// El cronómetro del servicio y los plazos de negocio (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 6).
//
// Lo neutral —la tabla, sus parámetros, las SENTENCIAS por motor, el `kind` de cada temporizador, la regla del
// vencimiento y el algoritmo del sondeador— está en keel-core/gen (timer-store.js, deadlines.js, timer-poller.js), y es
// contrato de los cuatro servidores: comparten base y esquema. Es lo mismo que emite keel-spring (src/scaffold/timer.js),
// dicho en Go:
//
//   · `<Servicio>Deadlines`, en internal/domain: la duración VIGENTE de cada plazo. El rechazo tardío la necesita y el
//     dominio no lee configuración, así que viaja por argumento, como `<Servicio>Parameters`;
//   · el rechazo tardío (D2), en `transitionAt(target, now, deadlines)` de la entidad (entities.js lo pide con
//     `lateGuardParts`). El `transitionTo` de un argumento se niega a salir de un estado con plazo hacia otro destino;
//   · el reloj inyectable es `application.Clock`, un `func() time.Time` con nombre (§ 3.4 de PLAN-KEEL-GO.md: se inyecta,
//     y una función de un solo método es lo que ya reciben el circuito y los últimos valores conocidos de los clientes;
//     una interfaz `Now()` pediría un tipo adaptador para time.Now sin ganar nada). Lo reciben, con los plazos, los
//     handlers que sacan una entidad de un estado con plazo hacia otro destino;
//   · el armado, en el Save del adaptador, en la transacción del caso de uso y solo al ENTRAR en el estado
//     (`armingParts`), con el despertar del sondeador DESPUÉS del commit;
//   · el almacén (`timer.Store`), en el paquete del motor: las sentencias de keel-core TAL CUAL, con sus marcadores
//     nombrados, que pasa al estilo del driver un enlazador en tiempo de ejecución (la lista de ids del reclamo tiene
//     largo variable); o, en MongoDB, la forma documental de keel-core;
//   · el sondeador (`timer.Poller`): UNA goroutine por réplica en el errgroup del arranque, que reclama, revalida,
//     despacha y duerme hasta el siguiente vencimiento; se despierta al armar y se apaga con el contexto de cierre. Lo
//     conmuta `scheduling.enabled` (TIMER_SWITCH), el interruptor que keel-go ya tenía;
//   · el despacho de cada plazo (`<Entidad><Estado>Deadline`, que REVALIDA y despacha la operación `by`) y la purga de la
//     propia tabla (R7), el primer recurrente, con el cron evaluado en UTC (T7).
//
// Ningún reloj de los que ya existían cambia en este incremento: el relay, las purgas y los `schedule` siguen con su
// bucle. El modo POR RÉPLICA no se emite: su único usuario es el relay (inc. 9), y un modo sin sujeto no lo ejecuta ninguna
// red.

import {
  CLOCK_PORT,
  deadlineHandlerNote,
  deadlineOf,
  lateGuards,
  lateTransitionNote,
  modelDeadlines,
  usesDeadlines
} from '@keel-system/keel-core/gen/deadlines';
import {
  KEEL_TIMER,
  KEEL_TIMER_DOCUMENT,
  NIL_ENTITY_ID,
  TIMER_ENGINES,
  TIMER_PARAMETERS,
  TIMER_PURGE_KIND,
  TIMER_SWITCH,
  CRON_UTC_CASES,
  timerStatements
} from '@keel-system/keel-core/gen/timer-store';
import { ageDeadlineScript } from '@keel-system/keel-core/gen/mongo-probes';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { snakeCase } from '@keel-system/keel-core/gen';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { constantOf } from './enums.js';
import { formatString, goFileName, isOptional, layout, localName, packageFile } from './render.js';
import { sentinelOf } from './errors.js';
import { parametersType } from './service-parameters.js';
import { contractOf, messageComponents, messageType, operations, useCaseField } from './services.js';
import { usesCorrelation } from './correlation.js';
import { schedulingYaml, usesScheduling } from './scheduling.js';
import { tablePurges } from './purge.js';
import { timerPurges, usesTimer } from '@keel-system/keel-core/gen/timer-plan';
import { pascalCase } from '@keel-system/keel-core/gen';

export { usesDeadlines, usesTimer, deadlineHandlerNote, lateTransitionNote, deadlineOf };

/** La constante del kind de la purga de una tabla del generador: `KindPurgeOutboxEvent`. */
export function purgeKindConstant(table) {
  return `KindPurge${pascalCase(table)}`;
}

/** El paquete del cronómetro. */
export const TIMER_IMPORT = 'internal/infrastructure/timer';

/** Los motores en los que hay cronómetro: los relacionales con sentencias medidas y MongoDB. */
export const TIMER_DATABASES = Object.freeze([...TIMER_ENGINES, 'mongodb']);

const PROFILES = ['local', 'develop', 'production', 'test'];

const cap = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const lower = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

// ─── Nombres ─────────────────────────────────────────────────────────────────────────────────────

/** El value object de los plazos vigentes: `VerificationCodesDeadlines`. */
export const deadlinesType = (model) => `${model.service.className}Deadlines`;
/** El accesor de la duración de un plazo: `VerificationCodePending`. */
export const deadlineAccessor = (entity, deadline) => `${entity.name}${goExported(deadline.stateName)}`;
/** La constante de su `kind` en el paquete del cronómetro: `KindVerificationCodePending`. */
export const kindConstant = (entity, deadline) => `Kind${entity.name}${goExported(deadline.stateName)}`;
/** El handler de un plazo: `VerificationCodePendingDeadline`. */
export const deadlineHandlerType = (entity, deadline) => `${entity.name}${goExported(deadline.stateName)}Deadline`;
/** La variable del arranque con los plazos vigentes. */
export const DEADLINES_VAR = 'deadlines';

/** El campo de Dependencies y el parámetro del handler con el reloj y con los plazos. */
export const CLOCK = { field: 'Clock', param: 'clock', type: 'Clock' };
export const DEADLINES = { field: 'Deadlines', param: 'deadlines' };

/** La operación `by` de un plazo, del modelo. */
function byOperation(model, deadline) {
  return operations(model).find((operation) => operation.name === deadline.by);
}

/** ¿Lleva su duración un parámetro de despliegue? Entonces el constructor de los plazos los recibe. */
export function deadlinesReadParameters(model) {
  return modelDeadlines(model).some(({ duration }) => duration.parameter);
}

/** Las operaciones que sacan una entidad de un estado con plazo hacia otro destino: reciben el reloj y los plazos. */
export function lateOperations(model) {
  if (!usesDeadlines(model)) return [];
  return operations(model).filter((operation) => lateTransitionNote(model, operation));
}

/** ¿Pide esta transición la hora? (para el TODO del método semántico y la llamada que se nombra). */
export function transitionNeedsClock(entity, fromConstant, toConstant) {
  return lateGuards(entity).some((guard) => guard.from === fromConstant && guard.exempt !== toConstant);
}

// ─── La frontera que depende del stack ───────────────────────────────────────────────────────────

/**
 * Lo que un diseño con plazos no puede generar con este stack, o []: el cronómetro solo existe donde sus sentencias se
 * midieron (timer-sql-check), y el rechazo tardío necesita un `code` con un solo status (lo lanza el DOMINIO, que no sabe
 * qué operación lo llama). Lo comprueba planService, que conoce el stack, como en keel-spring.
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
  for (const entity of model.entities ?? []) {
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

// ─── El rechazo tardío, en el dominio (lo emite entities.js) ─────────────────────────────────────

/**
 * Las piezas del lifecycle de una entidad con rechazos tardíos, o null si no tiene ninguno: `transitionAt` (la guarda con
 * la hora y los plazos) y el `transitionTo` de un argumento, que se niega a salir de un estado con plazo hacia otro
 * destino: sin la hora no hay rechazo tardío, y callarlo sería confirmar lo que el negocio daba por caducado. `apply` es
 * el cuerpo de la guarda del lifecycle (lo que hacía el transitionTo de siempre).
 */
export function lateGuardParts(model, entity, receiver, apply) {
  const guards = lateGuards(entity);
  if (guards.length === 0) return null;
  const { field, enumType } = entity.lifecycle;
  const constant = (value) => constantOf(model, enumType, value);
  const statusField = entity.fields.find((candidate) => candidate.name === field);
  const nullableStatus = statusField && isOptional(statusField);
  const status = `${receiver}.${localName(field)}`;
  const inState = (guard) => (nullableStatus ? `${status} != nil && *${status} == ${constant(guard.from)}` : `${status} == ${constant(guard.from)}`);
  const checks = guards.map((guard) => {
    const deadline = entity.lifecycle.deadlines.find((candidate) => candidate.state === guard.from);
    const error = model.errors.find((candidate) => candidate.code === guard.error);
    const sinceField = entity.fields.find((candidate) => candidate.name === guard.since);
    const since = `${receiver}.${localName(guard.since)}`;
    const optionalSince = sinceField && isOptional(sinceField);
    const message = formatString(error?.when ?? guard.error);
    const rejection = error ? `Errorf(${sentinelOf(guard.error)}, ${message})` : `errors.New(${goString(guard.error)})`;
    const measured = optionalSince
      ? `		if ${since} == nil {
			return errors.New(${goString(`${entity.name} en ${deadline.stateName} sin ${guard.since}: el plazo no se puede medir`)})
		}
		if !${since}.Add(deadlines.${deadlineAccessor(entity, deadline)}()).After(now) {
			return ${rejection}
		}`
      : `		if !${since}.Add(deadlines.${deadlineAccessor(entity, deadline)}()).After(now) {
			return ${rejection}
		}`;
    return `	// Plazo de '${deadline.stateName}' (DSL 2.26): pasado ${guard.since} + el plazo vigente, salir hacia otro destino que
	// '${deadline.toName}' es ${guard.error}. Vence EN el instante (since + after <= now), no después.
	if ${inState(guard)} && target != ${constant(guard.exempt)} {
${measured}
	}`;
  });
  // Con un solo plazo, sin paréntesis: gofmt quita los que envuelven la condición entera de un if.
  const guarded = guards.map((guard) => `${inState(guard)} && target != ${constant(guard.exempt)}`).map((condition, _i, all) => (all.length > 1 ? `(${condition})` : condition));
  const file = `${goFileName(entity.name)}_behavior.go`;
  return {
    transitionAt: `// transitionAt es la guarda del lifecycle con el RECHAZO TARDÍO de los plazos (DSL 2.26): la llaman los métodos
// semánticos, nunca un caso de uso. now es la hora del reloj inyectable (application.${CLOCK.type}, el puerto ${CLOCK_PORT.name}) y
// deadlines la duración vigente de cada plazo: los dos los recibe el método semántico del handler.
//
//lint:ignore U1000 la llaman los métodos semánticos que escribe el agente (los TODO de ${file}).
func (${receiver} *${entity.name}) transitionAt(target ${enumType}, now time.Time, deadlines ${deadlinesType(model)}) error {
${checks.join('\n')}
	return ${receiver}.applyTransition(target)
}`,
    transitionTo: `// transitionTo es la guarda del lifecycle SIN la hora: solo para las transiciones que no salen de un estado con plazo
// hacia otro destino que el suyo. Las que sí, van por transitionAt.
//
//lint:ignore U1000 la llaman los métodos semánticos que escribe el agente (los TODO de ${file}).
func (${receiver} *${entity.name}) transitionTo(target ${enumType}) error {
	if ${guarded.join(' || ')} {
		return errors.New("esta transición sale de un estado con plazo: usa transitionAt(target, now, deadlines)")
	}
	return ${receiver}.applyTransition(target)
}`,
    apply: `// applyTransition aplica una transición del lifecycle si el diseño la declara.
func (${receiver} *${entity.name}) applyTransition(target ${enumType}) error {
${apply}
	return nil
}`
  };
}

// ─── El armado, en el adaptador ──────────────────────────────────────────────────────────────────

/** Los plazos de una entidad: los que su adaptador arma al guardarla. */
function deadlinesOf(model, entity) {
  return modelDeadlines(model).filter((entry) => entry.entity.name === entity.name);
}

/** La dependencia que el adaptador de una raíz con plazos recibe: los plazos vigentes, con los que calcula el vencimiento. */
export function deadlineDependencies(model, entity) {
  if (deadlinesOf(model, entity).length === 0) return [];
  return [{ field: 'deadlines', type: `domain.${deadlinesType(model)}` }];
}

/** El vencimiento de un plazo sobre la entidad guardada, como expresión Go (y la comprobación de un `since` opcional). */
function dueExpression(entity, deadline, saved) {
  const sinceField = entity.fields.find((candidate) => candidate.name === deadline.since);
  const accessor = `${saved}.${goExported(deadline.since)}()`;
  const after = `r.deadlines.${deadlineAccessor(entity, deadline)}()`;
  if (sinceField && isOptional(sinceField)) return { guard: accessor, due: `${accessor}.Add(${after})`, optional: true };
  return { due: `${accessor}.Add(${after})`, optional: false };
}

/** El estado de la entidad guardada comparado con uno: con el estado opcional, por su puntero. */
function savedInState(model, entity, saved, state) {
  const { field, enumType } = entity.lifecycle;
  const statusField = entity.fields.find((candidate) => candidate.name === field);
  const value = `${saved}.${goExported(field)}()`;
  const constant = `domain.${constantOf(model, enumType, state)}`;
  return statusField && isOptional(statusField) ? `${value} != nil && *${value} == ${constant}` : `${value} == ${constant}`;
}

/**
 * Las piezas del armado en el Save del adaptador RELACIONAL, o null. `before` lee, en la transacción y antes de escribir,
 * el estado que la fila tenía (dice si la entidad ENTRA en el estado: salir no cuesta nada, y re-guardarla dentro no lo
 * rearma); `after` arma, tras releer, en esa misma transacción.
 */
export function relationalArming(model, entity, local, q, ph) {
  const entries = deadlinesOf(model, entity);
  if (entries.length === 0) return null;
  const { field, enumType } = entity.lifecycle;
  const column = entity.fields.find((candidate) => candidate.name === field)?.columns?.name ?? snakeCase(field);
  const idColumn = entity.idField?.columns?.name ?? 'id';
  const before = `		// El estado que la fila tenía ANTES de este guardado: un plazo se arma al ENTRAR en su estado (DSL 2.26).
		var previous sql.NullString
		if err := ${q}.QueryRowContext(ctx, ${goString(`SELECT ${column} FROM ${entity.tableName} WHERE ${idColumn} = ${ph(1)}`)}, ${local}.${goExported(entity.idField?.name ?? 'id')}()).Scan(&previous); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}`;
  const after = entries
    .map(({ deadline }) => {
      const { due, guard, optional } = dueExpression(entity, deadline, 'saved');
      const entering = `(!previous.Valid || previous.String != ${lower(enumType)}Column(domain.${constantOf(model, enumType, deadline.state)})) && ${savedInState(model, entity, 'saved', deadline.state)}`;
      const arm = `r.tx.armTimer(ctx, ${q}, timer.${kindConstant(entity, deadline)}, saved.${goExported(entity.idField?.name ?? 'id')}(), ${optional ? `${guard}.Add(r.deadlines.${deadlineAccessor(entity, deadline)}())` : due})`;
      return `		// El plazo de '${deadline.stateName}' se ARMA al entrar, en esta misma transacción: si revierte, no queda.
		if ${entering} {${optional ? `
			if ${guard} == nil {
				return errors.New(${goString(`${entity.name} en ${deadline.stateName} sin ${deadline.since}: el plazo no se puede armar`)})
			}` : ''}
			if err := ${arm}; err != nil {
				return err
			}
		}`;
    })
    .join('\n');
  return { before, after };
}

/** Las piezas del armado en el Save del adaptador DOCUMENTAL, o null: el documento de antes se lee en la sesión. */
export function documentArming(model, entity, local, filter) {
  const entries = deadlinesOf(model, entity);
  if (entries.length === 0) return null;
  const before = `		// El documento ANTES de este guardado: un plazo se arma al ENTRAR en su estado (DSL 2.26). Se lee en la sesión de la
		// transacción del caso de uso, antes de reemplazarlo.
		prior, err := r.find(ctx, bson.D{{Key: "_id", Value: ${filter}}}, options.Find().SetLimit(1))
		if err != nil {
			return err
		}`;
  const after = entries
    .map(({ deadline }) => {
      const { due, guard, optional } = dueExpression(entity, deadline, 'saved');
      const entering = `(len(prior) == 0 || !(${savedInState(model, entity, 'prior[0]', deadline.state)})) && ${savedInState(model, entity, 'saved', deadline.state)}`;
      return `		// El plazo de '${deadline.stateName}' se ARMA al entrar, en esta misma transacción: si aborta, no queda.
		if ${entering} {${optional ? `
			if ${guard} == nil {
				return errors.New(${goString(`${entity.name} en ${deadline.stateName} sin ${deadline.since}: el plazo no se puede armar`)})
			}` : ''}
			if err := r.tx.armTimer(ctx, timer.${kindConstant(entity, deadline)}, saved.${goExported(entity.idField?.name ?? 'id')}(), ${optional ? `${guard}.Add(r.deadlines.${deadlineAccessor(entity, deadline)}())` : due}); err != nil {
				return err
			}
		}`;
    })
    .join('\n');
  return { before, after };
}

// ─── Lo que emite build ──────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesTimer(model)) return [];
  const { domain, application, store } = layout(model);
  const timerPkg = timerPackage(model);
  const file = (name, imports, body, { test = false, doc = null } = {}) => ({
    path: `${timerPkg.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, timerPkg, { imports, body, test, doc })
  });
  const document = model.persistenceKind === 'document' || !usesRelational(model);
  const files = [
    ...(usesDeadlines(model)
      ? [
          { path: `${domain.dir}/${goFileName(deadlinesType(model))}.go`, content: packageFile(model, domain, { imports: ['errors', 'time'], body: deadlinesBody(model) }) },
          { path: `${application.dir}/clock.go`, content: packageFile(model, application, { imports: ['time'], body: CLOCK_BODY }) }
        ]
      : []),
    file('doc', [], '', { doc: PACKAGE_DOC }),
    file('kinds', [], kindsBody(model)),
    file('timer', ['context', 'fmt', 'strconv', 'strings', 'time', 'github.com/google/uuid', 'internal/platform/config'], timerBody()),
    file('poller', ['context', 'errors', 'fmt', 'log/slog', 'sync', 'time', 'github.com/google/uuid', 'github.com/robfig/cron/v3', 'internal/platform/correlation'], pollerBody(model)),
    file('purge', ['context', 'fmt'], PURGE_BODY),
    ...modelDeadlines(model).map((entry) =>
      file(goFileName(deadlineHandlerType(entry.entity, entry.deadline)), ['context', 'time', 'internal/application', 'internal/domain'], deadlineHandlerBody(model, entry))
    ),
    // La prueba del sondeador es INTERNA al paquete (package timer): usa sus tipos sin calificar, y con el paquete externo
    // (timer_test) no compilaba (lo midió go-check).
    { path: `${timerPkg.dir}/poller_test.go`, content: packageFile(model, timerPkg, { imports: ['context', 'errors', 'log/slog', 'testing', 'testing/synctest', 'time', 'github.com/google/uuid'], body: pollerTest() }) },
    {
      path: `${store.dir}/timers.go`,
      content: packageFile(model, store, {
        imports: document
          ? ['context', 'errors', 'fmt', 'time', 'github.com/google/uuid', 'go.mongodb.org/mongo-driver/v2/bson', { path: 'go.mongodb.org/mongo-driver/v2/mongo', name: 'mongodriver' }, 'go.mongodb.org/mongo-driver/v2/mongo/options', TIMER_IMPORT]
          : ['context', 'database/sql', 'errors', 'fmt', 'regexp', 'strconv', 'strings', 'time', 'github.com/google/uuid', TIMER_IMPORT],
        body: document ? documentStoreBody() : relationalStoreBody(model)
      })
    },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/timer.yaml`, content: timerYaml(profile) }))
  ];
  // El interruptor: scheduling.enabled, el del reloj. Si el diseño no tiene reloj, el fragmento lo emite el cronómetro.
  if (!usesScheduling(model)) files.push(...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/scheduling.yaml`, content: schedulingYaml(profile) })));
  return files;
}

/** El paquete del cronómetro (`internal/infrastructure/timer`). */
export function timerPackage(model) {
  const module = model.service.goModule;
  return { dir: TIMER_IMPORT, importPath: `${module}/${TIMER_IMPORT}`, name: 'timer' };
}

const PACKAGE_DOC = `Package timer es el cronómetro del servicio (DSL 2.26): UNA tabla de temporizadores (keel_timer) y un sondeador por
réplica, que dispara los plazos de negocio y la purga de la propia tabla. La tabla, las sentencias y los nombres de cada
temporizador son contrato con los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño
(keel-core/gen/timer-store.js): comparten base. La hora que compara es SIEMPRE la de la base.`;

// ─── El dominio y la aplicación ──────────────────────────────────────────────────────────────────

function deadlinesBody(model) {
  const entries = modelDeadlines(model);
  const type = deadlinesType(model);
  const parameters = model.service.parameters ?? [];
  const usesParameters = deadlinesReadParameters(model);
  const fields = alignRows(entries.map(({ entity, deadline }) => ({ indent: '\t', cells: [lower(deadlineAccessor(entity, deadline)), 'time.Duration'] })));
  const values = keyedLiteral(
    entries.map(({ entity, deadline, duration }) => {
      if (duration.seconds !== undefined) return [lower(deadlineAccessor(entity, deadline)), `${duration.seconds} * time.Second`];
      const parameter = parameters.find((candidate) => candidate.name === duration.parameter);
      return [lower(deadlineAccessor(entity, deadline)), `time.Duration(parameters.${goExported(parameter?.name ?? duration.parameter)}()) * ${duration.multiplier} * time.Second`];
    }),
    '\t\t'
  );
  const checks = entries.map(
    ({ entity, deadline }) => `	if d.${lower(deadlineAccessor(entity, deadline))} <= 0 {
		return ${type}{}, errors.New(${goString(`el plazo de ${entity.name}.${deadline.stateName} tiene que ser positivo`)})
	}`
  );
  const accessors = entries.map(
    ({ entity, deadline }) => `// ${deadlineAccessor(entity, deadline)} es cuánto puede seguir un ${entity.name} en '${deadline.stateName}' (desde ${deadline.since}).
func (d ${type}) ${deadlineAccessor(entity, deadline)}() time.Duration {
	return d.${lower(deadlineAccessor(entity, deadline))}
}`
  );
  return `
// ${type} es la duración VIGENTE de cada plazo de negocio del servicio (DSL 2.26, lifecycle.deadlines).
//
// Value object del dominio, como ${parametersType(model)}: el rechazo tardío del método de transición la necesita y el dominio
// no lee configuración. La construye el arranque, y la usan con el MISMO valor el dominio (el rechazo), el adaptador (el
// armado) y el cronómetro (la revalidación): cambiar el plazo en un despliegue no reescribe los temporizadores armados,
// los corrige la revalidación (T6).
type ${type} struct {
${fields.join('\n')}
}

// New${type} calcula la duración de cada plazo${usesParameters ? ' desde los parámetros de despliegue' : ''}. Un plazo que no es positivo no
// deja arrancar.
func New${type}(${usesParameters ? `parameters ${parametersType(model)}` : ''}) (${type}, error) {
	d := ${type}{
${values.join('\n')}
	}
${checks.join('\n')}
	return d, nil
}

${accessors.join('\n\n')}
`;
}

const CLOCK_BODY = `
// Clock es el reloj inyectable (el puerto Clock de keel-core/gen/deadlines.js): la hora que el handler de una transición
// tardía le da al dominio. En producción es time.Now; una prueba lo sustituye por una función que devuelve el instante que
// quiera medir, como el segundo exacto de un vencimiento. Es la hora de ESTA instancia (T2): la del cronómetro es la de la
// base.
type Clock func() time.Time
`;

// ─── El paquete del cronómetro ───────────────────────────────────────────────────────────────────

function kindsBody(model) {
  const rows = [];
  for (const { entity, deadline, kind } of modelDeadlines(model)) {
    rows.push({ text: `\t// ${kindConstant(entity, deadline)} es el plazo de ${entity.name} en '${deadline.stateName}'.` });
    rows.push({ indent: '\t', cells: [kindConstant(entity, deadline), `= ${goString(kind)}`] });
  }
  rows.push({ text: '\t// KindTimerPurge es la purga de la propia tabla: un recurrente en modo clúster (R7).' });
  rows.push({ indent: '\t', cells: ['KindTimerPurge', `= ${goString(TIMER_PURGE_KIND)}`] });
  for (const purge of timerPurges(model)) {
    rows.push({ text: `\t// ${purgeKindConstant(purge.table)} es la purga de ${purge.table}: un recurrente en modo clúster.` });
    rows.push({ indent: '\t', cells: [purgeKindConstant(purge.table), `= ${goString(purge.kind)}`] });
  }
  rows.push({ text: '\t// NilEntityID es el entity_id de un recurrente: no tiene entidad, y la unicidad (kind, entity_id) necesita un valor.' });
  rows.push({ indent: '\t', cells: ['NilEntityID', `= ${goString(NIL_ENTITY_ID)}`] });
  return `
// El nombre de cada temporizador en ${KEEL_TIMER.table} (columna kind). Es contrato con los otros generadores —comparten
// tabla—, así que sale de keel-core y no se cambia aquí.
const (
${alignRows(rows).join('\n')}
)
`;
}

/** Un parámetro del cronómetro en su perfil: el default literal en local y test, la variable con default fuera. */
function parameterValue(profile, parameter) {
  const value = profile === 'local' || profile === 'test' ? String(parameter.default) : `\${${parameter.env}:${parameter.default}}`;
  return parameter.cron ? `"${value}"` : value;
}

/** config/parameters/<perfil>/timer.yaml: la mecánica del cronómetro, con las claves y variables de keel-core. */
export function timerYaml(profile) {
  const P = TIMER_PARAMETERS;
  const leaf = (parameter) => parameter.key.split('.').at(-1);
  const line = (parameter, indent = '  ') => `${indent}${leaf(parameter)}: ${parameterValue(profile, parameter)}`;
  return [
    '# El cronómetro del servicio (DSL 2.26): un sondeador por réplica sobre la tabla keel_timer. Lo enciende y lo apaga',
    `# ${TIMER_SWITCH.key} (scheduling.yaml). Mecánica del generador, no contrato: el rechazo tardío lo hace el dominio en`,
    '# el instante exacto.',
    'timer:',
    line(P.maxSleepMs),
    line(P.batchSize),
    line(P.leaseMs),
    line(P.maxAttempts),
    line(P.retryDelayMs),
    line(P.retentionDays),
    '  purge:',
    '    # La purga de la propia tabla, evaluada en UTC.',
    line(P.purgeCron, '    ')
  ].join('\n') + '\n';
}

function timerBody() {
  const P = TIMER_PARAMETERS;
  const read = (parameter, kind) => `${goString(parameter.key)}, ${parameter.default}`;
  return `
// Claimed es un temporizador que ESTA réplica reclamó: lo es mientras dure su arriendo, y todo lo que se haga con él lleva
// la valla (el token) con la que se reclamó.
type Claimed struct {
	// ID es su identidad en la tabla: el uuid, o el _id documental (kind|entity_id).
	ID string
	// Kind es qué es: un plazo o un recurrente.
	Kind string
	// EntityID es la entidad de un plazo; el uuid nulo en un recurrente.
	EntityID uuid.UUID
	// DueAt es cuándo vencía.
	DueAt time.Time
	// Attempts son las veces que ya falló.
	Attempts int
}

// Outcome es el desenlace de un temporizador: borrarlo, o rearmarlo para otro vencimiento.
type Outcome struct {
	// Done dice que se borra: cumplido o descartado.
	Done bool
	// DueAt es el vencimiento nuevo si no se borra.
	DueAt time.Time
}

// Finished es el desenlace de un temporizador cumplido o descartado: se borra.
func Finished() Outcome {
	return Outcome{Done: true}
}

// RescheduleAt es el desenlace de un recurrente tras su tick, o de un plazo que la revalidación aplaza.
func RescheduleAt(dueAt time.Time) Outcome {
	return Outcome{DueAt: dueAt}
}

// Handler es lo que hace el cronómetro con los temporizadores de un kind. Corre DENTRO de la transacción en la que el
// sondeador borra o rearma el temporizador: si devuelve un error, la transacción revierte, el fallo se cuenta y, al agotar
// los intentos, el temporizador se aparca (T5). dbNow es la hora de la BASE (T1), la única que compara el cronómetro.
type Handler interface {
	Kind() string
	Handle(ctx context.Context, claimed Claimed, dbNow time.Time) (Outcome, error)
}

// Recurring es un temporizador RECURRENTE en modo clúster: una fila sin entidad, que cada réplica asegura al arrancar (R1)
// y que en cada tick ejecuta UNA sola réplica, la que la reclama. El siguiente tick lo calcula el sondeador desde la hora
// de la base de DESPUÉS del tick (R2), con el cron en UTC (T7).
//
// El tick corre FUERA de toda transacción, a diferencia de un plazo: un recurrente (una purga por lotes) gestiona las
// suyas, y envolverlo en una sola volvería a ser el DELETE único que la purga por lotes sustituye. Si devuelve un error,
// cuenta como un fallo del temporizador, igual que un plazo.
type Recurring interface {
	Kind() string
	// Spec es el cron de seis campos (el segundo primero), evaluado en UTC.
	Spec() string
	// Tick es lo que hace el mecanismo cada vez que vence.
	Tick(ctx context.Context) error
}

// Store es la tabla del cronómetro (${KEEL_TIMER.table}): las sentencias son las de keel-core, iguales en los cuatro
// generadores, y la hora que comparan es SIEMPRE la de la base. La implementa el adaptador del motor.
type Store interface {
	// DBNow es la hora de la base.
	DBNow(ctx context.Context) (time.Time, error)
	// EnsureRecurring asegura la fila de un recurrente: la crea, o recalcula su vencimiento si su spec cambió (R1).
	EnsureRecurring(ctx context.Context, kind, spec string, dueAt time.Time) error
	// Claim reclama lo vencido y libre de esos kinds, en orden de vencimiento, con arriendo y valla. Confirma antes de
	// volver: las demás réplicas dejan de ver el lote aunque quien llama tarde en procesarlo.
	Claim(ctx context.Context, kinds []string, limit int, lease time.Duration, token uuid.UUID) ([]Claimed, error)
	// Resolve ejecuta fn en una transacción PROPIA y, en ella, borra o rearma el temporizador según su desenlace, solo si
	// sigue siendo de quien lo reclamó. Si fn falla, la transacción revierte y el error vuelve.
	Resolve(ctx context.Context, claimed Claimed, token uuid.UUID, fn func(ctx context.Context) (Outcome, error)) error
	// Reschedule rearma un recurrente tras su tick, libre y con los intentos a cero, solo si sigue siendo de quien lo
	// reclamó (sin transacción: el tick ya hizo lo suyo en las suyas).
	Reschedule(ctx context.Context, id string, token uuid.UUID, dueAt time.Time) error
	// Fail cuenta un fallo; tras el retraso se reintenta y, al agotar los intentos, se aparca.
	Fail(ctx context.Context, id string, token uuid.UUID, maxAttempts int, retryDelay time.Duration) error
	// NextDue es cuánto falta para lo próximo reclamable de esos kinds (puede ser negativo); false si no hay nada.
	NextDue(ctx context.Context, kinds []string) (time.Duration, bool, error)
	// ParkedCount son los temporizadores aparcados.
	ParkedCount(ctx context.Context) (int64, error)
	// Purge borra lo vencido hace más de la retención y sin reclamar (R4, R7).
	Purge(ctx context.Context, retentionDays int) (int64, error)
}

// Settings es la mecánica del cronómetro del perfil (config/parameters/<perfil>/timer.yaml), con las claves y los
// defaults de keel-core/gen/timer-store.js, y su interruptor (${TIMER_SWITCH.key}).
type Settings struct {
	// Enabled dice si esta réplica sondea. Apagado, los temporizadores se siguen ARMANDO (eso es persistencia): lo que deja
	// de haber es quien los dispare.
	Enabled bool
	// MaxSleep es cuánto duerme como mucho sin plazos próximos: lo que tarda en ver lo que arma OTRA réplica.
	MaxSleep time.Duration
	// BatchSize es cuántos temporizadores reclama en cada pasada.
	BatchSize int
	// Lease es el arriendo de lo reclamado: mayor que lo que tarda un lote (T4).
	Lease time.Duration
	// MaxAttempts son los fallos tras los que un temporizador se aparca.
	MaxAttempts int
	// RetryDelay es cuándo se reintenta un temporizador que falló.
	RetryDelay time.Duration
	// RetentionDays es lo que la purga de la tabla deja de lo vencido sin reclamar.
	RetentionDays int
	// PurgeCron es cuándo corre esa purga, en UTC.
	PurgeCron string
}

// SettingsFrom lee el cronómetro del perfil. Un número que no es un entero positivo, o un interruptor que no es true ni
// false, no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	read := &reader{cfg: cfg}
	settings := Settings{
		Enabled:       read.flag(${goString(TIMER_SWITCH.key)}, ${TIMER_SWITCH.default}),
		MaxSleep:      time.Duration(read.positive(${read(P.maxSleepMs)})) * time.Millisecond,
		BatchSize:     read.positive(${read(P.batchSize)}),
		Lease:         time.Duration(read.positive(${read(P.leaseMs)})) * time.Millisecond,
		MaxAttempts:   read.positive(${read(P.maxAttempts)}),
		RetryDelay:    time.Duration(read.positive(${read(P.retryDelayMs)})) * time.Millisecond,
		RetentionDays: read.positive(${read(P.retentionDays)}),
		PurgeCron:     read.text(${goString(P.purgeCron.key)}, ${goString(P.purgeCron.default)}),
	}
	return settings, read.err
}

// reader lee claves de la configuración y se queda con el primer valor inválido.
type reader struct {
	cfg *config.Config
	err error
}

// value es el valor de key sin espacios, y si el perfil lo declara.
func (r *reader) value(key string) (string, bool) {
	value, ok := r.cfg.Value(key)
	value = strings.TrimSpace(value)
	return value, ok && value != ""
}

// text es el valor de key, o fallback si el perfil no lo declara.
func (r *reader) text(key, fallback string) string {
	if value, ok := r.value(key); ok {
		return value
	}
	return fallback
}

// positive es el entero positivo de key, o fallback si el perfil no lo declara.
func (r *reader) positive(key string, fallback int) int {
	value, ok := r.value(key)
	if !ok {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if (err != nil || n <= 0) && r.err == nil {
		r.err = fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
	}
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

// flag es el booleano de key, o fallback si el perfil no lo declara.
func (r *reader) flag(key string, fallback bool) bool {
	value, ok := r.value(key)
	if !ok {
		return fallback
	}
	switch strings.ToLower(value) {
	case "true":
		return true
	case "false":
		return false
	}
	if r.err == nil {
		r.err = fmt.Errorf("%s tiene que ser true o false: %q", key, value)
	}
	return fallback
}
`;
}

function pollerBody(model) {
  const correlated = usesCorrelation(model);
  return `
// parser lee el cron de seis campos de los cuatro servidores del diseño: segundo, minuto, hora, día del mes, mes y día
// de la semana.
var parser = cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

// NextTick es el siguiente tick de spec ESTRICTAMENTE posterior a from, con el cron evaluado en UTC (T7): dos réplicas
// con zonas distintas disparan a la misma hora.
func NextTick(spec string, from time.Time) (time.Time, error) {
	schedule, err := parser.Parse(spec)
	if err != nil {
		return time.Time{}, fmt.Errorf("cron inválido %q: %w", spec, err)
	}
	return schedule.Next(from.UTC()), nil
}

// SleepFor es cuánto duerme el sondeador: hasta lo próximo, con el tope (para ver lo que arman otras réplicas) y nunca
// negativo. Sin nada pendiente, el tope.
func SleepFor(next time.Duration, pending bool, maxSleep time.Duration) time.Duration {
	if !pending {
		return maxSleep
	}
	return max(0, min(next, maxSleep))
}

// Poller es el sondeador del cronómetro: UNO por réplica. Cada pasada reclama un lote de lo vencido (dos réplicas nunca
// toman el mismo mientras dure el arriendo), resuelve cada temporizador con su Handler DENTRO de una transacción en la que
// también lo borra o lo rearma, y duerme hasta el vencimiento más próximo, con un tope para ver lo que arman otras
// réplicas. Un temporizador que esta réplica arma y vence antes la despierta (Armed). Es al menos una vez: si la réplica
// muere con un lote arrendado, otra lo retoma al vencer el arriendo, y el efecto es uno solo porque la transición del
// plazo es condicional y la revalidación descarta lo que ya no aplica.
type Poller struct {
	store      Store
	handlers   map[string]Handler
	recurrings map[string]Recurring
	kinds      []string
	settings   Settings
	logger     *slog.Logger

	// wake avisa al bucle de que wakeAt cambió; con hueco para uno, nunca bloquea a quien arma.
	wake chan struct{}
	// mu guarda wakeAt, que escriben el bucle y quien arma (tras su commit).
	mu     sync.Mutex
	wakeAt time.Time
}

// NewPoller prepara el sondeador con los handlers de los plazos y los recurrentes. Un kind repetido o un recurrente con un
// cron inválido no deja arrancar: un plazo que no se dispara nunca no da ningún error que alguien vaya a ver.
func NewPoller(store Store, handlers []Handler, recurrings []Recurring, settings Settings, logger *slog.Logger) (*Poller, error) {
	p := &Poller{
		store:      store,
		handlers:   make(map[string]Handler, len(handlers)),
		recurrings: make(map[string]Recurring, len(recurrings)),
		settings:   settings,
		logger:     logger,
		wake:       make(chan struct{}, 1),
	}
	seen := make(map[string]bool, len(handlers)+len(recurrings))
	add := func(kind string) error {
		if seen[kind] {
			return fmt.Errorf("temporizador duplicado: %s", kind)
		}
		seen[kind] = true
		// Solo los kinds que esta réplica conoce (R4): un temporizador de otra versión no lo toca, ni para borrarlo.
		p.kinds = append(p.kinds, kind)
		return nil
	}
	for _, handler := range handlers {
		if err := add(handler.Kind()); err != nil {
			return nil, err
		}
		p.handlers[handler.Kind()] = handler
	}
	for _, recurring := range recurrings {
		if _, err := parser.Parse(recurring.Spec()); err != nil {
			return nil, fmt.Errorf("el recurrente %s tiene un cron inválido %q: %w", recurring.Kind(), recurring.Spec(), err)
		}
		if err := add(recurring.Kind()); err != nil {
			return nil, err
		}
		p.recurrings[recurring.Kind()] = recurring
	}
	return p, nil
}

// Kinds son los kinds que esta réplica reclama.
func (p *Poller) Kinds() []string {
	return append([]string(nil), p.kinds...)
}

// EnsureRecurring asegura las filas de los recurrentes de esta réplica (R1), con el siguiente tick desde la hora de la
// base.
func (p *Poller) EnsureRecurring(ctx context.Context) error {
	now, err := p.store.DBNow(ctx)
	if err != nil {
		return err
	}
	for _, kind := range p.kinds {
		recurring, ok := p.recurrings[kind]
		if !ok {
			continue
		}
		next, err := NextTick(recurring.Spec(), now)
		if err != nil {
			return err
		}
		if err := p.store.EnsureRecurring(ctx, kind, recurring.Spec(), next); err != nil {
			return fmt.Errorf("asegurar el recurrente %s: %w", kind, err)
		}
	}
	return nil
}

// PollOnce es una pasada: reclama, resuelve y devuelve cuánto dormir. Un temporizador que falla no para la pasada: se
// cuenta su intento y, al agotarlos, se aparca.
func (p *Poller) PollOnce(ctx context.Context) (time.Duration, error) {
	token, err := uuid.NewRandom()
	if err != nil {
		return 0, err
	}
	claimed, err := p.store.Claim(ctx, p.kinds, p.settings.BatchSize, p.settings.Lease, token)
	if err != nil {
		return 0, fmt.Errorf("reclamar temporizadores: %w", err)
	}
	for _, timer := range claimed {
		var err error
		if recurring, ok := p.recurrings[timer.Kind]; ok {
			err = p.tick(ctx, recurring, timer, token)
		} else {
			err = p.store.Resolve(ctx, timer, token, func(ctx context.Context) (Outcome, error) {
				return p.handle(ctx, timer)
			})
		}
		if err != nil {
			p.logger.WarnContext(ctx, "temporizador: falló", "timer", timer.ID, "kind", timer.Kind, "attempt", timer.Attempts+1, "error", err)
			if err := p.store.Fail(ctx, timer.ID, token, p.settings.MaxAttempts, p.settings.RetryDelay); err != nil {
				p.logger.ErrorContext(ctx, "temporizador: no se pudo contar el fallo", "timer", timer.ID, "error", err)
			} else if timer.Attempts+1 >= p.settings.MaxAttempts {
				p.logger.ErrorContext(ctx, "temporizador: agotó sus intentos y queda APARCADO", "timer", timer.ID, "kind", timer.Kind, "attempts", p.settings.MaxAttempts)
			}
		}
	}
	next, pending, err := p.store.NextDue(ctx, p.kinds)
	if err != nil {
		return 0, fmt.Errorf("leer el siguiente vencimiento: %w", err)
	}
	return SleepFor(next, pending, p.settings.MaxSleep), nil
}

// handle resuelve un temporizador con su handler, con la hora de la base. Un pánico del handler es un fallo más: no
// tumba la réplica.
func (p *Poller) handle(ctx context.Context, timer Claimed) (outcome Outcome, err error) {
	handler, ok := p.handlers[timer.Kind]
	if !ok {
		return Outcome{}, fmt.Errorf("temporizador de un kind sin handler: %s", timer.Kind)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("pánico en el temporizador %s: %v", timer.Kind, recovered)
		}
	}()
${correlated ? `	// Cada disparo es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación.
	ctx = correlation.WithID(ctx, uuid.NewString())
` : ''}	dbNow, err := p.store.DBNow(ctx)
	if err != nil {
		return Outcome{}, err
	}
	return handler.Handle(ctx, timer, dbNow)
}

// tick ejecuta un recurrente en modo clúster: lo ejecuta esta réplica porque ganó la fila, FUERA de toda transacción (el
// mecanismo gestiona las suyas), y lo rearma con el siguiente tick desde la hora de la base de DESPUÉS (R2). Si otra
// réplica le quitó la fila (el tick duró más que el arriendo), el rearme no casa con la valla y no pisa nada. Un pánico es
// un fallo más: no tumba la réplica.
func (p *Poller) tick(ctx context.Context, recurring Recurring, timer Claimed, token uuid.UUID) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("pánico en el temporizador %s: %v", timer.Kind, recovered)
		}
	}()
	if err = recurring.Tick(ctx); err != nil {
		return err
	}
	after, err := p.store.DBNow(ctx)
	if err != nil {
		return err
	}
	next, err := NextTick(recurring.Spec(), after)
	if err != nil {
		return err
	}
	return p.store.Reschedule(ctx, timer.ID, token, next)
}

// Armed avisa de un temporizador armado en ESTA réplica (tras el commit): si vence antes de lo que el bucle iba a dormir,
// lo despierta. Así un plazo corto no espera al tope del sueño.
func (p *Poller) Armed(dueAt time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.wakeAt.IsZero() && !dueAt.Before(p.wakeAt) {
		return
	}
	p.wakeAt = dueAt
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// WakeAt es cuándo piensa despertar el bucle.
func (p *Poller) WakeAt() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.wakeAt
}

// planWake fija cuándo despertar tras una pasada.
func (p *Poller) planWake(at time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.wakeAt = at
}

// Run es la vida del sondeador hasta que ctx se cancela: entonces no empieza otra pasada y vuelve cuando termina la que
// está en vuelo, que no se corta (cortarla dejaría temporizadores arrendados sin hacer hasta que venciera el arriendo).
// Va en el errgroup del arranque, así que la base se cierra después.
func (p *Poller) Run(ctx context.Context) error {
	if !p.settings.Enabled {
		p.logger.InfoContext(ctx, "cronómetro apagado (${TIMER_SWITCH.key}: false)", "kinds", len(p.kinds))
		return nil
	}
	ensured := false
	for ctx.Err() == nil {
		// Sin la cancelación del apagado: la pasada que ya empezó termina.
		pass := context.WithoutCancel(ctx)
		if !ensured {
			if err := p.EnsureRecurring(pass); err != nil {
				p.logger.ErrorContext(ctx, "el cronómetro no pudo asegurar sus recurrentes; lo reintenta en la siguiente pasada", "error", err)
			} else {
				ensured = true
			}
		}
		sleep, err := p.PollOnce(pass)
		if err != nil {
			p.logger.ErrorContext(ctx, "la pasada del cronómetro falló; se reintenta tras el sueño máximo", "error", err)
			sleep = p.settings.MaxSleep
		}
		p.planWake(time.Now().Add(sleep))
		if !p.wait(ctx) {
			return nil
		}
	}
	return nil
}

// wait duerme hasta wakeAt, que Armed puede adelantar. Devuelve false si ctx se cancela antes.
func (p *Poller) wait(ctx context.Context) bool {
	for {
		remaining := time.Until(p.WakeAt())
		if remaining <= 0 {
			return true
		}
		timer := time.NewTimer(remaining)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-p.wake:
			timer.Stop()
		case <-timer.C:
			return true
		}
	}
}
`;
}

const PURGE_BODY = `
// TimerPurge es la purga de la propia tabla del cronómetro (R7): un recurrente más, en modo clúster, así que la ejecuta UNA
// réplica por tick. Borra lo vencido hace más de la retención y sin reclamar: un temporizador de un kind que ya no conoce
// ninguna réplica (R4) o uno aparcado que ya se vio.
type TimerPurge struct {
	store         Store
	spec          string
	retentionDays int
}

// NewTimerPurge prepara la purga con el cron y la retención del perfil. Un cron inválido no deja arrancar.
func NewTimerPurge(store Store, settings Settings) (*TimerPurge, error) {
	if _, err := parser.Parse(settings.PurgeCron); err != nil {
		return nil, err
	}
	return &TimerPurge{store: store, spec: settings.PurgeCron, retentionDays: settings.RetentionDays}, nil
}

// Kind implementa Recurring.
func (p *TimerPurge) Kind() string {
	return KindTimerPurge
}

// Spec implementa Recurring.
func (p *TimerPurge) Spec() string {
	return p.spec
}

// Tick implementa Recurring: purga. El rearme lo hace el sondeador, desde la hora de la base de después del tick (R2).
func (p *TimerPurge) Tick(ctx context.Context) error {
	_, err := p.store.Purge(ctx, p.retentionDays)
	return err
}

// recurring es un Recurring de un kind, un cron y lo que hace cada tick.
type recurring struct {
	kind string
	spec string
	tick func(ctx context.Context) error
}

// NewRecurring es un recurrente en modo clúster a partir de lo que hace cada tick. Así llegan al cronómetro las purgas de
// las tablas del generador (DSL 2.26, inc. 7): con el Run de su tarea de siempre (scheduler.PurgeTask), que ahora ejecuta
// UNA réplica por tick en vez de todas a la vez. Un cron inválido no deja arrancar.
func NewRecurring(kind, spec string, tick func(ctx context.Context) error) (Recurring, error) {
	if _, err := parser.Parse(spec); err != nil {
		return nil, fmt.Errorf("el recurrente %s tiene un cron inválido %q: %w", kind, spec, err)
	}
	return &recurring{kind: kind, spec: spec, tick: tick}, nil
}

// Kind implementa Recurring.
func (r *recurring) Kind() string {
	return r.kind
}

// Spec implementa Recurring.
func (r *recurring) Spec() string {
	return r.spec
}

// Tick implementa Recurring.
func (r *recurring) Tick(ctx context.Context) error {
	return r.tick(ctx)
}
`;

function deadlineHandlerBody(model, { entity, deadline }) {
  const type = deadlineHandlerType(entity, deadline);
  const operation = byOperation(model, deadline);
  const contract = contractOf(operation, model);
  const message = messageType(operation);
  const component = messageComponents(operation, model).filter((candidate) => !candidate.entryGate)[0];
  const field = goExported(component?.name ?? 'id');
  const { field: status, enumType } = entity.lifecycle;
  const statusField = entity.fields.find((candidate) => candidate.name === status);
  const optionalStatus = statusField && isOptional(statusField);
  const constant = `domain.${constantOf(model, enumType, deadline.state)}`;
  const state = optionalStatus ? `found.${goExported(status)}() == nil || *found.${goExported(status)}() != ${constant}` : `found.${goExported(status)}() != ${constant}`;
  const sinceField = entity.fields.find((candidate) => candidate.name === deadline.since);
  const optionalSince = sinceField && isOptional(sinceField);
  const since = `found.${goExported(deadline.since)}()`;
  const handlerField = contract.kind === 'KindCommand' ? `application.CommandHandler[application.${message}]` : `application.${contract.handler.replace(/\[(\w+), /, (all, m) => `[application.${m}, application.`)}`;
  const dispatch =
    contract.kind === 'KindCommand'
      ? `	if err := d.${lower(useCaseField(operation))}.Handle(ctx, application.${message}{${field}: claimed.EntityID}); err != nil {
		return Outcome{}, err
	}`
      : `	if _, err := d.${lower(useCaseField(operation))}.Handle(ctx, application.${message}{${field}: claimed.EntityID}); err != nil {
		return Outcome{}, err
	}`;
  const repository = `domain.${entity.name}Repository`;
  return `
// ${type} es el plazo de ${entity.name} en '${deadline.stateName}' (DSL 2.26): vencido ${deadline.since} + el plazo vigente, la
// entidad pasa a '${deadline.toName}' por ${operation.name}, que despacha este handler.
//
// Antes de despachar REVALIDA, con la hora de la base y el plazo de AHORA: si la entidad ya no existe o ya salió de
// '${deadline.stateName}', el temporizador se descarta sin transición (DL-8); si con el plazo vigente todavía no vence, se
// rearma (DL-9, T6). Lo que hace ${operation.name} al caducar es del diseño: lo escribe el agente en su handler.
type ${type} struct {
${alignRows([
  { indent: '\t', cells: ['repository', repository] },
  { indent: '\t', cells: [lower(useCaseField(operation)), handlerField] },
  { indent: '\t', cells: ['deadlines', `domain.${deadlinesType(model)}`] }
]).join('\n')}
}

// New${type} prepara el plazo con el repositorio de ${entity.name}, el caso de uso ${operation.name} y los plazos vigentes.
func New${type}(repository ${repository}, ${lower(useCaseField(operation))} ${handlerField}, deadlines domain.${deadlinesType(model)}) *${type} {
	return &${type}{repository: repository, ${lower(useCaseField(operation))}: ${lower(useCaseField(operation))}, deadlines: deadlines}
}

// Kind implementa Handler.
func (d *${type}) Kind() string {
	return ${kindConstant(entity, deadline)}
}

// Handle implementa Handler: revalida y, si el plazo sigue vencido, despacha ${operation.name}.
func (d *${type}) Handle(ctx context.Context, claimed Claimed, dbNow time.Time) (Outcome, error) {
	found, ok, err := d.repository.FindByID(ctx, claimed.EntityID)
	if err != nil {
		return Outcome{}, err
	}
	if !ok || ${state} {
		return Finished(), nil
	}${optionalSince ? `
	if ${since} == nil {
		return Finished(), nil
	}` : ''}
	due := ${optionalSince ? `(*${since})` : since}.Add(d.deadlines.${deadlineAccessor(entity, deadline)}())
	if due.After(dbNow) {
		return RescheduleAt(due), nil
	}
${dispatch}
	return Finished(), nil
}
`;
}

// La prueba emitida del sondeador, con un almacén en memoria con la semántica de las sentencias de keel-core
// (timer-poller.js) y el reloj falso de testing/synctest: el sueño, el despertar al armar y el aparcado (DL-10), y el cron
// en UTC (CRON_UTC_CASES). Lo que toca el motor lo miden db-check y doc-check.
function pollerTest() {
  return `
// memoryStore es un almacén en memoria con la semántica de las sentencias de keel-core (keel-core/gen/timer-poller.js): el
// arriendo, la valla, el aparcado y el rearme. La hora de la base es la del reloj de la prueba.
type memoryStore struct {
	rows map[string]*memoryRow
}

type memoryRow struct {
	claimed      Claimed
	spec         string
	claimedUntil time.Time
	token        uuid.UUID
	parked       bool
}

func newMemoryStore() *memoryStore {
	return &memoryStore{rows: map[string]*memoryRow{}}
}

func (m *memoryStore) arm(kind string, entityID uuid.UUID, dueAt time.Time) {
	id := kind + "|" + entityID.String()
	m.rows[id] = &memoryRow{claimed: Claimed{ID: id, Kind: kind, EntityID: entityID, DueAt: dueAt}}
}

func (m *memoryStore) DBNow(context.Context) (time.Time, error) {
	return time.Now(), nil
}

func (m *memoryStore) EnsureRecurring(_ context.Context, kind, spec string, dueAt time.Time) error {
	id := kind + "|" + NilEntityID
	if row, ok := m.rows[id]; ok {
		if row.spec != spec {
			row.spec, row.claimed.DueAt = spec, dueAt
		}
		return nil
	}
	m.rows[id] = &memoryRow{claimed: Claimed{ID: id, Kind: kind, DueAt: dueAt}, spec: spec}
	return nil
}

func (m *memoryStore) Claim(_ context.Context, kinds []string, limit int, lease time.Duration, token uuid.UUID) ([]Claimed, error) {
	now := time.Now()
	var out []Claimed
	for _, row := range m.rows {
		known := false
		for _, kind := range kinds {
			known = known || kind == row.claimed.Kind
		}
		if known && !row.parked && !row.claimed.DueAt.After(now) && (row.claimedUntil.IsZero() || row.claimedUntil.Before(now)) && len(out) < limit {
			row.claimedUntil, row.token = now.Add(lease), token
			out = append(out, row.claimed)
		}
	}
	return out, nil
}

func (m *memoryStore) fenced(id string, token uuid.UUID) *memoryRow {
	if row, ok := m.rows[id]; ok && row.token == token {
		return row
	}
	return nil
}

func (m *memoryStore) Resolve(ctx context.Context, claimed Claimed, token uuid.UUID, fn func(context.Context) (Outcome, error)) error {
	outcome, err := fn(ctx)
	if err != nil {
		return err
	}
	row := m.fenced(claimed.ID, token)
	if row == nil {
		return nil
	}
	if outcome.Done {
		delete(m.rows, claimed.ID)
		return nil
	}
	row.claimed.DueAt, row.claimedUntil, row.token, row.claimed.Attempts = outcome.DueAt, time.Time{}, uuid.Nil, 0
	return nil
}

func (m *memoryStore) Reschedule(_ context.Context, id string, token uuid.UUID, dueAt time.Time) error {
	row := m.fenced(id, token)
	if row == nil {
		return nil
	}
	row.claimed.DueAt, row.claimedUntil, row.token, row.claimed.Attempts = dueAt, time.Time{}, uuid.Nil, 0
	return nil
}

func (m *memoryStore) Fail(_ context.Context, id string, token uuid.UUID, maxAttempts int, retryDelay time.Duration) error {
	row := m.fenced(id, token)
	if row == nil {
		return nil
	}
	row.parked = row.claimed.Attempts+1 >= maxAttempts
	row.claimed.Attempts++
	row.claimed.DueAt, row.claimedUntil, row.token = time.Now().Add(retryDelay), time.Time{}, uuid.Nil
	return nil
}

func (m *memoryStore) NextDue(_ context.Context, kinds []string) (time.Duration, bool, error) {
	var next time.Time
	for _, row := range m.rows {
		if row.parked {
			continue
		}
		due := row.claimed.DueAt
		if row.claimedUntil.After(due) {
			due = row.claimedUntil
		}
		if next.IsZero() || due.Before(next) {
			next = due
		}
	}
	if next.IsZero() {
		return 0, false, nil
	}
	return time.Until(next), true, nil
}

func (m *memoryStore) ParkedCount(context.Context) (int64, error) {
	var n int64
	for _, row := range m.rows {
		if row.parked {
			n++
		}
	}
	return n, nil
}

func (m *memoryStore) Purge(context.Context, int) (int64, error) {
	return 0, nil
}

// failing es un plazo cuyo handler falla siempre.
type failing struct{}

func (failing) Kind() string { return "deadline:Probe.failing" }

func (failing) Handle(context.Context, Claimed, time.Time) (Outcome, error) {
	return Outcome{}, errors.New("fallo de prueba")
}

func testSettings() Settings {
	return Settings{Enabled: true, MaxSleep: 30 * time.Second, BatchSize: 50, Lease: time.Minute, MaxAttempts: 2, RetryDelay: 0, RetentionDays: 7, PurgeCron: "0 30 5 * * *"}
}

func TestElSiguienteTickSeCalculaEnUTC(t *testing.T) {
	for _, tt := range []struct{ spec, from, want string }{
${CRON_CASES_ROWS}
	} {
		from, _ := time.Parse(time.RFC3339, tt.from)
		got, err := NextTick(tt.spec, from.In(time.FixedZone("UTC-5", -5*3600)))
		if err != nil {
			t.Fatal(err)
		}
		if want, _ := time.Parse(time.RFC3339, tt.want); !got.Equal(want) {
			t.Errorf("NextTick(%q, %s) = %s, quería %s", tt.spec, tt.from, got.UTC(), want)
		}
	}
}

func TestDuermeHastaElSiguienteVencimientoYDespiertaAlArmar(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newMemoryStore()
		store.arm("deadline:Probe.failing", uuid.New(), time.Now().Add(5*time.Second))
		poller, err := NewPoller(store, []Handler{failing{}}, nil, testSettings(), slog.New(slog.DiscardHandler))
		if err != nil {
			t.Fatal(err)
		}
		sleep, err := poller.PollOnce(t.Context())
		if err != nil || sleep != 5*time.Second {
			t.Fatalf("con un vencimiento a 5 s iba a dormir %s (%v)", sleep, err)
		}
		poller.planWake(time.Now().Add(30 * time.Second))
		poller.Armed(time.Now().Add(time.Second))
		if !poller.WakeAt().Equal(time.Now().Add(time.Second)) {
			t.Errorf("armar uno que vence antes no adelantó el despertar: %s", poller.WakeAt())
		}
		poller.Armed(time.Now().Add(time.Minute))
		if !poller.WakeAt().Equal(time.Now().Add(time.Second)) {
			t.Errorf("armar uno que vence después atrasó el despertar: %s", poller.WakeAt())
		}
		if got := SleepFor(0, false, 30*time.Second); got != 30*time.Second {
			t.Errorf("sin nada pendiente el sueño es el tope, no %s", got)
		}
	})
}

func TestAparcaTrasAgotarSusIntentos(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newMemoryStore()
		store.arm("deadline:Probe.failing", uuid.New(), time.Now())
		poller, err := NewPoller(store, []Handler{failing{}}, nil, testSettings(), slog.New(slog.DiscardHandler))
		if err != nil {
			t.Fatal(err)
		}
		for pass := 1; pass <= 2; pass++ {
			if _, err := poller.PollOnce(t.Context()); err != nil {
				t.Fatal(err)
			}
			parked, _ := store.ParkedCount(t.Context())
			if want := int64(pass / 2); parked != want {
				t.Fatalf("tras %d pasadas hay %d aparcados, quería %d", pass, parked, want)
			}
		}
	})
}

func TestLaPurgaEsUnRecurrenteQueSeAseguraUnaVez(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newMemoryStore()
		purge, err := NewTimerPurge(store, testSettings())
		if err != nil {
			t.Fatal(err)
		}
		poller, err := NewPoller(store, nil, []Recurring{purge}, testSettings(), slog.New(slog.DiscardHandler))
		if err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err := poller.EnsureRecurring(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		if len(store.rows) != 1 {
			t.Fatalf("asegurar dos veces dejó %d filas", len(store.rows))
		}
	})
}
`;
}

// Los casos del cron en UTC de keel-core, como filas de la tabla de la prueba emitida.
const CRON_CASES_ROWS = CRON_UTC_CASES.map(([spec, from, next]) => `\t\t{${goString(spec)}, ${goString(from)}, ${goString(next)}},`).join('\n');

// ─── El almacén relacional: las sentencias de keel-core, tal cual ────────────────────────────────

/** Las sentencias que el almacén usa, por su nombre de keel-core, y la constante Go de cada una. */
export const TIMER_STATEMENT_NAMES = ['dbNow', 'arm', 'ensureRecurring', 'claimLock', 'claimMark', 'claimed', 'complete', 'reschedule', 'fail', 'nextDueMs', 'parkedCount', 'purge'];
export const statementConstant = (name) => `timer${cap(name).replace(/^Db/, 'DB')}`;

function relationalStoreBody(model) {
  const engine = relationalEngine(model);
  const sql = timerStatements(engine);
  const d = sqlDialect(model);
  const constants = TIMER_STATEMENT_NAMES.flatMap((name) => [
    { text: `\t// ${statementConstant(name)} es la sentencia «${name}» de keel-core.` },
    { indent: '\t', cells: [statementConstant(name), `= ${goString(sql[name])}`] }
  ]);
  const claimOptions = d.mysql ? 'sql.TxOptions{Isolation: sql.LevelReadCommitted}' : 'sql.TxOptions{}';
  return `
// Las sentencias del cronómetro sobre ${d.label}, de keel-core (gen/timer-store.js) TAL CUAL, con sus marcadores
// nombrados: son contrato con los otros generadores, que comparten la tabla, y las mide timer-sql-check contra el motor.
// No las reescribas aquí.
const (
${alignRows(constants).join('\n')}
)

// timerMarker es un marcador nombrado de las sentencias de keel-core (:id), con el carácter que lo precede.
var timerMarker = regexp.MustCompile(\`(^|[^:\\w]):([a-zA-Z][a-zA-Z0-9]*)\`)

// timerSQL pasa una sentencia con marcadores nombrados al estilo del driver (${d.mysql ? '?' : '$n'}), con sus argumentos en orden: el
// bindNamed de keel-core, en tiempo de ejecución. Una lista ([]any) se expande en tantos marcadores como elementos (el
// expandList de keel-core: la lista de ids del reclamo tiene largo variable).
func timerSQL(statement string, values map[string]any) (string, []any, error) {
	var (
		args    []any
		missing string
	)
	query := timerMarker.ReplaceAllStringFunc(statement, func(match string) string {
		groups := timerMarker.FindStringSubmatch(match)
		value, ok := values[groups[2]]
		if !ok {
			missing = groups[2]
			return match
		}
		list, isList := value.([]any)
		if !isList {
			list = []any{value}
		}
		marks := make([]string, len(list))
		for i, item := range list {
			args = append(args, item)
			marks[i] = ${d.mysql ? '"?"' : '"$" + strconv.Itoa(len(args))'}
		}
		return groups[1] + strings.Join(marks, ", ")
	})
	if missing != "" {
		return "", nil, fmt.Errorf("la sentencia del cronómetro pide :%s y no se le dio", missing)
	}
	return query, args, nil
}

// timerExec ejecuta una sentencia del cronómetro y devuelve las filas que tocó.
func timerExec(ctx context.Context, q DBTX, statement string, values map[string]any) (int64, error) {
	query, args, err := timerSQL(statement, values)
	if err != nil {
		return 0, err
	}
	result, err := q.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// armTimer arma un plazo (o lo rearma si ya existía) en la transacción q, la del Save que lleva la entidad a su estado: si
// revierte, no queda. Tras el commit despierta al sondeador de esta réplica.
func (t *Transactions) armTimer(ctx context.Context, q DBTX, kind string, entityID uuid.UUID, dueAt time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	if _, err := timerExec(ctx, q, timerArm, map[string]any{"id": id, "kind": kind, "entityId": entityID, "spec": nil, "dueAt": dueAt.UTC()}); err != nil {
		return fmt.Errorf("armar el temporizador %s: %w", kind, err)
	}
	t.afterCommit(ctx, func(context.Context) {
		if t.timerArmed != nil {
			t.timerArmed(dueAt)
		}
	})
	return nil
}

// OnTimerArmed hace que armed se llame tras confirmar la transacción que arma un temporizador: el despertar del sondeador
// de esta réplica. Se fija en el arranque, antes de servir nada.
func (t *Transactions) OnTimerArmed(armed func(time.Time)) {
	t.timerArmed = armed
}

// TimerStore es el cronómetro sobre ${d.label}: implementa timer.Store con las sentencias de keel-core.
type TimerStore struct {
	tx *Transactions
}

var _ timer.Store = (*TimerStore)(nil)

// NewTimerStore construye el cronómetro sobre las transacciones del servicio.
func NewTimerStore(tx *Transactions) *TimerStore {
	return &TimerStore{tx: tx}
}

// DBNow implementa timer.Store: en la transacción abierta si la hay.
func (s *TimerStore) DBNow(ctx context.Context) (time.Time, error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return time.Time{}, err
	}
	var now time.Time
	if err := q.QueryRowContext(ctx, timerDBNow).Scan(&now); err != nil {
		return time.Time{}, err
	}
	return now.UTC(), nil
}

// EnsureRecurring implementa timer.Store.
func (s *TimerStore) EnsureRecurring(ctx context.Context, kind, spec string, dueAt time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	return s.tx.write(ctx, func(q DBTX) error {
		_, err := timerExec(ctx, q, timerEnsureRecurring, map[string]any{"id": id, "kind": kind, "entityId": uuid.Nil, "spec": spec, "dueAt": dueAt.UTC()})
		return err
	})
}

// Claim implementa timer.Store: tres sentencias en UNA transacción PROPIA (SKIP LOCKED, el arriendo con la valla y la
// lectura por la valla), que confirma antes de volver.
func (s *TimerStore) Claim(ctx context.Context, kinds []string, limit int, lease time.Duration, token uuid.UUID) ([]timer.Claimed, error) {
	var claimed []timer.Claimed
	err := s.tx.fresh(ctx, ${claimOptions}, func(ctx context.Context, q DBTX) error {
		claimed = nil
		query, args, err := timerSQL(timerClaimLock, map[string]any{"kinds": anyOf(kinds), "limit": limit})
		if err != nil {
			return err
		}
		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		var ids []any
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return errors.Join(err, rows.Close())
			}
			ids = append(ids, id)
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		if _, err := timerExec(ctx, q, timerClaimMark, map[string]any{"leaseMs": lease.Milliseconds(), "token": token, "ids": ids}); err != nil {
			return err
		}
		if query, args, err = timerSQL(timerClaimed, map[string]any{"token": token}); err != nil {
			return err
		}
		if rows, err = q.QueryContext(ctx, query, args...); err != nil {
			return err
		}
		for rows.Next() {
			var (
				one          timer.Claimed
				id           uuid.UUID
				spec         sql.NullString
				claimedUntil sql.NullTime
				claimToken   uuid.NullUUID
				parkedAt     sql.NullTime
			)
			if err := rows.Scan(&id, &one.Kind, &one.EntityID, &spec, &one.DueAt, &claimedUntil, &claimToken, &one.Attempts, &parkedAt); err != nil {
				return errors.Join(err, rows.Close())
			}
			one.ID = id.String()
			one.DueAt = one.DueAt.UTC()
			claimed = append(claimed, one)
		}
		return errors.Join(rows.Err(), rows.Close())
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}

// Resolve implementa timer.Store: fn y el desenlace en UNA transacción propia, en la que se une el caso de uso que fn
// despache (su Save, su outbox).
func (s *TimerStore) Resolve(ctx context.Context, claimed timer.Claimed, token uuid.UUID, fn func(ctx context.Context) (timer.Outcome, error)) error {
	id, err := uuid.Parse(claimed.ID)
	if err != nil {
		return err
	}
	return s.tx.fresh(ctx, sql.TxOptions{}, func(ctx context.Context, q DBTX) error {
		outcome, err := fn(ctx)
		if err != nil {
			return err
		}
		if outcome.Done {
			_, err = timerExec(ctx, q, timerComplete, map[string]any{"id": id, "token": token})
			return err
		}
		_, err = timerExec(ctx, q, timerReschedule, map[string]any{"dueAt": outcome.DueAt.UTC(), "id": id, "token": token})
		return err
	})
}

// Reschedule implementa timer.Store: el rearme de un recurrente tras su tick, sin la transacción del tick.
func (s *TimerStore) Reschedule(ctx context.Context, id string, token uuid.UUID, dueAt time.Time) error {
	timerID, err := uuid.Parse(id)
	if err != nil {
		return err
	}
	return s.tx.write(ctx, func(q DBTX) error {
		_, err := timerExec(ctx, q, timerReschedule, map[string]any{"dueAt": dueAt.UTC(), "id": timerID, "token": token})
		return err
	})
}

// Fail implementa timer.Store.
func (s *TimerStore) Fail(ctx context.Context, id string, token uuid.UUID, maxAttempts int, retryDelay time.Duration) error {
	timerID, err := uuid.Parse(id)
	if err != nil {
		return err
	}
	return s.tx.write(ctx, func(q DBTX) error {
		_, err := timerExec(ctx, q, timerFail, map[string]any{"maxAttempts": maxAttempts, "retryDelayMs": retryDelay.Milliseconds(), "id": timerID, "token": token})
		return err
	})
}

// NextDue implementa timer.Store.
func (s *TimerStore) NextDue(ctx context.Context, kinds []string) (time.Duration, bool, error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return 0, false, err
	}
	query, args, err := timerSQL(timerNextDueMs, map[string]any{"kinds": anyOf(kinds)})
	if err != nil {
		return 0, false, err
	}
	var ms sql.NullInt64
	if err := q.QueryRowContext(ctx, query, args...).Scan(&ms); err != nil {
		return 0, false, err
	}
	return time.Duration(ms.Int64) * time.Millisecond, ms.Valid, nil
}

// ParkedCount implementa timer.Store.
func (s *TimerStore) ParkedCount(ctx context.Context) (int64, error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return 0, err
	}
	var count int64
	err = q.QueryRowContext(ctx, timerParkedCount).Scan(&count)
	return count, err
}

// Purge implementa timer.Store.
func (s *TimerStore) Purge(ctx context.Context, retentionDays int) (int64, error) {
	var purged int64
	err := s.tx.write(ctx, func(q DBTX) error {
		var err error
		purged, err = timerExec(ctx, q, timerPurge, map[string]any{"retentionDays": retentionDays})
		return err
	})
	return purged, err
}

// anyOf es una lista de textos como lista de argumentos.
func anyOf(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}
`;
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────

function documentStoreBody() {
  const collection = KEEL_TIMER_DOCUMENT.collection;
  return `
// timerCollection es la colección del cronómetro: un documento por (kind, entity_id) con el _id aplanado (kind|entity_id),
// las mismas claves que las columnas de ${KEEL_TIMER.table} y el índice de due_at (keel-core, KEEL_TIMER_DOCUMENT). entity_id y
// claim_token van como TEXTO: son contrato con los otros generadores, y el texto no depende de la representación de uuid
// de cada driver.
const timerCollection = ${goString(collection)}

// timerID es el _id de un temporizador.
func timerID(kind, entityID string) string {
	return kind + "|" + entityID
}

// armTimer arma un plazo (o lo rearma si ya existía) en la sesión de ctx, la de la transacción del Save que lleva la
// entidad a su estado: si aborta, no queda. Tras el commit despierta al sondeador de esta réplica.
func (t *Transactions) armTimer(ctx context.Context, kind string, entityID uuid.UUID, dueAt time.Time) error {
	timers, err := t.collection(timerCollection)
	if err != nil {
		return err
	}
	set := bson.D{
		{Key: "kind", Value: kind},
		{Key: "entity_id", Value: entityID.String()},
		{Key: "spec", Value: nil},
		{Key: "due_at", Value: bson.NewDateTimeFromTime(dueAt)},
		{Key: "claimed_until", Value: nil},
		{Key: "claim_token", Value: nil},
		{Key: "attempts", Value: int32(0)},
		{Key: "parked_at", Value: nil},
	}
	if _, err := timers.UpdateOne(ctx, bson.D{{Key: "_id", Value: timerID(kind, entityID.String())}}, bson.D{{Key: "$set", Value: set}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return fmt.Errorf("armar el temporizador %s: %w", kind, err)
	}
	t.afterCommit(ctx, func(context.Context) {
		if t.timerArmed != nil {
			t.timerArmed(dueAt)
		}
	})
	return nil
}

// OnTimerArmed hace que armed se llame tras confirmar la transacción que arma un temporizador: el despertar del sondeador
// de esta réplica. Se fija en el arranque, antes de servir nada.
func (t *Transactions) OnTimerArmed(armed func(time.Time)) {
	t.timerArmed = armed
}

// TimerStore es el cronómetro sobre MongoDB: implementa timer.Store con la forma documental de keel-core. No hay SKIP
// LOCKED: el reclamo es FindOneAndUpdate de uno en uno sobre el mismo filtro, atómico por documento. La hora es $$NOW, la
// del servidor (T1).
type TimerStore struct {
	tx *Transactions
}

var _ timer.Store = (*TimerStore)(nil)

// NewTimerStore construye el cronómetro sobre las transacciones del servicio.
func NewTimerStore(tx *Transactions) *TimerStore {
	return &TimerStore{tx: tx}
}

// timers es la colección, o errDisabled en un perfil sin base.
func (s *TimerStore) timers() (*mongodriver.Collection, error) {
	return s.tx.collection(timerCollection)
}

// DBNow implementa timer.Store: $$NOW evaluado por el servidor, sobre la base SIN la sesión de la transacción en curso
// (la pide también quien está dentro de una): un comando como hello no se admite en una transacción (error 263, medido en
// keel-spring).
func (s *TimerStore) DBNow(ctx context.Context) (time.Time, error) {
	if s.tx.db == nil {
		return time.Time{}, errDisabled
	}
	cursor, err := s.tx.db.database.Aggregate(outside(ctx), bson.A{bson.D{{Key: "$documents", Value: bson.A{bson.D{{Key: "now", Value: "$$NOW"}}}}}})
	if err != nil {
		return time.Time{}, err
	}
	defer cursor.Close(ctx)
	if !cursor.Next(ctx) {
		return time.Time{}, errors.Join(errors.New("la base no devolvió su hora"), cursor.Err())
	}
	now, ok := cursor.Current.Lookup("now").DateTimeOK()
	if !ok {
		return time.Time{}, errors.New("la hora de la base no es una fecha")
	}
	return time.UnixMilli(now).UTC(), nil
}

// EnsureRecurring implementa timer.Store: un update con pipeline que, si la fila ya está y su spec no cambió, no toca su
// vencimiento (R1).
func (s *TimerStore) EnsureRecurring(ctx context.Context, kind, spec string, dueAt time.Time) error {
	timers, err := s.timers()
	if err != nil {
		return err
	}
	set := bson.D{
		{Key: "kind", Value: kind},
		{Key: "entity_id", Value: timer.NilEntityID},
		{Key: "due_at", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$spec", spec}}}, "$due_at", bson.NewDateTimeFromTime(dueAt)}}}},
		{Key: "spec", Value: spec},
		{Key: "claimed_until", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$claimed_until", nil}}}},
		{Key: "claim_token", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$claim_token", nil}}}},
		{Key: "attempts", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$attempts", int32(0)}}}},
		{Key: "parked_at", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$parked_at", nil}}}},
	}
	_, err = timers.UpdateOne(outside(ctx), bson.D{{Key: "_id", Value: timerID(kind, timer.NilEntityID)}}, bson.A{bson.D{{Key: "$set", Value: set}}}, options.UpdateOne().SetUpsert(true))
	return err
}

// Claim implementa timer.Store: FindOneAndUpdate de uno en uno, fuera de toda transacción, con $$NOW y el arriendo.
func (s *TimerStore) Claim(ctx context.Context, kinds []string, limit int, lease time.Duration, token uuid.UUID) ([]timer.Claimed, error) {
	timers, err := s.timers()
	if err != nil {
		return nil, err
	}
	filter := bson.D{
		{Key: "kind", Value: bson.D{{Key: "$in", Value: kinds}}},
		{Key: "parked_at", Value: nil},
		{Key: "$expr", Value: bson.D{{Key: "$and", Value: bson.A{
			bson.D{{Key: "$lte", Value: bson.A{"$due_at", "$$NOW"}}},
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$claimed_until", nil}}},
				bson.D{{Key: "$lt", Value: bson.A{"$claimed_until", "$$NOW"}}},
			}}},
		}}}},
	}
	update := bson.A{bson.D{{Key: "$set", Value: bson.D{
		{Key: "claimed_until", Value: bson.D{{Key: "$add", Value: bson.A{"$$NOW", lease.Milliseconds()}}}},
		{Key: "claim_token", Value: token.String()},
	}}}}
	opts := options.FindOneAndUpdate().SetSort(bson.D{{Key: "due_at", Value: 1}}).SetReturnDocument(options.After)
	var claimed []timer.Claimed
	for len(claimed) < limit {
		found, err := timers.FindOneAndUpdate(outside(ctx), filter, update, opts).Raw()
		if errors.Is(err, mongodriver.ErrNoDocuments) {
			break
		}
		if err != nil {
			return nil, err
		}
		one, err := decodeTimer(found)
		if err != nil {
			return nil, err
		}
		claimed = append(claimed, one)
	}
	return claimed, nil
}

// decodeTimer lee un temporizador reclamado.
func decodeTimer(doc bson.Raw) (timer.Claimed, error) {
	var one timer.Claimed
	var ok bool
	if one.ID, ok = doc.Lookup("_id").StringValueOK(); !ok {
		return one, errors.New("keel_timer: _id no es texto")
	}
	if one.Kind, ok = doc.Lookup("kind").StringValueOK(); !ok {
		return one, fmt.Errorf("keel_timer %s: kind no es texto", one.ID)
	}
	entityID, ok := doc.Lookup("entity_id").StringValueOK()
	if !ok {
		return one, fmt.Errorf("keel_timer %s: entity_id no es texto", one.ID)
	}
	parsed, err := uuid.Parse(entityID)
	if err != nil {
		return one, fmt.Errorf("keel_timer %s: %w", one.ID, err)
	}
	one.EntityID = parsed
	due, ok := doc.Lookup("due_at").DateTimeOK()
	if !ok {
		return one, fmt.Errorf("keel_timer %s: due_at no es una fecha", one.ID)
	}
	one.DueAt = time.UnixMilli(due).UTC()
	if attempts, ok := doc.Lookup("attempts").AsInt64OK(); ok {
		one.Attempts = int(attempts)
	}
	return one, nil
}

// fenced es el filtro de un temporizador que sigue siendo de quien lo reclamó.
func fenced(id string, token uuid.UUID) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "claim_token", Value: token.String()}}
}

// Resolve implementa timer.Store: fn y el desenlace en UNA transacción propia, en la que se une el caso de uso que fn
// despache.
func (s *TimerStore) Resolve(ctx context.Context, claimed timer.Claimed, token uuid.UUID, fn func(ctx context.Context) (timer.Outcome, error)) error {
	return s.tx.write(outside(ctx), func(ctx context.Context) error {
		outcome, err := fn(ctx)
		if err != nil {
			return err
		}
		timers, err := s.timers()
		if err != nil {
			return err
		}
		if outcome.Done {
			_, err = timers.DeleteOne(ctx, fenced(claimed.ID, token))
			return err
		}
		_, err = timers.UpdateOne(ctx, fenced(claimed.ID, token), bson.D{{Key: "$set", Value: bson.D{
			{Key: "due_at", Value: bson.NewDateTimeFromTime(outcome.DueAt)},
			{Key: "claimed_until", Value: nil},
			{Key: "claim_token", Value: nil},
			{Key: "attempts", Value: int32(0)},
		}}})
		return err
	})
}

// Reschedule implementa timer.Store: el rearme de un recurrente tras su tick, fuera de toda sesión.
func (s *TimerStore) Reschedule(ctx context.Context, id string, token uuid.UUID, dueAt time.Time) error {
	timers, err := s.timers()
	if err != nil {
		return err
	}
	_, err = timers.UpdateOne(outside(ctx), fenced(id, token), bson.D{{Key: "$set", Value: bson.D{
		{Key: "due_at", Value: bson.NewDateTimeFromTime(dueAt)},
		{Key: "claimed_until", Value: nil},
		{Key: "claim_token", Value: nil},
		{Key: "attempts", Value: int32(0)},
	}}})
	return err
}

// Fail implementa timer.Store: parked_at se calcula con los intentos de ANTES, como la sentencia relacional.
func (s *TimerStore) Fail(ctx context.Context, id string, token uuid.UUID, maxAttempts int, retryDelay time.Duration) error {
	timers, err := s.timers()
	if err != nil {
		return err
	}
	set := bson.D{
		{Key: "parked_at", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$gte", Value: bson.A{bson.D{{Key: "$add", Value: bson.A{"$attempts", 1}}}, maxAttempts}}}, "$$NOW", nil}}}},
		{Key: "attempts", Value: bson.D{{Key: "$add", Value: bson.A{"$attempts", 1}}}},
		{Key: "due_at", Value: bson.D{{Key: "$add", Value: bson.A{"$$NOW", retryDelay.Milliseconds()}}}},
		{Key: "claimed_until", Value: nil},
		{Key: "claim_token", Value: nil},
	}
	_, err = timers.UpdateOne(outside(ctx), fenced(id, token), bson.A{bson.D{{Key: "$set", Value: set}}})
	return err
}

// NextDue implementa timer.Store: un temporizador arrendado cuenta desde que vence su arriendo.
func (s *TimerStore) NextDue(ctx context.Context, kinds []string) (time.Duration, bool, error) {
	timers, err := s.timers()
	if err != nil {
		return 0, false, err
	}
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "kind", Value: bson.D{{Key: "$in", Value: kinds}}}, {Key: "parked_at", Value: nil}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "next", Value: bson.D{{Key: "$min", Value: bson.D{{Key: "$cond", Value: bson.A{
			bson.D{{Key: "$gt", Value: bson.A{"$claimed_until", "$due_at"}}}, "$claimed_until", "$due_at",
		}}}}}}}}},
		bson.D{{Key: "$project", Value: bson.D{{Key: "ms", Value: bson.D{{Key: "$subtract", Value: bson.A{"$next", "$$NOW"}}}}}}},
	}
	cursor, err := timers.Aggregate(outside(ctx), pipeline)
	if err != nil {
		return 0, false, err
	}
	defer cursor.Close(ctx)
	if !cursor.Next(ctx) {
		return 0, false, cursor.Err()
	}
	ms, ok := cursor.Current.Lookup("ms").AsInt64OK()
	if !ok {
		return 0, false, nil
	}
	return time.Duration(ms) * time.Millisecond, true, nil
}

// ParkedCount implementa timer.Store.
func (s *TimerStore) ParkedCount(ctx context.Context) (int64, error) {
	timers, err := s.timers()
	if err != nil {
		return 0, err
	}
	return timers.CountDocuments(outside(ctx), bson.D{{Key: "parked_at", Value: bson.D{{Key: "$ne", Value: nil}}}})
}

// Purge implementa timer.Store: vencido hace más de la retención y sin reclamar.
func (s *TimerStore) Purge(ctx context.Context, retentionDays int) (int64, error) {
	timers, err := s.timers()
	if err != nil {
		return 0, err
	}
	filter := bson.D{
		{Key: "claim_token", Value: nil},
		{Key: "$expr", Value: bson.D{{Key: "$lt", Value: bson.A{"$due_at", bson.D{{Key: "$subtract", Value: bson.A{"$$NOW", int64(retentionDays) * 86_400_000}}}}}}},
	}
	result, err := timers.DeleteMany(ctx, filter)
	if err != nil {
		return 0, err
	}
	return result.DeletedCount, nil
}
`;
}

// ─── El arranque ─────────────────────────────────────────────────────────────────────────────────

/** Los plazos vigentes, antes de los repositorios (que arman con ellos). */
export function deadlinesWiring(model, parametersVar) {
  return `	${DEADLINES_VAR}, err := domain.New${deadlinesType(model)}(${deadlinesReadParameters(model) ? parametersVar : ''})
	if err != nil {
		return fmt.Errorf("plazos de negocio: %w", err)
	}
`;
}

/**
 * El cronómetro en el arranque, tras los casos de uso: su configuración, el almacén, la purga de la tabla, un handler por
 * plazo (que despacha por los casos de uso) y el despertar al armar. Sin base (el perfil test), no sondea.
 */
export function timerWiring(model, store, repositoryCall) {
  const handlers = modelDeadlines(model).map(
    ({ entity, deadline }) => `		timer.New${deadlineHandlerType(entity, deadline)}(${repositoryCall(entity)}, useCases.${useCaseField(byOperation(model, deadline))}, ${DEADLINES_VAR}),`
  );
  // Las purgas de las tablas del generador (inc. 7): la tarea de siempre (scheduler.PurgeTask, con su SQL y sus lotes), que
  // ya no va al reloj de cada réplica sino al cronómetro, en modo clúster.
  const purges = timerPurges(model).map((purge) => {
    const entry = tablePurges(model).find((candidate) => candidate.table === purge.table);
    if (!entry) throw new Error(`timer.js: ${purge.table} se purga con el cronómetro y la purga del reloj no la tiene`);
    const variable = `purge${pascalCase(purge.table)}`;
    return {
      variable,
      code: `	${variable}, err := timer.NewRecurring(timer.${purgeKindConstant(purge.table)}, purges.${entry.field}.Cron, scheduler.PurgeTask(${JSON.stringify(entry.what)}, purges.${entry.field}, ${store.name}.${entry.constructor}(transactions), logger).Run)
	if err != nil {
		return fmt.Errorf("la purga de ${purge.table}: %w", err)
	}
`
    };
  });
  const recurrings = ['timerPurge', ...purges.map((purge) => purge.variable)];
  return `	timerSettings, err := timer.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración del cronómetro: %w", err)
	}
	// Sin base no hay tabla que sondear: el perfil test la apaga además con scheduling.enabled.
	timerSettings.Enabled = timerSettings.Enabled && database.Enabled
	timerStore := ${store.name}.NewTimerStore(transactions)
	timerPurge, err := timer.NewTimerPurge(timerStore, timerSettings)
	if err != nil {
		return fmt.Errorf("la purga del cronómetro: %w", err)
	}
${purges.map((purge) => purge.code).join('')}	poller, err := timer.NewPoller(timerStore, ${handlers.length > 0 ? `[]timer.Handler{\n${handlers.join('\n')}\n\t}` : 'nil'}, []timer.Recurring{${recurrings.join(', ')}}, timerSettings, logger)
	if err != nil {
		return err
	}
	// Un temporizador armado en esta réplica despierta a su sondeador tras el commit.
	transactions.OnTimerArmed(poller.Armed)
`;
}

/** El sondeador en el errgroup: al cancelarse el contexto termina la pasada en vuelo y vuelve, antes de cerrar la base. */
export const TIMER_WORKER = `
	group.Go(func() error {
		return poller.Run(groupCtx)
	})`;

// ─── El arnés ────────────────────────────────────────────────────────────────────────────────────

/**
 * `AgeForDeadline(entity, id, seconds)` en el arnés relacional (D7 de PLAN-DSL-226-PLAZOS.md): retrasa el `since` de la
 * entidad Y el vencimiento de su temporizador los mismos segundos, para que el rechazo tardío del dominio (que lee
 * `since`) y el cronómetro (que lee `due_at`) vean el mismo plazo vencido. La sentencia del temporizador es la de keel-core
 * (`timerStatements(engine).age`). Usa `Db` e `idLiteral`. Sin los literales del motor no se emite.
 */
export function relationalDeadlineAgingMembers(model) {
  if (!usesDeadlines(model) || !usesRelational(model)) return [];
  const engine = relationalEngine(model);
  const entry = DATABASES[engine];
  if (!TIMER_ENGINES.includes(engine) || !entry?.uuidLiteral) return [];
  const age = timerStatements(engine).age;
  const shift = (column) => (engine === 'mysql' ? `DATE_SUB(${column}, INTERVAL %d SECOND)` : `${column} - make_interval(secs => %d)`);
  const rows = modelDeadlines(model).map(({ entity, deadline, kind }) => {
    const since = entity.fields.find((candidate) => candidate.name === deadline.since)?.columns?.name ?? snakeCase(deadline.since);
    const idColumn = entity.idField?.columns?.name ?? 'id';
    const timerSql = age.replace(':ageMs', '%d').replace(':kind', `'${kind}'`).replace(':entityId', '%s');
    return { indent: '\t', cells: [`${goString(entity.name)}:`, `{${goString(`UPDATE ${entity.tableName} SET ${since} = ${shift(since)} WHERE ${idColumn} = %s`)}, ${goString(timerSql)}},`] };
  });
  return [deadlineAgingDoc(model, 'Db') + String.raw`
var deadlineAging = map[string][2]string{
${alignRows(rows).join('\n')}
}

func (s *Scenario) AgeForDeadline(entity, id string, seconds int64) {
	s.Helper()
	statements, ok := deadlineAging[entity]
	if !ok {
		s.Fatalf("no hay plazo para la entidad %q. Las que lo tienen: ${knownEntities(model)}", entity)
	}
	s.Db(fmt.Sprintf(statements[0], seconds, idLiteral(id)))
	s.Db(fmt.Sprintf(statements[1], seconds*1000, idLiteral(id)))
}`];
}

/** `AgeForDeadline` sobre documentos, con el script de keel-core (`ageDeadlineScript`). */
export function documentDeadlineAgingMembers(model) {
  if (!usesDeadlines(model) || usesRelational(model)) return [];
  const rows = modelDeadlines(model).map(({ entity, deadline, kind }) => {
    const since = snakeCase(deadline.since);
    return { indent: '\t', cells: [`${goString(entity.name)}:`, `${goString(ageDeadlineScript({ collection: entity.collectionName, sinceField: since, kind }))},`] };
  });
  return [deadlineAgingDoc(model, 'MongoEval') + String.raw`
var deadlineAging = map[string]string{
${alignRows(rows).join('\n')}
}

func (s *Scenario) AgeForDeadline(entity, id string, seconds int64) {
	s.Helper()
	script, ok := deadlineAging[entity]
	if !ok {
		s.Fatalf("no hay plazo para la entidad %q. Las que lo tienen: ${knownEntities(model)}", entity)
	}
	s.MongoEval(strings.NewReplacer("{id}", s.documentID(id), "{ms}", strconv.FormatInt(seconds*1000, 10)).Replace(script))
}`];
}

function knownEntities(model) {
  return [...new Set(modelDeadlines(model).map(({ entity }) => entity.name))].join(', ');
}

function deadlineAgingDoc(model, via) {
  const example = modelDeadlines(model)[0];
  return `// deadlineAging son las sentencias que envejecen el plazo de cada entidad que lo tiene: ${knownEntities(model)}.
//
// AgeForDeadline envejece el plazo de la entidad id: retrasa su ${example.deadline.since} y el vencimiento de su temporizador seconds
// segundos (por ${via}), de modo que el plazo venza ya sin esperarlo. No dispara la caducidad: la dispara el cronómetro en su
// próxima pasada (como mucho el sueño máximo, timer.max-sleep-ms), como en producción. Y el rechazo tardío del dominio lo
// ve en el acto, porque lee ${example.deadline.since}: un verbo tardío tras esta llamada ya debe salir con su error.
//
//	s.AgeForDeadline(${goString(example.entity.name)}, id, 3600)
//	s.Eventually(func() bool { … }, 45*time.Second, "el cronómetro no caducó la entidad")`;
}

// ─── La nota de los handlers ─────────────────────────────────────────────────────────────────────

/** Las notas neutrales de una operación (la `by` y la que sale del estado), con lo que en Go se le pasa al dominio. */
export function deadlineNotes(model, operation) {
  if (!usesDeadlines(model)) return [];
  const notes = [];
  const expiring = deadlineHandlerNote(model, operation);
  if (expiring) notes.push(expiring);
  const late = lateTransitionNote(model, operation);
  if (late) notes.push(`${late} En Go: h.${CLOCK.param}() y h.${DEADLINES.param}, que el método semántico pasa a transitionAt.`);
  return notes;
}
