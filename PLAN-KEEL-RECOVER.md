# Plan de `keel-recover`: ingeniería inversa de un servicio existente

## Context

Keel hoy solo diseña hacia delante. Las entradas del método (`/keel-decompose`, `/keel-design`,
`/keel-consume`) empiezan siempre por un humano que describe lo que quiere. Falta la entrada inversa:
un servicio **que ya existe**, un legacy que no generó Keel o uno que se quiere refactorizar, del que
se quieren obtener **artefactos de diseño fieles** para validarlo con la puerta de Keel y regenerarlo
en cualquier tecnología con keel-spring, keel-nest o keel-dotnet.

Supuestos de partida, que son los del peor caso:
- solo se conoce la tecnología (por ejemplo Java 8 o Node 14), no la arquitectura;
- el humano puede no tener ese entorno instalado;
- puede no haber pruebas de integración ni documentación;
- **la única entrada es el repo** del legacy o del servicio que se quiere refactorizar, con su
  historial de git. No hay base de producción ni dumps, ni documentación fuera del repo, ni acceso a
  los repos de los servicios con los que habla. El humano sigue ahí para **decidir** (`keep`/`fix`,
  las estructurales `omitted`), pero no aporta artefactos.

El primer paso de la implementación es copiar este plan a la raíz del repo como
`PLAN-KEEL-RECOVER.md`, para llevar su estado incremento a incremento, como `PLAN-KEEL-NEST.md` y
`PLAN-KEEL-DOTNET.md`.

## 0. Qué significa «fiel», y cómo se mide

«Fiel» no se afirma: se mide en dos ejes, y los dos tienen que salir en un informe al cerrar.

| Eje | Pregunta | Instrumento |
|---|---|---|
| **Corrección** | ¿Lo que dice el diseño es verdad del legacy? | Los escenarios `keep` se ejecutan contra el legacy en marcha y pasan |
| **Completitud** | ¿El diseño cubre todo lo que hace el legacy? | La cobertura de código del legacy bajo las sondas, más la lista de lo no observado |

Y cada elemento del diseño lleva su **procedencia**, con cuatro niveles de más a menos fuerte:

| Nivel | Origen | ¿Admitido en el diseño final? |
|---|---|---|
| `measured` | una grabación del sistema en marcha | sí |
| `read` | lectura del código, con `archivo:línea` | sí, marcado |
| `asked` | lo contestó el humano | sí |
| `inferred` | el agente lo supuso sin evidencia | **no**: se convierte en hueco declarado |

La última fila es la regla de oro de `/keel-consume` aplicada aquí: «un contrato inventado es un
diseño incorrecto que parece completo».

## 1. Principios

1. **La IA propone y lo determinista mide.** El agente construye el entorno, propone sondas e
   interpreta. La evidencia es siempre lo grabado del sistema en marcha. Cada bucle agéntico tiene
   un juez determinista y un **presupuesto** que lo cierra (el `MAX_PASSES` del careo es el
   precedente: un bucle sin tope no converge).
2. **El código del legacy no se toca.** Se monta en solo lectura. Lo que se adapta es el entorno
   (imágenes, mirrors, variables, stubs), y cada adaptación queda escrita con su motivo. Modificar
   el código sería caracterizar otro sistema.
3. **Lo no observado se declara, no se descarta.** La cobertura sin alcanzar y los mecanismos que
   las sondas no pueden disparar van a `unobserved.yaml` y se convierten en preguntas para el humano.
4. **Comportamiento observado no es decisión tomada.** Que el legacy no tenga idempotencia es un
   hecho. Si el servicio nuevo la tendrá, lo decide el humano. Toda decisión estructural sale
   `observed`, `omitted` o `contradicted`, y las `omitted` se preguntan con el protocolo de
   `/keel-design`: nada de defaults tácitos (`CHK-MODEL-IMPLICIT-DEFAULT`, criterio `structural`).
5. **El legacy, nunca en producción.** Las sondas disparan efectos (correos, cobros, llamadas a
   terceros). El runtime corre **sin salida a internet**, y eso lo comprueba el juez, no la buena fe.
6. **La frontera del DSL se declara.** Lo que el legacy hace y el DSL no puede decir (lógica en
   triggers, sesiones con estado, colas con orden global) va a una lista de rechazos con su motivo,
   como `supported-features.js` en los generadores.
7. **El repo es la única fuente, y lo que trae son afirmaciones, no medidas.** Las pruebas, specs,
   colecciones, stubs y seeds del repo se aprovechan, pero las escribieron sus autores y pueden estar
   desfasados. Entran como `read` y solo pasan a `measured` cuando una sonda lo confirma.
8. **Lo que está fuera del repo no se sabe.** El contrato de una dependencia sale solo de cómo la usa
   el legacy (sus DTO de cliente, sus stubs de test), con procedencia `read`. Su comportamiento real
   (umbrales, errores, latencias) no se puede observar y va a `unobserved.yaml` como asunción. Tampoco
   vale lo que el agente «sepa» de un proyecto público por su entrenamiento: eso es `inferred`.

## 2. Dónde vive

Un paquete nuevo, **`packages/keel-recover`** (CLI `keel-recover`), que depende de `keel-core`.

- **No va en keel-core** porque lleva adaptadores por tecnología del legacy (Maven, Gradle, npm…) y
  orquesta contenedores. Eso es de la misma naturaleza que un generador, no del núcleo del DSL.
- **Escribe en el workspace de diseño**: `legacy/<servicio>/` (sandbox y evidencia) y
  `specs/<servicio>/`. Es una **entrada** al diseño, no un generador, así que la regla «un generador
  nunca siembra en el workspace» no aplica. Igualmente lo dejo escrito en `CLAUDE.md`, porque es la
  primera excepción.
- Su skill `/keel-recover` vive en `packages/keel-recover/assets/skills/` con frontmatter neutral y
  tokens `{{keel:…}}`, y se proyecta con `emitHarnessFiles()` de `keel-core/src/lib/harness.js`.
- La procedencia va en un archivo lateral `specs/<servicio>/provenance.yaml`. Lleva fila en
  `SPEC_SIDE_FILES` (`keel-core/src/lib/spec-files.js`), y **no viaja ni al publicar ni al derivar**,
  porque cita rutas de un código privado.

## 3. El flujo

### Paso 0. Sandbox: levantar el legacy donde el humano no puede

| Sub | Qué | Quién |
|---|---|---|
| 0a | **Huella del runtime**: versión del lenguaje y de la herramienta de build, empaquetado y servidor de aplicaciones, leídos de `pom.xml`, `build.gradle` + wrapper, `package.json#engines`, `.nvmrc`, `.tool-versions`, `lockfileVersion` (y la existencia de **cualquier** lockfile: `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`), un Dockerfile si existe y **la configuración de CI** (`.travis.yml`, `.circleci/`, `.github/workflows/`, `.gitlab-ci.yml`), que en el inc. 1 fue la única fuente de la versión de Node y del motor. Sale `runtime.yaml` con `archivo:línea` | determinista |
| 0b | **Dependencias externas**: grep de lo que el código lee del entorno (`System.getenv`, `process.env`, `@Value`, `application*.yml`, `.env.example`). Clasificación: base o broker → su contenedor; tercero HTTP → WireMock, con stubs derivados de los DTO de cliente y de los stubs de test que traiga el repo; SMTP → Mailpit; desconocido → pregunta. **Inventario de activos del repo**: pruebas, specs (OpenAPI, Swagger, Dredd), colecciones (Postman), stubs de dependencias, seeds y scripts de arranque | grep determinista + agente |
| 0c | **Dockerfile multi-etapa** con la cadena antigua (`maven:3.6-jdk-8`, `node:14`), medidor de cobertura e imágenes fijadas por digest, más `compose.yaml` con lo de 0b. Cobertura: JaCoCo en `tcpserver` (se vuelca por ronda sin reiniciar); en Node ≥10.12, c8/`NODE_V8_COVERAGE`; en Node <10 no existe, así que nyc, que escribe al salir (**una ronda = un arranque**). Reglas del `compose.yaml`: (1) la **versión** de cada imagen sale de la evidencia, por este orden: la CI del repo, la compatibilidad del driver y la época de las dependencias. **Nunca la última por defecto**: en el inc. 1 la moderna arrancaba y mentía. (2) Cada servicio se publica con el **alias que el legacy ya espera** (`orders-db`, `rabbitmq`, `payment`), para no tocar su configuración. (3) La red de ejecución es `internal: true`; el build va aparte, con red solo para las dependencias. (4) Todas las imágenes van fijadas por **digest**. (5) Los terceros HTTP comparten un WireMock con un alias por host. Parte del catálogo neutral de `keel-core/src/lib/gen/infra-catalog.js` e `infra-scripts.js`, al que se añaden versiones antiguas | agente |
| 0d | **Bucle de build** con presupuesto. Fallos conocidos: Maven por http o jcenter desaparecido (mirror en `settings.xml`), npm despublicado, `node-gyp` con python2, Debian EOL (`archive.debian.org`), pruebas que descargan binarios en el build. Un registro privado sin credenciales en el repo es un **rechazo con motivo**, porque no hay otra entrada. Cada adaptación queda en `environment.yaml` con su motivo. La red solo se abre para resolver dependencias del build, nunca para buscar información | agente |
| 0e | **Bucle de arranque** con presupuesto: variables que faltan (con los valores de desarrollo del propio repo, nunca uno de producción), esquema (las migraciones de la app; si no hay, el que crea el ORM al arrancar; si tampoco, el derivado de las entidades, `read`) y datos (los seeds y fixtures del repo, o creados por la propia API en una ronda 0 de sondas) | agente |
| 0f | **Juez** `keel-recover verify`: la app responde sin 5xx, está conectada a la base, la cobertura graba y **el runtime no tiene salida a internet**. Si pasa, toma el snapshot de la base. Dos reglas medidas en el inc. 1. (1) La conexión a la base se comprueba con una **lectura y una escritura reales del dominio**, nunca con la salud del legacy: con el motor equivocado, el `/health` de orders decía OK mientras toda consulta fallaba. (2) Con el motor equivocado no todo es 5xx: RealWorld contra Mongo 7 respondía **422 «is already taken»** a un usuario nuevo. Por eso el juez cruza la versión del motor con la que declaran la CI y el driver, y no se conforma con «sin 5xx» | determinista |

**Se rechaza con su motivo** lo que no se puede contenerizar: .NET Framework sobre Windows,
middleware con licencia (WebLogic, IBM MQ) y mainframes.

### Paso 1. Observación

- **1a. Introspección** (determinista). Rutas con su handler (`/actuator/mappings`, la tabla del
  router, ApiExplorer), `information_schema` (tablas, únicos, FK, índices, valores distintos de las
  columnas de estado) y la API del broker (exchanges, colas, bindings, listeners). Sale
  `surface.yaml`. Medido en el inc. 1:
  - El `/mappings` de actuator 1.x **no lista** ni Spring Data REST ni los `@RepositoryRestController`. La
    tabla completa está en las líneas `Mapped "{[...]}"` del log de arranque, y `{repository}` se expande
    con la raíz HAL.
  - En Express no hay endpoint que pregunte por las rutas. Se leen del proceso con un módulo de precarga
    (`NODE_OPTIONS=--require`) que recorre `app._router.stack`, sin tocar el legacy.
  - La superficie de datos y de broker se declara de forma **perezosa**: colecciones que nacen con el
    primer documento y colas que `RabbitAdmin` declara en la primera conexión. Por eso la introspección se
    repite al final de cada ronda.
  - La introspección encuentra superficie que la lectura no ve, como actuator abierto sin autenticación
    con `POST /env` y `/restart`.
- **1b. Exploración por rondas**, con presupuesto:
  1. El agente lee **solo** los handlers y DTO que nombra `surface.yaml` (y las ramas sin cubrir) y
     escribe `probes/round-N.yaml`. La forma de cada petición se descubre por el DSL del framework
     si existe (OpenAPI, springdoc), por el DTO o por los 400 del propio legacy.
  2. `keel-recover probe` restaura el snapshot, envía la petición o publica el evento, espera a que
     el sistema esté quieto y graba, todo normalizado (ids, fechas, orden):
     - la respuesta;
     - el diff de la base;
     - los mensajes que caen en colas espía;
     - las llamadas que recibe WireMock;
     - el correo de Mailpit.
  3. Se vuelca la cobertura de la ronda.

  El bucle para cuando la cobertura se estanca o se agota el presupuesto. Medido en el inc. 1 (prototipo
  en `../keel-recover-lab/tools/probe.mjs`):
  - La **ronda 0** sale de los activos del repo cuando los hay: la colección Postman de RealWorld dio el
    88 % de líneas sola. Pero su verde no es una prueba, porque «pasaba» con un 500 dentro de una
    petición sin aserciones. Se lee el status de cada petición.
  - Los efectos se leen **después** de restaurar el setup de la sonda (con el broker otra vez arriba).
    Así se ve, por ejemplo, que una cola no durable ha desaparecido.
  - Una sonda de concurrencia no tiene un desenlace, sino una **distribución**: se repite (`repeat`) y
    se cuentan los desenlaces con una clave que no depende del orden de los pasos paralelos. Lo estable
    es el conjunto de desenlaces, no sus frecuencias.
  - Normalización: el JWT se identifica por sus claims sin `iat`/`exp`. Los hashes y lo aleatorio del
    framework (el sufijo del slug) llevan regla por legacy. Los tiempos se graban (`_timeSeconds`) pero
    no se comparan. Con eso, dos ejecuciones de la misma ronda dieron 22 de 24 grabaciones idénticas, y
    las 2 restantes eran de concurrencia.
  - Una misma sonda puede dar 200 o 500 según **la forma de la respuesta de una dependencia** (en orders,
    si el cliente trae direcciones embebidas). Se sondean las dos formas y se declara la asunción.
  - Lo que queda sin cubrir al estancarse se clasifica: código muerto, configuración inactiva, modo
    (desarrollo frente a producción) o carrera no reproducida. Cada caso va a `unobserved.yaml` con su
    motivo.
- **Sondas de clase**, que cubren lo que una petición suelta no ve:

  | Qué | Cómo se sondea |
  |---|---|
  | Autorización | La misma sonda con cada rol y sin token. Las credenciales salen del repo: registro por la propia API, el secreto de firma de la configuración de desarrollo, usuarios de los seeds |
  | Concurrencia | Dos sondas iguales en paralelo: ¿409, último gana o duplicado? |
  | Repetición | La misma sonda dos veces: ¿idempotente? |
  | Ciclo de vida | Cada transición sobre cada estado observado en la columna de estado |
  | Fallo saliente | WireMock en 500 y en timeout |
  | Broker caído | La sonda con el broker parado: ¿se pierde el evento? (outbox o best-effort) |

  Lo que no se puede disparar desde fuera, como un `@Scheduled` o un cron, se encuentra por lectura
  (`read`) y va a `unobserved.yaml`, salvo que el humano permita acelerarlo o invocarlo.

### Paso 2. Partir un monolito, si lo es

`/keel-decompose` con `surface.yaml` y las grabaciones como insumo. Los grupos de tablas por FK y las
rutas que las escriben sugieren las fronteras, y una base compartida entre esas fronteras es un
hallazgo de `system.yaml`. Los servicios de fuera del repo entran en `system.yaml` solo como
proveedores o consumidores con el contrato que se ve desde dentro. El humano confirma. Después se ejecuta un `/keel-recover` por servicio.

### Paso 3. Recuperar el diseño (`/keel-recover specs/<servicio>`)

Las capas se escriben en el orden de `/keel-design`, cada elemento con su procedencia en
`provenance.yaml`. La correspondencia es directa:

| Evidencia | Elemento del DSL |
|---|---|
| Diff de la base | entidades, agregados (filas que cambian juntas en una sonda) e `indexes` |
| Valores de la columna de estado + transiciones sondeadas | `lifecycle` |
| Mensajes en las colas espía | `emits` y eventos de `messaging` |
| Llamadas a WireMock | `dependencies` y `http-clients`, por el modo degradado de `/keel-consume` |
| Sondas por rol | `security` |
| 4xx observados | `errors` con su `code` y su `http` |
| Sondas de clase | las decisiones estructurales `observed`/`omitted`, en `decisions.yaml → structural:` con `origin` y `evidence` |

La lógica que el código tiene y el DSL solo puede escribir en prosa va a `rules`/`invariants`, con
la referencia al código.

### Paso 4. Caracterizar

Las grabaciones pasan a `validation-scenarios.md` como escenarios de caracterización. Cada uno lo
marca el humano:
- **`keep`**: el servicio nuevo tiene que hacer lo mismo.
- **`fix`**: es un defecto que se corrige a propósito, con su entrada en `decisions.yaml`.

Para un refactor, la lista de `fix` **es** su backlog.

### Paso 5. Medir la fidelidad

- Los escenarios `keep` se ejecutan contra el sandbox del legacy, con la colección de `/keel-docs` y
  el ejecutor de sondas. El bucle vuelve a los pasos 3 y 4 hasta que todos pasen, con presupuesto.
- **Sale** `legacy/<servicio>/FIDELITY.md`:
  - los `keep` en verde;
  - la cobertura final;
  - el reparto de procedencias (cuántos `measured`, `read` y `asked`, y ningún `inferred`);
  - lo no observado;
  - los rechazos por la frontera del DSL.
- El criterio nuevo **`characterized`** de `keel validate --ready` exige esa ejecución en verde,
  sellada con el hash de los escenarios, como el careo.

### Paso 6. Cierre y regeneración: lo que ya existe

`keel validate --ready` hasta 10/10 (análisis de huecos, careo, `DESIGN.md`). Después,
`keel-<tech> build` → `cd` → `/keel-generate-<tech>`.

### Paso 7. Paridad con el legacy

`keel-recover probe` ejecuta las **mismas sondas** contra el servicio regenerado y compara las
grabaciones con las del legacy: respuestas **y** efectos (las filas, los eventos y las llamadas
salientes). El resultado esperado es igual en los `keep`, con la diferencia declarada en los `fix`.
Se registra en `docs/corridas/`.

**La paridad es semántica, no literal** (decisión del 2026-10-22, inc. 1). El contrato del cable
(`wire-contract.md`) lo fija el método: forma del error, sobre de la página, cuerpos sin envoltura y
autenticación delegada en un proveedor OIDC. Un legacy casi nunca lo cumple; RealWorld envuelve los
cuerpos, pagina con `limit`/`offset` y emite sus propios tokens. Por eso los clientes del legacy
**migran** al contrato canónico, y el paso 7 compara:
- el **status**, con la tabla de diferencias declaradas;
- los **datos**, a través de un **mapa de contrato** legacy → Keel (`contract-map.yaml`: rutas,
  envolturas, campos, parámetros de página, forma del error, cómo se obtiene un token en cada lado);
- los **efectos**.

Nunca se compara el cuerpo literal. Cada diferencia de forma es un `fix` declarado en `decisions.yaml`,
con su entrada en el mapa.

**Los escenarios no bastan: se comparan todos los datos** (medido en el inc. 1). El servicio regenerado de
RealWorld pasó 73 de 73 escenarios, 91 pruebas y los 19 `keep`, y aun así llevaba tres defectos del diseño
recuperado que ninguno afirmaba:
- el `sub` del token de cada autor expuesto en todo artículo y comentario;
- la imagen por defecto perdida en las proyecciones del autor;
- `favorited` y `following` ausentes en respuestas autenticadas.

Los encontró `tools/parity.mjs`, que compara paso a paso **todo** lo que devuelven los dos lados (ya
traducido por el mapa): campos que solo tiene uno, valores distintos y `null` frente a ausente según la
semántica del mapa. Clasifica cada diferencia como equivalente, **declarada** (`declaredDifferences` del
mapa, con su motivo) o **sin declarar**, y sale en rojo con cualquier diferencia sin declarar y si no ha
comparado ningún paso: un comparador sin nada que comparar no puede salir en verde. Lo que el legacy hace y el contrato canónico no puede decir (la
autenticación opcional que personaliza una lectura pública, el login propio) es frontera, con su
motivo. Una fachada que conserve el contrato del legacy queda fuera de este plan.

**Queda fuera de este plan:** migrar los datos y el corte de tráfico (estrangulamiento o cambio de
golpe).

## 4. Incrementos

**Estado (2026-10-22):** incrementos 0, 1 y 2 **cerrados**. El 1 se registró en `docs/recover-bench/corridas/`
(paso 0, paso 1, pasos 3-5 y paso 7). Su laboratorio es el repo `../keel-recover-lab`: sandboxes,
grabaciones, el diseño `conduit` y los prototipos `tools/*.mjs` que los incrementos 4, 6 y 7 reescriben
dentro del paquete. **El siguiente es el 3.**

Incremento 2, hecho: `packages/keel-recover` con `fingerprint` y `env-deps`, adaptadores Maven, Gradle y
Node, y los schemas `runtime`/`environment` en `assets/schema/`. Puerta: las tres fixtures de
`fixtures/legacy/` (`java8-maven`, `java8-gradle`, `node14`) salen byte a byte como `fixtures/expected/`
(`npm test`, 31 pruebas). Contraste con la línea base: `npm run bench-check` da en verde los 37 hechos
deterministas de los `runtime.yaml`/`environment.yaml` a mano y de las filas ENV/ASSET de las hojas. Lo
que esas referencias traen y es del agente (la imagen elegida, `adaptations`, los hosts de payment y
shipping que orders compone en tiempo de ejecución, el `only_in: production` de RealWorld) queda fuera de
la herramienta y se lista aparte: es 0c-0e, del incremento 3. Hallazgos que el inc. 1 no tenía y la
herramienta sí: el `scripts/build.sh` de Sock Shop construía con `maven:3.2-jdk-8` (la única versión de
Maven del repo), su Travis usaba `oraclejdk11` contra un objetivo 1.8 (`consistent: false`), su compose
levanta `orders-db` con `mongo` sin versión, y la spec de orders documenta 2 operaciones.

| # | Qué | Puerta |
|---|---|---|
| 0 | Copiar este plan a `PLAN-KEEL-RECOVER.md` | — |
| 1 | **Prueba manual, sin código**: pasos 0, 1, 5 y 7 a mano sobre los legacys del banco (`docs/recover-bench/`: `realworld-node`, `sockshop-orders` y `sockshop-shipping`), regenerando uno con keel-dotnet. Cada fila de sus hojas de respuestas pasa de `read` a `measured` o `refuted` | Corrida en `docs/recover-bench/corridas/` (no en `docs/corridas/`, cuya serie es la de los generadores) con intentos de 0d/0e, adaptaciones, cobertura por ronda, `keep` que fallan la primera vez y la tabla de paridad. **Decide si el paso 0 es viable antes de construirlo**, y deja la línea base del banco |
| 2 | Paquete `keel-recover`: `fingerprint` (0a) y `env-deps` (0b) con adaptadores Java/Maven, Java/Gradle y Node; schemas `runtime`/`environment` fuera del DSL | Deterministas byte a byte sobre fixtures de legacy mínimas (`fixtures/legacy/java8-maven`, `java8-gradle`, `node14`). **Hecho** |
| 3 | Skill del sandbox (0c–0e) + `verify` (0f) | `verify` falsado: rojo con salida a internet, con cobertura vacía y con 5xx |
| 4 | `introspect` (1a) + `probe` (1b): restauración, captura de efectos, normalización y cobertura. Reutiliza WireMock, Mailpit, `keel-core/src/lib/gen/broker-probes.js` y la `infra/` neutral | Una app legacy de fixture, en vivo como los `*-check`: cada efecto capturado y uno saboteado por tipo (por ejemplo, la cola espía sin enlazar sale en rojo) |
| 5 | Skill `/keel-recover` (pasos 3 y 4) + `provenance.yaml` (fila en `SPEC_SIDE_FILES`) + `origin`/`evidence` en `structural-register.js` | `npm test` en keel-core; un `inferred` en el diseño final sale en rojo, y **también todo elemento del DSL sin fila en `provenance.yaml`**: en el inc. 1 se coló un rol copiado de la forma de una fixture, sin fila, y no lo habría cazado una puerta que solo mira lo que el agente declara |
| 6 | Criterio `characterized` en `readiness.js` + `FIDELITY.md` | `test/readiness.test.js`: romper el sello apaga `characterized` y solo ese criterio |
| 7 | Paridad legacy ↔ regenerado (paso 7) | La corrida de control del incremento 1, repetida con la herramienta: la misma tabla |
| 8 | **DSL 2.23: autorización por propietario.** Encontrada en el inc. 1 sobre RealWorld: «solo el autor edita o borra» no se puede declarar, porque `scoping` acota por un claim y no por un campo del recurso. `OBL-RESOURCE-SCOPE` no admite aceptarse y **bloquea la generación**. Sin embargo la acotación es producible con `callerIdentity`, igual que el detector ya reconoce para el nivel `service`: falta decir qué campo del recurso guarda al propietario (`Article.author` → `Profile.subject`) y con qué `code` se rechaza. Toca el schema de `security`, `crossrefs.js` (la obligación se cierra con la declaración), una mutación, los tres generadores y una fixture (conduit) | La fixture con propiedad genera en los tres generadores y su 403 sale en una red en vivo; el inc. 1 vuelve a ejecutar FL-ART-004 y FL-COM-002 contra el regenerado |

## 5. Riesgos

- **El paso 0 puede costar más que todo lo demás.** Por eso el incremento 1 lo mide antes de invertir.
- **La cobertura alta no es fidelidad.** Una línea ejecutada no es un comportamiento afirmado. La
  completitud la da la cobertura, y la corrección solo la dan los escenarios `keep` en verde. Por
  eso se miden los dos ejes.
- **No determinismo del propio legacy** (reloj, orden, aleatorios). La normalización lo absorbe, y lo
  que no se pueda normalizar se declara.
- **Seguridad del build.** Un legacy trae dependencias viejas con CVE y scripts de `postinstall`. El
  build corre aislado y el runtime sin red externa. Nunca se usan secretos de producción.

## Banco de medida

`docs/recover-bench/` fija tres legacys reales y abandonados por commit, con una hoja de respuestas
cada uno (109 hechos, con `archivo:línea`, más canarios de contaminación), las métricas de fidelidad y de esfuerzo y el protocolo para
medir. El incremento 1 mide a mano la línea base, y el 7 repite la medida con la herramienta. La
medida final añade un legacy **retenido** que elige el humano, contra el sobreajuste. Lo que el banco
no cubre (relacional, `lifecycle`, roles, correo, cron, consumo) está escrito en su README.

## Verificación

- El incremento 1 deja una corrida con la tabla de paridad legacy ↔ regenerado: los mismos `keep` en
  verde en los dos servicios, y `FIDELITY.md` escrito a mano.
- Del incremento 2 al 7, cada uno cierra con su puerta de la tabla del §4 y con `npm test` en verde
  en todo el monorepo.
