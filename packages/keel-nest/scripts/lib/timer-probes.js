// La sonda del cronómetro y de los plazos (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 4): el bloque que db-check
// (relacional) y doc-check (documental) meten en su sonda sobre el par verification-codes. El gemelo de
// keel-spring/src/lib/timer-probes.js: los mismos casos, con los mismos ids (keel-core/gen/deadlines.js, DEADLINE_CASES),
// y los mismos sabotajes, cada uno en exactamente sus casos.
//
// Ejecuta lo que build emitió —el rechazo tardío del dominio, el armado del adaptador, el almacén con las sentencias de
// keel-core, el sondeador y el handler del plazo— y no una copia: los nombres (entidad, estados, campo `since`, propiedad
// del plazo, `kind`) salen del MODELO. Lo que escribiría el agente —el método semántico de la entidad y el handler de la
// operación `by`— lo pone la sonda: un método público de prueba en la entidad (`timerProbePatch`) y un mediator de prueba
// que hace lo que haría el handler de `by` (cargar, transicionar, guardar), salvo para el id del caso del aparcado.
//
// La sonda declara `check`, `tx`, `randomUUID`, `stateOf` y, según la rama, `dataSource`/`settings` o
// `client`/`database`/`settings`.

import { modelDeadlines, lateGuards, DEADLINE_CASES, DEADLINE_SABOTAGES } from '@keel-system/keel-core/gen/deadlines';
import { timerStatements, bindNamed, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { classPath, DIRS } from '../../src/scaffold/render.js';
import { adapterClass, adapterPath } from '../../src/scaffold/repositories.js';
import { usesDocument, engineOf } from '../../src/scaffold/persistence-entities.js';
import {
  deadlinesClass,
  deadlinesPath,
  deadlineComponent,
  deadlineHandlerClass,
  deadlineHandlerPath,
  kindConstant,
  MONGO_TIMER_STORE_TS,
  SQL_TIMER_STORE_TS,
  TIMER_KINDS_TS,
  TIMER_POLLER_TS,
  TIMER_PURGE_TS,
  TIMER_STORE_TS
} from '../../src/scaffold/timer.js';
import { sampleEntity } from './samples.js';

const distOf = (file) => `./${file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')}`;

/** Los sujetos del par, por rama. */
export const TIMER_SUBJECTS = Object.freeze({ relational: 'verification-codes', document: 'verification-codes-mongo' });

/** El sujeto: el primer plazo con rechazo tardío del diseño, con todo lo que la sonda nombra. */
export function timerSubject(model) {
  const entry = modelDeadlines(model).find(({ entity }) => lateGuards(entity).length > 0) ?? modelDeadlines(model)[0];
  if (!entry) return null;
  const { entity, deadline, kind } = entry;
  const guard = lateGuards(entity).find((candidate) => candidate.from === deadline.state) ?? null;
  const error = guard ? (model.errors ?? []).find((candidate) => candidate.code === guard.error) : null;
  // El destino de una transición tardía: otro que el de la caducidad, saliendo del estado del plazo.
  const lateTarget = entity.lifecycle.transitions.find((transition) => transition.from === deadline.state)?.to.find((state) => state !== deadline.to) ?? null;
  return { entity, deadline, kind, guard, error, lateTarget, enumType: entity.lifecycle.enumType, statusField: entity.lifecycle.field };
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────
//
// Rompen lo emitido EN MEMORIA conservando la forma (sigue compilando): [sufijo del archivo, texto o expresión,
// sustituto], por rama. `breaks` son los casos que TIENEN que caer, y solo esos (los ids de keel-core). dl-wrong-field y
// dl-app-clock no tienen sujeto aquí: la fixture solo tiene una marca de tiempo, y la red corre con la instancia y la
// base en la misma máquina.

const GUARD = /if \((this\.#\w+\.getTime\(\) \+ deadlines\.\w+) <= now\.getTime\(\)\) \{/;
const ENTITY_FILE = '/domain/aggregate/verification-code.ts';
const HANDLER_FILE = '-pending-deadline.ts';
const REVALIDATION = /if \(found == null \|\| found\.\w+ !== \w+\.\w+\) return TimerOutcome\.finished\(\);\n(\s*const due = [^\n]*\n)\s*if \(due\.getTime\(\) > dbNow\.getTime\(\)\) return TimerOutcome\.rescheduleAt\(due\);\n/;

export const TIMER_SABOTAGES = Object.freeze({
  'dl-boundary': {
    relational: [ENTITY_FILE, GUARD, 'if ($1 < now.getTime()) {'],
    document: [ENTITY_FILE, GUARD, 'if ($1 < now.getTime()) {'],
    breaks: DEADLINE_SABOTAGES['dl-boundary'].breaks
  },
  'dl-no-guard': {
    relational: [ENTITY_FILE, GUARD, 'if (false) {'],
    document: [ENTITY_FILE, GUARD, 'if (false) {'],
    breaks: DEADLINE_SABOTAGES['dl-no-guard'].breaks
  },
  'dl-no-revalidate': {
    relational: [HANDLER_FILE, REVALIDATION, 'if (found == null) return TimerOutcome.finished();\n$1'],
    document: [HANDLER_FILE, REVALIDATION, 'if (found == null) return TimerOutcome.finished();\n$1'],
    breaks: DEADLINE_SABOTAGES['dl-no-revalidate'].breaks
  },
  'dl-no-lease': {
    relational: ['sql-timer-store.ts', 'SQL.claimMark, { leaseMs, ', 'SQL.claimMark, { leaseMs: 0, '],
    // Sin arriendo, el bucle de findOneAndUpdate vuelve a llevarse en el MISMO lote lo que acaba de reclamar: cae
    // además DL-5 (en relacional el lote es una sola sentencia y no lo ve). Lo mismo que midió keel-spring.
    document: ['mongo-timer-store.ts', "$add: ['$$NOW', leaseMs]", "$add: ['$$NOW', 0]"],
    breaks: DEADLINE_SABOTAGES['dl-no-lease'].breaks,
    documentBreaks: ['DL-5', ...DEADLINE_SABOTAGES['dl-no-lease'].breaks]
  },
  'dl-outside-tx': {
    // El armado en una transacción NUEVA, fuera de la del caso de uso.
    relational: ['sql-timer-store.ts', /await this\.exec\(SQL\.arm, (\{[^\n]*\})\);/, 'await this.transactions.inNewTransaction((manager) => this.run(manager, SQL.arm, $1));'],
    // El armado sin la sesión: escribe fuera de la transacción del caso de uso (en keel-spring no tenía sujeto).
    document: ['mongo-timer-store.ts', '{ upsert: true, session: this.transactions.session() }', '{ upsert: true }'],
    breaks: DEADLINE_SABOTAGES['dl-outside-tx'].breaks
  }
});

export const isTimerSabotage = (id) => Boolean(id && TIMER_SABOTAGES[id]);

/** El sabotaje de una rama: [sufijo, de, a], o null si no tiene sujeto en ella. */
export function timerSabotage(id, branch) {
  return TIMER_SABOTAGES[id]?.[branch] ?? null;
}

/** Los casos que tienen que caer con el sabotaje en esa rama. */
export function timerSabotageBreaks(id, branch) {
  const spec = TIMER_SABOTAGES[id];
  return [...((branch === 'document' && spec.documentBreaks) || spec.breaks)].sort();
}

/**
 * El veredicto de un sabotaje del cronómetro: los ids DL que cayeron (y nada más) contra los esperados. Un caso de la
 * sonda se llama `DL-n: …`; `R1: …` no lo rompe ningún sabotaje.
 */
export function timerSabotageVerdict(checks, id, branch) {
  const failedIds = [...new Set(checks.filter((check) => !check.ok).map((check) => /^(DL-\d+|R\d+):/.exec(check.name)?.[1] ?? check.name))].sort();
  const want = timerSabotageBreaks(id, branch);
  return { exact: failedIds.length === want.length && failedIds.every((name, index) => name === want[index]), failed: failedIds, want };
}

// ─── Lo que escribiría el agente ─────────────────────────────────────────────

/**
 * El método semántico de la sonda en la entidad (los de transición son privados): `probeTransition(target, now?,
 * deadlines?)`. Devuelve el contenido parcheado, o lanza si no aplica (un parche que no aplica no puede pasar por bueno).
 */
export function timerProbePatch(model, file) {
  const subject = timerSubject(model);
  if (!subject || !file.path.endsWith(`${classPath(DIRS.aggregates, subject.entity.name)}`)) return file.content;
  const anchor = `  get ${subject.entity.idField?.name ?? 'id'}(): `;
  if (!file.content.includes(anchor)) throw new Error(`timer-probes: el parche de la sonda no aplica en ${file.path}`);
  const method = `  /** Sonda del cronómetro (db-check/doc-check): el método semántico que escribiría el agente. */
  probeTransition(target: ${subject.enumType}, now?: Date, deadlines?: ${deadlinesClass(model)}): void {
    if (now === undefined || deadlines === undefined) this.transitionTo(target);
    else this.transitionTo(target, now, deadlines);
  }

`;
  const content = file.content.replace(anchor, `${method}${anchor}`);
  // El tipo de los plazos tiene que estar importado: lo está si la entidad tiene rechazo tardío.
  return subject.guard
    ? content
    : content.replace(/^/, `import type { ${deadlinesClass(model)} } from '../deadline/${deadlinesPath(model).split('/').pop().replace(/\.ts$/, '.js')}';\n`);
}

// ─── El preámbulo y el bloque ────────────────────────────────────────────────

/** Los argumentos que el adaptador de una raíz con plazos recibe al final (repositories.js, armingDependencies). */
export const TIMER_ADAPTER_ARGS = ['timerStore', 'timerDeadlines'];

/** Lo que la sonda declara ANTES de los bloques de raíz: el almacén del cronómetro y los plazos vigentes. */
export function timerPreamble(model) {
  const subject = timerSubject(model);
  if (!subject) return '';
  const document = usesDocument(model);
  const storeClass = document ? 'MongoTimerStore' : 'SqlTimerStore';
  const args = modelDeadlines(model).map(() => '10 * 60_000').join(', ');
  return `
// ── El cronómetro (DSL 2.26): el almacén emitido y la duración de los plazos con la que se mide.
const { ${storeClass} } = await import('${distOf(document ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS)}');
const { TimerArmedSignal } = await import('${distOf(TIMER_STORE_TS)}');
const { ${deadlinesClass(model)} } = await import('${distOf(deadlinesPath(model))}');
const timerSignal = new TimerArmedSignal();
const timerStore = new ${storeClass}(tx, timerSignal);
const timerDeadlines = new ${deadlinesClass(model)}(${args});
`;
}

/**
 * El bloque de los casos DL-1 a DL-10 y R1. `adapterArgs` es la lista de argumentos del adaptador de la raíz;
 * `replicaTx` la expresión de una segunda TransactionContext (otra «réplica», con su conexión).
 */
export function timerBlock(model, ctx, { adapterArgs, replicaTx }) {
  const subject = timerSubject(model);
  if (!subject) return '';
  const { entity, deadline, kind, guard, error, lateTarget, enumType, statusField } = subject;
  const document = usesDocument(model);
  const storeClass = document ? 'MongoTimerStore' : 'SqlTimerStore';
  const component = deadlineComponent(entity.name, deadline.stateName);
  const caseName = (id) => DEADLINE_CASES.find((entry) => entry.id === id)?.what ?? id;
  ctx.imports.add(`${enumType}|${classPath(DIRS.enums, enumType)}`);
  if (error) ctx.imports.add(`${error.exceptionClass}|${classPath(DIRS.errors, error.exceptionClass)}`);
  const sample = sampleEntity(model, entity, ctx, 'timer');
  const idName = entity.idField?.name ?? 'id';
  const enumOf = (constant) => `${enumType}.${constant}`;
  const support = document
    ? {
        clear: "await database.collection('keel_timer').deleteMany({});",
        count: "return database.collection('keel_timer').countDocuments({ kind });",
        fire: "await database.collection('keel_timer').updateMany({ kind }, { $set: { due_at: await timerStore.dbNow(), claimed_until: null, claim_token: null } });"
      }
    : (() => {
        const engine = engineOf(model);
        const style = engine === 'postgresql' ? 'dollar' : 'question';
        const fire = bindNamed(timerStatements(engine).fire, style).sql;
        const count = bindNamed(`SELECT count(*) AS n FROM ${KEEL_TIMER.table} WHERE kind = :kind`, style).sql;
        return {
          clear: `await dataSource.query('DELETE FROM ${KEEL_TIMER.table}');`,
          count: `return Number((await dataSource.query(${JSON.stringify(count)}, [kind]))[0].n);`,
          fire: `await dataSource.query(${JSON.stringify(fire)}, [kind]);`
        };
      })();
  const domainCases =
    guard && lateTarget
      ? `
  await dl('DL-1', ${JSON.stringify(caseName('DL-1'))}, async () => {
    const since = new Date('2026-11-07T10:00:00Z');
    const entidad = entity(${enumOf(deadline.state)}, since);
    entidad.probeTransition(${enumOf(lateTarget)}, new Date(since.getTime() + DL_MS - 1), timerDeadlines);
    check('DL-1: un milisegundo antes del vencimiento la transición tardía sale', entidad.${statusField} === ${enumOf(lateTarget)}, entidad.${statusField});
  });
  await dl('DL-2', ${JSON.stringify(caseName('DL-2'))}, async () => {
    const since = new Date('2026-11-07T10:00:00Z');
    const entidad = entity(${enumOf(deadline.state)}, since);
    let rejected = null;
    try {
      entidad.probeTransition(${enumOf(lateTarget)}, new Date(since.getTime() + DL_MS), timerDeadlines);
    } catch (thrown) {
      rejected = thrown;
    }
    check('DL-2: en el instante exacto del vencimiento la transición tardía se rechaza con ${guard.error}', ${error ? `rejected instanceof ${error.exceptionClass}` : 'rejected != null'}, rejected ?? 'salió');
    check('DL-2: una transición rechazada no mueve el estado', entidad.${statusField} === ${enumOf(deadline.state)}, entidad.${statusField});
  });
  await dl('DL-3', ${JSON.stringify(caseName('DL-3'))}, async () => {
    const since = new Date('2026-11-07T10:00:00Z');
    const entidad = entity(${enumOf(deadline.state)}, since);
    entidad.probeTransition(${enumOf(deadline.to)}, new Date(since.getTime() + DL_MS + 3_600_000), timerDeadlines);
    check('DL-3: pasado el plazo, la transición hacia el destino de la caducidad sale', entidad.${statusField} === ${enumOf(deadline.to)}, entidad.${statusField});
  });`
      : '';
  return `
// ═══ El cronómetro y los plazos (DSL 2.26): ${entity.name} en '${deadline.stateName}' ═══
{
  const { ${adapterClass(entity)}: TimerRepository } = await import('${distOf(adapterPath(entity))}');
  const { ${storeClass}: ReplicaStore } = await import('${distOf(document ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS)}');
  const { TimerPoller } = await import('${distOf(TIMER_POLLER_TS)}');
  const { KeelTimerPurge } = await import('${distOf(TIMER_PURGE_TS)}');
  const { TimerKinds } = await import('${distOf(TIMER_KINDS_TS)}');
  const { ${deadlineHandlerClass(entity.name, deadline.stateName)}: DeadlineHandler } = await import('${distOf(deadlineHandlerPath(entity.name, deadline.stateName))}');
  const KIND = TimerKinds.${kindConstant(entity.name, deadline.stateName)};
  check('el kind del plazo es el de keel-core', KIND === ${JSON.stringify(kind)}, KIND);
  const DL_MS = timerDeadlines.${component};
  const repository = new TimerRepository(${adapterArgs});
  const SAMPLE_STATE = stateOf(${sample});
  const entity = (status, since, id = randomUUID()) => new ${entity.name}({ ...SAMPLE_STATE, ${idName}: id, ${statusField}: status, ${deadline.since}: since, lockVersion: null });
  // Lo que escribiría el agente en el handler de ${deadline.by}: cargar, transicionar y guardar; el id de failId lanza.
  let failId = null;
  const mediator = {
    dispatch: (command) =>
      tx.inTransaction(async () => {
        if (command.${idName} === failId) throw new Error('fallo de prueba del cronómetro');
        const found = await repository.findById(command.${idName});
        found.probeTransition(${enumOf(deadline.to)});
        await repository.save(found);
      })
  };
  const deadlineHandler = new DeadlineHandler(repository, mediator, timerDeadlines);
  const timerSettings = (maxAttempts) => ({ enabled: true, maxSleepMs: 30_000, batchSize: 50, leaseMs: 60_000, maxAttempts, retryDelayMs: 0, retentionDays: 7, purgeCron: '0 30 5 * * *' });
  const purgeHandler = new KeelTimerPurge(timerStore, timerSettings(10));
  const poller = (maxAttempts = 10) => new TimerPoller(timerStore, [deadlineHandler, purgeHandler], timerSettings(maxAttempts), tx, timerSignal);
  const clear = async () => {
    ${support.clear}
  };
  const timers = async (kind) => {
    ${support.count}
  };
  const fire = async (kind) => {
    ${support.fire}
  };
  /** Guarda la entidad por el adaptador, en una transacción: es lo que arma el temporizador. */
  const save = async (status, since) => {
    const id = randomUUID();
    await tx.inTransaction(() => repository.save(entity(status, since, id)));
    return id;
  };
  /** Una entidad cuyo plazo venció hace \`agoMs\` (con la hora de la base). */
  const expired = async (agoMs) => save(${enumOf(deadline.state)}, new Date((await timerStore.dbNow()).getTime() - DL_MS - agoMs));
  const state = async (id) => (await repository.findById(id))?.${statusField};
  /** Un caso con su id: arranca con la tabla vacía, y un fallo inesperado es un fallo de ESE caso. */
  const dl = async (id, what, run) => {
    failId = null;
    try {
      await clear();
      await run();
    } catch (error) {
      check(\`\${id}: \${what}\`, false, error?.stack ?? error);
    }
  };
${domainCases}
  await dl('DL-4', ${JSON.stringify(caseName('DL-4'))}, async () => {
    await save(${enumOf(deadline.state)}, await timerStore.dbNow());
    check("DL-4: guardar una entidad que entra en '${deadline.stateName}' arma su temporizador", (await timers(KIND)) === 1, await timers(KIND));
    try {
      await tx.inTransaction(async () => {
        await repository.save(entity(${enumOf(deadline.state)}, await timerStore.dbNow()));
        throw new Error('revierte');
      });
    } catch {
      // la transacción revirtió a propósito
    }
    check('DL-4: si la transacción revierte, no queda temporizador', (await timers(KIND)) === 1, await timers(KIND));
  });
  await dl('DL-5', ${JSON.stringify(caseName('DL-5'))}, async () => {
    const antigua = await expired(30 * 60_000);
    const reciente = await expired(5 * 60_000);
    await save(${enumOf(deadline.state)}, await timerStore.dbNow());
    const reclamados = await timerStore.claim([KIND], 10, 60_000, randomUUID());
    check('DL-5: el reclamo se lleva los dos vencidos y no el que vence en el futuro', reclamados.length === 2, reclamados.length);
    check('DL-5: el reclamo va en orden de vencimiento', reclamados[0]?.entityId === antigua && reclamados[1]?.entityId === reciente, reclamados.map((t) => t.entityId).join(', '));
  });
  await dl('DL-6', ${JSON.stringify(caseName('DL-6'))}, async () => {
    for (let i = 0; i < 20; i++) await expired(60_000);
    // Dos réplicas, cada una con su conexión, a la vez.
    const otra = new ReplicaStore(${replicaTx}, timerSignal);
    const [a, b] = await Promise.all([timerStore.claim([KIND], 20, 60_000, randomUUID()), otra.claim([KIND], 20, 60_000, randomUUID())]);
    const vistos = new Set([...a, ...b].map((t) => t.id));
    check('DL-6: dos réplicas a la vez no reclaman el mismo temporizador', vistos.size === a.length + b.length, \`\${a.length} + \${b.length}, distintos \${vistos.size}\`);
    check('DL-6: entre las dos se llevan todos los vencidos', vistos.size === 20, vistos.size);
    check('DL-6: un temporizador arrendado no vuelve a reclamarse antes de que venza su arriendo', (await timerStore.claim([KIND], 20, 60_000, randomUUID())).length === 0);
  });
  await dl('DL-7', ${JSON.stringify(caseName('DL-7'))}, async () => {
    await expired(60_000);
    check('DL-7: una réplica lo reclama', (await timerStore.claim([KIND], 10, 400, randomUUID())).length === 1);
    check('DL-7: otra no se lo quita con el arriendo en vigor', (await timerStore.claim([KIND], 10, 400, randomUUID())).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check('DL-7: vencido el arriendo, otra réplica lo retoma', (await timerStore.claim([KIND], 10, 400, randomUUID())).length === 1);
  });
  await dl('DL-8', ${JSON.stringify(caseName('DL-8'))}, async () => {
    const id = await expired(60_000);
${lateTarget ? `    await tx.inTransaction(async () => {
      const found = await repository.findById(id);
      found.probeTransition(${enumOf(lateTarget)}${guard ? `, found.${deadline.since}, timerDeadlines` : ''});
      await repository.save(found);
    });` : ''}
    await poller().pollOnce();
    check('DL-8: el temporizador de una entidad que ya salió del estado se descarta', (await timers(KIND)) === 0, await timers(KIND));
    check("DL-8: el cronómetro no mueve una entidad que ya no está en '${deadline.stateName}'", (await state(id)) === ${enumOf(lateTarget ?? deadline.to)}, await state(id));
  });
  await dl('DL-9', ${JSON.stringify(caseName('DL-9'))}, async () => {
    const id = await save(${enumOf(deadline.state)}, await timerStore.dbNow());
    await fire(KIND);
    await poller().pollOnce();
    check('DL-9: con el plazo vigente sin vencer, el cronómetro no caduca la entidad', (await state(id)) === ${enumOf(deadline.state)}, await state(id));
    check('DL-9: el temporizador se rearma en vez de borrarse', (await timers(KIND)) === 1, await timers(KIND));
    check('DL-9: rearmado al vencimiento vigente, no se puede reclamar ya', (await timerStore.claim([KIND], 10, 60_000, randomUUID())).length === 0);
  });
  await dl('DL-3', ${JSON.stringify(caseName('DL-3'))}, async () => {
    const id = await expired(60_000);
    await poller().pollOnce();
    check("DL-3: vencido el plazo, el cronómetro despacha y la entidad pasa a '${deadline.toName}'", (await state(id)) === ${enumOf(deadline.to)}, await state(id));
    check('DL-3: el temporizador cumplido se borra', (await timers(KIND)) === 0, await timers(KIND));
  });
  await dl('DL-10', ${JSON.stringify(caseName('DL-10'))}, async () => {
    await save(${enumOf(deadline.state)}, new Date((await timerStore.dbNow()).getTime() - DL_MS + 5_000));
    const sondeador = poller();
    const sueno = await sondeador.pollOnce();
    check('DL-10: con un vencimiento a 5 s, el sondeador duerme hasta él', sueno > 2_000 && sueno <= 5_500, sueno);
    await clear();
    const tope = await sondeador.pollOnce();
    check('DL-10: sin nada pendiente, el sueño es el tope', tope === 30_000, tope);
    const ahora = Date.now();
    sondeador.planWake(ahora, 30_000);
    sondeador.onArmed(new Date(ahora + 1_000));
    check('DL-10: armar uno que vence antes adelanta el despertar', sondeador.wakeAtMs() <= ahora + 1_000, sondeador.wakeAtMs() - ahora);
  });
  await dl('DL-10', ${JSON.stringify(caseName('DL-10'))}, async () => {
    const id = await expired(60_000);
    failId = id;
    const sondeador = poller(2);
    const antes = await timerStore.parkedCount();
    await sondeador.pollOnce();
    check('DL-10: no aparca al primer fallo', (await timerStore.parkedCount()) === antes, await timerStore.parkedCount());
    await sondeador.pollOnce();
    check('DL-10: agotados los intentos, el temporizador se aparca', (await timerStore.parkedCount()) === antes + 1, await timerStore.parkedCount());
    check('DL-10: el aparcado no movió la entidad', (await state(id)) === ${enumOf(deadline.state)}, await state(id));
  });
  await dl('R1', 'cada réplica asegura sus recurrentes al arrancar, y asegurarlos dos veces no duplica', async () => {
    const sondeador = poller();
    await sondeador.ensureRecurring();
    await sondeador.ensureRecurring();
    check('R1: la purga de la tabla queda asegurada como un recurrente, una sola vez', (await timers(TimerKinds.TIMER_PURGE)) === 1, await timers(TimerKinds.TIMER_PURGE));
  });
  await clear();
}
`;
}
