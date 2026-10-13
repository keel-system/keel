// Un `TODO` es la marca con la que el agente de código encuentra su trabajo (`grep -rn "TODO" src`), así que solo puede
// estar donde ese trabajo se hace. La corrida catalog-nest (2026-10-13) los encontró en archivos de build que se quedan
// para siempre: el respaldo del OutboxDispatcher y la función `unsupported()` del lector, que no usaba nadie. Los
// respaldos del broker señalan ahora a `broker-bindings.ts`, que es lo que el agente rellena, y ahí está la marca.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const STACK = { database: 'postgresql', broker: 'rabbitmq' };
// Los respaldos que build registra y que no se borran: el agente registra su implementación en otro sitio.
const PERMANENT = [/outbox-dispatcher-fallback\.ts$/, /-publisher-stub\.ts$/, /\/rest\/request-reading\.ts$/];
// La marca, no la palabra: «TODOS los eventos» es prosa.
const WORK_MARK = /\/\/\s*TODO\b|TODO:/;

for (const name of fixtures) {
  test(`${name}: ningún archivo permanente de build lleva TODO, y broker-bindings.ts sí cuando hay trabajo`, (t) => {
    let files;
    try {
      ({ files } = planFixture(name, { stack: STACK }));
    } catch {
      return t.skip('fuera de la frontera de keel-nest');
    }
    for (const file of files.filter((f) => PERMANENT.some((pattern) => pattern.test(f.path)))) {
      assert.doesNotMatch(file.content, WORK_MARK, file.path);
    }
    const bindings = files.find((f) => f.path.endsWith('broker-bindings.ts'))?.content;
    if (!bindings) return;
    const fallback = files.some((f) => f.path.endsWith('outbox-dispatcher-fallback.ts') || f.path.endsWith('-publisher-stub.ts'));
    assert.equal(/TODO \(agente\): una implementación por puerto/.test(bindings), fallback, 'la marca de los adaptadores del broker');
  });
}

test('el lector de peticiones no emite código muerto que falle con «TODO»', () => {
  const files = planFixture('catalog-extended', { stack: STACK }).files;
  const reading = files.find((f) => f.path.endsWith('/rest/request-reading.ts')).content;
  assert.doesNotMatch(reading, /export function unsupported\(/);
});
