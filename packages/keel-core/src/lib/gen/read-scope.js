// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss` en `authentication.scoping` y en `ownership.<Entidad>`), neutral: la
// misma decisión en los cuatro generadores. Y `level: optional` (R3c), que comparte plan y versión.
//
// Hasta la 2.26 el DSL decidía quién EJECUTA una operación, no qué FILAS ve cada uno: el alcance de un listado era una
// `rule` en prosa y la propiedad solo dejaba una nota con el 403 en el handler. Su fallo no se ve: es una fuga de datos
// (OWASP API1, BOLA). Con `reads`, el predicado va en el ADAPTADOR generado —el listado, la página con su total y la
// lectura por id—, y el handler solo pasa el `ReadScope` que estampó el borde. Plan y decisiones (D1-D9):
// PLAN-DSL-227-LECTURA-ACOTADA.md.
//
// Aquí vive lo que los cuatro tienen que decidir igual:
//   · qué lecturas se acotan, con qué predicado y por qué camino de relaciones (derivado, no declarado);
//   · qué preguntas abre un diseño que no lo dice (OBL-READ-SCOPE-UNDECIDED) y qué no se puede generar (los CHK-*);
//   · el valor `ReadScope` (D1) y su regla de construcción (D3), como referencia ejecutable;
//   · la nota del handler, los casos RS-* y OA-* con sus sabotajes y el rechazo de los generadores que aún no lo emiten.
//
// La derivación es UNA y tiene una entrada, las capas: el modelo la llama con las mismas (`buildModel`), así que lo que
// `keel validate` acepta es exactamente lo que los generadores emiten.

import { operationTargetEntity, resolveRoute } from './model.js';

/** Los valores de `readMiss`, en el orden del schema. */
export const READ_MISS = ['not-found', 'forbidden'];

/** Los niveles de acceso con los que una lectura se puede acotar (D8): con `public` u `optional` no hay a quién. */
export const SCOPABLE_LEVELS = ['required', 'admin'];

/**
 * El campo del mensaje que estampa el borde (D1): el `ReadScope` construido desde el token. Desde otra puerta (evento,
 * despacho, reloj) llega `unrestricted`. camelCase; cada generador lo proyecta a su convención.
 */
export const READ_SCOPE_FIELD = 'readScope';

/** El tipo neutral y sus tres formas (D1). */
export const READ_SCOPE_TYPE = 'ReadScope';
export const READ_SCOPE_KINDS = ['unrestricted', 'ownedBy', 'within'];

/** El método del puerto que carga por id comparando con el scope (D5). */
export const LOAD_SCOPED = 'loadScoped';

/** El orden en que se decide la lectura por id de una fila (D5, el de la 2.25): no existe → no es tuya → versión. */
export const READ_MISS_ORDER = [404, 403, 412];

// ─── El valor (D1, D3) ────────────────────────────────────────────────────────────────────────────────────────────

/** Sin filtro: un exento, u otra puerta que no es HTTP. */
export const UNRESTRICTED = Object.freeze({ kind: 'unrestricted' });

/** El dueño es la identidad del llamante. */
export function ownedBy(value) {
  return { kind: 'ownedBy', value };
}

/** El campo acotado está en el conjunto del claim. */
export function within(values) {
  return { kind: 'within', values: [...new Set(values)] };
}

/** Los valores de un claim: una lista, un texto separado por espacios o comas, o nada. Nada es el conjunto VACÍO (D3). */
export function claimValues(claim) {
  if (claim == null) return [];
  if (Array.isArray(claim)) return claim.filter((value) => value != null && String(value) !== '').map(String);
  return String(claim)
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * El `ReadScope` de una lectura acotada para un llamante (D1, D3), la referencia ejecutable de lo que construye el borde
 * de los cuatro generadores. `roles` son los del token, `client` el cliente máquina de la credencial (si lo es),
 * `claims` el token entero y `caller` la identidad resuelta (`callerIdentity`).
 *
 * Solo una exención da `unrestricted`. Un claim ausente es un conjunto vacío y no se ve nada: nunca todo.
 */
export function readScopeFor(read, { roles = [], client = null, claims = {}, caller = null } = {}) {
  if (read.exemptRoles.some((role) => roles.includes(role))) return UNRESTRICTED;
  if (client && read.exemptClients.includes(client)) return UNRESTRICTED;
  if (read.kind === 'scoping') return within(claimValues(claims[read.claim]));
  return ownedBy(caller ?? null);
}

/** ¿Ve este scope una fila cuyo valor acotado es `value`? La referencia del predicado (D3, D4). */
export function scopeAdmits(scope, value) {
  if (scope.kind === 'unrestricted') return true;
  if (value == null) return false;
  if (scope.kind === 'within') return scope.values.includes(String(value));
  return scope.value != null && String(scope.value) === String(value);
}

/**
 * Lo que devuelve la lectura por id de una fila (D5): `found`, `not-found` (no existe, o es ajena con `not-found`) o
 * `forbidden` (existe, es ajena y `readMiss: forbidden`). La referencia de `loadScoped`.
 */
export function scopedLoadOutcome({ exists, admitted, readMiss }) {
  if (!exists) return 'not-found';
  if (admitted) return 'found';
  return readMiss === 'forbidden' ? 'forbidden' : 'not-found';
}

// ─── La derivación ────────────────────────────────────────────────────────────────────────────────────────────────

const TO_ONE = new Set(['many-to-one', 'one-to-one']);
const MAX_PATH = 4;

/**
 * Los caminos de relaciones a-uno de `from` a `to`, sin ciclos y de hasta MAX_PATH saltos. Si `from` es `to`, el único
 * camino es el vacío: la fila lleva el campo ella misma.
 */
export function toOnePaths(domain, from, to) {
  if (from === to) return [[]];
  const paths = [];
  const walk = (current, path, seen) => {
    if (path.length >= MAX_PATH) return;
    for (const [name, relation] of Object.entries(domain?.entities?.[current]?.relations ?? {})) {
      if (!TO_ONE.has(relation?.cardinality) || seen.has(relation.entity) || !domain.entities?.[relation.entity]) continue;
      if (relation.entity === to) paths.push([...path, name]);
      else walk(relation.entity, [...path, name], new Set([...seen, relation.entity]));
    }
  };
  walk(from, [], new Set([from]));
  return paths;
}

/** La forma de la salida de una query: `{ entity, shape }` con `single`, `list` o `page`, o null si no es una entidad. */
export function readShapeOf(op) {
  const output = op?.output;
  if (!output || typeof output !== 'object' || !output.entity) return null;
  return { entity: output.entity, shape: output.paginated ? 'page' : output.list ? 'list' : 'single' };
}

function accessLevelOf(security, opName) {
  return (security?.access?.rules?.[opName] ?? security?.access?.default)?.level ?? 'required';
}

function exposedQuery(layers, opName, op) {
  if (op?.kind !== 'query') return false;
  const target = operationTargetEntity(opName, op, layers.domain?.entities ?? {});
  return Boolean(resolveRoute(opName, op, layers.api ?? null, target, []));
}

/** Los bloques que declaran el alcance de una lectura, cada uno con lo que acota y cómo. */
function scopeBlocks(layers) {
  const security = layers?.security;
  const blocks = [];
  const scoping = security?.authentication?.scoping;
  if (scoping) {
    const [entity, field] = String(scoping.over).split('.');
    blocks.push({
      kind: 'scoping',
      where: 'security.authentication.scoping',
      target: entity,
      field,
      claim: scoping.claim,
      error: scoping.error,
      declared: scoping.reads,
      readMiss: scoping.readMiss ?? null,
      exemptRoles: scoping.exemptRoles ?? [],
      exemptClients: scoping.exemptClients ?? [],
      writes: []
    });
  }
  for (const [entity, rule] of Object.entries(security?.ownership ?? {})) {
    const path = String(rule.owner).split('.');
    blocks.push({
      kind: 'ownership',
      where: `security.ownership.${entity}`,
      target: entity,
      relations: path.slice(0, -1),
      field: path[path.length - 1],
      owner: rule.owner,
      error: rule.error,
      declared: rule.reads,
      readMiss: rule.readMiss ?? null,
      exemptRoles: rule.exemptRoles ?? [],
      exemptClients: [],
      writes: rule.operations ?? []
    });
  }
  return blocks;
}

/**
 * El camino de una lectura de `root` hasta el campo acotado: `{ relations, field }`, o null si no hay uno único. Con
 * `ownership` el root es la entidad de la regla y el camino es el de `owner`; con `scoping`, el único camino a-uno de
 * `root` a la entidad de `over`.
 */
function pathOf(layers, block, root) {
  if (block.kind === 'ownership') return root === block.target ? { relations: block.relations, field: block.field } : null;
  const paths = toOnePaths(layers.domain, root, block.target);
  return paths.length === 1 ? { relations: paths[0], field: block.field } : null;
}

/**
 * El plan de un diseño: `{ reads, problems, undecided }`.
 *
 *   · `reads`: las lecturas acotadas que se pueden generar, `{ operation, kind, block, root, shape, relations, field,
 *     claim, error, readMiss, exemptRoles, exemptClients }`. `relations` es el camino a-uno desde la raíz de la salida.
 *   · `problems`: por qué una lectura listada no se puede generar, `{ operation, where, kind, detail }`, con `kind` en
 *     `operation` (no es una query expuesta o no devuelve la entidad), `level` (D8), `path` (scoping sin camino único) y
 *     `miss-error` (la lectura por id no declara el error que su `readMiss` promete).
 *   · `undecided`: las lecturas que alcanzan una entidad acotada en un bloque SIN `reads`, `{ operation, where, scope }`.
 */
export function readScopesOfLayers(layers) {
  const operations = layers?.['use-cases']?.operations ?? {};
  const reads = [];
  const problems = [];
  const undecided = [];
  for (const block of scopeBlocks(layers)) {
    if (block.declared === undefined) {
      for (const [opName, op] of Object.entries(operations)) {
        if (!exposedQuery(layers, opName, op) || block.writes.includes(opName)) continue;
        if (!SCOPABLE_LEVELS.includes(accessLevelOf(layers.security, opName))) continue;
        const shape = readShapeOf(op);
        if (!shape) continue;
        const reaches = block.kind === 'ownership' ? shape.entity === block.target : toOnePaths(layers.domain, shape.entity, block.target).length > 0;
        if (reaches) undecided.push({ operation: opName, where: block.where, entity: shape.entity, scope: `${block.where}.reads.${opName}` });
      }
      continue;
    }
    for (const opName of block.declared) {
      const op = operations[opName];
      const shape = readShapeOf(op);
      const problem = (kind, detail = null) => problems.push({ operation: opName, where: block.where, kind, detail });
      if (!op || !exposedQuery(layers, opName, op) || !shape || (block.kind === 'ownership' && shape.entity !== block.target)) {
        problem('operation', shape?.entity ?? null);
        continue;
      }
      const level = accessLevelOf(layers.security, opName);
      if (!SCOPABLE_LEVELS.includes(level)) {
        problem('level', level);
        continue;
      }
      const path = pathOf(layers, block, shape.entity);
      if (!path) {
        problem('path', toOnePaths(layers.domain, shape.entity, block.target).length);
        continue;
      }
      if (shape.shape === 'single') {
        const errors = op.errors ?? [];
        const missing =
          block.readMiss === 'forbidden'
            ? !errors.some((e) => e.code === block.error && e.http === 403)
            : !errors.some((e) => e.http === 404);
        if (missing) {
          problem('miss-error', block.readMiss);
          continue;
        }
      }
      reads.push({
        operation: opName,
        kind: block.kind,
        block: block.where,
        root: shape.entity,
        shape: shape.shape,
        relations: path.relations,
        field: path.field,
        claim: block.claim ?? null,
        error: block.error,
        readMiss: block.readMiss,
        notFound: shape.shape === 'single' ? ((op.errors ?? []).find((e) => e.http === 404)?.code ?? null) : null,
        exemptRoles: block.exemptRoles,
        exemptClients: block.exemptClients
      });
    }
  }
  return { reads, problems, undecided };
}

/** La lectura acotada de una operación, o null. Lo que el modelo pone en `operation.readScope`. */
export function readScopeOfOperation(plan, opName) {
  return plan.reads.find((read) => read.operation === opName) ?? null;
}

/** Las operaciones con `level: optional` (R3c), incluida la regla por defecto si lo es: `{ operation }` o `{ default }`. */
export function optionalAuthRules(layers) {
  const access = layers?.security?.access;
  const rules = Object.entries(access?.rules ?? {})
    .filter(([, rule]) => rule?.level === 'optional')
    .map(([operation]) => ({ operation }));
  return access?.default?.level === 'optional' ? [{ default: true }, ...rules] : rules;
}

// ─── El handler ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Cómo se lee el predicado en prosa: `Asset.owner → Owner.code ∈ claim vaults`, `OrderMain.buyerEmail = el llamante`. */
export function readScopeText(read) {
  const path = [read.root, ...read.relations, read.field].join('.');
  return read.kind === 'scoping' ? `${path} ∈ claim ${read.claim}` : `${path} = identidad del llamante`;
}

/**
 * La nota del handler, la misma en los cuatro generadores, o null. `read` es cómo se lee el scope del mensaje en el
 * lenguaje (`query.readScope()`), y `call` la llamada al puerto (`assets.findPage(…, scope)`, `orders.loadScoped(id, scope)`).
 */
export function readScopeNote(read, { scope, call }) {
  if (!read) return null;
  const exempt = [...read.exemptRoles.map((role) => `el rol ${role}`), ...read.exemptClients.map((client) => `el cliente ${client}`)];
  const base =
    `Lectura acotada (${read.block}.reads): las filas las filtra el adaptador con ${scope}, que el borde construyó desde el ` +
    `token (${readScopeText(read)}${exempt.length ? `; sin filtro para ${exempt.join(', ')}` : ''}). Pasa ${scope} a ${call} y ` +
    'no filtres a mano: un filtro en el handler no llega al total de la página ni a la caché.';
  if (read.shape !== 'single') return base;
  const miss =
    read.readMiss === 'forbidden'
      ? `una fila ajena da ${read.error} (403), y una que no existe su 404 antes`
      : `una fila ajena da el mismo 404 que una que no existe${read.notFound ? ` (${read.notFound})` : ''}, para no revelar que existe`;
  return `${base} Carga con ${LOAD_SCOPED}: ${miss}.`;
}

// ─── La frontera de los generadores ───────────────────────────────────────────────────────────────────────────────

/**
 * El rechazo de un generador que todavía no genera la lectura acotada, con el mismo mensaje en los cuatro: llega por
 * incrementos (PLAN-DSL-227-LECTURA-ACOTADA.md) y, hasta el suyo, se rechaza entera, nunca a medias. Vacío si ningún
 * bloque declara `reads` con lecturas (una lista vacía no pide nada que generar).
 */
export function readScopePendingErrors(layers, generator, increment) {
  return scopeBlocks(layers)
    .filter((block) => (block.declared ?? []).length > 0)
    .map(
      (block) =>
        `${block.where}.reads (lectura acotada, DSL 2.27): ${generator} todavía no la genera — llega en el incremento ` +
        `${increment} de PLAN-DSL-227-LECTURA-ACOTADA.md, y una lectura acotada a medias (el listado filtrado y su total no, ` +
        'o la caché compartida entre llamantes) filtraría las filas que promete esconder. Quita reads para generar este diseño.'
    );
}

/** Lo mismo para `level: optional` (R3c, incremento 5 en los cuatro). */
export function optionalAuthPendingErrors(layers, generator, increment) {
  return optionalAuthRules(layers).map(
    (rule) =>
      `security: access.${rule.default ? 'default' : `rules.${rule.operation}`} (level: optional, DSL 2.27): ${generator} todavía ` +
      `no lo genera — llega en el incremento ${increment} de PLAN-DSL-227-LECTURA-ACOTADA.md, y a medias trataría un token ` +
      'inválido como anónimo. Decláralo public o required para generar este diseño.'
  );
}

// ─── La medición ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Los casos de la lectura acotada que los cuatro generadores ejecutan con el mismo id, y en qué red. */
export const READ_SCOPE_CASES = [
  { id: 'RS-1', level: 'adapter', asserts: 'el listado devuelve solo las filas del scope' },
  { id: 'RS-2', level: 'adapter', asserts: 'el total y las páginas cuentan solo las filas del scope' },
  { id: 'RS-3', level: 'adapter', asserts: 'unrestricted lo ve todo' },
  { id: 'RS-4', level: 'adapter', asserts: 'loadScoped de una fila ajena con not-found: no encontrado' },
  { id: 'RS-5', level: 'adapter', asserts: 'loadScoped de una fila ajena con forbidden: el error declarado, después del 404 de una inexistente' },
  { id: 'RS-6', level: 'adapter', asserts: 'within con varios valores ve las de todos, y con el conjunto vacío no devuelve nada' },
  { id: 'RS-7', level: 'adapter', asserts: 'el predicado se suma a los criterios y al where de un finder' },
  { id: 'RS-8', level: 'adapter', asserts: 'el dueño a través de un camino de relaciones (join o subdocumento)' },
  { id: 'RS-9', level: 'cache', asserts: 'dos llamantes con scopes distintos no comparten la entrada de caché' },
  { id: 'RS-10', level: 'edge', asserts: 'rol o cliente exento da unrestricted; el claim ausente da el conjunto vacío' },
  { id: 'RS-11', level: 'api', asserts: 'readMiss sale con su status, su code y su message del cable' }
];

/** Los casos de `level: optional` (R3c). */
export const OPTIONAL_AUTH_CASES = [
  { id: 'OA-1', level: 'edge', asserts: 'sin token: 200 con la identidad nula' },
  { id: 'OA-2', level: 'edge', asserts: 'con un token válido: la identidad presente' },
  { id: 'OA-3', level: 'edge', asserts: 'con un token inválido o caducado: 401 con la forma del cable' },
  { id: 'OA-4', level: 'contract', asserts: 'el OpenAPI declara security: [{}, {bearer: []}]' }
];

/** Los sabotajes, con el mismo id en los cuatro: verde significa que cada uno cae en exactamente sus casos. */
export const READ_SCOPE_SABOTAGES = [
  { id: 'rs-no-filter', breaks: 'el listado ignora el scope', falls: ['RS-1'] },
  { id: 'rs-count-unscoped', breaks: 'el conteo ignora el scope', falls: ['RS-2'] },
  { id: 'rs-get-leak', breaks: 'loadScoped no compara', falls: ['RS-4', 'RS-5'] },
  { id: 'rs-empty-is-all', breaks: 'el claim ausente se trata como unrestricted', falls: ['RS-6', 'RS-10'] },
  { id: 'rs-finder-replace', breaks: 'el predicado sustituye a los criterios en vez de sumarse', falls: ['RS-7'] },
  { id: 'rs-path', breaks: 'compara un campo equivocado del camino', falls: ['RS-8'] },
  { id: 'rs-cache-key', breaks: 'la clave de caché no lleva el scope', falls: ['RS-9'] }
];

export const OPTIONAL_AUTH_SABOTAGES = [
  { id: 'oa-degrade', breaks: 'un token inválido se trata como anónimo', falls: ['OA-3'] },
  { id: 'oa-ignore-token', breaks: 'con optional nunca hay identidad', falls: ['OA-2'] }
];
