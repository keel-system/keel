# Informe de corrida — el fallback estrecho de los clientes HTTP

Corrida completa del pipeline sobre `catalog-extended` en un workspace externo al repo, para
verificar en vivo un cambio del generador que `INFORME-CORRIDA-OUTBOX.md` había dejado anotado y
sin tocar: **el fallback del circuit breaker capturaba `Throwable`**.

**Resultado**: 34 de 34 escenarios `FL-*` en OK **a la primera, cero ciclos de arbitraje** de un
cupo de 2. Las cinco familias de `check-idempotency.sh` en OK, `contextTest: OK`, `baseline: OK`.
Stack PostgreSQL 16 + Kafka + Redis + MinIO + WireMock sobre podman 5.8.3 en Windows, JDK 21.

Sobre el mismo proyecto se hizo después una **segunda tanda**, al revisar qué quedaba realmente
cubierto: se añadió `FL-OBX-001` (el canal indisponible) y se re-puntuó a **35 de 35**, con un
ciclo de arbitraje que resultó `culprit: test`. Va en § La segunda tanda, y de ella salieron dos
arreglos más del generador: una convención que dimensionaba mal una espera y el gate `dedupe`,
que daba falsos verdes.

## El problema

`fallbackMethod` de resilience4j declaraba `Throwable`, así que **cualquier** excepción del
adaptador entraba por el camino escrito para «el proveedor no responde»: un NPE, un
`ClassCastException`, un cuerpo que no deserializa. Con `onFailure: fail` eso se convertía en el
error de indisponibilidad que declara el diseño — el síntoma acusaba al tercero y la causa estaba
en casa. Es el patrón que mantuvo el defecto del punto 7 de la corrida anterior meses sin
diagnosticar, y ese arreglo tapó **una** de sus fuentes, no el embudo que las disfrazaba.

Había un segundo embudo, del mismo problema: la instancia
`resilience4j.circuitbreaker.instances.<x>` no emitía `record-exceptions` ni `ignore-exceptions`,
así que el default de resilience4j contaba **toda** excepción y un 4xx, un error de
deserialización o un NPE llenaban la ventana de fallos. La instancia `retry` sí discriminaba
desde siempre; el circuito no.

## Qué se cambió

### La tabla única (`src/lib/outbound-failures.js`, nuevo)

Es **una** pregunta contestada en **dos** sitios —las sobrecargas del fallback y el
`record-exceptions` del circuito—, así que la tabla vive en un módulo aparte que consumen
`scaffold/http-clients.js` y `scaffold/config.js`. Mismo criterio que `broker-probes.js`: si
divergieran, el circuito se abriría por excepciones que el fallback ya no ve.

Dos columnas, y **la asimetría es deliberada** — es justo lo que un refactor futuro
«unificaría» por error:

| Excepción | Al fallback | Cuenta para el circuito |
|---|---|---|
| `CallNotPermittedException` | sí (solo con circuito) | no — la lanza el propio circuito; contarla lo realimentaría consigo mismo |
| `ResourceAccessException` | sí | sí |
| `HttpServerErrorException` | sí | sí |
| `UnknownHttpStatusCodeException` | sí | sí |
| `HttpClientErrorException` (4xx) | sí, con log propio | **no** — contestar no es estar caído |
| NPE, cast, deserialización | **no** — se propagan | no |

El 4xx fue la decisión que más se discutió. Propagarlo crudo lo habría cruzado por `application`
(rompiendo la frontera hexagonal) y convertido en 500, poniendo en rojo todo escenario que hoy
afirma el error declarado — **sin ganancia**, porque un 4xx no es un bug nuestro *ni* una caída
ajena: es una respuesta con significado. Entra al fallback con su propia línea de log, y queda
fuera de la ventana del circuito para que un 401 por credencial caducada no acuse al proveedor de
lo nuestro.

### Las sobrecargas (`src/scaffold/http-clients.js`)

En vez de un `<call>Fallback(..., Throwable)`, una sobrecarga por entrada de la tabla, todas
delegando en un único `<call>Unavailable(..., Throwable)` donde `fallbackBody()` sigue
generándose **una sola vez**: N copias del cuerpo es la forma de que un día dejen de decir lo
mismo. Lo que ninguna sobrecarga acepta, resilience4j lo relanza — y esa propagación es la
función, no un hueco.

**Detalle que condiciona el diseño y que conviene no perder**: con **un solo** método de fallback
resilience4j entra por un atajo cuya semántica ha cambiado entre versiones (hoy comprueba el
tipo; antes invocaba siempre). Por eso se emiten **siempre ≥2**, incluso sin circuito. Con la
tabla nunca baja de cuatro.

## Dos defectos que aparecieron por el camino

### 1. El `@Retry` estaba muerto en toda llamada con circuit breaker

El orden de aspectos de resilience4j es `Retry(CircuitBreaker(llamada))`: Retry es el **externo**.
Como el `fallbackMethod` iba solo en `@CircuitBreaker`, el aspecto del circuito atrapaba la
excepción, ejecutaba el fallback y le devolvía al de retry **un valor normal** — que veía éxito y
no reintentaba nunca. El `maxAttempts` del diseño no se ejercía.

Peor: `references/implementation.md` afirmaba explícitamente lo contrario («el retry agota
intentos y, si el circuito abre, dispara el fallback»). Corregido, y el `fallbackMethod` movido al
aspecto externo.

Sin este arreglo, la corrida habría verificado en vivo una resiliencia que no existía.

### 2. Código muerto multiplicado por cinco

Un `fallback` en prosa sin `retry` ni `circuitBreaker` emitía un método privado que ninguna
anotación referenciaba. Con las sobrecargas serían cinco. `hasFallback` ahora exige que exista un
aspecto que lo dispare.

## Los tres escenarios nuevos

`FL-CMP-002/003/004`, sobre `compliance.recordWithdrawal` (`onFailure: fail` →
`COMPLIANCE_UNAVAILABLE`), y **ninguno necesitó primitivas nuevas del arnés**. Para materializar
el primero se bajó `slidingWindowSize` de 10 a 5 en el diseño de la fixture: se acorta el umbral,
no la semántica — igual que la corrida anterior bajó un cron a `* * * * *`.

- **`FL-CMP-002` — el circuito se abre.** Es la **primera vez que un circuito se abre en vivo** en
  una corrida de este repo. `CallNotPermittedException` no aparecía en ningún sitio del código
  generado y llegaba al fallback solo porque este declaraba `Throwable`: sin su sobrecarga, el
  primer circuito que abriera en producción le habría estampado al llamante una excepción cruda de
  resilience4j en vez del rechazo declarado. Era el fallo más caro posible de este cambio.
- **`FL-CMP-003` — un cuerpo que viola el contrato.** El escenario que separa el comportamiento
  nuevo del viejo, y el que reproduce la clase de defecto que motivó todo: un fallo de integración
  **nuestro** disfrazado de caída ajena. Su `Then` es deliberadamente incómodo — dice que la
  respuesta **no** puede ser `COMPLIANCE_UNAVAILABLE` y que un 500 es el resultado correcto.
- **`FL-CMP-004` — un 4xx.** No-regresión pura: el desenlace es idéntico al de antes, que es
  exactamente lo que compraba la decisión de seguir enrutándolo al fallback.

El agente de pruebas se anticipó a un riesgo que habría envenenado el arbitraje: el circuit
breaker vive en el contexto de Spring, que JUnit reutiliza entre clases, y `waitDurationMs`
sobrevive a `resetState()` — que vacía la base, no el estado del circuito. Sin nada, `FL-CMP-002`
podía dejar en 502 la primera retirada del flujo siguiente y el árbitro habría culpado al agente
equivocado. Puso un `@AfterAll` que cierra el circuito pasándole llamadas reales, que es la única
palanca que existe en caja negra.

## Lo que la corrida destapó y NO se arregló aquí

**Los mappers no comprueban los campos `required` de la respuesta.** El conversor JSON del
`RestClient` ignora las propiedades desconocidas, así que un cuerpo sin un campo declarado
`required: true` deserializa a `null` y el mapper fabrica un resultado de dominio con ese nulo
dentro: una respuesta que **viola el contrato** pasa por una correcta.

Lo destapó `FL-CMP-003`, que no era distinguible de una inscripción correcta hasta que el agente
de código añadió a mano una guarda en `ComplianceMapper.toRecordWithdrawalResult` — **un archivo
propiedad de build**. Que el arreglo caiga en un archivo build-owned es la misma señal que en el
punto 7 de la corrida anterior: el arreglo va en el generador.

Alcance real: las cuatro llamadas del diseño declaran todos sus campos de respuesta `required` y
solo una tiene guarda. Y la misma omisión está en código que build genera entero — la rama
`if (response == null)` construye el resultado con **todos** los campos a nulo y sigue, pese a que
ya imprime `"el contrato declara N campo(s)"`: build **tiene** la información en el momento de
emitir y no actúa sobre ella.

No se replicó en los otros tres mappers porque **cambiaría el desenlace observable** de esas
llamadas (un `amount` nulo pasaría de degradación silenciosa a 500). Es conductual, es del
generador, y merece su propia decisión — exactamente el mismo razonamiento por el que el fallback
`Throwable` no se arregló de propina en la corrida anterior.

## La segunda tanda: el outbox que nadie había ejecutado

Al preguntarse qué quedaba cubierto de verdad tras la corrida apareció que **la entrega del
outbox no estaba verificada en vivo en `catalog-extended`**. No era sospecha: `keel validate` lo
decía en cada build, y la regla vive en `crossrefs.js:1015` — un escenario que solo afirme que el
evento acaba publicado lo pasa igual un servidor que publica en línea dentro de la transacción.
`FL-PRD-001-A` Then 4 era justo eso.

El inventario destapó que el hueco era más ancho: **`asset-vault` tenía el mismo**. Se escribió
`FL-OBX-001` en las dos —sobre `createProduct`/`ProductCreated` en catalog y sobre
`publishAsset`/`AssetPublished` en asset-vault, elegido frente a `uploadAsset` porque la subida
arrastra el almacenamiento a un escenario que mide el canal—. Ninguna fixture del repo promete ya
`outbox` sin demostrarlo, y se comprobó que el check muerde validando las versiones anteriores:
el aviso estaba en las dos y ya no está.

**Resultado: 35 de 35**, con un ciclo de arbitraje.

### 3. La convención dimensionaba mal la espera, y el agente la siguió

El escenario falló en la primera puntuación. El árbitro dictaminó `culprit: test` y el
diagnóstico es lo más valioso de esta tanda: **el servidor cumplía el `Then` entero y entregó el
evento 1,3 s después de que la prueba dejara de mirar**.

La causa no era el backoff del relay. Con el broker caído el `join()` del productor no falla
rápido: arrastra la conexión muerta hasta `request.timeout.ms` —**30 s por defecto**, y el perfil
`local` no lo baja—, y hasta que Kafka no cancela esa petición el relay sigue bloqueado sin
reintentar. Una ventana de 20 s medida desde `startBroker()` no podía llegar nunca.

Y el error no era del agente: era de **la documentación del generador**.
`conventions/integration-tests.md` decía textualmente que la espera «tiene que cubrir el backoff
del relay» y que «veinte segundos es holgado». El agente siguió esa guía al pie de la letra.

Corregido en el payload con lo que la corrida midió: quien manda es el timeout del cliente del
broker, 60 s es el mínimo prudente con los defaults, y el dato concreto del retraso de 1,3 s
queda escrito para que nadie vuelva a dimensionarlo por el relay. Es el mismo patrón que el punto
1 y que el 7 de la corrida anterior: cuando el arreglo cae en algo que produce `build` —código o
prosa—, el arreglo va en el generador.

Se descartó por escrito la solución fácil (bajar `request.timeout.ms` en el perfil `local`): haría
que la suite midiera un cliente Kafka distinto del que corre en `develop`/`production`.

## El gate `dedupe` dejó de dar falsos verdes

Cerrado el hueco que la corrida de outbox dejó anotado y que este informe listaba como abierto: la
familia `dedupe` de `check-idempotency.sh` comprobaba el **orden y el uso** del guard —que eran
correctos— y salió `OK` con la deduplicación completamente rota.

`insertChecks()` (`src/scaffold/idempotency-check.js`) añade lo que faltaba, y cada pieza es un
defecto real de aquella corrida:

- **`Persistable` en la entidad** — sin él, la clave asignada hace que Spring Data concluya que la
  fila ya existe y ejecute `merge()`: SELECT + UPDATE que no viola la clave y no lanza nada.
- **`isNew()` que consulta el flag, no constante** — `SimpleJpaRepository.delete()` empieza con
  `if (isNew(entity)) return;`, así que un `true` fijo convierte el borrado en un no-op silencioso.
- **`saveAndFlush` del repositorio, no `entityManager.persist`** — el proxy del EntityManager no
  traduce excepciones, y el catch-all acaba en el 500 que los escenarios de carrera prohíben.

En la rama documental el reparto es otro (`insert()` ya fuerza la inserción), así que ahí solo se
prohíbe `save()`, que hace upsert y nunca chocaría.

**Por qué esto va en el script si esas clases las genera `build`**, que no es obvio: el gate existe
para vigilar el trabajo del *agente*, pero esta misma serie demostró que los archivos build-owned
**no son intocables** — el agente de código editó `ComplianceMapper.java`. «Build lo generó bien» y
«está bien en el árbol donde corre el gate» son cosas distintas.

**La primera versión no mordía**, y conviene que quede escrito: el patrón que prohibía el `isNew()`
constante cruzaba dos líneas, y `grep -E` es línea a línea, así que no podía dispararse nunca —
salía verde con el defecto puesto, que es exactamente lo que se venía a corregir. Se detectó
reintroduciendo el defecto en vez de comprobar solo el árbol bueno. Al arreglarlo apareció una
segunda trampa: prohibir `return true;` daba un KO **falso**, porque `equals()` lleva uno legítimo;
la versión final exige la forma correcta (`return !<campo>`) en vez de prohibir la incorrecta.

La regresión (`test/idempotency-check.test.js`) reintroduce los cuatro defectos uno a uno y exige
el rojo con el archivo señalado. Verificado además contra el proyecto real de la corrida.

## Corrección sobre la cobertura de la reconciliación

Este informe y el de outbox afirmaban que la reconciliación «no tiene ningún escenario `FL-*`
detrás» porque un cron no se alcanza en caja negra. **Es falso desde que `stock-reservation` ganó
`FL-REC-001`**, y su propio documento lo dice: `reconcileReservations` ya no es `uncovered`. La
palanca es envejecer la fila —no el reloj del servicio ni el umbral— y esperar un tick del barrido.

Lo que sí es cierto es que esa cobertura **existe en una sola fixture**: ni `catalog-extended` ni
`asset-vault` ejercitan su barrido, y ninguna de las dos tiene los `FL-CLU-*`. Con una salvedad
que importa al decidir si merece la pena repetirlos: los mecanismos que `build` genera enteros y
no varían con el diseño —el reclamo del `OutboxRelay`, el arbitraje de la clave por la clave
primaria— ya están probados y volver a probarlos es ejecutar el mismo código otra vez. Lo que sí
cambia por diseño, y por tanto sigue sin cubrir fuera de `stock-reservation`, es lo que escribe el
**agente**: la consulta de reclamo del barrido y el handler compensador.

## Verificación

- `npm test` en verde en los dos workspaces (472 + 387) con los casos de regresión nuevos.
- Los tests **muerden**: se comprobó revirtiendo el código. La primera versión de la prohibición
  de `Throwable` **no mordía** —cazaba el nombre de la variable, así que `Throwable t` colaba— y se
  endureció para prohibir el tipo. Es la lección del punto 6 de la corrida anterior: un test que
  fija la forma defectuosa sale verde y no distingue nada.
- `compile-check` en verde para los tres brokers.
- **El adaptador compiló de verdad** dentro del pipeline (`./gradlew build -x test`), que es la
  única red real: `compile-check` solo compila el source set `integrationTest` y nunca toca `main`.
- El aviso de outbox de `keel validate` desaparece en las dos fixtures, comprobado que **estaba**
  en las versiones anteriores: un check cuya ausencia no se contrasta no prueba nada.
- El gate `dedupe`/`commandIdempotency` verificado **contra el proyecto real de la corrida**: verde
  con el árbol correcto y rojo con cada uno de los cuatro defectos reintroducidos por separado.

## Lo que sigue abierto

1. **La guarda de campos `required` en los mappers** (arriba). Conductual, del generador, tres
   llamadas más afectadas: su propia decisión.
2. **La cola dead-letter** sigue sin poder asertarse en ninguna fixture. Necesita una primitiva del
   arnés (`deadLetterMessages(<suscripción>, n)`); sin ella, las cláusulas «se confirma sin acabar
   en la DLQ» son `uncovered` por construcción.
3. **`FL-REC-001` en `catalog-extended`**: el barrido lo escribe el agente en cada diseño, así que
   el verde de `stock-reservation` no dice nada de este. Forzaría además a declarar la marca
   temporal de espera que `Product` no tiene y que el barrido suple con `createdAt`.
4. **`asset-vault` no se ha corrido en vivo**: su `FL-OBX-001` está escrito y validado
   mecánicamente, nada más. Asimetría deliberada, no olvido.

## Confirmaciones colaterales

- **El fallback a `podman-compose` de `infra/up.sh` se activó de verdad**: `podman compose ls`
  falló y el lanzador cayó al frontend alternativo. Es el arreglo de la corrida anterior,
  ejercitado por primera vez.
- `record-exceptions` y `retry-exceptions` como listas explícitas son lo que hace que la
  `IllegalStateException` de la guarda no se reintente, no llene la ventana y no la acepte ninguna
  sobrecarga. Los tres efectos son los que `FL-CMP-003` pide y ninguno es accidental.

## Nota de método

El pipeline se ejecutó desde una sesión externa al proyecto, así que los cuatro agentes se
lanzaron como genéricos con la obligación de leer su archivo de `.claude/agents/` y seguirlo. En
el pipeline nativo el candado es el `tools:` del frontmatter; aquí fue una instrucción. Además, el
agente de pruebas **portó** los siete flujos anteriores de una corrida previa del mismo diseño en
vez de volver a derivarlos: siguen siendo derivación del mismo documento y en caja negra, pero el
trabajo nuevo son los tres flujos `FL-CMP-002/003/004`, y es sobre esos donde el resultado
significa algo.
