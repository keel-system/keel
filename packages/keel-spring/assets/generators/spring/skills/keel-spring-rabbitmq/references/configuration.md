# RabbitMQ — configuración y tuning

Propiedades `spring.rabbitmq.*` que el agente puede necesitar añadir en
`parameters/<perfil>/rabbitmq.yaml`. Build ya dejó `host`/`port`/`username`/`password`
con el gradiente por perfil (local literal, develop `${VAR:default}`, production
`${VAR}`): **no toques esas cuatro**; añade el resto solo si el diseño lo exige.

## Fiabilidad de publicación

Si el diseño declara `reliability: after-commit` u `outbox`, activa confirms para
detectar publicaciones perdidas:

```yaml
spring:
  rabbitmq:
    # Confirmación asíncrona del broker por mensaje (correlacionada con CorrelationData).
    publisher-confirm-type: correlated
    # Devuelve mensajes no enrutables (exchange sin binding para la routing key).
    publisher-returns: true
    template:
      mandatory: true
```

- `publisher-confirm-type: correlated` habilita `ConfirmCallback` en el
  `RabbitTemplate`; `simple` bloquea por envío (no lo uses en handlers).
- `publisher-returns` + `template.mandatory` habilitan `ReturnsCallback`: sin
  ellos, un mensaje con routing key sin binding se descarta en silencio.
- Con `best-effort` no hace falta nada de esto.

## Listener (contenedor simple)

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        # Mensajes prefetched por consumidor: bajo si el proceso es lento (reparte
        # mejor), alto si es rápido (menos round-trips). 250 es el default de Spring.
        prefetch: 10
        # auto: ack tras el listener sin excepción (default y correcto aquí:
        # el despacho vía UseCaseMediator es síncrono). manual solo si necesitas
        # ack por lotes o diferido.
        acknowledge-mode: auto
        # Un mensaje rechazado NO vuelve a la cola (iría al DLX si está declarado);
        # true (default) provoca bucles infinitos con errores permanentes.
        default-requeue-rejected: false
        # Consumidores concurrentes por listener; súbelo solo si la operación
        # destino es segura en concurrencia (idempotencia, locking optimista).
        concurrency: 1
        max-concurrency: 4
```

## Reintentos declarativos (alternativa al DLX con TTL)

Para `onFailure` con reintentos en memoria (bloquean el consumidor mientras
esperan; válido para backoffs cortos):

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        retry:
          enabled: true
          max-attempts: 5          # attempts del diseño
          initial-interval: 1s
          multiplier: 2.0
          max-interval: 10s
```

Agotados los reintentos, el mensaje se rechaza sin requeue → DLX si la cola lo
declara. Para backoffs largos usa el patrón DLX+TTL de
`references/implementation.md` (no bloquea el consumidor).

## Por perfil

- **local**: valores del compose (guest/guest, localhost:5672); prefetch y
  concurrencia bajos para depurar.
- **develop/production**: credenciales por env var (ya en el gradiente de build);
  considera `spring.rabbitmq.ssl.enabled: true` si el broker real lo exige y
  ajusta prefetch/concurrencia con datos reales, no por adelantado.
- Cualquier propiedad nueva respeta el gradiente: literal en local,
  `${VAR:default}` en develop, `${VAR}` en production.

## Qué no hacer

- No declares colas/exchanges en YAML ni a mano en la UI: la topología va en
  código (`Declarables`, ver `references/implementation.md`) para que el
  arranque sea reproducible.
- No subas `prefetch` y `concurrency` a la vez «por rendimiento» sin un
  escenario que lo pida: multiplica los mensajes en vuelo y los unacked.
- No uses `acknowledge-mode: none` (pérdida de mensajes garantizada ante caída).
