#!/usr/bin/env node
// bench-verify: el juez (keel-recover verify) contra los tres sandboxes que el incremento 1 montó a
// mano en ../keel-recover-lab. Cubre lo que la fixture en vivo (verify-check) no ejercita: JaCoCo
// en tcpserver (sockshop) y nyc en Node 8 (RealWorld), motores antiguos y un broker.
//
// No escribe en el laboratorio: copia cada sandbox a un temporal, genera runtime.yaml y
// environment.yaml con la propia herramienta (con las adaptaciones que el inc. 1 escribió a mano)
// y le añade el sandbox.yaml con las sondas que el inc. 1 midió con éxito. Necesita las imágenes
// `recover/<legacy>:sandbox` que dejó el inc. 1 (sandbox/build.sh de cada legacy las reconstruye).
//
//   node scripts/bench-verify.js [--lab=<ruta>] [--only=<legacy>] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderDoc } from '../src/lib/emit.js';
import { fingerprint } from '../src/lib/fingerprint.js';
import { envDeps } from '../src/lib/env-deps.js';
import { loadSandbox, composeProject } from '../src/lib/sandbox.js';
import { containerRuntime, resolveRuntime } from '../src/lib/containers.js';
import { verify } from '../src/lib/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const lab = path.resolve(arg('lab') ?? path.join(here, '..', '..', '..', '..', 'keel-recover-lab'));
const only = arg('only');
const keep = process.argv.includes('--keep');

const order = {
  customer: 'http://user/customers/57a98d98e4b00679b4a830b5',
  address: 'http://user/addresses/57a98d98e4b00679b4a830b3',
  card: 'http://user/cards/57a98d98e4b00679b4a830b4',
  items: 'http://carts/carts/57a98d98e4b00679b4a830b5/items',
};
const jacoco = { kind: 'jacoco', cli: '/opt/jacoco/jacococli.jar', classes: '/opt/app/classes' };
// Las rutas de sockshop (Spring 4) salen de las líneas Mapped del log de arranque: el /mappings de su actuator no lista
// ni el POST /orders propio ni Spring Data REST (surface.yaml del inc. 1).
const springLog = { routes: { kind: 'spring-log' } };

// El sandbox.yaml de cada legacy, desde lo que midió el inc. 1 (probe.json, rondas y LOG.md).
const SANDBOXES = {
  'sockshop-shipping': {
    app: { service: 'app', base: 'http://shipping:8080' },
    coverage: jacoco,
    introspection: springLog,
    judge: {
      read: { method: 'GET', path: '/shipping', expect: [200] },
      write: { method: 'POST', path: '/shipping', body: { id: '{{nonce}}', name: 'verify' }, expect: [201] },
    },
  },
  'sockshop-orders': {
    app: { service: 'app', base: 'http://orders:8082' },
    database: { service: 'orders-db', tech: 'mongodb', name: 'data' },
    coverage: jacoco,
    introspection: springLog,
    judge: {
      read: { method: 'GET', path: '/orders', expect: [200] },
      write: { method: 'POST', path: '/orders', body: order, expect: [201] },
    },
  },
  'realworld-node': {
    app: { service: 'app', base: 'http://conduit:3000' },
    database: { service: 'mongo', tech: 'mongodb', name: 'conduit' },
    coverage: { kind: 'nyc', dir: '/coverage' },
    // La precarga que ya carga su compose (NODE_OPTIONS). El compose del inc. 1 la escribe en /tmp, que introspect no
    // alcanza (lee por --volumes-from): en la COPIA va a un volumen propio, fuera de /coverage porque nyc lee todo *.json
    // de ahí. Es lo que el sandbox de la herramienta tiene que hacer para pasar VER-ROUTES (medido: con /tmp, en rojo).
    introspection: { routes: { kind: 'express', file: '/recover-routes/routes.json' } },
    compose: (c) => {
      c.services.app.environment.RECOVER_ROUTES_OUT = '/recover-routes/routes.json';
      c.services.app.volumes.push('routes:/recover-routes');
      c.volumes.routes = {};
    },
    judge: {
      read: { method: 'GET', path: '/api/tags', expect: [200] },
      write: {
        method: 'POST',
        path: '/api/users',
        body: { user: { username: 'verify{{nonce}}', email: 'verify-{{nonce}}@recover.invalid', password: 'recover-sandbox' } },
        expect: [200],
      },
    },
  },
};

const runtime = resolveRuntime();
if (!runtime) {
  console.error('bench-verify necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-bench-verify-'));
fs.cpSync(path.join(lab, 'tools'), path.join(work, 'tools'), { recursive: true });

const results = [];
for (const [legacy, partial] of Object.entries(SANDBOXES)) {
  if (only && only !== legacy) continue;
  const src = path.join(lab, legacy, 'src');
  const dir = path.join(work, legacy);
  fs.cpSync(path.join(lab, legacy, 'sandbox'), path.join(dir, 'sandbox'), {
    recursive: true,
    filter: (p) => !/\.log$|coverage|recordings/.test(path.basename(p)),
  });
  fs.writeFileSync(path.join(dir, 'runtime.yaml'), renderDoc(fingerprint(src)).text);
  const env = renderDoc(envDeps(src)).plain;
  env.adaptations = YAML.parse(fs.readFileSync(path.join(lab, legacy, 'environment.yaml'), 'utf8')).adaptations ?? [];
  fs.writeFileSync(path.join(dir, 'environment.yaml'), YAML.stringify(env));
  const { compose: patchCompose, ...spec } = partial;
  if (patchCompose) {
    const composeFile = path.join(dir, 'sandbox', 'compose.yaml');
    const compose = YAML.parse(fs.readFileSync(composeFile, 'utf8'));
    patchCompose(compose);
    fs.writeFileSync(composeFile, YAML.stringify(compose));
  }
  fs.writeFileSync(path.join(dir, 'sandbox', 'sandbox.yaml'), YAML.stringify({ kind: 'sandbox', schema: 1, compose: 'compose.yaml', tool: { service: 'tool' }, ...spec }));

  console.log(`\n── ${legacy}`);
  const sandbox = loadSandbox(path.join(dir, 'sandbox'));
  if (sandbox.errors.length) {
    console.log(`  ✗ ${sandbox.errors.join('; ')}`);
    results.push({ legacy, ok: false });
    continue;
  }
  rt.compose(sandbox.composeFile, composeProject(sandbox), ['down', '-v']);
  const report = await verify(sandbox, rt, { log: (c) => console.log(`  ${c.ok ? 'OK   ' : c.skipped ? '·    ' : 'ROJO '} ${c.id}  ${c.detail}`) });
  if (report.snapshot) console.log(`  ${report.snapshot.ok ? 'OK   ' : 'ROJO '} snapshot  ${report.snapshot.where ?? report.snapshot.error}`);
  results.push({ legacy, ok: report.ok, red: report.criteria.filter((c) => !c.ok).map((c) => c.id) });
  if (!keep) rt.compose(sandbox.composeFile, composeProject(sandbox), ['down', '-v']);
}
if (!keep) fs.rmSync(work, { recursive: true, force: true });
console.log('\n' + results.map((r) => `${r.ok ? '✓' : '✗'} ${r.legacy}${r.red?.length ? `  [${r.red.join(', ')}]` : ''}`).join('\n'));
process.exit(results.every((r) => r.ok) ? 0 : 1);
