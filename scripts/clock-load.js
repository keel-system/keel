#!/usr/bin/env node
// La CARGA que los relojes del servidor generado ponen sobre la base (PLAN-DSL-226-PLAZOS.md, incremento 0).
//
// Arranca N réplicas de un proyecto ya generado y completado contra su infra/ en marcha, deja un minuto de
// calentamiento y mide durante una ventana lo que llega a PostgreSQL: transacciones, tuplas leídas y escritas, y los
// recorridos de cada tabla. En reposo, eso es lo que cuestan los relojes (relay del outbox, purgas, barridos); con
// carga, lo mismo más lo que cuesta atender. Se pasa al cerrar cada migración (7, 8 y 9) para comprobar que la carga
// baja donde el plan dice que baja.
//
// Uso (con la infra/ del proyecto ya levantada: bash infra/up.sh && bash infra/validate-infra.sh):
//   node scripts/clock-load.js <proyecto> [--replicas=3] [--minutes=5] [--load=5] [--label=go-3r-reposo]
//
//   --load=<n>   peticiones de alta por segundo durante la ventana (0, el default, es reposo)
//
// Hoy solo sabe arrancar un proyecto de keel-go (un binario: tres réplicas caben en esta máquina). Los demás se
// añaden en LAUNCHERS cuando haga falta medirlos.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const project = args.find((arg) => !arg.startsWith('--'));
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const replicas = Number(option('replicas', '1'));
const minutes = Number(option('minutes', '5'));
const loadPerSecond = Number(option('load', '0'));
const warmupSeconds = Number(option('warmup', '60'));
const label = option('label', `${replicas}r-${loadPerSecond > 0 ? `carga${loadPerSecond}` : 'reposo'}`);
const outDir = option('out', 'D:/keel-tmp/clock-load');

if (!project || !fs.existsSync(path.join(project, 'keel-generated.json'))) {
  console.error('Uso: node scripts/clock-load.js <proyecto generado> [--replicas=N] [--minutes=M] [--load=R] [--label=…]');
  process.exit(2);
}

const runtime = ['podman', 'docker'].find((name) => spawnSync(name, ['ps'], { encoding: 'utf8' }).status === 0);
if (!runtime) {
  console.error('No hay podman ni docker en marcha.');
  process.exit(2);
}

/** El contenedor de PostgreSQL de la infra/ del proyecto y sus credenciales, leídos del compose. */
function database() {
  const compose = fs.readFileSync(path.join(project, 'infra', 'docker-compose.yaml'), 'utf8');
  const block = compose.split(/\n  (?=\S)/).find((service) => /image:\s*\S*postgres/.test(service));
  if (!block) throw new Error('la infra/ no tiene PostgreSQL: hoy solo se mide sobre PostgreSQL');
  const field = (name) => block.match(new RegExp(`${name}:\\s*(\\S+)`))?.[1];
  return { container: field('container_name'), db: field('POSTGRES_DB'), user: field('POSTGRES_USER') };
}
const pg = database();

function sql(statement) {
  const result = spawnSync(runtime, ['exec', '-i', pg.container, 'psql', '-U', pg.user, '-d', pg.db, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`psql: ${result.stderr || result.stdout}`);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
}

/** Los contadores acumulados de la base y de cada tabla. Las ventanas se miden por diferencia. */
function snapshot() {
  // Los contadores de pg_stat se publican al terminar cada transacción, con un pequeño retraso: se fuerza el volcado.
  sql('SELECT pg_stat_force_next_flush();');
  const [databaseRow] = sql(`SELECT xact_commit, xact_rollback, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = '${pg.db}';`);
  const [xactCommit, xactRollback, tupReturned, tupFetched, tupInserted, tupUpdated, tupDeleted] = databaseRow.map(Number);
  const tables = Object.fromEntries(
    sql('SELECT relname, COALESCE(seq_scan,0), COALESCE(idx_scan,0), n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables;').map(([name, ...counters]) => {
      const [seqScan, idxScan, inserted, updated, deleted] = counters.map(Number);
      return [name, { scans: seqScan + idxScan, seqScan, idxScan, written: inserted + updated + deleted }];
    })
  );
  return { at: Date.now(), xactCommit, xactRollback, tupReturned, tupFetched, tupInserted, tupUpdated, tupDeleted, tables };
}

const LAUNCHERS = {
  go: {
    matches: () => fs.existsSync(path.join(project, 'go.mod')),
    build() {
      fs.mkdirSync(outDir, { recursive: true });
      // Fuera de %TEMP%: el antivirus deniega ejecutables recién enlazados allí (medido en db-check de keel-go).
      const binary = path.join(outDir, `${path.basename(project)}-server${process.platform === 'win32' ? '.exe' : ''}`);
      const built = spawnSync('go', ['build', '-o', binary, './cmd/server'], { cwd: project, encoding: 'utf8' });
      if (built.status !== 0) throw new Error(`go build: ${built.stderr}`);
      return binary;
    },
    start: (binary, port) => spawn(binary, [], { cwd: project, env: { ...process.env, PROFILE: 'local', SERVER_PORT: String(port), SERVER_ADDRESS: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'pipe'] })
  }
};

const launcher = Object.entries(LAUNCHERS).find(([, candidate]) => candidate.matches());
if (!launcher) {
  console.error(`No sé arrancar ${project}: hoy solo keel-go (LAUNCHERS).`);
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilServing(port, child) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`la réplica del puerto ${port} terminó con ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/livez`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`la réplica del puerto ${port} no contestó en 60 s`);
}

/** Una categoría para el alta (el diseño no tiene operación que la cree): por columnas, como el seedCategory del arnés. */
function ensureCategory() {
  // El nombre de la tabla lo decide el generador (`categories` en keel-go): se busca, como hace el arnés.
  const [found] = sql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('categories','category') ORDER BY table_name LIMIT 1;");
  if (!found) throw new Error('no encuentro la tabla de categorías (categories/category)');
  const table = found[0];
  const [existing] = sql(`SELECT id FROM ${table} LIMIT 1;`);
  if (existing) return existing[0];
  const columns = sql(`SELECT column_name, data_type, is_nullable, COALESCE(column_default,'') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}';`);
  const id = crypto.randomUUID();
  const value = (name, type) => (name === 'id' ? `'${id}'` : /uuid/.test(type) ? 'gen_random_uuid()' : /timestamp/.test(type) ? 'now()' : /int|numeric/.test(type) ? '0' : /bool/.test(type) ? 'false' : `'carga-${name}'`);
  // Todas las columnas sin default, también las anulables: la lectura del adaptador puede exigirlas (created_at).
  const required = columns.filter(([name, , , hasDefault]) => name === 'id' || !hasDefault);
  // Una anulable va a NULL (una FK opcional no puede llevar un uuid inventado), salvo las marcas de tiempo.
  const valueOf = ([name, type, nullable]) => (nullable === 'YES' && name !== 'id' && !/timestamp/.test(type) ? 'NULL' : value(name, type));
  sql(`INSERT INTO ${table} (${required.map(([name]) => name).join(', ')}) VALUES (${required.map(valueOf).join(', ')});`);
  return id;
}

/** Altas de producto repartidas entre las réplicas, a ritmo fijo, durante la ventana. */
async function drive(ports, categoryId, stopAt) {
  const outcomes = {};
  const runId = crypto.randomBytes(3).toString('hex');
  let sent = 0;
  while (Date.now() < stopAt) {
    const tick = Date.now();
    const batch = [];
    for (let i = 0; i < loadPerSecond; i += 1) {
      const port = ports[sent % ports.length];
      sent += 1;
      batch.push(
        fetch(`http://127.0.0.1:${port}/api/v1/products`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          // Corto a propósito: el SKU de catalog-extended no pasa de 20 caracteres.
          body: JSON.stringify({ sku: `L-${runId}-${sent.toString(36)}`, name: 'Carga', categoryId })
        })
          .then((response) => response.status)
          .catch(() => 'error')
          .then((status) => {
            outcomes[status] = (outcomes[status] ?? 0) + 1;
          })
      );
    }
    await Promise.all(batch);
    await sleep(Math.max(0, 1000 - (Date.now() - tick)));
  }
  return outcomes;
}

function report(before, after) {
  const perMinute = (value) => Math.round((value / ((after.at - before.at) / 60_000)) * 10) / 10;
  const delta = (key) => after[key] - before[key];
  const tables = Object.keys(after.tables)
    .map((name) => ({
      table: name,
      scansPerMinute: perMinute(after.tables[name].scans - (before.tables[name]?.scans ?? 0)),
      writesPerMinute: perMinute(after.tables[name].written - (before.tables[name]?.written ?? 0))
    }))
    .filter((row) => row.scansPerMinute > 0 || row.writesPerMinute > 0)
    .sort((a, b) => b.scansPerMinute - a.scansPerMinute);
  return {
    transactionsPerMinute: perMinute(delta('xactCommit') + delta('xactRollback')),
    tuplesReadPerMinute: perMinute(delta('tupReturned') + delta('tupFetched')),
    tuplesWrittenPerMinute: perMinute(delta('tupInserted') + delta('tupUpdated') + delta('tupDeleted')),
    tables
  };
}

const children = [];
const stopAll = () => children.forEach((child) => child.exitCode === null && child.kill());
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

try {
  const binary = launcher[1].build();
  const ports = [];
  for (let i = 0; i < replicas; i += 1) {
    const port = await freePort();
    const child = launcher[1].start(binary, port);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.on('exit', (code) => code && console.error(`réplica ${port} salió con ${code}: ${stderr}`));
    children.push(child);
    ports.push(port);
    await waitUntilServing(port, child);
  }
  console.log(`${replicas} réplica(s) en ${ports.join(', ')}; calentamiento ${warmupSeconds} s, ventana ${minutes} min${loadPerSecond ? `, ${loadPerSecond} altas/s` : ', en reposo'}`);
  const categoryId = loadPerSecond > 0 ? ensureCategory() : null;
  await sleep(warmupSeconds * 1000);
  const before = snapshot();
  const stopAt = Date.now() + minutes * 60_000;
  const outcomes = loadPerSecond > 0 ? await drive(ports, categoryId, stopAt) : (await sleep(minutes * 60_000), null);
  const after = snapshot();
  // Lo que tarda un evento en salir del outbox hacia el broker (con hora de la base en los dos extremos): es lo que
  // tiene que bajar con el despertar al confirmar de la migración del relay.
  const [hasOutbox] = sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'outbox_event';");
  const [latency] = Number(hasOutbox[0]) > 0
    ? sql(`SELECT count(*), round(avg(extract(epoch FROM published_at - created_at)) * 1000), round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM published_at - created_at)) * 1000)::numeric) FROM outbox_event WHERE published_at IS NOT NULL AND created_at > now() - interval '${minutes} minutes';`)
    : [[0]];
  const outboxLatency = Number(latency[0]) > 0 ? { events: Number(latency[0]), avgMs: Number(latency[1]), p95Ms: Number(latency[2]) } : null;
  const result = { label, project: path.resolve(project), replicas, minutes, loadPerSecond, outcomes, outboxLatency, ...report(before, after) };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`transacciones/min ${result.transactionsPerMinute} · tuplas leídas/min ${result.tuplesReadPerMinute} · escritas/min ${result.tuplesWrittenPerMinute}`);
  for (const row of result.tables.slice(0, 10)) console.log(`  ${row.table.padEnd(28)} recorridos/min ${String(row.scansPerMinute).padStart(8)} · escrituras/min ${row.writesPerMinute}`);
  if (outcomes) console.log(`  respuestas: ${JSON.stringify(outcomes)}`);
  if (outboxLatency) console.log(`  salida del outbox: ${outboxLatency.events} eventos, media ${outboxLatency.avgMs} ms, p95 ${outboxLatency.p95Ms} ms`);
  console.log(`→ ${file}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stopAll();
}
