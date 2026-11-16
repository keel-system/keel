// La guarda del agregado (DSL 2.31: `entities.<E>.checks`, las cotas de sus campos y `computed: { sum, count }`).
//
// D21 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md: build emite en la entidad `EnsureInvariants() error` —los derivados,
// las cotas y los checks del agregado entero, las hijas primero— y el `Save` de los dos adaptadores la llama antes de
// escribir nada (antes también de drenar los eventos). El derivado es un accesor que calcula desde las hijas: lo que el
// Save persiste es su valor, y el `<Raíz>State` lo sigue trayendo de la base, pero `Rehydrate` lo ignora. Todo sale del
// plan neutral (`entity.invariantPlan`, keel-core/gen/entity-checks.js), y el orden es contrato (D23): decide el `code`
// cuando se rompen dos. La aritmética es la de D5 (exacta y un solo redondeo HALF_UP a la escala del campo) sobre el
// `wire.Decimal` del proyecto, que no desborda nunca: lo que no cabe es la columna (DECIMAL_PRECISION dígitos) o el
// entero del campo. Es la misma guarda que emiten los otros tres; la miden db-check y doc-check
// (scripts/lib/invariant-probes.js).

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { declaredErrorFor } from '@keel-system/keel-core/gen/declared-errors';
import { guardsAggregate, invariantMessage, collectPlans } from '@keel-system/keel-core/gen/entity-checks';
import { DECIMAL_PRECISION } from '@keel-system/keel-core/gen/constraints';
import { enumConstant, goExported, WIRE_PACKAGE } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { domainPath, isOptional, layout, localName, packageFile } from './render.js';
import { sentinelOf } from './errors.js';

/**
 * El centinela de la invariante rota (el code canónico, o el del diseño si lo declara con el mismo code). Una función y no
 * una constante: errors.js importa este módulo, y al evaluarlo sentinelOf aún no tiene sus dependencias listas.
 */
export const invariantSentinel = () => sentinelOf(FRAMEWORK_ERRORS.invariantViolated.code);

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

/** ¿Llama el Save de esta raíz a `EnsureInvariants()`? */
export const guardsOnSave = (entity) => Boolean(entity.isAggregateRoot && entity.guardsInvariants);

/** Las líneas con las que empieza el Save (D21): la guarda antes de drenar los eventos y de abrir la transacción. */
export function saveGuardLines(entity, local) {
  return guardsOnSave(entity)
    ? `
	// La guarda del agregado (DSL 2.31): nada se escribe si una invariante no se cumple.
	if err := ${local}.EnsureInvariants(); err != nil {
		return nil, err
	}`
    : '';
}

/** ¿Es este campo un derivado estructurado? Su accesor calcula: no hay miembro que guardar en el struct. */
export const isDerived = (field) => Boolean(field?.computedSpec);

/**
 * El centinela de la invariante rota, si hace falta: alguna raíz se guarda y el diseño no lo sustituye (si lo hace, el
 * centinela es el de su error). Lo lista errors.js con los demás del dominio generado.
 */
export function invariantSentinels(model) {
  if (!(model.entities ?? []).some(guardsOnSave)) return [];
  // El diseño que lo sustituye (por su code o por su familia) da su propio centinela.
  if (declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)) return [];
  return [
    {
      name: invariantSentinel(),
      doc: 'una invariante de la entidad rota por un valor que calculó el servidor (DSL 2.31): un check del diseño, la cota de un campo o un derivado que no cabe en su tipo. Lo devuelve EnsureInvariants(), que el Save llama antes de escribir nada. El cliente no mandó nada inválido (eso es VALIDATION_ERROR, en el borde): por eso 422.',
      ...FRAMEWORK_ERRORS.invariantViolated
    }
  ];
}

/** `return …` de una invariante rota con `code`. */
function raise(model, code, message) {
  const declared = code === FRAMEWORK_ERRORS.invariantViolated.code
    ? declaredErrorFor(model, FRAMEWORK_ERRORS.invariantViolated)
    : (model.errors ?? []).find((error) => error.code === code);
  const sentinel = sentinelOf(declared?.code ?? code);
  const format = goString(message.replaceAll('%', '%%'));
  // Un code con el status por operación: la entidad no sabe qué operación la guarda, y toma el primero que declara.
  if (declared?.dynamicStatus) {
    return `return StatusErrorf(${sentinel}, ${declared.usages?.[0]?.http ?? FRAMEWORK_ERRORS.invariantViolated.http}, ${format})`;
  }
  return `return Errorf(${sentinel}, ${format})`;
}

// ─── Las expresiones de una ruta ─────────────────────────────────────────────
//
// Un valor es `{ nils: [condiciones que lo hacen ausente por nil], expr: el valor ya desreferenciado, goType, list, json,
// field }`: quien lo usa comprueba antes `nils` (la expresión solo es segura cuando ninguna se cumple).

function memberValue(model, entity, receiver, head) {
  const field = entity.fields.find((candidate) => candidate.name === head);
  if (field) {
    // El derivado se lee por su accesor, que calcula; lo demás, por el campo sin exportar.
    const access = isDerived(field) ? `${receiver}.${goExported(head)}()` : `${receiver}.${localName(head)}`;
    const optional = isOptional(field);
    return {
      nils: optional ? [`${access} == nil`] : [],
      expr: optional ? `*${access}` : access,
      goType: field.goType,
      list: Boolean(field.list),
      json: field.base === 'json',
      field
    };
  }
  const relation = entity.relations.find((candidate) => candidate.name === head);
  const toMany = relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';
  if (relation && !relation.internal && model.layersPresent?.persistence) {
    const access = `${receiver}.${localName(`${head}Id`)}`;
    return relation.required
      ? { nils: [], expr: access, goType: 'uuid.UUID', list: false }
      : { nils: [`${access} == nil`], expr: `*${access}`, goType: 'uuid.UUID', list: false };
  }
  const access = `${receiver}.${localName(head)}`;
  return toMany ? { nils: [], expr: access, goType: 'slice', list: true } : { nils: [`${access} == nil`], expr: access, goType: 'entity', list: false };
}

/** El valor de una ruta (`price.amount` → `p.price.Amount()`) con su tipo Go. */
function pathValue(model, entity, receiver, path) {
  const member = memberValue(model, entity, receiver, path.head);
  if (path.sub === null) return member;
  const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === member.field?.namedType);
  const sub = vo?.fields.find((candidate) => candidate.name === path.sub);
  const access = `${member.nils.length > 0 ? `(${member.expr})` : member.expr}.${goExported(path.sub)}()`;
  const optional = sub ? isOptional(sub) : false;
  return {
    nils: [...member.nils, ...(optional ? [`${access} == nil`] : [])],
    expr: optional ? `*${access}` : access,
    goType: sub?.goType ?? 'any',
    list: Boolean(sub?.list),
    json: sub?.base === 'json',
    field: sub
  };
}

/** Las condiciones `X == nil` negadas: el valor está. */
const notNil = (nils) => nils.map((nil) => nil.replace(/ == nil$/, ' != nil'));

/** El receptor de una llamada a método: un valor desreferenciado va entre paréntesis (`(*p.x).Cmp`). */
const recv = (expr) => (expr.startsWith('*') ? `(${expr})` : expr);

/** Entre paréntesis si es compuesta: va detrás de un `&&`. */
const wrap = (expr) => (/ (\|\||&&) /.test(expr) ? `(${expr})` : expr);

/** ¿Está ausente? (D6, D20): el json solo si es nulo; el texto y las listas también vacíos. */
function absentExpr(value) {
  const extra = value.json ? null : value.list ? `len(${value.expr}) == 0` : value.goType === 'string' ? `${value.expr} == ""` : null;
  const parts = [...value.nils, ...(extra ? [extra] : [])];
  return parts.length === 0 ? 'false' : parts.join(' || ');
}

/** ¿Está presente? La negación de `absentExpr`, escrita sin `!(…)`. */
function presentExpr(value) {
  const extra = value.json ? null : value.list ? `len(${value.expr}) > 0` : value.goType === 'string' ? `${value.expr} != ""` : null;
  const parts = [...notNil(value.nils), ...(extra ? [extra] : [])];
  return parts.length === 0 ? 'true' : parts.join(' && ');
}

const isDecimal = (value) => value.goType === 'wire.Decimal';
const isInteger = (value) => ['int32', 'int64', 'int'].includes(value.goType);

/** Un instante del diseño (ISO) como `time.Date(...)` en UTC. */
function instantLiteral(text) {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`checks: '${text}' no es un instante`);
  return `time.Date(${date.getUTCFullYear()}, ${date.getUTCMonth() + 1}, ${date.getUTCDate()}, ${date.getUTCHours()}, ${date.getUTCMinutes()}, ${date.getUTCSeconds()}, ${date.getUTCMilliseconds() * 1e6}, time.UTC)`;
}

/** Un literal del diseño del tipo de `value`. */
function literalFor(value, literal) {
  if (isDecimal(value)) return `wire.MustDecimal(${goString(String(literal))})`;
  if (isInteger(value)) return String(literal);
  if (value.goType === 'time.Time') return instantLiteral(String(literal));
  if (value.goType === 'wire.Date') return `wire.MustDate(${goString(String(literal))})`;
  if (value.goType === 'uuid.UUID') return `uuid.MustParse(${goString(String(literal))})`;
  if (value.field?.kind === 'enum') return enumConstant(value.field.namedType, String(literal));
  return typeof literal === 'string' ? goString(literal) : String(literal);
}

const OPS = { eq: '==', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
const NEGATED = { eq: 'ne', ne: 'eq', lt: 'gte', lte: 'gt', gt: 'lte', gte: 'lt' };

/** La comparación `left op right` con la semántica de cada tipo (Cmp en un decimal, Compare en un instante). */
function comparison(left, right, op, rightIsLiteral) {
  const symbol = OPS[op];
  if (isDecimal(left) || isDecimal(right)) {
    const asDecimal = (value, expr) => (isDecimal(value) ? expr : `wire.NewDecimal(int64(${expr}), 0)`);
    const rightExpr = rightIsLiteral ? right.expr : asDecimal(right, right.expr);
    return `${recv(asDecimal(left, left.expr))}.Cmp(${rightExpr}) ${symbol} 0`;
  }
  if (left.goType === 'time.Time' || left.goType === 'wire.Date') return `${recv(left.expr)}.Compare(${right.expr}) ${symbol} 0`;
  if (isInteger(left) && isInteger(right) && left.goType !== right.goType) return `int64(${left.expr}) ${symbol} int64(${right.expr})`;
  return `${left.expr} ${symbol} ${right.expr}`;
}

/**
 * Lo que dice que una comparación se ROMPE: sus dos operandos presentes y la comparación negada (D19, D22: un operando
 * ausente la cumple).
 */
function compareBroken(model, entity, receiver, check) {
  const [fieldPath, thanPath] = check.paths;
  const left = pathValue(model, entity, receiver, fieldPath);
  const right = thanPath
    ? pathValue(model, entity, receiver, thanPath)
    : { nils: [], expr: literalFor(left, check.value), goType: left.goType, field: left.field };
  return [...notNil(left.nils), ...notNil(right.nils), comparison(left, right, NEGATED[check.op], !thanPath)].join(' && ');
}

/** La condición de un check como expresión Go, o null si aplica siempre. */
function conditionExpr(model, entity, receiver, condition) {
  if (!condition) return null;
  const value = memberValue(model, entity, receiver, condition.field);
  const symbol = condition.negated ? '!=' : '==';
  const tests = condition.values.map((literal) => `${value.expr} ${symbol} ${literalFor(value, literal)}`);
  if (!condition.negated) {
    const any = tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
    return value.nils.length > 0 ? `${notNil(value.nils).join(' && ')} && ${any}` : any;
  }
  // `unless`: aplica fuera de esos valores, también sin valor.
  const none = tests.join(' && ');
  return value.nils.length > 0 ? `(${value.nils.join(' || ')} || ${wrap(none)})` : none;
}

/** La expresión que dice que el check se ROMPE. */
function checkViolation(model, entity, receiver, check, helpers) {
  const value = (path) => pathValue(model, entity, receiver, path);
  let broken;
  switch (check.kind) {
    case 'requires': broken = absentExpr(value(check.paths[0])); break;
    case 'forbids': broken = presentExpr(value(check.paths[0])); break;
    case 'exactlyOne':
      helpers.add('presentCount');
      broken = `presentCount(${check.paths.map((path) => presentExpr(value(path))).join(', ')}) != 1`;
      break;
    default: broken = compareBroken(model, entity, receiver, check);
  }
  const condition = conditionExpr(model, entity, receiver, check.condition);
  return condition ? `${condition} && ${wrap(broken)}` : broken;
}

/** La expresión que dice que una cota se ROMPE sobre `value` (ya desreferenciado), de tipo `goType`. */
function boundViolation(rule, value, goType, patternVar, statics) {
  switch (rule.rule) {
    case 'size': {
      // La longitud de un texto en puntos de código (D24), no en bytes.
      const length = goType === 'string' ? `utf8.RuneCountInString(${value})` : `len(${value})`;
      return [rule.min !== null ? `${length} < ${rule.min}` : null, rule.max !== null ? `${length} > ${rule.max}` : null].filter(Boolean).join(' || ');
    }
    case 'pattern':
      statics.set(patternVar, `// ${patternVar} es el formato de una cota de la entidad, entero (RE2, como el de Format).
var ${patternVar} = regexp.MustCompile(${goString(`^(?:${rule.regexp})$`)})`);
      return `!${patternVar}.MatchString(${value})`;
    default: {
      const op = rule.rule === 'min' ? '<' : '>';
      return goType === 'wire.Decimal' ? `${recv(value)}.Cmp(wire.MustDecimal(${goString(String(rule.value))})) ${op} 0` : `${value} ${op} ${rule.value}`;
    }
  }
}

// ─── Los derivados ───────────────────────────────────────────────────────────

/**
 * El cálculo de un derivado y su accesor: `{ compute: método privado o null, accessor, overflow: condición de
 * desbordamiento o null }`. El cálculo devuelve el valor y si cabe.
 */
function derivedMethods(model, entity, receiver, field) {
  const spec = field.computedSpec;
  const method = goExported(field.name);
  const optional = isOptional(field);
  const ret = optional ? `*${field.goType}` : field.goType;
  const doc = `// ${method}: derivado (DSL 2.31), ${spec.kind === 'count' ? `count de ${spec.relation}` : `sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}`}. Lo calcula la entidad desde sus
// hijas y lo persiste el Save (EnsureInvariants() ya comprobó que cabe); nunca viene del cliente.`;
  const value = (expr) => (optional ? `\tvalue := ${expr}\n\treturn &value` : `\treturn ${expr}`);
  if (spec.kind === 'count') {
    return { compute: null, overflow: null, accessor: `${doc}\nfunc (${receiver} *${entity.name}) ${method}() ${ret} {\n${value(`${field.goType}(len(${receiver}.${localName(spec.relation)}))`)}\n}` };
  }
  const compute = `compute${method}`;
  const child = model.entities.find((candidate) => candidate.name === spec.child);
  const childField = (name) => child.fields.find((candidate) => candidate.name === name);
  const operand = (name) => {
    const def = childField(name);
    const access = `item.${localName(name)}`;
    const nullable = isOptional(def);
    const plain = nullable ? `*${access}` : access;
    return { nil: nullable ? `${access} == nil` : null, expr: def.goType === 'wire.Decimal' ? plain : `wire.NewDecimal(int64(${plain}), 0)` };
  };
  const amount = operand(spec.field);
  const factor = spec.times ? operand(spec.times) : null;
  const skip = [amount, factor].filter((entry) => entry?.nil).map((entry) => entry.nil).join(' || ');
  const decimal = spec.base === 'decimal';
  const scale = spec.scale ?? 0;
  const line = factor ? `${recv(amount.expr)}.Mul(${factor.expr})` : amount.expr;
  const bits = field.goType === 'int64' ? 64 : 32;
  // Exacta hasta el final y un solo redondeo (D5); un entero se suma exacto y cada línea pierde su parte decimal (D24).
  const body = `	var total wire.Decimal
	for _, item := range ${receiver}.${localName(spec.relation)} {
${skip ? `		if ${skip} {\n			continue\n		}\n` : ''}		line := ${line}
		total = total.Add(${decimal ? 'line' : 'line.Rescale(0, wire.RoundDown)'})
	}
${decimal
    ? `	total = total.Rescale(${scale}, wire.RoundHalfUp)
	return total, !exceedsDecimal(total, ${scale})`
    : `	whole, err := strconv.ParseInt(total.String(), 10, ${bits})
	return ${field.goType}(whole), err == nil`}`;
  return {
    compute: `// ${compute} calcula ${field.name}: sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}, exacto y con un solo redondeo,
// HALF_UP, a la escala del campo; una hija con el sumando o el factor ausente aporta cero. El bool dice si el valor
// cabe en ${decimal ? 'la columna' : 'el entero del campo'}: si no, EnsureInvariants() lo responde como INVARIANT_VIOLATED.
func (${receiver} *${entity.name}) ${compute}() (${field.goType}, bool) {
${body}
}`,
    overflow: `_, fits := ${receiver}.${compute}(); !fits`,
    helper: decimal ? 'exceedsDecimal' : null,
    accessor: `${doc}\nfunc (${receiver} *${entity.name}) ${method}() ${ret} {\n\tvalue, _ := ${receiver}.${compute}()\n${optional ? '\treturn &value' : '\treturn value'}\n}`
  };
}

const HELPERS = {
  presentCount: `// presentCount cuenta los valores presentes de un exactlyOne (DSL 2.31).
func presentCount(present ...bool) int {
	count := 0
	for _, value := range present {
		if value {
			count++
		}
	}
	return count
}`,
  exceedsDecimal: `// exceedsDecimal dice si un decimal no cabe en su columna: su parte entera tiene más de ${DECIMAL_PRECISION} dígitos menos la
// escala (DSL 2.31). El decimal del proyecto no desborda nunca; la columna, sí.
func exceedsDecimal(value wire.Decimal, scale int32) bool {
	whole := strings.TrimLeft(value.Abs().Rescale(0, wire.RoundDown).String(), "0")
	return len(whole) > ${DECIMAL_PRECISION}-int(scale)
}`
};

const helpersUsedBy = new WeakMap();

/**
 * Lo que la entidad gana con la guarda: `{ accessors: Map<campo, accesor>, blocks: [bloques de nivel de paquete] }`.
 * Vacío si su agregado no tiene nada que guardar desde ella.
 */
export function invariantMembers(model, entity) {
  const plan = planOf(model, entity);
  if (!plan) return { accessors: new Map(), blocks: [] };
  const receiver = entity.name[0].toLowerCase();
  const helpers = new Set();
  const statics = new Map();
  const accessors = new Map();
  const computes = [];
  const lines = [];

  // Las hijas primero (D23), cada una con su propia guarda.
  for (const child of plan.children) {
    if (!guardsAggregate(child.plan)) continue;
    const relation = `${receiver}.${localName(child.relation)}`;
    lines.push(
      child.toMany
        ? `	for _, child := range ${relation} {
		if err := child.EnsureInvariants(); err != nil {
			return err
		}
	}`
        : `	if ${relation} != nil {
		if err := ${relation}.EnsureInvariants(); err != nil {
			return err
		}
	}`
    );
  }
  // Los derivados: un count siempre cabe; una suma, no.
  for (const { fieldName } of plan.computed) {
    const field = entity.fields.find((candidate) => candidate.name === fieldName);
    const methods = derivedMethods(model, entity, receiver, field);
    accessors.set(fieldName, methods.accessor);
    if (methods.compute) computes.push(methods.compute);
    if (methods.helper) helpers.add(methods.helper);
    if (methods.overflow) {
      lines.push(`	if ${methods.overflow} {\n		${raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'computed', field: fieldName }))}\n	}`);
    }
  }
  // Las cotas de sus campos, en su orden.
  const bounds = plan.bounds.map((guard) => {
    const field = entity.fields.find((candidate) => candidate.name === guard.field);
    const goType = guard.element ? field.elementGoType : field.goType;
    const patternVar = `${localName(entity.name)}${goExported(guard.field)}${guard.element ? 'Element' : ''}Pattern`;
    const thrown = raise(model, FRAMEWORK_ERRORS.invariantViolated.code, invariantMessage(entity.name, { kind: 'bound', field: guard.field }));
    const member = memberValue(model, entity, receiver, guard.field);
    const valueOf = guard.element ? 'element' : member.expr;
    const parts = guard.rules.map((rule) => boundViolation(rule, valueOf, goType, patternVar, statics));
    const broken = parts.length === 1 ? parts[0] : parts.map((expr) => `(${expr})`).join(' || ');
    if (guard.element) {
      return `	for _, element := range ${member.expr} {
		if ${broken} {
			${thrown}
		}
	}`;
    }
    const guarded = member.nils.length > 0 ? `${notNil(member.nils).join(' && ')} && ${wrap(broken)}` : broken;
    return `	if ${guarded} {\n		${thrown}\n	}`;
  });
  if (bounds.length > 0) lines.push('	// Las cotas de sus campos (U1, U6: una cota de la entidad es siempre verdad).', ...bounds);
  // Sus checks, en el orden del diseño.
  const checks = plan.checks.map((check) => {
    const message = invariantMessage(entity.name, { kind: 'check', check });
    return `	// check ${check.index}: ${message.slice(entity.name.length + 2)}\n	if ${checkViolation(model, entity, receiver, check, helpers)} {\n		${raise(model, check.error, message)}\n	}`;
  });
  if (checks.length > 0) lines.push(`	// Sus checks (domain: entities.${entity.name}.checks).`, ...checks);

  helpersUsedBy.set(entity, helpers);
  const guard = `// EnsureInvariants es la guarda del agregado (DSL 2.31): la emite build y la llama el Save del adaptador antes de
// escribir nada. Comprueba que los derivados quepan, las cotas de los campos y los checks del diseño, las hijas primero
// (el orden decide el code cuando se rompen dos). No la llames desde el handler ni repitas sus comprobaciones en los
// métodos de negocio.
func (${receiver} *${entity.name}) EnsureInvariants() error {
${lines.join('\n')}
	return nil
}`;
  return { accessors, blocks: [guard, ...computes, ...statics.values()] };
}

/** Las importaciones que puede necesitar el archivo de una entidad con guarda (el colector deja solo las usadas). */
export const GUARD_IMPORTS = ['regexp', 'strconv', 'unicode/utf8', 'time', WIRE_PACKAGE, 'github.com/google/uuid'];

/** `internal/domain/invariants.go`: las ayudas que comparten las guardas (solo las usadas: U1000 rechaza el resto). */
export function generate(model) {
  const used = new Set();
  for (const entity of model.entities ?? []) {
    if (!planOf(model, entity)) continue;
    if (!helpersUsedBy.has(entity)) invariantMembers(model, entity);
    for (const name of helpersUsedBy.get(entity) ?? []) used.add(name);
  }
  if (used.size === 0) return [];
  const blocks = [...used].sort().map((name) => HELPERS[name]);
  return [
    {
      path: domainPath(model, 'Invariants'),
      content: packageFile(model, layout(model).domain, { imports: ['strings', WIRE_PACKAGE], body: `\n${blocks.join('\n\n')}\n` })
    }
  ];
}
