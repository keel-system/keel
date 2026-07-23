import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { rewriteManifestForDerivation } from '../src/lib/derive.js';
import { schemaPathFor } from '../src/lib/assets.js';
import { createService } from '../src/commands/new.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

const MANIFEST_ORIGIN = `# Manifiesto del servicio
keel: "2.0"

service:
  name: billing            # kebab-case
  version: 1.2.0
  description: Gestiona la facturación de pedidos.
  domain: commerce

layers:
  domain: domain.keel.yaml
  use-cases: use-cases.keel.yaml
`;

test('rewriteManifestForDerivation reescribe identidad y conserva comentarios', () => {
  const out = rewriteManifestForDerivation(MANIFEST_ORIGIN, { name: 'billing-eu', basedOn: 'billing@1.2.0' });

  assert.match(out, /# Manifiesto del servicio/);
  assert.match(out, /# kebab-case/);
  assert.match(out, /name: billing-eu/);
  assert.match(out, /version: 0\.1\.0/);
  assert.match(out, /basedOn: billing@1\.2\.0/);
  assert.match(out, /description: "?TODO: revisar descripción heredada de billing — Gestiona la facturación de pedidos\./);
});

test('rewriteManifestForDerivation no doble-prefija una description ya pendiente', () => {
  const source = MANIFEST_ORIGIN.replace(
    'description: Gestiona la facturación de pedidos.',
    'description: "TODO: describe en una frase qué resuelve."'
  );
  const out = rewriteManifestForDerivation(source, { name: 'billing-eu', basedOn: 'billing@1.2.0' });

  assert.doesNotMatch(out, /revisar descripción heredada/);
  assert.match(out, /TODO: describe en una frase qué resuelve\./);
});

test('el schema del manifiesto acepta basedOn con formato servicio@versión y rechaza el resto', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(schemaPathFor('common'), 'utf8')));
  const check = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('service'), 'utf8')));

  const manifest = (basedOn) => ({
    keel: '2.0',
    service: { name: 'billing-eu', version: '0.1.0', description: 'Facturación para la región europea.', basedOn },
    layers: { domain: 'domain.keel.yaml', 'use-cases': 'use-cases.keel.yaml' }
  });

  assert.equal(check(manifest('billing@1.2.0')), true, JSON.stringify(check.errors));
  assert.equal(check(manifest('billing')), false);
  assert.equal(check(manifest('billing@1.2')), false);
});

function makeWorkspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-derive-'));
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  t.after(() => {
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
    fs.rmSync(base, { recursive: true, force: true });
  });

  // isKeelWorkspace solo comprueba que exista schema/service.schema.json
  fs.mkdirSync(path.join(base, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(base, 'schema', 'service.schema.json'), '{}');

  const originDir = path.join(base, 'specs', 'billing');
  fs.mkdirSync(originDir, { recursive: true });
  fs.writeFileSync(path.join(originDir, 'service.keel.yaml'), MANIFEST_ORIGIN);
  fs.writeFileSync(path.join(originDir, 'domain.keel.yaml'), 'entities:\n  Invoice:\n    fields: {}\n');
  fs.writeFileSync(path.join(originDir, 'use-cases.keel.yaml'), 'operations: {}\n');
  fs.writeFileSync(path.join(originDir, 'validation-scenarios.md'), '# escenarios\n');

  process.chdir(base);
  return base;
}

test('keel new --from clona las capas, reescribe el manifiesto y excluye validation-scenarios.md', (t) => {
  const base = makeWorkspace(t);

  createService('billing-eu', { from: 'billing' });

  assert.notEqual(process.exitCode, 1);
  const destDir = path.join(base, 'specs', 'billing-eu');
  const manifest = fs.readFileSync(path.join(destDir, 'service.keel.yaml'), 'utf8');
  assert.match(manifest, /name: billing-eu/);
  assert.match(manifest, /basedOn: billing@1\.2\.0/);
  assert.equal(
    fs.readFileSync(path.join(destDir, 'domain.keel.yaml'), 'utf8'),
    fs.readFileSync(path.join(base, 'specs', 'billing', 'domain.keel.yaml'), 'utf8')
  );
  assert.equal(fs.existsSync(path.join(destDir, 'use-cases.keel.yaml')), true);
  assert.equal(fs.existsSync(path.join(destDir, 'validation-scenarios.md')), false);
});

test('keel new --from acepta el origen como ruta (specs/billing)', (t) => {
  const base = makeWorkspace(t);

  createService('billing-eu', { from: path.join('specs', 'billing') });

  assert.notEqual(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml')), true);
});

test('keel new --from falla si el origen no existe', (t) => {
  makeWorkspace(t);

  createService('billing-eu', { from: 'no-existe' });

  assert.equal(process.exitCode, 1);
});

test('keel new --from falla si origen y destino son el mismo servicio', (t) => {
  makeWorkspace(t);

  createService('billing', { from: 'billing' });

  assert.equal(process.exitCode, 1);
});

test('keel new --from falla si el YAML del origen está roto', (t) => {
  const base = makeWorkspace(t);
  fs.writeFileSync(path.join(base, 'specs', 'billing', 'domain.keel.yaml'), 'entities: [inválido\n');

  createService('billing-eu', { from: 'billing' });

  assert.equal(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu')), false);
});
