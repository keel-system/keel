# Listeners de RabbitMQ en keel-go

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —la cola, la DLQ, el reintento, la
confirmación— lo pone la conexión de build según lo que devuelva tu handler: **`nil` es confirmar, un error es
fallar**. Eso convierte cada `return` del handler en una decisión sobre si un mensaje se pierde.

## Cola compartida: un listener que enruta

El destino sale de la FUENTE, así que las suscripciones de un mismo emisor resuelven a la **misma cola** — lo ves en
`deps.Settings.Subscriptions[<e>].Queue`, en `rabbitmq.Queues()` y en el comentario de `messageListeners`. Dos
`deps.Rabbit.Consume(...)` sobre la misma cola no son dos oyentes: son consumidores que compiten, y cada mensaje llega
a uno solo. El síntoma no es un error: mensajes que se pierden y escenarios que fallan como si el handler no hubiera
hecho nada.

Por eso: **un listener por cola**, con un `switch` por el tipo del mensaje y un `case` por suscripción. Un tipo que la
fuente publica y este servicio no consume va a `default: return nil` (confirmado sin efecto).

## El contexto del handler

`Consume` le pasa al handler un contexto que **no se cancela con el apagado**: un mensaje empezado se termina, y el
apagado espera a la entrega en vuelo antes de cerrar la conexión. Úsalo para todo lo que haga el mensaje (el caso de
uso, la guarda) y no crees otro con `context.Background()`. Las entregas de una cola se procesan **de una en una**: no
abras goroutines desde el handler para «ir más rápido»; quedarían fuera de la espera del apagado y del desenlace.

## El `contract` de la suscripción manda

El comentario del mensaje (`internal/infrastructure/messaging/<evento>_message.go`) lo trae traducido; impleméntalo
literalmente:

- **`envelope: keel`** → `messaging.ParseEnvelope(message.Body)`, el tipo en `envelope.Metadata.EventType` y el payload
  con `messaging.Read<Evento>Message(envelope.Data)`. La clave de deduplicación es `envelope.Metadata.EventID` (el
  emisor la estampa y la reentrega la repite intacta).
- **`envelope: wrapped`** → `messaging.Parse<Evento>Envelope(message.Body)` y el payload con `.Message()`. El tipo está
  donde lo diga el `discriminator`: con `location: header`, en `message.Headers["<name>"]`; con `location: field`, en
  el campo de la envoltura. La clave, donde diga `messageId` (`message.Headers["<name>"]` o el campo).
- **`envelope: none`** → el cuerpo ES el payload: `messaging.Read<Evento>Message(jsontext.Value(message.Body))` (un
  cuerpo que no es un objeto JSON es un `*messaging.ContractError`).

Filtra por el tipo **antes** de `Read…`/`RequireContract`: un mensaje ajeno del canal no tiene por qué cumplir tu
contrato, y devolver su error lo mandaría a tu DLQ.

## Lo ajeno con `nil`, lo propio roto con su error

| Caso | Qué devuelves | Por qué |
|---|---|---|
| Un tipo que no es de este servicio | `nil` | Se confirma y desaparece: no es tuyo |
| Tuyo, pero no se lee o incumple el contrato | el `*messaging.ContractError` | Va a la DLQ sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`*domain.Error`) | el error | DLQ sin reintento: no se resuelve mejor dentro de un segundo |
| Tuyo y el dominio dice que no existe (`domain.KindNotFound`), en una cola que lo reintenta | el error | Se reintenta con la curva de `onFailure.retry` (suele ser la carrera de orden: el mensaje llegó antes que el hecho del que depende) y, agotado, al descarte. Lo decide build por cola (`rabbitmq.RetriesNotFoundOn`); en las demás, es un rechazo más |
| Un fallo transitorio (la base no responde) | el error | Se reintenta con la curva de `onFailure.retry` y, agotado, DLQ |
| Ya procesado (la guarda lo dice) | `nil` | La reentrega absorbida: confirmada sin segundo efecto |

**Nunca `logger.Error(...); return nil` con un mensaje tuyo**: eso lo confirma y lo borra, la DLQ no recibe nada y la
aserción «acabó en el descarte» mira una cola vacía. Y no envuelvas el error en uno tuyo sin `%w`: `IsRetryable` lo
reconoce con `errors.As`, y un error opaco convertiría un rechazo en un reintento.

## El orden de la guarda lo dicta el diseño

La guarda escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden
importe. Cuál toca lo dice el comentario del mensaje:

- **`AlreadyProcessed(...)` antes y `Record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio (`transitions`, o su clave de idempotencia en la clave natural): un fallo transitorio deja el mensaje sin
  marcar y se reintenta; la repetición la frena el agregado.
- **`TryRecord(...)` antes** de despachar cuando no hay guarda de dominio: si devuelve `false`, otra entrega ya lo
  reclamó y se confirma sin efecto. Cierra la ventana del duplicado al precio de perder el mensaje si el handler falla.

**El reintento en memoria NO es una reentrega del broker**: la conexión vuelve a llamar a tu handler dentro de la MISMA
entrega, con el mismo id. Con `TryRecord`, el primer reintento encuentra el mensaje ya marcado, devuelve `nil` y se
confirma: agotar los intentos pierde el mensaje igual. Es el precio declarado de ese orden. Si no encaja con la
durabilidad que necesitas, lo que falta es una guarda de dominio en el diseño, no un `Record` movido de sitio.

Una clave vacía no se pasa a la guarda (deduplicaría contra todos los mensajes sin clave): regístralo con
`logger.WarnContext` y devuelve un `&messaging.ContractError{Reason: …}`, que va al descarte.

El primer argumento de la guarda es el **consumidor** (`handlerID`): un nombre estable por listener. Dos listeners con
el mismo nombre se deduplicarían el uno al otro.

## La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, la API— puede sacar a la entidad del mismo estado, el despacho falla
de dos formas que son la misma carrera:

- `domain.ErrInvalidStateTransition`: el otro llegó antes;
- `domain.ErrConcurrentModification` (o el error que el diseño declare para la concurrencia): llegasteis a la vez y
  perdiste el commit.

Reconócelas juntas con `errors.Is` y **no las devuelvas**: regístralo a `Debug` diciendo por qué y, con el orden
`Record`, llama a `Record(...)` igualmente (el mensaje quedó atendido, por el otro camino). El comentario del mensaje lo
anota cuando build ve la carrera; que no lo anote no significa que no exista.

## La correlación

Con envoltura Keel, despacha con `messaging.Inbound(ctx, envelope.Metadata)`: los eventos que provoque heredan la
correlación de origen. Con una fuente ajena (`wrapped` o `none`) no hay metadata de la que heredar:
`correlation.WithID(ctx, correlation.Accept(""))` abre una nueva (o `correlation.Accept(message.Headers["<cabecera>"])`
si la fuente manda la suya en una cabecera). Es lo que dice el despacho escrito en el comentario de cada mensaje.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`envelope.Metadata.Source`, una cabecera) y se pasa
YA RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de `onUnresolved`:
`discard` → `return nil` (y queda en el log); `deadLetter` → devuelve un `*messaging.ContractError`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del mensaje
(`OrderID: *message.OrderID`, …): lo obligatorio llega como puntero, y `RequireContract` ya garantizó que viene.
Despacha por `deps.UseCases.<Operación>.Handle(ctx, comando)`: nunca llames a un handler ni a un repositorio desde el
listener (los casos de uso abren su transacción).
