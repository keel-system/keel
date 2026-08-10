# Kafka — troubleshooting

Síntoma → causa → arreglo. Sondeo básico y recetas de infraestructura en
`{{keel:docs}}/conventions/infra-validation.md`.

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

## El arnés de pruebas falla al sondear el topic

Los helpers de `AbstractFlowIT` (`publishedMessages`, `purgeMessages`,
`publishRaw`) son **scaffold del generador**, no código de este proyecto: no los
reimplementes. Dos causas cubren casi todos sus fallos, y ambas se descartan en
minutos:

1. **El topic aún no existe.** Contra un broker recién levantado nadie ha
   publicado todavía, así que `kcat -o beginning` sale con `Unknown topic or
   partition` (código 1) y el arnés lo convierte en `IllegalStateException`.
   Cualquier lectura de offsets tiene que tolerarlo devolviendo 0 — es lo que
   hace `safeNextOffset()`. Síntoma típico: revienta el **primer** flujo de la
   suite o el humo del arnés, y no vuelve a pasar en la segunda corrida.
2. **El cuerpo llegó deformado (Windows).** Un JSON embebido en la cadena de
   `sh -c` pierde las comillas dobles: `ProcessBuilder` reconstruye una única
   línea de comandos y el escapado de `docker.exe`/`podman.exe` las corrompe
   antes de que kcat las vea. Lo que aterriza en el topic es
   `{metadata:{eventType:X}}`, que el filtro por `eventType` no reconoce: el
   síntoma es un `await` que agota el timeout **sin ningún error**. La regla del
   arnés es que todo cuerpo con comillas viaja por archivo (`copyToDevtools` +
   `kcat -P -l <archivo>`), nunca en la línea de comandos.

Para confirmar cuál de las dos es, publica a mano desde devtools y vuelve a leer:
`kcat -b kafka:29092 -t <topic> -C -o beginning -e -q`. Si el mensaje está pero
sin comillas, es la 2.

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

**Si ves esos topics, alguien añadió `@RetryableTopic` y sobra**: build ya genera
`DeadLetterConfig` con `DefaultErrorHandler` + `DeadLetterPublishingRecoverer`, que
reintenta in-situ (conserva el orden) y publica en `<topic>.DLT`. Con los dos
mecanismos a la vez el mensaje acaba en `-dlt` y no en `.DLT`, así que
`deadLetterMessages(...)` lee una cola vacía y el escenario da por bueno un descarte
que sí ocurrió. Quita la anotación; no cambies el destino del arnés.

## El envío «funciona» pero el evento no está en el topic

`send()` es asíncrono y el fallo quedó en un future ignorado (broker caído,
timeout, `RecordTooLargeException`). Registra el `whenComplete` del
implementation.md y revisa el log. Con `acks: all` y el broker de prueba
single-node no hay réplicas que esperar: un fallo aquí es de conexión o tamaño.
