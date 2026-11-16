// La guarda del agregado (DSL 2.31: `entities.<E>.checks`, las cotas de sus campos y `computed: { sum, count }`).
//
// D21 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md: build emite en la entidad `ensureInvariants()` —los derivados, las
// cotas y los checks del agregado entero, las hijas primero— y el `save` de los dos adaptadores la llama antes de
// escribir nada. El derivado es un getter que calcula desde las hijas: lo que el save persiste es su valor. Todo sale
// del plan neutral (`entity.invariantPlan`, keel-core/gen/entity-checks.js), y el orden es contrato (D23): decide el
// `code` cuando se rompen dos. La aritmética es la de D5 (exacta y un solo redondeo HALF_UP), la misma que la referencia
// `evaluateComputed`; la mide invariant-check.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { declaredErrorFor } from '@keel-system/keel-core/gen/declared-errors';
import { guardsAggregate, invariantMessage, collectPlans } from '@keel-system/keel-core/gen/entity-checks';
import { DECIMAL_PRECISION } from '@keel-system/keel-core/gen/constraints';
import { javaFile, javaPath, subPackage } from './render.js';
import { screamingSnake } from '../lib/naming.js';

const ERRORS_PKG = 'domain.errors';
export const INVARIANT_EXCEPTION = 'InvariantViolatedException';

const java = (text) => JSON.stringify(text);
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const INTEGER_TYPES = new Set(['Integer', 'Long', 'int', 'long', 'Short', 'short']);

/** El plan de cada entidad del modelo (la raíz y sus hijas), sacado del de las raíces. */
function planNodes(model) {
  const nodes = new Map();
  for (const root of model.entities) {
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

/** ¿Llama el save de esta raíz a `ensureInvariants()`? */
export const guardsOnSave = (entity) => Boolean(entity.isAggregateRoot && entity.guardsInvariants);

/** La línea con la que el save empieza: la guarda antes de leer o escribir nada (D21). */
export function saveGuardLine(entity) {
  return guardsOnSave(entity) ? '        // La guarda del agregado (DSL 2.31): nada se escribe si una invariante no se cumple.\n        entity.ensureInvariants();\n' : '';
}

/** ¿Hace falta la clase de la invariante rota? Solo si alguna raíz se guarda y el diseño no la sustituye. */
const usesDefaultException = (model) =>
  model.entities.some(guardsOnSave) && !declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated);

/** `domain/errors/InvariantViolatedException.java` (422, el code canónico del catálogo), si hace falta. */
export function generate(model) {
  if (!usesDefaultException(model)) return [];
  const error = FRAMEWORK_ERRORS.invariantViolated;
  return [
    {
      path: javaPath(model, ERRORS_PKG, INVARIANT_EXCEPTION),
      content: javaFile(
        subPackage(model, ERRORS_PKG),
        [],
        `/**
 * Una invariante de la entidad rota por un valor que calculó el servidor (DSL 2.31): un check del diseño, la cota de un
 * campo o un derivado que no cabe en su tipo. La lanza ensureInvariants(), que el save llama antes de escribir nada.
 * El cliente no mandó nada inválido —eso es ${FRAMEWORK_ERRORS.validation.code}, en el borde—: por eso ${error.http}.
 */
public class ${INVARIANT_EXCEPTION} extends BusinessException {

    public static final String CODE = ${java(error.code)};

    public ${INVARIANT_EXCEPTION}(String message) {
        super(message, CODE, ${error.http}, null);
    }
}`
      )
    }
  ];
}

/** `throw …` de una invariante rota con `code`, y lo que hay que importar. */
function raise(model, code, message, imports) {
  const errorsPkg = subPackage(model, ERRORS_PKG);
  const declared = code === FRAMEWORK_ERRORS.invariantViolated.code
    ? declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)
    : (model.errors ?? []).find((error) => error.code === code);
  if (!declared) {
    imports.add(`${errorsPkg}.${INVARIANT_EXCEPTION}`);
    return `throw new ${INVARIANT_EXCEPTION}(${java(message)});`;
  }
  imports.add(`${errorsPkg}.${declared.exceptionClass}`);
  // Un code con el status por operación: la entidad no sabe qué operación la guarda, y toma el primero que declara.
  const status = declared.dynamicStatus ? `, ${declared.usages?.[0]?.http ?? FRAMEWORK_ERRORS.invariantViolated.http}` : '';
  return `throw new ${declared.exceptionClass}(${java(message)}${status});`;
}

// ─── Las expresiones de una ruta ─────────────────────────────────────────────

/** El miembro de la entidad que nombra la cabeza de una ruta: `{ expr, javaType, list }`. */
function memberOf(model, entity, head) {
  const field = entity.fields.find((candidate) => candidate.name === head);
  if (field) return { expr: head, javaType: field.javaType, list: Boolean(field.list), field };
  const relation = entity.relations.find((candidate) => candidate.name === head);
  const toMany = relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';
  if (relation && !relation.internal && model.layersPresent.persistence) return { expr: `${head}Id`, javaType: 'UUID', list: false };
  return { expr: head, javaType: toMany ? 'List' : relation?.entity ?? 'Object', list: toMany };
}

/** El valor de una ruta (`price.amount` → `(price == null ? null : price.amount())`) y su tipo Java. */
function pathValue(model, entity, path) {
  const member = memberOf(model, entity, path.head);
  if (path.sub === null) return member;
  const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === member.field?.namedType);
  const sub = vo?.fields.find((candidate) => candidate.name === path.sub);
  return { expr: `(${member.expr} == null ? null : ${member.expr}.${path.sub}())`, javaType: sub?.javaType ?? 'Object', list: Boolean(sub?.list) };
}

/** ¿Está ausente? (D6, D20): el json solo si es nulo; el texto y las listas también vacíos. */
function absentExpr(value, category, helpers) {
  if (category === 'json') return `${value.expr} == null`;
  if (value.list || value.javaType === 'String') {
    helpers.add(value.list ? 'absentCollection' : 'absentText');
    return `isAbsent(${value.expr})`;
  }
  return `${value.expr} == null`;
}

/** La condición de un check como expresión Java, o null si aplica siempre. */
function conditionExpr(model, entity, condition, imports) {
  if (!condition) return null;
  const field = entity.fields.find((candidate) => candidate.name === condition.field);
  const tests = condition.values.map((value) => {
    if (field?.kind === 'enum') return `${condition.field} == ${field.namedType}.${screamingSnake(String(value))}`;
    imports.add('java.util.Objects');
    return `Objects.equals(${condition.field}, ${typeof value === 'string' ? java(value) : String(value)})`;
  });
  const inside = tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
  return condition.negated ? `!${inside.startsWith('(') ? inside : `(${inside})`}` : inside;
}

const CMP = { eq: '==', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** Un literal del diseño del tipo de `value`. */
function literal(value, category, base, imports) {
  if (category === 'numeric') {
    imports.add('java.math.BigDecimal');
    return `new BigDecimal(${java(String(value))})`;
  }
  if (category === 'instant') {
    imports.add(base === 'date' ? 'java.time.LocalDate' : 'java.time.Instant');
    return base === 'date' ? `LocalDate.parse(${java(String(value))})` : `Instant.parse(${java(String(value))})`;
  }
  return typeof value === 'string' ? java(value) : String(value);
}

/** Lo que dice si una comparación se CUMPLE (D19, D22: un operando ausente la cumple). */
function compareHolds(model, entity, check, helpers, imports) {
  const [fieldPath, thanPath] = check.paths;
  const left = pathValue(model, entity, fieldPath);
  const base = entity.fields.find((candidate) => candidate.name === fieldPath.head)?.base;
  const right = thanPath ? pathValue(model, entity, thanPath) : null;
  const rightExpr = right ? right.expr : literal(check.value, fieldPath.category, base, imports);
  const nulls = [`Objects.isNull(${left.expr})`, ...(right ? [`Objects.isNull(${right.expr})`] : [])];
  imports.add('java.util.Objects');
  let comparison;
  if (fieldPath.category === 'numeric') {
    helpers.add('decimalOf');
    imports.add('java.math.BigDecimal');
    comparison = `decimalOf(${left.expr}).compareTo(${right ? `decimalOf(${rightExpr})` : rightExpr}) ${CMP[check.op]} 0`;
  } else if (fieldPath.category === 'instant') {
    comparison = `${left.expr}.compareTo(${rightExpr}) ${CMP[check.op]} 0`;
  } else {
    comparison = `${check.op === 'ne' ? '!' : ''}Objects.equals(${left.expr}, ${rightExpr})`;
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
      broken = `Stream.of(${check.paths.map((path) => `!(${absent(path)})`).join(', ')}).filter(Boolean::booleanValue).count() != 1`;
      imports.add('java.util.stream.Stream');
      break;
    default: broken = `!(${compareHolds(model, entity, check, helpers, imports)})`;
  }
  const condition = conditionExpr(model, entity, check.condition, imports);
  return condition ? `${condition} && ${broken.startsWith('!(') || !/\s/.test(broken) ? broken : `(${broken})`}` : broken;
}

/** La expresión que dice que una cota se ROMPE sobre `value` (no nulo), de tipo `javaType`. */
function boundViolation(rule, value, javaType, entityName, field, statics) {
  switch (rule.rule) {
    case 'size': {
      const length = javaType === 'String' ? `${value}.codePointCount(0, ${value}.length())` : `${value}.size()`;
      const parts = [rule.min !== null ? `${length} < ${rule.min}` : null, rule.max !== null ? `${length} > ${rule.max}` : null].filter(Boolean);
      return parts.join(' || ');
    }
    case 'pattern': {
      const constant = `${constantOf(field)}_PATTERN`;
      statics.set(constant, `    private static final Pattern ${constant} = Pattern.compile(${java(rule.regexp)});`);
      return `!${constant}.matcher(${value}).matches()`;
    }
    default: {
      const op = rule.rule === 'min' ? '<' : '>';
      if (INTEGER_TYPES.has(javaType)) return `${value} ${op} ${rule.value}${/Long|long/.test(javaType) ? 'L' : ''}`;
      return `${value}.compareTo(new BigDecimal(${java(String(rule.value))})) ${op} 0`;
    }
  }
}

// ─── Los derivados ───────────────────────────────────────────────────────────

/** El método privado que calcula un derivado sin redondear ni acotar, y el getter que lo expone. */
function computedMethods(model, entity, fieldName, spec, imports) {
  const field = entity.fields.find((candidate) => candidate.name === fieldName);
  const method = `compute${capital(fieldName)}`;
  if (spec.kind === 'count') {
    const value = /Long|long/.test(field.javaType) ? `(long) ${spec.relation}.size()` : `${spec.relation}.size()`;
    return {
      compute: null,
      getter: `    // Derivado (DSL 2.31): count de ${spec.relation}. Lo calcula la entidad y lo persiste el save; nunca viene del cliente.
    public ${field.javaType} get${capital(fieldName)}() {
        return ${value};
    }`
    };
  }
  imports.add('java.math.BigDecimal');
  imports.add('java.math.RoundingMode');
  const child = model.entities.find((candidate) => candidate.name === spec.child);
  const amount = child.fields.find((candidate) => candidate.name === spec.field);
  const factor = spec.times ? child.fields.find((candidate) => candidate.name === spec.times) : null;
  const asDecimal = (expr, javaType) => (javaType === 'BigDecimal' ? expr : `BigDecimal.valueOf(${expr})`);
  const amountExpr = `item.get${capital(spec.field)}()`;
  const factorExpr = factor ? `item.get${capital(spec.times)}()` : null;
  const skip = [amountExpr, factorExpr].filter(Boolean).map((expr) => `${expr} == null`).join(' || ');
  const lineExpr = factor ? `${asDecimal(amountExpr, amount.javaType)}.multiply(${asDecimal(factorExpr, factor.javaType)})` : asDecimal(amountExpr, amount.javaType);
  const decimal = spec.base === 'decimal';
  // Exacta hasta el final y un solo redondeo (D5); un entero se suma exacto y cada línea pierde su parte decimal (D24).
  const total = decimal ? `total.setScale(${spec.scale ?? 0}, RoundingMode.HALF_UP)` : 'total';
  const line = decimal ? 'line' : 'line.setScale(0, RoundingMode.DOWN)';
  const exact = /Long|long/.test(field.javaType) ? 'longValueExact' : 'intValueExact';
  return {
    compute: `    // Derivado (DSL 2.31): sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}. Exacto y un solo redondeo,
    // HALF_UP, a la escala del campo; una hija con el sumando o el factor ausente aporta cero.
    private BigDecimal ${method}() {
        BigDecimal total = BigDecimal.ZERO;
        for (${spec.child} item : ${spec.relation}) {
            if (${skip}) {
                continue;
            }
            BigDecimal line = ${lineExpr};
            total = total.add(${line});
        }
        return ${total};
    }`,
    getter: `    // Lo calcula la entidad y lo persiste el save (ensureInvariants() ya comprobó que cabe); nunca viene del cliente.
    public ${field.javaType} get${capital(fieldName)}() {
        return ${decimal ? `${method}()` : `${method}().${exact}()`};
    }`,
    // Lo que no cabe en la columna (un decimal) o en el tipo (un entero) es INVARIANT_VIOLATED.
    overflow: decimal
      ? `exceedsDecimal(${method}(), ${spec.scale ?? 0})`
      : `exceedsInteger(${method}(), ${/Long|long/.test(field.javaType) ? 'Long.MIN_VALUE, Long.MAX_VALUE' : 'Integer.MIN_VALUE, Integer.MAX_VALUE'})`,
    helper: decimal ? 'exceedsDecimal' : 'exceedsInteger'
  };
}

const HELPERS = {
  absentText: `    private static boolean isAbsent(String value) {
        return value == null || value.isEmpty();
    }`,
  absentCollection: `    private static boolean isAbsent(Collection<?> value) {
        return value == null || value.isEmpty();
    }`,
  decimalOf: `    private static BigDecimal decimalOf(Object value) {
        return value instanceof BigDecimal decimal ? decimal : new BigDecimal(value.toString());
    }`,
  exceedsDecimal: `    // Un decimal desborda cuando su parte entera no cabe en la columna: ${DECIMAL_PRECISION} dígitos menos la escala.
    private static boolean exceedsDecimal(BigDecimal value, int scale) {
        return value.precision() - value.scale() > ${DECIMAL_PRECISION} - scale;
    }`,
  exceedsInteger: `    private static boolean exceedsInteger(BigDecimal value, long min, long max) {
        return value.compareTo(BigDecimal.valueOf(min)) < 0 || value.compareTo(BigDecimal.valueOf(max)) > 0;
    }`
};

/**
 * Lo que la entidad gana con la guarda: `{ getters: Map<campo, getter>, members: [bloques] }`. Vacío si su agregado no
 * tiene nada que guardar desde ella.
 */
export function invariantMembers(model, entity, imports) {
  const plan = planOf(model, entity);
  if (!plan) return { getters: new Map(), members: [] };
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
        ? `        for (${child.plan.entity} child : ${child.relation}) {\n            child.ensureInvariants();\n        }`
        : `        if (${child.relation} != null) {\n            ${child.relation}.ensureInvariants();\n        }`
    );
  }
  // Los derivados: un count siempre cabe; una suma, no.
  for (const { fieldName, spec } of plan.computed) {
    const methods = computedMethods(model, entity, fieldName, spec, imports);
    getters.set(fieldName, methods.getter);
    if (methods.compute) computes.push(methods.compute);
    if (methods.overflow) {
      helpers.add(methods.helper);
      lines.push(`        if (${methods.overflow}) {\n            ${raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'computed', field: fieldName }), imports)}\n        }`);
    }
  }
  // Las cotas de sus campos, en su orden.
  const bounds = plan.bounds.map((guard) => {
    const field = entity.fields.find((candidate) => candidate.name === guard.field);
    const javaType = guard.element ? field.elementJavaType ?? 'String' : field.javaType;
    const value = guard.element ? 'element' : guard.field;
    if (guard.rules.some((rule) => rule.rule === 'min' || rule.rule === 'max') && !INTEGER_TYPES.has(javaType)) imports.add('java.math.BigDecimal');
    if (guard.rules.some((rule) => rule.rule === 'pattern')) imports.add('java.util.regex.Pattern');
    const parts = guard.rules.map((rule) => boundViolation(rule, value, javaType, entity.name, guard.field, statics));
    const broken = parts.length === 1 ? parts[0] : parts.map((expr) => `(${expr})`).join(' || ');
    const thrown = raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'bound', field: guard.field }), imports);
    return guard.element
      ? `        if (${guard.field} != null) {\n            for (${javaType} element : ${guard.field}) {\n                if (element != null && (${broken})) {\n                    ${thrown}\n                }\n            }\n        }`
      : `        if (${guard.field} != null && (${broken})) {\n            ${thrown}\n        }`;
  });
  if (bounds.length > 0) lines.push('        // Las cotas de sus campos (U1, U6: una cota de la entidad es siempre verdad).', ...bounds);
  // Sus checks, en el orden del diseño.
  const checks = plan.checks.map((check) => {
    const message = invariantMessage(entity.name, { kind: 'check', check });
    return `        // check ${check.index}: ${message.slice(entity.name.length + 2)}\n        if (${checkViolation(model, entity, check, helpers, imports)}) {\n            ${raise(model, check.error, message, imports)}\n        }`;
  });
  if (checks.length > 0) lines.push('        // Sus checks (domain: entities.' + entity.name + '.checks).', ...checks);

  if (helpers.has('absentCollection')) imports.add('java.util.Collection');
  if ([...helpers].some((name) => name !== 'absentText' && name !== 'absentCollection')) imports.add('java.math.BigDecimal');
  const members = [
    ...statics.values(),
    `    // ─── La guarda del agregado (DSL 2.31) ───────────────────────────────────
    // La emite build y la llama el save del adaptador antes de escribir nada: recalcula los derivados y comprueba las
    // cotas de los campos y los checks del diseño, las hijas primero (el orden decide el code cuando se rompen dos).
    // No la llames desde el handler ni repitas sus comprobaciones en los métodos de negocio.
    public void ensureInvariants() {
${lines.join('\n')}
    }`,
    ...computes,
    ...[...helpers].sort().map((name) => HELPERS[name])
  ].filter(Boolean);
  return { getters, members };
}
