# RabbitMQ en keel-nest — diagnóstico

Síntoma → causa → arreglo. La UI de management está en `http://localhost:15672` (guest/guest).

## `routed:false` al entregar desde una prueba (`deliverMessage` lanza)

El exchange de la fuente existe pero no hay cola enlazada: la conexión del servicio no llegó a declarar su
topología. `useFlow()` espera a que la conexión esté arriba al abrir cada flujo; si aun así pasa, mira el log del
servicio (`RabbitMQ: no se pudo conectar`) y que `infra/` esté arriba (`bash infra/validate-infra.sh`).

## `PRECONDITION_FAILED - inequivalent arg` al arrancar

Alguien redeclaró una cola de build con otros argumentos (sin `x-dead-letter-*`, o como quorum). RabbitMQ no
permite cambiar los argumentos de una cola viva. **Quita la declaración**: la topología es de build. En local,
borra la cola desde la UI (o `bash infra/down.sh --volumes`) y arranca de nuevo.

## El outbox reintenta hasta rendirse con «El mensaje no tenía cola»

`publish` va con `mandatory`: un mensaje que el exchange no enruta a ninguna cola vuelve, y no se da por
publicado. La cola del canal la declara build con el binding de cada routing key; si falla, la routing key de la
fila no casa con la de `messaging.publishing.routing-keys` (¿la cambió alguien en un perfil?) o el destino no es
`messaging.publishing.destination`.

## Tras levantar el broker, nada sale durante unos segundos

Es la reconexión: la conexión reintenta con espera creciente hasta `rabbitmq.listener.recovery-interval-ms`
(5 s). Mientras tanto `publish` lanza `BrokerUnavailableError` y el relay cuenta el intento con su backoff. En
local, con 40 intentos y tope de 2 s, la fila aguanta un reinicio entero; si se rinde, el broker tardó más de lo
que el presupuesto cubre.

## Un mensaje tuyo no llega a la DLQ

El listener retornó en vez de lanzar (un `catch` que registra y sigue, o un `return` sobre un cuerpo que no
parsea): eso lo confirma y lo borra. Deja que lance (`references/listeners.md`).

## Un mensaje llega a la DLQ al primer intento cuando debía reintentarse

O es un `DomainException` / `MessageContractViolation` (no se reintentan, a propósito), o la suscripción no
declara `onFailure.retry` (sin él, un solo intento). Si el error es de verdad transitorio y sale como
`DomainException`, el defecto está en quien lo lanza.

## La reentrega se procesa dos veces

El listener no deduplica, o deduplica con una clave distinta de la del contrato (con envoltura Keel,
`metadata.eventId`; con una fuente ajena, el `messageId` declarado). Y la ventana: el registro se purga a los
`processed-event.purge.retention-days`.

## Un mensaje parece perderse en una cola compartida

Dos listeners sobre la misma cola: compiten y cada mensaje llega a uno solo. Un listener por cola
(`references/listeners.md`).

## El proceso se cae al parar el broker («Unhandled Rejection»)

Una promesa sin `await` ni `catch` en código propio que toca el broker. La conexión de build maneja los suyos; un
`void this.connection.publish(...)` en un listener o un publisher no. Espera siempre la promesa.
