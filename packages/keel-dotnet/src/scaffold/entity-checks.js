// La guarda del agregado (DSL 2.31: `entities.<E>.checks`, las cotas de sus campos y `computed: { sum, count }`).
//
// D21 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md: build emite en la entidad `EnsureInvariants()` —los derivados, las
// cotas y los checks del agregado entero, las hijas primero— y el `Save` de los dos adaptadores la llama antes de
// escribir nada. El derivado es una propiedad que calcula desde las hijas: lo que el Save persiste (Apply y ToDocument la
// leen) es su valor. Todo sale del plan neutral (`entity.invariantPlan`, keel-core/gen/entity-checks.js), y el orden es
// contrato (D23): decide el `code` cuando se rompen dos. La aritmética es la de D5 (exacta y un solo redondeo HALF_UP, que
// en .NET es `MidpointRounding.AwayFromZero`) sobre el `decimal` de .NET, la misma que la referencia `evaluateComputed`.
// Es la misma guarda que emiten keel-spring y keel-nest; la miden db-check y doc-check (scripts/lib/invariant-probes.js).

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { declaredErrorFor } from '@keel-system/keel-core/gen/declared-errors';
import { guardsAggregate, invariantMessage, collectPlans } from '@keel-system/keel-core/gen/entity-checks';
import { DECIMAL_PRECISION } from '@keel-system/keel-core/gen/constraints';
import { memberOf as enumMemberOf } from './enums.js';
import { csFile, csLocal, csMember, csString, csVerbatim, declType, isNullable, located, namespaceOf } from './render.js';

export const INVARIANT_EXCEPTION = 'InvariantViolatedException';

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
export const DERIVED_MARK = '// Derivado (DSL 2.31): el valor que calcula la propiedad de la entidad.';

/** ¿Llama el Save de esta raíz a `EnsureInvariants()`? */
export const guardsOnSave = (entity) => Boolean(entity.isAggregateRoot && entity.guardsInvariants);

/** Las líneas con las que el Save empieza, dentro de su transacción: la guarda antes de leer o escribir nada (D21). */
export function saveGuardLines(entity) {
  return guardsOnSave(entity)
    ? ['// La guarda del agregado (DSL 2.31): nada se escribe si una invariante no se cumple.', 'entity.EnsureInvariants();']
    : [];
}

/** ¿Hace falta la clase de la invariante rota? Solo si alguna raíz se guarda y el diseño no la sustituye. */
const usesDefaultException = (model) =>
  (model.entities ?? []).some(guardsOnSave) && !declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated);

/** `Domain/Errors/InvariantViolatedException.cs` (422, el code canónico del catálogo), si hace falta. */
export function generate(model) {
  if (!usesDefaultException(model)) return [];
  const error = FRAMEWORK_ERRORS.invariantViolated;
  const { namespace, path } = located(model, 'errors', INVARIANT_EXCEPTION);
  return [
    {
      path,
      content: csFile({
        namespace,
        body: `/// <summary>
/// Una invariante de la entidad rota por un valor que calculó el servidor (DSL 2.31): un check del diseño, la cota de un
/// campo o un derivado que no cabe en su tipo. La lanza EnsureInvariants(), que el Save llama antes de escribir nada.
/// El cliente no mandó nada inválido (eso es ${FRAMEWORK_ERRORS.validation.code}, en el borde): por eso ${error.http}.
/// </summary>
public sealed class ${INVARIANT_EXCEPTION}(string message)
    : BusinessException(message, code: ${csString(error.code)}, httpStatus: ${error.http});`
      })
    }
  ];
}

/** `throw …` de una invariante rota con `code`. */
function raise(model, code, message) {
  const declared = code === FRAMEWORK_ERRORS.invariantViolated.code
    ? declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)
    : (model.errors ?? []).find((error) => error.code === code);
  if (!declared) return `throw new ${INVARIANT_EXCEPTION}(${csString(message)});`;
  // Un code con el status por operación: la entidad no sabe qué operación la guarda, y toma el primero que declara.
  const status = declared.dynamicStatus ? `, ${declared.usages?.[0]?.http ?? FRAMEWORK_ERRORS.invariantViolated.http}` : '';
  return `throw new ${declared.exceptionClass}(${csString(message)}${status});`;
}

// ─── Las expresiones de una ruta ─────────────────────────────────────────────

/**
 * El miembro de la entidad que nombra la cabeza de una ruta: `{ expr, csType, nullable, list, field, json }`. Se lee
 * siempre por la propiedad: la de un derivado calcula, y la de una colección es la vista de solo lectura.
 */
function memberOf(model, entity, head) {
  const field = entity.fields.find((candidate) => candidate.name === head);
  if (field) {
    return { expr: csMember(head), csType: field.csType, nullable: isNullable(field), list: Boolean(field.list), field, json: field.base === 'json' };
  }
  const relation = entity.relations.find((candidate) => candidate.name === head);
  const toMany = relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';
  if (relation && !relation.internal && model.layersPresent?.persistence) {
    return { expr: `${csMember(head)}Id`, csType: 'Guid', nullable: !relation.required, list: false };
  }
  return { expr: csMember(head), csType: toMany ? 'IReadOnlyList' : relation?.entity ?? 'object', nullable: !toMany && !relation?.required, list: toMany };
}

/** El valor de una ruta (`price.amount` → `Price?.Amount`) con su tipo C#. */
function pathValue(model, entity, path) {
  const member = memberOf(model, entity, path.head);
  if (path.sub === null) return member;
  const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === member.field?.namedType);
  const sub = vo?.fields.find((candidate) => candidate.name === path.sub);
  return {
    expr: `${member.expr}${member.nullable ? '?' : ''}.${csMember(path.sub)}`,
    csType: sub?.csType ?? 'object',
    nullable: member.nullable || (sub ? isNullable(sub) : true),
    list: Boolean(sub?.list),
    field: sub,
    json: sub?.base === 'json'
  };
}

/** ¿Está ausente? (D6, D20): el json solo si es nulo; el texto y las listas también vacíos. */
function absentExpr(value, helpers) {
  if (value.json) return value.nullable ? `${value.expr} is null` : `${value.expr}.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null`;
  if (value.list || value.csType === 'string') {
    helpers.add(value.list ? 'absentCollection' : 'absentText');
    return `IsAbsent(${value.expr})`;
  }
  return value.nullable ? `${value.expr} is null` : 'false';
}

/** Un literal del diseño para comparar con `value` (de categoría `category`). */
function literal(model, value, field, category, base, usings) {
  if (category === 'numeric') {
    const text = String(value);
    return field?.csType === 'decimal' || text.includes('.') ? `${text}m` : field?.csType === 'long' ? `${text}L` : text;
  }
  if (category === 'instant') {
    usings.push('System.Globalization');
    return base === 'date'
      ? `DateOnly.Parse(${csString(String(value))}, CultureInfo.InvariantCulture)`
      : `DateTimeOffset.Parse(${csString(String(value))}, CultureInfo.InvariantCulture)`;
  }
  if (field?.kind === 'enum') return `${field.namedType}.${enumValue(model, field.namedType, value)}`;
  return typeof value === 'string' ? csString(value) : String(value);
}

/** El miembro C# del valor `literal` de un enum del diseño. */
function enumValue(model, enumName, value) {
  const constant = (model.enums ?? []).find((entry) => entry.name === enumName)?.values.find((entry) => entry.literal === String(value))?.constant;
  return enumMemberOf(model, enumName, constant ?? String(value));
}

/** La condición de un check como expresión C#, o null si aplica siempre. */
function conditionExpr(model, entity, condition) {
  if (!condition) return null;
  const field = entity.fields.find((candidate) => candidate.name === condition.field);
  const tests = condition.values.map((value) => {
    const right = field?.kind === 'enum' ? `${field.namedType}.${enumValue(model, field.namedType, value)}` : typeof value === 'string' ? csString(value) : String(value);
    return `${csMember(condition.field)} == ${right}`;
  });
  const inside = tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
  return condition.negated ? `!${inside.startsWith('(') ? inside : `(${inside})`}` : inside;
}

const CMP = { eq: '==', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** Lo que dice si una comparación se CUMPLE (D19, D22: un operando ausente la cumple). */
function compareHolds(model, entity, check, usings) {
  const [fieldPath, thanPath] = check.paths;
  const left = pathValue(model, entity, fieldPath);
  const right = thanPath ? pathValue(model, entity, thanPath) : null;
  const base = left.field?.base;
  const rightExpr = right ? right.expr : literal(model, check.value, left.field, fieldPath.category, base, usings);
  const nulls = [left, ...(right ? [right] : [])].filter((value) => value.nullable).map((value) => `${value.expr} is null`);
  // Los operadores de C# sobre int, long y decimal comparan por cantidad, y sobre DateTimeOffset por instante.
  const comparison = `${left.expr} ${CMP[check.op]} ${rightExpr}`;
  return [...nulls, comparison].join(' || ');
}

/** La expresión que dice que el check se ROMPE. */
function checkViolation(model, entity, check, helpers, usings) {
  const absent = (path) => absentExpr(pathValue(model, entity, path), helpers);
  let broken;
  switch (check.kind) {
    case 'requires': broken = absent(check.paths[0]); break;
    case 'forbids': broken = `!(${absent(check.paths[0])})`; break;
    case 'exactlyOne':
      broken = `new[] { ${check.paths.map((path) => `!(${absent(path)})`).join(', ')} }.Count(present => present) != 1`;
      break;
    default: broken = `!(${compareHolds(model, entity, check, usings)})`;
  }
  const condition = conditionExpr(model, entity, check.condition);
  return condition ? `${condition} && ${broken.startsWith('!(') || !/\s/.test(broken) ? broken : `(${broken})`}` : broken;
}

/** La expresión que dice que una cota se ROMPE sobre `value` (no nulo), de tipo `csType`. */
function boundViolation(rule, value, csType, field, statics) {
  switch (rule.rule) {
    case 'size': {
      // La longitud de un texto en puntos de código (D24), no en unidades de UTF-16.
      const length = csType === 'string' ? `${value}.EnumerateRunes().Count()` : `${value}.Count`;
      const parts = [rule.min !== null ? `${length} < ${rule.min}` : null, rule.max !== null ? `${length} > ${rule.max}` : null].filter(Boolean);
      return parts.join(' || ');
    }
    case 'pattern': {
      const method = `${csMember(field)}Pattern`;
      statics.set(method, `    [GeneratedRegex(${csVerbatim(`^(?:${rule.regexp})\\z`)}, RegexOptions.CultureInvariant)]
    private static partial Regex ${method}();`);
      return `!${method}().IsMatch(${value})`;
    }
    default: {
      const op = rule.rule === 'min' ? '<' : '>';
      const text = String(rule.value);
      const suffix = csType === 'decimal' || text.includes('.') ? 'm' : csType === 'long' ? 'L' : '';
      return `${value} ${op} ${text}${suffix}`;
    }
  }
}

// ─── Los derivados ───────────────────────────────────────────────────────────

const ROUND = 'MidpointRounding.AwayFromZero';

/** El método privado que calcula un derivado sin redondear ni acotar, y la propiedad que lo expone. */
function computedMethods(model, entity, fieldName, spec) {
  const field = entity.fields.find((candidate) => candidate.name === fieldName);
  const property = csMember(fieldName);
  const type = declType(field);
  if (spec.kind === 'count') {
    const value = field.csType === 'long' ? `(long)${csMember(spec.relation)}.Count` : `${csMember(spec.relation)}.Count`;
    return {
      compute: null,
      getter: `    /// <summary>Derivado (DSL 2.31): count de ${spec.relation}. Lo calcula la entidad y lo persiste el Save; nunca viene del cliente.</summary>
    public ${type} ${property} => ${value};`
    };
  }
  const method = `Compute${property}`;
  const child = model.entities.find((candidate) => candidate.name === spec.child);
  const childField = (name) => child.fields.find((candidate) => candidate.name === name);
  const operand = (name) => {
    const childDef = childField(name);
    return { expr: `item.${csMember(name)}`, nullable: isNullable(childDef), decimal: childDef.csType === 'decimal' };
  };
  const amount = operand(spec.field);
  const factor = spec.times ? operand(spec.times) : null;
  const skip = [amount, factor].filter((entry) => entry?.nullable).map((entry) => `${entry.expr} is null`).join(' || ');
  const value = (entry) => (entry.nullable ? `${entry.expr}.Value` : entry.expr);
  // El sumando, como decimal: un entero se convierte antes de multiplicar, y la multiplicación ya es la de decimal.
  const amountExpr = amount.decimal ? value(amount) : `(decimal)${value(amount)}`;
  const lineExpr = factor ? `${amountExpr} * ${value(factor)}` : amountExpr;
  const decimal = spec.base === 'decimal';
  const scale = spec.scale ?? 0;
  // Exacta hasta el final y un solo redondeo (D5); un entero se suma exacto y cada línea pierde su parte decimal (D24).
  const line = decimal ? 'line' : 'decimal.Truncate(line)';
  const message = invariantMessage(entity.name, { kind: 'computed', field: fieldName });
  const local = `${csLocal(fieldName).replace(/^@/, '')}Sum`;
  // La escala del campo también en el valor: 0m redondeado a 2 decimales sigue siendo 0, y el cable diría 0 y no 0.00.
  const atScale = (expr) => `Math.Round(${expr}, ${scale}, ${ROUND})${scale > 0 ? ` + ${(0).toFixed(scale)}m` : ''}`;
  const integerType = field.csType === 'long' ? 'long' : 'int';
  return {
    compute: `    // Derivado (DSL 2.31): sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}. Exacto y un solo redondeo,
    // HALF_UP, a la escala del campo; una hija con el sumando o el factor ausente aporta cero. Null si no cabe en el
    // decimal de .NET: EnsureInvariants() lo responde como INVARIANT_VIOLATED.
    private decimal? ${method}()
    {
        try
        {
            var total = 0m;
            foreach (var item in ${csMember(spec.relation)})
            {
${skip ? `                if (${skip})\n                {\n                    continue;\n                }\n\n` : ''}                var line = ${lineExpr};
                total += ${line};
            }

            return total;
        }
        catch (OverflowException)
        {
            return null;
        }
    }`,
    getter: `    /// <summary>
    /// Derivado (DSL 2.31): lo calcula la entidad y lo persiste el Save (EnsureInvariants() ya comprobó que cabe); nunca
    /// viene del cliente.
    /// </summary>
    public ${type} ${property} => ${decimal
      ? atScale(`${method}() ?? throw new ${INVARIANT_EXCEPTION_OR_DECLARED(model)}(${csString(message)})`)
      : `(${integerType})(${method}() ?? throw new ${INVARIANT_EXCEPTION_OR_DECLARED(model)}(${csString(message)}))`};`,
    // Lo que no cabe en la columna (un decimal) o en el tipo (un entero) es INVARIANT_VIOLATED.
    overflow: decimal
      ? `${method}() is not { } ${local} || ExceedsDecimal(Math.Round(${local}, ${scale}, ${ROUND}), ${scale})`
      : `${method}() is not { } ${local} || ${local} < ${integerType}.MinValue || ${local} > ${integerType}.MaxValue`,
    helper: decimal ? 'exceedsDecimal' : null
  };
}

/** La clase de la invariante rota para el `throw` de una propiedad derivada (la declarada si el diseño la sustituye). */
function INVARIANT_EXCEPTION_OR_DECLARED(model) {
  return declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)?.exceptionClass ?? INVARIANT_EXCEPTION;
}

const HELPERS = {
  absentText: `    private static bool IsAbsent(string? value) => string.IsNullOrEmpty(value);`,
  absentCollection: `    private static bool IsAbsent<T>(IReadOnlyCollection<T> value) => value.Count == 0;`,
  exceedsDecimal: `    // Un decimal desborda cuando su parte entera no cabe en la columna: ${DECIMAL_PRECISION} dígitos menos la escala.
    private static bool ExceedsDecimal(decimal value, int scale) =>
        Math.Truncate(Math.Abs(value)).ToString(CultureInfo.InvariantCulture).TrimStart('0').Length > ${DECIMAL_PRECISION} - scale;`
};

/**
 * Lo que la entidad gana con la guarda: `{ getters: Map<campo, propiedad>, members: [bloques de la clase], partial,
 * usings }`. Vacío si su agregado no tiene nada que guardar desde ella. `partial` dice si la clase tiene que serlo (los
 * patrones van con GeneratedRegex).
 */
export function invariantMembers(model, entity) {
  const plan = planOf(model, entity);
  if (!plan) return { getters: new Map(), members: [], partial: false, usings: [] };
  const usings = [namespaceOf(model, 'errors')];
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
        ? `        foreach (var child in ${csMember(child.relation)})\n        {\n            child.EnsureInvariants();\n        }`
        : `        ${csMember(child.relation)}?.EnsureInvariants();`
    );
  }
  // Los derivados: un count siempre cabe; una suma, no.
  for (const { fieldName, spec } of plan.computed) {
    const methods = computedMethods(model, entity, fieldName, spec);
    getters.set(fieldName, methods.getter);
    if (methods.compute) computes.push(methods.compute);
    if (methods.overflow) {
      if (methods.helper) helpers.add(methods.helper);
      lines.push(`        if (${methods.overflow})\n        {\n            ${raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'computed', field: fieldName }))}\n        }`);
    }
  }
  // Las cotas de sus campos, en su orden.
  const bounds = plan.bounds.map((guard) => {
    const field = entity.fields.find((candidate) => candidate.name === guard.field);
    const csType = guard.element ? field.elementCsType ?? 'string' : field.csType;
    const property = csMember(guard.field);
    const value = guard.element ? 'element' : property;
    const parts = guard.rules.map((rule) => boundViolation(rule, value, csType, guard.field, statics));
    const broken = parts.length === 1 ? parts[0] : parts.map((expr) => `(${expr})`).join(' || ');
    const thrown = raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'bound', field: guard.field }));
    if (guard.element) {
      // Un elemento de tipo valor nunca es null: solo el texto (o un value object) lo comprueba.
      const present = csType === 'string' ? 'element is not null && ' : '';
      return `        foreach (var element in ${property})\n        {\n            if (${present}(${broken}))\n            {\n                ${thrown}\n            }\n        }`;
    }
    const nullable = isNullable(field) || csType === 'string';
    return `        if (${nullable ? `${property} is not null && ` : ''}(${broken}))\n        {\n            ${thrown}\n        }`;
  });
  if (bounds.length > 0) lines.push('        // Las cotas de sus campos (U1, U6: una cota de la entidad es siempre verdad).', ...bounds);
  // Sus checks, en el orden del diseño.
  const checks = plan.checks.map((check) => {
    const message = invariantMessage(entity.name, { kind: 'check', check });
    return `        // check ${check.index}: ${message.slice(entity.name.length + 2)}\n        if (${checkViolation(model, entity, check, helpers, usings)})\n        {\n            ${raise(model, check.error, message)}\n        }`;
  });
  if (checks.length > 0) lines.push(`        // Sus checks (domain: entities.${entity.name}.checks).`, ...checks);

  if (helpers.has('exceedsDecimal')) usings.push('System.Globalization');
  if (statics.size > 0) usings.push('System.Text.RegularExpressions');
  const members = [
    `    // ─── La guarda del agregado (DSL 2.31) ───────────────────────────────────
    // La emite build y la llama el Save del adaptador antes de escribir nada: recalcula los derivados y comprueba las
    // cotas de los campos y los checks del diseño, las hijas primero (el orden decide el code cuando se rompen dos).
    // No la llames desde el handler ni repitas sus comprobaciones en los métodos de negocio.
    public void EnsureInvariants()
    {
${lines.join('\n\n')}
    }`,
    ...computes,
    ...[...helpers].sort().map((name) => HELPERS[name]),
    ...statics.values()
  ];
  return { getters, members, partial: statics.size > 0, usings };
}
