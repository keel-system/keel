# Informe de generación — catalog-spring

Registro de incidencias detectadas durante la ejecución de `/keel-generate-spring` (Fase 1 + ciclos código↔validación) sobre el diseño `specs/catalog` v0.1.0. El objetivo de este documento no es el estado del servicio (ver el resumen de cierre en `README.md`), sino **qué falló en el proceso de generación en sí** — huecos del scaffolding determinista de `keel-spring build`, y debilidades de los subagentes al generar código y pruebas — para mejorar el generador y las skills en próximas ejecuciones.

## 1. Incidencias del código determinista (scaffolding de `keel-spring build`)

Estas no son bugs de lógica de negocio: son cosas que el generador dejó en un estado que rompía la generación antes de que el agente pudiera producir nada útil, o que solo se manifestaron al ejercitar el servidor real.

### 1.1 Drift de esquema entre entidades JPA y la BD del contenedor de prueba

La base de datos local (`catalog-db`) traía columnas `name_normalized varchar NOT NULL` y `lock_version bigint` en `categories` y `products` que **ninguna entidad JPA actual mapea** (`CategoryJpa`/`ProductJpa`, 0 referencias) y que `specs/persistence.keel.yaml` no pide (`optimisticLocking: none`). Con `ddl-auto: update`, Hibernate nunca elimina columnas obsoletas ni afloja un `NOT NULL` preexistente, así que **todo `INSERT` sobre esas tablas violaba la constraint** y devolvía un 409 genérico (`ApiExceptionHandler.onDataIntegrityViolation`) sin relación aparente con la causa real. Esto bloqueó los 26 flujos de golpe.

- **Causa probable**: una iteración anterior del scaffolding generó esas columnas (¿un `optimisticLocking` o una normalización de búsqueda que se quitó del diseño más tarde?) y el volumen de Postgres del contenedor de prueba no se recreó al regenerar.
- **Recomendación para `keel-spring build`**: cuando el `--force` regenera entidades, documentar (o automatizar) que el volumen de BD de `infra/docker-compose.yaml` debe recrearse si el mapeo de columnas cambió, en vez de confiar en `ddl-auto: update` para mantenerlo sincronizado. Alternativa: un chequeo de arranque que compare el esquema real contra las entidades y falle rápido con un mensaje claro en vez de un 409 opaco en el primer insert.

### 1.2 Colas RabbitMQ nunca declaradas pese al exchange y routing keys correctos

`RabbitMqConfig` (generado por build) declaraba el `TopicExchange catalog.events` y cada publisher usaba las routing keys correctas (`catalog.product-created`, etc.), pero **ninguna cola estaba declarada ni bindeada**. Resultado: todo evento publicado se descartaba silenciosamente (`drop_unroutable`), sin error visible en la aplicación — el publisher reportaba éxito porque el exchange aceptó el mensaje.

- **Impacto**: 9 de 11 fallos del primer ciclo real de validación fueron por esta única causa. Además, produjo **falsos verdes**: dos escenarios que esperaban "no se publica evento" (`FL-IMG-001-D`, `FL-IMG-010-B`) pasaban porque el canal *siempre* estaba vacío — no distinguían "no publicado" de "publicado y perdido".
- **Recomendación para `keel-spring build`**: si el generador ya conoce los canales del diseño (`specs/messaging.keel.yaml` → `docs/asyncapi.yaml`), debería dejar las colas declaradas por defecto (con el nombre del canal, como espera el harness de test generado), no solo el exchange. Es la mitad del contrato de mensajería la que faltaba.

### 1.3 Validaciones de entrada ausentes pese a estar en el contrato

Dos casos borde documentados explícitamente en el contrato (`min: 0` en `priceMin`, `minItems: 1` en `ids` de un batch) no tenían su Bean Validation correspondiente en los DTOs/controllers generados (`ProductV1Controller.priceMin`, `ListProductsBatchQuery.ids`). Ambos devolvían 200 en vez de 400.

- **Recomendación**: cuando `api.keel.yaml` fija restricciones numéricas o de tamaño de colección en un parámetro, el generador de controllers/DTOs debería emitir la anotación Bean Validation correspondiente por defecto, no dejarlo a discreción del agente de código en la fase de completado.

## 2. Debilidades detectadas en los agentes generadores

### 2.1 `keel-spring-infra` — Keycloak sin script de aprovisionamiento

No existía ningún realm ni script de setup de Keycloak al arrancar. El agente tuvo que escribir `infra/init-keycloak.sh` desde cero, interpretando `.claude/skills/keel-spring-keycloak/references/test-clients.md`. Esto es razonable como trabajo de "completar scaffolding", pero implica que **nadie valida antes de la Fase 1 si el script de aprovisionamiento es coherente con lo que espera el arnés de test** (ver 2.4 más abajo) — se descubrió el desajuste solo al ejecutar la suite completa.

### 2.2 `keel-spring-tests` — asunciones sobre infraestructura no verificadas

En la Fase 1 (donde el agente trabaja en caja negra, sin leer `src/main/java` ni tener infraestructura arriba todavía en paralelo), `keel-spring-tests` documentó en un comentario que las aserciones de `FL-M2M-020` (403 sin scope, 403 audiencia ajena) **no se podían traducir** porque "ni `security.keel.yaml` ni `infra-validation.md` definen un segundo cliente M2M sin ese scope o con otra audiencia". Esa afirmación quedó obsoleta en cuanto `keel-spring-infra` (corriendo en paralelo) sí aprovisionó exactamente esos dos clientes (`test-m2m-no-scope`, `test-m2m-bad-aud`), siguiendo la convención ya documentada en `.claude/skills/keel-spring-keycloak/references/test-clients.md` — el mismo documento que el agente de tests citó como "no lo define".

- **El agente sí tenía la referencia correcta a mano y no la usó para inferir que la infraestructura la proveería.** El comentario quedó como código muerto en `ServiceSurfaceAuthorizationFlowIT.java` y las tres aserciones (2, 3, 6) siguen sin ejercitarse tras 4 ciclos de validación.
- **Recomendación**: cuando un escenario depende de un fixture de infraestructura (cliente M2M, usuario, secreto) que una skill de stack ya documenta como convención estándar (`references/test-clients.md`, `infra-validation.md`), el agente de tests debe **asumir que existirá** y escribir el test contra el nombre convencional, no declararlo "no traducible". Si la convención no se cumple, ese es justamente el tipo de fallo que `keel-spring-infra` o `keel-spring-validate` deben detectar y corregir — no una razón para dejar cobertura sin escribir.

### 2.3 `keel-spring-tests` — arnés no portable entre entornos (bash)

`AbstractFlowIT.resetState()` invocaba `new ProcessBuilder("bash", "infra/reset-db.sh")` sin ruta absoluta. En Windows con WSL instalado, la resolución de `"bash"` por `CreateProcess` prioriza `%SystemRoot%\System32\bash.exe` (el lanzador de WSL, un entorno aislado sin `PATH` ni variables de Windows) sobre Git Bash. Esto bloqueó los 26 flujos en `@BeforeAll` sin ningún mensaje relacionado con el negocio.

- **Recomendación para la skill `keel-spring-tests`**: cuando el arnés de integración necesite invocar un script de shell desde Java, **nunca depender de que `"bash"` resuelva correctamente por `PATH`** en un entorno Windows no controlado. Resolver explícitamente el ejecutable (con override por variable de entorno, ver el fix aplicado: `bashExecutable()` prueba rutas conocidas de Git for Windows y cae a `"bash"` literal en SO no-Windows). Esto debería ser parte del template/base class que `keel-spring build` genera, no algo que cada ejecución tenga que redescubrir y parchear.

### 2.4 `keel-spring-tests` — credenciales hardcodeadas sin verificar contra la infraestructura real

Dos valores por defecto en `AbstractFlowIT` no coincidían con lo que `keel-spring-infra` efectivamente aprovisionó, y ambos bloquearon sistémicamente la suite entera hasta que `keel-spring-validate` los diagnosticó por fuerza bruta:

| Variable | Default hardcodeado | Valor real provisionado | Convención que lo define |
|---|---|---|---|
| `AUTH_TEST_CLIENT` (client_id de usuario) | `catalog-test` | `catalog-spring-test` | `<artifactId>-test`, `.claude/conventions/infra-validation.md` |
| `AUTH_CLIENT_SECRET` (secreto M2M) | `secret` | `catalog-consumer-secret` | fijado por `infra/init-keycloak.sh` |

- **Patrón común con 2.2 y 2.3**: el agente de tests trabaja en Fase 1 sin ver la infraestructura real (por diseño, para mantener la caja negra), pero eso significa que **cualquier literal que dependa de infraestructura (nombres de cliente, secretos, nombres de recurso) es una apuesta que hay que verificar en la Fase 2**, no una entrada dada por buena. En este proyecto, dos de estas apuestas fallaron y consumieron dos ciclos de validación completos (sistémicos, sin coste de cupo, pero sí de tiempo) antes de llegar a evaluar un solo escenario de negocio real.
- **Recomendación**: derivar estos valores de una fuente única compartida entre `keel-spring-infra` y `keel-spring-tests` en vez de que cada agente los hardcodee por su cuenta desde su lectura de la convención — por ejemplo, que `keel-spring-infra` escriba un `infra/test-credentials.env` (o similar) al aprovisionar, y que `AbstractFlowIT` lo lea en vez de tener el nombre de cliente y el secreto como literales en el código Java. Esto convierte un desajuste de dos escritores independientes en una dependencia explícita de un único productor.

### 2.5 `keel-spring-tests` — aserciones "ausencia de evento" sin capacidad de distinguir falso negativo

Independientemente del bug de las colas (§1.2), el patrón de test `"no se publica evento" → publishedMessages(canal, n) == 0` es frágil por construcción: si el canal está vacío por *cualquier* motivo ajeno al escenario (bug de infraestructura, timing, cola mal bindeada), el test pasa igual. No hay forma de que ese `assert` distinga "correctamente no publicado" de "el mecanismo de publicación está roto".

- **Recomendación concreta para escribir estas aserciones de forma más robusta**: cada clase de flujo que incluya una aserción negativa de mensajería debería, en algún punto de la misma clase (no necesariamente el mismo test), also comprobar afirmativamente que el canal funciona — p. ej. abrir con un evento positivo esperado antes de la aserción negativa, o registrar en el propio `AbstractFlowIT` un "canary check" al inicio de la suite (publicar y leer un mensaje de prueba en cada canal declarado) que falle rápido y explícito si el binding no existe, en vez de dejar que se manifieste como 9 fallos de timeout dispersos y 2 falsos verdes.

## 3. Recomendaciones consolidadas para `keel-spring-tests` — cómo escribir las pruebas de integración de forma más eficiente por parte del stack

Instrucciones concretas a añadir a `.claude/conventions/integration-tests.md` (o a la skill) para próximas generaciones:

1. **Mensajería (RabbitMQ)**: antes de escribir aserciones "evento publicado"/"evento no publicado" para un canal, verificar (documentándolo en el propio test o en un fixture común) que existe al menos un test en la suite que confirma positivamente que ese canal recibe mensajes. Nunca dejar que la única evidencia de que un canal "funciona" sea una aserción de ausencia.
2. **Credenciales e identificadores de infraestructura (Keycloak, secretos M2M, nombres de recurso)**: no hardcodear un valor por defecto inventado o inferido sin confirmarlo contra lo que la skill de infraestructura correspondiente documenta como convención generada. Si la convención está documentada (`<artifactId>-test`, nombre de secreto fijado por el script de init), usar exactamente ese valor como default — no una variante plausible.
3. **Invocación de procesos externos desde el arnés (`ProcessBuilder`, scripts de reset)**: resolver siempre el ejecutable por ruta explícita quando el nombre del binario es ambiguo en el SO objetivo (caso conocido: `bash` en Windows con WSL instalado). Añadir esta resolución al template base (`AbstractFlowIT` o equivalente) que genera `keel-spring build`, no dejarlo para que cada agente de tests lo redescubra.
4. **Cobertura de casos borde de infraestructura de autorización (scopes, audiencias)**: cuando un escenario de seguridad requiere un fixture de identidad que la skill de auth ya define como parte de su matriz de test estándar (p. ej. `test-clients.md` de Keycloak), escribir el test asumiendo que el fixture existirá — nunca marcarlo como "no traducible" solo porque en el momento de escribirlo (Fase 1, sin ver infraestructura) no se puede confirmar. Verificar y corregir en la re-validación si el fixture resulta faltar, no dejar cobertura sin escribir por precaución excesiva.
5. **Validación cruzada de casos borde de contrato** (`min`/`max`, `minItems`, patrones): tratar cada restricción declarada explícitamente en `api.keel.yaml`/`openapi.yaml` como un escenario obligatorio de "debe rechazar con 400", incluso si el flujo `FL-*` no lo menciona palabra por palabra — son estos los que más fácilmente faltan en el scaffolding generado (ver §1.3) y los que un test de caja negra puede atrapar sin necesidad de leer el código.
6. **Reportar, no silenciar, las apuestas no verificables en Fase 1**: cuando el agente de tests toma una decisión que depende de infraestructura que aún no existe (nombre de cliente, secreto, nombre de cola), debe declararlo explícitamente en su reporte de cierre de fase (`blockers` o una sección de "asunciones de infraestructura pendientes de verificar") en vez de solo dejarlo como comentario en el código fuente — así el orquestador puede pedirle a `keel-spring-validate` que las confirme explícitamente en el primer ciclo, en vez de descubrirlas por fuerza bruta tras un `initializationError` en las 26 clases.

## 4. Resumen de coste

Los tres bloqueos sistémicos (drift de esquema, colas RabbitMQ, y — antes de estos — resolución de `bash` y `client_id`/`secret` mal configurados) consumieron 4 ciclos completos de re-ejecución de la suite de integración (26 clases × ~metros de tiempo de arranque de Spring Boot cada una) **antes de evaluar un solo escenario de negocio real**. Ninguno de estos 4 ciclos contó contra el cupo de la Fase 2 (por ser `blocking: systemic` o `culprit: test`), pero sí contra el tiempo real de la generación. La mayoría son prevenibles con las recomendaciones de la sección 3, aplicadas al template que `keel-spring build` genera en vez de a la iteración manual de cada agente.
