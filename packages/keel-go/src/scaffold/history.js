// El HISTORIAL DE CAMBIOS consultable (DSL 2.29: `persistence.audit.history` y la query de `output: { history }`) en
// keel-go: incremento 4 de PLAN-DSL-229-HISTORIAL.md, con el reparto de los otros tres. Lo que decide QUÉ (qué raíces, qué
// rutas registra cada una, cuáles son personales, el diff, el orden, los filtros, las tablas y sus sentencias, la nota) es
// de keel-core (gen/history.js, gen/history-store.js); aquí solo se escribe en Go:
//
//   · `internal/domain/history.go`: la entrada, el cambio y el filtro, lo único que el puerto de la raíz nombra. Los valores
//     de un cambio son `jsontext.Value`: ya van en la forma del cable.
//   · `history.go` del paquete del motor (`postgres`, `mysql` o `mongo`): el diff (D2) sobre el TEXTO del cable que escribe
//     `wire.Marshal`, la anonimización (D8), las rutas personales y la instantánea de cada raíz, y el almacén (D6, D11): las
//     sentencias de keel-core TAL CUAL, o un documento por entrada en MongoDB. En el paquete del motor y no en el dominio:
//     hay uno solo por proyecto, la instantánea lee los getters del agregado y el almacén necesita la transacción en curso.
//     Son FUNCIONES que reciben esa transacción (la `DBTX` o el contexto con la sesión), no un tipo que inyectar: así ningún
//     constructor de adaptador cambia, y la entrada va siempre en la transacción de la escritura que la origina (D1).
//   · El ADAPTADOR de la raíz escribe la entrada en su `Save`/`DeleteByID`/`Restore` (D1), con la instantánea «antes» LEÍDA
//     de la base dentro de la transacción y antes de escribir (T1: con SQL propio no hay entidad gestionada), y lee el
//     historial con `HistoryOf`, que carga la raíz con la misma lectura que su ficha (D7).
//   · La retención se lleva el historial (`then: delete`) o lo anonimiza (`then: anonymize`), en data-lifecycle.js.

import { usesHistory, historyDiff, historyPersonalPatterns, anonymizeHistoryChanges, anonymizedEntryChanges, historyNote } from '@keel-system/keel-core/gen/history';
import {
  CHANGE_HISTORY_COLLECTION,
  HISTORY_ENGINES,
  HISTORY_FILTER_ORDER,
  historyStatements
} from '@keel-system/keel-core/gen/history-store';
import { scopedLoadOf } from '@keel-system/keel-core/gen/read-scope';
import { usesPersistence } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { isOptional, layout, packageFile } from './render.js';

export { usesHistory };

const isDocument = (model) => model.persistenceKind === 'document';

/** ¿Emite el servicio el historial? Solo con persistencia: sin ella no hay adaptador que escriba la entrada. */
export const usesGoHistory = (model) => usesPersistence(model) && usesHistory(model);

/** ¿Lleva historial esta raíz? */
export const recordsHistory = (entity) => Boolean(entity?.history && entity.historyShape);

const lower = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** La variable del paquete del motor con el historial de una raíz: `contactCardHistory` (su tipo y sus rutas personales). */
export const rootVariable = (entity) => `${lower(entity.name)}History`;

/** La función que arma la instantánea de una raíz: `contactCardHistorySnapshot`. */
export const snapshotFunction = (entity) => `${lower(entity.name)}HistorySnapshot`;

/** El texto del id de la raíz, como lo guarda `root_id`: el de su `String()` (un uuid) o su número. */
export const rootIDText = (expression) => `fmt.Sprint(${expression})`;

/**
 * Lo que el historial no puede generar con este stack, o []: las sentencias son de PostgreSQL y MySQL (las mide
 * timer-sql-check) y el documental es MongoDB. Una réplica no es un agregado de este servicio. El mismo criterio que los
 * otros tres.
 */
export function historyStackErrors(model) {
  if (!usesGoHistory(model)) return [];
  const errors = [];
  if (!isDocument(model) && !HISTORY_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `persistence: audit.history (DSL 2.29): el almacén del historial tiene sentencias medidas para ${HISTORY_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores.`
    );
  }
  for (const entity of model.entities.filter((candidate) => candidate.history)) {
    if (entity.replicaOf) errors.push(`persistence: audit.history: ${entity.name} es la copia local de otro servicio, no un agregado de este.`);
  }
  return errors;
}

// ─── Lo que nombra el dominio ────────────────────────────────────────────────────────────────────

const DOMAIN_HISTORY = `
// FieldChange es un campo que cambió en una escritura (wire-contract.md § Historial): su ruta del contrato y sus valores
// antes y después, ya en la forma del cable (null cuando no había o ya no hay). Se escriben aunque sean null: un historial
// que calla el before no dice desde qué valor cambió.
type FieldChange struct {
	Field  string         \`json:"field"\`
	Before jsontext.Value \`json:"before"\`
	After  jsontext.Value \`json:"after"\`
}

// HistoryChange es lo que pasó en una escritura (D2).
type HistoryChange string

// Los cambios del historial, en el orden del contrato.
const (
	// HistoryCreated es el alta del agregado, con todos sus campos.
	HistoryCreated HistoryChange = "created"
	// HistoryUpdated es un guardado que cambió algún campo; uno sin diferencias no deja entrada.
	HistoryUpdated HistoryChange = "updated"
	// HistoryDeleted es la baja, sin cambios.
	HistoryDeleted HistoryChange = "deleted"
	// HistoryRestored es la restauración de una baja lógica, sin cambios.
	HistoryRestored HistoryChange = "restored"
	// HistoryAnonymized es la retención que anonimiza: los valores personales ya sustituidos.
	HistoryAnonymized HistoryChange = "anonymized"
)

// HistoryEntry es una entrada del historial: una escritura confirmada sobre el agregado (D2). Author es el actor de la
// autoría, o el centinela system fuera de una petición. Los campos van en el orden del cable.
type HistoryEntry struct {
	At      time.Time     \`json:"at"\`
	Author  string        \`json:"author"\`
	Change  HistoryChange \`json:"change"\`
	Changes []FieldChange \`json:"changes"\`
}

// HistoryFilter son los filtros de una lectura del historial (D10), los tres opcionales y combinados con AND: Field casa la
// ruta entera o el campo de la raíz que la contiene (price casa price.amount); From y To incluyen su extremo.
type HistoryFilter struct {
	Field *string
	From  *time.Time
	To    *time.Time
}
`;

function domainFile(model) {
  const { domain } = layout(model);
  return { path: `${domain.dir}/history.go`, content: packageFile(model, domain, { imports: ['encoding/json/jsontext', 'time'], body: DOMAIN_HISTORY }) };
}

// ─── El diff, la anonimización y las raíces (lo común de los dos almacenes) ─────────────────────

const SUPPORT = `
// historySnapshot es una instantánea del agregado (D3): ruta del contrato → su valor, como TEXTO del cable. Una ruta que
// falta vale null.
type historySnapshot map[string]string

// put guarda el valor de una ruta con el contrato del cable: el mismo serializador que escribe las respuestas.
func (s historySnapshot) put(path string, value any) error {
	text, err := wire.Marshal(value)
	if err != nil {
		return fmt.Errorf("el historial no pudo escribir %s: %w", path, err)
	}
	s[path] = string(text)
	return nil
}

// historyText es el texto de una ruta en una instantánea, o null si no está.
func historyText(snapshot historySnapshot, path string) string {
	if text, ok := snapshot[path]; ok {
		return text
	}
	return "null"
}

// historyDiff es lo que cambió entre dos instantáneas (D2, D3): la referencia ejecutable es historyDiff de keel-core.
// before nil es un alta. Solo lo que cambió, ordenado por ruta, con los valores tal como los escribe el cable.
func historyDiff(before, after historySnapshot) []domain.FieldChange {
	paths := make([]string, 0, len(after)+len(before))
	for path := range after {
		paths = append(paths, path)
	}
	for path := range before {
		if _, ok := after[path]; !ok {
			paths = append(paths, path)
		}
	}
	slices.Sort(paths)
	var changes []domain.FieldChange
	for _, path := range paths {
		was, is := historyText(before, path), historyText(after, path)
		if was != is {
			changes = append(changes, domain.FieldChange{Field: path, Before: jsontext.Value(was), After: jsontext.Value(is)})
		}
	}
	return changes
}

// historyTop es el campo de la raíz que contiene una ruta: price en price.amount, lines en lines[7].qty.
func historyTop(path string) string {
	if cut := strings.IndexAny(path, ".["); cut >= 0 {
		return path[:cut]
	}
	return path
}

// historyFieldRows son las filas del filtro por campo de una entrada (historyFieldRows de keel-core): su ruta y el campo de
// la raíz que la contiene, una por ruta y en el orden de los cambios.
func historyFieldRows(changes []domain.FieldChange) [][2]string {
	seen := map[string]bool{}
	var rows [][2]string
	for _, change := range changes {
		if !seen[change.Field] {
			seen[change.Field] = true
			rows = append(rows, [2]string{change.Field, historyTop(change.Field)})
		}
	}
	return rows
}

// historyPersonalPath es una ruta personal del historial de una raíz (DSL 2.28): el patrón de keel-core
// (historyPersonalPatterns, anclado y válido en RE2) y si el campo es obligatorio, que decide qué vale al anonimizar.
type historyPersonalPath struct {
	pattern  *regexp.Regexp
	required bool
}

// historyRoot es una raíz con historial: el nombre del diseño (contrato con los otros generadores) y sus rutas personales.
type historyRoot struct {
	name     string
	personal []historyPersonalPath
}

// personalMatch es la ruta personal que casa con un campo, o nil.
func personalMatch(personal []historyPersonalPath, field string) *historyPersonalPath {
	for i := range personal {
		if personal[i].pattern.MatchString(field) {
			return &personal[i]
		}
	}
	return nil
}

// anonymizedText es lo que vale un cambio personal anonimizado: el sustituto anon-<id de la raíz> si es obligatorio, null
// si no.
func anonymizedText(path *historyPersonalPath, rootID string) string {
	if path.required {
		text, _ := wire.Marshal(${goString('anon-')} + rootID)
		return string(text)
	}
	return "null"
}

// anonymizeChanges son los cambios de una entrada con lo personal reescrito (D8), y si alguno cambió: la referencia es
// anonymizeHistoryChanges de keel-core. before y after pasan al sustituto o a null.
func anonymizeChanges(changes []domain.FieldChange, personal []historyPersonalPath, rootID string) ([]domain.FieldChange, bool) {
	touched := false
	out := make([]domain.FieldChange, len(changes))
	for i, change := range changes {
		out[i] = change
		match := personalMatch(personal, change.Field)
		if match == nil {
			continue
		}
		value := jsontext.Value(anonymizedText(match, rootID))
		if string(change.Before) != string(value) || string(change.After) != string(value) {
			touched = true
		}
		out[i] = domain.FieldChange{Field: change.Field, Before: value, After: value}
	}
	return out, touched
}

// anonymizedEntryChanges son los cambios de la entrada anonymized (D8): uno por ruta personal que aparece en el historial,
// ordenados por ruta, con el valor anonimizado en before y en after (el anterior ya no existe en ninguna parte).
func anonymizedEntryChanges(entries [][]domain.FieldChange, personal []historyPersonalPath, rootID string) []domain.FieldChange {
	seen := map[string]string{}
	for _, changes := range entries {
		for _, change := range changes {
			if _, done := seen[change.Field]; done {
				continue
			}
			if match := personalMatch(personal, change.Field); match != nil {
				seen[change.Field] = anonymizedText(match, rootID)
			}
		}
	}
	fields := make([]string, 0, len(seen))
	for field := range seen {
		fields = append(fields, field)
	}
	slices.Sort(fields)
	out := make([]domain.FieldChange, 0, len(fields))
	for _, field := range fields {
		out = append(out, domain.FieldChange{Field: field, Before: jsontext.Value(seen[field]), After: jsontext.Value(seen[field])})
	}
	return out
}

// writeChanges es el texto guardado de los cambios de una entrada, con el contrato del cable.
func writeChanges(changes []domain.FieldChange) (string, error) {
	if changes == nil {
		changes = []domain.FieldChange{}
	}
	text, err := wire.Marshal(changes)
	return string(text), err
}

// readChanges lee los cambios guardados de una entrada. Con encoding/json/v2 a pelo y no con wire.Unmarshal: su lector de
// jsontext.Value toma una cadena por un documento ya serializado (json-embedded), y el before "a@x.com" dejaría de serlo.
func readChanges(text string) ([]domain.FieldChange, error) {
	var changes []domain.FieldChange
	if err := json.Unmarshal([]byte(text), &changes); err != nil {
		return nil, fmt.Errorf("los cambios guardados de una entrada del historial: %w", err)
	}
	return changes, nil
}

// historyID es el id de una entrada: un UUID versión 7, que desempata dos entradas del mismo instante (D10). El de
// google/uuid crece también dentro del mismo milisegundo (lo mide history_test.go).
func historyID() (uuid.UUID, error) {
	return uuid.NewV7()
}
`;

/** Las instrucciones Go que ponen en `s` las rutas de `paths` leídas de `variable`, cuyos campos son `fields`. */
function snapshotLines(model, variable, fields, paths, prefix, indent) {
  const lines = [];
  // Agrupa por el primer segmento: un value object compuesto se lee una vez y sus hojas de él.
  const groups = new Map();
  for (const path of paths) {
    const [head, ...rest] = path.split('.');
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(rest.join('.'));
  }
  for (const [head, rests] of groups) {
    const field = (fields ?? []).find((candidate) => candidate.name === head);
    const getter = `${variable}.${goExported(head)}()`;
    if (rests.length === 1 && rests[0] === '') {
      lines.push(`${indent}if err := s.put(${prefix}${goString(head)}, ${getter}); err != nil {\n${indent}\treturn nil, err\n${indent}}`);
      continue;
    }
    // Un value object compuesto: sus hojas con dot-path. Si puede faltar, sus rutas faltan (valen null).
    const vo = model.valueObjects?.find((candidate) => candidate.name === field?.namedType || candidate.name === field?.goType?.replace(/^\*/, ''));
    const local = `${lower(goExported(head))}Value`;
    const inner = snapshotLines(model, local, vo?.fields ?? [], rests, `${prefix}${goString(`${head}.`)}+`, `${indent}\t`);
    if (field && isOptional(field)) {
      lines.push(`${indent}if ${local} := ${getter}; ${local} != nil {\n${inner.join('\n')}\n${indent}}`);
    } else {
      lines.push(`${indent}{\n${indent}\t${local} := ${getter}\n${inner.join('\n')}\n${indent}}`);
    }
  }
  return lines;
}

/** La instantánea de una raíz: sus rutas y las de sus hijas, leídas de los getters del agregado. */
function snapshotFunctionBody(model, entity) {
  const shape = entity.historyShape;
  const lines = snapshotLines(model, 'e', entity.fields, shape.paths, '', '\t');
  for (const child of shape.children) {
    const childEntity = model.entities.find((candidate) => candidate.name === child.entity);
    const getter = `e.${goExported(child.relation)}()`;
    if (child.list) {
      lines.push(`\tfor _, child := range ${getter} {
\t\tprefix := ${goString(`${child.relation}[`)} + fmt.Sprint(child.${goExported(child.idField)}()) + "]."
${snapshotLines(model, 'child', childEntity?.fields, child.paths, 'prefix+', '\t\t').join('\n')}
\t}`);
    } else {
      lines.push(`\tif child := ${getter}; child != nil {
\t\tprefix := ${goString(`${child.relation}.`)}
${snapshotLines(model, 'child', childEntity?.fields, child.paths, 'prefix+', '\t\t').join('\n')}
\t}`);
    }
  }
  return `// ${snapshotFunction(entity)} es lo que registra el historial de ${entity.name} (DSL 2.29): ruta del contrato → valor del
// cable. Ni lo sensible ni lo que pone la infraestructura (D4): son las rutas de keel-core (historyShape).
func ${snapshotFunction(entity)}(e *domain.${entity.name}) (historySnapshot, error) {
	s := historySnapshot{}
${lines.join('\n')}
	return s, nil
}`;
}

function rootsBody(model) {
  return model.entities.filter(recordsHistory).map((entity) => {
    const patterns = historyPersonalPatterns(entity.historyShape);
    const personal = patterns.map((entry) => `\t\t{pattern: regexp.MustCompile(${goRaw(entry.pattern)}), required: ${entry.required}},`);
    return `// ${rootVariable(entity)} es el historial de ${entity.name}: el nombre con que se guardan sus entradas y sus rutas personales.
var ${rootVariable(entity)} = historyRoot{
	name:${personal.length > 0 ? ' ' : '     '}${goString(entity.name)},
	personal: []historyPersonalPath{${personal.length > 0 ? `\n${personal.join('\n')}\n\t` : ''}},
}

${snapshotFunctionBody(model, entity)}`;
  }).join('\n\n');
}

/** Un literal Go en crudo (`...`) para una expresión regular; con comillas si lleva una comilla invertida. */
function goRaw(text) {
  return text.includes('`') ? goString(text) : `\`${text}\``;
}

// ─── El almacén relacional ───────────────────────────────────────────────────────────────────────

/** Las sentencias que el almacén usa, por su nombre de keel-core, y la constante Go de cada una. */
const RELATIONAL_STATEMENTS = [
  ['insertEntry', 'historyInsertEntry'],
  ['insertField', 'historyInsertField'],
  ['pageHead', 'historyPageHead'],
  ['countHead', 'historyCountHead'],
  ...HISTORY_FILTER_ORDER.map((name) => [`filters.${name}`, `historyFilter${goExported(name)}`]),
  ['pageTail', 'historyPageTail'],
  ['entriesOfRoot', 'historyEntriesOfRoot'],
  ['updateChanges', 'historyUpdateChanges'],
  ['deleteFields', 'historyDeleteFields'],
  ['deleteEntries', 'historyDeleteEntries']
];

function relationalStoreBody(model) {
  const d = sqlDialect(model);
  const sql = historyStatements(relationalEngine(model));
  const constants = RELATIONAL_STATEMENTS.flatMap(([name, constant]) => [
    { text: `\t// ${constant} es la sentencia «${name}» de keel-core.` },
    { indent: '\t', cells: [constant, `= ${goString(name.startsWith('filters.') ? sql.filters[name.slice(8)] : sql[name])}`] }
  ]);
  return `
// Las sentencias del historial sobre ${d.label}, de keel-core (gen/history-store.js) TAL CUAL, con sus marcadores nombrados:
// son contrato con los otros generadores, que comparten las tablas, y las mide timer-sql-check contra el motor. No las
// reescribas aquí. La hora de una entrada es la del motor; a igual hora desempata el id, un UUID versión 7.
const (
${alignRows(constants).join('\n')}
)

// historyMarker es un marcador nombrado de las sentencias de keel-core (:id), con el carácter que lo precede.
var historyMarker = regexp.MustCompile(\`(^|[^:\\w]):([a-zA-Z][a-zA-Z0-9]*)\`)

// historySQL pasa una sentencia con marcadores nombrados al estilo del driver (${d.mysql ? '?' : '$n'}), con sus argumentos en orden: el
// bindNamed de keel-core, en tiempo de ejecución. Un marcador repetido se pasa dos veces.
func historySQL(statement string, values map[string]any) (string, []any, error) {
	var (
		args    []any
		missing string
	)
	query := historyMarker.ReplaceAllStringFunc(statement, func(match string) string {
		groups := historyMarker.FindStringSubmatch(match)
		value, ok := values[groups[2]]
		if !ok {
			missing = groups[2]
			return match
		}
		args = append(args, value)
		return groups[1] + ${d.mysql ? '"?"' : '"$" + strconv.Itoa(len(args))'}
	})
	if missing != "" {
		return "", nil, fmt.Errorf("la sentencia del historial pide :%s y no se le dio", missing)
	}
	return query, args, nil
}

// historyExec ejecuta una sentencia del historial en q.
func historyExec(ctx context.Context, q DBTX, statement string, values map[string]any) error {
	query, args, err := historySQL(statement, values)
	if err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, query, args...); err != nil {
		return translate(err)
	}
	return nil
}

// recordHistory escribe una entrada del historial con el autor de la escritura en curso, en q: la transacción de esa
// escritura, así que si revierte, la entrada también (D1).
func recordHistory(ctx context.Context, q DBTX, root historyRoot, rootID string, change domain.HistoryChange, changes []domain.FieldChange) error {
	text, err := writeChanges(changes)
	if err != nil {
		return err
	}
	id, err := historyID()
	if err != nil {
		return err
	}
	if err := historyExec(ctx, q, historyInsertEntry, map[string]any{"id": id, "rootType": root.name, "rootId": rootID, "author": auditActor(ctx), "change": string(change), "changes": text}); err != nil {
		return fmt.Errorf("escribir el historial de %s %s: %w", root.name, rootID, err)
	}
	for _, row := range historyFieldRows(changes) {
		if err := historyExec(ctx, q, historyInsertField, map[string]any{"entryId": id, "path": row[0], "top": row[1]}); err != nil {
			return fmt.Errorf("escribir el historial de %s %s: %w", root.name, rootID, err)
		}
	}
	return nil
}

// recordSave escribe la entrada de un guardado (D2): created si no había nada; updated solo si algo cambió.
func recordSave(ctx context.Context, q DBTX, root historyRoot, rootID string, before, after historySnapshot) error {
	changes := historyDiff(before, after)
	if before == nil {
		return recordHistory(ctx, q, root, rootID, domain.HistoryCreated, changes)
	}
	if len(changes) == 0 {
		return nil
	}
	return recordHistory(ctx, q, root, rootID, domain.HistoryUpdated, changes)
}

// historyPage es una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor. Los
// filtros presentes, en el orden de keel-core (historyPageSql): uno que no llega no se escribe.
func historyPage(ctx context.Context, q DBTX, root historyRoot, rootID string, filter domain.HistoryFilter, pageable domain.Pageable) (domain.Page[domain.HistoryEntry], error) {
	filters := ""
	values := map[string]any{"rootType": root.name, "rootId": rootID}
	if filter.Field != nil {
		filters += historyFilterField
		values["field"] = *filter.Field
	}
	if filter.From != nil {
		filters += historyFilterFrom
		values["from"] = filter.From.UTC()
	}
	if filter.To != nil {
		filters += historyFilterTo
		values["to"] = filter.To.UTC()
	}
	var total int64
	query, args, err := historySQL(historyCountHead+filters, values)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, err
	}
	if err := q.QueryRowContext(ctx, query, args...).Scan(&total); err != nil {
		return domain.Page[domain.HistoryEntry]{}, translate(err)
	}
	values["limit"] = pageable.Size
	values["offset"] = pageable.Offset()
	query, args, err = historySQL(historyPageHead+filters+historyPageTail, values)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, err
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, translate(err)
	}
	var entries []domain.HistoryEntry
	for rows.Next() {
		var (
			id      uuid.UUID
			entry   domain.HistoryEntry
			change  string
			changes string
		)
		if err := rows.Scan(&id, &entry.At, &entry.Author, &change, &changes); err != nil {
			_ = rows.Close()
			return domain.Page[domain.HistoryEntry]{}, err
		}
		entry.At = entry.At.UTC()
		entry.Change = domain.HistoryChange(change)
		if entry.Changes, err = readChanges(changes); err != nil {
			_ = rows.Close()
			return domain.Page[domain.HistoryEntry]{}, err
		}
		entries = append(entries, entry)
	}
	if err := closeRows(rows); err != nil {
		return domain.Page[domain.HistoryEntry]{}, err
	}
	return domain.NewPage(entries, pageable, total), nil
}

// anonymizeHistory reescribe los valores personales de todas las entradas de la raíz y deja la entrada anonymized (D8), en
// q: la transacción de la retención que anonimiza la raíz.
func anonymizeHistory(ctx context.Context, q DBTX, root historyRoot, rootID string) error {
	query, args, err := historySQL(historyEntriesOfRoot, map[string]any{"rootType": root.name, "rootId": rootID})
	if err != nil {
		return err
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return translate(err)
	}
	type stored struct {
		id      uuid.UUID
		changes []domain.FieldChange
	}
	// Se leen todas antes de reescribir ninguna: con las filas abiertas, la conexión de la transacción está ocupada.
	var all []stored
	for rows.Next() {
		var (
			one  stored
			text string
		)
		if err := rows.Scan(&one.id, &text); err != nil {
			_ = rows.Close()
			return err
		}
		if one.changes, err = readChanges(text); err != nil {
			_ = rows.Close()
			return err
		}
		all = append(all, one)
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	rewritten := make([][]domain.FieldChange, 0, len(all))
	for _, one := range all {
		changes, touched := anonymizeChanges(one.changes, root.personal, rootID)
		rewritten = append(rewritten, changes)
		if !touched {
			continue
		}
		text, err := writeChanges(changes)
		if err != nil {
			return err
		}
		if err := historyExec(ctx, q, historyUpdateChanges, map[string]any{"changes": text, "id": one.id}); err != nil {
			return err
		}
	}
	return recordHistory(ctx, q, root, rootID, domain.HistoryAnonymized, anonymizedEntryChanges(rewritten, root.personal, rootID))
}

// purgeHistory borra el historial de la raíz (D8): su retención con then: delete o la purga de lo borrado, en q. Primero
// los campos y después las entradas, sin depender de la cascada.
func purgeHistory(ctx context.Context, q DBTX, root historyRoot, rootID string) error {
	values := map[string]any{"rootType": root.name, "rootId": rootID}
	if err := historyExec(ctx, q, historyDeleteFields, values); err != nil {
		return err
	}
	return historyExec(ctx, q, historyDeleteEntries, values)
}
`;
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────

const DOCUMENT_STORE = `
// historyCollection es la colección del historial (keel-core: CHANGE_HISTORY_COLLECTION); su índice lo asegura indexes.go.
const historyCollection = ${goString(CHANGE_HISTORY_COLLECTION.collection)}

// El historial sobre MongoDB tiene la forma documental de keel-core: un documento por entrada con los nombres de las
// columnas, _id el id como texto y, en vez de la segunda tabla, ${CHANGE_HISTORY_COLLECTION.fields} con la ruta y el campo de la raíz de cada
// cambio. changes va como TEXTO, igual que en el relacional: un decimal o un número grande del cable no sobreviven a pasar
// por BSON y volver. Todo va por la sesión de la transacción que lleva ctx: si la escritura revierte, la entrada también
// (D1). La hora es la del servidor, de milisegundos; a igual instante desempata el id, un UUID versión 7.

// recordHistory escribe una entrada del historial con el autor de la escritura en curso, en la transacción de ctx.
func recordHistory(ctx context.Context, tx *Transactions, root historyRoot, rootID string, change domain.HistoryChange, changes []domain.FieldChange) error {
	text, err := writeChanges(changes)
	if err != nil {
		return err
	}
	id, err := historyID()
	if err != nil {
		return err
	}
	fields := bson.A{}
	for _, row := range historyFieldRows(changes) {
		fields = append(fields, bson.D{{Key: "path", Value: row[0]}, {Key: "top", Value: row[1]}})
	}
	documents, err := tx.collection(historyCollection)
	if err != nil {
		return err
	}
	_, err = documents.InsertOne(ctx, bson.D{
		{Key: "_id", Value: id.String()},
		{Key: "root_type", Value: root.name},
		{Key: "root_id", Value: rootID},
		{Key: "at", Value: instantValue(time.Now().UTC())},
		{Key: "author", Value: auditActor(ctx)},
		{Key: "change_kind", Value: string(change)},
		{Key: "changes", Value: text},
		{Key: ${goString(CHANGE_HISTORY_COLLECTION.fields)}, Value: fields},
	})
	if err != nil {
		return fmt.Errorf("escribir el historial de %s %s: %w", root.name, rootID, translate(err))
	}
	return nil
}

// recordSave escribe la entrada de un guardado (D2): created si no había nada; updated solo si algo cambió.
func recordSave(ctx context.Context, tx *Transactions, root historyRoot, rootID string, before, after historySnapshot) error {
	changes := historyDiff(before, after)
	if before == nil {
		return recordHistory(ctx, tx, root, rootID, domain.HistoryCreated, changes)
	}
	if len(changes) == 0 {
		return nil
	}
	return recordHistory(ctx, tx, root, rootID, domain.HistoryUpdated, changes)
}

// historyOfRoot es el filtro de las entradas de una raíz.
func historyOfRoot(root historyRoot, rootID string) bson.D {
	return bson.D{{Key: "root_type", Value: root.name}, {Key: "root_id", Value: rootID}}
}

// historyPage es una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor.
func historyPage(ctx context.Context, tx *Transactions, root historyRoot, rootID string, filter domain.HistoryFilter, pageable domain.Pageable) (domain.Page[domain.HistoryEntry], error) {
	query := historyOfRoot(root, rootID)
	if filter.Field != nil {
		// La ruta entera o el campo de la raíz que la contiene (historyMatches de keel-core).
		query = append(query, bson.E{Key: "$or", Value: bson.A{
			bson.D{{Key: ${goString(`${CHANGE_HISTORY_COLLECTION.fields}.path`)}, Value: *filter.Field}},
			bson.D{{Key: ${goString(`${CHANGE_HISTORY_COLLECTION.fields}.top`)}, Value: *filter.Field}},
		}})
	}
	if filter.From != nil || filter.To != nil {
		at := bson.D{}
		if filter.From != nil {
			at = append(at, bson.E{Key: "$gte", Value: instantValue(*filter.From)})
		}
		if filter.To != nil {
			at = append(at, bson.E{Key: "$lte", Value: instantValue(*filter.To)})
		}
		query = append(query, bson.E{Key: "at", Value: at})
	}
	documents, err := tx.collection(historyCollection)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, err
	}
	// Una tras otra y no a la vez: dentro de una transacción el driver no admite operaciones concurrentes.
	total, err := documents.CountDocuments(ctx, query)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, translate(err)
	}
	cursor, err := documents.Find(ctx, query, options.Find().SetSort(bson.D{{Key: "at", Value: -1}, {Key: "_id", Value: -1}}).SetSkip(pageable.Offset()).SetLimit(int64(pageable.Size)))
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, translate(err)
	}
	defer cursor.Close(ctx)
	var entries []domain.HistoryEntry
	for cursor.Next(ctx) {
		entry, err := readHistoryEntry(cursor.Current)
		if err != nil {
			return domain.Page[domain.HistoryEntry]{}, err
		}
		entries = append(entries, entry)
	}
	if err := cursor.Err(); err != nil {
		return domain.Page[domain.HistoryEntry]{}, translate(err)
	}
	return domain.NewPage(entries, pageable, total), nil
}

// readHistoryEntry lee una entrada guardada.
func readHistoryEntry(document bson.Raw) (domain.HistoryEntry, error) {
	var entry domain.HistoryEntry
	at, err := asInstant(document.Lookup("at"))
	if err != nil {
		return entry, err
	}
	author, err := asText(document.Lookup("author"))
	if err != nil {
		return entry, err
	}
	change, err := asText(document.Lookup("change_kind"))
	if err != nil {
		return entry, err
	}
	text, err := asText(document.Lookup("changes"))
	if err != nil {
		return entry, err
	}
	changes, err := readChanges(text)
	if err != nil {
		return entry, err
	}
	return domain.HistoryEntry{At: at.UTC(), Author: author, Change: domain.HistoryChange(change), Changes: changes}, nil
}

// anonymizeHistory reescribe los valores personales de todas las entradas de la raíz y deja la entrada anonymized (D8), en
// la transacción de ctx: la de la retención que anonimiza la raíz.
func anonymizeHistory(ctx context.Context, tx *Transactions, root historyRoot, rootID string) error {
	documents, err := tx.collection(historyCollection)
	if err != nil {
		return err
	}
	cursor, err := documents.Find(ctx, historyOfRoot(root, rootID))
	if err != nil {
		return translate(err)
	}
	type stored struct {
		id      string
		changes []domain.FieldChange
	}
	// Se leen todas antes de reescribir ninguna: dentro de una transacción el driver no admite operaciones concurrentes.
	var all []stored
	for cursor.Next(ctx) {
		id, err := asText(cursor.Current.Lookup("_id"))
		if err != nil {
			_ = cursor.Close(ctx)
			return err
		}
		text, err := asText(cursor.Current.Lookup("changes"))
		if err != nil {
			_ = cursor.Close(ctx)
			return err
		}
		changes, err := readChanges(text)
		if err != nil {
			_ = cursor.Close(ctx)
			return err
		}
		all = append(all, stored{id: id, changes: changes})
	}
	if err := cursor.Err(); err != nil {
		_ = cursor.Close(ctx)
		return translate(err)
	}
	if err := cursor.Close(ctx); err != nil {
		return err
	}
	rewritten := make([][]domain.FieldChange, 0, len(all))
	for _, one := range all {
		changes, touched := anonymizeChanges(one.changes, root.personal, rootID)
		rewritten = append(rewritten, changes)
		if !touched {
			continue
		}
		text, err := writeChanges(changes)
		if err != nil {
			return err
		}
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: one.id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "changes", Value: text}}}}); err != nil {
			return translate(err)
		}
	}
	return recordHistory(ctx, tx, root, rootID, domain.HistoryAnonymized, anonymizedEntryChanges(rewritten, root.personal, rootID))
}

// purgeHistory borra el historial de la raíz (D8): su retención con then: delete o la purga de lo borrado, en la
// transacción de ctx.
func purgeHistory(ctx context.Context, tx *Transactions, root historyRoot, rootID string) error {
	documents, err := tx.collection(historyCollection)
	if err != nil {
		return err
	}
	if _, err := documents.DeleteMany(ctx, historyOfRoot(root, rootID)); err != nil {
		return translate(err)
	}
	return nil
}
`;

function storeFile(model) {
  const { store } = layout(model);
  const document = isDocument(model);
  const d = document ? null : sqlDialect(model);
  const imports = [
    'context',
    'encoding/json/jsontext',
    'encoding/json/v2',
    'fmt',
    'regexp',
    'slices',
    'strings',
    'github.com/google/uuid',
    'internal/domain',
    'internal/platform/wire',
    ...(document ? ['time', 'go.mongodb.org/mongo-driver/v2/bson', 'go.mongodb.org/mongo-driver/v2/mongo/options'] : d.mysql ? [] : ['strconv'])
  ];
  const body = `${SUPPORT}
${rootsBody(model)}
${document ? DOCUMENT_STORE : relationalStoreBody(model)}`;
  return { path: `${store.dir}/history.go`, content: packageFile(model, store, { imports, body }) };
}

// ─── La prueba emitida: el diff, la anonimización y el id contra keel-core ───────────────────────
//
// Como HistorySupportTests de keel-dotnet: los casos se calculan aquí con keel-core y viajan como DATOS; la prueba no
// reimplementa nada, compara el texto del cable. La forma es sintética: lo que se mide es el código común del almacén, que
// no depende de la raíz (la instantánea de cada raíz la miden HI-2 y HI-3 en db-check y doc-check).

const SHAPE = Object.freeze({
  paths: ['title', 'status', 'labels', 'price.amount'],
  personal: [
    { path: 'email', required: false },
    { path: 'subject', required: true }
  ],
  children: [{ relation: 'revisions', idField: 'id', list: true, paths: ['revisionNumber', 'note'], personal: [{ path: 'note', required: false }] }]
});

const BEFORE = { title: 'uno', status: 'draft', labels: ['a'], price: { amount: '19.90' }, revisions: [{ id: 'r1', revisionNumber: 1, note: null }, { id: 'r2', revisionNumber: 2, note: 'x' }] };
const AFTER = { title: 'dos', status: 'draft', labels: ['a', 'b'], price: { amount: '19.95' }, revisions: [{ id: 'r1', revisionNumber: 1, note: 'nota' }, { id: 'r3', revisionNumber: 3, note: null }] };

const ENTRIES = [
  [{ field: 'subject', before: null, after: 's-1' }, { field: 'email', before: null, after: 'a@x.com' }, { field: 'title', before: null, after: 'Ana' }],
  [{ field: 'email', before: 'a@x.com', after: 'b@x.com' }, { field: 'revisions[r1].note', before: null, after: 'nota' }],
  [{ field: 'title', before: 'Ana', after: 'Eva' }]
];

/** La instantánea como la arma el adaptador: ruta del contrato → texto del cable. */
function snapshotOf(object) {
  const entries = [];
  const at = (value, path) => path.split('.').reduce((current, segment) => (current == null ? null : current[segment]), value) ?? null;
  for (const path of SHAPE.paths) entries.push([path, JSON.stringify(at(object, path))]);
  for (const child of SHAPE.children) {
    for (const item of object[child.relation] ?? []) for (const path of child.paths) entries.push([`${child.relation}[${item.id}].${path}`, JSON.stringify(at(item, path))]);
  }
  return entries;
}

const goMap = (entries) => `historySnapshot{${entries.map(([key, value]) => `${goString(key)}: ${goString(value)}`).join(', ')}}`;

function testFile(model) {
  const { store } = layout(model);
  const patterns = historyPersonalPatterns(SHAPE);
  const personal = patterns.map(({ pattern, required }) => `\t{pattern: regexp.MustCompile(${goRaw(pattern)}), required: ${required}},`);
  const anonymized = ENTRIES.map((changes, index) => {
    const reference = anonymizeHistoryChanges(changes, patterns, 'r-1');
    return `// La anonimización de la entrada ${index + 1} es la de keel-core (anonymizeHistoryChanges).
func TestHistoryAnonymizeEntry${index + 1}(t *testing.T) {
	changes, touched := anonymizeChanges(mustReadChanges(t, ${goString(JSON.stringify(changes))}), testPersonal, "r-1")
	assertChanges(t, changes, ${goString(JSON.stringify(reference.changes))})
	if touched != ${reference.touched} {
		t.Fatalf("touched = %v, quería ${reference.touched}", touched)
	}
}`;
  });
  const body = `
// El diff, la reescritura de lo personal y el id de la entrada del historial (DSL 2.29), EJECUTADOS contra las referencias
// de keel-core: los resultados esperados los calculó build con historyDiff, anonymizeHistoryChanges y
// anonymizedEntryChanges.

var testPersonal = []historyPersonalPath{
${personal.join('\n')}
}

func mustReadChanges(t *testing.T, text string) []domain.FieldChange {
	t.Helper()
	changes, err := readChanges(text)
	if err != nil {
		t.Fatal(err)
	}
	return changes
}

func assertChanges(t *testing.T, changes []domain.FieldChange, want string) {
	t.Helper()
	got, err := writeChanges(changes)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("cambios:\\n got %s\\nwant %s", got, want)
	}
}

// El diff de un cambio es el de keel-core (historyDiff): solo lo que cambió, ordenado por ruta.
func TestHistoryDiffOfAnUpdate(t *testing.T) {
	assertChanges(t, historyDiff(${goMap(snapshotOf(BEFORE))}, ${goMap(snapshotOf(AFTER))}), ${goString(JSON.stringify(historyDiff(SHAPE, BEFORE, AFTER)))})
}

// El diff de un alta es el de keel-core: todas las rutas, desde null.
func TestHistoryDiffOfACreation(t *testing.T) {
	assertChanges(t, historyDiff(nil, ${goMap(snapshotOf(AFTER))}), ${goString(JSON.stringify(historyDiff(SHAPE, null, AFTER)))})
}

// Un guardado sin cambios no tiene diff: no deja entrada.
func TestHistoryDiffWithoutChangesIsEmpty(t *testing.T) {
	if changes := historyDiff(${goMap(snapshotOf(AFTER))}, ${goMap(snapshotOf(AFTER))}); len(changes) != 0 {
		t.Fatalf("diff sin cambios: %v", changes)
	}
}

${anonymized.join('\n\n')}

// La entrada anonymized es la de keel-core (anonymizedEntryChanges): una por ruta personal del historial, por ruta.
func TestHistoryAnonymizedEntry(t *testing.T) {
	entries := [][]domain.FieldChange{
${ENTRIES.map((changes) => `\t\tmustReadChanges(t, ${goString(JSON.stringify(changes))}),`).join('\n')}
	}
	assertChanges(t, anonymizedEntryChanges(entries, testPersonal, "r-1"), ${goString(JSON.stringify(anonymizedEntryChanges(ENTRIES, patterns, 'r-1')))})
}

// El id de la entrada crece también dentro del mismo milisegundo: es el desempate del orden de lectura (D10), y en MongoDB la
// hora es de milisegundos.
func TestHistoryIDGrowsWithinTheSameMillisecond(t *testing.T) {
	previous, err := historyID()
	if err != nil {
		t.Fatal(err)
	}
	for range 10_000 {
		next, err := historyID()
		if err != nil {
			t.Fatal(err)
		}
		if next.String() <= previous.String() {
			t.Fatalf("%s no es mayor que %s", next, previous)
		}
		previous = next
	}
}
`;
  return {
    path: `${store.dir}/history_test.go`,
    content: packageFile(model, store, { imports: ['regexp', 'testing', 'internal/domain'], body })
  };
}

export function generate(model) {
  if (!usesGoHistory(model)) return [];
  return [domainFile(model), storeFile(model), testFile(model)];
}

/** El índice de la colección, para indexes.go (document-persistence.js): la lectura de una raíz, la más reciente primero. */
export function historyIndexEntry(model) {
  if (!isDocument(model) || !usesGoHistory(model)) return null;
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  return {
    collection: CHANGE_HISTORY_COLLECTION.collection,
    specs: [{ name: index.name, paths: index.keys.map(([key]) => key), directions: index.keys.map(([, direction]) => direction), unique: false }]
  };
}

// ─── Lo que gana el adaptador de cada raíz ───────────────────────────────────────────────────────

/**
 * La instantánea «antes» de un guardado relacional (T1): el agregado LEÍDO dentro de la transacción y antes de escribirlo.
 * `query` es la función que lee la raíz y su agregado (`queryContactCard`), `where` el filtro por id y `idExpr` el id.
 */
export function relationalBeforeLines(model, entity, { local, where, idExpr }) {
  if (!recordsHistory(entity)) return '';
  return `
		// El historial (DSL 2.29, T1): lo que había, LEÍDO antes de escribir y dentro de la misma transacción.
		var historyBefore historySnapshot
		if previous, err := query${entity.name}(ctx, q, ${goString(where)}, ${idExpr}); err != nil {
			return err
		} else if len(previous) > 0 {
			if historyBefore, err = ${snapshotFunction(entity)}(domain.Rehydrate${entity.name}(previous[0])); err != nil {
				return err
			}
		}`;
}

/** La entrada de un guardado, tras releer lo guardado (`saved`): la escribe en la misma transacción. */
export function saveRecordLines(entity, { store }) {
  if (!recordsHistory(entity)) return '';
  return `
		historyAfter, err := ${snapshotFunction(entity)}(saved)
		if err != nil {
			return err
		}
		if err := recordSave(ctx, ${store}, ${rootVariable(entity)}, ${rootIDText(`saved.${goExported(entity.idField?.name ?? 'id')}()`)}, historyBefore, historyAfter); err != nil {
			return err
		}`;
}

/** La instantánea «antes» de un guardado documental (T1): el documento LEÍDO antes de escribirlo, con la sesión de ctx. */
export function documentBeforeLines(entity, { idExpr }) {
  if (!recordsHistory(entity)) return '';
  return `
		// El historial (DSL 2.29, T1): lo que había, LEÍDO antes de escribirlo y con la sesión de la transacción.
		var historyBefore historySnapshot
		if previous, err := r.find(ctx, bson.D{{Key: "_id", Value: ${idExpr}}}); err != nil {
			return err
		} else if len(previous) > 0 {
			if historyBefore, err = ${snapshotFunction(entity)}(previous[0]); err != nil {
				return err
			}
		}`;
}

/** La entrada sin cambios de campos de una baja o una restauración, para el id `idExpr`, en la transacción `store`. */
export function recordLines(entity, change, idExpr, { store, indent = '\t\t' }) {
  if (!recordsHistory(entity)) return '';
  const constant = change === 'deleted' ? 'domain.HistoryDeleted' : 'domain.HistoryRestored';
  return `${indent}// El historial (DSL 2.29): ${change === 'deleted' ? 'la baja' : 'la restauración'} deja su entrada, sin cambios de campos.
${indent}if err := recordHistory(ctx, ${store}, ${rootVariable(entity)}, ${rootIDText(idExpr)}, ${constant}, nil); err != nil {
${indent}\treturn err
${indent}}`;
}

/** Lo que la retención le hace al historial de la raíz (D8), en su transacción: se lo lleva o lo anonimiza. */
export function retentionLines(entity, retention, { store, idExpr = 'id', indent = '\t\t' }) {
  if (!recordsHistory(entity)) return '';
  const call = retention.then === 'delete' ? 'purgeHistory' : 'anonymizeHistory';
  return `${indent}// El historial de la raíz sigue su régimen (DSL 2.29, D8), en la misma transacción.
${indent}if err := ${call}(ctx, ${store}, ${rootVariable(entity)}, ${rootIDText(idExpr)}); err != nil {
${indent}\treturn err
${indent}}`;
}

// ─── La lectura (D7) ─────────────────────────────────────────────────────────────────────────────

/**
 * Las lecturas del historial de una raíz: una por forma de cargarla. `{ method, by, load, scoped, param }`: por id (la
 * carga viva del puerto) o, si la query va acotada, por la carga acotada de la ficha (`LoadScoped`/`LoadScopedBy<Clave>`).
 * La misma derivación que los otros tres.
 */
export function historyReadsOf(model, entity) {
  if (!recordsHistory(entity)) return [];
  const reads = new Map();
  for (const operation of model.services.flatMap((group) => group.operations)) {
    if (operation.historyOf !== entity.name) continue;
    const load = operation.readScope ? scopedLoadOf(model, operation) : null;
    const by = load?.by === 'key' ? 'key' : 'id';
    const method = by === 'id' ? 'HistoryOf' : `HistoryOfBy${goExported(load.field)}`;
    if (reads.has(method)) continue;
    const field = by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    reads.set(method, {
      method,
      by,
      load: load ? goExported(load.method) : 'FindByID',
      scoped: Boolean(operation.readScope),
      field: field?.name ?? 'id',
      param: { name: field?.name === 'id' || by === 'id' ? 'id' : lower(goExported(field.name)), type: field?.goType ?? 'uuid.UUID' }
    });
  }
  return [...reads.values()];
}

const readParams = (read, qualify) =>
  ['ctx context.Context', `${read.param.name} ${read.param.type}`, ...(read.scoped ? [`scope ${qualify}ReadScope`] : []), `filter ${qualify}HistoryFilter`, `pageable ${qualify}Pageable`].join(', ');

/** Los métodos del puerto: `[doc, signature]`. */
export function historyPortMethods(model, entity) {
  return historyReadsOf(model, entity).map((read) => [
    `el historial de cambios de ${entity.name} (DSL 2.29), la entrada más reciente primero: carga la raíz con la misma lectura que su ficha —viva${read.scoped ? ' y con el alcance del llamante' : ''}— y found es false si no la ve. El filtro y la página los aplica el almacén.`,
    `${read.method}(${readParams(read, '')}) (Page[HistoryEntry], bool, error)`
  ]);
}

/** Los métodos del adaptador: la lectura (D7). `store` es cómo llega el almacén a la transacción. */
export function historyReadMethods(model, entity, { type, port, document }) {
  return historyReadsOf(model, entity).map((read) => {
    const load = `r.${read.load}(ctx, ${read.param.name}${read.scoped ? ', scope' : ''})`;
    const page = document
      ? `historyPage(ctx, r.tx, ${rootVariable(entity)}, ${rootIDText(`root.${goExported(entity.idField?.name ?? 'id')}()`)}, filter, pageable)`
      : `historyPage(ctx, q, ${rootVariable(entity)}, ${rootIDText(`root.${goExported(entity.idField?.name ?? 'id')}()`)}, filter, pageable)`;
    return `// ${read.method} implementa domain.${port}. D7: la misma lectura que la ficha; lo que ella no ve, el historial tampoco.
func (r *${type}) ${read.method}(${readParams(read, 'domain.')}) (domain.Page[domain.HistoryEntry], bool, error) {
	root, found, err := ${load}
	if err != nil || !found {
		return domain.Page[domain.HistoryEntry]{}, false, err
	}${document ? '' : `
	q, err := r.tx.conn(ctx)
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, false, err
	}`}
	page, err := ${page}
	if err != nil {
		return domain.Page[domain.HistoryEntry]{}, false, err
	}
	return page, true, nil
}`;
  });
}

// ─── La query ────────────────────────────────────────────────────────────────────────────────────

/** El tipo que devuelve una query de historial: la página del contrato. */
export const HISTORY_RESULT = 'PagedResponse[domain.HistoryEntry]';

/** La nota del handler (la neutral de keel-core), con la llamada en Go. */
export function handlerNote(model, operation, repository) {
  const root = model.entities.find((entity) => entity.name === operation.historyOf);
  if (!root) return null;
  const reads = historyReadsOf(model, root);
  const read = reads.find((candidate) => (operation.readScope ? candidate.scoped : !candidate.scoped)) ?? reads[0];
  if (!read) return null;
  const filter = HISTORY_FILTER_ORDER.map((role) => `${goExported(role)}: ${operation.historyFilters?.[role] ? `query.${goExported(operation.historyFilters[role])}` : 'nil'}`).join(', ');
  const call = `h.${repository}.${read.method}(ctx, <${read.by === 'id' ? 'su id' : `su ${read.param.name}`}>${read.scoped ? ', query.ReadScope' : ''}, domain.HistoryFilter{${filter}}, query.Pageable)`;
  return historyNote(operation, { historyCall: call });
}
