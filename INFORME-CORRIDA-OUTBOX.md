# Informe de corrida — stock-reservation (outbox, compensación e idempotencia)

Corrida completa del pipeline sobre `specs/stock-reservation` v1.0.0 en un workspace de
diseño externo al repo, con la fixture `packages/keel-spring/test/fixtures/stock-reservation/`
**ampliada** para ejercitar por primera vez los cinco caminos caros de estos mecanismos.

**Resultado**: 13 de 13 escenarios `FL-*` en OK; 2 ciclos de arbitraje consumidos de un cupo
de 3, más un escenario añadido después del cierre (`FL-RES-001-D`) que destapó un cuarto
defecto. Pase de calidad `status: OK` con las cinco familias de `check-idempotency.sh` en OK,
`contextTest: OK` y `baseline: OK`. Stack: PostgreSQL 16 + Kafka + WireMock sobre podman en
Windows, JDK 21.

## El punto de partida

`keel validate` ya exigía tres escenarios de cobertura —canal indisponible, carrera de la
clave de idempotencia y doble entrega simultánea de una compensación— y **ninguna fixture del
repo los satisfacía**. El arnés tenía las primitivas desde hacía tiempo (`stopBroker`,
`raceOf`, `race`, `db`, `stubRequestHeader`) y `broker-check` probaba la palanca, pero ningún
escenario las usaba: los caminos que esas primitivas existen para ejercitar nunca se habían
ejecutado.

Cuatro cambios al diseño de la fixture lo hicieron materializable: cron del barrido a
`* * * * *` (la frecuencia y el umbral son cosas distintas; solo la primera se acorta),
`optimisticLocking: all` en vez de `none`, y una suscripción `StockCountAdjusted` →
`noteStockCount` **sin `transitions`** con un contador detrás, que es lo único que hace
observable en caja negra la rama `tryRecord` del guard.

## Defectos del generador (los tres bloquearon la corrida)

Los tres están **corregidos en el generador y congelados** como regresión en
`packages/keel-spring/test/scaffold.test.js`.

### 1. El registro de procesados no deduplicaba nada

`ProcessedEventWriter.insert` hacía `repository.saveAndFlush(...)` sobre `ProcessedEventJpa`,
que tiene la clave **asignada** (`@EmbeddedId`, sin `@Version` ni `Persistable`).
`SimpleJpaRepository.isNew()` mira el id, lo ve no nulo, concluye que la fila ya existe y hace
`merge()`: un SELECT + UPDATE que **no viola la clave primaria y no lanza nada**. `record()` y
`tryRecord()` devolvían `true` siempre.

El javadoc de la clase afirmaba justo lo contrario —«la unicidad la impone la clave primaria,
no una consulta previa»— y era falso desde el principio.

**Por qué nadie lo había visto**: la rama `alreadyProcessed`+`record` tiene dos redes que lo
tapan (la consulta previa filtra la reentrega secuencial; la transición de lifecycle absorbe
la doble entrega simultánea). `tryRecord` no tiene ninguna de las dos, y esa rama —aunque
`catalog-extended` la genera— **nunca se había ejecutado en vivo**.

Corregido en `src/scaffold/idempotency.js` y `src/scaffold/http-idempotency.js`:
`ProcessedEventJpa` e `IdempotencyRecordJpa` implementan `Persistable` con `isNew()` siempre
`true`, correcto porque ambas tablas son de solo inserción.

### 2. El desenlace de la carrera acababa en 500

Apareció **al corregir el 1**, y solo era visible una vez que la carrera estaba de verdad
arbitrada por la clave: `FL-RES-001-C` pasaba antes porque `merge` no chocaba nunca.

El primer intento de fix usó `entityManager.persist(...)` + `flush()` dentro de un
`@Component`. La traducción de excepciones de Spring solo actúa **al salir de un método
proxeado**, y el proxy del `EntityManager` compartido no traduce: salía un
`ConstraintViolationException` de Hibernate crudo que ningún `catch` de
`DataIntegrityViolationException` reconoce, y el catch-all del `ApiExceptionHandler` lo
convertía en 500 — el resultado que el escenario nombra como prohibido.

Matiz que conviene retener: **anotar el adaptador con `@Repository` tampoco habría bastado**,
porque la traducción habría ocurrido al salir del método y el `catch` está dentro.

Corregido volviendo a `saveAndFlush` del **repositorio** (cuyo proxy sí traduce), con el
INSERT forzado por `Persistable` en la entidad. Las tres piezas son necesarias y ninguna
sobra: `Persistable` para que sea INSERT, el repositorio para que la excepción se traduzca, y
el `flush` para que salte ahí y no en el commit del mediador.

### 3. El canal no se podía leer con el broker parado a propósito

Lo reportó el agente de pruebas como `blocker` en la fase 1, sin parchearlo — correcto, el
arnés es salida de `build` y está fuera de su alcance.

Con el broker caído la lectura falla por **transporte**, y la única tolerancia existente era
para `Unknown topic or partition`. Así que `FL-OBX-001` Then 3 —«el canal sigue vacío durante
la caída»— no era asertable, y ese `Then` es la **única** cláusula que distingue un servicio
con outbox de uno que publica en línea dentro de la transacción.

Corregido en `src/scaffold/integration-tests.js`: `stopBroker()` marca un flag que
`startBroker()` limpia **después** del sondeo de readiness, y las tres rutas de lectura
(Kafka, RabbitMQ, SNS/SQS) traducen a «canal vacío» el fallo ocurrido con ese flag activo. La
condición es el flag y no el tipo de error: una infraestructura que se cae por su cuenta sigue
reventando la suite donde se cae.

Este fue el único de los tres que `java-syntax.test.js` no bastó para validar: la primera
versión no compilaba en la rama Kafka (el helper no se emitía en ese template) y lo cazó
`compile-check`, que es exactamente para lo que existe.

### 4. La clave quedaba inutilizable entre su caducidad y la purga

Encontrado **después** de cerrar la corrida, al preguntarse qué quedaba sin cubrir. Tiene dos
mitades y conviene separarlas:

- **En la rama documental el defecto es original**, no una regresión: `find` descarta el
  documento caducado, el handler ejecuta y el `insert` choca contra un `_id` que sigue ahí.
  Cualquier servicio documental con `idempotency` lo tiene hoy.
- **En la relacional lo introduje yo con el fix 1**: `merge` sobrescribía la fila caducada y
  el comportamiento era correcto por accidente, con el mismo mecanismo que impedía deduplicar.

Efecto: reutilizar una clave pasada su ventana devuelve `409 IDEMPOTENCY_KEY_IN_PROGRESS`
hasta que la purga —diaria, por lotes— retire la fila. La ventana real de deduplicación pasaba
a fijarla la cadencia de la purga en vez del `ttlSeconds` del diseño, que es justo lo que ese
campo compra.

Corregido en las dos ramas: quien escribe la clave **retira** el registro caducado antes de
insertar, con el filtro complementario exacto del de `find`.

### 4b. Y el fix del 4 destapó el más sutil de todos

La primera versión no funcionó, y el escenario lo demostró en vivo: la fila caducada
sobrevivía intacta. La causa es una interacción entre los dos fixes anteriores.

`SimpleJpaRepository.delete(entity)` empieza con `if (entityInformation.isNew(entity)) return;`.
Como el fix 1 hizo que `isNew()` devolviera **siempre `true`**, el borrado era un **no-op
silencioso**: el arreglo del INSERT había desactivado el DELETE, y nada lo delataba.

Corregido haciendo que `isNew()` **no sea constante**: un flag transitorio que `@PostLoad`
pone a `true`. Una fila recién construida sigue siendo nueva —`persist`, y la clave primaria
sigue arbitrando la carrera, que es lo que `FL-RES-001-C` comprueba— y una leída de la base ya
no lo es, así que se puede borrar. Es el patrón canónico de Spring Data para claves asignadas,
y el `true` constante era un atajo que solo funcionaba mientras nadie borrara.

## Revalidación de la rama documental

Los cuatro fixes se probaron sobre PostgreSQL. Para revalidar la rama documental se generó el
**gemelo documental del mismo diseño** —`stock-reservation-doc`, idéntico salvo
`persistence.default.model: document` y el nombre— en vez de correr `asset-vault`: deja la
persistencia como única variable y convierte los 13 escenarios en lo que
`validation-scenarios.md` declara ser, un contrato de equivalencia entre implementaciones.

**Resultado: 13 de 13 en OK a la primera, cero ciclos de arbitraje**, con las cinco familias
del gate en OK, `contextTest: OK`, `indexes: OK` e `indexesTested: OK`. Las dos
implementaciones del mismo diseño se comportan igual en los trece escenarios, incluidos los
cinco caminos caros.

Reparto de los fixes en esta rama:

| Fix | En Mongo |
|---|---|
| `Persistable` / `merge` | **N/A** — `insert()` ya forzaba la inserción; era exclusivo de JPA |
| Traducción de excepciones | **N/A** — `DuplicateKeyException` ya es `DataIntegrityViolationException` |
| Flag de caída del broker | **Verificado en vivo** (`FL-OBX-001`), antes solo compilado |
| Retirada del registro caducado | **Verificado en vivo** (`FL-RES-001-D`); aquí el defecto era ORIGINAL |

Dos observaciones de método, ambas favorables al diseño de los escenarios: el agente de
pruebas documental llegó **por su cuenta** a la misma primitiva que el relacional para las
reentregas (una ventana de estabilidad en vez de una lectura puntual, con otro nombre), y no
reportó ningún `blocker` — donde el relacional sí lo hizo, porque el defecto que lo motivaba
ya estaba corregido.

### 5. Las constraints declaradas en la entidad no se comprobaban en la frontera

Lo destapó la divergencia entre las dos suites: el agente relacional dejó los casos borde de
`quantity: 0` y `sku` de 33 como `uncovered` («inventar el status es contrato inventado») y el
documental los implementó — y fallaron con `400` pero `code: null`.

`domain.keel.yaml` declaraba `constraints: { min: 1 }` y `{ maxLength: 32 }` en la entidad,
pero `use-cases.keel.yaml` **no las repetía en el input de la operación**. El generador emite
la validación desde el input, así que el command solo llevaba `@NotNull`/`@NotBlank`: la
violación viajaba hasta el agregado y salía como un 400 sin `code`, que ningún escenario puede
afirmar. Es un hueco **compartido por las dos ramas** —en la relacional simplemente no había
prueba que lo tocara—, no una diferencia entre motores.

Corregido en el diseño de la fixture declarando las constraints también en el input, con la
nota de por qué van en los dos sitios. `build` pasa a emitir `@Size`/`@Min` y el rechazo es
`VALIDATION_ERROR`. Suite documental: **19 de 19 pruebas, 0 fallos**.

Las **dos ramas se regeneraron** con ese cambio y se repuntuaron: relacional 13/13 (17
pruebas, 0 fallos) y documental 13/13 (19 pruebas, 0 fallos), con las cinco familias del gate
en OK en ambas. El `CreateReservationCommand` que produce `build` es ahora **idéntico en las
dos ramas** salvo el nombre del paquete —`@NotBlank @Size(max = 32)` y `@NotNull @Min(1)`—,
que es la comprobación de que la frontera aplica el mismo contrato con los dos motores.

La diferencia de conteo (17 frente a 19) no es una divergencia de comportamiento: son las dos
pruebas de los casos borde que solo la suite documental escribió. Portarlas a la relacional
haría las dos suites literalmente equivalentes; hoy lo que está probado como equivalente son
los trece escenarios `FL-*`.

**Candidato a regla de validación**: `keel validate` podría avisar cuando el input de la
operación que crea una entidad no repite las constraints que esa entidad declara. Hoy nada lo
delata, y el síntoma —un 400 sin `code`— aparece lejos de la causa.

## La corrida multi-réplica

El hueco estructural que quedaba: los escenarios de carrera corrían con **dos hilos de la
misma JVM**, que comparten pool de conexiones, planificador y reloj. Tres garantías de este
diseño no dicen «esto es correcto» sino «esto es correcto **aunque haya varias instancias**» —
el reclamo del relay con `SKIP LOCKED`, el del barrido (`@Scheduled` corre en todas las
réplicas) y el arbitraje de la clave de idempotencia por la clave primaria «aunque las dos
peticiones ni siquiera estén en el mismo proceso»— y ninguna se ejercitaba.

### La primitiva: `startReplica()`

El arnés gana una segunda instancia del servicio. Es un **proceso aparte lanzado desde el
jar**, no un segundo contexto de Spring, y las dos razones importan:

- **De alcance**: lo que se contrasta es que dos procesos con pools, planificadores y relojes
  propios no se pisan. Dos contextos en la misma JVM comparten demasiado para que el resultado
  signifique lo que dice.
- **Estructural**: el source set de las pruebas deja `src/main/java` fuera del
  `compileClasspath` —esa es la caja negra—, así que el arnés no puede ni **nombrar** la clase
  de aplicación para arrancarla. Lanzar el jar respeta las dos cosas a la vez.

`infra/score-scenarios.sh` ejecuta `bootJar` antes del humo: un jar viejo levantaría una
réplica con código distinto del que se está puntuando. Se genera solo para diseños con outbox,
operación programada o idempotencia declarada — al resto no se le cobra el medio minuto.

### Los tres escenarios

- **`FL-CLU-001`** — cinco confirmaciones simultáneas con dos relays vivos: en el canal hay
  **exactamente cinco** eventos. Sin reclamo, los dos relays leen el mismo lote y publican
  diez. Cinco filas y no una porque con una sola la ventana de solape es tan estrecha que el
  escenario pasaría por suerte.
- **`FL-CLU-002`** — cinco reservas envejecidas con dos barridos vivos: el proveedor recibe
  **exactamente cinco** cancelaciones. Se cuentan las llamadas *recibidas* y no su efecto,
  porque la idempotencia saliente absorbería los duplicados: lo que se mide es el reclamo, no
  la red que hay debajo.
- **`FL-CLU-003`** — la misma clave a la vez contra **procesos distintos**. Es lo que
  `FL-RES-001-C` no puede probar: que el árbitro sea la base y no un candado en memoria. Un
  servidor que resolviera la carrera con un `synchronized` o un caché local pasa
  `FL-RES-001-C` y falla aquí — y es la implementación que se escribe sola si nadie la prueba.

### Resultado

**16 de 16 en OK**, con las cinco familias del gate en verde. Las tres afirmaciones se
sostienen: el generador ya las implementaba bien, y lo que faltaba era poder demostrarlo.
Un resultado sin defectos es un resultado: lo que cambia es que dejan de ser razonadas.

Detalle de método aportado por el agente de pruebas y que conviene conservar: las mitades
negativas («ni uno más», «exactamente cinco») se afirman tras una ventana deliberada posterior
al `await` de la mitad positiva. Contarlas en el instante en que se cumple lo positivo no daría
ocasión al duplicado de aparecer.

## La compensación con activación de vuelta (catalog-extended)

Punto de partida, y una corrección: **ninguna fixture del repo declaraba una compensación que
avisara al proveedor**. `stock-reservation` no la tenía y `catalog-extended` tampoco — el
propio gate lo decía al generarlo («el diseño no declara activación de vuelta, así que solo
devuelve el estado propio»). Esa mitad del mecanismo no es que no se hubiera corrido: **no se
había generado nunca**.

Se le añadió a `compliance` lo que le faltaba: la llamada `cancelWithdrawal`
(`DELETE /withdrawals/{productId}`, con `idempotency: payload-hash`, retry y fallback) y la
activación `triggeredBy: [reactivateWithdrawnProduct]` con `awaits: outcome` y
`onFailure: ignore`. Con eso el gate pasa de no exigir nada a exigir `ComplianceClient` en el
handler compensador, y `build` cablea la mitad saliente: inyecta el cliente y deja la nota del
orden obligatorio —transición del agregado primero, llamada después—, porque la llamada no es
transaccional y un rollback dejaría el trabajo deshecho en el otro servidor sin nada que lo
rehaga.

**Resultado: 31 de 31 escenarios en OK**, un ciclo de arbitraje consumido de un cupo de 4, con
las cinco familias del gate en verde, `contextTest: OK` y `baseline: OK`. La compensación
completa quedó verificada por `FL-CMP-001-B` (la llamada ocurre y lleva `Idempotency-Key`),
`-C` (una reentrega no la duplica) y `-D` (dos entregas simultáneas tampoco).

### 6. Todo `PATCH` con una constraint en un campo opcional nacía respondiendo 500

El defecto que destapó esta corrida, y el más barato de sufrir en producción.

**Síntoma**: `FL-PRD-002-D` y `-E` en rojo con `500` y `code: null`.

**Causa**: `build` emitía `@Size(max = 200) JsonNullable<String> name`, con la constraint sobre
el **contenedor**. Hibernate Validator resuelve el validador por el tipo declarado —antes de
mirar el valor— y lanza `UnexpectedTypeException` (HV000030) en **toda** petición que traiga el
campo, válida o no. No es que la validación no se aplicara: es que el endpoint entero
respondía 500.

**Por qué nadie lo vio**: había un test que fijaba exactamente la forma defectuosa, con un
comentario que explicaba el razonamiento equivocado («sin el value extractor, un `@Size` sobre
`JsonNullable` no se evalúa nunca»). La suite salía verde porque un `includes(...)` encuentra
la anotación y encuentra el tipo, y **ninguna comparación de cadenas distingue dónde está
puesta**. Es el caso puro de lo que `compile-check` y las corridas existen para cubrir — y ni
siquiera `compile-check` lo habría visto, porque compila.

**Fix** en `src/scaffold/services.js`: la constraint va dentro del genérico
—`JsonNullable<@Size(max = 200) String>`—, que además es lo que dice el contrato (la
restricción es del valor, no de que el campo venga). La regresión ahora **prohíbe
explícitamente** la forma vieja.

### Y un hueco de contrato que se cerró en vez de declararse

`FL-PRD-004-D` llevaba anotado como hueco: retirar un producto ya retirado se rechazaba, pero
`use-cases` no declaraba `code` ni status, así que ningún escenario podía afirmar sobre él. Se
declaró `PRODUCT_NOT_RETIRABLE` (409) y el escenario dejó de ser `NO_EJERCITADO`. Su `Then`
añade la cláusula que importa: el rechazo ocurre **en el agregado**, antes de encargar nada, así
que un reintento no inscribe una segunda retirada en el registro regulatorio.

## Los dos arreglos de infraestructura pedidos aparte

- **El sondeo del frontend de compose.** `deploy/up.sh` caía a `podman-compose` si
  `podman compose version` fallaba — pero ese comando lo contesta el binario delegado sin
  tocar el motor, así que sale `0` incluso cuando no puede hablar con podman. El fallback no
  se activaba nunca y el `up` moría con un error de named pipe que no menciona compose. El
  sondeo ahora es `compose ls`, que para contestar tiene que llegar al motor.
- **`infra/` no tenía lanzador.** Todo el repo mandaba un `compose up -d` a pelo, que en esta
  máquina falla, y es el primer comando de la fase de infraestructura del pipeline. Se generan
  `infra/up.sh` e `infra/down.sh` con la misma resolución que `deploy/`, compartida en
  `devtools.js` para que no puedan divergir.

## Carencias del arnés (pendientes)

- **No hay forma de afirmar sobre la cola dead-letter.** Tres cláusulas «el mensaje se
  confirma sin acabar en la DLQ ni reintentando» quedaron `uncovered`. Lo sustantivo (la
  ausencia de segundo efecto) sí está asertado, y de forma sostenida. Propuesta del agente de
  pruebas: un `deadLetterMessages(<suscripción>, n)` generado junto a cada `deliverXxx`.
- **El gate estático no ve este defecto.** `check-idempotency.sh` familia `dedupe` salió `OK`
  con la deduplicación completamente rota, porque verifica el **orden** del guard —que era
  correcto— y no que la escritura del registro sea un INSERT real. La regresión quedó en el
  test del repo; cerrarlo también en el script exigiría comprobar que la entidad implementa
  `Persistable`.

## Evaluado y descartado

El pase de calidad propuso extender `Persistable` a `OutboxEventJpa` para ahorrar un SELECT
por evento publicado. **Sería un bug**: el relay hace `outboxRepository.save(row)` sobre una
fila cargada y mutada (`markPublished`, conteo de reintentos), así que ahí `merge` es
obligatorio. La diferencia con las otras dos tablas es justo la que justifica el fix —
aquellas son de solo inserción, esta es read-modify-write.

## Huecos del diseño (`designGaps`)

Son de la fixture, no del generador. Los dos primeros son los que importan:

1. **`IDEMPOTENCY_KEY_IN_PROGRESS` no está declarado** en `use-cases.keel.yaml`, pese a ser el
   desenlace de la carrera y estar fijado por `FL-RES-001-C`. El comportamiento es correcto;
   el contrato público está sin escribir.
2. **`noteStockCount` no tiene guarda de dominio.** Al no declarar `transitions`, la única
   protección contra la repetición es el registro de procesados, lo que obliga al orden
   `tryRecord` — que cierra la ventana del duplicado a cambio de perder el mensaje si el
   handler falla. Dar identidad al recuento (un `lastCountSequence` que solo avance) permitiría
   el orden que no pierde mensajes.
3. Clave de idempotencia reutilizada con otro cuerpo: sin error declarado.
4. `optimisticLocking: all` sin error declarado para la modificación concurrente; el
   scaffolding cae en `OPTIMISTIC_LOCK_CONFLICT`, un `code` que el diseño no conoce.
5. Las tres suscripciones comparten canal sin `contract.discriminator`.
6. `reconcileReservations` no declara el texto del `releaseReason` con el que se rinde.
7. `orderId` es única por dos caminos (`naturalKey` y `unique: true`).

## Observación sobre el método de esta corrida

El pipeline se ejecutó desde una sesión externa al proyecto, así que los cinco agentes se
lanzaron como agentes genéricos cuyo primer paso obligatorio era leer su archivo de
`.claude/agents/` y seguirlo, con las restricciones repetidas en el prompt. En el pipeline
nativo el candado es el `tools:` del frontmatter; aquí fue una instrucción. Los reportes son
consistentes con haberlas respetado —y el source set respalda la más importante, dejando
`src/main/java` fuera del `compileClasspath` del arnés—, pero la garantía es más débil y
conviene tenerlo en cuenta al leer el resultado.

## Verificación del port

`npm test` en verde en los dos workspaces (472 + 373) con los casos de regresión nuevos;
`compile-check` en verde para `stock-reservation` con los tres brokers; y los cuatro archivos
que `build` genera —`AbstractFlowIT`, `ProcessedEventWriter`, `ProcessedEventJpa`,
`JpaIdempotencyStore`, `IdempotencyRecordJpa`— sustituidos en el proyecto de la corrida por
los que produce el generador corregido, con la suite re-puntuada al 100%: es lo que prueba que
la versión del generador y la que corrió son la misma cosa.
