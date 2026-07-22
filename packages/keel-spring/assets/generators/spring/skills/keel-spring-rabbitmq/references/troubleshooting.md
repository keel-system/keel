# RabbitMQ — troubleshooting

Síntoma → causa → arreglo. Sondeo básico y recetas de infraestructura en
`.claude/conventions/infra-validation.md`.

## `PRECONDITION_FAILED - inequivalent arg ...` al arrancar

Estás redeclarando una cola/exchange existente con argumentos distintos
(p. ej. añadiste `x-dead-letter-exchange` o cambiaste classic → quorum sobre
una cola ya creada). RabbitMQ no permite cambiar args de una cola viva.
**Arreglo en local**: borra la cola (`docker compose -f infra/docker-compose.yaml
exec rabbitmq rabbitmqctl delete_queue <cola>`, o desde la UI 15672) y reinicia
la app para que la redeclare. No «arregles» quitando la declaración del código.

## El mensaje se reentrega en bucle infinito

El listener lanza excepción y el mensaje vuelve a la cola
(`default-requeue-rejected: true`, el default). Ponlo a `false` y declara DLX;
para un descarte puntual, `AmqpRejectAndDontRequeueException`. Si la causa es
un error de conversión, revisa el payload en la DLQ: reintentar no lo arregla.

## Mensajes acumulados en «Unacked» (UI de management)

El consumidor los tiene prefetched sin ackear: o el proceso es más lento que el
`prefetch` configurado (bájalo), o hay `acknowledge-mode: manual` sin `ack`
explícito (vuelve a `auto` salvo necesidad real), o el listener está colgado
(thread dump). Los unacked vuelven a la cola al cerrar el canal.

## El publisher «funciona» pero el evento nunca llega

- Routing key sin binding: sin `publisher-returns` + `mandatory` el broker lo
  descarta en silencio. Actívalos (configuration.md) y mira el `ReturnsCallback`.
- Exchange sin declarar: la publicación falla con canal cerrado
  (`NOT_FOUND - no exchange`); asegúrate de que el exchange está en `Declarables`.
- Publicación dentro de la transacción con rollback posterior: con
  `reliability: after-commit` publica en `afterCommit`, no antes.

## `Connection refused` / `ACCESS_REFUSED`

`Connection refused`: el contenedor no está arriba o el puerto no coincide
(compose expone 5672); sondea `curl -sf -u guest:guest
http://rabbitmq:15672/api/healthchecks/node` desde devtools. `ACCESS_REFUSED`:
credenciales del perfil ≠ las del compose (guest/guest); ojo: guest solo puede
conectar desde localhost en instalaciones reales, no en el contenedor de prueba.

## La conversión JSON falla en el listener (`MessageConversionException`)

El productor no publica JSON (falta `Jackson2JsonMessageConverter` en su
template) o el `__TypeId__` no casa con el record destino. En este proyecto el
conversor está en `RabbitMqConfig` para template y container factory: verifica
que ambos usan el mismo bean y que el `<Evento>Message` refleja el payload real
(compara con un mensaje de la DLQ o de la UI).
