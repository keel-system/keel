# Listeners de Kafka en keel-dotnet

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —el consumer group, el reintento, el
descarte en `<topic>.DLT`, el avance del offset— lo pone la conexión de build según lo que haga tu handler: **terminar
es confirmar, lanzar es fallar**.
Eso convierte cada `return` y cada `throw` del listener en una decisión sobre si un mensaje se pierde.

## Un grupo por suscripción: un listener por suscripción

El topic sale de la FUENTE, así que las suscripciones de un mismo emisor leen el **mismo topic**. En Kafka eso no reparte
nada: cada suscripción tiene su consumer group (`MessagingSettings.Subscriptions[<e>].GroupId`, uno por suscripción, el
mismo que keel-spring y keel-nest) y cada grupo recibe el topic entero. Por eso **un listener por suscripción**, que se
registra con `connection.Consume("<Suscripción>", …)` y descarta con `return` lo que no es de su tipo.

No lo cambies por uno solo que enrute con un `switch` sobre un grupo compartido: Kafka repartiría las particiones entre
los consumidores de ese grupo y cada suscripción vería solo un trozo del tráfico. Cada listener es dueño de su grupo,
que es además lo que el arnés espera. Es justo lo contrario que con RabbitMQ (allí la cola se comparte y el listener es
uno por cola).

## El ámbito de DI, por mensaje

El listener es un `IHostedService` (singleton) y los casos de uso viven en un ámbito: el `IUseCaseMediator`, el
`DbContext` y la transacción. Abre **un ámbito por mensaje** con `IServiceScopeFactory` y resuelve el mediator dentro;
nunca inyectes el mediator en el constructor del listener: el contenedor solo lo rechaza con la validación de ámbitos
encendida, y donde no, todos los mensajes compartirían un `DbContext`. La guarda (`IdempotencyGuard`) es singleton y abre sus propias transacciones.

## El `contract` de la suscripción manda

El comentario del mensaje (`Messaging/Subscriptions/<Evento>Message.cs`) lo trae traducido; impleméntalo literalmente:

- **`envelope: keel`** → `EventEnvelope.Parse(message.Value)`, el tipo en `envelope.Metadata.EventType` y el payload en
  `envelope.Data`. La clave de deduplicación es `envelope.Metadata.EventId` (el emisor la estampa y la reentrega la
  repite intacta).
- **`envelope: wrapped`** → `<Evento>Envelope.Parse(message.Value)` y el payload con `.Message()`. El tipo está donde lo
  diga el `discriminator`: con `location: header`, en `message.Header("<name>")`; con `location: field`, en la propiedad
  de la envoltura. La clave, donde diga `messageId` (`message.Header("<name>")` o la propiedad).
- **`envelope: none`** → el cuerpo ES el payload: `<Evento>Message.FromWire(JsonDocument.Parse(message.Value).RootElement)`
  (un cuerpo que no es JSON se lanza como `MessageContractViolation`).

Filtra por el tipo **antes** de `FromWire`/`RequireContract`: un mensaje ajeno del topic no tiene por qué cumplir tu
contrato, y lanzar con él lo mandaría a tu descarte.

## Lo ajeno con `return`, lo propio roto con `throw`

| Caso | Qué haces | Por qué |
|---|---|---|
| Un tipo que no es de este servicio | `return` | Se confirma y desaparece: no es tuyo |
| Tuyo, pero no parsea o incumple el contrato | dejas que lance (`MessageContractViolation`) | Va a `<topic>.DLT` sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`DomainException`) | dejas que lance | Al descarte sin reintento: no se resuelve mejor dentro de un segundo |
| Tuyo y el dominio dice que no existe (`NotFoundException`), en una suscripción cuya nota lo marca como reintentable | dejas que lance | Se reintenta con la curva de `onFailure.retry` (suele ser la carrera de orden: el mensaje llegó antes que el hecho del que depende) y, agotado, al descarte. Lo decide build por topic (`KafkaConsumption`, `RetriesNotFound`); fuera de esos, es un rechazo más |
| Un fallo transitorio (la base no responde) | dejas que lance | Se reintenta con la curva de `onFailure.retry` y, agotado, `<topic>.DLT` (sin descarte declarado, se registra y se confirma) |
| Ya procesado (el guard lo dice) | `return` | La reentrega absorbida: confirmada sin segundo efecto |

**Nunca `logger.LogError(...); return;` con un mensaje tuyo**: eso lo confirma (el offset avanza), `<topic>.DLT` no
recibe nada y la aserción «acabó en el descarte» mira un topic vacío.

## El orden del guard lo dicta el diseño

El guard escribe en su **propia** transacción, así que sobrevive al fallo del handler, y eso hace que el orden importe.
Cuál toca lo dice el comentario del mensaje:

- **`AlreadyProcessed(...)` antes y `Record(...)` DESPUÉS** de despachar bien, cuando la operación tiene guarda de
  dominio (`transitions`, o su clave de idempotencia en la clave natural): un fallo transitorio deja el mensaje sin
  marcar y se reintenta; la repetición la frena el agregado.
- **`TryRecord(...)` antes** de despachar cuando no hay guarda de dominio: cierra la ventana del duplicado al precio de
  perder el mensaje si el handler falla.

**El reintento en memoria NO es una reentrega del broker**: la conexión reinvoca tu handler dentro de la MISMA entrega,
con el mismo id. Con `TryRecord`, el primer reintento encuentra el mensaje ya marcado, retorna y se confirma: agotar los
intentos pierde el mensaje igual. Es el precio declarado de ese orden. Si no encaja con la durabilidad que necesitas, lo
que falta es una guarda de dominio en el diseño, no un `Record` movido de sitio.

Una clave nula o vacía no se pasa al guard (deduplicaría contra todos los mensajes sin clave): regístralo con
`LogWarning` y lanza un `MessageContractViolation`, que va al descarte.

## La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, la API— puede sacar a la entidad del mismo estado, el despacho falla
de dos formas que son la misma carrera:

- `InvalidStateTransitionException` (`Domain/Errors`): el otro llegó antes;
- el conflicto de concurrencia: la `ConflictException` con el `code` `CONCURRENT_MODIFICATION` (o el que el diseño
  declare para la concurrencia) que la transacción traduce de un `OptimisticLockConflict`: llegasteis a la vez y
  perdiste el commit.

Captúralas juntas, **no lances**: regístralo a `Debug` diciendo por qué y, con el orden `Record`, llama a `Record(...)`
igualmente (el mensaje quedó atendido, por el otro camino). El comentario del mensaje lo anota cuando build ve la
carrera; que no lo anote no significa que no exista.

## La correlación

Todo el trabajo del mensaje dentro de `InboundContext.Run(envelope.Metadata, ...)` (`Messaging/InboundContext.cs`): los
eventos que provoque heredan la correlación de origen. Con una fuente ajena sin envoltura Keel,
`CorrelationContext.Open(...)` con la cabecera que lleve su correlación, o ninguna.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`Metadata.Source`, una cabecera) y se pasa YA
RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de `onUnresolved`:
`discard` → `return` (y queda en el log); `deadLetter` → lanza un `MessageContractViolation`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del mensaje
(`OrderId = message.OrderId`, `EventId = envelope.Metadata.EventId`…). Despacha por el `IUseCaseMediator` del ámbito del
mensaje: nunca llames a un handler ni a un repositorio desde el listener.
