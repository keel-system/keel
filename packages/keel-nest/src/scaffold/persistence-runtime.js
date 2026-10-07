// La persistencia relacional en ejecución: el DataSource de TypeORM configurado por perfil, la
// transacción que abre el UseCaseMediator y que los adaptadores heredan sin verla, y la traducción de
// los errores del motor al contrato.
//
// Todo con los MISMOS nombres y la misma semántica que el servidor de keel-spring del mismo diseño:
//   · las variables de entorno (DB_URL, DB_USERNAME, DB_PASSWORD, DB_POOL_MAX_SIZE,
//     DB_POOL_CONNECTION_TIMEOUT_MS, DB_POOL_MAX_LIFETIME_MS, DB_TRANSACTION_TIMEOUT) y su gradiente
//     por perfil. DB_URL admite la URL JDBC tal cual la escribe un despliegue de keel-spring: el
//     mismo `.env` sirve para los dos servidores;
//   · el esquema: en `local` lo crea el ORM (el `ddl-auto: update` de Hibernate); en develop y
//     production lo gobiernan las migraciones, nunca el ORM;
//   · el tope de transacción → 503 TRANSACTION_TIMEOUT, el interbloqueo reintentado y, agotado, 409;
//     la violación de una constraint con nombre → el error que el diseño declara para ella.
//
// El perfil `test` no tiene base de datos: las pruebas que build deja (el contrato HTTP, el cableado)
// arrancan sin infraestructura, y quien toque un repositorio recibe un error que lo dice. Lo que
// juzga el esquema contra un motor real es `npm run ts-check` de keel-nest, que levanta uno.

import { MIGRATIONS_TABLE } from './infra.js';
import {
  usesRequestIdempotency,
  IDEMPOTENCY_RECORD_ORM_TS,
  IDEMPOTENCY_STORE_TS,
  IDEMPOTENCY_STORE_IMPL_TS
} from './request-idempotency.js';
import {
  constraintErrors,
  declaredConcurrencyError,
  CONCURRENT_MODIFICATION_MESSAGE,
  UNKNOWN_INTEGRITY_MESSAGE,
  TRANSACTION_TIMEOUT_MESSAGE,
  persistedMembers
} from 'keel-core/gen';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { usesRelational, engineOf, ormClass, ormPath, elementClass } from './persistence-entities.js';
import {
  repositoryRoots,
  portClass,
  portPath,
  adapterClass,
  adapterPath,
  TRANSACTION_CONTEXT_TS,
  PERSISTENCE_ERRORS_TS
} from './repositories.js';

export const DATA_SOURCE_OPTIONS_TS = 'src/infrastructure/persistence/data-source-options.ts';
export const PERSISTENCE_MODULE_TS = 'src/infrastructure/persistence/persistence-module.ts';

/** El tope por defecto de una transacción: el mismo que keel-spring (DB_TRANSACTION_TIMEOUT). */
export const DB_TRANSACTION_TIMEOUT = '30s';
/** Cuánto espera una petición a que el pool tenga conexión libre (ms): el mismo que keel-spring. */
export const DB_POOL_CONNECTION_TIMEOUT_MS = 5000;

export function generate(model) {
  if (!usesRelational(model)) return [];
  const dbName = model.service.name.replace(/-/g, '_');
  return [
    ...['local', 'develop', 'production', 'test'].map((profile) => ({
      path: `config/parameters/${profile}/db.yaml`,
      content: dbYaml(model, profile, dbName)
    })),
    { path: DATA_SOURCE_OPTIONS_TS, content: dataSourceOptionsFile(model) },
    { path: TRANSACTION_CONTEXT_TS, content: transactionContextFile(model) },
    { path: PERSISTENCE_ERRORS_TS, content: persistenceErrorsFile(model) },
    { path: PERSISTENCE_MODULE_TS, content: persistenceModuleFile(model) }
  ];
}

// ─── Configuración ───────────────────────────────────────────────────────────

// El gradiente de keel-spring: literal en local (y test), `${VAR:default}` en develop y `${VAR}` sin
// default en production, donde un valor que nadie eligió no deja arrancar.
function envValue(profile, name, local) {
  if (profile === 'local' || profile === 'test') return String(local);
  if (profile === 'develop') return `\${${name}:${local}}`;
  return `\${${name}}`;
}

// Valores operativos (no secretos): con default en todos los perfiles.
function envWithDefault(profile, name, local) {
  return profile === 'local' ? String(local) : `\${${name}:${local}}`;
}

/** La URL de conexión de local: la JDBC que escribe keel-spring para el mismo motor. */
export function localDatabaseUrl(engine, dbName) {
  const db = DATABASES[engine];
  return `jdbc:${engine}://localhost:${db.port}/${dbName}`;
}

function dbYaml(model, profile, dbName) {
  const engine = engineOf(model);
  const db = DATABASES[engine];
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. El esquema contra un motor real lo juzga ts-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URL JDBC de keel-spring vale tal cual (jdbc:${engine}://host:puerto/base): el mismo .env sirve
  # para los dos servidores del diseño.
  url: ${envValue(profile, 'DB_URL', localDatabaseUrl(engine, dbName))}
  username: ${envValue(profile, 'DB_USERNAME', db.user(dbName))}
  password: ${envValue(profile, 'DB_PASSWORD', db.password)}
  pool:
    # El nombre del pool en los logs del driver: con el de por defecto, dos servicios en el mismo
    # backend no se distinguen.
    name: ${model.service.name}-pool
    max-size: ${envWithDefault(profile, 'DB_POOL_MAX_SIZE', 10)}
    # Cuánto espera una petición a que haya conexión libre: fallar rápido con el pool agotado en vez
    # de acumular peticiones que el cliente ya abandonó.
    connection-timeout-ms: ${envWithDefault(profile, 'DB_POOL_CONNECTION_TIMEOUT_MS', DB_POOL_CONNECTION_TIMEOUT_MS)}
    # Vida máxima de una conexión: menor que cualquier corte de ociosas entre el servicio y la base.
    max-lifetime-ms: ${envWithDefault(profile, 'DB_POOL_MAX_LIFETIME_MS', 1800000)}
  # Tope de cada transacción; lo cancelado sale como 503 TRANSACTION_TIMEOUT.
  transaction-timeout: ${envWithDefault(profile, 'DB_TRANSACTION_TIMEOUT', DB_TRANSACTION_TIMEOUT)}
  # ${profile === 'local' ? 'Solo para iterar: en local el ORM crea y altera el esquema.' : 'El esquema lo gobiernan las migraciones de src/migrations/, nunca el ORM.'}
  synchronize: ${profile === 'local'}
  # ${profile === 'local' ? 'En local no hay migraciones que aplicar: el esquema es el de las entidades.' : 'Al arrancar se aplican las migraciones pendientes de src/migrations/ (el baseline lo exporta el pase de calidad).'}
  migrations-run: ${profile !== 'local'}
  show-sql: ${profile === 'local'}
`;
}

// ─── El DataSource ───────────────────────────────────────────────────────────

function dataSourceOptionsFile(model) {
  const engine = engineOf(model);
  const roots = repositoryRoots(model);
  const entities = [];
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    entities.push({ symbol: ormClass(entity.name), from: ormPath(entity.name) });
    for (const member of persistedMembers(model, entity).filter((m) => m.kind === 'elementCollection')) {
      entities.push({ symbol: elementClass(entity, member), from: ormPath(entity.name) });
    }
  }
  // El registro de la idempotencia de petición: una tabla más del esquema, la misma que en keel-spring.
  if (usesRequestIdempotency(model)) entities.push({ symbol: 'IdempotencyRecordOrm', from: IDEMPOTENCY_RECORD_ORM_TS });
  const driverOptions =
    engine === 'postgresql'
      ? `    type: 'postgres',
    host: url.host,
    port: url.port,
    database: url.database,
    username,
    password,
    applicationName: configuration.application.name,
    poolSize: maxSize,
    extra: {
      // node-postgres: la espera por una conexión libre y la vida máxima de una ociosa.
      connectionTimeoutMillis: connectionTimeoutMs,
      maxLifetimeSeconds: Math.max(1, Math.round(maxLifetimeMs / 1000))
    },`
      : `    type: 'mysql',
    host: url.host,
    port: url.port,
    database: url.database,
    username,
    password,
    // Los instantes en UTC en los dos sentidos, y la fecha sin hora como texto: un Date de la zona
    // del proceso movería el día.
    timezone: 'Z',
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: true,
    poolSize: maxSize,
    connectTimeout: connectionTimeoutMs,
    extra: {
      // mysql2: la espera por una conexión libre del pool y la vida de una ociosa.
      maxIdle: maxSize,
      idleTimeout: maxLifetimeMs
    },`;
  const body = `/** La configuración de la base, ya resuelta y validada para el perfil activo. */
export interface DatabaseSettings {
  readonly enabled: boolean;
  readonly transactionTimeoutMs: number;
  readonly options: DataSourceOptions | null;
}

/**
 * Las opciones del DataSource del perfil activo. Una URL que no es del motor del servicio no deja
 * arrancar: conectaría a otra cosa o fallaría en la primera petición, lejos de la causa.
 */
export function databaseSettings(configuration: Configuration): DatabaseSettings {
  const enabled = configuration.get('database.enabled') !== false && configuration.get('database.url') != null;
  const transactionTimeoutMs = toMillis(configuration.get('database.transaction-timeout') ?? '${DB_TRANSACTION_TIMEOUT}');
  if (!enabled) return { enabled: false, transactionTimeoutMs, options: null };

  const url = parseDatabaseUrl(String(configuration.get('database.url')));
  const username = String(configuration.get('database.username'));
  const password = String(configuration.get('database.password'));
  const maxSize = Number(configuration.get('database.pool.max-size') ?? 10);
  const connectionTimeoutMs = Number(configuration.get('database.pool.connection-timeout-ms') ?? ${DB_POOL_CONNECTION_TIMEOUT_MS});
  const maxLifetimeMs = Number(configuration.get('database.pool.max-lifetime-ms') ?? 1800000);
  const options: DataSourceOptions = {
${driverOptions}
    entities: ENTITIES,
    synchronize: configuration.get('database.synchronize') === true || configuration.get('database.synchronize') === 'true',
    // El esquema fuera de local: las migraciones de src/migrations/, compiladas a dist/ (su README).
    migrations: ['dist/migrations/*.js'],
    migrationsRun: configuration.get('database.migrations-run') === true || configuration.get('database.migrations-run') === 'true',
    // El historial con nombre propio: infra/reset-db.sh lo respeta por nombre (ver infra.js).
    migrationsTableName: '${MIGRATIONS_TABLE}',
    logging: configuration.get('database.show-sql') === true || configuration.get('database.show-sql') === 'true' ? ['query', 'error'] : ['error']
  };
  return { enabled: true, transactionTimeoutMs, options };
}

/** Las entidades del esquema: las tablas de las raíces, de sus hijas y de sus listas. */
export const ENTITIES = [${entities.map((entity) => entity.symbol).join(', ')}];

export interface DatabaseUrl {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

/**
 * \`jdbc:${engine}://host:puerto/base?…\` o \`${engine === 'postgresql' ? 'postgres' : 'mysql'}://host:puerto/base\`. Los parámetros de la
 * URL no se trasladan: los que importan tienen su propia variable.
 */
export function parseDatabaseUrl(raw: string): DatabaseUrl {
  const text = raw.trim().replace(/^jdbc:/, '');
  const match = /^(\\w+):\\/\\/([^/:?]+)(?::(\\d+))?\\/([^?;]+)/.exec(text);
  const scheme = match?.[1]?.toLowerCase();
  if (!match || !${tsString(engine === 'postgresql' ? 'postgresql|postgres' : 'mysql')}.split('|').includes(scheme ?? '')) {
    throw new Error(\`database.url no es una URL de ${DATABASES[engine].label}: '\${raw}' (usa jdbc:${engine}://host:puerto/base)\`);
  }
  return { host: match[2]!, port: Number(match[3] ?? ${DATABASES[engine].port}), database: decodeURIComponent(match[4]!) };
}
`;
  return tsModule(
    DATA_SOURCE_OPTIONS_TS,
    [
      { symbol: 'DataSourceOptions', from: 'typeorm', type: true },
      { symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true },
      { symbol: 'toMillis', from: 'src/infrastructure/config/configuration.ts' },
      ...entities
    ],
    body
  );
}

// ─── La transacción ──────────────────────────────────────────────────────────

function transactionContextFile(model) {
  const engine = engineOf(model);
  // Lo que cada motor necesita al abrir: solo lectura y el tope de cada sentencia.
  const prepare =
    engine === 'postgresql'
      ? `    // Solo lectura primero: SET TRANSACTION tiene que ir antes de cualquier consulta.
    if (readOnly) await runner.query('SET TRANSACTION READ ONLY');
    // El tope de cada sentencia de la transacción, espera de bloqueo incluida (57014 al cortarla).
    await runner.query(\`SET LOCAL statement_timeout = \${this.settings.transactionTimeoutMs}\`);`
      : `    // MySQL: SET TRANSACTION afecta a la SIGUIENTE transacción, así que va antes de abrirla. El
    // tope: la espera de bloqueo (1205) y las lecturas (3024); las dos salen como 503.
    const seconds = Math.max(1, Math.ceil(this.settings.transactionTimeoutMs / 1000));
    await runner.query(\`SET SESSION innodb_lock_wait_timeout = \${seconds}\`);
    await runner.query(\`SET SESSION max_execution_time = \${this.settings.transactionTimeoutMs}\`);
    await runner.query(readOnly ? 'SET TRANSACTION READ ONLY' : 'SET TRANSACTION READ WRITE');`;
  const open = engine === 'postgresql' ? `    await runner.startTransaction();\n${prepare}` : `${prepare}\n    await runner.startTransaction();`;
  const body = `/** Token del DataSource de TypeORM (null en el perfil test, que no tiene base de datos). */
export const DATA_SOURCE = Symbol('DATA_SOURCE');

/** Token de la configuración de la base ya resuelta. */
export const DATABASE_SETTINGS = Symbol('DATABASE_SETTINGS');

export interface TransactionOptions {
  readonly readOnly?: boolean;
}

/**
 * La transacción en curso, propagada con AsyncLocalStorage: la abre el UseCaseMediator y los
 * adaptadores de repositorio la toman de aquí sin que el handler la vea ni la pase. Es lo que en
 * keel-spring hace el TransactionSynchronizationManager.
 */
@Injectable()
export class TransactionContext {
  private readonly storage = new AsyncLocalStorage<EntityManager>();

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource | null,
    @Inject(DATABASE_SETTINGS) private readonly settings: DatabaseSettings
  ) {}

  /** ¿Hay una transacción abierta en este flujo? */
  get active(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** El EntityManager de la transacción en curso; fuera de ella, el del DataSource (sentencia suelta). */
  manager(): EntityManager {
    return this.storage.getStore() ?? this.source().manager;
  }

  /**
   * Ejecuta \`work\` en una transacción: la ABIERTA si la hay (se une a ella, como la propagación por
   * defecto de Spring) o una nueva, que confirma si \`work\` termina y revierte si lanza.
   */
  async inTransaction<T>(work: (manager: EntityManager) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const current = this.storage.getStore();
    if (current) return work(current);
    const readOnly = options.readOnly === true;
    const runner = this.source().createQueryRunner();
    await runner.connect();
    try {
${open.replace(/^/gm, '  ')}
      try {
        const result = await this.storage.run(runner.manager, () => work(runner.manager));
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      }
    } finally {
      await runner.release();
    }
  }

  private source(): DataSource {
    if (this.dataSource == null) {
      throw new Error('Sin base de datos en este perfil (database.enabled: false): el perfil test no la tiene.');
    }
    return this.dataSource;
  }
}`;
  return tsModule(
    TRANSACTION_CONTEXT_TS,
    [
      { symbol: 'AsyncLocalStorage', from: 'node:async_hooks' },
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'DataSource', from: 'typeorm', type: true },
      { symbol: 'EntityManager', from: 'typeorm', type: true },
      { symbol: 'DatabaseSettings', from: DATA_SOURCE_OPTIONS_TS, type: true }
    ],
    body
  );
}

// ─── Errores del motor ───────────────────────────────────────────────────────

/** Los códigos de cada motor, por familia. */
const ENGINE_CODES = {
  postgresql: {
    // Clase 23: violaciones de integridad (unicidad 23505, FK 23503, NOT NULL 23502, CHECK 23514).
    integrity: "code.startsWith('23')",
    // Interbloqueo y fallo de serialización: se arreglan repitiendo la transacción.
    transient: "code === '40P01' || code === '40001'",
    // Sentencia cancelada por statement_timeout (también la espera de un bloqueo).
    timeout: "code === '57014' || code === '55P03'"
  },
  mysql: {
    // ER_DUP_ENTRY, FK (1451 padre referenciado, 1452 hija sin padre), NOT NULL, dato demasiado largo.
    integrity: "['1062', '1451', '1452', '1048', '1364', '1406', '3819'].includes(code)",
    // ER_LOCK_DEADLOCK.
    transient: "code === '1213'",
    // Espera de bloqueo agotada (1205) y lectura cortada por max_execution_time (3024).
    timeout: "code === '1205' || code === '3024'"
  }
};

function persistenceErrorsFile(model) {
  const engine = engineOf(model);
  const codes = ENGINE_CODES[engine];
  const entries = constraintErrors(model);
  const concurrency = declaredConcurrencyError(model);
  const imports = [
    { symbol: 'QueryFailedError', from: 'typeorm' },
    { symbol: 'ConflictException', from: classPath(DIRS.errors, 'ConflictException') },
    { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS, type: true }
  ];
  if (concurrency) imports.push({ symbol: concurrency.exceptionClass, from: classPath(DIRS.errors, concurrency.exceptionClass) });
  for (const entry of entries) {
    if (entry.declared) imports.push({ symbol: entry.declared.exceptionClass, from: classPath(DIRS.errors, entry.declared.exceptionClass) });
  }
  const concurrencyError = concurrency
    ? `new ${concurrency.exceptionClass}(${tsString(CONCURRENT_MODIFICATION_MESSAGE)})`
    : // `details: []` y no null: es lo que responde el handler de keel-spring para este conflicto.
      `new ConflictException(${tsString(CONCURRENT_MODIFICATION_MESSAGE)}, { code: ${tsString(FRAMEWORK_ERRORS.concurrency.code)}, httpStatus: 409, details: [] })`;
  const rows = entries.map((entry) => {
    const build = entry.declared
      ? `new ${entry.declared.exceptionClass}(${tsString(entry.message)})`
      : `new ConflictException(${tsString(entry.message)}, { code: ${tsString(entry.code)}, httpStatus: 409 })`;
    const why = entry.reference
      ? `Referencia entre agregados (${entry.reference.table}.${entry.reference.column} → ${entry.reference.refTable}): el desenlace de negocio de borrar el padre.`
      : entry.named
        ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño NOMBRA para ella.`
        : entry.raceOnly
          ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: solo una carrera la rompe, así que es conflicto de concurrencia.`
          : entry.declared
            ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño declara para ella.`
            : `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el diseño no nombra un error para ella, así que sale con el code CANÓNICO de la familia uniqueness (docs/framework-errors.md). No es un hueco que reportar: para cambiarlo, decláralo en los errors de la operación que escribe, con 409 y un code de su familia.`;
    return `  // ${why}\n  [${tsString(entry.constraint.toLowerCase())}, () => ${build}]`;
  });
  const body = `/**
 * Conflicto de bloqueo optimista: otra escritura subió la versión del agregado (o lo borró) entre que
 * este lo leyó y lo guardó. Es un 409 y NO se reintenta: reaplicar la intención del cliente sobre un
 * estado que no vio escondería la actualización perdida.
 */
export class OptimisticLockConflict extends Error {
  constructor(readonly entity: string, readonly id: string) {
    super(\`\${entity} \${id}: la versión cambió desde que se leyó\`);
    this.name = 'OptimisticLockConflict';
  }
}

/** Un conflicto de escritura transitorio (interbloqueo) que agotó sus reintentos: sale como 409. */
export class WriteConflictExhausted extends Error {
  constructor(attempts: number, cause: unknown) {
    super(\`Conflicto de escritura concurrente tras \${attempts} intentos\`, { cause });
    this.name = 'WriteConflictExhausted';
  }
}

/** El código del motor de un fallo de TypeORM (SQLSTATE en PostgreSQL, errno en MySQL), o null. */
function engineCode(error: unknown): string | null {
  for (let cause: unknown = error, depth = 0; cause != null && depth < 5; depth++) {
    if (cause instanceof QueryFailedError) {
      const driver = cause.driverError as { code?: unknown; errno?: unknown } | undefined;
      const code = ${engine === 'postgresql' ? 'driver?.code' : 'driver?.errno'};
      if (code != null) return String(code);
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return null;
}

/** El texto del motor, donde viaja el nombre de la constraint violada. */
function engineDetail(error: unknown): string {
  const driver = error instanceof QueryFailedError ? (error.driverError as Record<string, unknown> | undefined) : undefined;
  return [driver?.constraint, driver?.detail, driver?.sqlMessage, error instanceof Error ? error.message : String(error)]
    .filter((part) => part != null)
    .join(' ')
    .toLowerCase();
}

/** ¿Un interbloqueo o un fallo de serialización? Se arregla repitiendo la transacción entera. */
export function isTransientWriteConflict(error: unknown): boolean {
  const code = engineCode(error);
  return code != null && (${codes.transient});
}

/** ¿El motor cortó la sentencia por el tope de la transacción? */
export function isTransactionTimeout(error: unknown): boolean {
  const code = engineCode(error);
  return code != null && (${codes.timeout});
}

/** ¿Una violación de integridad (unicidad, FK, NOT NULL)? */
export function isIntegrityViolation(error: unknown): boolean {
  const code = engineCode(error);
  return code != null && (${codes.integrity});
}

/** El tope de transacción: transitorio y la transacción revirtió entera, así que reintentar es seguro. */
export const TRANSACTION_TIMEOUT = { status: ${FRAMEWORK_ERRORS.transactionTimeout.http}, code: ${tsString(FRAMEWORK_ERRORS.transactionTimeout.code)}, message: ${tsString(TRANSACTION_TIMEOUT_MESSAGE)} } as const;

/** Una violación de integridad sin constraint conocida: 409 sin \`code\`, como keel-spring. */
export const UNKNOWN_INTEGRITY = { status: 409, message: ${tsString(UNKNOWN_INTEGRITY_MESSAGE)} } as const;

/**
 * Nombre de constraint (en minúsculas) → el error que representa violarla. Los nombres los pone el
 * esquema (keel-core/gen/relational.js) y el error, con su mensaje, keel-core/gen/constraint-errors.js:
 * los dos servidores del diseño traducen la misma violación al mismo error.
 */
const CONSTRAINT_TO_ERROR: ReadonlyArray<readonly [string, () => DomainException]> = [
${rows.join(',\n')}
];

/**
 * El error del contrato de un fallo de persistencia, o null si no es de persistencia:
 *   · conflicto de versión o interbloqueo agotado → 409 de concurrencia (el del diseño si lo declara);
 *   · violación de una constraint conocida → su error; desconocida → \`'integrity'\` (409 genérico);
 *   · tope de transacción → \`'timeout'\` (503 con Retry-After).
 */
export function translatePersistenceError(error: unknown): DomainException | 'integrity' | 'timeout' | null {
  if (error instanceof OptimisticLockConflict || error instanceof WriteConflictExhausted) {
    return ${concurrencyError};
  }
  if (isTransactionTimeout(error)) return 'timeout';
  if (isIntegrityViolation(error)) {
    const detail = engineDetail(error);
    for (const [constraint, build] of CONSTRAINT_TO_ERROR) {
      if (detail.includes(constraint)) return build();
    }
    return 'integrity';
  }
  return null;
}`;
  return tsModule(PERSISTENCE_ERRORS_TS, imports, body);
}

// ─── El módulo ───────────────────────────────────────────────────────────────

function persistenceModuleFile(model) {
  const roots = repositoryRoots(model);
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'Logger', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'OnApplicationShutdown', from: '@nestjs/common', type: true },
    { symbol: 'DataSource', from: 'typeorm' },
    { symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true },
    { symbol: 'databaseSettings', from: DATA_SOURCE_OPTIONS_TS },
    { symbol: 'DATA_SOURCE', from: TRANSACTION_CONTEXT_TS },
    { symbol: 'DATABASE_SETTINGS', from: TRANSACTION_CONTEXT_TS },
    { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }
  ];
  for (const entity of roots) {
    imports.push({ symbol: portClass(entity), from: portPath(entity) });
    imports.push({ symbol: adapterClass(entity), from: adapterPath(entity) });
  }
  const bindings = roots.map((entity) => `    { provide: ${portClass(entity)}, useClass: ${adapterClass(entity)} }`);
  const ports = roots.map((entity) => portClass(entity));
  // El puerto del registro de idempotencia: lo inyectan los handlers de las operaciones que lo usan.
  if (usesRequestIdempotency(model)) {
    imports.push({ symbol: 'IdempotencyStore', from: IDEMPOTENCY_STORE_TS }, { symbol: 'IdempotencyStoreImpl', from: IDEMPOTENCY_STORE_IMPL_TS });
    bindings.push('    { provide: IdempotencyStore, useClass: IdempotencyStoreImpl }');
    ports.push('IdempotencyStore');
  }
  const body = `/** Cierra el pool al apagar: después de que el servidor HTTP deje de aceptar y drene. */
@Injectable()
class DataSourceShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger('Persistence');

  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
      this.logger.log('Pool de conexiones cerrado');
    }
  }
}

/**
 * La persistencia relacional: el DataSource del perfil, la transacción que propaga el mediator y un
 * adaptador por puerto. Global: los handlers de application inyectan los puertos sin importarla.
 *
 * El DataSource se inicializa al ARRANCAR: una base inalcanzable o un esquema que el ORM no sabe
 * mapear tumba el arranque, no la primera petición.
 */
@Global()
@Module({})
export class PersistenceModule {
  static register(configuration: Configuration): DynamicModule {
    const settings = databaseSettings(configuration);
    return {
      module: PersistenceModule,
      providers: [
        { provide: DATABASE_SETTINGS, useValue: settings },
        {
          provide: DATA_SOURCE,
          useFactory: async () => (settings.options == null ? null : new DataSource(settings.options).initialize())
        },
        TransactionContext,
        DataSourceShutdown,
${bindings.join(',\n')}
      ],
      exports: [TransactionContext, DATA_SOURCE${ports.length > 0 ? `, ${ports.join(', ')}` : ''}]
    };
  }
}`;
  return tsModule(PERSISTENCE_MODULE_TS, imports, body);
}
