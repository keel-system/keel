// El RECLAMO de un barrido (incremento 10c): llevarse un lote de filas pendientes de forma que dos réplicas nunca se
// lleven la misma. Es el mismo mecanismo que generan keel-spring y keel-nest, sobre EF Core y PostgreSQL o MySQL (en
// MySQL la transacción del reclamo va en READ COMMITTED: ver relational-engine.js).
//
// Por qué lo genera build y no el agente: el reloj dispara el barrido en TODAS las réplicas, y el camino de menor
// resistencia para quien escribe el handler a mano —leer el lote con un finder por estado y marcarlo después— sale
// verde con una sola instancia y se lo da entero a todas en producción.
//
// Dos capas, como en los otros dos:
//   · llevarse la fila: un UPDATE condicional (`… WHERE id = {id} AND estado IN (…)`). Una fila afectada = es mía;
//     cero = otra réplica llegó antes. La marca es el PROPIO estado de destino del diseño;
//   · elegir a qué filas tirarle: la lectura con FOR UPDATE SKIP LOCKED, para que cada réplica reciba candidatos
//     distintos. Es una optimización: el reclamo es correcto sin ella.
// Y dos sujetos: la COLA (filas que esperan) y el RESCATE de un estado en vuelo (`claim.stalled`), que lleva una cota
// temporal —sin ella, reclamar es arrancarle el trabajo a quien lo está haciendo— y que NO cambia el estado: lo
// ARRIENDA renovando su reloj; la transición la hace el dominio, que fija los campos que exige.
//
// Qué reclama cada barrido, en qué orden y de qué claves salen el lote y el plazo lo decide keel-core
// (`operation.claim[]`, `claimOrderField`, `sweepConfig`). El SQL va LITERAL: la tabla, las columnas y las constantes
// del estado son del generador, y solo los instantes, el lote y el id viajan como parámetro. Ninguno de los tres
// generadores sube la versión del bloqueo optimista en el reclamo.

import { claimOrderField, claimsForEntity, screamingSnake, snakeCase, sweepClaims, sweepConfig } from '@keel-system/keel-core/gen';
import { envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { csFile, csMember, csString, located, xmlDoc } from './render.js';
import { configNamespace } from './config.js';
import { usesPersistence } from './persistence.js';
import { parametersClass, parametersNamespace } from './service-parameters.js';
import { valueAlias } from './relational-engine.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Genera build algún reclamo de barrido? Con persistencia, relacional o documental (incremento 12c). */
export function usesSweepClaims(model) {
  return usesPersistence(model) && sweepClaims(model).length > 0;
}

export function generate(model) {
  if (!usesSweepClaims(model)) return [];
  const { namespace, path } = located(model, 'persistence', 'SweepSettings');
  return [
    { path, content: csFile({ namespace, usings: ['System.Globalization', configNamespace(model)], body: settingsBody(model) }) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/sweep.yaml`, content: sweepYaml(model, profile) }))
  ];
}

/** El MISMO texto que el sweep.yaml de keel-nest. */
export function sweepYaml(model, profile) {
  const lines = ['sweep:'];
  for (const { key, entries } of sweepConfig(model)) {
    lines.push(`  ${key}:`);
    for (const entry of entries) {
      if (entry.kind === 'batch') {
        lines.push(
          '    # Cota del lote por pasada: capacidad, no diseño; misma familia que outbox.relay.batch-size.',
          `    batch-size: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      } else {
        lines.push(
          `    # ${entry.operation.name}: un ${entry.claim.entity} que lleva más de esto en ${entry.claim.stalled.state} (medido sobre`,
          `    # ${entry.claim.stalled.stampField}) se da por abandonado y otra réplica lo rescata. Por ENCIMA de un ciclo completo.`,
          `    stalled-after-seconds: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function settingsBody(model) {
  const config = sweepConfig(model);
  const of = (kind) => config.flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === kind).map((entry) => ({ key, entry })));
  const read = ({ key, entry }) => `                [${csString(key)}] = Positive(configuration, ${csString(`sweep:${key}:${entry.leaf}`)}, ${entry.default}),`;
  return `/// <summary>
/// Los barridos del perfil activo (config/parameters/&lt;perfil&gt;/sweep.yaml), con las claves y los defaults de los servidores
/// de keel-spring y keel-nest.
/// </summary>
/// <param name="BatchSize">La cota del lote de cada barrido, por su clave (<c>sweep.&lt;clave&gt;.batch-size</c>).</param>
/// <param name="StalledAfterSeconds">El plazo de abandono de cada rescate no enlazado a un parámetro (<c>sweep.&lt;clave&gt;.stalled-after-seconds</c>).</param>
public sealed record SweepSettings(IReadOnlyDictionary<string, int> BatchSize, IReadOnlyDictionary<string, int> StalledAfterSeconds)
{
    /// <summary>Los defaults, sin configuración: los de un contenedor que no la tiene (las pruebas de build).</summary>
    public static SweepSettings Defaults { get; } = Read(null);

    /// <summary>Lee los barridos del perfil al ARRANCAR: un valor que no es un entero positivo no deja arrancar.</summary>
    public static SweepSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return Read(configuration);
    }

    private static SweepSettings Read(ServiceConfiguration? configuration) =>
        new(
            new Dictionary<string, int>(StringComparer.Ordinal)
            {
${of('batch').map(read).join('\n')}
            },
            new Dictionary<string, int>(StringComparer.Ordinal)
            {
${of('stalled').map(read).join('\n')}
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

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────

const csMethod = (name) => csMember(name);

/** Los métodos de reclamo del puerto I<E>Repository, con lo que el agente tiene que saber de cada uno. */
export function portClaimMethods(model, entity) {
  return claimsForEntity(model, entity.name).map(
    (claim) =>
      `${xmlDoc(describe(claim, entity.name).split('\n'), '    ')}    Task<IReadOnlyList<${entity.name}>> ${csMethod(claim.method)}(CancellationToken cancellationToken = default);`
  );
}

function describe(claim, entityName) {
  const stamp = claim.stamps
    ? `\n\nDevuelve las filas con ${claim.stamps.field} YA estampado, en el mismo UPDATE que el cambio de estado, porque\n${claim.stamps.reason} consulta esa marca. No la vuelvas a poner desde el handler: una caída entre las dos escrituras\ndejaría la fila con la marca a null, invisible para siempre a quien la busca por antigüedad.`
    : '';
  const own = '\n\nConfirma en SU PROPIA transacción, así que no corre dentro de otra: el scheduler despacha su operación con\nDispatchWithoutTransaction, y llamarlo con una transacción abierta lanza en vez de unirse a ella.';
  if (claim.stalled) {
    const deadline = claim.stalled.parameter
      ? `el parámetro del diseño ${claim.stalled.parameter.name} (en ${claim.stalled.parameter.unit})`
      : `sweep.${claim.stalled.configKey}.stalled-after-seconds`;
    return `Rescata hasta el lote de ${entityName} ATASCADOS en ${claim.stalled.state}: los devuelve SIGUIENDO en ${claim.stalled.state}, con
${claim.stalled.stampField} renovado, para que el handler los pase a ${claim.to}.

Reclama, no lee: corre en TODAS las réplicas, y solo devuelve lo que ESTA se llevó (un UPDATE condicional que
solo casa si la fila sigue atascada, y que renueva el reloj).

No cambia el estado, lo ARRIENDA: la transición a ${claim.to} es del dominio, que fija los campos que ese estado
exige. Si el ciclo muere entre el reclamo y la transición, la fila sigue en ${claim.stalled.state} con el reloj
renovado y otro rescate la recoge pasado el plazo.

Solo se lleva lo ABANDONADO: ${claim.stalled.stampField} más viejo que ${deadline}. Lo que devuelve es trabajo que
alguien dejó a medias: si el ciclo que murió ya produjo un efecto irreversible, repetirlo lo duplica.${stamp}${own}`;
  }
  const due = claim.due ? ` Solo los que ya vencieron (${claim.due.field} <= ahora).` : '';
  return `Reclama hasta el lote de ${entityName} en ${claim.from.join(' o ')} y los pasa a ${claim.to}.${due}

Reclama, no lee: corre en TODAS las réplicas a la vez, y lo que devuelve son SOLO las filas que ESTA se llevó
(el paso a ${claim.to} va en un UPDATE condicional). Leer el lote con un finder y marcarlo después se lo daría
entero a todas. Actúa sobre lo que devuelve FUERA de su transacción.${stamp}${own}`;
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

/** Lo que el constructor del adaptador recibe para sus reclamos: la configuración y, si un rescate lo lee, los parámetros. */
export function claimDependencies(model, entity) {
  const claims = claimsForEntity(model, entity.name);
  if (claims.length === 0 || !usesPersistence(model)) return [];
  const deps = [{ type: 'SweepSettings', name: 'sweeps', usings: [] }];
  if (claims.some((claim) => claim.stalled?.parameter)) deps.push({ type: parametersClass(model), name: 'parameters', usings: [parametersNamespace(model)] });
  return deps;
}

/** Los métodos de reclamo del adaptador EF Core. Usa `Graph()` y `ToDomain` del propio adaptador. */
export function adapterClaimMethods(model, entity) {
  const claims = claimsForEntity(model, entity.name);
  if (claims.length === 0) return [];
  const table = entity.tableName;
  const stateColumn = snakeCase(entity.lifecycle.field);
  const idField = entity.idField?.name ?? 'id';
  const idColumn = snakeCase(idField);
  const idType = entity.idField?.csType ?? 'Guid';
  const idProp = csMember(idField);
  const methods = claims.map((claim) => {
    const states = claim.from.map((state) => `'${screamingSnake(state)}'`).join(', ');
    const order = snakeCase(claimOrderField(entity, claim));
    const setup = [`        var batch = sweeps.BatchSize[${csString(claim.sweepKey)}];`];
    const extra = [];
    if (claim.stalled) {
      const seconds = claim.stalled.parameter
        ? `parameters.${csMember(claim.stalled.parameter.name)} * ${claim.stalled.parameter.unitSeconds}`
        : `sweeps.StalledAfterSeconds[${csString(claim.stalled.configKey)}]`;
      setup.push(
        '        // La cota del rescate: solo lo que lleva atascado más que el plazo. Se calcula UNA vez para la lectura y para',
        '        // cada UPDATE: recalcularla movería la cota entre los dos.',
        `        var staleBefore = DateTimeOffset.UtcNow.AddSeconds(-(${seconds}));`
      );
      extra.push(`${snakeCase(claim.stalled.stampField)} < {staleBefore}`);
    }
    if (claim.due) {
      setup.push(`        // Solo lo que ya venció (${claim.due.field} <= ahora).`, '        var now = DateTimeOffset.UtcNow;');
      extra.push(`${snakeCase(claim.due.field)} <= {now}`);
    }
    // El instante con el que se estampa o se arrienda: uno por tanda.
    if (claim.stamps || claim.stalled) setup.push('        var claimedAt = DateTimeOffset.UtcNow;');
    const where = [`${stateColumn} IN (${states})`, ...extra].join(' AND ');
    const set = claim.stalled
      ? `${snakeCase(claim.stalled.stampField)} = {claimedAt}`
      : `${stateColumn} = '${screamingSnake(claim.to)}'${claim.stamps ? `, ${snakeCase(claim.stamps.field)} = {claimedAt}` : ''}`;
    const what = claim.stalled
      ? `renueva ${claim.stalled.stampField} SOLO si la fila sigue atascada en ${claim.stalled.state}; el estado no se toca`
      : `pasa la fila a ${claim.to} SOLO si sigue en su estado de partida`;
    return `    /// <summary>El reclamo del puerto (${claim.stalled ? 'rescate' : 'cola'}): ver I${entity.name}Repository.${csMethod(claim.method)}.</summary>
    public Task<IReadOnlyList<${entity.name}>> ${csMethod(claim.method)}(CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(csMethod(claim.method))});
${setup.join('\n')}
        return transactions.InTransaction<IReadOnlyList<${entity.name}>>(
            async () =>
            {
                // Los candidatos, del más antiguo al más nuevo. SKIP LOCKED: cada réplica recibe candidatos DISTINTOS en vez
                // de pelearse por la misma página; el bloqueo dura lo que esta transacción, que termina al reclamar.
                var candidates = await db.Database
                    .SqlQuery<${idType}>($"SELECT ${idColumn} ${valueAlias(model)} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT {batch} FOR UPDATE SKIP LOCKED")
                    .ToListAsync(cancellationToken);
                var claimed = new List<${entity.name}>();
                foreach (var id in candidates)
                {
                    // El reclamo: ${what}.
                    // 1 = es mía; 0 = otra réplica la reclamó entre la lectura y esta escritura. Esa comparación es toda la
                    // exclusión mutua.
                    var won = await db.Database.ExecuteSqlAsync($"UPDATE ${table} SET ${set} WHERE ${idColumn} = {id} AND ${where}", cancellationToken);
                    if (won != 1)
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
            cancellationToken,
            PersistenceTransactions.ClaimIsolation);
    }`;
  });
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
  return methods;
}

// ─── La guarda de un efecto que no se deshace (mail.sentBy, adelantada al 12e) ───────────────────
//
// El reclamo de UNA fila concreta para la operación que produce un efecto externo, cuando su ciclo de vida declara un
// estado EN VUELO (`guardClaim` de keel-core, el mismo que leen keel-spring y keel-nest). Existe porque después viene un
// correo, y ningún rollback lo deshace: la marca tiene que existir para todo el mundo ANTES del envío. Una transición en
// memoria no llega a existir hasta el commit del mediator, que cae DESPUÉS del envío; una caída en medio revierte la marca
// y el ciclo siguiente manda un segundo correo a una persona real. Ningún escenario FL-* puede ver esa ventana.

/** Los reclamos de guarda que apuntan a esta entidad (uno por operación que lo declara). */
export function guardClaimsFor(model, entityName) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .map((operation) => operation.guardClaim)
    .filter((claim) => claim && claim.entity === entityName);
}

/** El valor GUARDADO de un estado del ciclo de vida de la entidad: la constante de su enum. */
export function storedState(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle?.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

function describeGuard(claim, entityName) {
  return `Reclama ESTE ${entityName} para ${claim.operation}: lo pasa a ${claim.to} solo si sigue en ${claim.from.join(' o ')}${
    claim.stampField ? `, y estampa ${claim.stampField}` : ''
  }. Devuelve el agregado ya reclamado, o null si otra ejecución llegó antes.

Y CONFIRMA ANTES DE VOLVER (transacción propia, fuera de la del caso de uso). Eso es lo que lo hace una guarda y no una
anotación en memoria: ${claim.operation} produce un efecto externo que NO se deshace, así que la marca tiene que existir
para todo el mundo ANTES de producirlo. Si el proceso cae después del efecto y antes del commit final, la fila se queda en
${claim.to} —lo que busca el rescate— en vez de volver a ${claim.from.join(' o ')} y repetirse.

El null es la carrera perdida: no hay efecto, y se termina como digan las reglas (sin efecto o con el error declarado). No es un caso
excepcional: es el caso normal cuando dos ejecuciones coinciden.`;
}

/** Los métodos de guarda del puerto I<E>Repository. */
export function portGuardMethods(model, entity) {
  const idType = entity.idField?.csType ?? 'Guid';
  return guardClaimsFor(model, entity.name).map(
    (claim) => `${xmlDoc(describeGuard(claim, entity.name).split('\n'), '    ')}    Task<${entity.name}?> ${csMethod(claim.method)}(${idType} id, CancellationToken cancellationToken = default);`
  );
}

/** Lo que el adaptador relacional recibe para sus guardas: los ámbitos, para abrir una transacción que no sea la del caso de uso. */
export function guardDependencies(model, entity) {
  if (guardClaimsFor(model, entity.name).length === 0) return [];
  return [{ type: 'IServiceScopeFactory', name: 'scopes', usings: ['Microsoft.Extensions.DependencyInjection'] }];
}

/** Los métodos de guarda del adaptador EF Core: UPDATE condicional por id y estado, en un ámbito y una transacción propios. */
export function adapterGuardMethods(model, entity, context) {
  const idType = entity.idField?.csType ?? 'Guid';
  const table = entity.tableName;
  const stateColumn = snakeCase(entity.lifecycle?.field ?? 'status');
  return guardClaimsFor(model, entity.name).map((claim) => {
    const states = claim.from.map((state) => `'${storedState(model, entity, state)}'`).join(', ');
    const stamp = claim.stampField ? `, ${snakeCase(claim.stampField)} = {claimedAt}` : '';
    return `    /// <summary>La guarda del puerto: ver I${entity.name}Repository.${csMethod(claim.method)}.</summary>
    public async Task<${entity.name}?> ${csMethod(claim.method)}(${idType} id, CancellationToken cancellationToken = default)
    {
        // En un ámbito y una transacción PROPIOS, y no en la del caso de uso: si la marca esperase a su commit, no existiría
        // para nadie durante el efecto externo, que es justo cuando hace falta.
        await using var scope = scopes.CreateAsyncScope();
        var own = scope.ServiceProvider.GetRequiredService<${context}>();${claim.stampField ? '\n        var claimedAt = DateTimeOffset.UtcNow;' : ''}
        // 1 = esta ejecución se la llevó; 0 = otra llegó antes. Esa comparación en el WHERE es toda la exclusión mutua.
        var won = await scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().InTransaction(
            () => own.Database.ExecuteSqlAsync($"UPDATE ${table} SET ${stateColumn} = '${storedState(model, entity, claim.to)}'${stamp} WHERE id = {id} AND ${stateColumn} IN (${states})", cancellationToken),
            readOnly: false,
            cancellationToken);
        return won == 1 ? await FindById(id, cancellationToken) : null;
    }`;
  });
}

/** Los namespaces que el adaptador necesita para sus reclamos. */
export function claimUsings(model, entity) {
  return claimDependencies(model, entity).flatMap((dep) => dep.usings);
}


