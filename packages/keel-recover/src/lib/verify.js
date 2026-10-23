import crypto from 'node:crypto';
import { composeProject, containerOf } from './sandbox.js';
import { staticCriteria } from './verify-static.js';
import { parseJsonFiles, readIstanbul, readJacocoCsv, readV8, splitDump } from './coverage.js';
import { databaseAdapter } from './db/index.js';

// Paso 0f: el juez del sandbox. Decide si el legacy está levantado de forma que lo que se grabe
// después sea comportamiento y no un síntoma del entorno. Las dos reglas que midió el inc. 1:
//   1. la base se comprueba con una lectura y una escritura REALES del dominio, y la escritura
//      tiene que dejar rastro en la base; nunca con la salud del legacy (el /health de orders decía
//      OK con todas las consultas en 500);
//   2. «sin 5xx» no basta: cada sonda declara qué estados son acierto (RealWorld contra Mongo 7
//      daba 422 a un usuario nuevo), y la versión del motor se cruza con la de la CI.
// Si todo sale en verde, toma el snapshot de la base: el estado de partida de las sondas, con su
// huella (`snapshot.hash`), que el paso 1 compara tras cada restauración.

// Los estáticos que impiden arrancar: con la red abierta el legacy dispararía efectos en internet
// (principio 5), y sin sus servicios no hay a quién preguntar. El resto (un digest, el motor) se
// juzga igual en rojo, pero no esconde lo que diría el sandbox en marcha.
export const BLOCKING = new Set(['VER-COMPOSE', 'VER-NET-INTERNAL']);
export const LIVE_CRITERIA = ['VER-UP', 'VER-EGRESS', 'VER-READ', 'VER-WRITE', 'VER-DB-TRACE', 'VER-COVERAGE'];
const DEFAULT_EGRESS = ['https://example.com', 'https://registry.npmjs.org'];
// curl sin salida: 6 (no resuelve), 7 (no conecta), 28 (plazo), 35/60 (TLS sin llegar).
const BLOCKED_CURL = new Set([6, 7, 28, 35, 60]);

const criterion = (id, ok, detail, extra = {}) => ({ id, ok: Boolean(ok), detail, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function verify(sandbox, rt, { up = true, snapshot = true, log = () => {}, nonce = crypto.randomUUID().slice(0, 8), pollMs = 2000 } = {}) {
  const report = { kind: 'verify', schema: 1, ok: false, runtime: rt.name, criteria: [] };
  const push = (c) => {
    report.criteria.push(c);
    log(c);
    return c.ok;
  };
  for (const c of staticCriteria(sandbox)) push(c);
  const skip = (why) => {
    for (const id of LIVE_CRITERIA) if (!report.criteria.some((c) => c.id === id)) push(criterion(id, false, `no se ejecutó: ${why}`, { skipped: true }));
    return finish(report);
  };
  const blocked = report.criteria.filter((c) => !c.ok && BLOCKING.has(c.id)).map((c) => c.id);
  if (blocked.length) return skip(`${blocked.join(' y ')} en rojo: el sandbox no se arranca`);

  const { spec } = sandbox;
  const app = containerOf(sandbox, spec.app.service);
  const tool = containerOf(sandbox, spec.tool.service);
  const db = spec.database ? containerOf(sandbox, spec.database.service) : null;
  const project = composeProject(sandbox);

  if (up) {
    const r = rt.compose(sandbox.composeFile, project, ['up', '-d']);
    if (r.status !== 0) {
      push(criterion('VER-UP', false, `compose up falló: ${tail(r.stderr || r.stdout)}`));
      return skip('no arrancó');
    }
  }
  const ready = await waitReady(rt, tool, spec, pollMs);
  if (!push(criterion('VER-UP', ready.ok, ready.detail))) return skip('la app no responde');

  push(egressCriterion(rt, app, tool, spec.egress?.targets ?? DEFAULT_EGRESS));

  const read = probe(rt, tool, spec.app.base, spec.judge.read, nonce);
  push(criterion('VER-READ', read.ok, read.detail));

  const before = spec.database ? dbFingerprint(rt, db, spec.database) : null;
  const write = probe(rt, tool, spec.app.base, spec.judge.write, nonce);
  push(criterion('VER-WRITE', write.ok, write.detail));
  if (spec.database) {
    const after = dbFingerprint(rt, db, spec.database);
    const traced = before.ok && after.ok && before.value !== after.value;
    push(
      criterion(
        'VER-DB-TRACE',
        traced,
        !before.ok || !after.ok
          ? `no se pudo leer la base: ${before.error ?? after.error}`
          : traced
            ? `la escritura cambió ${spec.database.tech}/${spec.database.name}`
            : `la escritura respondió ${write.status} y la base ${spec.database.name} no cambió: la app no escribe donde el sandbox cree`
      )
    );
  } else {
    push(criterion('VER-DB-TRACE', true, 'el legacy no tiene base (sin database en sandbox.yaml)'));
  }

  const cov = await coverageCriterion(rt, sandbox, app, tool, pollMs);
  report.coverage = cov.coverage;
  push(cov.criterion);

  report.ok = report.criteria.every((c) => c.ok);
  if (report.ok && snapshot && spec.database) {
    const s = databaseAdapter(spec.database.tech)?.takeSnapshot(rt, db, spec.database) ?? { ok: false, error: `snapshot sin implementar para ${spec.database.tech}` };
    report.snapshot = s;
    if (!s.ok) report.ok = false;
  }
  return report;
}

function finish(report) {
  report.ok = report.criteria.every((c) => c.ok);
  return report;
}

function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

// ── sondas HTTP por el contenedor de herramientas ─────────────────────────────────────────────

function curlArgs(base, p, nonce) {
  const fill = (s) => String(s).replaceAll('{{nonce}}', nonce);
  const args = ['curl', '-sS', '-m', '20', '-o', '-', '-w', '\n@@STATUS %{http_code}', '-X', p.method];
  for (const [k, v] of Object.entries(p.headers ?? {})) args.push('-H', `${k}: ${fill(v)}`);
  let input;
  if (p.body !== undefined) {
    input = fill(typeof p.body === 'string' ? p.body : JSON.stringify(p.body));
    if (typeof p.body !== 'string' && !Object.keys(p.headers ?? {}).some((k) => k.toLowerCase() === 'content-type')) args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', '@-');
  }
  args.push(fill(base.replace(/\/$/, '') + p.path));
  return { args, input };
}

export function probe(rt, tool, base, p, nonce) {
  const { args, input } = curlArgs(base, p, nonce);
  const r = rt.exec(tool, args, input !== undefined ? { input } : {});
  const m = /\n@@STATUS (\d{3})\s*$/.exec(r.stdout);
  const status = m ? Number(m[1]) : 0;
  const body = m ? r.stdout.slice(0, m.index) : r.stdout;
  const label = `${p.method} ${p.path}`;
  if (!status) return { ok: false, status, detail: `${label}: sin respuesta (${tail(r.stderr) || `curl ${r.status}`})` };
  const ok = p.expect.includes(status);
  return {
    ok,
    status,
    detail: ok ? `${label} → ${status}` : `${label} → ${status}, se esperaba ${p.expect.join('/')}${status >= 500 ? ' (5xx)' : ''}: ${tail(body, 200)}`,
  };
}

export async function waitReady(rt, tool, spec, pollMs) {
  const deadline = Date.now() + (spec.app.startup_seconds ?? 180) * 1000;
  let last = '';
  for (;;) {
    const r = rt.exec(tool, ['curl', '-s', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}', spec.app.base.replace(/\/$/, '') + spec.judge.read.path]);
    const code = r.stdout.trim();
    if (/^\d{3}$/.test(code) && code !== '000') return { ok: true, detail: `${spec.app.base} responde (${code})` };
    last = tail(r.stderr) || `curl ${r.status}`;
    if (Date.now() > deadline) return { ok: false, detail: `${spec.app.base} no respondió en ${spec.app.startup_seconds ?? 180} s (${last})` };
    await sleep(pollMs);
  }
}

// ── egreso, desde las redes DE LA APP ─────────────────────────────────────────────────────────
// Un contenedor nuevo en cada red a la que está enganchada la app ve lo mismo que ella: la app no
// tiene otra salida porque VER-NET-INTERNAL ya prohibió `network_mode` y las redes no internas.
// (`--network container:<app>` sería más directo, pero podman-compose mete los servicios en un
// pod y podman no deja compartir la red de un contenedor de un pod desde fuera de él.)

export function egressCriterion(rt, app, tool, targets) {
  const image = rt.image(tool);
  const networks = rt.networks(app);
  if (networks.length === 0) return criterion('VER-EGRESS', false, `no se pudieron leer las redes de ${app}`);
  const open = [];
  const seen = [];
  for (const network of networks) {
    for (const target of targets) {
      const r = rt.run(['--network', network, '--entrypoint', 'curl', image, '-sS', '-o', '/dev/null', '-m', '8', '-w', '%{http_code}', target]);
      const code = r.stdout.trim();
      if (r.status === 0 || (/^\d{3}$/.test(code) && code !== '000')) open.push(`${network} → ${target} → ${code || 'conecta'}`);
      else if (!BLOCKED_CURL.has(r.status)) open.push(`${network} → ${target}: curl salió ${r.status}, que no prueba el bloqueo (${tail(r.stderr, 120)})`);
      else seen.push(`${network} → ${target}: curl ${r.status}`);
    }
  }
  return criterion('VER-EGRESS', open.length === 0, open.length ? `la app sale a internet: ${open.join('; ')}` : `sin salida (${seen.join(', ')})`);
}

// ── base ──────────────────────────────────────────────────────────────────────────────────────

export function dbFingerprint(rt, db, database) {
  const adapter = databaseAdapter(database.tech);
  if (!adapter) return { ok: false, error: `rastro de escritura sin implementar para ${database.tech}` };
  return adapter.fingerprint(rt, db, database);
}

// ── cobertura ─────────────────────────────────────────────────────────────────────────────────

async function coverageCriterion(rt, sandbox, app, tool, pollMs) {
  const cov = sandbox.spec.coverage;
  let result;
  let error = null;
  if (cov.kind === 'jacoco') {
    const port = String(cov.port ?? 6300);
    const dump = rt.exec(app, ['java', '-jar', cov.cli, 'dump', '--address', 'localhost', '--port', port, '--destfile', '/tmp/recover-verify.exec']);
    const rep = dump.status === 0 ? rt.exec(app, ['java', '-jar', cov.cli, 'report', '/tmp/recover-verify.exec', '--classfiles', cov.classes, '--csv', '/tmp/recover-verify.csv']) : dump;
    const csv = rep.status === 0 ? rt.exec(app, ['cat', '/tmp/recover-verify.csv']) : rep;
    if (csv.status !== 0) error = `no se pudo volcar JaCoCo: ${tail(csv.stderr || csv.stdout)}`;
    else result = readJacocoCsv(csv.stdout);
  } else {
    // nyc y v8 escriben al salir: se para la app, se lee el directorio y se vuelve a arrancar.
    rt.stop(app);
    const image = rt.image(tool);
    // Como root: Node escribe la cobertura con permisos 600 del usuario de la app, y la imagen de
    // la herramienta no corre como root.
    const dump = rt.run(['--user', '0', '--volumes-from', app, '--entrypoint', 'sh', image, '-c', `find ${shq(cov.dir)} -name '*.json' -type f | sort | while read f; do echo "@@FILE $f"; cat "$f"; echo; done`]);
    rt.start(app);
    const files = splitDump(dump.stdout);
    if (dump.status !== 0) error = `no se pudo leer ${cov.dir}: ${tail(dump.stderr)}`;
    else result = cov.kind === 'nyc' ? readIstanbul(parseJsonFiles(files), cov.include) : readV8(parseJsonFiles(files), cov.include);
    const again = await waitReady(rt, tool, sandbox.spec, pollMs);
    if (!again.ok && !error) error = `la app no volvió tras volcar la cobertura: ${again.detail}`;
  }
  if (error) return { coverage: null, criterion: criterion('VER-COVERAGE', false, error) };
  const ok = result.covered > 0;
  return {
    coverage: result,
    criterion: criterion('VER-COVERAGE', ok, ok ? `${cov.kind}: ${result.covered}/${result.total} ${unitEs(result.unit)} de la app en ${result.files} archivo(s)` : `${cov.kind}: nada del código de la app quedó grabado (${result.files} archivo(s) de la app)`),
  };
}

function unitEs(unit) {
  return { lines: 'líneas', statements: 'sentencias', functions: 'funciones' }[unit] ?? unit;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
