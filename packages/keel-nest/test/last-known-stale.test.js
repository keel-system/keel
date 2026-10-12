// El último valor conocido (`onUnavailable: lastKnown`) se sirve MARCADO, y una respuesta que lo lleve no se cachea.
//
// Las dos corridas de control de catalog (keel-spring y keel-nest, 2026-10-11) le añadieron a mano una marca `stale`
// al resultado de la llamada: cacheado, el precio viejo seguiría sirviéndose todo el TTL, más allá de la edad máxima
// que el diseño declara. No es una decisión abierta del diseño: la toma `maxAgeSeconds`. Lo decide keel-core
// (`gen/last-known.js`) y lo emiten los dos generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'kafka' };
const flat = (text) => text.replace(/\n\s*\/\/\s*/g, ' ');

function springRead() {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  return (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
}

test('el resultado de la llamada que sirve lastKnown lleva stale, y el rescate lo marca, en los dos generadores', async () => {
  const spring = springRead();
  const record = spring('/GetPriceResult.java');
  assert.ok(record.includes('public record GetPriceResult(BigDecimal amount, String currency, boolean stale) {'), record);
  assert.ok(record.includes('this(amount, currency, false);') && record.includes('return new GetPriceResult(amount, currency, true);'));
  assert.ok(spring('/PricingHttpAdapter.java').includes('.map(GetPriceResult::asStale)'));

  const { files } = planFixture('catalog-extended', { stack: STACK });
  const read = (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
  assert.ok(read('pricing-http-adapter.ts').includes('if (remembered !== null) return remembered.asStale();'));
  // EJECUTADO: recién leído no es stale; el rescatado sí, con los mismos valores.
  const { GetPriceResult } = await transpileTree(files).load('src/domain/clients/get-price-result.ts');
  const fresh = new GetPriceResult('9.90', 'EUR');
  assert.equal(fresh.stale, false);
  const rescued = fresh.asStale();
  assert.deepEqual([rescued.amount, rescued.currency, rescued.stale], ['9.90', 'EUR', true]);
  assert.equal(fresh.stale, false, 'asStale no toca el original');
});

test('una llamada sin lastKnown no gana stale', () => {
  const spring = springRead();
  assert.ok(!spring('/GetCostResult.java').includes('stale'), 'legacyErp.getCost es degrade, no lastKnown');
});

test('la nota de la caché de la operación que usa el need dice que el valor rescatado no se guarda, en los dos', () => {
  const spring = flat(springRead()('/GetProductBySlugQueryHandler.java'));
  const { files } = planFixture('catalog-extended', { stack: STACK });
  const nest = flat(files.find((f) => f.path.endsWith('get-product-by-slug-query-handler.ts')).content);
  for (const handler of [spring, nest]) {
    assert.ok(handler.includes('Tampoco la que sirvió el ÚLTIMO VALOR CONOCIDO de pricing.currentPrice'), handler);
  }
});
