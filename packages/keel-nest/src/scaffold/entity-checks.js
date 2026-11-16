// La guarda del agregado (DSL 2.31: `entities.<E>.checks`, las cotas de sus campos y `computed: { sum, count }`).
//
// D21 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md: build emite en la entidad `ensureInvariants()` —los derivados, las
// cotas y los checks del agregado entero, las hijas primero— y el `save` de los dos adaptadores la llama antes de
// escribir nada. El derivado es un getter que calcula desde las hijas: lo que el save persiste (toOrm lee el getter) es
// su valor. Todo sale del plan neutral (`entity.invariantPlan`, keel-core/gen/entity-checks.js), y el orden es contrato
// (D23): decide el `code` cuando se rompen dos. La aritmética es la de D5 (exacta y un solo redondeo HALF_UP) sobre el
// `Decimal` del proyecto, la misma que la referencia `evaluateComputed`. Es la misma guarda que emite keel-spring; la
// miden db-check y doc-check (scripts/lib/invariant-probes.js).

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { declaredErrorFor } from '@keel-system/keel-core/gen/declared-errors';
import { guardsAggregate, invariantMessage, collectPlans } from '@keel-system/keel-core/gen/entity-checks';
import { DECIMAL_PRECISION } from '@keel-system/keel-core/gen/constraints';
import { DIRS, classPath, tsModule, tsString } from './render.js';

export const INVARIANT_EXCEPTION = 'InvariantViolatedException';
export const INVARIANT_EXCEPTION_TS = classPath(DIRS.errors, INVARIANT_EXCEPTION);
const DECIMAL_TS = classPath(DIRS.support, 'Decimal');

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** El plan de cada entidad del modelo (la raíz y sus hijas), sacado del de las raíces. */
function planNodes(model) {
  const nodes = new Map();
  for (const root of model.entities ?? []) {
    if (!root.invariantPlan) continue;
    for (const node of collectPlans(root.invariantPlan)) if (!nodes.has(node.entity)) nodes.set(node.entity, node);
  }
  return nodes;
}

/** El plan de `entity` si su agregado tiene algo que guardar desde ella, o null. */
export function planOf(model, entity) {
  const node = planNodes(model).get(entity.name);
  return node && guardsAggregate(node) ? node : null;
}

/** La marca de la línea que guarda un derivado en el mapeo del adaptador (la busca el sabotaje cp-stale de las sondas). */
export const DERIVED_MARK = '// Derivado (DSL 2.31): el valor que calcula el getter de la entidad.';

/** ¿Llama el save de esta raíz a `ensureInvariants()`? */
export const guardsOnSave = (entity) => Boolean(entity.isAggregateRoot && entity.guardsInvariants);

/** La línea con la que el save empieza, dentro de su transacción: la guarda antes de leer o escribir nada (D21). */
export function saveGuardLine(entity, indent = '      ') {
  return guardsOnSave(entity)
    ? [`${indent}// La guarda del agregado (DSL 2.31): nada se escribe si una invariante no se cumple.`, `${indent}entity.ensureInvariants();`]
    : [];
}

/** ¿Hace falta la clase de la invariante rota? Solo si alguna raíz se guarda y el diseño no la sustituye. */
const usesDefaultException = (model) =>
  (model.entities ?? []).some(guardsOnSave) && !declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated);

/** `domain/errors/invariant-violated-exception.ts` (422, el code canónico del catálogo), si hace falta. */
export function generate(model) {
  if (!usesDefaultException(model)) return [];
  const error = FRAMEWORK_ERRORS.invariantViolated;
  return [
    {
      path: INVARIANT_EXCEPTION_TS,
      content: tsModule(
        INVARIANT_EXCEPTION_TS,
        [{ symbol: 'BusinessException', from: classPath(DIRS.errors, 'BusinessException') }],
        `/**
 * Una invariante de la entidad rota por un valor que calculó el servidor (DSL 2.31): un check del diseño, la cota de un
 * campo o un derivado que no cabe en su tipo. La lanza ensureInvariants(), que el save llama antes de escribir nada.
 * El cliente no mandó nada inválido —eso es ${FRAMEWORK_ERRORS.validation.code}, en el borde—: por eso ${error.http}.
 */
export class ${INVARIANT_EXCEPTION} extends BusinessException {
  static readonly CODE = ${tsString(error.code)};

  constructor(message: string) {
    super(message, { code: ${INVARIANT_EXCEPTION}.CODE, httpStatus: ${error.http} });
  }
}`
      )
    }
  ];
}

/** `throw …` de una invariante rota con `code`, y lo que hay que importar. */
function raise(model, code, message, imports) {
  const declared = code === FRAMEWORK_ERRORS.invariantViolated.code
    ? declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)
    : (model.errors ?? []).find((error) => error.code === code);
  if (!declared) {
    imports.push({ symbol: INVARIANT_EXCEPTION, from: INVARIANT_EXCEPTION_TS });
    return `throw new ${INVARIANT_EXCEPTION}(${tsString(message)});`;
  }
  imports.push({ symbol: declared.exceptionClass, from: classPath(DIRS.errors, declared.exceptionClass) });
  // Un code con el status por operación: la entidad no sabe qué operación la guarda, y toma el primero que declara.
  const status = declared.dynamicStatus ? `, ${declared.usages?.[0]?.http ?? FRAMEWORK_ERRORS.invariantViolated.http}` : '';
  return `throw new ${declared.exceptionClass}(${tsString(message)}${status});`;
}

// ─── Las expresiones de una ruta ─────────────────────────────────────────────

/** El miembro de la entidad que nombra la cabeza de una ruta: `{ expr, tsType, list, field, kind }`. */
function memberOf(model, entity, head) {
  const field = entity.fields.find((candidate) => candidate.name === head);
  // Un derivado se lee por su getter, que calcula: el campo guardado es lo que la entidad traía.
  if (field) return { expr: field.computedSpec ? `this.${head}` : `this.#${head}`, tsType: field.tsType, list: Boolean(field.list), field, kind: 'field' };
  const relation = entity.relations.find((candidate) => candidate.name === head);
  const toMany = relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';
  if (relation && !relation.internal && model.layersPresent?.persistence) return { expr: `this.#${head}Id`, tsType: 'string', list: false, kind: 'relation' };
  return { expr: `this.#${head}`, tsType: toMany ? 'array' : relation?.entity ?? 'unknown', list: toMany, kind: 'relation' };
}

/** El valor de una ruta (`price.amount` → `this.#price?.amount`) y su tipo TS. */
function pathValue(model, entity, path) {
  const member = memberOf(model, entity, path.head);
  if (path.sub === null) return member;
  const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === member.field?.namedType);
  const sub = vo?.fields.find((candidate) => candidate.name === path.sub);
  return { expr: `${member.expr}?.${path.sub}`, tsType: sub?.tsType ?? 'unknown', list: Boolean(sub?.list), field: sub, kind: 'field' };
}

/** ¿Está ausente? (D6, D20): el json solo si es nulo; el texto y las listas también vacíos; una referencia, si es nula. */
function absentExpr(value, category, helpers) {
  if (category === 'json' || value.kind === 'relation' && !value.list) return `${value.expr} == null`;
  if (value.list || value.tsType === 'string') {
    helpers.add('isAbsent');
    return `isAbsent(${value.expr})`;
  }
  return `${value.expr} == null`;
}

/** El literal TS de un valor de enum del diseño (`ProductStatus.ACTIVE`), o null si el campo no es un enum. */
function enumLiteral(model, field, value, imports) {
  if (field?.kind !== 'enum') return null;
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === field.namedType);
  const constant = enumDef?.values.find((entry) => entry.literal === String(value))?.constant;
  if (!constant) return null;
  imports.push({ symbol: field.namedType, from: classPath(DIRS.enums, field.namedType) });
  return `${field.namedType}.${constant}`;
}

/** La condición de un check como expresión TS, o null si aplica siempre. */
function conditionExpr(model, entity, condition, imports) {
  if (!condition) return null;
  const field = entity.fields.find((candidate) => candidate.name === condition.field);
  const tests = condition.values.map((value) => {
    const literal = enumLiteral(model, field, value, imports) ?? (typeof value === 'string' ? tsString(value) : String(value));
    return `this.#${condition.field} === ${literal}`;
  });
  const inside = tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
  return condition.negated ? `!${inside.startsWith('(') ? inside : `(${inside})`}` : inside;
}

const CMP = { eq: '===', ne: '!==', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** Lo que dice si una comparación se CUMPLE (D19, D22: un operando ausente la cumple). */
function compareHolds(model, entity, check, helpers, imports) {
  const [fieldPath, thanPath] = check.paths;
  const left = pathValue(model, entity, fieldPath);
  const right = thanPath ? pathValue(model, entity, thanPath) : null;
  const base = left.field?.base;
  const nulls = [`${left.expr} == null`, ...(right ? [`${right.expr} == null`] : [])];
  let comparison;
  if (fieldPath.category === 'numeric') {
    // Por cantidad, sobre Decimal: un number, un bigint y un Decimal se comparan igual, y el literal es exacto.
    imports.push({ symbol: 'Decimal', from: DECIMAL_TS });
    const rightExpr = right ? `Decimal.of(${right.expr})` : `Decimal.parse(${tsString(String(check.value))})`;
    comparison = `Decimal.of(${left.expr}).compareTo(${rightExpr}) ${CMP[check.op]} 0`;
  } else if (fieldPath.category === 'instant' && base !== 'date') {
    const rightExpr = right ? `${right.expr}.getTime()` : `new Date(${tsString(String(check.value))}).getTime()`;
    comparison = `${left.expr}.getTime() ${CMP[check.op]} ${rightExpr}`;
  } else {
    // Una fecha es su texto ISO (YYYY-MM-DD): el orden del texto es el del calendario.
    const rightExpr = right ? right.expr : enumLiteral(model, left.field, check.value, imports) ?? (typeof check.value === 'string' ? tsString(check.value) : String(check.value));
    comparison = `${left.expr} ${CMP[check.op]} ${rightExpr}`;
  }
  return `${nulls.join(' || ')} || ${comparison}`;
}

/** La expresión que dice que el check se ROMPE. */
function checkViolation(model, entity, check, helpers, imports) {
  const absent = (path) => absentExpr(pathValue(model, entity, path), path.category, helpers);
  let broken;
  switch (check.kind) {
    case 'requires': broken = absent(check.paths[0]); break;
    case 'forbids': broken = `!(${absent(check.paths[0])})`; break;
    case 'exactlyOne':
      broken = `[${check.paths.map((path) => `!(${absent(path)})`).join(', ')}].filter(Boolean).length !== 1`;
      break;
    default: broken = `!(${compareHolds(model, entity, check, helpers, imports)})`;
  }
  const condition = conditionExpr(model, entity, check.condition, imports);
  return condition ? `${condition} && ${broken.startsWith('!(') || !/\s/.test(broken) ? broken : `(${broken})`}` : broken;
}

/** La expresión que dice que una cota se ROMPE sobre `value` (no nulo), de tipo `tsType`. */
function boundViolation(rule, value, tsType, field, statics, imports) {
  switch (rule.rule) {
    case 'size': {
      // La longitud de un texto en puntos de código (D24), no en unidades de UTF-16.
      const length = tsType === 'string' ? `[...${value}].length` : `${value}.length`;
      const parts = [rule.min !== null ? `${length} < ${rule.min}` : null, rule.max !== null ? `${length} > ${rule.max}` : null].filter(Boolean);
      return parts.join(' || ');
    }
    case 'pattern': {
      const constant = `${constantOf(field)}_PATTERN`;
      statics.set(constant, `const ${constant} = new RegExp(${tsString(`^(?:${rule.regexp})$`)}, 'u');`);
      return `!${constant}.test(${value})`;
    }
    default: {
      const op = rule.rule === 'min' ? '<' : '>';
      if (tsType === 'number') return `${value} ${op} ${rule.value}`;
      if (tsType === 'bigint') return `${value} ${op} ${rule.value}n`;
      imports.push({ symbol: 'Decimal', from: DECIMAL_TS });
      return `${value}.compareTo(Decimal.parse(${tsString(String(rule.value))})) ${op} 0`;
    }
  }
}

// ─── Los derivados ───────────────────────────────────────────────────────────

/** El método privado que calcula un derivado sin redondear ni acotar, y el getter que lo expone. */
function computedMethods(model, entity, fieldName, spec, imports) {
  const field = entity.fields.find((candidate) => candidate.name === fieldName);
  const type = field.list ? field.tsType : `${field.tsType}${field.required ? '' : ' | null'}`;
  const method = `#compute${capital(fieldName)}`;
  if (spec.kind === 'count') {
    const value = field.tsType === 'bigint' ? `BigInt(this.#${spec.relation}.length)` : `this.#${spec.relation}.length`;
    return {
      compute: null,
      getter: `  // Derivado (DSL 2.31): count de ${spec.relation}. Lo calcula la entidad y lo persiste el save; nunca viene del cliente.
  get ${fieldName}(): ${type} {
    return ${value};
  }`
    };
  }
  imports.push({ symbol: 'Decimal', from: DECIMAL_TS });
  const amountExpr = `item.${spec.field}`;
  const factorExpr = spec.times ? `item.${spec.times}` : null;
  const skip = [amountExpr, factorExpr].filter(Boolean).map((expr) => `${expr} == null`).join(' || ');
  const lineExpr = factorExpr ? `Decimal.of(${amountExpr}).times(Decimal.of(${factorExpr}))` : `Decimal.of(${amountExpr})`;
  const decimal = spec.base === 'decimal';
  // Exacta hasta el final y un solo redondeo (D5); un entero se suma exacto y cada línea pierde su parte decimal (D24).
  const line = decimal ? 'line' : "line.setScale(0, 'DOWN')";
  const getterValue = decimal
    ? `this.${method}().setScale(${spec.scale ?? 0}, 'HALF_UP')`
    : field.tsType === 'bigint' ? `BigInt(this.${method}().toString())` : `Number(this.${method}().toString())`;
  const limits = field.tsType === 'bigint' ? ["'-9223372036854775808'", "'9223372036854775807'"] : ["'-2147483648'", "'2147483647'"];
  return {
    compute: `  // Derivado (DSL 2.31): sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}. Exacto y un solo redondeo,
  // HALF_UP, a la escala del campo; una hija con el sumando o el factor ausente aporta cero.
  ${method}(): Decimal {
    let total = Decimal.parse('0');
    for (const item of this.#${spec.relation}) {
      if (${skip}) {
        continue;
      }
      const line = ${lineExpr};
      total = total.plus(${line});
    }
    return total;
  }`,
    getter: `  // Lo calcula la entidad y lo persiste el save (ensureInvariants() ya comprobó que cabe); nunca viene del cliente.
  get ${fieldName}(): ${type} {
    return ${getterValue};
  }`,
    // Lo que no cabe en la columna (un decimal) o en el tipo (un entero) es INVARIANT_VIOLATED.
    overflow: decimal
      ? `exceedsDecimal(this.${method}().setScale(${spec.scale ?? 0}, 'HALF_UP'), ${spec.scale ?? 0})`
      : `exceedsInteger(this.${method}(), ${limits.join(', ')})`,
    helper: decimal ? 'exceedsDecimal' : 'exceedsInteger'
  };
}

const HELPERS = {
  isAbsent: `function isAbsent(value: string | readonly unknown[] | null | undefined): boolean {
  return value == null || value.length === 0;
}`,
  exceedsDecimal: `// Un decimal desborda cuando su parte entera no cabe en la columna: ${DECIMAL_PRECISION} dígitos menos la escala.
function exceedsDecimal(value: Decimal, scale: number): boolean {
  const integer = value.toString().replace('-', '').split('.')[0]!.replace(/^0+/, '');
  return integer.length > ${DECIMAL_PRECISION} - scale;
}`,
  exceedsInteger: `function exceedsInteger(value: Decimal, min: string, max: string): boolean {
  return value.compareTo(Decimal.parse(min)) < 0 || value.compareTo(Decimal.parse(max)) > 0;
}`
};

/**
 * Lo que la entidad gana con la guarda: `{ getters: Map<campo, getter>, members: [bloques de la clase], module: [lo que va
 * fuera de la clase] }`. Vacío si su agregado no tiene nada que guardar desde ella.
 */
export function invariantMembers(model, entity, imports) {
  const plan = planOf(model, entity);
  if (!plan) return { getters: new Map(), members: [], module: [] };
  const helpers = new Set();
  const statics = new Map();
  const getters = new Map();
  const computes = [];
  const lines = [];

  // Las hijas primero (D23), cada una con su propia guarda.
  for (const child of plan.children) {
    if (!guardsAggregate(child.plan)) continue;
    lines.push(
      child.toMany
        ? `    for (const child of this.#${child.relation}) {\n      child.ensureInvariants();\n    }`
        : `    this.#${child.relation}?.ensureInvariants();`
    );
  }
  // Los derivados: un count siempre cabe; una suma, no.
  for (const { fieldName, spec } of plan.computed) {
    const methods = computedMethods(model, entity, fieldName, spec, imports);
    getters.set(fieldName, methods.getter);
    if (methods.compute) computes.push(methods.compute);
    if (methods.overflow) {
      helpers.add(methods.helper);
      lines.push(`    if (${methods.overflow}) {\n      ${raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'computed', field: fieldName }), imports)}\n    }`);
    }
  }
  // Las cotas de sus campos, en su orden.
  const bounds = plan.bounds.map((guard) => {
    const field = entity.fields.find((candidate) => candidate.name === guard.field);
    const tsType = guard.element ? field.elementTsType ?? String(field.tsType).replace(/\[\]$/, '') : field.tsType;
    const value = guard.element ? 'element' : `this.#${guard.field}`;
    const parts = guard.rules.map((rule) => boundViolation(rule, value, tsType, guard.field, statics, imports));
    const broken = parts.length === 1 ? parts[0] : parts.map((expr) => `(${expr})`).join(' || ');
    const thrown = raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'bound', field: guard.field }), imports);
    return guard.element
      ? `    for (const element of this.#${guard.field}) {\n      if (element != null && (${broken})) {\n        ${thrown}\n      }\n    }`
      : `    if (this.#${guard.field} != null && (${broken})) {\n      ${thrown}\n    }`;
  });
  if (bounds.length > 0) lines.push('    // Las cotas de sus campos (U1, U6: una cota de la entidad es siempre verdad).', ...bounds);
  // Sus checks, en el orden del diseño.
  const checks = plan.checks.map((check) => {
    const message = invariantMessage(entity.name, { kind: 'check', check });
    return `    // check ${check.index}: ${message.slice(entity.name.length + 2)}\n    if (${checkViolation(model, entity, check, helpers, imports)}) {\n      ${raise(model, check.error, message, imports)}\n    }`;
  });
  if (checks.length > 0) lines.push(`    // Sus checks (domain: entities.${entity.name}.checks).`, ...checks);

  if ([...helpers].some((name) => name !== 'isAbsent')) imports.push({ symbol: 'Decimal', from: DECIMAL_TS });
  const members = [
    `  // ─── La guarda del agregado (DSL 2.31) ───────────────────────────────────
  // La emite build y la llama el save del adaptador antes de escribir nada: recalcula los derivados y comprueba las
  // cotas de los campos y los checks del diseño, las hijas primero (el orden decide el code cuando se rompen dos).
  // No la llames desde el handler ni repitas sus comprobaciones en los métodos de negocio.
  ensureInvariants(): void {
${lines.join('\n')}
  }`,
    ...computes
  ];
  const module = [...statics.values(), ...[...helpers].sort().map((name) => HELPERS[name])];
  return { getters, members, module };
}
