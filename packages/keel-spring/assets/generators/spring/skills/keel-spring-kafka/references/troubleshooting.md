# Kafka — troubleshooting

Síntoma → causa → arreglo. Sondeo básico y recetas de infraestructura en
`.claude/conventions/infra-validation.md`.

## El listener no recibe nada (y el publisher sí publica)

1. **Group con offset ya avanzado**: el group consumió (o se creó con
   `auto-offset-reset: latest`) antes de publicar. Verifica con
   `kcat -b kafka:29092 -t <topic> -C -c 1` que el evento está en el topic;
   si está, resetea el offset del group o usa un `group-id` nuevo en local.
2. **Topic distinto**: el default es `<fuente>.events`; compara el topic del
   `@KafkaListener` (propiedad `messaging.subscriptions.<evento>.topic`) con el
   que usa el publisher.
3. **Conexión al listener equivocado**: desde el host es `localhost:9092`
   (EXTERNAL); desde dentro de la red compose (devtools) es `kafka:29092`
   (INTERNAL). Una app en el host apuntando a `kafka:29092` no conecta.

## El poll revienta en bucle con el mismo mensaje

Poison pill: `JsonDeserializer` sin `ErrorHandlingDeserializer` lanza antes de
llegar al listener y el offset no avanza. Configura el envoltorio
(`references/configuration.md`); el mensaje corrupto irá al error handler/DLT
y el resto fluye.

## `The class 'X' is not in the trusted packages`

El type header del mensaje apunta a una clase fuera de
`spring.json.trusted.packages`. Si el productor es este mismo servicio, añade
el paquete; si es externo, apaga los headers
(`spring.json.use.type.headers: false`) y fija `spring.json.value.default.type`
al `<Evento>Message` local — el record espejo es tuyo, no de la fuente.

## Rebalanceos continuos / `max.poll.interval.ms exceeded`

El handler tarda más que `max.poll.interval.ms` en procesar el lote: el broker
expulsa al consumidor, reasigna y el ciclo se repite (verás el mismo lote
procesado a medias varias veces). Baja `max-poll-records`, sube el interval o
saca el trabajo pesado del camino síncrono del listener.

## Duplicados en el consumo

Comportamiento at-least-once esperado tras rebalanceos o reinicios, no un bug
del broker: la solución es idempotencia de consumo
(`references/implementation.md`). Si además el producer duplica en reintentos,
falta `enable.idempotence: true`.

## `@RetryableTopic` crea topics inesperados / rompe el orden

Es su diseño: `-retry-*` y `-dlt` por topic, y los mensajes en retry salen de
su partición original (el orden relativo con mensajes posteriores se pierde).
Si el orden importa, cambia a `DefaultErrorHandler` con backoff bloqueante
(ver implementation.md). En local puedes limpiar los topics de retry sin
miedo; en clusters reales su creación puede estar prohibida — pacta con la
plataforma.

## El envío «funciona» pero el evento no está en el topic

`send()` es asíncrono y el fallo quedó en un future ignorado (broker caído,
timeout, `RecordTooLargeException`). Registra el `whenComplete` del
implementation.md y revisa el log. Con `acks: all` y el broker de prueba
single-node no hay réplicas que esperar: un fallo aquí es de conexión o tamaño.
