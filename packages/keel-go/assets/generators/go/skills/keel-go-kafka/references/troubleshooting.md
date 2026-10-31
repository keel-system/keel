# Kafka en keel-go — diagnóstico

Síntoma → causa → arreglo. El log del servidor de las pruebas de flujo está en `build/keel-scenarios/server.log`; los
topics se listan con `kcat -b kafka:29092 -L` desde el contenedor devtools de infra/.

## «los consumer groups del servicio no recibieron sus particiones» al abrir un flujo

El arnés espera a que cada grupo cuyo topic ya existe tenga un miembro con particiones. El que no llega es casi
siempre una suscripción **sin listener** en `cmd/server/broker.go` (nadie se une a su grupo), o un listener que llama a
`Consume` con un nombre que no es el de la suscripción en el diseño (`Consume` devuelve el error y el servicio no
arranca: míralo en el log).

## El primer mensaje de un escenario tarda en llegar

El topic no existía: lo crea el broker con el primer mensaje, y el consumidor no lo ve hasta que refresca sus
metadatos (`kafka.consumer.metadata-refresh-interval-ms`, 2 s en `local`). Fuera de `local` son 5 min por defecto: en
producción los topics los aprovisiona la plataforma antes de desplegar.

## El outbox reintenta hasta rendirse

`Publish` falla con `kafka.ErrUnavailable` cuando el broker no confirma dentro de `delivery.timeout.ms` (15 s en
`local`). Con el broker caído es lo esperado y la fila sale al volver; si se rinde con el broker arriba, mira el log
del cliente (`Kafka: …`) y que `KAFKA_BOOTSTRAP_SERVERS` apunte al listener externo (`localhost:9092`).

## El servicio no arranca: «no hay implementación de messaging.Dispatcher»

Con `reliability: outbox`, fuera de `local` y `test` el respaldo no deja arrancar. Falta el `Dispatcher` en lo que
devuelve `brokerAdapters` (`cmd/server/broker.go`).

## Un mensaje tuyo no llega a `<topic>.DLT`

O el handler devolvió `nil` en vez del error (eso lo confirma), o ninguna suscripción de ese topic declara
`onFailure.deadLetter`. Sin ella, lo agotado se registra y se confirma, y el log lo dice:
«el diseño no declara dead-letter para esta suscripción». Devuelve el error (`references/listeners.md`).

## Un mensaje llega al descarte al primer intento cuando debía reintentarse

Es un `*domain.Error` o un `*messaging.ContractError` (no se reintentan, a propósito). Si el error es de verdad
transitorio y sale como `*domain.Error`, el defecto está en quien lo construye.

## Un rechazo de negocio se reintenta

El error se envolvió sin `%w` o en un tipo propio: `IsRetryable` busca el `*domain.Error` con `errors.As`. Envuelve
con `%w` o devuélvelo tal cual.

## La reentrega se procesa dos veces

El listener no deduplica, deduplica con otra clave (con envoltura Keel, `envelope.Metadata.EventID`), o dos listeners
usan el mismo `handlerID`. Kafka reentrega de verdad tras un apagado a mitad o un offset sin confirmar: la guarda es
la que lo absorbe.

## Un mensaje se procesa en una suscripción que no es la suya

El listener no filtra por el tipo antes de despachar: cada grupo recibe el topic ENTERO, también los eventos de las
otras suscripciones de la misma fuente.
