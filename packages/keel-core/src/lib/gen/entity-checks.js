// Las invariantes de la entidad que se hacen cumplir (DSL 2.31, `entities.<E>.checks`) y los derivados estructurados
// (`computed: { sum, count }`), como decisiones neutrales.
//
// Un check es una invariante que la ENTIDAD comprueba al final de cada mutación, antes de guardar (D2 de
// PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): no la escribe el agente donde un escenario la pide, sino build donde el
// diseño la declara. Una rota es INVARIANT_VIOLATED (422) o el `error` del check. Aquí vive lo que la validación y los
// cuatro generadores tienen que leer igual: el inventario, cómo se resuelve la ruta de un check sobre la entidad y la
// frontera mientras un generador no lo genera.

import { FRAMEWORK_ERRORS } from '../framework-errors.js';
import { operationTargetEntity } from './model.js';

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

// ─── La frontera mientras un generador no lo genera ─────────────────────────

/**
 * Lo que un generador rechaza hasta su incremento: los checks y los derivados estructurados, con el mismo mensaje en los
 * cuatro. A medias fallarían en silencio: un check que no se comprueba es exactamente la invariante en prosa de antes.
 */
export function entityChecksPendingErrors(layers, generator, increment) {
  const pending = (what, fix) =>
    `${what} (DSL 2.31): ${generator} todavía no lo genera — llega en el incremento ${increment} de ` +
    `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md, y a medias fallaría en silencio. ${fix} para generar este diseño.`;
  const errors = [];
  const withChecks = [...new Set(declaredChecks(layers).map(({ entityName }) => entityName))];
  if (withChecks.length > 0) errors.push(pending(`domain: checks [${withChecks.join(', ')}]`, 'Pasa los checks a invariants'));
  for (const { entityName, fieldName } of declaredComputed(layers)) {
    errors.push(pending(`domain: ${entityName}.${fieldName}.computed estructurado`, 'Escribe el computed en prosa'));
  }
  return errors;
}
