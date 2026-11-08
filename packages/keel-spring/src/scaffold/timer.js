// El cronómetro del servicio y los plazos de negocio (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 3).
//
// Lo neutral —la tabla, sus parámetros, las SENTENCIAS por motor, el `kind` de cada temporizador, la regla del
// vencimiento y el algoritmo del sondeador— está en keel-core/gen (timer-store.js, deadlines.js, timer-poller.js), y es
// contrato de los cuatro servidores: comparten base y esquema. Aquí solo se escribe en Java:
//
//   · `<Servicio>Deadlines`, en el dominio: la duración VIGENTE de cada plazo. El rechazo tardío la necesita y el dominio
//     no lee configuración, así que viaja por argumento, como `<Servicio>Parameters`;
//   · el rechazo tardío (D2), en el método de transición de la entidad (entities.js lo pide con `lateGuardBlock`);
//   · el armado, en el adaptador del repositorio, en la transacción del caso de uso (`adapterArming`);
//   · el almacén (`TimerStore`), JDBC con las sentencias de keel-core tal cual, o MongoDB con su forma documental;
//   · el sondeador (`TimerPoller`): un hilo de plataforma por réplica que reclama, revalida, despacha y duerme hasta el
//     siguiente vencimiento. Se apaga con `scheduling.enabled` (TIMER_SWITCH), el único interruptor;
//   · el despacho de cada plazo (`<Entidad><Estado>Deadline`) y la purga de la propia tabla (R7), el primer recurrente.
//
// Desde el incremento 7, las purgas de las tablas del generador también corren aquí, como recurrentes en modo clúster
// (`<Tabla>PurgeTimer`): una réplica por tick en vez de todas a la vez. Por eso el cronómetro existe con plazos O con
// purgas (`usesTimer`, keel-core/gen/timer-plan.js), y lo de los plazos solo con plazos. Un motor sin sentencias del
// cronómetro (MariaDB, SQL Server, Oracle) no lo tiene, y sus purgas conservan su `@Scheduled` (purge.js).
//
// Desde el incremento 8, el `schedule` de cada operación también (`<Operación>ScheduleTimer`), con DRENAJE: el tick lo
// ejecuta una réplica y repite la pasada mientras su lote salga lleno (`SweepPass`, que avisan los reclamos generados).
// El despacho sigue en el `<Servicio>Scheduler`, ya sin `@Scheduled`. Un recurrente que falla no se aparca: se rearma.
//
// El relay sigue con su `@Scheduled`: migra en el incremento 9. El modo POR RÉPLICA no tiene
// todavía quien lo use (su único usuario es el relay, inc. 9), así que no se emite: un modo sin sujeto sería código que
// ninguna red ejecuta.

import { javaFile, javaPath, subPackage } from './render.js';
import { pascalCase } from '../lib/naming.js';
import { usesCorrelation, correlationImport } from './correlation.js';
import { messageComponents, messagePackage } from './services.js';
import { MEDIATOR_PKG } from './mediator.js';
import { modelDeadlines, usesDeadlines, lateGuards, deadlineOf, CLOCK_PORT } from '@keel-system/keel-core/gen/deadlines';
import {
  KEEL_TIMER,
  KEEL_TIMER_DOCUMENT,
  NIL_ENTITY_ID,
  TIMER_PARAMETERS,
  TIMER_PURGE_KIND,
  TIMER_SWITCH,
  timerStatements
} from '@keel-system/keel-core/gen/timer-store';
import { TIMER_DATABASES, claimDrains, timerPurges, timerSchedules, usesTimer } from '@keel-system/keel-core/gen/timer-plan';

export { usesDeadlines, usesTimer, TIMER_DATABASES };

const TIMER_PKG = 'infrastructure.timer';
const TIMER_JPA_PKG = 'infrastructure.persistence.timer';
const CONFIG_PKG = 'infrastructure.configurations.timer';
const DEADLINE_PKG = 'domain.deadline';

/**
 * Lo que un diseño con plazos no puede generar con este stack, o []: el cronómetro solo existe donde sus sentencias se
 * midieron (timer-sql-check), y el rechazo tardío necesita un `code` con un solo status.
 */
export function timerStackErrors(model) {
  if (!usesDeadlines(model)) return [];
  const errors = [];
  if (!model.layersPresent.persistence) {
    errors.push('lifecycle.deadlines (DSL 2.26): el cronómetro vive en la base del servicio, y este diseño no tiene capa persistence.');
  } else if (!TIMER_DATABASES.includes(model.stack?.database)) {
    errors.push(
      `lifecycle.deadlines (DSL 2.26): el cronómetro no tiene sentencias medidas para '${model.stack?.database}' ` +
        `(las hay para ${TIMER_DATABASES.join(', ')}). Elige uno de esos motores o genera el diseño sin el plazo.`
    );
  }
  for (const entity of model.entities) {
    for (const guard of lateGuards(entity)) {
      const error = model.errors.find((candidate) => candidate.code === guard.error);
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

// ─── Nombres ─────────────────────────────────────────────────────────────────

const cap = (name) => name[0].toUpperCase() + name.slice(1);
const decap = (name) => name[0].toLowerCase() + name.slice(1);

export function deadlinesClass(model) {
  return `${model.service.className}Deadlines`;
}
export function deadlinesImport(model) {
  return `${subPackage(model, DEADLINE_PKG)}.${deadlinesClass(model)}`;
}
/** El componente del record que lleva la duración de un plazo: `verificationCodePending`. */
export function deadlineComponent(entityName, stateName) {
  return `${decap(entityName)}${cap(stateName)}`;
}
function deadlineHandlerClass(entityName, stateName) {
  return `${entityName}${cap(stateName)}Deadline`;
}
function kindConstant(entityName, stateName) {
  return `${entityName}_${stateName}`.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
/** `PURGE_OUTBOX_EVENT`: la constante del `kind` de la purga de una tabla del generador. */
function purgeKindConstant(table) {
  return `PURGE_${table.toUpperCase()}`;
}
/** `OutboxEventPurgeTimer`: el recurrente que dispara la purga de una tabla del generador. */
export function purgeTimerClass(table) {
  return `${pascalCase(table)}PurgeTimer`;
}
/** `DISPATCH_JOBS`: la constante del `kind` del `schedule` de una operación. */
function scheduleKindConstant(operationName) {
  return `SCHEDULE_${operationName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}
/** `DispatchJobsScheduleTimer`: el recurrente que dispara el `schedule` de una operación (incremento 8). */
export function scheduleTimerClass(operationName) {
  return `${cap(operationName)}ScheduleTimer`;
}
/** El `<Servicio>Scheduler` que despacha una operación con `schedule`: el de su servicio (services.js). */
export function schedulerClassOf(model, operationName) {
  const service = (model.services ?? []).find((candidate) => (candidate.operations ?? []).some((operation) => operation.name === operationName));
  return service.className.replace(/Service$/, 'Scheduler');
}

/** La señal de lote lleno del drenaje (incremento 8): `SweepPass`, en application/support porque la llaman los handlers. */
export const SWEEP_PASS_PKG = 'application.support';
export function usesSweepPass(model) {
  return timerSchedules(model).length > 0;
}
export function sweepPassImport(model) {
  return `${subPackage(model, SWEEP_PASS_PKG)}.SweepPass`;
}
/**
 * La línea con la que un reclamo GENERADO avisa al tick de que su lote salió lleno (o nada, si su operación no corre
 * sobre el cronómetro). `size` y `batch` son expresiones Java.
 */
export function sweepPassSignal(model, claim, imports, size, batch) {
  if (!claimDrains(model, claim)) return '';
  imports.add(sweepPassImport(model));
  return `        // Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
        SweepPass.claimed(${size}, ${batch});
`;
}

const timerImport = (model, name) => `${subPackage(model, TIMER_PKG)}.${name}`;
const isDocument = (model) => model.persistenceKind === 'document';

// ─── El rechazo tardío, en el dominio (lo emite entities.js) ─────────────────

/**
 * El método de transición de una entidad con rechazos tardíos. Devuelve null si la entidad no tiene ninguno. El de un
 * argumento sigue existiendo para las transiciones que no salen de un estado con plazo; para las que sí, se niega: sin la
 * hora no hay rechazo tardío, y callarlo sería confirmar lo que el negocio daba por caducado.
 */
export function lateGuardBlock(model, entity, imports) {
  const guards = lateGuards(entity);
  if (guards.length === 0) return null;
  const { field, enumType } = entity.lifecycle;
  imports.add('java.time.Instant');
  imports.add(deadlinesImport(model));
  const deadlines = entity.lifecycle.deadlines;
  const checks = guards.map((guard) => {
    const deadline = deadlines.find((candidate) => candidate.state === guard.from);
    const error = model.errors.find((candidate) => candidate.code === guard.error);
    if (error) imports.add(`${subPackage(model, 'domain.errors')}.${error.exceptionClass}`);
    const thrown = error
      ? `new ${error.exceptionClass}("${(error.when ?? guard.error).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`
      : `new IllegalStateException("${guard.error}")`;
    return `        // Plazo de '${deadline.stateName}' (DSL 2.26): pasado ${guard.since} + el plazo vigente, salir hacia otro
        // destino que '${deadline.toName}' es ${guard.error}. Vence EN el instante (since + after <= now), no después.
        if (${field} == ${enumType}.${guard.from} && target != ${enumType}.${guard.exempt}) {
            if (${guard.since} == null) {
                throw new IllegalStateException("${entity.name} en ${deadline.stateName} sin ${guard.since}: el plazo no se puede medir");
            }
            if (!${guard.since}.plus(deadlines.${deadlineComponent(entity.name, deadline.stateName)}()).isAfter(now)) {
                throw ${thrown};
            }
        }`;
  });
  const guarded = guards.map((guard) => `(${field} == ${enumType}.${guard.from} && target != ${enumType}.${guard.exempt})`);
  return `    // Guard interno del lifecycle con el RECHAZO TARDÍO de los plazos (DSL 2.26): lo llaman los métodos semánticos,
    // nunca un handler. \`now\` es la hora del reloj inyectable (java.time.Clock, el puerto ${CLOCK_PORT.name}) y
    // \`deadlines\` la duración vigente de cada plazo: los dos los recibe el método semántico del handler.
    private void transitionTo(${enumType} target, Instant now, ${deadlinesClass(model)} deadlines) {
${checks.join('\n')}
        applyTransition(target);
    }

    // Sin la hora: solo para las transiciones que no salen de un estado con plazo hacia otro destino que el suyo.
    private void transitionTo(${enumType} target) {
        if (${guarded.join(' || ')}) {
            throw new IllegalStateException("Esta transición sale de un estado con plazo: usa transitionTo(target, now, deadlines)");
        }
        applyTransition(target);
    }

    private void applyTransition(${enumType} target) {
        if (!TRANSITIONS.getOrDefault(${field}, Set.of()).contains(target)) {
            throw new InvalidStateTransitionException(${field}.name(), target.name());
        }
        this.${field} = target;
    }`;
}

/** ¿Pide esta transición la hora? Para el TODO del método semántico. */
export function transitionNeedsClock(entity, fromConstant, toConstant) {
  return lateGuards(entity).some((guard) => guard.from === fromConstant && guard.exempt !== toConstant);
}

// ─── El armado, en el adaptador (lo usan repositories.js y document-repositories.js) ─────

/** Los plazos de una entidad: los que su adaptador arma al guardarla. */
function deadlinesOf(model, entity) {
  return modelDeadlines(model).filter((entry) => entry.entity.name === entity.name);
}

/**
 * Las piezas del armado en el `save` del adaptador, o null. `before` va antes de volcar el agregado (dice si la entidad
 * ENTRA en el estado: salir no cuesta nada, y re-guardarla dentro no lo rearma), `after` tras persistir, con `saved`.
 * `previous` es la expresión del estado que tenía en la base.
 */
export function adapterArming(model, entity, imports, previous) {
  const entries = deadlinesOf(model, entity);
  if (entries.length === 0) return null;
  imports.add(timerImport(model, 'TimerStore'));
  imports.add(timerImport(model, 'TimerKinds'));
  imports.add(deadlinesImport(model));
  const { field, enumType } = entity.lifecycle;
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);
  const getter = `get${cap(field)}()`;
  const idGetter = `get${cap(entity.idField.name)}()`;
  const before = entries
    .map(({ deadline }) => `        boolean entering${cap(deadline.stateName)} = ${previous} != ${enumType}.${deadline.state};`)
    .join('\n');
  const after = entries
    .map(
      ({ deadline }) => `        // El plazo de '${deadline.stateName}' se ARMA al entrar, en esta misma transacción: si revierte, no queda.
        if (entering${cap(deadline.stateName)} && saved.${getter} == ${enumType}.${deadline.state}) {
            timers.arm(TimerKinds.${kindConstant(entity.name, deadline.stateName)}, saved.${idGetter},
                    saved.get${cap(deadline.since)}().plus(deadlines.${deadlineComponent(entity.name, deadline.stateName)}()));
        }`
    )
    .join('\n');
  return {
    fields: ['    private final TimerStore timers;', `    private final ${deadlinesClass(model)} deadlines;`],
    params: ['TimerStore timers', `${deadlinesClass(model)} deadlines`],
    assigns: ['        this.timers = timers;', '        this.deadlines = deadlines;'],
    before,
    after
  };
}

// ─── Lo que emite build ──────────────────────────────────────────────────────

export function generate(model) {
  if (!usesTimer(model)) return [];
  const document = isDocument(model);
  const files = [
    ...(usesDeadlines(model) ? [deadlinesRecord(model), timerConfig(model)] : []),
    simple(model, 'TimerKinds', [], timerKinds(model)),
    simple(model, 'ClaimedTimer', ['java.time.Instant', 'java.util.UUID'], claimedTimer()),
    simple(model, 'TimerOutcome', ['java.time.Instant'], timerOutcome()),
    simple(model, 'TimerHandler', ['java.time.Instant'], timerHandler()),
    simple(model, 'RecurringTimerHandler', [], recurringTimerHandler()),
    simple(model, 'TimerArmed', ['java.time.Instant'], timerArmed()),
    simple(model, 'TimerStore', ['java.time.Instant', 'java.util.List', 'java.util.UUID'], timerStoreInterface()),
    document ? mongoTimerStore(model) : jdbcTimerStore(model),
    timerPoller(model),
    timerPurge(model),
    ...timerPurges(model).map((purge) => purgeTimer(model, purge)),
    ...timerSchedules(model).map((schedule) => scheduleTimer(model, schedule)),
    ...modelDeadlines(model).map((entry) => deadlineHandler(model, entry))
  ];
  if (usesSweepPass(model)) files.push(sweepPass(model));
  if (!document) files.push(timerJpa(model));
  return files;
}

function simple(model, name, imports, body) {
  return { path: javaPath(model, TIMER_PKG, name), content: javaFile(subPackage(model, TIMER_PKG), imports, body) };
}

function deadlinesRecord(model) {
  const entries = modelDeadlines(model);
  const components = entries.map(({ entity, deadline }) => `Duration ${deadlineComponent(entity.name, deadline.stateName)}`);
  const guards = entries.map(({ entity, deadline }) => {
    const name = deadlineComponent(entity.name, deadline.stateName);
    return `        if (${name} == null || ${name}.isNegative() || ${name}.isZero()) {
            throw new IllegalStateException("El plazo de ${entity.name}.${deadline.stateName} tiene que ser positivo: " + ${name});
        }`;
  });
  const params = entries
    .map(({ entity, deadline }) => ` * @param ${deadlineComponent(entity.name, deadline.stateName)} cuánto puede seguir un ${entity.name} en '${deadline.stateName}' (desde ${deadline.since})`)
    .join('\n');
  const body = `/**
 * La duración VIGENTE de cada plazo de negocio del servicio (DSL 2.26, \`lifecycle.deadlines\`).
 *
 * <p>Value object de dominio, como {@code ${model.service.className}Parameters}: el rechazo tardío del método de
 * transición la necesita y el dominio no lee configuración. Lo puebla {@code TimerConfig}, y lo usan con el MISMO valor
 * el dominio (el rechazo), el adaptador (el armado) y el cronómetro (la revalidación): cambiar el plazo en un despliegue
 * no reescribe los temporizadores armados, los corrige la revalidación (T6).
 *
${params}
 */
public record ${deadlinesClass(model)}(${components.join(', ')}) {

    public ${deadlinesClass(model)} {
${guards.join('\n')}
    }
}`;
  return {
    path: javaPath(model, DEADLINE_PKG, deadlinesClass(model)),
    content: javaFile(subPackage(model, DEADLINE_PKG), ['java.time.Duration'], body)
  };
}

function timerConfig(model) {
  const parameters = model.service.parameters ?? [];
  const usesParameters = modelDeadlines(model).some(({ duration }) => duration.parameter);
  const args = modelDeadlines(model).map(({ duration }) => {
    if (duration.seconds !== undefined) return `Duration.ofSeconds(${duration.seconds}L)`;
    const parameter = parameters.find((candidate) => candidate.name === duration.parameter);
    return `Duration.ofSeconds(parameters.${parameter?.name ?? duration.parameter}().longValue() * ${duration.multiplier}L)`;
  });
  const parametersClass = `${model.service.className}Parameters`;
  const imports = [
    'java.time.Clock',
    'java.time.Duration',
    'org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    deadlinesImport(model),
    usesParameters ? `${subPackage(model, 'domain.parameters')}.${parametersClass}` : null
  ];
  const body = `/**
 * El reloj inyectable y la duración de los plazos (DSL 2.26).
 *
 * <p>El reloj es {@link Clock} del JDK: el puerto ${CLOCK_PORT.name} del método, proyectado a Java. Lo reciben los
 * handlers que sacan una entidad de un estado con plazo, y lo sustituye una prueba con {@code Clock.fixed(...)} para
 * medir el segundo exacto del vencimiento. Es la hora de ESTA instancia (T2); la del cronómetro es la de la base (T1).
 */
@Configuration
public class TimerConfig {

    @Bean
    @ConditionalOnMissingBean(Clock.class)
    public Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    public ${deadlinesClass(model)} ${decap(deadlinesClass(model))}(${usesParameters ? `${parametersClass} parameters` : ''}) {
        return new ${deadlinesClass(model)}(${args.join(', ')});
    }
}`;
  return { path: javaPath(model, CONFIG_PKG, 'TimerConfig'), content: javaFile(subPackage(model, CONFIG_PKG), imports, body) };
}

function timerKinds(model) {
  const constants = [
    ...modelDeadlines(model).map(
      ({ entity, deadline, kind }) => `    /** El plazo de ${entity.name} en '${deadline.stateName}'. */
    public static final String ${kindConstant(entity.name, deadline.stateName)} = "${kind}";`
    ),
    `    /** La purga de la propia tabla: un recurrente en modo clúster (R7). */
    public static final String TIMER_PURGE = "${TIMER_PURGE_KIND}";`,
    ...timerPurges(model).map(
      (purge) => `    /** La purga de {@code ${purge.table}}: un recurrente en modo clúster. */
    public static final String ${purgeKindConstant(purge.table)} = "${purge.kind}";`
    ),
    ...timerSchedules(model).map(
      (schedule) => `    /** El \`schedule\` de ${schedule.operation}: un recurrente en modo clúster, con drenaje. */
    public static final String ${scheduleKindConstant(schedule.operation)} = "${schedule.kind}";`
    )
  ];
  return `/**
 * El nombre de cada temporizador en {@code ${KEEL_TIMER.table}} (columna {@code kind}). Es contrato con los otros
 * generadores —comparten tabla—, así que sale de keel-core y no se cambia aquí.
 */
public final class TimerKinds {

${constants.join('\n\n')}

    /** El \`entity_id\` de un recurrente: no tiene entidad, y la unicidad (kind, entity_id) necesita un valor. */
    public static final String NIL_ENTITY_ID = "${NIL_ENTITY_ID}";

    private TimerKinds() {
    }
}`;
}

function claimedTimer() {
  return `/**
 * Un temporizador que ESTA réplica reclamó: lo es mientras dure su arriendo, y todo lo que se haga con él lleva la valla
 * ({@code token}) con la que se reclamó.
 *
 * @param id       su identidad en la tabla (el uuid, o el {@code _id} documental)
 * @param kind     qué es: un plazo o un recurrente ({@link TimerKinds})
 * @param entityId la entidad de un plazo; el uuid nulo en un recurrente
 * @param dueAt    cuándo vencía
 * @param attempts cuántas veces falló ya
 */
public record ClaimedTimer(String id, String kind, UUID entityId, Instant dueAt, int attempts) {
}`;
}

function timerOutcome() {
  return `/** El desenlace de un temporizador: borrarlo, o rearmarlo para otro vencimiento. */
public record TimerOutcome(boolean done, Instant dueAt) {

    /** Cumplido o descartado: se borra. */
    public static TimerOutcome finished() {
        return new TimerOutcome(true, null);
    }

    /** Un recurrente tras su tick, o un plazo que la revalidación aplaza. */
    public static TimerOutcome rescheduleAt(Instant dueAt) {
        return new TimerOutcome(false, dueAt);
    }
}`;
}

function timerHandler() {
  return `/**
 * Lo que hace el cronómetro con los temporizadores de un {@code kind}. Corre DENTRO de la transacción en la que el
 * sondeador borra o rearma el temporizador: si lanza, la transacción revierte, el fallo se cuenta y, al agotar los
 * intentos, el temporizador se aparca (T5).
 */
public interface TimerHandler {

    String kind();

    /** {@code dbNow} es la hora de la BASE (T1): la única que compara el cronómetro. */
    TimerOutcome handle(ClaimedTimer timer, Instant dbNow);
}`;
}

function recurringTimerHandler() {
  return `/**
 * Un temporizador RECURRENTE en modo clúster: una fila sin entidad, que cada réplica asegura al arrancar (R1) y que en
 * cada tick ejecuta UNA sola réplica, la que la reclama. El siguiente tick lo calcula el sondeador desde la hora de la
 * base de DESPUÉS del tick (R2), con el cron en UTC (T7).
 *
 * <p>El tick corre FUERA de la transacción del sondeador, a diferencia de un plazo: un recurrente (una purga por lotes)
 * gestiona sus propias transacciones, y envolverlo en una sola volvería a ser el DELETE único que la purga por lotes
 * sustituye. Si lanza, el sondeador lo registra y lo rearma para su siguiente tick: un recurrente no se aparca nunca.
 */
public interface RecurringTimerHandler {

    /** El nombre del temporizador en la tabla ({@link TimerKinds}). */
    String kind();

    /** El cron de seis campos (el segundo primero), evaluado en UTC. */
    String spec();

    /** Un tick: lo que hace el mecanismo cada vez que vence. */
    void tick();
}`;
}

function timerArmed() {
  return `/**
 * Un temporizador recién armado. El sondeador de esta réplica lo escucha DESPUÉS del commit y, si vence antes de lo que
 * pensaba dormir, despierta: así un plazo corto no espera al tope del sueño.
 */
public record TimerArmed(Instant dueAt) {
}`;
}

function timerStoreInterface() {
  return `/**
 * La tabla del cronómetro (\`${KEEL_TIMER.table}\`), detrás de un puerto: las sentencias son las de keel-core, iguales en
 * los cuatro generadores, y la hora que comparan es SIEMPRE la de la base.
 */
public interface TimerStore {

    /** La hora de la base. */
    Instant dbNow();

    /** Arma un plazo (o lo rearma si ya existía), en la transacción en curso. */
    void arm(String kind, UUID entityId, Instant dueAt);

    /** Asegura la fila de un recurrente: la crea, o recalcula su vencimiento si su spec cambió (R1). */
    void ensureRecurring(String kind, String spec, Instant dueAt);

    /** Reclama lo vencido y libre de esos kinds, en orden de vencimiento, con arriendo y valla. Confirma antes de volver. */
    List<ClaimedTimer> claim(List<String> kinds, int limit, long leaseMs, UUID token);

    /** Borra un temporizador, solo si sigue siendo de quien lo reclamó. */
    boolean complete(String id, UUID token);

    /** Lo rearma, libre y con los intentos a cero, solo con la valla. */
    boolean reschedule(String id, UUID token, Instant dueAt);

    /** Cuenta un fallo; tras el retraso se reintenta y, al agotar los intentos, se aparca. */
    boolean fail(String id, UUID token, int maxAttempts, long retryDelayMs);

    /** Cuántos milisegundos faltan para lo próximo reclamable de esos kinds (null: nada; puede ser negativo). */
    Long nextDueMs(List<String> kinds);

    /** Los aparcados. */
    long parkedCount();

    /** La purga de la tabla: vencido hace más de la retención y sin reclamar (R4, R7). */
    int purge(int retentionDays);
}`;
}

// ─── El almacén relacional: las sentencias de keel-core, tal cual ────────────

function javaText(sql) {
  return `"${sql.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function jdbcTimerStore(model) {
  const engine = model.stack.database;
  const sql = timerStatements(engine);
  const mysql = engine === 'mysql';
  const constants = ['dbNow', 'arm', 'ensureRecurring', 'claimLock', 'claimMark', 'claimed', 'complete', 'reschedule', 'fail', 'nextDueMs', 'parkedCount', 'purge']
    .map((name) => `    private static final String ${name.replace(/([A-Z])/g, '_$1').toUpperCase()} = ${javaText(sql[name])};`)
    .join('\n');
  // La forma del uuid y de la hora en el cable de JDBC: la que deja Hibernate en la misma columna.
  const binding = mysql
    ? `    // MySQL: el uuid es binary(16) (el orden de bytes de Hibernate) y la hora un datetime(6) con la hora UTC, que es
    // como la escriben los cuatro servidores y como la lee UTC_TIMESTAMP(6).
    private static Object uuid(UUID value) {
        if (value == null) {
            return null;
        }
        return ByteBuffer.allocate(16).putLong(value.getMostSignificantBits()).putLong(value.getLeastSignificantBits()).array();
    }

    private static UUID readUuid(ResultSet rs, String column) throws SQLException {
        byte[] bytes = rs.getBytes(column);
        if (bytes == null) {
            return null;
        }
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        return new UUID(buffer.getLong(), buffer.getLong());
    }

    private static Object time(Instant value) {
        return value == null ? null : LocalDateTime.ofInstant(value, ZoneOffset.UTC);
    }

    private static Instant readTime(ResultSet rs, int column) throws SQLException {
        LocalDateTime value = rs.getObject(column, LocalDateTime.class);
        return value == null ? null : value.toInstant(ZoneOffset.UTC);
    }

    private static Instant readTime(ResultSet rs, String column) throws SQLException {
        LocalDateTime value = rs.getObject(column, LocalDateTime.class);
        return value == null ? null : value.toInstant(ZoneOffset.UTC);
    }`
    : `    // PostgreSQL: uuid nativo y timestamp with time zone.
    private static Object uuid(UUID value) {
        return value;
    }

    private static UUID readUuid(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, UUID.class);
    }

    private static Object time(Instant value) {
        return value == null ? null : OffsetDateTime.ofInstant(value, ZoneOffset.UTC);
    }

    private static Instant readTime(ResultSet rs, int column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    private static Instant readTime(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }`;
  const imports = [
    'java.sql.ResultSet',
    'java.sql.SQLException',
    'java.time.Instant',
    'java.time.ZoneOffset',
    mysql ? 'java.nio.ByteBuffer' : null,
    mysql ? 'java.time.LocalDateTime' : 'java.time.OffsetDateTime',
    'java.util.List',
    'java.util.UUID',
    'javax.sql.DataSource',
    'org.springframework.context.ApplicationEventPublisher',
    'org.springframework.jdbc.core.simple.JdbcClient',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.TransactionDefinition',
    'org.springframework.transaction.support.TransactionTemplate'
  ];
  const body = `/**
 * El cronómetro sobre ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core
 * ({@code timer-store.js}) TAL CUAL: son contrato con los otros generadores, que comparten la tabla, y las mide
 * {@code timer-sql-check} contra el motor. No las reescribas aquí.
 *
 * <p>Va por JDBC ({@link JdbcClient}) y no por JPA: las sentencias usan la hora de la base, {@code FOR UPDATE SKIP
 * LOCKED} y el upsert de cada motor, que JPQL no dice. Sobre el mismo {@code DataSource} que JPA, así que el armado
 * entra en la transacción del caso de uso ({@code JpaTransactionManager} expone su conexión a JDBC).
 */
@Component
public class JdbcTimerStore implements TimerStore {

${constants}

    private final JdbcClient jdbc;
    private final TransactionTemplate ownTransaction;
    private final ApplicationEventPublisher events;

    public JdbcTimerStore(DataSource dataSource, PlatformTransactionManager transactionManager, ApplicationEventPublisher events) {
        this.jdbc = JdbcClient.create(dataSource);
        // El reclamo son tres sentencias en UNA transacción PROPIA: confirma antes de volver, así que las demás réplicas
        // dejan de ver el lote aunque quien llama tarde en procesarlo.
        this.ownTransaction = new TransactionTemplate(transactionManager);
        this.ownTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.events = events;
    }

    @Override
    public Instant dbNow() {
        return jdbc.sql(DB_NOW).query((rs, row) -> readTime(rs, 1)).single();
    }

    @Override
    public void arm(String kind, UUID entityId, Instant dueAt) {
        jdbc.sql(ARM)
                .param("id", uuid(UUID.randomUUID()))
                .param("kind", kind)
                .param("entityId", uuid(entityId))
                .param("spec", null)
                .param("dueAt", time(dueAt))
                .update();
        events.publishEvent(new TimerArmed(dueAt));
    }

    @Override
    public void ensureRecurring(String kind, String spec, Instant dueAt) {
        jdbc.sql(ENSURE_RECURRING)
                .param("id", uuid(UUID.randomUUID()))
                .param("kind", kind)
                .param("entityId", uuid(UUID.fromString(TimerKinds.NIL_ENTITY_ID)))
                .param("spec", spec)
                .param("dueAt", time(dueAt))
                .update();
    }

    @Override
    public List<ClaimedTimer> claim(List<String> kinds, int limit, long leaseMs, UUID token) {
        return ownTransaction.execute(status -> {
            List<Object> ids = jdbc.sql(CLAIM_LOCK)
                    .param("kinds", kinds)
                    .param("limit", limit)
                    .query((rs, row) -> uuid(readUuid(rs, "id")))
                    .list();
            if (ids.isEmpty()) {
                return List.of();
            }
            jdbc.sql(CLAIM_MARK).param("leaseMs", leaseMs).param("token", uuid(token)).param("ids", ids).update();
            return jdbc.sql(CLAIMED)
                    .param("token", uuid(token))
                    .query((rs, row) -> new ClaimedTimer(readUuid(rs, "id").toString(), rs.getString("kind"),
                            readUuid(rs, "entity_id"), readTime(rs, "due_at"), rs.getInt("attempts")))
                    .list();
        });
    }

    @Override
    public boolean complete(String id, UUID token) {
        return jdbc.sql(COMPLETE).param("id", uuid(UUID.fromString(id))).param("token", uuid(token)).update() > 0;
    }

    @Override
    public boolean reschedule(String id, UUID token, Instant dueAt) {
        return jdbc.sql(RESCHEDULE)
                .param("dueAt", time(dueAt))
                .param("id", uuid(UUID.fromString(id)))
                .param("token", uuid(token))
                .update() > 0;
    }

    @Override
    public boolean fail(String id, UUID token, int maxAttempts, long retryDelayMs) {
        return jdbc.sql(FAIL)
                .param("maxAttempts", maxAttempts)
                .param("retryDelayMs", retryDelayMs)
                .param("id", uuid(UUID.fromString(id)))
                .param("token", uuid(token))
                .update() > 0;
    }

    @Override
    public Long nextDueMs(List<String> kinds) {
        return jdbc.sql(NEXT_DUE_MS).param("kinds", kinds).query((rs, row) -> {
            long value = rs.getLong(1);
            return rs.wasNull() ? null : value;
        }).optional().orElse(null);
    }

    @Override
    public long parkedCount() {
        return jdbc.sql(PARKED_COUNT).query(Long.class).single();
    }

    @Override
    public int purge(int retentionDays) {
        return jdbc.sql(PURGE).param("retentionDays", retentionDays).update();
    }

${binding}
}`;
  return { path: javaPath(model, TIMER_PKG, 'JdbcTimerStore'), content: javaFile(subPackage(model, TIMER_PKG), imports, body) };
}

function timerJpa(model) {
  const body = `/**
 * La tabla del cronómetro, mapeada SOLO para el esquema: así la crea Hibernate en \`local\` y \`test\`, la valida en
 * \`develop\` y \`production\`, y entra en el baseline que exporta el agente (o en el paso de esquema de build, si la
 * base ya está desplegada). Nadie la lee por JPA: la usa {@code JdbcTimerStore}, con las sentencias de keel-core.
 *
 * <p>Columnas, unicidad e índice son los de keel-core ({@code KEEL_TIMER}): los comparten los cuatro generadores.
 */
@Entity
@Table(name = "${KEEL_TIMER.table}",
        uniqueConstraints = @UniqueConstraint(name = "${KEEL_TIMER.uniques[0].name}", columnNames = {${KEEL_TIMER.uniques[0].columns.map((column) => `"${column}"`).join(', ')}}),
        indexes = @Index(name = "${KEEL_TIMER.indexes[0].name}", columnList = "${KEEL_TIMER.indexes[0].columns.join(', ')}"))
public class KeelTimerJpa {

    @Id
    @Column(name = "id", nullable = false)
    private UUID id;

    @Column(name = "kind", nullable = false, length = ${KEEL_TIMER.columns.find((column) => column.name === 'kind').length})
    private String kind;

    @Column(name = "entity_id", nullable = false)
    private UUID entityId;

    @Column(name = "spec", length = ${KEEL_TIMER.columns.find((column) => column.name === 'spec').length})
    private String spec;

    @Column(name = "due_at", nullable = false)
    private Instant dueAt;

    @Column(name = "claimed_until")
    private Instant claimedUntil;

    @Column(name = "claim_token")
    private UUID claimToken;

    @Column(name = "attempts", nullable = false)
    private Integer attempts;

    @Column(name = "parked_at")
    private Instant parkedAt;

    protected KeelTimerJpa() {
    }
}`;
  return {
    path: javaPath(model, TIMER_JPA_PKG, 'KeelTimerJpa'),
    content: javaFile(
      subPackage(model, TIMER_JPA_PKG),
      [
        'jakarta.persistence.Column',
        'jakarta.persistence.Entity',
        'jakarta.persistence.Id',
        'jakarta.persistence.Index',
        'jakarta.persistence.Table',
        'jakarta.persistence.UniqueConstraint',
        'java.time.Instant',
        'java.util.UUID'
      ],
      body
    )
  };
}

// ─── El almacén documental ───────────────────────────────────────────────────

function mongoTimerStore(model) {
  const collection = KEEL_TIMER_DOCUMENT.collection;
  const imports = [
    'com.mongodb.client.model.FindOneAndUpdateOptions',
    'com.mongodb.client.model.ReturnDocument',
    'com.mongodb.client.model.UpdateOptions',
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.Arrays',
    'java.util.Date',
    'java.util.List',
    'java.util.UUID',
    'org.bson.Document',
    'org.springframework.context.ApplicationEventPublisher',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'org.springframework.data.mongodb.core.query.Update',
    'org.springframework.stereotype.Component'
  ];
  const body = `/**
 * El cronómetro sobre MongoDB, con la forma documental de keel-core ({@code KEEL_TIMER_DOCUMENT}): un documento por
 * (kind, entity_id) con el {@code _id} aplanado ({@code kind|entity_id}), las mismas claves que las columnas y el índice
 * de {@code due_at}. {@code entity_id} y {@code claim_token} van como TEXTO: son contrato con los otros generadores,
 * y el texto no depende de la representación de uuid que cada driver configure.
 *
 * <p>No hay SKIP LOCKED: el reclamo es {@code findOneAndUpdate} de uno en uno sobre el mismo filtro, atómico por
 * documento. La hora es {@code $$NOW}, la del servidor (T1). El armado, el borrado y el rearme van por
 * {@link MongoTemplate}, que se une a la transacción del caso de uso ({@code MongoTransactionManager}).
 */
@Component
public class MongoTimerStore implements TimerStore {

    private static final String COLLECTION = "${collection}";

    private final MongoTemplate mongo;
    private final ApplicationEventPublisher events;

    public MongoTimerStore(MongoTemplate mongo, ApplicationEventPublisher events) {
        this.mongo = mongo;
        this.events = events;
    }

    private static String documentId(String kind, String entityId) {
        return kind + "|" + entityId;
    }

    private static Instant instant(Object value) {
        return value instanceof Date date ? date.toInstant() : null;
    }

    @Override
    public Instant dbNow() {
        // $$NOW evaluado por el servidor, sobre la base SIN la sesión de la transacción en curso (la pide también quien
        // está dentro de una): un comando como \`hello\` no se admite en una transacción (error 263, medido).
        Document now = mongo.getMongoDatabaseFactory().getMongoDatabase()
                .aggregate(List.of(new Document("$documents", List.of(new Document("now", "$$NOW")))))
                .first();
        return instant(now == null ? null : now.get("now"));
    }

    @Override
    public void arm(String kind, UUID entityId, Instant dueAt) {
        Update update = new Update()
                .set("kind", kind)
                .set("entity_id", entityId.toString())
                .set("spec", null)
                .set("due_at", Date.from(dueAt))
                .set("claimed_until", null)
                .set("claim_token", null)
                .set("attempts", 0)
                .set("parked_at", null);
        mongo.upsert(Query.query(Criteria.where("_id").is(documentId(kind, entityId.toString()))), update, COLLECTION);
        events.publishEvent(new TimerArmed(dueAt));
    }

    @Override
    public void ensureRecurring(String kind, String spec, Instant dueAt) {
        // Un update con pipeline: si ya está y su spec no cambió, no se toca su vencimiento (R1).
        Document set = new Document("kind", kind)
                .append("entity_id", TimerKinds.NIL_ENTITY_ID)
                .append("due_at", new Document("$cond", List.of(new Document("$eq", List.of("$spec", spec)), "$due_at", Date.from(dueAt))))
                .append("spec", spec)
                .append("claimed_until", new Document("$ifNull", Arrays.asList("$claimed_until", null)))
                .append("claim_token", new Document("$ifNull", Arrays.asList("$claim_token", null)))
                .append("attempts", new Document("$ifNull", List.of("$attempts", 0)))
                .append("parked_at", new Document("$ifNull", Arrays.asList("$parked_at", null)));
        mongo.getCollection(COLLECTION).updateOne(
                new Document("_id", documentId(kind, TimerKinds.NIL_ENTITY_ID)),
                List.of(new Document("$set", set)),
                new UpdateOptions().upsert(true));
    }

    @Override
    public List<ClaimedTimer> claim(List<String> kinds, int limit, long leaseMs, UUID token) {
        Document filter = new Document("kind", new Document("$in", kinds))
                .append("parked_at", null)
                .append("$expr", new Document("$and", List.of(
                        new Document("$lte", List.of("$due_at", "$$NOW")),
                        new Document("$or", List.of(
                                new Document("$eq", Arrays.asList("$claimed_until", null)),
                                new Document("$lt", List.of("$claimed_until", "$$NOW")))))));
        List<Document> update = List.of(new Document("$set", new Document("claimed_until", new Document("$add", List.of("$$NOW", leaseMs)))
                .append("claim_token", token.toString())));
        FindOneAndUpdateOptions options = new FindOneAndUpdateOptions().sort(new Document("due_at", 1)).returnDocument(ReturnDocument.AFTER);
        List<ClaimedTimer> claimed = new ArrayList<>();
        while (claimed.size() < limit) {
            Document found = mongo.getCollection(COLLECTION).findOneAndUpdate(filter, update, options);
            if (found == null) {
                break;
            }
            Number attempts = found.get("attempts", Number.class);
            claimed.add(new ClaimedTimer(found.getString("_id"), found.getString("kind"), UUID.fromString(found.getString("entity_id")),
                    instant(found.get("due_at")), attempts == null ? 0 : attempts.intValue()));
        }
        return claimed;
    }

    private static Query fenced(String id, UUID token) {
        return Query.query(Criteria.where("_id").is(id).and("claim_token").is(token.toString()));
    }

    @Override
    public boolean complete(String id, UUID token) {
        return mongo.remove(fenced(id, token), COLLECTION).getDeletedCount() > 0;
    }

    @Override
    public boolean reschedule(String id, UUID token, Instant dueAt) {
        Update update = new Update().set("due_at", Date.from(dueAt)).set("claimed_until", null).set("claim_token", null).set("attempts", 0);
        return mongo.updateFirst(fenced(id, token), update, COLLECTION).getModifiedCount() > 0;
    }

    @Override
    public boolean fail(String id, UUID token, int maxAttempts, long retryDelayMs) {
        // parked_at se calcula con los intentos de ANTES, como la sentencia relacional.
        Document set = new Document("parked_at", new Document("$cond", Arrays.asList(
                        new Document("$gte", List.of(new Document("$add", List.of("$attempts", 1)), maxAttempts)), "$$NOW", null)))
                .append("attempts", new Document("$add", List.of("$attempts", 1)))
                .append("due_at", new Document("$add", List.of("$$NOW", retryDelayMs)))
                .append("claimed_until", null)
                .append("claim_token", null);
        return mongo.getCollection(COLLECTION)
                .updateOne(new Document("_id", id).append("claim_token", token.toString()), List.of(new Document("$set", set)))
                .getModifiedCount() > 0;
    }

    @Override
    public Long nextDueMs(List<String> kinds) {
        List<Document> pipeline = List.of(
                new Document("$match", new Document("kind", new Document("$in", kinds)).append("parked_at", null)),
                new Document("$group", new Document("_id", null).append("next", new Document("$min",
                        new Document("$cond", List.of(new Document("$gt", List.of("$claimed_until", "$due_at")), "$claimed_until", "$due_at"))))),
                new Document("$project", new Document("ms", new Document("$subtract", List.of("$next", "$$NOW")))));
        Document result = mongo.getCollection(COLLECTION).aggregate(pipeline).first();
        Number ms = result == null ? null : result.get("ms", Number.class);
        return ms == null ? null : ms.longValue();
    }

    @Override
    public long parkedCount() {
        return mongo.count(Query.query(Criteria.where("parked_at").ne(null)), COLLECTION);
    }

    @Override
    public int purge(int retentionDays) {
        Document filter = new Document("claim_token", null).append("$expr", new Document("$lt", List.of("$due_at",
                new Document("$subtract", List.of("$$NOW", retentionDays * 86_400_000L)))));
        return (int) mongo.getCollection(COLLECTION).deleteMany(filter).getDeletedCount();
    }
}`;
  return { path: javaPath(model, TIMER_PKG, 'MongoTimerStore'), content: javaFile(subPackage(model, TIMER_PKG), imports, body) };
}

// ─── El sondeador ────────────────────────────────────────────────────────────

const value = ({ key, default: fallback }) => `@Value("\${${key}:${fallback}}")`;

function timerPoller(model) {
  const P = TIMER_PARAMETERS;
  const imports = [
    'java.time.Instant',
    'java.util.List',
    'java.util.Map',
    'java.util.UUID',
    'java.util.function.Function',
    'java.util.stream.Collectors',
    'java.util.stream.Stream',
    'org.springframework.beans.factory.ObjectProvider',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.boot.autoconfigure.condition.ConditionalOnProperty',
    'org.springframework.context.SmartLifecycle',
    'org.springframework.scheduling.support.CronExpression',
    'org.springframework.core.task.SimpleAsyncTaskExecutor',
    'java.util.concurrent.CountDownLatch',
    'java.util.concurrent.TimeUnit',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.event.TransactionPhase',
    'org.springframework.transaction.event.TransactionalEventListener',
    'org.springframework.transaction.support.TransactionTemplate',
    'java.time.ZoneOffset'
  ];
  const [switchKey, ...rest] = TIMER_SWITCH.key.split('.');
  const body = `/**
 * El sondeador del cronómetro: UNO por réplica, en un hilo de plataforma propio (como el {@code SchedulingConfig}: lo
 * que corre por reloj no comparte carriers con la carga web).
 *
 * <p>Cada pasada reclama un lote de lo vencido ({@link TimerStore#claim}: dos réplicas nunca toman el mismo mientras
 * dure el arriendo), resuelve cada temporizador con su {@link TimerHandler} DENTRO de una transacción en la que también
 * lo borra o lo rearma, y duerme hasta el vencimiento más próximo, con un tope para ver lo que arman otras réplicas. Un
 * temporizador que esta réplica arma y vence antes la despierta ({@link TimerArmed}). Es al menos una vez: si la réplica
 * muere con un lote arrendado, otra lo retoma al vencer el arriendo, y el efecto es uno solo porque la transición del
 * plazo es condicional y la revalidación descarta lo que ya no aplica.
 *
 * <p>Se apaga con {@code ${TIMER_SWITCH.key}=false} (el perfil {@code test} lo apaga): los temporizadores se siguen
 * ARMANDO, que es persistencia; lo que deja de haber es quien los dispare.
 */
@Component
@ConditionalOnProperty(prefix = "${switchKey}", name = "${rest.join('.')}", havingValue = "true", matchIfMissing = true)
public class TimerPoller implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(TimerPoller.class);

    private final TimerStore store;
    private final Map<String, TimerHandler> handlers;
    private final Map<String, RecurringTimerHandler> recurrings;
    private final List<String> kinds;
    private final TransactionTemplate transaction;
    private final Object monitor = new Object();

    ${value(P.maxSleepMs)}
    private long maxSleepMs;

    ${value(P.batchSize)}
    private int batchSize;

    ${value(P.leaseMs)}
    private long leaseMs;

    ${value(P.maxAttempts)}
    private int maxAttempts;

    ${value(P.retryDelayMs)}
    private long retryDelayMs;

    private volatile boolean running;
    private volatile long wakeAtMs = Long.MAX_VALUE;
    private volatile CountDownLatch stopped;

    /** Sin plazos no hay ningún {@link TimerHandler}: por eso los dos van por {@link ObjectProvider} y no por lista. */
    @Autowired
    public TimerPoller(
            TimerStore store,
            ObjectProvider<TimerHandler> handlers,
            ObjectProvider<RecurringTimerHandler> recurrings,
            PlatformTransactionManager transactionManager) {
        this(store, handlers.orderedStream().toList(), recurrings.orderedStream().toList(), transactionManager);
    }

    /** El de las pruebas: los handlers a mano, como dos réplicas con los suyos. */
    TimerPoller(
            TimerStore store,
            List<TimerHandler> handlers,
            List<RecurringTimerHandler> recurrings,
            PlatformTransactionManager transactionManager) {
        this.store = store;
        this.handlers = handlers.stream().collect(Collectors.toMap(TimerHandler::kind, Function.identity()));
        this.recurrings = recurrings.stream().collect(Collectors.toMap(RecurringTimerHandler::kind, Function.identity()));
        // Solo los kinds que esta réplica conoce (R4): un temporizador de otra versión no lo toca, ni para borrarlo.
        this.kinds = Stream.concat(this.handlers.keySet().stream(), this.recurrings.keySet().stream()).toList();
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /** Las réplicas aseguran sus recurrentes al arrancar (R1), con el siguiente tick desde la hora de la base. */
    void ensureRecurring() {
        Instant now = store.dbNow();
        for (RecurringTimerHandler recurring : recurrings.values()) {
            store.ensureRecurring(recurring.kind(), recurring.spec(), nextTick(recurring.spec(), now));
        }
    }

    /** El siguiente tick ESTRICTAMENTE posterior a {@code from}, con el cron en UTC (T7). */
    static Instant nextTick(String spec, Instant from) {
        return CronExpression.parse(spec).next(from.atZone(ZoneOffset.UTC)).toInstant();
    }

    /** Cuánto dormir: hasta lo próximo, con el tope y nunca negativo. */
    static long sleepMs(Long nextDueMs, long maxSleepMs) {
        if (nextDueMs == null) {
            return maxSleepMs;
        }
        return Math.max(0, Math.min(nextDueMs, maxSleepMs));
    }

    /**
     * Una pasada: reclama, resuelve y devuelve cuánto dormir. Visible para las pruebas, que la ejecutan con un almacén
     * en memoria y la hora en su mano (DL-10).
     */
    long pollOnce() {
        UUID token = UUID.randomUUID();
        List<ClaimedTimer> claimed = store.claim(kinds, batchSize, leaseMs, token);
        for (ClaimedTimer timer : claimed) {
            RecurringTimerHandler recurring = recurrings.get(timer.kind());
            if (recurring != null) {
                tick(recurring, timer, token);
                continue;
            }
            TimerHandler handler = handlers.get(timer.kind());
            try {
                transaction.executeWithoutResult(status -> {
                    TimerOutcome outcome = handler.handle(timer, store.dbNow());
                    if (outcome.done()) {
                        store.complete(timer.id(), token);
                    } else {
                        store.reschedule(timer.id(), token, outcome.dueAt());
                    }
                });
            } catch (RuntimeException failure) {
                log.warn("El temporizador {} ({}) falló en su intento {}: {}", timer.id(), timer.kind(), timer.attempts() + 1, failure.toString());
                store.fail(timer.id(), token, maxAttempts, retryDelayMs);
                if (timer.attempts() + 1 >= maxAttempts) {
                    log.error("El temporizador {} ({}) agotó sus {} intentos y queda APARCADO", timer.id(), timer.kind(), maxAttempts);
                }
            }
        }
        return sleepMs(store.nextDueMs(kinds), maxSleepMs);
    }

    /**
     * Un tick de un recurrente en modo clúster: lo ejecuta esta réplica porque ganó la fila, FUERA de toda transacción
     * (el mecanismo gestiona las suyas), y lo rearma con el siguiente tick desde la hora de la base de DESPUÉS (R2). Si
     * otra réplica le quitó la fila (el tick duró más que el arriendo), el rearme no casa con la valla y no pisa nada.
     *
     * <p>Un tick que falla NO se aparca, a diferencia de un plazo: se rearma igual para su siguiente tick, como hacía su
     * {@code @Scheduled}. Aparcarlo tras {@code max-attempts} fallos —una base caída unos minutos— dejaría el barrido o
     * la purga sin reloj para siempre, y nada lo volvería a armar: asegurar al arrancar no toca una fila con el mismo spec.
     */
    private void tick(RecurringTimerHandler recurring, ClaimedTimer timer, UUID token) {
        try {
            recurring.tick();
        } catch (RuntimeException failure) {
            log.warn("El tick del recurrente {} falló; se rearma para el siguiente: {}", timer.kind(), failure.toString());
        }
        store.reschedule(timer.id(), token, nextTick(recurring.spec(), store.dbNow()));
    }

    /** Un temporizador armado en ESTA réplica: si vence antes de lo que iba a dormir, despierta (tras el commit). */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onArmed(TimerArmed armed) {
        synchronized (monitor) {
            if (armed.dueAt().toEpochMilli() < wakeAtMs) {
                wakeAtMs = armed.dueAt().toEpochMilli();
                monitor.notifyAll();
            }
        }
    }

    /** Cuándo piensa despertar (milisegundos de la época, según el reloj de la instancia). */
    long wakeAtMs() {
        return wakeAtMs;
    }

    /** Fija cuándo despertar tras una pasada; lo usa el bucle y lo comprueban las pruebas. */
    void planWake(long nowMs, long sleepMs) {
        synchronized (monitor) {
            wakeAtMs = nowMs + sleepMs;
        }
    }

    private void loop() {
        try {
            ensureRecurring();
        } catch (RuntimeException failure) {
            log.error("El cronómetro no pudo asegurar sus recurrentes; lo reintenta en la siguiente pasada", failure);
        }
        while (running) {
            long sleep;
            try {
                sleep = pollOnce();
            } catch (RuntimeException failure) {
                log.error("La pasada del cronómetro falló; se reintenta tras el sueño máximo", failure);
                sleep = maxSleepMs;
            }
            planWake(System.currentTimeMillis(), sleep);
            synchronized (monitor) {
                long remaining;
                while (running && (remaining = wakeAtMs - System.currentTimeMillis()) > 0) {
                    try {
                        monitor.wait(remaining);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        }
    }

    /**
     * El hilo lo da un ejecutor de Spring con hilos de PLATAFORMA, no un {@code Thread} a mano (lo veta
     * check-logging.sh). Empieza sin contexto a propósito, como un {@code @Scheduled}: cada disparo abre el suyo.
     */
    @Override
    public void start() {
        running = true;
        stopped = new CountDownLatch(1);
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("${model.service.artifactId}-timer-");
        executor.setVirtualThreads(false);
        executor.execute(() -> {
            try {
                loop();
            } finally {
                stopped.countDown();
            }
        });
    }

    @Override
    public void stop() {
        running = false;
        synchronized (monitor) {
            monitor.notifyAll();
        }
        // Se espera a la pasada en vuelo: cortarla deja temporizadores arrendados sin hacer hasta que venza el arriendo.
        if (stopped != null) {
            try {
                stopped.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}`;
  return { path: javaPath(model, TIMER_PKG, 'TimerPoller'), content: javaFile(subPackage(model, TIMER_PKG), imports, body) };
}

function timerPurge(model) {
  const P = TIMER_PARAMETERS;
  const body = `/**
 * La purga de la propia tabla del cronómetro (R7): un recurrente más, en modo clúster, así que la ejecuta UNA réplica
 * por tick. Borra lo vencido hace más de la retención y sin reclamar: un temporizador de un kind que ya no conoce
 * ninguna réplica (R4) o uno aparcado que ya se vio.
 */
@Component
public class KeelTimerPurge implements RecurringTimerHandler {

    private final TimerStore store;

    ${value(P.purgeCron)}
    private String cron;

    ${value(P.retentionDays)}
    private int retentionDays;

    public KeelTimerPurge(TimerStore store) {
        this.store = store;
    }

    @Override
    public String kind() {
        return TimerKinds.TIMER_PURGE;
    }

    @Override
    public String spec() {
        return cron;
    }

    @Override
    public void tick() {
        store.purge(retentionDays);
    }
}`;
  return {
    path: javaPath(model, TIMER_PKG, 'KeelTimerPurge'),
    content: javaFile(subPackage(model, TIMER_PKG), ['org.springframework.beans.factory.annotation.Value', 'org.springframework.stereotype.Component'], body)
  };
}

/**
 * El bean que hace cada purga del generador, con su paquete: la purga no cambia (su retención, sus lotes, sus
 * transacciones), solo quién la dispara.
 */
function purgeTarget(model, table) {
  const document = isDocument(model);
  switch (table) {
    case 'outbox_event':
      return { pkg: 'infrastructure.messaging.outbox', className: 'OutboxRelay' };
    case 'processed_event':
      return { pkg: 'infrastructure.messaging.idempotency', className: 'IdempotencyGuard' };
    case 'idempotency_record':
      return { pkg: 'infrastructure.persistence.idempotency', className: document ? 'MongoIdempotencyStore' : 'JpaIdempotencyStore' };
    case 'reconciliation_claim':
      return { pkg: 'infrastructure.persistence.reconciliation', className: 'ReconciliationClaimPurge' };
    default:
      throw new Error(`timer.js: no sé qué bean purga ${table}`);
  }
}

/**
 * El recurrente que dispara la purga de una tabla del generador (incremento 7): antes era un `@Scheduled` que corría en
 * TODAS las réplicas a la vez; ahora lo ejecuta UNA por tick, la que gana su fila en keel_timer. El cron es el de
 * siempre (su clave, su variable y su default de keel-core), evaluado ahora en UTC (T7).
 */
function purgeTimer(model, purge) {
  const className = purgeTimerClass(purge.table);
  const target = purgeTarget(model, purge.table);
  const field = decap(target.className);
  const body = `/**
 * La purga de {@code ${purge.table}}, como recurrente del cronómetro en modo clúster: cada tick lo ejecuta UNA réplica,
 * la que gana su fila en {@code ${KEEL_TIMER.table}}. Lo que borra y cómo (la retención, los lotes, sus transacciones) es
 * lo de {@link ${target.className}#purge()}, que no cambia: solo cambia quién la dispara.
 */
@Component
public class ${className} implements RecurringTimerHandler {

    private final ${target.className} ${field};

    ${value(purge.cron)}
    private String cron;

    public ${className}(${target.className} ${field}) {
        this.${field} = ${field};
    }

    @Override
    public String kind() {
        return TimerKinds.${purgeKindConstant(purge.table)};
    }

    @Override
    public String spec() {
        return cron;
    }

    @Override
    public void tick() {
        ${field}.purge();
    }
}`;
  return {
    path: javaPath(model, TIMER_PKG, className),
    content: javaFile(
      subPackage(model, TIMER_PKG),
      [`${subPackage(model, target.pkg)}.${target.className}`, 'org.springframework.beans.factory.annotation.Value', 'org.springframework.stereotype.Component'],
      body
    )
  };
}

/**
 * El recurrente que dispara el `schedule` de una operación (incremento 8): antes era un `@Scheduled` en el
 * `<Servicio>Scheduler` que corría en TODAS las réplicas; ahora el tick lo ejecuta UNA, la que gana su fila, y DRENA:
 * repite la pasada mientras su lote salga lleno (SweepPass), hasta el siguiente tick o `timer.drain-budget-ms`. El
 * despacho sigue en el `<Servicio>Scheduler` (su transacción o su falta de ella, su correlación, el TODO de los
 * argumentos): aquí solo se decide cuándo y cuántas veces.
 */
function scheduleTimer(model, schedule) {
  const className = scheduleTimerClass(schedule.operation);
  const scheduler = schedulerClassOf(model, schedule.operation);
  const field = decap(scheduler);
  const P = TIMER_PARAMETERS;
  const body = `/**
 * El \`schedule\` de ${schedule.operation} (su cron, {@link #spec()}, en UTC), como recurrente del cronómetro en modo clúster:
 * cada tick lo ejecuta UNA réplica, la que gana su fila en {@code ${KEEL_TIMER.table}}.
 *
 * <p>Por eso el tick DRENA: con una sola réplica trabajando, repite la pasada mientras el lote salga lleno —lo avisa el
 * reclamo con {@link SweepPass#claimed}— y para cuando sale a medias, cuando llega su siguiente tick o cuando agota
 * {@code ${P.drainBudgetMs.key}}, que es menor que el arriendo: un tick más largo que su arriendo lo repetiría otra
 * réplica a la vez. Lo que quede pasa al siguiente tick. Sin aviso (un reclamo que no lo da), una pasada por tick.
 *
 * <p>El tick sigue siendo AL MENOS UNA VEZ: si la réplica muere a mitad, otra lo repite al vencer el arriendo. Por eso el
 * barrido sigue reclamando sus filas, aunque ya no corra en todas las réplicas a la vez.
 */
@Component
public class ${className} implements RecurringTimerHandler {

    private final ${scheduler} ${field};

    ${value(P.drainBudgetMs)}
    private long drainBudgetMs;

    public ${className}(${scheduler} ${field}) {
        this.${field} = ${field};
    }

    @Override
    public String kind() {
        return TimerKinds.${scheduleKindConstant(schedule.operation)};
    }

    /** El cron del diseño con el segundo repartido (scheduleCron de keel-core): no es configurable. */
    @Override
    public String spec() {
        return "${schedule.cron}";
    }

    @Override
    public void tick() {
        Instant start = Instant.now();
        long budget = Math.min(Duration.between(start, TimerPoller.nextTick(spec(), start)).toMillis(), drainBudgetMs);
        for (;;) {
            SweepPass.begin();
            boolean full;
            try {
                ${field}.${schedule.operation}();
            } finally {
                full = SweepPass.end();
            }
            if (!full || Duration.between(start, Instant.now()).toMillis() >= budget) {
                return;
            }
        }
    }
}`;
  return {
    path: javaPath(model, TIMER_PKG, className),
    content: javaFile(
      subPackage(model, TIMER_PKG),
      [
        `${subPackage(model, 'infrastructure.scheduling')}.${scheduler}`,
        sweepPassImport(model),
        'java.time.Duration',
        'java.time.Instant',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}

/**
 * `SweepPass`: la señal con la que una pasada de un barrido le dice al tick que su lote salió LLENO. Va en
 * application/support porque también la llama el handler del agente cuando reclama él (el barrido de pagos, o uno sin
 * reclamo generado), y la aplicación no importa infraestructura. Es un ThreadLocal: el despacho del tick es síncrono, en
 * el hilo del sondeador.
 */
function sweepPass(model) {
  const body = `/**
 * La señal del DRENAJE de un barrido (DSL 2.26, incremento 8): una pasada que reclamó su lote lleno puede dejar
 * candidatos, y el tick del cronómetro la repite.
 *
 * <p>Un tick en modo clúster lo ejecuta UNA réplica, así que, si cada tick hiciera una sola pasada, el barrido rendiría lo
 * de una réplica y no lo de todas. Quien reclama sabe si el lote salió lleno: lo avisan los reclamos que genera build, y
 * TÚ, si el handler reclama su lote a mano, con {@code SweepPass.claimed(reclamadas, lote)}. Sin aviso, el tick hace una
 * pasada, que es correcto pero más lento con atrasos grandes.
 *
 * <p>Fuera de un tick (una prueba, un despacho por otra puerta) no hace nada.
 */
public final class SweepPass {

    private static final ThreadLocal<boolean[]> PASS = new ThreadLocal<>();

    private SweepPass() {
    }

    /** Lo llama quien reclama: {@code claimed} de una cota de {@code batchSize}. Lleno = puede que queden. */
    public static void claimed(int claimed, int batchSize) {
        boolean[] pass = PASS.get();
        if (pass != null && batchSize > 0 && claimed >= batchSize) {
            pass[0] = true;
        }
    }

    /** El tick abre una pasada. */
    public static void begin() {
        PASS.set(new boolean[1]);
    }

    /** El tick la cierra: ¿algún reclamo de la pasada salió lleno? */
    public static boolean end() {
        boolean[] pass = PASS.get();
        PASS.remove();
        return pass != null && pass[0];
    }
}`;
  return { path: javaPath(model, SWEEP_PASS_PKG, 'SweepPass'), content: javaFile(subPackage(model, SWEEP_PASS_PKG), [], body) };
}

function findOperation(model, name) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []).find((operation) => operation.name === name);
}

function deadlineHandler(model, { entity, deadline }) {
  const className = deadlineHandlerClass(entity.name, deadline.stateName);
  const operation = findOperation(model, deadline.by);
  const { field, enumType } = entity.lifecycle;
  const components = messageComponents(model, operation).filter((component) => !component.entryGate);
  const correlated = usesCorrelation(model);
  const imports = [
    'java.time.Instant',
    'java.util.Optional',
    'org.springframework.stereotype.Component',
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`,
    `${subPackage(model, messagePackage(operation))}.${operation.messageClass}`,
    `${subPackage(model, 'domain.repository')}.${entity.name}Repository`,
    `${subPackage(model, entity.isAggregateRoot ? 'domain.aggregate' : 'domain.entity')}.${entity.name}`,
    `${subPackage(model, 'domain.enums')}.${enumType}`,
    deadlinesImport(model),
    correlated ? correlationImport(model) : null,
    correlated ? 'java.util.UUID' : null
  ];
  const message =
    components.length === 1
      ? `new ${operation.messageClass}(timer.entityId())`
      : null;
  const dispatch = message
    ? correlated
      ? `// Cada disparo es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación.
        CorrelationContext.runWith(UUID.randomUUID().toString(), () -> mediator.dispatch(${message}));`
      : `mediator.dispatch(${message});`
    : `// TODO (agente): el mensaje de ${operation.name} pide más que el id de la entidad; constrúyelo aquí.
        throw new UnsupportedOperationException("TODO: despachar ${operation.messageClass} desde el cronómetro");`;
  const repository = `${decap(entity.name)}Repository`;
  const body = `/**
 * El plazo de ${entity.name} en '${deadline.stateName}' (DSL 2.26): vencido ${deadline.since} + el plazo vigente, la entidad
 * pasa a '${deadline.toName}' por ${operation.name}, que despacha este handler.
 *
 * <p>Antes de despachar REVALIDA, con la hora de la base y el plazo de AHORA: si la entidad ya no existe o ya salió de
 * '${deadline.stateName}', el temporizador se descarta sin transición (DL-8); si con el plazo vigente todavía no vence, se
 * rearma (DL-9, T6). Lo que hace ${operation.name} al caducar es del diseño: lo escribe el agente en su handler.
 */
@Component
public class ${className} implements TimerHandler {

    private final ${entity.name}Repository ${repository};
    private final UseCaseMediator mediator;
    private final ${deadlinesClass(model)} deadlines;

    public ${className}(${entity.name}Repository ${repository}, UseCaseMediator mediator, ${deadlinesClass(model)} deadlines) {
        this.${repository} = ${repository};
        this.mediator = mediator;
        this.deadlines = deadlines;
    }

    @Override
    public String kind() {
        return TimerKinds.${kindConstant(entity.name, deadline.stateName)};
    }

    @Override
    public TimerOutcome handle(ClaimedTimer timer, Instant dbNow) {
        Optional<${entity.name}> found = ${repository}.findById(timer.entityId());
        if (found.isEmpty() || found.get().get${cap(field)}() != ${enumType}.${deadline.state}) {
            return TimerOutcome.finished();
        }
        Instant due = found.get().get${cap(deadline.since)}().plus(deadlines.${deadlineComponent(entity.name, deadline.stateName)}());
        if (due.isAfter(dbNow)) {
            return TimerOutcome.rescheduleAt(due);
        }
        ${dispatch}
        return TimerOutcome.finished();
    }
}`;
  return { path: javaPath(model, TIMER_PKG, className), content: javaFile(subPackage(model, TIMER_PKG), imports, body) };
}

// ─── La configuración ────────────────────────────────────────────────────────

/** Los parámetros del cronómetro, en el orden en que salen en `parameters/<perfil>/timer.yaml`. */
export const TIMER_CONFIG_PARAMETERS = Object.freeze([
  TIMER_PARAMETERS.maxSleepMs,
  TIMER_PARAMETERS.batchSize,
  TIMER_PARAMETERS.leaseMs,
  TIMER_PARAMETERS.maxAttempts,
  TIMER_PARAMETERS.retryDelayMs,
  TIMER_PARAMETERS.drainBudgetMs,
  TIMER_PARAMETERS.retentionDays,
  TIMER_PARAMETERS.purgeCron
]);

export { TIMER_SWITCH, deadlineOf };
