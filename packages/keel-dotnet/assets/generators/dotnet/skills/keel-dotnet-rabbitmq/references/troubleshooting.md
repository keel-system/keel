# RabbitMQ en keel-dotnet — diagnóstico

Síntoma → causa → arreglo. La UI de management está en `http://localhost:15672` (guest/guest); el log del servidor de
las pruebas de flujo, en `build/keel-scenarios/server.log`.

## `routed:false` al entregar desde una prueba (`DeliverMessage` lanza)

El exchange de la fuente existe pero no hay cola enlazada: la conexión del servicio no llegó a declarar su topología.
La base de los flujos espera a que el servidor esté conectado al abrir cada flujo (lo busca entre las conexiones del
broker por el nombre del servicio); si aun así pasa, mira el log del servidor (`RabbitMQ: no se pudo conectar`) y que
`infra/` esté arriba (`bash infra/validate-infra.sh`).

## `PRECONDITION_FAILED - inequivalent arg` al arrancar

Alguien redeclaró una cola de build con otros argumentos (sin `x-dead-letter-*`, o como quorum). RabbitMQ no permite
cambiar los argumentos de una cola viva. **Quita la declaración**: la topología es de build. En local, borra la cola
desde la UI (o `bash infra/down.sh --volumes`) y arranca de nuevo.

## El outbox reintenta hasta rendirse con «El mensaje no tenía cola»

`Publish` va con `mandatory`: un mensaje que el exchange no enruta a ninguna cola vuelve, y no se da por publicado. La
cola del canal la declara build con el binding de cada routing key; si falla, la routing key de la fila no casa con la
de `messaging.publishing.routing-keys` (¿la cambió alguien en un perfil?) o el destino no es
`messaging.publishing.destination`.

## Tras levantar el broker, nada sale durante unos segundos

Es la recuperación: la conexión reintenta cada `rabbitmq.listener.recovery-interval-ms` (5 s). Mientras tanto `Publish`
lanza `BrokerUnavailableException` y el relay cuenta el intento con su backoff. En local, con 40 intentos y tope de 2 s,
la fila aguanta un reinicio entero; si se rinde, el broker tardó más de lo que el presupuesto cubre.

## El servicio no arranca: «No hay implementación de IOutboxDispatcher»

Con `reliability: outbox`, fuera de `local` y `test` el respaldo no deja arrancar: marcaría como publicados eventos que
nunca salen. Falta el dispatcher en `BrokerBindings.AddBrokerAdapters` (o se registró con otro tipo de servicio).

## Un mensaje tuyo no llega a la DLQ

El listener retornó en vez de lanzar (un `catch` que registra y sigue, o un `return` sobre un cuerpo que no parsea): eso
lo confirma y lo borra. Deja que lance (`references/listeners.md`).

## Un mensaje llega a la DLQ al primer intento cuando debía reintentarse

O es un `DomainException` / `MessageContractViolation` (no se reintentan, a propósito), o ninguna suscripción declara
`onFailure.retry` (sin él, un solo intento: `RabbitTopology.Retry` es null). Si el error es de verdad transitorio y
sale como `DomainException`, el defecto está en quien lo lanza.

## La reentrega se procesa dos veces

El listener no deduplica, o deduplica con una clave distinta de la del contrato (con envoltura Keel,
`Metadata.EventId`; con una fuente ajena, el `messageId` declarado). Y la ventana: el registro se purga a los
`processed-event.purge.retention-days`.

## Un mensaje parece perderse en una cola compartida

Dos listeners sobre la misma cola: compiten y cada mensaje llega a uno solo. Un listener por cola
(`references/listeners.md`).

## «Cannot resolve scoped service IUseCaseMediator from root provider»

El listener recibe el mediator en el constructor. Es un singleton y el mediator vive en un ámbito: abre uno por mensaje
con `IServiceScopeFactory` (`references/listeners.md` § El ámbito de DI).
