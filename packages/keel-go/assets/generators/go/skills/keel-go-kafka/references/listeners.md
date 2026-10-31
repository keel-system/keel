# Listeners de Kafka en keel-go

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —el grupo, el descarte en
`<topic>.DLT`, el reintento, la confirmación del offset— lo pone la conexión de build según lo que devuelva tu handler:
**`nil` es confirmar, un error es fallar**. Eso convierte cada `return` del handler en una decisión sobre si un
mensaje se pierde.

## Un consumer group por suscripción

En Kafka no hay cola intermedia: cada suscripción consume directamente del topic de su fuente con **su** consumer
group (`deps.Settings.Subscriptions[<e>].GroupID`, `kafka.Subscriptions()` y el comentario de `messageListeners` los
listan). Un grupo recibe el topic entero, así que dos suscripciones de la misma fuente reciben los mismos mensajes y
cada una descarta lo que no es suyo por el tipo.

Por eso: **un listener por suscripción**, cada uno con `deps.Kafka.Consume(ctx, "<Suscripción>", handle)`. Un listener
que faltara deja su grupo sin miembros: los mensajes de esa suscripción se quedan en el topic sin leer, y el arnés de
flujos falla al abrir esperando a ese grupo.

## El contexto del handler

`Consume` le pasa al handler un contexto que **no se cancela con el apagado**: un mensaje empezado se termina, y el
apagado espera al que esté en vuelo antes de cerrar el productor. Úsalo para todo lo que haga el mensaje (el caso de
uso, la guarda) y no crees otro con `context.Background()`. Los mensajes de una suscripción se procesan **de uno en
uno** y el offset avanza después de cada desenlace: no abras goroutines desde el handler.

## El `contract` de la suscripción manda

El comentario del mensaje (`internal/infrastructure/messaging/<evento>_message.go`) lo trae traducido; impleméntalo
literalmente:

- **`envelope: keel`** → `messaging.ParseEnvelope(message.Value)`, el tipo en `envelope.Metadata.EventType` y el
  payload con `messaging.Read<Evento>Message(envelope.Data)`. La clave de deduplicación es `envelope.Metadata.EventID`
  (el emisor la estampa y la reentrega la repite intacta).
- **`envelope: wrapped`** → `messaging.Parse<Evento>Envelope(message.Value)` y el payload con `.Message()`. El tipo
  está donde lo diga el `discriminator`: con `location: header`, en `message.Headers["<name>"]`; con
  `location: field`, en el campo de la envoltura. La clave, donde diga `messageId` (`message.Headers["<name>"]` o el
  campo).
- **`envelope: none`** → el valor ES el payload: `messaging.Read<Evento>Message(jsontext.Value(message.Value))` (un
  valor que no es un objeto JSON es un `*messaging.ContractError`).

Filtra por el tipo **antes** de `Read…`/`RequireContract`: un mensaje de otra suscripción del mismo topic no tiene por
qué cumplir tu contrato, y devolver su error lo mandaría a tu descarte.

## Lo ajeno con `nil`, lo propio roto con su error

| Caso | Qué devuelves | Por qué |
|---|---|---|
| Un tipo que no es de esta suscripción | `nil` | Se confirma: es de otra (que tiene su propio grupo) o de nadie |
| Tuyo, pero no se lee o incumple el contrato | el `*messaging.ContractError` | Va a `<topic>.DLT` sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`*domain.Error`) | el error | Descarte sin reintento: no se resuelve mejor dentro de un segundo |
| Tuyo y el dominio dice que no existe (`domain.KindNotFound`), en una suscripción que lo reintenta | el error | Se reintenta con la curva de `onFailure.retry` (suele ser la carrera de orden) y, agotado, al descarte. Lo decide build por topic (`RetriesNotFound` en `kafka.Subscriptions()`); en las demás, es un rechazo más |
| Un fallo transitorio (la base no responde) | el error | Se reintenta con la curva y, agotado, al descarte |
| Ya procesado (la guarda lo dice) | `nil` | La reentrega absorbida: confirmada sin segundo efecto |

Sin `onFailure.deadLetter` en ninguna suscripción del topic, lo agotado **se registra y se confirma** (es lo que
significa no declararlo, como en keel-spring). **Nunca `logger.Error(...); return nil` con un mensaje tuyo**: eso lo
confirma, el descarte no recibe nada y la aserción «acabó en el descarte» mira un topic vacío. Y no envuelvas el error
en uno tuyo sin `%w`: `IsRetryable` lo reconoce con `errors.As`.

## El orden de la guarda lo dicta el diseño

La guarda escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden
importe. Cuál toca lo dice el comentario del mensaje:

- **`AlreadyProcessed(...)` antes y `Record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio: un fallo transitorio deja el mensaje sin marcar y se reintenta; la repetición la frena el agregado.
- **`TryRecord(...)` antes** de despachar cuando no hay guarda de dominio: si devuelve `false`, otra entrega ya lo
  reclamó y se confirma sin efecto.

**El reintento en memoria NO es una reentrega del broker**: la conexión vuelve a llamar a tu handler con el MISMO
registro. Con `TryRecord`, el primer reintento lo encuentra ya marcado, devuelve `nil` y se confirma. Es el precio
declarado de ese orden; si no encaja, lo que falta es una guarda de dominio en el diseño.

Kafka **sí** reentrega de verdad: un apagado a mitad o un offset que no se pudo confirmar vuelven a entregar el
registro, a esta réplica o a otra del grupo. La guarda es lo que lo absorbe.

Una clave vacía no se pasa a la guarda: regístralo con `logger.WarnContext` y devuelve un
`&messaging.ContractError{Reason: …}`, que va al descarte. El primer argumento de la guarda es el **consumidor**
(`handlerID`): un nombre estable por listener, distinto en cada uno.

## La carrera ya resuelta no es un fallo

Cuando otro camino puede sacar a la entidad del mismo estado, el despacho falla de dos formas que son la misma
carrera: `domain.ErrInvalidStateTransition` (el otro llegó antes) y `domain.ErrConcurrentModification` (llegasteis a
la vez y perdiste el commit). Reconócelas juntas con `errors.Is` y **no las devuelvas**: regístralo a `Debug` y, con
el orden `Record`, llama a `Record(...)` igualmente.

## La correlación

Con envoltura Keel, despacha con `messaging.Inbound(ctx, envelope.Metadata)`. Con una fuente ajena (`wrapped` o
`none`), `correlation.WithID(ctx, correlation.Accept(""))` abre una nueva (o `correlation.Accept(message.Headers["<cabecera>"])`
si la fuente manda la suya en un header). Es lo que dice el despacho escrito en el comentario de cada mensaje.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`envelope.Metadata.Source`, un header) y se pasa YA
RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de `onUnresolved`:
`discard` → `return nil` (y queda en el log); `deadLetter` → devuelve un `*messaging.ContractError`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del mensaje: lo obligatorio llega
como puntero, y `RequireContract` ya garantizó que viene. Despacha por `deps.UseCases.<Operación>.Handle(ctx, comando)`:
nunca llames a un handler ni a un repositorio desde el listener.
