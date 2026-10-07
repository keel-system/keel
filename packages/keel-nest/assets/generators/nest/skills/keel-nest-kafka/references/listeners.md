# Listeners de Kafka en keel-nest

El listener es la única pieza de la recepción que escribe el agente. Todo lo demás —el consumer group, el
reintento, el descarte en `<topic>.DLT`, el avance del offset— lo pone la conexión de build según lo que haga tu
handler: **retornar es confirmar, lanzar es fallar**. Eso convierte cada `return` y cada `throw` del listener en
una decisión sobre si un mensaje se pierde.

## Un grupo por suscripción: un listener por suscripción

El topic sale de la FUENTE, así que las suscripciones de un mismo emisor leen el **mismo topic**. En Kafka eso no
reparte nada: cada suscripción tiene su consumer group (`MessagingSettings.subscriptions[<e>].groupId`, uno por
suscripción, el mismo que keel-spring) y cada grupo recibe el topic entero. Por eso **un listener por
suscripción**, que se registra con `connection.consume('<Suscripción>', …)` y descarta con `return` lo que no es
de su tipo.

No lo cambies por uno solo que enrute con un `switch` sobre un grupo compartido: Kafka repartiría las particiones
entre los consumidores de ese grupo y cada suscripción vería solo un trozo del tráfico. Cada listener es dueño de
su grupo, que es además lo que el arnés espera. Es justo lo contrario que con RabbitMQ (allí la cola se comparte
y el listener es uno por cola).

## El `contract` de la suscripción manda

El comentario de `subscriptions/<e>-message.ts` lo trae traducido; impleméntalo literalmente:

- **`envelope: keel`** → `EventEnvelope.parse(message.value)`, el tipo en `envelope.metadata.eventType` y el
  payload en `envelope.data`. La clave de deduplicación es `envelope.metadata.eventId` (el emisor la estampa y la
  reentrega la repite intacta).
- **`envelope: wrapped`** → `<Evento>Envelope.parse(message.value)` y el payload con `.message()`. El tipo está
  donde lo diga el `discriminator`: con `location: header`, en `message.headers[<name>]`; con `location: field`,
  en el campo de la envoltura. La clave, donde diga `messageId` (`message.headers[<name>]` o el campo).
- **`envelope: none`** → el cuerpo ES el payload: `<Evento>Message.fromWire(parseWireJson(message.value))`.

Filtra por el tipo **antes** de `fromWire`/`requireContract`: un mensaje ajeno del topic no tiene por qué cumplir
tu contrato, y lanzar con él lo mandaría a tu descarte.

## Lo ajeno con `return`, lo propio roto con `throw`

| Caso | Qué haces | Por qué |
|---|---|---|
| Un tipo que no es de esta suscripción | `return` | Se confirma (el offset avanza): no es tuyo |
| Tuyo, pero no parsea o incumple el contrato | dejas que lance (`MessageContractViolation`) | Va a `<topic>.DLT` sin reintento, que es donde el emisor lo ve |
| Tuyo y el dominio lo rechaza (`DomainException`) | dejas que lance | Al descarte sin reintento: no se resuelve mejor dentro de un segundo |
| Un fallo transitorio (la base no responde) | dejas que lance | Se reintenta con la curva de `onFailure.retry` y, agotado, al descarte |
| Ya procesado (el guard lo dice) | `return` | La reentrega absorbida: confirmada sin segundo efecto |

**Nunca `logger.error(...); return;` con un mensaje tuyo**: eso lo confirma y lo pierde, el descarte no recibe
nada y la aserción «acabó en el descarte» mira un topic vacío.

Sin `onFailure.deadLetter` en ninguna suscripción del topic, lo agotado no va a ninguna parte: se registra y se
confirma (es lo que hace el error handler por defecto de Spring Kafka). Y si ninguna suscripción del servicio
declara descarte, el reintento es el de Spring por defecto: diez intentos seguidos, sin espera.

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

Kafka es at-least-once: tras un rebalanceo, o si el proceso cae después de procesar y antes de confirmar el
offset, el mensaje vuelve. El guard es lo que lo hace inocuo; no dependas de que «no suele pasar».

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
eventos que provoque heredan la correlación de origen. Con una fuente ajena sin envoltura Keel, el header que
lleve su correlación, o ninguna.

## La identidad del emisor

Si la suscripción declara `identity`, el valor sale de donde diga (`metadata.source`, un header) y se pasa YA
RESUELTO al comando; nunca del payload. Un emisor que no corresponde a nadie registrado es el caso de
`onUnresolved`: `discard` → `return` (y queda en el log); `deadLetter` → lanza un `MessageContractViolation`.

## El comando

El mapeo campo a campo del payload al comando de `triggers` está en el comentario del `<Evento>Message`
(`orderId = payload.orderId`, `eventId = envelope.metadata.eventId`…). Despacha por el `UseCaseMediator`: nunca
llames a un handler ni a un repositorio desde el listener.
