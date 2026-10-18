# Observabilidad (telemetría OpenTelemetry vía colector)

Este documento solo existe si el proyecto se generó con telemetría (`telemetry: otel` en `keel-stack.json`, elegido en
el cuestionario de `keel-dotnet build` o con `--telemetry otel`). Sin ella, el servidor no emite telemetría y nada de
esto aplica.

## El patrón: un colector en medio

El servicio emite **trazas (y, opcionalmente, logs) por OTLP/HTTP a un colector OpenTelemetry**, y lo único que sabe
de él es su dirección: la variable `OTEL_EXPORTER_OTLP_ENDPOINT`. Las **métricas van al revés**: no se empujan, las
viene a buscar el colector a `/actuator/prometheus` (en `production`, en el puerto de gestión `MANAGEMENT_PORT`, que
no se publica fuera del pod). El motivo son los **exemplars** —el enlace de un punto de una métrica a una traza—, que
viajan pegados a los cubos del histograma en la exposición OpenMetrics.

**Los nombres son los de los servidores de keel-spring y keel-nest del mismo diseño**: el mismo panel y las mismas
alertas tienen datos con los tres. Cambiar de backend no toca el código ni la configuración: se edita el colector.

Las trazas van con el SDK de OpenTelemetry sobre un `ActivitySource` propio, `keel`, y las métricas con prometheus-net.
**No hay instrumentación automática de ASP.NET Core ni de HttpClient**: los spans los abre el código generado en los
puntos de paso. ASP.NET Core crea su propio `Activity` por petición aunque nadie lo exporte, y un span del servicio que
colgara de él quedaría con un padre que el backend no tiene; por eso los del servicio toman su padre de forma explícita.

## Qué lo genera build (y no se toca a mano)

| Pieza | Dónde | Qué hace |
|---|---|---|
| `KeelTelemetry` | `Infrastructure/Telemetry/KeelTelemetry.cs` | El proveedor de trazas (W3C, acepta B3), el registro de métricas y las observaciones. La arranca `Program.cs` antes que la aplicación. |
| Configuración | `config/parameters/<perfil>/telemetry.yaml` | Endpoint, muestreo, recurso y los interruptores; las MISMAS variables que keel-spring y keel-nest. |
| `UseCaseMediator` | `Infrastructure/UseCase` | `keel.use-case` por caso de uso: span con el nombre del mensaje y `keel_use_case_seconds` con `keel.operation` y `keel.outcome` (`ok`, `rejected`, `error`). |
| Entrada HTTP | `Infrastructure/Telemetry/HttpTelemetryMiddleware.cs` | El primero del pipeline: un span SERVER por petición que continúa la traza de quien llama, y `http_server_requests_seconds` con la plantilla de la ruta. Las sondas cuentan pero no abren traza. |
| Relay del outbox | `Infrastructure/Messaging/Outbox/OutboxRelay.cs` | Publica cada evento dentro de la traza que lo originó (`keel.outbox.publish`) y publica el gauge `keel.outbox.dead_lettered`. |
| Envoltura | `EventEnvelope.Of(...)` | Estampa `metadata.traceparent` con el span en curso. |
| Consumo | `Infrastructure/Messaging/InboundContext.cs` | `InboundContext.Run(envelope.Metadata, ...)`: la correlación de origen y un span CONSUMER (`keel.message.consume`) que continúa la traza del emisor. |
| Clientes HTTP | `Infrastructure/Clients/HttpExchange.cs` | Span CLIENT por llamada, `traceparent` hacia el proveedor y `http_client_requests_seconds`. El transporte no propaga nada por su cuenta. |
| Storage / correo | `ObservedFileStorage`, `ObservedMailSender` | El PUERTO se registra observado (`keel.storage` con la operación y el bucket lógico; `keel.mail.send`), así que se instrumenta cualquier adaptador, lo escriba quien lo escriba. |
| Caché | `Infrastructure/Cache/RedisOperationCache.cs` | `cache_gets_total{cache,result}`, el ratio de acierto del panel. |
| Logs | `Infrastructure/Logging/KeelConsoleFormatter.cs` | `trace.id`/`span.id` en cada línea dentro de una traza del servicio; por OTLP con `LOG_EXPORT_OTLP`. |

## Instrumentación opcional por subsistema

| Subsistema | Variable | Qué desaparece al apagarlo |
|---|---|---|
| Caché | `TELEMETRY_INSTRUMENT_CACHE` | — (reservado: las lecturas se cuentan siempre). |
| Almacenamiento | `TELEMETRY_INSTRUMENT_STORAGE` | El decorador del puerto `IFileStorage`: el adaptador se invoca directamente. |
| Correo | `TELEMETRY_INSTRUMENT_MAIL` | El decorador del puerto `IMailSender`: el correo sale igual. |

Se leen al arrancar: cambian con un reinicio, nunca en caliente. Solo se declaran las de los subsistemas que el diseño trae.

## Reglas para quien escribe código

- **El listener abre su contexto con `InboundContext.Run(envelope.Metadata, async () => { ... })`.** Abrir solo la
  correlación con `CorrelationContext.Open(...)` compila, pasa todos los escenarios y **corta la traza en cada
  consumo**; con SNS/SQS la envoltura es la única vía.
- **No instrumentes un adaptador de un puerto observado** (storage, correo): el registro ya entrega el puerto decorado.
  Una observación propia duplica el span y la serie.
- **No abras spans a mano ni crees otro `ActivitySource`.** Lo que importa ya es una observación: la petición, el caso
  de uso, la publicación, el consumo, la llamada saliente, el bucket y el correo. Un `ActivitySource` que el proveedor
  no escucha no exporta nada, y uno que sí escucha abre spans que nadie consulta.
- **Si añades una métrica, añade dónde se mira** (el panel o una alerta). Una serie que nadie consulta no la mira nadie,
  y una alerta sobre una serie que nadie publica no dispara nunca.
- **Cardinalidad baja en las etiquetas de métricas.** Nombres de operación o de evento, sí; ids, emails o importes,
  nunca: cada valor distinto es una serie nueva, y es el único fallo sin ningún síntoma —nada falla, se ve en la
  factura del backend—. Un identificador va al span (`SpanAttributes`), que es donde sirve. Lo veta
  `infra/check-telemetry.sh`: las claves de etiqueta son las del vocabulario.
- **Ni datos personales ni secretos en atributos ni en logs.** Identifica por id, nunca por el dato.
- **Loguea con `ILogger<T>`** (mejor con `[LoggerMessage]`): el formateador del servicio pone la correlación y la
  traza en cada línea. Nada de `Console.WriteLine`, que se salta el formato y los niveles. Lo veta
  `infra/check-logging.sh`, junto con loguear un objeto de entrada entero, construir el mensaje a mano, un `LogError`
  desde Domain o Application y lanzar trabajo sin el contexto de la petición.

## Perfiles

| Perfil | Exportación | Muestreo | Endpoint |
|---|---|---|---|
| `local` | **apagada** por defecto (`TELEMETRY_EXPORT_ENABLED=true` para encenderla) | 100 % | `http://localhost:4318` por defecto |
| `develop` | encendida | 100 % | `OTEL_EXPORTER_OTLP_ENDPOINT`, `http://localhost:4318` por defecto |
| `production` | encendida | 10 % de las raíces (`TRACING_SAMPLING_PROBABILITY`) | `OTEL_EXPORTER_OTLP_ENDPOINT` **obligatoria** |
| `test` | apagada | 100 % | — |

El muestreo es *parent-based*: el servicio respeta la decisión de quien lo llama y solo decide en las raíces.
