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

**Nada de esto se aplica solo por estar en el YAML.** `spring.rabbitmq.listener.simple.*` lo
lee `SimpleRabbitListenerContainerFactoryConfigurer`, así que solo llega al contenedor si el
bean del factory pasa por él (`configurer.configure(factory, connectionFactory)`, ver el
snippet de `SKILL.md`). Con un `new SimpleRabbitListenerContainerFactory()` cableado a mano,
todo lo de abajo es decorado: la app arranca, el camino feliz funciona y solo un escenario
adverso descubre que el listener nunca agotó reintentos.

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

**Es el bloque que más se pierde por el factory cableado a mano** (ver el aviso de § Listener):
sin el configurer, `retry.*` no llega al contenedor y el mensaje que falla se rechaza al primer
intento. El síntoma es que el escenario de descarte pasa «demasiado pronto» — cae a la DLQ sin
haber reintentado.

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

### El retry en memoria NO es una reentrega del broker

Y de ahí una interacción con el orden del `IdempotencyGuard` que no es evidente y que se
paga cara: estos reintentos **reinvocan tu handler dentro de la MISMA entrega**. No hay
segundo mensaje, el `eventId` es el mismo y el broker no ha vuelto a entregar nada.

Consecuencias, según el orden que el javadoc del `<Evento>Message` te haya prescrito:

- Con `alreadyProcessed(...)` + `record(...)` **después** del éxito: los N reintentos
  vuelven a entrar con el registro todavía sin escribir, que es justo lo que se quiere —
  el fallo transitorio se reintenta y el efecto no se duplica porque lo frena la
  transición del agregado. Si en vez de eso reclamas **antes** de despachar, el primer
  reintento se encuentra el mensaje ya marcado, se lo salta y el fallo transitorio se
  convierte en un mensaje perdido en silencio: el reintento existe pero no reintenta nada.
- Con `tryRecord(...)` antes de despachar: el registro ya está escrito cuando entra el
  primer reintento, así que agotar los intentos **pierde el mensaje igual**. Es el precio
  declarado de ese orden (lo elige el diseño al no declarar `transitions`), pero conviene
  saberlo antes de subir `max-attempts` creyendo que compra durabilidad: no la compra.

Regla corta: **el orden del guard lo dicta el diseño y no se ajusta para acomodar el
retry**. Si el orden prescrito y la durabilidad que necesitas no encajan, lo que falta es
una guarda de dominio en el diseño — no un `record()` movido de sitio.

Agotados los reintentos, el mensaje se rechaza sin requeue → DLX si la cola lo
declara. Para backoffs largos usa el patrón DLX+TTL de
`references/implementation.md` (no bloquea el consumidor).

## Recovery interval: la propiedad que no existe

`spring.rabbitmq.listener.simple.recovery-interval` **no existe**: `RabbitProperties` no la
expone, así que declararla en `parameters/` no tiene ningún efecto y el contenedor se queda con
el default invisible de `AbstractMessageListenerContainer` (5000 ms). La única vía es
`factory.setRecoveryInterval(...)` sobre el bean, leyendo una clave propia que **build ya
deja escrita** en `parameters/<perfil>/rabbitmq.yaml` (no la dupliques ni la sustituyas por un
literal):

```yaml
rabbitmq:
  listener:
    # Cada cuánto reintenta la conexión el contenedor de listeners. Clave PROPIA (no
    # spring.*) porque la de Boot no existe. De aquí sale también el DISPATCH_DEADLINE
    # del dispatcher del outbox, que tiene que quedar por encima: los dos comparten
    # ConnectionFactory y un deadline más corto reinicia este reloj en cada timeout.
    recovery-interval-ms: 5000
```

Que el número viva en un solo sitio es el punto: dispatcher y contenedor tienen que estar de
acuerdo, y el modo de fallo de que no lo estén es una recuperación que nunca converge.

## Por perfil

- **local**: valores del compose (guest/guest, localhost:5672); prefetch y
  concurrencia bajos para depurar.
- **develop/production**: credenciales por env var (ya en el gradiente de build);
  considera `spring.rabbitmq.ssl.enabled: true` si el broker real lo exige y
  ajusta prefetch/concurrencia con datos reales, no por adelantado.
- Cualquier propiedad nueva respeta el gradiente: literal en local,
  `${VAR:default}` en develop, `${VAR}` en production.

## Qué no hacer

- No declares `spring.rabbitmq.listener.simple.recovery-interval`: no existe (ver arriba).
  Queda en el YAML como una promesa que nadie cumple, y el contenedor sigue con su default.
- No declares colas/exchanges en YAML ni a mano en la UI: la topología va en
  código (`Declarables`, ver `references/implementation.md`) para que el
  arranque sea reproducible.
- No subas `prefetch` y `concurrency` a la vez «por rendimiento» sin un
  escenario que lo pida: multiplica los mensajes en vuelo y los unacked.
- No uses `acknowledge-mode: none` (pérdida de mensajes garantizada ante caída).
