# Observabilidad: guía de uso y operación

Esta guía es para **personas**: quien levanta el servicio, mira si funciona, investiga por qué algo tardó o falló, y decide a qué backend van las señales. Las reglas para quien escribe código están en otros dos documentos y no se solapan con esta:

- `conventions/observability.md` — qué instrumenta build y qué no se debe tocar.
- `conventions/logging.md` — qué loguea build, qué puede añadir el agente y qué no se loguea nunca.

Todo lo de aquí aplica a un servicio generado **con telemetría activada** (`telemetry: otel` en `keel-stack.json`). Si tu proyecto no la tiene, la primera sección explica cómo activarla.

---

## 1. Activarla (y qué aparece cuando lo haces)

La telemetría es una elección de **stack**, no del diseño: el mismo diseño se genera con ella o sin ella. Por defecto **no** se activa.

```bash
# Proyecto nuevo: el cuestionario de build pregunta por ella…
keel-spring build specs/<servicio>

# …o se elige directamente:
keel-spring build specs/<servicio> --telemetry otel

# Proyecto que ya existe: se activa y se propaga sin pisar el código del agente
keel-spring build specs/<servicio> --telemetry otel --refresh
```

Para quitarla: `--telemetry none --refresh`.

Con `--refresh`, los archivos nuevos aparecen y los que generó build se ponen al día; lo que haya tocado el agente se reporta como conflicto y no se pisa. Si el servicio ya está desplegado, recuerda que activar la telemetría **añade dependencias**: hay que reconstruir la imagen.

Lo que aparece en el proyecto:

| Pieza | Dónde | Qué hace |
|---|---|---|
| Dependencias | `build.gradle` | Puente de Micrometer Tracing a OpenTelemetry, exportadores OTLP y —en el modelo relacional— la instrumentación de JDBC |
| Configuración | `src/main/resources/parameters/<perfil>/telemetry.yaml` | A dónde se exporta, cuánto se muestrea y qué atributos identifican al servicio |
| Logs | `parameters/<perfil>/logging.yaml` | `traceId`/`spanId` en cada línea y JSON (ECS) fuera de `local` |
| Código | `infrastructure/telemetry/` | Lo que la autoconfiguración no hace sola: el appender de logs, el filtro anti-ruido y la traza a través de los mensajes |
| Infraestructura de prueba | `deploy/otel/collector.yaml` + dos contenedores en `deploy/docker-compose.yaml` | El colector y un backend para mirarlo todo en local |
| Referencia de producción | `deploy/otel/collector-agent.example.yaml` y `collector-gateway.example.yaml` | Plantillas para desplegar de verdad; build no las despliega |

---

## 2. El modelo mental: tres señales y un colector en medio

Son tres cosas distintas y cada una responde a una pregunta:

| Señal | Pregunta que responde | Ejemplo |
|---|---|---|
| **Trazas** | ¿Por dónde pasó ESTA petición y dónde se fue el tiempo? | La confirmación tardó 900 ms: 850 fueron una consulta |
| **Métricas** | ¿Cómo se comporta el servicio en conjunto? | El p95 de `confirmReservation` subió esta semana |
| **Logs** | ¿Qué decidió el código en ese instante? | «Mensaje duplicado descartado por StockReservedListener» |

El servicio **no habla con el backend**. Habla con un **colector OpenTelemetry**, y lo único que sabe de él es su dirección:

```
   ┌─────────────────────┐   OTLP/HTTP    ┌───────────────┐   lo que tú decidas
   │   tu servicio       │ ─────────────▶ │   colector    │ ─────────────────▶  Tempo / Jaeger
   │                     │  trazas        │               │                     Prometheus / Mimir
   │  consola (JSON) ────┼──▶ la recoge   │  recibe       │                     Loki / Elastic
   └─────────────────────┘   la plataforma│  procesa      │                     un SaaS…
                                          │  reexporta    │
                                          └───────────────┘
```

Esto es lo que hace que **cambiar de backend no toque el servicio**: se edita la configuración del colector y se reinicia el colector. Ni se recompila, ni se redespliega, ni se reinicia la aplicación.

Los **logs tienen dos caminos** y conviene entenderlo desde el principio:

- **La consola es el canal principal.** En `develop` y `production` cada línea es JSON (formato ECS), que es lo que recoge la plataforma (en Kubernetes, el agente de logs del clúster o el propio colector leyendo el fichero del contenedor).
- **El envío por OTLP es opcional** y va **apagado** (`LOG_EXPORT_OTLP=false`). Si lo enciendes y además alguien recoge la consola, cada línea llega **dos veces** al backend. En `deploy/` va encendido a propósito, porque allí no hay nada que recoja la consola.

---

## 3. Levantarlo y mirarlo: el primer recorrido

```bash
bash deploy/up.sh
```

Levanta el servicio en contenedor con su infraestructura, el colector y un backend completo para mirar las tres señales (Grafana + Tempo + Loki + Prometheus, todo en un contenedor). Al terminar imprime las URLs; las que importan aquí:

| URL | Qué es |
|---|---|
| `http://localhost:3001` | **Grafana**: aquí se miran trazas, logs y métricas |
| `http://localhost:8080` | La API del servicio |
| `http://localhost:8080/actuator/health` | Estado del servicio |
| `http://localhost:4318` | El colector (OTLP/HTTP). No tiene interfaz: es a donde exporta la app |

Si el stack del servicio trae broker, caché, almacenamiento, correo o proveedor de identidad, `up.sh` imprime también sus consolas (Kafka UI, RabbitMQ, RedisInsight, MinIO, Mailpit, Keycloak). Todos los puertos salen de `deploy/.env` (`GRAFANA_PORT`, `APP_PORT`, `OTEL_HTTP_PORT`…): si alguno está ocupado en tu máquina, cámbialo ahí y vuelve a levantar.

### El recorrido, paso a paso

**1. Provoca algo.** Llama a una operación del servicio con una correlación tuya, que es un hilo fácil de seguir:

```bash
curl -X POST http://localhost:8080/<ruta-de-tu-operación> \
  -H 'Content-Type: application/json' \
  -H 'X-Correlation-Id: mi-prueba-1' \
  -d '{ … }'
```

**2. Busca la traza.** Abre `http://localhost:3001` → **Explore** (la brújula del menú lateral) → origen de datos **Tempo** → pestaña **Search**: filtra por `Service Name` = el nombre de tu servicio y pulsa *Run query*. Verás la lista de trazas recientes; la última es la tuya.

Si prefieres escribirlo, la pestaña **TraceQL** acepta:

```
{ resource.service.name = "<nombre-del-servicio>" }
```

y para encontrar exactamente la tuya, por la correlación que enviaste:

```
{ span.keel.correlation_id = "mi-prueba-1" }
```

**3. Léela.** Al abrir una traza se ve la cascada de spans: arriba la petición HTTP y, debajo y anidado, todo lo que provocó. Cada barra es tiempo real. Ahí se ve de un vistazo si el tiempo se fue en la base de datos, en una llamada saliente o en el propio código.

**4. Salta de la traza a los logs.** En el panel de un span, Grafana ofrece ir a los logs de esa traza (botón *Logs for this span*). Si prefieres buscarlos a mano: Explore → origen **Loki** →

```
{service_name="<nombre-del-servicio>"} | json | trace_id="<el trace id>"
```

Y al revés, de un log a su traza: cada registro lleva `trace_id`, así que desde el log puedes abrir la traza completa.

**5. Mira las métricas.** Explore → origen **Prometheus** (o Mimir). Escribe `keel_` y el autocompletado enseña las métricas propias del servicio. Por ejemplo, el percentil 95 por operación:

```
histogram_quantile(0.95, sum by (le, keel_operation) (rate(keel_use_case_milliseconds_bucket[5m])))
```

> Los nombres en Prometheus llevan `_` donde OpenTelemetry usa `.`: `keel.use-case` se consulta como `keel_use_case_milliseconds…`.

Cuando termines: `bash deploy/down.sh` (con `-v` borra también los datos).

---

## 4. Qué vas a ver exactamente

**Spans** de una petición que acaba publicando un evento y consumiéndolo:

| Span | De dónde sale |
|---|---|
| `http post /api/v1/…` | La petición entrante (es la raíz de la traza) |
| `<operación>-command` / `<operación>-query` | El caso de uso; lleva `keel.operation` y el `keel.correlation_id` |
| `connection`, `query`, `result-set` | Cada acceso a la base de datos relacional |
| `<colección>.find`, `<colección>.findAndModify` | Lo mismo en el modelo documental (MongoDB) |
| `keel.outbox.publish <Evento>` | La publicación del evento desde el outbox, **dentro de la traza que lo originó** aunque ocurra mucho después |
| `<destino> send` | El envío al broker |
| `keel.message.consume <Evento>` | El consumo de un mensaje, reenganchado a la traza del emisor |
| `<cliente> …` | Cada llamada HTTP saliente |

**Métricas** propias (además de las de Spring Boot y la JVM):

| Métrica | Para qué sirve |
|---|---|
| `keel.use-case` | Duración y número de ejecuciones por operación (con histograma: admite p95/p99) |
| `keel.message.consume` | Lo mismo para los mensajes consumidos |
| `keel.outbox.publish` | Lo mismo para los eventos publicados por el outbox |
| `keel.outbox.dead_lettered` | **Eventos que agotaron sus reintentos y no salieron.** Debería ser siempre 0 |
| `http.server.requests` | Latencia y códigos de respuesta por endpoint |

**Una línea de log** en `develop`/`production` (JSON ECS, recortada):

```json
{"@timestamp":"2026-09-19T20:23:35.60Z","log":{"level":"DEBUG","logger":"…UseCaseMediator"},
 "message":"Caso de uso ConfirmReservationCommand: ok",
 "trace.id":"f6aef85d84e48f9f0d8f3e70ecb3d409","span.id":"00cc3b8d80deecc3",
 "correlationId":"mi-prueba-1",
 "keel":{"operation":"ConfirmReservationCommand","outcome":"ok","duration_ms":31}}
```

Los tres identificadores son los que permiten cruzar señales: `trace.id` lleva a la traza, `correlationId` es el que recibió el cliente (viaja en la cabecera `X-Correlation-Id` de la respuesta) y `keel.operation` es el nombre de la operación del diseño.

En `local` el log es texto plano para leerlo en la terminal, con los mismos identificadores entre corchetes.

---

## 5. La traza a través de los eventos

Un evento rompe la traza dos veces si nadie hace nada: con `reliability: outbox` se publica **en otro hilo y más tarde**, y el consumidor es **otro proceso**.

Se conserva así:

1. **Al publicar**, la envoltura del evento lleva el contexto de traza W3C en `metadata.traceparent`. Es parte del contrato del evento, con telemetría o sin ella (sin ella viaja a `null`).
2. **El relay del outbox** lee ese contexto de la fila y publica dentro de la traza original, aunque hayan pasado horas.
3. **Al consumir**, el listener reabre el contexto. Con Kafka y RabbitMQ además viaja la cabecera nativa del broker; **con SNS/SQS no existe esa cabecera** y el `traceparent` del sobre es la única vía.

Para el punto 3 hace falta una línea en el listener, que es código del agente:

```java
CorrelationContext.runWith(envelope.metadata(), () -> { … });   // ✅ continúa la traza
CorrelationContext.runWith(envelope.metadata().correlationId(), () -> { … });  // ❌ la corta
```

Las dos compilan y las dos abren la correlación; solo la primera continúa la traza. Lo verifica `bash infra/check-idempotency.sh` (familia `inboundContext`).

**Cómo se ve que está bien:** una petición que publica un evento y lo consume produce **una sola traza**, con el span del consumo colgando del de la publicación. Si ves dos trazas separadas, el eslabón roto es ese.

---

## 6. Perfiles y variables

| Perfil | Cuándo se usa | Exporta | Muestreo | Endpoint |
|---|---|---|---|---|
| `local` | Desarrollo y suite de escenarios | **No** por defecto | 100 % | `http://localhost:4318` |
| `develop` | El contenedor de `deploy/` y entornos de prueba | Sí | 100 % | `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `production` | Producción | Sí | 10 % de las raíces | `OTEL_EXPORTER_OTLP_ENDPOINT` **obligatoria** |
| `test` | Pruebas unitarias | No, y sin trazas | — | — |

`local` no exporta porque es el perfil con el que corre la suite de escenarios y ahí no hay colector: un exportador sin destino no rompe nada, pero llena la salida de avisos. Para mirar telemetría en local, levanta `deploy/` y arranca con `TELEMETRY_EXPORT_ENABLED=true`.

| Variable | Qué hace | Cuándo tocarla |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Dirección del colector | Siempre en producción; en `deploy/` ya viene puesta |
| `TELEMETRY_EXPORT_ENABLED` | Enciende o apaga la exportación de trazas y métricas | Para mirar telemetría en `local`, o para silenciar un entorno |
| `LOG_EXPORT_OTLP` | Manda **además** los logs por OTLP | Solo donde nada recoge la consola |
| `TRACING_SAMPLING_PROBABILITY` | Fracción de trazas que se conservan (1.0 = todas) | Subirlo para investigar; ponerlo a 1.0 si el colector hace muestreo por cola |
| `METRICS_EXPORT_STEP` | Cada cuánto se envían las métricas | Bajarlo para ver antes en una prueba |
| `LOG_FORMAT` | Formato de la consola fuera de `local` (`ecs` por defecto) | Si tu plataforma espera otro formato |
| `DEPLOYMENT_ENVIRONMENT` | Etiqueta el entorno en todas las señales | Para distinguir varios entornos en el mismo backend |

El **muestreo** es *parent-based*: si quien llama ya decidió que su traza se conserva, este servicio la respeta. Solo decide cuando la traza nace aquí.

---

## 7. El colector: cambiar o añadir un backend

El archivo de las pruebas manuales es `deploy/otel/collector.yaml` y tiene cuatro bloques:

```yaml
receivers:    # por dónde entran los datos (aquí, OTLP)
processors:   # qué se les hace antes de salir
exporters:    # a dónde van
service:
  pipelines:  # cómo se encadenan, una por señal (traces, metrics, logs)
```

Los procesadores **van en orden y el orden importa**:

| Procesador | Qué hace | Por qué ahí |
|---|---|---|
| `memory_limiter` | Rechaza si se queda sin memoria | **El primero**: si el backend se atasca, el colector rechaza en vez de morirse, y el servicio reintenta |
| `resourcedetection` | Completa de dónde viene el dato | Antes de exportar, sin pisar lo que ya trae la app |
| `attributes/redact` | Borra cabeceras de credenciales | Antes de salir: es la última red antes del backend |
| `batch` | Agrupa y comprime | **El último**: exportar dato a dato satura cualquier backend |

### Cambiar de backend

Tres pasos, siempre los mismos:

1. **Declara el exportador nuevo** en `exporters`.
2. **Ponlo en los pipelines** que quieras que vayan a él.
3. **Reinicia solo el colector.**

Ejemplos listos para copiar:

```yaml
# Trazas a un Tempo o Jaeger que ya tienes
exporters:
  otlp/tempo:
    endpoint: tempo.observabilidad.svc:4317
    tls:
      insecure: true            # quítalo si el destino tiene TLS

# Métricas a un Prometheus con remote-write
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write

# Cualquier proveedor SaaS que hable OTLP (la credencial, del ENTORNO del colector)
  otlphttp/proveedor:
    endpoint: https://otlp.ejemplo.com
    headers:
      api-key: ${env:MI_API_KEY}
```

y en los pipelines:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, attributes/redact, batch]
      exporters: [otlp/tempo]            # ← antes decía otro
```

### Añadir un backend sin quitar el que hay

Un pipeline admite **varios exportadores**: el colector manda una copia a cada uno. Es la forma de migrar sin apagar nada.

```yaml
    traces:
      exporters: [otlphttp/backend, otlp/tempo]
```

### Comprobar y aplicar

Antes de reiniciar nada, valida el archivo (no arranca nada, solo lo lee):

```bash
podman run --rm -v "$PWD/deploy/otel:/cfg:ro" \
  otel/opentelemetry-collector-contrib:<versión> validate --config=/cfg/collector.yaml
```

Si hay un error —un exportador citado en un pipeline que no existe, una clave mal escrita— lo dice con el camino exacto. Después:

```bash
podman restart <proyecto>_otel-collector_1     # o el nombre que muestre `podman ps`
```

La aplicación no se toca. Si la editas mientras hay tráfico, lo que estuviera en la cola del colector se pierde; con `retry_on_failure` y `sending_queue` puestos (ya vienen), lo que ya había entrado se reintenta.

**Las credenciales del backend van en el entorno del colector** (`${env:…}`), nunca dentro del archivo ni en la aplicación. La aplicación no tiene credenciales de observabilidad: esa es otra ventaja de tener un colector en medio.

---

## 8. Producción

`deploy/` es para probar a mano. En un clúster, el patrón recomendado son **dos colectores**, y vienen como plantillas comentadas:

| Archivo | Dónde va | Qué hace |
|---|---|---|
| `deploy/otel/collector-agent.example.yaml` | Uno por nodo (DaemonSet) | Recoge la **consola** de los contenedores (`filelog`), recibe trazas y métricas de los pods del nodo, añade los metadatos de Kubernetes y reparte las trazas por `traceID` |
| `deploy/otel/collector-gateway.example.yaml` | Un despliegue central | Decide **qué trazas se guardan** (`tail_sampling`) y es el único que conoce el backend |

Son dos y no uno por dos razones que no se pueden cumplir a la vez en el mismo sitio: recoger la consola exige estar **en cada nodo**, y decidir con la traza entera delante exige que **todos sus spans lleguen al mismo colector**.

El **muestreo por cola** del gateway se queda con todas las trazas que tienen un error, todas las lentas y una parte del resto. Es mucho mejor que muestrear a ciegas en el servicio: las trazas que te interesan son justo las raras. Si lo usas, pon `TRACING_SAMPLING_PROBABILITY=1.0` en la aplicación, o estarás muestreando dos veces.

---

## 9. Operación del día a día

### «No llega nada»

En orden, que es de lo más común a lo más raro:

1. **¿Está encendida la exportación?** `TELEMETRY_EXPORT_ENABLED` en el entorno de la app. En `local` está apagada a propósito.
2. **¿Apunta a donde crees?** `OTEL_EXPORTER_OTLP_ENDPOINT` tiene que ser alcanzable **desde dentro del contenedor de la app** — `localhost` ahí es la propia app, no tu máquina.
3. **¿Llega al colector?** Mira sus logs: `podman logs <colector>`. Si el servicio no alcanza el colector, la app escribe avisos de exportación fallida cada pocos segundos.
4. **¿Sale del colector?** Añade temporalmente el exportador `debug` al pipeline y reinícialo: imprime lo que recibe. Si ahí hay datos, el problema está entre el colector y el backend.
5. **¿Es el muestreo?** En `production` solo se conserva una de cada diez trazas por defecto. Sube `TRACING_SAMPLING_PROBABILITY` para una prueba.
6. **¿Es el ruido lo que esperabas ver?** Las peticiones al *actuator* y los ciclos de las tareas programadas se descartan a propósito (ver más abajo).
7. **¿Y los logs?** Si esperas verlos en el backend pero no los recoge nadie, te falta `LOG_EXPORT_OTLP=true` o un recolector de la consola.

### «La traza está partida»

- Si el corte está entre **publicar y consumir**, casi siempre es el listener: tiene que usar `runWith(envelope.metadata(), …)` (§ 5).
- Si el corte está entre **dos servicios por HTTP**, quien llama tiene que propagar la cabecera `traceparent`. Los clientes que genera build lo hacen; un cliente escrito a mano puede no hacerlo.
- Si aparecen **spans sueltos sin padre**, suele ser trabajo lanzado a otro hilo sin propagar el contexto. Para eso está `ContextPropagatingExecutors` (`application/support`).

### Ruido, y por qué no lo hay

El relay del outbox consulta la base de datos **cada segundo**. Sin filtro, eso serían miles de trazas vacías al día que además se comerían tu cuota de muestreo. Build descarta las peticiones al *actuator*, los ciclos de las tareas programadas y las consultas que no cuelgan de nada.

> Medido en una corrida real: media hora de servicio en marcha, con unas 1.800 pasadas del relay, produjo **16 trazas**, todas con contenido.

Lo que sí se ve: cada evento publicado (`keel.outbox.publish`) y cada barrido que hace trabajo, porque pasan por un caso de uso.

### Coste y cardinalidad

Lo que hace cara —y lenta— una plataforma de observabilidad es casi siempre la **cardinalidad**: una etiqueta con muchos valores distintos multiplica las series. Por eso las métricas que genera build solo llevan etiquetas de baja cardinalidad (nombre de operación, de evento, código de respuesta), y los identificadores (ids, correlación) van como **atributos del span**, no como etiquetas de métrica. Si añades métricas propias, respeta esa frontera.

Palancas para ajustar volumen, de menos a más invasivas: `METRICS_EXPORT_STEP`, el muestreo por cola en el gateway, `TRACING_SAMPLING_PROBABILITY` y, para los logs, el nivel (`LOG_LEVEL_ROOT`, `LOG_LEVEL_APP`).

### Tres alertas que valen la pena

| Alerta | Por qué |
|---|---|
| `keel.outbox.dead_lettered > 0` | Hay eventos que agotaron sus reintentos y **no salieron**. Es pérdida de datos en el mecanismo cuya única promesa es que no se pierde nada |
| Tasa de `keel.use-case` con resultado `error` | Fallos del servicio, ya agregados por operación |
| p95 de `keel.use-case` por operación | Degradación antes de que alguien se queje |

### Qué no sale en la telemetría, nunca

Ni datos personales, ni secretos, ni cuerpos de peticiones o mensajes. Se identifica por id. El colector borra además las cabeceras de credenciales por si acaso, pero eso es la última red, no la primera: lo que no se emite no se puede filtrar.

---

## 10. Límites conocidos

- **Solo se instrumenta lo que pasa por Micrometer** (peticiones HTTP, casos de uso, base de datos, clientes HTTP, mensajería, caché). No se usa el agente Java de OpenTelemetry, así que una librería de terceros que hagas servir por tu cuenta no aparece sola.
- **SNS/SQS no propaga cabeceras de traza** (su cliente no lo soporta todavía): ahí la traza viaja solo en el sobre del evento, y por eso la línea del listener es obligatoria.
- **Los logs del arranque no salen por OTLP**: el appender se instala cuando el contexto de Spring ya existe. Sí están en la consola.
- **El muestreo por cola necesita** que todos los spans de una traza lleguen al mismo colector; por eso el agente de nodo los reparte por `traceID`.
- **`local` no exporta por defecto**, para no ensuciar la suite de escenarios.

---

## 11. Dónde seguir

- `conventions/logging.md` — qué loguea build en cada frontera, qué puede añadir el agente y qué está prohibido.
- `conventions/observability.md` — las reglas que el código tiene que respetar para no romper nada de esto.
- `deploy/otel/collector.yaml` — el archivo que decides tú, comentado por dentro.
