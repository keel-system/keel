# Kafka en keel-dotnet — diagnóstico

Síntoma → causa → arreglo. Desde devtools: `kcat -b kafka:29092 -L` (topics y particiones) y
`kcat -b kafka:29092 -C -t <topic> -o beginning -e` (lo que hay en un topic). El log del servidor de las pruebas de
flujo está en `build/keel-scenarios/server.log`.

## El primer mensaje a un topic nuevo tarda en procesarse

El consumidor se suscribió antes de que el topic existiera, y no lo ve hasta el siguiente refresco de metadatos. En
`local` es de 2 s (`kafka.consumer.metadata-refresh-interval-ms`); fuera de `local`, el default de librdkafka (5 min),
porque allí los topics los aprovisiona la plataforma antes del despliegue. Si en `local` tarda minutos, alguien subió ese
valor.

## Nada se consume tras arrancar, durante unos segundos

Es el reparto del grupo: cada consumer group nuevo espera a que el broker le asigne sus particiones. La base de los
flujos espera, al abrir cada flujo, a que cada grupo cuyo topic existe tenga sus particiones (lo pregunta al broker con la
API de administración); un flujo que entregue antes de su `GivenAsync` lo verá tarde.

## El log dice «Kafka: … Connection refused» una y otra vez

El broker no está, o `KAFKA_BOOTSTRAP_SERVERS` no apunta a él. El servicio arranca igual y librdkafka reintenta solo.
En `local`, la app en el host habla con `localhost:9092`; `kafka:29092` es el listener de la red del compose
(devtools).

## Tras parar y levantar el broker, nada sale durante un rato

librdkafka se reconecta solo, y el relay del outbox cuenta los intentos que fallaron mientras tanto: cada envío en vuelo
espera hasta `kafka.producer.delivery-timeout-ms` (15 s en `local`) antes de fallar, y después el backoff del relay. En
`local`, con 40 intentos y tope de 2 s, la fila aguanta un reinicio entero; si se rinde, el broker tardó más de lo que
el presupuesto cubre. Los consumidores vuelven a recibir sus particiones cuando el grupo se recompone.

## Un mensaje tuyo no llega a `<topic>.DLT`

O el listener retornó en vez de lanzar (un `catch` que registra y sigue, o un `return` sobre un cuerpo que no parsea), o
ninguna suscripción de ese topic declara `onFailure.deadLetter`: entonces lo agotado se registra y se confirma, sin
descarte (`references/listeners.md`).

## Un mensaje llega al descarte al primer intento cuando debía reintentarse

Es un `DomainException` / `MessageContractViolation` (no se reintentan, a propósito). Si el error es de verdad transitorio
y sale como `DomainException`, el defecto está en quien lo lanza.

## Una suscripción no ve algunos mensajes de su topic

Dos suscripciones compartiendo consumer group: Kafka les reparte las particiones y cada una ve un trozo. El grupo es uno
por suscripción (`messaging.subscriptions.<e>.group-id`); si alguien lo igualó en un perfil, ahí está.

## La reentrega se procesa dos veces

El listener no deduplica, o deduplica con una clave distinta de la del contrato (con envoltura Keel,
`Metadata.EventId`; con una fuente ajena, el `messageId` declarado). Y la ventana: el registro se purga a los
`processed-event.purge.retention-days`.

## Un consumidor procesa el mismo mensaje una y otra vez

El descarte no se pudo escribir (el broker no acepta en `<topic>.DLT`): sin desenlace, la conexión no guarda el offset y
el mensaje vuelve. El log dice `no se pudo publicar en <topic>.DLT`. Es lo que hace Spring cuando su recuperador falla, y
la partición queda parada detrás de ese mensaje hasta que el descarte se pueda escribir.

## «Cannot resolve scoped service IUseCaseMediator from root provider»

El listener recibe el mediator en el constructor. Es un singleton y el mediator vive en un ámbito: abre uno por mensaje
con `IServiceScopeFactory` (`references/listeners.md` § El ámbito de DI).
