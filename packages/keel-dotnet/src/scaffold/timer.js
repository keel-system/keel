// El cronómetro del servicio y los plazos de negocio (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 5).
//
// Lo neutral —la tabla, sus parámetros, las SENTENCIAS por motor, el `kind` de cada temporizador, la regla del
// vencimiento y el algoritmo del sondeador— está en keel-core/gen (timer-store.js, deadlines.js, timer-poller.js), y es
// contrato de los cuatro servidores: comparten base y esquema. La referencia de lenguaje es keel-spring (su
// `src/scaffold/timer.js`, inc. 3). Aquí solo se escribe en C#, con lo idiomático de keel-dotnet:
//
//   · `<Servicio>Deadlines`, en Domain/Deadline: la duración VIGENTE de cada plazo. El rechazo tardío la necesita y el
//     dominio no lee configuración, así que viaja por argumento, como `<Servicio>Parameters`;
//   · el rechazo tardío (D2), en el método de transición de la entidad (entities.js lo pide con `lateGuardBlock`);
//   · el reloj inyectable es `TimeProvider` (.NET 8+, en el BCL): es el puerto `Clock` del método proyectado a .NET, y el
//     que sustituyen las pruebas (FakeTimeProvider o una subclase). Lo reciben los handlers que sacan una entidad de un
//     estado con plazo, y le dan al dominio `timeProvider.GetUtcNow()`;
//   · el armado, en el `Save` del adaptador, en la transacción del caso de uso (`relationalArming`/`documentArming`);
//   · el almacén (`TimerStore`, detrás de `ITimerStore`): sobre la conexión del DbContext con las sentencias de keel-core
//     TAL CUAL (los marcadores nombrados se traducen en C# como lo hacen `expandList` y `bindNamed`), o sobre MongoDB con
//     su forma documental. La tabla entra en el modelo de EF solo para el esquema (`KeelTimerRow`, el `KeelTimerJpa` de
//     keel-spring): así la crea EF, la lleva el baseline y la nombra el snapshot;
//   · el sondeador (`TimerPoller`): un BackgroundService por réplica que reclama, revalida, despacha y duerme hasta el
//     siguiente vencimiento, y se despierta al armar. Se apaga con `scheduling.enabled` (TIMER_SWITCH);
//   · el despacho de cada plazo (`<Entidad><Estado>Deadline`) y la purga de la propia tabla (R7), el primer recurrente.
//
// Ningún reloj de los que ya existían cambia en este incremento (las purgas, los `schedule` y el relay siguen en
// Scheduling/OutboxRelay; migran en los incrementos 7, 8 y 9). El modo POR RÉPLICA no se emite: su único usuario es el
// relay (inc. 9), y un modo sin sujeto sería código que ninguna red ejecuta.

import { modelDeadlines, usesDeadlines, lateGuards, CLOCK_PORT } from '@keel-system/keel-core/gen/deadlines';
import { TIMER_DATABASES, timerPurges, usesTimer } from '@keel-system/keel-core/gen/timer-plan';
import { pascalCase } from '@keel-system/keel-core/gen';
import {
  KEEL_TIMER,
  NIL_ENTITY_ID,
  TIMER_ENGINES,
  TIMER_PARAMETERS,
  TIMER_PURGE_KIND,
  TIMER_SWITCH,
  CRON_UTC_CASES,
  timerStatements
} from '@keel-system/keel-core/gen/timer-store';
import { envWithDefault, cronWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { parameterValue } from '@keel-system/keel-core/gen/messaging-stores';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { memberOf } from './enums.js';
import { csFile, csMember, csString, declType, entityPlace, located, namespaceOf, solution, typeUsings } from './render.js';
import { configNamespace } from './config.js';
import { usesCorrelation } from './rest-support.js';
import { usesMySql } from './relational-engine.js';
import { tablePurges } from './purge.js';
import { purgeSettingsExpression } from './scheduling-tests.js';
import { usesDocument, usesRelational } from '@keel-system/keel-core/gen/features';

export { usesDeadlines, usesTimer, TIMER_DATABASES };

const PROFILES = ['local', 'develop', 'production', 'test'];

/** `OutboxEventPurgeTimer`: el recurrente que dispara la purga de una tabla del generador (el nombre de keel-spring). */
export function purgeTimerClass(table) {
  return `${pascalCase(table)}PurgeTimer`;
}
/** La constante de `TimerKinds` de la purga de una tabla: `PurgeOutboxEvent`. */
export function purgeKindConstant(table) {
  return `Purge${pascalCase(table)}`;
}

/** Las sentencias del almacén relacional, en el orden en que se emiten: los nombres son los de `timerStatements`. */
export const TIMER_STATEMENTS = Object.freeze(['dbNow', 'arm', 'ensureRecurring', 'claimLock', 'claimMark', 'claimed', 'complete', 'reschedule', 'fail', 'nextDueMs', 'parkedCount', 'purge']);

/** El nombre de la constante C# de una sentencia: `claimLock` → `ClaimLockSql`. */
export const statementConstant = (name) => `${name[0].toUpperCase()}${name.slice(1)}Sql`;

/** La fila de EF de `keel_timer`, solo para el esquema. */
export const KEEL_TIMER_ROW = 'KeelTimerRow';

/**
 * Lo que un diseño con plazos no puede generar con este stack, o []: el cronómetro solo existe donde sus sentencias se
 * midieron (timer-sql-check), `entity_id` es un uuid (un id que no lo es no cabe en la tabla), y el rechazo tardío
 * necesita un `code` con un solo status. Los mismos rechazos que keel-spring (`timerStackErrors`), más el del id.
 */
export function timerStackErrors(model) {
  if (!usesDeadlines(model)) return [];
  const errors = [];
  const database = model.stack?.database ?? (usesDocument(model) ? 'mongodb' : 'postgresql');
  if (!model.layersPresent?.persistence) {
    errors.push('lifecycle.deadlines (DSL 2.26): el cronómetro vive en la base del servicio, y este diseño no tiene capa persistence.');
  } else if (!TIMER_DATABASES.includes(database)) {
    errors.push(
      `lifecycle.deadlines (DSL 2.26): el cronómetro no tiene sentencias medidas para '${database}' ` +
        `(las hay para ${TIMER_DATABASES.join(', ')}). Elige uno de esos motores o genera el diseño sin el plazo.`
    );
  }
  for (const { entity, deadline } of modelDeadlines(model)) {
    const idType = entity.idField?.csType ?? 'Guid';
    if (idType !== 'Guid') {
      errors.push(
        `domain: ${entity.name}.lifecycle.deadlines.${deadline.stateName} (DSL 2.26): el temporizador guarda el id de la entidad en ` +
          `keel_timer.entity_id, que es un uuid, y ${entity.name} tiene un id ${idType}. Declara el id como uuid o genera el diseño sin el plazo.`
      );
    }
  }
  for (const entity of model.entities ?? []) {
    for (const guard of lateGuards(entity)) {
      const error = (model.errors ?? []).find((candidate) => candidate.code === guard.error);
      if (error?.dynamicStatus) {
        errors.push(
          `domain: ${entity.name}.lifecycle.deadlines.${guard.from.toLowerCase()}.lateAction.error (${guard.error}): las operaciones lo ` +
            'declaran con status HTTP distintos, y el rechazo tardío lo lanza el DOMINIO, que no sabe qué operación lo llama. ' +
            'Declara el mismo http en todas.'
        );
      }
    }
  }
  return errors;
}

// ─── Nombres ─────────────────────────────────────────────────────────────────────────────────────

const cap = (name) => name[0].toUpperCase() + name.slice(1);

export function deadlinesClass(model) {
  return `${model.service.className}Deadlines`;
}
export function deadlinesNamespace(model) {
  return namespaceOf(model, 'deadline');
}
export function timerNamespace(model) {
  return namespaceOf(model, 'timer');
}
/** La propiedad de `<Servicio>Deadlines` con la duración de un plazo: `VerificationCodePending`. */
export function deadlineMember(entityName, stateName) {
  return `${entityName}${cap(stateName)}`;
}
/** El handler del cronómetro de un plazo: `VerificationCodePendingDeadline`. */
export function deadlineHandlerClass(entityName, stateName) {
  return `${entityName}${cap(stateName)}Deadline`;
}
/** La constante de `TimerKinds` de un plazo: la misma que la propiedad de los plazos. */
const kindConstant = deadlineMember;

/** El miembro C# del enum del lifecycle para una constante del modelo (`PENDING` → `CodeStatus.Pending`). */
function stateMember(model, entity, constant) {
  return `${entity.lifecycle.enumType}.${memberOf(model, entity.lifecycle.enumType, constant)}`;
}

function sinceField(entity, deadline) {
  return entity.fields.find((field) => field.name === deadline.since);
}

/** El instante desde el que cuenta un plazo como expresión C# sobre un objeto (`found.IssuedAt`). */
function sinceNullable(entity, deadline) {
  const field = sinceField(entity, deadline);
  return Boolean(field && declType(field).endsWith('?'));
}

// ─── El rechazo tardío, en el dominio (lo emite entities.js) ─────────────────────────────────────

/**
 * El método de transición de una entidad con rechazos tardíos, o null si no tiene ninguno. El de un argumento sigue
 * existiendo para las transiciones que no salen de un estado con plazo; para las que sí, se niega: sin la hora no hay
 * rechazo tardío, y callarlo sería confirmar lo que el negocio daba por caducado. `applyTransition` es la guarda de las
 * transiciones de siempre (el cuerpo del TransitionTo sin plazos).
 */
export function lateGuardBlock(model, entity, usings, applyTransition) {
  const guards = lateGuards(entity);
  if (guards.length === 0) return null;
  usings.push(deadlinesNamespace(model));
  const { field } = entity.lifecycle;
  const status = csMember(field);
  const deadlines = entity.lifecycle.deadlines;
  const conditions = guards.map((guard) => `${status} == ${stateMember(model, entity, guard.from)} && target != ${stateMember(model, entity, guard.exempt)}`);
  const checks = guards.map((guard, index) => {
    const deadline = deadlines.find((candidate) => candidate.state === guard.from);
    const error = (model.errors ?? []).find((candidate) => candidate.code === guard.error);
    const thrown = error ? `new ${error.exceptionClass}(${csString(error.when ?? guard.error)})` : `new InvalidOperationException(${csString(guard.error)})`;
    const since = csMember(guard.since);
    const local = `${guard.since}Value`;
    const measured = sinceNullable(entity, deadline)
      ? `            if (${since} is not { } ${local})
            {
                throw new InvalidOperationException(${csString(`${entity.name} en ${deadline.stateName} sin ${guard.since}: el plazo no se puede medir`)});
            }
            if (${local} + deadlines.${deadlineMember(entity.name, deadline.stateName)} <= now)`
      : `            if (${since} + deadlines.${deadlineMember(entity.name, deadline.stateName)} <= now)`;
    return `        // Plazo de '${deadline.stateName}' (DSL 2.26): pasado ${guard.since} + el plazo vigente, salir hacia otro destino que
        // '${deadline.toName}' es ${guard.error}. Vence EN el instante (since + after <= now), no después.
        if (${conditions[index]})
        {
${measured}
            {
                throw ${thrown};
            }
        }`;
  });
  return `    // Guarda interna del lifecycle con el RECHAZO TARDÍO de los plazos (DSL 2.26): la llaman los métodos semánticos,
    // nunca un handler. \`now\` es la hora del reloj inyectable (TimeProvider, el puerto ${CLOCK_PORT.name}) y \`deadlines\` la
    // duración vigente de cada plazo: los dos los recibe el método semántico desde el handler.
    private void TransitionTo(${entity.lifecycle.enumType} target, DateTimeOffset now, ${deadlinesClass(model)} deadlines)
    {
        ArgumentNullException.ThrowIfNull(deadlines);
${checks.join('\n')}
        ApplyTransition(target);
    }

    // Sin la hora: solo para las transiciones que no salen de un estado con plazo hacia otro destino que el suyo.
    private void TransitionTo(${entity.lifecycle.enumType} target)
    {
        if (${conditions.map((condition) => `(${condition})`).join(' || ')})
        {
            throw new InvalidOperationException("Esta transición sale de un estado con plazo: usa TransitionTo(target, now, deadlines)");
        }
        ApplyTransition(target);
    }

    private void ApplyTransition(${entity.lifecycle.enumType} target)
    {
${applyTransition}
    }`;
}

/** ¿Pide esta transición la hora? Para el TODO del método semántico. */
export function transitionNeedsClock(entity, fromConstant, toConstant) {
  return lateGuards(entity).some((guard) => guard.from === fromConstant && guard.exempt !== toConstant);
}

// ─── El armado, en el adaptador (lo usan repositories.js y document-repositories.js) ─────────────

function deadlinesOf(model, entity) {
  return modelDeadlines(model).filter((entry) => entry.entity.name === entity.name);
}

/** Lo que el adaptador de una raíz con plazos recibe además de lo suyo: el almacén y los plazos vigentes. */
export function timerDependencies(model, entity) {
  if (deadlinesOf(model, entity).length === 0) return [];
  return [
    { type: 'ITimerStore', name: 'timers', usings: [timerNamespace(model)] },
    { type: deadlinesClass(model), name: 'deadlines', usings: [deadlinesNamespace(model), ...typeUsings(model, [entity.lifecycle.enumType])] }
  ];
}

/** Las líneas que arman, tras guardar, los plazos en los que `saved` ENTRA (`entering<Estado>` dice si ya estaba). */
function armingLines(model, entity, entering) {
  return deadlinesOf(model, entity).flatMap(({ deadline }) => {
    const since = `saved.${csMember(deadline.since)}`;
    const member = deadlineMember(entity.name, deadline.stateName);
    const due = sinceNullable(entity, deadline) ? `(${since} ?? throw new InvalidOperationException(${csString(`${entity.name} entra en ${deadline.stateName} sin ${deadline.since}`)})) + deadlines.${member}` : `${since} + deadlines.${member}`;
    return [
      `// El plazo de '${deadline.stateName}' se ARMA al entrar, en esta misma transacción: si revierte, no queda.`,
      `if (${entering(deadline)} && saved.${csMember(entity.lifecycle.field)} == ${stateMember(model, entity, deadline.state)})`,
      '{',
      `    await timers.Arm(TimerKinds.${kindConstant(entity.name, deadline.stateName)}, saved.${csMember(entity.idField?.name ?? 'id')}, ${due}, cancellationToken);`,
      '}'
    ];
  });
}

/**
 * El armado del adaptador relacional, o null: `previous` es la línea que declara `previousState` (lo que la fila tenía
 * ANTES de volcar el agregado; null si es nueva), y `after` las que arman tras el SaveChanges, con `saved`.
 */
export function relationalArming(model, entity) {
  if (deadlinesOf(model, entity).length === 0) return null;
  const enumType = entity.lifecycle.enumType;
  return {
    declare: `${enumType}? previousState = null;`,
    capture: `previousState = row.${csMember(entity.lifecycle.field)};`,
    after: armingLines(model, entity, (deadline) => `previousState != ${stateMember(model, entity, deadline.state)}`)
  };
}

/**
 * El armado del adaptador documental, o null: el estado que el documento tenía en la base se lee ANTES de escribirlo,
 * en la sesión del caso de uso (`before`), y se compara con la CONSTANTE guardada.
 */
export function documentArming(model, entity, storedState) {
  const entries = deadlinesOf(model, entity);
  if (entries.length === 0) return null;
  const key = documentShape(model, entity).find((entry) => entry.member === entity.lifecycle.field)?.name ?? snakeCase(entity.lifecycle.field);
  return {
    before: [
      '// El estado que el documento tenía en la base dice si la entidad ENTRA en un estado con plazo (salir no cuesta nada).',
      `var previous = await Collection.Find(session, new BsonDocument("_id", id)).Project(new BsonDocument(${csString(key)}, 1)).FirstOrDefaultAsync(cancellationToken);`,
      `var previousState = previous is null ? BsonNull.Value : previous.GetValue(${csString(key)}, BsonNull.Value);`
    ],
    after: armingLines(model, entity, (deadline) => `previousState is not BsonString { Value: ${csString(storedState(model, entity, deadline.stateName))} }`)
  };
}

// ─── El registro (lo usan persistence-runtime.js, document-persistence.js y api.js) ─────────────

/** La línea de AddPersistence que registra lo que el armado necesita (el almacén, los plazos y el reloj). */
export function persistenceTimerRegistration(model) {
  if (!usesTimer(model)) return null;
  return {
    usings: [timerNamespace(model)],
    line: '        // El cronómetro (DSL 2.26): el adaptador arma los plazos con él, en la transacción del caso de uso.\n        services.AddTimerStore();'
  };
}

/** Lo que Program.cs registra: el sondeador, los handlers y la mecánica del perfil. */
export function programTimer(model) {
  if (!usesTimer(model)) return { usings: [], registration: '' };
  return {
    usings: [timerNamespace(model)],
    registration: `
// El cronómetro del servicio (DSL 2.26): un sondeador por réplica sobre keel_timer, con la mecánica del perfil (timer.yaml)
// y su interruptor, scheduling.enabled (TimerRegistration, generado).
builder.Services.AddTimer(TimerSettings.From(configuration));`
  };
}

// ─── Lo que emite build ──────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesTimer(model)) return [];
  const timer = (name, usings, body) => {
    const { namespace, path } = located(model, 'timer', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const document = usesDocument(model);
  const deadline = located(model, 'deadline', deadlinesClass(model));
  const files = [
    ...(usesDeadlines(model) ? [{ path: deadline.path, content: csFile({ namespace: deadline.namespace, usings: [], body: deadlinesBody(model) }) }] : []),
    timer('TimerKinds', [], timerKindsBody(model)),
    timer('ClaimedTimer', [], claimedTimerBody()),
    timer('TimerOutcome', [], timerOutcomeBody()),
    timer('ITimerHandler', [], timerHandlerBody()),
    timer('TimerWakeup', [], timerWakeupBody()),
    timer('ITimerStore', [], timerStoreInterfaceBody()),
    timer('TimerSettings', ['System.Globalization', 'Cronos', configNamespace(model)], timerSettingsBody()),
    document
      ? timer('TimerStore', ['MongoDB.Bson', 'MongoDB.Driver', namespaceOf(model, 'persistence')], documentStoreBody())
      : timer(
          'TimerStore',
          ['System.Data.Common', 'System.Globalization', 'System.Text.RegularExpressions', 'Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Storage', 'Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'persistence')],
          relationalStoreBody(model)
        ),
    timer('TimerPoller', ['Cronos', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging', namespaceOf(model, 'persistence')], pollerBody()),
    timer('KeelTimerPurge', [], purgeBody()),
    ...timerPurges(model).map((purge) => timer(purgeTimerClass(purge.table), [namespaceOf(model, 'purge')], purgeTimerBody(model, purge))),
    timer('TimerRegistration', registrationUsings(model), registrationBody(model)),
    ...modelDeadlines(model).map((entry) => timer(deadlineHandlerClass(entry.entity.name, entry.deadline.stateName), handlerUsings(model, entry), deadlineHandlerBody(model, entry))),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/timer.yaml`, content: timerYaml(profile) })),
    timerTestsFile(model)
  ];
  if (usesRelational(model)) files.push(keelTimerRowFile(model));
  return files;
}

// ─── El dominio ──────────────────────────────────────────────────────────────────────────────────

function deadlinesBody(model) {
  const entries = modelDeadlines(model);
  const params = entries.map(({ entity, deadline }) => `TimeSpan ${deadlineMember(entity.name, deadline.stateName)[0].toLowerCase()}${deadlineMember(entity.name, deadline.stateName).slice(1)}`);
  const assigns = entries.map(({ entity, deadline }) => {
    const member = deadlineMember(entity.name, deadline.stateName);
    const param = `${member[0].toLowerCase()}${member.slice(1)}`;
    return `        ${member} = ${param} > TimeSpan.Zero
            ? ${param}
            : throw new ArgumentOutOfRangeException(nameof(${param}), ${param}, ${csString(`El plazo de ${entity.name}.${deadline.stateName} tiene que ser positivo`)});`;
  });
  const properties = entries.map(
    ({ entity, deadline }) => `    /// <summary>Cuánto puede seguir un ${entity.name} en '${deadline.stateName}', contado desde ${deadline.since}.</summary>
    public TimeSpan ${deadlineMember(entity.name, deadline.stateName)} { get; }`
  );
  return `/// <summary>
/// La duración VIGENTE de cada plazo de negocio del servicio (DSL 2.26, <c>lifecycle.deadlines</c>).
/// </summary>
/// <remarks>
/// Value object de dominio, como <c>${model.service.className}Parameters</c>: el rechazo tardío del método de transición la
/// necesita y el dominio no lee configuración. Lo puebla TimerRegistration, y lo usan con el MISMO valor el dominio (el
/// rechazo), el adaptador (el armado) y el cronómetro (la revalidación): cambiar el plazo en un despliegue no reescribe los
/// temporizadores armados, los corrige la revalidación (T6). Un plazo que no es positivo no deja arrancar.
/// </remarks>
public sealed class ${deadlinesClass(model)}
{
    public ${deadlinesClass(model)}(${params.join(', ')})
    {
${assigns.join('\n')}
    }

${properties.join('\n\n')}
}`;
}

// ─── Las piezas del cronómetro ───────────────────────────────────────────────────────────────────

function timerKindsBody(model) {
  const constants = [
    ...modelDeadlines(model).map(
      ({ entity, deadline, kind }) => `    /// <summary>El plazo de ${entity.name} en '${deadline.stateName}'.</summary>
    public const string ${kindConstant(entity.name, deadline.stateName)} = ${csString(kind)};`
    ),
    `    /// <summary>La purga de la propia tabla: un recurrente en modo clúster (R7).</summary>
    public const string TimerPurge = ${csString(TIMER_PURGE_KIND)};`,
    ...timerPurges(model).map(
      (purge) => `    /// <summary>La purga de <c>${purge.table}</c>: un recurrente en modo clúster.</summary>
    public const string ${purgeKindConstant(purge.table)} = ${csString(purge.kind)};`
    )
  ];
  return `/// <summary>
/// El nombre de cada temporizador en <c>${KEEL_TIMER.table}</c> (columna <c>kind</c>). Es contrato con los otros generadores
/// —comparten tabla—, así que sale de keel-core y no se cambia aquí.
/// </summary>
public static class TimerKinds
{
${constants.join('\n\n')}

    /// <summary>El <c>entity_id</c> de un recurrente: no tiene entidad, y la unicidad (kind, entity_id) necesita un valor.</summary>
    public static readonly Guid NilEntityId = Guid.Parse(${csString(NIL_ENTITY_ID)});
}`;
}

function claimedTimerBody() {
  return `/// <summary>
/// Un temporizador que ESTA réplica reclamó: lo es mientras dure su arriendo, y todo lo que se haga con él lleva la valla
/// (<c>claim_token</c>) con la que se reclamó.
/// </summary>
/// <param name="Id">Su identidad en la tabla (el uuid en texto, o el <c>_id</c> documental <c>kind|entity_id</c>).</param>
/// <param name="Kind">Qué es: un plazo o un recurrente (TimerKinds).</param>
/// <param name="EntityId">La entidad de un plazo; el uuid nulo en un recurrente.</param>
/// <param name="DueAt">Cuándo vencía.</param>
/// <param name="Attempts">Cuántas veces falló ya.</param>
public sealed record ClaimedTimer(string Id, string Kind, Guid EntityId, DateTimeOffset DueAt, int Attempts);`;
}

function timerOutcomeBody() {
  return `/// <summary>El desenlace de un temporizador: borrarlo, o rearmarlo para otro vencimiento.</summary>
public readonly record struct TimerOutcome(bool Done, DateTimeOffset? DueAt)
{
    /// <summary>Cumplido o descartado: se borra.</summary>
    public static TimerOutcome Finished() => new(true, null);

    /// <summary>Un recurrente tras su tick, o un plazo que la revalidación aplaza.</summary>
    public static TimerOutcome RescheduleAt(DateTimeOffset dueAt) => new(false, dueAt);
}`;
}

function timerHandlerBody() {
  return `/// <summary>
/// Lo que hace el cronómetro con los temporizadores de un <c>kind</c>. Corre DENTRO de la transacción en la que el
/// sondeador borra o rearma el temporizador: si lanza, la transacción revierte, el fallo se cuenta y, al agotar los
/// intentos, el temporizador se aparca (T5).
/// </summary>
public interface ITimerHandler
{
    string Kind { get; }

    /// <summary><paramref name="dbNow"/> es la hora de la BASE (T1): la única que compara el cronómetro.</summary>
    Task<TimerOutcome> Handle(ClaimedTimer timer, DateTimeOffset dbNow, CancellationToken cancellationToken);
}

/// <summary>
/// Un temporizador RECURRENTE en modo clúster: una fila sin entidad, que cada réplica asegura al arrancar (R1) y que en cada
/// tick ejecuta UNA sola réplica, la que la reclama. El siguiente tick lo calcula el sondeador desde la hora de la base de
/// DESPUÉS del tick (R2), con el cron en UTC (T7).
/// </summary>
/// <remarks>
/// El tick corre FUERA de toda transacción, a diferencia de un plazo: un recurrente (una purga por lotes) gestiona las suyas,
/// y envolverlo en una sola volvería a ser el DELETE único que la purga por lotes sustituye. Si lanza, cuenta como un fallo
/// del temporizador, igual que un plazo.
/// </remarks>
public interface IRecurringTimerHandler
{
    /// <summary>El nombre del temporizador en la tabla (TimerKinds).</summary>
    string Kind { get; }

    /// <summary>El cron de seis campos (el segundo primero), evaluado en UTC.</summary>
    string Spec { get; }

    /// <summary>Un tick: lo que hace el mecanismo cada vez que vence.</summary>
    Task Tick(CancellationToken cancellationToken);
}`;
}

function timerWakeupBody() {
  return `/// <summary>
/// El aviso de que ESTA réplica armó un temporizador, tras el commit de la transacción que lo armó: el sondeador lo escucha y,
/// si vence antes de lo que pensaba dormir, despierta. Así un plazo corto no espera al tope del sueño.
/// </summary>
public sealed class TimerWakeup
{
    private readonly List<Action<DateTimeOffset>> listeners = [];
    private readonly Lock gate = new();

    /// <summary>Lo llama el sondeador al construirse.</summary>
    public void Subscribe(Action<DateTimeOffset> listener)
    {
        ArgumentNullException.ThrowIfNull(listener);
        lock (gate)
        {
            listeners.Add(listener);
        }
    }

    /// <summary>Lo llama el almacén tras el commit del armado.</summary>
    public void Notify(DateTimeOffset dueAt)
    {
        Action<DateTimeOffset>[] current;
        lock (gate)
        {
            current = [.. listeners];
        }
        foreach (var listener in current)
        {
            listener(dueAt);
        }
    }
}`;
}

function timerStoreInterfaceBody() {
  return `/// <summary>
/// La tabla del cronómetro (<c>${KEEL_TIMER.table}</c>), detrás de un puerto: las sentencias son las de keel-core, iguales en los
/// cuatro generadores, y la hora que comparan es SIEMPRE la de la base (T1).
/// </summary>
public interface ITimerStore
{
    /// <summary>La hora de la base.</summary>
    Task<DateTimeOffset> DbNow(CancellationToken cancellationToken = default);

    /// <summary>Arma un plazo (o lo rearma si ya existía), en la transacción en curso.</summary>
    Task Arm(string kind, Guid entityId, DateTimeOffset dueAt, CancellationToken cancellationToken = default);

    /// <summary>Asegura la fila de un recurrente: la crea, o recalcula su vencimiento si su spec cambió (R1).</summary>
    Task EnsureRecurring(string kind, string spec, DateTimeOffset dueAt, CancellationToken cancellationToken = default);

    /// <summary>Reclama lo vencido y libre de esos kinds, en orden de vencimiento, con arriendo y valla. Confirma antes de volver.</summary>
    Task<IReadOnlyList<ClaimedTimer>> Claim(IReadOnlyList<string> kinds, int limit, long leaseMs, Guid token, CancellationToken cancellationToken = default);

    /// <summary>Borra un temporizador, solo si sigue siendo de quien lo reclamó.</summary>
    Task<bool> Complete(string id, Guid token, CancellationToken cancellationToken = default);

    /// <summary>Lo rearma, libre y con los intentos a cero, solo con la valla.</summary>
    Task<bool> Reschedule(string id, Guid token, DateTimeOffset dueAt, CancellationToken cancellationToken = default);

    /// <summary>Cuenta un fallo; tras el retraso se reintenta y, al agotar los intentos, se aparca.</summary>
    Task<bool> Fail(string id, Guid token, int maxAttempts, long retryDelayMs, CancellationToken cancellationToken = default);

    /// <summary>Cuántos milisegundos faltan para lo próximo reclamable de esos kinds (null: nada; puede ser negativo).</summary>
    Task<long?> NextDueMs(IReadOnlyList<string> kinds, CancellationToken cancellationToken = default);

    /// <summary>Los aparcados.</summary>
    Task<long> ParkedCount(CancellationToken cancellationToken = default);

    /// <summary>La purga de la tabla: vencido hace más de la retención y sin reclamar (R4, R7).</summary>
    Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default);
}`;
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

/** Los parámetros del cronómetro, en el orden en que salen en `config/parameters/<perfil>/timer.yaml` (el de keel-spring). */
export const TIMER_CONFIG_PARAMETERS = Object.freeze([
  TIMER_PARAMETERS.maxSleepMs,
  TIMER_PARAMETERS.batchSize,
  TIMER_PARAMETERS.leaseMs,
  TIMER_PARAMETERS.maxAttempts,
  TIMER_PARAMETERS.retryDelayMs,
  TIMER_PARAMETERS.retentionDays,
  TIMER_PARAMETERS.purgeCron
]);

function parameterLine(profile, parameter) {
  const segments = parameter.key.split('.');
  const value = parameterValue(parameter, profile);
  const rendered = parameter.cron ? cronWithDefault(profile, parameter.env, value) : envWithDefault(profile, parameter.env, value);
  return `${'  '.repeat(segments.length - 1)}${segments.at(-1)}: ${rendered}`;
}

/**
 * config/parameters/&lt;perfil&gt;/timer.yaml: la mecánica del cronómetro (keel-core/gen/timer-store.js, la misma clave y
 * variable en los cuatro generadores) y su interruptor, `scheduling.enabled`, que en `test` va apagado. El MISMO texto que el
 * timer.yaml de keel-spring (lo compara test/timer.test.js).
 */
export function timerYaml(profile) {
  const lines = [
    '# El cronómetro del servicio (DSL 2.26): un sondeador por réplica sobre la tabla keel_timer.',
    '# Mecánica del generador, no contrato: el rechazo tardío lo hace el dominio en el instante exacto.',
    'timer:'
  ];
  let parent = null;
  for (const parameter of TIMER_CONFIG_PARAMETERS) {
    const segments = parameter.key.split('.');
    if (segments.length === 3 && parent !== segments[1]) {
      parent = segments[1];
      lines.push(`  ${parent}:`);
    }
    lines.push(parameterLine(profile, parameter));
  }
  const [root, leaf] = TIMER_SWITCH.key.split('.');
  lines.push(`${root}:`, `  ${leaf}: ${profile === 'test' ? 'false' : envWithDefault(profile, TIMER_SWITCH.env, TIMER_SWITCH.default)}`);
  return `${lines.join('\n')}\n`;
}

const configKey = (key) => key.replaceAll('.', ':');

function timerSettingsBody() {
  const P = TIMER_PARAMETERS;
  const read = (parameter) => `Positive(configuration, ${csString(configKey(parameter.key))}, ${parameter.default})`;
  return `/// <summary>
/// La mecánica del cronómetro del perfil activo (config/parameters/&lt;perfil&gt;/timer.yaml), con las claves, las variables y los
/// defaults de keel-core (los mismos en los cuatro servidores), y su interruptor, <c>${TIMER_SWITCH.key}</c>.
/// </summary>
/// <param name="Enabled">¿Sondea esta réplica? Apagado, los temporizadores se siguen ARMANDO (es persistencia); lo que deja de haber es quien los dispare.</param>
/// <param name="MaxSleepMs">Cuánto duerme como mucho sin plazos próximos: lo que tarda en ver lo que arma OTRA réplica.</param>
/// <param name="BatchSize">Cuántos temporizadores reclama por pasada.</param>
/// <param name="LeaseMs">El arriendo de lo reclamado: mayor que lo que tarda un lote (T4).</param>
/// <param name="MaxAttempts">Fallos tras los que un temporizador se aparca (T5).</param>
/// <param name="RetryDelayMs">Tras un fallo, cuándo se vuelve a intentar.</param>
/// <param name="RetentionDays">La purga de la tabla se lleva lo vencido hace más que esto y sin reclamar.</param>
/// <param name="PurgeCron">Cuándo corre esa purga: seis campos, en UTC (T7).</param>
public sealed record TimerSettings(bool Enabled, long MaxSleepMs, int BatchSize, long LeaseMs, int MaxAttempts, long RetryDelayMs, int RetentionDays, string PurgeCron)
{
    /// <summary>Los defaults de keel-core, sin configuración (las pruebas que montan el contenedor).</summary>
    public static TimerSettings Defaults { get; } =
        new(${TIMER_SWITCH.default ? 'true' : 'false'}, ${P.maxSleepMs.default}, ${P.batchSize.default}, ${P.leaseMs.default}, ${P.maxAttempts.default}, ${P.retryDelayMs.default}, ${P.retentionDays.default}, ${csString(P.purgeCron.default)});

    /// <summary>Lee el perfil al ARRANCAR: un valor que no es un entero positivo, o un cron inválido, no deja arrancar.</summary>
    public static TimerSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var cron = configuration.Get(${csString(configKey(P.purgeCron.key))});
        cron = string.IsNullOrWhiteSpace(cron) ? ${csString(P.purgeCron.default)} : cron.Trim();
        try
        {
            CronExpression.Parse(cron, CronFormat.IncludeSeconds);
        }
        catch (CronFormatException error)
        {
            throw new InvalidOperationException($"${P.purgeCron.key} no es un cron de seis campos: '{cron}'", error);
        }
        return new TimerSettings(
            Switch(configuration.Get(${csString(configKey(TIMER_SWITCH.key))})),
            ${read(P.maxSleepMs)},
            (int)${read(P.batchSize)},
            ${read(P.leaseMs)},
            (int)${read(P.maxAttempts)},
            ${read(P.retryDelayMs)},
            (int)${read(P.retentionDays)},
            cron);
    }

    private static bool Switch(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return ${TIMER_SWITCH.default ? 'true' : 'false'};
        }
        return value.Trim().ToLowerInvariant() switch
        {
            "true" => true,
            "false" => false,
            _ => throw new InvalidOperationException($"${TIMER_SWITCH.key} tiene que ser true o false: '{value}'")
        };
    }

    private static long Positive(ServiceConfiguration configuration, string key, long fallback)
    {
        var value = configuration.Get(key);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0 && parsed <= int.MaxValue
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un entero positivo: '{value}'");
    }
}`;
}

// ─── El almacén relacional: las sentencias de keel-core, tal cual ────────────────────────────────

/** Las sentencias del motor del diseño, con el nombre de su constante C#: lo que compara test/timer.test.js. */
export function relationalStatements(model) {
  const engine = usesMySql(model) ? 'mysql' : 'postgresql';
  const sql = timerStatements(engine);
  return TIMER_STATEMENTS.map((name) => ({ name, constant: statementConstant(name), sql: sql[name] }));
}

function relationalStoreBody(model) {
  const mysql = usesMySql(model);
  const context = `${model.service.rootNamespace}DbContext`;
  const constants = relationalStatements(model)
    .map(({ name, constant, sql }) => `    /// <summary><c>${name}</c> de keel-core.</summary>\n    private const string ${constant} = ${csString(sql)};`)
    .join('\n\n');
  return `/// <summary>
/// El cronómetro sobre ${mysql ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core (<c>timer-store.js</c>) TAL CUAL: son contrato
/// con los otros generadores, que comparten la tabla, y las mide <c>timer-sql-check</c> contra el motor. No las reescribas aquí.
/// </summary>
/// <remarks>
/// <para>
/// Va por la conexión del DbContext del ámbito y no por LINQ: las sentencias usan la hora de la base, <c>FOR UPDATE SKIP
/// LOCKED</c> y el upsert de cada motor, que EF no dice. Sobre la MISMA conexión y la MISMA transacción que EF, así que el
/// armado entra en la transacción del caso de uso. Los marcadores nombrados (<c>:id</c>) se traducen aquí a los del driver
/// (${mysql ? '<c>?</c> de MySqlConnector' : '<c>$1</c> de Npgsql'}), con las mismas reglas que <c>expandList</c> y <c>bindNamed</c> de keel-core.
/// </para>
/// <para>
/// El reclamo son tres sentencias en UNA transacción PROPIA (un ámbito, un contexto y una conexión nuevos): confirma antes de
/// volver, así que las demás réplicas dejan de ver el lote aunque quien llama tarde en procesarlo.
/// </para>
/// </remarks>
public sealed partial class TimerStore(${context} db, IServiceScopeFactory scopes, PersistenceTransactions transactions, TimerWakeup wakeup) : ITimerStore
{
${constants}

    public async Task<DateTimeOffset> DbNow(CancellationToken cancellationToken = default) =>
        ReadTime(await Scalar(db, DbNowSql, [], cancellationToken));

    public async Task Arm(string kind, Guid entityId, DateTimeOffset dueAt, CancellationToken cancellationToken = default)
    {
        // En la transacción en curso, la del caso de uso que guarda la entidad: si revierte, el temporizador no queda.
        await Execute(db, ArmSql, new() { ["id"] = Guid.CreateVersion7(), ["kind"] = kind, ["entityId"] = entityId, ["spec"] = null, ["dueAt"] = dueAt }, cancellationToken);
        // El sondeador de ESTA réplica lo sabe tras el commit: si vence antes de lo que pensaba dormir, despierta.
        transactions.AfterCommit(() =>
        {
            wakeup.Notify(dueAt);
            return Task.CompletedTask;
        });
    }

    public async Task EnsureRecurring(string kind, string spec, DateTimeOffset dueAt, CancellationToken cancellationToken = default) =>
        await Execute(db, EnsureRecurringSql, new() { ["id"] = Guid.CreateVersion7(), ["kind"] = kind, ["entityId"] = TimerKinds.NilEntityId, ["spec"] = spec, ["dueAt"] = dueAt }, cancellationToken);

    public async Task<IReadOnlyList<ClaimedTimer>> Claim(IReadOnlyList<string> kinds, int limit, long leaseMs, Guid token, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(kinds);
        await using var scope = scopes.CreateAsyncScope();
        var own = Context(scope.ServiceProvider);
        return await scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().InTransaction(
            () => OnConnection<IReadOnlyList<ClaimedTimer>>(
                own,
                async () =>
                {
                    // 1. Los candidatos, bloqueados saltándose los bloqueados: dos réplicas toman lotes disjuntos.
                    var ids = new List<object>();
                    await using (var command = Command(own, ClaimLockSql, new() { ["kinds"] = new Many([.. kinds]), ["limit"] = limit }))
                    await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
                    {
                        while (await reader.ReadAsync(cancellationToken))
                        {
                            ids.Add(reader.GetGuid(0));
                        }
                    }
                    if (ids.Count == 0)
                    {
                        return [];
                    }
                    // 2. El arriendo y la valla.
                    await using (var mark = Command(own, ClaimMarkSql, new() { ["leaseMs"] = leaseMs, ["token"] = token, ["ids"] = new Many(ids) }))
                    {
                        await mark.ExecuteNonQueryAsync(cancellationToken);
                    }
                    // 3. Lo que ESTA réplica reclamó, por su valla.
                    var claimed = new List<ClaimedTimer>();
                    await using (var command = Command(own, ClaimedSql, new() { ["token"] = token }))
                    await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
                    {
                        while (await reader.ReadAsync(cancellationToken))
                        {
                            claimed.Add(new ClaimedTimer(reader.GetGuid(0).ToString("D"), reader.GetString(1), reader.GetGuid(2), ReadTime(reader.GetValue(4)), reader.GetInt32(7)));
                        }
                    }
                    return claimed;
                },
                cancellationToken),
            readOnly: false,
            cancellationToken,
            PersistenceTransactions.ClaimIsolation);
    }

    public async Task<bool> Complete(string id, Guid token, CancellationToken cancellationToken = default) =>
        await Execute(db, CompleteSql, new() { ["id"] = Guid.Parse(id), ["token"] = token }, cancellationToken) > 0;

    public async Task<bool> Reschedule(string id, Guid token, DateTimeOffset dueAt, CancellationToken cancellationToken = default) =>
        await Execute(db, RescheduleSql, new() { ["dueAt"] = dueAt, ["id"] = Guid.Parse(id), ["token"] = token }, cancellationToken) > 0;

    public async Task<bool> Fail(string id, Guid token, int maxAttempts, long retryDelayMs, CancellationToken cancellationToken = default) =>
        await Execute(db, FailSql, new() { ["maxAttempts"] = maxAttempts, ["retryDelayMs"] = retryDelayMs, ["id"] = Guid.Parse(id), ["token"] = token }, cancellationToken) > 0;

    public async Task<long?> NextDueMs(IReadOnlyList<string> kinds, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(kinds);
        var value = await Scalar(db, NextDueMsSql, new() { ["kinds"] = new Many([.. kinds]) }, cancellationToken);
        return value is null or DBNull ? null : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    public async Task<long> ParkedCount(CancellationToken cancellationToken = default) =>
        Convert.ToInt64(await Scalar(db, ParkedCountSql, [], cancellationToken), CultureInfo.InvariantCulture);

    public Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default) =>
        Execute(db, PurgeSql, new() { ["retentionDays"] = retentionDays }, cancellationToken);

    // ─── La conexión y los marcadores ───────────────────────────────────────────────────────────

    /// <summary>Una lista de valores para un marcador de lista (<c>:kinds</c>, <c>:ids</c>): se expande como <c>expandList</c>.</summary>
    private sealed record Many(IReadOnlyList<object> Items);

    private static ${context} Context(IServiceProvider services) => services.GetRequiredService<${context}>();

    /// <summary>
    /// Abre la conexión del contexto (si la transacción en curso ya la tiene abierta, EF solo cuenta una apertura más) y la
    /// suelta al terminar.
    /// </summary>
    private static async Task<T> OnConnection<T>(DbContext context, Func<Task<T>> work, CancellationToken cancellationToken)
    {
        await context.Database.OpenConnectionAsync(cancellationToken);
        try
        {
            return await work();
        }
        finally
        {
            await context.Database.CloseConnectionAsync();
        }
    }

    private static Task<int> Execute(DbContext context, string sql, Dictionary<string, object?> values, CancellationToken cancellationToken) =>
        OnConnection(
            context,
            async () =>
            {
                await using var command = Command(context, sql, values);
                return await command.ExecuteNonQueryAsync(cancellationToken);
            },
            cancellationToken);

    private static Task<object?> Scalar(DbContext context, string sql, Dictionary<string, object?> values, CancellationToken cancellationToken) =>
        OnConnection(
            context,
            async () =>
            {
                await using var command = Command(context, sql, values);
                return await command.ExecuteScalarAsync(cancellationToken);
            },
            cancellationToken);

    /// <summary>
    /// La sentencia con sus marcadores nombrados pasados a los del driver, en la transacción en curso del contexto: las listas
    /// se expanden (<c>:kinds)</c> → <c>:kinds0, :kinds1)</c>) y cada marcador, en su orden, se convierte en un parámetro
    /// posicional. Un marcador repetido es otro parámetro con el mismo valor.
    /// </summary>
    private static DbCommand Command(DbContext context, string named, Dictionary<string, object?> values)
    {
        var sql = named;
        var flat = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (name, value) in values)
        {
            if (value is Many many)
            {
                sql = ExpandList(sql, name, many.Items.Count);
                for (var index = 0; index < many.Items.Count; index++)
                {
                    flat[name + index.ToString(CultureInfo.InvariantCulture)] = many.Items[index];
                }
            }
            else
            {
                flat[name] = value;
            }
        }
        var command = context.Database.GetDbConnection().CreateCommand();
        command.Transaction = context.Database.CurrentTransaction?.GetDbTransaction();
        command.CommandText = Marker().Replace(sql, match =>
        {
            var parameter = command.CreateParameter();
            parameter.Value = Wire(flat[match.Groups[1].Value]);
            command.Parameters.Add(parameter);
            return ${mysql ? '"?"' : '"$" + command.Parameters.Count.ToString(CultureInfo.InvariantCulture)'};
        });
        return command;
    }

    /// <summary><c>expandList</c> de keel-core: un marcador de lista en <paramref name="count"/> marcadores numerados.</summary>
    private static string ExpandList(string sql, string name, int count)
    {
        if (count < 1)
        {
            throw new ArgumentException($"la lista :{name} necesita al menos un elemento", nameof(count));
        }
        var markers = string.Join(", ", Enumerable.Range(0, count).Select(index => ":" + name + index.ToString(CultureInfo.InvariantCulture)));
        return sql.Replace(":" + name + ")", markers + ")", StringComparison.Ordinal);
    }

    /// <summary>
    /// El valor como viaja: la hora en UTC (la que escriben los cuatro servidores en la columna${mysql ? ', y la que lee UTC_TIMESTAMP(6)' : ''}) y
    /// null como DBNull.${mysql ? ' El uuid viaja en binary(16) con los bytes del texto: lo fija GuidFormat=Binary16 en la cadena de conexión que registra AddPersistence.' : ''}
    /// </summary>
    private static object Wire(object? value) => value switch
    {
        null => DBNull.Value,
        DateTimeOffset instant => instant.UtcDateTime,
        _ => value
    };

    private static DateTimeOffset ReadTime(object? value) => value switch
    {
        DateTime time => new DateTimeOffset(DateTime.SpecifyKind(time, DateTimeKind.Utc)),
        DateTimeOffset instant => instant.ToUniversalTime(),
        _ => throw new InvalidOperationException($"La base no devolvió una hora: '{value}'")
    };

    /// <summary>El marcador nombrado de keel-core (<c>bindNamed</c>): dos puntos que no siguen a otros ni a una letra.</summary>
    [GeneratedRegex(@"(?<![:\\w]):([a-zA-Z][a-zA-Z0-9]*)")]
    private static partial Regex Marker();
}`;
}

/** La fila de keel_timer en el modelo de EF: solo para el esquema (el `KeelTimerJpa` de keel-spring). */
function keelTimerRowFile(model) {
  const { namespace, path } = located(model, 'rows', KEEL_TIMER_ROW);
  const TYPES = { uuid: 'Guid', string: 'string', timestamp: 'DateTimeOffset', int: 'int' };
  const property = (column) => column.name.replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase());
  const properties = KEEL_TIMER.columns.map((column) => {
    const type = `${TYPES[column.base]}${column.nullable ? '?' : ''}`;
    return `    public ${type} ${property(column)} { get; set; }${column.base === 'string' && !column.nullable ? ' = null!;' : ''}`;
  });
  const chains = KEEL_TIMER.columns.map((column) => {
    const parts = [`row.Property(r => r.${property(column)})`, `.HasColumnName(${csString(column.name)})`];
    if (column.length != null) parts.push(`.HasMaxLength(${column.length})`);
    parts.push(column.nullable ? '.IsRequired(false)' : '.IsRequired()');
    if (column.primary) parts.push('.ValueGeneratedNever()');
    return `        ${parts.join('')};`;
  });
  const selector = (columns) => (columns.length === 1 ? `r => r.${property({ name: columns[0] })}` : `r => new { ${columns.map((name) => `r.${property({ name })}`).join(', ')} }`);
  const uniques = KEEL_TIMER.uniques.map((unique) => `        row.HasIndex(${selector(unique.columns)}, ${csString(unique.name)}).IsUnique().HasDatabaseName(${csString(unique.name)});`);
  const indexes = KEEL_TIMER.indexes.map((index) => `        row.HasIndex(${selector(index.columns)}, ${csString(index.name)}).HasDatabaseName(${csString(index.name)});`);
  const primary = KEEL_TIMER.columns.find((column) => column.primary);
  const body = `/// <summary>
/// La tabla del cronómetro, mapeada SOLO para el esquema: así la crea EF en <c>local</c>, la lleva el baseline de
/// <c>dotnet ef</c> (o el paso de esquema de build, si la base ya está desplegada) y la nombra el snapshot del modelo. Nadie la
/// lee por EF: la usa TimerStore, con las sentencias de keel-core. Columnas, unicidad e índice son los de keel-core
/// (<c>KEEL_TIMER</c>), los de los cuatro servidores.
/// </summary>
public sealed class ${KEEL_TIMER_ROW}
{
${properties.join('\n\n')}
}

/// <summary>El mapeo de ${KEEL_TIMER_ROW} a la tabla ${KEEL_TIMER.table}.</summary>
public sealed class ${KEEL_TIMER_ROW}Configuration : IEntityTypeConfiguration<${KEEL_TIMER_ROW}>
{
    public void Configure(EntityTypeBuilder<${KEEL_TIMER_ROW}> row)
    {
        row.ToTable(${csString(KEEL_TIMER.table)});
        row.HasKey(r => r.${property(primary)}).HasName(${csString(`${KEEL_TIMER.table}_pkey`)});
${chains.join('\n')}
${uniques.join('\n')}
${indexes.join('\n')}
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders'], body }) };
}

/** Los nombres que keel_timer pone en el esquema: los busca la prueba emitida del modelo. */
export function timerSchemaNames(model) {
  if (!usesTimer(model) || !usesRelational(model)) return [];
  return [KEEL_TIMER.table, `${KEEL_TIMER.table}_pkey`, ...KEEL_TIMER.uniques.map((unique) => unique.name), ...KEEL_TIMER.indexes.map((index) => index.name)];
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────

function documentStoreBody() {
  return `/// <summary>
/// El cronómetro sobre MongoDB, con la forma documental de keel-core (<c>KEEL_TIMER_DOCUMENT</c>): un documento por (kind,
/// entity_id) con el <c>_id</c> aplanado (<c>kind|entity_id</c>), las mismas claves que las columnas, y <c>entity_id</c> y
/// <c>claim_token</c> como TEXTO: son contrato con los otros generadores, y el texto no depende de la representación de uuid
/// que configure cada driver.
/// </summary>
/// <remarks>
/// No hay SKIP LOCKED: el reclamo es <c>FindOneAndUpdate</c> de uno en uno sobre el mismo filtro, atómico por documento y
/// fuera de toda sesión (confirma al volver). La hora es <c>$$NOW</c>, la del servidor (T1). El armado, el borrado y el rearme
/// toman la sesión de la transacción abierta, la del caso de uso o la del sondeador.
/// </remarks>
public sealed class TimerStore(DocumentDatabase database, PersistenceTransactions transactions, TimerWakeup wakeup) : ITimerStore
{
    private const string CollectionName = ${csString(KEEL_TIMER.table)};

    private static readonly UpdateOptions Upsert = new() { IsUpsert = true };

    private IMongoCollection<BsonDocument> Collection => database.Collection(CollectionName);

    private static string DocumentId(string kind, Guid entityId) => kind + "|" + entityId.ToString("D");

    private static DateTimeOffset? Instant(BsonValue value) =>
        value is BsonDateTime date ? new DateTimeOffset(date.ToUniversalTime(), TimeSpan.Zero) : null;

    private static PipelineUpdateDefinition<BsonDocument> Pipeline(BsonDocument set) =>
        new(new BsonDocumentStagePipelineDefinition<BsonDocument, BsonDocument>([new BsonDocument("$set", set)]));

    public async Task<DateTimeOffset> DbNow(CancellationToken cancellationToken = default)
    {
        // $$NOW evaluado por el servidor, sobre la base SIN la sesión de la transacción en curso (la pide también quien está
        // dentro de una): un comando como hello no se admite en una transacción (error 263, medido en keel-spring).
        var pipeline = new BsonDocumentStagePipelineDefinition<NoPipelineInput, BsonDocument>([new BsonDocument("$documents", new BsonArray { new BsonDocument("now", "$$NOW") })]);
        using var cursor = await database.Database.AggregateAsync(pipeline, cancellationToken: cancellationToken);
        var row = await cursor.FirstAsync(cancellationToken);
        return Instant(row["now"]) ?? throw new InvalidOperationException("La base no devolvió una hora");
    }

    public async Task Arm(string kind, Guid entityId, DateTimeOffset dueAt, CancellationToken cancellationToken = default)
    {
        var filter = new BsonDocument("_id", DocumentId(kind, entityId));
        var update = new BsonDocument("$set", new BsonDocument
        {
            { "kind", kind },
            { "entity_id", entityId.ToString("D") },
            { "spec", BsonNull.Value },
            { "due_at", new BsonDateTime(dueAt.UtcDateTime) },
            { "claimed_until", BsonNull.Value },
            { "claim_token", BsonNull.Value },
            { "attempts", 0 },
            { "parked_at", BsonNull.Value }
        });
        // En la sesión de la transacción en curso, la del caso de uso que guarda la entidad: si aborta, el temporizador no queda.
        if (transactions.Session is { } session)
        {
            await Collection.UpdateOneAsync(session, filter, update, Upsert, cancellationToken);
        }
        else
        {
            await Collection.UpdateOneAsync(filter, update, Upsert, cancellationToken);
        }
        // El sondeador de ESTA réplica lo sabe tras el commit: si vence antes de lo que pensaba dormir, despierta.
        transactions.AfterCommit(() =>
        {
            wakeup.Notify(dueAt);
            return Task.CompletedTask;
        });
    }

    public async Task EnsureRecurring(string kind, string spec, DateTimeOffset dueAt, CancellationToken cancellationToken = default)
    {
        // Un update con pipeline: si ya está y su spec no cambió, no se toca su vencimiento (R1).
        var set = new BsonDocument
        {
            { "kind", kind },
            { "entity_id", TimerKinds.NilEntityId.ToString("D") },
            { "due_at", new BsonDocument("$cond", new BsonArray { new BsonDocument("$eq", new BsonArray { "$spec", spec }), "$due_at", new BsonDateTime(dueAt.UtcDateTime) }) },
            { "spec", spec },
            { "claimed_until", new BsonDocument("$ifNull", new BsonArray { "$claimed_until", BsonNull.Value }) },
            { "claim_token", new BsonDocument("$ifNull", new BsonArray { "$claim_token", BsonNull.Value }) },
            { "attempts", new BsonDocument("$ifNull", new BsonArray { "$attempts", 0 }) },
            { "parked_at", new BsonDocument("$ifNull", new BsonArray { "$parked_at", BsonNull.Value }) }
        };
        await Collection.UpdateOneAsync(new BsonDocument("_id", DocumentId(kind, TimerKinds.NilEntityId)), Pipeline(set), Upsert, cancellationToken);
    }

    public async Task<IReadOnlyList<ClaimedTimer>> Claim(IReadOnlyList<string> kinds, int limit, long leaseMs, Guid token, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(kinds);
        var filter = new BsonDocument
        {
            { "kind", new BsonDocument("$in", new BsonArray(kinds)) },
            { "parked_at", BsonNull.Value },
            {
                "$expr",
                new BsonDocument("$and", new BsonArray
                {
                    new BsonDocument("$lte", new BsonArray { "$due_at", "$$NOW" }),
                    new BsonDocument("$or", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$claimed_until", BsonNull.Value }),
                        new BsonDocument("$lt", new BsonArray { "$claimed_until", "$$NOW" })
                    })
                })
            }
        };
        var update = Pipeline(new BsonDocument
        {
            { "claimed_until", new BsonDocument("$add", new BsonArray { "$$NOW", new BsonInt64(leaseMs) }) },
            { "claim_token", token.ToString("D") }
        });
        var options = new FindOneAndUpdateOptions<BsonDocument> { Sort = new BsonDocument("due_at", 1), ReturnDocument = ReturnDocument.After };
        var claimed = new List<ClaimedTimer>();
        while (claimed.Count < limit)
        {
            var found = await Collection.FindOneAndUpdateAsync(filter, update, options, cancellationToken);
            if (found is null)
            {
                break;
            }
            claimed.Add(new ClaimedTimer(
                found["_id"].AsString,
                found["kind"].AsString,
                Guid.Parse(found["entity_id"].AsString),
                Instant(found["due_at"]) ?? throw new InvalidOperationException($"El temporizador {found["_id"]} no tiene due_at"),
                found.GetValue("attempts", 0).ToInt32()));
        }
        return claimed;
    }

    private static BsonDocument Fenced(string id, Guid token) => new() { { "_id", id }, { "claim_token", token.ToString("D") } };

    private async Task<bool> UpdateFenced(string id, Guid token, UpdateDefinition<BsonDocument> update, CancellationToken cancellationToken)
    {
        var result = transactions.Session is { } session
            ? await Collection.UpdateOneAsync(session, Fenced(id, token), update, cancellationToken: cancellationToken)
            : await Collection.UpdateOneAsync(Fenced(id, token), update, cancellationToken: cancellationToken);
        return result.ModifiedCount > 0;
    }

    public async Task<bool> Complete(string id, Guid token, CancellationToken cancellationToken = default)
    {
        var result = transactions.Session is { } session
            ? await Collection.DeleteOneAsync(session, Fenced(id, token), cancellationToken: cancellationToken)
            : await Collection.DeleteOneAsync(Fenced(id, token), cancellationToken);
        return result.DeletedCount > 0;
    }

    public Task<bool> Reschedule(string id, Guid token, DateTimeOffset dueAt, CancellationToken cancellationToken = default) =>
        UpdateFenced(
            id,
            token,
            new BsonDocument("$set", new BsonDocument { { "due_at", new BsonDateTime(dueAt.UtcDateTime) }, { "claimed_until", BsonNull.Value }, { "claim_token", BsonNull.Value }, { "attempts", 0 } }),
            cancellationToken);

    public Task<bool> Fail(string id, Guid token, int maxAttempts, long retryDelayMs, CancellationToken cancellationToken = default) =>
        // parked_at se calcula con los intentos de ANTES, como la sentencia relacional.
        UpdateFenced(
            id,
            token,
            Pipeline(new BsonDocument
            {
                {
                    "parked_at",
                    new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$gte", new BsonArray { new BsonDocument("$add", new BsonArray { "$attempts", 1 }), maxAttempts }),
                        "$$NOW",
                        BsonNull.Value
                    })
                },
                { "attempts", new BsonDocument("$add", new BsonArray { "$attempts", 1 }) },
                { "due_at", new BsonDocument("$add", new BsonArray { "$$NOW", new BsonInt64(retryDelayMs) }) },
                { "claimed_until", BsonNull.Value },
                { "claim_token", BsonNull.Value }
            }),
            cancellationToken);

    public async Task<long?> NextDueMs(IReadOnlyList<string> kinds, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(kinds);
        var pipeline = new BsonDocumentStagePipelineDefinition<BsonDocument, BsonDocument>(
        [
            new BsonDocument("$match", new BsonDocument { { "kind", new BsonDocument("$in", new BsonArray(kinds)) }, { "parked_at", BsonNull.Value } }),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", BsonNull.Value },
                { "next", new BsonDocument("$min", new BsonDocument("$cond", new BsonArray { new BsonDocument("$gt", new BsonArray { "$claimed_until", "$due_at" }), "$claimed_until", "$due_at" })) }
            }),
            new BsonDocument("$project", new BsonDocument("ms", new BsonDocument("$subtract", new BsonArray { "$next", "$$NOW" })))
        ]);
        using var cursor = await Collection.AggregateAsync(pipeline, cancellationToken: cancellationToken);
        var result = await cursor.FirstOrDefaultAsync(cancellationToken);
        return result is null || !result.Contains("ms") || result["ms"].IsBsonNull ? null : result["ms"].ToInt64();
    }

    public async Task<long> ParkedCount(CancellationToken cancellationToken = default) =>
        await Collection.CountDocumentsAsync(new BsonDocument("parked_at", new BsonDocument("$ne", BsonNull.Value)), cancellationToken: cancellationToken);

    public async Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default)
    {
        var filter = new BsonDocument
        {
            { "claim_token", BsonNull.Value },
            { "$expr", new BsonDocument("$lt", new BsonArray { "$due_at", new BsonDocument("$subtract", new BsonArray { "$$NOW", new BsonInt64(retentionDays * 86_400_000L) }) }) }
        };
        var result = await Collection.DeleteManyAsync(filter, cancellationToken);
        return (int)result.DeletedCount;
    }
}`;
}

// ─── El sondeador ────────────────────────────────────────────────────────────────────────────────

function pollerBody() {
  return `/// <summary>
/// El sondeador del cronómetro: UNO por réplica. Cada pasada reclama un lote de lo vencido (ITimerStore.Claim: dos réplicas
/// nunca toman el mismo mientras dure el arriendo), resuelve cada temporizador con su ITimerHandler DENTRO de una transacción
/// en la que también lo borra o lo rearma, y duerme hasta el vencimiento más próximo, con un tope para ver lo que arman otras
/// réplicas. Un temporizador que esta réplica arma y vence antes la despierta (TimerWakeup).
/// </summary>
/// <remarks>
/// <para>
/// Es al menos una vez: si la réplica muere con un lote arrendado, otra lo retoma al vencer el arriendo, y el efecto es uno
/// solo porque la transición del plazo es condicional y la revalidación descarta lo que ya no aplica.
/// </para>
/// <para>
/// Se apaga con <c>${TIMER_SWITCH.key}=false</c> (el perfil test lo apaga): los temporizadores se siguen ARMANDO, que es
/// persistencia; lo que deja de haber es quien los dispare. Al apagar no se corta la pasada en vuelo: el host la espera.
/// </para>
/// </remarks>
public sealed partial class TimerPoller : BackgroundService
{
    private readonly IServiceScopeFactory scopes;
    private readonly TimerSettings settings;
    private readonly TimeProvider clock;
    private readonly ILogger<TimerPoller> logger;
    private readonly Lock monitor = new();
    private IReadOnlyList<string>? kinds;
    private long wakeAtMs = long.MaxValue;
    private TaskCompletionSource woken = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public TimerPoller(IServiceScopeFactory scopes, TimerSettings settings, TimerWakeup wakeup, TimeProvider clock, ILogger<TimerPoller> logger)
    {
        ArgumentNullException.ThrowIfNull(wakeup);
        this.scopes = scopes;
        this.settings = settings;
        this.clock = clock;
        this.logger = logger;
        wakeup.Subscribe(OnArmed);
    }

    /// <summary>Los kinds que esta réplica conoce (R4): un temporizador de otra versión no lo toca, ni para borrarlo.</summary>
    public IReadOnlyList<string> Kinds
    {
        get
        {
            if (kinds is null)
            {
                using var scope = scopes.CreateScope();
                kinds =
                [
                    .. scope.ServiceProvider.GetServices<ITimerHandler>().Select(handler => handler.Kind)
                        .Concat(scope.ServiceProvider.GetServices<IRecurringTimerHandler>().Select(recurring => recurring.Kind))
                        .Distinct(StringComparer.Ordinal)
                ];
            }
            return kinds;
        }
    }

    /// <summary>Cuándo piensa despertar (milisegundos de la época, según el reloj de la instancia).</summary>
    public long WakeAtMs
    {
        get
        {
            lock (monitor)
            {
                return wakeAtMs;
            }
        }
    }

    /// <summary>El siguiente tick ESTRICTAMENTE posterior a <paramref name="from"/>, con el cron en UTC (T7).</summary>
    public static DateTimeOffset NextTick(string spec, DateTimeOffset from) =>
        CronExpression.Parse(spec, CronFormat.IncludeSeconds).GetNextOccurrence(from, TimeZoneInfo.Utc)
            ?? throw new InvalidOperationException($"El cron '{spec}' no tiene ninguna ocurrencia después de {from:O}");

    /// <summary>Cuánto dormir: hasta lo próximo, con el tope y nunca negativo (<c>sleepMs</c> de keel-core).</summary>
    public static long SleepMs(long? nextDueMs, long maxSleepMs) => nextDueMs is not { } next ? maxSleepMs : Math.Max(0, Math.Min(next, maxSleepMs));

    /// <summary>Las réplicas aseguran sus recurrentes al arrancar (R1), con el siguiente tick desde la hora de la base.</summary>
    public async Task EnsureRecurring(CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<ITimerStore>();
        var now = await store.DbNow(cancellationToken);
        foreach (var recurring in scope.ServiceProvider.GetServices<IRecurringTimerHandler>())
        {
            await store.EnsureRecurring(recurring.Kind, recurring.Spec, NextTick(recurring.Spec, now), cancellationToken);
        }
    }

    /// <summary>
    /// Una pasada: reclama, resuelve y devuelve cuánto dormir. Pública para las pruebas, que la ejecutan contra la base con el
    /// sondeador apagado (DL-8 a DL-10).
    /// </summary>
    public async Task<long> PollOnce(CancellationToken cancellationToken = default)
    {
        var token = Guid.NewGuid();
        IReadOnlyList<ClaimedTimer> claimed;
        await using (var scope = scopes.CreateAsyncScope())
        {
            claimed = await scope.ServiceProvider.GetRequiredService<ITimerStore>().Claim(Kinds, settings.BatchSize, settings.LeaseMs, token, cancellationToken);
        }
        foreach (var timer in claimed)
        {
            try
            {
                // Un ámbito por temporizador: su transacción, su contexto y su despacho son solo suyos.
                await using var scope = scopes.CreateAsyncScope();
                var store = scope.ServiceProvider.GetRequiredService<ITimerStore>();
                var recurring = scope.ServiceProvider.GetServices<IRecurringTimerHandler>().FirstOrDefault(candidate => candidate.Kind == timer.Kind);
                if (recurring is not null)
                {
                    // Un recurrente en modo clúster: lo ejecuta esta réplica porque ganó la fila, FUERA de toda transacción (el
                    // mecanismo gestiona las suyas), y se rearma con el siguiente tick desde la hora de la base de DESPUÉS (R2). Si
                    // otra réplica le quitó la fila (el tick duró más que el arriendo), el rearme no casa con la valla.
                    await recurring.Tick(cancellationToken);
                    await store.Reschedule(timer.Id, token, NextTick(recurring.Spec, await store.DbNow(cancellationToken)), cancellationToken);
                    continue;
                }
                var handler = scope.ServiceProvider.GetServices<ITimerHandler>().First(candidate => candidate.Kind == timer.Kind);
                await scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().InTransaction(
                    async () =>
                    {
                        var outcome = await handler.Handle(timer, await store.DbNow(cancellationToken), cancellationToken);
                        if (outcome.Done)
                        {
                            await store.Complete(timer.Id, token, cancellationToken);
                        }
                        else
                        {
                            await store.Reschedule(timer.Id, token, outcome.DueAt ?? throw new InvalidOperationException("Un rearme sin vencimiento"), cancellationToken);
                        }
                        return true;
                    },
                    readOnly: false,
                    cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                LogFailed(timer.Id, timer.Kind, timer.Attempts + 1, error);
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<ITimerStore>().Fail(timer.Id, token, settings.MaxAttempts, settings.RetryDelayMs, cancellationToken);
                if (timer.Attempts + 1 >= settings.MaxAttempts)
                {
                    LogParked(timer.Id, timer.Kind, settings.MaxAttempts);
                }
            }
        }
        await using (var scope = scopes.CreateAsyncScope())
        {
            return SleepMs(await scope.ServiceProvider.GetRequiredService<ITimerStore>().NextDueMs(Kinds, cancellationToken), settings.MaxSleepMs);
        }
    }

    /// <summary>Un temporizador armado en ESTA réplica (tras el commit): si vence antes de lo que iba a dormir, despierta.</summary>
    public void OnArmed(DateTimeOffset dueAt)
    {
        lock (monitor)
        {
            var due = dueAt.ToUnixTimeMilliseconds();
            if (due < wakeAtMs)
            {
                wakeAtMs = due;
                woken.TrySetResult();
            }
        }
    }

    /// <summary>Fija cuándo despertar tras una pasada; lo usa el bucle y lo comprueban las pruebas.</summary>
    public void PlanWake(long nowMs, long sleepMs)
    {
        lock (monitor)
        {
            wakeAtMs = nowMs + sleepMs;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!settings.Enabled)
        {
            LogDisabled();
            return;
        }
        try
        {
            await EnsureRecurring(stoppingToken);
        }
        catch (Exception error) when (error is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
        {
            LogEnsureFailed(error);
        }
        while (!stoppingToken.IsCancellationRequested)
        {
            long sleep;
            try
            {
                // Sin el token del apagado: la pasada que ya empezó termina (cortarla deja temporizadores arrendados sin hacer).
                sleep = await PollOnce(CancellationToken.None);
            }
            catch (Exception error)
            {
                LogPassFailed(error);
                sleep = settings.MaxSleepMs;
            }
            PlanWake(clock.GetUtcNow().ToUnixTimeMilliseconds(), sleep);
            await SleepUntilWake(stoppingToken);
        }
    }

    private async Task SleepUntilWake(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Task signal;
            long remaining;
            lock (monitor)
            {
                remaining = wakeAtMs - clock.GetUtcNow().ToUnixTimeMilliseconds();
                if (remaining <= 0)
                {
                    return;
                }
                if (woken.Task.IsCompleted)
                {
                    woken = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                }
                signal = woken.Task;
            }
            var delay = Task.Delay(TimeSpan.FromMilliseconds(Math.Min(remaining, int.MaxValue)), clock, stoppingToken);
            // Delay cancelado (apagado) o completado, o un armado más próximo: se vuelve a mirar el reloj.
            await Task.WhenAny(signal, delay);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Cronómetro apagado (${TIMER_SWITCH.key}: false): esta réplica no dispara temporizadores")]
    private partial void LogDisabled();

    [LoggerMessage(Level = LogLevel.Error, Message = "El cronómetro no pudo asegurar sus recurrentes; lo reintenta la réplica siguiente que arranque")]
    private partial void LogEnsureFailed(Exception error);

    [LoggerMessage(Level = LogLevel.Error, Message = "La pasada del cronómetro falló; se reintenta tras el sueño máximo")]
    private partial void LogPassFailed(Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "El temporizador {Id} ({Kind}) falló en su intento {Attempt}")]
    private partial void LogFailed(string id, string kind, int attempt, Exception error);

    [LoggerMessage(Level = LogLevel.Error, Message = "El temporizador {Id} ({Kind}) agotó sus {MaxAttempts} intentos y queda APARCADO")]
    private partial void LogParked(string id, string kind, int maxAttempts);
}`;
}

function purgeBody() {
  return `/// <summary>
/// La purga de la propia tabla del cronómetro (R7): un recurrente más, en modo clúster, así que la ejecuta UNA réplica por
/// tick. Borra lo vencido hace más de la retención y sin reclamar: un temporizador de un kind que ya no conoce ninguna réplica
/// (R4) o uno aparcado que ya se vio.
/// </summary>
public sealed class KeelTimerPurge(ITimerStore store, TimerSettings settings) : IRecurringTimerHandler
{
    public string Kind => TimerKinds.TimerPurge;

    public string Spec => settings.PurgeCron;

    public async Task Tick(CancellationToken cancellationToken) => await store.Purge(settings.RetentionDays, cancellationToken);
}`;
}

/**
 * El recurrente que dispara la purga de una tabla del generador (incremento 7): antes la registraba TablePurges en el
 * reloj, que corría en TODAS las réplicas a la vez; ahora la ejecuta UNA por tick, la que gana su fila en keel_timer. El
 * cron es el de siempre (su clave, su variable y su default de keel-core, en PurgeSettings), evaluado en UTC (T7).
 */
function purgeTimerBody(model, purge) {
  const entry = tablePurges(model).find((candidate) => candidate.table === purge.table);
  if (!entry) throw new Error(`timer.js: ${purge.table} se purga con el cronómetro y TablePurges no la tiene`);
  return `/// <summary>
/// La purga de <c>${purge.table}</c>, como recurrente del cronómetro en modo clúster: cada tick lo ejecuta UNA réplica, la que
/// gana su fila en <c>${KEEL_TIMER.table}</c>. Lo que borra y cómo (la retención, los lotes, sus transacciones) es lo de
/// TablePurges.${entry.method}, que no cambia: solo cambia quién la dispara.
/// </summary>
public sealed class ${purgeTimerClass(purge.table)}(TablePurges purges, PurgeSettings settings) : IRecurringTimerHandler
{
    public string Kind => TimerKinds.${purgeKindConstant(purge.table)};

    public string Spec => settings.${entry.key}.Cron;

    public async Task Tick(CancellationToken cancellationToken) => await purges.${entry.method}(null, cancellationToken);
}`;
}

// ─── El handler de cada plazo ────────────────────────────────────────────────────────────────────

function findOperation(model, name) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []).find((operation) => operation.name === name);
}

function handlerUsings(model, { entity, deadline }) {
  const operation = findOperation(model, deadline.by);
  const usings = [
    namespaceOf(model, 'abstractions'),
    namespaceOf(model, operation?.messageKind === 'query' ? 'queries' : 'commands'),
    namespaceOf(model, 'repositories'),
    namespaceOf(model, entityPlace(entity)),
    deadlinesNamespace(model),
    ...typeUsings(model, [entity.lifecycle.enumType])
  ];
  if (usesCorrelation(model)) usings.push('Microsoft.Extensions.Logging', namespaceOf(model, 'correlation'));
  return usings;
}

function deadlineHandlerBody(model, { entity, deadline }) {
  const className = deadlineHandlerClass(entity.name, deadline.stateName);
  const operation = findOperation(model, deadline.by);
  const components = [...(operation?.pathParams ?? []), ...(operation?.bodyFields ?? [])];
  const correlated = usesCorrelation(model);
  const member = deadlineMember(entity.name, deadline.stateName);
  const status = csMember(entity.lifecycle.field);
  const since = csMember(deadline.since);
  const port = `I${entity.name}Repository`;
  const message = components.length === 1 && components[0].csType === 'Guid' ? `new ${operation.messageClass} { ${csMember(components[0].name)} = timer.EntityId }` : null;
  const dispatchCall = `await mediator.Dispatch(${message}, cancellationToken);`;
  const dispatch = !message
    ? `// TODO (agente): el mensaje de ${deadline.by} pide más que el id de la entidad; constrúyelo aquí.
        throw new NotImplementedException("TODO: despachar ${operation?.messageClass ?? deadline.by} desde el cronómetro");`
    : correlated
      ? `// Cada disparo es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación.
        var correlationId = Guid.NewGuid().ToString();
        using (CorrelationContext.Open(correlationId))
        using (logger.BeginScope(new Dictionary<string, object> { ["correlationId"] = correlationId }))
        {
            ${dispatchCall}
        }`
      : dispatchCall;
  const sinceValue = sinceNullable(entity, deadline)
    ? `found.${since} ?? throw new InvalidOperationException(${csString(`${entity.name} en ${deadline.stateName} sin ${deadline.since}: el plazo no se puede medir`)})`
    : `found.${since}`;
  const ctor = [`${port} repository`, 'IUseCaseMediator mediator', `${deadlinesClass(model)} deadlines`, ...(correlated ? [`ILogger<${className}> logger`] : [])];
  return `/// <summary>
/// El plazo de ${entity.name} en '${deadline.stateName}' (DSL 2.26): vencido ${deadline.since} + el plazo vigente, la entidad pasa a
/// '${deadline.toName}' por ${deadline.by}, que despacha este handler.
/// </summary>
/// <remarks>
/// Antes de despachar REVALIDA, con la hora de la base y el plazo de AHORA: si la entidad ya no existe o ya salió de
/// '${deadline.stateName}', el temporizador se descarta sin transición (DL-8); si con el plazo vigente todavía no vence, se rearma
/// (DL-9, T6). Lo que hace ${deadline.by} al caducar es del diseño: lo escribe el agente en su handler.
/// </remarks>
public sealed class ${className}(${ctor.join(', ')}) : ITimerHandler
{
    public string Kind => TimerKinds.${kindConstant(entity.name, deadline.stateName)};

    public async Task<TimerOutcome> Handle(ClaimedTimer timer, DateTimeOffset dbNow, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(timer);
        var found = await repository.FindById(timer.EntityId, cancellationToken);
        if (found is null || found.${status} != ${stateMember(model, entity, deadline.state)})
        {
            return TimerOutcome.Finished();
        }
        var due = ${sinceValue} + deadlines.${member};
        if (due > dbNow)
        {
            return TimerOutcome.RescheduleAt(due);
        }
        ${dispatch}
        return TimerOutcome.Finished();
    }
}`;
}

// ─── El registro ─────────────────────────────────────────────────────────────────────────────────

function registrationUsings(model) {
  const usings = ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.DependencyInjection.Extensions'];
  if (usesDeadlines(model)) usings.push(deadlinesNamespace(model));
  if (modelDeadlines(model).some(({ duration }) => duration.parameter)) usings.push(namespaceOf(model, 'parameters'));
  return usings;
}

/** La expresión C# que construye los plazos vigentes, con `parameters` a mano si alguno sale de un parámetro. */
export function deadlinesExpression(model, parametersExpr = 'parameters') {
  const parameters = model.service.parameters ?? [];
  const args = modelDeadlines(model).map(({ duration }) => {
    if (duration.seconds !== undefined) return `TimeSpan.FromSeconds(${duration.seconds})`;
    const parameter = parameters.find((candidate) => candidate.name === duration.parameter);
    return `TimeSpan.FromSeconds((long)${parametersExpr}.${csMember(parameter?.name ?? duration.parameter)} * ${duration.multiplier})`;
  });
  return `new ${deadlinesClass(model)}(${args.join(', ')})`;
}

function registrationBody(model) {
  const usesParameters = modelDeadlines(model).some(({ duration }) => duration.parameter);
  const parametersClass = `${model.service.className}Parameters`;
  const deadlines = usesParameters
    ? `services.TryAddSingleton(provider => Deadlines(provider.GetRequiredService<${parametersClass}>()));`
    : `services.TryAddSingleton(${deadlinesExpression(model)});`;
  const factory = usesParameters
    ? `

    /// <summary>Los plazos vigentes desde los parámetros de despliegue (la duración de cada uno, en su unidad).</summary>
    public static ${deadlinesClass(model)} Deadlines(${parametersClass} parameters)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        return ${deadlinesExpression(model)};
    }`
    : '';
  const handlers = [
    ...modelDeadlines(model).map(({ entity, deadline }) => `        services.AddScoped<ITimerHandler, ${deadlineHandlerClass(entity.name, deadline.stateName)}>();`),
    '        services.AddScoped<IRecurringTimerHandler, KeelTimerPurge>();',
    ...timerPurges(model).map((purge) => `        services.AddScoped<IRecurringTimerHandler, ${purgeTimerClass(purge.table)}>();`)
  ];
  return `/// <summary>
/// El cronómetro del servicio en el contenedor (DSL 2.26). El ÚNICO sitio que lo registra: lo que necesita el armado (desde
/// AddPersistence) y el sondeador con sus handlers (desde Program.cs).
/// </summary>
public static class TimerRegistration
{
    /// <summary>
    /// Lo que el adaptador de repositorio necesita para armar un plazo: el almacén, los plazos vigentes y el reloj inyectable
    /// (TimeProvider, el puerto ${CLOCK_PORT.name}). Lo llama AddPersistence; una prueba puede sustituir el reloj registrándolo antes.
    /// </summary>
    public static IServiceCollection AddTimerStore(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<TimerWakeup>();${usesDeadlines(model) ? `\n        ${deadlines}` : ''}
        services.TryAddScoped<ITimerStore, TimerStore>();
        return services;
    }

    /// <summary>
    /// El sondeador de esta réplica y lo que dispara: ${usesDeadlines(model) ? 'un handler por plazo, ' : ''}la purga de la tabla (R7)${timerPurges(model).length > 0 ? ' y las de las tablas del generador, en modo clúster (TablePurges y PurgeSettings los registra AddScheduling)' : ''}.
    /// </summary>
    public static IServiceCollection AddTimer(this IServiceCollection services, TimerSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddTimerStore();
${handlers.join('\n')}
        services.TryAddSingleton<TimerPoller>();
        services.AddHostedService(provider => provider.GetRequiredService<TimerPoller>());
        return services;
    }${factory}
}`;
}

// ─── El arnés de flujos: AgeForDeadline (D7) ─────────────────────────────────────────────────────

const AGING_DOC = (example) => `    /// <summary>
    /// Envejece el plazo de la entidad <paramref name="id"/>: retrasa su ${example.deadline.since} y el vencimiento de su temporizador
    /// <paramref name="seconds"/> segundos, de modo que el plazo venza ya sin esperarlo (D7 de PLAN-DSL-226-PLAZOS.md, el
    /// ageForDeadline de keel-spring).
    /// </summary>
    /// <remarks>
    /// No dispara la caducidad: la dispara el cronómetro en su próxima pasada (como mucho el sueño máximo, timer.max-sleep-ms),
    /// como en producción. Y el rechazo tardío del dominio lo ve en el acto, porque lee ${example.deadline.since}: un verbo tardío
    /// tras esta llamada ya debe salir con su error.
    /// <code>
    /// AgeForDeadline(${csString(example.entity.name)}, id, 3600);
    /// await Eventually(async () => …, TimeSpan.FromSeconds(45));
    /// </code>
    /// </remarks>`;

/**
 * `AgeForDeadline(entidad, id, segundos)` sobre una base relacional (Support/FlowTest.cs), o []: la sentencia del
 * temporizador es la de keel-core (`timerStatements(engine).age`) con sus marcadores puestos, y el id va por el `IdLiteral`
 * del arnés. Sin un motor con sentencias del cronómetro no se emite.
 */
export function relationalAgingMembers(model) {
  if (!usesDeadlines(model) || !usesRelational(model)) return [];
  const engine = usesMySql(model) ? 'mysql' : 'postgresql';
  if (!TIMER_ENGINES.includes(engine)) return [];
  const age = timerStatements(engine).age;
  const shift = (column) => (engine === 'mysql' ? `DATE_SUB(${column}, INTERVAL " + Seconds(seconds) + " SECOND)` : `${column} - make_interval(secs => " + Seconds(seconds) + ")`);
  const entries = modelDeadlines(model);
  const branches = entries.map(({ entity, deadline, kind }) => {
    const since = sinceField(entity, deadline)?.columns?.name ?? snakeCase(deadline.since);
    const idColumn = entity.idField?.columns?.name ?? 'id';
    // La sentencia de keel-core como expresión C#: sus trozos literales y, en cada marcador, su valor.
    const values = { ':ageMs': 'Seconds(seconds * 1000)', ':kind': csString(`'${kind}'`), ':entityId': 'IdLiteral(id)' };
    const timer = age
      .split(/(:ageMs|:kind|:entityId)/)
      .filter((piece) => piece !== '')
      .map((piece) => values[piece] ?? csString(piece))
      .join(' + ');
    return `        if (entity == ${csString(entity.name)})
        {
            Db("UPDATE ${entity.tableName} SET ${since} = ${shift(since)} WHERE ${idColumn} = " + IdLiteral(id));
            Db(${timer});
            return;
        }`;
  });
  const known = [...new Set(entries.map(({ entity }) => entity.name))].join(', ');
  return [
    `${AGING_DOC(entries[0])}
    protected static void AgeForDeadline(string entity, string id, long seconds)
    {
${branches.join('\n')}
        throw new ArgumentException($"No hay plazo para la entidad '{entity}'. Las que lo tienen: ${known}", nameof(entity));
    }`,
    '    private static string Seconds(long value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);'
  ];
}

/** `AgeForDeadline` sobre documentos: el script de keel-core (`ageDeadlineScript`, mongo-probes.js) con sus marcadores. */
export function documentAgingMembers(model, ageDeadlineScript) {
  if (!usesDeadlines(model) || !usesDocument(model)) return [];
  const entries = modelDeadlines(model);
  const branches = entries.map(({ entity, deadline, kind }) => {
    const key = documentShape(model, entity).find((entry) => entry.member === deadline.since)?.name ?? snakeCase(deadline.since);
    const script = ageDeadlineScript({ collection: entity.collectionName, sinceField: key, kind });
    return `        if (entity == ${csString(entity.name)})
        {
            MongoEval(${csString(script)}.Replace("{id}", DocumentId(id), StringComparison.Ordinal).Replace("{ms}", (seconds * 1000).ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal));
            return;
        }`;
  });
  const known = [...new Set(entries.map(({ entity }) => entity.name))].join(', ');
  return [
    `${AGING_DOC(entries[0])}
    protected static void AgeForDeadline(string entity, string id, long seconds)
    {
${branches.join('\n')}
        throw new ArgumentException($"No hay plazo para la entidad '{entity}'. Las que lo tienen: ${known}", nameof(entity));
    }`
  ];
}

// ─── La prueba emitida: lo que se ejecuta sin base ───────────────────────────────────────────────

/** El estado de la entidad en un estado y con su `since`: el resto de miembros, con el default de su tipo. */
function stateInitializer(model, entity, deadline, statusExpr, sinceExpr) {
  const lines = [];
  for (const field of entity.fields) {
    let value = 'default!';
    if (field.name === entity.lifecycle.field) value = statusExpr;
    else if (field.name === deadline.since) value = sinceExpr;
    else if (field.list) value = '[]';
    lines.push(`${csMember(field.name)} = ${value},`);
  }
  for (const relation of entity.relations ?? []) {
    if (relation.backReference) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    const name = !relation.internal && model.layersPresent?.persistence ? `${relation.name}Id` : relation.name;
    lines.push(`${csMember(name)} = ${toMany && (relation.internal || !model.layersPresent?.persistence) ? '[]' : 'default!'},`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) lines.push('LockVersion = null,');
  return `new ${entity.name}State
        {
            ${lines.join('\n            ')}
        }`;
}

function timerTestsFile(model) {
  const sln = solution(model);
  const usings = ['System.Reflection', 'Xunit', timerNamespace(model)];
  if (usesDeadlines(model)) usings.push(deadlinesNamespace(model));
  const cron = CRON_UTC_CASES.map(([spec, from, next]) => `    [InlineData(${csString(spec)}, ${csString(from)}, ${csString(next)})]`);
  const members = [
    `    /// <summary>El cron se evalúa en UTC (T7): los casos de keel-core (CRON_UTC_CASES), los mismos en los cuatro.</summary>
    [Theory]
${cron.join('\n')}
    public void ElSiguienteTickEsElDeKeelCoreEnUtc(string spec, string from, string next) =>
        Assert.Equal(DateTimeOffset.Parse(next, System.Globalization.CultureInfo.InvariantCulture), TimerPoller.NextTick(spec, DateTimeOffset.Parse(from, System.Globalization.CultureInfo.InvariantCulture)));`,
    `    /// <summary>Cuánto duerme el sondeador: hasta lo próximo, con el tope y nunca negativo (sleepMs de keel-core).</summary>
    [Theory]
    [InlineData(null, 30000L, 30000L)]
    [InlineData(5000L, 30000L, 5000L)]
    [InlineData(-10L, 30000L, 0L)]
    [InlineData(60000L, 30000L, 30000L)]
    public void ElSuenoEsHastaLoProximoConTope(long? next, long max, long expected) => Assert.Equal(expected, TimerPoller.SleepMs(next, max));`
  ];
  // Las purgas en modo clúster (inc. 7): cada recurrente con el kind de keel-core y el cron del perfil.
  const purges = timerPurges(model);
  if (purges.length > 0) {
    usings.push(namespaceOf(model, 'purge'));
    const all = tablePurges(model);
    members.push(`    /// <summary>Cada purga del generador es un recurrente del cronómetro con el kind de keel-core y el cron de su configuración.</summary>
    [Fact]
    public void CadaPurgaEsUnRecurrenteConElKindDeKeelCore()
    {
        var settings = ${purgeSettingsExpression(all)};
        IRecurringTimerHandler[] recurrentes = [${purges.map((purge) => `new ${purgeTimerClass(purge.table)}(null!, settings)`).join(', ')}];
        Assert.Equal(new[] { ${purges.map((purge) => csString(purge.kind)).join(', ')} }, recurrentes.Select(recurrente => recurrente.Kind));
        Assert.Equal(new[] { ${purges.map((purge) => csString(purge.cron.default)).join(', ')} }, recurrentes.Select(recurrente => recurrente.Spec));
    }`);
  }
  // DL-1 a DL-3 contra el dominio emitido, por reflexión (el método de transición es privado: los semánticos son del agente).
  const entry = modelDeadlines(model).find(({ entity }) => lateGuards(entity).length > 0);
  if (entry) {
    const { entity, deadline } = entry;
    const guard = lateGuards(entity).find((candidate) => candidate.from === deadline.state);
    const lateTarget = entity.lifecycle.transitions.find((transition) => transition.from === deadline.state)?.to.find((state) => state !== deadline.to);
    const error = (model.errors ?? []).find((candidate) => candidate.code === guard.error);
    if (lateTarget) {
      usings.push(namespaceOf(model, entityPlace(entity)), ...typeUsings(model, [entity.lifecycle.enumType]));
      if (error) usings.push(namespaceOf(model, 'errors'));
      const enumType = entity.lifecycle.enumType;
      const from = stateMember(model, entity, deadline.state);
      const late = stateMember(model, entity, lateTarget);
      const to = stateMember(model, entity, deadline.to);
      const member = deadlineMember(entity.name, deadline.stateName);
      const status = csMember(entity.lifecycle.field);
      const plazos = `new ${deadlinesClass(model)}(${modelDeadlines(model).map(() => 'TimeSpan.FromMinutes(10)').join(', ')})`;
      members.push(`    private static readonly ${deadlinesClass(model)} Plazos = ${plazos};

    private static readonly DateTimeOffset Desde = DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    private static ${entity.name} Entidad() => new(${stateInitializer(model, entity, deadline, from, 'Desde')});

    private static void Transicion(${entity.name} entidad, ${enumType} destino, DateTimeOffset now)
    {
        var metodo = typeof(${entity.name}).GetMethod("TransitionTo", BindingFlags.Instance | BindingFlags.NonPublic, [typeof(${enumType}), typeof(DateTimeOffset), typeof(${deadlinesClass(model)})])
            ?? throw new InvalidOperationException("La entidad no tiene el TransitionTo con la hora y los plazos");
        try
        {
            metodo.Invoke(entidad, [destino, now, Plazos]);
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
        }
    }

    /// <summary>DL-1: dentro del plazo, la transición tardía sale.</summary>
    [Fact]
    public void DL1_DentroDelPlazoLaTransicionTardiaSale()
    {
        var entidad = Entidad();
        Transicion(entidad, ${late}, Desde + Plazos.${member} - TimeSpan.FromMilliseconds(1));
        Assert.Equal(${late}, entidad.${status});
    }

    /// <summary>DL-2: en el instante exacto del vencimiento (since + after &lt;= now), se rechaza con ${guard.error}.</summary>
    [Fact]
    public void DL2_EnElInstanteExactoSeRechaza()
    {
        var entidad = Entidad();
        Assert.Throws<${error ? error.exceptionClass : 'InvalidOperationException'}>(() => Transicion(entidad, ${late}, Desde + Plazos.${member}));
        Assert.Equal(${from}, entidad.${status});
    }

    /// <summary>DL-3: pasado el plazo, la transición hacia el destino de la caducidad sale.</summary>
    [Fact]
    public void DL3_HaciaElDestinoDeLaCaducidadSale()
    {
        var entidad = Entidad();
        Transicion(entidad, ${to}, Desde + Plazos.${member} + TimeSpan.FromHours(1));
        Assert.Equal(${to}, entidad.${status});
    }`);
    }
  }
  const body = `/// <summary>
/// El cronómetro y los plazos (DSL 2.26) sin base ni reloj real: el cron en UTC, el sueño, y el rechazo tardío del dominio en
/// el instante exacto del vencimiento. Lo que habla con la base (armado, reclamo, revalidación, aparcado) lo juzgan db-check
/// y doc-check.
/// </summary>
public sealed class TimerTests
{
${members.join('\n\n')}
}`;
  return { path: `${sln.unitTests.dir}/TimerTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}
