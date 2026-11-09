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
import { timerPurges, timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { tablePurges } from '../../src/scaffold/purge.js';
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
  purgeKindConstant,
  purgeTimerClass,
  purgeTimerPath,
  scheduleKindConstant,
  scheduleTimerClass,
  scheduleTimerPath,
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
    // Y TL-1 (inc. 11): con arriendo cero, lo «arrendado» vuelve a contar en el retraso al instante siguiente.
    breaks: [...DEADLINE_SABOTAGES['dl-no-lease'].breaks, 'TL-1'],
    documentBreaks: ['DL-5', ...DEADLINE_SABOTAGES['dl-no-lease'].breaks, 'TL-1']
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
  const failedIds = [...new Set(checks.filter((check) => !check.ok).map((check) => /^(DL-\d+|R\d+|TL-\d+):/.exec(check.name)?.[1] ?? check.name))].sort();
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
  const poller = (maxAttempts = 10) => new TimerPoller(timerStore, [deadlineHandler], [purgeHandler], timerSettings(maxAttempts), tx, timerSignal);
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
  // El RETRASO del cronómetro (DSL 2.26, inc. 11): lo que lee el gauge keel.timer.lag.seconds, contra el motor real. El
  // filtro es el del reclamo, así que ni lo arrendado ni un kind que la réplica no conoce cuentan.
  await dl('TL-1', 'el retraso del cronómetro: lo vencido y libre más antiguo de los kinds conocidos, con la hora de la base', async () => {
    check('TL-1: sin nada vencido, el retraso es nulo', (await timerStore.lagMs([KIND])) === null, await timerStore.lagMs([KIND]));
    await expired(120_000);
    const lag = await timerStore.lagMs([KIND]);
    check('TL-1: el retraso es lo que lleva vencido (unos 120 s)', lag >= 115_000 && lag < 180_000, lag);
    check('TL-1: un kind que la réplica no conoce no cuenta', (await timerStore.lagMs(['deadline:Ajeno.pending'])) === null, await timerStore.lagMs(['deadline:Ajeno.pending']));
    await timerStore.claim([KIND], 10, 60_000, randomUUID());
    check('TL-1: lo arrendado no cuenta', (await timerStore.lagMs([KIND])) === null, await timerStore.lagMs([KIND]));
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

// ─── Las purgas en modo clúster (DSL 2.26, incremento 7) ─────────────────────
//
// Antes, TablePurges registraba cada purga en el reloj, que corre en TODAS las réplicas a la vez. Ahora cada una es un
// recurrente del cronómetro (`<Tabla>PurgeTimer`), y la promesa es una sola: cada tick lo ejecuta UNA réplica, la que gana
// su fila en keel_timer. Lo que hace la purga no cambió y lo mide el bloque de purgas por lotes; aquí se mide quién la
// dispara. Dos réplicas son dos sondeadores con SUS PROPIAS instancias de cada recurrente, sobre la misma base; TablePurges
// se sustituye por un doble que cuenta las llamadas: contarlas es contar cuántas réplicas ejecutaron el tick. Los mismos
// casos que la sonda de keel-spring (src/lib/purge-timer-probes.js), con los mismos ids.

/** El sabotaje: el kind de cada `<Tabla>PurgeTimer` es distinto por instancia, así que cada réplica arbitra con su propia fila. */
export const PURGE_TIMER_SABOTAGES = Object.freeze({
  'timer-every-replica': {
    spec: ['-purge-timer.ts', /readonly kind = (TimerKinds\.PURGE_\w+);/g, "readonly kind = $1 + '@' + Math.random().toString(36).slice(2);"],
    breaks: ['R1', 'RC-1']
  },
  // El mismo, SOLO sobre los `schedule` (inc. 8): demuestra que el bloque mide el schedule y no solo la primera purga.
  'timer-every-replica-schedule': {
    spec: ['-schedule-timer.ts', /readonly kind = (TimerKinds\.SCHEDULE_\w+);/g, "readonly kind = $1 + '@' + Math.random().toString(36).slice(2);"],
    breaks: ['R1', 'RC-1']
  }
});

/**
 * Los sabotajes del DRENAJE (inc. 8): el reclamo que no avisa del lote lleno (cae DR-1) y el tick sin tope de tiempo (cae
 * DR-3). Los casos los escribe db-check/doc-check junto al reclamo de la cola, con el adaptador real.
 */
export const DRAIN_SABOTAGES = Object.freeze({
  'drain-no-signal': { spec: ['-repository-impl.ts', /^\s*SweepPass\.claimed\(.*\);\n/m, ''], breaks: ['DR-1'] },
  'drain-no-budget': { spec: ['-schedule-timer.ts', ' || Date.now() - start >= budget', ''], breaks: ['DR-3'] }
});

export const isDrainSabotage = (id) => Boolean(id && DRAIN_SABOTAGES[id]);

/** El veredicto: los casos DR que cayeron (`DR-<n>: …`) contra los esperados, y que no cayera nada más. */
export function drainSabotageVerdict(checks, id) {
  const failed = [...new Set(checks.filter((check) => !check.ok).map((check) => /^(DR-\d+):/.exec(check.name)?.[1] ?? check.name))].sort();
  const want = [...DRAIN_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

export const isPurgeTimerSabotage = (id) => Boolean(id && PURGE_TIMER_SABOTAGES[id]);

/** El veredicto: los ids que cayeron en el bloque de las purgas (`purgas · <id>: …`), y nada más, contra los esperados. */
export function purgeTimerSabotageVerdict(checks, id) {
  const failed = [...new Set(checks.filter((check) => !check.ok).map((check) => /^purgas · ([A-Z]+-?\d+):/.exec(check.name)?.[1] ?? check.name))].sort();
  const want = [...PURGE_TIMER_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** El bloque de R1, RC-1 y R2 sobre las purgas de este diseño, o '' si no corre ninguna en el cronómetro. */
export function purgeTimerBlock(model) {
  const purges = timerPurges(model);
  const schedules = timerSchedules(model);
  if (purges.length === 0 && schedules.length === 0) return '';
  const document = usesDocument(model);
  const storeClass = document ? 'MongoTimerStore' : 'SqlTimerStore';
  const entries = purges.map((purge) => {
    const entry = tablePurges(model).find((candidate) => candidate.table === purge.table);
    if (!entry) throw new Error(`timer-probes: ${purge.table} corre en el cronómetro y TablePurges no la tiene`);
    return { ...purge, key: entry.key, method: entry.method, className: purgeTimerClass(purge.table) };
  });
  const support = document
    ? {
        clear: "await database.collection('keel_timer').deleteMany({});",
        // El kind de una purga (`purge:<tabla>`) no lleva caracteres especiales de una expresión regular.
        count: "return database.collection('keel_timer').countDocuments({ kind: { $regex: '^' + prefix } });",
        fire: "await database.collection('keel_timer').updateMany({ kind }, { $set: { due_at: await purgeTimerStore.dbNow(), claimed_until: null, claim_token: null } });"
      }
    : (() => {
        const engine = engineOf(model);
        const style = engine === 'postgresql' ? 'dollar' : 'question';
        const fire = bindNamed(timerStatements(engine).fire, style).sql;
        const count = bindNamed(`SELECT count(*) AS n FROM ${KEEL_TIMER.table} WHERE kind LIKE :prefix`, style).sql;
        return {
          clear: `await dataSource.query('DELETE FROM ${KEEL_TIMER.table}');`,
          count: `return Number((await dataSource.query(${JSON.stringify(count)}, [prefix + '%']))[0].n);`,
          fire: `await dataSource.query(${JSON.stringify(fire)}, [kind]);`
        };
      })();
  // Los `schedule` (inc. 8): el doble es el scheduler, que cuenta cuántas veces se despacha cada operación.
  const scheduleEntries = schedules.map((schedule) => ({ ...schedule, className: scheduleTimerClass(schedule.operation) }));
  const imports = [
    ...entries.map((entry) => `  const { ${entry.className} } = await import('${distOf(purgeTimerPath(entry.table))}');`),
    ...scheduleEntries.map((entry) => `  const { ${entry.className} } = await import('${distOf(scheduleTimerPath(entry.operation))}');`)
  ].join('\n');
  const config = entries.map((entry) => `${entry.key}: { cron: ${JSON.stringify(entry.cron.default)} }`).join(', ');
  const fakes = entries.map((entry) => `${entry.method}: async () => { calls[${JSON.stringify(entry.table)}] += 1; return 0; }`).join(', ');
  const schedulerFakes = scheduleEntries.map((entry) => `${entry.operation}: async () => { calls[${JSON.stringify(entry.operation)}] += 1; }`).join(', ');
  const instances = [
    ...entries.map((entry) => `new ${entry.className}(fakePurges, purgeConfig)`),
    ...scheduleEntries.map((entry) => `new ${entry.className}(fakeScheduler, pollerSettings)`)
  ].join(', ');
  return `
// ═══ Los recurrentes en modo clúster (DSL 2.26, incs. 7 y 8): ${[...entries.map((entry) => entry.table), ...scheduleEntries.map((entry) => entry.operation)].join(', ')} ═══
try {
  const { ${storeClass} } = await import('${distOf(document ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS)}');
  const { TimerArmedSignal } = await import('${distOf(TIMER_STORE_TS)}');
  const { TimerPoller } = await import('${distOf(TIMER_POLLER_TS)}');
  const { TimerKinds } = await import('${distOf(TIMER_KINDS_TS)}');
${imports}
  const purgeTimerStore = new ${storeClass}(tx, new TimerArmedSignal());
  const calls = { ${[...entries.map((entry) => entry.table), ...scheduleEntries.map((entry) => entry.operation)].map((name) => `${JSON.stringify(name)}: 0`).join(', ')} };
  // TablePurges, doblado: el recurrente llama a SU método, y la llamada se cuenta.
  const fakePurges = { ${fakes} };
  // Y el scheduler, doblado: el <Operación>ScheduleTimer llama al método de su operación.
  const fakeScheduler = { ${schedulerFakes} };
  const purgeConfig = { ${config} };
  const pollerSettings = { enabled: true, maxSleepMs: 30_000, batchSize: 50, leaseMs: 60_000, maxAttempts: 10, retryDelayMs: 0, drainBudgetMs: 0, retentionDays: 7, purgeCron: '0 30 5 * * *' };
  /** Una réplica: un sondeador con SUS PROPIAS instancias de cada recurrente, como un proceso aparte. */
  const replica = () => {
    const recurrings = [${instances}];
    return { poller: new TimerPoller(purgeTimerStore, [], recurrings, pollerSettings, tx, new TimerArmedSignal()), recurrings };
  };
  const reset = async () => {
    ${support.clear}
    for (const table of Object.keys(calls)) calls[table] = 0;
  };
  /** Las filas cuyo kind empieza por el de esa purga (con el sabotaje, una por réplica). */
  const rows = async (prefix) => {
    ${support.count}
  };
  const fireAll = async ({ recurrings }) => {
    for (const { kind } of recurrings) {
      ${support.fire}
    }
  };
  const KINDS = [${[...entries.map((entry) => `TimerKinds.${purgeKindConstant(entry.table)}`), ...scheduleEntries.map((entry) => `TimerKinds.${scheduleKindConstant(entry.operation)}`)].join(', ')}];

  await reset();
  await replica().poller.ensureRecurring();
  await replica().poller.ensureRecurring();
  for (const kind of KINDS) {
    check(\`purgas · R1: \${kind} es UNA fila en keel_timer, la aseguren las réplicas que la aseguren\`, (await rows(kind)) === 1, await rows(kind));
  }

  await reset();
  const a = replica();
  const b = replica();
  await a.poller.ensureRecurring();
  await b.poller.ensureRecurring();
  await fireAll(a);
  await fireAll(b);
  await a.poller.pollOnce();
  await b.poller.pollOnce();
  for (const [table, count] of Object.entries(calls)) {
    check(\`purgas · RC-1: el tick de \${table} lo ejecuta UNA réplica\`, count === 1, \`\${count} ejecuciones\`);
  }

  await reset();
  const solo = replica();
  await solo.poller.ensureRecurring();
  await fireAll(solo);
  await solo.poller.pollOnce();
  await solo.poller.pollOnce();
  for (const [table, count] of Object.entries(calls)) {
    check(\`purgas · R2: tras su tick, \${table} no se repite antes del siguiente cron\`, count === 1, \`\${count} ejecuciones\`);
  }
  const next = await purgeTimerStore.nextDueMs(solo.recurrings.map(({ kind }) => kind));
  check('purgas · R2: la purga queda armada para el futuro', next != null && next > 0, next);
  ${support.clear}
} catch (error) {
  check('purgas · el bloque de las purgas en el cronómetro corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}
`;
}
