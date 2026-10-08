// El reclamo del barrido de RECONCILIACIÓN (incremento 11c): llevarse los encargos que llevan demasiado
// tiempo sin desenlace, de forma que dos réplicas no se lleven el mismo. El mismo mecanismo que keel-spring
// (su `reconciliation-claim.js`), sobre TypeORM.
//
// Por qué NO es el reclamo de una cola (claim.js): allí la marca es el propio estado de destino; aquí el
// estado de espera es justo lo que el barrido busca y no se puede cambiar antes de saber el desenlace, y
// entre reclamar y actuar hay una llamada al proveedor —un lock solo aísla mientras dura su transacción—.
// De ahí la tabla propia `reconciliation_claim`, con una marca que SOBREVIVE AL COMMIT y CADUCA.
//
// La tabla, su purga, los tres números de cada barrido (clave, variable y default) y la regla de quién se
// lleva el candidato son de keel-core (`gen/reconciliation-stores.js`), los mismos que en keel-spring.

import {
  RECONCILIATION_CLAIM,
  RECONCILIATION_PURGE,
  reconciledActivations,
  reconciliationClaims,
  reconciliationParameters
} from 'keel-core/gen/reconciliation-stores';
import { kebabCase, screamingSnake } from 'keel-core/gen';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { ORM_DIR, engineOf, ormClass, usesRelational } from './persistence-entities.js';
import { storeEntity } from './messaging-stores.js';
import { TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const RECONCILIATION_DIR = 'src/infrastructure/persistence/reconciliation';
export const RECONCILIATION_CLAIM_ORM_TS = `src/${ORM_DIR}/reconciliation-claim-orm.ts`;
export const RECONCILIATION_CLAIM_STORE_TS = `${RECONCILIATION_DIR}/reconciliation-claim-store.ts`;
export const RECONCILIATION_SETTINGS_TS = `${RECONCILIATION_DIR}/reconciliation-settings.ts`;

/** ¿Genera build algún reclamo de reconciliación? Rama relacional (la documental llega con el incremento 12). */
export function usesReconciliationClaims(model) {
  return usesRelational(model) && reconciliationClaims(model).length > 0;
}

/** ¿Hay parámetros de barridos de reconciliación que leer? Los hay aunque build no pueda generar el reclamo. */
export function usesReconciliationSettings(model) {
  return usesRelational(model) && reconciledActivations(model).length > 0;
}

export function generate(model) {
  const files = [];
  if (usesReconciliationSettings(model)) {
    files.push({ path: RECONCILIATION_SETTINGS_TS, content: settingsFile(model) });
    // Los mismos perfiles que keel-spring: en test valen los defaults del código.
    for (const profile of ['local', 'develop', 'production']) {
      files.push({ path: `config/parameters/${profile}/reconciliation.yaml`, content: reconciliationYaml(model, profile) });
    }
  }
  if (usesReconciliationClaims(model)) {
    files.push(
      { path: RECONCILIATION_CLAIM_ORM_TS, content: storeEntity(model, RECONCILIATION_CLAIM, 'ReconciliationClaimOrm', RECONCILIATION_CLAIM_ORM_TS, CLAIM_DOC) },
      { path: RECONCILIATION_CLAIM_STORE_TS, content: storeFile(model) }
    );
  }
  return files;
}

/** La entidad de la tabla, para el DataSource. */
export function reconciliationEntities(model) {
  return usesReconciliationClaims(model) ? [{ symbol: 'ReconciliationClaimOrm', from: RECONCILIATION_CLAIM_ORM_TS }] : [];
}

/** La purga de la tabla, para table-purges.ts: las marcas viejas ya no protegen nada. */
export function reconciliationPurge(model) {
  if (!usesReconciliationClaims(model)) return null;
  return {
    key: 'reconciliationClaim',
    what: RECONCILIATION_CLAIM.table,
    method: 'purgeReconciliationClaims',
    table: RECONCILIATION_CLAIM.table,
    column: 'claimed_at',
    predicate: null,
    prefix: 'reconciliation.purge',
    cron: RECONCILIATION_PURGE.cron,
    retentionDays: RECONCILIATION_PURGE.retentionDays,
    log: 'Reconciliación: purgadas ${deleted} marcas de reclamo anteriores a ${cutoff.toISOString()}'
  };
}

const CLAIM_DOC = `Marca de que una réplica se llevó un candidato del barrido de reconciliación. La MISMA tabla que el
 * servidor de keel-spring del diseño (keel-core/gen/reconciliation-stores.js): la clave es compuesta
 * —activación + entidad— porque una entidad puede esperar el desenlace de VARIAS activaciones a la vez, y
 * claimed_at es un instante y no un booleano porque la marca CADUCA: una fila no se suelta cuando muere la
 * réplica que la escribió.`;

// ─── Configuración ───────────────────────────────────────────────────────────

const envWithDefault = (profile, name, value) => (profile === 'local' ? String(value) : `\${${name}:${value}}`);

/** El mismo `reconciliation.yaml` que keel-spring, con las claves de keel-core. */
function reconciliationYaml(model, profile) {
  const lines = ['reconciliation:'];
  for (const { dependency, activation, sweeper } of reconciledActivations(model)) {
    const parameters = reconciliationParameters(activation, sweeper);
    lines.push(
      `  ${kebabCase(activation.name)}:`,
      `    # Encargos a ${dependency} sin desenlace pasado este tiempo: candidatos del barrido.`,
      '    # Lo declara el DISEÑO; aquí solo se parametriza para poder moverlo por entorno.',
      `    unanswered-after-seconds: ${envWithDefault(profile, parameters.unansweredAfterSeconds.env, parameters.unansweredAfterSeconds.default)}`,
      '    # Caducidad del reclamo: una réplica que muere con el lote en vuelo retiene sus',
      '    # candidatos hasta que pasa esto. Del generador, no del diseño: cubre el lote entero',
      '    # (lote × timeout de la llamada con sus reintentos) y al menos dos ticks del cron.',
      `    claim-timeout-ms: ${envWithDefault(profile, parameters.claimTimeoutMs.env, parameters.claimTimeoutMs.default)}`,
      '    # Cota del lote por pasada: sin ella, una tanda con 50.000 atascados son 50.000',
      '    # llamadas al proveedor de una vez. Del generador, no del diseño.',
      `    batch-size: ${envWithDefault(profile, parameters.batchSize.env, parameters.batchSize.default)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function settingsFile(model) {
  const entries = reconciledActivations(model).map(({ activation, sweeper }) => {
    const parameters = reconciliationParameters(activation, sweeper);
    const read = (parameter) => `positive(configuration, ${tsString(parameter.key)}, ${parameter.default})`;
    return `    ${tsString(activation.name)}: {
      unansweredAfterSeconds: ${read(parameters.unansweredAfterSeconds)},
      claimTimeoutMs: ${read(parameters.claimTimeoutMs)},
      batchSize: ${read(parameters.batchSize)}
    }`;
  });
  return tsModule(
    RECONCILIATION_SETTINGS_TS,
    [{ symbol: 'Configuration', from: CONFIG_TS, type: true }],
    `/** Token de la configuración de los barridos de reconciliación ya resuelta. */
export const RECONCILIATION_SETTINGS = Symbol('RECONCILIATION_SETTINGS');

/**
 * Los tres números de un barrido, y NO son la misma clase de decisión: el silencio tolerado lo declara el
 * diseño (unansweredAfterSeconds de la activación); la caducidad del reclamo y la cota del lote son del
 * generador (mecánica y capacidad). Los tres se leen de config/parameters/<perfil>/reconciliation.yaml.
 */
export interface ReconciliationWindow {
  readonly unansweredAfterSeconds: number;
  readonly claimTimeoutMs: number;
  readonly batchSize: number;
}

/** Por activación: cada proveedor tarda lo suyo. */
export type ReconciliationSettings = Readonly<Record<string, ReconciliationWindow>>;

/** Las claves y los defaults del servidor de keel-spring. Un valor que no es un entero positivo no deja arrancar. */
export function reconciliationSettings(configuration: Configuration): ReconciliationSettings {
  return {
${entries.join(',\n')}
  };
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}`
  );
}

// ─── La tienda del reclamo ───────────────────────────────────────────────────

function storeFile() {
  return tsModule(
    RECONCILIATION_CLAIM_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'LessThanOrEqual', from: 'typeorm' },
      { symbol: 'ReconciliationClaimOrm', from: RECONCILIATION_CLAIM_ORM_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'isIntegrityViolation', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS }
    ],
    `/**
 * Quién se lleva cada candidato del barrido de reconciliación. Dos caminos y ninguno sobra, porque la fila
 * puede no existir todavía:
 *
 *   1. si existe y su marca CADUCÓ, un UPDATE condicional la renueva: 1 fila afectada = es mía;
 *   2. si no existe, se INSERTA, y la clave primaria arbitra la carrera entre dos réplicas que la insertan a
 *      la vez: la que pierde recibe la violación de clave, que aquí no es un error sino el desenlace normal.
 *
 * Y si existe con la marca VIVA, el UPDATE no toca nada y el INSERT choca: las dos vías dicen que no. Cada
 * paso en su propia transacción, confirmada al volver: la marca tiene que existir para las demás réplicas
 * ANTES de que esta llame al proveedor. Es la regla de keel-core (\`reconciliationClaimReference\`).
 */
@Injectable()
export class ReconciliationClaimStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  /**
   * @param activation    qué encargo se reclama (una entidad puede esperar varios)
   * @param entityId      cuál de ellos
   * @param now           la marca que se estampa
   * @param expiredBefore por debajo de este instante, un reclamo ajeno ya caducó
   * @returns true si el candidato es de esta réplica
   */
  async claim(activation: string, entityId: string, now: Date, expiredBefore: Date): Promise<boolean> {
    const renewed = await this.transactions.inNewTransaction((manager) =>
      manager
        .createQueryBuilder()
        .update(ReconciliationClaimOrm)
        .set({ claimedAt: now })
        .where({ activation, entityId, claimedAt: LessThanOrEqual(expiredBefore) })
        .execute()
    );
    if (renewed.affected) return true;
    try {
      await this.transactions.inNewTransaction((manager) => manager.insert(ReconciliationClaimOrm, { activation, entityId, claimedAt: now }));
      return true;
    } catch (error) {
      // Otra réplica insertó la marca entre el UPDATE y el INSERT: suya es. Con MySQL la perdedora puede salir
      // por espera de bloqueo o interbloqueo en vez de por la clave duplicada: significa lo mismo. Ceder de más
      // es benigno —la pasada siguiente lo recoge—; lo caro es lo contrario.
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) return false;
      throw error;
    }
  }
}`
  );
}

// ─── El puerto y el adaptador de la raíz que espera ──────────────────────────

const claimsFor = (model, entityName) => (usesRelational(model) ? reconciliationClaims(model).filter((claim) => claim.entity === entityName) : []);

function describe(claim) {
  return `Reclama los ${claim.entity} que encargaron trabajo a ${claim.dependency}.${claim.activation} y llevan
demasiado tiempo sin desenlace (${claim.awaitingField} más viejo que el umbral que declara el diseño).

Reclama, no lee: corre en TODAS las réplicas a la vez, y la lista son SOLO los candidatos que ESTA se llevó.
La marca es una fila de reconciliation_claim confirmada antes de volver, así que las demás réplicas dejan de
verlos; y CADUCA (claim-timeout-ms), porque sobrevive también a la réplica que muera con el candidato en vuelo.

No recibe el lote: los tres números —umbral, caducidad y cota— salen de config/parameters/<perfil>/
reconciliation.yaml y los lee el adaptador. Actúa sobre lo que devuelve FUERA de esta llamada.`;
}

/** Los métodos del puerto <E>Repository. */
export function portReconciliationMethods(model, entity) {
  return claimsFor(model, entity.name).map(
    (claim) => `  /**
${describe(claim)
  .split('\n')
  .map((line) => `   * ${line}`.trimEnd())
  .join('\n')}
   */
  abstract ${claim.method}(): Promise<${entity.name}[]>;`
  );
}

/** Lo que el adaptador inyecta para reclamar: la tienda y la configuración. */
export function reconciliationDependencies(model, entity) {
  if (claimsFor(model, entity.name).length === 0) return [];
  return [
    { token: 'ReconciliationClaimStore', name: 'reconciliationClaims', type: 'ReconciliationClaimStore', imports: [{ symbol: 'ReconciliationClaimStore', from: RECONCILIATION_CLAIM_STORE_TS }] },
    {
      token: 'RECONCILIATION_SETTINGS',
      name: 'reconciliation',
      type: 'ReconciliationSettings',
      imports: [
        { symbol: 'RECONCILIATION_SETTINGS', from: RECONCILIATION_SETTINGS_TS },
        { symbol: 'ReconciliationSettings', from: RECONCILIATION_SETTINGS_TS, type: true }
      ]
    }
  ];
}

/** Los métodos del adaptador TypeORM. `findOptions(where)` es el de la carga del agregado entero. */
export function adapterReconciliationMethods(model, entity, imports, findOptions) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];
  const { enumType, field } = entity.lifecycle;
  const orm = ormClass(entity.name);
  imports.push({ symbol: enumType, from: classPath(DIRS.enums, enumType) }, { symbol: 'LessThan', from: 'typeorm' });
  // READ COMMITTED en MySQL, por lo mismo que el reclamo de una cola: la lectura con bloqueo de REPEATABLE READ
  // toma también los huecos entre claves y frena los INSERT de filas nuevas.
  const isolation = engineOf(model) === 'mysql' ? ", { isolation: 'READ COMMITTED' }" : '';
  return claims.map((claim) => {
    const states = claim.states.map((state) => `${enumType}.${screamingSnake(state)}`).join(', ');
    return `  /** El reclamo del puerto (reconciliación): ver ${entity.name}Repository.${claim.method}. */
  async ${claim.method}(): Promise<${entity.name}[]> {
    const window = this.reconciliation[${tsString(claim.activation)}]!;
    // Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - window.unansweredAfterSeconds * 1000);
    const claimExpiredBefore = new Date(now.getTime() - window.claimTimeoutMs);
    const states = [${states}];
    // Los candidatos, el que más lleva primero. SKIP LOCKED reparte entre réplicas; quién se queda cada uno lo
    // decide el reclamo de abajo, no esta consulta.
    const candidates = await this.transactions.inNewTransaction(
      (manager) =>
        manager
          .createQueryBuilder(${orm}, 'e')
          .select(['e.id'])
          .where(states.map((state) => ({ ${field}: state, ${claim.awaitingField}: LessThan(staleBefore) })))
          .orderBy('e.${claim.awaitingField}', 'ASC')
          .limit(window.batchSize)
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getMany()${isolation}
    );
    const claimed: ${entity.name}[] = [];
    for (const { id } of candidates) {
      // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
      if (!(await this.reconciliationClaims.claim(${tsString(claim.activation)}, id, now, claimExpiredBefore))) continue;
      const found = await this.transactions.inNewTransaction((manager) => manager.findOne(${orm}, ${findOptions('{ id }')}));
      if (found != null) claimed.push(toDomain${entity.name}(found));
    }
    return claimed;
  }`;
  });
}

/** El enlace del módulo de persistencia: la tienda y la configuración. */
export function reconciliationBindings(model) {
  const bindings = [];
  const imports = [];
  if (usesReconciliationSettings(model)) {
    imports.push({ symbol: 'RECONCILIATION_SETTINGS', from: RECONCILIATION_SETTINGS_TS }, { symbol: 'reconciliationSettings', from: RECONCILIATION_SETTINGS_TS });
    bindings.push('    { provide: RECONCILIATION_SETTINGS, useValue: reconciliationSettings(configuration) }');
  }
  if (usesReconciliationClaims(model)) {
    imports.push({ symbol: 'ReconciliationClaimStore', from: RECONCILIATION_CLAIM_STORE_TS });
    bindings.push('    ReconciliationClaimStore');
  }
  // Exportados: un barrido que build no pudo reclamar lo escribe el agente, y lee estos números igual.
  const exports = usesReconciliationSettings(model) ? ['RECONCILIATION_SETTINGS'] : [];
  if (usesReconciliationClaims(model)) exports.push('ReconciliationClaimStore');
  return { bindings, imports, exports };
}
