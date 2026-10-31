# Listeners de SNS/SQS en keel-go

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —el sondeo de la cola, el
reintento por visibilidad, la DLQ, el borrado— lo pone la conexión de build según lo que devuelva tu handler: **`nil`
es borrar el mensaje, un error es fallar**. Eso convierte cada `return` del handler en una decisión sobre si un
mensaje se pierde.

## Una cola por suscripción

De un topic de SNS no se lee: cada suscripción tiene **su cola propia** de SQS, suscrita al topic de su fuente con
raw delivery y un filtro por el message attribute `eventType` (`deps.Settings.Subscriptions[<e>].Queue`,
`snssqs.Subscriptions()` y el comentario de `messageListeners` las listan; las siembra `infra/init-messaging.sh`). Dos
suscripciones de la misma fuente tienen dos colas, y cada una recibe solo su tipo.

Por eso: **un listener por suscripción**, cada uno con `deps.SNSSQS.Consume(ctx, "<Suscripción>", handle)`. Un
listener que faltara deja su cola llenándose sin que nadie la lea; uno que llama a `Consume` con un nombre que no es
el de la suscripción en el diseño devuelve el error y el servicio no arranca.

## El contexto del handler

`Consume` le pasa al handler un contexto que **no se cancela con el apagado**: un mensaje empezado se termina, y el
apagado espera al que esté en vuelo. Úsalo para todo lo que haga el mensaje (el caso de uso, la guarda) y no crees
otro con `context.Background()`. Los mensajes de una cola se procesan **de uno en uno** y se borran después de cada
desenlace: no abras goroutines desde el handler.

## El `contract` de la suscripción manda

El comentario del mensaje (`internal/infrastructure/messaging/<evento>_message.go`) lo trae traducido; impleméntalo
literalmente:

- **`envelope: keel`** → `messaging.ParseEnvelope(message.Body)`, el tipo en `envelope.Metadata.EventType` y el
  payload con `messaging.Read<Evento>Message(envelope.Data)`. La clave de deduplicación es `envelope.Metadata.EventID`
  (el emisor la estampa y la reentrega la repite intacta).
- **`envelope: wrapped`** → `messaging.Parse<Evento>Envelope(message.Body)` y el payload con `.Message()`. El tipo
  está donde lo diga el `discriminator`: con `location: header`, en `message.Attribute("<name>")` (los message
  attributes); con `location: field`, en el campo de la envoltura. La clave, donde diga `messageId`
  (`message.Attribute("<name>")` o el campo).
- **`envelope: none`** → el cuerpo ES el payload: `messaging.Read<Evento>Message(jsontext.Value(message.Body))` (un
  cuerpo que no es un objeto JSON es un `*messaging.ContractError`).

`message.MessageID` es el id de SQS y **cambia en cada reenvío a la cola**: no sirve para deduplicar.

Filtra por el tipo **antes** de `Read…`/`RequireContract`. El filtro de la suscripción ya deja fuera lo ajeno, pero
no es la única defensa: una cola mal sembrada o un emisor que no estampa `eventType` no deben mandar un mensaje
ajeno a tu DLQ.

## Lo ajeno con `nil`, lo propio roto con su error

| Caso | Qué devuelves | Por qué |
|---|---|---|
| Un tipo que no es de esta suscripción | `nil` | Se borra: no es de nadie que lea esta cola |
| Tuyo, pero no se lee o incumple el contrato | el `*messaging.ContractError` | La conexión lo lleva a la DLQ sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`*domain.Error`) | el error | DLQ sin reintento: no se resuelve mejor con otra recepción |
| Tuyo y el dominio dice que no existe (`domain.KindNotFound`), en una suscripción que lo reintenta | el error | Se reintenta con la curva de `onFailure.retry` (suele ser la carrera de orden) y, agotado, a la DLQ. Lo decide build por cola (`RetriesNotFound` en `snssqs.Subscriptions()`); en las demás, es un rechazo más |
| Un fallo transitorio (la base no responde) | el error | La conexión alarga la visibilidad con la curva; al agotar `MaxReceive`, la RedrivePolicy lo lleva a la DLQ |
| Ya procesado (la guarda lo dice) | `nil` | La reentrega absorbida: borrada sin segundo efecto |

Sin `onFailure.deadLetter`, lo no reintentable o agotado **se registra y se borra** (es lo que significa no
declararlo, como en keel-spring). **Nunca `logger.Error(...); return nil` con un mensaje tuyo**: eso lo borra, la DLQ
no recibe nada y la aserción «acabó en el descarte» mira una cola vacía. Y no envuelvas el error en uno tuyo sin
`%w`: `IsRetryable` lo reconoce con `errors.As`.

## El orden de la guarda lo dicta el diseño

La guarda escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden
importe. Cuál toca lo dice el comentario del mensaje:

- **`AlreadyProcessed(...)` antes y `Record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio: un fallo transitorio deja el mensaje sin marcar y se reintenta; la repetición la frena el agregado.
- **`TryRecord(...)` antes** de despachar cuando no hay guarda de dominio: si devuelve `false`, otra entrega ya lo
  reclamó y se borra sin efecto.

En SQS **el reintento es una recepción nueva del mismo mensaje**: con `TryRecord`, la segunda recepción lo encuentra
ya marcado, devuelve `nil` y se borra sin llegar nunca a la DLQ. Es el precio declarado de ese orden; si no encaja, lo
que falta es una guarda de dominio en el diseño.

SQS además reentrega por su cuenta (entrega «al menos una vez»), y un apagado a mitad deja el mensaje para cuando
venza su visibilidad. La guarda es lo que lo absorbe.

Una clave vacía no se pasa a la guarda: regístralo con `logger.WarnContext` y devuelve un
`&messaging.ContractError{Reason: …}`, que va a la DLQ. El primer argumento de la guarda es el **consumidor**
(`handlerID`): un nombre estable por listener, distinto en cada uno.

## La carrera ya resuelta no es un fallo

Cuando otro camino puede sacar a la entidad del mismo estado, el despacho falla de dos formas que son la misma
carrera: `domain.ErrInvalidStateTransition` (el otro llegó antes) y `domain.ErrConcurrentModification` (llegasteis a
la vez y perdiste el commit). Reconócelas juntas con `errors.Is` y **no las devuelvas**: regístralo a `Debug` y, con
el orden `Record`, llama a `Record(...)` igualmente.

## La correlación

Con envoltura Keel, despacha con `messaging.Inbound(ctx, envelope.Metadata)`. Con una fuente ajena (`wrapped` o
`none`), `correlation.WithID(ctx, correlation.Accept(""))` abre una nueva (o
`correlation.Accept(message.Attribute("<atributo>"))` si la fuente manda la suya en un message attribute). Es lo que
dice el despacho escrito en el comentario de cada mensaje.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`envelope.Metadata.Source`, un message attribute)
y se pasa YA RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de
`onUnresolved`: `discard` → `return nil` (y queda en el log); `deadLetter` → devuelve un `*messaging.ContractError`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del mensaje: lo obligatorio llega
como puntero, y `RequireContract` ya garantizó que viene. Despacha por `deps.UseCases.<Operación>.Handle(ctx, comando)`:
nunca llames a un handler ni a un repositorio desde el listener.
