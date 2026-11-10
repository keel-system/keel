// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss` en `authentication.scoping` y en `ownership.<Entidad>`) en
// keel-nest: incremento 2 de PLAN-DSL-227-LECTURA-ACOTADA.md, con el reparto de keel-spring. Lo que decide QUÉ (las
// lecturas, el camino, el predicado, la carga por id o por clave, la clave de caché y la nota) es de
// keel-core/gen/read-scope.js; aquí solo se escribe en TypeScript:
//
//   · `ReadScope` (domain/repository): el valor neutral de D1 como unión discriminada, con lo que admite y su parte de la
//     clave de caché (D6), la misma función que `readScopeCacheKey` de keel-core.
//   · `ReadScopes` (infrastructure/security): lo construye desde el principal en curso, uno por bloque. Solo una exención
//     da `unrestricted`; un claim ausente es el conjunto vacío (D3). Lo llama el controlador y lo estampa en el mensaje.
//   · El predicado en el ADAPTADOR (D4): `readScopeWhere(scope)` en el where de TypeORM, con una subconsulta por salto
//     construida con el QueryBuilder de la otra raíz dentro de un `Raw` (TypeORM pone los nombres y las comillas de cada
//     motor), y `readScopeFilter(scope)` en el filtro del driver, resolviendo los ids de cada salto. Se suma a los criterios
//     del finder, y la misma condición da el total.
//   · `loadScoped(id, scope)` y `loadScopedBy<Clave>(valor, scope)` (D5, T7): cargan, y si la fila existe preguntan al
//     motor si el MISMO predicado la admite. Fuera: null con `not-found`, el error declarado con `forbidden`.

import {
  readMissMessage,
  readScopePath,
  readScopeText,
  scopedLoadOf,
  scopedReadsOf,
  scopedRootsOf
} from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { persistedMembers } from '@keel-system/keel-core/gen/relational';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { DIRS, classPath, tsModule, tsString } from './render.js';

export const READ_SCOPE_TS = 'src/domain/repository/read-scope.ts';
export const READ_SCOPES_TS = 'src/infrastructure/security/read-scopes.ts';
export const READ_SCOPE = 'readScope';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

export const usesReadScope = (model) => scopedReadsOf(model).length > 0;
export const readScopeImport = (type = true) => ({ symbol: 'ReadScope', from: READ_SCOPE_TS, ...(type ? { type: true } : {}) });

/** El método de `ReadScopes` que construye el scope de una lectura: uno por bloque, con los nombres de keel-spring. */
export function readScopesMethod(read) {
  return read.kind === 'scoping' ? 'scoping' : `ownerOf${read.block.split('.').pop()}`;
}

/** Las cargas acotadas de una raíz (T7): `[{ method, by, input, param: { name, tsType } }]`, sin repetir. */
export function scopedLoadsOf(model, entity) {
  const loads = new Map();
  for (const operation of scopedReadsOf(model)) {
    if (operation.readScope.root !== entity.name) continue;
    const load = scopedLoadOf(model, operation);
    if (!load || loads.has(load.method)) continue;
    const field = load.by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    loads.set(load.method, { ...load, param: { name: field.name, tsType: field.tsType } });
  }
  return [...loads.values()];
}

export function isScopedRoot(model, entity) {
  return scopedRootsOf(model).some((root) => root.entity?.name === entity.name);
}

function rootRead(model, entity) {
  return scopedRootsOf(model).find((root) => root.entity?.name === entity.name)?.read ?? null;
}

/** El miss de una carga: el error declarado (forbidden) o null (not-found). */
function missStatement(model, read, imports) {
  if (read.readMiss !== 'forbidden') {
    return `    // readMiss: not-found. Una fila ajena da el mismo 404 que una que no existe: no revela que existe.
    return null;`;
  }
  const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === read.root && candidate.readScope.shape === 'single');
  const error = operationError(model, operation.name, read.error);
  imports.push({ symbol: error.exceptionClass, from: classPath(DIRS.errors, error.exceptionClass) });
  const args = [tsString(readMissMessage(model, read)), ...(error.dynamicStatus ? ['403'] : [])];
  return `    // readMiss: forbidden. Existe y es ajena: el ${read.error} (403) del diseño, después del 404 de una que no existe.
    throw new ${error.exceptionClass}(${args.join(', ')});`;
}

/** Las firmas del puerto. */
export function readScopePortMethods(model, entity, imports) {
  const loads = scopedLoadsOf(model, entity);
  if (loads.length === 0) return [];
  imports.push(readScopeImport());
  const read = rootRead(model, entity);
  const miss = read.readMiss === 'forbidden' ? `lanza ${read.error} (403)` : 'devuelve null, como si no existiera';
  return loads.map(
    (load) => `  /**
   * Carga el agregado por ${load.by === 'id' ? 'su id' : `su ${load.field}`} si el alcance del llamante lo admite (${read.block}.reads:
   * ${readScopeText(read)}). Null si no existe; si existe y es ajeno, ${miss}. El scope lo estampa el borde.
   */
  abstract ${load.method}(${load.param.name}: ${load.param.tsType}, scope: ReadScope): Promise<${entity.name} | null>;`
  );
}

function loadMethods(model, entity, findBy) {
  return scopedLoadsOf(model, entity).map(
    (load) => `  async ${load.method}(${load.param.name}: ${load.param.tsType}, scope: ReadScope): Promise<${entity.name} | null> {
    return this.admittedOrMiss(await this.${findBy(load)}(${load.param.name}), scope);
  }`
  );
}

const findByOf = (load) => (load.by === 'id' ? 'findById' : `findBy${capital(load.field)}`);

// ─── TypeORM ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del adaptador relacional: las cargas, el predicado y su comparador. */
export function readScopeRelationalMethods(model, entity, imports, { ormClass, ormPath }) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  imports.push(readScopeImport(), { symbol: 'FindOperator', from: 'typeorm', type: true }, { symbol: 'Raw', from: 'typeorm' }, { symbol: 'FindOptionsWhere', from: 'typeorm', type: true });
  const methods = loadMethods(model, entity, findByOf);
  if (methods.length > 0) {
    const id = entity.idField;
    methods.push(`  /** El desenlace de una carga acotada (D5): la fila si el predicado la admite; si no, el readMiss del diseño. */
  private async admittedOrMiss(found: ${entity.name} | null, scope: ReadScope): Promise<${entity.name} | null> {
    if (found == null || scope.kind === 'unrestricted') return found;
    const admitted = (await this.manager.count(${ormClass(entity.name)}, { where: { ${id.name}: found.${id.name}, ...this.readScopeWhere(scope) } as FindOptionsWhere<${ormClass(entity.name)}> })) > 0;
    if (admitted) return found;
${missStatement(model, read, imports)}
  }`);
  }
  const path = readScopePath(model, read);
  let body;
  if (path.hops.length === 0) {
    imports.push({ symbol: 'In', from: 'typeorm' }, { symbol: 'Equal', from: 'typeorm' });
    body = `    return { ${read.field}: scopedOperator(scope) };`;
  } else {
    // De dentro afuera: cada salto es una subconsulta que selecciona los ids de la raíz siguiente que cumplen lo de dentro.
    const lines = [];
    let inner = `scopedSql('hop${path.hops.length}.${read.field}', scope)`;
    for (let at = path.hops.length; at >= 1; at -= 1) {
      const hop = path.hops[at - 1];
      imports.push({ symbol: ormClass(hop.to), from: ormPath(hop.to) });
      lines.push(
        `    const hop${at} = this.manager.createQueryBuilder(${ormClass(hop.to)}, 'hop${at}').select('hop${at}.${hop.entity.idField.name}');`,
        at === path.hops.length ? `    const where${at} = ${inner};\n    hop${at}.where(where${at}.sql, where${at}.parameters);` : `    hop${at}.where(${inner}).setParameters(hop${at + 1}.getParameters());`
      );
      inner = at === 1 ? null : `\`hop${at - 1}.${hop.relation}Id IN (\${hop${at}.getQuery()})\``;
    }
    const outer = path.hops[0];
    body = `${lines.join('\n')}
    return { ${outer.relation}Id: Raw((alias) => \`\${alias} IN (\${hop1.getQuery()})\`, hop1.getParameters()) };`;
  }
  methods.push(`  /**
   * El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Va en el where de cada lectura acotada, así
   * que se suma a sus criterios y la misma condición da el total (D4). Solo unrestricted lo ve todo.
   */
  private readScopeWhere(scope: ReadScope): Record<string, FindOperator<any>> {
    if (scope.kind === 'unrestricted') return {};
${body}
  }`);
  return methods;
}

/** Los ayudantes del predicado relacional, a nivel de módulo del adaptador. */
export function readScopeRelationalHelpers(model, entity) {
  if (!isScopedRoot(model, entity)) return '';
  const path = readScopePath(model, rootRead(model, entity));
  if (path.hops.length === 0) {
    return `/** El campo acotado contra el scope. Un dueño nulo o un conjunto vacío no ve nada (D3): nunca todo. */
function scopedOperator(scope: ReadScope): FindOperator<any> {
  if (scope.kind === 'ownedBy' && scope.value != null) return Equal(scope.value);
  if (scope.kind === 'within' && scope.values.size > 0) return In([...scope.values]);
  return Raw(() => '1 = 0');
}

`;
  }
  return `/**
 * El campo acotado contra el scope, como condición del QueryBuilder (con su parámetro). Un dueño nulo o un conjunto vacío
 * no ve nada (D3): nunca todo.
 */
function scopedSql(column: string, scope: ReadScope): { sql: string; parameters: Record<string, unknown> } {
  if (scope.kind === 'ownedBy' && scope.value != null) return { sql: \`\${column} = :readScopeOwner\`, parameters: { readScopeOwner: scope.value } };
  if (scope.kind === 'within' && scope.values.size > 0) return { sql: \`\${column} IN (:...readScopeValues)\`, parameters: { readScopeValues: [...scope.values] } };
  return { sql: '1 = 0', parameters: {} };
}

`;
}

/** La línea que el finder relacional añade a su where. */
export const RELATIONAL_SCOPE_LINE = '    for (const [property, condition] of Object.entries(this.readScopeWhere(scope))) and(property, condition);';

// ─── MongoDB ──────────────────────────────────────────────────────────────────────────────────────────────────

/** La clave del documento de un miembro, leída de la forma neutral (la misma regla que document-repositories.js). */
function keyOf(model, entity, memberName) {
  return documentShape(model, entity).find((entry) => entry.member === memberName)?.name ?? snakeCase(memberName);
}

/** La clave del documento que guarda una relación a otra raíz (`owner_id`). */
function relationKey(model, entity, relation) {
  const member = persistedMembers(model, entity).find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === relation);
  return member?.column ?? `${snakeCase(relation)}_id`;
}

/** Los métodos del adaptador documental: las cargas, el predicado y su comparador. */
export function readScopeDocumentMethods(model, entity, imports, { documentId, idWrite }) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  imports.push(readScopeImport(), { symbol: 'Filter', from: 'mongodb', type: true });
  const methods = loadMethods(model, entity, findByOf);
  if (methods.length > 0) {
    const id = entity.idField;
    methods.push(`  /** El desenlace de una carga acotada (D5): la fila si el predicado la admite; si no, el readMiss del diseño. */
  private async admittedOrMiss(found: ${entity.name} | null, scope: ReadScope): Promise<${entity.name} | null> {
    if (found == null || scope.kind === 'unrestricted') return found;
    const mine: Filter<StoredDocument> = { $and: [{ ${documentId}: ${idWrite(`found.${id.name}`)} }, await this.readScopeFilter(scope)] };
    const admitted = (await this.collection.countDocuments(mine, { session: this.session, limit: 1 })) > 0;
    if (admitted) return found;
${missStatement(model, read, imports)}
  }`);
  }
  const path = readScopePath(model, read);
  const lines = [];
  let inner = `scopedFilter(${tsString(keyOf(model, path.target, read.field))}, scope)`;
  for (let at = path.hops.length; at >= 1; at -= 1) {
    const hop = path.hops[at - 1];
    const from = model.entities.find((candidate) => candidate.name === hop.from);
    // El salto más interior primero: el de fuera filtra por los ids que devuelve el de dentro.
    lines.push(
      `    const ids${at} = (await this.transactions.collection<StoredDocument>(${tsString(hop.entity.collectionName)}).find(${inner}, { projection: { ${documentId}: 1 }, session: this.session }).toArray()).map((document) => document.${documentId});`
    );
    inner = `{ ${tsString(relationKey(model, from, hop.relation))}: { $in: ids${at} } }`;
  }
  methods.push(`  /**
   * El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Cada salto a otra raíz se resuelve a sus ids,
   * que es como se guarda la relación. Va en el filtro de cada lectura acotada, también en el conteo de la página (D4).
   */
  private async readScopeFilter(scope: ReadScope): Promise<Filter<StoredDocument>> {
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}    return ${inner};
  }`);
  return methods;
}

/** El comparador documental, a nivel de módulo del adaptador. */
export function readScopeDocumentHelpers(model, entity) {
  if (!isScopedRoot(model, entity)) return '';
  return `/** El campo acotado contra el scope. Un dueño nulo o un conjunto vacío no ve nada (D3): nunca todo. */
function scopedFilter(key: string, scope: ReadScope): Filter<StoredDocument> {
  if (scope.kind === 'ownedBy' && scope.value != null) return { [key]: scope.value };
  if (scope.kind === 'within' && scope.values.size > 0) return { [key]: { $in: [...scope.values] } };
  return { [key]: { $in: [] } };
}

`;
}

/** La línea que el finder documental añade a sus condiciones: nada con unrestricted. */
export const DOCUMENT_SCOPE_LINE = "    if (scope.kind !== 'unrestricted') conditions.push(await this.readScopeFilter(scope));";

// ─── Los tipos ────────────────────────────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesReadScope(model)) return [];
  return [readScopeFile(), readScopesFile(model)];
}

function readScopeFile() {
  const body = String.raw`/**
 * Qué filas ve quien lee (DSL 2.27, la lectura acotada de security.keel.yaml). Lo construye el borde desde el token
 * (ReadScopes) y lo estampa en el mensaje; el handler lo pasa al puerto y el ADAPTADOR lo aplica en la consulta, en su
 * total y en la carga por id. Desde otra puerta (un evento, el reloj) llega \`ReadScope.unrestricted()\`.
 *
 *   · unrestricted: sin filtro. Solo lo da una exención.
 *   · ownedBy: el dueño es la identidad del llamante. Una identidad nula no ve nada.
 *   · within: el campo acotado está en el conjunto del claim. El conjunto vacío no ve nada.
 */
export type ReadScope =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'ownedBy'; readonly value: string | null }
  | { readonly kind: 'within'; readonly values: ReadonlySet<string> };

const UNRESTRICTED: ReadScope = Object.freeze({ kind: 'unrestricted' });

/** Una coma o una barra dentro de un valor no puede confundirse con la separación entre valores. */
function escape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(',', '\\,');
}

export const ReadScope = {
  unrestricted(): ReadScope {
    return UNRESTRICTED;
  },

  ownedBy(value: string | null): ReadScope {
    return { kind: 'ownedBy', value };
  },

  within(values: Iterable<string>): ReadScope {
    return { kind: 'within', values: new Set(values) };
  },

  /** ¿Ve este scope una fila cuyo valor acotado es \`value\`? */
  admits(scope: ReadScope, value: string | null | undefined): boolean {
    if (scope.kind === 'unrestricted') return true;
    if (value == null) return false;
    return scope.kind === 'within' ? scope.values.has(value) : scope.value === value;
  },

  /**
   * La parte del scope en la clave de una caché (D6): \`all\`, \`by:<valor>\`, \`none\` o \`in:<v1>,<v2>\` ordenado, con la
   * coma y la barra escapadas. Dos scopes distintos nunca comparten entrada; la misma forma que keel-spring.
   */
  cacheKey(scope: ReadScope): string {
    if (scope.kind === 'ownedBy') return scope.value == null ? 'none' : \`by:\${escape(scope.value)}\`;
    if (scope.kind === 'within') return \`in:\${[...scope.values].sort().map(escape).join(',')}\`;
    return 'all';
  }
};`;
  return { path: READ_SCOPE_TS, content: tsModule(READ_SCOPE_TS, [], body.replaceAll('\\`', '`').replaceAll('\\${', '${')) };
}

function readScopesFile(model) {
  const imports = [{ symbol: 'ReadScope', from: READ_SCOPE_TS }];
  const blocks = new Map();
  for (const operation of scopedReadsOf(model)) blocks.set(readScopesMethod(operation.readScope), operation.readScope);
  const members = [];
  let roles = false;
  for (const [method, read] of blocks) {
    if (read.kind === 'scoping') {
      imports.push({ symbol: 'JwtCallerScope', from: 'src/infrastructure/security/jwt-caller-scope.ts' });
      members.push(`  /**
   * ${read.block}: ${readScopeText(read)}. Exento (${[...read.exemptRoles.map((role) => `rol ${role}`), ...read.exemptClients.map((client) => `cliente ${client}`)].join(', ') || 'nadie'}): sin filtro.
   * Si no, el conjunto del claim, y un claim ausente es el conjunto VACÍO, que no ve nada (D3).
   */
  ${method}(): ReadScope {
    const scope = new JwtCallerScope();
    if (scope.isExempt()) return ReadScope.unrestricted();
    return ReadScope.within(scope.scopedValues());
  }`);
    } else {
      imports.push({ symbol: 'CallerIdentity', from: 'src/infrastructure/security/caller-identity.ts' });
      if (read.exemptRoles.length > 0) roles = true;
      members.push(`  /**
   * ${read.block}: ${readScopeText(read)}.${read.exemptRoles.length > 0 ? ` Exentos los roles ${read.exemptRoles.join(', ')}: sin filtro.` : ''}
   * El dueño es la identidad del llamante (callerIdentity), la misma que estampa el controlador; con resolvedBy, el
   * controlador pasa la ya resuelta.
   */
  ${method}(identity: string | null = CallerIdentity.resolve()): ReadScope {${read.exemptRoles.length > 0
    ? `
    if (hasAny(${read.exemptRoles.map((role) => tsString(`ROLE_${role}`)).join(', ')})) return ReadScope.unrestricted();`
    : ''}
    return ReadScope.ownedBy(identity);
  }`);
    }
  }
  if (roles) imports.push({ symbol: 'SecurityContext', from: 'src/infrastructure/security/security-context.ts' });
  const body = `/**
 * El ReadScope de cada lectura acotada (DSL 2.27), construido desde el principal de la petición en curso: lo estampa el
 * controlador en el mensaje y el handler no lo vuelve a mirar. Solo una exención da \`unrestricted\` (D3).
 */
export const ReadScopes = {
${members.join(',\n\n')}
};${roles
    ? `

/** ¿Tiene el llamante alguna de estas authorities (\`ROLE_<rol>\`, como en keel-spring)? */
function hasAny(...authorities: readonly string[]): boolean {
  const principal = SecurityContext.current();
  return principal != null && authorities.some((authority) => principal.authorities.has(authority));
}`
    : ''}`;
  return { path: READ_SCOPES_TS, content: tsModule(READ_SCOPES_TS, imports, body) };
}

/** La llamada que nombra la nota del handler en una lectura de una fila. */
export function readScopeHandlerCall(model, operation, finderCallText) {
  const load = scopedLoadOf(model, operation);
  if (!load) return finderCallText;
  const repository = `this.${operation.readScope.root[0].toLowerCase()}${operation.readScope.root.slice(1)}Repository`;
  return `await ${repository}.${load.method}(query.${load.input}, query.${READ_SCOPE})`;
}
