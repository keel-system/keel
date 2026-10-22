import { containerOf } from './sandbox.js';
import { waitReady } from './verify.js';
import { istanbulUncovered, jacocoUncovered, parseJsonFiles, readIstanbul, readJacocoCsv, readV8, splitDump, v8Uncovered } from './coverage.js';

// La cobertura de una RONDA de sondas (paso 1b). Dos números distintos y los dos hacen falta:
//   - el acumulado (todo lo ejecutado desde que arrancó el sandbox), que mide la completitud y
//     dice si la exploración se estanca;
//   - el de la ronda sola, que prueba que el medidor sigue grabando. Sin él, una app que dejó de
//     grabar a mitad del paso 1 seguiría mostrando el acumulado de antes y nadie lo vería.
// JaCoCo se vuelca en caliente (`dump --reset` deja el exec de la ronda sola, y el acumulado es su
// unión); nyc y V8 escriben al salir, así que la ronda se marca al empezar con un archivo testigo
// y se cuentan aparte los volcados más nuevos que él.

const JACOCO_DIR = '/tmp/keel-recover';
const MARK = (tag) => `.keel-recover-round-${tag}`;

function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const asRoot = (rt, app, tool, script) => rt.run(['--user', '0', '--volumes-from', app, '--entrypoint', 'sh', rt.image(tool), '-c', script]);

/** Al empezar la ronda: el testigo para nyc y V8 (JaCoCo no lo necesita). */
export function markRound(rt, sandbox, tag) {
  const cov = sandbox.spec.coverage;
  if (cov.kind === 'jacoco') return { ok: true };
  const app = containerOf(sandbox, sandbox.spec.app.service);
  const tool = containerOf(sandbox, sandbox.spec.tool.service);
  const r = asRoot(rt, app, tool, `mkdir -p ${shq(cov.dir)} && touch ${shq(`${cov.dir}/${MARK(tag)}`)}`);
  return r.status === 0 ? { ok: true } : { ok: false, error: `no se pudo marcar la ronda en ${cov.dir}: ${tail(r.stderr || r.stdout)}` };
}

/** Al terminar la ronda: `{ ok, error?, round, cumulative, uncovered }`. */
export async function dumpRound(rt, sandbox, tag, { pollMs = 2000 } = {}) {
  const cov = sandbox.spec.coverage;
  const app = containerOf(sandbox, sandbox.spec.app.service);
  const tool = containerOf(sandbox, sandbox.spec.tool.service);
  if (cov.kind === 'jacoco') return dumpJacoco(rt, app, cov, tag);

  rt.stop(app);
  const mark = `${cov.dir}/${MARK(tag)}`;
  const script =
    `find ${shq(cov.dir)} -name '*.json' -type f | sort | while read f; do echo "@@FILE $f"; cat "$f"; echo; done; ` +
    `[ -f ${shq(mark)} ] && find ${shq(cov.dir)} -name '*.json' -type f -newer ${shq(mark)} | sort | while read f; do echo "@@NEW $f"; done; true`;
  const dump = asRoot(rt, app, tool, script);
  rt.start(app);
  const again = await waitReady(rt, tool, sandbox.spec, pollMs);
  if (dump.status !== 0) return { ok: false, error: `no se pudo leer ${cov.dir}: ${tail(dump.stderr)}` };
  if (!again.ok) return { ok: false, error: `la app no volvió tras volcar la cobertura: ${again.detail}` };

  const fresh = new Set([...dump.stdout.matchAll(/^@@NEW (.+)$/gm)].map((m) => m[1].trim()));
  const files = splitDump(dump.stdout.replace(/^@@NEW .*$/gm, ''));
  const all = parseJsonFiles(files);
  const own = parseJsonFiles(files.filter((f) => fresh.has(f.path)));
  const read = cov.kind === 'nyc' ? readIstanbul : readV8;
  const cumulative = read(all, cov.include);
  const round = read(own, cov.include);
  let uncovered;
  if (cov.kind === 'nyc') uncovered = istanbulUncovered(all, cov.include);
  else uncovered = v8Uncovered(all, cov.include, appSources(rt, app, all, cov.include));
  return { ok: true, round, cumulative, uncovered };
}

// El fuente de los archivos de la app, para traducir los offsets de V8 a líneas.
function appSources(rt, app, docs, include) {
  const paths = new Set();
  for (const doc of docs) {
    for (const s of doc?.result ?? []) {
      const url = String(s.url ?? '');
      if (url.startsWith('file://') && !url.includes('/node_modules/') && (!include || url.includes(include))) paths.add(url.slice('file://'.length));
    }
  }
  const out = {};
  for (const p of paths) {
    const r = rt.exec(app, ['cat', p]);
    if (r.status === 0) out[p] = r.stdout;
  }
  return out;
}

function dumpJacoco(rt, app, cov, tag) {
  const java = (args) => rt.exec(app, ['java', '-jar', cov.cli, ...args]);
  const port = String(cov.port ?? 6300);
  const roundExec = `${JACOCO_DIR}/round-${tag}.exec`;
  rt.exec(app, ['mkdir', '-p', JACOCO_DIR]);
  const steps = [
    () => java(['dump', '--address', 'localhost', '--port', port, '--reset', '--destfile', roundExec]),
    () => java(['report', roundExec, '--classfiles', cov.classes, '--csv', `${JACOCO_DIR}/round.csv`]),
    () => rt.exec(app, ['sh', '-c', `java -jar ${shq(cov.cli)} merge ${JACOCO_DIR}/round-*.exec --destfile ${JACOCO_DIR}/all.exec`]),
    () => java(['report', `${JACOCO_DIR}/all.exec`, '--classfiles', cov.classes, '--csv', `${JACOCO_DIR}/all.csv`]),
  ];
  for (const step of steps) {
    const r = step();
    if (r.status !== 0) return { ok: false, error: `no se pudo volcar JaCoCo: ${tail(r.stderr || r.stdout)}` };
  }
  const roundCsv = rt.exec(app, ['cat', `${JACOCO_DIR}/round.csv`]);
  const allCsv = rt.exec(app, ['cat', `${JACOCO_DIR}/all.csv`]);
  if (roundCsv.status !== 0 || allCsv.status !== 0) return { ok: false, error: 'no se pudo leer el CSV de JaCoCo' };
  return { ok: true, round: readJacocoCsv(roundCsv.stdout), cumulative: readJacocoCsv(allCsv.stdout), uncovered: jacocoUncovered(allCsv.stdout) };
}
