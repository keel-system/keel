// El patrón mediator de keel-spring, en TypeScript y sin que la capa application importe Nest.
//
//   · application/interfaces — Command, Query<R>, ReturningCommand<R> y sus handlers. Son clases
//     abstractas con una MARCA de tipo, no interfaces vacías: TypeScript compara por estructura, y
//     tres interfaces vacías serían el mismo tipo — el mediator no podría saber qué devuelve
//     `dispatch(mensaje)`.
//   · application/annotations — @ApplicationComponent() y @Handles(Mensaje): solo ponen metadata
//     en la clase (sin reflect-metadata ni Nest). Es lo que en Java hace @ApplicationComponent con
//     el component-scan filtrado: marcar sin acoplar.
//   · infrastructure/usecase — UseCaseContainer (mensaje → handler), UseCaseMediator (la fachada de
//     despacho y el log de frontera de cada caso de uso) y UseCaseModule, el único sitio que cablea
//     handlers y mappers. En Java el registro lo hace UseCaseAutoRegister por reflexión de los
//     genéricos; TypeScript los borra al compilar, así que cada handler DECLARA su mensaje con
//     @Handles y el contenedor falla al arrancar si dos lo reclaman o si a uno le falta.
//
// La inyección de los handlers y mappers tampoco puede usar @Inject (es de Nest): cada clase declara
// `static readonly inject = [...]` con sus dependencias en el orden del constructor, y el módulo de
// infraestructura construye cada una con un factory provider. Con persistencia relacional el despacho
// abre la transacción del caso de uso (incremento 6); sin ella `dispatchWithoutTransaction` es el
// mismo despacho, y existe igual para que el scheduler (scheduling.js) no pregunte por la capa.

import { DIRS, classPath, tsModule } from './render.js';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { usesPersistence, usesRelational } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';
import { usesCallerScope } from './security.js';
import { usesMessaging } from './messaging.js';
import { usesServiceParameters } from './service-parameters.js';
import { usesHttpClients } from './http-clients.js';

export const MESSAGES_TS = classPath(DIRS.interfaces, 'Messages');
export const HANDLERS_TS = classPath(DIRS.interfaces, 'Handlers');
export const ANNOTATIONS_TS = classPath(DIRS.annotations, 'ApplicationComponent');
export const CONTAINER_TS = classPath(DIRS.usecase, 'UseCaseContainer');
export const MEDIATOR_TS = classPath(DIRS.usecase, 'UseCaseMediator');
export const MODULE_TS = classPath(DIRS.usecase, 'UseCaseModule');
export const COMMAND_DISPATCHER_TS = classPath(DIRS.portOut, 'CommandDispatcher');
export const COMMAND_DISPATCHER_ADAPTER_TS = classPath(DIRS.usecase, 'CommandDispatcherAdapter');

/** ¿Hay casos de uso que despachar? Sin operaciones no se genera nada de esto. */
export function usesMediator(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).length > 0);
}

/** Las clases de aplicación que el módulo cablea, con su archivo: handlers y mappers. */
export function applicationClasses(model) {
  const handlers = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      handlers.push({ symbol: operation.handlerClass, from: classPath(DIRS.usecases, operation.handlerClass) });
    }
  }
  return handlers;
}

export function generate(model, { mappers = [] } = {}) {
  if (!usesMediator(model)) return [];
  // Con persistencia (de los dos modelos), el despacho abre la transacción del caso de uso.
  const transactional = usesPersistence(model);
  const files = [
    { path: MESSAGES_TS, content: tsModule(MESSAGES_TS, [], messagesBody()) },
    { path: HANDLERS_TS, content: tsModule(HANDLERS_TS, [{ symbol: 'Command', from: MESSAGES_TS, type: true }, { symbol: 'Query', from: MESSAGES_TS, type: true }, { symbol: 'ReturningCommand', from: MESSAGES_TS, type: true }], handlersBody()) },
    { path: ANNOTATIONS_TS, content: tsModule(ANNOTATIONS_TS, [{ symbol: 'Dispatchable', from: MESSAGES_TS, type: true }], annotationsBody()) },
    { path: CONTAINER_TS, content: tsModule(CONTAINER_TS, [
      { symbol: 'Dispatchable', from: MESSAGES_TS, type: true },
      { symbol: 'Handler', from: HANDLERS_TS, type: true },
      { symbol: 'handledMessageOf', from: ANNOTATIONS_TS }
    ], containerBody()) },
    { path: MEDIATOR_TS, content: tsModule(MEDIATOR_TS, [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'Command', from: MESSAGES_TS, type: true },
      { symbol: 'Dispatchable', from: MESSAGES_TS, type: true },
      { symbol: 'Query', from: MESSAGES_TS, type: true },
      { symbol: 'ReturningCommand', from: MESSAGES_TS, type: true },
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'UseCaseContainer', from: CONTAINER_TS },
      ...(transactional
        ? [
            { symbol: 'Query', from: MESSAGES_TS },
            { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
            { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS },
            { symbol: 'WriteConflictExhausted', from: PERSISTENCE_ERRORS_TS }
          ]
        : [])
    ], mediatorBody(transactional)) }
  ];
  files.push(...commandDispatcher(model));
  files.push(moduleFile(model, mappers));
  files.push({ path: 'test/use-cases.test.ts', content: useCasesTest(model) });
  return files;
}

/**
 * La prueba del cableado: cada mensaje del diseño llega a SU handler a través del módulo real, y el
 * contenedor se niega a arrancar con un handler sin mensaje o con dos para el mismo. Se escribe para
 * que siga valiendo cuando el agente implemente los handlers: no afirma que fallen con su TODO, sino
 * que el mediator los encuentra.
 */
function useCasesTest(model) {
  const operations = (model.services ?? []).flatMap((service) => service.operations ?? []);
  const imports = operations
    .map((operation) => {
      const dir = operation.messageKind === 'query' ? DIRS.queries : DIRS.commands;
      return `import { ${operation.messageClass} } from '../${classPath(dir, operation.messageClass).replace(/\.ts$/, '.js')}';`;
    })
    .join('\n');
  const rows = operations.map((operation) => `  ['${operation.name}', ${operation.messageClass}]`).join(',\n');
  // Con persistencia, los handlers inyectan sus puertos: el módulo de persistencia del perfil test (sin
  // base de datos) los provee, y quien los use de verdad recibe un error que lo dice.
  const persistence = usesPersistence(model);
  const persistenceImports = persistence
    ? "\nimport { PersistenceModule } from '../src/infrastructure/persistence/persistence-module.js';\nimport { loadConfiguration } from '../src/infrastructure/config/configuration.js';"
    : '';
  // El alcance por recurso (global) también es dependencia de los handlers que lo declaran.
  const scope = usesCallerScope(model);
  const scopeImport = scope ? "\nimport { SecurityModule } from '../src/infrastructure/security/security-module.js';" : '';
  // Con mensajería, los adaptadores de repositorio entregan al puente de eventos: también es dependencia.
  const messaging = usesRelational(model) && usesMessaging(model);
  const messagingImport = messaging ? "\nimport { MessagingModule } from '../src/infrastructure/messaging/messaging-module.js';" : '';
  // Los parámetros de despliegue (globales): los inyectan los adaptadores y los handlers que los leen.
  const parameters = usesServiceParameters(model);
  const parametersImport = parameters
    ? "\nimport { ServiceParametersModule } from '../src/infrastructure/config/service-parameters-module.js';" +
      (persistence ? '' : "\nimport { loadConfiguration } from '../src/infrastructure/config/configuration.js';")
    : '';
  // Los clientes HTTP salientes (globales): los handlers inyectan sus puertos. En el perfil test apuntan a una
  // dirección que no responde, y nada los llama.
  const clients = usesHttpClients(model);
  const clientsImport = clients
    ? "\nimport { HttpClientsModule } from '../src/infrastructure/clients/http-clients-module.js';" +
      (persistence || parameters ? '' : "\nimport { loadConfiguration } from '../src/infrastructure/config/configuration.js';")
    : '';
  const modules = [
    parameters ? "ServiceParametersModule.register(loadConfiguration({ ...process.env, PROFILE: 'test' }))" : null,
    persistence ? "PersistenceModule.register(loadConfiguration({ ...process.env, PROFILE: 'test' }))" : null,
    messaging ? "MessagingModule.register(loadConfiguration({ ...process.env, PROFILE: 'test' }))" : null,
    clients ? "HttpClientsModule.register(loadConfiguration({ ...process.env, PROFILE: 'test' }))" : null,
    scope ? 'SecurityModule' : null,
    'UseCaseModule'
  ]
    .filter(Boolean)
    .join(', ');
  return `import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it, beforeAll } from 'vitest';
import { UseCaseModule } from '../src/infrastructure/usecase/use-case-module.js';
import { UseCaseMediator } from '../src/infrastructure/usecase/use-case-mediator.js';
import { UseCaseContainer } from '../src/infrastructure/usecase/use-case-container.js';
import { Handles } from '../src/application/annotations/application-component.js';
import { Command } from '../src/application/interfaces/messages.js';${persistenceImports}${messagingImport}${scopeImport}${parametersImport}${clientsImport}
${imports}

const OPERATIONS = [
${rows}
] as const;

describe('casos de uso', () => {
  let mediator: UseCaseMediator;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [${modules}] }).compile();
    mediator = moduleRef.get(UseCaseMediator);
  });

  it.each(OPERATIONS)('%s llega a su handler por el mediator', async (_name, type) => {
    // Un mensaje sin construir basta para que el mediator elija handler: la clase es la clave.
    const message = Object.create(type.prototype) as Command;
    const outcome = await mediator.dispatch(message).then(
      () => null,
      (error: unknown) => error
    );
    expect(String(outcome)).not.toMatch(/No hay handler registrado/);
  });

  it('el contenedor se niega a arrancar con un handler que no declara su mensaje', () => {
    class Orphan {
      async handle(): Promise<void> {}
    }
    expect(() => UseCaseContainer.of([new Orphan()])).toThrow(/no declara su mensaje/);
  });

  it('el contenedor se niega a arrancar con dos handlers para el mismo mensaje', () => {
    class Ping extends Command {}
    @Handles(Ping)
    class First {
      async handle(): Promise<void> {}
    }
    @Handles(Ping)
    class Second {
      async handle(): Promise<void> {}
    }
    expect(() => UseCaseContainer.of([new First(), new Second()])).toThrow(/dos handlers/);
  });
});
`;
}

function messagesBody() {
  return `/**
 * Los mensajes que despacha el UseCaseMediator. Son clases abstractas con una marca de tipo (que no
 * existe en ejecución): TypeScript compara por estructura, y sin la marca un Command, una Query y un
 * ReturningCommand serían el mismo tipo vacío.
 */

/** Comando sin valor de retorno. */
export abstract class Command {
  declare readonly __message: 'command';
}

/** Consulta que devuelve un resultado de tipo R. */
export abstract class Query<R> {
  declare readonly __message: 'query';
  declare readonly __result: R;
}

/** Comando que devuelve un resultado de tipo R. */
export abstract class ReturningCommand<R> {
  declare readonly __message: 'returning-command';
  declare readonly __result: R;
}

/** Todo lo que se puede despachar. */
export type Dispatchable = Command | Query<unknown> | ReturningCommand<unknown>;`;
}

function handlersBody() {
  return `export interface CommandHandler<C extends Command> {
  handle(command: C): Promise<void>;
}

export interface QueryHandler<Q extends Query<R>, R> {
  handle(query: Q): Promise<R>;
}

export interface ReturningCommandHandler<C extends ReturningCommand<R>, R> {
  handle(command: C): Promise<R>;
}

/** Cualquier handler registrable en el UseCaseContainer. */
export interface Handler {
  handle(message: never): Promise<unknown>;
}`;
}

function annotationsBody() {
  return `// Marcas de la capa application, SIN Nest: solo ponen metadata en la clase. El cableado lo hace
// infrastructure/usecase/use-case-module.ts, que es quien sí conoce el framework.

const APPLICATION_COMPONENT = Symbol.for('keel.application.component');
const HANDLES = Symbol.for('keel.application.handles');

/** Constructor de un mensaje despachable. */
export type MessageType = abstract new (...args: never[]) => Dispatchable;

/** Marca un componente de la capa application (handler o mapper) sin acoplarlo a Nest. */
export function ApplicationComponent(): ClassDecorator {
  return (target) => {
    Object.defineProperty(target, APPLICATION_COMPONENT, { value: true });
  };
}

/** Declara qué mensaje maneja un handler: TypeScript borra los genéricos, así que se dice aquí. */
export function Handles(message: MessageType): ClassDecorator {
  return (target) => {
    Object.defineProperty(target, HANDLES, { value: message });
  };
}

export function isApplicationComponent(type: object): boolean {
  return (type as Record<symbol, unknown>)[APPLICATION_COMPONENT] === true;
}

export function handledMessageOf(type: object): MessageType | undefined {
  return (type as Record<symbol, MessageType | undefined>)[HANDLES];
}`;
}

function containerBody() {
  return `/**
 * Registro mensaje → handler que alimenta al UseCaseMediator. Se construye UNA vez al arrancar, y
 * falla ahí —no en la primera petición— si un handler no declara su mensaje o si dos reclaman el
 * mismo.
 */
export class UseCaseContainer {
  private readonly handlers = new Map<Function, Handler>();

  static of(handlers: readonly Handler[]): UseCaseContainer {
    const container = new UseCaseContainer();
    for (const handler of handlers) {
      const message = handledMessageOf(handler.constructor);
      if (!message) {
        throw new Error(\`El handler \${handler.constructor.name} no declara su mensaje con @Handles(...)\`);
      }
      const previous = container.handlers.get(message);
      if (previous) {
        throw new Error(\`\${message.name} tiene dos handlers: \${previous.constructor.name} y \${handler.constructor.name}\`);
      }
      container.handlers.set(message, handler);
    }
    return container;
  }

  resolve(message: Dispatchable): Handler {
    const handler = this.handlers.get(message.constructor);
    if (!handler) {
      throw new Error(\`No hay handler registrado para el mensaje \${message.constructor.name}\`);
    }
    return handler;
  }
}`;
}

function mediatorBody(transactional) {
  const transactionDoc = transactional
    ? ` * La frontera transaccional del diseño también vive aquí: cada Query corre en una transacción de
 * SOLO LECTURA y cada Command en una de escritura (TransactionContext), y los adaptadores de
 * repositorio se unen a ella sin que el handler la vea. Una escritura que pierde un interbloqueo se
 * reintenta entera; agotados los intentos, sale como conflicto de concurrencia (409).`
    : ` * La frontera transaccional del diseño (las Query en lectura, los Command en escritura) se instala
 * aquí con la persistencia; los handlers no la verán nunca.`;
  const ctor = transactional
    ? `  constructor(
    @Inject(UseCaseContainer) private readonly container: UseCaseContainer,
    @Inject(TransactionContext) private readonly transactions: TransactionContext
  ) {}`
    : '  constructor(@Inject(UseCaseContainer) private readonly container: UseCaseContainer) {}';
  const without = transactional
    ? '   * confirmar el desenlace).'
    : '   * confirmar el desenlace). Hasta que haya persistencia es el mismo despacho que `dispatch`.';
  const invoke = transactional
    ? 'const result = transactional ? await this.inTransaction(message, () => handler.handle(message as never)) : await handler.handle(message as never);'
    : 'const result = await handler.handle(message as never);';
  const params = transactional ? 'message: Dispatchable, transactional: boolean' : 'message: Dispatchable, _transactional: boolean';
  const transactionHelpers = transactional
    ? `

  /**
   * La transacción del caso de uso. Dentro de una transacción AJENA (un handler que despacha otro por
   * el CommandDispatcher) se une a ella y no reintenta: la del llamante ya quedó marcada para revertir,
   * y repetir el handler ahí solo cambiaría el error por otro más confuso.
   *
   * El reintento repite el handler ENTERO, así que dentro de la transacción no puede haber efectos que
   * salgan del proceso (llamar a un proveedor, mandar un correo): se verían duplicados.
   */
  private async inTransaction<T>(message: Dispatchable, work: () => Promise<T>): Promise<T> {
    const readOnly = message instanceof Query;
    if (readOnly || this.transactions.active) return this.transactions.inTransaction(() => work(), { readOnly });
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactions.inTransaction(() => work());
      } catch (error) {
        if (!isTransientWriteConflict(error)) throw error;
        if (attempt >= WRITE_CONFLICT_ATTEMPTS) throw new WriteConflictExhausted(attempt, error);
        this.log.debug(\`Conflicto de escritura transitorio (intento \${attempt}): se reintenta la transacción\`);
        await pause(attempt);
      }
    }
  }`
    : '';
  const transactionTail = transactional
    ? `

/** Intentos de una transacción de escritura que pierde un conflicto transitorio (interbloqueo). */
const WRITE_CONFLICT_ATTEMPTS = 3;

function pause(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 10)));
}`
    : '';
  return `/**
 * Fachada única de despacho de casos de uso: resuelve el handler registrado para la clase del
 * mensaje y lo invoca. Los controladores dependen solo de este componente, no de los handlers.
 *
 * Es también el único punto por el que pasan TODAS las operaciones —las peticiones HTTP, los
 * barridos programados y los mensajes consumidos—, y por eso es aquí donde vive el LOG DE FRONTERA
 * de cada caso de uso: operación, resultado y duración.
 *
${transactionDoc}
 */
@Injectable()
export class UseCaseMediator {
  private readonly log = new Logger(UseCaseMediator.name);

${ctor}

  dispatch<R>(message: Query<R> | ReturningCommand<R>): Promise<R>;
  dispatch(message: Command): Promise<void>;
  dispatch(message: Dispatchable): Promise<unknown> {
    return this.run(message, true);
  }

  /**
   * Despacha SIN transacción abarcadora: las abre el adaptador de repositorio en cada llamada, así
   * que quien despacha controla dónde cae cada commit. Es para los barridos que llaman a un
   * proveedor EN MEDIO de su trabajo (reclamar y confirmar, llamar fuera de toda transacción,
${without}
   */
  dispatchWithoutTransaction<R>(message: Query<R> | ReturningCommand<R>): Promise<R>;
  dispatchWithoutTransaction(message: Command): Promise<void>;
  dispatchWithoutTransaction(message: Dispatchable): Promise<unknown> {
    return this.run(message, false);
  }

  /**
   * El log de frontera. Solo nombres y códigos, nunca los valores del mensaje: un Command lleva datos
   * de quien llama. Niveles fijos: debug si salió bien, log si el dominio lo rechazó —un 4xx es un
   * resultado esperado— y error si falló. La pila de un fallo NO va aquí: la imprime el adaptador
   * por el que entró, y con las dos cada fallo saldría duplicado.
   */
  private async run(${params}): Promise<unknown> {
    const operation = message.constructor.name;
    const handler = this.container.resolve(message);
    const start = performance.now();
    try {
      ${invoke}
      this.log.debug(\`Caso de uso \${operation}: ok (\${elapsed(start)} ms)\`);
      return result;
    } catch (error) {
      if (error instanceof DomainException) {
        this.log.log(\`Caso de uso \${operation}: rechazado (\${error.code ?? error.name}, \${elapsed(start)} ms)\`);
      } else {
        const type = error instanceof Error ? error.name : typeof error;
        this.log.error(\`Caso de uso \${operation}: falló con \${type} (\${elapsed(start)} ms)\`);
      }
      throw error;
    }
  }${transactionHelpers}
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}${transactionTail}`;
}

/**
 * Las operaciones internas a las que no llega ningún disparador generado: ni `schedule`, ni
 * endpoint, ni suscripción. Solo otro caso de uso puede ejecutarlas, y un handler no llama a otro
 * handler: para eso está el puerto CommandDispatcher (el mismo criterio que keel-spring).
 */
export function orphanInternalOperations(model) {
  const bySubscription = new Set((model.subscriptions ?? []).map((subscription) => subscription.trigger).filter(Boolean));
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter((operation) => operation.internal && !operation.schedule && !bySubscription.has(operation.name));
}

function commandDispatcher(model) {
  const orphans = orphanInternalOperations(model);
  if (orphans.length === 0) return [];
  const names = orphans.map((operation) => operation.name).join(', ');
  const port = `/**
 * Puerto de despacho de OTRO caso de uso desde un handler. Un handler nunca invoca a otro handler
 * directamente; cuando lo necesita, despacha su mensaje por este puerto, que implementa un adaptador
 * de infraestructura sobre el UseCaseMediator.
 *
 * Existe porque el diseño declara ${orphans.length === 1 ? 'una operación interna' : 'operaciones internas'} sin disparador propio
 * (${names}): solo otro caso de uso puede ejecutarla${orphans.length === 1 ? '' : 's'}.
 *
 * Las dos variantes no son intercambiables:
 *   · dispatch: la operación invocada se une a la transacción del llamante. Es lo correcto cuando
 *     todo el trabajo es de base de datos y tiene que ser atómico con el del llamante.
 *   · dispatchWithoutTransaction: la operación invocada abre sus propias transacciones. Es lo
 *     correcto cuando hace I/O externo (un correo, una llamada a un proveedor): bajo la transacción
 *     del llamante, una tanda de N elementos retiene una conexión durante N latencias de un tercero.
 *
 * Es una clase abstracta y no una interfaz porque sirve también de token de inyección.
 */
export abstract class CommandDispatcher {
  abstract dispatch<R>(message: ReturningCommand<R>): Promise<R>;
  abstract dispatch(message: Command): Promise<void>;
  abstract dispatchWithoutTransaction<R>(message: ReturningCommand<R>): Promise<R>;
  abstract dispatchWithoutTransaction(message: Command): Promise<void>;
}`;
  const adapter = `/**
 * Adaptador del puerto CommandDispatcher sobre el UseCaseMediator. Vive en infraestructura porque es
 * aquí donde se conoce el mediator; la capa application solo ve el puerto.
 */
@Injectable()
export class CommandDispatcherAdapter extends CommandDispatcher {
  constructor(@Inject(UseCaseMediator) private readonly mediator: UseCaseMediator) {
    super();
  }

  dispatch<R>(message: ReturningCommand<R>): Promise<R>;
  dispatch(message: Command): Promise<void>;
  dispatch(message: Command | ReturningCommand<unknown>): Promise<unknown> {
    return this.mediator.dispatch(message as Command);
  }

  dispatchWithoutTransaction<R>(message: ReturningCommand<R>): Promise<R>;
  dispatchWithoutTransaction(message: Command): Promise<void>;
  dispatchWithoutTransaction(message: Command | ReturningCommand<unknown>): Promise<unknown> {
    return this.mediator.dispatchWithoutTransaction(message as Command);
  }
}`;
  return [
    {
      path: COMMAND_DISPATCHER_TS,
      content: tsModule(COMMAND_DISPATCHER_TS, [
        { symbol: 'Command', from: MESSAGES_TS, type: true },
        { symbol: 'ReturningCommand', from: MESSAGES_TS, type: true }
      ], port)
    },
    {
      path: COMMAND_DISPATCHER_ADAPTER_TS,
      content: tsModule(COMMAND_DISPATCHER_ADAPTER_TS, [
        { symbol: 'Inject', from: '@nestjs/common' },
        { symbol: 'Injectable', from: '@nestjs/common' },
        { symbol: 'Command', from: MESSAGES_TS, type: true },
        { symbol: 'ReturningCommand', from: MESSAGES_TS, type: true },
        { symbol: 'CommandDispatcher', from: COMMAND_DISPATCHER_TS },
        { symbol: 'UseCaseMediator', from: MEDIATOR_TS }
      ], adapter)
    }
  ];
}

function moduleFile(model, mappers) {
  const handlers = applicationClasses(model);
  const dispatcher = orphanInternalOperations(model).length > 0;
  const imports = [
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'FactoryProvider', from: '@nestjs/common', type: true },
    { symbol: 'InjectionToken', from: '@nestjs/common', type: true },
    { symbol: 'Handler', from: HANDLERS_TS, type: true },
    { symbol: 'UseCaseContainer', from: CONTAINER_TS },
    { symbol: 'UseCaseMediator', from: MEDIATOR_TS },
    ...handlers,
    ...mappers
  ];
  if (dispatcher) {
    imports.push({ symbol: 'CommandDispatcher', from: COMMAND_DISPATCHER_TS }, { symbol: 'CommandDispatcherAdapter', from: COMMAND_DISPATCHER_ADAPTER_TS });
  }
  const list = (items) => (items.length > 0 ? `\n  ${items.map((item) => item.symbol).join(',\n  ')}\n` : '');
  const body = `/** Una clase de la capa application: declara sus dependencias en \`inject\`, en el orden de su constructor. */
type ApplicationClass<T> = (new (...args: never[]) => T) & { readonly inject: readonly InjectionToken[] };

/**
 * Provider de una clase de application. La capa application no importa Nest, así que no puede
 * decorar su constructor con @Inject: declara sus dependencias en \`static inject\` y aquí se
 * construye con ellas.
 */
function applicationProvider<T>(type: ApplicationClass<T>): FactoryProvider<T> {
  return { provide: type, useFactory: (...deps: unknown[]) => new type(...(deps as never[])), inject: [...type.inject] };
}

/** Los handlers de los casos de uso del diseño, uno por operación. */
const HANDLERS = [${list(handlers)}] as const;

/** Los mappers de aplicación que los handlers inyectan. */
const MAPPERS = [${list(mappers)}] as const;

/**
 * El único sitio que cablea los casos de uso: handlers, mappers, el contenedor que los registra y el
 * mediator que los despacha.${dispatcher ? ' También el puerto CommandDispatcher, para las operaciones internas sin disparador.' : ''}
 */
@Module({
  providers: [
    ...MAPPERS.map((type) => applicationProvider<object>(type)),
    ...HANDLERS.map((type) => applicationProvider<Handler>(type)),
    {
      provide: UseCaseContainer,
      useFactory: (...handlers: Handler[]) => UseCaseContainer.of(handlers),
      inject: [...HANDLERS]
    },
    UseCaseMediator${dispatcher ? ',\n    { provide: CommandDispatcher, useClass: CommandDispatcherAdapter }' : ''}
  ],
  exports: [UseCaseMediator${dispatcher ? ', CommandDispatcher' : ''}]
})
export class UseCaseModule {}`;
  return { path: MODULE_TS, content: tsModule(MODULE_TS, imports, body) };
}
