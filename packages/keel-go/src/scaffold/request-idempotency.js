// La idempotencia de PETICIÓN (`use-cases.<op>.idempotency`): la que evita que reintentar una petición ejecute el caso
// de uso dos veces. Es el mismo mecanismo que el de keel-spring, keel-nest y keel-dotnet, con su misma tabla
// (`@keel-system/keel-core/gen/request-idempotency.js`, `IDEMPOTENCY_RECORD`):
//
//   · build genera TODO lo transversal: el puerto `domain.IdempotencyStore` y los dos conflictos (la carrera y la clave
//     reutilizada) con el `code` de SU operación, la firma canónica de cada mensaje, la clave de la cabecera en el
//     contexto (y el borde HTTP que la pone), y el adaptador del motor sobre `idempotency_record`;
//   · el agente escribe el USO en el handler, guiado por la nota que le deja el stub (services.js).
//
// Lo que en Go toma otra forma:
//   · **La firma no usa reflexión** (PLAN-KEEL-GO.md § 3.4): cada mensaje con registro lleva su `IdempotencySignature()`
//     generada, que escribe sus campos por su nombre del cable y en orden, con un `signer` de forma canónica (cada valor
//     precedido de su longitud, null como marca propia, el decimal sin ceros finales). Lo compuesto (un value object, un
//     DTO anidado) entra por su JSON del cable, que es determinista.
//   · **La clave viaja en el `context.Context`** (`application.WithIdempotencyKey`/`IdempotencyKeyFrom`), no en un
//     AsyncLocal: la pone el borde HTTP y la lee el handler.
//   · **Un conflicto es un valor `error`**: `domain.IdempotencyConflict(scope, key)` y `domain.IdempotencyReuse(scope,
//     key)`, ocurrencias del centinela del code que declara la operación que encabeza el ámbito, o del canónico.
//
// Se adelantó del incremento 10 por lo mismo que en keel-nest y keel-dotnet: un aviso de frontera no frena al agente
// cuando un escenario exige el mecanismo, y el suyo sale con otra tabla y otro algoritmo. La purga de las claves
// caducadas (necesita el reloj) y el gate check-idempotency.sh siguen en el incremento 10.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { idempotencyOutcomeCodes, idempotencyOutcomeCode } from '@keel-system/keel-core/gen';
import { usesApi, usesRelational } from '@keel-system/keel-core/gen/features';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_RECORD,
  registryOperations,
  usesRequestIdempotency as usesRegistryInDesign
} from '@keel-system/keel-core/gen/request-idempotency';
import { goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { MYSQL_DRIVER } from './persistence-runtime.js';
import { componentType, messageComponents } from './services.js';
import { sentinelOf } from './errors.js';
import { applicationPath, domainPath, goTypeName, layout, packageFile } from './render.js';

/** ¿Se genera el registro? Con persistencia relacional (la documental llega en el incremento 12) y alguna operación que lo use. */
export function usesRequestIdempotency(model) {
  return usesRelational(model) && usesRegistryInDesign(model);
}

/** ¿Viaja la clave por la cabecera Idempotency-Key? Solo con `client-key`, y con API. */
export function usesIdempotencyHeader(model) {
  return usesRequestIdempotency(model) && usesApi(model) && registryOperations(model, 'client-key').length > 0;
}

/** ¿Deduplica ESTA operación con el registro? */
export function usesRegistry(model, operation) {
  return usesRequestIdempotency(model) && Boolean(operation.idempotency && operation.idempotency.guard !== 'natural-key');
}

/** El campo de Dependencies y el parámetro del handler. */
export const IDEMPOTENCY_STORE = { field: 'IdempotencyStore', param: 'idempotencyStore', port: 'domain.IdempotencyStore' };

/** Los centinelas canónicos de los dos conflictos, salvo que el diseño declare ese mismo code (entonces ya existe). */
export function idempotencySentinels(model) {
  if (!usesRequestIdempotency(model)) return [];
  const declared = new Set((model.errors ?? []).map((error) => error.code));
  return [
    {
      name: sentinelOf(FRAMEWORK_ERRORS.idempotencyRace.code),
      doc: 'dos peticiones con la misma clave de idempotencia a la vez: la primera aún no ha confirmado, así que no hay respuesta que reproducir. Lo usa la operación que no declara un code propio para este conflicto.',
      ...FRAMEWORK_ERRORS.idempotencyRace
    },
    {
      name: sentinelOf(FRAMEWORK_ERRORS.idempotencyReuse.code),
      doc: 'la misma clave de idempotencia con un contenido distinto. Lo usa la operación que no declara un code propio para este conflicto.',
      ...FRAMEWORK_ERRORS.idempotencyReuse
    }
  ].filter((entry) => !declared.has(entry.code));
}

export function generate(model) {
  if (!usesRequestIdempotency(model)) return [];
  const { application, store } = layout(model);
  // El texto de una parte opcional del ámbito, una vez por paquete y solo si algún ámbito la usa (U1000).
  const scopeText = registryOperations(model).some(
    (operation) => idempotencyMethods(model, operation, '', messageComponents(operation, model), (component) => componentType(operation, component))?.scopeText
  );
  const signer = scopeText ? `${SIGNER}\n${SCOPE_TEXT}\n` : SIGNER;
  const files = [
    { path: domainPath(model, 'idempotency'), content: domainFile(model) },
    { path: applicationPath(model, 'Signer'), content: packageFile(model, application, { imports: ['crypto/sha256', 'encoding/hex', 'errors', 'fmt', 'strconv', 'strings', 'time', 'internal/platform/wire'], body: signer }) },
    { path: `${application.dir}/idempotency_test.go`, content: emittedTest(model) },
    { path: `${store.dir}/idempotency_store.go`, content: storeAdapter(model) }
  ];
  if (usesIdempotencyHeader(model)) files.push({ path: applicationPath(model, 'IdempotencyKey'), content: headerContext(model) });
  return files;
}

// ─── El dominio: el puerto y los dos conflictos ──────────────────────────────────────────────────

/** El constructor de uno de los conflictos, con el code de la operación que encabeza el ámbito. */
function conflictConstructor(model, { name, entry, doc, message }) {
  const declared = idempotencyOutcomeCodes(model, entry).filter((row) => row.declared);
  const canonical = sentinelOf(entry.code);
  if (declared.length === 0) {
    return `// ${name} ${doc} Su code es el CANÓNICO del framework (docs/framework-errors.md): el diseño no declara uno propio.
func ${name}(scope, key string) error {
	return Errorf(${canonical}, ${goString(message)}, scope, key)
}`;
  }
  const cases = declared.map((row) => `\tcase ${goString(row.operation)}:\n\t\tof = ${sentinelOf(row.code)}`).join('\n');
  return `// ${name} ${doc} Su code es el que declara la operación que encabeza scope (${declared.map((row) => row.operation).join(', ')}), o el
// CANÓNICO del framework (docs/framework-errors.md).
func ${name}(scope, key string) error {
	of := ${canonical}
	operation, _, _ := strings.Cut(scope, ":")
	switch operation {
${cases}
	}
	return Errorf(of, ${goString(message)}, scope, key)
}`;
}

function domainFile(model) {
  const body = `
// StoredRequest es lo guardado de la primera ejecución de una petición idempotente.
type StoredRequest struct {
	// Signature es la firma del contenido (IdempotencySignature del mensaje) con la que se usó la clave.
	Signature string
	// ResourceID es el id del recurso resultante, para reconstruir la respuesta; nil si la operación no crea nada.
	ResourceID *string
}

// IdempotencyStore es el registro de peticiones ya atendidas, por clave de idempotencia.
//
// El contrato del diseño no es rechazar la repetición sino REPRODUCIRLA: la segunda llamada con la misma clave y el mismo
// contenido devuelve la respuesta de la primera, sin volver a ejecutar nada. Por eso se guarda el id del recurso
// resultante y la firma del contenido, que distingue el reintento de la clave reutilizada con otro cuerpo
// (IdempotencyReuse).
type IdempotencyStore interface {
	// Find devuelve el registro de key en scope si esa clave ya se usó y no ha caducado. scope es el IdempotencyScope()
	// del mensaje, que build compone desde el diseño; key, la cabecera Idempotency-Key (client-key), la firma del
	// mensaje (payload-hash) o el campo de la clave (payload-field).
	Find(ctx context.Context, scope, key string) (StoredRequest, bool, error)
	// Save registra la primera ejecución DENTRO de la transacción del caso de uso: si el comando revierte, el registro
	// revierte con él. Dos peticiones con la misma clave a la vez chocan en la clave primaria del registro, y la que
	// pierde recibe IdempotencyConflict: no se captura. ttlSeconds es la ventana del diseño (idempotency.ttlSeconds).
	Save(ctx context.Context, scope, key, signature string, resourceID *string, ttlSeconds int) error
}

${conflictConstructor(model, {
  name: 'IdempotencyConflict',
  entry: FRAMEWORK_ERRORS.idempotencyRace,
  doc: 'es la carrera de dos peticiones con la misma clave a la vez. No es el reintento normal —ese\n// encuentra el registro ya confirmado y reproduce la respuesta—: la primera aún no ha confirmado. La transacción de quien\n// pierde revierte entera: de dos peticiones idénticas se ejecutó exactamente una.',
  message: 'Otra petición con la misma clave de idempotencia está en curso: %s/%s'
})}

${conflictConstructor(model, {
  name: 'IdempotencyReuse',
  entry: FRAMEWORK_ERRORS.idempotencyReuse,
  doc: 'es la misma clave con un contenido DISTINTO. El cliente prometió, al mandar la clave, que dos\n// peticiones con ella son la misma; esta no lo es: reproducir la primera respuesta contestaría a otra pregunta, y\n// ejecutarla rompería la promesa.',
  message: 'La clave de idempotencia %s/%s ya se usó con un contenido distinto'
})}
`;
  return packageFile(model, layout(model).domain, { imports: ['context', 'strings'], body });
}

// ─── La aplicación: la firma canónica y la clave en el contexto ──────────────────────────────────

const SIGNER = String.raw`
// signer escribe la forma canónica del contenido de un mensaje, la que firma IdempotencySignature: cada valor precedido
// de su longitud (ningún contenido puede imitar un separador), null como marca propia, el orden de las listas
// conservado, el decimal sin ceros finales (1.50 y 1.5 son el mismo importe) y el instante en UTC. Lo compuesto entra
// por su JSON del cable, que es determinista.
//
// Se compara contra una firma guardada en OTRO despliegue: dos formas de calcularla, o un refactor que cambie una,
// dejarían de deduplicar sin que nada lo delate. Por eso la generan build y este tipo, y no cada handler.
type signer struct {
	text strings.Builder
	err  error
}

// scalar escribe un valor de texto con su longitud delante.
func (s *signer) scalar(value string) {
	s.text.WriteString(strconv.Itoa(len(value)))
	s.text.WriteByte(':')
	s.text.WriteString(value)
}

// null escribe la marca de un valor ausente o nulo.
func (s *signer) null() {
	s.text.WriteByte('~')
}

// mark escribe un delimitador: { } para un mensaje, [ ] para una lista.
func (s *signer) mark(delimiter byte) {
	s.text.WriteByte(delimiter)
}

// decimal escribe un importe sin sus ceros finales: la escala no es contenido.
func (s *signer) decimal(value wire.Decimal) {
	text := value.String()
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	s.scalar(text)
}

// instant escribe un instante en UTC con toda su precisión.
func (s *signer) instant(value time.Time) {
	s.scalar(value.UTC().Format(time.RFC3339Nano))
}

// value escribe un valor compuesto por su JSON del cable.
func (s *signer) value(v any) {
	data, err := wire.Marshal(v)
	if err != nil {
		s.err = errors.Join(s.err, err)
		return
	}
	s.scalar(string(data))
}

// sum es el SHA-256 en hexadecimal de la forma canónica.
func (s *signer) sum() (string, error) {
	if s.err != nil {
		return "", fmt.Errorf("firmar el mensaje: %w", s.err)
	}
	digest := sha256.Sum256([]byte(s.text.String()))
	return hex.EncodeToString(digest[:]), nil
}
`;

function headerContext(model) {
  const body = `
// IdempotencyHeader es la cabecera HTTP de la clave de idempotencia (keySource: client-key).
const IdempotencyHeader = ${goString(IDEMPOTENCY_HEADER)}

// idempotencyKey es la clave de contexto de la clave de idempotencia de la petición.
type idempotencyKey struct{}

// WithIdempotencyKey devuelve ctx con la clave de idempotencia de la petición, recortada. Una clave en blanco no abre
// ninguna. Es transporte, así que no viaja dentro del mensaje: la pone el borde HTTP y la lee el handler.
func WithIdempotencyKey(ctx context.Context, key string) context.Context {
	key = strings.TrimSpace(key)
	if key == "" {
		return ctx
	}
	return context.WithValue(ctx, idempotencyKey{}, key)
}

// IdempotencyKeyFrom es la clave de idempotencia de la petición en curso. La cabecera es OPCIONAL: sin ella (false) la
// operación se ejecuta sin deduplicar —no se rechaza—, salvo que el diseño declare el error que la exige.
func IdempotencyKeyFrom(ctx context.Context) (string, bool) {
	key, ok := ctx.Value(idempotencyKey{}).(string)
	return key, ok
}
`;
  return packageFile(model, layout(model).application, { imports: ['context', 'strings'], body });
}

/**
 * Los métodos que lleva el MENSAJE de una operación con registro: su ámbito y su firma. Los añade services.js al
 * mensaje; `components` son los del mensaje (ruta y cuerpo; la página no es contenido).
 */
export function idempotencyMethods(model, operation, message, components, typeOf) {
  if (!usesRegistry(model, operation)) return null;
  const imports = new Set();
  const partition = operation.idempotency.partitionBy ?? [];
  const byName = new Map(components.map((component) => [component.name, component]));
  const scopeParts = partition.map((name) => {
    const component = byName.get(name);
    const type = component ? typeOf(component) : 'string';
    const field = `m.${goExported(name)}`;
    if (type === 'string') return field;
    imports.add('fmt');
    return type.startsWith('*') ? `scopeText(${field})` : `fmt.Sprint(${field})`;
  });
  const what =
    partition.length > 0
      ? `la operación y ${partition.join(', ')} (idempotency.partitionBy)`
      : 'la operación (sin partitionBy la clave es GLOBAL entre llamantes: lo decidió el diseño)';
  const scope = [goString(operation.name), ...scopeParts.map((part) => `":" + ${part}`)].join(' + ');
  const content = components.filter((component) => !component.paging).sort((a, b) => wireName(a).localeCompare(wireName(b)));
  const lines = ["\tvar s signer", "\ts.mark('{')"];
  for (const component of content) {
    lines.push(`\ts.scalar(${goString(wireName(component))})`);
    lines.push(...writeValue(model, typeOf(component), `m.${goExported(component.name)}`, '\t', imports, 0));
  }
  lines.push("\ts.mark('}')", '\treturn s.sum()');
  const methods = `// IdempotencyScope es el ámbito de la clave de idempotencia de ${operation.name}. Lo compone build, y no se compone a
// mano: ${what}.
func (m ${message}) IdempotencyScope() string {
	return ${scope}
}

// IdempotencySignature es la firma del contenido de m: la que se guarda junto a la clave para distinguir el reintento de
// la clave reutilizada, o la CLAVE misma con keySource: payload-hash. La genera build; no se calcula a mano.
func (m ${message}) IdempotencySignature() (string, error) {
${lines.join('\n')}
}`;
  return { methods, imports: [...imports], scopeText: scopeParts.some((part) => part.startsWith('scopeText(')) };
}

/** Un ámbito con una parte opcional: su texto, o vacío. Se emite una vez por paquete si algún ámbito la usa. */
export const SCOPE_TEXT = `// scopeText es el texto de una parte opcional del ámbito de idempotencia, o "" si no vino.
func scopeText[T any](value *T) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(*value)
}`;

function wireName(component) {
  return component.wireName ?? component.name;
}

/** Las sentencias que escriben `expr`, de tipo Go `type`, en el signer `s`. */
function writeValue(model, type, expr, indent, imports, depth) {
  if (type.startsWith('wire.Optional[')) {
    const inner = type.slice('wire.Optional['.length, -1);
    const v = depth === 0 ? 'value' : `value${depth}`;
    return [
      `${indent}if ${v}, ok := ${expr}.Get(); ok {`,
      ...writeValue(model, inner, v, `${indent}\t`, imports, depth + 1),
      `${indent}} else {`,
      `${indent}\ts.null()`,
      `${indent}}`
    ];
  }
  if (type.startsWith('*')) {
    const inner = type.slice(1);
    // Los paréntesis solo hacen falta antes de una llamada a método: *m.ID.String() desreferenciaría el resultado.
    const deref = inner === 'uuid.UUID' || inner === 'wire.Date' ? `(*${expr})` : `*${expr}`;
    return [`${indent}if ${expr} == nil {`, `${indent}\ts.null()`, `${indent}} else {`, ...writeValue(model, inner, deref, `${indent}\t`, imports, depth + 1), `${indent}}`];
  }
  if (type.startsWith('[]')) {
    const item = depth === 0 ? 'item' : `item${depth}`;
    return [`${indent}s.mark('[')`, `${indent}for _, ${item} := range ${expr} {`, ...writeValue(model, type.slice(2), item, `${indent}\t`, imports, depth + 1), `${indent}}`, `${indent}s.mark(']')`];
  }
  switch (type) {
    case 'string':
      return [`${indent}s.scalar(${expr})`];
    case 'int32':
    case 'int64':
    case 'int':
      imports.add('strconv');
      return [`${indent}s.scalar(strconv.FormatInt(int64(${expr}), 10))`];
    case 'float64':
      imports.add('strconv');
      return [`${indent}s.scalar(strconv.FormatFloat(${expr}, 'g', -1, 64))`];
    case 'bool':
      imports.add('strconv');
      return [`${indent}s.scalar(strconv.FormatBool(${expr}))`];
    case 'wire.Decimal':
      return [`${indent}s.decimal(${expr})`];
    case 'time.Time':
      return [`${indent}s.instant(${expr})`];
    case 'uuid.UUID':
    case 'wire.Date':
      return [`${indent}s.scalar(${expr}.String())`];
    case 'jsontext.Value':
      return [`${indent}s.scalar(string(${expr}))`];
    default: {
      // Un enum del dominio es un string con nombre; lo demás (un value object, un DTO anidado) entra por su JSON.
      const name = type.replace(/^domain\./, '');
      if (type.startsWith('domain.') && (model.enums ?? []).some((candidate) => goExported(candidate.name) === name || candidate.name === name)) {
        return [`${indent}s.scalar(string(${expr}))`];
      }
      return [`${indent}s.value(${expr})`];
    }
  }
}

/** Las notas del handler de una operación con idempotencia: qué está generado y el algoritmo. */
export function idempotencyNotes(model, operation) {
  const idempotency = operation.idempotency;
  if (!idempotency) return [];
  if (idempotency.guard === 'natural-key') {
    return [
      `Idempotencia: keySource=payload-field, keyField=${idempotency.keyField}. La guarda es la CLAVE NATURAL ` +
        `(${(idempotency.naturalKey ?? []).join(', ')}) del agregado, no un registro: build NO genera IdempotencyStore para ` +
        'esta operación y no debes escribir otro. Busca por la clave natural ANTES de insertar; si ya existe, devuelve ese mismo ' +
        'recurso sin re-ejecutar nada — una repetición devuelve la respuesta original, NO un error. La carrera la arbitra la ' +
        'constraint: no captures su violación para «arreglarla».'
    ];
  }
  if (!usesRequestIdempotency(model)) return [];
  const ttl = idempotency.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const reuse = `${FRAMEWORK_ERRORS.idempotencyReuse.http} ${idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyReuse)}`;
  const race = `${FRAMEWORK_ERRORS.idempotencyRace.http} ${idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyRace)}`;
  const source =
    idempotency.keySource === 'payload-hash'
      ? 'La clave es la propia firma, cmd.IdempotencySignature(): NO hay cabecera, y por tanto tampoco caso «sin clave» — siempre se deduplica.'
      : idempotency.keySource === 'payload-field'
        ? `La clave es el campo ${goExported(idempotency.keyField)} del comando; la firma, cmd.IdempotencySignature(). No hay cabecera.`
        : 'La clave es IdempotencyKeyFrom(ctx): false = el cliente no mandó la cabecera, y entonces se ejecuta SIN deduplicar (no se rechaza). La firma es cmd.IdempotencySignature().';
  return [
    `Idempotencia: keySource=${idempotency.keySource}, ttlSeconds=${ttl}. El puerto domain.IdempotencyStore (h.idempotencyStore), su ` +
      `adaptador, la tabla ${IDEMPOTENCY_RECORD.table} y la firma del mensaje ya están generados: NO escribas otro registro, otra tabla ni otra ` +
      'firma, y no toques UseCases ni el endpoint para esto. ' +
      source,
    'Algoritmo, dentro de la transacción del comando (ya abierta por UseCases): scope := cmd.IdempotencyScope() (build lo compone ' +
      'desde el diseño); previous, found, err := h.idempotencyStore.Find(ctx, scope, clave). Si la hay con la MISMA firma, ' +
      'reconstruye la respuesta desde previous.ResourceID sin re-ejecutar nada (ni escrituras ni eventos). Si la firma difiere, ' +
      `devuelve domain.IdempotencyReuse(scope, clave) (${reuse}). Si no la hay, RECLAMA PRIMERO: decide el id del recurso ` +
      `(uuid.NewV7()), h.idempotencyStore.Save(ctx, scope, clave, firma, &id, ${ttl}) y SOLO DESPUÉS ejecuta el negocio con ese id.`,
    'La CARRERA (dos peticiones con la misma clave a la vez) no la ve Find: la arbitra la clave primaria del registro, y el ' +
      `adaptador devuelve domain.IdempotencyConflict (${race}). NO la captures. Y por eso el orden de arriba: con Save ` +
      'al final, la perdedora choca antes contra la primera restricción de negocio y sale su code, no el de la clave en curso.'
  ];
}

// ─── El adaptador del motor ──────────────────────────────────────────────────────────────────────

function storeAdapter(model) {
  const d = sqlDialect(model);
  const table = IDEMPOTENCY_RECORD.table;
  const p = d.param;
  const columns = IDEMPOTENCY_RECORD.columns.map((column) => column.name);
  const duplicate = d.mysql
    ? `	var engine *mysqldriver.MySQLError
	// MySQL llama PRIMARY a toda clave primaria, y solo la nombra en el texto del mensaje.
	return errors.As(err, &engine) && engine.Number == 1062 && strings.Contains(engine.Message, ${goString(`'${table}.PRIMARY'`)})`
    : `	var engine *pgconn.PgError
	return errors.As(err, &engine) && engine.Code == "23505" && engine.ConstraintName == ${goString(`${table}_pkey`)}`;
  const body = `
// IdempotencyStore es el adaptador de ${d.label} del registro de idempotencia (domain.IdempotencyStore) sobre la tabla
// ${table}, la MISMA que los servidores de keel-spring, keel-nest y keel-dotnet del diseño. Se une a la transacción del
// caso de uso: el registro y el efecto del comando se confirman o revierten juntos, porque una clave marcada sin recurso
// detrás haría que el reintento devolviese una respuesta que nunca existió.
//
// La carrera la arbitra el MOTOR: dos peticiones simultáneas con la misma clave insertan la misma clave primaria, y la
// que pierde espera a que la otra confirme y choca. Sale como domain.IdempotencyConflict —su code, no un 409 anónimo
// indistinguible de un conflicto de negocio— y sin la causa del motor detrás: el traductor no tiene que volver a mirarla.
type IdempotencyStore struct {
	tx *Transactions
}

// NewIdempotencyStore construye el registro sobre las transacciones del servicio.
func NewIdempotencyStore(tx *Transactions) *IdempotencyStore {
	return &IdempotencyStore{tx: tx}
}

var _ domain.IdempotencyStore = (*IdempotencyStore)(nil)

// Find implementa domain.IdempotencyStore. Una fila caducada es como si no estuviera: la ventana la fija el diseño, no
// la purga.
func (s *IdempotencyStore) Find(ctx context.Context, scope, key string) (domain.StoredRequest, bool, error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return domain.StoredRequest{}, false, err
	}
	var stored domain.StoredRequest
	var resource sql.NullString
	row := q.QueryRowContext(ctx, ${goString(`SELECT signature, resource_id FROM ${table} WHERE operation_scope = ${p(1)} AND idempotency_key = ${p(2)} AND expires_at > ${p(3)}`)}, scope, key, time.Now().UTC())
	switch err := row.Scan(&stored.Signature, &resource); {
	case errors.Is(err, sql.ErrNoRows):
		return domain.StoredRequest{}, false, nil
	case err != nil:
		return domain.StoredRequest{}, false, translate(err)
	}
	if resource.Valid {
		stored.ResourceID = &resource.String
	}
	return stored, true, nil
}

// Save implementa domain.IdempotencyStore.
func (s *IdempotencyStore) Save(ctx context.Context, scope, key, signature string, resourceID *string, ttlSeconds int) error {
	return s.tx.write(ctx, func(q DBTX) error {
		now := time.Now().UTC()
		// Una fila CADUCADA es como si no estuviera —es lo que ya asume Find—, y tiene que serlo aquí: si no, la clave
		// quedaría inutilizable entre su caducidad y la purga, con el conflicto de clave en curso todo ese tiempo.
		if _, err := q.ExecContext(ctx, ${goString(`DELETE FROM ${table} WHERE operation_scope = ${p(1)} AND idempotency_key = ${p(2)} AND expires_at <= ${p(3)}`)}, scope, key, now); err != nil {
			return err
		}
		_, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => p(i + 1)).join(', ')})`)},
			scope, key, signature, resourceID, now, now.Add(time.Duration(ttlSeconds)*time.Second))
		if duplicateIdempotencyRecord(err) {
			return domain.IdempotencyConflict(scope, key)
		}
		return err
	})
}

// duplicateIdempotencyRecord dice si err es la clave primaria del registro repetida: la carrera.
func duplicateIdempotencyRecord(err error) bool {
${duplicate}
}
`;
  const imports = ['context', 'database/sql', 'errors', 'strings', 'time', 'internal/domain', d.mysql ? MYSQL_DRIVER : 'github.com/jackc/pgx/v5/pgconn'];
  return packageFile(model, layout(model).store, { imports, body });
}

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

/**
 * La prueba EMITIDA del mecanismo, sin base: la forma canónica (lo que hace que el reintento y la clave reutilizada se
 * distingan), la firma de cada mensaje, el ámbito, la clave en el contexto y el code de cada conflicto por operación.
 * Lo que solo juzga el motor (guardar, la carrera, la caducidad, el rollback) lo mide db-check.
 */
function emittedTest(model) {
  const operations = registryOperations(model);
  const rows = operations.map((operation) => {
    const race = idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyRace);
    const reuse = idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyReuse);
    return `\t\t{operation: ${goString(operation.name)}, race: ${goString(race)}, reuse: ${goString(reuse)}},`;
  });
  const messages = operations.map((operation) => {
    const message = goTypeName(operation.messageClass);
    return `\t\t{name: ${goString(operation.name)}, scope: ${message}{}.IdempotencyScope(), sign: ${message}{}.IdempotencySignature},`;
  });
  const header = usesIdempotencyHeader(model)
    ? `

func TestLaCabeceraLlegaAlContextoRecortadaYEnBlancoNoAbreNada(t *testing.T) {
	if _, ok := IdempotencyKeyFrom(t.Context()); ok {
		t.Fatal("un contexto sin cabecera lleva clave")
	}
	if key, ok := IdempotencyKeyFrom(WithIdempotencyKey(t.Context(), "  clave-1 ")); !ok || key != "clave-1" {
		t.Errorf("clave = %q, %v; quiero \\"clave-1\\" recortada", key, ok)
	}
	if _, ok := IdempotencyKeyFrom(WithIdempotencyKey(t.Context(), "   ")); ok {
		t.Error("una clave en blanco abre una clave")
	}
}`
    : '';
  const body = `
func canonical(write func(s *signer)) string {
	var s signer
	write(&s)
	return s.text.String()
}

func TestLaFormaCanonicaNoDejaQueUnContenidoImiteUnSeparadorNiANull(t *testing.T) {
	joined := canonical(func(s *signer) { s.scalar("b,c") })
	split := canonical(func(s *signer) {
		s.scalar("b")
		s.scalar(",c")
	})
	if joined == split {
		t.Errorf("\\"b,c\\" y \\"b\\"+\\",c\\" escriben lo mismo: %q", joined)
	}
	if canonical(func(s *signer) { s.null() }) == canonical(func(s *signer) { s.scalar("~") }) {
		t.Error("null y \\"~\\" escriben lo mismo")
	}
	if got := canonical(func(s *signer) { s.scalar("año") }); got != "4:año" {
		t.Errorf("la longitud es la de los bytes: %q", got)
	}
}

func TestLaEscalaNoEsContenidoYElOrdenDeUnaListaSi(t *testing.T) {
	decimal := func(text string) string {
		return canonical(func(s *signer) { s.decimal(wire.MustDecimal(text)) })
	}
	if decimal("1.50") != decimal("1.5") || decimal("2.000") != decimal("2") {
		t.Error("1.50 y 1.5 (o 2.000 y 2) firman distinto")
	}
	if decimal("1.50") == decimal("1.51") || decimal("10") == decimal("1") {
		t.Error("dos importes distintos firman igual")
	}
	list := func(items ...string) string {
		return canonical(func(s *signer) {
			s.mark('[')
			for _, item := range items {
				s.scalar(item)
			}
			s.mark(']')
		})
	}
	if list("a", "b") == list("b", "a") {
		t.Error("el orden de una lista no cuenta")
	}
}

func TestUnInstanteFirmaIgualEnCualquierZonaYLoCompuestoPorSuJSON(t *testing.T) {
	instant := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	other := instant.In(time.FixedZone("UTC-5", -5*3600))
	if canonical(func(s *signer) { s.instant(instant) }) != canonical(func(s *signer) { s.instant(other) }) {
		t.Error("el mismo instante en otra zona firma distinto")
	}
	if got := canonical(func(s *signer) { s.value(struct{ A, B int }{1, 2}) }); got != "13:{\\"A\\":1,\\"B\\":2}" {
		t.Errorf("value = %q", got)
	}
	var failing signer
	failing.value(func() {})
	if _, err := failing.sum(); err == nil {
		t.Error("un valor que no se puede escribir firma sin error")
	}
}

func TestCadaMensajeFirmaDeterministaYConSuAmbito(t *testing.T) {
	cases := []struct {
		name  string
		scope string
		sign  func() (string, error)
	}{
${messages.join('\n')}
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			first, err := c.sign()
			if err != nil {
				t.Fatal(err)
			}
			second, err := c.sign()
			if err != nil || first != second || len(first) != 64 {
				t.Errorf("firma = %q y %q (%v); quiero dos iguales de 64 caracteres", first, second, err)
			}
			if c.scope != c.name && !strings.HasPrefix(c.scope, c.name+":") {
				t.Errorf("ámbito = %q; quiero el de la operación %s", c.scope, c.name)
			}
		})
	}
}

func TestCadaConflictoSaleConElCodeDeSuOperacion(t *testing.T) {
	cases := []struct {
		operation, race, reuse string
	}{
${rows.join('\n')}
	}
	for _, c := range cases {
		t.Run(c.operation, func(t *testing.T) {
			for _, want := range []struct {
				err  error
				code string
			}{
				{domain.IdempotencyConflict(c.operation+":particion", "k"), c.race},
				{domain.IdempotencyReuse(c.operation, "k"), c.reuse},
			} {
				var failure *domain.Error
				if !errors.As(want.err, &failure) || failure.Code() != want.code || failure.Status() != 409 {
					t.Errorf("%v: quiero el code %s con 409", want.err, want.code)
				}
			}
		})
	}
}${header}
`;
  return packageFile(model, layout(model).application, { imports: ['errors', 'strings', 'testing', 'time', 'internal/domain', 'internal/platform/wire'], body });
}
