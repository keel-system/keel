// Las sondas y los sabotajes de db-check, sin Go ni base: la sonda de cada fixture relacional se genera, es Go válido con
// sus imports en uso, y cada sabotaje se sigue aplicando al texto que emite hoy build y nombra sondas que existen en un
// sujeto donde se aplica. Los ejecuta `npm run db-check -- --sabotage=<id>`: un sabotaje que ya no encuentra lo que
// buscaba no falsa nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { probeFile } from '../scripts/lib/db-probes.js';
import { DB_SABOTAGES, applyDbSabotage } from './helpers/db-sabotages.js';
import { checkGoTree } from './helpers/go-tree.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { FINDER_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});
// Las fixtures relacionales y los diseños derivados de los finders que salen de una de ellas: los sujetos de db-check.
const designs = [
  ...relational.map((name) => ({ name, from: name, mutate: null })),
  ...FINDER_DESIGNS.filter((design) => relational.includes(design.from))
];
const subjects = designs.map(({ name, from, mutate }) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
  if (mutate) mutate(layers);
  const plan = planService({ manifest, layers, workspace: FIXTURES_DIR });
  const probe = probeFile(plan.model);
  const probes = [...probe.content.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((m) => m[1]);
  return { name, plan, probe, probes };
});

for (const { name, plan, probe } of subjects) {
  test(`${name}: la sonda de db-check es Go válido, con sus imports en uso y muestras para todo`, async () => {
    assert.deepEqual(probe.unsampled, []);
    assert.deepEqual(await checkGoTree([...plan.files, probe], plan.model.service.goModule), []);
  });
}

for (const [id, sabotage] of Object.entries(DB_SABOTAGES)) {
  test(`el sabotaje de db-check ${id} se sigue aplicando y nombra sondas que existen donde se aplica`, () => {
    const touched = subjects.filter((subject) => applyDbSabotage(sabotage, subject.plan.files).changed > 0);
    assert.ok(touched.length > 0, `${id} no cambia lo emitido en ninguna fixture`);
    const named = touched.flatMap((subject) => subject.probes.filter((probe) => sabotage.expect.test(probe)).map((probe) => `${subject.name}:${probe}`));
    assert.ok(named.length > 0, `${id} espera sondas que no existen en ${touched.map((s) => s.name).join(', ')}`);
  });
}
