# Listeners de RabbitMQ en keel-nest

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —la cola, la DLQ, el
reintento, la confirmación— lo pone la conexión de build según lo que haga tu handler: **retornar es
confirmar, lanzar es fallar**. Eso convierte cada `return` y cada `throw` del listener en una decisión sobre si
un mensaje se pierde.

## Cola compartida: un listener que enruta

El destino sale de la FUENTE, así que las suscripciones de un mismo emisor (o de un mismo canal) resuelven a la
**misma cola** — lo ves en `MessagingSettings.subscriptions[<e>].queue` y en `RABBIT_TOPOLOGY`. Dos
`connection.consume(...)` sobre la misma cola no son dos oyentes: son consumidores que compiten, y cada mensaje
llega a uno solo. El síntoma no es un error: mensajes que se pierden y escenarios que fallan como si el handler
no hubiera hecho nada.

Por eso: **un listener por cola**, con un `switch` por el tipo del mensaje y una rama por suscripción. Un tipo
que la fuente publica y este servicio no consume va a `default: return` (confirmado sin efecto).

## El `contract` de la suscripción manda

El comentario de `subscriptions/<e>-message.ts` lo trae traducido; impleméntalo literalmente:

- **`envelope: keel`** → `EventEnvelope.parse(message.content.toString('utf8'))`, el tipo en
  `envelope.metadata.eventType` y el payload en `envelope.data`. La clave de deduplicación es
  `envelope.metadata.eventId` (el emisor la estampa y la reentrega la repite intacta).
- **`envelope: wrapped`** → `<Evento>Envelope.parse(texto)` y el payload con `.message()`. El tipo está donde lo
  diga el `discriminator`: con `location: header`, en `message.properties.headers[<name>]`; con `location:
  field`, en el campo de la envoltura. La clave, donde diga `messageId` (`message.properties.headers[<name>]` o el
  campo).
- **`envelope: none`** → el cuerpo ES el payload: `<Evento>Message.fromWire(parseWireJson(texto))`.

Filtra por el tipo **antes** de `fromWire`/`requireContract`: un mensaje ajeno del canal no tiene por qué cumplir
tu contrato, y lanzar con él lo mandaría a tu DLQ.

## Lo ajeno con `return`, lo propio roto con `throw`

| Caso | Qué haces | Por qué |
|---|---|---|
| Un tipo que no es de este servicio | `return` | Se confirma y desaparece: no es tuyo |
| Tuyo, pero no parsea o incumple el contrato | dejas que lance (`MessageContractViolation`) | Va a la DLQ sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`DomainException`) | dejas que lance | DLQ sin reintento: no se resuelve mejor dentro de un segundo |
| Un fallo transitorio (la base no responde) | dejas que lance | Se reintenta con la curva de `onFailure.retry` y, agotado, DLQ |
| Ya procesado (el guard lo dice) | `return` | La reentrega absorbida: confirmada sin segundo efecto |

**Nunca `logger.error(...); return;` con un mensaje tuyo**: eso lo confirma y lo borra, la DLQ no recibe nada y
la aserción «acabó en el descarte» mira una cola vacía.

## El orden del guard lo dicta el diseño

El guard escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden
importe. Cuál toca lo dice el comentario del `<Evento>Message`:

- **`alreadyProcessed(...)` antes y `record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio (`transitions`, o su clave de idempotencia en la clave natural): un fallo transitorio deja el mensaje
  sin marcar y se reintenta; la repetición la frena el agregado.
- **`tryRecord(...)` antes** de despachar cuando no hay guarda de dominio: cierra la ventana del duplicado al
  precio de perder el mensaje si el handler falla.

**El reintento en memoria NO es una reentrega del broker**: la conexión reinvoca tu handler dentro de la MISMA
entrega, con el mismo id. Con `tryRecord`, el primer reintento encuentra el mensaje ya marcado, retorna y se
confirma: agotar los intentos pierde el mensaje igual. Es el precio declarado de ese orden. Si no encaja con la
durabilidad que necesitas, lo que falta es una guarda de dominio en el diseño, no un `record` movido de sitio.

Una clave nula o vacía no se pasa al guard (deduplicaría contra todos los mensajes sin clave): regístralo con
`warn` y lanza un `MessageContractViolation`, que va al descarte.

## La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, la API— puede sacar a la entidad del mismo estado, el despacho
falla de dos formas que son la misma carrera:

- `InvalidStateTransitionException` (`src/domain/errors/`): el otro llegó antes;
- `OptimisticLockConflict` o `WriteConflictExhausted` (`src/infrastructure/persistence/persistence-errors.ts`):
  llegasteis a la vez y perdiste el commit.

Captúralas juntas, **no lances**: regístralo a `debug` diciendo por qué y, con el orden `record`, llama a
`record(...)` igualmente (el mensaje quedó atendido, por el otro camino). El comentario del `<Evento>Message` lo
anota cuando build ve la carrera; que no lo anote no significa que no exista.

## La correlación

Todo el trabajo del mensaje dentro de `CorrelationContext.runWith(envelope.metadata.correlationId, ...)`: los
eventos que provoque heredan la correlación de origen. Con una fuente ajena sin envoltura Keel, la cabecera que
lleve su correlación, o ninguna.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`metadata.source`, una cabecera) y se pasa YA
RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de
`onUnresolved`: `discard` → `return` (y queda en el log); `deadLetter` → lanza un `MessageContractViolation`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del `<Evento>Message`
(`orderId = payload.orderId`, `eventId = envelope.metadata.eventId`…). Despacha por el `UseCaseMediator`: nunca
llames a un handler ni a un repositorio desde el listener.
