import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { rewriteManifestForDerivation, rewriteScenariosForDerivation, stampAdoptedManifest } from '../src/lib/derive.js';
import { schemaPathFor } from '../src/lib/assets.js';
import { loadRegistryIndex } from '../src/lib/registry-source.js';
import { createService } from '../src/commands/new.js';
import {
  MANIFEST_ORIGIN,
  REGISTRY_FILES,
  REGISTRY_URL,
  SCENARIOS_ORIGIN,
  makeWorkspace,
  registryFixture,
  withRegistry
} from './helpers/registry.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

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

test('stampAdoptedManifest solo añade el linaje: adoptar no reescribe identidad', () => {
  const out = stampAdoptedManifest(MANIFEST_ORIGIN, { basedOn: 'billing@1.2.0' });

  assert.match(out, /basedOn: billing@1\.2\.0/);
  // Lo que derivar sí cambia y adoptar no.
  assert.match(out, /name: billing\b/);
  assert.match(out, /version: 1\.2\.0/);
  assert.match(out, /description: Gestiona la facturación de pedidos\./);
  assert.doesNotMatch(out, /TODO/);
  assert.match(out, /# kebab-case/);
});

test('rewriteScenariosForDerivation reapunta la ruta y conserva la versión del origen', () => {
  const out = rewriteScenariosForDerivation(SCENARIOS_ORIGIN, { name: 'billing-eu' });

  assert.match(out, /^> specs\/billing-eu v1\.2\.0\. Derivados/m);
  // La versión no se toca: el manifiesto derivado nace en 0.1.0, así que el sello
  // heredado es justo lo que deja los escenarios `stale` en keel describe.
  assert.doesNotMatch(out, /v0\.1\.0/);
  assert.match(out, /## FL-1 Emitir factura/);
});

test('rewriteScenariosForDerivation deja intacto un archivo sin cabecera de sello', () => {
  const source = '# escenarios\n\n## FL-1\n';
  assert.equal(rewriteScenariosForDerivation(source, { name: 'billing-eu' }), source);
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
  // Adoptar estampa el mismo nombre y versión que el servicio: el schema no lo impide.
  assert.equal(check(manifest('billing-eu@0.1.0')), true, JSON.stringify(check.errors));
});

test('keel new --from clona las capas, reescribe el manifiesto y hereda validation-scenarios.md', (t) => {
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

  // Los escenarios llegan como punto de partida, con la ruta reapuntada y el
  // sello del origen: `keel describe` los verá stale, que es lo que toca hasta
  // que se regeneren al cerrar el diseño derivado.
  const scenarios = fs.readFileSync(path.join(destDir, 'validation-scenarios.md'), 'utf8');
  assert.match(scenarios, /^> specs\/billing-eu v1\.2\.0\./m);
  assert.match(scenarios, /## FL-1 Emitir factura/);
});

test('keel new --from deriva igual si el origen no tiene escenarios', (t) => {
  const base = makeWorkspace(t);
  fs.rmSync(path.join(base, 'specs', 'billing', 'validation-scenarios.md'));

  createService('billing-eu', { from: 'billing' });

  assert.notEqual(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'validation-scenarios.md')), false);
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

// --- Derivación desde el registry -----------------------------------------

test('keel new --from registry trae solo el spec: los derivados del origen no se copian', async (t) => {
  const base = makeWorkspace(t);
  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES }));

  await createService('billing-eu', { from: 'registry:billing', ...registry });

  assert.notEqual(process.exitCode, 1);
  assert.match(fs.readFileSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml'), 'utf8'), /basedOn: billing@1\.2\.0/);

  // Derivar implica completar el diseño: DESIGN.md, contratos y panel del origen
  // describen al servicio del origen y se regeneran al cerrar. No hay origin/.
  assert.equal(fs.existsSync(path.join(base, 'docs', 'billing-eu')), false);

  // Los escenarios sí, porque viven en el spec.
  assert.match(
    fs.readFileSync(path.join(base, 'specs', 'billing-eu', 'validation-scenarios.md'), 'utf8'),
    /^> specs\/billing-eu v1\.2\.0\./m
  );
});

test('derivar del registry revalida el índice aunque la caché siga dentro del TTL', async (t) => {
  const base = makeWorkspace(t);
  // El índice viejo no listaba las capas nuevas: derivar de él dejaría el spec
  // incompleto y en silencio.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const viejo = { ...REGISTRY_FILES };
  delete viejo['specs/billing/validation-scenarios.md'];
  await loadRegistryIndex({ source: REGISTRY_URL, fetchImpl: registryFixture({ files: viejo }), cacheDir, env: {} });

  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES }));
  await createService('billing-eu', { from: 'registry:billing', ...registry, cacheDir });

  assert.notEqual(process.exitCode, 1);
  assert.ok(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'validation-scenarios.md')));
});

test('derivar con --offline no toca la red para el índice: se sirve de la caché', async (t) => {
  const base = makeWorkspace(t);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  await loadRegistryIndex({
    source: REGISTRY_URL,
    fetchImpl: registryFixture({ files: REGISTRY_FILES }),
    cacheDir,
    env: {}
  });

  let indexHits = 0;
  const fetchImpl = registryFixture({ files: REGISTRY_FILES });
  const registry = withRegistry(t, async (url) => {
    if (String(url) === REGISTRY_URL) indexHits += 1;
    return fetchImpl(url);
  });

  await createService('billing-eu', { from: 'registry:billing', ...registry, offline: true, cacheDir });

  assert.notEqual(process.exitCode, 1);
  assert.equal(indexHits, 0);
  assert.ok(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml')));
});

test('keel new --from falla si el YAML del origen está roto', (t) => {
  const base = makeWorkspace(t);
  fs.writeFileSync(path.join(base, 'specs', 'billing', 'domain.keel.yaml'), 'entities: [inválido\n');

  createService('billing-eu', { from: 'billing' });

  assert.equal(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu')), false);
});
