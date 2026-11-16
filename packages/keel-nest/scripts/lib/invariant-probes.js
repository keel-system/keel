// Las sondas de la GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) para
// db-check y doc-check: los vectores de keel-core/test/helpers/entity-check-designs.js (INVARIANT_VECTORS), con los ids
// IC-* y CP-* que ejecuta también el invariant-check de keel-spring sobre el MISMO sujeto.
//
// Cada vector se construye con el constructor de rehidratación (el estado que sea, también uno que ningún método de
// negocio dejaría) y se guarda por el ADAPTADOR emitido: lo que se mide es el save que emite build y la
// ensureInvariants() que llama. Las etiquetas importan para el falsado (cada sabotaje cae en exactamente sus casos): solo
// IC-10 mira la fila después de un rechazo, solo CP-5 lee la columna (o el campo) persistida, y CP-1 a CP-3 leen el
// derivado de lo que devuelve el save.

import { INVARIANT_SABOTAGES } from '@keel-system/keel-core/gen/entity-checks';
import { COMPUTED_SABOTAGES } from '@keel-system/keel-core/gen/computed';
import { INVARIANT_VECTORS } from '../../../keel-core/test/helpers/entity-check-designs.js';
import { classPath, DIRS, entityDir } from '../../src/scaffold/render.js';

/** La raíz del sujeto sobre la que están escritos los vectores. */
export const SUBJECT_ROOT = 'Product';

const js = (value) => JSON.stringify(value);
const ENTITIES = /src[\\/]domain[\\/](aggregate|entity)[\\/][^\\/]+\.ts$/;
const IMPL = '-repository-impl.ts';
const GUARD_CALL = /\n {6}\/\/ La guarda del agregado \(DSL 2\.31\)[^\n]*\n {6}entity\.ensureInvariants\(\);/;

/** Cada sabotaje, por rama: `[dónde, texto o expresión, sustituto]`. Todos compilan: lo que se mide es la sonda. */
const shared = {
  // lte se evalúa como lt (y gte como gt).
  'ic-boundary': [ENTITIES, /\) ([<>])= (0|this\.#\w+\.getTime\(\))\)\) \{/g, ') $1 $2)) {'],
  // Una comparación con un operando ausente se rompe.
  'ic-null-fails': [ENTITIES, /(this\.#\w+) == null \|\| /g, '$1 != null && '],
  // Solo el nulo cuenta como ausente.
  'ic-absent-null-only': [ENTITIES, 'return value == null || value.length === 0;', 'return value == null;'],
  // La entidad no hace cumplir sus cotas.
  'ic-no-bounds': [ENTITIES, /^ {4}\/\/ Las cotas de sus campos[^\n]*\n[\s\S]*?(?=^ {4}\/\/ Sus checks|^ {2}\}$)/gm, ''],
  // La guarda no baja a las hijas.
  'ic-children': [ENTITIES, /\n {4}for \(const child of this\.#\w+\) \{\n {6}child\.ensureInvariants\(\);\n {4}\}/g, ''],
  // Ignora el error del check.
  'ic-default-code': [ENTITIES, /throw new (?!InvariantViolatedException|InvalidStateTransitionException)(\w+Error)\(/g, 'throw new InvariantViolatedException('],
  // El save no llama a ensureInvariants().
  'ic-no-call': [IMPL, GUARD_CALL, ''],
  // La guarda corre después de escribir, justo antes de devolver.
  'ic-after-write': [IMPL, new RegExp(`${GUARD_CALL.source}([\\s\\S]*?)\\n {6}return `), '$1\n      entity.ensureInvariants();\n      return '],
  // Redondea cada línea antes de sumar.
  'cp-round-each': [ENTITIES, /total = total\.plus\(line\);([\s\S]*?)setScale\((\d+), 'HALF_UP'\)/g, "total = total.plus(line.setScale($2, 'HALF_UP'));$1setScale($2, 'HALF_UP')"],
  // Redondea la mitad al par.
  'cp-half-even': [ENTITIES, "'HALF_UP'", "'HALF_EVEN'"],
  // No comprueba que el resultado quepa.
  'cp-no-overflow': [ENTITIES, 'if (exceedsDecimal(', 'if (false && exceedsDecimal(']
};

export const INVARIANT_SABOTAGE_SPECS = Object.fromEntries([
  ...Object.entries(shared).map(([id, spec]) => [id, { relational: spec, document: spec }]),
  // El save no escribe el derivado recalculado: sin la línea, TypeORM no toca la columna (conserva lo que la fila traía) y
  // el $set del documento no lleva el campo.
  [
    'cp-stale',
    {
      relational: [IMPL, /^ {2}\/\/ Derivado \(DSL 2\.31\)[^\n]*\n {2}orm\.\w+ = entity\.\w+;\n/gm, ''],
      document: [IMPL, /^ {4}\/\/ Derivado \(DSL 2\.31\)[^\n]*\n {4}\w+: [^\n]*\n/gm, '']
    }
  ]
]);

const BREAKS = Object.fromEntries([...Object.entries(INVARIANT_SABOTAGES), ...Object.entries(COMPUTED_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isInvariantSabotage = (id) => Boolean(INVARIANT_SABOTAGE_SPECS[id]);

/** La raíz del sujeto si este modelo es el de los vectores (sus checks y su derivado), o null. */
function subjectOf(model) {
  const root = (model.entities ?? []).find((entity) => entity.name === SUBJECT_ROOT);
  return root && (root.checks ?? []).length > 0 && root.fields.some((field) => field.computedSpec) ? root : null;
}

/** Los casos que ejecuta el bloque de este diseño, en el orden de los vectores (los mismos que keel-spring). */
export function invariantCases(model) {
  return subjectOf(model) ? [...new Set(INVARIANT_VECTORS.map((vector) => vector.case))] : [];
}

/**
 * Lo que enmascara cada rama, con su motivo medido (lo mismo que keel-spring): el save es transaccional en los dos
 * modelos, así que la fila que la guarda rechaza después de escribirla se revierte (IC-10 no ve ic-after-write); y
 * Decimal128 admite la suma que no cabe en la columna, así que en documental CP-4 tampoco.
 */
export function invariantMasks(id, { document }) {
  if (id !== 'ic-after-write') return [];
  return document ? ['IC-10', 'CP-4'] : ['IC-10'];
}

/** Lo que tiene que caer con un sabotaje: sus casos que el bloque ejecuta, sin los enmascarados, y solo esos. */
export function invariantSabotageVerdict(checks, id, model, { document }) {
  const cases = invariantCases(model);
  const masked = invariantMasks(id, { document });
  const want = BREAKS[id].filter((caseId) => cases.includes(caseId) && !masked.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^(IC|CP)-\d+:/.test(check.name)).map((check) => /^((IC|CP)-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want, masked };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Un valor del vector (con los nombres del diseño) como expresión JS del tipo del campo emitido. */
function valueExpr(model, field, value, ctx) {
  if (value === null || value === undefined) return 'null';
  if (field.kind === 'enum') {
    const constant = model.enums.find((entry) => entry.name === field.namedType)?.values.find((entry) => entry.literal === String(value))?.constant;
    ctx.imports.add(`${field.namedType}|${classPath(DIRS.enums, field.namedType)}`);
    return `${field.namedType}.${constant}`;
  }
  switch (field.base) {
    case 'decimal':
      ctx.imports.add('Decimal|src/domain/support/decimal.ts');
      return `Decimal.parse(${js(String(value))})`;
    case 'json':
      ctx.imports.add('RawJson|src/domain/support/raw-json.ts');
      return `RawJson.of(${js(JSON.stringify(value))})`;
    case 'timestamp': return `new Date(${js(value)})`;
    case 'long': return `${value}n`;
    case 'int': return String(value);
    default: return js(value);
  }
}

/**
 * El bloque de los vectores, con `check`, `stateOf` y `randomUUID` del script de la sonda. `sampleEntity` da el agregado
 * de muestra (del que salen los campos que el vector no nombra), `adapterOf(entity)` el adaptador de la raíz y
 * `rawOf(idExpr)` la expresión que lee la fila o el documento crudo; `keys` son las columnas (o claves) de los derivados.
 */
export function invariantBlock(model, ctx, { sampleEntity, adapterOf, rawOf, keys }) {
  const root = subjectOf(model);
  if (!root) return '';
  const relation = root.relations.find((candidate) => candidate.internal && candidate.cardinality === 'one-to-many');
  const child = model.entities.find((entity) => entity.name === relation.entity);
  ctx.imports.add(`${child.name}|${classPath(entityDir(child), child.name)}`);
  const idName = root.idField?.name ?? 'id';
  const childId = child.idField?.name ?? 'id';
  const fieldOf = (entity, name) => entity.fields.find((field) => field.name === name);

  const imageExpr = (image, idExpr) => {
    const parts = Object.entries(image).filter(([name]) => fieldOf(child, name)).map(([name, value]) => `${name}: ${valueExpr(model, fieldOf(child, name), value, ctx)}`);
    return `new ${child.name}({ ...imageBase, ${childId}: ${idExpr}, ${parts.join(', ')} })`;
  };
  let sku = 0;
  /** `new Product(...)` del estado, con `idExpr` y `lockExpr`; cada imagen con el id que diga `imageIds`. */
  const construct = (state, { idExpr = 'randomUUID()', lockExpr = 'null', imageIds = [] } = {}) => {
    const parts = [];
    for (const [name, value] of Object.entries(state)) {
      if (name === relation.name) {
        parts.push(`${name}: [${value.map((image, at) => imageExpr(image, imageIds[at] ?? 'randomUUID()')).join(', ')}]`);
        continue;
      }
      const field = fieldOf(root, name);
      if (!field) continue;
      // La clave natural, distinta en cada vector: la sonda no vacía la tabla entre uno y otro.
      const unique = name === 'sku' && value === 'ACME-1' ? `ACME-${++sku}` : value;
      parts.push(`${name}: ${valueExpr(model, field, unique, ctx)}`);
    }
    return `new ${SUBJECT_ROOT}({ ...productBase, ${idName}: ${idExpr}, lockVersion: ${lockExpr}, ${parts.join(', ')} })`;
  };

  const tests = [];
  for (const vector of INVARIANT_VECTORS) {
    const label = `${vector.case}: ${vector.title}${vector.expect ? ` → ${vector.expect}` : ''}`;
    const rejected = (expression) => `    try {
      await repository.save(${expression});
      check(${js(label)}, false, 'se guardó');
    } catch (error) {
      check(${js(label)}, error?.code === ${js(vector.expect)}, error?.code ?? error?.message);
    }`;
    let body;
    if (vector.case === 'IC-10') {
      // Una fila válida que ya existía; el rechazo no tiene que tocarla.
      const draft = { ...vector.state, status: 'draft', publishedAt: null, retiredAt: null, attributes: null };
      body = `    const id = randomUUID();
    const stored = await repository.save(${construct(draft, { idExpr: 'id' })});
    try {
      await repository.save(${construct(vector.state, { idExpr: 'id', lockExpr: 'stored.lockVersion' })});
      check(${js(label)}, false, 'se guardó');
    } catch (error) {
      const after = await repository.findById(id);
      check(${js(label)}, error?.code === ${js(vector.expect)} && String(after?.status) === String(stored.status) && Number(after?.lockVersion) === Number(stored.lockVersion), \`\${error?.code} · \${after?.status} v\${after?.lockVersion}\`);
    }`;
    } else if (vector.case === 'CP-5') {
      // Guardado antes con una imagen más: lo que queda en la columna tiene que ser el derivado de lo que hay AHORA.
      const kept = vector.state[relation.name];
      const extra = { ...kept[0], storageKey: 'img-extra.png', position: kept.length + 1 };
      const ids = kept.map((_, at) => `image${at}`);
      const asserts = Object.entries(vector.derived).map(([name, value]) => {
        const read = `raw?.[${js(keys[name])}]`;
        return fieldOf(root, name).base === 'decimal' ? `String(${read}) === ${js(String(value))}` : `Number(${read}) === ${value}`;
      });
      body = `    const id = randomUUID();
${ids.map((name) => `    const ${name} = randomUUID();`).join('\n')}
    const stored = await repository.save(${construct({ ...vector.state, [relation.name]: [...kept, extra] }, { idExpr: 'id', imageIds: ids })});
    await repository.save(${construct(vector.state, { idExpr: 'id', lockExpr: 'stored.lockVersion', imageIds: ids })});
    const raw = ${rawOf('id')};
    check(${js(label)}, ${asserts.join(' && ')}, JSON.stringify(${js(Object.keys(vector.derived).map((name) => keys[name]))}.map((key) => String(raw?.[key]))));`;
    } else if (vector.expect) {
      body = rejected(construct(vector.state));
    } else {
      const asserts = Object.entries(vector.derived ?? {}).map(([name, value]) =>
        fieldOf(root, name).base === 'decimal' ? `saved.${name}?.toString() === ${js(String(value))}` : `Number(saved.${name}) === ${value}`
      );
      body = `    try {
      const saved = await repository.save(${construct(vector.state)});
      check(${js(label)}, ${asserts.length > 0 ? asserts.join(' && ') : 'saved != null'}, ${asserts.length > 0 ? `JSON.stringify([${Object.keys(vector.derived).map((name) => `String(saved.${name})`).join(', ')}])` : "''"});
    } catch (error) {
      check(${js(label)}, false, error?.code ?? error?.message);
    }`;
    }
    tests.push(`  {\n${body}\n  }`);
  }

  return `
// ─── La guarda del agregado (DSL 2.31): IC-* y CP-* ───
{
  const repository = ${adapterOf(root)};
  const productBase = stateOf(${sampleEntity(model, root, ctx, 'inv')});
  const imageBase = stateOf(${sampleEntity(model, child, ctx, 'invimg')});
${tests.join('\n')}
}`;
}
