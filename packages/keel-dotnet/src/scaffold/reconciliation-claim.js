// El reclamo del barrido de RECONCILIACIÓN (incremento 11c): llevarse los encargos que llevan demasiado tiempo sin
// desenlace, de forma que dos réplicas no se lleven el mismo. El mismo mecanismo que keel-spring y keel-nest, sobre EF
// Core y PostgreSQL.
//
// Por qué NO es el reclamo de una cola (claim.js): allí la marca es el propio estado de destino; aquí el estado de espera
// es justo lo que el barrido busca y no se puede cambiar antes de saber el desenlace, y entre reclamar y actuar hay una
// llamada al proveedor —un lock solo aísla mientras dura su transacción—. De ahí la tabla propia `reconciliation_claim`,
// con una marca que SOBREVIVE AL COMMIT y CADUCA.
//
// La tabla, su purga, los tres números de cada barrido (clave, variable y default), su reconciliation.yaml y la regla de
// quién se lleva el candidato son de keel-core (`gen/reconciliation-stores.js`), los mismos que en los otros dos.
//
// Lo propio de .NET sobre PostgreSQL: la marca se pone con UNA sentencia (`INSERT … ON CONFLICT DO UPDATE … WHERE
// claimed_at <= caducidad`), no con el UPDATE y el INSERT de keel-nest capturando la violación de clave: en PostgreSQL un
// error aborta la transacción entera, y el reclamo de cada candidato va dentro de la de la tanda.

import { RECONCILIATION_CLAIM, RECONCILIATION_PURGE, reconciledActivations, reconciliationClaims, reconciliationParameters, reconciliationYaml } from 'keel-core/gen/reconciliation-stores';
import { screamingSnake, snakeCase } from 'keel-core/gen';
import { csFile, csMember, csString, located, xmlDoc } from './render.js';
import { configNamespace } from './config.js';
import { dbContextClass, usesRelational } from './persistence.js';
import { rowFile } from './messaging-stores.js';

export const RECONCILIATION_ROW = 'ReconciliationClaimRow';
const STORE = 'ReconciliationClaimStore';
const SETTINGS = 'ReconciliationSettings';

/** ¿Genera build algún reclamo de reconciliación? Con persistencia relacional (el documental llega en el incremento 12). */
export function usesReconciliationClaims(model) {
  return usesRelational(model) && reconciliationClaims(model).length > 0;
}

/** ¿Hay parámetros de barridos de reconciliación que leer? Los hay aunque build no pueda generar el reclamo. */
export function usesReconciliationSettings(model) {
  return usesRelational(model) && reconciledActivations(model).length > 0;
}

/** Los nombres que la tabla pone en el esquema: los busca la prueba emitida del modelo. */
export function reconciliationSchemaNames(model) {
  if (!usesReconciliationClaims(model)) return [];
  return [RECONCILIATION_CLAIM.table, `${RECONCILIATION_CLAIM.table}_pkey`, ...RECONCILIATION_CLAIM.indexes.map((index) => index.name)];
}

/** La purga de la tabla, para TablePurges: las marcas viejas ya no protegen nada. La misma que keel-nest. */
export function reconciliationPurge(model) {
  if (!usesReconciliationClaims(model)) return null;
  return {
    key: 'ReconciliationClaim',
    what: RECONCILIATION_CLAIM.table,
    method: 'PurgeReconciliationClaims',
    table: RECONCILIATION_CLAIM.table,
    column: 'claimed_at',
    predicate: null,
    prefix: 'reconciliation.purge',
    cron: RECONCILIATION_PURGE.cron,
    retentionDays: RECONCILIATION_PURGE.retentionDays,
    log: 'Reconciliación: purgadas {Deleted} marcas de reclamo anteriores a {Cutoff}'
  };
}

export function generate(model) {
  const files = [];
  if (usesReconciliationSettings(model)) {
    const { namespace, path } = located(model, 'persistence', SETTINGS);
    files.push({ path, content: csFile({ namespace, usings: ['System.Globalization', configNamespace(model)], body: settingsBody(model) }) });
    // Los mismos perfiles que los otros dos: en test valen los defaults del código.
    for (const profile of ['local', 'develop', 'production']) {
      files.push({ path: `config/parameters/${profile}/reconciliation.yaml`, content: reconciliationYaml(model, profile) });
    }
  }
  if (usesReconciliationClaims(model)) {
    files.push(rowFile(model, RECONCILIATION_ROW, RECONCILIATION_CLAIM, CLAIM_DOC));
    const { namespace, path } = located(model, 'persistence', STORE);
    files.push({ path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore'], body: storeBody(model) }) });
  }
  return files;
}

const CLAIM_DOC = `Marca de que una réplica se llevó un candidato del barrido de reconciliación. La MISMA tabla que los servidores
/// de keel-spring y keel-nest del diseño (keel-core/gen/reconciliation-stores.js): la clave es compuesta —activación +
/// entidad— porque una entidad puede esperar el desenlace de VARIAS activaciones a la vez, y claimed_at es un instante y
/// no un booleano porque la marca CADUCA: una fila no se suelta cuando muere la réplica que la escribió.`;

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

const configKey = (key) => key.replaceAll('.', ':');

function settingsBody(model) {
  const entries = reconciledActivations(model).map(({ activation, sweeper }) => {
    const parameters = reconciliationParameters(activation, sweeper);
    const read = (parameter) => `Positive(configuration, ${csString(configKey(parameter.key))}, ${parameter.default})`;
    return `                [${csString(activation.name)}] = new(
                    ${read(parameters.unansweredAfterSeconds)},
                    ${read(parameters.claimTimeoutMs)},
                    ${read(parameters.batchSize)}),`;
  });
  return `/// <summary>
/// Los tres números de un barrido de reconciliación, y NO son la misma clase de decisión: el silencio tolerado lo declara
/// el diseño (unansweredAfterSeconds de la activación); la caducidad del reclamo y la cota del lote son del generador
/// (mecánica y capacidad).
/// </summary>
public sealed record ReconciliationWindow(int UnansweredAfterSeconds, int ClaimTimeoutMs, int BatchSize);

/// <summary>
/// Los barridos de reconciliación del perfil activo (config/parameters/&lt;perfil&gt;/reconciliation.yaml), por activación,
/// con las claves y los defaults de los servidores de keel-spring y keel-nest. Un valor que no es un entero positivo no
/// deja arrancar.
/// </summary>
public sealed record ${SETTINGS}(IReadOnlyDictionary<string, ReconciliationWindow> Windows)
{
    /// <summary>Los defaults, sin configuración: los de un contenedor que no la tiene (las pruebas de build).</summary>
    public static ${SETTINGS} Defaults { get; } = Read(null);

    /// <summary>Lee los barridos del perfil al ARRANCAR.</summary>
    public static ${SETTINGS} From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return Read(configuration);
    }

    private static ${SETTINGS} Read(ServiceConfiguration? configuration) =>
        new(new Dictionary<string, ReconciliationWindow>(StringComparer.Ordinal)
            {
${entries.join('\n')}
            });

    private static int Positive(ServiceConfiguration? configuration, string key, int fallback)
    {
        var value = configuration?.Get(key);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un entero positivo: '{value}'");
    }
}`;
}

// ─── La tienda del reclamo ───────────────────────────────────────────────────────────────────────

function storeBody(model) {
  const table = RECONCILIATION_CLAIM.table;
  return `/// <summary>
/// Quién se lleva cada candidato del barrido de reconciliación: la regla de keel-core (reconciliationClaimReference), la
/// misma que en keel-spring y keel-nest. Sin marca, la inserción es el reclamo; con marca, solo si CADUCÓ
/// (claimed_at &lt;= la caducidad). Y si dos réplicas van a la vez a por el mismo candidato, la clave primaria deja una sola.
/// </summary>
/// <remarks>
/// UNA sentencia: INSERT … ON CONFLICT DO UPDATE … WHERE. Una fila afectada = la marca es mía; cero = otra réplica la tiene
/// viva. No se captura una violación de clave para decidirlo, como en keel-nest: en PostgreSQL un error aborta la
/// transacción entera, y este reclamo va dentro de la de su tanda. Usa el DbContext del ámbito: corre en la transacción
/// que haya abierta, y la marca existe para las demás réplicas cuando esa transacción confirma — ANTES de llamar al
/// proveedor.
/// </remarks>
public sealed class ${STORE}(${dbContextClass(model)} db)
{
    /// <param name="activation">qué encargo se reclama (una entidad puede esperar varios)</param>
    /// <param name="entityId">cuál de ellos</param>
    /// <param name="now">la marca que se estampa</param>
    /// <param name="expiredBefore">por debajo de este instante, un reclamo ajeno ya caducó</param>
    /// <returns>true si el candidato es de esta réplica</returns>
    public async Task<bool> Claim(string activation, Guid entityId, DateTimeOffset now, DateTimeOffset expiredBefore, CancellationToken cancellationToken = default)
    {
        var claimedAt = now.ToUniversalTime();
        var expired = expiredBefore.ToUniversalTime();
        var won = await db.Database.ExecuteSqlAsync(
            $"INSERT INTO ${table} (activation, entity_id, claimed_at) VALUES ({activation}, {entityId}, {claimedAt}) ON CONFLICT (activation, entity_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at WHERE ${table}.claimed_at <= {expired}",
            cancellationToken);
        return won == 1;
    }
}`;
}

// ─── El puerto y el adaptador de la raíz que espera ──────────────────────────────────────────────

const claimsFor = (model, entityName) => (usesRelational(model) ? reconciliationClaims(model).filter((claim) => claim.entity === entityName) : []);

/** El método C# de un reclamo (`claimForReconcileReservationsReserveStock` → `ClaimForReconcileReservationsReserveStock`). */
export function reconciliationMethod(claim) {
  return csMember(claim.method);
}

function describe(claim) {
  return `Reclama los ${claim.entity} que encargaron trabajo a ${claim.dependency}.${claim.activation} y llevan
demasiado tiempo sin desenlace (${claim.awaitingField} más viejo que el umbral que declara el diseño).

Reclama, no lee: corre en TODAS las réplicas a la vez, y la lista son SOLO los candidatos que ESTA se llevó. La marca
es una fila de reconciliation_claim confirmada antes de volver, así que las demás réplicas dejan de verlos; y CADUCA
(claim-timeout-ms), porque sobrevive también a la réplica que muera con el candidato en vuelo.

No recibe el lote: los tres números —umbral, caducidad y cota— salen de config/parameters/<perfil>/reconciliation.yaml
y los lee el adaptador. No cambia el estado. Actúa sobre lo que devuelve FUERA de esta llamada.

Confirma en SU PROPIA transacción, así que no corre dentro de otra: llamarlo con una transacción abierta lanza en vez de
unirse a ella.`;
}

/** Los métodos de reclamo de reconciliación del puerto I<E>Repository. */
export function portReconciliationMethods(model, entity) {
  return claimsFor(model, entity.name).map(
    (claim) => `${xmlDoc(describe(claim).split('\n'), '    ')}    Task<IReadOnlyList<${entity.name}>> ${reconciliationMethod(claim)}(CancellationToken cancellationToken = default);`
  );
}

/** Lo que el constructor del adaptador recibe para reclamar: la tienda y la configuración. */
export function reconciliationDependencies(model, entity) {
  if (claimsFor(model, entity.name).length === 0) return [];
  return [
    { type: SETTINGS, name: 'reconciliation', usings: [] },
    { type: STORE, name: 'reconciliationClaims', usings: [] }
  ];
}

/**
 * Los métodos del adaptador EF Core. Usa `Graph()` y `ToDomain` del propio adaptador, y `RequireOwnTransaction`, que emite
 * claim.js si la raíz tiene además un reclamo de barrido (`ownTransactionHelper` dice si hay que emitirlo aquí).
 */
export function adapterReconciliationMethods(model, entity, { ownTransactionHelper }) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];
  const table = entity.tableName;
  const stateColumn = snakeCase(entity.lifecycle.field);
  const idField = entity.idField?.name ?? 'id';
  const idColumn = snakeCase(idField);
  const idType = entity.idField?.csType ?? 'Guid';
  const idProp = csMember(idField);
  const methods = claims.map((claim) => {
    const states = claim.states.map((state) => `'${screamingSnake(state)}'`).join(', ');
    const awaiting = snakeCase(claim.awaitingField);
    return `    /// <summary>El reclamo del puerto (reconciliación): ver I${entity.name}Repository.${reconciliationMethod(claim)}.</summary>
    public Task<IReadOnlyList<${entity.name}>> ${reconciliationMethod(claim)}(CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(reconciliationMethod(claim))});
        var window = reconciliation.Windows[${csString(claim.activation)}];
        // Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
        var now = DateTimeOffset.UtcNow;
        var unansweredBefore = now.AddSeconds(-window.UnansweredAfterSeconds);
        var claimExpiredBefore = now.AddMilliseconds(-window.ClaimTimeoutMs);
        return transactions.InTransaction<IReadOnlyList<${entity.name}>>(
            async () =>
            {
                // Los candidatos, el que más lleva primero. SKIP LOCKED reparte entre réplicas; quién se queda cada uno lo
                // decide la marca de abajo, no esta consulta. El estado NO se toca. Los que ya tienen una marca VIVA no son
                // candidatos: sin excluirlos, la cabeza de la cola —reclamada y aún sin resolver— ocuparía el lote de cada
                // pasada hasta caducar, y los que esperan detrás no se reconciliarían nunca antes.
                var candidates = await db.Database
                    .SqlQuery<${idType}>($"SELECT e.${idColumn} AS \\"Value\\" FROM ${table} e WHERE e.${stateColumn} IN (${states}) AND e.${awaiting} < {unansweredBefore} AND NOT EXISTS (SELECT 1 FROM ${RECONCILIATION_CLAIM.table} c WHERE c.activation = ${"'"}${claim.activation}${"'"} AND c.entity_id = e.${idColumn} AND c.claimed_at > {claimExpiredBefore}) ORDER BY e.${awaiting} LIMIT {window.BatchSize} FOR UPDATE OF e SKIP LOCKED")
                    .ToListAsync(cancellationToken);
                var claimed = new List<${entity.name}>();
                foreach (var id in candidates)
                {
                    // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
                    if (!await reconciliationClaims.Claim(${csString(claim.activation)}, id, now, claimExpiredBefore, cancellationToken))
                    {
                        continue;
                    }
                    var found = await Graph().AsNoTracking().SingleOrDefaultAsync(r => r.${idProp} == id, cancellationToken);
                    if (found is not null)
                    {
                        claimed.Add(ToDomain(found));
                    }
                }
                return claimed;
            },
            readOnly: false,
            cancellationToken);
    }`;
  });
  if (ownTransactionHelper) {
    methods.push(`    /// <summary>
    /// Un reclamo confirma en SU transacción antes de devolver las filas: dentro de otra se uniría a ella y el reclamo no
    /// existiría para ninguna otra réplica hasta el commit final, así que todas actuarían sobre los mismos candidatos.
    /// </summary>
    private void RequireOwnTransaction(string method)
    {
        if (db.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException(
                $"{method} confirma en su propia transacción y hay una abierta: despacha la operación con DispatchWithoutTransaction (el scheduler ya lo hace).");
        }
    }`);
  }
  return methods;
}
