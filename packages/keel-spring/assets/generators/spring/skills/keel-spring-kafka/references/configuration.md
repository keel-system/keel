# Kafka — configuración y tuning

Propiedades `spring.kafka.*` que el agente puede necesitar en
`parameters/<perfil>/kafka.yaml`. Build ya dejó `bootstrap-servers` (gradiente
por perfil), serializadores del producer y un consumer con
`StringDeserializer` + `// TODO (agente)`: **ese TODO es tuyo** — la
deserialización de consumo se completa aquí.

El producer sale con `StringSerializer` en clave y valor, y **eso no se cambia**:
el JSON lo produce el `ObjectMapper` de la aplicación y viaja ya serializado
(SKILL.md § Envío al broker). Sustituirlo por `JsonSerializer` reintroduce el
doble escapado y el desajuste de módulos de serialización.

## Producer: fiabilidad primero

```yaml
spring:
  kafka:
    producer:
      # Espera el ack de todas las réplicas in-sync: sin esto puedes perder
      # eventos publicados en un failover.
      acks: all
      properties:
        # Reintentos del producer sin duplicar mensajes (exactly-once por partición).
        enable.idempotence: true
        # Tiempo total (envío + reintentos) antes de dar el envío por fallido.
        delivery.timeout.ms: 120000
      # Latencia/throughput: agrupa envíos hasta 10ms o 32KB antes de mandar.
      # Déjalo en 0 (default) salvo throughput real de eventos.
      # properties.linger.ms: 10
      compression-type: lz4      # solo con payloads grandes o mucho volumen
```

Con `reliability: after-commit` u `outbox`, `acks: all` + idempotence no son
opcionales: son la mitad broker de la garantía.

## Consumer: deserialización JSON segura (el TODO de build)

```yaml
spring:
  kafka:
    consumer:
      # Envuelve al deserializador real: un mensaje corrupto no tumba el listener
      # (va al error handler en vez de reventar el poll en bucle).
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      # Dónde empezar si el group no tiene offset: earliest procesa lo ya
      # publicado (lo normal para suscripciones de eventos), latest lo ignora.
      auto-offset-reset: earliest
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        # Solo confía en tus paquetes: sin esto la deserialización por type
        # headers es un vector de ejecución de clases arbitrarias.
        spring.json.trusted.packages: <basePackage>
        # El publisher externo no manda type headers compatibles: fija el tipo
        # destino por defecto y apaga el uso de headers.
        # Válido SOLO si el topic transporta un único tipo (ver abajo).
        spring.json.value.default.type: <basePackage>.infrastructure.messaging.subscriptions.<Evento>Message
        spring.json.use.type.headers: false
```

Un tipo por topic no es la regla, es un caso: comprueba el `contract` del
diseño antes de fijarlo.

- **Sin `discriminator`** — el canal transporta un solo tipo: `default.type` como
  arriba (o el `<Evento>Envelope` cuando `envelope: wrapped`, y
  `EventEnvelope<XxxMessage>` cuando `envelope: keel`).
- **Con `discriminator`** — el canal multiplexa varios eventos y `default.type`
  reventaría con los que no son tuyos. Deserializa a `JsonNode` (o `byte[]`) y
  enruta en el listener por el header/campo declarado, descartando el resto sin
  lanzar excepción (una excepción dispararía reintentos sobre un mensaje que
  simplemente no te toca).
- **Varias suscripciones de tipos distintos en topics distintos** — un
  `JsonDeserializer` por container factory, o `spring.json.type.mapping`
  (`token:clase,token2:clase2`) acordado con la fuente.
- **`format: avro|protobuf`** — no aplica nada de esto: usa el deserializador del
  formato y apunta `schema.registry.url` al registry de la fuente (`schemaRef`
  del diseño identifica el schema).

## Consumer: poll y rebalanceo

```yaml
spring:
  kafka:
    consumer:
      max-poll-records: 500        # bájalo si procesar 500 excede max.poll.interval
      properties:
        # Tiempo máximo entre polls antes de que el broker expulse al consumidor
        # (rebalanceo). Handler lento → súbelo o baja max-poll-records.
        max.poll.interval.ms: 300000
```

El commit de offsets lo gestiona Spring (`ack-mode` BATCH por defecto: commit
tras procesar el lote). No actives `enable.auto.commit`.

## Por perfil

- **local**: `localhost:9092` (listener EXTERNAL del compose); deja
  `auto-offset-reset: earliest` para que los escenarios vean eventos previos.
- **develop/production**: bootstrap por env var (ya en el gradiente); añade la
  seguridad del cluster real (`spring.kafka.security.protocol`, SASL) según el
  entorno — nunca credenciales literales.
- Cualquier propiedad nueva respeta el gradiente: literal en local,
  `${VAR:default}` en develop, `${VAR}` en production.

## Qué no hacer

- No pongas `spring.json.trusted.packages: "*"` (desactiva la protección).
- No configures reintentos del listener por properties ni por anotación: **ya los
  genera build** en `DeadLetterConfig`, con los valores del `onFailure` del diseño
  (ver `references/implementation.md`).
- No crees topics por código (`KafkaAdmin`/`NewTopic`) **en ningún perfil**, local
  incluido: ahí los autocrea el broker del compose con 1 partición, que es el
  valor que la infraestructura de prueba quiere, y en los entornos reales los
  gobierna la plataforma. El razonamiento completo está en SKILL.md § Topología.
  Si algún entorno llegara a exigir que la app los declarase, sería bajo perfil,
  con `KafkaAdmin.setAutoCreate(false)` en `production`, factor de replicación
  `-1` (el default del broker) y nunca un número de particiones fijo.
