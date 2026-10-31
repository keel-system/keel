# SNS/SQS en keel-go — diagnóstico

Síntoma → causa → arreglo. El log del servidor de las pruebas de flujo está en `build/keel-scenarios/server.log`; los
topics y las colas se listan desde el contenedor devtools de infra/ con
`aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` (y `sqs list-queues`).

## «SQS: no se pudo sondear la cola; se reintenta» en bucle

La cola no existe: la topología no está sembrada. LocalStack la guarda en MEMORIA, así que un LocalStack recién
levantado o reiniciado no tiene nada hasta `bash infra/init-messaging.sh` (el arnés lo hace solo al levantar el broker
en un escenario). Si la cola existe, mira que `AWS_SQS_ENDPOINT` apunte a LocalStack y que
`messaging.subscriptions.<e>.queue` no la haya renombrado.

## El outbox reintenta: «el topic X no existe» o «todavía no tiene ningún suscriptor confirmado»

`Publish` se niega a dar por publicado lo que SNS descartaría: un topic que no existe, o uno sin suscriptores (SNS
acepta el mensaje y lo tira sin error). Es lo esperado con la topología sin sembrar o recién resembrada; la fila sale
en cuanto la suscripción está confirmada. Si se rinde con todo arriba, falta la suscripción de ese topic en
`infra/init-messaging.sh` (se regenera desde el diseño: no lo edites a mano).

## «SNS: falta el message attribute eventType»

El dispatcher o el publisher no pasa el tipo del evento como atributo. Sin él ninguna suscripción recibiría el
mensaje (filtran por `eventType`), así que `Publish` lo rechaza antes de enviarlo.

## El servicio no arranca: «no hay implementación de messaging.Dispatcher»

Con `reliability: outbox`, fuera de `local` y `test` el respaldo no deja arrancar. Falta el `Dispatcher` en lo que
devuelve `brokerAdapters` (`cmd/server/broker.go`).

## Un mensaje entregado no llega al listener

O no lleva el message attribute `eventType` del tipo de la suscripción (el filtro lo deja fuera sin ningún error), o
la suscripción SNS→SQS no tiene raw delivery (el listener recibiría el sobre de SNS, `{"Type":"Notification",…}`, que
el contrato no describe y va a la DLQ como contrato incumplido). Las dos cosas las pone `infra/init-messaging.sh`.

## Un mensaje tuyo no llega a la DLQ

O el handler devolvió `nil` en vez del error (eso lo borra), o la suscripción no declara `onFailure.deadLetter`. Sin
ella, lo no reintentable o agotado se registra y se borra, y el log lo dice:
«la suscripción no declara dead-letter». Devuelve el error (`references/listeners.md`).

## Un fallo transitorio tarda en llegar a la DLQ

Es la curva del diseño: cada recepción fallida oculta el mensaje `initial·multiplier^(n-1)` (al segundo, con su
techo) y la RedrivePolicy lo mueve tras `MaxReceive` recepciones. El sondeo largo
(`aws.sqs.listener.poll-timeout-seconds`) suma su espera a cada vuelta.

## Un mensaje llega a la DLQ a la primera cuando debía reintentarse

Es un `*domain.Error` o un `*messaging.ContractError` (no se reintentan, a propósito: la conexión los lleva directos a
la DLQ). Si el error es de verdad transitorio y sale como `*domain.Error`, el defecto está en quien lo construye.

## Un rechazo de negocio se reintenta

El error se envolvió sin `%w` o en un tipo propio: `IsRetryable` busca el `*domain.Error` con `errors.As`. Envuelve
con `%w` o devuélvelo tal cual.

## La reentrega se procesa dos veces

El listener no deduplica, deduplica por `message.MessageID` (el de SQS, que cambia en cada reenvío) en vez de por la
clave del contrato (con envoltura Keel, `envelope.Metadata.EventID`), o dos listeners usan el mismo `handlerID`. SQS
entrega «al menos una vez»: la guarda es la que lo absorbe.
