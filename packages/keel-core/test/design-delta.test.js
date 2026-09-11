// El delta entre dos versiones de un diseño: lo que un generador necesita para evolucionar
// un proyecto que ya generó sin repetir la generación a ciegas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { diffDesigns } from '../src/lib/design-delta.js';
import { splitScenarioBlocks, scenarioBody, scenarioFamilyOf } from '../src/lib/scenario-blocks.js';

function design({ version = '1.0.0', layers = {}, scenarios = null }) {
  const dir = tmpDir('keel-delta-');
  const manifest = [
    'keel: "2.13"',
    'service:',
    '  name: demo',
    `  version: ${version}`,
    '  description: Servicio de prueba.',
    'layers:',
    ...Object.keys(layers).map((layer) => `  ${layer}: ${layer}.keel.yaml`)
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'service.keel.yaml'), `${manifest}\n`);
  for (const [layer, content] of Object.entries(layers)) {
    fs.writeFileSync(path.join(dir, `${layer}.keel.yaml`), content);
  }
  if (scenarios !== null) fs.writeFileSync(path.join(dir, 'validation-scenarios.md'), scenarios);
  return dir;
}

const USE_CASES_V1 = `operations:
  createThing:
    kind: command
    description: Crea.
  getThing:
    kind: query
    description: Lee.
  retireThing:
    kind: command
    description: Retira.
`;

const USE_CASES_V2 = `operations:
  # el orden cambia y no es un cambio de diseño
  getThing:
    description: Lee.
    kind: query
  createThing:
    kind: command
    description: Crea, ahora con otra regla.
  renameThing:
    kind: command
    description: Renombra.
`;

test('un diseño contra sí mismo no tiene delta', () => {
  const dir = design({ layers: { 'use-cases': USE_CASES_V1 } });
  const delta = diffDesigns(dir, dir);
  assert.equal(delta.empty, true);
  assert.deepEqual(delta.sections, []);
});

test('operaciones añadidas, quitadas y cambiadas — el orden de las claves no cuenta', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1 } });
  const next = design({ version: '1.1.0', layers: { 'use-cases': USE_CASES_V2 } });
  const delta = diffDesigns(prev, next);

  assert.equal(delta.from, '1.0.0');
  assert.equal(delta.to, '1.1.0');
  assert.equal(delta.empty, false);
  assert.deepEqual(delta.sections, [
    { layer: 'use-cases', section: 'operations', added: ['renameThing'], removed: ['retireThing'], changed: ['createThing'] }
  ]);
});

test('una capa añadida trae todo lo suyo como añadido, y una quitada como quitado', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1, api: 'style: rest\n' } });
  const next = design({
    layers: { 'use-cases': USE_CASES_V1, messaging: 'events:\n  ThingCreated:\n    description: Nació.\n' }
  });
  const delta = diffDesigns(prev, next);

  assert.deepEqual(delta.layers, { added: ['messaging'], removed: ['api'] });
  assert.deepEqual(
    delta.sections.find((entry) => entry.layer === 'messaging'),
    { layer: 'messaging', section: 'events', added: ['ThingCreated'], removed: [], changed: [] }
  );
  assert.deepEqual(delta.sections.find((entry) => entry.layer === 'api'), { layer: 'api', section: 'style', replaced: true });
});

const SCENARIOS_V1 = `# demo — Escenarios

## Alta

### FL-THG-001: se crea
Given nada. Then existe.

#### FL-THG-001-B: se reintenta
Given la misma clave. Then una sola.

## Retirada

### FL-THG-002: se retira
Given existe. Then retirado.
`;

// FL-THG-001-B cambia, FL-THG-002 desaparece, FL-THG-003 nace; y el título de la sección
// que va DESPUÉS de FL-THG-001-B cambia sin que ese escenario cambie.
const SCENARIOS_V2 = `# demo — Escenarios

## Alta

### FL-THG-001: se crea
Given nada. Then existe.

#### FL-THG-001-B: se reintenta
Given la misma clave. Then una sola, y el mismo id.

## Renombrado (sección nueva)

### FL-THG-003: se renombra
Given existe. Then otro nombre.
`;

test('escenarios: añadidos, cambiados, quitados y sus familias', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1 }, scenarios: SCENARIOS_V1 });
  const next = design({ layers: { 'use-cases': USE_CASES_V1 }, scenarios: SCENARIOS_V2 });
  const { scenarios, empty } = diffDesigns(prev, next);

  assert.equal(empty, false);
  assert.deepEqual(scenarios.added, ['FL-THG-003']);
  assert.deepEqual(scenarios.changed, ['FL-THG-001-B']);
  assert.deepEqual(scenarios.removed, ['FL-THG-002']);
  assert.deepEqual(scenarios.families, ['FL-THG-001', 'FL-THG-002', 'FL-THG-003']);
});

test('retocar el título de la sección siguiente no da por cambiado al último escenario de la anterior', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1 }, scenarios: SCENARIOS_V1 });
  const next = design({
    layers: { 'use-cases': USE_CASES_V1 },
    scenarios: SCENARIOS_V1.replace('## Retirada', '## Retirada definitiva')
  });
  assert.equal(diffDesigns(prev, next).empty, true);
});

test('determinista: dos llamadas dan el mismo delta', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1 }, scenarios: SCENARIOS_V1 });
  const next = design({ version: '2.0.0', layers: { 'use-cases': USE_CASES_V2 }, scenarios: SCENARIOS_V2 });
  assert.deepEqual(diffDesigns(prev, next), diffDesigns(prev, next));
});

test('un diseño que no carga devuelve error en vez de un delta vacío', () => {
  const prev = design({ layers: { 'use-cases': USE_CASES_V1 } });
  const broken = tmpDir('keel-delta-broken-');
  fs.writeFileSync(path.join(broken, 'service.keel.yaml'), 'keel: [sin cerrar\n');
  assert.ok(diffDesigns(prev, broken).error);
});

test('el troceador: el bloque crudo conserva la cola que crossrefs siempre leyó; el cuerpo la corta', () => {
  const blocks = splitScenarioBlocks(SCENARIOS_V1);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].includes('## Retirada'), 'el bloque crudo cambió: crossrefs.js dejaría de ver lo que veía');
  assert.ok(!scenarioBody(blocks[1]).includes('## Retirada'));
  assert.equal(scenarioFamilyOf(blocks[1]), 'FL-THG-001');
});
