// Los logs del servicio generado (incremento 14b de PLAN-KEEL-NEST.md): lo que keel-spring genera CON y SIN
// telemetría, porque la consola es el canal primario de los logs en cualquier plataforma.
//
//   · `local` (y `test`) escriben TEXTO, porque lo lee una persona; `develop` y `production`, JSON ECS
//     (`LOG_FORMAT`, default `ecs`), que es lo que un agente de nodo, CloudWatch o Fluent Bit separan en campos
//     sin expresiones regulares. La forma es la del formato ECS de Spring Boot 3.5 —anidado: `log.level`,
//     `log.logger`, `process.pid`, `service.*`, `ecs.version`—, para que un mismo pipeline de logs lea los dos
//     servidores del mismo diseño.
//   · Cada línea lleva el `correlationId` en curso (CorrelationContext): es lo que permite reconstruir una
//     petición entera, y los eventos que provocó, desde el identificador que el cliente recibió.
//   · Los niveles salen de las MISMAS variables que en keel-spring: `LOG_LEVEL_ROOT` para lo que escribe el
//     framework y `LOG_LEVEL_APP` para lo que escribe el servicio, con el mismo gradiente (INFO/DEBUG fuera de
//     production; WARN/INFO en production).
//   · La versión, el entorno y la réplica van en `service.*` (`DEPLOYMENT_ENVIRONMENT`, `SERVICE_INSTANCE_ID`
//     o `HOSTNAME`): sin ellos dos despliegues o dos instancias escriben líneas indistinguibles.

import { tsModule } from './render.js';
import { CORRELATION_TS, usesCorrelation } from './rest-support.js';
import { envFor } from 'keel-core/gen/runtime-env';

export const LOGGER_TS = 'src/infrastructure/logging/keel-logger.ts';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** Los contextos que escribe el propio Nest: su nivel es el de `LOG_LEVEL_ROOT`, como los paquetes ajenos en keel-spring. */
export const FRAMEWORK_CONTEXTS = [
  'NestFactory',
  'NestApplication',
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'RouterExecutionContext',
  'ExceptionsHandler',
  'ExceptionHandler',
  'NestMicroservice',
  'Scheduler'
];

/** La versión del esquema ECS que declara cada línea: la del formato de Spring Boot 3.5. */
export const ECS_VERSION = '8.11';

export function generate(model) {
  return [
    { path: LOGGER_TS, content: loggerTs(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/logging.yaml`, content: loggingYaml(model, profile) }))
  ];
}

/** El fragmento de cada perfil: las mismas claves de nivel y formato, y las mismas variables, que keel-spring. */
export function loggingYaml(model, profile) {
  const root = profile === 'production' ? 'WARN' : 'INFO';
  const app = profile === 'production' ? 'INFO' : 'DEBUG';
  const lines = [
    `# Generado por keel-nest build. Los logs del servicio en el perfil ${profile}.`,
    'logging:',
    '  level:',
    `    root: ${envFor('LOG_LEVEL_ROOT', profile, root)}`,
    `    app: ${envFor('LOG_LEVEL_APP', profile, app)}`
  ];
  if (profile === 'develop' || profile === 'production') {
    lines.push(
      '  # Fuera de local la consola es JSON (ECS): la recoge un agente que la separa en campos.',
      '  structured:',
      '    format:',
      `      console: ${envFor('LOG_FORMAT', profile)}`,
      '    ecs:',
      '      service:',
      `        version: "${model.service.version}"`,
      `        environment: ${envFor('DEPLOYMENT_ENVIRONMENT', profile, profile)}`,
      '        node-name: ${SERVICE_INSTANCE_ID:${HOSTNAME:unknown}}'
    );
  }
  return `${lines.join('\n')}\n`;
}

function loggerTs(model) {
  const imports = [
    { symbol: 'LoggerService', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true }
  ];
  const correlation = usesCorrelation(model);
  if (correlation) imports.push({ symbol: 'CorrelationContext', from: CORRELATION_TS });
  const correlationOf = correlation ? 'CorrelationContext.get()' : 'null';
  return tsModule(LOGGER_TS, imports, `export type LogFormat = 'text' | 'ecs';

type Level = 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal';

/** Los niveles de keel-spring (los de logback) sobre los de Nest, de menos a más grave. */
const RANK: Record<Level, number> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 };
const FROM_NAME: Record<string, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5, OFF: 6 };
const ECS_LEVEL: Record<Level, string> = { verbose: 'TRACE', debug: 'DEBUG', log: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'FATAL' };

/** Los contextos que escribe Nest: van con el nivel raíz. */
const FRAMEWORK_CONTEXTS = new Set<string>(${JSON.stringify(FRAMEWORK_CONTEXTS)});

const STACK_LINE = /\\n\\s+at /;

export interface KeelLoggerOptions {
  readonly format: LogFormat;
  readonly rootLevel: string;
  readonly appLevel: string;
  readonly service: { readonly name: string; readonly version?: string; readonly environment?: string; readonly nodeName?: string };
  /** Dónde se escribe cada línea (stdout por defecto; las pruebas lo sustituyen). */
  readonly write?: (line: string) => void;
  /** La telemetría, si este proceso la arrancó: los ids de la traza en curso y el reenvío por OTLP. */
  readonly telemetry?: LogTelemetry | null;
}

/**
 * Lo que el logger necesita de la telemetría, sin depender de ella (sin telemetría no se emite su módulo): los ids
 * de la traza en curso, que van en cada línea (trace.id/span.id: el enlace de la línea con su traza), y el reenvío
 * de la línea por OTLP, que solo hace algo con LOG_EXPORT_OTLP.
 */
type TraceIds = { readonly traceId: string; readonly spanId: string };

export interface LogTelemetry {
  traceIds(): TraceIds | null;
  emitLog(level: string, logger: string, message: string, attributes: Record<string, string>): void;
}

/**
 * El logger del servicio: lo instala main.ts para Nest y para todo \`new Logger(Contexto)\` del código.
 *
 * Texto en local; JSON ECS (el formato de Spring Boot 3.5, anidado) fuera de él. Cada línea lleva el
 * correlationId en curso. Los niveles: \`logging.level.root\` para los contextos del propio Nest y
 * \`logging.level.app\` para el resto (LOG_LEVEL_ROOT / LOG_LEVEL_APP).
 *
 * Una sola pila por fallo: la escribe quien registra el error con ella (el filtro de la API); quien
 * solo lo cuenta (el mediator) no la pasa.
 */
export class KeelLogger implements LoggerService {
  private readonly root: number;
  private readonly app: number;
  private readonly write: (line: string) => void;

  constructor(private readonly options: KeelLoggerOptions) {
    this.root = rankOf(options.rootLevel);
    this.app = rankOf(options.appLevel);
    this.write = options.write ?? ((line) => process.stdout.write(line));
  }

  /** El logger que dice la configuración del perfil activo. */
  static from(configuration: Configuration, telemetry: LogTelemetry | null = null): KeelLogger {
    const text = (path: string) => {
      const value = configuration.get(path);
      return value == null || value === '' ? undefined : String(value);
    };
    return new KeelLogger({
      format: text('logging.structured.format.console') === 'ecs' ? 'ecs' : 'text',
      rootLevel: text('logging.level.root') ?? 'INFO',
      appLevel: text('logging.level.app') ?? 'INFO',
      service: {
        name: configuration.application.name,
        version: text('logging.structured.ecs.service.version'),
        environment: text('logging.structured.ecs.service.environment'),
        nodeName: text('logging.structured.ecs.service.node-name')
      },
      telemetry
    });
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  /** ¿Se escribiría una línea de este nivel en este contexto? */
  enabled(level: Level, context: string | undefined): boolean {
    const threshold = context != null && FRAMEWORK_CONTEXTS.has(context) ? this.root : this.app;
    return RANK[level] >= threshold;
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    // La firma de Nest: el último parámetro de texto es el contexto; en error(), uno anterior con
    // forma de pila es la pila.
    const rest = [...params];
    const context = rest.length > 0 && typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    if (!this.enabled(level, context)) return;
    let stack: string | undefined;
    if (rest.length > 0 && typeof rest[0] === 'string' && STACK_LINE.test(rest[0])) stack = rest.shift() as string;
    const error = message instanceof Error ? message : rest.find((param): param is Error => param instanceof Error);
    if (error && stack == null) stack = error.stack;
    const text = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    const correlationId = ${correlationOf};
    const telemetry = this.options.telemetry ?? null;
    const trace = telemetry?.traceIds() ?? null;
    this.write(
      this.options.format === 'ecs'
        ? \`\${JSON.stringify(this.ecs(level, context, text, correlationId, trace, error, stack))}\\n\`
        : this.text(level, context, text, correlationId, trace, stack)
    );
    telemetry?.emitLog(ECS_LEVEL[level], context ?? 'app', text, {
      ...(correlationId ? { correlationId } : {}),
      ...(stack ? { 'exception.stacktrace': stack } : {})
    });
  }

  private ecs(level: Level, context: string | undefined, message: string, correlationId: string | null, trace: TraceIds | null, error: Error | undefined, stack: string | undefined) {
    const { service } = this.options;
    return {
      '@timestamp': new Date().toISOString(),
      log: { level: ECS_LEVEL[level], logger: context ?? 'app' },
      process: { pid: process.pid, thread: { name: 'main' } },
      service: {
        name: service.name,
        ...(service.version ? { version: service.version } : {}),
        ...(service.environment ? { environment: service.environment } : {}),
        ...(service.nodeName ? { node: { name: service.nodeName } } : {})
      },
      message,
      ...(correlationId ? { correlationId } : {}),
      // Los nombres de ECS: con ellos un backend enlaza la línea con su traza.
      ...(trace ? { trace: { id: trace.traceId }, span: { id: trace.spanId } } : {}),
      ...(stack || error
        ? { error: { type: error?.name ?? 'Error', message: error?.message ?? message, ...(stack ? { stack_trace: stack } : {}) } }
        : {}),
      ecs: { version: '${ECS_VERSION}' }
    };
  }

  private text(level: Level, context: string | undefined, message: string, correlationId: string | null, trace: TraceIds | null, stack: string | undefined): string {
    const ids = trace ? \`[\${trace.traceId},\${trace.spanId}] \` : '';
    const head = \`\${new Date().toISOString()} \${ECS_LEVEL[level].padStart(5)} \${process.pid} --- \${correlationId ? \`[\${correlationId}] \` : ''}\${ids}[\${context ?? 'app'}] \${message}\`;
    return \`\${head}\\n\${stack ? \`\${stack}\\n\` : ''}\`;
  }
}

function rankOf(name: string): number {
  const rank = FROM_NAME[name.trim().toUpperCase()];
  if (rank == null) throw new Error(\`Nivel de log desconocido: '\${name}' (usa TRACE, DEBUG, INFO, WARN, ERROR u OFF)\`);
  return rank;
}`);
}
