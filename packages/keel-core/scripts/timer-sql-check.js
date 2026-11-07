#!/usr/bin/env node
// Las SENTENCIAS del cronómetro (keel-core/gen/timer-store.js) contra PostgreSQL y MySQL reales (PLAN-DSL-226-PLAZOS.md,
// incremento 2). La referencia en memoria (gen/timer-poller.js) dice qué tienen que hacer; esto mide que lo hacen: que el
// reclamo SALTE lo bloqueado por otra sesión, que el upsert rearme, que la valla proteja, que el aparcado cuente bien con
// el orden de asignación de MySQL y que todo compare con la hora del MOTOR. Nada de esto lo ve una prueba sin base.
//
// La tabla se crea con los tipos que usan los generadores: timestamptz y uuid en PostgreSQL, datetime(6) y binary(16) en
// MySQL. Los valores van como literales (la CLI del contenedor no liga parámetros), con `bindNamed` a la vista.
//
// Uso: node scripts/timer-sql-check.js [--database=postgresql|mysql] [--sabotage=no-skip-locked|no-fence|park-order]
//   (podman o docker; ~1 min). Con sabotaje, verde = el sabotaje cae en exactamente sus casos.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { DATABASES } from '../src/lib/gen/infra-catalog.js';
import { timerStatements, expandList, NIL_ENTITY_ID, TIMER_ENGINES } from '../src/lib/gen/timer-store.js';

const only = process.argv.find((arg) => arg.startsWith('--database='))?.slice('--database='.length);
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.slice('--sabotage='.length) ?? null;
const SABOTAGES = {
  // El reclamo sin SKIP LOCKED: la segunda sesión espera al lock y, al soltarlo, ve la fila ya arrendada (la salta por el
  // arriendo) — pero mientras tanto se bloquea. Lo ve el caso que mide que no espera.
  'no-skip-locked': { breaks: ['skip-locked'], apply: (s) => ({ ...s, claimLock: s.claimLock.replace(' SKIP LOCKED', '') }) },
  'no-fence': { breaks: ['valla'], apply: (s) => ({ ...s, complete: s.complete.replace(' AND claim_token = :token', '') }) },
  'park-order': {
    breaks: ['aparcado'],
    // PostgreSQL evalúa todas las asignaciones con los valores de antes: ahí el orden no importa, y no debe caer nada.
    onlyIn: 'mysql',
    // attempts antes que parked_at: en MySQL parked_at ve el attempts ya incrementado y aparca un intento antes.
    apply: (s) => ({ ...s, fail: s.fail.replace(/SET (parked_at = CASE[^,]*END), (attempts = attempts \+ 1)/, 'SET $2, $1') })
  }
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const runtime = ['podman', 'docker'].find((name) => spawnSync(name, ['ps'], { encoding: 'utf8' }).status === 0);
if (!runtime) {
  console.error('Hace falta podman o docker en marcha.');
  process.exit(2);
}

const DDL = {
  postgresql: `CREATE TABLE keel_timer (id uuid PRIMARY KEY, kind varchar(160) NOT NULL, entity_id uuid NOT NULL, spec varchar(120),
    due_at timestamptz(6) NOT NULL, claimed_until timestamptz(6), claim_token uuid, attempts integer NOT NULL, parked_at timestamptz(6),
    CONSTRAINT uq_keel_timer_kind_entity UNIQUE (kind, entity_id));
    CREATE INDEX ix_keel_timer_due_at ON keel_timer (due_at);`,
  mysql: `CREATE TABLE keel_timer (id binary(16) PRIMARY KEY, kind varchar(160) NOT NULL, entity_id binary(16) NOT NULL, spec varchar(120),
    due_at datetime(6) NOT NULL, claimed_until datetime(6), claim_token binary(16), attempts int NOT NULL, parked_at datetime(6),
    CONSTRAINT uq_keel_timer_kind_entity UNIQUE (kind, entity_id), INDEX ix_keel_timer_due_at (due_at)) ENGINE=InnoDB;`
};

/** Un valor como literal del motor: uuid, instante, texto o número. */
function literal(engine, value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) {
    const iso = value.toISOString();
    return engine === 'postgresql' ? `'${iso}'::timestamptz` : `'${iso.replace('T', ' ').replace('Z', '')}'`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    return engine === 'postgresql' ? `'${value}'::uuid` : `UUID_TO_BIN('${value}')`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Sustituye los marcadores nombrados por literales; las listas se expanden primero. */
function render(engine, sql, params) {
  let text = sql;
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      text = expandList(text, name, value.length);
      value.forEach((item, index) => (text = text.replaceAll(`:${name}${index}`, literal(engine, item))));
    }
  }
  return text.replace(/(?<![:\w]):([a-zA-Z][a-zA-Z0-9]*)/g, (match, name) => {
    if (!(name in params)) throw new Error(`falta el parámetro :${name} en ${sql}`);
    return literal(engine, params[name]);
  });
}

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(engine) {
  const db = DATABASES[engine];
  const port = await freePort();
  const name = `keel-timer-sql-${engine}-${process.pid}`;
  const env = engine === 'postgresql' ? ['-e', 'POSTGRES_PASSWORD=changeme', '-e', 'POSTGRES_DB=timer'] : ['-e', 'MYSQL_ROOT_PASSWORD=changeme', '-e', 'MYSQL_DATABASE=timer'];
  const started = spawnSync(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${port}:${db.port}`, ...env, db.image], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(`no arrancó ${db.image}: ${started.stderr}`);
  // En MySQL, por TCP: por socket contesta el servidor temporal del init (el arreglo del db-check de keel-go).
  const probe = engine === 'postgresql' ? ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'timer'] : ['exec', name, 'mysql', '-h', '127.0.0.1', '-uroot', '-pchangeme', '-e', 'SELECT 1', 'timer'];
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (spawnSync(runtime, probe, { encoding: 'utf8' }).status === 0) {
      await sleep(engine === 'postgresql' ? 1500 : 500);
      return name;
    }
    await sleep(1000);
  }
  throw new Error(`${engine} no estuvo listo en 180 s`);
}

function clientArgs(engine, name) {
  return engine === 'postgresql'
    ? ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'timer', '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1']
    : ['exec', '-i', '-e', 'MYSQL_PWD=changeme', name, 'mysql', '-h', '127.0.0.1', '-uroot', '-N', '-B', 'timer'];
}

function sql(engine, name, text) {
  const result = spawnSync(runtime, clientArgs(engine, name), { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${engine}: ${(result.stderr || result.stdout).trim()} — en: ${text.slice(0, 300)}`);
  return result.stdout.trim().split('\n').filter((line) => line && !line.startsWith('mysql: [Warning]')).map((line) => line.split('\t'));
}

/** Una sesión que corre en paralelo: devuelve la promesa de su salida. */
function sqlAsync(engine, name, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, clientArgs(engine, name));
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
    child.stdin.end(text);
  });
}

const results = [];
function step(engine, id, ok, detail = '') {
  results.push({ engine, id, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} [${engine}] ${id}${detail ? ` — ${detail}` : ''}`);
}

const uuid = () => crypto.randomUUID();
const KIND = 'deadline:Reservation.pending';

async function check(engine) {
  let name;
  try {
    name = await start(engine);
    step(engine, 'motor en marcha', true);
  } catch (error) {
    step(engine, 'motor en marcha', false, error.message);
    return;
  }
  const S = sabotage ? SABOTAGES[sabotage].apply(timerStatements(engine)) : timerStatements(engine);
  const run = (statement, params = {}) => sql(engine, name, render(engine, statement, params));
  const hex = engine === 'postgresql' ? (column) => column : (column) => `BIN_TO_UUID(${column})`;
  const count = (where = '1=1') => Number(sql(engine, name, `SELECT count(*) FROM keel_timer WHERE ${where};`)[0][0]);
  const reset = () => sql(engine, name, 'DELETE FROM keel_timer;');
  const dbNow = () => new Date(`${run(S.dbNow)[0][0].replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/\+00(:00)?$/, '')}Z`);
  const claim = (token, kinds = [KIND], limit = 10) => {
    const ids = run(S.claimLock, { kinds, limit }).map(([id]) => id);
    if (ids.length > 0) {
      // claimLock devuelve el id crudo; en MySQL es binario: se vuelve a leer como texto.
      const textual = engine === 'postgresql' ? ids : run(`SELECT ${hex('id')} FROM keel_timer WHERE kind IN (:kinds) ORDER BY due_at`, { kinds }).map(([id]) => id).slice(0, ids.length);
      run(S.claimMark, { leaseMs: 120000, token, ids: textual });
    }
    return run(S.claimed.replace('SELECT id, kind, entity_id', `SELECT ${hex('id')}, kind, ${hex('entity_id')}`), { token });
  };

  try {
    sql(engine, name, DDL[engine]);
    // Siempre con la hora del motor de ESE momento: el script tarda, y una hora vieja descuadra los vencimientos.
    const ago = (s) => new Date(dbNow().getTime() - s * 1000);
    const ahead = (s) => new Date(dbNow().getTime() + s * 1000);

    // Armar dos veces el mismo plazo: una fila, rearmada.
    run(S.arm, { id: uuid(), kind: KIND, entityId: 'aaaaaaaa-0000-4000-8000-000000000001', spec: null, dueAt: ahead(60) });
    run(S.arm, { id: uuid(), kind: KIND, entityId: 'aaaaaaaa-0000-4000-8000-000000000001', spec: null, dueAt: ahead(120) });
    step(engine, 'armado', count() === 1 && count(`due_at > ${literal(engine, ahead(100))}`) === 1);
    reset();

    // Un recurrente: el mismo spec no lo toca, otro spec lo recalcula.
    const recurring = (spec, dueAt) => run(S.ensureRecurring, { id: uuid(), kind: 'schedule:sweep', entityId: NIL_ENTITY_ID, spec, dueAt });
    recurring('*/5 * * * *', ahead(300));
    recurring('*/5 * * * *', ahead(9000));
    const same = count(`due_at < ${literal(engine, ahead(1000))}`) === 1;
    recurring('*/10 * * * *', ahead(9000));
    step(engine, 'recurrente', same && count(`due_at > ${literal(engine, ahead(1000))}`) === 1, same ? '' : 'el mismo spec cambió due_at');
    reset();

    // El reclamo: solo lo vencido, en orden de due_at, con la hora del motor.
    const ids = ['aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000c'];
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ago(1) });
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[1], spec: null, dueAt: ago(5) });
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[2], spec: null, dueAt: ahead(3600) });
    const claimed = claim(uuid());
    step(engine, 'reclamo', claimed.map((row) => row[2]).join(',') === [ids[1], ids[0]].join(','), claimed.map((row) => row[2]).join(','));
    // Con el arriendo puesto, nadie más los toma.
    step(engine, 'arriendo', claim(uuid()).length === 0);

    // La valla: completar con otra valla no borra; con la suya, sí.
    const token = uuid();
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ago(1) });
    const [own] = claim(token);
    const wrong = run(`${S.complete}${engine === 'postgresql' ? ' RETURNING id' : ''}`, { id: own[0], token: uuid() });
    const leftAfterWrong = count();
    run(S.complete, { id: own[0], token });
    step(engine, 'valla', leftAfterWrong === 1 && count() === 0, `con otra valla quedaron ${leftAfterWrong} (${wrong.length})`);

    // El aparcado: con max-attempts 2, el primer fallo NO aparca y el segundo sí.
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ago(1) });
    const fail = () => {
      const t = uuid();
      run(`UPDATE keel_timer SET due_at = ${engine === 'postgresql' ? 'current_timestamp' : 'current_timestamp(6)'} - interval '1' second;`.replace("interval '1' second", engine === 'postgresql' ? "interval '1 second'" : 'INTERVAL 1 SECOND'));
      const [row] = claim(t);
      // Nada que reclamar: ya estaba aparcado (lo que hace el sabotaje park-order en MySQL, un intento antes).
      if (row) run(S.fail, { id: row[0], token: t, maxAttempts: 2, retryDelayMs: 0 });
    };
    fail();
    const afterOne = count('parked_at IS NOT NULL');
    fail();
    step(engine, 'aparcado', afterOne === 0 && count('parked_at IS NOT NULL') === 1 && count('attempts = 2') === 1, `tras el primer fallo, ${afterOne} aparcados`);

    // Lo próximo: unos 7 s, con la hora del motor.
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ahead(7) });
    const next = Number(run(S.nextDueMs, { kinds: [KIND] })[0][0]);
    step(engine, 'siguiente vencimiento', next > 5000 && next <= 7000, `${next} ms`);

    // La purga: lo vencido hace más de la retención y sin reclamar.
    reset();
    run(S.arm, { id: uuid(), kind: 'schedule:retired', entityId: ids[0], spec: null, dueAt: ago(10 * 86400) });
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[1], spec: null, dueAt: ago(60) });
    run(S.purge, { retentionDays: 7 });
    step(engine, 'purga', count() === 1 && count(`kind = '${KIND}'`) === 1);

    // El arnés: adelantar y envejecer.
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ahead(3600) });
    run(S.age, { kind: KIND, entityId: ids[0], ageMs: 3_700_000 });
    const aged = claim(uuid()).length === 1;
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ahead(3600) });
    run(S.fire, { kind: KIND });
    step(engine, 'arnés (age y fire)', aged && claim(uuid()).length === 1);

    // SKIP LOCKED: una sesión tiene bloqueado el primer candidato; la otra, a la vez, toma el siguiente sin esperarla.
    reset();
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[0], spec: null, dueAt: ago(10) });
    run(S.arm, { id: uuid(), kind: KIND, entityId: ids[1], spec: null, dueAt: ago(5) });
    const holdSleep = engine === 'postgresql' ? 'SELECT pg_sleep(6);' : 'DO SLEEP(6);';
    const holder = sqlAsync(engine, name, `${engine === 'postgresql' ? 'BEGIN' : 'START TRANSACTION'};\n${render(engine, S.claimLock, { kinds: [KIND], limit: 1 })};\n${holdSleep}\nCOMMIT;`);
    await sleep(2000);
    const began = Date.now();
    const other = run(S.claimLock, { kinds: [KIND], limit: 10 });
    const waited = Date.now() - began;
    await holder;
    step(engine, 'skip-locked', other.length === 1 && waited < 3000, `la otra sesión tomó ${other.length} en ${waited} ms`);
  } catch (error) {
    step(engine, 'sentencias', false, error.message.replace(/\s+/g, ' ').slice(0, 600));
  } finally {
    spawnSync(runtime, ['rm', '-f', name]);
  }
}

for (const engine of TIMER_ENGINES.filter((engine) => !only || engine === only)) await check(engine);

const failed = results.filter((result) => !result.ok);
if (!sabotage) {
  console.log(failed.length === 0 ? `\nVerde: ${results.length} pasos.` : `\nRojo: ${failed.length} de ${results.length}.`);
  process.exit(failed.length === 0 ? 0 : 1);
}
const ran = new Set(results.map((result) => result.engine));
const { onlyIn } = SABOTAGES[sabotage];
const expected = !onlyIn || ran.has(onlyIn) ? SABOTAGES[sabotage].breaks : [];
const fell = [...new Set(failed.map((result) => result.id))];
const ok = expected.every((id) => fell.includes(id)) && fell.every((id) => expected.includes(id));
console.log(`\nSabotaje ${sabotage}: cayeron ${fell.join(', ') || 'ninguno'}; se esperaba ${expected.join(', ')} → ${ok ? 'VERDE' : 'ROJO'}`);
process.exit(ok ? 0 : 1);
