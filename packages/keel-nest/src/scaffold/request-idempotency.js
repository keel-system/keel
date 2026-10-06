// La idempotencia de PETICIÓN (`use-cases.<op>.idempotency`): la que evita que reintentar una
// petición ejecute el caso de uso dos veces. Es el mismo mecanismo que el de keel-spring, con su misma
// tabla (`keel-core/gen/request-idempotency.js`, `IDEMPOTENCY_RECORD`):
//
//   · build genera TODO lo transversal: el puerto `IdempotencyStore` (dominio), su adaptador TypeORM con
//     la tabla `idempotency_record`, la firma canónica del comando (`CommandSignature`), el contexto
//     que lleva la cabecera `Idempotency-Key` hasta el handler y los dos errores de conflicto (la
//     carrera y la clave reutilizada), con el `code` del catálogo de Keel o el que el diseño declare;
//   · el agente escribe el USO en el handler, guiado por la nota que le deja el stub (services.js).
//
// Por qué un registro en la base y no una clave en una caché: el contrato no es «rechazar el
// duplicado» sino «reproducir la respuesta», y el registro tiene que confirmarse en la MISMA
// transacción que el efecto del comando — con dos almacenes, marcar antes deja la clave envenenada si
// la transacción revierte, y marcar después abre la ventana para que dos reintentos ejecuten ambos.
//
// La primera corrida de keel-nest (product-catalog, 2026-10-06) es el motivo de que esto exista ya:
// sin el mecanismo, el agente escribió el suyo con otra tabla y SQL de un solo motor.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { declaredErrorFor } from 'keel-core/gen';
import {
  IDEMPOTENCY_RECORD,
  IDEMPOTENCY_HEADER,
  usesRequestIdempotency as usesRegistryInDesign,
  usesIdempotencyHeader as usesHeaderInDesign
} from 'keel-core/gen/request-idempotency';
import { DIRS, classPath, tsModule } from './render.js';
import { ORM_DIR, engineOf, physicalColumn, usesRelational } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';

export const IDEMPOTENCY_STORE_TS = classPath(DIRS.idempotency, 'IdempotencyStore');
export const IDEMPOTENCY_CONFLICT_TS = classPath(DIRS.idempotency, 'IdempotencyConflictException');
export const IDEMPOTENCY_REUSE_TS = classPath(DIRS.idempotency, 'IdempotencyReuseException');
export const COMMAND_SIGNATURE_TS = classPath(DIRS.appSupport, 'CommandSignature');
export const IDEMPOTENCY_CONTEXT_TS = classPath(DIRS.appSupport, 'IdempotencyContext');
export const IDEMPOTENCY_RECORD_ORM_TS = `src/${ORM_DIR}/idempotency-record-orm.ts`;
export const IDEMPOTENCY_STORE_IMPL_TS = 'src/infrastructure/persistence/idempotency-store-impl.ts';

/** ¿Se genera el registro? El relacional: el documental llega con la persistencia documental (inc. 12). */
export function usesRequestIdempotency(model) {
  return usesRelational(model) && usesRegistryInDesign(model);
}

/** ¿Viaja la clave por la cabecera Idempotency-Key? */
export function usesIdempotencyHeader(model) {
  return usesRelational(model) && usesHeaderInDesign(model);
}

export function generate(model) {
  if (!usesRequestIdempotency(model)) return [];
  const files = [
    { path: IDEMPOTENCY_STORE_TS, content: storePort() },
    { path: IDEMPOTENCY_CONFLICT_TS, content: conflictException(model) },
    { path: IDEMPOTENCY_REUSE_TS, content: reuseException(model) },
    { path: COMMAND_SIGNATURE_TS, content: commandSignature() },
    { path: IDEMPOTENCY_RECORD_ORM_TS, content: recordEntity(model) },
    { path: IDEMPOTENCY_STORE_IMPL_TS, content: storeAdapter() }
  ];
  // El contexto es el camino de la CABECERA: solo con `client-key`. Con `payload-hash` o
  // `payload-field` la clave sale del propio comando y no hay nada que transportar.
  if (usesIdempotencyHeader(model)) files.push({ path: IDEMPOTENCY_CONTEXT_TS, content: idempotencyContext() });
  return files;
}

function storePort() {
  return `/** Lo guardado de la primera ejecución de una petición. */
export interface StoredRequest {
  /** La firma del contenido (CommandSignature) con la que se usó la clave. */
  readonly signature: string;
  /** El id del recurso resultante, para reconstruir la respuesta; null si la operación no crea nada. */
  readonly resourceId: string | null;
}

/**
 * Registro de peticiones ya atendidas, por clave de idempotencia. Clase abstracta y no interfaz:
 * sirve también de token de inyección, sin que el dominio importe nada del framework.
 *
 * El contrato del diseño no es rechazar la repetición, sino REPRODUCIRLA: la segunda llamada con la
 * misma clave y el mismo contenido devuelve la respuesta de la primera, sin volver a ejecutar nada. Por
 * eso se guarda el id del recurso resultante y una firma del contenido (para detectar la reutilización
 * de la clave con otro cuerpo, que tiene su propio error: IdempotencyReuseException).
 */
export abstract class IdempotencyStore {
  /**
   * El registro previo, si esa clave ya se usó y no ha caducado.
   *
   * @param scope command.idempotencyScope(), que build compone desde el diseño (la operación y su
   *              partitionBy): no se compone a mano
   * @param idempotencyKey la cabecera Idempotency-Key (client-key), CommandSignature.of(command)
   *                       (payload-hash) o el campo de la clave (payload-field)
   */
  abstract find(scope: string, idempotencyKey: string): Promise<StoredRequest | null>;

  /**
   * Registra la primera ejecución, DENTRO de la transacción del caso de uso: si el comando revierte, el
   * registro revierte con él. Dos peticiones con la misma clave a la vez chocan en la clave primaria del
   * registro, y la que pierde sale como IdempotencyConflictException: no la captures.
   *
   * @param ttlSeconds la ventana de deduplicación del diseño (idempotency.ttlSeconds)
   */
  abstract save(scope: string, idempotencyKey: string, signature: string, resourceId: string | null, ttlSeconds: number): Promise<void>;
}
`;
}

function conflictBody(model, canonical, className, summary, detail) {
  const declared = declaredErrorFor(model, canonical);
  const code = declared?.code ?? canonical.code;
  const origin = declared
    ? 'El code sale del error que el diseño declara para este conflicto.'
    : `El code es el CANÓNICO del framework (docs/framework-errors.md): el diseño no declara uno propio, y eso es\n * una respuesta legítima. Para cambiarlo, declara en los errors de la operación un code de su familia con\n * status ${canonical.http}.`;
  return tsModule(
    classPath(DIRS.idempotency, className),
    [{ symbol: 'ConflictException', from: classPath(DIRS.errors, 'ConflictException') }],
    `/**
 * ${summary}
 *
 * ${detail}
 *
 * ${origin}
 */
export class ${className} extends ConflictException {
  constructor(scope: string, idempotencyKey: string) {
    super(${className === 'IdempotencyConflictException'
      ? '`Otra petición con la misma clave de idempotencia está en curso: ${scope}/${idempotencyKey}`'
      : '`La clave de idempotencia ${scope}/${idempotencyKey} ya se usó con un contenido distinto`'}, {
      code: '${code}',
      httpStatus: ${canonical.http}
    });
  }
}`
  );
}

function conflictException(model) {
  return conflictBody(
    model,
    FRAMEWORK_ERRORS.idempotencyRace,
    'IdempotencyConflictException',
    'Dos peticiones con la misma clave de idempotencia, a la vez.',
    'No es el reintento normal —ese encuentra el registro ya confirmado y reproduce la respuesta—: es la\n * ventana en la que la primera aún no ha confirmado, así que no hay respuesta que reproducir. La\n * transacción de quien pierde revierte entera: de dos peticiones idénticas se ejecutó exactamente una.'
  );
}

function reuseException(model) {
  return conflictBody(
    model,
    FRAMEWORK_ERRORS.idempotencyReuse,
    'IdempotencyReuseException',
    'La misma clave de idempotencia con un contenido DISTINTO.',
    'El cliente prometió, al mandar la clave, que dos peticiones con ella son la misma; esta no lo es.\n * Reproducir la primera respuesta contestaría a otra pregunta, y ejecutarla rompería la promesa de la\n * clave. Se detecta comparando la firma del contenido con la que se guardó junto a la clave.'
  );
}

function commandSignature() {
  return tsModule(
    COMMAND_SIGNATURE_TS,
    [
      { symbol: 'createHash', from: 'node:crypto' },
      { symbol: 'Decimal', from: classPath(DIRS.support, 'Decimal') },
      { symbol: 'RawJson', from: classPath(DIRS.support, 'RawJson') }
    ],
    `/**
 * Firma determinista del contenido de un comando: la que se guarda junto a la clave (client-key) para
 * distinguir el reintento de la clave reutilizada, o la CLAVE misma (payload-hash).
 *
 * Generada y no escrita en cada handler: se compara contra una firma guardada en OTRO despliegue, y dos
 * formas de calcularla —o un refactor que cambie una— dejarían de deduplicar sin que nada lo delate.
 *
 * Canónica: propiedades ordenadas por nombre, cada escalar precedido de su longitud (ningún contenido
 * puede imitar un separador), el orden de las listas conservado, null y ausente como marca propia, y un
 * decimal sin ceros finales (1.50 y 1.5 son el mismo importe). No usa JSON.stringify: el orden de las
 * claves y la forma de los números no son contrato suyo.
 */
export const CommandSignature = {
  /** SHA-256 en hexadecimal de la forma canónica del comando. */
  of(command: object): string {
    return createHash('sha256').update(CommandSignature.canonical(command), 'utf8').digest('hex');
  },

  /** La forma canónica: visible para poder verificarla en una prueba. */
  canonical(value: unknown): string {
    if (value === null || value === undefined) return '~';
    if (value instanceof Decimal) return scalar(withoutTrailingZeros(value.toString()));
    if (value instanceof RawJson) return scalar(value.text);
    if (value instanceof Date) return scalar(value.toISOString());
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return scalar(String(value));
    if (typeof value === 'string') return scalar(value);
    if (Array.isArray(value)) return \`[\${value.map((item) => CommandSignature.canonical(item)).join(',')}]\`;
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => typeof item !== 'function')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return \`{\${entries.map(([name, item]) => scalar(name) + CommandSignature.canonical(item)).join(',')}}\`;
    }
    return scalar(String(value));
  }
};

/** Prefijo de longitud: hace imposible que un contenido imite un separador. */
function scalar(raw: string): string {
  return \`\${raw.length}:\${raw}\`;
}

function withoutTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\\.$/, '') : text;
}`
  );
}

function idempotencyContext() {
  return tsModule(
    IDEMPOTENCY_CONTEXT_TS,
    [{ symbol: 'AsyncLocalStorage', from: 'node:async_hooks' }],
    `/** La cabecera HTTP de la clave. */
export const IDEMPOTENCY_HEADER = '${IDEMPOTENCY_HEADER}';

const storage = new AsyncLocalStorage<string>();

/**
 * La clave de idempotencia de la petición en curso (cabecera ${IDEMPOTENCY_HEADER}, keySource:
 * client-key). Es transporte, así que no viaja dentro del comando: la abre el hook de entrada HTTP
 * (http-platform.ts) y la lee el handler. Vive en un AsyncLocalStorage, que sigue a la petición por sus
 * awaits y se cierra solo.
 *
 * La cabecera es OPCIONAL: sin ella get() devuelve null y la operación se ejecuta sin deduplicar — no
 * se rechaza, salvo que el diseño declare el error que la exige.
 */
export const IdempotencyContext = {
  /** La clave de la petición en curso, o null si el cliente no la envió. */
  get(): string | null {
    return storage.getStore() ?? null;
  },

  /** Ejecuta la acción con la clave recibida (sin clave, o en blanco, sin abrir nada). */
  runWith<T>(idempotencyKey: unknown, action: () => T): T {
    const key = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
    if (typeof key !== 'string' || key.trim() === '') return action();
    return storage.run(key.trim(), action);
  }
};`
  );
}

function columnDecorator(column, engine) {
  const physical = physicalColumn(column, engine);
  const options = { name: column.name, ...physical.options, ...(column.nullable ? { nullable: true } : { nullable: false }) };
  const text = Object.entries(options)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? `'${value}'` : value}`)
    .join(', ');
  return `@${column.primary ? 'PrimaryColumn' : 'Column'}({ ${text} })`;
}

function propertyOf(column) {
  return column.name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}

function tsTypeOf(column) {
  const base = column.base === 'timestamp' ? 'Date' : 'string';
  return column.nullable ? `${base} | null` : base;
}

function recordEntity(model) {
  const engine = engineOf(model);
  const index = IDEMPOTENCY_RECORD.indexes[0];
  const fields = IDEMPOTENCY_RECORD.columns
    .map((column) => `  ${columnDecorator(column, engine)}\n  ${propertyOf(column)}!: ${tsTypeOf(column)};`)
    .join('\n\n');
  return tsModule(
    IDEMPOTENCY_RECORD_ORM_TS,
    [
      { symbol: 'Column', from: 'typeorm' },
      { symbol: 'Entity', from: 'typeorm' },
      { symbol: 'Index', from: 'typeorm' },
      { symbol: 'PrimaryColumn', from: 'typeorm' }
    ],
    `/**
 * Petición ya atendida: un par (ámbito, clave de idempotencia). La MISMA tabla que el servidor de
 * keel-spring del diseño (keel-core/gen/request-idempotency.js): la clave primaria compuesta arbitra la
 * carrera entre dos peticiones simultáneas, y expires_at se guarda calculada para que cada fila
 * conserve la ventana con la que se registró. El índice sobre expires_at es el de la purga.
 */
@Entity({ name: '${IDEMPOTENCY_RECORD.table}' })
@Index('${index.name}', [${index.columns.map((c) => `'${propertyOf({ name: c })}'`).join(', ')}])
export class IdempotencyRecordOrm {
${fields}
}`
  );
}

function storeAdapter() {
  return tsModule(
    IDEMPOTENCY_STORE_IMPL_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'LessThanOrEqual', from: 'typeorm' },
      { symbol: 'IdempotencyStore', from: IDEMPOTENCY_STORE_TS },
      { symbol: 'StoredRequest', from: IDEMPOTENCY_STORE_TS, type: true },
      { symbol: 'IdempotencyConflictException', from: IDEMPOTENCY_CONFLICT_TS },
      { symbol: 'IdempotencyRecordOrm', from: IDEMPOTENCY_RECORD_ORM_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'isIntegrityViolation', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS }
    ],
    `/**
 * Adaptador TypeORM del registro de idempotencia. Usa el EntityManager de la transacción del caso de
 * uso (TransactionContext): el registro y el efecto del comando se confirman o revierten juntos, porque
 * una clave marcada sin recurso detrás haría que el reintento devolviese una respuesta que nunca existió.
 *
 * Carreras: dos peticiones simultáneas con la misma clave insertan la misma clave primaria y el MOTOR
 * arbitra; la que pierde sale como IdempotencyConflictException (su code, no un 409 anónimo
 * indistinguible de un conflicto de negocio). Con MySQL la perdedora puede salir por espera de bloqueo o
 * interbloqueo en vez de por la clave duplicada: significa lo mismo y se traduce igual.
 *
 * Sin SQL a mano: las sentencias las escribe TypeORM para el motor de keel-stack.json.
 */
@Injectable()
export class IdempotencyStoreImpl extends IdempotencyStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  async find(scope: string, idempotencyKey: string): Promise<StoredRequest | null> {
    const found = await this.transactions.manager().findOne(IdempotencyRecordOrm, { where: { operationScope: scope, idempotencyKey } });
    // Una fila caducada es como si no estuviera: la ventana la fija el diseño, no la purga.
    if (found == null || found.expiresAt.getTime() <= Date.now()) return null;
    return { signature: found.signature, resourceId: found.resourceId };
  }

  async save(scope: string, idempotencyKey: string, signature: string, resourceId: string | null, ttlSeconds: number): Promise<void> {
    const manager = this.transactions.manager();
    const now = new Date();
    // Una fila CADUCADA es como si no estuviera —es lo que ya asume find—, y tiene que serlo aquí: si
    // no, la clave quedaría inutilizable entre su caducidad y la purga, con un 409 de clave en curso
    // durante toda esa ventana.
    await manager.delete(IdempotencyRecordOrm, { operationScope: scope, idempotencyKey, expiresAt: LessThanOrEqual(now) });
    try {
      await manager.insert(IdempotencyRecordOrm, {
        operationScope: scope,
        idempotencyKey,
        signature,
        resourceId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
      });
    } catch (error) {
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) {
        throw new IdempotencyConflictException(scope, idempotencyKey);
      }
      throw error;
    }
  }
}`
  );
}
