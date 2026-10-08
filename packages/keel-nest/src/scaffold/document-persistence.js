// La persistencia DOCUMENTAL en ejecución (incremento 12): el cliente de MongoDB configurado por
// perfil, la transacción que abre el UseCaseMediator y que los adaptadores heredan sin verla, los
// índices que el servidor crea al arrancar y la traducción de los errores del motor al contrato.
//
// Emite los MISMOS archivos que la rama relacional (persistence-runtime.js) para la transacción, los
// errores y el módulo, con la misma forma: el mediator, el filtro de errores y el módulo raíz no
// distinguen qué almacén tienen debajo. Lo que cambia es lo de dentro, y es lo que hace keel-spring
// sobre el mismo diseño:
//   · `DB_URL` es la URI de MongoDB de keel-spring tal cual —el mismo `.env` sirve a los dos
//     servidores—; el driver de Node rechaza `uuidRepresentation` (medido: MongoParseError), así que
//     se quita al leerla: aquí un uuid es SIEMPRE binario de subtipo 4, que es lo que esa opción pide;
//   · el agregado es el documento (keel-core/gen/document.js): las hijas van anidadas, un value
//     object es un subdocumento, decimal como Decimal128, uuid como binario estándar;
//   · las transacciones multidocumento solo existen sobre un replica set, que es como arranca
//     infra/ incluso en local; dos escrituras sobre el mismo documento no esperan: la segunda aborta
//     con un WriteConflict transitorio, que el mediator reintenta y, agotado, es un 409;
//   · los índices los crea el servidor al ARRANCAR, con los nombres del diseño: el traductor de
//     errores encuentra el `code` declarado buscando ese nombre en el mensaje E11000;
//   · no hay tope de transacción ni 503: keel-spring no lo aplica en Mongo, y la transacción tiene
//     el límite de vida del servidor.
//
// El perfil `test` no tiene base de datos, como en la rama relacional.

import {
  constraintErrors,
  declaredConcurrencyError,
  CONCURRENT_MODIFICATION_MESSAGE,
  UNKNOWN_INTEGRITY_MESSAGE,
  TRANSACTION_TIMEOUT_MESSAGE
} from 'keel-core/gen';
import { documentIndexes, exportIndexesScript } from 'keel-core/gen/document';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { usesDocument, usesTextFold, textFoldFile, TEXT_FOLD_TS } from './persistence-entities.js';
import { repositoryRoots, portClass, portPath, adapterClass, adapterPath, TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';
import { PERSISTENCE_MODULE_TS } from './persistence-runtime.js';
import { reconciliationBindings } from './reconciliation-claim.js';
import { SWEEP_SETTINGS_TS, usesSweepClaims } from './claim.js';
import { usesRequestIdempotency, IDEMPOTENCY_STORE_TS, IDEMPOTENCY_STORE_IMPL_TS } from './request-idempotency.js';

export const MONGO_SETTINGS_TS = 'src/infrastructure/persistence/mongo-settings.ts';
export const DOCUMENT_INDEXES_TS = 'src/infrastructure/persistence/document-indexes.ts';
export const BSON_VALUES_TS = 'src/infrastructure/persistence/bson-values.ts';

/** La pieza que crea los índices y la que traduce sus violaciones, como las nombra export-indexes.sh. */
const PLATFORM = { indexCreator: 'document-indexes.ts', errorTranslator: 'ApiExceptionFilter' };

export function generate(model) {
  if (!usesDocument(model)) return [];
  const dbName = model.service.name.replace(/-/g, '_');
  const files = [
    ...['local', 'develop', 'production', 'test'].map((profile) => ({
      path: `config/parameters/${profile}/db.yaml`,
      content: dbYaml(profile, dbName)
    })),
    { path: MONGO_SETTINGS_TS, content: mongoSettingsFile() },
    { path: BSON_VALUES_TS, content: bsonValuesFile() },
    { path: DOCUMENT_INDEXES_TS, content: documentIndexesFile(model) },
    { path: TRANSACTION_CONTEXT_TS, content: transactionContextFile() },
    { path: PERSISTENCE_ERRORS_TS, content: persistenceErrorsFile(model) },
    { path: PERSISTENCE_MODULE_TS, content: persistenceModuleFile(model) },
    { path: 'infra/export-indexes.sh', content: exportIndexesScript(model, PLATFORM) }
  ];
  if (usesTextFold(model)) files.push({ path: TEXT_FOLD_TS, content: textFoldFile() });
  return files;
}

// ─── Configuración ───────────────────────────────────────────────────────────

/** La URI de local: la MISMA que escribe keel-spring para el mismo servicio (src/lib/java-stack.js). */
export function localMongoUrl(dbName) {
  const db = DATABASES.mongodb;
  return `mongodb://${db.user(dbName)}:${db.password}@localhost:${db.port}/${dbName}?authSource=admin&directConnection=true&uuidRepresentation=standard`;
}

function dbYaml(profile, dbName) {
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. Los documentos contra un MongoDB real los juzga db-check.
database:
  enabled: false
`;
  }
  // El gradiente de keel-spring: literal en local, con default en develop, sin default en production.
  const url = profile === 'local' ? localMongoUrl(dbName) : profile === 'develop' ? `\${DB_URL:${localMongoUrl(dbName)}}` : '${DB_URL}';
  return `database:
  # La URI de MongoDB de keel-spring vale tal cual: el mismo .env sirve para los dos servidores del
  # diseño. Toda la configuración de la conexión viaja en ella (credenciales, replica set o conexión
  # directa); \`uuidRepresentation\` se ignora porque aquí un uuid es siempre binario estándar.
  url: ${url}
  # Los índices los crea el servidor al arrancar, derivados enteros de persistence.keel.yaml y con
  # los nombres del diseño (src/infrastructure/persistence/document-indexes.ts).
`;
}

function mongoSettingsFile() {
  const body = `/** La configuración del almacén, ya resuelta y validada para el perfil activo. */
export interface DatabaseSettings {
  readonly enabled: boolean;
  /** La URI que se le da al driver (sin las opciones que solo entiende el de Java). */
  readonly url: string | null;
  /** La base del servicio: la de la ruta de la URI. */
  readonly database: string | null;
}

/**
 * Las opciones del cliente del perfil activo. Una URI que no es de MongoDB, o sin base en su ruta, no
 * deja arrancar: conectaría a otra cosa o escribiría en la base \`test\` del servidor, lejos de la causa.
 */
export function databaseSettings(configuration: Configuration): DatabaseSettings {
  const enabled = configuration.get('database.enabled') !== false && configuration.get('database.url') != null;
  if (!enabled) return { enabled: false, url: null, database: null };
  const raw = String(configuration.get('database.url'));
  return { enabled: true, url: driverUrl(raw), database: databaseOf(raw) };
}

/**
 * Las opciones de la URI que el driver de Java entiende y el de Node rechaza al construir el cliente
 * (\`MongoParseError: option … is not supported\`). Se quitan para que la MISMA \`DB_URL\` sirva a los dos
 * servidores, y solo estas: una opción desconocida que no esté aquí sigue fallando al arrancar.
 */
const JAVA_ONLY_OPTIONS = new Set(['uuidrepresentation']);

export function driverUrl(raw: string): string {
  const text = raw.trim();
  if (!/^mongodb(\\+srv)?:\\/\\//i.test(text)) {
    throw new Error(\`database.url no es una URI de MongoDB: '\${raw}' (usa mongodb://usuario:clave@host:27017/base)\`);
  }
  const query = text.indexOf('?');
  if (query < 0) return text;
  const kept = text
    .slice(query + 1)
    .split('&')
    .filter((pair) => pair !== '' && !JAVA_ONLY_OPTIONS.has(pair.split('=')[0]!.toLowerCase()));
  return kept.length > 0 ? \`\${text.slice(0, query)}?\${kept.join('&')}\` : text.slice(0, query);
}

export function databaseOf(raw: string): string {
  const match = /^mongodb(?:\\+srv)?:\\/\\/[^/]+\\/([^?]+)/i.exec(raw.trim());
  if (!match || match[1] === '') {
    throw new Error(\`database.url no nombra la base del servicio en su ruta: '\${raw}'\`);
  }
  return decodeURIComponent(match[1]);
}
`;
  return tsModule(MONGO_SETTINGS_TS, [{ symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true }], body);
}

// ─── Valores BSON ────────────────────────────────────────────────────────────

function bsonValuesFile() {
  const body = `/**
 * Un documento guardado: su \`_id\` es el id del agregado (un uuid binario, o el texto de un id que no es
 * uuid) y no el ObjectId que el driver da por defecto; el resto de claves, las del contrato.
 */
export interface StoredDocument {
  _id: UUID | string;
  [key: string]: any;
}

/**
 * Un documento de un almacén del generador con el tipo de su \`_id\`: el subdocumento de una clave compuesta
 * (processed_event, idempotency_record) o la clave aplanada (reconciliation_claim).
 */
export interface KeyedDocument<K> {
  _id: K;
  [key: string]: any;
}

/**
 * Lo que lleva cada valor entre el dominio y el documento sin perder nada por el camino, con la
 * representación física del contrato (keel-core/gen/document.js) —la que escribe y lee también el
 * servidor de keel-spring del mismo diseño—:
 *   · uuid como binario de subtipo 4, no como texto;
 *   · decimal como Decimal128 con su escala (\`2.50\` sigue siendo \`2.50\`), nunca un number binario;
 *   · un entero de 64 bits como Int64 (el dominio lo lleva como bigint);
 *   · una fecha sin hora como la medianoche UTC de ese día: el día no tiene zona;
 *   · un \`json\` embebido como su texto, y un enum por el NOMBRE de su constante.
 * Todas aceptan null (y lo devuelven): un campo opcional ausente se guarda como null.
 */

export function toUuid(value: string): UUID;
export function toUuid(value: string | null | undefined): UUID | null;
export function toUuid(value: string | null | undefined): UUID | null {
  return value == null ? null : new UUID(value);
}

export function fromUuid(value: Binary | UUID): string;
export function fromUuid(value: Binary | UUID | null | undefined): string | null;
export function fromUuid(value: Binary | UUID | null | undefined): string | null {
  if (value == null) return null;
  return (value instanceof UUID ? value : value.toUUID()).toHexString(true);
}

export function toDecimal128(value: Decimal): Decimal128;
export function toDecimal128(value: Decimal | null | undefined): Decimal128 | null;
export function toDecimal128(value: Decimal | null | undefined): Decimal128 | null {
  return value == null ? null : Decimal128.fromString(value.toString());
}

export function fromDecimal128(value: Decimal128): Decimal;
export function fromDecimal128(value: Decimal128 | null | undefined): Decimal | null;
export function fromDecimal128(value: Decimal128 | null | undefined): Decimal | null {
  return value == null ? null : Decimal.parse(value.toString());
}

export function toInt64(value: bigint): bigint;
export function toInt64(value: bigint | null | undefined): bigint | null;
export function toInt64(value: bigint | null | undefined): bigint | null {
  return value == null ? null : BigInt.asIntN(64, value);
}

/** Int64 → bigint, también si llegó como number (un Int32 escrito por otro cliente) o como Long. */
export function fromInt64(value: bigint | number | Long): bigint;
export function fromInt64(value: bigint | number | Long | null | undefined): bigint | null;
export function fromInt64(value: bigint | number | Long | null | undefined): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  return typeof value === 'number' ? BigInt(value) : value.toBigInt();
}

/** 'YYYY-MM-DD' → la medianoche UTC de ese día. */
export function toDay(value: string): Date;
export function toDay(value: string | null | undefined): Date | null;
export function toDay(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(\`\${value.slice(0, 10)}T00:00:00.000Z\`);
}

/** La medianoche UTC de un día → 'YYYY-MM-DD'. */
export function fromDay(value: Date): string;
export function fromDay(value: Date | null | undefined): string | null;
export function fromDay(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString().slice(0, 10);
}

export function toJsonText(value: RawJson): string;
export function toJsonText(value: RawJson | null | undefined): string | null;
export function toJsonText(value: RawJson | null | undefined): string | null {
  return value == null ? null : value.text;
}

export function fromJsonText(value: string): RawJson;
export function fromJsonText(value: string | null | undefined): RawJson | null;
export function fromJsonText(value: string | null | undefined): RawJson | null {
  return value == null ? null : RawJson.of(value);
}

/**
 * Un enum por el NOMBRE de su constante (\`ACTIVE\`), como lo guarda keel-spring: el valor del enum de
 * TypeScript es el literal del cable (\`active\`).
 */
export function toEnumName<E extends Record<string, string>>(type: E, value: E[keyof E]): string;
export function toEnumName<E extends Record<string, string>>(type: E, value: E[keyof E] | null | undefined): string | null;
export function toEnumName<E extends Record<string, string>>(type: E, value: E[keyof E] | null | undefined): string | null {
  if (value == null) return null;
  const found = Object.entries(type).find(([, literal]) => literal === value);
  return found ? found[0] : String(value);
}

/** Un nombre que el enum no tiene es un dato que no casa con el diseño, y se dice. */
export function fromEnumName<E extends Record<string, string>>(type: E, name: string): E[keyof E];
export function fromEnumName<E extends Record<string, string>>(type: E, name: string | null | undefined): E[keyof E] | null;
export function fromEnumName<E extends Record<string, string>>(type: E, name: string | null | undefined): E[keyof E] | null {
  if (name == null) return null;
  const value = (type as Record<string, string>)[name];
  if (value === undefined) throw new Error(\`Valor de enum desconocido en la base: '\${name}'\`);
  return value as E[keyof E];
}
`;
  return tsModule(
    BSON_VALUES_TS,
    [
      { symbol: 'Binary', from: 'mongodb' },
      { symbol: 'Decimal128', from: 'mongodb' },
      { symbol: 'UUID', from: 'mongodb' },
      { symbol: 'Long', from: 'mongodb', type: true },
      { symbol: 'Decimal', from: 'src/domain/support/decimal.ts' },
      { symbol: 'RawJson', from: 'src/domain/support/raw-json.ts' }
    ],
    body
  );
}

// ─── Índices ─────────────────────────────────────────────────────────────────

function documentIndexesFile(model) {
  const entries = documentIndexes(model, model.warnings).map(({ collection, specs }) => {
    const indexes = specs.map((spec) => {
      const keys = spec.paths.map((path) => `${tsString(path)}: 1`).join(', ');
      const options = [`name: ${tsString(spec.name)}`];
      if (spec.unique) options.push('unique: true');
      if (spec.partialFilter) options.push(`partialFilterExpression: { ${tsString(spec.partialFilter.path)}: ${JSON.stringify(spec.partialFilter.equals)} }`);
      return `      { keys: { ${keys} }, options: { ${options.join(', ')} } }`;
    });
    return `  {\n    collection: ${tsString(collection)},\n    indexes: [\n${indexes.join(',\n')}\n    ]\n  }`;
  });
  const body = `/**
 * Los índices de las colecciones del servicio, derivados de persistence.keel.yaml (clave natural,
 * campos únicos e índices declarados, con su filtro parcial si el diseño los condiciona al estado)
 * y de los almacenes del generador. Son los MISMOS, con los MISMOS nombres, que crea el servidor de
 * keel-spring del diseño (keel-core/gen/document.js): el traductor de errores encuentra el \`code\`
 * declarado buscando el nombre \`uk_*\` en el mensaje E11000 del driver.
 *
 * Se crean al ARRANCAR y fuera de toda transacción (MongoDB no crea índices dentro de una).
 * \`createIndex\` es idempotente mientras la definición no cambie; si un índice cambia de forma hay que
 * borrarlo antes: el motor rechaza recrear el mismo nombre con otras claves, y el arranque falla
 * diciéndolo. Verificarlos contra los vivos: \`bash infra/export-indexes.sh\`.
 */
export const DOCUMENT_INDEXES: ReadonlyArray<{
  readonly collection: string;
  readonly indexes: ReadonlyArray<{ readonly keys: IndexSpecification; readonly options: CreateIndexesOptions }>;
}> = [
${entries.join(',\n')}
];

export async function ensureDocumentIndexes(db: Db): Promise<void> {
  for (const { collection, indexes } of DOCUMENT_INDEXES) {
    for (const { keys, options } of indexes) await db.collection(collection).createIndex(keys, options);
  }
}
`;
  return tsModule(
    DOCUMENT_INDEXES_TS,
    [
      { symbol: 'CreateIndexesOptions', from: 'mongodb', type: true },
      { symbol: 'Db', from: 'mongodb', type: true },
      { symbol: 'IndexSpecification', from: 'mongodb', type: true }
    ],
    body
  );
}

// ─── La transacción ──────────────────────────────────────────────────────────

function transactionContextFile() {
  const body = `/** Token del cliente de MongoDB (null en el perfil test, que no tiene base de datos). */
export const MONGO_CLIENT = Symbol('MONGO_CLIENT');

/**
 * El manejador del almacén con el nombre común a las dos ramas: lo inyectan el relay del outbox y las purgas
 * para saber si hay base (null en el perfil test). Es el MISMO token que MONGO_CLIENT.
 */
export const DATA_SOURCE = MONGO_CLIENT;

/** Token de la configuración del almacén ya resuelta. */
export const DATABASE_SETTINGS = Symbol('DATABASE_SETTINGS');

export interface TransactionOptions {
  readonly readOnly?: boolean;
}

/** Lo que sigue a una transacción abierta: su sesión y lo que espera a su commit. */
interface TransactionFrame {
  readonly session: ClientSession;
  readonly afterCommit: Array<() => unknown>;
}

/**
 * La transacción en curso, propagada con AsyncLocalStorage: la abre el UseCaseMediator y los
 * adaptadores de repositorio toman de aquí su sesión sin que el handler la vea ni la pase. Es lo que
 * en keel-spring hace el MongoTransactionManager.
 *
 * Las transacciones multidocumento solo existen sobre un replica set (infra/ lo arranca así incluso
 * en local): es lo que hace que el documento del agregado y lo que se escribe con él confirmen juntos.
 */
@Injectable()
export class TransactionContext {
  private readonly storage = new AsyncLocalStorage<TransactionFrame>();
  private readonly logger = new Logger('TransactionContext');

  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient | null,
    @Inject(DATABASE_SETTINGS) private readonly settings: DatabaseSettings
  ) {}

  /** ¿Hay una transacción abierta en este flujo? */
  get active(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** La sesión de la transacción en curso; fuera de ella, ninguna (operación suelta). */
  session(): ClientSession | undefined {
    return this.storage.getStore()?.session;
  }

  /** La base del servicio. */
  db(): Db {
    return this.source().db(this.settings.database ?? undefined);
  }

  /** Una colección de la base del servicio. Sus operaciones toman la sesión de \`session()\`. */
  collection<T extends Document = Document>(name: string): Collection<T> {
    return this.db().collection<T>(name);
  }

  /**
   * Ejecuta \`work\` en una transacción: la ABIERTA si la hay (se une a ella, como la propagación por
   * defecto de Spring) o una nueva, que confirma si \`work\` termina y aborta si lanza. No se reintenta
   * aquí —el driver lo haría con \`withTransaction\` durante dos minutos—: el conflicto transitorio lo
   * reintenta el mediator con sus intentos contados, como keel-spring, y agotado es un 409.
   */
  async inTransaction<T>(work: (session: ClientSession) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const current = this.storage.getStore();
    if (current) return work(current.session);
    const session = this.source().startSession();
    const frame: TransactionFrame = { session, afterCommit: [] };
    let result: T;
    try {
      // Una lectura también va en transacción, como el @Transactional(readOnly = true) de keel-spring
      // sobre Mongo: todas sus lecturas ven el mismo instante.
      session.startTransaction(options.readOnly === true ? { readPreference: 'primary' } : undefined);
      try {
        result = await this.storage.run(frame, () => work(session));
        await session.commitTransaction();
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        throw error;
      }
    } finally {
      await session.endSession();
    }
    // Ya confirmada: lo que sale del proceso (publicar un evento best-effort) va aquí. Es el
    // AFTER_COMMIT de Spring: lo que falla se registra y no deshace nada.
    for (const callback of frame.afterCommit) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(\`Fallo en una acción tras el commit: \${error instanceof Error ? error.message : String(error)}\`);
      }
    }
    return result;
  }

  /**
   * Ejecuta \`work\` en una transacción NUEVA aunque haya otra abierta (el REQUIRES_NEW de Spring): se
   * confirma o aborta por su cuenta, y la del llamante sigue intacta.
   */
  inNewTransaction<T>(work: (session: ClientSession) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return this.storage.exit(() => this.inTransaction(work, options));
  }

  /**
   * Programa \`callback\` para DESPUÉS del commit de la transacción en curso; si aborta, no se ejecuta
   * nunca. Sin transacción abierta no hay commit que esperar y se ejecuta ya.
   */
  async afterCommit(callback: () => unknown): Promise<void> {
    const current = this.storage.getStore();
    if (current) {
      current.afterCommit.push(callback);
      return;
    }
    await callback();
  }

  private source(): MongoClient {
    if (this.client == null) {
      throw new Error('Sin base de datos en este perfil (database.enabled: false): el perfil test no la tiene.');
    }
    return this.client;
  }
}`;
  return tsModule(
    TRANSACTION_CONTEXT_TS,
    [
      { symbol: 'AsyncLocalStorage', from: 'node:async_hooks' },
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'ClientSession', from: 'mongodb', type: true },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'Db', from: 'mongodb', type: true },
      { symbol: 'Document', from: 'mongodb', type: true },
      { symbol: 'MongoClient', from: 'mongodb', type: true },
      { symbol: 'DatabaseSettings', from: MONGO_SETTINGS_TS, type: true }
    ],
    body
  );
}

// ─── Errores del motor ───────────────────────────────────────────────────────

function persistenceErrorsFile(model) {
  // En el documento no hay claves ajenas: solo unicidad.
  const entries = constraintErrors(model).filter((entry) => !entry.reference);
  const concurrency = declaredConcurrencyError(model);
  const imports = [
    { symbol: 'ConflictException', from: classPath(DIRS.errors, 'ConflictException') },
    { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS, type: true }
  ];
  if (concurrency) imports.push({ symbol: concurrency.exceptionClass, from: classPath(DIRS.errors, concurrency.exceptionClass) });
  for (const entry of entries) {
    if (entry.declared) imports.push({ symbol: entry.declared.exceptionClass, from: classPath(DIRS.errors, entry.declared.exceptionClass) });
  }
  const concurrencyError = concurrency
    ? `new ${concurrency.exceptionClass}(${tsString(CONCURRENT_MODIFICATION_MESSAGE)})`
    : `new ConflictException(${tsString(CONCURRENT_MODIFICATION_MESSAGE)}, { code: ${tsString(FRAMEWORK_ERRORS.concurrency.code)}, httpStatus: 409, details: [] })`;
  const rows = entries.map((entry) => {
    const build = entry.declared
      ? `new ${entry.declared.exceptionClass}(${tsString(entry.message)})`
      : `new ConflictException(${tsString(entry.message)}, { code: ${tsString(entry.code)}, httpStatus: 409 })`;
    const why = entry.named
      ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño NOMBRA para ella.`
      : entry.raceOnly
        ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: solo una carrera la rompe, así que es conflicto de concurrencia.`
        : entry.declared
          ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño declara para ella.`
          : `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el diseño no nombra un error para ella, así que sale con el code CANÓNICO de la familia uniqueness (docs/framework-errors.md).`;
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

/** Un conflicto de escritura transitorio que agotó sus reintentos: sale como 409. */
export class WriteConflictExhausted extends Error {
  constructor(attempts: number, cause: unknown) {
    super(\`Conflicto de escritura concurrente tras \${attempts} intentos\`, { cause });
    this.name = 'WriteConflictExhausted';
  }
}

/** El error del servidor de MongoDB en la cadena de causas, o null. */
function serverError(error: unknown): MongoServerError | null {
  for (let cause: unknown = error, depth = 0; cause != null && depth < 5; depth++) {
    if (cause instanceof MongoServerError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * ¿Un conflicto de escritura transitorio? Dos transacciones que tocan el mismo documento a la vez: el
 * motor aborta a la segunda en vez de hacerla esperar (WriteConflict, código 112, etiqueta
 * TransientTransactionError). En el reintento ve lo que la otra confirmó y falla con el error que el
 * diseño declara, o pasa.
 */
export function isTransientWriteConflict(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause != null && depth < 5; depth++) {
    if (cause instanceof MongoError && (cause.hasErrorLabel('TransientTransactionError') || cause.code === 112)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * ¿El motor cortó la transacción por un tope? En el modelo documental no hay tope que el servicio
 * fije —keel-spring no lo aplica en Mongo—: la transacción tiene el límite de vida del servidor, y
 * pasarlo es un conflicto transitorio. Se exporta por la forma común con la rama relacional.
 */
export function isTransactionTimeout(_error: unknown): boolean {
  return false;
}

/** ¿Una violación de unicidad (E11000)? En el documento es la única integridad que hay. */
export function isIntegrityViolation(error: unknown): boolean {
  const server = serverError(error);
  return server != null && (server.code === 11000 || server.code === 11001);
}

/** El tope de transacción: la forma común con la rama relacional (aquí no lo produce nadie). */
export const TRANSACTION_TIMEOUT = { status: ${FRAMEWORK_ERRORS.transactionTimeout.http}, code: ${tsString(FRAMEWORK_ERRORS.transactionTimeout.code)}, message: ${tsString(TRANSACTION_TIMEOUT_MESSAGE)} } as const;

/** Una violación de integridad sin índice conocido: 409 sin \`code\`, como keel-spring. */
export const UNKNOWN_INTEGRITY = { status: 409, message: ${tsString(UNKNOWN_INTEGRITY_MESSAGE)} } as const;

/**
 * Nombre de índice (en minúsculas) → el error que representa violarlo. Los nombres los pone
 * keel-core/gen/document.js y el error, con su mensaje, keel-core/gen/constraint-errors.js: los dos
 * servidores del diseño traducen la misma violación al mismo error. El nombre viaja en el mensaje
 * del motor: \`E11000 duplicate key error collection: … index: uk_… dup key: …\`.
 */
const CONSTRAINT_TO_ERROR: ReadonlyArray<readonly [string, () => DomainException]> = [
${rows.join(',\n')}
];

/**
 * El error del contrato de un fallo de persistencia, o null si no es de persistencia:
 *   · conflicto de versión o conflicto transitorio agotado → 409 de concurrencia (el del diseño si lo declara);
 *   · violación de un índice único conocido → su error; desconocido (el \`_id\`) → \`'integrity'\` (409 genérico).
 */
export function translatePersistenceError(error: unknown): DomainException | 'integrity' | 'timeout' | null {
  if (error instanceof OptimisticLockConflict || error instanceof WriteConflictExhausted) {
    return ${concurrencyError};
  }
  if (isIntegrityViolation(error)) {
    const detail = (serverError(error)?.message ?? '').toLowerCase();
    for (const [index, build] of CONSTRAINT_TO_ERROR) {
      // El nombre entero: \`uk_jobs_natural\` no puede casar dentro de \`uk_jobs_natural_x\`.
      if (new RegExp(\`index: \${index}( |$)\`).test(detail)) return build();
    }
    return 'integrity';
  }
  return null;
}`;
  imports.push({ symbol: 'MongoError', from: 'mongodb' }, { symbol: 'MongoServerError', from: 'mongodb' });
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
    { symbol: 'MongoClient', from: 'mongodb' },
    { symbol: 'Configuration', from: 'src/infrastructure/config/configuration.ts', type: true },
    { symbol: 'databaseSettings', from: MONGO_SETTINGS_TS },
    { symbol: 'ensureDocumentIndexes', from: DOCUMENT_INDEXES_TS },
    { symbol: 'MONGO_CLIENT', from: TRANSACTION_CONTEXT_TS },
    { symbol: 'DATABASE_SETTINGS', from: TRANSACTION_CONTEXT_TS },
    { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }
  ];
  for (const entity of roots) {
    imports.push({ symbol: portClass(entity), from: portPath(entity) });
    imports.push({ symbol: adapterClass(entity), from: adapterPath(entity) });
  }
  const bindings = roots.map((entity) => `    { provide: ${portClass(entity)}, useClass: ${adapterClass(entity)} }`);
  const ports = roots.map((entity) => portClass(entity));
  // Los mismos enlaces que la rama relacional: la tienda del reclamo de reconciliación y los números de cada
  // barrido, la configuración de los barridos y el puerto del registro de idempotencia.
  const reconciliation = reconciliationBindings(model);
  imports.push(...reconciliation.imports);
  bindings.push(...reconciliation.bindings);
  ports.push(...reconciliation.exports);
  if (usesSweepClaims(model)) {
    imports.push({ symbol: 'SWEEP_SETTINGS', from: SWEEP_SETTINGS_TS }, { symbol: 'sweepSettings', from: SWEEP_SETTINGS_TS });
    bindings.push('    { provide: SWEEP_SETTINGS, useValue: sweepSettings(configuration) }');
  }
  if (usesRequestIdempotency(model)) {
    imports.push({ symbol: 'IdempotencyStore', from: IDEMPOTENCY_STORE_TS }, { symbol: 'IdempotencyStoreImpl', from: IDEMPOTENCY_STORE_IMPL_TS });
    bindings.push('    { provide: IdempotencyStore, useClass: IdempotencyStoreImpl }');
    ports.push('IdempotencyStore');
  }
  const body = `/** Cierra el cliente al apagar: después de que el servidor HTTP deje de aceptar y drene. */
@Injectable()
class MongoClientShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger('Persistence');

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.client != null) {
      await this.client.close();
      this.logger.log('Conexiones con MongoDB cerradas');
    }
  }
}

/**
 * La persistencia documental: el cliente del perfil, la transacción que propaga el mediator, los
 * índices del diseño y un adaptador por puerto. Global: los handlers de application inyectan los
 * puertos sin importarla.
 *
 * El cliente conecta y crea los índices al ARRANCAR: un MongoDB inalcanzable, o un índice que ya
 * existe con otra forma, tumba el arranque y no la primera petición. \`useBigInt64\`: un Int64 se lee
 * como bigint, que es como lo lleva el dominio.
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
          provide: MONGO_CLIENT,
          useFactory: async () => {
            if (settings.url == null) return null;
            const client = await new MongoClient(settings.url, { useBigInt64: true, appName: configuration.application.name }).connect();
            await ensureDocumentIndexes(client.db(settings.database ?? undefined));
            return client;
          }
        },
        TransactionContext,
        MongoClientShutdown,
${bindings.join(',\n')}
      ],
      exports: [TransactionContext, MONGO_CLIENT${ports.length > 0 ? `, ${ports.join(', ')}` : ''}]
    };
  }
}`;
  return tsModule(PERSISTENCE_MODULE_TS, imports, body);
}
