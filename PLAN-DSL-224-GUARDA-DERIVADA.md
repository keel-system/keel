# Plan: la guarda por clave natural con la clave guardada en otro campo (DSL 2.24)

## Contexto

La corrida de control del 2026-11-05 (`docs/corridas/2026-11-05-notification-mailer-mongo-spring-control.md`) destapó un hueco del generador que llevaba ahí desde los controles del 2026-10-18, en los cuatro generadores.

**El síntoma.** El listener de `NotificationRequested` reclama el mensaje con `IdempotencyGuard.tryRecord(...)` **antes** de despachar `acceptNotificationRequest`. Si el handler falla de forma pasajera, el registro ya está escrito (va en su propia transacción) y el reintento lo confirma como duplicado sin ejecutar nada. El mensaje se pierde, y los cinco reintentos que declara `onFailure.retry` no sirven.

**La causa.** El orden lo decide `triggerHasDomainGuard` (`keel-core/src/lib/gen/model.js`, ~l. 2901). Con guarda de dominio, primero `alreadyProcessed` y después `record`; sin ella, `tryRecord`. Hoy reconoce tres guardas:
- transiciones del lifecycle;
- `idempotency.guard: 'natural-key'`, que `resolveIdempotency` (~l. 3460) solo da cuando `keySource: payload-field` y el `keyField` **se llama igual** que un campo de la `naturalKey` de la entidad escrita;
- el cobro de la capa `payments`.

`acceptNotificationRequest` sí tiene guarda. `Notification` lleva `naturalKey [applicationKey, dedupeKey]`, y por evento `dedupeKey` es `event:<eventId>`. Pero esa derivación vive en una `rule` en prosa, la operación no declara `idempotency` y el campo del input se llama `eventId`, no `dedupeKey`. El modelo no tiene con qué enlazarlos.

**No es un caso nuevo.** Es el mismo hueco que destapó la corrida `user-profile` (2026-10-01), escrito en el comentario de `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` (`crossrefs.js`, ~l. 4364): «La comparación es por NOMBRE —no hay otro enlace en el DSL—, así que un input `callerSubject` frente a una naturalKey `[subject]` cae al almacén sin que nada lo diga, aunque una rule en prosa los iguale». Entonces se resolvió avisando, y la salida era renombrar. Aquí no se puede renombrar: `dedupeKey` lo comparte la puerta HTTP (`requestNotification`, donde es la `Idempotency-Key`) y el `eventId` no es la clave tal cual, sino su materia prima.

**Decisión del usuario (2026-11-05).** Dos piezas:
1. **El enlace en el DSL** (lo que arregla). La declaración de idempotencia puede decir en qué campo de la clave natural acaba la clave. El modelo ve entonces la guarda, y el orden correcto sale en los cuatro generadores sin tocar ninguno, porque la decisión es neutral.
2. **El aviso** (la red). Una suscripción con `onFailure.retry` cuya operación cae en el orden que reclama antes tiene esos reintentos muertos. Es una incoherencia que se ve solo con las capas, y con la pieza 1 ya tiene salida.

Se descartó que el generador libere la marca si el handler falla: tapa el fallo pasajero, pero si el proceso muere entre la marca y el commit el mensaje se pierde igual, y cambia el código que se ejecuta en los cuatro generadores para un caso que el diseño ya resuelve con su clave natural.

**Regla de cada incremento:**
- Cada incremento empieza en un contexto nuevo.
- Abre comprobando en el código lo que este plan da por supuesto (los números de línea son de `dcd7215c`), nunca de memoria.
- Cierra con su red en verde, con su mutación cuando la tiene, con un commit propio y con el estado y el «Para retomar» actualizados en este archivo.

## Estado

| Inc. | Qué | Estado |
|---|---|---|
| 0 | Medir el alcance y fijar el nombre | hecho (2026-11-06) |
| 1 | DSL 2.24: el enlace `storedIn` (schema, validación, modelo) | pendiente |
| 2 | Las notas de los cuatro generadores | pendiente |
| 3 | El aviso: reintentos muertos tras el reclamo | pendiente |
| 4 | El par del MVP declara su guarda | pendiente |
| 5 | Corrida de control | pendiente |

**Para retomar:** empezar por el incremento 1, en un contexto nuevo. Lo medido en el inc. 0 (§ Lo medido) amplía el inc. 1 con dos piezas neutrales más: el predicado del «no existe» y las obligaciones de idempotencia con guarda por clave natural.

## Lo que se descarta, y por qué

| Opción | Motivo |
|---|---|
| Liberar la marca si el handler falla (`tryRecord` + borrado en el `catch`) | Pierde el mensaje igual si el proceso muere entre la marca y el commit. Cambia el código que se ejecuta en cuatro generadores para un caso que la clave natural ya resuelve |
| Solo el aviso | El par del MVP saldría en rojo sin forma honrada de cerrarlo: o acepta perder mensajes, contra lo que dice su propio diseño, o quita los reintentos |
| Inferir el enlace leyendo las `rules` | Es prosa. Inventar un enlace que el diseño no declara es justo lo que `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` se niega a hacer |
| Declarar la transformación (`event:` + `eventId`) en el DSL | El generador no la necesita: la búsqueda por clave natural la escribe el agente desde la `rule`. Lo que falta es saber que la guarda **existe**, no cómo se calcula |

---

## Incremento 0: medir el alcance y fijar el nombre

Sin código. Hay que responder a cuatro preguntas antes de tocar el schema:

- **¿Qué otras fixtures caen en el mismo hueco?** Con `buildModel` sobre todas las de `fixtures/designs/`, listar las suscripciones con `triggerHasDomainGuard: false`, cuántas declaran `onFailure.retry` y, de esas, cuáles tienen una clave natural que una `rule` alimenta desde el input. Las que reintentan sin guarda posible son las que el aviso del inc. 3 pondrá en rojo, y cada una necesita su salida antes de que el aviso entre. Si no, una puerta que nace roja se aprende a ignorar.
- **¿Admite el schema `idempotency` en una operación `internal`?** En `use-cases.schema.json` (~l. 107) no hay nada que lo impida. Hay que confirmar en `crossrefs.js` que ninguna regla lo rechace o le pida algo de HTTP: `OBL-IDEM-KEY-REQUIRED` es solo de `client-key`, y las de los códigos de carrera y de reutilización se saltan con `guard: 'natural-key'` (`declared-errors.js`, ~l. 57).
- **¿Qué obligaciones abre en el par añadir `idempotency` a `acceptNotificationRequest`?** Pasar su `decisions.yaml` por `keel validate --ready` con el cambio en memoria.
- **El nombre.** La propuesta es `storedIn` (`idempotency: { keySource: payload-field, keyField: eventId, storedIn: dedupeKey }`). Hay que cotejarlo con el vocabulario del DSL (`resolvedBy` de `callerIdentity`, `keyField` de `replica`) y con `dsl-reference.md`, y elegir uno que lea bien en las cuatro notas.

**Puerta:** este archivo corregido con lo medido, incluida la lista de fixtures del primer punto.

### Lo medido (2026-11-06, sobre `dcd7215c`)

Los números de línea del plan se confirmaron: `triggerHasDomainGuard` en `model.js:2901`, `resolveIdempotency` en `model.js:3460`, `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` en `crossrefs.js:4377` y el salto de `natural-key` en `declared-errors.js:57`.

**1. Las suscripciones que reintentan sin guarda.** Con `buildModel` sobre las 17 fixtures hay 16 suscripciones. Cinco tienen `triggerHasDomainGuard: false` sin `retry` o con guarda, y no cuentan. Seis reintentan (`maxAttempts: 5`) sin guarda:

| Fixture (¿lista?) | Suscripción → operación | ¿Hay guarda posible? | Salida |
|---|---|---|---|
| `notification-mailer`, `-mongo` (sí) | `NotificationRequested` → `acceptNotificationRequest` | Sí: `naturalKey [applicationKey, dedupeKey]`, con `dedupeKey` derivado de `eventId` en una `rule` | `storedIn: dedupeKey` (inc. 4) |
| `metering-digest` (no, parcial) | `MeterReadingCaptured` → `recordReading` | Sí, y **ya expresable**: `naturalKey [meterId, readAt]` se llama igual que el input | `idempotency: { keySource: payload-field, keyField: <meterId o readAt> }` (inc. 3). Su comentario («la clave llega por la cabecera Idempotency-Key») es anterior a `payload-field` (DSL 2.12) y se corrige |
| `metering-digest` (no) | `MeterDecommissioned` → `decommissionMeter` | La guarda real es la **PK** (`serialNumber` es `id: true`, sin `naturalKey`), y el modelo solo reconoce la `naturalKey` | **Decisión del usuario:** aceptarla en su `decisions.yaml`, con ese motivo. La PK como guarda de idempotencia queda como candidata, fuera de este plan |
| `asset-vault` (sí) | `ThumbnailDelivered` → `noteThumbnailDelivery` | No: es un contador, y la fixture existe para ejercitar la rama `tryRecord` (lo dice su comentario) | Aceptar en `decisions.yaml` (inc. 3) |
| `stock-reservation`, `stock-reservation-events` (sí) | `StockCountAdjusted` → `noteStockCount` | No: contador, rama `tryRecord` a propósito | Aceptar en `decisions.yaml` (inc. 3) |

**La naturaleza del aviso del inc. 3 es `undecided`**, con `warnIn` por suscripción (`messaging.subscriptions.<nombre>`) y aceptable. Hay dos motivos:
- `tryRecord` no deja el `retry` muerto del todo: un fallo antes del reclamo o en el reclamo mismo (la base caída) no deja marca y se reintenta. Muere solo lo que falla después.
- Un contador prefiere legítimamente perder una entrega a contarla dos veces, y las tres fixtures de la rama `tryRecord` existen para eso. Las salidas son tres: declarar la guarda, aceptarlo por escrito, o quitar el `retry`, que con `tryRecord` manda el fallo al descarte, donde se ve, en vez de confirmarlo en silencio.

Tres de las fixtures están en `READY_FIXTURES`, así que el aviso nace rojo en ellas: el inc. 3 las acepta en el mismo commit.

**2. `idempotency` en una operación `internal`.** El schema la admite y ninguna regla la rechaza: `CHK-USECASES-IDEM-*` sin-endpoint (`crossrefs.js:4418`) excluye `payload-field`, y `OBL-IDEM-KEY-REQUIRED` es solo de `client-key`. Pero hay **una asimetría**: `OBL-IDEM-RACE-CODE` y `OBL-IDEM-REUSE-CODE` (`crossrefs.js:3570`) se abren con cualquier `idempotency`, también con la guarda por clave natural, para la que el generador no emite esos códigos (`declared-errors.js:57`). En el par no se nota, porque `requestNotification` ya las abre y las cierra. En `metering-digest` abriría dos obligaciones falsas. **Va al inc. 1**: el predicado «guarda por clave natural» sale de una sola fuente, que también usa `crossrefs.js`.

**3. Lo que abre en el par** (copia en `D:\keel-tmp\dsl224-inc0\`, `--ready` con `idempotency: { keySource: payload-field, keyField: eventId }`, sin `storedIn`, que el schema aún rechaza):
- `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL`. Lo cierra `storedIn`.
- `CHK-SCEN-IDEM-RACE`. Ningún escenario de `acceptNotificationRequest` cubre la carrera. El inc. 4 escribe uno: dos entregas simultáneas del mismo `eventId` dan un solo correo y el descarte sigue vacío. Hay que medir si el arnés llega a solaparlas, porque con un consumidor por cola se serializan; si no las solapa, se dice en sus notas de determinación. Tocar el escenario recarea ese flujo.
- Ninguna obligación nueva.

**Efecto colateral que el plan no preveía.** Con la guarda, `retriesMissingTarget` (`dead-letter.js:240`) pasa a `true` en la cola de `NotificationRequested`, en los tres brokers (medido con `missingTargetRetryDestinations`). `TEMPLATE_NOT_FOUND` es de la clase 404, porque `model.errors` lleva la primera declaración (404, en otra operación), así que la vía de eventos lo reintentaría cinco veces. Pero `acceptNotificationRequest` lo declara 422, y FL-EVT-002 afirma que llega al descarte «a la primera». **Decisión del usuario: afinar el predicado en el inc. 1.** El destino no reintenta el «no existe» si la operación disparada declara con otro `http` un `code` que es de la clase 404 (el `http` de esa operación sale de `operationError`, `declared-errors.js`). El diseño no cambia.

**Versión del par: patch (`v2.1.1` → `v2.1.2`), no minor.** `methodology.md` § Versionado: es una regla reescrita sin cambiar comportamiento, porque la operación es interna y el contrato HTTP y de eventos no cambia. El comportamiento que se declara es el que la `rule` ya decía. Así `review.yaml` no caduca; el careo sí se recarea en el flujo que se toque.

**4. El nombre: `storedIn`.** El vocabulario del DSL nombra campos con `<verbo>As`/`<verbo>By`/`<verbo>From` (`exposedAs`, `fedBy`, `keyFrom`, `resolvedBy`), y `keyField` ya es el campo del input. `storedIn` completa la frase: «la clave `eventId` se guarda en `dedupeKey`». Se descartó `storedAs`: sugiere un formato, y lo que se nombra es un campo.

**Lo que no se puede medir desde el arnés** (pregunta del inc. 5): el fallo pasajero a mitad del handler. Ya lo dicen las notas de FL-EVT-002 («provocarlo exige tirar el almacén a mitad de un consumo»), y hoy su red, el gate estático, prescribe justo el orden equivocado. No hay escenario `FL-*` nuevo para esto.

## Incremento 1: DSL 2.24, el enlace `storedIn`

- **Schema.** El enum de `properties.keel` de `service.schema.json` se **sustituye** por `2.24` (se soporta una sola versión). `storedIn` va en `$defs/idempotency` de `common.schema.json`, solo con `keySource: payload-field` (un `allOf` como el de `partitionBy`). Su descripción tiene que decir qué es: el campo de la entidad escrita que guarda la clave, cuando no se llama como ella.
- **Validación** (`crossrefs.js`, junto a `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL`). Cada regla nueva lleva su id, su entrada en `checks.js` y su mutación en `test/design-mutations/catalog.js`:
  - `storedIn` tiene que ser un campo de la entidad que la operación escribe (`CHK-USECASES-IDEM-STOREDIN-UNKNOWN`, error).
  - Tiene que estar en su `naturalKey`, porque si no, no es la guarda (`CHK-USECASES-IDEM-STOREDIN-NOT-NATURAL`, error: declarar un enlace que no lleva a ninguna guarda es una incoherencia, no una pregunta).
  - El mensaje de `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` pasa a nombrar `storedIn` como la salida cuando no se puede renombrar.
- **Modelo.** En `resolveIdempotency`, el campo que se compara con la `naturalKey` es `storedIn ?? keyField`. La política resuelta lleva los dos (`keyField` y `storedIn`), porque la nota del handler tiene que nombrar los dos. `triggerHasDomainGuard` no cambia: ya lee `guard === 'natural-key'`.
- **Una sola fuente para «guarda por clave natural»** (lo medido, punto 2). `OBL-IDEM-RACE-CODE` y `OBL-IDEM-REUSE-CODE` dejan de abrirse por una operación cuya idempotencia es `natural-key`: es el mismo salto que hace `declared-errors.js:57`. El predicado se extrae a una función neutral de `gen/` que usan `resolveIdempotency` y `crossrefs.js`. Lleva su caso en `test/crossrefs.test.js` y, si cambia algún id, su mutación.
- **El «no existe» que la operación declara con otro `http`** (lo medido, efecto colateral). `retriesMissingTarget` (`dead-letter.js`) exige además que la operación disparada no declare con un `http` distinto de 404 un `code` que en `model.errors` es de la clase 404. El `http` de esa operación sale de `operationError`. Se prueba en `keel-core` con el par, que hoy es el único caso: sin `storedIn` el resultado no cambia, con `storedIn` el destino no aparece en `missingTargetRetryDestinations`. Su contrario va sobre un diseño sintético que declara el 404.
- **Docs.** `docs/dsl/use-cases.md`, la fila del historial en `dsl-reference.md` y `docs/validation-scenarios.md` si habla de la guarda.
- **Versión.** `SUPPORTED_DSL`, el `keel.dsl` del `package.json` y el README de los cuatro generadores; la plantilla `templates/service/service.keel.yaml`; el `keel` de todas las fixtures; y el corpus de mutaciones (su base sigue en silencio).
- **Fuera de este plan:** el registry, que ya está pendiente de subir a 2.22, sube a 2.24 cuando se publique.
- **Puerta:**
  - `npm test`, los cinco paquetes;
  - `npm run design-matrix --workspace packages/keel-core`, con los dos ids nuevos falsados.

## Incremento 2: las notas de los cuatro generadores

Con el modelo arreglado, el orden del listener ya sale bien en los cuatro. Lo que queda es que las notas **digan** la guarda tal como es:

- **El javadoc del `<Evento>Message`** (`keel-spring/src/scaffold/messaging.js` ~l. 538, y sus homólogos en keel-nest ~l. 670, keel-dotnet ~l. 646 y keel-go ~l. 1043). En la rama `natural-key` tiene que nombrar el campo guardado cuando difiere del de la clave («la clave `eventId` se guarda en `dedupeKey`, que es parte de la clave natural»). Si no, el agente busca por un campo que la entidad no tiene.
- **La nota del handler** (`keel-spring/src/scaffold/services.js` ~l. 598 y sus homólogos). El algoritmo («busca por la clave natural ANTES de insertar») tiene que decir que el valor de búsqueda sale de la `rule` que deriva el campo, no del input tal cual.
- **El gate de `check-idempotency.sh`** (`idempotency-check.js` ~l. 397) lee la misma bandera, así que pasa solo de exigir `tryRecord` a exigir `alreadyProcessed`/`record`. Hay que comprobarlo con un caso que lo **ejecute** sobre el proyecto emitido, no con una cadena.
- **Pruebas:**
  - un caso en `keel-core` con un diseño sintético (`keyField` ≠ `storedIn`) que afirma `guard: 'natural-key'` y `triggerHasDomainGuard: true`, y su contrario sin `storedIn`;
  - y uno que compare la frase de los cuatro generadores, como `keel-go/test/error-notes.test.js` hace con los errores.
- **Puerta:**
  - `npm test`;
  - `compile-check` sobre el par;
  - `ts-syntax`, `cs-syntax` y `go-syntax`, que ya corren dentro de `npm test`.

## Incremento 3: el aviso de los reintentos muertos tras el reclamo

- **La regla.** Una suscripción con `onFailure.retry` cuya operación disparada no tiene guarda de dominio prescribe el reclamo antes de despachar, y entonces el reintento de un fallo pasajero ve el mensaje como procesado y no hace nada. Va en `crossrefs.js` con id propio (propuesta: `CHK-MESSAGING-RETRY-AFTER-CLAIM`) y su entrada en `checks.js`.
- **Su naturaleza** (decidida en el inc. 0): `undecided`, con `warnIn` por suscripción (`messaging.subscriptions.<nombre>`) y aceptable en `decisions.yaml`. El mensaje nombra las tres salidas: declarar la guarda (transiciones o `idempotency`, con `storedIn` si hace falta), aceptarlo, o quitar el `retry`.
- **Una sola fuente para el predicado.** `crossrefs.js` ya importa de `gen/model.js`, pero no puede recalcular «tiene guarda» por su cuenta: si dos fuentes deciden lo mismo, acaban decidiendo distinto. El predicado se extrae a una función neutral de `keel-core/src/lib/gen/` (p. ej. `triggerDomainGuard(op, layers)`), que usen `model.js` y `crossrefs.js`.
- **Mutación** en `test/design-mutations/catalog.js`, sobre una extensión limpia del corpus que tenga suscripción con `retry` y guarda, y que afirme ese id y solo ese.
- **Las fixtures que el inc. 0 encontró en rojo** se cierran en este incremento, cada una con su salida (tabla de § Lo medido). Todas salvo el par, que es el inc. 4:
  - `asset-vault`, `stock-reservation` y `stock-reservation-events`: aceptación en `decisions.yaml`. Son contadores en la rama `tryRecord` a propósito, y siguen en `--ready`.
  - `metering-digest.recordReading`: declara su `idempotency` con `payload-field` y corrige el comentario viejo.
  - `metering-digest.decommissionMeter`: aceptación, con el motivo de que la guarda es la PK.
- **Puerta:**
  - `npm test`;
  - `npm run design-matrix`.

## Incremento 4: el par del MVP declara su guarda

- `acceptNotificationRequest` gana `idempotency: { keySource: payload-field, keyField: eventId, storedIn: dedupeKey }` en **las dos** fixtures a la vez, con las capas idénticas salvo `persistence` y `service`.
- **El escenario de la carrera** que pide `CHK-SCEN-IDEM-RACE` (lo medido, punto 3): un `FL-EVT-001-C` con dos entregas simultáneas del mismo `eventId`.
- **Versión del par: `v2.1.1` → `v2.1.2`, patch** (decidido en el inc. 0). El coste sigue siendo la regla de la fila del par en `CLAUDE.md`:
  - tocar el YAML recarea el careo **entero**;
  - `review.yaml` no caduca con un patch;
  - `DESIGN.md` de `fixtures/design-docs/` se rehace en los dos.

  Tiene que seguir en 10/10 de `--ready`: lo fija `test/mvp-ready.test.js`.
- **Una línea en `review.yaml`.** La que hoy dice en prosa que la guarda es la clave natural pasa a citar la declaración.
- **Medida, sin corrida.** Regenerar el par con build en `D:\keel-tmp\` y comprobar que:
  - el javadoc del `NotificationRequestedMessage` prescribe `alreadyProcessed` + `record` en los cuatro generadores;
  - y `check-idempotency.sh` sale ROJO sobre un listener que reclame antes y VERDE sobre el que comprueba y registra después. Es la falsación del gate.
- **Puerta:**
  - `npm test`, con `mvp-ready`;
  - `store-check`, cuyo sujeto es este par;
  - `compile-check` sobre el par.

## Incremento 5: corrida de control

- Corrida sobre el par con keel-spring, por el flujo normalizado. La lanza el usuario; no tocar el proyecto mientras corre.
- **Qué mide:**
  - que los escenarios siguen 23/23 y la huella no crece (referencia: 17 en los dos, `2026-11-05-*-spring-control.md`);
  - y que el listener que escribe el agente comprueba y registra **después** de despachar.
- **Lo que no puede medir.** Ningún escenario de caja negra ve el mensaje perdido: haría falta un fallo pasajero de la base a mitad del handler. Su red es el gate estático de `check-idempotency.sh`, falsado en el inc. 4. Si el inc. 0 encuentra una forma de provocarlo desde el arnés (la base parada entre la entrega y el commit), se escribe el escenario `FL-*` en el par y se dice aquí.
- Registro en `docs/corridas/<fecha>-<servicio>.md`, con la tabla de etiquetas fijas.
- Si la corrida sale limpia, keel-nest, keel-dotnet y keel-go no la repiten: su cambio es el javadoc, comparado en el inc. 2.
- **Cierre del plan:** mover este archivo a `completed_plans/` y borrar la memoria `keel-guarda-listener-tryrecord`.

## Verificación común

En cada incremento:
- `npm test`, todos los workspaces, porque el cambio es neutral y lo emiten los cuatro;
- `npm run design-matrix --workspace packages/keel-core`, si entra un id;
- las redes en vivo que nombra cada incremento.

Los temporales van en `D:\keel-tmp\dsl224-inc<N>\` y se limpian al terminar.
