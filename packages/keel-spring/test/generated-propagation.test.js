// Propagar un arreglo del generador a un proyecto que YA existe.
//
// El problema que resuelve: sin `--force` build omite todo lo que existe, así que un
// arreglo nunca llega; con `--force` lo sobrescribe todo, incluido el código que escribió
// el agente. La tercera vía necesita saber qué escribió build la última vez — comparar
// contenidos no basta, porque «diferente del stub» es exactamente lo esperado en cuanto
// el agente completa los TODO.
//
// Lo caro de no tenerlo, medido: cerrando la corrida `customer-refunds`, cinco escenarios
// del outbox tumbaron una pasada entera de ~20 minutos contra un `OutboxRelay` anterior a
// la métrica que acababa de añadirse al generador. Nada lo dijo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { digestOf } from 'keel-core';
import { build } from '../src/commands/build.js';

const SPEC = 'product-catalog';
const SKILL_REL = ['.claude', 'skills', 'keel-generate-spring', 'SKILL.md'];

function withFixture() {
  const workspace = tmpDir('keel-propagation-');
  fs.mkdirSync(path.join(workspace, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'schema', 'service.schema.json'), '{}');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', SPEC);
  const specDir = path.join(workspace, 'specs', SPEC);
  fs.mkdirSync(specDir, { recursive: true });
  fs.cpSync(fixture, specDir, { recursive: true });
  return workspace;
}

async function runBuild(workspace, options) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const silenced = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await build(`specs/${SPEC}`, options);
    return process.exitCode;
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, silenced);
  }
}

const projectOf = (workspace) => path.join(workspace, 'services', `${SPEC}-spring`);
const manifestPath = (workspace) => path.join(projectOf(workspace), 'keel-generated.json');
const readManifest = (workspace) => JSON.parse(fs.readFileSync(manifestPath(workspace), 'utf8'));
const saveManifest = (workspace, manifest) =>
  fs.writeFileSync(manifestPath(workspace), JSON.stringify(manifest, null, 2));

/** El archivo de build sobre el que se monta cada caso, y su ruta en el manifiesto. */
const skillPath = (workspace) => path.join(projectOf(workspace), ...SKILL_REL);
const SKILL_KEY = SKILL_REL.join('/');

test('build registra lo que escribió, que es lo que hace propagable un arreglo', async () => {
  const workspace = withFixture();
  await runBuild(workspace);

  const manifest = readManifest(workspace);
  assert.match(manifest.generator, /^keel-spring@/);
  assert.ok(Object.keys(manifest.files).length > 100, 'el manifiesto no registró el scaffolding');
  assert.deepEqual(manifest.adopted, [], 'un proyecto recién generado no adopta nada: build lo escribió todo');
});

test('--check no escribe nada y falla cuando el proyecto se quedó atrás', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  assert.equal(await runBuild(workspace, { check: true }), undefined, 'un proyecto al día no falla');

  // Un archivo de build al que NADIE ha tocado y que el generador ha cambiado: en disco
  // sigue estando lo que build escribió, así que su huella casa con el manifiesto.
  const viejo = 'lo que escribió un build anterior';
  fs.writeFileSync(skillPath(workspace), viejo);
  const manifest = readManifest(workspace);
  manifest.files[SKILL_KEY] = digestOf({ content: viejo });
  saveManifest(workspace, manifest);

  assert.equal(await runBuild(workspace, { check: true }), 1);
  assert.equal(fs.readFileSync(skillPath(workspace), 'utf8'), viejo, '--check escribió');
});

test('--refresh pone al día lo de build y NO toca lo que escribió el agente', async () => {
  const workspace = withFixture();
  await runBuild(workspace);

  const alDia = fs.readFileSync(skillPath(workspace), 'utf8');
  const manifest = readManifest(workspace);

  // (a) De build y sin tocar: refrescable.
  fs.writeFileSync(skillPath(workspace), 'version vieja');
  manifest.files[SKILL_KEY] = digestOf({ content: 'version vieja' });

  // (b) Tocado por el agente, con el generador sin cambiar: no hay nada que propagar, y
  //     pisarlo sería exactamente lo que hace `--force` y esto existe para evitar.
  const readme = path.join(projectOf(workspace), 'README.md');
  fs.writeFileSync(readme, `${fs.readFileSync(readme, 'utf8')}\nlo del agente`);
  saveManifest(workspace, manifest);

  await runBuild(workspace, { refresh: true });

  assert.equal(fs.readFileSync(skillPath(workspace), 'utf8'), alDia, 'lo de build no se puso al día');
  assert.ok(
    fs.readFileSync(readme, 'utf8').includes('lo del agente'),
    'el refresco pisó trabajo del agente: es justo lo que no puede hacer'
  );
});

test('un conflicto no se toca, y su versión nueva cae fuera de src/', async () => {
  const workspace = withFixture();
  await runBuild(workspace);

  // Las TRES versiones distintas: lo que hay, lo que build escribió, y lo que emite hoy.
  fs.writeFileSync(skillPath(workspace), 'lo que escribió el agente');
  const manifest = readManifest(workspace);
  manifest.files[SKILL_KEY] = digestOf({ content: 'lo que build escribió ANTES' });
  saveManifest(workspace, manifest);

  await runBuild(workspace, { refresh: true });

  assert.equal(
    fs.readFileSync(skillPath(workspace), 'utf8'),
    'lo que escribió el agente',
    'el conflicto se resolvió solo, que es la decisión que no le toca tomar'
  );

  // Fuera del árbol que leen los gates: check-idempotency.sh y check-domain-guards.sh
  // hacen `grep -rl` sobre src/, y acabarían juzgando código que no compila nadie.
  const copia = path.join(projectOf(workspace), 'build', 'keel-refresh', ...SKILL_REL);
  assert.ok(fs.existsSync(copia), 'no se dejó la versión nueva para poder compararla');
  assert.notEqual(fs.readFileSync(copia, 'utf8'), 'lo que escribió el agente');
});

test('un proyecto anterior al mecanismo adopta solo lo que difiere, y no se refresca', async () => {
  const workspace = withFixture();
  await runBuild(workspace);

  fs.writeFileSync(skillPath(workspace), 'lo que hubiera escrito un build anterior');
  fs.rmSync(manifestPath(workspace));

  await runBuild(workspace);
  const manifest = readManifest(workspace);
  // Se adopta SOLO lo que ya difiere de lo que el generador emite. Lo byte a byte
  // idéntico se registra como suyo: adoptarlo todo dejaba a los proyectos que ya
  // existían sin poder refrescar NUNCA —cada archivo quedaba para siempre «sin
  // registro»—, cuando ser idéntico a la salida del generador es la prueba más fuerte
  // que puede haber de que es suya.
  assert.deepEqual(manifest.adopted, [SKILL_KEY], 'se adoptó más de lo que de verdad difiere');
  assert.ok(Object.keys(manifest.files).length > 100, 'lo idéntico al generador no se registró');

  // Y refrescar no toca nada: no se sabe cuáles de esos archivos tocó el agente, así que
  // refrescar cualquiera sería jugársela con su trabajo. El valor es el aviso, no la
  // escritura.
  await runBuild(workspace, { refresh: true });
  assert.equal(fs.readFileSync(skillPath(workspace), 'utf8'), 'lo que hubiera escrito un build anterior');
});

test('--force reescribe todo y devuelve lo adoptado al registro de build', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  // Para que haya algo adoptado hace falta que difiera: lo idéntico se registra.
  fs.writeFileSync(skillPath(workspace), 'lo que hubiera escrito un build anterior');
  fs.rmSync(manifestPath(workspace));
  await runBuild(workspace);
  assert.deepEqual(readManifest(workspace).adopted, [SKILL_KEY]);

  await runBuild(workspace, { force: true });
  const manifest = readManifest(workspace);
  assert.deepEqual(manifest.adopted, [], 'tras un --force todo es de build otra vez');
  assert.ok(Object.keys(manifest.files).length > 100);
});
