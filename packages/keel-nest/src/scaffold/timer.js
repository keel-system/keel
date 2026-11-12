// El cronómetro del servicio y los plazos de negocio en keel-nest (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 4).
//
// Lo neutral —la tabla, sus parámetros, las SENTENCIAS por motor, el `kind` de cada temporizador, la regla del
// vencimiento y el algoritmo del sondeador— está en keel-core/gen (timer-store.js, deadlines.js, timer-poller.js), y es
// contrato de los cuatro servidores: comparten base y esquema. Es lo mismo que emite keel-spring (scaffold/timer.js),
// escrito en TypeScript:
//
//   · `<Servicio>Deadlines`, en el dominio: la duración VIGENTE de cada plazo (en milisegundos). El rechazo tardío la
//     necesita y el dominio no lee configuración, así que viaja por argumento, como `<Servicio>Parameters`;
//   · el rechazo tardío (D2), en el método de transición de la entidad (entities.js lo pide con `lateGuardBlock`);
//   · el reloj inyectable: el puerto `Clock` en application/port/out (lo que en keel-spring es java.time.Clock), con
//     `SystemClock` como adaptador; lo reciben los handlers que sacan la entidad de un estado con plazo;
//   · el armado, en el adaptador del repositorio, en la transacción del caso de uso (`adapterArming`);
//   · el almacén (`TimerStore`): SQL con las sentencias de keel-core TAL CUAL (los marcadores se pasan al estilo del
//     driver al ejecutar, como hace el JdbcClient de keel-spring), o MongoDB con su forma documental;
//   · el sondeador (`TimerPoller`): un bucle por réplica que reclama, revalida, despacha y duerme hasta el siguiente
//     vencimiento; se apaga con `scheduling.enabled` (TIMER_SWITCH), el MISMO interruptor que ya apagaba el reloj de
//     keel-nest: desde la 2.26 gobierna también al cronómetro;
//   · el despacho de cada plazo (`<Entidad><Estado>Deadline`) y la purga de la propia tabla (R7), el primer recurrente.
//
// Desde el incremento 7, las purgas de las tablas del generador también corren aquí, como recurrentes en modo clúster
// (`<Tabla>PurgeTimer`, que llama a TablePurges): una réplica por tick en vez de todas a la vez. Por eso el cronómetro
// existe con plazos O con purgas (`usesTimer`, keel-core/gen/timer-plan.js), y lo de los plazos solo con plazos.
//
// Desde el incremento 8, el `schedule` de cada operación también (`<Operación>ScheduleTimer`, que llama al método del
// `<Grupo>Scheduler`, ya sin registrarse en el reloj de scheduling.js), con DRENAJE: el tick lo ejecuta una réplica y
// repite la pasada mientras su lote salga lleno (`SweepPass`, que avisan los reclamos generados). Un recurrente que falla
// no se aparca: se rearma. El relay sigue en su bucle: migra en el incremento 9. El modo POR RÉPLICA no se emite (su
// único usuario es el relay, inc. 9).

import { modelDeadlines, usesDeadlines, lateGuards, deadlineOf, CLOCK_PORT } from '@keel-system/keel-core/gen/deadlines';
import { TIMER_DATABASES, claimDrains, clusterRecurrings, scheduledByTimer, timerPurges, timerSchedules, usesTimer } from '@keel-system/keel-core/gen/timer-plan';
import { agingSweeps, documentAgingTargets, relationalAgingTargets } from '@keel-system/keel-core/gen/aging-targets';
import { rescueProbes } from '@keel-system/keel-core/gen';
import { pascalCase } from '@keel-system/keel-core/gen';
import {
  KEEL_TIMER,
  KEEL_TIMER_DOCUMENT,
  NIL_ENTITY_ID,
  TIMER_ENGINES,
  TIMER_PARAMETERS,
  TIMER_PURGE_KIND,
  TIMER_SWITCH,
  scheduleKind,
  timerStatements
} from '@keel-system/keel-core/gen/timer-store';
import { needsReadCommitted } from '@keel-system/keel-core/gen/infra-catalog';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { DIRS, classPath, tsModule, tsString, fileName } from './render.js';
import { TRANSFORMERS_TS, engineOf, optionsLiteral, physicalColumn, usesDocument } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS, portClass, portPath } from './repositories.js';
import { MEDIATOR_TS } from './mediator.js';
import { CORRELATION_TS, usesCorrelation } from './rest-support.js';
import { messageComponents, messagePath } from './services.js';
import { parametersClass, parametersPath } from './service-parameters.js';
import { TABLE_PURGES_TS, tablePurges } from './purge.js';
import { schedulerClass, schedulerPath } from './scheduling.js';
import { TELEMETRY_TS, usesTelemetry } from './telemetry.js';
import { ATTRIBUTES, OBSERVATIONS, TIMER_LAG, TIMER_PARKED } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { RETENTION_SETTINGS_TS, retentionKindLines, retentionProviders } from './data-lifecycle.js';

export { usesDeadlines, usesTimer, deadlineOf, TIMER_DATABASES };

const TIMER_DIR = 'infrastructure/timer';
export const CLOCK_TS = classPath(DIRS.portOut, CLOCK_PORT.name);
export const SYSTEM_CLOCK_TS = classPath(TIMER_DIR, 'SystemClock');
export const TIMER_KINDS_TS = classPath(TIMER_DIR, 'TimerKinds');
export const TIMER_STORE_TS = classPath(TIMER_DIR, 'TimerStore');
export const SQL_TIMER_STORE_TS = classPath(TIMER_DIR, 'SqlTimerStore');
export const MONGO_TIMER_STORE_TS = classPath(TIMER_DIR, 'MongoTimerStore');
export const TIMER_SETTINGS_TS = classPath(TIMER_DIR, 'TimerSettings');
export const TIMER_POLLER_TS = classPath(TIMER_DIR, 'TimerPoller');
export const TIMER_PURGE_TS = classPath(TIMER_DIR, 'KeelTimerPurge');
export const TIMER_MODULE_TS = classPath(TIMER_DIR, 'TimerModule');
/** La tabla, mapeada SOLO para el esquema (synchronize en local, el baseline y el paso de build del 2b). */
export const KEEL_TIMER_ORM_TS = 'src/infrastructure/persistence/timer/keel-timer-orm.ts';
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** `OutboxEventPurgeTimer`: el recurrente que dispara la purga de una tabla del generador (el nombre de keel-spring). */
export function purgeTimerClass(table) {
  return `${pascalCase(table)}PurgeTimer`;
}
export function purgeTimerPath(table) {
  return classPath(TIMER_DIR, purgeTimerClass(table));
}
/** La clave de `TimerKinds` de la purga de una tabla: `PURGE_OUTBOX_EVENT`. */
export function purgeKindConstant(table) {
  return `PURGE_${table.toUpperCase()}`;
}

/** `DispatchJobsScheduleTimer`: el recurrente que dispara el `schedule` de una operación (el nombre de keel-spring). */
export function scheduleTimerClass(operationName) {
  return `${operationName[0].toUpperCase()}${operationName.slice(1)}ScheduleTimer`;
}
export function scheduleTimerPath(operationName) {
  return classPath(TIMER_DIR, scheduleTimerClass(operationName));
}
/** La clave de `TimerKinds` del `schedule` de una operación: `SCHEDULE_DISPATCH_JOBS`. */
export function scheduleKindConstant(operationName) {
  return `SCHEDULE_${operationName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}
/** El grupo (servicio) de una operación con `schedule`: su scheduler la despacha. */
export function scheduleService(model, operationName) {
  return (model.services ?? []).find((service) => (service.operations ?? []).some((operation) => operation.name === operationName));
}

/** La señal de lote lleno del drenaje (inc. 8): en application/support, porque la llaman los handlers del agente. */
export const SWEEP_PASS_TS = classPath(DIRS.appSupport, 'SweepPass');
export function usesSweepPass(model) {
  return timerSchedules(model).length > 0;
}
/**
 * La línea con la que un reclamo GENERADO avisa al tick de que su lote salió lleno (o nada, si su operación no corre
 * sobre el cronómetro). `size` y `batch` son expresiones TypeScript; `indent`, la sangría.
 */
export function sweepPassSignal(model, claim, size, batch, indent = '    ') {
  if (!claimDrains(model, claim)) return '';
  return `${indent}// Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
${indent}SweepPass.claimed(${size}, ${batch});
`;
}
export const sweepPassImport = () => ({ symbol: 'SweepPass', from: SWEEP_PASS_TS });

/**
 * Lo que un diseño con plazos no puede generar con este stack, o []: el cronómetro solo existe donde sus sentencias se
 * midieron (timer-sql-check), el rechazo tardío necesita un `code` con un solo status, y `keel_timer.entity_id` es un
 * uuid (un id `long` no cabe en él). Lo mismo que keel-spring, más el último motivo, que allí no se comprueba.
 */
export function timerStackErrors(model) {
  if (!usesDeadlines(model)) return [];
  const errors = [];
  if (!model.layersPresent?.persistence) {
    errors.push('lifecycle.deadlines (DSL 2.26): el cronómetro vive en la base del servicio, y este diseño no tiene capa persistence.');
  } else if (!TIMER_DATABASES.includes(model.stack?.database)) {
    errors.push(
      `lifecycle.deadlines (DSL 2.26): el cronómetro no tiene sentencias medidas para '${model.stack?.database}' ` +
        `(las hay para ${TIMER_DATABASES.join(', ')}). Elige uno de esos motores o genera el diseño sin el plazo.`
    );
  }
  for (const { entity } of modelDeadlines(model)) {
    if ((entity.idField?.base ?? 'uuid') !== 'uuid') {
      errors.push(
        `domain: ${entity.name}.lifecycle.deadlines (DSL 2.26): el id de ${entity.name} no es un uuid, y el temporizador ` +
          `de un plazo lo guarda en ${KEEL_TIMER.table}.entity_id, que es uuid en los cuatro servidores.`
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
  return [...new Set(errors)];
}

// ─── Nombres ─────────────────────────────────────────────────────────────────

const cap = (name) => name[0].toUpperCase() + name.slice(1);
const decap = (name) => name[0].toLowerCase() + name.slice(1);

export function deadlinesClass(model) {
  return `${model.service.className}Deadlines`;
}
export function deadlinesPath(model) {
  return classPath('domain/deadline', deadlinesClass(model));
}
/** La propiedad de `<Servicio>Deadlines` que lleva la duración de un plazo, en milisegundos: `verificationCodePendingMs`. */
export function deadlineComponent(entityName, stateName) {
  return `${decap(entityName)}${cap(stateName)}Ms`;
}
export function deadlineHandlerClass(entityName, stateName) {
  return `${entityName}${cap(stateName)}Deadline`;
}
export function deadlineHandlerPath(entityName, stateName) {
  return classPath(TIMER_DIR, deadlineHandlerClass(entityName, stateName));
}
/** La clave de `TimerKinds`: `VERIFICATION_CODE_PENDING`. */
export function kindConstant(entityName, stateName) {
  return `${entityName}_${stateName}`.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
const timerStoreImplPath = (model) => (usesDocument(model) ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS);
const timerStoreImplClass = (model) => (usesDocument(model) ? 'MongoTimerStore' : 'SqlTimerStore');

/** Los archivos que emite este módulo, para quien los cablea (app.module, la prueba de los casos de uso). */
export function timerModules(model) {
  if (!usesTimer(model)) return null;
  return { timerModule: { symbol: 'TimerModule', from: TIMER_MODULE_TS }, pollerModule: { symbol: 'TimerPollerModule', from: TIMER_MODULE_TS } };
}

// ─── El rechazo tardío, en el dominio (lo emite entities.js) ─────────────────

/**
 * La guarda del lifecycle de una entidad con rechazos tardíos, o null si no tiene ninguno. Con dos firmas (sobrecargas):
 * sin la hora solo vale para las transiciones que no salen de un estado con plazo hacia otro destino —para esas se niega:
 * sin la hora no hay rechazo tardío, y callarlo sería confirmar lo que el negocio daba por caducado—; con la hora y los
 * plazos vigentes, rechaza con el `code` de lateAction en el instante exacto del vencimiento (since + after <= now, D3).
 */
export function lateGuardBlock(model, entity, imports) {
  const guards = lateGuards(entity);
  if (guards.length === 0) return null;
  const { field, enumType } = entity.lifecycle;
  imports.push({ symbol: deadlinesClass(model), from: deadlinesPath(model), type: true });
  const deadlines = entity.lifecycle.deadlines;
  const sinceNullable = (since) => {
    const def = entity.fields.find((candidate) => candidate.name === since);
    return !(def?.required || def?.generated);
  };
  const checks = guards.map((guard) => {
    const deadline = deadlines.find((candidate) => candidate.state === guard.from);
    const error = (model.errors ?? []).find((candidate) => candidate.code === guard.error);
    if (error) imports.push({ symbol: error.exceptionClass, from: classPath(DIRS.errors, error.exceptionClass) });
    const thrown = error ? `new ${error.exceptionClass}(${tsString(error.when ?? guard.error)})` : `new Error(${tsString(guard.error)})`;
    const nullCheck = sinceNullable(guard.since)
      ? `
      if (this.#${guard.since} == null) {
        throw new Error(${tsString(`${entity.name} en ${deadline.stateName} sin ${guard.since}: el plazo no se puede medir`)});
      }`
      : '';
    return `    // Plazo de '${deadline.stateName}' (DSL 2.26): pasado ${guard.since} + el plazo vigente, salir hacia otro destino
    // que '${deadline.toName}' es ${guard.error}. Vence EN el instante (since + after <= now), no después.
    if (this.#${field} === ${enumType}.${guard.from} && target !== ${enumType}.${guard.exempt}) {
      if (now === undefined || deadlines === undefined) {
        throw new Error('Esta transición sale de un estado con plazo: usa transitionTo(target, now, deadlines)');
      }${nullCheck}
      if (this.#${guard.since}.getTime() + deadlines.${deadlineComponent(entity.name, deadline.stateName)} <= now.getTime()) {
        throw ${thrown};
      }
    }`;
  });
  const fieldDef = entity.fields.find((candidate) => candidate.name === field);
  const nullable = fieldDef && !(fieldDef.required || fieldDef.isId || fieldDef.generated);
  const allowed = nullable
    ? `const allowed = current == null ? undefined : ${entity.name}.#TRANSITIONS.get(current);`
    : `const allowed = ${entity.name}.#TRANSITIONS.get(current);`;
  const deadlinesType = deadlinesClass(model);
  return `  // Guarda interna del lifecycle con el RECHAZO TARDÍO de los plazos (DSL 2.26): la llaman los métodos semánticos,
  // nunca un handler. \`now\` es la hora del reloj inyectable (el puerto ${CLOCK_PORT.name}, ${CLOCK_TS}) y \`deadlines\`
  // la duración vigente de cada plazo: los dos los recibe el método semántico del handler. Sin la hora solo valen las
  // transiciones que no salen de un estado con plazo hacia otro destino que el suyo.
  private transitionTo(target: ${enumType}): void;
  private transitionTo(target: ${enumType}, now: Date, deadlines: ${deadlinesType}): void;
  private transitionTo(target: ${enumType}, now?: Date, deadlines?: ${deadlinesType}): void {
${checks.join('\n')}
    const current = this.#${field};
    ${allowed}
    if (!allowed?.has(target)) {
      throw new InvalidStateTransitionException(String(current), target);
    }
    this.#${field} = target;
  }`;
}

/** ¿Pide esta transición la hora? Para el TODO del método semántico. */
export function transitionNeedsClock(entity, fromConstant, toConstant) {
  return lateGuards(entity).some((guard) => guard.from === fromConstant && guard.exempt !== toConstant);
}

// ─── El armado, en el adaptador (lo usan repositories.js y document-repositories.js) ─────

function deadlinesOf(model, entity) {
  return modelDeadlines(model).filter((entry) => entry.entity.name === entity.name);
}

/** Las dependencias del constructor del adaptador que arma: el almacén y los plazos vigentes. Van las ÚLTIMAS. */
export function armingDependencies(model, entity) {
  if (deadlinesOf(model, entity).length === 0) return [];
  return [
    { token: 'TimerStore', name: 'timers', type: 'TimerStore', imports: [{ symbol: 'TimerStore', from: TIMER_STORE_TS }] },
    { token: deadlinesClass(model), name: 'deadlines', type: deadlinesClass(model), imports: [{ symbol: deadlinesClass(model), from: deadlinesPath(model) }] }
  ];
}

/**
 * Las líneas del armado en el `save` del adaptador, o null. `previous` es la expresión del estado que la entidad tenía
 * en la base (null si es nueva): solo ENTRAR en el estado arma (salir no cuesta nada, y re-guardarla dentro no lo
 * rearma). Va tras persistir, dentro de la misma transacción: si revierte, no queda temporizador.
 */
export function adapterArming(model, entity, imports, previous) {
  const entries = deadlinesOf(model, entity);
  if (entries.length === 0) return null;
  const { field, enumType } = entity.lifecycle;
  imports.push({ symbol: 'TimerKinds', from: TIMER_KINDS_TS }, { symbol: enumType, from: classPath(DIRS.enums, enumType) });
  const idName = entity.idField?.name ?? 'id';
  return entries
    .map(
      ({ deadline }) => `      // El plazo de '${deadline.stateName}' se ARMA al entrar, en esta misma transacción: si revierte, no queda.
      if (${previous} !== ${enumType}.${deadline.state} && entity.${field} === ${enumType}.${deadline.state}) {
        await this.timers.arm(TimerKinds.${kindConstant(entity.name, deadline.stateName)}, entity.${idName}, new Date(entity.${deadline.since}.getTime() + this.deadlines.${deadlineComponent(entity.name, deadline.stateName)}));
      }`
    )
    .join('\n');
}

// ─── Lo que emite build ──────────────────────────────────────────────────────

export function generate(model) {
  if (!usesTimer(model)) return [];
  const document = usesDocument(model);
  const deadlines = usesDeadlines(model);
  const files = [
    ...(deadlines
      ? [
          { path: CLOCK_TS, content: clockFile() },
          { path: SYSTEM_CLOCK_TS, content: systemClockFile() },
          { path: deadlinesPath(model), content: deadlinesFile(model) }
        ]
      : []),
    { path: TIMER_KINDS_TS, content: timerKindsFile(model) },
    { path: TIMER_STORE_TS, content: timerStoreFile() },
    document ? { path: MONGO_TIMER_STORE_TS, content: mongoTimerStoreFile() } : { path: SQL_TIMER_STORE_TS, content: sqlTimerStoreFile(model) },
    { path: TIMER_SETTINGS_TS, content: timerSettingsFile() },
    { path: TIMER_POLLER_TS, content: timerPollerFile(model) },
    { path: TIMER_PURGE_TS, content: timerPurgeFile() },
    ...timerPurges(model).map((purge) => ({ path: purgeTimerPath(purge.table), content: purgeTimerFile(model, purge) })),
    ...timerSchedules(model).map((schedule) => ({ path: scheduleTimerPath(schedule.operation), content: scheduleTimerFile(model, schedule) })),
    ...(usesSweepPass(model) ? [{ path: SWEEP_PASS_TS, content: sweepPassFile() }] : []),
    ...modelDeadlines(model).map((entry) => ({ path: deadlineHandlerPath(entry.entity.name, entry.deadline.stateName), content: deadlineHandlerFile(model, entry) })),
    { path: TIMER_MODULE_TS, content: timerModuleFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/timer.yaml`, content: timerYaml(profile) }))
  ];
  if (!document) files.push({ path: KEEL_TIMER_ORM_TS, content: keelTimerOrmFile(model) });
  return files;
}

/** La entidad de la tabla, para el DataSource (relacional). */
export function timerEntities(model) {
  if (!usesTimer(model) || usesDocument(model)) return [];
  return [{ symbol: 'KeelTimerOrm', from: KEEL_TIMER_ORM_TS }];
}

function clockFile() {
  return tsModule(
    CLOCK_TS,
    [],
    `/**
 * El reloj inyectable (DSL 2.26): el puerto ${CLOCK_PORT.name} del método, proyectado a TypeScript (en keel-spring es
 * java.time.Clock). Lo reciben los handlers que sacan una entidad de un estado con plazo, y le pasan al dominio
 * \`clock.${CLOCK_PORT.method}()\`: una prueba lo sustituye por un reloj parado para medir el segundo exacto del vencimiento.
 * Es la hora de ESTA instancia (T2); la del cronómetro es la de la base (T1).
 */
export abstract class ${CLOCK_PORT.name} {
  /** El instante actual. */
  abstract ${CLOCK_PORT.method}(): Date;
}`
  );
}

function systemClockFile() {
  return tsModule(
    SYSTEM_CLOCK_TS,
    [{ symbol: CLOCK_PORT.name, from: CLOCK_TS }],
    `/** El reloj del sistema: la hora de esta instancia, la que da el reloj inyectable fuera de las pruebas. */
export class SystemClock extends ${CLOCK_PORT.name} {
  ${CLOCK_PORT.method}(): Date {
    return new Date();
  }
}`
  );
}

function deadlinesFile(model) {
  const entries = modelDeadlines(model);
  const params = entries.map(
    ({ entity, deadline }) => `    /** Cuánto puede seguir un ${entity.name} en '${deadline.stateName}' (desde ${deadline.since}), en milisegundos. */
    readonly ${deadlineComponent(entity.name, deadline.stateName)}: number`
  );
  const guards = entries.map(({ entity, deadline }) => {
    const name = deadlineComponent(entity.name, deadline.stateName);
    return `    if (!Number.isFinite(${name}) || ${name} <= 0) {
      throw new Error(\`El plazo de ${entity.name}.${deadline.stateName} tiene que ser positivo: \${${name}}\`);
    }`;
  });
  return tsModule(
    deadlinesPath(model),
    [],
    `/**
 * La duración VIGENTE de cada plazo de negocio del servicio (DSL 2.26, \`lifecycle.deadlines\`), en milisegundos.
 *
 * Value object de dominio, como ${parametersClass(model)}: el rechazo tardío del método de transición la necesita y
 * el dominio no lee configuración. Lo puebla TimerModule, y lo usan con el MISMO valor el dominio (el rechazo), el
 * adaptador (el armado) y el cronómetro (la revalidación): cambiar el plazo en un despliegue no reescribe los
 * temporizadores armados, los corrige la revalidación (T6).
 */
export class ${deadlinesClass(model)} {
  constructor(
${params.join(',\n')}
  ) {
${guards.join('\n')}
  }
}`
  );
}

function timerKindsFile(model) {
  const constants = [
    ...modelDeadlines(model).map(
      ({ entity, deadline, kind }) => `  /** El plazo de ${entity.name} en '${deadline.stateName}'. */
  ${kindConstant(entity.name, deadline.stateName)}: ${tsString(kind)},`
    ),
    ...timerPurges(model).map(
      (purge) => `  /** La purga de \`${purge.table}\`: un recurrente en modo clúster. */
  ${purgeKindConstant(purge.table)}: ${tsString(purge.kind)},`
    ),
    ...timerSchedules(model).map(
      (schedule) => `  /** El \`schedule\` de ${schedule.operation}: un recurrente en modo clúster, con drenaje. */
  ${scheduleKindConstant(schedule.operation)}: ${tsString(schedule.kind)},`
    ),
    // Las retenciones (DSL 2.28, D8): un recurrente en modo clúster por raíz.
    ...retentionKindLines(model)
  ];
  return tsModule(
    TIMER_KINDS_TS,
    [],
    `/**
 * El nombre de cada temporizador en \`${KEEL_TIMER.table}\` (columna \`kind\`). Es contrato con los otros generadores
 * —comparten tabla—, así que sale de keel-core y no se cambia aquí.
 */
export const TimerKinds = {
${constants.join('\n')}
  /** La purga de la propia tabla: un recurrente en modo clúster (R7). */
  TIMER_PURGE: ${tsString(TIMER_PURGE_KIND)}
} as const;

/** El \`entity_id\` de un recurrente: no tiene entidad, y la unicidad (kind, entity_id) necesita un valor. */
export const NIL_ENTITY_ID = ${tsString(NIL_ENTITY_ID)};`
  );
}

function timerStoreFile() {
  return tsModule(
    TIMER_STORE_TS,
    [],
    `/**
 * Un temporizador que ESTA réplica reclamó: lo es mientras dure su arriendo, y todo lo que se haga con él lleva la valla
 * (\`token\`) con la que se reclamó.
 */
export interface ClaimedTimer {
  /** Su identidad en la tabla (el uuid, o el \`_id\` documental). */
  readonly id: string;
  /** Qué es: un plazo o un recurrente (TimerKinds). */
  readonly kind: string;
  /** La entidad de un plazo; el uuid nulo en un recurrente. */
  readonly entityId: string;
  /** Cuándo vencía. */
  readonly dueAt: Date;
  /** Cuántas veces falló ya. */
  readonly attempts: number;
}

/** El desenlace de un temporizador: borrarlo, o rearmarlo para otro vencimiento. */
export type TimerOutcome = { readonly done: true } | { readonly done: false; readonly dueAt: Date };

export const TimerOutcome = {
  /** Cumplido o descartado: se borra. */
  finished: (): TimerOutcome => ({ done: true }),
  /** Un recurrente tras su tick, o un plazo que la revalidación aplaza. */
  rescheduleAt: (dueAt: Date): TimerOutcome => ({ done: false, dueAt })
};

/**
 * Lo que hace el cronómetro con los temporizadores de un \`kind\`. Corre DENTRO de la transacción en la que el sondeador
 * borra o rearma el temporizador: si lanza, la transacción revierte, el fallo se cuenta y, al agotar los intentos, el
 * temporizador se aparca (T5).
 */
export interface TimerHandler {
  readonly kind: string;
  /** \`dbNow\` es la hora de la BASE (T1): la única que compara el cronómetro. */
  handle(timer: ClaimedTimer, dbNow: Date): Promise<TimerOutcome>;
}

/**
 * Un temporizador RECURRENTE en modo clúster: una fila sin entidad, que cada réplica asegura al arrancar (R1) y que en
 * cada tick ejecuta UNA sola réplica, la que la reclama. El siguiente tick lo calcula el sondeador desde la hora de la
 * base de DESPUÉS del tick (R2), con el cron en UTC (T7).
 *
 * El tick corre FUERA de toda transacción, a diferencia de un plazo: un recurrente (una purga por lotes) gestiona las
 * suyas, y envolverlo en una sola volvería a ser el DELETE único que la purga por lotes sustituye. Si lanza, el sondeador
 * lo registra y lo rearma para su siguiente tick: un recurrente no se aparca nunca.
 */
export interface RecurringTimerHandler {
  /** El nombre del temporizador en la tabla (TimerKinds). */
  readonly kind: string;
  /** El cron de seis campos (el segundo primero), evaluado en UTC. */
  readonly spec: string;
  /** Un tick: lo que hace el mecanismo cada vez que vence. */
  tick(): Promise<void>;
}

/** Token de la lista de handlers de los plazos. */
export const TIMER_HANDLERS = Symbol('TIMER_HANDLERS');

/** Token de la lista de recurrentes del cronómetro. */
export const TIMER_RECURRINGS = Symbol('TIMER_RECURRINGS');

/**
 * Un temporizador recién armado, avisado DESPUÉS del commit: el sondeador de esta réplica lo escucha y, si vence antes de
 * lo que pensaba dormir, despierta. Así un plazo corto no espera al tope del sueño.
 */
export class TimerArmedSignal {
  readonly #listeners = new Set<(dueAt: Date) => void>();

  subscribe(listener: (dueAt: Date) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  armed(dueAt: Date): void {
    for (const listener of this.#listeners) listener(dueAt);
  }
}

/**
 * La tabla del cronómetro (\`${KEEL_TIMER.table}\`), detrás de un puerto: las sentencias son las de keel-core, iguales en
 * los cuatro generadores, y la hora que comparan es SIEMPRE la de la base.
 */
export abstract class TimerStore {
  /** La hora de la base. */
  abstract dbNow(): Promise<Date>;

  /** Arma un plazo (o lo rearma si ya existía), en la transacción en curso. */
  abstract arm(kind: string, entityId: string, dueAt: Date): Promise<void>;

  /** Asegura la fila de un recurrente: la crea, o recalcula su vencimiento si su spec cambió (R1). */
  abstract ensureRecurring(kind: string, spec: string, dueAt: Date): Promise<void>;

  /** Reclama lo vencido y libre de esos kinds, en orden de vencimiento, con arriendo y valla. Confirma antes de volver. */
  abstract claim(kinds: readonly string[], limit: number, leaseMs: number, token: string): Promise<ClaimedTimer[]>;

  /** Borra un temporizador, solo si sigue siendo de quien lo reclamó. */
  abstract complete(id: string, token: string): Promise<boolean>;

  /** Lo rearma, libre y con los intentos a cero, solo con la valla. */
  abstract reschedule(id: string, token: string, dueAt: Date): Promise<boolean>;

  /** Cuenta un fallo; tras el retraso se reintenta y, al agotar los intentos, se aparca. */
  abstract fail(id: string, token: string, maxAttempts: number, retryDelayMs: number): Promise<boolean>;

  /** Cuántos milisegundos faltan para lo próximo reclamable de esos kinds (null: nada; puede ser negativo). */
  abstract nextDueMs(kinds: readonly string[]): Promise<number | null>;

  /** Los aparcados, de todos los kinds (T5). */
  abstract parkedCount(): Promise<number>;

  /** Cuántos milisegundos lleva esperando lo más antiguo reclamable YA de esos kinds (null: nada). El retraso del cronómetro. */
  abstract lagMs(kinds: readonly string[]): Promise<number | null>;

  /** La purga de la tabla: vencido hace más de la retención y sin reclamar (R4, R7). */
  abstract purge(retentionDays: number): Promise<number>;
}`
  );
}

// ─── El almacén relacional: las sentencias de keel-core, tal cual ────────────

const STATEMENT_NAMES = ['dbNow', 'arm', 'ensureRecurring', 'claimLock', 'claimMark', 'claimed', 'complete', 'reschedule', 'fail', 'nextDueMs', 'parkedCount', 'lagMs', 'purge'];

function sqlTimerStoreFile(model) {
  const engine = engineOf(model);
  const sql = timerStatements(engine);
  const mysql = engine === 'mysql';
  const statements = STATEMENT_NAMES.map((name) => `  ${name}: ${tsString(sql[name])}`).join(',\n');
  const isolation = needsReadCommitted(engine) ? ", { isolation: 'READ COMMITTED' }" : '';
  const codec = mysql
    ? `// MySQL: el uuid es binary(16) (el orden de bytes de Hibernate y del UUID_BINARY de las entidades) y la hora un
// datetime(6) con la hora UTC, que es como la escriben los cuatro servidores y como la lee UTC_TIMESTAMP(6). El driver
// convierte un Date en los dos sentidos con \`timezone: 'Z'\` (data-source-options.ts).
function uuid(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function readUuid(value: unknown): string {
  const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value).replaceAll('-', '');
  return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
}

/** \`?\`: el estilo de mysql2. */
const marker = (_position: number): string => '?';`
    : `// PostgreSQL: uuid nativo y timestamp with time zone; el driver convierte un Date en los dos sentidos.
function uuid(value: string): string {
  return value;
}

function readUuid(value: unknown): string {
  return String(value);
}

/** \`$n\`: el estilo de node-postgres. */
const marker = (position: number): string => \`$\${position}\`;`;
  return tsModule(
    SQL_TIMER_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'EntityManager', from: 'typeorm', type: true },
      { symbol: 'randomUUID', from: 'node:crypto' },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'NIL_ENTITY_ID', from: TIMER_KINDS_TS },
      { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerArmedSignal', from: TIMER_STORE_TS },
      { symbol: 'TimerStore', from: TIMER_STORE_TS }
    ],
    `/**
 * Las sentencias del cronómetro de keel-core (\`timer-store.js\`) para ${mysql ? 'MySQL' : 'PostgreSQL'}, TAL CUAL: son contrato
 * con los otros generadores, que comparten la tabla, y las mide \`timer-sql-check\` contra el motor. No las reescribas
 * aquí. Llevan marcadores nombrados (\`:kind\`); \`bind\` los pasa al estilo del driver al ejecutar, y expande una lista
 * (\`:kinds\`, \`:ids\`) en tantos marcadores como elementos.
 */
const SQL = {
${statements}
} as const;

${codec}

/** Los marcadores nombrados al estilo del driver, en orden de aparición; una lista se expande. */
function bind(sql: string, values: Readonly<Record<string, unknown>>): [string, unknown[]] {
  const params: unknown[] = [];
  const text = sql.replace(/(?<![:\\w]):([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(\`Falta el valor de :\${name} en una sentencia del cronómetro\`);
    const value = values[name];
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error(\`La lista :\${name} necesita al menos un elemento\`);
      return value.map((item) => {
        params.push(item);
        return marker(params.length);
      }).join(', ');
    }
    params.push(value);
    return marker(params.length);
  });
  return [text, params];
}

/** El primer valor de la primera fila (una sentencia de una sola columna), o null. */
function single(records: readonly Record<string, unknown>[]): unknown {
  const row = records[0];
  return row == null ? null : Object.values(row)[0] ?? null;
}

/**
 * El cronómetro sobre ${mysql ? 'MySQL' : 'PostgreSQL'}. Va con SQL a pelo y no por el ORM: las sentencias usan la hora de la base,
 * \`FOR UPDATE SKIP LOCKED\` y el upsert de cada motor, que el constructor de consultas no dice. Sobre el mismo
 * DataSource que los repositorios, y por la transacción en curso (TransactionContext): el armado entra en la del caso
 * de uso.
 */
@Injectable()
export class SqlTimerStore extends TimerStore {
  constructor(
    @Inject(TransactionContext) private readonly transactions: TransactionContext,
    @Inject(TimerArmedSignal) private readonly signal: TimerArmedSignal
  ) {
    super();
  }

  /** Ejecuta una sentencia en la transacción en curso (o en una propia, si no la hay): sus filas y cuántas tocó. */
  private async run(manager: EntityManager, sql: string, values: Readonly<Record<string, unknown>> = {}): Promise<{ records: Record<string, unknown>[]; affected: number }> {
    const [text, params] = bind(sql, values);
    const runner = manager.queryRunner;
    if (runner == null) throw new Error('El cronómetro ejecuta sus sentencias dentro de una transacción');
    const result = await runner.query(text, params, true);
    const records = Array.isArray(result.records) ? (result.records as Record<string, unknown>[]) : [];
    return { records, affected: Number(result.affected ?? 0) };
  }

  private exec(sql: string, values: Readonly<Record<string, unknown>> = {}): Promise<{ records: Record<string, unknown>[]; affected: number }> {
    return this.transactions.inTransaction((manager) => this.run(manager, sql, values));
  }

  async dbNow(): Promise<Date> {
    return new Date(single((await this.exec(SQL.dbNow)).records) as Date | string);
  }

  async arm(kind: string, entityId: string, dueAt: Date): Promise<void> {
    await this.exec(SQL.arm, { id: uuid(randomUUID()), kind, entityId: uuid(entityId), spec: null, dueAt });
    // Tras el commit (o ya, sin transacción): si revierte, no hay nada que despertar.
    await this.transactions.afterCommit(() => this.signal.armed(dueAt));
  }

  async ensureRecurring(kind: string, spec: string, dueAt: Date): Promise<void> {
    await this.exec(SQL.ensureRecurring, { id: uuid(randomUUID()), kind, entityId: uuid(NIL_ENTITY_ID), spec, dueAt });
  }

  claim(kinds: readonly string[], limit: number, leaseMs: number, token: string): Promise<ClaimedTimer[]> {
    // Las tres sentencias en UNA transacción PROPIA: confirma antes de volver, así que las demás réplicas dejan de ver el
    // lote aunque quien llama tarde en procesarlo.
    return this.transactions.inNewTransaction(async (manager) => {
      const locked = await this.run(manager, SQL.claimLock, { kinds: [...kinds], limit });
      const ids = locked.records.map((row) => row.id);
      if (ids.length === 0) return [];
      await this.run(manager, SQL.claimMark, { leaseMs, token: uuid(token), ids });
      const claimed = await this.run(manager, SQL.claimed, { token: uuid(token) });
      return claimed.records.map((row) => ({
        id: readUuid(row.id),
        kind: String(row.kind),
        entityId: readUuid(row.entity_id),
        dueAt: new Date(row.due_at as Date | string),
        attempts: Number(row.attempts)
      }));
    }${isolation});
  }

  async complete(id: string, token: string): Promise<boolean> {
    return (await this.exec(SQL.complete, { id: uuid(id), token: uuid(token) })).affected > 0;
  }

  async reschedule(id: string, token: string, dueAt: Date): Promise<boolean> {
    return (await this.exec(SQL.reschedule, { dueAt, id: uuid(id), token: uuid(token) })).affected > 0;
  }

  async fail(id: string, token: string, maxAttempts: number, retryDelayMs: number): Promise<boolean> {
    return (await this.exec(SQL.fail, { maxAttempts, retryDelayMs, id: uuid(id), token: uuid(token) })).affected > 0;
  }

  async nextDueMs(kinds: readonly string[]): Promise<number | null> {
    const value = single((await this.exec(SQL.nextDueMs, { kinds: [...kinds] })).records);
    return value == null ? null : Number(value);
  }

  async parkedCount(): Promise<number> {
    return Number(single((await this.exec(SQL.parkedCount)).records) ?? 0);
  }

  async lagMs(kinds: readonly string[]): Promise<number | null> {
    const value = single((await this.exec(SQL.lagMs, { kinds: [...kinds] })).records);
    return value == null ? null : Number(value);
  }

  async purge(retentionDays: number): Promise<number> {
    return (await this.exec(SQL.purge, { retentionDays })).affected;
  }
}`
  );
}

function keelTimerOrmFile(model) {
  const engine = engineOf(model);
  const transformers = new Set();
  const types = { timestamp: 'Date', int: 'number' };
  const property = (name) => name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  const fields = KEEL_TIMER.columns.map((column) => {
    const physical = physicalColumn(column, engine);
    for (const symbol of physical.imports ?? []) transformers.add(symbol);
    const options = { name: column.name, ...physical.options, nullable: column.nullable };
    if (physical.transformer) options.transformer = physical.transformer;
    if (column.primary) delete options.nullable;
    const type = types[column.base] ?? 'string';
    return `  @${column.primary ? 'PrimaryColumn' : 'Column'}(${optionsLiteral(options)})\n  ${property(column.name)}!: ${column.nullable ? `${type} | null` : type};`;
  });
  const uniques = KEEL_TIMER.uniques.map((unique) => `@Unique(${tsString(unique.name)}, [${unique.columns.map((name) => tsString(property(name))).join(', ')}])`);
  const indexes = KEEL_TIMER.indexes.map((index) => `@Index(${tsString(index.name)}, [${index.columns.map((name) => tsString(property(name))).join(', ')}])`);
  return tsModule(
    KEEL_TIMER_ORM_TS,
    [
      { symbol: 'Column', from: 'typeorm' },
      { symbol: 'Entity', from: 'typeorm' },
      { symbol: 'Index', from: 'typeorm' },
      { symbol: 'PrimaryColumn', from: 'typeorm' },
      { symbol: 'Unique', from: 'typeorm' },
      ...[...transformers].map((symbol) => ({ symbol, from: TRANSFORMERS_TS }))
    ],
    `/**
 * La tabla del cronómetro, mapeada SOLO para el esquema: así la crea el ORM en \`local\` (synchronize), entra en el
 * baseline que exporta el pase de calidad y, en una base ya desplegada, en el paso de esquema de build. Nadie la lee por
 * el ORM: la usa SqlTimerStore, con las sentencias de keel-core. Columnas, unicidad e índice son los de keel-core
 * (\`KEEL_TIMER\`): los comparten los cuatro generadores.
 */
@Entity({ name: '${KEEL_TIMER.table}' })
${uniques.join('\n')}
${indexes.join('\n')}
export class KeelTimerOrm {
${fields.join('\n\n')}
}`
  );
}

// ─── El almacén documental ───────────────────────────────────────────────────

function mongoTimerStoreFile() {
  return tsModule(
    MONGO_TIMER_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'Document', from: 'mongodb', type: true },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'NIL_ENTITY_ID', from: TIMER_KINDS_TS },
      { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerArmedSignal', from: TIMER_STORE_TS },
      { symbol: 'TimerStore', from: TIMER_STORE_TS }
    ],
    `/** La colección del cronómetro. */
const COLLECTION = '${KEEL_TIMER_DOCUMENT.collection}';

/** El \`_id\` de un temporizador: la clave (kind, entity_id) aplanada. Es lo que arbitra dos armados a la vez. */
function documentId(kind: string, entityId: string): string {
  return \`\${kind}|\${entityId}\`;
}

/**
 * El cronómetro sobre MongoDB, con la forma documental de keel-core (\`KEEL_TIMER_DOCUMENT\`): un documento por
 * (kind, entity_id) con el \`_id\` aplanado (\`kind|entity_id\`), las mismas claves que las columnas y el vencimiento en
 * \`due_at\`. \`entity_id\` y \`claim_token\` van como TEXTO: son contrato con los otros generadores, y el texto no depende
 * de la representación de uuid de cada driver.
 *
 * No hay SKIP LOCKED: el reclamo es \`findOneAndUpdate\` de uno en uno sobre el mismo filtro, atómico por documento. La
 * hora es \`$$NOW\`, la del servidor (T1). El armado, el borrado y el rearme van con la sesión de la transacción en curso.
 */
@Injectable()
export class MongoTimerStore extends TimerStore {
  constructor(
    @Inject(TransactionContext) private readonly transactions: TransactionContext,
    @Inject(TimerArmedSignal) private readonly signal: TimerArmedSignal
  ) {
    super();
  }

  private get timers(): Collection<Document> {
    return this.transactions.collection(COLLECTION);
  }

  async dbNow(): Promise<Date> {
    // $$NOW evaluado por el servidor, sobre la base SIN la sesión de la transacción en curso (la pide también quien está
    // dentro de una): un comando como \`hello\` no se admite en una transacción (error 263, medido en keel-spring).
    const now = await this.transactions.db().aggregate([{ $documents: [{ now: '$$NOW' }] }]).next();
    return now?.now as Date;
  }

  async arm(kind: string, entityId: string, dueAt: Date): Promise<void> {
    await this.timers.updateOne(
      { _id: documentId(kind, entityId) as never },
      { $set: { kind, entity_id: entityId, spec: null, due_at: dueAt, claimed_until: null, claim_token: null, attempts: 0, parked_at: null } },
      { upsert: true, session: this.transactions.session() }
    );
    // Tras el commit (o ya, sin transacción): si aborta, no hay nada que despertar.
    await this.transactions.afterCommit(() => this.signal.armed(dueAt));
  }

  async ensureRecurring(kind: string, spec: string, dueAt: Date): Promise<void> {
    // Un update con pipeline: si ya está y su spec no cambió, no se toca su vencimiento (R1).
    await this.timers.updateOne(
      { _id: documentId(kind, NIL_ENTITY_ID) as never },
      [
        {
          $set: {
            kind,
            entity_id: NIL_ENTITY_ID,
            due_at: { $cond: [{ $eq: ['$spec', spec] }, '$due_at', dueAt] },
            spec,
            claimed_until: { $ifNull: ['$claimed_until', null] },
            claim_token: { $ifNull: ['$claim_token', null] },
            attempts: { $ifNull: ['$attempts', 0] },
            parked_at: { $ifNull: ['$parked_at', null] }
          }
        }
      ],
      { upsert: true }
    );
  }

  async claim(kinds: readonly string[], limit: number, leaseMs: number, token: string): Promise<ClaimedTimer[]> {
    const filter = {
      kind: { $in: [...kinds] },
      parked_at: null,
      $expr: { $and: [{ $lte: ['$due_at', '$$NOW'] }, { $or: [{ $eq: ['$claimed_until', null] }, { $lt: ['$claimed_until', '$$NOW'] }] }] }
    };
    const claimed: ClaimedTimer[] = [];
    while (claimed.length < limit) {
      const found = await this.timers.findOneAndUpdate(
        filter,
        [{ $set: { claimed_until: { $add: ['$$NOW', leaseMs] }, claim_token: token } }],
        { sort: { due_at: 1 }, returnDocument: 'after' }
      );
      if (found == null) break;
      claimed.push({
        id: String(found._id),
        kind: String(found.kind),
        entityId: String(found.entity_id),
        dueAt: found.due_at as Date,
        attempts: Number(found.attempts ?? 0)
      });
    }
    return claimed;
  }

  async complete(id: string, token: string): Promise<boolean> {
    const result = await this.timers.deleteOne({ _id: id as never, claim_token: token }, { session: this.transactions.session() });
    return result.deletedCount > 0;
  }

  async reschedule(id: string, token: string, dueAt: Date): Promise<boolean> {
    const result = await this.timers.updateOne(
      { _id: id as never, claim_token: token },
      { $set: { due_at: dueAt, claimed_until: null, claim_token: null, attempts: 0 } },
      { session: this.transactions.session() }
    );
    return result.modifiedCount > 0;
  }

  async fail(id: string, token: string, maxAttempts: number, retryDelayMs: number): Promise<boolean> {
    // parked_at se calcula con los intentos de ANTES, como la sentencia relacional.
    const result = await this.timers.updateOne({ _id: id as never, claim_token: token }, [
      {
        $set: {
          parked_at: { $cond: [{ $gte: [{ $add: ['$attempts', 1] }, maxAttempts] }, '$$NOW', null] },
          attempts: { $add: ['$attempts', 1] },
          due_at: { $add: ['$$NOW', retryDelayMs] },
          claimed_until: null,
          claim_token: null
        }
      }
    ]);
    return result.modifiedCount > 0;
  }

  async nextDueMs(kinds: readonly string[]): Promise<number | null> {
    const result = await this.timers
      .aggregate([
        { $match: { kind: { $in: [...kinds] }, parked_at: null } },
        { $group: { _id: null, next: { $min: { $cond: [{ $gt: ['$claimed_until', '$due_at'] }, '$claimed_until', '$due_at'] } } } },
        { $project: { ms: { $subtract: ['$next', '$$NOW'] } } }
      ])
      .next();
    return result?.ms == null ? null : Number(result.ms);
  }

  async parkedCount(): Promise<number> {
    return this.timers.countDocuments({ parked_at: { $ne: null } });
  }

  async lagMs(kinds: readonly string[]): Promise<number | null> {
    // El filtro del reclamo, el más antiguo y la hora del SERVIDOR ($$NOW), como lagPipeline de keel-core.
    const result = await this.timers
      .aggregate([
        {
          $match: {
            kind: { $in: [...kinds] },
            parked_at: null,
            $expr: { $and: [{ $lte: ['$due_at', '$$NOW'] }, { $or: [{ $eq: ['$claimed_until', null] }, { $lt: ['$claimed_until', '$$NOW'] }] }] }
          }
        },
        { $group: { _id: null, oldest: { $min: '$due_at' } } },
        { $project: { _id: 0, lagMs: { $subtract: ['$$NOW', '$oldest'] } } }
      ])
      .next();
    return result?.lagMs == null ? null : Number(result.lagMs);
  }

  async purge(retentionDays: number): Promise<number> {
    const result = await this.timers.deleteMany({
      claim_token: null,
      $expr: { $lt: ['$due_at', { $subtract: ['$$NOW', retentionDays * 86_400_000] }] }
    });
    return result.deletedCount;
  }
}`
  );
}

// ─── La configuración ────────────────────────────────────────────────────────

/** Los parámetros del cronómetro, en el orden en que salen en `config/parameters/<perfil>/timer.yaml`. */
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

/**
 * `config/parameters/<perfil>/timer.yaml`: la mecánica del cronómetro (keel-core/gen/timer-store.js, la misma clave y
 * variable en los cuatro generadores) y su interruptor, `scheduling.enabled`, que en `test` va apagado. Es, línea a línea,
 * el `timer.yaml` de keel-spring (test/deadlines.test.js lo compara). `scheduling.enabled` puede salir también en
 * `scheduling.yaml` con el mismo valor: el cargador funde los fragmentos.
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
    const rendered = parameter.cron ? cronWithDefault(profile, parameter.env, parameter.default) : envWithDefault(profile, parameter.env, parameter.default);
    lines.push(`${'  '.repeat(segments.length - 1)}${segments.at(-1)}: ${rendered}`);
  }
  const [root, leaf] = TIMER_SWITCH.key.split('.');
  lines.push(`${root}:`, `  ${leaf}: ${profile === 'test' ? 'false' : envWithDefault(profile, TIMER_SWITCH.env, TIMER_SWITCH.default)}`);
  return `${lines.join('\n')}\n`;
}

function timerSettingsFile() {
  const P = TIMER_PARAMETERS;
  const entry = (name, parameter) => `    ${name}: positive(configuration, ${tsString(parameter.key)}, ${parameter.default})`;
  return tsModule(
    TIMER_SETTINGS_TS,
    [{ symbol: 'Configuration', from: CONFIG_TS, type: true }],
    `/** Token de la configuración del cronómetro ya resuelta. */
export const TIMER_SETTINGS = Symbol('TIMER_SETTINGS');

/** La mecánica del cronómetro: la de keel-core (TIMER_PARAMETERS), con las mismas claves y defaults en los cuatro. */
export interface TimerSettings {
  /** ¿Sondea esta réplica? \`${TIMER_SWITCH.key}\`, apagado en el perfil test. Apagado, se sigue ARMANDO. */
  readonly enabled: boolean;
  /** Cuánto duerme como mucho sin plazos próximos: lo que tarda en ver lo que arma OTRA réplica. */
  readonly maxSleepMs: number;
  readonly batchSize: number;
  /** Mayor que lo que tarda un lote (T4). */
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  /** Lo que puede durar como mucho el tick de un \`schedule\` que drena: menor que el arriendo (T4). */
  readonly drainBudgetMs: number;
  readonly retentionDays: number;
  /** El cron (seis campos, en UTC) de la purga de la propia tabla. */
  readonly purgeCron: string;
}

/** Lee el cronómetro del perfil. Un valor que no es un entero positivo no deja arrancar. */
export function timerSettings(configuration: Configuration): TimerSettings {
  return {
    enabled: flag(configuration, ${tsString(TIMER_SWITCH.key)}, ${TIMER_SWITCH.default}),
${entry('maxSleepMs', P.maxSleepMs)},
${entry('batchSize', P.batchSize)},
${entry('leaseMs', P.leaseMs)},
${entry('maxAttempts', P.maxAttempts)},
${entry('retryDelayMs', P.retryDelayMs)},
${entry('drainBudgetMs', P.drainBudgetMs)},
${entry('retentionDays', P.retentionDays)},
    purgeCron: text(configuration, ${tsString(P.purgeCron.key)}, ${tsString(P.purgeCron.default)})
  };
}

function flag(configuration: Configuration, key: string, fallback: boolean): boolean {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') throw new Error(\`\${key} tiene que ser true o false: '\${String(value)}'\`);
  return normalized === 'true';
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}

function text(configuration: Configuration, key: string, fallback: string): string {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}`
  );
}

// ─── El sondeador ────────────────────────────────────────────────────────────

function timerPollerFile(model) {
  // Con telemetría (DSL 2.26, inc. 11): cada disparo es una observación y la réplica publica el retraso y los aparcados.
  const telemetry = usesTelemetry(model);
  // El disparo, observado con su kind (acotado por el diseño: nunca el id de la entidad) y su desenlace; sin telemetría, tal cual.
  const observed = (expression) => (telemetry ? `observedTick(timer.kind, () => ${expression.replace(/\n/g, '\n  ')})` : expression);
  return tsModule(
    TIMER_POLLER_TS,
    [
      ...(telemetry
        ? [
            { symbol: 'Telemetry', from: TELEMETRY_TS },
            { symbol: 'ROOT_CONTEXT', from: '@opentelemetry/api' }
          ]
        : []),
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'CronTime', from: 'cron' },
      { symbol: 'randomUUID', from: 'node:crypto' },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'TIMER_SETTINGS', from: TIMER_SETTINGS_TS },
      { symbol: 'TimerSettings', from: TIMER_SETTINGS_TS, type: true },
      { symbol: 'TIMER_HANDLERS', from: TIMER_STORE_TS },
      { symbol: 'TIMER_RECURRINGS', from: TIMER_STORE_TS },
      { symbol: 'TimerArmedSignal', from: TIMER_STORE_TS },
      { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerStore', from: TIMER_STORE_TS }
    ],
    `/**
 * El siguiente tick ESTRICTAMENTE posterior a \`from\`, con el cron en UTC (T7). La zona va en el CÁLCULO: en \`cron\` 4
 * la del constructor no se aplica a getNextDateFrom (medido: sin ella, '0 0 3 * * *' daba las 03:00 de la zona del proceso).
 */
export function nextTick(spec: string, from: Date): Date {
  return new CronTime(spec, 'UTC').getNextDateFrom(from, 'UTC').toJSDate();
}

${telemetry ? `/**
 * Un disparo, observado (${OBSERVATIONS.timerTick}): su kind —acotado por el diseño, nunca el id de la entidad— y su
 * desenlace, y su duración en el histograma que el panel agrupa por kind. Raíz a propósito: un tick no tiene petición de
 * la que colgar, y abre la traza de lo que hace.
 */
function observedTick<T>(kind: string, action: () => Promise<T>): Promise<T> {
  const telemetry = Telemetry.current();
  if (telemetry == null) return action();
  return telemetry.observe('${OBSERVATIONS.timerTick}', { name: \`timer \${kind}\`, labels: { '${ATTRIBUTES.timerKind}': kind }, parent: ROOT_CONTEXT }, action);
}

` : ''}/** Cuánto dormir: hasta lo próximo, con el tope y nunca negativo. */
export function sleepMs(nextDueMs: number | null, maxSleepMs: number): number {
  if (nextDueMs == null) return maxSleepMs;
  return Math.max(0, Math.min(nextDueMs, maxSleepMs));
}

/**
 * El sondeador del cronómetro: UNO por réplica, un bucle en el proceso.
 *
 * Cada pasada reclama un lote de lo vencido (TimerStore.claim: dos réplicas nunca toman el mismo mientras dure el
 * arriendo), resuelve cada temporizador con su TimerHandler DENTRO de una transacción en la que también lo borra o lo
 * rearma, y duerme hasta el vencimiento más próximo, con un tope para ver lo que arman otras réplicas. Un temporizador que
 * esta réplica arma y vence antes la despierta (TimerArmedSignal, tras el commit). Es al menos una vez: si la réplica
 * muere con un lote arrendado, otra lo retoma al vencer el arriendo, y el efecto es uno solo porque la transición del
 * plazo es condicional y la revalidación descarta lo que ya no aplica.
 *
 * Se apaga con \`${TIMER_SWITCH.key}=false\` (el perfil test lo apaga): los temporizadores se siguen ARMANDO, que es
 * persistencia; lo que deja de haber es quien los dispare. Al apagar se espera a la pasada en vuelo, ANTES de cerrar el
 * pool: cortarla deja temporizadores arrendados sin hacer hasta que venza el arriendo.
 */
@Injectable()
export class TimerPoller implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TimerPoller');
  private readonly handlers: ReadonlyMap<string, TimerHandler>;
  private readonly recurrings: ReadonlyMap<string, RecurringTimerHandler>;
  /** Solo los kinds que esta réplica conoce (R4): un temporizador de otra versión no lo toca, ni para borrarlo. */
  private readonly kinds: readonly string[];
  private running = false;
  private loopDone: Promise<void> | null = null;
  private wakeAt = Number.MAX_SAFE_INTEGER;
  private sleeper: { readonly timer: NodeJS.Timeout; readonly resolve: () => void } | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(TimerStore) private readonly store: TimerStore,
    @Inject(TIMER_HANDLERS) handlers: readonly TimerHandler[],
    @Inject(TIMER_RECURRINGS) recurrings: readonly RecurringTimerHandler[],
    @Inject(TIMER_SETTINGS) private readonly settings: TimerSettings,
    @Inject(TransactionContext) private readonly transactions: TransactionContext,
    @Inject(TimerArmedSignal) private readonly signal: TimerArmedSignal
  ) {
    this.handlers = new Map(handlers.map((handler) => [handler.kind, handler]));
    this.recurrings = new Map(recurrings.map((recurring) => [recurring.kind, recurring]));
    this.kinds = [...this.handlers.keys(), ...this.recurrings.keys()];
  }

  /** Las réplicas aseguran sus recurrentes al arrancar (R1), con el siguiente tick desde la hora de la base. */
  async ensureRecurring(): Promise<void> {
    const now = await this.store.dbNow();
    for (const recurring of this.recurrings.values()) {
      await this.store.ensureRecurring(recurring.kind, recurring.spec, nextTick(recurring.spec, now));
    }
  }

  /** Una pasada: reclama, resuelve y devuelve cuánto dormir. Pública para las pruebas, que la ejecutan con la hora en su mano (DL-10). */
  async pollOnce(): Promise<number> {
    const token = randomUUID();
    const claimed = await this.store.claim(this.kinds, this.settings.batchSize, this.settings.leaseMs, token);
    for (const timer of claimed) {
      const recurring = this.recurrings.get(timer.kind);
      const handler = this.handlers.get(timer.kind);
      try {
        if (recurring != null) {
          // Un recurrente en modo clúster: lo ejecuta esta réplica porque ganó la fila, FUERA de toda transacción (el
          // mecanismo gestiona las suyas), y se rearma con el siguiente tick desde la hora de la base de DESPUÉS (R2). Si
          // otra réplica le quitó la fila (el tick duró más que el arriendo), el rearme no casa con la valla. Un tick que
          // falla NO se aparca: aparcarlo tras max-attempts fallos (una base caída unos minutos) dejaría el barrido o la
          // purga sin reloj para siempre, y asegurar al arrancar no toca una fila con el mismo spec.
          try {
            await ${observed('recurring.tick()')};
          } catch (failure) {
            this.logger.warn(\`El tick del recurrente \${timer.kind} falló; se rearma para el siguiente: \${failure instanceof Error ? failure.message : String(failure)}\`);
          }
          await this.store.reschedule(timer.id, token, nextTick(recurring.spec, await this.store.dbNow()));
          continue;
        }
        if (handler == null) throw new Error(\`Sin handler para el temporizador \${timer.kind}\`);
        await ${observed(`this.transactions.inTransaction(async () => {
          const outcome = await handler.handle(timer, await this.store.dbNow());
          if (outcome.done) await this.store.complete(timer.id, token);
          else await this.store.reschedule(timer.id, token, outcome.dueAt);
        })`)};
      } catch (failure) {
        await this.failed(timer, token, failure);
      }
    }
    return sleepMs(await this.store.nextDueMs(this.kinds), this.settings.maxSleepMs);
  }

  /** Un fallo: cuenta el intento y, al agotarlos, el temporizador queda aparcado (T5). */
  private async failed(timer: ClaimedTimer, token: string, failure: unknown): Promise<void> {
    const reason = failure instanceof Error ? failure.message : String(failure);
    this.logger.warn(\`El temporizador \${timer.id} (\${timer.kind}) falló en su intento \${timer.attempts + 1}: \${reason}\`);
    await this.store.fail(timer.id, token, this.settings.maxAttempts, this.settings.retryDelayMs);
    if (timer.attempts + 1 >= this.settings.maxAttempts) {
      this.logger.error(\`El temporizador \${timer.id} (\${timer.kind}) agotó sus \${this.settings.maxAttempts} intentos y queda APARCADO\`);
    }
  }

  /** Un temporizador armado en ESTA réplica (tras el commit): si vence antes de lo que iba a dormir, despierta. */
  onArmed(dueAt: Date): void {
    if (dueAt.getTime() >= this.wakeAt) return;
    this.wakeAt = dueAt.getTime();
    if (this.sleeper != null) {
      const { timer, resolve } = this.sleeper;
      clearTimeout(timer);
      this.sleeper = { timer: this.schedule(resolve), resolve };
    }
  }

  /** Cuándo piensa despertar (milisegundos de la época, según el reloj de la instancia). */
  wakeAtMs(): number {
    return this.wakeAt;
  }

  /** Fija cuándo despertar tras una pasada; lo usa el bucle y lo comprueban las pruebas. */
  planWake(nowMs: number, sleep: number): void {
    this.wakeAt = nowMs + sleep;
  }

  private schedule(resolve: () => void): NodeJS.Timeout {
    const timer = setTimeout(resolve, Math.max(0, this.wakeAt - Date.now()));
    timer.unref();
    return timer;
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.sleeper = null;
        resolve();
      };
      this.sleeper = { timer: this.schedule(done), resolve: done };
    });
  }

  private async loop(): Promise<void> {
    try {
      await this.ensureRecurring();
    } catch (failure) {
      this.logger.error(\`El cronómetro no pudo asegurar sus recurrentes: \${failure instanceof Error ? failure.message : String(failure)}\`);
    }
    while (this.running) {
      let sleep: number;
      try {
        sleep = await this.pollOnce();
      } catch (failure) {
        this.logger.error(\`La pasada del cronómetro falló; se reintenta tras el sueño máximo: \${failure instanceof Error ? failure.message : String(failure)}\`);
        sleep = this.settings.maxSleepMs;
      }
      if (!this.running) break;
      this.planWake(Date.now(), sleep);
      await this.sleep();
    }
  }

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      this.logger.log('Cronómetro apagado (${TIMER_SWITCH.key}: false): los temporizadores se arman, pero nadie los dispara');
      return;
    }
    this.running = true;${telemetry ? `
    // El RETRASO y los APARCADOS, en cada scrape. Cada réplica publica lo mismo (la tabla es una): el panel los agrega con max.
    Telemetry.current()?.gauge('${TIMER_LAG}', 'Segundos que lleva esperando el temporizador vencido y sin reclamar más antiguo', async () =>
      Math.max(0, (await this.store.lagMs(this.kinds)) ?? 0) / 1000
    );
    Telemetry.current()?.gauge('${TIMER_PARKED}', 'Temporizadores que agotaron sus intentos y quedaron aparcados', () => this.store.parkedCount());` : ''}
    this.unsubscribe = this.signal.subscribe((dueAt) => this.onArmed(dueAt));
    this.loopDone = this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    if (this.sleeper != null) {
      clearTimeout(this.sleeper.timer);
      this.sleeper.resolve();
    }
    await this.loopDone;
  }
}`
  );
}

function timerPurgeFile() {
  return tsModule(
    TIMER_PURGE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
      { symbol: 'TIMER_SETTINGS', from: TIMER_SETTINGS_TS },
      { symbol: 'TimerSettings', from: TIMER_SETTINGS_TS, type: true },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerStore', from: TIMER_STORE_TS }
    ],
    `/**
 * La purga de la propia tabla del cronómetro (R7): un recurrente más, en modo clúster, así que la ejecuta UNA réplica por
 * tick. Borra lo vencido hace más de la retención y sin reclamar: un temporizador de un kind que ya no conoce ninguna
 * réplica (R4) o uno aparcado que ya se vio.
 */
@Injectable()
export class KeelTimerPurge implements RecurringTimerHandler {
  readonly kind = TimerKinds.TIMER_PURGE;
  readonly spec: string;

  constructor(
    @Inject(TimerStore) private readonly store: TimerStore,
    @Inject(TIMER_SETTINGS) private readonly settings: TimerSettings
  ) {
    this.spec = settings.purgeCron;
  }

  async tick(): Promise<void> {
    await this.store.purge(this.settings.retentionDays);
  }
}`
  );
}

/**
 * El recurrente que dispara la purga de una tabla del generador (incremento 7): antes la registraba TablePurges en el
 * reloj, que corría en TODAS las réplicas a la vez; ahora la ejecuta UNA por tick, la que gana su fila en keel_timer. El
 * cron es el de siempre (su clave, su variable y su default de keel-core, en PURGE_SETTINGS), evaluado en UTC (T7).
 */
function purgeTimerFile(model, purge) {
  const entry = tablePurges(model).find((candidate) => candidate.table === purge.table);
  if (!entry) throw new Error(`timer.js: ${purge.table} se purga con el cronómetro y TablePurges no la tiene`);
  const className = purgeTimerClass(purge.table);
  return tsModule(
    purgeTimerPath(purge.table),
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'PURGE_SETTINGS', from: TABLE_PURGES_TS },
      { symbol: 'PurgeSettings', from: TABLE_PURGES_TS, type: true },
      { symbol: 'TablePurges', from: TABLE_PURGES_TS }
    ],
    `/**
 * La purga de \`${purge.table}\`, como recurrente del cronómetro en modo clúster: cada tick lo ejecuta UNA réplica, la que
 * gana su fila en \`${KEEL_TIMER.table}\`. Lo que borra y cómo (la retención, los lotes, sus transacciones) es lo de
 * TablePurges.${entry.method}, que no cambia: solo cambia quién la dispara.
 */
@Injectable()
export class ${className} implements RecurringTimerHandler {
  readonly kind = TimerKinds.${purgeKindConstant(purge.table)};
  readonly spec: string;

  constructor(
    @Inject(TablePurges) private readonly purges: TablePurges,
    @Inject(PURGE_SETTINGS) settings: PurgeSettings
  ) {
    this.spec = settings.${entry.key}.cron;
  }

  async tick(): Promise<void> {
    await this.purges.${entry.method}();
  }
}`
  );
}

/**
 * El recurrente que dispara el `schedule` de una operación (incremento 8): antes lo registraba su `<Grupo>Scheduler` en
 * el reloj, que corría en TODAS las réplicas; ahora el tick lo ejecuta UNA, la que gana su fila, y DRENA: repite la pasada
 * mientras su lote salga lleno (SweepPass), hasta el siguiente tick o `timer.drain-budget-ms`. El despacho sigue en el
 * scheduler (su transacción o su falta de ella, su correlación, el TODO de los argumentos). Es el de keel-spring.
 */
function scheduleTimerFile(model, schedule) {
  const service = scheduleService(model, schedule.operation);
  const scheduler = schedulerClass(service);
  return tsModule(
    scheduleTimerPath(schedule.operation),
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
      { symbol: 'TIMER_SETTINGS', from: TIMER_SETTINGS_TS },
      { symbol: 'TimerSettings', from: TIMER_SETTINGS_TS, type: true },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'nextTick', from: TIMER_POLLER_TS },
      sweepPassImport(),
      { symbol: scheduler, from: schedulerPath(service) }
    ],
    `/**
 * El \`schedule\` de ${schedule.operation} (su cron, \`spec\`, en UTC), como recurrente del cronómetro en modo clúster:
 * cada tick lo ejecuta UNA réplica, la que gana su fila en \`${KEEL_TIMER.table}\`.
 *
 * Por eso el tick DRENA: con una sola réplica trabajando, repite la pasada mientras el lote salga lleno —lo avisa el
 * reclamo con SweepPass.claimed— y para cuando sale a medias, cuando llega su siguiente tick o cuando agota
 * \`${TIMER_PARAMETERS.drainBudgetMs.key}\`, que es menor que el arriendo. Lo que quede pasa al siguiente tick. Sin aviso,
 * una pasada por tick.
 *
 * El tick sigue siendo AL MENOS UNA VEZ: si la réplica muere a mitad, otra lo repite al vencer el arriendo. Por eso el
 * barrido sigue reclamando sus filas.
 */
@Injectable()
export class ${scheduleTimerClass(schedule.operation)} implements RecurringTimerHandler {
  readonly kind = TimerKinds.${scheduleKindConstant(schedule.operation)};
  /** El cron del diseño con el segundo repartido (scheduleCron de keel-core): no es configurable. */
  readonly spec = ${tsString(schedule.cron)};

  constructor(
    @Inject(${scheduler}) private readonly scheduler: ${scheduler},
    @Inject(TIMER_SETTINGS) private readonly settings: TimerSettings
  ) {}

  async tick(): Promise<void> {
    const start = Date.now();
    const budget = Math.min(nextTick(this.spec, new Date(start)).getTime() - start, this.settings.drainBudgetMs);
    for (;;) {
      const full = await SweepPass.run(() => this.scheduler.${schedule.operation}());
      if (!full || Date.now() - start >= budget) return;
    }
  }
}`
  );
}

/**
 * `SweepPass`: la señal con la que una pasada de un barrido le dice al tick que su lote salió LLENO. En
 * application/support porque también la llama el handler del agente cuando reclama él, y la aplicación no importa
 * infraestructura. Va sobre AsyncLocalStorage: la pasada es asíncrona y puede coincidir con otras en el mismo proceso.
 */
function sweepPassFile() {
  return tsModule(
    SWEEP_PASS_TS,
    [{ symbol: 'AsyncLocalStorage', from: 'node:async_hooks' }],
    `const PASS = new AsyncLocalStorage<{ full: boolean }>();

/**
 * La señal del DRENAJE de un barrido (DSL 2.26, incremento 8): una pasada que reclamó su lote lleno puede dejar
 * candidatos, y el tick del cronómetro la repite.
 *
 * Un tick en modo clúster lo ejecuta UNA réplica, así que, si cada tick hiciera una sola pasada, el barrido rendiría lo de
 * una réplica y no lo de todas. Quien reclama sabe si el lote salió lleno: lo avisan los reclamos que genera build, y TÚ,
 * si el handler reclama su lote a mano, con \`SweepPass.claimed(reclamadas, lote)\`. Sin aviso, el tick hace una pasada,
 * que es correcto pero más lento con atrasos grandes.
 *
 * Fuera de un tick (una prueba, un despacho por otra puerta) no hace nada.
 */
export const SweepPass = {
  /** Lo llama quien reclama: \`claimed\` de una cota de \`batchSize\`. Lleno = puede que queden. */
  claimed(claimed: number, batchSize: number): void {
    const pass = PASS.getStore();
    if (pass != null && batchSize > 0 && claimed >= batchSize) pass.full = true;
  },

  /** El tick: ejecuta una pasada y dice si algún reclamo de ella salió lleno. */
  async run(pass: () => Promise<unknown>): Promise<boolean> {
    const state = { full: false };
    await PASS.run(state, pass);
    return state.full;
  }
} as const;`
  );
}

function findOperation(model, name) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []).find((operation) => operation.name === name);
}

function deadlineHandlerFile(model, { entity, deadline }) {
  const className = deadlineHandlerClass(entity.name, deadline.stateName);
  const file = deadlineHandlerPath(entity.name, deadline.stateName);
  const operation = findOperation(model, deadline.by);
  const { field, enumType } = entity.lifecycle;
  const components = messageComponents(model, operation).filter((component) => !component.entryGate);
  const correlated = usesCorrelation(model);
  const repository = `${decap(entity.name)}Repository`;
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'UseCaseMediator', from: MEDIATOR_TS },
    { symbol: operation.messageClass, from: messagePath(operation) },
    { symbol: portClass(entity), from: portPath(entity) },
    { symbol: enumType, from: classPath(DIRS.enums, enumType) },
    { symbol: deadlinesClass(model), from: deadlinesPath(model) },
    { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
    { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
    { symbol: 'TimerHandler', from: TIMER_STORE_TS, type: true },
    { symbol: 'TimerOutcome', from: TIMER_STORE_TS },
    ...(correlated ? [{ symbol: 'randomUUID', from: 'node:crypto' }, { symbol: 'CorrelationContext', from: CORRELATION_TS }] : [])
  ];
  const message = components.length === 1 ? `new ${operation.messageClass}({ ${components[0].name}: timer.entityId })` : null;
  const dispatch = message
    ? correlated
      ? `// Cada disparo es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación.
    await CorrelationContext.runWith(randomUUID(), () => this.mediator.dispatch(${message}));`
      : `await this.mediator.dispatch(${message});`
    : `// TODO (agente): el mensaje de ${operation.name} pide más que el id de la entidad; constrúyelo aquí.
    throw new Error('TODO: despachar ${operation.messageClass} desde el cronómetro');`;
  return tsModule(
    file,
    imports,
    `/**
 * El plazo de ${entity.name} en '${deadline.stateName}' (DSL 2.26): vencido ${deadline.since} + el plazo vigente, la entidad pasa
 * a '${deadline.toName}' por ${operation.name}, que despacha este handler.
 *
 * Antes de despachar REVALIDA, con la hora de la base y el plazo de AHORA: si la entidad ya no existe o ya salió de
 * '${deadline.stateName}', el temporizador se descarta sin transición (DL-8); si con el plazo vigente todavía no vence, se
 * rearma (DL-9, T6). Corre en la transacción del sondeador, y el mediator se une a ella: la transición y el borrado del
 * temporizador confirman juntos. Lo que hace ${operation.name} al caducar es del diseño: lo escribe el agente en su handler.
 */
@Injectable()
export class ${className} implements TimerHandler {
  readonly kind = TimerKinds.${kindConstant(entity.name, deadline.stateName)};

  constructor(
    @Inject(${portClass(entity)}) private readonly ${repository}: ${portClass(entity)},
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,
    @Inject(${deadlinesClass(model)}) private readonly deadlines: ${deadlinesClass(model)}
  ) {}

  async handle(timer: ClaimedTimer, dbNow: Date): Promise<TimerOutcome> {
    const found = await this.${repository}.findById(timer.entityId);
    if (found == null || found.${field} !== ${enumType}.${deadline.state}) return TimerOutcome.finished();
    const due = new Date(found.${deadline.since}.getTime() + this.deadlines.${deadlineComponent(entity.name, deadline.stateName)});
    if (due.getTime() > dbNow.getTime()) return TimerOutcome.rescheduleAt(due);
    ${dispatch}
    return TimerOutcome.finished();
  }
}`
  );
}

// ─── Los módulos ─────────────────────────────────────────────────────────────

function timerModuleFile(model) {
  const parameters = model.service.parameters ?? [];
  const usesParameters = modelDeadlines(model).some(({ duration }) => duration.parameter);
  const args = modelDeadlines(model).map(({ duration }) => {
    if (duration.seconds !== undefined) return `${duration.seconds} * 1000`;
    const parameter = parameters.find((candidate) => candidate.name === duration.parameter);
    return `Number(parameters.${parameter?.name ?? duration.parameter}) * ${duration.multiplier} * 1000`;
  });
  const handlers = modelDeadlines(model).map(({ entity, deadline }) => ({
    symbol: deadlineHandlerClass(entity.name, deadline.stateName),
    from: deadlineHandlerPath(entity.name, deadline.stateName)
  }));
  const deadlines = usesDeadlines(model);
  const handlerList = handlers.map((handler) => handler.symbol);
  const purgeTimers = timerPurges(model).map((purge) => ({ symbol: purgeTimerClass(purge.table), from: purgeTimerPath(purge.table) }));
  const scheduleTimers = timerSchedules(model).map((schedule) => ({ symbol: scheduleTimerClass(schedule.operation), from: scheduleTimerPath(schedule.operation) }));
  // Las retenciones (DSL 2.28): el componente que barre y su recurrente.
  const retentions = retentionProviders(model);
  const retains = retentions.length > 0;
  const recurringList = [
    'KeelTimerPurge',
    ...purgeTimers.map((purge) => purge.symbol),
    ...scheduleTimers.map((schedule) => schedule.symbol),
    ...retentions.filter((provider) => provider.recurring).map((provider) => provider.symbol)
  ];
  const deadlineProviders = deadlines
    ? `
        { provide: ${CLOCK_PORT.name}, useClass: SystemClock },
        {
          provide: ${deadlinesClass(model)},
          useFactory: (${usesParameters ? `parameters: ${parametersClass(model)}` : ''}) => new ${deadlinesClass(model)}(${args.join(', ')}),
          inject: [${usesParameters ? parametersClass(model) : ''}]
        },`
    : '';
  return tsModule(
    TIMER_MODULE_TS,
    [
      { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
      { symbol: 'Global', from: '@nestjs/common' },
      { symbol: 'Module', from: '@nestjs/common' },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      ...(deadlines
        ? [
            { symbol: CLOCK_PORT.name, from: CLOCK_TS },
            { symbol: deadlinesClass(model), from: deadlinesPath(model) },
            { symbol: 'SystemClock', from: SYSTEM_CLOCK_TS },
            { symbol: 'UseCaseModule', from: 'src/infrastructure/usecase/use-case-module.ts' },
            { symbol: 'TimerHandler', from: TIMER_STORE_TS, type: true }
          ]
        : []),
      ...(usesParameters ? [{ symbol: parametersClass(model), from: parametersPath(model) }] : []),
      { symbol: 'KeelTimerPurge', from: TIMER_PURGE_TS },
      { symbol: 'TimerPoller', from: TIMER_POLLER_TS },
      { symbol: 'TIMER_SETTINGS', from: TIMER_SETTINGS_TS },
      { symbol: 'timerSettings', from: TIMER_SETTINGS_TS },
      { symbol: 'TIMER_HANDLERS', from: TIMER_STORE_TS },
      { symbol: 'TIMER_RECURRINGS', from: TIMER_STORE_TS },
      { symbol: 'TimerArmedSignal', from: TIMER_STORE_TS },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerStore', from: TIMER_STORE_TS },
      { symbol: timerStoreImplClass(model), from: timerStoreImplPath(model) },
      ...handlers,
      ...purgeTimers,
      ...scheduleTimers,
      ...retentions.map(({ symbol, from }) => ({ symbol, from })),
      ...(retains ? [{ symbol: 'RETENTION_SETTINGS', from: RETENTION_SETTINGS_TS }, { symbol: 'retentionSettings', from: RETENTION_SETTINGS_TS }] : [])
    ],
    `/**
 * El cronómetro del servicio (DSL 2.26), lo que necesitan los demás: ${deadlines ? 'el reloj inyectable, la duración vigente de cada plazo y ' : ''}el
 * almacén de temporizadores, con su aviso de armado. Global: ${deadlines ? 'los adaptadores de repositorio arman con él y los handlers inyectan el reloj y los plazos sin importarlo' : 'el sondeador y sus recurrentes lo inyectan sin importarlo'}. Va después de la persistencia (el almacén usa su transacción).
 */
@Global()
@Module({})
export class TimerModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: TimerModule,
      providers: [
        { provide: TIMER_SETTINGS, useValue: timerSettings(configuration) },${retains ? '\n        { provide: RETENTION_SETTINGS, useValue: retentionSettings(configuration) },' : ''}${deadlineProviders}
        TimerArmedSignal,
        { provide: TimerStore, useClass: ${timerStoreImplClass(model)} }
      ],
      exports: [TIMER_SETTINGS, ${retains ? 'RETENTION_SETTINGS, ' : ''}${deadlines ? `${CLOCK_PORT.name}, ${deadlinesClass(model)}, ` : ''}TimerArmedSignal, TimerStore]
    };
  }
}

/**
 * El sondeador y sus handlers: ${deadlines ? 'uno por plazo, que revalida y despacha su operación por el mediator, y ' : ''}los recurrentes en modo
 * clúster (la purga de la tabla${purgeTimers.length > 0 ? ', las de las tablas del generador, que llaman a TablePurges' : ''}${scheduleTimers.length > 0 ? ' y los schedule de las operaciones, que llaman a su scheduler y drenan' : ''}). Va el último, después de los casos de uso.
 */
@Module({${deadlines ? '\n  imports: [UseCaseModule],' : ''}
  providers: [
${[...handlerList, ...retentions.filter((provider) => !provider.recurring).map((provider) => provider.symbol), ...recurringList].map((symbol) => `    ${symbol},`).join('\n')}
    { provide: TIMER_HANDLERS, useFactory: (${deadlines ? '...handlers: TimerHandler[]' : ''}) => ${deadlines ? 'handlers' : '[]'}, inject: [${handlerList.join(', ')}] },
    { provide: TIMER_RECURRINGS, useFactory: (...recurrings: RecurringTimerHandler[]) => recurrings, inject: [${recurringList.join(', ')}] },
    TimerPoller
  ]
})
export class TimerPollerModule {}`
  );
}

// ─── Lo que lee el agente ────────────────────────────────────────────────────

/** El nombre del reloj y de los plazos con que un handler los recibe (services.js los inyecta). */
export function clockDependencies(model) {
  return [
    { type: CLOCK_PORT.name, name: decap(CLOCK_PORT.name), import: { symbol: CLOCK_PORT.name, from: CLOCK_TS } },
    { type: deadlinesClass(model), name: decap(deadlinesClass(model)), import: { symbol: deadlinesClass(model), from: deadlinesPath(model) } }
  ];
}

/** La coletilla de la nota de una transición tardía, en TypeScript. */
export function lateTransitionHint(model) {
  return `En TypeScript: this.${decap(CLOCK_PORT.name)}.${CLOCK_PORT.method}() y this.${decap(deadlinesClass(model))}.`;
}

/** El archivo de una entidad, para el gate. */
export const entityFileName = (entity) => `${fileName(entity.name)}.ts`;

// ─── El arnés: fireTimer (inc. 8) ────────────────────────────────────────────

/**
 * ¿Emite el arnés `fireTimer`? Con cronómetro, y con con qué alcanzarlo: `db()` sobre un relacional con sentencias del
 * cronómetro, o `mongoEval()` sobre documentos. Lo consultan los helpers del rescate y de la reconciliación, que lo llaman.
 */
export function firesTimer(model, { relational = false } = {}) {
  if (!usesTimer(model)) return false;
  return relational ? TIMER_ENGINES.includes(model.stack?.database) : usesDocument(model);
}

/** Lo envejecible de cada activación (o del cobro), en la rama de persistencia del diseño. */
const agingTargetsOf = (model, relational) => (relational ? relationalAgingTargets(model) : documentAgingTargets(model));

/** Las activaciones cuyos barridos dispara el cronómetro, con sus operaciones. */
function agedSweeps(model) {
  return [...agingSweeps(model)]
    .map(([key, operations]) => [key, operations.filter((operation) => scheduledByTimer(model, operation))])
    .filter(([, operations]) => operations.length > 0);
}

/**
 * ¿Hay rescate al que adelantar su barrido, o reconciliación? Solo entonces se emiten `fireSchedule` y `fireAgedSweeps`:
 * con `noUnusedLocals`, una función que nadie llama no compila.
 */
const firesSchedules = (model, options) => firesTimer(model, options) && rescueProbes(model).length > 0;
const firesAgedSweeps = (model, options) =>
  firesTimer(model, options) && agedSweeps(model).length > 0 && agingTargetsOf(model, Boolean(options?.relational)).size > 0;

/** La llamada con la que un helper adelanta el barrido que recoge lo que acaba de fabricar (o nada). */
export const fireScheduleCall = (model, operationExpression, options) => (firesSchedules(model, options) ? `  fireSchedule(${operationExpression});\n` : '');
export const fireAgedCall = (model, activationExpression, options) => (firesAgedSweeps(model, options) ? `  fireAgedSweeps(${activationExpression});\n` : '');

/**
 * `fireTimer(kind)` en flow.ts: adelanta un recurrente del cronómetro para que venza YA, con la hora de la base. Es la
 * sentencia `fire` de keel-core (o su script documental, `fireTimerScript` de mongo-probes.js), la misma que el
 * AbstractFlowIT de keel-spring. Y `fireSchedule`/`fireAgedSweeps`, con los que `stallInFlight`, `putInFlight` y
 * `ageForReconciliation` adelantan el barrido que recoge lo que fabrican: así un flujo no espera al cron.
 */
export function timerFireSection(model, { relational = false, document = false, fireTimerScript = null } = {}) {
  if (!firesTimer(model, { relational })) return '';
  if (!relational && !(document && fireTimerScript)) return '';
  const kinds = clusterRecurrings(model).map((recurring) => recurring.kind);
  const statement = relational
    ? `db(${tsString(timerStatements(model.stack.database).fire.split(':kind')[0])} + "'" + kind.replaceAll("'", "''") + "'")`
    : `mongoEval(${tsString(fireTimerScript('{kind}').split('{kind}')[0])} + kind + ${tsString(fireTimerScript('{kind}').split('{kind}')[1])})`;
  const schedules = timerSchedules(model)
    .map((schedule) => `  ${tsString(schedule.operation)}: ${tsString(schedule.kind)}`)
    .join(',\n');
  const aged = agedSweeps(model)
    .map(([key, operations]) => `  ${tsString(key)}: [${operations.map((operation) => tsString(scheduleKind(operation))).join(', ')}]`)
    .join(',\n');
  const options = { relational };
  const scheduleHelpers = firesSchedules(model, options)
    ? `
/** El schedule de cada operación que dispara el cronómetro. */
const SCHEDULE_TIMERS: Readonly<Record<string, string>> = {
${schedules}
};

/** Adelanta el barrido de una operación, si lo dispara el cronómetro. */
function fireSchedule(operation: string): void {
  const kind = SCHEDULE_TIMERS[operation];
  if (kind != null) fireTimer(kind);
}
`
    : '';
  const agedHelpers = firesAgedSweeps(model, options)
    ? `
/** Los barridos que recogen lo envejecido de cada activación (o del cobro). */
const AGED_SWEEPS: Readonly<Record<string, readonly string[]>> = {
${aged}
};

/** Adelanta los barridos que recogen lo envejecido de una activación. */
function fireAgedSweeps(activation: string): void {
  for (const kind of AGED_SWEEPS[activation] ?? []) fireTimer(kind);
}
`
    : '';
  return `
/**
 * Adelanta el temporizador recurrente \`kind\` del cronómetro: vence YA, con la hora de la base, y sin arriendo.
 *
 * No dispara nada: el sondeador lo recoge en su próxima pasada (como mucho \`timer.max-sleep-ms\`), en UNA réplica, como
 * en producción. Es lo que hace que un escenario de barrido no espere al cron. Los helpers que fabrican la precondición
 * de un rescate o de una reconciliación ya lo llaman por ti.
 *
 *   fireTimer(${tsString(kinds.find((kind) => kind.startsWith('schedule:')) ?? kinds[0])});
 *
 * Recurrentes de este servicio: ${kinds.join(', ')}.
 */
export function fireTimer(kind: string): void {
  ${statement};
}
${scheduleHelpers}${agedHelpers}`;
}

// ─── El arnés: ageForDeadline (D7) ───────────────────────────────────────────

/**
 * `ageForDeadline(entidad, id, segundos)` en `test/integration/support/flow.ts`: un escenario de plazo no puede esperar
 * 15 minutos. Retrasa el `since` de la entidad Y el vencimiento de su temporizador los mismos segundos, para que el
 * rechazo tardío del dominio (que lee `since`) y el cronómetro (que lee `due_at`) vean el mismo plazo vencido. Las
 * sentencias del temporizador son las de keel-core (`timerStatements(engine).age`) y el script documental el de
 * mongo-probes.js (`ageDeadlineScript`), los mismos que el AbstractFlowIT de keel-spring. Relacional: sobre `db()`;
 * documental: sobre `mongoEval()`. '' si el diseño no tiene plazos o el arnés no tiene con qué.
 */
export function deadlineAgingSection(model, { relational = false, document = false, uuidLiteral = null, ageDeadlineScript = null } = {}) {
  const deadlines = modelDeadlines(model);
  if (deadlines.length === 0) return '';
  const engine = model.stack?.database;
  if (relational && (!TIMER_ENGINES.includes(engine) || !uuidLiteral)) return '';
  if (!relational && !(document && ageDeadlineScript)) return '';
  const column = (entity, name) => entity.fields.find((candidate) => candidate.name === name)?.columns?.name ?? name.replace(/([A-Z])/g, '_$1').toLowerCase();
  const shift = (sinceColumn) =>
    engine === 'mysql' ? `DATE_SUB(${sinceColumn}, INTERVAL \${seconds} SECOND)` : `${sinceColumn} - make_interval(secs => \${seconds})`;
  const branches = deadlines
    .map(({ entity, deadline, kind }) => {
      const since = column(entity, deadline.since);
      if (!relational) {
        const script = ageDeadlineScript({ collection: entity.collectionName, sinceField: since, kind });
        return `  if (entity === ${tsString(entity.name)}) {
    mongoEval(${tsString(script)}.replaceAll('{id}', deadlineId(id)).replaceAll('{ms}', String(seconds * 1000)));
    return;
  }`;
      }
      const literal = `${uuidLiteral.prefix}\${deadlineId(id)}${uuidLiteral.suffix}`;
      const timer = timerStatements(engine).age.replace(':ageMs', '${seconds * 1000}').replace(':kind', `'${kind}'`).replace(':entityId', literal);
      return `  if (entity === ${tsString(entity.name)}) {
    db(\`UPDATE ${entity.tableName} SET ${since} = ${shift(since)} WHERE ${column(entity, entity.idField?.name ?? 'id')} = ${literal}\`);
    db(\`${timer}\`);
    return;
  }`;
    })
    .join('\n');
  const known = [...new Set(deadlines.map(({ entity }) => entity.name))].join(', ');
  const example = deadlines[0];
  return `
/** Un id para una sentencia del arnés: valida la forma antes de meterlo en el literal. */
function deadlineId(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(\`No es un id: '\${id}'\`);
  return id;
}

/**
 * Envejece el plazo de la entidad \`id\` (DSL 2.26): retrasa su ${example.deadline.since} y el vencimiento de su temporizador
 * \`seconds\` segundos, de modo que el plazo venza ya sin esperarlo.
 *
 * No dispara la caducidad: la dispara el cronómetro en su próxima pasada (como mucho el sueño máximo,
 * \`timer.max-sleep-ms\`), como en producción. Y el rechazo tardío del dominio lo ve en el acto, porque lee
 * \`${example.deadline.since}\`: un verbo tardío tras esta llamada ya debe salir con su error.
 *
 *   ageForDeadline('${example.entity.name}', id, 3600);
 *   await eventually(async () => (await flow.get(...)).body.status === '${example.deadline.toName}', 45_000);
 *
 * Entidades con plazo en este diseño: ${known}.
 */
export function ageForDeadline(entity: string, id: string, seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(\`Los segundos tienen que ser un entero positivo: \${seconds}\`);
${branches}
  throw new Error(\`No hay plazo para la entidad '\${entity}'. Las que lo tienen: ${known}\`);
}
`;
}
