// La vista con la que se compara el go.mod (src/lib/digest-views.js): quita lo que añade `go mod tidy` —el paso que
// el propio build prescribe— y nada de lo que decide build. Sin ella, la corrida 7d le atribuyó al agente un go.mod que
// solo había completado tidy, y un `--refresh` lo habría visto TOCADO para siempre.
//
// Tres propiedades: es la IDENTIDAD sobre lo que emite build en todas las fixtures (si no, los manifiestos ya escritos
// dejan de casar); devuelve lo de build a partir de lo que deja tidy, con las dos formas en que tidy lo escribe; y sigue
// VIENDO lo que build decide (un directo, la versión de una herramienta, el bloque tool).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planService } from '../src/scaffold/index.js';
import { DIGEST_VIEWS, goModView } from '../src/lib/digest-views.js';
import { FIXTURES_DIR, GO_READY_DESIGN, makeWorkspace, mountDesign, runCommand } from './helpers/workspace.js';
import { goView } from './helpers/contract.js';
import { build } from '../src/commands/build.js';
import { digestOf } from '@keel-system/keel-core';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const goModOf = (plan) => plan.files.find((file) => file.path === 'go.mod').content;

const BUILT = goModOf(planService({ ...goView(GO_READY_DESIGN.name), workspace: FIXTURES_DIR }));

/** Los `// indirect` que añadió tidy en la corrida 7d, una muestra de los 33. */
const TIDY_ADDED = [
  '\tgithub.com/jackc/pgpassfile v1.0.0 // indirect',
  '\tgithub.com/spf13/cobra v1.7.0 // indirect',
  '\tgolang.org/x/text v0.43.0 // indirect',
  '\tk8s.io/klog/v2 v2.90.1 // indirect'
];

/** Lo que deja tidy: los indirectos nuevos FUNDIDOS y ordenados en el bloque de las herramientas (lo que se midió). */
function tidiedMerged(goMod) {
  return goMod.replace(/require \(\n((?:\t\S+ \S+ \/\/ indirect\n)+)\)/, (_, block) => {
    const lines = [...block.trimEnd().split('\n'), ...TIDY_ADDED].sort();
    return `require (\n${lines.join('\n')}\n)`;
  });
}

/** La otra forma posible: un bloque aparte, que tras quitar sus líneas queda vacío. */
const tidiedSeparate = (goMod) => goMod.replace(/\ntool \(/, `\nrequire (\n${TIDY_ADDED.join('\n')}\n)\n\ntool (`);

test('sobre lo que emite build es la identidad, en todas las fixtures y en los dos motores', () => {
  let measured = 0;
  for (const name of fixtures) {
    for (const stack of [null, { database: 'mysql' }]) {
      const goMod = goModOf(planService({ ...goView(name), workspace: FIXTURES_DIR, ...(stack ? { stack } : {}) }));
      assert.equal(goModView(goMod), goMod, `${name}${stack ? ' (mysql)' : ''}`);
      measured += 1;
    }
  }
  assert.ok(measured >= 30, `solo ${measured}`);
});

test('devuelve lo de build a partir de lo que deja go mod tidy, en sus dos formas', () => {
  assert.notEqual(tidiedMerged(BUILT), BUILT, 'la muestra tiene que cambiar el archivo');
  assert.equal(goModView(tidiedMerged(BUILT)), BUILT);
  assert.equal(goModView(tidiedSeparate(BUILT)), BUILT);
});

test('sigue viendo lo que decide build: un directo, la versión de una herramienta y el bloque tool', () => {
  const tidied = tidiedMerged(BUILT);
  const cases = {
    'un directo cambiado': tidied.replace(/(\tgithub\.com\/google\/uuid) v\S+/, '$1 v1.5.0'),
    'un directo pasado a indirecto': tidied.replace(/(\tgithub\.com\/google\/uuid v\S+)/, '$1 // indirect'),
    'la versión de una herramienta': tidied.replace(/(\thonnef\.co\/go\/tools) v\S+ \/\/ indirect/, '$1 v0.7.0 // indirect'),
    'una herramienta de menos': tidied.replace(/\n\tgotest\.tools\/gotestsum\n/, '\n'),
    'el toolchain': tidied.replace(/toolchain go\S+/, 'toolchain go1.27.9')
  };
  for (const [label, edited] of Object.entries(cases)) {
    assert.notEqual(edited, tidied, `${label}: el caso no aplicó`);
    assert.notEqual(goModView(edited), BUILT, label);
  }
});

test('el módulo de una herramienta es el de ruta más larga que la contiene, como en Go', () => {
  const goMod = `module m

go 1.27.0

require (
\texample.com/a v1.0.0 // indirect
\texample.com/a/tools v1.0.0 // indirect
)

tool example.com/a/tools/cmd/x
`;
  assert.equal(goModView(goMod), goMod.replace('\texample.com/a v1.0.0 // indirect\n', ''));
});

test('es la vista que build registra para go.mod y para nada más', () => {
  assert.deepEqual(Object.keys(DIGEST_VIEWS), ['go.mod']);
});

// De punta a punta: tras tidy, --check sigue «al día» y --refresh no deshace lo que escribió tidy.
test('build: el go.mod completado por tidy no es deriva ni se reescribe al refrescar', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN);
  const spec = `specs/${GO_READY_DESIGN.name}`;
  await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true });
  const goModPath = path.join(workspace, 'services', `${GO_READY_DESIGN.name}-go`, 'go.mod');
  const tidied = tidiedMerged(fs.readFileSync(goModPath, 'utf8'));
  fs.writeFileSync(goModPath, tidied);

  const check = await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true, check: true });
  assert.equal(check.exitCode, undefined, check.output);
  await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true, refresh: true });
  assert.equal(fs.readFileSync(goModPath, 'utf8'), tidied);
});

// El daño que la vista evita: un go.mod que escribió un keel-go ANTERIOR y que después completó tidy tiene que
// refrescarse cuando el generador cambia un directo. Sin vista era un conflicto: el arreglo no llegaba nunca.
test('build: un go.mod de un keel-go anterior, completado por tidy, se refresca', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN);
  const spec = `specs/${GO_READY_DESIGN.name}`;
  await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true });
  const project = path.join(workspace, 'services', `${GO_READY_DESIGN.name}-go`);
  const goModPath = path.join(project, 'go.mod');
  const current = fs.readFileSync(goModPath, 'utf8');

  // Lo que habría escrito el keel-go anterior (otro directo) y su registro en el manifiesto, tal como lo dejaba build.
  const previous = current.replace(/(\tgithub\.com\/google\/uuid) v\S+/, '$1 v1.5.0');
  assert.notEqual(previous, current);
  const manifestPath = path.join(project, 'keel-generated.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['go.mod'] = digestOf({ content: previous });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(goModPath, tidiedMerged(previous));

  await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true, refresh: true });
  assert.equal(fs.readFileSync(goModPath, 'utf8'), current);
});
