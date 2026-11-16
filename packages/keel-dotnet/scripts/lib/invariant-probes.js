// Las sondas de la GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) para
// db-check y doc-check: los vectores de keel-core/test/helpers/entity-check-designs.js (INVARIANT_VECTORS), con los ids
// IC-* y CP-* que ejecutan también el invariant-check de keel-spring y las sondas de keel-nest sobre el MISMO sujeto.
//
// Un [Fact] por vector, con el caso en el nombre (`Invariants_IC3_2_…`), dentro de la clase de sondas. Cada vector se
// construye con el constructor de rehidratación (el estado que sea, también uno que ningún método de negocio dejaría) y
// se guarda por el ADAPTADOR emitido: lo que se mide es el Save que emite build y la EnsureInvariants() que llama. Las
// etiquetas importan para el falsado (cada sabotaje cae en exactamente sus casos): solo IC-10 mira la fila después de un
// rechazo, solo CP-5 lee la columna (o el campo) persistida, y CP-1 a CP-3 leen el derivado de lo que devuelve el Save.
//
// El sujeto solo ejecuta sus vectores: la muestra de los demás bloques no cumple sus checks a propósito (los vectores
// parten de ella), y lo demás de catalog-extended ya lo mide su propio sujeto.

import { INVARIANT_SABOTAGES } from '@keel-system/keel-core/gen/entity-checks';
import { COMPUTED_SABOTAGES } from '@keel-system/keel-core/gen/computed';
import { snakeCase } from '@keel-system/keel-core/gen';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { INVARIANT_VECTORS } from '../../../keel-core/test/helpers/entity-check-designs.js';
import { enumMember } from '../../src/lib/cs-projection.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { csMember, csString, entityPlace, namespaceOf } from '../../src/scaffold/render.js';

/** La raíz del sujeto sobre la que están escritos los vectores. */
export const SUBJECT_ROOT = 'Product';

const DOMAIN = '.Domain/';
const ADAPTER = 'Persistence/Repositories/';
const GUARD = '// La guarda del agregado (DSL 2.31): nada se escribe si una invariante no se cumple.\n';
const GUARD_CALL = /\n {16}\/\/ La guarda del agregado \(DSL 2\.31\)[^\n]*\n {16}entity\.EnsureInvariants\(\);/;

/** Cada sabotaje, por rama: `[dónde, texto o expresión, sustituto]`. Todos compilan: lo que se mide es la sonda. */
const shared = {
  // lte se evalúa como lt (y gte como gt), en la comparación de cada check.
  'ic-boundary': [DOMAIN, /(\/\/ check \d+:[^\n]*\n {8}if \([^\n]*?) ([<>])= /g, '$1 $2 '],
  // Una comparación con un operando ausente se rompe (en los checks: el `item.X is null ||` de la suma no es uno).
  'ic-null-fails': [DOMAIN, /(?<![.\w])([A-Z]\w*) is null \|\| /g, '$1 is not null && '],
  // Solo el nulo cuenta como ausente.
  'ic-absent-null-only': [DOMAIN, 'private static bool IsAbsent(string? value) => string.IsNullOrEmpty(value);', 'private static bool IsAbsent(string? value) => value is null;'],
  // La entidad no hace cumplir sus cotas.
  'ic-no-bounds': [DOMAIN, /^ {8}\/\/ Las cotas de sus campos[^\n]*\n[\s\S]*?(?=^ {8}\/\/ Sus checks|^ {4}\}$)/gm, ''],
  // La guarda no baja a las hijas.
  'ic-children': [DOMAIN, /\n {8}foreach \(var child in \w+\)\n {8}\{\n {12}child\.EnsureInvariants\(\);\n {8}\}\n/g, '\n'],
  // Ignora el error del check.
  'ic-default-code': [DOMAIN, /throw new (?!InvariantViolatedException|InvalidStateTransitionException)(\w+Error)\(/g, 'throw new InvariantViolatedException('],
  // El Save no llama a EnsureInvariants().
  'ic-no-call': [ADAPTER, GUARD_CALL, ''],
  // La guarda corre después de escribir, justo antes de devolver.
  'ic-after-write': [ADAPTER, new RegExp(`${GUARD_CALL.source}([\\s\\S]*?)\\n( {16})return `), `$1\n$2${GUARD}$2entity.EnsureInvariants();\n$2return `],
  // Redondea cada línea antes de sumar.
  // (la propiedad, que lleva la escala, va antes que el método que suma).
  'cp-round-each': [
    DOMAIN,
    /Math\.Round\(Compute\w+\(\) \?\? [^\n]*?, (\d+), MidpointRounding\.AwayFromZero\)[\s\S]*?total \+= line;/g,
    (match, scale) => match.replace('total += line;', `total += Math.Round(line, ${scale}, MidpointRounding.AwayFromZero);`)
  ],
  // Redondea la mitad al par.
  'cp-half-even': [DOMAIN, 'MidpointRounding.AwayFromZero', 'MidpointRounding.ToEven'],
  // No comprueba que el resultado quepa.
  'cp-no-overflow': [DOMAIN, '|| ExceedsDecimal(', '|| false && ExceedsDecimal(']
};

export const INVARIANT_SABOTAGE_SPECS = Object.fromEntries([
  ...Object.entries(shared).map(([id, spec]) => [id, { relational: spec, document: spec }]),
  // El Save no escribe el derivado recalculado: sin la línea, EF no toca la columna de una fila rastreada (conserva lo que
  // traía) y el $set del documento no lleva el campo.
  [
    'cp-stale',
    {
      relational: [ADAPTER, /^ {8}\/\/ Derivado \(DSL 2\.31\)[^\n]*\n {8}row\.\w+ = entity\.\w+;\n/gm, ''],
      document: [ADAPTER, /^ {12}\/\/ Derivado \(DSL 2\.31\)[^\n]*\n {12}\{ "\w+", [^\n]*\n/gm, '']
    }
  ]
]);

const BREAKS = Object.fromEntries([...Object.entries(INVARIANT_SABOTAGES), ...Object.entries(COMPUTED_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isInvariantSabotage = (id) => Boolean(INVARIANT_SABOTAGE_SPECS[id]);

/** La raíz del sujeto si este modelo es el de los vectores (sus checks y su derivado), o null. */
export function invariantSubject(model) {
  const root = (model.entities ?? []).find((entity) => entity.name === SUBJECT_ROOT);
  return root && (root.checks ?? []).length > 0 && root.fields.some((field) => field.computedSpec) ? root : null;
}

/** Los casos que ejecuta el bloque de este diseño, en el orden de los vectores (los mismos que keel-spring y keel-nest). */
export function invariantCases(model) {
  return invariantSubject(model) ? [...new Set(INVARIANT_VECTORS.map((vector) => vector.case))] : [];
}

/**
 * Lo que enmascara cada rama, con su motivo medido (lo mismo que keel-spring y keel-nest): el Save es transaccional en los
 * dos modelos, así que la fila que la guarda rechaza después de escribirla se revierte (IC-10 no ve ic-after-write); y
 * Decimal128 admite la suma que no cabe en la columna, así que en documental CP-4 tampoco.
 */
export function invariantMasks(id, { document }) {
  if (id !== 'ic-after-write') return [];
  return document ? ['IC-10', 'CP-4'] : ['IC-10'];
}

/** Lo que tiene que caer con un sabotaje: sus casos que el bloque ejecuta, sin los enmascarados, y solo esos. */
export function invariantSabotageVerdict(failures, id, model, { document }) {
  const cases = invariantCases(model);
  const masked = invariantMasks(id, { document });
  const want = BREAKS[id].filter((caseId) => cases.includes(caseId) && !masked.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_(IC|CP)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want, masked };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Un valor del vector (con los nombres del diseño) como expresión C# del tipo del campo emitido. */
function valueExpr(model, field, value, ctx) {
  if (value === null || value === undefined) return 'null';
  if (field.kind === 'enum') {
    ctx.usings.push(namespaceOf(model, 'enums'));
    return `${field.namedType}.${enumMember(String(value))}`;
  }
  switch (field.base) {
    case 'decimal':
      return `${value}m`;
    case 'json':
      ctx.usings.push('System.Text.Json');
      return `JsonDocument.Parse(${csString(JSON.stringify(value))}).RootElement.Clone()`;
    case 'timestamp':
      ctx.usings.push('System.Globalization');
      return `DateTimeOffset.Parse(${csString(value)}, CultureInfo.InvariantCulture)`;
    case 'long':
      return `${value}L`;
    case 'int':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return csString(value);
  }
}

/** El nombre de la propiedad C# de cada derivado de la raíz y su base. */
const derivedOf = (root) => Object.fromEntries(root.fields.filter((field) => field.computedSpec).map((field) => [field.name, field]));

/** Lo que afirma un derivado esperado sobre `expr` (un decimal, con su escala: el texto invariante). */
function derivedAssert(field, expr, value) {
  return field.base === 'decimal'
    ? `Assert.Equal(${csString(String(value))}, ${expr}?.ToString(CultureInfo.InvariantCulture));`
    : `Assert.Equal(${value}, ${expr});`;
}

/**
 * Los [Fact] de los vectores y lo que necesitan, o null si el modelo no es el del sujeto: `{ methods, usings }`. `ctx` es
 * el de la clase de sondas (sus `refs` dan los `Ensure<Raíz>`); `sampleState` da el estado de muestra de una entidad, del
 * que salen los miembros que el vector no nombra; `rawDerived(idExpr, field)` lee la columna (o el campo) persistida de un
 * derivado como texto invariante.
 */
export function invariantProbeBlock(model, ctx, { sampleState, rawDerived }) {
  const root = invariantSubject(model);
  if (!root) return null;
  ctx.usings.push('System.Globalization', namespaceOf(model, entityPlace(root)));
  const relation = root.relations.find((candidate) => candidate.internal && candidate.cardinality === 'one-to-many');
  const child = model.entities.find((entity) => entity.name === relation.entity);
  ctx.usings.push(namespaceOf(model, entityPlace(child)));
  const fieldOf = (entity, name) => entity.fields.find((field) => field.name === name);
  const derived = derivedOf(root);
  const port = portClass(root);
  const id = csMember(root.idField?.name ?? 'id');
  const childId = csMember(child.idField?.name ?? 'id');

  // La muestra de base: sus referencias obligatorias son las de la clase (EnsureCategory…), y la piden todos los vectores.
  const refsBefore = new Set(ctx.refs);
  ctx.refs.clear();
  const baseState = sampleState(model, root, ctx, 'invariants');
  const imageState = sampleState(model, child, ctx, 'invimg');
  const refs = [...ctx.refs];
  for (const ref of refsBefore) ctx.refs.add(ref);
  const params = refs.map((ref) => `${model.entities.find((entity) => entity.name === ref)?.idField?.csType ?? 'Guid'} ${ref[0].toLowerCase()}${ref.slice(1)}Id`).join(', ');
  const args = refs.map((ref) => `await Ensure${ref}(services)`).join(', ');

  const imageExpr = (image, idExpr) => {
    const values = Object.fromEntries(Object.entries(image).filter(([name]) => fieldOf(child, name)).map(([name, value]) => [name, valueExpr(model, fieldOf(child, name), value, ctx)]));
    const lines = domainMembers(model, child).map((member) => `${csMember(member.name)} = ${member.name === (child.idField?.name ?? 'id') ? idExpr : values[member.name] ?? `image.${csMember(member.name)}`},`);
    return `new ${child.name}(new ${child.name}State { ${lines.join(' ')} })`;
  };
  let sku = 0;
  /** `new ProductState { … }` del estado, con `idExpr` y `lockExpr`; cada imagen con el id que diga `imageIds`. */
  const construct = (state, { idExpr = 'Guid.NewGuid()', lockExpr = 'null', imageIds = [] } = {}) => {
    const values = {};
    for (const [name, value] of Object.entries(state)) {
      if (name === relation.name) {
        values[name] = `[${value.map((image, at) => imageExpr(image, imageIds[at] ?? 'Guid.NewGuid()')).join(', ')}]`;
        continue;
      }
      const field = fieldOf(root, name);
      if (!field) continue;
      // La clave natural, distinta en cada vector: la sonda comparte la base con las demás y no vacía la tabla.
      const unique = name === 'sku' && value === 'ACME-1' ? `ACME-${++sku}` : value;
      values[name] = valueExpr(model, field, unique, ctx);
    }
    const lines = domainMembers(model, root).map((member) => {
      if (member.name === (root.idField?.name ?? 'id')) return `${id} = ${idExpr},`;
      return `${csMember(member.name)} = ${values[member.name] ?? `product.${csMember(member.name)}`},`;
    });
    if (root.usesOptimisticLocking && !root.declaresLockVersion) lines.push(`LockVersion = ${lockExpr},`);
    return `new ${root.name}(new ${root.name}State\n            {\n                ${lines.join('\n                ')}\n            })`;
  };
  const save = (expression) => `services.GetRequiredService<${port}>().Save(${expression}, Cancel)`;
  const prologue = `            var product = ${root.name}InvariantBase(${args});\n            var image = ${child.name}InvariantBase();`;

  const counts = new Map();
  const tests = INVARIANT_VECTORS.map((vector) => {
    const n = (counts.get(vector.case) ?? 0) + 1;
    counts.set(vector.case, n);
    const name = `Invariants_${vector.case.replace('-', '')}_${n}_${vector.expect ? 'Rechaza' : 'Guarda'}`;
    let body;
    if (vector.case === 'IC-10') {
      // Una fila válida que ya existía; el rechazo no tiene que tocarla.
      const draft = { ...vector.state, status: 'draft', publishedAt: null, retiredAt: null, attributes: null };
      body = `            var id = Guid.NewGuid();
            var stored = await InScope(other => other.GetRequiredService<${port}>().Save(${construct(draft, { idExpr: 'id' })}, Cancel));
            var error = await Assert.ThrowsAnyAsync<DomainException>(() => InScope(other => other.GetRequiredService<${port}>().Save(${construct(vector.state, { idExpr: 'id', lockExpr: 'stored.LockVersion' })}, Cancel)));
            Assert.Equal(${csString(vector.expect)}, error.Code);
            var after = await InScope(other => other.GetRequiredService<${port}>().FindById(id, Cancel));
            Assert.NotNull(after);
            Assert.Equal(stored.Status, after.Status);
            Assert.Equal(stored.LockVersion, after.LockVersion);`;
    } else if (vector.case === 'CP-5') {
      // Guardado antes con una imagen más: lo que queda en la columna tiene que ser el derivado de lo que hay AHORA.
      const kept = vector.state[relation.name];
      const extra = { ...kept[0], storageKey: 'img-extra.png', position: kept.length + 1 };
      const ids = kept.map((_, at) => `image${at}`);
      body = `            var id = Guid.NewGuid();
${ids.map((local) => `            var ${local} = Guid.NewGuid();`).join('\n')}
            var stored = await InScope(other => other.GetRequiredService<${port}>().Save(${construct({ ...vector.state, [relation.name]: [...kept, extra] }, { idExpr: 'id', imageIds: ids })}, Cancel));
            await InScope(other => other.GetRequiredService<${port}>().Save(${construct(vector.state, { idExpr: 'id', lockExpr: 'stored.LockVersion', imageIds: ids })}, Cancel));
${Object.entries(vector.derived).map(([field, value]) => `            Assert.Equal(${csString(String(value))}, await InScope(async other => ${rawDerived('id', derived[field])}));`).join('\n')}`;
    } else if (vector.expect) {
      body = `            var error = await Assert.ThrowsAnyAsync<DomainException>(() => ${save(construct(vector.state))});
            Assert.Equal(${csString(vector.expect)}, error.Code);`;
    } else {
      body = `            var saved = await ${save(construct(vector.state))};
            Assert.NotNull(saved);
${Object.entries(vector.derived ?? {}).map(([field, value]) => `            ${derivedAssert(derived[field], `saved.${csMember(field)}`, value)}`).join('\n')}`;
    }
    return `    /// <summary>${vector.case}: ${vector.title}${vector.expect ? ` → ${vector.expect}` : ''}.</summary>
    [Fact]
    public async Task ${name}() =>
        await InScope(async services =>
        {
${prologue}
${body.trimEnd()}
        });`;
  });

  const methods = `    // ─── La guarda del agregado (DSL 2.31): IC-* y CP-* ───

${tests.join('\n\n')}

    private static ${root.name}State ${root.name}InvariantBase(${params}) =>
        ${baseState};

    private static ${child.name}State ${child.name}InvariantBase() =>
        ${imageState};`;
  return { methods };
}

/** La columna de un derivado de la raíz en la fila, y la clave en el documento. */
export const derivedColumn = (field) => field.columns?.name ?? snakeCase(field.name);
export function derivedKey(model, root, field) {
  return documentShape(model, root).find((entry) => entry.field?.name === field.name)?.name ?? snakeCase(field.name);
}
