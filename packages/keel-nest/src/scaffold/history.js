// El HISTORIAL DE CAMBIOS consultable (DSL 2.29: `persistence.audit.history` y la query de `output: { history }`) en
// keel-nest: incremento 2 de PLAN-DSL-229-HISTORIAL.md, con el reparto de keel-spring. Lo que decide QUÉ (qué raíces, qué
// rutas registra cada una, cuáles son personales, el diff, el orden, los filtros, las tablas y sus sentencias, la nota)
// es de keel-core (gen/history.js, gen/history-store.js); aquí solo se escribe en TypeScript:
//
//   · `domain/history`: la entrada y el cambio del cable y el filtro, lo único que el puerto de la raíz nombra.
//   · `infrastructure/persistence/history`: el diff (D2) sobre los valores del cable, la reescritura de lo personal (D8),
//     las rutas personales de cada raíz y el almacén (D6, D11): `ChangeHistory` con las sentencias de keel-core TAL CUAL
//     y las dos tablas mapeadas solo para el esquema, o un documento por entrada en MongoDB. En infraestructura y no en el
//     dominio, al revés que en keel-spring, porque el valor del cable lo escribe `application/support/wire.ts` y el
//     dominio no puede importarlo.
//   · El ADAPTADOR de la raíz escribe la entrada en su `save`/`deleteById`/`restore` (D1), dentro de su transacción, con
//     la instantánea «antes» LEÍDA de la base antes de escribir (T1: ni TypeORM ni el driver tienen entidad gestionada),
//     y lee el historial con `historyOf`, que carga la raíz con la misma lectura que su ficha (D7).
//   · La retención se lleva el historial (`then: delete`) o lo anonimiza (`then: anonymize`), en data-lifecycle.js.

import { usesHistory, historyPersonalPatterns, historyNote } from '@keel-system/keel-core/gen/history';
import {
  CHANGE_HISTORY,
  CHANGE_HISTORY_FIELD,
  CHANGE_HISTORY_COLLECTION,
  HISTORY_ENGINES,
  HISTORY_FILTER_ORDER,
  historyStatements
} from '@keel-system/keel-core/gen/history-store';
import { scopedLoadOf } from '@keel-system/keel-core/gen/read-scope';
import { classPath, tsModule, tsString } from './render.js';
import { physicalColumn, optionsLiteral } from './persistence-entities.js';
// La ruta de bson-values.ts (BSON_VALUES_TS de document-persistence.js), escrita aquí: importarla cierra un ciclo de módulos.
const BSON_VALUES_TS = 'src/infrastructure/persistence/bson-values.ts';

export { usesHistory };

const HISTORY_DIR = 'infrastructure/persistence/history';
export const HISTORY_ENTRY_TS = 'src/domain/history/history-entry.ts';
export const HISTORY_SUPPORT_TS = classPath(HISTORY_DIR, 'HistorySupport');
export const CHANGE_HISTORY_TS = classPath(HISTORY_DIR, 'ChangeHistory');
export const CHANGE_HISTORY_ORM_TS = classPath(HISTORY_DIR, 'ChangeHistoryOrm');

// Las rutas de repositories.js y compañía, escritas aquí: repositories.js importa este módulo.
const TRANSACTION_CONTEXT_TS = 'src/infrastructure/persistence/transaction-context.ts';
const PAGE_TS = 'src/domain/repository/page.ts';
const WIRE_TS = 'src/application/support/wire.ts';
const AUDIT_ACTOR_TS = 'src/infrastructure/persistence/audit-actor.ts';
const UUIDS_TS = 'src/domain/identity/uuids.ts';
const TRANSFORMERS_TS = 'src/infrastructure/persistence/column-transformers.ts';
const READ_SCOPE_TS = 'src/domain/repository/read-scope.ts';

const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const isDocument = (model) => model.persistenceKind === 'document';

/** ¿Lleva historial esta raíz? */
export const recordsHistory = (entity) => Boolean(entity?.history && entity.historyShape);

/** La constante de una raíz en history-support.ts: `CONTACT_CARD_HISTORY` (su tipo y sus rutas personales). */
export const rootConstant = (entity) => `${constantOf(entity.name)}_HISTORY`;

/**
 * Lo que el historial no puede generar con este stack, o []: las sentencias son de PostgreSQL y MySQL (las mide
 * timer-sql-check) y el documental es MongoDB. Una réplica no es un agregado de este servicio. El mismo criterio que
 * keel-spring, salvo la profundidad: aquí una ruta se lee con `?.`, sin límite.
 */
export function historyStackErrors(model) {
  if (!usesHistory(model)) return [];
  const errors = [];
  if (!isDocument(model) && !HISTORY_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `persistence: audit.history (DSL 2.29): el almacén del historial tiene sentencias medidas para ${HISTORY_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores.`
    );
  }
  for (const entity of model.entities.filter((candidate) => candidate.history)) {
    if (entity.replicaOf) errors.push(`persistence: audit.history: ${entity.name} es la copia local de otro servicio, no un agregado de este.`);
  }
  return errors;
}

// ─── Lo que nombra el dominio ────────────────────────────────────────────────────────────────────────────────────

function entryFile() {
  return {
    path: HISTORY_ENTRY_TS,
    content: tsModule(
      HISTORY_ENTRY_TS,
      [],
      `/**
 * Un campo que cambió en una escritura (wire-contract.md § Historial): su ruta del contrato y sus valores antes y después,
 * ya en la forma del cable (null cuando no había o ya no hay). Se escriben aunque sean null: un historial que calla el
 * \`before\` no dice desde qué valor cambió.
 */
export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Lo que pasó en una escritura (D2). */
export type HistoryChange = 'created' | 'updated' | 'deleted' | 'restored' | 'anonymized';

/**
 * Una entrada del historial: una escritura confirmada sobre el agregado (D2). \`author\` es el actor de la autoría, o el
 * centinela \`system\` fuera de una petición. Las claves van en el orden del cable.
 */
export interface HistoryEntry {
  readonly at: Date;
  readonly author: string;
  readonly change: HistoryChange;
  readonly changes: readonly FieldChange[];
}

/**
 * Los filtros de una lectura del historial (D10), los tres opcionales y combinados con AND: \`field\` casa la ruta entera
 * o el campo de la raíz que la contiene (\`price\` casa \`price.amount\`); \`from\` y \`to\` incluyen su extremo.
 */
export interface HistoryFilter {
  readonly field: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** Sin filtros: el historial entero. */
export const NO_HISTORY_FILTER: HistoryFilter = Object.freeze({ field: null, from: null, to: null });`
    )
  };
}

// ─── El diff, la anonimización y las raíces ──────────────────────────────────────────────────────────────────────

function supportFile(model) {
  const roots = model.entities.filter(recordsHistory);
  const constants = roots.map((entity) => {
    const patterns = historyPersonalPatterns(entity.historyShape);
    const personal = patterns.map((entry) => `    { pattern: new RegExp(${tsString(entry.pattern)}), required: ${entry.required} }`);
    return `/** El historial de ${entity.name}: el tipo con que se guardan sus entradas y sus rutas personales. */
export const ${rootConstant(entity)}: HistoryRoot = {
  type: ${tsString(entity.name)},
  personal: [${personal.length > 0 ? `\n${personal.join(',\n')}\n  ` : ''}]
};`;
  });
  return {
    path: HISTORY_SUPPORT_TS,
    content: tsModule(
      HISTORY_SUPPORT_TS,
      [
        { symbol: 'parseWireJson', from: WIRE_TS },
        { symbol: 'toWireJson', from: WIRE_TS },
        { symbol: 'FieldChange', from: HISTORY_ENTRY_TS, type: true }
      ],
      `/** Una instantánea del agregado (D3): ruta del contrato → su valor, como TEXTO del cable. */
export type HistorySnapshot = ReadonlyMap<string, string>;

/**
 * Una ruta personal del historial de una raíz (DSL 2.28): el patrón de keel-core (\`historyPersonalPatterns\`, anclado) y
 * si el campo es obligatorio, que decide qué vale al anonimizar: el sustituto \`anon-<id>\` o null.
 */
export interface PersonalPath {
  readonly pattern: RegExp;
  readonly required: boolean;
}

/** Una raíz con historial: el nombre del diseño (contrato con los otros generadores) y sus rutas personales. */
export interface HistoryRoot {
  readonly type: string;
  readonly personal: readonly PersonalPath[];
}

${constants.join('\n\n')}

/** El texto del cable de un valor del dominio: el mismo serializador que escribe las respuestas. */
export function wireText(value: unknown): string {
  return toWireJson(value ?? null);
}

/**
 * Lo que cambió entre dos instantáneas (D2, D3): la referencia ejecutable es \`historyDiff\` de keel-core. \`before\` null es
 * un alta. Solo lo que cambió, ordenado por ruta, con los valores ya leídos del cable (un número conserva su texto).
 */
export function historyDiff(before: HistorySnapshot | null, after: HistorySnapshot): FieldChange[] {
  const paths = [...new Set([...after.keys(), ...(before?.keys() ?? [])])].sort();
  const changes: FieldChange[] = [];
  for (const path of paths) {
    const was = before?.get(path) ?? 'null';
    const is = after.get(path) ?? 'null';
    if (was !== is) changes.push({ field: path, before: parseWireJson(was), after: parseWireJson(is) });
  }
  return changes;
}

/** Las filas del filtro por campo de una entrada: su ruta y el campo de la raíz que la contiene, sin repetir ruta. */
export function historyFieldRows(changes: readonly FieldChange[]): Map<string, string> {
  const rows = new Map<string, string>();
  for (const change of changes) if (!rows.has(change.field)) rows.set(change.field, change.field.split(/[.[]/)[0]!);
  return rows;
}

function personalMatch(personal: readonly PersonalPath[], field: string): PersonalPath | null {
  return personal.find((path) => path.pattern.test(field)) ?? null;
}

const anonymized = (path: PersonalPath, rootId: string): string | null => (path.required ? \`anon-\${rootId}\` : null);

/**
 * Los cambios de una entrada con lo personal reescrito (D8), y si alguno cambió: la referencia es
 * \`anonymizeHistoryChanges\` de keel-core. \`before\` y \`after\` pasan al sustituto o a null.
 */
export function anonymizeChanges(changes: readonly FieldChange[], personal: readonly PersonalPath[], rootId: string): { changes: FieldChange[]; touched: boolean } {
  let touched = false;
  const out = changes.map((change) => {
    const match = personalMatch(personal, change.field);
    if (!match) return change;
    const value = anonymized(match, rootId);
    if (wireText(change.before) !== wireText(value) || wireText(change.after) !== wireText(value)) touched = true;
    return { field: change.field, before: value, after: value };
  });
  return { changes: out, touched };
}

/** Los cambios de la entrada \`anonymized\` (D8): una por ruta personal que aparece en el historial, por ruta. */
export function anonymizedEntryChanges(entries: readonly (readonly FieldChange[])[], personal: readonly PersonalPath[], rootId: string): FieldChange[] {
  const seen = new Map<string, string | null>();
  for (const changes of entries) {
    for (const change of changes) {
      const match = personalMatch(personal, change.field);
      if (match && !seen.has(change.field)) seen.set(change.field, anonymized(match, rootId));
    }
  }
  return [...seen.keys()].sort().map((field) => ({ field, before: seen.get(field) ?? null, after: seen.get(field) ?? null }));
}

/** Los cambios guardados de una entrada, leídos con las reglas del cable. */
export function readChanges(text: string): FieldChange[] {
  return parseWireJson(text) as FieldChange[];
}`
    )
  };
}

// ─── El almacén relacional ───────────────────────────────────────────────────────────────────────────────────────

const STORE_DOC = (engine) => `/**
 * El historial de cambios sobre ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core (\`history-store.js\`) TAL CUAL:
 * son contrato con los otros generadores, que comparten las tablas, y las mide \`timer-sql-check\` contra el motor. No las
 * reescribas aquí.
 *
 * Va con SQL a pelo por la transacción en curso (TransactionContext): la entrada entra en la de la escritura que la
 * origina, y si esa escritura revierte, la entrada también (D1). La hora es la del motor; a igual hora desempata el id,
 * un UUID versión 7.
 */`;

function sqlStoreFile(model) {
  const engine = model.stack.database;
  const S = historyStatements(engine);
  const mysql = engine === 'mysql';
  const statements = [
    ['insertEntry', S.insertEntry],
    ['insertField', S.insertField],
    ['pageHead', S.pageHead],
    ['countHead', S.countHead],
    ...HISTORY_FILTER_ORDER.map((name) => [`filter${name[0].toUpperCase()}${name.slice(1)}`, S.filters[name]]),
    ['pageTail', S.pageTail],
    ['entriesOfRoot', S.entriesOfRoot],
    ['updateChanges', S.updateChanges],
    ['deleteFields', S.deleteFields],
    ['deleteEntries', S.deleteEntries]
  ];
  const codec = mysql
    ? `// MySQL: el uuid es binary(16) (el orden de bytes de Hibernate y del UUID_BINARY de las entidades) y la hora un
// datetime(6) con la hora UTC; el driver convierte un Date en los dos sentidos con \`timezone: 'Z'\`.
function uuid(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

/** \`?\`: el estilo de mysql2. */
const marker = (_position: number): string => '?';`
    : `// PostgreSQL: uuid nativo y timestamp with time zone; el driver convierte un Date en los dos sentidos.
function uuid(value: string): string {
  return value;
}

/** \`$n\`: el estilo de node-postgres. */
const marker = (position: number): string => \`$\${position}\`;`;
  return {
    path: CHANGE_HISTORY_TS,
    content: tsModule(
      CHANGE_HISTORY_TS,
      [
        { symbol: 'Inject', from: '@nestjs/common' },
        { symbol: 'Injectable', from: '@nestjs/common' },
        { symbol: 'EntityManager', from: 'typeorm', type: true },
        { symbol: 'FieldChange', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryChange', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryEntry', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryFilter', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'Page', from: PAGE_TS, type: true },
        { symbol: 'Pageable', from: PAGE_TS, type: true },
        { symbol: 'pageOf', from: PAGE_TS },
        { symbol: 'Uuids', from: UUIDS_TS },
        { symbol: 'toWireJson', from: WIRE_TS },
        { symbol: 'currentActor', from: AUDIT_ACTOR_TS },
        { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
        { symbol: 'PersonalPath', from: HISTORY_SUPPORT_TS, type: true },
        { symbol: 'anonymizeChanges', from: HISTORY_SUPPORT_TS },
        { symbol: 'anonymizedEntryChanges', from: HISTORY_SUPPORT_TS },
        { symbol: 'historyFieldRows', from: HISTORY_SUPPORT_TS },
        { symbol: 'readChanges', from: HISTORY_SUPPORT_TS }
      ],
      `const SQL = {
${statements.map(([name, sql]) => `  ${name}: ${tsString(sql)}`).join(',\n')}
} as const;

${codec}

/** Los marcadores nombrados al estilo del driver, en orden de aparición (uno repetido se pasa dos veces). */
function bind(sql: string, values: Readonly<Record<string, unknown>>): [string, unknown[]] {
  const params: unknown[] = [];
  const text = sql.replace(/(?<![:\\w]):([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(\`Falta el valor de :\${name} en una sentencia del historial\`);
    params.push(values[name]);
    return marker(params.length);
  });
  return [text, params];
}

${STORE_DOC(engine)}
@Injectable()
export class ChangeHistory {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  /** Ejecuta una sentencia en la transacción en curso: sus filas. */
  private async run(manager: EntityManager, sql: string, values: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
    const [text, params] = bind(sql, values);
    const runner = manager.queryRunner;
    if (runner == null) throw new Error('El historial ejecuta sus sentencias dentro de una transacción');
    const result = await runner.query(text, params, true);
    return Array.isArray(result.records) ? (result.records as Record<string, unknown>[]) : [];
  }

  /** Escribe una entrada con el autor de la escritura en curso, en su transacción. */
  async record(rootType: string, rootId: string, change: HistoryChange, changes: readonly FieldChange[]): Promise<void> {
    await this.transactions.inTransaction(async (manager) => {
      const id = Uuids.v7();
      await this.run(manager, SQL.insertEntry, { id: uuid(id), rootType, rootId, author: currentActor(), change, changes: toWireJson(changes) });
      for (const [path, top] of historyFieldRows(changes)) await this.run(manager, SQL.insertField, { entryId: uuid(id), path, top });
    });
  }

  /** Una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor. */
  page(rootType: string, rootId: string, filter: HistoryFilter, pageable: Pageable): Promise<Page<HistoryEntry>> {
    // Los filtros presentes, en el orden de keel-core (historyPageSql): uno que no llega no se escribe.
    const filters = (filter.field != null ? SQL.filterField : '') + (filter.from != null ? SQL.filterFrom : '') + (filter.to != null ? SQL.filterTo : '');
    const values: Record<string, unknown> = { rootType, rootId };
    if (filter.field != null) values['field'] = filter.field;
    if (filter.from != null) values['from'] = filter.from;
    if (filter.to != null) values['to'] = filter.to;
    return this.transactions.inTransaction(async (manager) => {
      const rows = await this.run(manager, SQL.pageHead + filters + SQL.pageTail, { ...values, limit: pageable.size, offset: pageable.page * pageable.size });
      const counted = await this.run(manager, SQL.countHead + filters, values);
      const total = Number(Object.values(counted[0] ?? {})[0] ?? 0);
      const entries: HistoryEntry[] = rows.map((row) => ({
        at: new Date(row['at'] as Date | string),
        author: String(row['author']),
        change: String(row['change_kind']) as HistoryChange,
        changes: readChanges(String(row['changes']))
      }));
      return pageOf(entries, pageable, total);
    }, { readOnly: true });
  }

  /** Reescribe los valores personales de todas las entradas de la raíz y deja la entrada \`anonymized\` (D8). */
  async anonymize(rootType: string, rootId: string, personal: readonly PersonalPath[]): Promise<void> {
    await this.transactions.inTransaction(async (manager) => {
      const all: FieldChange[][] = [];
      for (const row of await this.run(manager, SQL.entriesOfRoot, { rootType, rootId })) {
        const rewrite = anonymizeChanges(readChanges(String(row['changes'])), personal, rootId);
        all.push(rewrite.changes);
        if (rewrite.touched) await this.run(manager, SQL.updateChanges, { changes: toWireJson(rewrite.changes), id: row['id'] });
      }
      await this.record(rootType, rootId, 'anonymized', anonymizedEntryChanges(all, personal, rootId));
    });
  }

  /** Borra el historial de la raíz: su retención con \`then: delete\` o la purga de lo borrado (D8). */
  async purge(rootType: string, rootId: string): Promise<void> {
    await this.transactions.inTransaction(async (manager) => {
      await this.run(manager, SQL.deleteFields, { rootType, rootId });
      await this.run(manager, SQL.deleteEntries, { rootType, rootId });
    });
  }
}`
    )
  };
}

/** Las dos tablas, mapeadas SOLO para el esquema (como keel_timer): las crea el ORM y entran en el baseline. */
function ormFile(model) {
  const engine = model.stack.database;
  const transformers = new Set();
  const types = { timestamp: 'Date' };
  const property = (name) => name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  const fieldsOf = (table) =>
    table.columns.map((column) => {
      const physical = physicalColumn({ ...column, length: column.length }, engine);
      for (const symbol of physical.imports ?? []) transformers.add(symbol);
      const options = { name: column.name, ...physical.options, nullable: column.nullable };
      if (physical.transformer) options.transformer = physical.transformer;
      if (column.primary) delete options.nullable;
      const type = types[column.base] ?? 'string';
      return `  @${column.primary ? 'PrimaryColumn' : 'Column'}(${optionsLiteral(options)})\n  ${property(column.name)}!: ${column.nullable ? `${type} | null` : type};`;
    });
  const index = CHANGE_HISTORY.indexes[0];
  const fk = CHANGE_HISTORY_FIELD.columns.find((column) => column.references).references;
  const entryFields = fieldsOf(CHANGE_HISTORY);
  const fieldFields = fieldsOf(CHANGE_HISTORY_FIELD);
  return {
    path: CHANGE_HISTORY_ORM_TS,
    content: tsModule(
      CHANGE_HISTORY_ORM_TS,
      [
        { symbol: 'Column', from: 'typeorm' },
        { symbol: 'Entity', from: 'typeorm' },
        { symbol: 'Index', from: 'typeorm' },
        { symbol: 'JoinColumn', from: 'typeorm' },
        { symbol: 'ManyToOne', from: 'typeorm' },
        { symbol: 'PrimaryColumn', from: 'typeorm' },
        { symbol: 'Relation', from: 'typeorm', type: true },
        ...[...transformers].map((symbol) => ({ symbol, from: TRANSFORMERS_TS }))
      ],
      `/**
 * La tabla del historial, mapeada SOLO para el esquema: así la crea el ORM en \`local\` (synchronize), entra en el baseline
 * que exporta el pase de calidad y, en una base ya desplegada, en el paso de esquema de build. Nadie la lee por el ORM: la
 * usa ChangeHistory, con las sentencias de keel-core. Columnas e índice son los de keel-core (\`CHANGE_HISTORY\`): los
 * comparten los cuatro generadores.
 */
@Entity({ name: '${CHANGE_HISTORY.table}' })
@Index(${tsString(index.name)}, [${index.columns.map((name) => tsString(property(name))).join(', ')}])
export class ChangeHistoryOrm {
${entryFields.join('\n\n')}
}

/**
 * Los campos que tocó cada entrada, para el filtro por campo sin operadores JSON del motor (D11): su ruta y el campo de la
 * raíz que la contiene. Mapeada solo para el esquema, como ChangeHistoryOrm; se va con su entrada (ON DELETE CASCADE).
 */
@Entity({ name: '${CHANGE_HISTORY_FIELD.table}' })
export class ChangeHistoryFieldOrm {
${fieldFields.join('\n\n')}

  @ManyToOne(() => ChangeHistoryOrm, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entry_id', foreignKeyConstraintName: ${tsString(fk.name)} })
  entry?: Relation<ChangeHistoryOrm>;
}`
    )
  };
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────────────────────

function mongoStoreFile() {
  return {
    path: CHANGE_HISTORY_TS,
    content: tsModule(
      CHANGE_HISTORY_TS,
      [
        { symbol: 'Inject', from: '@nestjs/common' },
        { symbol: 'Injectable', from: '@nestjs/common' },
        { symbol: 'ClientSession', from: 'mongodb', type: true },
        { symbol: 'Collection', from: 'mongodb', type: true },
        { symbol: 'Filter', from: 'mongodb', type: true },
        { symbol: 'KeyedDocument', from: BSON_VALUES_TS, type: true },
        { symbol: 'FieldChange', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryChange', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryEntry', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'HistoryFilter', from: HISTORY_ENTRY_TS, type: true },
        { symbol: 'Page', from: PAGE_TS, type: true },
        { symbol: 'Pageable', from: PAGE_TS, type: true },
        { symbol: 'pageOf', from: PAGE_TS },
        { symbol: 'Uuids', from: UUIDS_TS },
        { symbol: 'toWireJson', from: WIRE_TS },
        { symbol: 'currentActor', from: AUDIT_ACTOR_TS },
        { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
        { symbol: 'PersonalPath', from: HISTORY_SUPPORT_TS, type: true },
        { symbol: 'anonymizeChanges', from: HISTORY_SUPPORT_TS },
        { symbol: 'anonymizedEntryChanges', from: HISTORY_SUPPORT_TS },
        { symbol: 'historyFieldRows', from: HISTORY_SUPPORT_TS },
        { symbol: 'readChanges', from: HISTORY_SUPPORT_TS }
      ],
      `/** La colección del historial (keel-core: \`CHANGE_HISTORY_COLLECTION\`); su índice lo crea document-indexes.ts. */
const COLLECTION = ${tsString(CHANGE_HISTORY_COLLECTION.collection)};

/**
 * El historial de cambios sobre MongoDB, con la forma documental de keel-core: un documento por entrada con los nombres
 * de las columnas, \`_id\` el id como texto y, en vez de la segunda tabla, \`${CHANGE_HISTORY_COLLECTION.fields}\` con la ruta y el campo de la raíz de
 * cada cambio. \`changes\` va como TEXTO, igual que en el relacional: un decimal o un número grande del cable no
 * sobreviven a pasar por BSON y volver.
 *
 * Por la sesión de la transacción en curso (TransactionContext): si la escritura revierte, la entrada también (D1). A
 * igual instante desempata el id, un UUID versión 7.
 */
@Injectable()
export class ChangeHistory {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  private get collection(): Collection<KeyedDocument<string>> {
    return this.transactions.collection(COLLECTION);
  }

  private get session(): ClientSession | undefined {
    return this.transactions.session();
  }

  /** Escribe una entrada con el autor de la escritura en curso, en su transacción. */
  async record(rootType: string, rootId: string, change: HistoryChange, changes: readonly FieldChange[]): Promise<void> {
    const fields = [...historyFieldRows(changes)].map(([path, top]) => ({ path, top }));
    await this.transactions.inTransaction((session) =>
      this.collection.insertOne(
        {
          _id: Uuids.v7(),
          root_type: rootType,
          root_id: rootId,
          at: new Date(),
          author: currentActor(),
          change_kind: change,
          changes: toWireJson(changes),
          ${CHANGE_HISTORY_COLLECTION.fields}: fields
        },
        { session }
      )
    );
  }

  /** Una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor. */
  async page(rootType: string, rootId: string, filter: HistoryFilter, pageable: Pageable): Promise<Page<HistoryEntry>> {
    const query: Filter<KeyedDocument<string>> = { root_type: rootType, root_id: rootId };
    // La ruta entera o el campo de la raíz que la contiene (historyMatches de keel-core).
    if (filter.field != null) query['$or'] = [{ 'fields.path': filter.field }, { 'fields.top': filter.field }];
    if (filter.from != null || filter.to != null) {
      query['at'] = { ...(filter.from != null ? { $gte: filter.from } : {}), ...(filter.to != null ? { $lte: filter.to } : {}) };
    }
    // Una tras otra y no en paralelo: dentro de una transacción el driver no admite operaciones concurrentes.
    const documents = await this.collection
      .find(query, { session: this.session })
      .sort({ at: -1, _id: -1 })
      .skip(pageable.page * pageable.size)
      .limit(pageable.size)
      .toArray();
    const total = await this.collection.countDocuments(query, { session: this.session });
    const entries: HistoryEntry[] = documents.map((document) => ({
      at: document['at'] as Date,
      author: String(document['author']),
      change: String(document['change_kind']) as HistoryChange,
      changes: readChanges(String(document['changes']))
    }));
    return pageOf(entries, pageable, total);
  }

  /** Reescribe los valores personales de todas las entradas de la raíz y deja la entrada \`anonymized\` (D8). */
  async anonymize(rootType: string, rootId: string, personal: readonly PersonalPath[]): Promise<void> {
    await this.transactions.inTransaction(async (session) => {
      const all: FieldChange[][] = [];
      for (const stored of await this.collection.find({ root_type: rootType, root_id: rootId }, { session }).toArray()) {
        const rewrite = anonymizeChanges(readChanges(String(stored['changes'])), personal, rootId);
        all.push(rewrite.changes);
        if (rewrite.touched) await this.collection.updateOne({ _id: stored._id }, { $set: { changes: toWireJson(rewrite.changes) } }, { session });
      }
      await this.record(rootType, rootId, 'anonymized', anonymizedEntryChanges(all, personal, rootId));
    });
  }

  /** Borra el historial de la raíz: su retención con \`then: delete\` o la purga de lo borrado (D8). */
  async purge(rootType: string, rootId: string): Promise<void> {
    await this.transactions.inTransaction((session) => this.collection.deleteMany({ root_type: rootType, root_id: rootId }, { session }));
  }
}`
    )
  };
}

/** El índice de la colección, para DOCUMENT_INDEXES (document-indexes.ts): la lectura de una raíz, la más reciente primero. */
export function historyDocumentIndexEntry(model) {
  if (!isDocument(model) || !usesHistory(model)) return null;
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  const keys = index.keys.map(([key, direction]) => `${tsString(key)}: ${direction}`).join(', ');
  return `  {\n    collection: ${tsString(CHANGE_HISTORY_COLLECTION.collection)},\n    indexes: [\n      { keys: { ${keys} }, options: { name: ${tsString(index.name)} } }\n    ]\n  }`;
}

/** La entidad de las tablas, para el DataSource (relacional). */
export function historyEntities(model) {
  if (!usesHistory(model) || isDocument(model) || !model.layersPresent?.persistence) return [];
  return [
    { symbol: 'ChangeHistoryOrm', from: CHANGE_HISTORY_ORM_TS },
    { symbol: 'ChangeHistoryFieldOrm', from: CHANGE_HISTORY_ORM_TS }
  ];
}

/** El enlace del almacén en el módulo de persistencia: `{ imports, bindings, exports }`. */
export function historyBindings(model) {
  if (!usesHistory(model) || !model.layersPresent?.persistence) return { imports: [], bindings: [], exports: [] };
  return { imports: [{ symbol: 'ChangeHistory', from: CHANGE_HISTORY_TS }], bindings: ['    ChangeHistory'], exports: ['ChangeHistory'] };
}

export function generate(model) {
  if (!model.layersPresent?.persistence || !usesHistory(model)) return [];
  const files = [entryFile(), supportFile(model)];
  if (isDocument(model)) files.push(mongoStoreFile());
  else files.push(sqlStoreFile(model), ormFile(model));
  return files;
}

// ─── Lo que gana el adaptador de cada raíz ───────────────────────────────────────────────────────────────────────

/** La dependencia del adaptador: el almacén. La última del constructor (constructorOf). */
export function historyDependency(entity) {
  if (!recordsHistory(entity)) return [];
  return [{ token: 'ChangeHistory', name: 'changeHistory', type: 'ChangeHistory', imports: [{ symbol: 'ChangeHistory', from: CHANGE_HISTORY_TS }] }];
}

/** La expresión TypeScript de una ruta del contrato sobre `variable` (`price.amount` → `entity.price?.amount`). */
function pathExpression(variable, path) {
  const [head, ...rest] = path.split('.');
  return [`${variable}.${head}`, ...rest].join('?.');
}

/** La línea que escribe una entrada sin cambios (`deleted`, `restored`) para el id `idExpr`. */
export function historyRecordLine(entity, change, idExpr, imports, indent) {
  if (!recordsHistory(entity)) return '';
  imports.push({ symbol: rootConstant(entity), from: HISTORY_SUPPORT_TS });
  return `${indent}// El historial (DSL 2.29): ${change === 'deleted' ? 'la baja' : 'la restauración'} deja su entrada, sin cambios de campos.\n${indent}await this.changeHistory.record(${rootConstant(entity)}.type, String(${idExpr}), '${change}', []);\n`;
}

/**
 * Los métodos privados del adaptador: la instantánea del agregado (D3: ruta del contrato → texto del cable, la forma de
 * keel-core) y la entrada de un guardado (D2).
 */
export function historyAdapterHelpers(model, entity, imports) {
  if (!recordsHistory(entity)) return [];
  const shape = entity.historyShape;
  imports.push(
    { symbol: 'historyDiff', from: HISTORY_SUPPORT_TS },
    { symbol: 'wireText', from: HISTORY_SUPPORT_TS },
    { symbol: 'HistorySnapshot', from: HISTORY_SUPPORT_TS, type: true },
    { symbol: rootConstant(entity), from: HISTORY_SUPPORT_TS }
  );
  const lines = shape.paths.map((path) => `    snapshot.set(${tsString(path)}, wireText(${pathExpression('entity', path)}));`);
  for (const child of shape.children) {
    const childLines = (indent) => child.paths.map((path) => `${indent}snapshot.set(prefix + ${tsString(path)}, wireText(${pathExpression('child', path)}));`).join('\n');
    if (child.list) {
      lines.push(`    for (const child of entity.${child.relation} ?? []) {
      const prefix = \`${child.relation}[\${String(child.${child.idField})}].\`;
${childLines('      ')}
    }`);
    } else {
      lines.push(`    const ${child.relation}Child = entity.${child.relation};
    if (${child.relation}Child != null) {
      const child = ${child.relation}Child;
      const prefix = ${tsString(`${child.relation}.`)};
${childLines('      ')}
    }`);
    }
  }
  const id = entity.idField?.name ?? 'id';
  return [
    `  /** Lo que registra el historial de ${entity.name} (DSL 2.29): ruta del contrato → valor del cable. */
  private historySnapshot(entity: ${entity.name}): HistorySnapshot {
    const snapshot = new Map<string, string>();
${lines.join('\n')}
    return snapshot;
  }`,
    `  /** La entrada de un guardado (D2): created si no había nada; updated solo si algo cambió. */
  private async recordSave(before: HistorySnapshot | null, saved: ${entity.name}): Promise<void> {
    const changes = historyDiff(before, this.historySnapshot(saved));
    if (before == null) await this.changeHistory.record(${rootConstant(entity)}.type, String(saved.${id}), 'created', changes);
    else if (changes.length > 0) await this.changeHistory.record(${rootConstant(entity)}.type, String(saved.${id}), 'updated', changes);
  }`
  ];
}

// ─── La lectura (D7) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las lecturas del historial de una raíz: una por forma de cargarla. `{ method, by, load, scoped, param }`: por id (la
 * carga viva del puerto) o, si la query va acotada, por la carga acotada de la ficha (`loadScoped`/`loadScopedBy<Clave>`).
 * La misma derivación que keel-spring.
 */
export function historyReadsOf(model, entity) {
  const reads = new Map();
  for (const operation of model.services.flatMap((group) => group.operations)) {
    if (operation.historyOf !== entity.name) continue;
    const load = operation.readScope ? scopedLoadOf(model, operation) : null;
    const by = load?.by === 'key' ? 'key' : 'id';
    const method = by === 'id' ? 'historyOf' : `historyOfBy${load.field[0].toUpperCase()}${load.field.slice(1)}`;
    if (reads.has(method)) continue;
    const field = by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    reads.set(method, { method, by, load: load?.method ?? 'findById', scoped: Boolean(operation.readScope), param: { name: field.name, type: field.tsType ?? 'string' } });
  }
  return [...reads.values()];
}

const readParams = (read) => [`${read.param.name}: ${read.param.type}`, ...(read.scoped ? ['scope: ReadScope'] : []), 'filter: HistoryFilter', 'pageable: Pageable'].join(', ');

function readImports(read, imports) {
  imports.push(
    { symbol: 'HistoryEntry', from: HISTORY_ENTRY_TS, type: true },
    { symbol: 'HistoryFilter', from: HISTORY_ENTRY_TS, type: true },
    { symbol: 'Page', from: PAGE_TS, type: true },
    { symbol: 'Pageable', from: PAGE_TS, type: true }
  );
  if (read.scoped) imports.push({ symbol: 'ReadScope', from: READ_SCOPE_TS, type: true });
}

export function historyPortMethods(model, entity, imports) {
  return historyReadsOf(model, entity).map((read) => {
    readImports(read, imports);
    return `  /**
   * El historial de cambios de ${entity.name} (DSL 2.29), la entrada más reciente primero: carga la raíz con la misma
   * lectura que su ficha —viva${read.scoped ? ' y con el alcance del llamante' : ''}— y null si no la ve. El filtro y la página
   * los aplica el almacén.
   */
  abstract ${read.method}(${readParams(read)}): Promise<Page<HistoryEntry> | null>;`;
  });
}

export function historyReadMethods(model, entity, imports) {
  return historyReadsOf(model, entity).map((read) => {
    readImports(read, imports);
    imports.push({ symbol: rootConstant(entity), from: HISTORY_SUPPORT_TS });
    return `  async ${read.method}(${readParams(read)}): Promise<Page<HistoryEntry> | null> {
    // D7: la misma lectura que la ficha; lo que ella no ve, el historial tampoco.
    const root = await this.${read.load}(${read.param.name}${read.scoped ? ', scope' : ''});
    return root == null ? null : this.changeHistory.page(${rootConstant(entity)}.type, String(root.${entity.idField?.name ?? 'id'}), filter, pageable);
  }`;
  });
}

// ─── La query ────────────────────────────────────────────────────────────────────────────────────────────────────

/** El tipo que devuelve una query de historial: la página del contrato. */
export const HISTORY_RESPONSE = 'PagedResponse<HistoryEntry>';

/** Lo que importa quien nombra ese tipo. */
export const historyResponseImport = () => ({ symbol: 'HistoryEntry', from: HISTORY_ENTRY_TS, type: true });

/** La nota del handler (la neutral de keel-core), con la llamada en TypeScript. */
export function handlerNote(model, operation) {
  const root = model.entities.find((entity) => entity.name === operation.historyOf);
  if (!root) return null;
  const reads = historyReadsOf(model, root);
  const read = reads.find((candidate) => (operation.readScope ? candidate.scoped : !candidate.scoped)) ?? reads[0];
  if (!read) return null;
  const filter = HISTORY_FILTER_ORDER.map((role) => `${role}: ${operation.historyFilters?.[role] ? `query.${operation.historyFilters[role]}` : 'null'}`).join(', ');
  const call = `await this.${root.name[0].toLowerCase()}${root.name.slice(1)}Repository.${read.method}(<${read.by === 'id' ? 'su id' : `su ${read.param.name}`}>${read.scoped ? ', query.readScope' : ''}, { ${filter} }, query.pageable)`;
  return historyNote(operation, { historyCall: call });
}
