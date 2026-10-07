// Lo que corre por RELOJ (incremento 10b): las operaciones con `schedule` del diseño y las purgas de
// las tablas del generador.
//
// Es el `@Scheduled` de keel-spring con `cron` 4 a pelo (no @nestjs/schedule: las expresiones de las
// purgas salen de la configuración al arrancar, no de un decorador, y su registro no aporta nada):
//
//   · `Scheduling` registra cada tarea con su cron de SEIS campos y la arranca al terminar el arranque
//     de la aplicación; al apagar, para el reloj y ESPERA a la pasada en vuelo. Cada tarea corre con
//     `waitForCompletion`: un tick que llega con la pasada anterior en curso se salta, que es lo que
//     hace el @Scheduled de Spring (la siguiente ejecución se calcula al terminar). La conmuta
//     `scheduling.enabled`, apagada en el perfil `test`, que no tiene base de datos.
//   · Un `<Servicio>Scheduler` por grupo de operaciones con `schedule`, en infraestructura (es un
//     adaptador de entrada, como un controlador): el segundo de arranque y si se despacha con la
//     transacción del caso de uso o sin ella son decisiones NEUTRALES (keel-core/gen/scheduling.js),
//     las mismas que toma keel-spring para el mismo diseño.
//   · Las purgas (`purge.js`) se registran en el mismo `Scheduling`.

import { scheduledOperations, scheduleCron, scheduleDispatch } from 'keel-core/gen';
import { classPath, tsModule, tsdoc } from './render.js';
import { MEDIATOR_TS, MODULE_TS as USE_CASE_MODULE_TS, usesMediator } from './mediator.js';
import { messageComponents, messagePath } from './services.js';
import { CORRELATION_TS, usesCorrelation } from './rest-support.js';
import { TABLE_PURGES_TS, usesTablePurges } from './purge.js';

const SCHEDULING_DIR = 'infrastructure/scheduling';
export const SCHEDULING_TS = `src/${SCHEDULING_DIR}/scheduling.ts`;
export const SCHEDULING_MODULE_TS = `src/${SCHEDULING_DIR}/scheduling-module.ts`;
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Hay algo que corra por reloj? Operaciones con `schedule` (con casos de uso que despachar) o purgas. */
export function usesScheduling(model) {
  return (usesMediator(model) && scheduledOperations(model).length > 0) || usesTablePurges(model);
}

/** El scheduler de un grupo de operaciones: `NotificationService` → `NotificationScheduler`. */
export const schedulerClass = (service) => service.className.replace(/Service$/, 'Scheduler');
export const schedulerPath = (service) => classPath(SCHEDULING_DIR, schedulerClass(service));

/** Los grupos con alguna operación por reloj, con esas operaciones. */
export function scheduledServices(model) {
  if (!usesMediator(model)) return [];
  return (model.services ?? [])
    .map((service) => ({ service, operations: (service.operations ?? []).filter((operation) => operation.schedule) }))
    .filter(({ operations }) => operations.length > 0);
}

export function generate(model) {
  if (!usesScheduling(model)) return [];
  const files = [
    { path: SCHEDULING_TS, content: schedulingFile() },
    { path: SCHEDULING_MODULE_TS, content: moduleFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/scheduling.yaml`, content: schedulingYaml(profile) }))
  ];
  for (const { service, operations } of scheduledServices(model)) {
    files.push({ path: schedulerPath(service), content: schedulerFile(model, service, operations) });
  }
  return files;
}

function schedulingYaml(profile) {
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: nada corre por reloj.
scheduling:
  enabled: false
`;
  }
  return `# El reloj del servicio: los barridos del diseño y las purgas de las tablas del generador.
scheduling:
  enabled: \${SCHEDULING_ENABLED:true}
`;
}

function schedulingFile() {
  return tsModule(
    SCHEDULING_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'CronJob', from: 'cron' },
      { symbol: 'Configuration', from: CONFIG_TS, type: true }
    ],
    `/** Token de la configuración del reloj ya resuelta. */
export const SCHEDULING_SETTINGS = Symbol('SCHEDULING_SETTINGS');

export interface SchedulingSettings {
  /** ¿Corre el reloj? Apagado en el perfil test, que no tiene base de datos. */
  readonly enabled: boolean;
}

export function schedulingSettings(configuration: Configuration): SchedulingSettings {
  const value = configuration.get('scheduling.enabled');
  if (value == null || String(value).trim() === '') return { enabled: true };
  const text = String(value).trim().toLowerCase();
  if (text !== 'true' && text !== 'false') throw new Error(\`scheduling.enabled tiene que ser true o false: '\${String(value)}'\`);
  return { enabled: text === 'true' };
}

/** Una tarea por reloj: su nombre (único), su cron de SEIS campos (con segundos) y su pasada. */
export interface ScheduledTask {
  readonly name: string;
  readonly cron: string;
  readonly run: () => Promise<unknown>;
}

/**
 * El reloj del servicio. Las tareas se registran al inicializar sus módulos y arrancan cuando la
 * aplicación termina de arrancar; al apagar se para y se espera a la pasada en vuelo, ANTES de cerrar el
 * pool de conexiones: cortarla a medias deja filas reclamadas sin trabajo hecho, que solo recupera un
 * rescate.
 *
 * Cada tarea corre en TODAS las réplicas: es «una vez por instancia», no «una vez en el clúster». Lo que
 * actúa sobre lo que encuentra tiene que reclamarlo, no solo leerlo.
 */
@Injectable()
export class Scheduling implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Scheduling');
  private readonly jobs = new Map<string, CronJob>();

  constructor(@Inject(SCHEDULING_SETTINGS) private readonly settings: SchedulingSettings) {}

  /**
   * Registra una tarea. Un cron inválido no deja arrancar: un barrido que no se dispara nunca no da
   * ningún error que alguien vaya a ver.
   */
  register(task: ScheduledTask): void {
    if (this.jobs.has(task.name)) throw new Error(\`Tarea por reloj duplicada: \${task.name}\`);
    const job = CronJob.from({
      cronTime: task.cron,
      start: false,
      // Un tick con la pasada anterior en curso se salta: la tarea no se solapa consigo misma.
      waitForCompletion: true,
      name: task.name,
      onTick: async () => {
        try {
          await task.run();
        } catch (error) {
          // Una pasada que falla entera no para el reloj: lo intenta en la siguiente.
          this.logger.error(\`\${task.name}: la pasada falló: \${error instanceof Error ? error.message : String(error)}\`);
        }
      }
    });
    this.jobs.set(task.name, job);
  }

  /** Los nombres de las tareas registradas. */
  names(): string[] {
    return [...this.jobs.keys()];
  }

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      if (this.jobs.size > 0) this.logger.log(\`Reloj apagado (scheduling.enabled: false): \${this.jobs.size} tarea(s) sin arrancar\`);
      return;
    }
    for (const job of this.jobs.values()) job.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.stop()));
  }
}`
  );
}

function schedulerFile(model, service, operations) {
  const className = schedulerClass(service);
  const file = schedulerPath(service);
  const correlated = usesCorrelation(model);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'OnModuleInit', from: '@nestjs/common', type: true },
    { symbol: 'UseCaseMediator', from: MEDIATOR_TS },
    { symbol: 'Scheduling', from: SCHEDULING_TS },
    ...(correlated ? [{ symbol: 'randomUUID', from: 'node:crypto' }, { symbol: 'CorrelationContext', from: CORRELATION_TS }] : [])
  ];
  const registrations = operations
    .map((operation) => `    this.scheduling.register({ name: '${operation.name}', cron: '${scheduleCron(model, operation)}', run: () => this.${operation.name}() });`)
    .join('\n');
  const methods = operations.map((operation) => {
    const mode = scheduleDispatch(model, operation);
    const why = {
      provider: 'llama al proveedor',
      irreversible: 'produce un efecto que no se deshace',
      claimed: 'confirma cada reclamo en su propia transacción y actúa sobre las filas una a una'
    }[mode.reason];
    const note = mode.withoutTransaction
      ? `Despachado SIN transacción abarcadora a propósito: este barrido ${why} EN MEDIO de su trabajo, así que su
garantía es un orden de commits —reclamar y confirmar, actuar fuera de toda transacción, confirmar el
desenlace— y no una transacción única. Igualarlo a mediator.dispatch(...) «por coherencia» deja el reclamo
sin confirmar hasta el final del lote: ninguna réplica lo ve y todas actúan sobre los mismos candidatos.`
      : 'Despachado con la transacción del caso de uso: no llama a nadie en medio de su trabajo.';
    const doc = tsdoc([operation.schedule.description, `Cron del diseño: ${operation.schedule.cron} (build añade el segundo de arranque).`, note], '  ');
    if (messageComponents(model, operation).length > 0) {
      return `${doc}  ${operation.name}(): Promise<void> {
    // TODO (agente): el mensaje requiere argumentos; construirlos aquí.
    return Promise.reject(new Error('TODO: despachar ${operation.messageClass} desde el scheduler'));
  }`;
    }
    imports.push({ symbol: operation.messageClass, from: messagePath(operation) });
    const dispatch = `this.mediator.${mode.withoutTransaction ? 'dispatchWithoutTransaction' : 'dispatch'}(new ${operation.messageClass}())`;
    const body = correlated
      ? `    // Una pasada del barrido es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su
    // correlación. Sin esto, todo lo que publique viajaría con correlationId nulo.
    return CorrelationContext.runWith(randomUUID(), () => ${dispatch});`
      : `    return ${dispatch};`;
    return `${doc}  ${operation.name}(): Promise<void> {
${body}
  }`;
  });
  const body = `/**
 * Disparadores por reloj de las operaciones de ${service.className.replace(/Service$/, '')} que declaran \`schedule\`.
 *
 * Cada método corre en TODAS las réplicas del servicio. No todos despachan igual, y no es un descuido: lo
 * decide el diseño (keel-core/gen/scheduling.js), igual que en el servidor de keel-spring.
 *
 * El primer campo del cron —el segundo— no es 0 por casualidad: el diseño declara cinco campos y build
 * reparte el arranque dentro del minuto para que dos operaciones con la misma cadencia no salgan a la vez.
 * Igualarlos a 0 «por limpieza» deshace ese reparto.
 */
@Injectable()
export class ${className} implements OnModuleInit {
  constructor(
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,
    @Inject(Scheduling) private readonly scheduling: Scheduling
  ) {}

  onModuleInit(): void {
${registrations}
  }

${methods.join('\n\n')}
}`;
  return tsModule(file, imports, body);
}

function moduleFile(model) {
  const schedulers = scheduledServices(model).map(({ service }) => ({ symbol: schedulerClass(service), from: schedulerPath(service) }));
  const purges = usesTablePurges(model);
  const imports = [
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'SCHEDULING_SETTINGS', from: SCHEDULING_TS },
    { symbol: 'Scheduling', from: SCHEDULING_TS },
    { symbol: 'schedulingSettings', from: SCHEDULING_TS },
    ...schedulers,
    ...(schedulers.length > 0 ? [{ symbol: 'UseCaseModule', from: USE_CASE_MODULE_TS }] : []),
    ...(purges
      ? [
          { symbol: 'PURGE_SETTINGS', from: TABLE_PURGES_TS },
          { symbol: 'TablePurges', from: TABLE_PURGES_TS },
          { symbol: 'purgeSettings', from: TABLE_PURGES_TS }
        ]
      : [])
  ];
  const providers = [
    '{ provide: SCHEDULING_SETTINGS, useValue: schedulingSettings(configuration) }',
    'Scheduling',
    ...(purges ? ['{ provide: PURGE_SETTINGS, useValue: purgeSettings(configuration) }', 'TablePurges'] : []),
    ...schedulers.map((scheduler) => scheduler.symbol)
  ];
  return tsModule(
    SCHEDULING_MODULE_TS,
    imports,
    `/**
 * El reloj del servicio: el registro de tareas, ${[schedulers.length > 0 ? 'los schedulers de las operaciones con schedule' : null, purges ? 'las purgas de las tablas del generador' : null].filter(Boolean).join(' y ')}.
 * Va después de los casos de uso y de la persistencia: despacha por el UseCaseMediator y purga con su
 * DataSource.
 */
@Module({})
export class SchedulingModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: SchedulingModule,${schedulers.length > 0 ? '\n      imports: [UseCaseModule],' : ''}
      providers: [
${providers.map((provider) => `        ${provider}`).join(',\n')}
      ],
      exports: [Scheduling${purges ? ', TablePurges' : ''}]
    };
  }
}`
  );
}
