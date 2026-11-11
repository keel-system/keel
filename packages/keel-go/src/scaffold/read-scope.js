// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss` en `authentication.scoping` y en `ownership.<Entidad>`) en keel-go:
// incremento 4 de PLAN-DSL-227-LECTURA-ACOTADA.md, con el reparto de keel-spring, keel-nest y keel-dotnet. Lo que decide
// QUÉ (las lecturas, el camino, el predicado, la carga por id o por clave, la clave de caché y la nota) es de
// keel-core/gen/read-scope.js; aquí solo se escribe en Go:
//
//   · `domain.ReadScope`: el valor neutral de D1, con lo que admite y su parte de la clave de caché (D6), la misma función
//     que `readScopeCacheKey` de keel-core. Su valor CERO es el conjunto vacío, que no ve nada: Go no obliga a dar un campo
//     en un literal, así que un mensaje que nadie estampó no puede verlo todo (D3).
//   · `internal/httpapi/read_scope.go`: el scope desde el principal en curso, uno por bloque. Solo una exención da
//     `UnrestrictedScope`; un claim ausente es el conjunto vacío (D3). El endpoint lo estampa en el mensaje tras el lector.
//   · El predicado en el ADAPTADOR (D4): `scoped` suma su condición al `filters` del finder (el salto a otra raíz, una
//     subconsulta por salto) o a las condiciones del documento (resolviendo los `_id` de cada salto), y la misma consulta
//     da el total.
//   · `LoadScoped` y `LoadScopedBy<Clave>` (D5, T7): cargan, y si la fila existe preguntan al motor si el MISMO predicado
//     la admite. Fuera: found false con `not-found`, el centinela del error declarado con `forbidden`.
//   · Las pruebas emitidas: la clave de caché (RS-9, en `internal/domain` y la que compone la caché de la operación en
//     `internal/application`), el scope del borde (RS-10) y el 403 del cable (RS-11). RS-1 a RS-8 las miden db-check y
//     doc-check contra el adaptador.

import { tokenContract } from '@keel-system/keel-core/gen/identity-providers';
import { READ_SCOPE_KEY_CASES, readMissMessage, readScopeNote, readScopePath, readScopeText, scopedLoadOf, scopedReadsOf, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { persistedMembers, snakeCase } from '@keel-system/keel-core/gen';
import { goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { domainPath, formatString, layout, localName, packageFile } from './render.js';
import { sentinelOf } from './errors.js';
import { naturalKeyFinder, repositoryParam } from './repositories.js';
import { cacheVar } from './cache.js';
import { messageType } from './services.js';
import { securityPackage, usesCallerIdentity } from './security.js';

/** El campo del mensaje que estampa el endpoint. */
export const READ_SCOPE_FIELD = 'ReadScope';
export const READ_SCOPE_FILE = 'read_scope.go';

export const usesReadScope = (model) => scopedReadsOf(model).length > 0;

/** La función de `internal/httpapi/read_scope.go` que construye el scope de una lectura: una por bloque. */
export function readScopeBuilder(read) {
  return read.kind === 'scoping' ? 'readScopeScoping' : `readScopeOwnerOf${goExported(read.block.split('.').pop())}`;
}

/** ¿Construye el dueño con la identidad resuelta contra las credenciales del recurso (resolvedBy)? */
function resolvesOwner(model, read) {
  return read.kind === 'ownership' && Boolean(model.security?.callerIdentity?.resolvedBy);
}

/** Las cargas acotadas de una raíz (T7): `[{ method, by, field, finder, param: { name, type } }]`, sin repetir. */
export function scopedLoadsOf(model, entity) {
  const loads = new Map();
  for (const operation of scopedReadsOf(model)) {
    if (operation.readScope.root !== entity.name) continue;
    const load = scopedLoadOf(model, operation);
    if (!load || loads.has(load.method)) continue;
    if (load.by === 'id') {
      loads.set(load.method, { ...load, method: goExported(load.method), finder: 'FindByID', param: { name: localName(entity.idField?.name ?? 'id'), type: entity.idField?.goType ?? 'uuid.UUID' } });
      continue;
    }
    const finder = naturalKeyFinder(model, entity);
    if (!finder || finder.params.length !== 1) throw new Error(`${entity.name}: la carga acotada por ${load.field} necesita el finder de su clave natural de un campo`);
    const [param] = finder.params;
    loads.set(load.method, { ...load, method: goExported(load.method), finder: finder.name, param: { name: localName(param.name), type: param.type.replace(/^domain\./, '') } });
  }
  return [...loads.values()];
}

export function isScopedRoot(model, entity) {
  return scopedRootsOf(model).some((root) => root.entity?.name === entity.name);
}

function rootRead(model, entity) {
  return scopedRootsOf(model).find((root) => root.entity?.name === entity.name)?.read ?? null;
}

/** La lectura de una fila de una raíz con `readMiss: forbidden` (la que declara el error del 403). */
function singleRead(model, read) {
  return scopedReadsOf(model).find((candidate) => candidate.readScope.root === read.root && candidate.readScope.shape === 'single');
}

/** El error del 403 de una fila ajena, como lo devuelve el adaptador (y como lo construye la prueba emitida RS-11). */
export function missError(model, read, domain = 'domain.') {
  const error = operationError(model, singleRead(model, read).name, read.error);
  const message = formatString(readMissMessage(model, read));
  return error?.dynamicStatus ? `${domain}StatusErrorf(${domain}${sentinelOf(read.error)}, 403, ${message})` : `${domain}Errorf(${domain}${sentinelOf(read.error)}, ${message})`;
}

/** El desenlace de una fila ajena en el adaptador. */
function missStatement(model, read) {
  if (read.readMiss !== 'forbidden') {
    return `	// readMiss: not-found. Una fila ajena da el mismo 404 que una que no existe: no revela que existe.
	return nil, false, nil`;
  }
  return `	// readMiss: forbidden. Existe y es ajena: el ${read.error} (403) del diseño, después del 404 de una que no existe.
	return nil, false, ${missError(model, read)}`;
}

/** Las firmas del puerto: `[doc, firma]` por carga. */
export function readScopePortMethods(model, entity) {
  const loads = scopedLoadsOf(model, entity);
  if (loads.length === 0) return [];
  const read = rootRead(model, entity);
  const miss = read.readMiss === 'forbidden' ? `devuelve el ${read.error} (403)` : 'found es false, como si no existiera';
  return loads.map((load) => [
    `carga el ${entity.name} por ${load.by === 'id' ? 'su id' : `su ${load.field}`} si el alcance del llamante lo admite (${read.block}.reads: ${readScopeText(read)}). found es false si no existe; si existe y es ajeno, ${miss}. El scope lo estampa el endpoint.`,
    `${load.method}(ctx context.Context, ${load.param.name} ${load.param.type}, scope ReadScope) (*${entity.name}, bool, error)`
  ]);
}

/** Las cargas de los dos adaptadores: cargan con su finder y deciden con `admittedOrMiss`. */
function loadMethods(model, entity, type) {
  return scopedLoadsOf(model, entity).map(
    (load) => `// ${load.method} implementa domain.${entity.name}Repository.
func (r *${type}) ${load.method}(ctx context.Context, ${load.param.name} ${load.param.type}, scope domain.ReadScope) (*domain.${entity.name}, bool, error) {
	found, ok, err := r.${load.finder}(ctx, ${load.param.name})
	if err != nil || !ok {
		return nil, false, err
	}
	return r.admittedOrMiss(ctx, found, scope)
}`
  );
}

/** El comparador de las cargas: `count` es cuántas filas con ese id admite el predicado (0 o 1). */
function admittedOrMiss(model, entity, type, read, countLines) {
  return `// admittedOrMiss es el desenlace de una carga acotada (D5): found si el MISMO predicado de las lecturas lo admite; si no,
// el readMiss del diseño.
func (r *${type}) admittedOrMiss(ctx context.Context, found *domain.${entity.name}, scope domain.ReadScope) (*domain.${entity.name}, bool, error) {
	if scope.Kind() == domain.ReadScopeUnrestricted {
		return found, true, nil
	}
${countLines}
	if count > 0 {
		return found, true, nil
	}
${missStatement(model, read)}
}`;
}

/** El miembro persistido con la referencia a otra raíz de un salto. */
function hopReference(model, from, relation) {
  const member = persistedMembers(model, from).find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === relation);
  return { column: member?.column ?? `${snakeCase(relation)}_id`, name: member?.name ?? `${relation}Id` };
}

// ─── El adaptador relacional ─────────────────────────────────────────────────────────────────────

/** La línea con la que un finder relacional suma el alcance a sus criterios. */
export const RELATIONAL_SCOPE_LINE = '\tr.scoped(&f, scope)';

/**
 * Los métodos del adaptador relacional: las cargas, su comparador y el predicado. `root` es el modelo de la tabla de la
 * raíz (repositories.js) y `writeValue` su códec.
 */
export function readScopeRelationalMethods(model, entity, { type, root, writeValue }) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  const q = (name) => sqlDialect(model).quote(name);
  const methods = loadMethods(model, entity, type);
  if (methods.length > 0) {
    const idValue = writeValue(entity.idField ?? { goType: 'uuid.UUID', name: 'id' }, `found.${goExported(entity.idField?.name ?? 'id')}()`, false);
    methods.push(
      admittedOrMiss(
        model,
        entity,
        type,
        read,
        `	var admitted filters
	admitted.add(${goString(root.idColumn)}, "=", ${idValue})
	r.scoped(&admitted, scope)
	q, err := r.tx.conn(ctx)
	if err != nil {
		return nil, false, err
	}
	var count int64
	if err := q.QueryRowContext(ctx, ${goString(`SELECT count(*) FROM ${root.table} `)}+admitted.where(), admitted.args...).Scan(&count); err != nil {
		return nil, false, translate(err)
	}`
      )
    );
  }
  // De fuera adentro: cada salto es `<fk> IN (SELECT <id> FROM <tabla> WHERE …`, y el campo acotado cierra con el IN de los
  // valores. El motor lo resuelve en UNA sentencia, así que el total sale de la misma consulta.
  const path = readScopePath(model, read);
  let head = '';
  let from = entity;
  for (const hop of path.hops) {
    head += `${q(hopReference(model, from, hop.relation).column)} IN (SELECT ${q(hop.entity.idField?.columns?.name ?? 'id')} FROM ${q(hop.entity.tableName)} WHERE `;
    from = hop.entity;
  }
  const field = path.field;
  head += q(field?.columns?.name ?? snakeCase(read.field));
  const tail = ')'.repeat(path.hops.length);
  methods.push(`// scoped suma a f el alcance de la lectura (${read.block}.reads: ${readScopeText(read)}). Va en la consulta de cada
// lectura acotada, así que se suma a sus criterios y la misma consulta da el total (D4). Solo UnrestrictedScope lo deja como
// está; un conjunto vacío o un dueño vacío no ven nada (D3).
func (r *${type}) scoped(f *filters, scope domain.ReadScope) {
	if scope.Kind() == domain.ReadScopeUnrestricted {
		return
	}
	f.in(${goString(head)}, scope.Values(), ${goString(tail)})
}`);
  return methods;
}

// ─── El adaptador documental ─────────────────────────────────────────────────────────────────────

/** Las líneas con las que un finder documental suma el alcance a sus condiciones. */
export function documentScopeLines(zero) {
  return ['\tconditions, err := r.scoped(ctx, conditions, scope)', '\tif err != nil {', `\t\treturn ${zero}, err`, '\t}'];
}

/** La clave del documento de un miembro, leída de la forma neutral (la misma regla que document-repositories.js). */
function keyOf(model, entity, memberName) {
  return documentShape(model, entity).find((entry) => entry.member === memberName)?.name ?? snakeCase(memberName);
}

/** Los métodos del adaptador documental: las cargas, su comparador y el predicado. `idWrite` escribe el id de `found`. */
export function readScopeDocumentMethods(model, entity, { type, constant, idWrite }) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  const methods = loadMethods(model, entity, type);
  if (methods.length > 0) {
    methods.push(
      admittedOrMiss(
        model,
        entity,
        type,
        read,
        `	admitted, err := r.scoped(ctx, bson.A{bson.D{{Key: "_id", Value: ${idWrite}}}}, scope)
	if err != nil {
		return nil, false, err
	}
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return nil, false, err
	}
	count, err := documents.CountDocuments(ctx, matching(admitted), options.Count().SetLimit(1))
	if err != nil {
		return nil, false, translate(err)
	}`
      )
    );
  }
  // De dentro afuera: el salto más interior filtra por el campo acotado; cada uno de fuera, por los ids del de dentro.
  const path = readScopePath(model, read);
  const lines = [];
  let inner = `bson.D{{Key: ${goString(keyOf(model, path.target, read.field))}, Value: bson.D{{Key: "$in", Value: allowed}}}}`;
  for (let at = path.hops.length; at >= 1; at -= 1) {
    const hop = path.hops[at - 1];
    const from = at === 1 ? entity : path.hops[at - 2].entity;
    lines.push(`	ids${at}, err := r.idsIn(ctx, ${goString(hop.entity.collectionName)}, ${inner})`, '	if err != nil {', '		return nil, err', '	}');
    inner = `bson.D{{Key: ${goString(keyOf(model, from, hopReference(model, from, hop.relation).name))}, Value: bson.D{{Key: "$in", Value: ids${at}}}}}`;
  }
  methods.push(`// scoped suma a conditions el alcance de la lectura (${read.block}.reads: ${readScopeText(read)}). Cada salto a otra
// raíz se resuelve a sus ids, que es como se guarda la relación. Va en las condiciones de cada lectura acotada, también en
// el conteo de la página (D4). Solo UnrestrictedScope las deja como están.
func (r *${type}) scoped(ctx context.Context, conditions bson.A, scope domain.ReadScope) (bson.A, error) {
	if scope.Kind() == domain.ReadScopeUnrestricted {
		return conditions, nil
	}
	// Un conjunto vacío o un dueño vacío no ven nada (D3): $in con la lista vacía no casa con ningún documento.
	allowed := bson.A{}
	for _, value := range scope.Values() {
		allowed = append(allowed, value)
	}
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}	return append(conditions, ${inner}), nil
}`);
  if (path.hops.length > 0) {
    methods.push(`// idsIn son los _id de los documentos de collection que casan con filter.
func (r *${type}) idsIn(ctx context.Context, collection string, filter bson.D) (bson.A, error) {
	documents, err := r.tx.collection(collection)
	if err != nil {
		return nil, err
	}
	cursor, err := documents.Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, translate(err)
	}
	defer cursor.Close(ctx)
	ids := bson.A{}
	for cursor.Next(ctx) {
		ids = append(ids, cursor.Current.Lookup("_id"))
	}
	return ids, translate(cursor.Err())
}`);
  }
  return methods;
}

// ─── El mensaje, el endpoint y el handler ────────────────────────────────────────────────────────

/** Las líneas del endpoint que estampan el scope en el mensaje, tras el lector (la entrada ya es válida). */
export function readScopeEndpointLines(model, operation, variable) {
  const read = operation.readScope;
  if (!read) return [];
  const builder = readScopeBuilder(read);
  if (read.kind === 'scoping') return [`\t${variable}.${READ_SCOPE_FIELD} = ${builder}(r.Context())`];
  const args = resolvesOwner(model, read) ? 'r.Context(), a.useCases.ResolveCaller' : 'r.Context()';
  return [`\t${variable}.${READ_SCOPE_FIELD}, err = ${builder}(${args})`, '\tif err != nil {', '\t\treturn err', '\t}'];
}

/** La llamada que nombra la nota del handler en una lectura de una fila. */
export function readScopeHandlerCall(model, operation, finderCallText) {
  const load = scopedLoadOf(model, operation);
  if (!load) return finderCallText;
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  const root = model.entities.find((entity) => entity.name === operation.readScope.root);
  return `h.${repositoryParam(root)}.${goExported(load.method)}(ctx, ${variable}.${goExported(load.input)}, ${variable}.${READ_SCOPE_FIELD})`;
}

/** La nota del handler: la neutral, con los nombres de Go. */
export function readScopeHandlerNote(model, operation, finderCallText) {
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  return readScopeNote(operation.readScope, { scope: `${variable}.${READ_SCOPE_FIELD}`, call: readScopeHandlerCall(model, operation, finderCallText) });
}

// ─── Los archivos ────────────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesReadScope(model)) return [];
  const { domain, httpapi, application } = layout(model);
  const files = [
    { path: domainPath(model, 'ReadScope'), content: packageFile(model, domain, { imports: ['slices', 'strings'], body: READ_SCOPE_GO }) },
    { path: `${domain.dir}/read_scope_test.go`, content: packageFile(model, domain, { test: true, imports: ['testing', 'internal/domain'], body: domainTestGo() }) },
    { path: `${httpapi.dir}/${READ_SCOPE_FILE}`, content: packageFile(model, httpapi, { imports: ['context', 'internal/domain', securityPackage(model).dir], body: readScopesGo(model) }) },
    { path: `${httpapi.dir}/read_scope_test.go`, content: edgeTestGo(model) }
  ];
  const cached = cacheKeyTestGo(model);
  if (cached) files.push({ path: `${application.dir}/read_scope_cache_test.go`, content: cached });
  return files;
}

const READ_SCOPE_GO = `
// ReadScopeKind es la forma de un ReadScope.
type ReadScopeKind int

const (
	// ReadScopeWithin es un conjunto de valores del campo acotado. Es el valor cero a propósito: un ReadScope que nadie
	// estampó es el conjunto vacío, que no ve nada (D3), nunca todo.
	ReadScopeWithin ReadScopeKind = iota
	// ReadScopeOwnedBy es un dueño: la identidad del llamante. Una identidad vacía no ve nada.
	ReadScopeOwnedBy
	// ReadScopeUnrestricted es sin filtro. Solo lo da una exención, u otra puerta que no es HTTP.
	ReadScopeUnrestricted
)

// ReadScope es qué filas ve quien lee (DSL 2.27, la lectura acotada de security.keel.yaml). Lo construye el endpoint desde
// el token y lo estampa en el mensaje; el handler lo pasa al puerto y el ADAPTADOR lo aplica en la consulta, en su total y
// en la carga por id. Desde otra puerta (un evento, el reloj) se pasa UnrestrictedScope().
type ReadScope struct {
	kind   ReadScopeKind
	owner  string
	values []string
}

// UnrestrictedScope es el scope sin filtro.
func UnrestrictedScope() ReadScope {
	return ReadScope{kind: ReadScopeUnrestricted}
}

// ScopeOwnedBy es el scope de un dueño; vacío, el llamante sin identidad, que no ve nada.
func ScopeOwnedBy(owner string) ReadScope {
	scope := ReadScope{kind: ReadScopeOwnedBy, owner: owner}
	if owner != "" {
		scope.values = []string{owner}
	}
	return scope
}

// ScopeWithin es el scope de un conjunto de valores del campo acotado; vacío, no ve nada.
func ScopeWithin(values []string) ReadScope {
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	return ReadScope{kind: ReadScopeWithin, values: slices.Compact(sorted)}
}

// Kind es la forma del scope.
func (s ReadScope) Kind() ReadScopeKind {
	return s.kind
}

// Owner es el dueño de un ScopeOwnedBy; vacío si el llamante no tiene identidad.
func (s ReadScope) Owner() string {
	return s.owner
}

// Values son los valores que admite el campo acotado, ordenados: el dueño, o el conjunto. Vacío no ve nada; con
// ReadScopeUnrestricted no dicen nada.
func (s ReadScope) Values() []string {
	return slices.Clone(s.values)
}

// Admits dice si el scope ve una fila cuyo valor acotado es value.
func (s ReadScope) Admits(value string) bool {
	return s.kind == ReadScopeUnrestricted || (value != "" && slices.Contains(s.values, value))
}

// CacheKey es la parte del scope en la clave de una caché (D6): all, by:<valor>, none o in:<v1>,<v2> ordenado, con la coma
// y la barra escapadas. Dos scopes distintos nunca comparten entrada; la misma forma que keel-spring, keel-nest y
// keel-dotnet.
func (s ReadScope) CacheKey() string {
	switch s.kind {
	case ReadScopeUnrestricted:
		return "all"
	case ReadScopeOwnedBy:
		if s.owner == "" {
			return "none"
		}
		return "by:" + scopeValueEscaper.Replace(s.owner)
	default:
		escaped := make([]string, len(s.values))
		for i, value := range s.values {
			escaped[i] = scopeValueEscaper.Replace(value)
		}
		return "in:" + strings.Join(escaped, ",")
	}
}

// scopeValueEscaper escapa la barra y la coma de un valor: dentro de él no pueden confundirse con la separación.
var scopeValueEscaper = strings.NewReplacer(\`\\\`, \`\\\\\`, ",", \`\\,\`)
`;

function domainTestGo() {
  const literal = (scope) => {
    if (scope.kind === 'unrestricted') return 'domain.UnrestrictedScope()';
    if (scope.kind === 'ownedBy') return `domain.ScopeOwnedBy(${goString(scope.value ?? '')})`;
    return `domain.ScopeWithin([]string{${scope.values.map(goString).join(', ')}})`;
  };
  const rows = READ_SCOPE_KEY_CASES.map((entry) => `\t\t{${goString(entry.id)}, ${literal(entry.scope)}, ${goString(entry.key)}},`);
  return `
// La clave de caché de un ReadScope (RS-9): los casos de keel-core/gen/read-scope.js, los mismos que ejecutan los otros
// generadores. RS-1 a RS-8 las miden db-check y doc-check contra el adaptador.

func TestRS9DosScopesDistintosNoCompartenLaClaveDeCache(t *testing.T) {
	for _, c := range []struct {
		id    string
		scope domain.ReadScope
		key   string
	}{
${rows.join('\n')}
	} {
		if got := c.scope.CacheKey(); got != c.key {
			t.Errorf("%s: la clave es %q, quiero %q", c.id, got, c.key)
		}
	}
}

func TestElValorCeroDeUnReadScopeNoVeNada(t *testing.T) {
	var unstamped domain.ReadScope
	if unstamped.Kind() == domain.ReadScopeUnrestricted || len(unstamped.Values()) != 0 || unstamped.Admits("a") {
		t.Errorf("un ReadScope que nadie estampó ve algo: %#v", unstamped)
	}
	if !domain.UnrestrictedScope().Admits("a") || domain.ScopeOwnedBy("").Admits("") || !domain.ScopeWithin([]string{"b", "a"}).Admits("a") {
		t.Error("Admits no dice lo que admite cada scope")
	}
}
`;
}

/** Los bloques que construyen un scope, uno por función. */
function builders(model) {
  const blocks = new Map();
  for (const operation of scopedReadsOf(model)) blocks.set(readScopeBuilder(operation.readScope), operation.readScope);
  return [...blocks.entries()];
}

function readScopesGo(model) {
  const functions = [];
  for (const [name, read] of builders(model)) {
    if (read.kind === 'scoping') {
      const exempt = [...read.exemptRoles.map((role) => `rol ${role}`), ...read.exemptClients.map((client) => `cliente ${client}`)].join(', ') || 'nadie';
      functions.push(`// ${name} es el scope de las lecturas de ${read.block}: ${readScopeText(read)}. Exento (${exempt}): sin
// filtro. Si no, el conjunto del claim, y un claim ausente es el conjunto VACÍO, que no ve nada (D3).
func ${name}(ctx context.Context) domain.ReadScope {
	var scope security.CallerScope
	if scope.IsExempt(ctx) {
		return domain.UnrestrictedScope()
	}
	return domain.ScopeWithin(scope.ScopedValues(ctx))
}`);
      continue;
    }
    if (!usesCallerIdentity(model)) throw new Error(`${read.block}.reads: el dueño se compara con la identidad del llamante, y el diseño no declara security.authentication.callerIdentity`);
    const roles = read.exemptRoles;
    const resolving = resolvesOwner(model, read);
    const exemption = roles.length > 0
      ? `
	if principal, ok := security.PrincipalFrom(ctx); ok && (${roles.map((role) => `principal.Has(${goString(`ROLE_${role}`)})`).join(' || ')}) {
		return domain.UnrestrictedScope(), nil
	}`
      : '';
    const owner = resolving
      ? `	credential, err := callerIdentity(ctx)
	if err != nil {
		return domain.ReadScope{}, err
	}
	owner, err := resolve(ctx, credential)
	if err != nil {
		return domain.ReadScope{}, err
	}`
      : `	owner, err := callerIdentity(ctx)
	if err != nil {
		return domain.ReadScope{}, err
	}`;
    functions.push(`// ${name} es el scope de las lecturas de ${read.block}: ${readScopeText(read)}.${roles.length > 0 ? ` Exentos los
// roles ${roles.join(', ')}: sin filtro.` : ''} El dueño es la identidad del llamante (callerIdentity), la misma que
// estamparía el lector${resolving ? ', resuelta al recurso al que pertenece su credencial (resolvedBy)' : ''}; un token que no la trae es el 401.
func ${name}(ctx context.Context${resolving ? ', resolve func(context.Context, string) (string, error)' : ''}) (domain.ReadScope, error) {${exemption}
${owner}
	return domain.ScopeOwnedBy(owner), nil
}`);
  }
  return `
// El ReadScope de cada lectura acotada (DSL 2.27), construido desde el principal de la petición en curso: lo estampa el
// endpoint en el mensaje y el handler no lo vuelve a mirar. Solo una exención da UnrestrictedScope (D3).

${functions.join('\n\n')}
`;
}

/** La identidad del llamante en los claims de un principal de prueba, como la lee callerIdentity. */
function identityClaim(model) {
  const identity = model.security.callerIdentity;
  return identity.source === 'claim' ? identity.claim ?? 'sub' : tokenContract(model.stack?.auth).clientClaims[0];
}

/**
 * Un cliente exento como llega del autenticador (`setup` son las líneas que lo preparan y `expr`, el principal): con su nombre en el claim del cliente, o, si el proveedor genera el id,
 * reconocido en Principal.Client (lo que hace el autenticador con security.client-ids; lo mide token_contract_test.go).
 */
function exemptClientCaller(model, client) {
  const { clientClaims, opaqueClients } = tokenContract(model.stack?.auth);
  if (!opaqueClients) return { setup: '', expr: `tokenWith(nil, ${goString(client)}, map[string]string{${goString(clientClaims[0])}: ${goString(JSON.stringify(client))}})` };
  return { setup: `	client := tokenWith(nil, "service-account", nil)
	client.Client = ${goString(client)}
`, expr: 'client' };
}

/**
 * `internal/httpapi/read_scope_test.go`, sin base: RS-10 (el scope del borde desde un principal: exento → sin filtro, el
 * claim ausente → el conjunto vacío, el dueño) y RS-11 (el readMiss forbidden sale con su status, su code y su message del
 * cable).
 */
function edgeTestGo(model) {
  const { httpapi } = layout(model);
  const security = securityPackage(model);
  const tests = [];
  for (const [name, read] of builders(model)) {
    if (read.kind === 'scoping') {
      const role = read.exemptRoles[0];
      const client = read.exemptClients[0];
      tests.push(`func TestRS10${goExported(name)}ElClaimAusenteEsElConjuntoVacioYSoloLaExencionLoVeTodo(t *testing.T) {
	as := func(principal *security.Principal) domain.ReadScope {
		return ${name}(security.WithPrincipal(t.Context(), principal))
	}
	if absent := as(tokenWith(nil, "custodio", nil)); absent.Kind() != domain.ReadScopeWithin || len(absent.Values()) != 0 {
		t.Errorf("sin el claim, el scope es %#v; quiero el conjunto vacío", absent)
	}
	if some := as(tokenWith(nil, "custodio", map[string]string{${goString(read.claim)}: \`"a b"\`})); some.Kind() != domain.ReadScopeWithin || some.CacheKey() != "in:a,b" {
		t.Errorf("con el claim, el scope es %#v; quiero a y b", some)
	}${role ? `
	if exempt := as(tokenWith([]string{${goString(`ROLE_${role}`)}}, "admin", nil)); exempt.Kind() != domain.ReadScopeUnrestricted {
		t.Errorf("el rol exento ${role} no lo ve todo: %#v", exempt)
	}` : ''}${client ? `
${exemptClientCaller(model, client).setup}	if exempt := as(${exemptClientCaller(model, client).expr}); exempt.Kind() != domain.ReadScopeUnrestricted {
		t.Errorf("el cliente exento ${client} no lo ve todo: %#v", exempt)
	}` : ''}
}`);
      continue;
    }
    const role = read.exemptRoles[0];
    const resolving = resolvesOwner(model, read);
    const call = (principal) => `${name}(security.WithPrincipal(t.Context(), ${principal})${resolving ? ', same' : ''})`;
    const claim = goString(identityClaim(model));
    tests.push(`func TestRS10${goExported(name)}ElDuenoEsLaIdentidadYSoloLaExencionLoVeTodo(t *testing.T) {${resolving ? `
	same := func(_ context.Context, credential string) (string, error) { return credential, nil }` : ''}
	owned, err := ${call(`tokenWith(nil, "ana", map[string]string{${claim}: \`"ana@x.io"\`})`)}
	if err != nil || owned.Kind() != domain.ReadScopeOwnedBy || owned.Owner() != "ana@x.io" {
		t.Errorf("el dueño es %#v (%v); quiero ana@x.io", owned, err)
	}
	if _, err := ${call(`tokenWith(nil, "", nil)`)}; !errors.Is(err, errUnidentifiedCaller) {
		t.Errorf("un token sin la identidad da %v; quiero el 401 de la identidad", err)
	}${role ? `
	if exempt, err := ${call(`tokenWith([]string{${goString(`ROLE_${role}`)}}, "empleado", nil)`)}; err != nil || exempt.Kind() != domain.ReadScopeUnrestricted {
		t.Errorf("el rol exento ${role} no lo ve todo: %#v (%v)", exempt, err)
	}` : ''}
}`);
  }
  const seen = new Set();
  for (const operation of scopedReadsOf(model)) {
    const read = operation.readScope;
    if (read.shape !== 'single' || read.readMiss !== 'forbidden' || seen.has(read.error)) continue;
    seen.add(read.error);
    tests.push(`func TestRS11${goExported(operation.name)}LaFilaAjenaEs403ConSuCodeYSuTexto(t *testing.T) {
	a, _ := newEdge()
	failing := a.edge(a.endpoint(func(*api, http.ResponseWriter, *http.Request) error {
		return ${missError(model, read)}
	}))
	expectEdgeError(t, serve(failing), 403, "Forbidden", ${goString(read.error)}, ${goString(readMissMessage(model, read))})
}`);
  }
  const body = `
// La lectura acotada en el borde (DSL 2.27): el scope que se construye desde el principal (RS-10) y el 403 de una fila
// ajena en el cable (RS-11). RS-1 a RS-8 las miden db-check y doc-check contra el adaptador; RS-9, read_scope_test.go del
// dominio.

// tokenWith es un llamante con token: sus authorities, su nombre y sus claims, cada uno como su JSON.
func tokenWith(authorities []string, name string, claims map[string]string) *security.Principal {
	values := map[string]jsontext.Value{}
	for claim, value := range claims {
		values[claim] = jsontext.Value(value)
	}
	return &security.Principal{Kind: security.TokenPrincipal, Name: name, Authorities: authorities, Claims: values}
}

${tests.join('\n\n')}
`;
  const usesHttp = tests.some((test) => test.includes('http.ResponseWriter'));
  return packageFile(model, httpapi, {
    imports: ['encoding/json/jsontext', 'testing', 'internal/domain', security.dir, ...(usesHttp ? ['net/http'] : []), ...(body.includes('errors.Is') ? ['errors'] : []), ...(body.includes('context.Context') ? ['context'] : [])],
    body
  });
}

/**
 * `internal/application/read_scope_cache_test.go` (RS-9): la clave que compone la caché de una lectura acotada con el MISMO
 * mensaje salvo el scope; si no lo lleva, dos llamantes comparten entrada (D6). Null sin lecturas acotadas con caché.
 */
function cacheKeyTestGo(model) {
  const cached = scopedReadsOf(model).filter((operation) => operation.cache);
  if (cached.length === 0) return null;
  const { application } = layout(model);
  const tests = cached.map(
    (operation) => `func TestRS9La${goExported(cacheVar(operation.name))}LlevaElScopeEnLaClave(t *testing.T) {
	a := ${messageType(operation)}{${READ_SCOPE_FIELD}: domain.ScopeWithin([]string{"a"})}
	b := ${messageType(operation)}{${READ_SCOPE_FIELD}: domain.ScopeWithin([]string{"b"})}
	if ${cacheVar(operation.name)}.Key(a) == ${cacheVar(operation.name)}.Key(b) {
		t.Errorf("dos scopes distintos comparten la entrada %q", ${cacheVar(operation.name)}.Key(a))
	}
}`
  );
  return packageFile(model, application, {
    imports: ['testing', 'internal/domain'],
    body: `
// La caché de una lectura acotada (DSL 2.27, D6): el scope del llamante va en la clave.

${tests.join('\n\n')}
`
  });
}

/** La referencia de un salto: su columna y el nombre de su miembro (`ownerId`), para las sondas. */
export function referenceMember(model, from, relation) {
  return hopReference(model, from, relation);
}
