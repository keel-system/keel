// Lo que la auditoría del inc. 1 de PLAN-KEEL-GO.md sacó de los generadores a keel-core/gen. Vivía copiado, con el
// mismo cuerpo, en keel-nest y keel-dotnet; aquí se fija que no vuelva a copiarse —tampoco en el generador
// siguiente— y que cada pieza responde sobre el modelo de toda fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import * as features from '../src/lib/gen/features.js';
import { relationalAgingTargets, documentAgingTargets } from '../src/lib/gen/aging-targets.js';
import { compensationNote } from '../src/lib/gen/compensation.js';
import { mappersByEntity, reachableChildDtos } from '../src/lib/gen/mapper-plan.js';
import { sortablePaths } from '../src/lib/gen/document.js';
import { guardClaimsFor } from '../src/lib/gen/scheduling.js';
import { subscriptionsBySource } from '../src/lib/gen/messaging-plan.js';
import { PROBE } from './helpers/probe-projection.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.join(here, '..', '..');
const FIXTURES_DIR = path.join(PACKAGES, '..', 'fixtures', 'designs');

// El nombre que tenía la copia en cada generador. `agingTargets` y `bySource` eran nombres locales de lo que en gen se
// llama de otra forma.
const EXTRACTED = [
  ...Object.keys(features),
  'agingTargets',
  'compensationNote',
  'mappersByEntity',
  'reachableChildDtos',
  'sortablePaths',
  'guardClaimsFor',
  'bySource',
  'localIssuer',
  'localMongoUrl'
];

// keel-spring no entró en la extracción (su golden no cambia por esto): lo que todavía define él mismo. Dos no dicen lo
// mismo que gen: su `usesStorageControl` exige además devtools y su `sendsMail` no mira si la capa mail está.
const SPRING_OWN = new Set(['reachableChildDtos', 'resolvedByOf', 'guardClaimsFor', 'isPartialUpdate', 'usesStorageControl', 'sendsMail']);

function sourcesOf(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesOf(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []
  );
}

test('ningún generador vuelve a definir lo que ya decide keel-core/gen', () => {
  const generators = fs.readdirSync(PACKAGES).filter((name) => fs.existsSync(path.join(PACKAGES, name, 'src', 'scaffold')));
  assert.ok(generators.includes('keel-nest') && generators.includes('keel-dotnet'), `generadores: ${generators.join(', ')}`);
  const findings = [];
  for (const generator of generators) {
    for (const file of sourcesOf(path.join(PACKAGES, generator, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const name of EXTRACTED) {
        if (generator === 'keel-spring' && SPRING_OWN.has(name)) continue;
        if (new RegExp(`^(export )?function ${name}\\(`, 'm').test(source)) findings.push(`${generator}/${path.relative(path.join(PACKAGES, generator), file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

const fixtures = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')))
  .sort();

for (const fixture of fixtures) {
  test(`lo extraído responde sobre el modelo de ${fixture}`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model) };
    const model = buildModel({ manifest, layers, stack, projection: PROBE });
    const operations = (model.services ?? []).flatMap((service) => service.operations ?? []);

    // Una sola persistencia, nunca las dos; y las raíces con repositorio solo con persistencia.
    assert.ok(!(features.usesRelational(model) && features.usesDocument(model)));
    assert.equal(features.usesPersistence(model), features.usesRelational(model) || features.usesDocument(model));
    if (!features.usesPersistence(model)) assert.deepEqual(features.repositoryRoots(model), []);
    for (const operation of operations) {
      const root = features.repositoryOf(model, operation);
      if (root) assert.ok(features.repositoryRoots(model).includes(root));
      features.sendsMail(model, operation);
      const note = compensationNote(operation);
      assert.equal(note === null, !operation.compensates);
    }

    const relational = relationalAgingTargets(model);
    const documental = documentAgingTargets(model);
    // Las dos vistas son del mismo diseño: nombran los mismos barridos (la documental solo se pide en su rama).
    assert.deepEqual([...documental.keys()].sort(), [...relational.keys()].sort());
    for (const targets of relational.values()) for (const target of targets) assert.ok(target.table && target.awaitingField);

    const mappers = mappersByEntity(model);
    for (const dtos of mappers.values()) reachableChildDtos(model, [...dtos.values()]);
    for (const entity of features.repositoryRoots(model)) {
      if (features.usesDocument(model)) assert.ok(sortablePaths(model, entity).every(([property, route]) => property && route));
      guardClaimsFor(model, entity.name);
    }
    const groups = subscriptionsBySource(model, model.subscriptions ?? []);
    assert.equal(groups.flat().length, (model.subscriptions ?? []).length);
  });
}
