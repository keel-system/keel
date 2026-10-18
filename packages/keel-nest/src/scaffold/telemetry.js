// La telemetría del servicio generado (`telemetry: otel`, incremento 14c de PLAN-KEEL-NEST.md).
//
// El patrón es el de keel-spring: el servidor solo conoce el endpoint de UN colector
// (`OTEL_EXPORTER_OTLP_ENDPOINT`) y le manda trazas (y, con `LOG_EXPORT_OTLP`, logs) por OTLP/HTTP; las métricas
// no salen, las viene a buscar el colector a `/actuator/prometheus`, que es lo que conserva los EXEMPLARS. Cambiar
// de backend es cambiar el colector, nunca el código.
//
// La regla de equivalencia manda en los NOMBRES: las observaciones, los atributos, los desenlaces y las series
// salen de `keel-core/gen/telemetry-vocabulary.js`, el mismo vocabulario con el que keel-spring publica, así que el
// mismo panel y las mismas alertas tienen datos con los dos servidores. Lo que no se comparte es el runtime (Node
// frente a la JVM).
//
// Los spans no salen de una auto-instrumentación por loader —en ESM exige `--experimental-loader` y parchea
// módulos ajenos—: los abre el código generado donde keel-nest ya es dueño del punto de paso (el hook de entrada
// de Fastify, el mediator, el relay del outbox, el consumo, los clientes salientes, los puertos de storage y
// correo). Los spans de los drivers (SQL, Mongo, Redis) son otro tramo: `telemetry-store-spans` de la matriz.

import { collectorHostEndpoint, TELEMETRY_INFRA } from 'keel-core/gen/infra-catalog';
import {
  ATTRIBUTES,
  INSTRUMENTATION,
  METRICS_TRANSPORT,
  OBSERVATIONS,
  instrumentationFor,
  promTag,
  usesTelemetry
} from 'keel-core/gen/telemetry-vocabulary';
import { tsModule } from './render.js';
import { runtimeDefault } from 'keel-core/gen/runtime-env';
import { telemetryYaml as neutralTelemetryYaml } from 'keel-core/gen/telemetry-config';

export { usesTelemetry, instrumentationFor };

export const TELEMETRY_TS = 'src/infrastructure/telemetry/telemetry.ts';

/**
 * Las series del RUNTIME de Node, que consulta la fila de runtime del panel y su alerta de heap. Las de
 * `nodejs_*` las publica el cliente de Prometheus (`collectDefaultMetrics`); las de `keel_*` las publica la
 * telemetría generada, porque no hay ninguna estándar:
 *
 *   · el LÍMITE del heap (`v8.getHeapStatistics().heap_size_limit`): la alerta compara lo usado con él y no con
 *     `nodejs_heap_size_total_bytes`, que V8 hace crecer a demanda y que lo usado roza siempre —con él, la alerta del
 *     90 % dispararía en un servicio sano—;
 *   · el pool de conexiones del driver relacional (pg o mysql2), que no publica nada por sí mismo.
 */
export const NODE_RUNTIME = {
  heapUsed: 'nodejs_heap_size_used_bytes',
  heapLimit: 'keel_runtime_heap_limit_bytes',
  gcSeconds: 'nodejs_gc_duration_seconds_sum',
  eventLoopLagP99: 'nodejs_eventloop_lag_p99_seconds',
  pool: {
    active: 'keel_db_pool_active',
    idle: 'keel_db_pool_idle',
    max: 'keel_db_pool_max',
    saturation: 'keel_db_pool_pending'
  }
};
export const TELEMETRY_LIFECYCLE_TS = 'src/infrastructure/telemetry/telemetry-lifecycle.ts';

/** Puerto de gestión por defecto en production (con telemetría; catálogo neutral). */
export const MANAGEMENT_PORT = runtimeDefault('MANAGEMENT_PORT');

const PROFILES = ['local', 'develop', 'production', 'test'];

/**
 * Los cubos de los histogramas de duración, en segundos: de 1 ms a 30 s, el rango del histograma de percentiles
 * de Micrometer. Los cubos no tienen que coincidir con los de keel-spring: `histogram_quantile` interpola dentro
 * de cada uno.
 */
export const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Las versiones de las dependencias de la telemetría (al menos dos semanas publicadas al elegirlas). */
export const TELEMETRY_DEPENDENCIES = {
  '@opentelemetry/api': '^1.9.1',
  '@opentelemetry/context-async-hooks': '~2.11.0',
  '@opentelemetry/core': '~2.11.0',
  '@opentelemetry/propagator-b3': '~2.11.0',
  '@opentelemetry/resources': '~2.11.0',
  '@opentelemetry/sdk-trace-node': '~2.11.0',
  '@opentelemetry/exporter-trace-otlp-http': '~0.222.0',
  '@opentelemetry/api-logs': '~0.222.0',
  '@opentelemetry/sdk-logs': '~0.222.0',
  '@opentelemetry/exporter-logs-otlp-http': '~0.222.0',
  // El sucesor oficial de prom-client (deprecado), del mismo repositorio prometheus/client_js.
  '@prometheus-io/client': '~0.16.1'
};

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [
    { path: TELEMETRY_TS, content: telemetryTs(model) },
    { path: TELEMETRY_LIFECYCLE_TS, content: lifecycleTs() },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/telemetry.yaml`, content: telemetryYaml(model, profile) }))
  ];
}

/** El fragmento de cada perfil: el NEUTRAL de keel-core (keel-core/gen/telemetry-config.js), el mismo que keel-dotnet. */
export function telemetryYaml(model, profile) {
  return neutralTelemetryYaml(model, profile, { generator: 'keel-nest' });
}

function lifecycleTs() {
  return tsModule(TELEMETRY_LIFECYCLE_TS, [
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'OnApplicationShutdown', from: '@nestjs/common', type: true },
    { symbol: 'Telemetry', from: TELEMETRY_TS }
  ], `/**
 * Al apagar, la telemetría vacía lo que tiene en cola (las últimas trazas de la última petición) y cierra el
 * puerto de gestión. Va DESPUÉS del drenaje de peticiones: Nest llama a este hook al final del apagado.
 */
@Injectable()
export class TelemetryLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await Telemetry.current()?.shutdown();
  }
}`);
}

function telemetryTs(model) {
  const labels = (keys) => JSON.stringify(keys);
  const instrumentation = instrumentationFor(model)
    .map((entry) => `  ${entry.id}: ${JSON.stringify(entry.property)}`)
    .join(',\n');
  return tsModule(TELEMETRY_TS, [
    { symbol: 'context', from: '@opentelemetry/api' },
    { symbol: 'propagation', from: '@opentelemetry/api' },
    { symbol: 'ROOT_CONTEXT', from: '@opentelemetry/api' },
    { symbol: 'SpanKind', from: '@opentelemetry/api' },
    { symbol: 'SpanStatusCode', from: '@opentelemetry/api' },
    { symbol: 'trace', from: '@opentelemetry/api' },
    { symbol: 'TraceFlags', from: '@opentelemetry/api' },
    { symbol: 'Context', from: '@opentelemetry/api', type: true },
    { symbol: 'Span', from: '@opentelemetry/api', type: true },
    { symbol: 'TextMapGetter', from: '@opentelemetry/api', type: true },
    { symbol: 'TextMapPropagator', from: '@opentelemetry/api', type: true },
    { symbol: 'TextMapSetter', from: '@opentelemetry/api', type: true },
    { symbol: 'SeverityNumber', from: '@opentelemetry/api-logs' },
    { symbol: 'AsyncLocalStorageContextManager', from: '@opentelemetry/context-async-hooks' },
    { symbol: 'W3CTraceContextPropagator', from: '@opentelemetry/core' },
    { symbol: 'OTLPLogExporter', from: '@opentelemetry/exporter-logs-otlp-http' },
    { symbol: 'OTLPTraceExporter', from: '@opentelemetry/exporter-trace-otlp-http' },
    { symbol: 'B3Propagator', from: '@opentelemetry/propagator-b3' },
    { symbol: 'resourceFromAttributes', from: '@opentelemetry/resources' },
    { symbol: 'BatchLogRecordProcessor', from: '@opentelemetry/sdk-logs' },
    { symbol: 'LoggerProvider', from: '@opentelemetry/sdk-logs' },
    { symbol: 'BatchSpanProcessor', from: '@opentelemetry/sdk-trace-node' },
    { symbol: 'NodeTracerProvider', from: '@opentelemetry/sdk-trace-node' },
    { symbol: 'ParentBasedSampler', from: '@opentelemetry/sdk-trace-node' },
    { symbol: 'TraceIdRatioBasedSampler', from: '@opentelemetry/sdk-trace-node' },
    { symbol: 'SpanProcessor', from: '@opentelemetry/sdk-trace-node', type: true },
    { symbol: 'Counter', from: '@prometheus-io/client' },
    { symbol: 'Gauge', from: '@prometheus-io/client' },
    { symbol: 'Histogram', from: '@prometheus-io/client' },
    { symbol: 'Registry', from: '@prometheus-io/client' },
    { symbol: 'collectDefaultMetrics', from: '@prometheus-io/client' },
    { symbol: 'FastifyInstance', from: 'fastify', type: true },
    { symbol: 'FastifyReply', from: 'fastify', type: true },
    { symbol: 'FastifyRequest', from: 'fastify', type: true },
    { symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true },
    { symbol: 'getHeapStatistics', from: 'node:v8' }
  ], `/** Las observaciones propias: el vocabulario neutral (keel-core/gen/telemetry-vocabulary.js), el de keel-spring. */
export const OBSERVATIONS = ${JSON.stringify(OBSERVATIONS, null, 2)} as const;

/** Los atributos que estampa el código generado; \`correlationId\` va solo al span, nunca a una etiqueta de métrica. */
export const ATTRIBUTES = ${JSON.stringify(ATTRIBUTES, null, 2)} as const;

/** Las claves de configuración de los interruptores de este diseño (\`TELEMETRY_INSTRUMENT_*\`). */
const INSTRUMENTATION_KEYS: Record<string, string> = {
${instrumentation}
};

/** La ruta del scrape: la misma que en keel-spring, para que el colector no dependa de quién la sirve. */
export const SCRAPE_PATH = '${METRICS_TRANSPORT.scrapePath}';

/** Rutas técnicas: no abren traza (las sondas se piden cada pocos segundos), pero sí cuentan en la métrica HTTP. */
const TECHNICAL_PATHS = new Set(['/livez', '/readyz', SCRAPE_PATH]);

const DURATION_BUCKETS = ${JSON.stringify(DURATION_BUCKETS)};

/** Las etiquetas de la métrica HTTP de entrada: las de \`http.server.requests\` de keel-spring. */
const HTTP_SERVER_LABELS = ${labels(['method', 'uri', 'status', 'outcome', 'exception'])};

/** Las de la métrica HTTP de salida: las de \`http.client.requests\` de keel-spring. */
const HTTP_CLIENT_LABELS = ${labels(['method', 'uri', 'status', 'client_name', 'outcome'])};

export type Outcome = 'ok' | 'rejected' | 'error';

export interface ObserveOptions {
  /** El nombre del span (la operación concreta); la métrica lleva el de la observación. */
  readonly name?: string;
  readonly kind?: SpanKind;
  /** Atributos de BAJA cardinalidad: van al span y, manglados, a la métrica. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Atributos de ALTA cardinalidad: solo al span. */
  readonly spanAttributes?: Readonly<Record<string, string | null | undefined>>;
  /** El contexto padre (un traceparent recibido); por defecto, el activo. */
  readonly parent?: Context;
  /** Un error que es un desenlace esperado (un rechazo del dominio): \`rejected\`, sin marcar el span como error. */
  readonly isRejection?: (error: unknown) => boolean;
}

/** Lo que el logger añade a cada línea cuando hay una traza en curso. */
export interface TraceIds {
  readonly traceId: string;
  readonly spanId: string;
}

interface Settings {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly instanceId: string | null;
  readonly samplingProbability: number;
  readonly exportEnabled: boolean;
  readonly endpoint: string;
  readonly logsExportEnabled: boolean;
  readonly prometheusEnabled: boolean;
  readonly managementPort: number | null;
}

/**
 * Produce W3C y acepta además B3 (una y varias cabeceras) de quien llame: una malla de servicio o un sistema de la
 * familia Zipkin no corta la traza al llegar aquí. Emitir B3 no aporta nada a quien ya entiende W3C.
 */
class W3cOutB3InPropagator implements TextMapPropagator {
  private readonly w3c = new W3CTraceContextPropagator();
  private readonly b3 = new B3Propagator();

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    this.w3c.inject(ctx, carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const fromW3c = this.w3c.extract(ctx, carrier, getter);
    return trace.getSpanContext(fromW3c) ? fromW3c : this.b3.extract(ctx, carrier, getter);
  }

  fields(): string[] {
    return this.w3c.fields();
  }
}

/**
 * La telemetría del proceso: el proveedor de trazas, el registro de métricas (OpenMetrics, para los exemplars) y
 * las piezas que usa el código generado para observar. Una por proceso; la arranca main.ts ANTES de crear la
 * aplicación, y sin arrancar (el perfil test de las pruebas emitidas) todo lo que la consulta sigue sin ella.
 */
export class Telemetry {
  private static instance: Telemetry | null = null;

  readonly registry = new Registry(Registry.OPENMETRICS_CONTENT_TYPE);
  private readonly tracer = trace.getTracer('keel');
  private readonly histograms = new Map<string, Histogram<string>>();
  private readonly httpRequests = new WeakMap<FastifyRequest, { start: number; span: Span | null }>();
  private logs: ReturnType<LoggerProvider['getLogger']> | null = null;
  private cacheGets: Counter<string> | null = null;
  private management: FastifyInstance | null = null;

  private constructor(
    readonly settings: Settings,
    private readonly provider: NodeTracerProvider,
    private readonly logProvider: LoggerProvider | null,
    private readonly configuration: Configuration
  ) {
    collectDefaultMetrics({ register: this.registry });
    // El límite del heap, contra el que se mide la presión de memoria (el total de V8 crece a demanda).
    void this.gauge('${NODE_RUNTIME.heapLimit}', 'Límite del heap de V8', async () => getHeapStatistics().heap_size_limit);
    this.logs = logProvider?.getLogger('keel') ?? null;
  }

  /**
   * El pool de conexiones del driver relacional: en uso, libres, máximo y peticiones ESPERANDO una conexión (la
   * serie de la alerta de saturación). Lo registra el módulo de persistencia al inicializar el DataSource.
   */
  connectionPool(read: () => { active: number; idle: number; max: number; pending: number }): void {
    this.gauge('${NODE_RUNTIME.pool.active}', 'Conexiones del pool en uso', async () => read().active);
    this.gauge('${NODE_RUNTIME.pool.idle}', 'Conexiones del pool libres', async () => read().idle);
    this.gauge('${NODE_RUNTIME.pool.max}', 'Tamaño máximo del pool', async () => read().max);
    this.gauge('${NODE_RUNTIME.pool.saturation}', 'Peticiones esperando una conexión del pool', async () => read().pending);
  }

  /** La telemetría en marcha, o null si este proceso no la arrancó. */
  static current(): Telemetry | null {
    return Telemetry.instance;
  }

  /** Arranca la telemetría con la configuración del perfil activo. Idempotente. */
  static start(configuration: Configuration): Telemetry {
    if (Telemetry.instance) return Telemetry.instance;
    const settings = settingsOf(configuration);
    const resource = resourceFromAttributes({
      'service.name': settings.serviceName,
      'service.version': settings.serviceVersion,
      'deployment.environment': settings.environment,
      ...(settings.instanceId ? { 'service.instance.id': settings.instanceId } : {})
    });
    // Sin exportar (local, por defecto) las trazas existen igual: dan el trace.id a los logs y a los exemplars.
    const spanProcessors: SpanProcessor[] = settings.exportEnabled
      ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: \`\${settings.endpoint}/v1/traces\`, compression: 'gzip' as never }))]
      : [];
    const provider = new NodeTracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(settings.samplingProbability) }),
      spanProcessors
    });
    provider.register({ contextManager: new AsyncLocalStorageContextManager(), propagator: new W3cOutB3InPropagator() });
    const logProvider =
      settings.exportEnabled && settings.logsExportEnabled
        ? new LoggerProvider({
            resource,
            processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: \`\${settings.endpoint}/v1/logs\` }) })]
          })
        : null;
    Telemetry.instance = new Telemetry(settings, provider, logProvider, configuration);
    return Telemetry.instance;
  }

  /** ¿Está encendida la instrumentación opcional de \`id\` (cache, storage, mail)? Se lee al arrancar. */
  instrumented(id: string): boolean {
    const key = INSTRUMENTATION_KEYS[id];
    if (!key) return false;
    const value = this.configuration.get(key);
    return value == null || String(value).trim().toLowerCase() !== 'false';
  }

  /**
   * Ejecuta \`action\` dentro de un span de la observación y registra su duración en el histograma de la misma, con
   * el desenlace (\`keel.outcome\`) y, si la traza se muestrea, el exemplar que enlaza el punto con ella.
   */
  async observe<T>(observation: string, options: ObserveOptions, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const labels = options.labels ?? {};
    const parent = options.parent ?? context.active();
    return this.tracer.startActiveSpan(
      options.name ?? observation,
      { kind: options.kind ?? SpanKind.INTERNAL, attributes: { ...labels } },
      parent,
      async (span) => {
        for (const [key, value] of Object.entries(options.spanAttributes ?? {})) if (value != null) span.setAttribute(key, value);
        let outcome: Outcome = 'ok';
        try {
          return await action();
        } catch (error) {
          if (options.isRejection?.(error)) {
            // Un rechazo del dominio NO es un error del span: es un desenlace esperado (un 4xx).
            outcome = 'rejected';
          } else {
            outcome = 'error';
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          throw error;
        } finally {
          span.setAttribute(ATTRIBUTES.outcome, outcome);
          span.end();
          this.record(observation, { ...labels, [ATTRIBUTES.outcome]: outcome }, (performance.now() - start) / 1000, span);
        }
      }
    );
  }

  /**
   * La publicación de un evento desde el outbox: un span PRODUCER que continúa la traza que lo originó (la que
   * quedó en la fila, porque el relay publica en otro instante y sin el contexto de la petición).
   */
  publishing<T>(eventType: string, traceparent: string | null | undefined, action: () => Promise<T>): Promise<T> {
    return this.observe(
      OBSERVATIONS.outboxPublish,
      { name: \`\${eventType} publish\`, kind: SpanKind.PRODUCER, labels: { [ATTRIBUTES.eventType]: eventType }, parent: this.contextFrom(traceparent) ?? ROOT_CONTEXT },
      action
    );
  }

  /** El consumo de un evento: un span CONSUMER que continúa la traza del emisor (\`metadata.traceparent\`). */
  consuming<T>(eventType: string, traceparent: string | null | undefined, action: () => Promise<T>): Promise<T> {
    return this.observe(
      OBSERVATIONS.messageConsume,
      { name: \`\${eventType} consume\`, kind: SpanKind.CONSUMER, labels: { [ATTRIBUTES.eventType]: eventType }, parent: this.contextFrom(traceparent) ?? ROOT_CONTEXT },
      action
    );
  }

  /**
   * Una llamada saliente: un span CLIENT que inyecta la traza en las cabeceras ANTES de llamar, y la métrica
   * \`http_client_requests_seconds\` con las etiquetas de keel-spring (la plantilla de la ruta, nunca la URL con sus
   * valores). Sin respuesta, el estado es IO_ERROR.
   */
  async httpClient<T extends { readonly status: number }>(
    clientName: string,
    method: string,
    uriTemplate: string,
    headers: Record<string, string>,
    action: () => Promise<T>
  ): Promise<T> {
    const start = performance.now();
    return this.tracer.startActiveSpan(
      \`\${method} \${uriTemplate}\`,
      { kind: SpanKind.CLIENT, attributes: { 'http.request.method': method, 'url.template': uriTemplate, 'keel.client': clientName } },
      async (span) => {
        this.injectInto(headers);
        let status = 'IO_ERROR';
        try {
          const response = await action();
          status = String(response.status);
          return response;
        } catch (error) {
          const failed = (error as { status?: unknown } | null)?.status;
          if (typeof failed === 'number') status = String(failed);
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.setAttribute('http.response.status_code', status);
          span.end();
          const numeric = Number(status);
          this.histogram('http.client.requests', HTTP_CLIENT_LABELS).observe({
            labels: { method, uri: uriTemplate, status, client_name: clientName, outcome: Number.isNaN(numeric) ? 'UNKNOWN' : outcomeOf(numeric) },
            value: (performance.now() - start) / 1000,
            ...exemplarOf(span)
          });
        }
      }
    );
  }

  /**
   * Un PUERTO entero observado (storage, correo): cada método asíncrono dentro de un span de la observación, con su
   * timer. Sobre el puerto y no dentro del adaptador porque el de storage lo escribe el agente: así se instrumenta
   * cualquier implementación. Con su interruptor apagado (\`TELEMETRY_INSTRUMENT_*\`), el puerto tal cual.
   */
  instrumentPort<T extends object>(
    id: string,
    observation: string,
    port: T,
    labelsOf: (method: string, args: readonly unknown[]) => Record<string, string>,
    syncMethods: readonly string[] = []
  ): T {
    if (!this.instrumented(id)) return port;
    return new Proxy(port, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || typeof property !== 'string' || property === 'constructor' || syncMethods.includes(property)) return value;
        return (...args: unknown[]) =>
          this.observe(observation, { name: \`\${observation} \${property}\`, labels: labelsOf(property, args) }, () =>
            Promise.resolve((value as (...params: unknown[]) => unknown).apply(target, args))
          );
      }
    });
  }

  /**
   * Un acierto o un fallo de una caché de lectura: \`cache_gets_total{cache,result}\`, la serie del ratio de acierto
   * del panel (la misma que publica keel-spring con las estadísticas del gestor de caché).
   */
  cacheGet(cache: string, hit: boolean): void {
    this.cacheGets ??= new Counter({ name: 'cache_gets', help: 'Lecturas de las cachés de lectura', labelNames: ['cache', 'result'], registers: [this.registry] });
    this.cacheGets.inc({ cache, result: hit ? 'hit' : 'miss' });
  }

  /**
   * Un gauge que se lee en cada scrape (\`keel.outbox.dead_lettered\`: los eventos que agotaron sus reintentos). Gauge y
   * no contador: un contador se reinicia con el proceso y no vería lo que se rindió antes de arrancar.
   */
  gauge(name: string, help: string, read: () => Promise<number>): void {
    const metric = mangle(name);
    if (this.registry.getSingleMetric(metric)) return;
    new Gauge({
      name: metric,
      help,
      registers: [this.registry],
      async collect() {
        this.set(await read());
      }
    });
  }

  /** El contexto que continúa la traza de un \`traceparent\` recibido (la envoltura de un evento); sin él, ninguno. */
  contextFrom(traceparent: string | null | undefined): Context | undefined {
    if (!traceparent) return undefined;
    return propagation.extract(ROOT_CONTEXT, { traceparent });
  }

  /** El \`traceparent\` W3C de la traza en curso, para estamparlo en la envoltura de un evento; sin traza, null. */
  currentTraceparent(): string | null {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier.traceparent ?? null;
  }

  /** Las cabeceras de propagación para una llamada saliente. */
  injectInto(headers: Record<string, string>): void {
    propagation.inject(context.active(), headers);
  }

  /** Los ids de la traza en curso (para el logger), o null. */
  traceIds(): TraceIds | null {
    const span = trace.getSpan(context.active());
    const ids = span?.spanContext();
    return ids && trace.isSpanContextValid(ids) ? { traceId: ids.traceId, spanId: ids.spanId } : null;
  }

  /** Un registro de log por OTLP (solo con LOG_EXPORT_OTLP): el logger lo llama por cada línea que escribe. */
  emitLog(level: string, logger: string, message: string, attributes: Record<string, string>): void {
    this.logs?.emit({
      severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
      severityText: level,
      body: message,
      attributes: { 'log.logger': logger, ...attributes },
      context: context.active()
    });
  }

  /**
   * La entrada HTTP: un span SERVER por petición (continuando la traza de quien llama) y la métrica
   * \`http_server_requests_seconds\` con las etiquetas de keel-spring. Se instala ANTES que la correlación, para que
   * todo lo que haga la petición quede dentro del span.
   */
  installHttp(fastify: FastifyInstance): void {
    fastify.addHook('onRequest', (request, _reply, done) => {
      const path = request.url.split('?')[0] ?? '/';
      if (TECHNICAL_PATHS.has(path)) {
        this.httpRequests.set(request, { start: performance.now(), span: null });
        done();
        return;
      }
      const parent = propagation.extract(ROOT_CONTEXT, request.headers);
      const span = this.tracer.startSpan(
        \`\${request.method} \${routeOf(request) ?? path}\`,
        { kind: SpanKind.SERVER, attributes: { 'http.request.method': request.method, 'url.path': path } },
        parent
      );
      this.httpRequests.set(request, { start: performance.now(), span });
      context.with(trace.setSpan(parent, span), done);
    });
    fastify.addHook('onResponse', (request, reply, done) => {
      const entry = this.httpRequests.get(request);
      if (entry) this.finishHttp(request, reply, entry);
      done();
    });
    if (this.settings.prometheusEnabled && this.settings.managementPort == null) {
      fastify.get(SCRAPE_PATH, (_request, reply) => this.scrape(reply));
    }
  }

  /** El puerto de gestión (production): solo el scrape y su sonda, en un servidor aparte. */
  async startManagement(host: string): Promise<void> {
    if (!this.settings.prometheusEnabled || this.settings.managementPort == null) return;
    const { default: Fastify } = await import('fastify');
    const server = Fastify();
    server.get(SCRAPE_PATH, (_request, reply) => this.scrape(reply));
    server.get('/actuator/health', (_request, reply) => reply.send({ status: 'UP' }));
    await server.listen({ port: this.settings.managementPort, host });
    this.management = server;
  }

  /** Exporta YA lo que haya en cola (trazas y logs), sin apagar nada. */
  async flush(): Promise<void> {
    await this.provider.forceFlush();
    await this.logProvider?.forceFlush();
  }

  /** Vacía lo que queda en cola y cierra el puerto de gestión. */
  async shutdown(): Promise<void> {
    await this.management?.close();
    await this.provider.shutdown();
    await this.logProvider?.shutdown();
    Telemetry.instance = null;
  }

  private async scrape(reply: FastifyReply): Promise<void> {
    const body = await this.registry.metrics();
    await reply.header('content-type', this.registry.contentType).serializer((payload) => String(payload)).send(body);
  }

  private finishHttp(request: FastifyRequest, reply: FastifyReply, entry: { start: number; span: Span | null }): void {
    const status = reply.statusCode;
    const uri = routeOf(request) ?? (status === 404 ? 'NOT_FOUND' : 'UNKNOWN');
    const seconds = (performance.now() - entry.start) / 1000;
    const span = entry.span;
    if (span) {
      span.updateName(\`\${request.method} \${uri}\`);
      span.setAttribute('http.route', uri);
      span.setAttribute('http.response.status_code', status);
      const correlationId = reply.getHeader('x-correlation-id');
      if (typeof correlationId === 'string') span.setAttribute(ATTRIBUTES.correlationId, correlationId);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    this.histogram('http.server.requests', HTTP_SERVER_LABELS).observe({
      labels: { method: request.method, uri, status: String(status), outcome: outcomeOf(status), exception: 'none' },
      value: seconds,
      ...exemplarOf(span)
    });
  }

  private record(observation: string, attributes: Readonly<Record<string, string>>, seconds: number, span: Span): void {
    const labels = Object.fromEntries(Object.entries(attributes).map(([key, value]) => [mangle(key), value]));
    this.histogram(observation, Object.keys(labels)).observe({ labels, value: seconds, ...exemplarOf(span) });
  }

  /** El histograma de una observación, con el nombre de serie de keel-spring (\`<observación>_seconds\`). */
  private histogram(observation: string, labelNames: readonly string[]): Histogram<string> {
    let histogram = this.histograms.get(observation);
    if (!histogram) {
      histogram = new Histogram({
        name: \`\${mangle(observation)}_seconds\`,
        help: observation,
        labelNames: [...labelNames],
        buckets: DURATION_BUCKETS,
        registers: [this.registry],
        enableExemplars: true
      });
      this.histograms.set(observation, histogram);
    }
    return histogram;
  }
}

/**
 * El puerto de storage observado (keel.storage, con la operación y el bucket LÓGICO del diseño: un nombre de un
 * conjunto cerrado; la key del objeto no sale nunca, es dato). Sin telemetría en marcha, el puerto tal cual.
 */
export function instrumentStorage<T extends object>(port: T): T {
  return (
    Telemetry.current()?.instrumentPort(
      'storage',
      OBSERVATIONS.storage,
      port,
      (method, args) => ({ [ATTRIBUTES.storageOperation]: method, [ATTRIBUTES.storageBucket]: typeof args[0] === 'string' ? args[0] : 'unknown' }),
      ['publicUrl']
    ) ?? port
  );
}

/** El puerto de correo observado (keel.mail.send). Sin más etiqueta que el desenlace: el destinatario es dato. */
export function instrumentMail<T extends object>(port: T): T {
  return Telemetry.current()?.instrumentPort('mail', OBSERVATIONS.mailSend, port, () => ({})) ?? port;
}

const SEVERITY: Record<string, SeverityNumber> = {
  TRACE: SeverityNumber.TRACE,
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL
};

/** El exemplar de un punto: solo si la traza se muestrea (un id de una traza que no se exportó no lleva a nada). */
function exemplarOf(span: Span | null): { exemplarLabels?: Record<string, string> } {
  const ids = span?.spanContext();
  if (!ids || !trace.isSpanContextValid(ids) || (ids.traceFlags & TraceFlags.SAMPLED) === 0) return {};
  return { exemplarLabels: { trace_id: ids.traceId, span_id: ids.spanId } };
}

/** La plantilla de la ruta, con la sintaxis de keel-spring (\`/products/{id}\`); null si ninguna casó. */
function routeOf(request: FastifyRequest): string | null {
  const url = request.routeOptions?.url;
  return url ? url.replace(/:([A-Za-z0-9_]+)/g, '{$1}') : null;
}

/** El desenlace de una respuesta HTTP, con los valores de keel-spring. */
function outcomeOf(status: number): string {
  if (status < 200) return 'INFORMATIONAL';
  if (status < 300) return 'SUCCESS';
  if (status < 400) return 'REDIRECTION';
  if (status < 500) return 'CLIENT_ERROR';
  return status < 600 ? 'SERVER_ERROR' : 'UNKNOWN';
}

/** El nombre de una serie o una etiqueta: lo que no es alfanumérico, a \`_\` (promMetric de keel-core). */
function mangle(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_');
}

function settingsOf(configuration: Configuration): Settings {
  const text = (path: string): string | null => {
    const value = configuration.get(path);
    return value == null || String(value).trim() === '' ? null : String(value).trim();
  };
  const flag = (path: string, fallback: boolean): boolean => {
    const value = text(path);
    return value == null ? fallback : value.toLowerCase() === 'true';
  };
  const probability = Number(text('telemetry.tracing.sampling-probability') ?? '1.0');
  if (!(probability >= 0 && probability <= 1)) {
    throw new Error(\`telemetry.tracing.sampling-probability inválido: '\${text('telemetry.tracing.sampling-probability')}' (entre 0 y 1)\`);
  }
  const port = text('management.server.port');
  return {
    serviceName: configuration.application.name,
    serviceVersion: text('telemetry.resource.service-version') ?? 'unknown',
    environment: text('telemetry.resource.deployment-environment') ?? configuration.profiles.join(','),
    instanceId: text('telemetry.resource.service-instance-id'),
    samplingProbability: probability,
    exportEnabled: flag('telemetry.export.enabled', false),
    endpoint: (text('telemetry.export.endpoint') ?? '${collectorHostEndpoint()}').replace(/\\/$/, ''),
    logsExportEnabled: flag('telemetry.logs.export-enabled', false),
    prometheusEnabled: flag('telemetry.metrics.prometheus-enabled', true),
    managementPort: port == null ? null : Number(port)
  };
}`);
}

/** Lo que cambia en main.ts con telemetría: arrancarla antes que nada y abrir el puerto de gestión tras escuchar. */
export function mainTelemetry(model) {
  return usesTelemetry(model)
    ? {
        imports: "\nimport { Telemetry } from './infrastructure/telemetry/telemetry.js';",
        start: '\n// La telemetría arranca ANTES que la aplicación: los spans de su arranque ya tienen proveedor.\nconst telemetry = Telemetry.start(configuration);',
        loggerOptions: ', telemetry',
        afterListen: '\n// En production, el scrape en su puerto de gestión (MANAGEMENT_PORT), que no se publica fuera del pod.\nawait telemetry.startManagement(configuration.server.address);'
      }
    : { imports: '', start: '', loggerOptions: '', afterListen: '' };
}

export { promTag, INSTRUMENTATION };
