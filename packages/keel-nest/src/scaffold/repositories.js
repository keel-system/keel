// Persistencia hexagonal de cada raíz de agregado persistida, el mismo reparto que keel-spring:
//   · el PUERTO `<Raíz>Repository` en domain/repository, una clase abstracta (sirve de token de
//     inyección) que solo nombra el dominio y la página de domain/repository/page.ts;
//   · el ADAPTADOR `<Raíz>RepositoryImpl` en infrastructure/persistence/repositories, sobre TypeORM,
//     con el mapeo dominio↔ORM escrito campo a campo (toDomain/toOrm), sin reflexión.
//
// El adaptador toma el EntityManager de la transacción abierta (TransactionContext, que la propaga
// con AsyncLocalStorage): los handlers no ven la transacción, la abre el UseCaseMediator. Una
// escritura sin transacción ambiente —un barrido despachado sin ella— abre la suya, como el
// @Transactional de método de keel-spring.
//
// Dos cosas que TypeORM no hace y Hibernate sí, y que aquí se escriben:
//   · el BLOQUEO OPTIMISTA: la versión se sube con un UPDATE condicionado a la esperada antes de
//     guardar el grafo; cero filas es otra escritura que ganó (o un borrado), y sale como conflicto;
//   · la AUDITORÍA: `created_*`/`updated_*` los estampa el adaptador, como el listener de Spring Data.

import { persistedMembers, collectInternalEntities, orderingFieldOf, partialUniqueIndexes, LOCK_VERSION } from 'keel-core/gen';
import { DIRS, classPath, capitalize, entityDir, tsModule, tsString } from './render.js';
import { bridgeClass, bridgePath, usesBridge } from './messaging.js';
import { domainMembers } from './entities.js';
import { adapterClaimMethods, claimDependencies, portClaimMethods } from './claim.js';
import { adapterReconciliationMethods, portReconciliationMethods, reconciliationDependencies } from './reconciliation-claim.js';
import {
  usesRelational,
  ormClass,
  ormPath,
  elementClass,
  unidirectionalParents,
  fkProperty,
  TEXT_FOLD_TS
} from './persistence-entities.js';

export const PORT_DIR = 'domain/repository';
export const REPO_DIR = 'infrastructure/persistence/repositories';
export const PAGE_TS = `src/${PORT_DIR}/page.ts`;
export const TRANSACTION_CONTEXT_TS = 'src/infrastructure/persistence/transaction-context.ts';
export const PERSISTENCE_ERRORS_TS = 'src/infrastructure/persistence/persistence-errors.ts';

export const portClass = (entity) => `${entity.name}Repository`;
export const portPath = (entity) => classPath(PORT_DIR, portClass(entity));
export const adapterClass = (entity) => `${entity.name}RepositoryImpl`;
export const adapterPath = (entity) => classPath(REPO_DIR, adapterClass(entity));

/** Las raíces que tienen repositorio: persistidas y raíz de su agregado. */
export function repositoryRoots(model) {
  if (!usesRelational(model)) return [];
  return model.entities.filter((entity) => entity.persisted && entity.isAggregateRoot);
}

/** ¿Alguna operación de la raíz pagina? Entonces el puerto lleva `list(pageable)`. */
export function isPaginated(model, entity) {
  return (model.services ?? []).some((group) => group.entity === entity.name && (group.operations ?? []).some((op) => op.paginated));
}

export function generate(model) {
  const roots = repositoryRoots(model);
  if (roots.length === 0) return [];
  const files = [{ path: PAGE_TS, content: tsModule(PAGE_TS, [], pageBody()) }];
  for (const entity of roots) {
    files.push(renderPort(model, entity));
    files.push(renderAdapter(model, entity));
  }
  return files;
}

// ─── Clave natural ───────────────────────────────────────────────────────────

/**
 * El finder de la clave natural, resuelto contra los MIEMBROS del dominio: una clave que atraviesa
 * otro agregado (`naturalKey: [owner, slug]`) se busca por `ownerId`, que es lo que el agregado
 * guarda. Cada parámetro dice cómo se escribe su condición en la entidad ORM.
 */
export function naturalKeyFinder(model, entity) {
  return keyFinder(model, entity, entity.naturalKey ?? []);
}

/**
 * Los finders de la fila que OCUPA cada índice único condicionado (`indexes` con `when` sobre un campo
 * directo): como mucho una por clave, que es lo que el índice garantiza. La operación que releva la
 * busca aquí para retirarla antes de activar la nueva. El mismo criterio que keel-spring; no se repite
 * el de la clave natural si coincidieran.
 */
export function occupantFinders(model, entity) {
  const seen = new Set([naturalKeyFinder(model, entity)?.name].filter(Boolean));
  const finders = [];
  for (const index of partialUniqueIndexes(entity)) {
    if (!index.when?.field || index.when.field.includes('.')) continue;
    const finder = keyFinder(model, entity, [...index.fields, index.when.field]);
    if (!finder || seen.has(finder.name)) continue;
    seen.add(finder.name);
    finders.push({ ...finder, state: index.when.equals });
  }
  return finders;
}

function keyFinder(model, entity, keys) {
  if (keys.length === 0) return null;
  const members = domainMembers(model, entity);
  const persisted = persistedMembers(model, entity);
  const params = keys.map((key) => {
    const member = members.find((m) => m.name === key || m.relation?.name === key);
    if (!member) return { name: key, type: 'string', where: [[key, key]], imports: [] };
    if (member.kind === 'externalRef') return { name: member.name, type: 'string', where: [[member.name, member.name]], imports: [] };
    const field = member.field;
    if (field?.kind === 'composite') {
      const vo = persisted.find((m) => m.kind === 'vo' && m.name === field.name);
      return {
        name: field.name,
        type: field.tsType,
        where: (vo?.subs ?? []).map((sub) => [sub.name, `${field.name}.${sub.voAccessor}`]),
        imports: [{ symbol: field.namedType, from: classPath(DIRS.valueObjects, field.namedType), type: true }]
      };
    }
    return { name: field.name, type: field.tsType, where: [[field.name, field.name]], imports: typeImportsOf(field) };
  });
  return { name: `findBy${params.map((p) => capitalize(p.name)).join('And')}`, params };
}

function typeImportsOf(field) {
  const imports = (field.imports ?? []).filter((imp) => imp.from?.startsWith('src/')).map((imp) => ({ ...imp, type: true }));
  if (field.kind === 'enum' && field.namedType) imports.push({ symbol: field.namedType, from: classPath(DIRS.enums, field.namedType), type: true });
  return imports;
}

// ─── El puerto ───────────────────────────────────────────────────────────────

function pageBody() {
  return `/**
 * Paginación del puerto de persistencia, sin framework: el dominio la nombra y el adaptador la
 * resuelve. Es la misma semántica que el Pageable/Page de Spring Data que usa keel-spring: página
 * desde 0, el orden pedido y el desempate por id lo pone el adaptador.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  /**
   * Propiedad por la que se ordena, como la nombra el contrato: la de la columna (\`name\`,
   * \`createdAt\`, \`priceAmount\` para un value object aplanado).
   */
  readonly property: string;
  readonly direction: SortDirection;
}

export interface Pageable {
  /** Página pedida, desde 0. */
  readonly page: number;
  /** Elementos por página, ya acotados al tope del diseño. */
  readonly size: number;
  /** Orden pedido, en orden de prioridad. Vacío: el que decida el adaptador (el id). */
  readonly sort: readonly SortOrder[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly size: number;
  readonly totalElements: number;
  readonly totalPages: number;
}

/** La misma página con sus elementos transformados (la del dominio → la del contrato). */
export function mapPage<T, R>(page: Page<T>, map: (item: T) => R): Page<R> {
  return { ...page, items: page.items.map(map) };
}`;
}

function renderPort(model, entity) {
  const file = portPath(entity);
  const domainFile = classPath(entityDir(entity), entity.name);
  const imports = [{ symbol: entity.name, from: domainFile, type: true }];
  const id = entity.idField;
  const idType = id?.tsType ?? 'string';
  const methods = [`  abstract findById(${id?.name ?? 'id'}: ${idType}): Promise<${entity.name} | null>;`];
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) imports.push(...param.imports);
    methods.push(
      `  /** El agregado por su clave natural (${entity.naturalKey.join(', ')}), o null. */\n` +
        `  abstract ${finder.name}(${finder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null>;`
    );
  }
  for (const occupant of occupantFinders(model, entity)) {
    for (const param of occupant.params) imports.push(...param.imports);
    methods.push(
      `  /**
   * La fila que OCUPA el índice único condicionado sobre '${occupant.state}': como mucho una por clave.
` +
        `   * La operación que releva la busca aquí para retirarla antes de activar la nueva.
   */
` +
        `  abstract ${occupant.name}(${occupant.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null>;`
    );
  }
  if (isPaginated(model, entity)) {
    imports.push({ symbol: 'Page', from: PAGE_TS, type: true }, { symbol: 'Pageable', from: PAGE_TS, type: true });
    methods.push(`  /** Una página de agregados, en el orden pedido y con el id como desempate. */\n  abstract list(pageable: Pageable): Promise<Page<${entity.name}>>;`);
  }
  // Los reclamos de los barridos que sacan filas de esta raíz (incremento 10c).
  methods.push(...portClaimMethods(model, entity));
  // Los reclamos de los barridos de reconciliación que la esperan (incremento 11c).
  methods.push(...portReconciliationMethods(model, entity));
  methods.push(
    `  /**\n   * Guarda el agregado entero (sus entidades internas y sus listas) y devuelve lo guardado. Con\n   * bloqueo optimista, una versión obsoleta sale como conflicto de concurrencia.\n   */\n  abstract save(entity: ${entity.name}): Promise<${entity.name}>;`,
    `  abstract deleteById(${id?.name ?? 'id'}: ${idType}): Promise<void>;`
  );
  const body = `/**
 * Puerto de persistencia del agregado ${entity.name}. Clase abstracta y no interfaz: sirve también de
 * token de inyección, sin que el dominio importe nada del framework. El adaptador vive en
 * infrastructure/persistence/repositories.
 */
export abstract class ${portClass(entity)} {
${methods.join('\n\n')}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

// ─── El adaptador ────────────────────────────────────────────────────────────

/** Las relaciones que se cargan con la raíz: el árbol del agregado, listas incluidas. */
export function relationsTree(model, entity, seen = new Set([entity.name])) {
  const tree = {};
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'elementCollection') tree[member.name] = true;
    else if ((member.kind === 'relationMany' || member.kind === 'relationOne') && !member.relation.backReference && member.relation.cardinality !== 'many-to-many') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      if (!child || seen.has(child.name)) continue;
      const nested = relationsTree(model, child, new Set([...seen, child.name]));
      tree[member.name] = Object.keys(nested).length > 0 ? nested : true;
    }
  }
  return tree;
}

function literal(tree) {
  const entries = Object.entries(tree).map(([key, value]) => `${key}: ${value === true ? 'true' : literal(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function renderAdapter(model, entity) {
  const file = adapterPath(entity);
  const involved = collectInternalEntities(model, entity).filter((candidate) => candidate.persisted);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'EntityManager', from: 'typeorm', type: true },
    { symbol: portClass(entity), from: portPath(entity) },
    { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }
  ];
  for (const candidate of involved) {
    imports.push({ symbol: candidate.name, from: classPath(entityDir(candidate), candidate.name) });
    imports.push({ symbol: ormClass(candidate.name), from: ormPath(candidate.name) });
  }
  const mappers = [];
  const helpers = new Set();
  for (const candidate of involved) {
    mappers.push(toDomainFunction(model, candidate, imports, helpers));
    mappers.push(toOrmFunction(model, candidate, entity, imports, helpers));
  }

  const id = entity.idField;
  const idName = id?.name ?? 'id';
  const idType = id?.tsType ?? 'string';
  const relations = relationsTree(model, entity);
  const hasRelations = Object.keys(relations).length > 0;
  const findOptions = (where) => `{ where: ${where}${hasRelations ? ', relations: RELATIONS' : ''} }`;
  const methods = [];

  methods.push(`  async findById(${idName}: ${idType}): Promise<${entity.name} | null> {
    const found = await this.manager.findOne(${ormClass(entity.name)}, ${findOptions(`{ ${idName} }`)});
    return found == null ? null : toDomain${entity.name}(found);
  }`);

  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) imports.push(...param.imports);
    const where = finder.params.flatMap((param) => param.where.map(([prop, expr]) => (prop === expr ? prop : `${prop}: ${expr}`)));
    methods.push(`  async ${finder.name}(${finder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null> {
    const found = await this.manager.findOne(${ormClass(entity.name)}, ${findOptions(`{ ${where.join(', ')} }`)});
    return found == null ? null : toDomain${entity.name}(found);
  }`);
  }

  for (const occupant of occupantFinders(model, entity)) {
    for (const param of occupant.params) imports.push(...param.imports);
    const where = occupant.params.flatMap((param) => param.where.map(([prop, expr]) => (prop === expr ? prop : `${prop}: ${expr}`)));
    methods.push(`  async ${occupant.name}(${occupant.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null> {
    const found = await this.manager.findOne(${ormClass(entity.name)}, ${findOptions(`{ ${where.join(', ')} }`)});
    return found == null ? null : toDomain${entity.name}(found);
  }`);
  }

  if (isPaginated(model, entity)) {
    imports.push({ symbol: 'Page', from: PAGE_TS, type: true }, { symbol: 'Pageable', from: PAGE_TS, type: true });
    imports.push({ symbol: 'FindOptionsOrder', from: 'typeorm', type: true });
    methods.push(`  async list(pageable: Pageable): Promise<Page<${entity.name}>> {
    const [rows, total] = await this.manager.findAndCount(${ormClass(entity.name)}, {
      ${hasRelations ? 'relations: RELATIONS,\n      ' : ''}order: withStableOrder(pageable),
      skip: pageable.page * pageable.size,
      take: pageable.size
    });
    return {
      items: rows.map(toDomain${entity.name}),
      page: pageable.page,
      size: pageable.size,
      totalElements: total,
      totalPages: Math.ceil(total / pageable.size)
    };
  }`);
  }

  methods.push(...adapterClaimMethods(model, entity, imports, findOptions));
  methods.push(...adapterReconciliationMethods(model, entity, imports, findOptions));
  methods.push(saveMethod(model, entity, imports));
  methods.push(`  async deleteById(${idName}: ${idType}): Promise<void> {
    await this.transactions.inTransaction(async (manager) => {
      // Se carga y se borra el GRAFO: las filas de las hijas y de las listas van antes que la raíz.
      const found = await manager.findOne(${ormClass(entity.name)}, ${findOptions(`{ ${idName} }`)});
      if (found != null) await manager.remove(found);
    });
  }`);

  const sortable = sortableProperties(model, entity);
  const body = `${hasRelations ? `/** El agregado entero: lo que se carga con la raíz y se borra con ella. */\nconst RELATIONS = ${literal(relations)} as const;\n\n` : ''}${isPaginated(model, entity) ? stableOrderHelper(entity, sortable) : ''}/**
 * Adaptador del puerto ${portClass(entity)} sobre TypeORM. Toma el EntityManager de la transacción
 * abierta (la abre el UseCaseMediator); sin ella, cada lectura va sola y cada escritura abre la suya.
 */
@Injectable()
export class ${adapterClass(entity)} extends ${portClass(entity)} {
${constructorOf(model, entity, imports)}

  private get manager(): EntityManager {
    return this.transactions.manager();
  }

${methods.join('\n\n')}
}

// ─── Mapeo dominio ↔ ORM ─────────────────────────────────────────────────────

${mappers.join('\n\n')}${[...helpers].length > 0 ? `\n\n${[...helpers].join('\n\n')}` : ''}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/**
 * Las propiedades por las que se puede ordenar un listado: las columnas de la raíz con el nombre que
 * les da la entidad de persistencia (un value object aplanado es `priceAmount`, un campo plegado
 * ordena por su sombra). Es lo que acepta el `?sort=` de keel-spring, que ordena por las propiedades
 * de su entidad JPA, y lo que el diseño escribe en su orden por defecto (`output.sort`).
 */
function sortableProperties(model, entity) {
  const props = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      props.push(member.name);
      if (member.folded) props.push(member.folded.name);
    } else if (member.kind === 'externalRef') props.push(member.name);
    else if (member.kind === 'vo') for (const sub of member.subs) if (sub.subKind !== 'composite') props.push(sub.name);
  }
  if (entity.auditTimestamps === 'all') props.push('createdAt', 'updatedAt');
  return props;
}

function stableOrderHelper(entity, sortable) {
  const idName = entity.idField?.name ?? 'id';
  return `/** Las propiedades por las que se puede ordenar: las de la entidad de persistencia. */
const SORTABLE = new Set<string>([${sortable.map(tsString).join(', ')}]);

/**
 * El orden pedido más el id como último criterio si no está ya: sin desempate, dos páginas
 * consecutivas pueden repetir una fila y omitir otra, porque cuando el ORDER BY empata el motor no
 * promete un orden estable entre consultas. Una propiedad que no existe es un error, como la
 * PropertyReferenceException de Spring Data.
 */
function withStableOrder(pageable: Pageable): FindOptionsOrder<${ormClass(entity.name)}> {
  const order: Record<string, 'ASC' | 'DESC'> = {};
  for (const { property, direction } of pageable.sort) {
    if (!SORTABLE.has(property)) throw new Error(\`No existe la propiedad '\${property}' para ordenar ${entity.name}\`);
    order[property] ??= direction === 'desc' ? 'DESC' : 'ASC';
  }
  order[${tsString(idName)}] ??= 'ASC';
  return order as FindOptionsOrder<${ormClass(entity.name)}>;
}

`;
}

/**
 * El constructor del adaptador: la transacción; si la raíz emite eventos y hay mensajería, el puente de
 * integración al que los entrega; y si algún barrido la reclama, la configuración de los barridos (y los
 * parámetros del servicio, si un rescate lee de ellos su plazo).
 */
function constructorOf(model, entity, imports) {
  const deps = [{ token: 'TransactionContext', name: 'transactions', type: 'TransactionContext' }];
  if (emitsDomainEvents(model, entity)) {
    imports.push({ symbol: bridgeClass(model), from: bridgePath(model) });
    deps.push({ token: bridgeClass(model), name: 'events', type: bridgeClass(model) });
  }
  for (const dep of [...claimDependencies(model, entity), ...reconciliationDependencies(model, entity)]) {
    imports.push(...dep.imports);
    deps.push(dep);
  }
  if (deps.length === 1) {
    return `  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }`;
  }
  return `  constructor(
${deps.map((dep) => `    @Inject(${dep.token}) private readonly ${dep.name}: ${dep.type}`).join(',\n')}
  ) {
    super();
  }`;
}

/** ¿La raíz emite eventos que salen por el puente? */
export function emitsDomainEvents(model, entity) {
  return usesBridge(model) && (model.events ?? []).some((event) => event.aggregates.includes(entity.name));
}

function saveMethod(model, entity, imports) {
  const versioned = entity.usesOptimisticLocking;
  const versionProp = entity.declaresLockVersion ? 'lockVersion' : LOCK_VERSION.field;
  const idName = entity.idField?.name ?? 'id';
  const audits = auditStamps(model, entity);
  const lines = [`      const orm = toOrm${entity.name}(entity);`];
  if (audits.length > 0) {
    lines.push('      const now = new Date();');
    lines.push(...audits.map((line) => `      ${line}`));
  }
  if (versioned) {
    imports.push({ symbol: 'OptimisticLockConflict', from: PERSISTENCE_ERRORS_TS });
    lines.push(`      const expected = entity.${versionProp};
      if (expected == null) {
        // Agregado nuevo: nace con la versión 0, como el @Version de JPA al persistir.
        orm.${versionProp} = 0;
      } else {
        // Sube la versión SOLO si sigue siendo la que el agregado leyó; el UPDATE además bloquea la
        // fila hasta el commit. Cero filas: otra escritura ganó (o la borró), y reaplicar esta
        // reharía en silencio una intención obsoleta.
        const bumped = await manager
          .createQueryBuilder()
          .update(${ormClass(entity.name)})
          .set({ ${versionProp}: () => '${LOCK_VERSION.column} + 1' })
          .where({ ${idName}: entity.${idName}, ${versionProp}: expected })
          .execute();
        if (!bumped.affected) throw new OptimisticLockConflict(${tsString(entity.name)}, String(entity.${idName}));
        orm.${versionProp} = Number(expected) + 1;
      }`);
  }
  // Los eventos que la raíz acumuló: sin capa de mensajería no hay quién los escuche (llega con el
  // incremento 9), pero se vacían igual para que el buffer no crezca con cada escritura.
  const emitsEvents = (model.events ?? []).some((event) => event.aggregates.includes(entity.name));
  lines.push(`      const saved = await manager.save(${ormClass(entity.name)}, orm);`);
  if (emitsEvents && usesBridge(model)) {
    // Los eventos que la raíz acumuló salen por el puente DENTRO de esta transacción: con outbox, la fila
    // y el cambio confirman o revierten juntos; con best-effort, se publican tras el commit.
    lines.push('      await this.events.publish(entity.pullDomainEvents());');
  } else if (emitsEvents) {
    // Sin capa de mensajería nadie los escucha, pero se vacían igual para que el buffer no crezca.
    lines.push('      entity.pullDomainEvents();');
  }
  lines.push(`      return toDomain${entity.name}(saved);`);
  return `  async save(entity: ${entity.name}): Promise<${entity.name}> {
    return this.transactions.inTransaction(async (manager) => {
${lines.join('\n')}
    });
  }`;
}

/** Las líneas que estampan la auditoría en la raíz y sus hijas al guardar. */
function auditStamps(model, entity) {
  const lines = [];
  const stamp = (target, axis) => {
    if (axis === 'createdAt') lines.push(`${target}.createdAt ??= now;`);
    else lines.push(`${target}.updatedAt = now;`);
  };
  const involved = collectInternalEntities(model, entity).filter((candidate) => candidate.persisted);
  for (const candidate of involved) {
    const ts = candidate.auditTimestamps;
    if (ts !== 'all' && ts !== 'declared') continue;
    const hasCreated = ts === 'all' || candidate.fields.some((field) => field.name === 'createdAt');
    const hasUpdated = ts === 'all' || candidate.fields.some((field) => field.name === 'updatedAt');
    if (candidate === entity) {
      if (hasCreated) stamp('orm', 'createdAt');
      if (hasUpdated) stamp('orm', 'updatedAt');
    } else {
      const path = pathTo(model, entity, candidate);
      if (!path) continue;
      const parts = [];
      if (hasCreated) parts.push('child.createdAt ??= now;');
      if (hasUpdated) parts.push('child.updatedAt = now;');
      lines.push(`for (const child of ${walk(path)}) { ${parts.join(' ')} }`);
    }
  }
  return lines;
}

/** El camino de relaciones de la raíz a una entidad interna. */
function pathTo(model, from, target, seen = new Set()) {
  for (const relation of from.relations ?? []) {
    if (!relation.internal || relation.backReference || seen.has(relation.entity)) continue;
    const next = model.entities.find((candidate) => candidate.name === relation.entity);
    if (!next) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (next === target) return [{ name: relation.name, toMany }];
    const rest = pathTo(model, next, target, new Set([...seen, from.name]));
    if (rest) return [{ name: relation.name, toMany }, ...rest];
  }
  return null;
}

/** Las instancias ORM de una entidad interna, recorriendo el camino desde la raíz. */
function walk(path) {
  const step = (source, { name, toMany }) => (toMany ? `(${source}.${name} ?? [])` : `[${source}.${name}].filter((node) => node != null)`);
  return path.reduce(
    (expr, current, index) => (index === 0 ? step('orm', current) : `${expr}.flatMap((node) => ${step('node', current)})`),
    ''
  );
}

// ─── toDomain ────────────────────────────────────────────────────────────────

function toDomainFunction(model, entity, imports, helpers) {
  const persisted = persistedMembers(model, entity);
  const state = [];
  for (const member of domainMembers(model, entity)) {
    state.push(`    ${member.name}: ${domainValue(model, entity, member, persisted, imports, helpers)}`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) state.push(`    ${LOCK_VERSION.field}: orm.${LOCK_VERSION.field}`);
  return `function toDomain${entity.name}(orm: ${ormClass(entity.name)}): ${entity.name} {
  return new ${entity.name}({
${state.join(',\n')}
  });
}`;
}

function domainValue(model, entity, member, persisted, imports, helpers) {
  if (member.kind === 'externalRef') return `orm.${member.name}`;
  if (member.kind === 'relationMany') {
    const child = member.relation.entity;
    const ordering = orderingFieldOf(model, child);
    const sorted = ordering ? `[...(orm.${member.name} ?? [])].sort((a, b) => compareOrder(a.${ordering.name}, b.${ordering.name}))` : `(orm.${member.name} ?? [])`;
    if (ordering) helpers.add(compareOrderHelper());
    return `${sorted}.map(toDomain${child})`;
  }
  if (member.kind === 'relationOne') {
    return `orm.${member.name} == null ? null : toDomain${member.relation.entity}(orm.${member.name})`;
  }
  const field = member.field;
  if (field.list) {
    helpers.add(byPositionHelper());
    const elements = `[...(orm.${field.name} ?? [])].sort(byPosition)`;
    if (field.kind === 'composite') {
      const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
      if (!vo || vo.fields.some((sub) => sub.kind === 'composite')) return unmapped(entity, field, helpers);
      imports.push({ symbol: vo.name, from: classPath(DIRS.valueObjects, vo.name) });
      const args = vo.fields.map((sub) => `element.${sub.name}${sub.required ? '' : ''}`);
      return `${elements}.map((element) => new ${vo.name}(${args.join(', ')}))`;
    }
    return `${elements}.map((element) => element.value!)`;
  }
  if (field.kind === 'composite') {
    const vo = persisted.find((m) => m.kind === 'vo' && m.name === field.name);
    const voDef = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    if (!vo || !voDef || vo.subs.length === 0 || vo.subs.some((sub) => sub.subKind === 'composite')) return unmapped(entity, field, helpers);
    imports.push({ symbol: voDef.name, from: classPath(DIRS.valueObjects, voDef.name) });
    // Un value object OPCIONAL ausente es null, no un objeto con todo a null: la marca de presencia
    // es un campo obligatorio del propio value object.
    const marker = voDef.fields.find((sub) => sub.required);
    const guarded = !field.required && marker;
    const args = vo.subs.map((sub) => `orm.${sub.name}${guarded && sub.sub.required ? '!' : ''}`);
    const build = `new ${voDef.name}(${args.join(', ')})`;
    return guarded ? `orm.${field.name}${capitalize(marker.name)} == null ? null : ${build}` : build;
  }
  return `orm.${field.name}`;
}

function unmapped(entity, field, helpers) {
  helpers.add(`/** Lo que build no sabe mapear (un value object anidado): compila y falla al usarse, nombrándolo. */
function unmapped(what: string): never {
  throw new Error(\`TODO (agente): mapear \${what} (value object anidado, ver skill keel-nest-database)\`);
}`);
  return `unmapped(${tsString(`${entity.name}.${field.name}`)})`;
}

function byPositionHelper() {
  return `/** El orden de una lista guardada: la posición con la que se escribió cada elemento. */
function byPosition(a: { position: number }, b: { position: number }): number {
  return a.position - b.position;
}`;
}

function compareOrderHelper() {
  return `/** El orden propio de una colección hija (su campo de posición), con los vacíos al final. */
function compareOrder(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return Number(a) - Number(b);
}`;
}

/** El nombre del campo id de una entidad. */
function idOf(model, entityName) {
  return model.entities.find((candidate) => candidate.name === entityName)?.idField?.name ?? 'id';
}

// ─── toOrm ───────────────────────────────────────────────────────────────────

function toOrmFunction(model, entity, root, imports, helpers) {
  const lines = [];
  const domainProps = new Set(domainMembers(model, entity).map((member) => member.name));
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      lines.push(`  orm.${member.name} = entity.${member.name};`);
      if (member.folded) {
        imports.push({ symbol: 'TextFold', from: TEXT_FOLD_TS });
        lines.push(`  orm.${member.folded.name} = TextFold.${member.folded.accents ? 'foldCaseAndAccents' : 'foldCase'}(entity.${member.name});`);
      }
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) {
        if (sub.subKind === 'composite') {
          lines.push(`  // TODO (agente): mapear ${member.field.namedType}.${sub.voAccessor} (value object anidado).`);
          continue;
        }
        lines.push(
          member.field.required
            ? `  orm.${sub.name} = entity.${member.name}.${sub.voAccessor};`
            : `  orm.${sub.name} = entity.${member.name}?.${sub.voAccessor} ?? null;`
        );
      }
    } else if (member.kind === 'externalRef') {
      lines.push(`  orm.${member.name} = entity.${member.name};`);
    } else if (member.kind === 'elementCollection') {
      const element = elementClass(entity, member);
      imports.push({ symbol: element, from: ormPath(entity.name) });
      const idName = entity.idField?.name ?? 'id';
      if (member.element.kind === 'vo') {
        const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
        const copies = (vo?.fields ?? []).filter((sub) => sub.kind !== 'composite').map((sub) => `${sub.name}: value.${sub.name}`);
        lines.push(
          `  orm.${member.name} = entity.${member.name}.map((value, position) =>\n    Object.assign(new ${element}(), { ownerId: entity.${idName}, position, ${copies.join(', ')} })\n  );`
        );
      } else {
        lines.push(`  orm.${member.name} = entity.${member.name}.map((value, position) => Object.assign(new ${element}(), { ownerId: entity.${idName}, position, value }));`);
      }
    } else if (member.kind === 'relationMany') {
      if (member.relation.cardinality === 'many-to-many') {
        lines.push(`  // TODO (agente): mapear ${member.name} (many-to-many dentro del agregado).`);
        continue;
      }
      const child = member.relation.entity;
      lines.push(`  orm.${member.name} = entity.${member.name}.map((child) => toOrm${child}(child, orm));`);
    } else if (member.kind === 'relationOne') {
      if (member.relation.backReference) continue;
      if (!domainProps.has(member.name)) continue;
      lines.push(`  orm.${member.name} = entity.${member.name} == null ? null : toOrm${member.relation.entity}(entity.${member.name}, orm);`);
      lines.push(`  orm.${fkProperty(member.name)} = entity.${member.name}?.${idOf(model, member.relation.entity)} ?? null;`);
    }
  }
  // La vuelta a la raíz (back-reference declarada, o la sintética del one-to-many unidireccional):
  // la pone el padre al mapear, porque el dominio no la nombra.
  const parentParams = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'relationOne' && member.relation.backReference) {
      parentParams.push({
        type: ormClass(member.relation.entity),
        assign: `  orm.${member.name} = parent as ${ormClass(member.relation.entity)};
    orm.${fkProperty(member.name)} = (parent as ${ormClass(member.relation.entity)}).${idOf(model, member.relation.entity)};`
      });
    }
  }
  for (const owner of unidirectionalParents(model, entity)) {
    parentParams.push({
      type: ormClass(owner.parent.name),
      assign: `  orm.${owner.property} = parent as ${ormClass(owner.parent.name)};
    orm.${fkProperty(owner.property)} = (parent as ${ormClass(owner.parent.name)}).${idOf(model, owner.parent.name)};`
    });
  }
  const parentTypes = [...new Set(parentParams.map((p) => p.type))];
  const parentParam = entity === root ? '' : `, parent?: ${parentTypes.length > 0 ? parentTypes.join(' | ') : 'object'}`;
  const parentAssigns = parentParams.length > 0 ? `  if (parent != null) {\n${parentParams.map((p) => `  ${p.assign}`).join('\n')}\n  }\n` : '';
  if (entity !== root && parentParams.length === 0) {
    // Ninguna vuelta que poner: el parámetro existe por uniformidad de la llamada.
  }
  return `function toOrm${entity.name}(entity: ${entity.name}${parentParam}): ${ormClass(entity.name)} {
  const orm = new ${ormClass(entity.name)}();
${lines.join('\n')}
${parentAssigns}  return orm;
}`;
}

