# Observabilidad (telemetría OpenTelemetry vía colector)

> **¿Buscas cómo usarla?** Esta convention son las reglas que el CÓDIGO tiene que respetar. Para levantar la telemetría, mirar las trazas en Grafana, cambiar de backend u operarla, la guía es `docs/keel/observabilidad.md`.

Este documento solo existe si el proyecto se generó con telemetría (`telemetry: otel` en `keel-stack.json`, elegido en el cuestionario de `keel-spring build` o con `--telemetry otel`). Sin ella, el servidor no emite telemetría y nada de esto aplica.

## El patrón: un colector en medio

El servicio emite **trazas, métricas y logs por OTLP/HTTP a un colector OpenTelemetry**, y lo único que sabe de él es su dirección: la variable `OTEL_EXPORTER_OTLP_ENDPOINT`. A qué backend va cada señal (Tempo, Jaeger, Loki, Prometheus, un proveedor SaaS) lo decide **la configuración del colector**, no el servicio.

Consecuencia práctica, y es la razón de todo el diseño: **cambiar de backend no toca el código ni la configuración de la aplicación**. Se edita el bloque `exporters` del colector (en pruebas manuales, `deploy/otel/collector.yaml`) y se reinicia el colector.

## Qué lo genera build (y no se toca a mano)

| Pieza | Dónde | Qué hace |
|---|---|---|
| Dependencias | `build.gradle` | Puente de Micrometer Tracing a OpenTelemetry, exportadores OTLP de trazas y métricas, appender OTLP de logback y, en el modelo relacional, `datasource-micrometer` (spans de JDBC). |
| Configuración | `parameters/<perfil>/telemetry.yaml` | Endpoint del colector, muestreo, atributos de recurso y la observación del broker (Kafka/RabbitMQ). |
| `TelemetryConfig` | `infrastructure/telemetry` | Instala el appender OTLP de logs, descarta el ruido (probes del actuator, ticks de las tareas programadas, consultas sin padre) y, en el modelo documental, instrumenta Mongo. |
| `MessageTracing` | `infrastructure/telemetry` | Lleva el contexto de traza W3C a través de los mensajes (`metadata.traceparent`). |
| `UseCaseMediator` | `configurations/usecase` | Una observación `keel.use-case` por caso de uso despachado: span con el nombre de la operación y su timer. |
| Relay del outbox | `messaging/outbox` | Publica cada evento dentro de la traza que lo originó (`keel.outbox.publish`), aunque ocurra en otro hilo y mucho después. |
| Clientes HTTP | `infrastructure/http` | Span por llamada saliente y cabecera `traceparent` hacia el proveedor. |
| Logs | `parameters/<perfil>/logging.yaml` | `traceId`/`spanId` en cada línea de texto; JSON (ECS) en consola fuera de `local`, con los ids renombrados a `trace.id`/`span.id`. |
| Paralelo | `application/support/ContextPropagatingExecutors` | Las tareas lanzadas a otro hilo conservan el MDC y la traza. |
| Colector de producción | `deploy/otel/collector-agent.example.yaml` + `collector-gateway.example.yaml` | Referencia: agente por nodo (logs de stdout, metadatos de Kubernetes) y gateway (muestreo por cola, único que conoce el backend). |

## Perfiles

| Perfil | Exportación | Muestreo | Endpoint |
|---|---|---|---|
| `local` | **apagada** por defecto (`TELEMETRY_EXPORT_ENABLED=true` para encenderla) | 100 % | `http://localhost:4318` por defecto |
| `develop` | encendida | 100 % | `OTEL_EXPORTER_OTLP_ENDPOINT`, `http://localhost:4318` por defecto |
| `production` | encendida | 10 % de las raíces (`TRACING_SAMPLING_PROBABILITY`) | `OTEL_EXPORTER_OTLP_ENDPOINT` **obligatoria** |
| `test` | apagada, sin trazas | — | — |

`local` es el perfil de la suite de escenarios, que no tiene colector: por eso la exportación va apagada ahí, y el `traceId` sigue apareciendo en los logs. El muestreo es *parent-based*: el servicio respeta la decisión de quien lo llama y solo decide en las raíces. Quedarse con todos los errores y con las trazas lentas (muestreo por cola) es trabajo del colector, que ve la traza entera.

## Los logs y sus identificadores de traza

- **Canal primario: la consola.** En `local` en texto; en `develop` y `production` en JSON (ECS), que la plataforma recoge sin expresiones regulares (en Kubernetes, el agente de nodo con `filelog`: ver `collector-agent.example.yaml`).
- **OTLP de logs: opcional**, con su propio interruptor (`LOG_EXPORT_OTLP`, apagado). Encenderlo además de recoger la consola duplica cada línea en el backend. `deploy/` lo trae encendido porque allí nada recoge stdout.
- **Identificadores de traza en cada línea**, los pone Micrometer Tracing en el MDC:
  - en texto, `[traceId,spanId]` dentro del patrón;
  - en JSON, `trace.id`/`span.id`, los nombres ECS con los que un backend enlaza el log con su traza (Boot vuelca el MDC tal cual, como `traceId`/`spanId`, y `logging.structured.json.rename` los renombra);
  - por OTLP, como contexto nativo del registro.
- Una línea **fuera** de una traza no lleva ids. Pasa con el arranque o con un tick programado sin trabajo, y es correcto.
- Qué se loguea y dónde: `conventions/logging.md`.

## Muestreo en producción

La app muestrea el 10 % de las raíces por defecto (`TRACING_SAMPLING_PROBABILITY`), que es seguro sin nada detrás. Lo recomendado es poner el **gateway** de `collector-gateway.example.yaml`, que muestrea **por cola**: se queda con todas las trazas con error, con todas las lentas y con una parte del resto. Con él, sube el muestreo de la app a `1.0`; si no, se muestrea dos veces.

## La traza a través de los eventos

El contexto de traza viaja en `metadata.traceparent` de la envoltura keel, que es parte del contrato público del evento (nulo si el emisor no tiene telemetría):

- **Al publicar** lo estampa `EventEnvelope.of(...)` desde el span activo. Vale para el bridge en modo outbox y para el `<Evento>Publisher` en best-effort: ninguno tiene que hacer nada.
- **Con outbox**, el relay lee el `traceparent` de la fila y publica dentro de esa traza. Con Kafka y RabbitMQ el template propaga además la cabecera W3C nativa.
- **Al consumir**, el listener **tiene que** abrir el contexto con la sobrecarga de la metadata:

  ```java
  CorrelationContext.runWith(envelope.metadata(), () -> { ... });
  ```

  y no con `runWith(envelope.metadata().correlationId(), ...)`. Las dos abren la correlación, pero solo la primera continúa la traza. Con SNS/SQS es la **única** vía: Spring Cloud AWS no propaga cabeceras de traza. El gate `infra/check-idempotency.sh` (familia `inboundContext`) lo verifica.

## Reglas para quien escribe código

- **No abras spans a mano.** Lo que importa ya es una observación: la petición HTTP, el caso de uso, el SQL, las llamadas salientes, la publicación y el consumo. Un span manual suele duplicar uno existente o quedar huérfano.
- **Ni datos personales ni secretos en atributos ni en logs.** Un log con un email, un token o un número de documento viaja al backend de logs y se queda allí. Identifica por id, nunca por el dato. El colector borra por si acaso las cabeceras de credenciales, pero es la última línea, no la primera.
- **Cardinalidad baja en las etiquetas de métricas.** Nombres de operación o de evento, sí; ids, emails o importes, nunca: cada valor distinto es una serie nueva.
- **Loguea con SLF4J y parámetros** (`log.info("... {}", id)`), sin concatenar: el appender OTLP conserva los argumentos y el contexto de traza se añade solo.
- **Un hilo nuevo pierde el contexto.** Para trabajo en paralelo usa siempre `ContextPropagatingExecutors.newVirtualThreadPerTaskExecutor()` (lo genera build): copia el MDC y la observación activa al hilo de la tarea. `Executors.newVirtualThreadPerTaskExecutor()` a secas lo veta `infra/check-logging.sh`.

## Cambiar de backend

1. Edita `exporters` en la configuración del colector y referencia el nuevo exportador en los `pipelines` (`traces`, `metrics`, `logs`). El propio `deploy/otel/collector.yaml` trae ejemplos comentados.
2. Las credenciales del backend van en el **entorno del colector** (`${env:VAR}`), nunca en el archivo ni en la aplicación.
3. Reinicia solo el colector. La aplicación no se toca.

Para comprobar el archivo sin arrancar nada: `otelcol-contrib validate --config=<archivo>` (en contenedor: `podman run --rm -v <ruta>:/c.yaml:ro otel/opentelemetry-collector-contrib:<versión> validate --config=/c.yaml`).
