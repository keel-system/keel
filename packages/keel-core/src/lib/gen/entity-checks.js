// Las invariantes de la entidad que se hacen cumplir (DSL 2.31, `entities.<E>.checks`) y los derivados estructurados
// (`computed: { sum, count }`), como decisiones neutrales.
//
// Un check es una invariante que la ENTIDAD comprueba al final de cada mutación, antes de guardar (D2 de
// PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): no la escribe el agente donde un escenario la pide, sino build donde el
// diseño la declara. Una rota es INVARIANT_VIOLATED (422) o el `error` del check. Aquí vive lo que la validación y los
// cuatro generadores tienen que leer igual: el inventario, cómo se resuelve la ruta de un check sobre la entidad, el plan
// de la guarda y su referencia ejecutable.

import { FRAMEWORK_ERRORS } from '../framework-errors.js';
import { operationTargetEntity } from './model.js';
import { resolveType } from './types.js';
import { validationRules, elementValidationRules } from './constraints.js';
import { computedFieldsOf, evaluateComputed, compareDecimals, computedNoteOf } from './computed.js';

/** El `code` canónico de una invariante rota (U1): el de un check sin `error`, y el de una cota rota por el servidor. */
export const INVARIANT_VIOLATED = FRAMEWORK_ERRORS.invariantViolated.code;

/** Las cinco formas de un check, por la clave que lo define. */
export function checkKind(check) {
  if (check?.requires !== undefined) return 'requires';
  if (check?.forbids !== undefined) return 'forbids';
  if (check?.exactlyOne !== undefined) return 'exactlyOne';
  return 'compare';
}

/** Las rutas que un check nombra sobre su entidad (sin la de su condición). */
export function checkPaths(check) {
  switch (checkKind(check)) {
    case 'requires': return [check.requires];
    case 'forbids': return [check.forbids];
    case 'exactlyOne': return [...check.exactlyOne];
    default: return [check.field, ...(check.than !== undefined ? [check.than] : [])];
  }
}

/** La condición de un check: `{ field, values, negated }` (`unless` la niega), o null si aplica siempre. */
export function checkCondition(check) {
  const condition = check?.when ?? check?.unless;
  if (!condition) return null;
  return { field: condition.field, values: condition.in ?? [condition.equals], negated: check.unless !== undefined };
}

/** El `code` con que se responde un check roto. */
export const checkErrorCode = (check) => check?.error ?? INVARIANT_VIOLATED;

/** Los checks declarados en las capas: `{ entityName, entity, index, check, kind }`, en el orden del diseño. */
export function declaredChecks(layers) {
  return Object.entries(layers.domain?.entities ?? {}).flatMap(([entityName, entity]) =>
    (entity?.checks ?? []).map((check, index) => ({ entityName, entity, index, check, kind: checkKind(check) }))
  );
}

/** ¿Es `computed` la forma estructurada (2.31) y no la prosa? */
export const isStructuredComputed = (computed) => computed !== null && typeof computed === 'object';

/** Los derivados estructurados: `{ entityName, entity, fieldName, field, spec }`. */
export function declaredComputed(layers) {
  return Object.entries(layers.domain?.entities ?? {}).flatMap(([entityName, entity]) =>
    Object.entries(entity?.fields ?? {})
      .filter(([, field]) => isStructuredComputed(field?.computed))
      .map(([fieldName, field]) => ({ entityName, entity, fieldName, field, spec: field.computed }))
  );
}

// ─── Lo que nombra una ruta ──────────────────────────────────────────────────

const NUMERIC = new Set(['int', 'long', 'decimal']);
const INSTANT = new Set(['timestamp', 'date']);
const TEXT = new Set(['string', 'text', 'uuid']);

/**
 * El tipo de un campo, resuelto contra los value types: `{ category, base, enumName, values, list }`. `category` es
 * `numeric`, `instant`, `text`, `boolean`, `enum`, `json`, `file` u `object` (un value object compuesto).
 */
export function resolveFieldType(field, domainTypes = {}) {
  const list = field?.list === true;
  if (field?.type === 'enum') return { category: 'enum', base: 'enum', enumName: null, values: field.values ?? [], list };
  const named = domainTypes?.[field?.type];
  if (named?.values) return { category: 'enum', base: 'enum', enumName: field.type, values: named.values, list };
  if (named?.fields) return { category: 'object', base: field.type, enumName: null, values: null, list, fields: named.fields };
  const base = named?.base ?? field?.type;
  const category = NUMERIC.has(base) ? 'numeric'
    : INSTANT.has(base) ? 'instant'
      : TEXT.has(base) ? 'text'
        : base === 'boolean' ? 'boolean'
          : base === 'json' ? 'json'
            : base === 'file' ? 'file'
              : 'unknown';
  return { category, base, enumName: null, values: null, list };
}

/**
 * Lo que una ruta de check nombra sobre `entityName`: un campo (`{ kind: 'field', type }`), un subcampo de uno de sus
 * value objects (`price.amount`, `{ kind: 'field', type }`), una relación (`{ kind: 'relation', relation, inAggregate }`)
 * o nada (`null`). `inAggregate` es falso en una colección hacia otro agregado: esa no existe en la entidad.
 */
export function resolveCheckPath(layers, entityName, path) {
  const domain = layers.domain ?? {};
  const entity = domain.entities?.[entityName];
  if (!entity || typeof path !== 'string') return null;
  const [head, sub] = path.split('.');
  const field = entity.fields?.[head];
  if (field) {
    const type = resolveFieldType(field, domain.types);
    if (sub === undefined) return { kind: 'field', field, type };
    const subField = type.category === 'object' && !type.list ? type.fields?.[sub] : undefined;
    return subField ? { kind: 'field', field: subField, type: resolveFieldType(subField, domain.types) } : null;
  }
  const relation = entity.relations?.[head];
  if (!relation || sub !== undefined) return null;
  const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
  return { kind: 'relation', relation, toMany, inAggregate: !toMany || sameAggregate(domain, entityName, relation.entity) };
}

/** ¿Es `child` una entidad interna del mismo agregado que `entityName`? */
export function sameAggregate(domain, entityName, child) {
  return Object.values(domain.aggregates ?? {}).some((aggregate) => {
    const members = new Set([aggregate.root, ...(aggregate.entities ?? [])]);
    return members.has(entityName) && (aggregate.entities ?? []).includes(child);
  });
}

/** La raíz del agregado de una entidad (ella misma si es raíz o si no hay agregados). */
export function aggregateRootOf(domain, entityName) {
  const owner = Object.values(domain.aggregates ?? {}).find((aggregate) => (aggregate.entities ?? []).includes(entityName));
  return owner?.root ?? entityName;
}

/**
 * Las operaciones que escriben una entidad: los command cuyo objetivo es ella o la raíz de su agregado, y los que
 * declaran una transición suya. Son las que tienen que declarar el `error` de un check (CHK-DOMAIN-CHECK-ERROR-UNDECLARED).
 */
export function operationsWriting(layers, entityName) {
  const domainEntities = layers.domain?.entities ?? {};
  const root = aggregateRootOf(layers.domain ?? {}, entityName);
  return Object.entries(layers['use-cases']?.operations ?? {})
    .filter(([opName, op]) => {
      if ((op?.kind ?? 'command') !== 'command') return false;
      const target = operationTargetEntity(opName, op, domainEntities);
      return target === entityName || target === root || (op.transitions ?? []).some((transition) => transition?.entity === entityName);
    })
    .map(([opName, op]) => ({ opName, op }));
}

// ─── El plan de la guarda: qué comprueba la entidad al guardar ───────────────
//
// D2 dice «al final de cada mutación», y M8 midió que los mutadores son del agente: el único punto de build por el que
// pasa toda escritura es el `save` del adaptador. Así que build emite en la entidad `ensureInvariants()` —los derivados,
// las cotas y los checks del agregado entero (D3)— y el `save` generado la llama antes de escribir nada (D21). La guarda
// y su llamada son de build, y ningún gate tiene que vigilar que el agente las escriba (la fila de D9 sobra).

const BOUND_RULES = new Set(['size', 'pattern', 'min', 'max']);

/**
 * Las cotas de una entidad que se hacen cumplir en ella (U1, U6: una cota de la entidad es siempre verdad), como reglas de
 * `validationRules` sin la presencia: `[{ field, element, rules }]`. `element: true` son las de cada elemento de una
 * lista. Fuera el id, lo generado y los value objects compuestos (su constructor ya guarda sus propias cotas). La escala
 * de un decimal no es una cota: normaliza, no rechaza.
 */
export function boundGuards(domain, entityName) {
  const entity = domain?.entities?.[entityName];
  const guards = [];
  for (const [fieldName, field] of Object.entries(entity?.fields ?? {})) {
    if (!field || field.id || field.generated || field.type === 'enum') continue;
    const resolved = resolveType(field.type, domain.types ?? {});
    if (resolved.kind === 'composite' || resolved.kind === 'enum') continue;
    const rules = validationRules({ ...field, required: false }, resolved).filter((rule) => BOUND_RULES.has(rule.rule));
    if (rules.length > 0) guards.push(Object.freeze({ field: fieldName, element: false, rules }));
    const element = elementValidationRules(field, resolved).filter((rule) => BOUND_RULES.has(rule.rule));
    if (element.length > 0) guards.push(Object.freeze({ field: fieldName, element: true, rules: element }));
  }
  return guards;
}

/**
 * Los checks de una entidad, resueltos para quien los emite: cada uno con su forma, sus rutas (`{ path, head, sub,
 * target: 'field'|'relation', category }`), su condición, su comparación y su `code`. Los nombres son los del diseño; cada
 * generador los proyecta a sus accesores.
 */
export function resolvedChecks(layers, entityName) {
  const entity = layers.domain?.entities?.[entityName];
  return (entity?.checks ?? []).map((check, index) => {
    const kind = checkKind(check);
    const paths = checkPaths(check).map((path) => {
      const target = resolveCheckPath(layers, entityName, path);
      const [head, sub = null] = path.split('.');
      return Object.freeze({
        path,
        head,
        sub,
        target: target?.kind ?? null,
        category: target?.kind === 'field' ? target.type.category : 'relation'
      });
    });
    return Object.freeze({
      index,
      kind,
      paths,
      condition: checkCondition(check),
      op: kind === 'compare' ? check.op : null,
      than: check.than ?? null,
      value: check.value ?? null,
      hasValue: check.value !== undefined,
      error: checkErrorCode(check),
      customError: check.error !== undefined
    });
  });
}

/**
 * El plan de la guarda de un agregado desde `entityName`: `{ entity, computed, bounds, checks, children }`, con
 * `children` = las relaciones internas del agregado (`{ relation, toMany, plan }`). Es lo que `ensureInvariants()` hace,
 * como datos.
 */
export function invariantPlan(layers, entityName, seen = new Set()) {
  const domain = layers.domain ?? {};
  const entity = domain.entities?.[entityName];
  seen.add(entityName);
  const children = Object.entries(entity?.relations ?? {})
    .filter(([, relation]) => sameAggregate(domain, entityName, relation.entity) && !seen.has(relation.entity))
    .map(([relation, def]) => ({
      relation,
      toMany: def.cardinality === 'one-to-many' || def.cardinality === 'many-to-many',
      plan: invariantPlan(layers, def.entity, seen)
    }));
  return Object.freeze({
    entity: entityName,
    computed: computedFieldsOf(domain, entityName),
    bounds: boundGuards(domain, entityName),
    checks: resolvedChecks(layers, entityName),
    children
  });
}

/** ¿Hay algo que guardar en el agregado del plan? Decide si build emite `ensureInvariants()`. */
export function guardsAggregate(plan) {
  return plan.computed.length + plan.bounds.length + plan.checks.length > 0 || plan.children.some((child) => guardsAggregate(child.plan));
}

// ─── La referencia ejecutable ────────────────────────────────────────────────

/**
 * ¿Está ausente un valor? (D6, D20): nulo, la cadena vacía y la lista vacía; un `json` solo si es nulo. Es la misma
 * definición de vacío que `required` en el borde.
 */
export function isAbsentValue(value, category, { sabotage = null } = {}) {
  if (value === null || value === undefined) return true;
  if (category === 'json' || sabotage === 'ic-absent-null-only') return false;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const valueAt = (state, { head, sub }) => (sub === null ? state?.[head] : state?.[head]?.[sub]);

function compareValues(left, right, category) {
  if (category === 'numeric') return compareDecimals(String(left), String(right));
  if (category === 'instant') {
    const x = Date.parse(left);
    const y = Date.parse(right);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return left === right ? 0 : 1;
}

/**
 * ¿Se cumple una comparación? Con un operando ausente se cumple (D19, y D22 para `eq`/`ne`: la semántica de un CHECK de
 * SQL con NULL).
 */
function compareHolds(check, state, sabotage) {
  const [field, than] = check.paths;
  const left = valueAt(state, field);
  const right = than ? valueAt(state, than) : check.value;
  if (left === null || left === undefined || right === null || right === undefined) return sabotage !== 'ic-null-fails';
  const order = compareValues(left, right, field.category);
  const op = sabotage === 'ic-boundary' ? ({ lte: 'lt', gte: 'gt' }[check.op] ?? check.op) : check.op;
  switch (op) {
    case 'eq': return order === 0;
    case 'ne': return order !== 0;
    case 'lt': return order < 0;
    case 'lte': return order <= 0;
    case 'gt': return order > 0;
    default: return order >= 0;
  }
}

function checkApplies(check, state) {
  if (!check.condition) return true;
  const inside = check.condition.values.includes(state?.[check.condition.field]);
  return check.condition.negated ? !inside : inside;
}

function checkHolds(check, state, sabotage) {
  if (!checkApplies(check, state)) return true;
  const absent = (path) => isAbsentValue(valueAt(state, path), path.category, { sabotage });
  switch (check.kind) {
    case 'requires': return !absent(check.paths[0]);
    case 'forbids': return absent(check.paths[0]);
    case 'exactlyOne': return check.paths.filter((path) => !absent(path)).length === 1;
    default: return compareHolds(check, state, sabotage);
  }
}

/** ¿Cumple `value` las reglas de cota? Un valor ausente no se acota: su presencia es de `required`. */
function boundHolds(rules, value) {
  if (value === null || value === undefined) return true;
  return rules.every((rule) => {
    switch (rule.rule) {
      case 'size': {
        // La longitud de un texto en puntos de código, no en unidades de UTF-16 ni en bytes.
        const length = Array.isArray(value) ? value.length : [...String(value)].length;
        return (rule.min === null || length >= rule.min) && (rule.max === null || length <= rule.max);
      }
      case 'pattern': return new RegExp(`^(?:${rule.regexp})$`, 'u').test(String(value));
      case 'min': return compareDecimals(String(value), String(rule.value)) >= 0;
      default: return compareDecimals(String(value), String(rule.value)) <= 0;
    }
  });
}

/**
 * La guarda de un agregado sobre `state` (con los nombres del diseño; una relación interna es su objeto o su lista de
 * objetos): `{ violation, state }`. `state` vuelve con los derivados recalculados, y `violation` es la primera
 * invariante rota —`{ code, entity, source }`— o null. El orden es contrato (decide el `code` cuando se rompen dos): las
 * hijas antes que su padre, y en cada entidad los derivados, las cotas en el orden de sus campos y los checks en el del
 * diseño. `sabotage` deja falsar la referencia (INVARIANT_SABOTAGES con `reference: true`).
 */
export function evaluateInvariants(plan, state, { sabotage = null } = {}) {
  const next = { ...state };
  if (sabotage !== 'ic-children') {
    for (const child of plan.children) {
      const value = next[child.relation];
      if (value === null || value === undefined) continue;
      const members = child.toMany ? value : [value];
      const evaluated = [];
      for (const member of members) {
        const result = evaluateInvariants(child.plan, member, { sabotage });
        if (result.violation) return { violation: result.violation, state: next };
        evaluated.push(result.state);
      }
      next[child.relation] = child.toMany ? evaluated : evaluated[0];
    }
  }
  for (const { fieldName, spec } of plan.computed) {
    const result = evaluateComputed(spec, next[spec.relation] ?? [], { sabotage });
    if (result.error) return { violation: { code: result.error, entity: plan.entity, source: `computed:${fieldName}` }, state: next };
    next[fieldName] = result.value;
  }
  if (sabotage !== 'ic-no-bounds') {
    for (const guard of plan.bounds) {
      const value = next[guard.field];
      const holds = guard.element ? (value ?? []).every((element) => boundHolds(guard.rules, element)) : boundHolds(guard.rules, value);
      if (!holds) return { violation: { code: INVARIANT_VIOLATED, entity: plan.entity, source: `bound:${guard.field}` }, state: next };
    }
  }
  for (const check of plan.checks) {
    if (checkHolds(check, next, sabotage)) continue;
    const code = sabotage === 'ic-default-code' ? INVARIANT_VIOLATED : check.error;
    return { violation: { code, entity: plan.entity, source: `check:${check.index}` }, state: next };
  }
  return { violation: null, state: next };
}

// ─── Lo que cuenta el contrato ───────────────────────────────────────────────

/**
 * Las raíces guardadas que escribe una operación del modelo: la de su entidad objetivo y las de las entidades cuyas
 * transiciones declara. Vacío en una query o si ninguna lleva guarda. Es la pregunta del contrato (el 422 de la
 * operación) y la de la nota de su handler.
 */
export function guardedRootsWrittenBy(model, operation) {
  if ((operation.kind ?? 'command') !== 'command') return [];
  const byName = new Map((model.entities ?? []).map((entity) => [entity.name, entity]));
  const touched = [operation.targetEntity, ...(operation.transitions ?? []).map((transition) => transition?.entity)].filter(Boolean);
  const roots = new Set(touched.map((name) => byName.get(name)?.aggregateRoot).filter(Boolean));
  return [...roots].map((name) => byName.get(name)).filter((root) => root?.guardsInvariants);
}

/** La frase del contrato para el 422 de la guarda. */
export const INVARIANT_CONTRACT_CLAUSE =
  'una invariante de la entidad (un check o la cota de un campo) se rompería con un valor que calculó el servidor; no se escribe nada.';

const OP_SYMBOLS = Object.freeze({ eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' });

/**
 * El `message` de una invariante rota, el mismo en los cuatro: `source` es `{ kind: 'check', check }` (un check de
 * `resolvedChecks`), `{ kind: 'bound', field }` o `{ kind: 'computed', field }`. Nombra la regla del diseño, nunca el
 * valor: el valor lo calculó el servidor y puede ser de otro campo `sensitive`.
 */
export function invariantMessage(entityName, source) {
  if (source.kind === 'bound') return `${entityName}: ${source.field} queda fuera de sus cotas.`;
  if (source.kind === 'computed') return `${entityName}: ${source.field} no cabe en su tipo.`;
  const { check } = source;
  const condition = check.condition
    ? ` ${check.condition.negated ? 'salvo cuando' : 'cuando'} ${check.condition.field} es ${check.condition.values.join(' o ')}`
    : '';
  const [first] = check.paths;
  switch (check.kind) {
    case 'requires': return `${entityName}: ${first.path} es obligatorio${condition}.`;
    case 'forbids': return `${entityName}: ${first.path} tiene que estar vacío${condition}.`;
    case 'exactlyOne': return `${entityName}: exactamente uno de ${check.paths.map((path) => path.path).join(', ')}${condition}.`;
    default: return `${entityName}: ${first.path} ${OP_SYMBOLS[check.op]} ${check.than ?? check.value}${condition}.`;
  }
}

// ─── Lo que lee el agente ────────────────────────────────────────────────────

/**
 * La nota del handler de una operación que escribe una entidad guardada, o null. La misma en los cuatro: el agente no
 * duplica la guarda, y lo que le queda es decidir el estado, no comprobarlo.
 */
export function invariantsHandlerNote(layers, entityName) {
  return invariantsNoteOfPlan(invariantPlan(layers, aggregateRootOf(layers.domain ?? {}, entityName)));
}

/** La misma nota desde el plan ya resuelto (el del modelo: `entity.invariantPlan` de la raíz). */
export function invariantsNoteOfPlan(plan) {
  if (!plan || !guardsAggregate(plan)) return null;
  const custom = [...new Set(collectPlans(plan).flatMap((node) => node.checks.filter((check) => check.customError).map((check) => check.error)))];
  return (
    `El agregado de ${plan.entity} se guarda con ensureInvariants(): el save generado comprueba las cotas de sus campos y ` +
    'sus checks antes de escribir nada, y recalcula sus derivados. No repitas esas comprobaciones en el handler ni las ' +
    `rodees: una invariante rota por un valor que calculó el servidor es ${INVARIANT_VIOLATED} (422)` +
    `${custom.length > 0 ? `, o el error que el check declara (${custom.join(', ')})` : ''}, y la transacción no deja nada escrito.`
  );
}

/**
 * Las notas de la guarda para el handler de una operación del modelo: la de cada raíz guardada que escribe y la de sus
 * derivados. Las mismas en los cuatro generadores.
 */
export function invariantHandlerNotes(model, operation) {
  return guardedRootsWrittenBy(model, operation).flatMap((root) => {
    const derived = (root.fields ?? []).filter((field) => field.computedSpec).map((field) => ({ fieldName: field.name, spec: field.computedSpec }));
    return [invariantsNoteOfPlan(root.invariantPlan), computedNoteOf(root.name, derived)].filter(Boolean);
  });
}

export function collectPlans(plan) {
  return [plan, ...plan.children.flatMap((child) => collectPlans(child.plan))];
}

// ─── Lo que se mide ──────────────────────────────────────────────────────────

/**
 * Lo que una muestra de las redes en vivo deja vacío para que el save la acepte: esas muestras rellenan cada campo y cada
 * relación, y desde la guarda (DSL 2.31) un `exactlyOne` o un `forbids` las rechazaría. Devuelve las cabezas (el campo o la
 * relación del diseño) que van a nulo: de un `exactlyOne`, todas menos la primera; de un `forbids`, su campo, salvo que un
 * `requires` lo pida (entonces la muestra cumple el `requires` y el estado de la muestra decide). Un `requires` y una
 * comparación ya los cumple una muestra completa con valores iguales. Con `keep`, las cabezas que la sonda fija a mano (la
 * FK de un finder inverso): de su `exactlyOne` se queda esa. La misma regla en los cuatro generadores.
 */
export function sampleBlanks(checks = [], { keep = [] } = {}) {
  const required = new Set(checks.filter((check) => check.kind === 'requires').map((check) => check.paths[0].head));
  const blanks = new Set();
  for (const check of checks) {
    if (check.kind === 'exactlyOne') {
      // La que la sonda fija (`keep`: la FK de un finder inverso) se queda, y las demás del grupo van a nulo.
      const kept = check.paths.find((path) => keep.includes(path.head)) ?? check.paths[0];
      check.paths.filter((path) => path !== kept).forEach((path) => blanks.add(path.head));
    }
    if (check.kind === 'forbids' && !required.has(check.paths[0].head)) blanks.add(check.paths[0].head);
  }
  return blanks;
}


/** Los casos de la guarda. Los vectores concretos, sobre el sujeto de entity-check-designs.js, los comparten las redes. */
export const INVARIANT_CASES = Object.freeze([
  { id: 'IC-1', what: 'requires + when: en el estado nombrado, el campo ausente es INVARIANT_VIOLATED; fuera de él, no' },
  { id: 'IC-2', what: 'forbids + unless: el campo presente fuera de los estados nombrados es INVARIANT_VIOLATED' },
  { id: 'IC-3', what: 'campo contra campo: lte se cumple en la igualdad y se rompe por encima' },
  { id: 'IC-4', what: 'campo contra literal con when: se rompe en el estado y no fuera de él' },
  { id: 'IC-5', what: 'una comparación con un operando ausente se cumple (D19)' },
  { id: 'IC-6', what: 'exactlyOne: ninguno y dos se rompen; uno se cumple' },
  { id: 'IC-7', what: 'ausente es nulo, la cadena vacía y la lista vacía; un json {} está presente (D6, D20)' },
  { id: 'IC-8', what: 'una cota de la entidad rota por un valor del servidor es INVARIANT_VIOLATED (422)' },
  { id: 'IC-9', what: 'el check de una hija se comprueba al guardar el agregado (D3)' },
  { id: 'IC-10', what: 'un save rechazado no escribe nada: la fila sigue como estaba' },
  { id: 'IC-11', what: 'un check con error responde con su code, y su http es el que declara la operación' }
]);

/** Los sabotajes de la guarda. `reference: true` los sabe aplicar evaluateInvariants, y el test de keel-core los falsa. */
export const INVARIANT_SABOTAGES = Object.freeze({
  'ic-boundary': { breaks: ['IC-3'], reference: true, what: 'lte se evalúa como lt' },
  'ic-null-fails': { breaks: ['IC-5'], reference: true, what: 'una comparación con un operando ausente se rompe' },
  'ic-absent-null-only': { breaks: ['IC-7'], reference: true, what: 'solo el nulo cuenta como ausente' },
  'ic-no-bounds': { breaks: ['IC-8'], reference: true, what: 'la entidad no hace cumplir sus cotas' },
  'ic-children': { breaks: ['IC-9'], reference: true, what: 'la guarda no baja a las hijas' },
  'ic-default-code': { breaks: ['IC-11'], reference: true, what: 'ignora el error del check' },
  'ic-no-call': {
    // Los casos con algún vector que se rompe: IC-5 e IC-7 solo tienen vectores que se cumplen, y sin la llamada siguen
    // cumpliéndose (medido en invariant-check de keel-spring). Y sin ella no se comprueba que el derivado quepa: la suma
    // llega a la base tal cual (CP-4).
    breaks: ['IC-1', 'IC-2', 'IC-3', 'IC-4', 'IC-6', 'IC-8', 'IC-9', 'IC-10', 'IC-11', 'CP-4'],
    reference: false,
    what: 'el save no llama a ensureInvariants()'
  },
  // El desbordamiento llega a la base antes que la guarda (CP-4), y la fila rechazada queda escrita (IC-10). Un generador
  // cuyo save es transaccional revierte esa fila, y uno cuyo almacén admite el número no ve el desbordamiento: cada red
  // dice cuál de los dos enmascara (masks en su script), con el motivo medido.
  'ic-after-write': { breaks: ['IC-10', 'CP-4'], reference: false, what: 'la guarda corre después de escribir' }
});
