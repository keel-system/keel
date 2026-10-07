# Listeners de SNS/SQS en keel-nest

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —la cola, la DLQ, la curva del
reintento, el borrado del mensaje— lo pone la conexión de build según lo que haga tu handler: **retornar es
confirmar (el mensaje se borra), lanzar es fallar**. Eso convierte cada `return` y cada `throw` del listener en
una decisión sobre si un mensaje se pierde.

## Una cola por suscripción

Cada suscripción tiene su cola propia, `<servicio>-<evento>` (`MessagingSettings.subscriptions[<e>].queue`),
suscrita al topic de la FUENTE con raw delivery y una `FilterPolicy` por su `eventType`. Por eso, a diferencia
de RabbitMQ, a la cola de una suscripción solo le llegan los mensajes de su tipo, y el listener es **uno por
suscripción**, registrado con `connection.consume('<Suscripción>', …)`. La comprobación del tipo en el listener
sigue valiendo la pena: es una línea y no depende de que el filtro esté bien sembrado.

Con raw delivery el cuerpo de SQS ES lo que publicó la fuente (la envoltura Keel, si es un servicio Keel). Sin
él, SNS lo metería dentro de su propio sobre (`{"Type":"Notification","Message":"…"}`): eso sería
infraestructura mal sembrada, no un `envelope: wrapped` del diseño.

## El `contract` de la suscripción manda

El comentario de `subscriptions/<e>-message.ts` lo trae traducido; impleméntalo literalmente:

- **`envelope: keel`** → `EventEnvelope.parse(message.body)`, el tipo en `envelope.metadata.eventType` y el
  payload en `envelope.data`. La clave de deduplicación es `envelope.metadata.eventId`.
- **`envelope: wrapped`** → `<Evento>Envelope.parse(message.body)` y el payload con `.message()`. El tipo está
  donde lo diga el `discriminator`: con `location: header`, en `message.attributes[<name>]` (los message
  attributes de SNS viajan como atributos del mensaje de SQS); con `location: field`, en el campo de la envoltura.
  La clave, donde diga `messageId`.
- **`envelope: none`** → el cuerpo ES el payload: `<Evento>Message.fromWire(parseWireJson(message.body))`.

**Nunca deduplices por `message.messageId`**: es el id que pone SQS y cambia en cada reenvío a la cola.

## Lo ajeno con `return`, lo propio roto con `throw`

| Caso | Qué haces | Por qué |
|---|---|---|
| Un tipo que no es de esta suscripción | `return` | Se borra: no es tuyo |
| Tuyo, pero no parsea o incumple el contrato | dejas que lance (`MessageContractViolation`) | La conexión lo lleva a la DLQ sin reintento |
| Tuyo y el dominio lo rechaza (`DomainException`) | dejas que lance | A la DLQ sin reintento: no se resuelve mejor en la siguiente recepción |
| Un fallo transitorio (la base no responde) | dejas que lance | Vuelve a la cola con la curva de `onFailure.retry`; al agotar `maxReceiveCount`, SQS lo mueve a la DLQ |
| Ya procesado (el guard lo dice) | `return` | La reentrega absorbida: borrada sin segundo efecto |

**Nunca `logger.error(...); return;` con un mensaje tuyo**: eso lo borra, la DLQ no recibe nada y la aserción
«acabó en el descarte» mira una cola vacía.

SQS no distingue tipos de excepción: cuenta recepciones. Que lo no reintentable vaya directo a la DLQ lo hace la
conexión de build (es la salida que la skill de keel-spring da para los errores que el diseño no quiere
reintentar). Sin `onFailure.deadLetter`, lo agotado o no reintentable se registra y se borra.

## El orden del guard lo dicta el diseño

El guard escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden
importe. Cuál toca lo dice el comentario del `<Evento>Message`:

- **`alreadyProcessed(...)` antes y `record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio (`transitions`, o su clave de idempotencia en la clave natural): un fallo transitorio deja el mensaje
  sin marcar y vuelve; la repetición la frena el agregado.
- **`tryRecord(...)` antes** de despachar cuando no hay guarda de dominio: cierra la ventana del duplicado al
  precio de perder el mensaje si el handler falla — la siguiente recepción lo encuentra marcado y lo borra.

Una clave nula o vacía no se pasa al guard (deduplicaría contra todos los mensajes sin clave): regístralo con
`warn` y lanza un `MessageContractViolation`, que va a la DLQ.

SQS estándar es at-least-once y sin orden: un mensaje puede llegar dos veces aunque nadie lo reintente. El guard
es lo que lo hace inocuo.

## La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, la API— puede sacar a la entidad del mismo estado, el despacho
falla de dos formas que son la misma carrera:

- `InvalidStateTransitionException` (`src/domain/errors/`): el otro llegó antes;
- `OptimisticLockConflict` o `WriteConflictExhausted` (`src/infrastructure/persistence/persistence-errors.ts`):
  llegasteis a la vez y perdiste el commit.

Captúralas juntas, **no lances**: regístralo a `debug` diciendo por qué y, con el orden `record`, llama a
`record(...)` igualmente (el mensaje quedó atendido, por el otro camino).

## La correlación

Todo el trabajo del mensaje dentro de `CorrelationContext.runWith(envelope.metadata.correlationId, ...)`: los
eventos que provoque heredan la correlación de origen.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`metadata.source`, un message attribute) y se
pasa YA RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de
`onUnresolved`: `discard` → `return` (y queda en el log); `deadLetter` → lanza un `MessageContractViolation`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del `<Evento>Message`.
Despacha por el `UseCaseMediator`: nunca llames a un handler ni a un repositorio desde el listener.
