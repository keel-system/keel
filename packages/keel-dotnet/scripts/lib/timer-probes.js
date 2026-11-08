// La sonda del cronómetro y de los plazos (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 5): los métodos xUnit que
// db-check (relacional) y doc-check (documental) meten en su clase de sondas sobre el par verification-codes. El gemelo de
// keel-nest/scripts/lib/timer-probes.js: los mismos casos, con los mismos ids (keel-core/gen/deadlines.js,
// DEADLINE_CASES), y los mismos sabotajes, cada uno en exactamente sus casos.
//
// Ejecuta lo que build emitió —el rechazo tardío del dominio, el armado del adaptador, el almacén con las sentencias de
// keel-core, el sondeador y el handler del plazo— y no una copia: los nombres salen del MODELO. Lo que escribiría el
// agente —el método semántico de la entidad y el handler de la operación `by`— lo pone la sonda: un método público de
// prueba en la entidad (`timerProbePatch`) y un mediator de prueba que hace lo que haría el handler de `by` (cargar,
// transicionar, guardar), salvo para el id del caso del aparcado.
//
// Los casos van DENTRO de la clase de sondas del sujeto, y no en una clase propia: xUnit ejecuta las clases a la vez, y
// las dos compartirían la base y la tabla keel_timer. Cada método se llama `DL<n>_…` o `R<n>_…`: es lo que lee el
// veredicto de un sabotaje en la salida de `dotnet test`.

import { modelDeadlines, lateGuards, DEADLINE_SABOTAGES } from '@keel-system/keel-core/gen/deadlines';
import { timerStatements, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { LOCK_VERSION } from '@keel-system/keel-core/gen';
import { domainMembers } from '../../src/scaffold/entities.js';
import { csMember, csString, entityPlace, namespaceOf, typeUsings } from '../../src/scaffold/render.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { memberOf } from '../../src/scaffold/enums.js';
import { usesMySql } from '../../src/scaffold/relational-engine.js';
import { deadlineHandlerClass, deadlineMember, deadlinesClass, deadlinesNamespace, purgeKindConstant, purgeTimerClass, scheduleKindConstant, scheduleTimerClass, schedulerClassOf, timerNamespace, usesDeadlines } from '../../src/scaffold/timer.js';
import { usesCorrelation } from '../../src/scaffold/rest-support.js';
import { claimsForEntity, sweepClaims } from '@keel-system/keel-core/gen';
import { claimDrains, timerPurges, timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { usesDocument } from '@keel-system/keel-core/gen/features';
import { sampleState } from './db-probes.js';

/** El sujeto: el primer plazo con rechazo tardío del diseño, con todo lo que la sonda nombra. */
export function timerSubject(model) {
  if (!usesDeadlines(model)) return null;
  const entry = modelDeadlines(model).find(({ entity }) => lateGuards(entity).length > 0) ?? modelDeadlines(model)[0];
  const { entity, deadline, kind } = entry;
  const guard = lateGuards(entity).find((candidate) => candidate.from === deadline.state) ?? null;
  const error = guard ? (model.errors ?? []).find((candidate) => candidate.code === guard.error) : null;
  // El destino de una transición tardía: otro que el de la caducidad, saliendo del estado del plazo.
  const lateTarget = entity.lifecycle.transitions.find((transition) => transition.from === deadline.state)?.to.find((state) => state !== deadline.to) ?? null;
  const operation = (model.services ?? []).flatMap((service) => service.operations ?? []).find((candidate) => candidate.name === deadline.by);
  return { entity, deadline, kind, guard, error, lateTarget, operation };
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────
//
// Rompen lo emitido CONSERVANDO LA FORMA (sigue compilando, sin warnings): [sufijo del archivo, texto o expresión,
// sustituto], por rama. `breaks` son los casos que TIENEN que caer, y solo esos (los ids de keel-core). dl-wrong-field y
// dl-app-clock no tienen sujeto aquí: la fixture solo tiene una marca de tiempo, y la red corre con la instancia y la
// base en la misma máquina.

const GUARD = /if \((\S+ \+ deadlines\.\w+) <= now\)/;
const REVALIDATION = /if \(found is null \|\| found\.\w+ != [\w.]+\)(\s*\{\s*return TimerOutcome\.Finished\(\);\s*\}\s*var due = [^\n]*\n\s*)if \(due > dbNow\)/;

export const TIMER_SABOTAGES = Object.freeze({
  'dl-boundary': {
    relational: ['Domain/Aggregate/', GUARD, 'if ($1 < now)'],
    document: ['Domain/Aggregate/', GUARD, 'if ($1 < now)'],
    breaks: DEADLINE_SABOTAGES['dl-boundary'].breaks
  },
  'dl-no-guard': {
    relational: ['Domain/Aggregate/', GUARD, 'if (now < DateTimeOffset.MinValue)'],
    document: ['Domain/Aggregate/', GUARD, 'if (now < DateTimeOffset.MinValue)'],
    breaks: DEADLINE_SABOTAGES['dl-no-guard'].breaks
  },
  'dl-no-revalidate': {
    relational: ['Deadline.cs', REVALIDATION, 'if (found is null)$1if (due > DateTimeOffset.MaxValue)'],
    document: ['Deadline.cs', REVALIDATION, 'if (found is null)$1if (due > DateTimeOffset.MaxValue)'],
    breaks: DEADLINE_SABOTAGES['dl-no-revalidate'].breaks
  },
  'dl-no-lease': {
    relational: ['Timers/TimerStore.cs', '["leaseMs"] = leaseMs', '["leaseMs"] = 0L'],
    // Sin arriendo, el bucle de FindOneAndUpdate vuelve a llevarse en el MISMO lote lo que acaba de reclamar: cae además
    // DL-5 (en relacional el lote es una sola sentencia y no lo ve). Lo mismo que midieron keel-spring y keel-nest.
    document: ['Timers/TimerStore.cs', 'new BsonInt64(leaseMs)', 'new BsonInt64(0)'],
    breaks: DEADLINE_SABOTAGES['dl-no-lease'].breaks,
    documentBreaks: ['DL-5', ...DEADLINE_SABOTAGES['dl-no-lease'].breaks]
  },
  'dl-outside-tx': {
    // El armado con un contexto NUEVO, en su propia conexión: confirma solo, fuera de la transacción del caso de uso.
    relational: ['Timers/TimerStore.cs', '        await Execute(db, ArmSql, ', '        await using var outside = scopes.CreateAsyncScope();\n        await Execute(Context(outside.ServiceProvider), ArmSql, '],
    // El armado sin la sesión: escribe fuera de la transacción del caso de uso.
    document: ['Timers/TimerStore.cs', 'await Collection.UpdateOneAsync(session, filter, update, Upsert, cancellationToken);', '_ = session;\n            await Collection.UpdateOneAsync(filter, update, Upsert, cancellationToken);'],
    breaks: DEADLINE_SABOTAGES['dl-outside-tx'].breaks
  }
});

export const isTimerSabotage = (id) => Boolean(id && TIMER_SABOTAGES[id]);

/** El sabotaje de una rama: [sufijo, de, a]. */
export function timerSabotage(id, branch) {
  return TIMER_SABOTAGES[id]?.[branch] ?? null;
}

/** Los casos que tienen que caer con el sabotaje en esa rama. */
export function timerSabotageBreaks(id, branch) {
  const spec = TIMER_SABOTAGES[id];
  return [...((branch === 'document' && spec.documentBreaks) || spec.breaks)].sort();
}

/**
 * El veredicto de un sabotaje del cronómetro sobre las líneas en rojo de `dotnet test` de UN sujeto: los ids DL que
 * cayeron (y nada más) contra los esperados. `DL5_…` es DL-5; una prueba que no es del cronómetro cuenta por su nombre.
 */
export function timerSabotageVerdict(failureLines, id, branch) {
  const failed = [
    ...new Set(
      failureLines.map((line) => {
        const match = /\.(DL|R)(\d+)_/.exec(line);
        return match ? `${match[1]}-${match[2]}` : line;
      })
    )
  ].sort();
  const want = timerSabotageBreaks(id, branch);
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── Lo que escribiría el agente ─────────────────────────────────────────────

/**
 * El método semántico de la sonda en la entidad (los de transición son privados): `ProbeTransition(target, now, deadlines)`.
 * Devuelve el archivo parcheado, o lanza si no aplica (un parche que no aplica no puede pasar por bueno).
 */
export function timerProbePatch(model, file) {
  const subject = timerSubject(model);
  if (!subject || typeof file.content !== 'string' || !/\.Domain\//.test(file.path) || !file.path.endsWith(`/${subject.entity.name}.cs`)) return file;
  const { entity, guard } = subject;
  const idType = entity.idField?.csType ?? 'Guid';
  const anchor = `    public ${idType} ${csMember(entity.idField?.name ?? 'id')} { get; private set; }`;
  if (!file.content.includes(anchor)) throw new Error(`timer-probes: el parche de la sonda no aplica en ${file.path}`);
  const enumType = entity.lifecycle.enumType;
  const method = guard
    ? `    /// <summary>Sonda del cronómetro (db-check/doc-check): el método semántico que escribiría el agente.</summary>
    public void ProbeTransition(${enumType} target, DateTimeOffset? now = null, ${deadlinesClass(model)}? deadlines = null)
    {
        if (now is { } at && deadlines is not null)
        {
            TransitionTo(target, at, deadlines);
        }
        else
        {
            TransitionTo(target);
        }
    }

`
    : `    /// <summary>Sonda del cronómetro (db-check/doc-check): el método semántico que escribiría el agente.</summary>
    public void ProbeTransition(${enumType} target) => TransitionTo(target);

`;
  return { ...file, content: file.content.replace(anchor, `${method}${anchor}`) };
}

/** Lo que el contenedor de la sonda registra para el cronómetro: la mecánica, el mediator de prueba y los handlers. */
export function timerFixtureRegistration(model) {
  const subject = timerSubject(model);
  if (!subject) return '';
  const handlers = modelDeadlines(model).map(({ entity, deadline }) => `        services.AddScoped<ITimerHandler, ${deadlineHandlerClass(entity.name, deadline.stateName)}>();`);
  return `
        // El cronómetro (DSL 2.26): la mecánica de la sonda, el mediator que hace lo que escribiría el agente en
        // ${subject.deadline.by} y lo que el sondeador despacha. AddPersistence registra el almacén, los plazos y el reloj.
        services.AddSingleton(${settingsExpr(10)});
        services.AddScoped<IUseCaseMediator, TimerProbeMediator>();
${handlers.join('\n')}
        services.AddScoped<IRecurringTimerHandler, KeelTimerPurge>();`;
}

const settingsExpr = (maxAttempts) => `new TimerSettings(true, 30_000, 50, 60_000, ${maxAttempts}, 0, 7, "0 30 5 * * *")`;

/** Los `using` que necesitan los casos y el mediator. */
export function timerProbeUsings(model) {
  const subject = timerSubject(model);
  if (!subject) return [];
  const { entity, operation, error } = subject;
  return [
    'Microsoft.Extensions.Logging.Abstractions',
    timerNamespace(model),
    deadlinesNamespace(model),
    namespaceOf(model, 'abstractions'),
    namespaceOf(model, operation?.messageKind === 'query' ? 'queries' : 'commands'),
    namespaceOf(model, entityPlace(entity)),
    ...typeUsings(model, [entity.lifecycle.enumType]),
    ...(error ? [namespaceOf(model, 'errors')] : [])
  ];
}

/**
 * Los métodos de los casos DL-1 a DL-10 y R1 (van dentro de la clase de sondas, que declara `root`, `Cancel` e `InScope`)
 * y, aparte, la clase del mediator de prueba. `ctx` es el de las muestras de la clase.
 */
export function timerProbeBlock(model, ctx) {
  const subject = timerSubject(model);
  if (!subject) return null;
  const { entity, deadline, guard, error, lateTarget, operation } = subject;
  const document = usesDocument(model);
  const enumType = entity.lifecycle.enumType;
  const state = (constant) => `${enumType}.${memberOf(model, enumType, constant)}`;
  const status = csMember(entity.lifecycle.field);
  const since = csMember(deadline.since);
  const idProp = csMember(entity.idField?.name ?? 'id');
  const port = portClass(entity);
  const plazo = deadlineMember(entity.name, deadline.stateName);
  const kind = `TimerKinds.${plazo}`;
  const inner = { ...ctx, refs: new Set() };
  const sample = sampleState(model, entity, inner, 'timer1');
  if (inner.refs.size > 0) throw new Error(`timer-probes: ${entity.name} referencia otras raíces (${[...inner.refs].join(', ')}); la sonda no las siembra`);
  const names = [...domainMembers(model, entity).map((member) => member.name), ...(entity.usesOptimisticLocking && !entity.declaresLockVersion ? [LOCK_VERSION.field] : [])];
  const overrides = { [entity.idField?.name ?? 'id']: 'id ?? Guid.CreateVersion7()', [entity.lifecycle.field]: 'status', [deadline.since]: 'since', [LOCK_VERSION.field]: 'null' };
  const assigns = names.map((name) => `            ${csMember(name)} = ${overrides[name] ?? `sample.${csMember(name)}`},`).join('\n');
  const component = [...(operation?.pathParams ?? []), ...(operation?.bodyFields ?? [])][0];
  const store = document
    ? {
        clear: '        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").DeleteManyAsync(new BsonDocument(), Cancel);',
        count: '        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").CountDocumentsAsync(new BsonDocument("kind", kind), cancellationToken: Cancel);',
        fire: `        var now = await TimerDbNow();
        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").UpdateManyAsync(
            new BsonDocument("kind", kind),
            new BsonDocument("$set", new BsonDocument { { "due_at", new BsonDateTime(now.UtcDateTime) }, { "claimed_until", BsonNull.Value }, { "claim_token", BsonNull.Value } }),
            cancellationToken: Cancel);`
      }
    : (() => {
        const context = `${model.service.rootNamespace}DbContext`;
        const engine = usesMySql(model) ? 'mysql' : 'postgresql';
        const fire = timerStatements(engine).fire.replace(':kind', '{0}');
        const alias = usesMySql(model) ? 'AS `Value`' : 'AS \\"Value\\"';
        return {
          clear: `        await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync("DELETE FROM ${KEEL_TIMER.table}", Cancel));`,
          count: `        await InScope(services => services.GetRequiredService<${context}>().Database.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${KEEL_TIMER.table} WHERE kind = {kind}").SingleAsync(Cancel));`,
          fire: `        await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(fire)}, [kind], Cancel));`
        };
      })();
  const thrown = error ? error.exceptionClass : 'InvalidOperationException';
  const domainCases =
    guard && lateTarget
      ? `
    [Fact]
    public async Task DL1_DentroDelPlazoLaTransicionTardiaSale()
    {
        await TimerStart();
        var since = DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var entidad = TimerEntity(${state(deadline.state)}, since);
        entidad.ProbeTransition(${state(lateTarget)}, since + TimerPlazo - TimeSpan.FromMilliseconds(1), TimerDeadlines);
        Assert.Equal(${state(lateTarget)}, entidad.${status});
    }

    [Fact]
    public async Task DL2_EnElInstanteExactoSeRechazaCon${csMember(guard.error.toLowerCase())}()
    {
        await TimerStart();
        var since = DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var entidad = TimerEntity(${state(deadline.state)}, since);
        Assert.Throws<${thrown}>(() => entidad.ProbeTransition(${state(lateTarget)}, since + TimerPlazo, TimerDeadlines));
        Assert.Equal(${state(deadline.state)}, entidad.${status});
    }

    [Fact]
    public async Task DL3_PasadoElPlazoLaCaducidadSaleEnElDominio()
    {
        await TimerStart();
        var since = DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var entidad = TimerEntity(${state(deadline.state)}, since);
        entidad.ProbeTransition(${state(deadline.to)}, since + TimerPlazo + TimeSpan.FromHours(1), TimerDeadlines);
        Assert.Equal(${state(deadline.to)}, entidad.${status});
    }
`
      : '';
  const lateMove = lateTarget
    ? `        await InScope(async services =>
        {
            var repository = services.GetRequiredService<${port}>();
            var found = await repository.FindById(id, Cancel) ?? throw new InvalidOperationException("la entidad no está");
            found.ProbeTransition(${state(lateTarget)}${guard ? `, found.${since}, TimerDeadlines` : ''});
            await repository.Save(found, Cancel);
        });
`
    : '';
  const methods = `    // ═══ El cronómetro y los plazos (DSL 2.26): ${entity.name} en '${deadline.stateName}' ═══

    private static ${deadlinesClass(model)} TimerDeadlines => root.GetRequiredService<${deadlinesClass(model)}>();

    private static TimeSpan TimerPlazo => TimerDeadlines.${plazo};

    private static TimerPoller TimerProbePoller(int maxAttempts = 10) =>
        new(root.GetRequiredService<IServiceScopeFactory>(), ${settingsExpr('maxAttempts')}, root.GetRequiredService<TimerWakeup>(), TimeProvider.System, NullLogger<TimerPoller>.Instance);

    private static ${entity.name} TimerEntity(${enumType} status, DateTimeOffset since, Guid? id = null)
    {
        var sample = ${sample};
        return new ${entity.name}(new ${entity.name}State
        {
${assigns}
        });
    }

    /// <summary>Cada caso arranca con la tabla vacía y sin fallo forzado: los demás casos de la clase también arman.</summary>
    private static async Task TimerStart()
    {
        TimerProbeMediator.FailId = null;
${store.clear}
    }

    private static Task<DateTimeOffset> TimerDbNow() => InScope(services => services.GetRequiredService<ITimerStore>().DbNow(Cancel));

    private static async Task<long> TimerCount(string kind) =>
${store.count}

    private static async Task TimerFire(string kind)
    {
${store.fire}
    }

    /// <summary>Guarda la entidad por el adaptador, que es lo que arma el temporizador.</summary>
    private static async Task<Guid> TimerSave(${enumType} status, DateTimeOffset since)
    {
        var entity = TimerEntity(status, since);
        await InScope(services => services.GetRequiredService<${port}>().Save(entity, Cancel));
        return entity.${idProp};
    }

    /// <summary>Una entidad cuyo plazo venció hace <paramref name="ago"/>, con la hora de la base.</summary>
    private static async Task<Guid> TimerExpired(TimeSpan ago) => await TimerSave(${state(deadline.state)}, await TimerDbNow() - TimerPlazo - ago);

    private static Task<${enumType}?> TimerState(Guid id) => InScope(async services => (await services.GetRequiredService<${port}>().FindById(id, Cancel))?.${status});

    private static Task<IReadOnlyList<ClaimedTimer>> TimerClaim(int limit, long leaseMs) =>
        InScope(services => services.GetRequiredService<ITimerStore>().Claim([${kind}], limit, leaseMs, Guid.NewGuid(), Cancel));
${domainCases}
    [Fact]
    public async Task DL4_ElArmadoVaEnLaTransaccionDeLaEntidad()
    {
        await TimerStart();
        await TimerSave(${state(deadline.state)}, await TimerDbNow());
        Assert.Equal(1, await TimerCount(${kind}));
        var now = await TimerDbNow();
        await Assert.ThrowsAnyAsync<Exception>(() => InScope(services => services.GetRequiredService<PersistenceTransactions>().InTransaction<bool>(
            async () =>
            {
                await services.GetRequiredService<${port}>().Save(TimerEntity(${state(deadline.state)}, now), Cancel);
                throw new InvalidOperationException("revierte");
            },
            false,
            Cancel)));
        Assert.Equal(1, await TimerCount(${kind}));
    }

    [Fact]
    public async Task DL5_ElReclamoSeLlevaLoVencidoEnOrden()
    {
        await TimerStart();
        var antigua = await TimerExpired(TimeSpan.FromMinutes(30));
        var reciente = await TimerExpired(TimeSpan.FromMinutes(5));
        await TimerSave(${state(deadline.state)}, await TimerDbNow());
        var reclamados = await TimerClaim(10, 60_000);
        Assert.Equal(new[] { antigua, reciente }, reclamados.Select(timer => timer.EntityId).ToArray());
    }

    [Fact]
    public async Task DL6_DosReplicasNoReclamanLoMismo()
    {
        await TimerStart();
        for (var i = 0; i < 20; i++)
        {
            await TimerExpired(TimeSpan.FromMinutes(1));
        }
        var lotes = await Task.WhenAll(TimerClaim(20, 60_000), TimerClaim(20, 60_000));
        var vistos = lotes.SelectMany(lote => lote).Select(timer => timer.Id).ToHashSet();
        Assert.Equal(lotes[0].Count + lotes[1].Count, vistos.Count);
        Assert.Equal(20, vistos.Count);
        Assert.Empty(await TimerClaim(20, 60_000));
    }

    [Fact]
    public async Task DL7_VencidoElArriendoOtraReplicaLoRetoma()
    {
        await TimerStart();
        await TimerExpired(TimeSpan.FromMinutes(1));
        Assert.Single(await TimerClaim(10, 400));
        Assert.Empty(await TimerClaim(10, 400));
        await Task.Delay(1_000, Cancel);
        Assert.Single(await TimerClaim(10, 400));
    }

    [Fact]
    public async Task DL8_ElTemporizadorDeUnaEntidadQueYaSalioSeDescarta()
    {
        await TimerStart();
        var id = await TimerExpired(TimeSpan.FromMinutes(1));
${lateMove}        await TimerProbePoller().PollOnce(Cancel);
        Assert.Equal(0, await TimerCount(${kind}));
        Assert.Equal(${state(lateTarget ?? deadline.to)}, await TimerState(id));
    }

    [Fact]
    public async Task DL9_ConElPlazoVigenteSinVencerSeRearma()
    {
        await TimerStart();
        var id = await TimerSave(${state(deadline.state)}, await TimerDbNow());
        await TimerFire(${kind});
        await TimerProbePoller().PollOnce(Cancel);
        Assert.Equal(${state(deadline.state)}, await TimerState(id));
        Assert.Equal(1, await TimerCount(${kind}));
        Assert.Empty(await TimerClaim(10, 60_000));
    }

    [Fact]
    public async Task DL3_VencidoElPlazoElCronometroDespacha()
    {
        await TimerStart();
        var id = await TimerExpired(TimeSpan.FromMinutes(1));
        await TimerProbePoller().PollOnce(Cancel);
        Assert.Equal(${state(deadline.to)}, await TimerState(id));
        Assert.Equal(0, await TimerCount(${kind}));
    }

    [Fact]
    public async Task DL10_ElSondeadorDuermeHastaLoProximo()
    {
        await TimerStart();
        await TimerSave(${state(deadline.state)}, await TimerDbNow() - TimerPlazo + TimeSpan.FromSeconds(5));
        var sondeador = TimerProbePoller();
        var sueno = await sondeador.PollOnce(Cancel);
        Assert.InRange(sueno, 2_001, 5_500);
        await TimerStart();
        Assert.Equal(30_000, await sondeador.PollOnce(Cancel));
        var ahora = DateTimeOffset.UtcNow;
        sondeador.PlanWake(ahora.ToUnixTimeMilliseconds(), 30_000);
        sondeador.OnArmed(ahora.AddSeconds(1));
        Assert.True(sondeador.WakeAtMs <= ahora.ToUnixTimeMilliseconds() + 1_000);
    }

    [Fact]
    public async Task DL10_AgotadosLosIntentosSeAparca()
    {
        await TimerStart();
        var id = await TimerExpired(TimeSpan.FromMinutes(1));
        TimerProbeMediator.FailId = id;
        var sondeador = TimerProbePoller(2);
        var antes = await InScope(services => services.GetRequiredService<ITimerStore>().ParkedCount(Cancel));
        await sondeador.PollOnce(Cancel);
        Assert.Equal(antes, await InScope(services => services.GetRequiredService<ITimerStore>().ParkedCount(Cancel)));
        await sondeador.PollOnce(Cancel);
        Assert.Equal(antes + 1, await InScope(services => services.GetRequiredService<ITimerStore>().ParkedCount(Cancel)));
        Assert.Equal(${state(deadline.state)}, await TimerState(id));
    }

    [Fact]
    public async Task R1_LosRecurrentesSeAseguranUnaSolaVez()
    {
        await TimerStart();
        var sondeador = TimerProbePoller();
        await sondeador.EnsureRecurring(Cancel);
        await sondeador.EnsureRecurring(Cancel);
        Assert.Equal(1, await TimerCount(TimerKinds.TimerPurge));
    }`;
  const commandId = component ? csMember(component.name) : 'Id';
  const classes = `/// <summary>
/// Lo que escribiría el agente en el handler de ${deadline.by}: cargar, transicionar y guardar. El id de <see cref="FailId"/>
/// lanza, para medir el aparcado (DL-10). Va dentro de la transacción del sondeador.
/// </summary>
public sealed class TimerProbeMediator(${port} repository) : IUseCaseMediator
{
    public static Guid? FailId { get; set; }

    public async Task Dispatch(ICommand command, CancellationToken cancellationToken = default)
    {
        var id = command is ${operation.messageClass} message ? message.${commandId} : throw new NotSupportedException(command?.GetType().Name);
        if (id == FailId)
        {
            throw new InvalidOperationException("fallo de prueba del cronómetro");
        }
        var found = await repository.FindById(id, cancellationToken) ?? throw new InvalidOperationException("la entidad no está");
        found.ProbeTransition(${state(deadline.to)});
        await repository.Save(found, cancellationToken);
    }

    public Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => throw new NotSupportedException();

    public Task<TResult> Dispatch<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default) => throw new NotSupportedException();

    public Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default) => Dispatch(command, cancellationToken);

    public Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
}`;
  return { methods, classes };
}

// ─── Las purgas en modo clúster (DSL 2.26, incremento 7) ─────────────────────────────────────────
//
// Antes, TablePurges registraba cada purga en el reloj, que corre en TODAS las réplicas a la vez. Ahora cada una es un
// recurrente del cronómetro (`<Tabla>PurgeTimer`), y la promesa es una sola: cada tick lo ejecuta UNA réplica, la que gana
// su fila en keel_timer. Dos réplicas son dos TimerPoller sobre la misma base; el contenedor de la sonda envuelve cada
// recurrente en `PurgeTimerCount`, que ejecuta la purga de verdad (TablePurges) y cuenta sus ticks: contarlos es contar
// cuántas réplicas ejecutaron cada uno. Los mismos casos que keel-spring (src/lib/purge-timer-probes.js): R1, RC-1 y R2.
//
// El sabotaje es «cada réplica arbitra con su propia fila» en el almacén: el recurrente se asegura con un entity_id nuevo
// en vez del uuid nulo, así que la unicidad (kind, entity_id) ya no lo deduplica. En keel-spring y keel-nest es un kind
// por instancia; aquí no vale, porque el sondeador resuelve los recurrentes del contenedor en cada ámbito y un kind por
// instancia rompería también a UNA réplica.

export const PURGE_TIMER_SABOTAGES = Object.freeze({
  'timer-every-replica': {
    relational: ['Timers/TimerStore.cs', '["entityId"] = TimerKinds.NilEntityId, ["spec"] = spec', '["entityId"] = Guid.NewGuid(), ["spec"] = spec'],
    document: ['Timers/TimerStore.cs', 'new BsonDocument("_id", DocumentId(kind, TimerKinds.NilEntityId)), Pipeline(set)', 'new BsonDocument("_id", DocumentId(kind, Guid.NewGuid())), Pipeline(set)'],
    breaks: ['R-1', 'RC-1']
  },
  // SOLO los `schedule` (inc. 8): su kind deja de ser el suyo en cada resolución, así que su fila no es la que el sondeador
  // reclama ni la que cuenta la sonda. Demuestra que el bloque mide el schedule y no solo las purgas; cae también R-2, que
  // cuenta los ticks por el mismo kind.
  'timer-every-replica-schedule': {
    relational: ['ScheduleTimer.cs', /public string Kind => (TimerKinds\.Schedule\w+);/g, 'public string Kind => $1 + "@" + Guid.NewGuid();'],
    document: ['ScheduleTimer.cs', /public string Kind => (TimerKinds\.Schedule\w+);/g, 'public string Kind => $1 + "@" + Guid.NewGuid();'],
    breaks: ['R-1', 'RC-1', 'R-2']
  }
});

/**
 * Los sabotajes del DRENAJE (inc. 8): el reclamo que no avisa del lote lleno (cae DR-1) y el tick sin tope de tiempo (cae
 * DR-3). Los casos (`DR1_…` a `DR3_…`) los escriben db-probes y doc-probes junto al reclamo de la cola.
 */
export const DRAIN_SABOTAGES = Object.freeze({
  'drain-no-signal': {
    relational: ['Persistence/Repositories/', /^\s*SweepPass\.Claimed\(.*\);\n/m, ''],
    document: ['Persistence/Repositories/', /^\s*SweepPass\.Claimed\(.*\);\n/m, ''],
    breaks: ['DR-1']
  },
  'drain-no-budget': {
    relational: ['ScheduleTimer.cs', ' || Stopwatch.GetElapsedTime(started).TotalMilliseconds >= budget', ''],
    document: ['ScheduleTimer.cs', ' || Stopwatch.GetElapsedTime(started).TotalMilliseconds >= budget', ''],
    breaks: ['DR-3']
  }
});

export const isDrainSabotage = (id) => Boolean(id && DRAIN_SABOTAGES[id]);

/** El veredicto del drenaje: `.DR<n>_` es DR-n; lo demás cuenta por su nombre. */
export function drainSabotageVerdict(failureLines, id) {
  const failed = [...new Set(failureLines.map((line) => {
    const match = /\.DR(\d+)_/.exec(line);
    return match ? `DR-${match[1]}` : line;
  }))].sort();
  const want = [...DRAIN_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/**
 * El sujeto del DRENAJE en una raíz: el reclamo de la cola sobre el cronómetro, la operación, su <Operación>ScheduleTimer y
 * su scheduler, o null.
 */
export function drainSubject(model, root) {
  const queue = claimsForEntity(model, root.name).find((claim) => !claim.stalled && claimDrains(model, claim));
  if (!queue) return null;
  const operation = sweepClaims(model).find((entry) => entry.claim === queue).operation.name;
  return { queue, operation, timer: scheduleTimerClass(operation), scheduler: schedulerClassOf(model, operation), correlated: usesCorrelation(model) };
}

/** Las muestras que gastan los casos DR (lote de 2 en las sondas): 5 + 1 + 6. */
export const DRAIN_SAMPLES = 12;

/** La clase de la sonda del drenaje: un mediator que, en vez de despachar al handler (un stub del agente), ejecuta la pasada. */
export const DRAIN_PROBE_CLASS = `/// <summary>El mediator de los casos DR: cada despacho del scheduler es una pasada que llama al reclamo real.</summary>
public sealed class DrainProbeMediator(Func<Task> pass) : IUseCaseMediator
{
    public int Passes { get; private set; }

    public async Task Dispatch(ICommand command, CancellationToken cancellationToken = default)
    {
        Passes++;
        await pass();
    }

    public Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => throw new NotSupportedException();

    public Task<TResult> Dispatch<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default) => throw new NotSupportedException();

    public Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default) => Dispatch(command, cancellationToken);

    public Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
}`;

/**
 * Los casos DR-1 a DR-3 en C#. `seed(count)` siembra filas en el estado de partida de la cola y devuelve el código que lo
 * hace; `remaining` es la expresión que cuenta las que siguen ahí; `claim` la que reclama por el adaptador real.
 */
export function drainProbes(subject, { seed, remaining, claim }) {
  const scheduler = (mediator) => `new ${subject.scheduler}(${mediator}${subject.correlated ? `, NullLogger<${subject.scheduler}>.Instance` : ''})`;
  const run = (budget) => `            var mediator = new DrainProbeMediator(async () => await ${claim});
            await new ${subject.timer}(${scheduler('mediator')}, TimerSettings.Defaults with { DrainBudgetMs = ${budget} }).Tick(Cancel);`;
  return [
    `    /// <summary>DR-1: con más candidatos que el lote, UN tick los drena todos, en varias pasadas.</summary>
    [Fact]
    public async Task DR1_UnTickDrenaTodoEnVariasPasadas() =>
        await InScope(async services =>
        {
${seed(5)}
${run('60_000')}
            Assert.Equal(0L, ${remaining});
            Assert.Equal(3, mediator.Passes);
        });`,
    `    /// <summary>DR-2: con menos candidatos que el lote, el tick hace una sola pasada.</summary>
    [Fact]
    public async Task DR2_ConElLoteAMediasElTickHaceUnaPasada() =>
        await InScope(async services =>
        {
${seed(1)}
${run('60_000')}
            Assert.Equal(0L, ${remaining});
            Assert.Equal(1, mediator.Passes);
        });`,
    `    /// <summary>DR-3: agotado el presupuesto, el tick para aunque el lote siga saliendo lleno; lo demás, al siguiente.</summary>
    [Fact]
    public async Task DR3_AgotadoElPresupuestoElTickPara() =>
        await InScope(async services =>
        {
${seed(6)}
${run('0')}
            Assert.Equal(1, mediator.Passes);
            Assert.Equal(4L, ${remaining});
        });`
  ];
}

/** Los usings de los casos DR. */
export function drainProbeUsings(model) {
  return [timerNamespace(model), namespaceOf(model, 'scheduling'), namespaceOf(model, 'abstractions'), 'Microsoft.Extensions.Logging.Abstractions'];
}

export const isPurgeTimerSabotage = (id) => Boolean(id && PURGE_TIMER_SABOTAGES[id]);

/** El veredicto sobre las líneas en rojo de UN sujeto: `PT_RC1_…` es RC-1; lo que no es del bloque cuenta por su nombre. */
export function purgeTimerSabotageVerdict(failureLines, id) {
  const failed = [...new Set(failureLines.map((line) => {
    const match = /\.PT_(RC|R)(\d+)_/.exec(line);
    return match ? `${match[1]}-${match[2]}` : line;
  }))].sort();
  const want = [...PURGE_TIMER_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** Lo que el contenedor de la sonda registra: cada recurrente de purga, envuelto en el que cuenta sus ticks. */
export function purgeTimerFixtureRegistration(model) {
  const purges = timerPurges(model);
  const schedules = timerSchedules(model);
  if (purges.length === 0 && schedules.length === 0) return '';
  const lines = purges.map(
    (purge) => `        services.AddScoped<IRecurringTimerHandler>(provider => new PurgeTimerCount(new ${purgeTimerClass(purge.table)}(provider.GetRequiredService<TablePurges>(), provider.GetRequiredService<PurgeSettings>())));`
  );
  // Los `schedule` (inc. 8): su scheduler, con un mediator que no despacha nada (el handler es un stub del agente), y
  // cada <Operación>ScheduleTimer contado igual. Con plazos ya hay mediator de la sonda del cronómetro.
  const schedulers = [...new Set(schedules.map((schedule) => schedulerClassOf(model, schedule.operation)))];
  const scheduleLines = schedules.length === 0
    ? []
    : [
        ...(timerSubject(model) ? [] : ['        services.AddSingleton(TimerSettings.Defaults);', '        services.AddScoped<IUseCaseMediator>(_ => new DrainProbeMediator(() => Task.CompletedTask));']),
        ...schedulers.map((scheduler) => `        services.AddScoped<${scheduler}>();`),
        ...schedules.map(
          (schedule) =>
            `        services.AddScoped<IRecurringTimerHandler>(provider => new PurgeTimerCount(new ${scheduleTimerClass(schedule.operation)}(provider.GetRequiredService<${schedulerClassOf(model, schedule.operation)}>(), provider.GetRequiredService<TimerSettings>())));`
        )
      ];
  return `
        // Los recurrentes en modo clúster (DSL 2.26, incs. 7 y 8): cada uno, contado por PurgeTimerCount.
${[...lines, ...scheduleLines].join('\n')}`;
}

export function purgeTimerProbeUsings(model) {
  if (timerPurges(model).length === 0 && timerSchedules(model).length === 0) return [];
  return [
    timerNamespace(model),
    'Microsoft.Extensions.Logging.Abstractions',
    'System.Collections.Concurrent',
    ...(timerSchedules(model).length > 0 ? [namespaceOf(model, 'scheduling'), namespaceOf(model, 'abstractions')] : [])
  ];
}

/** Los métodos de R1, RC-1 y R2 (dentro de la clase de sondas, que declara `root`, `Cancel` e `InScope`) y la clase que cuenta. */
export function purgeTimerProbeBlock(model) {
  const purges = timerPurges(model);
  const schedules = timerSchedules(model);
  if (purges.length === 0 && schedules.length === 0) return null;
  const document = usesDocument(model);
  const store = document
    ? {
        clear: '        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").DeleteManyAsync(new BsonDocument(), Cancel);',
        count: '        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").CountDocumentsAsync(new BsonDocument("kind", kind), cancellationToken: Cancel);',
        fire: `        var now = await InScope(services => services.GetRequiredService<ITimerStore>().DbNow(Cancel));
        await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").UpdateManyAsync(
            new BsonDocument("kind", kind),
            new BsonDocument("$set", new BsonDocument { { "due_at", new BsonDateTime(now.UtcDateTime) }, { "claimed_until", BsonNull.Value }, { "claim_token", BsonNull.Value } }),
            cancellationToken: Cancel);`
      }
    : (() => {
        const context = `${model.service.rootNamespace}DbContext`;
        const engine = usesMySql(model) ? 'mysql' : 'postgresql';
        const fire = timerStatements(engine).fire.replace(':kind', '{0}');
        const alias = usesMySql(model) ? 'AS `Value`' : 'AS \\"Value\\"';
        return {
          clear: `        await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync("DELETE FROM ${KEEL_TIMER.table}", Cancel));`,
          count: `        await InScope(services => services.GetRequiredService<${context}>().Database.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${KEEL_TIMER.table} WHERE kind = {kind}").SingleAsync(Cancel));`,
          fire: `        await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(fire)}, [kind], Cancel));`
        };
      })();
  const kinds = [
    ...purges.map((purge) => `TimerKinds.${purgeKindConstant(purge.table)}`),
    ...schedules.map((schedule) => `TimerKinds.${scheduleKindConstant(schedule.operation)}`)
  ].join(', ');
  const methods = `    // ═══ Los recurrentes en modo clúster (DSL 2.26, incs. 7 y 8): ${[...purges.map((purge) => purge.table), ...schedules.map((schedule) => schedule.operation)].join(', ')} ═══

    private static readonly string[] PurgeKinds = [${kinds}];

    /// <summary>Una réplica: un sondeador propio sobre la misma base, como un proceso aparte.</summary>
    private static TimerPoller PurgeReplica() =>
        new(root.GetRequiredService<IServiceScopeFactory>(), new TimerSettings(true, 30_000, 50, 60_000, 10, 0, 7, "0 30 5 * * *"), root.GetRequiredService<TimerWakeup>(), TimeProvider.System, NullLogger<TimerPoller>.Instance);

    private static async Task PurgeStart()
    {
        PurgeTimerCount.Ticks.Clear();
${store.clear}
    }

    private static async Task<long> PurgeRows(string kind) =>
${store.count}

    private static async Task PurgeFire(string kind)
    {
${store.fire}
    }

    /// <summary>R1: cada réplica asegura sus recurrentes al arrancar, y dos réplicas no duplican la fila de una purga.</summary>
    [Fact]
    public async Task PT_R1_UnaFilaPorPurgaAunqueLaAsegurenDosReplicas()
    {
        await PurgeStart();
        await PurgeReplica().EnsureRecurring(Cancel);
        await PurgeReplica().EnsureRecurring(Cancel);
        foreach (var kind in PurgeKinds)
        {
            Assert.Equal(1, await PurgeRows(kind));
        }
    }

    /// <summary>RC-1: con dos réplicas sondeando, cada tick de una purga lo ejecuta exactamente una.</summary>
    [Fact]
    public async Task PT_RC1_CadaTickLoEjecutaUnaSolaReplica()
    {
        await PurgeStart();
        var a = PurgeReplica();
        var b = PurgeReplica();
        await a.EnsureRecurring(Cancel);
        await b.EnsureRecurring(Cancel);
        foreach (var kind in PurgeKinds)
        {
            await PurgeFire(kind);
        }
        await a.PollOnce(Cancel);
        await b.PollOnce(Cancel);
        foreach (var kind in PurgeKinds)
        {
            Assert.Equal(1, PurgeTimerCount.Ticks.GetValueOrDefault(kind));
        }
    }

    /// <summary>R2: el tick rearma la purga para su siguiente cron, desde la hora de la base: la misma réplica no la repite ya.</summary>
    [Fact]
    public async Task PT_R2_ElTickRearmaParaElSiguienteCron()
    {
        await PurgeStart();
        var a = PurgeReplica();
        await a.EnsureRecurring(Cancel);
        foreach (var kind in PurgeKinds)
        {
            await PurgeFire(kind);
        }
        await a.PollOnce(Cancel);
        await a.PollOnce(Cancel);
        foreach (var kind in PurgeKinds)
        {
            Assert.Equal(1, PurgeTimerCount.Ticks.GetValueOrDefault(kind));
        }
        var next = await InScope(services => services.GetRequiredService<ITimerStore>().NextDueMs(PurgeKinds, Cancel));
        Assert.True(next is > 0, $"tras el tick la purga no quedó armada para el futuro: {next}");
    }`;
  const classes = `${schedules.length > 0 && !timerSubject(model) ? `${DRAIN_PROBE_CLASS}\n\n` : ''}/// <summary>Un recurrente de la sonda que ejecuta el de verdad y cuenta sus ticks por kind (R1, RC-1 y R2).</summary>
public sealed class PurgeTimerCount(IRecurringTimerHandler inner) : IRecurringTimerHandler
{
    public static ConcurrentDictionary<string, int> Ticks { get; } = new(StringComparer.Ordinal);

    public string Kind => inner.Kind;

    public string Spec => inner.Spec;

    public async Task Tick(CancellationToken cancellationToken)
    {
        await inner.Tick(cancellationToken);
        Ticks.AddOrUpdate(inner.Kind, 1, (_, ticks) => ticks + 1);
    }
}`;
  return { methods, classes };
}
