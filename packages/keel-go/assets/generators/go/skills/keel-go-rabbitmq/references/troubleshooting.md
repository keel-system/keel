# RabbitMQ en keel-go — diagnóstico

Síntoma → causa → arreglo. La UI de management está en `http://localhost:15672` (guest/guest); el log del servidor de
las pruebas de flujo, en `build/keel-scenarios/server.log`.

## `routed:false` al entregar desde una prueba (`s.DeliverMessage` falla)

El exchange de la fuente existe pero no hay cola enlazada: la conexión del servicio no llegó a declarar su topología.
`StartFlow` espera a que el servidor esté conectado al abrir cada flujo (lo busca entre las conexiones del broker por
el nombre del servicio); si aun así pasa, mira el log del servidor (`RabbitMQ: no se pudo conectar`) y que `infra/`
esté arriba (`bash infra/validate-infra.sh`).

## `PRECONDITION_FAILED - inequivalent arg` en el log

Alguien redeclaró una cola de build con otros argumentos (sin `x-dead-letter-*`, o como quorum). RabbitMQ no permite
cambiar los argumentos de una cola viva, y la conexión no llega a quedar arriba. **Quita la declaración**: la
topología es de build. En local, borra la cola desde la UI (o `bash infra/down.sh --volumes`) y arranca de nuevo.

## El outbox reintenta hasta rendirse con «el mensaje no tenía cola»

`Publish` va con `mandatory`: un mensaje que el exchange no enruta a ninguna cola vuelve, y no se da por publicado. La
cola del canal la declara build con el binding de cada routing key; si falla, la routing key de la fila no casa con la
de `messaging.publishing.routing-keys` (¿la cambió alguien en un perfil?) o el destino no es
`messaging.publishing.destination`.

## Tras levantar el broker, nada sale durante unos segundos

Es la reconexión: `Connection.Run` reintenta con una espera que se dobla hasta `rabbitmq.listener.recovery-interval-ms`.
Mientras tanto `Publish` devuelve `rabbitmq.ErrUnavailable` y el relay cuenta el intento con su backoff. En local, con
40 intentos y tope de 2 s, la fila aguanta un reinicio entero; si se rinde, el broker tardó más de lo que el
presupuesto cubre.

## El servicio no arranca: «no hay implementación de messaging.Dispatcher»

Con `reliability: outbox`, fuera de `local` y `test` el respaldo no deja arrancar: marcaría como publicados eventos que
nunca salen. Falta el `Dispatcher` en lo que devuelve `brokerAdapters` (`cmd/server/broker.go`).

## Un mensaje tuyo no llega a la DLQ

El handler devolvió `nil` en vez del error (un `if err != nil { logger.Error(…); return nil }`, o un `return nil` sobre
un cuerpo que no se lee): eso lo confirma y lo borra. Devuelve el error (`references/listeners.md`).

## Un mensaje llega a la DLQ al primer intento cuando debía reintentarse

O es un `*domain.Error` / `*messaging.ContractError` (no se reintentan, a propósito), o ninguna suscripción declara
`onFailure.retry` (sin él, un solo intento: `rabbitmq.ListenerAttempts()` es 1). Si el error es de verdad transitorio y
sale como `*domain.Error`, el defecto está en quien lo construye.

## Un rechazo de negocio se reintenta

El error se envolvió sin `%w` (`fmt.Errorf("…: %v", err)`) o en un tipo propio: `IsRetryable` busca el
`*domain.Error` con `errors.As`, y uno opaco lo trata como transitorio. Envuelve con `%w` o devuélvelo tal cual.

## La reentrega se procesa dos veces

El listener no deduplica, o deduplica con una clave distinta de la del contrato (con envoltura Keel,
`envelope.Metadata.EventID`; con una fuente ajena, el `messageId` declarado), o dos listeners usan distinto `handlerID`
para la misma suscripción. Y la ventana: el registro se purga a los `processed-event.purge.retention-days`.

## Un mensaje parece perderse en una cola compartida

Dos listeners sobre la misma cola: compiten y cada mensaje llega a uno solo. Un listener por cola
(`references/listeners.md`).

## El consumidor deja de recibir tras reiniciar el broker

Un listener que devuelve antes de tiempo: `messageListeners` tiene que devolver funciones que llamen a
`deps.Rabbit.Consume` y **devuelvan lo que devuelve**. `Consume` ya se reabre sobre cada conexión nueva; un listener
que lo envuelve en su propio bucle, o que vuelve en cuanto ve un error, deja la cola sin consumidor.
