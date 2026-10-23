import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { LEGACY_DIR } from './helpers/golden.js';
import { tmpDir } from './helpers/tmp.js';
import { kebab, mergeEnvironment, planInit, writePlan } from '../src/lib/init.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'src', 'cli.js');

function workspace() {
  const ws = tmpDir('recover-ws-');
  fs.mkdirSync(path.join(ws, 'schema'));
  fs.writeFileSync(path.join(ws, 'schema', 'service.schema.json'), '{}');
  return ws;
}

test('init escribe legacy/<servicio>/ y las skills del sandbox y del diseño para cada harness', () => {
  const ws = workspace();
  const plan = planInit({ workspace: ws, repo: path.join(LEGACY_DIR, 'node14'), name: 'Orders API' });
  assert.equal(plan.service, 'orders-api');
  const paths = plan.files.map((f) => f.path);
  for (const p of ['legacy/orders-api/legacy.yaml', 'legacy/orders-api/runtime.yaml', 'legacy/orders-api/environment.yaml', 'legacy/orders-api/sandbox/instrument/v8-coverage-exit.cjs', 'legacy/orders-api/sandbox/instrument/express-routes.cjs']) {
    assert.ok(paths.includes(p), p);
  }
  // las tres skills: la del sandbox (pasos 0c-0e), la del diseño (pasos 3 y 4) y la orquestadora, con sus referencias
  for (const skill of ['keel-recover-sandbox', 'keel-recover', 'keel-recover-run']) {
    assert.ok(paths.includes(`.claude/skills/${skill}/SKILL.md`), skill);
    assert.ok(paths.some((p) => p.startsWith('.opencode/') && p.includes(`/${skill}/`)), skill);
  }
  assert.ok(paths.includes('.claude/skills/keel-recover/references/characterization.md'));
  assert.ok(paths.includes('.claude/skills/keel-recover/references/exploration.md'));
  // los subagentes de /keel-recover-run, en los dos harnesses
  for (const agent of ['keel-recover-sandbox', 'keel-recover-explorer', 'keel-recover-designer']) {
    assert.ok(paths.includes(`.claude/agents/${agent}.md`), agent);
    assert.ok(paths.some((p) => p.startsWith('.opencode/') && p.endsWith(`/${agent}.md`)), agent);
  }
  // sin rutas de harness ni tokens sin proyectar en lo que se siembra
  for (const f of plan.files.filter((x) => /keel-recover/.test(x.path) && !x.path.startsWith('legacy/'))) {
    assert.ok(!/\{\{keel:/.test(f.content), `${f.path} con un token sin proyectar`);
  }
  const legacy = YAML.parse(plan.files.find((f) => f.path.endsWith('legacy.yaml')).content);
  assert.equal(path.resolve(ws, 'legacy/orders-api', legacy.repo), path.join(LEGACY_DIR, 'node14'));
});

test('repetir init conserva lo que puso el agente: adaptaciones y la imagen de cada provisión', () => {
  const ws = workspace();
  const repo = path.join(LEGACY_DIR, 'java8-maven');
  writePlan(ws, planInit({ workspace: ws, repo, name: 'inventory' }).files);
  const file = path.join(ws, 'legacy/inventory/environment.yaml');
  const env = YAML.parse(fs.readFileSync(file, 'utf8'));
  env.adaptations = [{ what: 'mongo:4.4', why: 'el driver de Spring Boot 1.5 no habla con 7.0' }];
  env.dependencies.find((d) => d.tech === 'mongodb').provision.image = 'docker.io/library/mongo:4.4';
  fs.writeFileSync(file, YAML.stringify(env));
  writePlan(ws, planInit({ workspace: ws, repo, name: 'inventory' }).files);
  const again = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(again.adaptations, env.adaptations);
  assert.equal(again.dependencies.find((d) => d.tech === 'mongodb').provision.image, 'docker.io/library/mongo:4.4');
  assert.deepEqual(again.dependencies.find((d) => d.tech === 'mongodb').provision.aliases, ['inventory-db']);
});

test('la fusión no deja que el agente pise lo que es de la herramienta', () => {
  const fresh = { dependencies: [{ kind: 'database', tech: 'mongodb', endpoints: [{ host: 'db' }], provision: { via: 'container', aliases: ['db'] } }], adaptations: [] };
  const previous = { dependencies: [{ kind: 'database', tech: 'mongodb', endpoints: [{ host: 'db' }], provision: { via: 'ask', aliases: ['otra'], image: 'mongo:4.4' } }], adaptations: [{ what: 'x', why: 'y' }] };
  const out = mergeEnvironment(fresh, previous);
  assert.deepEqual(out.dependencies[0].provision, { via: 'container', aliases: ['db'], image: 'mongo:4.4' });
});

test('init se niega fuera de un workspace y con el repo dentro de legacy/<servicio>/', () => {
  const outside = tmpDir('recover-nows-');
  const r = spawnSync(process.execPath, [cli, 'init', path.join(LEGACY_DIR, 'node14'), '--workspace', outside], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no es un workspace/);
  const ws = workspace();
  const inside = path.join(ws, 'legacy', 'svc', 'src');
  fs.cpSync(path.join(LEGACY_DIR, 'node14'), inside, { recursive: true });
  assert.throws(() => planInit({ workspace: ws, repo: inside, name: 'svc' }), /no puede vivir dentro/);
});

test('kebab', () => {
  assert.equal(kebab('sockshop_orders'), 'sockshop-orders');
  assert.equal(kebab('RealWorldNode'), 'real-world-node');
});

test('los assets de keel-recover no citan rutas de harness: para eso están los tokens', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.claude\/|\.opencode\//.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(pkgRoot, full));
    }
  };
  walk(path.join(pkgRoot, 'assets'));
  assert.deepEqual(offenders, []);
});

test('el compose y el sandbox.yaml de la fixture en vivo pasan los criterios estáticos', async () => {
  const { loadSandbox } = await import('../src/lib/sandbox.js');
  const { staticCriteria } = await import('../src/lib/verify-static.js');
  const { renderDoc } = await import('../src/lib/emit.js');
  const { fingerprint } = await import('../src/lib/fingerprint.js');
  const work = tmpDir('recover-fixture-');
  fs.cpSync(path.join(pkgRoot, 'fixtures', 'sandbox', 'node-mongo'), work, { recursive: true });
  fs.writeFileSync(path.join(work, 'runtime.yaml'), renderDoc(fingerprint(path.join(work, 'repo'))).text);
  const sb = loadSandbox(path.join(work, 'sandbox'));
  assert.deepEqual(sb.errors, []);
  assert.deepEqual(staticCriteria(sb).filter((c) => !c.ok), []);
});
