// Las sondas de la GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) para
// db-check y doc-check: los vectores de keel-core/test/helpers/entity-check-designs.js (INVARIANT_VECTORS), con los ids
// IC-* y CP-* que ejecutan también el invariant-check de keel-spring y las sondas de keel-nest y keel-dotnet sobre el
// MISMO sujeto.
//
// Una prueba por vector, con el caso en el nombre (`TestInvariants_IC3_2_Rechaza`), en un archivo aparte del paquete del
// almacén (`invariant_probe_test.go`), como las del historial. Cada vector se construye con `Rehydrate` (el estado que
// sea, también uno que ningún método de negocio dejaría) y se guarda por el ADAPTADOR emitido: lo que se mide es el Save
// que emite build y la EnsureInvariants() que llama. Las etiquetas importan para el falsado (cada sabotaje cae en
// exactamente sus casos): solo IC-10 mira la fila después de un rechazo, solo CP-5 lee la columna (o el campo)
// persistida, y CP-1 a CP-3 leen el derivado de lo que devuelve el Save.
//
// El sujeto solo ejecuta sus vectores (db-check y doc-check le pasan `-test.run`): la muestra de los demás bloques no
// cumple sus checks a propósito (los vectores parten de ella), y lo demás de catalog-extended ya lo mide su propio sujeto.

import { INVARIANT_SABOTAGES } from '@keel-system/keel-core/gen/entity-checks';
import { COMPUTED_SABOTAGES } from '@keel-system/keel-core/gen/computed';
import { snakeCase } from '@keel-system/keel-core/gen';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { INVARIANT_VECTORS } from '../../../keel-core/test/helpers/entity-check-designs.js';
import { enumConstant, goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { sqlDialect, storeDir } from '../../src/lib/relational-engine.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { repositoryArgs } from '../../src/scaffold/repositories.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';

/** La raíz del sujeto sobre la que están escritos los vectores. */
export const SUBJECT_ROOT = 'Product';

/** El `-test.run` con el que db-check y doc-check ejecutan solo los vectores en el sujeto. */
export const INVARIANT_RUN = '^TestInvariants_';

const DOMAIN = /^internal\/domain\/\w+\.go$/;
const ADAPTER = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+_repository\.go$/;
const EXPECT = /_(IC|CP)\d+_/;

// Las columnas (y claves) de los derivados del sujeto: los que los vectores esperan recalculados.
const DERIVED_COLUMNS = [...new Set(INVARIANT_VECTORS.flatMap((vector) => Object.keys(vector.derived ?? {})))].map(snakeCase);

/** Aplica `edit` a cada `if` de un check (el renglón que sigue a `// check N:`). */
const onCheckLines = (edit) => (content) => content.replace(/(\t\/\/ check \d+:[^\n]*\n)(\tif [^\n]*\{)/g, (_, comment, line) => comment + edit(line));

/** Cada sabotaje, con la forma de db-sabotages.js (`files`, `from`, `to`). Todos compilan: lo que se mide es la sonda. */
const shared = {
  // lte se evalúa como lt (y gte como gt): la comparación rota de esos dos gana la igualdad.
  'ic-boundary': { files: DOMAIN, from: /[\s\S]+/, to: onCheckLines((line) => line.replace(/ ([<>]) (?!=)/g, ' $1= ')) },
  // Una comparación con un operando ausente se rompe (solo en los checks que comparan).
  'ic-null-fails': {
    files: DOMAIN,
    from: /[\s\S]+/,
    to: onCheckLines((line) => (/(Cmp|Compare)\(/.test(line) ? line.replace(/(\S+) != nil && /g, '$1 == nil || ') : line))
  },
  // Solo el nulo cuenta como ausente: un texto vacío está presente.
  'ic-absent-null-only': { files: DOMAIN, from: /[\s\S]+/, to: onCheckLines((line) => line.replace(/ && \*?[\w.]+ != ""/g, '').replace(/ \|\| \*?[\w.]+ == ""/g, '')) },
  // La entidad no hace cumplir sus cotas (el bloque sigue, desactivado: sus imports siguen en uso).
  'ic-no-bounds': {
    files: DOMAIN,
    from: /(\t\/\/ Las cotas de sus campos[^\n]*\n)([\s\S]*?)(?=\t\/\/ Sus checks|\treturn nil\n\})/g,
    to: (_, head, block) => head + block.replace(/^\tif (.*) \{$/gm, '\tif false && ($1) {').replace(/^\t\tif (.*) \{$/gm, '\t\tif false && ($1) {')
  },
  // La guarda no baja a las hijas.
  'ic-children': { files: DOMAIN, from: /\tfor _, child := range \w+\.\w+ \{\n\t\tif err := child\.EnsureInvariants\(\); err != nil \{\n\t\t\treturn err\n\t\t\}\n\t\}\n/g, to: '' },
  // Ignora el error del check.
  'ic-default-code': { files: DOMAIN, from: /return Errorf\((?!ErrInvariantViolated\b|ErrInvalidStateTransition\b)(Err\w+), "/g, to: 'return Errorf(ErrInvariantViolated, "' },
  // El Save no llama a EnsureInvariants().
  'ic-no-call': { files: ADAPTER, from: /\n\t\/\/ La guarda del agregado \(DSL 2\.31\)[^\n]*\n\tif err := \w+\.EnsureInvariants\(\); err != nil \{\n\t\treturn nil, err\n\t\}/g, to: '' },
  // La guarda corre después de escribir, justo antes de cerrar la transacción.
  'ic-after-write': {
    files: ADAPTER,
    from: /\n\t\/\/ La guarda del agregado \(DSL 2\.31\)[^\n]*\n\tif err := (\w+)\.EnsureInvariants\(\); err != nil \{\n\t\treturn nil, err\n\t\}([\s\S]*?)\n\t\treturn nil\n\t\}\)/g,
    to: '$2\n\t\tif err := $1.EnsureInvariants(); err != nil {\n\t\t\treturn err\n\t\t}\n\t\treturn nil\n\t})'
  },
  // Redondea cada línea antes de sumar.
  'cp-round-each': {
    files: DOMAIN,
    from: /total = total\.Add\(line\)(\n[\s\S]*?total = total\.Rescale\((\d+), wire\.RoundHalfUp\))/g,
    to: (_, rest, scale) => `total = total.Add(line.Rescale(${scale}, wire.RoundHalfUp))${rest}`
  },
  // Redondea la mitad al par.
  'cp-half-even': { files: DOMAIN, from: /(total = total\.Rescale\(\d+, )wire\.RoundHalfUp\)/g, to: '$1wire.RoundHalfEven)' },
  // No comprueba que el resultado quepa.
  'cp-no-overflow': { files: DOMAIN, from: 'return total, !exceedsDecimal(total, ', to: 'return total, true || !exceedsDecimal(total, ' }
};

export const INVARIANT_SABOTAGE_SPECS = Object.fromEntries([
  ...Object.entries(shared).map(([id, spec]) => [id, { relational: { ...spec, expect: EXPECT }, document: { ...spec, expect: EXPECT } }]),
  // El Save no escribe el derivado recalculado: el UPDATE conserva lo que la fila tenía (en un alta no hay nada que
  // conservar), y el documento no lleva el campo.
  [
    'cp-stale',
    {
      relational: {
        files: ADAPTER,
        from: new RegExp(`(UPDATE [^"]*?)\\b(${DERIVED_COLUMNS.join('|')}) = (\\$\\d+|\\?)`, 'g'),
        to: (match) => match.replace(new RegExp(`\\b(${DERIVED_COLUMNS.join('|')}) = (\\$\\d+|\\?)$`), '$1 = COALESCE($1, $2)'),
        expect: EXPECT
      },
      document: {
        files: ADAPTER,
        from: new RegExp(`\\t+\\{Key: "(?:${DERIVED_COLUMNS.join('|')})", Value: [^\\n]*\\},\\n`, 'g'),
        to: '',
        expect: EXPECT
      }
    }
  ]
]);

const BREAKS = Object.fromEntries([...Object.entries(INVARIANT_SABOTAGES), ...Object.entries(COMPUTED_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isInvariantSabotage = (id) => Boolean(INVARIANT_SABOTAGE_SPECS[id]);

/** Los sujetos por almacén: los de entity-check-designs.js. */
export const INVARIANT_SUBJECTS = { relational: ['catalog-invariants'], document: ['catalog-invariants-mongo'] };

/** La raíz del sujeto si este modelo es el de los vectores (sus checks y su derivado), o null. */
export function invariantSubject(model) {
  const root = (model.entities ?? []).find((entity) => entity.name === SUBJECT_ROOT);
  return root && (root.checks ?? []).length > 0 && root.fields.some((field) => field.computedSpec) ? root : null;
}

/** Los casos que ejecuta el bloque de este diseño, en el orden de los vectores (los mismos que los otros tres). */
export function invariantCases(model) {
  return invariantSubject(model) ? [...new Set(INVARIANT_VECTORS.map((vector) => vector.case))] : [];
}

/**
 * Lo que enmascara cada rama, con su motivo medido (lo mismo que los otros tres): el Save es transaccional en los dos
 * modelos, así que la fila que la guarda rechaza después de escribirla se revierte (IC-10 no ve ic-after-write); y
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
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_(IC|CP)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want, masked };
}

// ─── El archivo de la sonda ──────────────────────────────────────────────────────────────────────

// La primera muestra del sujeto: lejos de las de las otras sondas (las del historial empiezan en 950).
const SAMPLE_BASE = 1300;

/** Un valor del vector (con los nombres del diseño) como expresión Go del tipo del campo emitido. */
function valueExpr(field, optional, value) {
  if (value === null || value === undefined) return 'nil';
  let expr;
  if (field.kind === 'enum') expr = `domain.${enumConstant(field.namedType, String(value))}`;
  else {
    switch (field.goType) {
      case 'wire.Decimal': expr = `wire.MustDecimal(${goString(String(value))})`; break;
      case 'time.Time': expr = `must(time.Parse(time.RFC3339, ${goString(value)}))`; break;
      case 'jsontext.Value': expr = `jsontext.Value(${goString(JSON.stringify(value))})`; break;
      case 'int32': expr = optional ? `int32(${value})` : String(value); break;
      case 'int64': expr = optional ? `int64(${value})` : String(value); break;
      case 'bool': expr = value ? 'true' : 'false'; break;
      default: expr = goString(value);
    }
  }
  return optional ? `ptr(${expr})` : expr;
}

/** `invariant_probe_test.go` en el paquete del almacén, o null si el modelo no es el del sujeto. */
export function invariantProbeFile(model) {
  const root = invariantSubject(model);
  if (!root) return null;
  const document = model.persistenceKind === 'document';
  const relation = root.relations.find((candidate) => candidate.internal && candidate.cardinality === 'one-to-many');
  const child = model.entities.find((entity) => entity.name === relation.entity);
  const rootMembers = domainMembers(model, root);
  const childMembers = domainMembers(model, child);
  const id = goExported(root.idField?.name ?? 'id');
  const childId = goExported(child.idField?.name ?? 'id');
  const derived = root.fields.filter((field) => field.computedSpec);
  const name = root.name;
  const relationField = goExported(relation.name);

  /** Las asignaciones del vector sobre `variable` (un `<E>State` de muestra), con los nombres del diseño. */
  const assign = (members, variable, values, skip = []) =>
    Object.entries(values)
      .filter(([field]) => !skip.includes(field))
      .map(([field, value]) => {
        const member = members.find((candidate) => candidate.name === field && candidate.kind === 'field');
        return member ? `\t${variable}.${goExported(field)} = ${valueExpr(member.field, member.optional, value)}` : null;
      })
      .filter(Boolean);

  let salt = SAMPLE_BASE;
  let sku = 0;
  /** Las líneas que construyen el estado `variable` del vector; las imágenes, con los ids de `imageIds` si los hay. */
  const build = (variable, state, { imageIds = null } = {}) => {
    const values = { ...state };
    // La clave natural, distinta en cada vector: la sonda comparte la base con las demás y no vacía la tabla.
    if (values.sku === 'ACME-1') values.sku = `ACME-${9000 + ++sku}`;
    const images = values[relation.name] ?? [];
    const lines = [`\t${variable} := sample${name}(t, ${salt++})`, ...assign(rootMembers, variable, values, [relation.name])];
    const children = images.map((image, at) => {
      const local = `${variable}Image${at}`;
      return [
        `\t${local} := sample${child.name}(t, ${salt++})`,
        ...(imageIds ? [`\t${local}.${childId} = ${imageIds[at]}`] : []),
        ...assign(childMembers, local, image)
      ];
    });
    lines.push(...children.flat());
    lines.push(`\t${variable}.${relationField} = []*domain.${child.name}{${images.map((_, at) => `domain.Rehydrate${child.name}(${variable}Image${at})`).join(', ')}}`);
    return lines;
  };
  const repo = `inv${name}Repo()`;
  const derivedAssert = (expr, field, value) =>
    field.goType === 'wire.Decimal'
      ? [`\tif got := ${expr}; got == nil || got.String() != ${goString(String(value))} {`, `\t\tt.Errorf("${field.name}: %v; quiero ${value}", got)`, '\t}']
      : [`\tif got := ${expr}; got == nil || *got != ${value} {`, `\t\tt.Errorf("${field.name}: %v; quiero ${value}", got)`, '\t}'];
  const derivedOf = (fieldName) => derived.find((field) => field.name === fieldName);

  const counts = new Map();
  const tests = INVARIANT_VECTORS.map((vector) => {
    const n = (counts.get(vector.case) ?? 0) + 1;
    counts.set(vector.case, n);
    const testName = `TestInvariants_${vector.case.replace('-', '')}_${n}_${vector.expect ? 'Rechaza' : 'Guarda'}`;
    let body;
    if (vector.case === 'IC-10') {
      // Una fila válida que ya existía; el rechazo no tiene que tocarla.
      const draft = { ...vector.state, status: 'draft', publishedAt: null, retiredAt: null, attributes: null };
      body = [
        ...build('valida', draft),
        `\tstored, err := ${repo}.Save(ctx, domain.Rehydrate${name}(valida))`,
        '\tif err != nil {',
        '\t\tt.Fatalf("guardar la fila válida: %v", err)',
        '\t}',
        ...build('rota', vector.state),
        `\trota.${id} = valida.${id}`,
        `\trota.LockVersion = stored.LockVersion()`,
        `\t_, err = ${repo}.Save(ctx, domain.Rehydrate${name}(rota))`,
        `\tif code := invCode(err); code != ${goString(vector.expect)} {`,
        `\t\tt.Fatalf("el Save respondió %q (%v); quiero ${vector.expect}", code, err)`,
        '\t}',
        `\tafter, found, err := ${repo}.FindByID(ctx, valida.${id})`,
        '\tif err != nil || !found {',
        '\t\tt.Fatalf("releer la fila: %v (encontrada: %v)", err, found)',
        '\t}',
        '\tif after.Status() != stored.Status() || *after.LockVersion() != *stored.LockVersion() {',
        '\t\tt.Errorf("el rechazo escribió: estado %v versión %v; quiero %v y %v", after.Status(), *after.LockVersion(), stored.Status(), *stored.LockVersion())',
        '\t}'
      ];
    } else if (vector.case === 'CP-5') {
      // Guardado antes con una imagen más: lo que queda en la columna tiene que ser el derivado de lo que hay AHORA.
      const kept = vector.state[relation.name];
      const extra = { ...kept[0], storageKey: 'img-extra.png', position: kept.length + 1 };
      const ids = kept.map((_, at) => `imageID${at}`);
      body = [
        ...ids.map((local) => `\t${local} := uuid.Must(uuid.NewV7())`),
        ...build('antes', { ...vector.state, [relation.name]: [...kept, extra] }, { imageIds: [...ids, 'uuid.Must(uuid.NewV7())'] }),
        `\tstored, err := ${repo}.Save(ctx, domain.Rehydrate${name}(antes))`,
        '\tif err != nil {',
        '\t\tt.Fatalf("guardar con la imagen de más: %v", err)',
        '\t}',
        ...build('ahora', vector.state, { imageIds: ids }),
        `\tahora.${id} = antes.${id}`,
        '\tahora.Sku = antes.Sku',
        `\tahora.LockVersion = stored.LockVersion()`,
        `\tif _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(ahora)); err != nil {`,
        '\t\tt.Fatalf("guardar sin ella: %v", err)',
        '\t}',
        ...Object.entries(vector.derived).flatMap(([field, value]) => [
          `\tif got := invRaw(t, antes.${id}, ${goString(derivedKey(model, root, derivedOf(field)))}); got != ${goString(String(value))} {`,
          `\t\tt.Errorf("${field} persistido: %s; quiero ${value}", got)`,
          '\t}'
        ])
      ];
    } else if (vector.expect) {
      body = [
        ...build('estado', vector.state),
        `\t_, err := ${repo}.Save(ctx, domain.Rehydrate${name}(estado))`,
        `\tif code := invCode(err); code != ${goString(vector.expect)} {`,
        `\t\tt.Fatalf("el Save respondió %q (%v); quiero ${vector.expect}", code, err)`,
        '\t}'
      ];
    } else {
      body = [
        ...build('estado', vector.state),
        `\tsaved, err := ${repo}.Save(ctx, domain.Rehydrate${name}(estado))`,
        '\tif err != nil || saved == nil {',
        '\t\tt.Fatalf("el Save rechazó un estado válido: %v", err)',
        '\t}',
        ...Object.entries(vector.derived ?? {}).flatMap(([field, value]) => derivedAssert(`saved.${goExported(field)}()`, derivedOf(field), value))
      ];
    }
    return `// ${testName}: ${vector.case}, ${vector.title}${vector.expect ? ` → ${vector.expect}` : ''}.
func ${testName}(t *testing.T) {
	ctx := t.Context()
${body.join('\n')}
}`;
  });

  const helpers = [
    `// inv${name}Repo es el adaptador de ${name} de la sonda.
func inv${name}Repo() *${name}Repository {
	return New${name}Repository(${repositoryArgs(model, root, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})
}`,
    `// invCode es el code del error de dominio, o "" si no lo es (o no hay error).
func invCode(err error) string {
	var failure *domain.Error
	if errors.As(err, &failure) {
		return failure.Code()
	}
	return ""
}`,
    rawHelper(model, root, document)
  ];
  const imports = [
    'encoding/json/jsontext',
    'errors',
    'fmt',
    'testing',
    'time',
    'github.com/google/uuid',
    ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : ['database/sql']),
    'internal/domain',
    'internal/platform/wire'
  ];
  const body = `
// La sonda de la guarda del agregado (scripts/lib/invariant-probes.js de keel-go): IC-1 a IC-11 y CP-1 a CP-5 contra la
// entidad y el adaptador emitidos. No es parte del proyecto generado.

${helpers.join('\n\n')}

${tests.join('\n\n')}
`;
  const dir = storeDir(model);
  return { path: `${dir}/invariant_probe_test.go`, content: goFile({ pkg: dir.split('/').pop(), imports, body, module: model.service.goModule, generated: false }) };
}

/** `invRaw(t, id, columna)`: lo que la base guarda en la columna (o la clave) de la raíz, como texto. */
function rawHelper(model, root, document) {
  const idType = root.idField?.goType ?? 'uuid.UUID';
  if (document) {
    return `// invRaw es lo que el documento de id guarda en key, como texto ("<ausente>" si no la lleva).
func invRaw(t *testing.T, id ${idType}, key string) string {
	t.Helper()
	raw, err := must(probeTx.collection(${goString(root.collectionName)})).FindOne(t.Context(), bson.D{{Key: "_id", Value: ${idType === 'uuid.UUID' ? 'uuidValue(id)' : 'id'}}}).Raw()
	if err != nil {
		t.Fatal(err)
	}
	value, err := raw.LookupErr(key)
	if err != nil {
		return "<ausente>"
	}
	switch value.Type {
	case bson.TypeDecimal128:
		return value.Decimal128().String()
	case bson.TypeInt32:
		return fmt.Sprint(value.Int32())
	case bson.TypeInt64:
		return fmt.Sprint(value.Int64())
	}
	return value.String()
}`;
  }
  const d = sqlDialect(model);
  const raw = d.mysql && idType === 'uuid.UUID' ? 'id[:]' : 'id';
  return `// invRaw es lo que la fila de id guarda en column, como texto.
func invRaw(t *testing.T, id ${idType}, column string) string {
	t.Helper()
	var value sql.NullString
	query := "SELECT " + column + " FROM ${root.tableName} WHERE ${root.idField?.columns?.name ?? 'id'} = ${d.param(1)}"
	if err := probeDB.QueryRowContext(t.Context(), query, ${raw}).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if !value.Valid {
		return "<null>"
	}
	return fmt.Sprint(value.String)
}`;
}

/** La columna de un derivado de la raíz en la fila, y la clave en el documento. */
function derivedKey(model, root, field) {
  if (model.persistenceKind === 'document') return documentShape(model, root).find((entry) => entry.field?.name === field.name)?.name ?? snakeCase(field.name);
  return field.columns?.name ?? snakeCase(field.name);
}
