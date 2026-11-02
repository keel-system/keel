# Observabilidad (telemetría OpenTelemetry vía colector)

Este documento solo existe si el proyecto se generó con telemetría (`telemetry: otel` en `keel-stack.json`, elegido en
el cuestionario de `keel-go build` o con `--telemetry otel`). Sin ella, el servidor no emite telemetría y nada de esto
aplica.

## El patrón: un colector en medio

El servicio emite **trazas (y, opcionalmente, logs) por OTLP/HTTP a un colector OpenTelemetry**, y lo único que sabe
de él es su dirección: la variable `OTEL_EXPORTER_OTLP_ENDPOINT`. Las **métricas van al revés**: no se empujan, las
viene a buscar el colector a `/actuator/prometheus` (en `production`, en el puerto de gestión `MANAGEMENT_PORT`, que
no se publica fuera del pod). El motivo son los **exemplars** —el enlace de un punto de una métrica a una traza—, que
viajan pegados a los cubos del histograma en la exposición OpenMetrics.

**Los nombres son los de los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño**: el mismo panel y las
mismas alertas tienen datos con los cuatro. Cambiar de backend no toca el código ni la configuración: se edita el colector.

Las trazas van con el SDK de OpenTelemetry y las métricas con client_golang. **No hay instrumentación automática ni estado
global**: los spans los abre el código generado en los puntos de paso, y `run` construye un `*telemetry.Telemetry` y se lo
da a quien observa. El span viaja en el `context.Context`, así que un span cuelga del que tiene delante en su contexto.

## Qué lo genera build (y no se toca a mano)

| Pieza | Dónde | Qué hace |
|---|---|---|
| `Telemetry` | `internal/platform/telemetry/telemetry.go` | El proveedor de trazas (W3C, acepta B3), el registro de métricas y las observaciones. La arranca `run` antes que el logger. |
| Configuración | `config/parameters/<perfil>/telemetry.yaml` | Endpoint, muestreo, recurso y los interruptores; las MISMAS variables que los otros servidores. |
| Casos de uso | `internal/application/use_cases.go` | `keel.use-case` por caso de uso: span con el nombre del mensaje y `keel_use_case_seconds` con `keel.operation` y `keel.outcome` (`ok`, `rejected`, `error`). Por el puerto `application.Observer`. |
| Entrada HTTP | `internal/platform/telemetry/http.go` | `Instrument`, por fuera del borde y de la seguridad: un span SERVER por petición que continúa la traza de quien llama, y `http_server_requests_seconds` con la plantilla de la ruta. Las sondas cuentan pero no abren traza. |
| Relay del outbox | `internal/infrastructure/messaging/outbox.go` | Publica cada evento dentro de la traza que lo originó (`keel.outbox.publish`). `run` publica el gauge `keel.outbox.dead_lettered`. |
| Envoltura | `messaging.NewEnvelope` | Estampa `metadata.traceparent` con el span en curso. |
| Consumo | `internal/infrastructure/messaging/inbound.go` | `messaging.Consume(ctx, deps.Telemetry, envelope.Metadata, ...)`: la correlación de origen y un span CONSUMER (`keel.message.consume`) que continúa la traza del emisor. |
| Clientes HTTP | `internal/infrastructure/clients/exchange.go` | Span CLIENT por intento, `traceparent` hacia el proveedor y `http_client_requests_seconds`. El transporte no propaga nada por su cuenta. |
| Storage / correo | `storage.Observed`, `smtp.Observed` | El PUERTO se entrega observado (`keel.storage` con la operación y el bucket lógico; `keel.mail.send`), así que se instrumenta cualquier adaptador, lo escriba quien lo escriba. |
| Caché | `OperationCache.OnRead` | `cache_gets_total{cache,result}`, el ratio de acierto del panel. |
| Logs | `internal/platform/logging/logging.go` | `trace.id`/`span.id` en cada línea escrita con el contexto de un span; por OTLP con `LOG_EXPORT_OTLP`. |
| Runtime | `internal/platform/telemetry/runtime.go` | El heap contra su límite, las pausas de GC, las goroutines y el pool de `database/sql`. |

## Instrumentación opcional por subsistema

| Subsistema | Variable | Qué desaparece al apagarlo |
|---|---|---|
| Caché | `TELEMETRY_INSTRUMENT_CACHE` | La cuenta de `cache_gets_total`, y con ella el ratio de acierto del panel. |
| Almacenamiento | `TELEMETRY_INSTRUMENT_STORAGE` | El decorador del puerto `domain.FileStorage`: el adaptador se invoca directamente. |
| Correo | `TELEMETRY_INSTRUMENT_MAIL` | El decorador del puerto `domain.MailSender`: el correo sale igual. |

Se leen al arrancar: cambian con un reinicio, nunca en caliente. Solo se declaran las de los subsistemas que el diseño trae.

## Reglas para quien escribe código

- **El listener trata el mensaje dentro de `messaging.Consume(ctx, deps.Telemetry, envelope.Metadata, func(ctx context.Context) error { ... })`**,
  guarda incluida. Abrir solo la correlación con `messaging.Inbound` compila, pasa todos los escenarios y **corta la traza en
  cada consumo**; con SNS/SQS la envoltura es la única vía. `infra/check-telemetry.sh` lo veta. Una suscripción sin envoltura Keel
  usa `deps.Telemetry.Consuming(ctx, "<Evento>", nil, ...)`: no hay traza que continuar.
- **Escribe los logs con Context** (`logger.InfoContext(ctx, ...)`): sin él, la línea pierde la correlación y la traza. Lo veta
  `infra/check-logging.sh`.
- **No instrumentes un adaptador de un puerto observado** (storage, correo): el arranque ya entrega el puerto decorado. Una
  observación propia duplica el span y la serie.
- **No abras spans a mano ni crees otro proveedor.** Lo que importa ya es una observación: la petición, el caso de uso, la
  publicación, el consumo, la llamada saliente, el bucket y el correo. Un proveedor propio no exporta nada de lo que ya sale, y
  un span que nadie consulta no lo mira nadie.
- **Si añades una métrica, añade dónde se mira** (el panel o una alerta). Una serie que nadie consulta no la mira nadie,
  y una alerta sobre una serie que nadie publica no dispara nunca.
- **Una etiqueta de métrica es un nombre de un conjunto cerrado.** Lo que identifica algo —un id, una clave, un correo— va al
  span (`Attributes` de `telemetry.Options`), no a la métrica: `infra/check-telemetry.sh` lo veta, porque multiplicar las series no
  falla en ninguna prueba y se ve en la factura del backend. Y `keel.correlation_id` nunca es etiqueta.

## Probarlo a mano

`bash deploy/up.sh` levanta el servicio en su contenedor con el colector, el backend de telemetría y el panel ya provisionados;
imprime sus URLs. Las pruebas de `go test ./...` ya miden la telemetría sin red (`internal/platform/telemetry/telemetry_test.go`).
