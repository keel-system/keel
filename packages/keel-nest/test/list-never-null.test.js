// Contrato del cable, `list-never-null` (keel-core/gen/wire.js): una lista que la entrada no informa se lee como
// `[]`, salvo la opcional del cuerpo de un PATCH. La corrida notification-mailer-mongo (2026-10-08) lo destapó: los
// dos servidores respondían `[]`, pero en keel-spring dependía de que el agente lo recordara al construir el
// agregado. Ahora lo emiten los dos: el lector de keel-nest (`x ?? []`) y el constructor compacto del mensaje de
// keel-spring (`x = x == null ? List.of() : x;`). Se comprueba en TODAS las fixtures, sobre lo que emite cada uno.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };

for (const name of fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml')))) {
  test(`${name}: toda lista de la entrada se normaliza a [] en los dos generadores`, (t) => {
    let nest;
    try {
      nest = planFixture(name, { stack: STACK });
    } catch {
      return t.skip('fuera de la frontera de keel-nest');
    }
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
    const nestText = nest.files.filter((file) => file.path.includes('/rest/controllers/')).map((file) => file.content).join('\n');
    let checked = 0;
    for (const service of nest.model.services ?? []) {
      for (const operation of service.operations ?? []) {
        if (!operation.route) continue;
        const partial = operation.route.method === 'PATCH';
        const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
        const lists = (operation.bodyFields ?? []).concat(operation.queryParams ?? []).filter((field) => field.list && !fromPath.has(field.name));
        const record = spring.find((file) => file.path.endsWith(`/${operation.messageClass}.java`))?.content;
        for (const field of lists) {
          // La opcional del cuerpo de un PATCH es de tres estados en keel-spring: ausente es «no tocar».
          if (partial && !field.required) continue;
          checked += 1;
          assert.ok(nestText.includes(`${field.name}: ${field.name} ?? []`), `keel-nest ${operation.name}.${field.name}`);
          assert.ok(record?.includes(`${field.name} = ${field.name} == null ? List.of() : ${field.name};`), `keel-spring ${operation.messageClass}.${field.name}`);
        }
      }
    }
    if (checked === 0) t.diagnostic('sin listas en la entrada');
  });
}

// La forma que ninguna fixture tiene: una lista OPCIONAL en el cuerpo de un PATCH. keel-spring la envuelve en
// JsonNullable (ausente = no tocar) y keel-nest la leía como `[]`, que la vaciaría (pendiente de la 12e). Se deriva
// de catalog-extended (updateProduct es PATCH) y el lector emitido se EJECUTA.
test('la lista opcional del cuerpo de un PATCH es de tres estados en los dos generadores', async () => {
  const mutate = (layers) => {
    layers['use-cases'].operations.updateProduct.input.fields.tags = { type: 'string', list: true, constraints: { maxLength: 40 } };
  };
  const nest = planFixture('catalog-extended', { stack: STACK, mutate });
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  mutate(layers);
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;

  const record = spring.find((file) => file.path.endsWith('/UpdateProductCommand.java')).content;
  assert.match(record, /JsonNullable<List<@Size\(max = 40\) String>> tags/);
  assert.ok(!record.includes('tags = tags == null ? List.of()'), 'keel-spring no la normaliza');
  const message = nest.files.find((file) => file.path.endsWith('/update-product-command.ts')).content;
  assert.match(message, /readonly tags\?: readonly string\[\] \| null;/);

  const controller = nest.files.find((file) => file.path.endsWith('/product-v1-controller.ts')).content;
  const start = controller.indexOf('function readUpdateProductCommand');
  const reader = controller.slice(start, controller.indexOf('\n}\n', start) + 2);
  assert.ok(!reader.includes('tags ?? []'), reader);
  const probe = {
    path: 'src/patch-probe.ts',
    content: `import { bodyObject, json, text, Violations } from './infrastructure/rest/request-reading.js';
import { UpdateProductCommand } from './application/commands/update-product-command.js';
export ${reader}`
  };
  const { readUpdateProductCommand } = await transpileTree([...nest.files, probe]).load('src/patch-probe.ts');
  const id = { id: '0190c6a4-7c1e-7cc0-8a3e-1b2c3d4e5f60' };
  const read = (body) => readUpdateProductCommand(id, {}, body);
  assert.equal(read({ name: 'x' }).tags, undefined, 'ausente: no se toca');
  assert.equal('tags' in read({ name: 'x' }) && read({ name: 'x' }).tags !== undefined, false);
  assert.equal(read({ tags: null }).tags, null, 'null: se vacía');
  assert.deepEqual(read({ tags: [] }).tags, [], '[]: se vacía');
  assert.deepEqual(read({ tags: ['rojo', 'azul'] }).tags, ['rojo', 'azul']);
  assert.throws(() => read({ tags: ['x'.repeat(41)] }), (error) => error.name === 'RequestValidationError');
});
