// Las SONDAS de `db-check`: una prueba Go por sujeto, escrita a partir del modelo, que EJECUTA los adaptadores que emite
// keel-go contra un PostgreSQL real. Es Go de verdad compilado contra lo emitido (prueba INTERNA del paquete
// `internal/infrastructure/postgres`, así que ve también `translate`, `openTx` y los rangos de enum), no una plantilla
// del proyecto generado: el agente nunca la ve.
//
// El arranque es el del servicio: `Open` con unas `Settings` y `Migrate` con las migraciones embebidas (goose al
// arrancar, el mismo camino que `run`). Después, por raíz de agregado:
//
//   ida y vuelta  Save de un agregado nuevo (value objects, decimales con su escala, enteros de 64 bits, fechas, json,
//                 enums, listas y entidades hijas) y FindByID lo devuelve igual, campo a campo; la versión nace en 0;
//   crudo         la fila guarda el enum por su CONSTANTE;
//   versión       guardar dos veces la MISMA lectura: la segunda es el 409 de concurrencia del contrato;
//   unicidad      otro agregado con la misma clave natural (también en MAYÚSCULAS si la clave se pliega) o en el mismo
//                 estado de un índice condicionado sale con el code y el mensaje de keel-core/gen/constraint-errors.js;
//   cota          un texto más largo que su columna lo rechaza el MOTOR (22001);
//   fusión        guardar otra vez el agregado con una hija quitada, otra cambiada y una nueva, y sus listas en otro
//                 orden: lo releído es exactamente lo guardado;
//   lecturas      la página y el borrado, la lectura por lote por id, los finders por clave (también plegados), el
//                 lote por clave natural, las inversas y el orden por la sombra de rango de un enum.
//
// Por sujeto, la TRANSACCIÓN: un interbloqueo real entre dos transacciones se repite hasta que las dos terminan, un
// conflicto que agota sus intentos sale como el 409 de concurrencia y una sentencia que pasa del tope, como el 503.
//
// Las muestras respetan las cotas y los patrones del diseño (el texto de un patrón lo da `sampleFor`, el mismo de las
// sondas de keel-nest y keel-dotnet), y cada número de muestra da valores distintos: dos muestras no comparten clave.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { constraintErrors, declaredConcurrencyError, indexName, keyShadow, partialUniqueIndexes } from '@keel-system/keel-core/gen';
import { inverseFindersOf } from '@keel-system/keel-core/gen/inverse-collections';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { isPaginated, repositoryRoots } from '@keel-system/keel-core/gen/features';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { sampleFor } from '../../../keel-nest/scripts/lib/samples.js';
import { enumConstant, goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { keyFinders, naturalKeyBatchFinder } from '../../src/scaffold/repositories.js';
import { finderProbes } from './finder-probes.js';

/** La ruta de la sonda dentro del proyecto del sujeto. */
export const PROBE_FILE = 'internal/infrastructure/postgres/db_probe_test.go';

// Los números de muestra que no usa ninguna prueba: los agregados que se guardan para que una FK apunte a algo real.
const ENSURE_BASE = 500;
// Cuántas muestras distintas de un patrón se precalculan: tienen que bastar para las pruebas y para los `ensure`.
const PATTERN_SAMPLES = 900;

const IMPORTS = [
  'context',
  'database/sql',
  'encoding/json/jsontext',
  'errors',
  'fmt',
  'log/slog',
  'os',
  'reflect',
  'slices',
  'strings',
  'sync',
  'sync/atomic',
  'testing',
  'time',
  'unicode',
  'unicode/utf8',
  'github.com/google/uuid',
  'github.com/jackc/pgx/v5/pgconn',
  'internal/application',
  'internal/domain',
  'internal/platform/wire'
];

/** La sonda del sujeto: `{ path, content }`. */
export function probeFile(model) {
  const ctx = { patterns: new Map(), unsampled: [] };
  const entities = model.entities.filter((entity) => entity.persisted !== false);
  const roots = repositoryRoots(model);
  const parts = [PRELUDE];
  // Las muestras de toda entidad que se guarda (raíces e hijas, transitivas).
  const sampled = new Set();
  const visit = (entity) => {
    if (sampled.has(entity.name)) return;
    sampled.add(entity.name);
    parts.push(sampleFunction(model, entity, ctx), dumpFunction(model, entity));
    for (const member of domainMembers(model, entity)) {
      if (member.kind === 'relationMany') visit(model.entities.find((candidate) => candidate.name === member.relation.entity));
    }
  };
  for (const root of roots) visit(root);
  for (const vo of usedValueObjects(model, [...sampled])) parts.push(dumpValueObject(model, vo));
  for (const root of roots) parts.push(ensureFunction(root));
  for (const root of roots) parts.push(...rootProbes(model, root));
  if (roots.length > 0) parts.push(transactionProbes(model, roots[0]));
  parts.push(patternTables(ctx));
  if (entities.length === 0) return null;
  const content = goFile({ pkg: 'postgres', imports: IMPORTS, body: `\n${parts.filter(Boolean).join('\n\n')}\n`, module: model.service.goModule, generated: false });
  return { path: PROBE_FILE, content, unsampled: ctx.unsampled };
}

const PRELUDE = `// La sonda de db-check (scripts/lib/db-probes.js de keel-go): ejecuta los adaptadores emitidos contra un PostgreSQL
// real. No es parte del proyecto generado.

var (
	probeDB  *sql.DB
	probeTx  *Transactions
	probeSeq atomic.Int64
)

func TestMain(m *testing.M) {
	os.Exit(runProbes(m))
}

// runProbes abre la base como el servicio (Open + Migrate, con goose) y ejecuta las sondas.
func runProbes(m *testing.M) int {
	ctx := context.Background()
	settings := Settings{
		Enabled:            true,
		URL:                os.Getenv("DB_CHECK_URL"),
		Username:           os.Getenv("DB_CHECK_USER"),
		Password:           os.Getenv("DB_CHECK_PASSWORD"),
		PoolName:           "db-check",
		MaxSize:            8,
		ConnectionTimeout:  10 * time.Second,
		MaxLifetime:        time.Minute,
		TransactionTimeout: 5 * time.Second,
	}
	db, err := Open(ctx, settings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "abrir la base:", err)
		return 2
	}
	defer db.Close()
	logger := slog.New(slog.DiscardHandler)
	if err := Migrate(ctx, db, logger); err != nil {
		fmt.Fprintln(os.Stderr, "migrar:", err)
		return 2
	}
	probeDB = db
	probeTx = NewTransactions(db, settings.TransactionTimeout, logger)
	return m.Run()
}

func nextID() int64 { return 1_000_000 + probeSeq.Add(1) }

func ptr[T any](v T) *T { return &v }

// deref es el valor de p, o falla la prueba si la muestra no lo tiene.
func deref[T any](t *testing.T, p *T) T {
	t.Helper()
	if p == nil {
		t.Fatal("la muestra no tiene el valor que se filtra")
	}
	return *p
}

// other es un valor de all distinto de v (o v si no hay otro).
func other[T comparable](v T, all ...T) T {
	for _, candidate := range all {
		if candidate != v {
			return candidate
		}
	}
	return v
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// text es un texto de muestra distinto por n, dentro de sus cotas.
func text(base string, n, minLen, maxLen int) string {
	s := fmt.Sprintf("%s-%d", base, n)
	if r := []rune(s); len(r) > maxLen {
		s = string(r[len(r)-maxLen:])
	}
	for utf8.RuneCountInString(s) < minLen {
		s += "x"
	}
	return s
}

// pick es la muestra n de un patrón.
func pick(samples []string, n int) string {
	return samples[n%len(samples)]
}

// flipCase cambia la caja de cada letra: la misma clave escrita de otra forma.
func flipCase(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsUpper(r) {
			return unicode.ToLower(r)
		}
		return unicode.ToUpper(r)
	}, s)
}

// show es un valor del dominio como texto comparable: un decimal con su escala, un instante en UTC.
func show(v any) string {
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return "nil"
		}
		v = rv.Elem().Interface()
	}
	switch x := v.(type) {
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	case jsontext.Value:
		return string(x)
	case fmt.Stringer:
		return x.String()
	}
	return fmt.Sprintf("%#v", v)
}

// domainError es el *domain.Error de err, o falla la prueba.
func domainError(t *testing.T, err error) *domain.Error {
	t.Helper()
	var de *domain.Error
	if !errors.As(err, &de) {
		t.Fatalf("se esperaba un error del contrato, llegó %v", err)
	}
	return de
}

// engineCode es el SQLSTATE del motor en err, o "".
func engineCode(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}`;

// ─── Las muestras ────────────────────────────────────────────────────────────────────────────────

/** Las muestras de un patrón como tabla Go, una vez por patrón. */
function patternTable(ctx, pattern, min, max) {
  const key = `${pattern}\u0000${min}\u0000${max}`;
  if (!ctx.patterns.has(key)) {
    const seen = new Set();
    for (let variant = 0; variant < PATTERN_SAMPLES * 3 && seen.size < PATTERN_SAMPLES; variant++) {
      // Las variantes de sampleFor salen de UN carácter (26): pasada la vigésimo sexta, la muestra se alarga.
      const base = sampleFor(pattern, min, max, variant);
      const longer = variant >= 26 && base != null ? sampleFor(pattern, base.length + Math.floor(variant / 26), max, variant) : null;
      for (const candidate of [longer, base]) {
        if (candidate != null && matches(pattern, candidate) && (max == null || [...candidate].length <= max) && [...candidate].length >= min) {
          seen.add(candidate);
          break;
        }
      }
    }
    ctx.patterns.set(key, { name: `pattern${ctx.patterns.size + 1}`, values: [...seen] });
  }
  return ctx.patterns.get(key);
}

function matches(pattern, sample) {
  try {
    return new RegExp(pattern).test(sample);
  } catch {
    return false;
  }
}

function patternTables(ctx) {
  if (ctx.patterns.size === 0) return null;
  return [...ctx.patterns.values()]
    .map((table) => `var ${table.name} = []string{\n${table.values.map((value) => `\t${goString(value)},`).join('\n')}\n}`)
    .join('\n\n');
}

/** La expresión Go de una muestra de un campo (sin puntero ni lista), distinta por `n` (una expresión Go entera). */
function sampleExpr(model, field, ctx, n) {
  if (field.kind === 'enum') return `domain.${enumConstant(field.namedType, chosenEnumValue(model, field).literal)}`;
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    const args = vo.fields.map((sub) => {
      const value = sub.list ? listExpr(model, sub, ctx, n) : sampleExpr(model, sub, ctx, n);
      return sub.list || !isOptionalField(sub) ? value : `ptr(${value})`;
    });
    return `must(domain.New${vo.name}(${args.join(', ')}))`;
  }
  const text = field.text ?? {};
  const numeric = field.numeric ?? {};
  switch (field.goType) {
    case 'uuid.UUID':
      return 'uuid.Must(uuid.NewV7())';
    case 'int32': {
      const min = numeric.min != null ? Number(numeric.min) : 7;
      const max = numeric.max != null ? Number(numeric.max) : null;
      return max != null ? `int32(${min} + (${n})%${Math.max(1, max - min + 1)})` : `int32(${min} + ${n})`;
    }
    case 'int64':
      return `int64(9007199254740993 + ${n})`;
    case 'wire.Decimal': {
      const scale = numeric.scale ?? 2;
      let whole = numeric.min != null && Number(numeric.min) > 12 ? Math.ceil(Number(numeric.min)) : 12;
      if (numeric.max != null && whole > Number(numeric.max)) whole = Math.max(0, Math.floor(Number(numeric.max)) - 1);
      // Con ceros a la derecha a propósito: la escala es lo que se pierde por el camino.
      return `wire.MustDecimal(${goString(scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : String(whole))})`;
    }
    case 'bool':
      return 'true';
    case 'wire.Date':
      return 'wire.MustDate("2026-03-14")';
    case 'time.Time':
      return 'time.Date(2026, 3, 14, 9, 21, 7, 482000000, time.UTC)';
    case 'jsontext.Value':
      return 'jsontext.Value(`{"a":[1,2.50]}`)';
    case 'string': {
      const min = text.minLength ?? 0;
      const max = text.maxLength ?? field.columns?.length ?? 40;
      if (text.pattern) {
        const table = patternTable(ctx, text.pattern, min, text.maxLength ?? null);
        if (table.values.length === 0) {
          ctx.unsampled.push(`${field.name} (${text.pattern})`);
          return goString('');
        }
        return `pick(${table.name}, ${n})`;
      }
      return `text(${goString(field.name)}, ${n}, ${min}, ${max})`;
    }
    default:
      throw new Error(`db-probes: no sé muestrear ${field.name} (${field.goType})`);
  }
}

/** Una lista de dos muestras en orden DESCENDENTE: si el adaptador ordenara por valor y no por posición, se ve. */
function listExpr(model, field, ctx, n) {
  const element = { ...field, list: false, goType: field.goType.replace(/^\[\]/, '') };
  const type = element.kind === 'enum' || element.kind === 'composite' ? `domain.${element.goType}` : element.goType;
  return `[]${type}{${sampleExpr(model, element, ctx, `2*(${n})+1`)}, ${sampleExpr(model, element, ctx, `2*(${n})`)}}`;
}

function isOptionalField(field) {
  return !(field.required || field.isId || field.generated || field.list);
}

/** El valor de enum de las muestras: el segundo si hay más de uno (el primero suele ser el inicial). */
function chosenEnumValue(model, field) {
  const enumDef = model.enums.find((candidate) => candidate.name === field.namedType);
  return enumDef.values[enumDef.values.length > 1 ? 1 : 0];
}

function idExpr(field) {
  if (!field || field.goType === 'uuid.UUID') return 'uuid.Must(uuid.NewV7())';
  if (field.goType === 'int64') return 'nextID()';
  if (field.goType === 'int32') return 'int32(nextID())';
  return 'fmt.Sprintf("id-%09d", nextID())';
}

/** `sample<E>(t, n)`: el estado de muestra n de una entidad, con sus hijas y apuntando a raíces guardadas. */
function sampleFunction(model, entity, ctx) {
  const lines = [];
  for (const member of domainMembers(model, entity)) {
    const method = goExported(member.name);
    let value;
    if (member.kind === 'externalRef') {
      // Toda referencia a OTRA raíz apunta a una guardada de verdad (su FK existe). La autorreferencia, a nil.
      const target = member.relation.entity;
      if (target === entity.name) {
        if (member.relation.required) throw new Error(`db-probes: ${entity.name}.${member.name} es una autorreferencia obligatoria`);
        continue;
      }
      value = member.relation.required ? `ensure${target}(t)` : `ptr(ensure${target}(t))`;
    } else if (member.kind === 'relationMany') {
      const child = member.relation.entity;
      value = `[]*domain.${child}{domain.Rehydrate${child}(sample${child}(t, 10*(n)+1)), domain.Rehydrate${child}(sample${child}(t, 10*(n)+2))}`;
    } else if (member.kind === 'relationOne') {
      continue;
    } else if (member.declaredLock) {
      continue;
    } else if (member.field.list) {
      value = listExpr(model, member.field, ctx, 'n');
    } else if (member.field.isId) {
      value = idExpr(member.field);
    } else {
      const expr = sampleExpr(model, member.field, ctx, 'n');
      value = member.optional ? `ptr(${expr})` : expr;
    }
    lines.push(`\t\t${method}: ${value},`);
  }
  return `// sample${entity.name} es el estado de muestra n de ${entity.name}.
func sample${entity.name}(t *testing.T, n int) domain.${entity.name}State {
	t.Helper()
	return domain.${entity.name}State{
${lines.join('\n')}
	}
}`;
}

/** `dump<E>(e)`: el agregado como texto, campo a campo y con sus hijas: lo que se compara. */
function dumpFunction(model, entity) {
  const lines = [];
  for (const member of domainMembers(model, entity)) {
    const method = goExported(member.name);
    if (member.kind === 'relationMany') {
      lines.push(`\tfor i, child := range e.${method}() {\n\t\tout = append(out, fmt.Sprintf("${method}[%d]{%s}", i, dump${member.relation.entity}(child)))\n\t}`);
    } else if (member.kind === 'relationOne') {
      continue;
    } else if (member.kind === 'field' && member.field.kind === 'composite' && !member.field.list) {
      const vo = member.field.namedType;
      if (member.optional) lines.push(`\tif v := e.${method}(); v != nil {\n\t\tout = append(out, "${method}="+dump${vo}(*v))\n\t} else {\n\t\tout = append(out, "${method}=nil")\n\t}`);
      else lines.push(`\tout = append(out, "${method}="+dump${vo}(e.${method}()))`);
    } else if (member.kind === 'field' && member.field.kind === 'composite') {
      lines.push(`\tfor i, v := range e.${method}() {\n\t\tout = append(out, fmt.Sprintf("${method}[%d]=%s", i, dump${member.field.namedType}(v)))\n\t}`);
    } else if (member.kind === 'field' && member.field.list) {
      lines.push(`\tfor i, v := range e.${method}() {\n\t\tout = append(out, fmt.Sprintf("${method}[%d]=%s", i, show(v)))\n\t}`);
    } else {
      lines.push(`\tout = append(out, "${method}="+show(e.${method}()))`);
    }
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) lines.push('\tout = append(out, "LockVersion="+show(e.LockVersion()))');
  return `// dump${entity.name} es ${entity.name} como texto comparable, campo a campo.
func dump${entity.name}(e *domain.${entity.name}) string {
	var out []string
${lines.join('\n')}
	return strings.Join(out, "; ")
}`;
}

/** Los value objects que aparecen en las entidades muestreadas (y dentro de ellos). */
function usedValueObjects(model, entityNames) {
  const found = new Map();
  const visitField = (field) => {
    if (field.kind !== 'composite' || found.has(field.namedType)) return;
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    found.set(vo.name, vo);
    for (const sub of vo.fields) visitField(sub);
  };
  for (const name of entityNames) for (const field of model.entities.find((e) => e.name === name).fields) visitField(field);
  return [...found.values()];
}

function dumpValueObject(model, vo) {
  const parts = vo.fields.map((sub) => {
    const method = goExported(sub.name);
    if (sub.kind === 'composite' && !sub.list) return `"${method}=" + dump${sub.namedType}(v.${method}())`;
    return `"${method}=" + show(v.${method}())`;
  });
  return `// dump${vo.name} es ${vo.name} como texto comparable.
func dump${vo.name}(v domain.${vo.name}) string {
	return "{" + ${parts.join(' + "," + ')} + "}"
}`;
}

/** `ensure<R>(t)`: guarda una muestra de la raíz y devuelve su id, para las FK que apuntan a ella. */
function ensureFunction(root) {
  const idMethod = goExported(root.idField?.name ?? 'id');
  return `// ensure${root.name} guarda un ${root.name} nuevo y devuelve su id: el destino de una FK.
func ensure${root.name}(t *testing.T) ${root.idField?.goType ?? 'uuid.UUID'} {
	t.Helper()
	saved, err := New${root.name}Repository(probeTx).Save(t.Context(), domain.Rehydrate${root.name}(sample${root.name}(t, ${ENSURE_BASE}+int(probeSeq.Add(1)))))
	if err != nil {
		t.Fatalf("guardar el ${root.name} al que apunta la muestra: %v", err)
	}
	return saved.${idMethod}()
}`;
}

// ─── Las sondas de una raíz ──────────────────────────────────────────────────────────────────────

function concurrencyCode(model) {
  return declaredConcurrencyError(model)?.code ?? FRAMEWORK_ERRORS.concurrency.code;
}

function rootProbes(model, root) {
  const name = root.name;
  const repo = `New${name}Repository(probeTx)`;
  const id = goExported(root.idField?.name ?? 'id');
  const idColumn = root.idField?.columns?.name ?? 'id';
  const versioned = Boolean(root.usesOptimisticLocking);
  const lock = versioned ? 'LockVersion' : null;
  const members = domainMembers(model, root);
  const tests = [];
  // El estado esperado tras guardar una muestra: la versión es la que puso la base.
  const expect = (state, saved) => (lock ? `\t${state}.${lock} = ${saved}.${lock}()\n` : '');

  tests.push(`func Test${name}_RoundTrip(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 1)
	saved, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	read, found, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil || !found {
		t.Fatalf("FindByID: found=%v err=%v", found, err)
	}
${expect('state', 'read')}	if want, got := dump${name}(domain.Rehydrate${name}(state)), dump${name}(read); want != got {
		t.Errorf("lo leído no es lo guardado:\\nguardado %s\\nleído    %s", want, got)
	}
	if a, b := dump${name}(saved), dump${name}(read); a != b {
		t.Errorf("Save no devuelve lo que hay en la base:\\nSave %s\\nbase %s", a, b)
	}${versioned ? `
	if v := read.${lock}(); v == nil || *v != 0 {
		t.Errorf("la versión de un agregado nuevo es %s, no 0", show(v))
	}` : ''}
}`);

  const stored = storedEnum(model, root);
  if (stored) {
    tests.push(`func Test${name}_StoresEnumByConstant(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 2)
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	var stored string
	if err := probeDB.QueryRowContext(ctx, ${goString(`SELECT ${stored.column} FROM ${root.tableName} WHERE ${idColumn} = $1`)}, state.${id}).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != ${goString(stored.constant)} {
		t.Errorf("la columna ${stored.column} guarda %q, no la constante %q", stored, ${goString(stored.constant)})
	}
}`);
  }

  if (versioned) {
    tests.push(`func Test${name}_StaleVersionIsConcurrencyConflict(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 3)
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	read, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ${repo}.Save(ctx, read)
	if err != nil {
		t.Fatalf("el primer guardado de la lectura: %v", err)
	}
	if v := second.${lock}(); v == nil || *v != 1 {
		t.Errorf("tras una actualización la versión es %s, no 1", show(v))
	}
	_, err = ${repo}.Save(ctx, read)
	de := domainError(t, err)
	if de.Code() != ${goString(concurrencyCode(model))} || de.Status() != 409 {
		t.Errorf("la lectura obsoleta sale %q/%d, no ${concurrencyCode(model)}/409", de.Code(), de.Status())
	}
}`);
  }

  tests.push(...clashProbes(model, root, { repo, members }));

  const bounded = boundedText(root);
  if (bounded) {
    const method = goExported(bounded.name);
    const over = `strings.Repeat("x", ${bounded.columns.length + 1})`;
    tests.push(`func Test${name}_EngineRejectsTextOverItsBound(t *testing.T) {
	state := sample${name}(t, 9)
	state.${method} = ${isOptionalField(bounded) ? `ptr(${over})` : over}
	_, err := ${repo}.Save(t.Context(), domain.Rehydrate${name}(state))
	if code := engineCode(err); code != "22001" {
		t.Errorf("un ${bounded.name} de ${bounded.columns.length + 1} caracteres sale %v (SQLSTATE %q), no 22001", err, code)
	}
}`);
  }

  if (isPaginated(model, root)) {
    tests.push(`func Test${name}_PageAndDelete(t *testing.T) {
	ctx := t.Context()
	var ids []${root.idField?.goType ?? 'uuid.UUID'}
	for n := 6; n <= 8; n++ {
		saved, err := ${repo}.Save(ctx, domain.Rehydrate${name}(sample${name}(t, n)))
		if err != nil {
			t.Fatalf("Save: %v", err)
		}
		ids = append(ids, saved.${id}())
	}
	page, err := ${repo}.List(ctx, domain.Pageable{Page: 0, Size: 2})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 2 || page.TotalElements < 3 || page.Number != 0 {
		t.Errorf("la página trae %d de %d (número %d)", len(page.Items), page.TotalElements, page.Number)
	}
	all, err := ${repo}.List(ctx, domain.Pageable{Page: 0, Size: 1000, Sort: []domain.SortOrder{{Property: ${goString(root.idField?.name ?? 'id')}, Direction: domain.SortDesc}}})
	if err != nil {
		t.Fatalf("List por id: %v", err)
	}
	for i := 1; i < len(all.Items); i++ {
		if show(all.Items[i-1].${id}()) == show(all.Items[i].${id}()) {
			t.Errorf("la página repite %s", show(all.Items[i].${id}()))
		}
	}
	if _, err := ${repo}.List(ctx, domain.Pageable{Size: 2, Sort: []domain.SortOrder{{Property: "noSuchProperty"}}}); err == nil {
		t.Error("ordenar por una propiedad que no existe no es un error")
	}
	if err := ${repo}.DeleteByID(ctx, ids[0]); err != nil {
		t.Fatalf("DeleteByID: %v", err)
	}
	if _, found, err := ${repo}.FindByID(ctx, ids[0]); err != nil || found {
		t.Errorf("tras borrar, FindByID: found=%v err=%v", found, err)
	}
}`);
  }

  const merge = mergeProbe(model, root, { repo, id, lock, members });
  if (merge) tests.push(merge);

  if (idBatchReason(model, root)) {
    tests.push(`func Test${name}_FindAllByID(t *testing.T) {
	ctx := t.Context()
	a := sample${name}(t, 30)
	b := sample${name}(t, 31)
	for _, s := range []domain.${name}State{a, b} {
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(s)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	found, err := ${repo}.FindAllByID(ctx, []${root.idField?.goType ?? 'uuid.UUID'}{a.${id}, b.${id}, sample${name}(t, 32).${id}})
	if err != nil {
		t.Fatalf("FindAllByID: %v", err)
	}
	if len(found) != 2 {
		t.Errorf("FindAllByID trae %d agregados, no los 2 guardados", len(found))
	}
}`);
  }

  tests.push(...keyFinderProbes(model, root, { repo, id }));
  tests.push(...inverseProbes(model, root, { repo }));
  tests.push(...rankProbes(model, root, { repo }));
  tests.push(...finderProbes(model, root, { repo, id }));
  return tests;
}

/** El primer enum escalar obligatorio de la raíz: el que se mira en crudo. */
function storedEnum(model, entity) {
  const field = entity.fields.find((candidate) => !candidate.list && candidate.kind === 'enum' && candidate.columns && !candidate.columns.nullable);
  if (!field) return null;
  return { field, column: field.columns.name, constant: chosenEnumValue(model, field).constant };
}

/** El campo de texto acotado con el que se prueba la cota del motor: sin patrón, fuera de toda clave. */
function boundedText(entity) {
  const keys = new Set([...(entity.naturalKey ?? []), ...(entity.indexes ?? []).flatMap((index) => index.fields)]);
  return entity.fields.find(
    (field) =>
      !field.list &&
      !field.isId &&
      field.kind !== 'composite' &&
      field.kind !== 'enum' &&
      field.goType === 'string' &&
      field.columns?.length != null &&
      !field.text?.pattern &&
      !keys.has(field.name) &&
      !keyShadow(field)
  );
}

/**
 * Las unicidades: dos agregados que chocan en `keys`. El segundo copia del primero los miembros de la clave (y en su
 * caso la pliega con otra caja) y el resto lo toma de otra muestra. El choque tiene que salir con el code y el mensaje
 * de keel-core.
 */
function clashProbes(model, root, { repo, members }) {
  const name = root.name;
  const errors = constraintErrors(model);
  const tests = [];
  const memberOf = (key) => members.find((m) => m.name === key || m.relation?.name === key);
  const conditional = partialUniqueIndexes(root).filter((index) => index.when?.field && !index.when.field.includes('.'));
  // El valor de un enum dentro o fuera de la condición de un índice condicionado.
  const enumValue = (fieldName, inside, equals) => {
    const field = root.fields.find((candidate) => candidate.name === fieldName);
    const enumDef = field?.kind === 'enum' ? model.enums.find((e) => e.name === field.namedType) : null;
    const value = enumDef?.values.find((candidate) => (candidate.literal === equals) === inside);
    return value ? `domain.${enumConstant(enumDef.name, value.literal)}` : null;
  };
  const clash = (title, keys, entry, { both = {}, transform = {}, samples = [4, 5] }) => {
    const copies = keys.map((key) => {
      const member = memberOf(key);
      const method = goExported(member.name);
      return `\tclash.${method} = ${transform[member.name] ? transform[member.name](`first.${method}`) : `first.${method}`}`;
    });
    const forced = (target) => Object.entries(both).map(([field, value]) => `\t${target}.${goExported(field)} = ${value}`);
    const different = Object.keys(transform).map((field) => `\tif clash.${goExported(field)} == first.${goExported(field)} {\n\t\tt.Skip("la muestra no cambia al plegarla")\n\t}`);
    tests.push(`func Test${name}_${title}(t *testing.T) {
	ctx := t.Context()
	first := sample${name}(t, ${samples[0]})
${forced('first').join('\n')}
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(first)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	clash := sample${name}(t, ${samples[1]})
${forced('clash').join('\n')}
${copies.join('\n')}
${different.join('\n')}
	_, err := ${repo}.Save(ctx, domain.Rehydrate${name}(clash))
	de := domainError(t, err)
	if de.Code() != ${goString(entry.code ?? '')} || de.Message() != ${goString(entry.message)} {
		t.Errorf("el choque sale %q «%s», no %q «%s»", de.Code(), de.Message(), ${goString(entry.code ?? '')}, ${goString(entry.message)})
	}
}`.replace(/\n\n+/g, '\n'));
  };

  const natural = errors.find((entry) => entry.constraint === `uk_${root.tableName}_natural`);
  if (natural && (root.naturalKey ?? []).length > 0 && root.naturalKey.every((key) => memberOf(key))) {
    // Fuera de toda condición: si no, el choque viola también la unicidad condicionada y el motor nombra esa.
    const outside = {};
    for (const index of conditional) {
      const value = enumValue(index.when.field, false, index.when.equals);
      if (value && !root.naturalKey.includes(index.when.field)) outside[index.when.field] = value;
    }
    clash('NaturalKeyClash', root.naturalKey, natural, { both: outside });
    const folded = root.naturalKey.map((key) => root.fields.find((field) => field.name === key)).filter((field) => field && keyShadow(field));
    if (folded.length > 0) {
      clash('NaturalKeyClashWithOtherCase', root.naturalKey, natural, {
        both: outside,
        transform: Object.fromEntries(folded.map((field) => [field.name, (expr) => `flipCase(${expr})`])),
        samples: [40, 41]
      });
    }
  }
  conditional.slice(0, 3).forEach((index, position) => {
    const entry = errors.find((candidate) => candidate.constraint === indexName(root, index));
    const inside = enumValue(index.when.field, true, index.when.equals);
    if (!entry || !inside || !index.fields.every((key) => memberOf(key))) return;
    clash(`ConditionalUniqueClash${position + 1}`, index.fields, entry, { both: { [index.when.field]: inside }, samples: [10 + position * 2, 11 + position * 2] });
  });
  return tests;
}

/**
 * La FUSIÓN: el agregado guardado se guarda otra vez con una hija quitada, otra cambiada (mismo id, otros valores) y
 * una nueva, y con las listas de otra muestra. Lo releído tiene que ser exactamente lo guardado.
 */
function mergeProbe(model, root, { repo, id, lock, members }) {
  const children = members.filter((member) => member.kind === 'relationMany');
  const lists = members.filter((member) => member.kind === 'field' && member.field.list);
  if (children.length === 0 && lists.length === 0) return null;
  const name = root.name;
  const lines = [];
  for (const child of children) {
    const method = goExported(child.name);
    const childEntity = model.entities.find((candidate) => candidate.name === child.relation.entity);
    const childId = goExported(childEntity.idField?.name ?? 'id');
    lines.push(`\tkept := sample${childEntity.name}(t, 10*21+3)
	kept.${childId} = state.${method}[1].${childId}()
	changed.${method} = []*domain.${childEntity.name}{domain.Rehydrate${childEntity.name}(kept), domain.Rehydrate${childEntity.name}(sample${childEntity.name}(t, 10*21+4))}`);
  }
  return `func Test${name}_SaveMergesChildrenAndLists(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 20)
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	read, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	// Otra muestra con el mismo id: otros valores, otras listas y, de las hijas, la segunda cambiada y una nueva.
	changed := sample${name}(t, 21)
	changed.${id} = state.${id}${lock ? `\n\tchanged.${lock} = read.${lock}()` : ''}
${lines.join('\n')}
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(changed)); err != nil {
		t.Fatalf("Save de la fusión: %v", err)
	}
	again, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}${lock ? `\n\tchanged.${lock} = again.${lock}()` : ''}
	if want, got := dump${name}(domain.Rehydrate${name}(changed)), dump${name}(again); want != got {
		t.Errorf("lo releído no es la fusión guardada:\\nguardado %s\\nleído    %s", want, got)
	}
}`;
}

/** Los finders por clave: con los valores de una muestra guardada la encuentran; plegados, también con otra caja. */
function keyFinderProbes(model, root, { repo, id }) {
  const name = root.name;
  const members = domainMembers(model, root);
  const tests = [];
  keyFinders(model, root).forEach((finder, index) => {
    const args = finder.params.map((param) => {
      const member = members.find((m) => m.name === param.name || m.name === `${param.name}Id` || m.relation?.name === param.name);
      const expr = `state.${goExported(member.name)}`;
      return member.optional ? `*${expr}` : expr;
    });
    const folded = finder.params.findIndex((param) => param.fold);
    const n = 50 + index;
    tests.push(`func Test${name}_${finder.name}(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, ${n})
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	found, ok, err := ${repo}.${finder.name}(ctx, ${args.join(', ')})
	if err != nil || !ok || found.${id}() != state.${id} {
		t.Fatalf("${finder.name} no encuentra la muestra guardada: ok=%v err=%v", ok, err)
	}${folded >= 0 ? `
	if _, ok, err := ${repo}.${finder.name}(ctx, ${args.map((arg, i) => (i === folded ? `flipCase(${arg})` : arg)).join(', ')}); err != nil || !ok {
		t.Errorf("${finder.name} con otra caja no la encuentra: ok=%v err=%v", ok, err)
	}` : ''}
	other := sample${name}(t, ${n + 20})
	if _, ok, err := ${repo}.${finder.name}(ctx, ${args.map((arg) => arg.replace('state.', 'other.')).join(', ')}); err != nil || ok {
		t.Errorf("${finder.name} encuentra una clave que no se guardó: ok=%v err=%v", ok, err)
	}
}`);
  });
  const batch = naturalKeyBatchFinder(model, root);
  if (batch) {
    const method = goExported(batch.param.name);
    tests.push(`func Test${name}_${batch.name}(t *testing.T) {
	ctx := t.Context()
	a := sample${name}(t, 60)
	b := sample${name}(t, 61)
	for _, s := range []domain.${name}State{a, b} {
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(s)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	found, err := ${repo}.${batch.name}(ctx, []${batch.param.type}{a.${method}, b.${method}, sample${name}(t, 62).${method}})
	if err != nil {
		t.Fatalf("${batch.name}: %v", err)
	}
	if len(found) != 2 {
		t.Errorf("${batch.name} trae %d agregados, no los 2 guardados", len(found))
	}
}`);
  }
  return tests;
}

/** Las lecturas por la FK inversa: las filas de un dueño, todas y solo ellas. */
function inverseProbes(model, root, { repo }) {
  const name = root.name;
  return inverseFindersOf(model, name).map((inverse) => {
    const method = goExported(`${inverse.relation}Id`);
    const member = domainMembers(model, root).find((m) => m.kind === 'externalRef' && m.relation.name === inverse.relation);
    const owner = member.optional ? 'ptr(owner)' : 'owner';
    return `func Test${name}_${goExported(inverse.finder)}(t *testing.T) {
	ctx := t.Context()
	owner := ensure${inverse.owner}(t)
	for n := 70; n <= 72; n++ {
		state := sample${name}(t, n)
		if n < 72 {
			state.${method} = ${owner}
		}
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	found, err := ${repo}.${goExported(inverse.finder)}(ctx, owner)
	if err != nil {
		t.Fatalf("${goExported(inverse.finder)}: %v", err)
	}
	if len(found) != 2 {
		t.Errorf("${goExported(inverse.finder)} trae %d filas del dueño, no 2", len(found))
	}
}`;
  });
}

/** El orden por un enum va por su SOMBRA DE RANGO (la posición en la declaración), no por su nombre. */
function rankProbes(model, root, { repo }) {
  if (!isPaginated(model, root)) return [];
  const name = root.name;
  const ranked = persistedMembers(model, root).filter((member) => member.kind === 'scalar' && member.ranked);
  return ranked.map((member) => {
    const field = member.field;
    const enumName = member.ranked.enum ?? field.goType;
    const enumDef = model.enums.find((candidate) => candidate.name === enumName);
    const values = enumDef.values.map((value) => `domain.${enumConstant(enumName, value.literal)}`);
    const method = goExported(field.name);
    const rank = `${enumName[0].toLowerCase()}${enumName.slice(1)}Rank`;
    const assign = isOptionalField(field) ? 'ptr(value)' : 'value';
    const read = isOptionalField(field) ? `*item.${method}()` : `item.${method}()`;
    return `func Test${name}_SortsBy${goExported(member.ranked.name)}(t *testing.T) {
	ctx := t.Context()
	for i, value := range []domain.${enumName}{${[...values].reverse().join(', ')}} {
		state := sample${name}(t, 80+i)
		state.${method} = ${assign}
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	page, err := ${repo}.List(ctx, domain.Pageable{Size: 1000, Sort: []domain.SortOrder{{Property: ${goString(member.ranked.name)}, Direction: domain.SortAsc}}})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	last := int32(-1)
	for _, item := range page.Items {${isOptionalField(field) ? `\n\t\tif item.${method}() == nil {\n\t\t\tcontinue\n\t\t}` : ''}
		if r := ${rank}(${read}); r < last {
			t.Fatalf("el orden por ${member.ranked.name} no sigue la declaración del enum: %s detrás de un rango %d", show(${read}), last)
		} else {
			last = r
		}
	}
}`;
  });
}

// ─── La transacción ──────────────────────────────────────────────────────────────────────────────

/**
 * Sobre la tabla de la primera raíz: un interbloqueo REAL entre dos transacciones (cada una bloquea una fila y espera
 * la del otro) se repite y las dos terminan; un conflicto transitorio que no cesa agota los intentos y sale como el 409;
 * una sentencia que pasa del tope sale como el 503.
 */
function transactionProbes(model, root) {
  const name = root.name;
  const id = goExported(root.idField?.name ?? 'id');
  const idColumn = root.idField?.columns?.name ?? 'id';
  const touch = `UPDATE ${root.tableName} SET ${idColumn} = ${idColumn} WHERE ${idColumn} = $1`;
  return `func TestTransaction_DeadlockIsRetried(t *testing.T) {
	ctx := t.Context()
	repo := New${name}Repository(probeTx)
	a := sample${name}(t, 90)
	b := sample${name}(t, 91)
	for _, s := range []domain.${name}State{a, b} {
		if _, err := repo.Save(ctx, domain.Rehydrate${name}(s)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	var attempts atomic.Int32
	var arrived sync.WaitGroup
	arrived.Add(2)
	cross := func(first, second any) func(context.Context) error {
		var once sync.Once
		return func(ctx context.Context) error {
			attempts.Add(1)
			q := openTx(ctx)
			if _, err := q.ExecContext(ctx, ${goString(touch)}, first); err != nil {
				return err
			}
			// Solo en el primer intento: las dos esperan a tener su fila antes de pedir la del otro.
			once.Do(func() {
				arrived.Done()
				arrived.Wait()
			})
			_, err := q.ExecContext(ctx, ${goString(touch)}, second)
			return err
		}
	}
	results := make(chan error, 2)
	go func() { results <- probeTx.Within(ctx, application.KindCommand, cross(a.${id}, b.${id})) }()
	go func() { results <- probeTx.Within(ctx, application.KindCommand, cross(b.${id}, a.${id})) }()
	for range 2 {
		if err := <-results; err != nil {
			t.Errorf("una de las dos transacciones cruzadas falló: %v", err)
		}
	}
	if n := attempts.Load(); n < 3 {
		t.Errorf("hubo %d intentos: el motor no vio el interbloqueo", n)
	}
}

func TestTransaction_ExhaustedConflictIsConcurrencyError(t *testing.T) {
	var attempts atomic.Int32
	err := probeTx.Within(t.Context(), application.KindCommand, func(context.Context) error {
		attempts.Add(1)
		return &pgconn.PgError{Code: "40001"}
	})
	de := domainError(t, err)
	if de.Code() != ${goString(concurrencyCode(model))} || de.Status() != 409 {
		t.Errorf("el conflicto agotado sale %q/%d, no ${concurrencyCode(model)}/409", de.Code(), de.Status())
	}
	if n := attempts.Load(); n != writeConflictAttempts {
		t.Errorf("hubo %d intentos, no %d", n, writeConflictAttempts)
	}
}

func TestTransaction_StatementOverTimeoutIs503(t *testing.T) {
	short := NewTransactions(probeDB, 300*time.Millisecond, slog.New(slog.DiscardHandler))
	err := short.Within(t.Context(), application.KindCommand, func(ctx context.Context) error {
		_, err := openTx(ctx).ExecContext(ctx, "SELECT pg_sleep(2)")
		return err
	})
	de := domainError(t, err)
	if de.Code() != ${goString(FRAMEWORK_ERRORS.transactionTimeout.code)} || de.Status() != 503 {
		t.Errorf("la sentencia cortada sale %q/%d, no ${FRAMEWORK_ERRORS.transactionTimeout.code}/503", de.Code(), de.Status())
	}
}`;
}
