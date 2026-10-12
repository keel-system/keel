# Observabilidad (telemetría OpenTelemetry vía colector)

Este documento solo existe si el proyecto se generó con telemetría (`telemetry: otel` en `keel-stack.json`, elegido en
el cuestionario de `keel-nest build` o con `--telemetry otel`). Sin ella, el servidor no emite telemetría y nada de
esto aplica.

## El patrón: un colector en medio

El servicio emite **trazas (y, opcionalmente, logs) por OTLP/HTTP a un colector OpenTelemetry**, y lo único que sabe
de él es su dirección: la variable `OTEL_EXPORTER_OTLP_ENDPOINT`. Las **métricas van al revés**: no se empujan, las
viene a buscar el colector a `/actuator/prometheus` (en `production`, en el puerto de gestión `MANAGEMENT_PORT`, que
no se publica fuera del pod). El motivo son los **exemplars** —el enlace de un punto de una métrica a una traza—, que
viajan pegados a los cubos del histograma en la exposición OpenMetrics.

**Los nombres son los del servidor de keel-spring del mismo diseño**: el mismo panel y las mismas alertas tienen datos
con los dos. Cambiar de backend no toca el código ni la configuración: se edita el colector.

## Qué lo genera build (y no se toca a mano)

| Pieza | Dónde | Qué hace |
|---|---|---|
| `Telemetry` | `infrastructure/telemetry/telemetry.ts` | El proveedor de trazas (W3C, acepta B3), el registro de métricas y las observaciones. La arranca `main.ts` antes que la aplicación. |
| Configuración | `config/parameters/<perfil>/telemetry.yaml` | Endpoint, muestreo, recurso y los interruptores; las MISMAS variables que keel-spring. |
| `UseCaseMediator` | `infrastructure/usecase` | `keel.use-case` por caso de uso: span con el nombre del mensaje y `keel_use_case_seconds` con `keel.operation` y `keel.outcome` (`ok`, `rejected`, `error`). |
| Entrada HTTP | `infrastructure/http/http-platform.ts` | Un span SERVER por petición que continúa la traza de quien llama, y `http_server_requests_seconds` con la plantilla de la ruta. |
| Relay del outbox | `infrastructure/messaging/outbox` | Publica cada evento dentro de la traza que lo originó (`keel.outbox.publish`) y publica el gauge `keel.outbox.dead_lettered`. |
| Envoltura | `EventEnvelope.of(...)` | Estampa `metadata.traceparent` con la traza en curso. |
| Consumo | `infrastructure/messaging/inbound-context.ts` | `runInbound(envelope.metadata, ...)`: la correlación de origen y un span CONSUMER (`keel.message.consume`) que continúa la traza del emisor. |
| Clientes HTTP | `infrastructure/clients/http-exchange.ts` | Span CLIENT por llamada, `traceparent` hacia el proveedor y `http_client_requests_seconds`. |
| Storage / correo | los módulos de `infrastructure/storage` y `infrastructure/mail` | El PUERTO se entrega observado (`keel.storage` con la operación y el bucket lógico; `keel.mail.send`), así que se instrumenta cualquier adaptador, lo escriba quien lo escriba. |
| Caché | el adaptador de `infrastructure/cache` | `cache_gets_total{cache,result}`, el ratio de acierto del panel. |
| Logs | `infrastructure/logging/keel-logger.ts` | `trace.id`/`span.id` en cada línea dentro de una traza; por OTLP con `LOG_EXPORT_OTLP`. |

## Instrumentación opcional por subsistema

| Subsistema | Variable | Qué desaparece al apagarlo |
|---|---|---|
| Caché | `TELEMETRY_INSTRUMENT_CACHE` | — (reservado: las lecturas se cuentan siempre). |
| Almacenamiento | `TELEMETRY_INSTRUMENT_STORAGE` | El envoltorio del puerto `FileStorage`: el adaptador se invoca directamente. |
| Correo | `TELEMETRY_INSTRUMENT_MAIL` | El envoltorio del puerto `MailSender`: el correo sale igual. |

Se leen al arrancar: cambian con un reinicio, nunca en caliente. Solo se declaran las de los subsistemas que el diseño trae.

## Reglas para quien escribe código

- **El listener abre su contexto con `runInbound(envelope.metadata, async () => { ... })`.** Abrir solo la correlación con
  `CorrelationContext.runWith(envelope.metadata.correlationId, ...)` compila, pasa todos los escenarios y **corta la
  traza en cada consumo**; con SNS/SQS la envoltura es la única vía.
- **No instrumentes un adaptador de un puerto observado** (storage, correo): el módulo ya entrega el puerto envuelto.
  Una observación propia duplica el span y la serie.
- **No abras spans a mano.** Lo que importa ya es una observación: la petición, el caso de uso, la publicación, el
  consumo, la llamada saliente, el bucket y el correo.
- **Si añades una métrica, añade dónde se mira** (el panel o una alerta). Una serie que nadie consulta no la mira nadie,
  y una alerta sobre una serie que nadie publica no dispara nunca.
- **Cardinalidad baja en las etiquetas de métricas.** Nombres de operación o de evento, sí; ids, emails o importes,
  nunca: cada valor distinto es una serie nueva. Un identificador va al span, que es donde sirve.
- **Ni datos personales ni secretos en atributos ni en logs.** Identifica por id, nunca por el dato.
- **Loguea con `new Logger(Contexto)`** de Nest: el logger del servicio pone la correlación y la traza en cada línea.
  Nada de `console.log`, que se salta el formato y los niveles.

## Perfiles

| Perfil | Exportación | Muestreo | Endpoint |
|---|---|---|---|
| `local` | **apagada** por defecto (`TELEMETRY_EXPORT_ENABLED=true` para encenderla) | 100 % | `http://localhost:4318` por defecto |
| `develop` | encendida | 100 % | `OTEL_EXPORTER_OTLP_ENDPOINT`, `http://localhost:4318` por defecto |
| `production` | encendida | 10 % de las raíces (`TRACING_SAMPLING_PROBABILITY`) | `OTEL_EXPORTER_OTLP_ENDPOINT` **obligatoria** |
| `test` | sin telemetría | — | — |

El muestreo es *parent-based*: el servicio respeta la decisión de quien lo llama y solo decide en las raíces.
