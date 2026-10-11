// El «no existe» en una suscripción se reintenta donde hay guarda de dominio (corrida catalog de keel-spring,
// 2026-10-11).
//
// `WithdrawalRejected` puede llegar antes que la retirada que compensa, y el diseño cuenta con que los reintentos
// absorban esa carrera; los dos generadores mandaban el `PRODUCT_NOT_FOUND` directo al descarte. Ahora keel-core
// decide por DESTINO dónde se reintenta (`missingTargetRetryDestinations`), y aquí se EJECUTA lo que emite keel-nest
// en los tres brokers y se compara con el `RETRIES_NOT_FOUND` que emite keel-spring.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { missingTargetRetryDestinations } from 'keel-core/gen';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { DOMAIN_EXCEPTION_TS, NOT_FOUND_EXCEPTION_TS } from '../src/scaffold/exceptions.js';
import { KAFKA_CONSUMPTION_TS, RABBIT_TOPOLOGY_TS, SNSSQS_CONSUMPTION_TS } from '../src/scaffold/messaging.js';

const SUBJECT = 'catalog-extended';

/** El conjunto RETRIES_NOT_FOUND que emite keel-spring para ese broker. */
function springSet(broker) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker } }).files;
  const config = files.find((f) => /\/(DeadLetterConfig|RabbitTopologyConfig)\.java$/.test(f.path));
  const declared = /RETRIES_NOT_FOUND = Set\.of\(([^)]*)\)/.exec(config.content);
  assert.ok(declared, `keel-spring declara RETRIES_NOT_FOUND con ${broker}`);
  return declared[1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean).sort();
}

async function exceptions(tree) {
  const { DomainException } = await tree.load(DOMAIN_EXCEPTION_TS);
  const { NotFoundException } = await tree.load(NOT_FOUND_EXCEPTION_TS);
  class ProductMissing extends NotFoundException {}
  class Rejected extends DomainException {}
  return { missing: new ProductMissing('PRODUCT_NOT_FOUND'), rejected: new Rejected('regla de negocio') };
}

const BROKERS = [
  { broker: 'kafka', file: KAFKA_CONSUMPTION_TS, table: 'KAFKA_CONSUMPTION', key: 'topic' },
  { broker: 'rabbitmq', file: RABBIT_TOPOLOGY_TS, table: 'RABBIT_TOPOLOGY', key: 'queue' },
  { broker: 'snssqs', file: SNSSQS_CONSUMPTION_TS, table: 'SNSSQS_CONSUMPTION', key: 'queue' }
];

for (const { broker, file, table, key } of BROKERS) {
  test(`${broker}: el «no existe» se reintenta solo en el destino con guarda de dominio, el mismo que en keel-spring`, async () => {
    const { files, model } = planFixture(SUBJECT, { stack: { database: 'postgresql', broker } });
    const tree = transpileTree(files);
    const module = await tree.load(file);
    const entries = module[table];

    const expected = missingTargetRetryDestinations(model, broker);
    assert.deepEqual(expected.length, 1, 'catalog-extended: solo WithdrawalRejected, cuya operación declara transiciones');
    const retried = [...new Set(entries.filter((entry) => entry.retriesNotFound).map((entry) => entry[key]))].sort();
    assert.deepEqual(retried, expected);
    // SNS/SQS no tiene clase de build en keel-spring (lo escribe el agente, guiado por el javadoc).
    if (broker !== 'snssqs') assert.deepEqual(retried, springSet(broker), 'el mismo conjunto que keel-spring');

    const { missing, rejected } = await exceptions(tree);
    assert.equal(module.isRetryable(missing, true), true, 'donde se admite, el «no existe» se reintenta');
    assert.equal(module.isRetryable(missing, false), false, 'fuera de ese destino, es un rechazo más');
    assert.equal(module.isRetryable(missing), false, 'y por defecto también');
    assert.equal(module.isRetryable(rejected, true), false, 'el resto del rechazo de negocio no se reintenta nunca');
    assert.equal(module.isRetryable(new Error('la base no responde'), false), true);

    if (broker === 'rabbitmq') {
      for (const entry of entries) assert.equal(module.retriesNotFoundOn(entry.queue), entry.retriesNotFound, entry.queue);
      assert.equal(module.retriesNotFoundOn('otra-cola'), false);
    }
  });
}

test('con tryRecord (sin guarda de dominio) no se reintenta: el reintento encontraría el evento ya marcado', () => {
  const { model } = planFixture(SUBJECT, { stack: { database: 'postgresql', broker: 'snssqs' } });
  const unguarded = model.subscriptions.find((sub) => sub.name === 'SupplierPriceChanged');
  assert.equal(unguarded.triggerHasDomainGuard, false);
  assert.ok(!missingTargetRetryDestinations(model, 'snssqs').some((d) => d.includes('supplier-price')));
});
