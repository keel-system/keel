// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss` en `authentication.scoping` y en `ownership.<Entidad>`) en
// keel-dotnet: incremento 3 de PLAN-DSL-227-LECTURA-ACOTADA.md, con el reparto de keel-spring y keel-nest. Lo que decide
// QUÉ (las lecturas, el camino, el predicado, la carga por id o por clave, la clave de caché y la nota) es de
// keel-core/gen/read-scope.js; aquí solo se escribe en C#:
//
//   · `ReadScope` (Domain/Repository): el valor neutral de D1, con lo que admite y su parte de la clave de caché (D6), la
//     misma función que `readScopeCacheKey` de keel-core.
//   · `ReadScopes` (Infrastructure/Security): lo construye desde el principal en curso, uno por bloque. Solo una exención
//     da `Unrestricted`; un claim ausente es el conjunto vacío (D3). Lo llama el lector del endpoint y lo estampa en el
//     mensaje.
//   · El predicado en el ADAPTADOR (D4): `Scoped(query, scope)` sobre el IQueryable de EF, con una subconsulta por salto
//     a otra raíz (EF la traduce a un IN), y sobre el filtro BSON del driver, resolviendo los ids de cada salto. Se suma
//     a los criterios del finder, y la misma consulta da el total.
//   · `LoadScoped(id, scope)` y `LoadScopedBy<Clave>(valor, scope)` (D5, T7): cargan, y si la fila existe preguntan al
//     motor si el MISMO predicado la admite. Fuera: null con `not-found`, el error declarado con `forbidden`.
//   · `ReadScopeTests`: la clave de caché (RS-9), ReadScopes desde un principal (RS-10) y el 403 del cable (RS-11), las
//     tres sin base; RS-1 a RS-8 las miden db-check y doc-check contra el adaptador.

import { readMissMessage, readScopePath, readScopeText, scopedLoadOf, scopedReadsOf, scopedRootsOf, READ_SCOPE_KEY_CASES } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { persistedMembers } from '@keel-system/keel-core/gen/relational';
import { documentShape, DOCUMENT_ID } from '@keel-system/keel-core/gen/document';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { csFile, csLocal, csMember, csString, located, namespaceOf, solution } from './render.js';
import { rowClass } from './persistence.js';
import { messageComponents, messageNamespace } from './services.js';
import { cacheMember } from './cache.js';
import { carriesEntryGate } from '@keel-system/keel-core/gen';
import { credentialClientId, tokenContract } from '@keel-system/keel-core/gen/identity-providers';
import { translatedClients } from '@keel-system/keel-core/gen/security-config';
import { configNamespace } from './config.js';

export const READ_SCOPE = 'ReadScope';
export const READ_SCOPES = 'ReadScopes';
/** La propiedad del mensaje que estampa el endpoint. */
export const READ_SCOPE_PROPERTY = csMember('readScope');

export const usesReadScope = (model) => scopedReadsOf(model).length > 0;

/** El método de `ReadScopes` que construye el scope de una lectura: uno por bloque, con los nombres de keel-spring. */
export function readScopesMethod(read) {
  return read.kind === 'scoping' ? 'Scoping' : `OwnerOf${read.block.split('.').pop()}`;
}

/** Las cargas acotadas de una raíz (T7): `[{ method, by, input, field, param: { name, type } }]`, sin repetir. */
export function scopedLoadsOf(model, entity) {
  const loads = new Map();
  for (const operation of scopedReadsOf(model)) {
    if (operation.readScope.root !== entity.name) continue;
    const load = scopedLoadOf(model, operation);
    if (!load || loads.has(load.method)) continue;
    const field = load.by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    loads.set(load.method, { ...load, method: csMember(load.method), param: { name: csLocal(field?.name ?? 'id'), type: (field?.csType ?? 'Guid').replace(/\?$/, '') } });
  }
  return [...loads.values()];
}

export function isScopedRoot(model, entity) {
  return scopedRootsOf(model).some((root) => root.entity?.name === entity.name);
}

function rootRead(model, entity) {
  return scopedRootsOf(model).find((root) => root.entity?.name === entity.name)?.read ?? null;
}

/** El miss de una carga: el error declarado (forbidden) o null (not-found). */
function missStatement(model, read) {
  if (read.readMiss !== 'forbidden') {
    return `        // readMiss: not-found. Una fila ajena da el mismo 404 que una que no existe: no revela que existe.
        return null;`;
  }
  const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === read.root && candidate.readScope.shape === 'single');
  const error = operationError(model, operation.name, read.error);
  const args = [csString(readMissMessage(model, read)), ...(error.dynamicStatus ? ['403'] : [])];
  return `        // readMiss: forbidden. Existe y es ajena: el ${read.error} (403) del diseño, después del 404 de una que no existe.
        throw new ${error.exceptionClass}(${args.join(', ')});`;
}

/** Las firmas del puerto. */
export function readScopePortMethods(model, entity) {
  const loads = scopedLoadsOf(model, entity);
  if (loads.length === 0) return [];
  const read = rootRead(model, entity);
  const miss = read.readMiss === 'forbidden' ? `lanza ${read.error} (403)` : 'devuelve null, como si no existiera';
  return loads.map(
    (load) => `    /// <summary>
    /// Carga el agregado por ${load.by === 'id' ? 'su id' : `su ${load.field}`} si el alcance del llamante lo admite (${read.block}.reads:
    /// ${readScopeText(read)}). Null si no existe; si existe y es ajeno, ${miss}. El scope lo estampa el endpoint.
    /// </summary>
    Task<${entity.name}?> ${load.method}(${load.param.type} ${load.param.name}, ReadScope scope, CancellationToken cancellationToken = default);`
  );
}

/** Las cargas de los dos adaptadores: cargan con su finder y deciden con `AdmittedOrMiss`. */
function loadMethods(model, entity) {
  return scopedLoadsOf(model, entity).map(
    (load) => `    public async Task<${entity.name}?> ${load.method}(${load.param.type} ${load.param.name}, ReadScope scope, CancellationToken cancellationToken = default) =>
        await AdmittedOrMiss(await ${load.by === 'id' ? 'FindById' : `FindBy${csMember(load.field)}`}(${load.param.name}, cancellationToken), scope, cancellationToken);`
  );
}

function admittedOrMiss(model, entity, read, admittedExpression) {
  const id = csMember(entity.idField?.name ?? 'id');
  return `    /// <summary>El desenlace de una carga acotada (D5): la fila si el predicado la admite; si no, el readMiss del diseño.</summary>
    private async Task<${entity.name}?> AdmittedOrMiss(${entity.name}? found, ReadScope scope, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (found is null || scope.Kind == ReadScopeKind.Unrestricted)
        {
            return found;
        }
        var key = found.${id};
        var admitted = ${admittedExpression};
        if (admitted)
        {
            return found;
        }
${missStatement(model, read)}
    }`;
}

/** La relación a otra raíz que recorre un salto, con la propiedad de su FK y si admite null. */
function hopForeignKey(model, from, relation) {
  const member = persistedMembers(model, from).find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === relation);
  return { property: csMember(`${relation}Id`), nullable: !member?.relation?.required, column: member?.column ?? `${snakeCase(relation)}_id` };
}

// ─── EF Core ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del adaptador relacional: las cargas, el predicado y su comparador. */
export function readScopeRelationalMethods(model, entity) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  const row = rowClass(entity.name);
  const id = csMember(entity.idField?.name ?? 'id');
  const methods = loadMethods(model, entity);
  if (methods.length > 0) {
    methods.push(admittedOrMiss(model, entity, read, `await Scoped(db.Set<${row}>().AsNoTracking(), scope).AnyAsync(r => r.${id} == key, cancellationToken)`));
  }
  const path = readScopePath(model, read);
  const lines = [];
  let result;
  if (path.hops.length === 0) {
    result = `query.Where(r => allowed.Contains(r.${csMember(read.field)}))`;
  } else {
    // De dentro afuera: cada salto es una subconsulta con los ids de la raíz siguiente que cumplen lo de dentro. EF las
    // compone en una sola sentencia (un IN por salto), así que el total sale de la misma consulta.
    let inner = (hop) => `allowed.Contains(hop${path.hops.length}.${csMember(read.field)})`;
    for (let at = path.hops.length; at >= 1; at -= 1) {
      const hop = path.hops[at - 1];
      const from = at === 1 ? entity : path.hops[at - 2].entity;
      const fk = hopForeignKey(model, from, hop.relation);
      const idType = (hop.entity.idField?.csType ?? 'Guid').replace(/\?$/, '');
      const select = fk.nullable ? `(${idType}?)hop${at}.${csMember(hop.entity.idField?.name ?? 'id')}` : `hop${at}.${csMember(hop.entity.idField?.name ?? 'id')}`;
      lines.push(`        var ids${at} = db.Set<${rowClass(hop.to)}>().AsNoTracking().Where(hop${at} => ${inner()}).Select(hop${at} => ${select});`);
      inner = () => `ids${at}.Contains(hop${at - 1}.${fk.property})`;
      if (at === 1) result = `query.Where(r => ids1.Contains(r.${fk.property}))`;
    }
  }
  methods.push(`    /// <summary>
    /// El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Va en la consulta de cada lectura acotada,
    /// así que se suma a sus criterios y la misma consulta da el total (D4). Solo Unrestricted lo ve todo.
    /// </summary>
    private IQueryable<${row}> Scoped(IQueryable<${row}> query, ReadScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (scope.Kind == ReadScopeKind.Unrestricted)
        {
            return query;
        }
        // Un dueño nulo o un conjunto vacío no ve nada (D3): la lista vacía no casa con ninguna fila, nunca todo.
        var allowed = scope.Values.ToList();
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}        return ${result};
    }`);
  return methods;
}

/** La línea que el finder relacional añade tras sus criterios. */
export const RELATIONAL_SCOPE_LINE = '        query = Scoped(query, scope);';

// ─── MongoDB ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** La clave del documento de un miembro, leída de la forma neutral (la misma regla que document-repositories.js). */
function keyOf(model, entity, memberName) {
  return documentShape(model, entity).find((entry) => entry.member === memberName)?.name ?? snakeCase(memberName);
}

/** Los métodos del adaptador documental: las cargas, el predicado y su comparador. */
export function readScopeDocumentMethods(model, entity, { idWrite }) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  const methods = loadMethods(model, entity);
  if (methods.length > 0) {
    methods.push(
      admittedOrMiss(
        model,
        entity,
        read,
        `await Count(Builders<BsonDocument>.Filter.And(new BsonDocument(${csString(DOCUMENT_ID)}, ${idWrite('key')}), await ReadScopeFilter(scope, cancellationToken)), cancellationToken) > 0`
      )
    );
  }
  const path = readScopePath(model, read);
  const lines = [];
  let inner = `new BsonDocument(${csString(keyOf(model, path.target, read.field))}, new BsonDocument("$in", allowed))`;
  for (let at = path.hops.length; at >= 1; at -= 1) {
    const hop = path.hops[at - 1];
    const from = at === 1 ? entity : path.hops[at - 2].entity;
    // El salto más interior primero: el de fuera filtra por los ids que devuelve el de dentro.
    lines.push(`        var ids${at} = new BsonArray(await IdsIn(${csString(hop.entity.collectionName)}, ${inner}, cancellationToken));`);
    inner = `new BsonDocument(${csString(hopForeignKey(model, from, hop.relation).column)}, new BsonDocument("$in", ids${at}))`;
  }
  methods.push(`    /// <summary>
    /// El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Cada salto a otra raíz se resuelve a sus ids,
    /// que es como se guarda la relación. Va en el filtro de cada lectura acotada, también en el conteo de la página (D4).
    /// </summary>
    private async Task<FilterDefinition<BsonDocument>> ReadScopeFilter(ReadScope scope, CancellationToken cancellationToken)
    {
        // Un dueño nulo o un conjunto vacío no ve nada (D3): $in con la lista vacía no casa con ningún documento.
        var allowed = new BsonArray(scope.Values);
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}        return ${inner};
    }

    /// <summary>La lectura acotada sobre un filtro: el alcance se SUMA con un $and. Unrestricted lo deja como está.</summary>
    private async Task<FilterDefinition<BsonDocument>> Scoped(FilterDefinition<BsonDocument> query, ReadScope scope, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scope);
        return scope.Kind == ReadScopeKind.Unrestricted ? query : Builders<BsonDocument>.Filter.And(query, await ReadScopeFilter(scope, cancellationToken));
    }

    /// <summary>Cuántos documentos casan, en la sesión de la transacción abierta si la hay.</summary>
    private Task<long> Count(FilterDefinition<BsonDocument> filter, CancellationToken cancellationToken) =>
        transactions.Session is { } session
            ? Collection.CountDocumentsAsync(session, filter, new CountOptions { Limit = 1 }, cancellationToken)
            : Collection.CountDocumentsAsync(filter, new CountOptions { Limit = 1 }, cancellationToken);${path.hops.length > 0 ? `

    /// <summary>Los _id de otra colección que casan con el filtro, en la sesión de la transacción abierta si la hay.</summary>
    private async Task<IEnumerable<BsonValue>> IdsIn(string collection, FilterDefinition<BsonDocument> filter, CancellationToken cancellationToken)
    {
        var other = transactions.Collection(collection);
        var found = transactions.Session is { } session ? other.Find(session, filter) : other.Find(filter);
        var documents = await found.Project(Builders<BsonDocument>.Projection.Include(${csString(DOCUMENT_ID)})).ToListAsync(cancellationToken);
        return documents.Select(document => document[${csString(DOCUMENT_ID)}]);
    }` : ''}`);
  return methods;
}

/** La línea que el finder documental añade tras componer su filtro. */
export const DOCUMENT_SCOPE_LINE = '        query = await Scoped(query, scope, cancellationToken);';

// ─── Los tipos ────────────────────────────────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesReadScope(model)) return [];
  return [readScopeFile(model), readScopesFile(model), readScopeTestsFile(model)];
}

function readScopeFile(model) {
  const { namespace, path } = located(model, 'repositories', READ_SCOPE);
  const body = String.raw`/// <summary>La forma de un <see cref="ReadScope"/>.</summary>
public enum ReadScopeKind
{
    /// <summary>Sin filtro. Solo lo da una exención, u otra puerta que no es HTTP.</summary>
    Unrestricted,

    /// <summary>El dueño es la identidad del llamante. Una identidad nula no ve nada.</summary>
    OwnedBy,

    /// <summary>El campo acotado está en el conjunto del claim. El conjunto vacío no ve nada.</summary>
    Within
}

/// <summary>
/// Qué filas ve quien lee (DSL 2.27, la lectura acotada de security.keel.yaml). Lo construye el endpoint desde el token
/// (ReadScopes) y lo estampa en el mensaje; el handler lo pasa al puerto y el ADAPTADOR lo aplica en la consulta, en su
/// total y en la carga por id. Desde otra puerta (un evento, el reloj) llega <see cref="Unrestricted"/>.
/// </summary>
public sealed class ReadScope
{
    private static readonly ReadScope All = new(ReadScopeKind.Unrestricted, null, new HashSet<string>(StringComparer.Ordinal));

    private ReadScope(ReadScopeKind kind, string? owner, IReadOnlySet<string> values)
    {
        Kind = kind;
        Owner = owner;
        Values = values;
    }

    public ReadScopeKind Kind { get; }

    /// <summary>El dueño, con <see cref="ReadScopeKind.OwnedBy"/>; null si el llamante no tiene identidad.</summary>
    public string? Owner { get; }

    /// <summary>Los valores que admite el campo acotado: el dueño, o el conjunto del claim. Vacío: no ve nada (D3).</summary>
    public IReadOnlySet<string> Values { get; }

    public static ReadScope Unrestricted() => All;

    public static ReadScope OwnedBy(string? owner) =>
        new(ReadScopeKind.OwnedBy, owner, owner is null ? new HashSet<string>(StringComparer.Ordinal) : new HashSet<string>([owner], StringComparer.Ordinal));

    public static ReadScope Within(IEnumerable<string> values)
    {
        ArgumentNullException.ThrowIfNull(values);
        return new(ReadScopeKind.Within, null, new HashSet<string>(values, StringComparer.Ordinal));
    }

    /// <summary>¿Ve este scope una fila cuyo valor acotado es <paramref name="value"/>?</summary>
    public bool Admits(string? value) => Kind == ReadScopeKind.Unrestricted || (value is not null && Values.Contains(value));

    /// <summary>
    /// La parte del scope en la clave de una caché (D6): <c>all</c>, <c>by:&lt;valor&gt;</c>, <c>none</c> o
    /// <c>in:&lt;v1&gt;,&lt;v2&gt;</c> ordenado, con la coma y la barra escapadas. Dos scopes distintos nunca comparten
    /// entrada; la misma forma que keel-spring y keel-nest.
    /// </summary>
    public string CacheKey() => Kind switch
    {
        ReadScopeKind.OwnedBy => Owner is null ? "none" : "by:" + Escape(Owner),
        ReadScopeKind.Within => "in:" + string.Join(",", Values.Order(StringComparer.Ordinal).Select(Escape)),
        _ => "all"
    };

    /// <summary>Una coma o una barra dentro de un valor no puede confundirse con la separación entre valores.</summary>
    private static string Escape(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace(",", "\\,", StringComparison.Ordinal);
}`;
  return { path, content: csFile({ namespace, body }) };
}

function readScopesFile(model) {
  const { namespace, path } = located(model, 'security', READ_SCOPES);
  const usings = [namespaceOf(model, 'repositories')];
  const blocks = new Map();
  for (const operation of scopedReadsOf(model)) blocks.set(readScopesMethod(operation.readScope), operation.readScope);
  const members = [];
  for (const [method, read] of blocks) {
    if (read.kind === 'scoping') {
      const exempt = [...read.exemptRoles.map((role) => `rol ${role}`), ...read.exemptClients.map((client) => `cliente ${client}`)].join(', ') || 'nadie';
      members.push(`    /// <summary>
    /// ${read.block}: ${readScopeText(read)}.
    /// Exento (${exempt}): sin filtro. Si no, el conjunto del claim, y un claim ausente es el conjunto VACÍO, que no ve
    /// nada (D3).
    /// </summary>
    public static ReadScope ${method}()
    {
        var scope = new JwtCallerScope();
        return scope.IsExempt() ? ReadScope.Unrestricted() : ReadScope.Within(scope.ScopedValues());
    }`);
    } else {
      const roles = read.exemptRoles;
      members.push(`    /// <summary>
    /// ${read.block}: ${readScopeText(read)}.${roles.length > 0 ? `\n    /// Exentos los roles ${roles.join(', ')}: sin filtro.` : ''}
    /// El dueño es la identidad del llamante (callerIdentity), la misma que estamparía el endpoint; con resolvedBy, el
    /// endpoint pasa la ya resuelta.
    /// </summary>
    public static ReadScope ${method}(string? identity)
    {${roles.length > 0
      ? `
        var principal = SecurityContext.Get();
        if (principal is not null && (${roles.map((role) => `principal.Authorities.Contains(${csString(`ROLE_${role}`)})`).join(' || ')}))
        {
            return ReadScope.Unrestricted();
        }`
      : ''}
        return ReadScope.OwnedBy(identity);
    }

    /// <summary>Lo mismo con la identidad del principal en curso.</summary>
    public static ReadScope ${method}() => ${method}(CallerIdentity.Resolve());`);
    }
  }
  const body = `/// <summary>
/// El ReadScope de cada lectura acotada (DSL 2.27), construido desde el principal de la petición en curso: lo estampa el
/// lector del endpoint en el mensaje y el handler no lo vuelve a mirar. Solo una exención da Unrestricted (D3).
/// </summary>
public static class ${READ_SCOPES}
{
${members.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** La lectura que el endpoint estampa: `ReadScopes.Scoping()`, o con la identidad resuelta (resolvedBy). */
export function readScopeStamp(operation, resolvedIdentity = null) {
  const method = readScopesMethod(operation.readScope);
  return `${READ_SCOPES}.${method}(${resolvedIdentity && operation.readScope.kind === 'ownership' ? resolvedIdentity : ''})`;
}

/** La llamada que nombra la nota del handler en una lectura de una fila. */
export function readScopeHandlerCall(model, operation, finderCallText) {
  const load = scopedLoadOf(model, operation);
  if (!load) return finderCallText;
  return `await ${csLocal(operation.readScope.root)}Repository.${csMember(load.method)}(query.${csMember(load.input)}, query.${READ_SCOPE_PROPERTY}, cancellationToken)`;
}

// ─── Las pruebas emitidas (RS-9 a RS-11) ──────────────────────────────────────────────────────────────────────────

/**
 * `ReadScopeTests`, sin base: RS-9 (la clave de caché con los casos de keel-core, los mismos de los otros generadores),
 * RS-10 (ReadScopes desde un principal: exento → Unrestricted, el claim ausente → el conjunto vacío, el dueño) y RS-11 (el
 * readMiss forbidden sale con su status, su code y su message del cable).
 */
function readScopeTestsFile(model) {
  const sln = solution(model);
  const literal = (scope) => {
    if (scope.kind === 'unrestricted') return 'ReadScope.Unrestricted()';
    if (scope.kind === 'ownedBy') return `ReadScope.OwnedBy(${scope.value == null ? 'null' : csString(scope.value)})`;
    return `ReadScope.Within(new string[] { ${scope.values.map(csString).join(', ')} })`;
  };
  const keyCases = READ_SCOPE_KEY_CASES.map((entry) => `        Assert.Equal(${csString(entry.key)}, ${literal(entry.scope)}.CacheKey());`);
  // La clave que compone CachedOperations, con el MISMO mensaje salvo el scope: si no lo lleva, dos llamantes comparten
  // entrada (D6).
  const cachedKeys = [];
  const messageUsings = [];
  for (const operation of scopedReadsOf(model).filter((candidate) => candidate.cache)) {
    messageUsings.push(messageNamespace(model, operation));
    const members = [
      ...messageComponents(operation, model).map((component) => `${csMember(component.name)} = default!`),
      ...(carriesEntryGate(model, operation) ? ['EntryGate = default'] : [])
    ];
    const message = (scope) => `new ${operation.messageClass} { ${[...members, `${READ_SCOPE_PROPERTY} = ${scope}`].join(', ')} }`;
    cachedKeys.push(
      `        Assert.NotEqual(CachedOperations.${cacheMember(operation.name)}.KeyOf(${message('ReadScope.Within(new[] { "a" })')}), CachedOperations.${cacheMember(operation.name)}.KeyOf(${message('ReadScope.Within(new[] { "b" })')}));`
    );
  }
  const edge = [];
  const blocks = new Map();
  // El cliente exento con la forma del proveedor: su claim y su id; si el proveedor genera el id, el mapa del perfil test.
  const [clientClaim] = tokenContract(model.stack?.auth).clientClaims;
  const translates = translatedClients(model).length > 0;
  for (const operation of scopedReadsOf(model)) blocks.set(readScopesMethod(operation.readScope), operation.readScope);
  for (const [method, read] of blocks) {
    if (read.kind === 'scoping') {
      const role = read.exemptRoles[0];
      const client = read.exemptClients[0];
      const clientId = client ? credentialClientId(model.stack?.auth, client) : null;
      edge.push(`    [Fact]
    public void RS10_${method}_ElClaimAusenteEsElConjuntoVacioYSoloLaExencionLoVeTodo()
    {
        var absent = As(Token("custodio", []));
        Assert.Equal((ReadScopeKind.Within, 0), (absent.Kind, absent.Values.Count));
        var some = As(Token("custodio", [], (${csString(read.claim)}, "a b")));
        Assert.Equal(ReadScopeKind.Within, some.Kind);
        Assert.True(some.Values.SetEquals(["a", "b"]));${role ? `
        Assert.Equal(ReadScopeKind.Unrestricted, As(Token("admin", [${csString(`ROLE_${role}`)}])).Kind);` : ''}${client ? `${translates ? `
        ServiceClientIds.Configure(ServiceConfiguration.Load(name => name == "PROFILE" ? "test" : null));` : ''}
        Assert.Equal(ReadScopeKind.Unrestricted, As(Token(${csString(clientId)}, [], (${csString(clientClaim)}, ${csString(clientId)}))).Kind);` : ''}

        static ReadScope As(Principal principal)
        {
            using var _ = SecurityContext.Open(principal);
            return ReadScopes.${method}();
        }
    }`);
    } else {
      const role = read.exemptRoles[0];
      edge.push(`    [Fact]
    public void RS10_${method}_ElDuenoEsLaIdentidadYSoloLaExencionLoVeTodo()
    {
        var owned = As(Token("ana", []), "ana@x.io");
        Assert.Equal((ReadScopeKind.OwnedBy, "ana@x.io"), (owned.Kind, owned.Owner));
        var nobody = As(Token("ana", []), null);
        Assert.Equal((ReadScopeKind.OwnedBy, 0), (nobody.Kind, nobody.Values.Count));${role ? `
        Assert.Equal(ReadScopeKind.Unrestricted, As(Token("empleado", [${csString(`ROLE_${role}`)}]), "otro@x.io").Kind);` : ''}

        static ReadScope As(Principal principal, string? identity)
        {
            using var _ = SecurityContext.Open(principal);
            return ReadScopes.${method}(identity);
        }
    }`);
    }
  }
  const forbidden = scopedReadsOf(model).filter((operation) => operation.readScope.shape === 'single' && operation.readScope.readMiss === 'forbidden');
  const seenErrors = new Set();
  const miss = [];
  for (const operation of forbidden) {
    const read = operation.readScope;
    if (seenErrors.has(read.error)) continue;
    seenErrors.add(read.error);
    const error = operationError(model, operation.name, read.error);
    const message = readMissMessage(model, read);
    miss.push(`    [Fact]
    public async Task RS11_${csMember(operation.name)}_LaFilaAjenaEs403ConSuCodeYSuTexto()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        var middleware = new ApiErrorMiddleware(_ => throw new ${error.exceptionClass}(${[csString(message), ...(error.dynamicStatus ? ['403'] : [])].join(', ')}), NullLogger<ApiErrorMiddleware>.Instance);
        await middleware.InvokeAsync(context);
        Assert.Equal(403, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(context.Response.Body, cancellationToken: TestContext.Current.CancellationToken);
        var body = document.RootElement;
        Assert.Equal(403, body.GetProperty("status").GetInt32());
        Assert.Equal(${csString(read.error)}, body.GetProperty("code").GetString());
        Assert.Equal(${csString(message)}, body.GetProperty("message").GetString());
    }`);
  }
  const usings = [
    'System.Text.Json',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.Logging.Abstractions',
    'Xunit',
    `${sln.api.name}.Rest`,
    namespaceOf(model, 'repositories'),
    namespaceOf(model, 'security'),
    namespaceOf(model, 'errors'),
    ...(translates && edge.length > 0 ? [configNamespace(model)] : []),
    ...(cachedKeys.length > 0 ? [namespaceOf(model, 'appSupport'), ...messageUsings] : [])
  ];
  const body = `/// <summary>
/// La lectura acotada fuera del adaptador (DSL 2.27): la clave de caché (RS-9, los casos de keel-core/gen/read-scope.js,
/// los mismos que ejecutan los otros generadores), el scope que construye el borde desde el principal (RS-10) y el 403
/// de una fila ajena en el cable (RS-11). RS-1 a RS-8 las miden db-check y doc-check contra el adaptador.
/// </summary>
public sealed class ReadScopeTests
{
    [Fact]
    public void RS9_DosScopesDistintosNoCompartenLaClaveDeCache()
    {
${[...keyCases, ...cachedKeys].join('\n')}
    }

${[...edge, ...miss].join('\n\n')}${edge.length > 0 ? `

    private static Principal Token(string name, string[] authorities, params (string Claim, string Value)[] claims) =>
        new(
            PrincipalKind.Token,
            name,
            new HashSet<string>(authorities, StringComparer.Ordinal),
            claims.ToDictionary(claim => claim.Claim, claim => JsonSerializer.SerializeToElement(claim.Value), StringComparer.Ordinal));` : ''}
}`;
  return { path: `${sln.unitTests.dir}/ReadScopeTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}
