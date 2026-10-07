# SNS/SQS en keel-nest — diagnóstico

Síntoma → causa → arreglo. Desde devtools, con `AWS="aws --endpoint-url http://localstack:4566 --region us-east-1"`:
`$AWS sns list-topics`, `$AWS sqs list-queues` y `$AWS sqs receive-message --queue-url
http://localstack:4566/000000000000/<cola> --visibility-timeout 0` (mira sin consumir).

## `SQS: no se pudo sondear <cola> (QueueDoesNotExist)` en bucle

La topología no está sembrada: LocalStack la sirve de MEMORIA, y un reinicio del contenedor la borra. `bash
infra/init-messaging.sh` (idempotente) y `bash infra/validate-infra.sh`. El servicio sigue reintentando cada
`aws.reconnect-interval-ms` y se recupera solo en cuanto la cola existe.

## El outbox reintenta con «el topic … no existe» o «no tiene ningún suscriptor confirmado»

Es la protección, no el fallo: la conexión no crea el topic ni publica en uno sin suscriptores, porque SNS
descartaría el mensaje sin error y el relay lo daría por publicado. Siembra la topología; la fila sale en el
siguiente intento.

## Un mensaje publicado no llega a la cola

Falta el message attribute `eventType`, o no casa con la `FilterPolicy` de la suscripción (el nombre del evento
en el diseño, tal cual). `publish` lanza si falta; si está y no casa, mira el filtro de la suscripción en
`init-messaging.sh`. Y el `Subject` de SNS no sirve: con raw delivery se descarta.

## El cuerpo llega envuelto en `{"Type":"Notification","Message":…}`

La suscripción SNS→SQS no tiene raw delivery: alguien la creó a mano. Bórrala y vuelve a sembrar con
`init-messaging.sh`.

## Un fallo tarda en reintentarse lo que no dice el diseño

La curva la aplica la conexión alargando la visibilidad del mensaje (`initialDelayMs · 2^(n-1)`, con el techo de
`maxDelayMs`, al segundo). Si alguien cambia la visibilidad o lo borra a mano, el mensaje vuelve con la visibilidad
fija de la cola (30 s) o no vuelve.

## Un mensaje tuyo no llega a la DLQ

El listener retornó en vez de lanzar (eso lo borra), o la suscripción no declara `onFailure.deadLetter` (sin DLQ,
lo agotado se registra y se borra). Con DLQ, un fallo transitorio llega tras `maxReceiveCount` recepciones; uno no
reintentable, al primer intento.

## La reentrega se procesa dos veces

El listener deduplica por el `MessageId` de SQS (cambia en cada reenvío) en vez de por la clave del contrato, o no
deduplica. Y la ventana: el registro se purga a los `processed-event.purge.retention-days`.

## Tras parar y levantar LocalStack, nada sale durante un rato

La topología se perdió con el reinicio: el arnés la vuelve a sembrar en `startBroker()` y espera a que la
suscripción entregue una sonda antes de seguir. Fuera del arnés, siémbrala tú. Mientras tanto el relay cuenta los
intentos fallidos con su backoff; en `local`, con 40 intentos y tope de 2 s, la fila aguanta un reinicio entero.

## El proceso se cae al parar el broker («Unhandled Rejection»)

Una promesa sin `await` ni `catch` en código propio que toca el broker. La conexión de build maneja los suyos; un
`void this.connection.publish(...)` en un listener o un publisher no. Espera siempre la promesa.
