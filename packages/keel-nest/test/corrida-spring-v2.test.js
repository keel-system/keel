// Lo que las corridas de control de keel-spring (asset-vault y catalog, 2026-10-11) escribieron otra vez a mano, y
// que las tres corridas de cada diseño —dos de keel-spring y una de keel-nest— habían escrito igual:
//
//   - el finder de un campo `unique` suelto (`findByChecksum`), para comprobarlo antes de subir el binario;
//   - la resolución del claim del alcance (`findAllByCodeIn`): el claim enumera los códigos que el llamante ve;
//   - el proyector de una réplica que trata un hecho del MISMO instante como ya aplicado.
//
// Se emiten en los dos generadores con el mismo nombre; aquí se comparan.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function springRead(name, stack) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
  return (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
}

function nestRead(name, stack) {
  const { files } = planFixture(name, { stack });
  return (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
}

for (const database of ['mongodb', 'postgresql']) {
  const stack = { database, broker: 'rabbitmq' };

  test(`asset-vault (${database}): el campo único suelto tiene su finder en los dos generadores`, () => {
    const nest = nestRead('asset-vault', stack);
    const spring = springRead('asset-vault', stack);
    assert.match(nest('asset-repository.ts'), /abstract findByChecksum\(checksum: string\): Promise<Asset \| null>;/);
    assert.match(nest('asset-repository-impl.ts'), /async findByChecksum\(checksum: string\): Promise<Asset \| null> \{/);
    assert.ok(spring('/AssetRepository.java').includes('Optional<Asset> findByChecksum(String checksum);'));
    assert.ok(spring('/AssetRepositoryImpl.java').includes('public Optional<Asset> findByChecksum(String checksum) {'));
    // La clave natural no se duplica como «campo único».
    assert.equal((spring('/AssetRepository.java').match(/findByOwnerIdAndSlug\(/g) ?? []).length, 1);
  });

  test(`asset-vault (${database}): el over del alcance se resuelve por lote en los dos generadores`, () => {
    const nest = nestRead('asset-vault', stack);
    const spring = springRead('asset-vault', stack);
    assert.match(nest('owner-repository.ts'), /abstract findAllByCodeIn\(codes: readonly string\[\]\): Promise<Owner\[\]>;/);
    assert.ok(spring('/OwnerRepository.java').includes('List<Owner> findAllByCodeIn(Collection<String> codes);'));
    assert.match(spring('/OwnerRepository.java'), /scoping\.over/);
  });
}

test('sin alcance no hay lote del over: la regla es del alcance, no de toda clave natural', () => {
  const { files } = planFixture('asset-vault', {
    stack: { database: 'mongodb', broker: 'rabbitmq' },
    mutate: (layers) => delete layers.security.authentication.scoping
  });
  const port = files.find((f) => f.path.endsWith('owner-repository.ts')).content;
  assert.ok(port.includes('findByCode('), 'la clave natural sigue');
  assert.ok(!port.includes('findAllByCodeIn'), port);
});

// La clave saliente `keyFrom: correlation` era `call + correlationId`: dos llamadas DISTINTAS de la misma ejecución
// (un barrido que revalida varios archivos en el mismo tick) compartían clave, y un proveedor que deduplica por ella
// se quedaba con la primera (designGap de la corrida asset-vault de keel-spring, FL-CLU-002).
test('la clave por correlación distingue dos peticiones de la misma ejecución y repite la del reintento', async () => {
  const { files } = planFixture('asset-vault', { stack: { database: 'mongodb', broker: 'rabbitmq' } });
  const { load } = transpileTree(files);
  const { OutboundIdempotency } = await load('src/infrastructure/clients/outbound-idempotency.ts');
  const { CorrelationContext } = await load('src/infrastructure/correlation/correlation-context.ts');
  await CorrelationContext.runWith('tick-1', async () => {
    const a = OutboundIdempotency.correlated('scanAsset', { assetId: 'a' });
    const b = OutboundIdempotency.correlated('scanAsset', { assetId: 'b' });
    assert.notEqual(a, b, 'dos archivos del mismo tick no comparten clave');
    assert.equal(OutboundIdempotency.correlated('scanAsset', { assetId: 'a' }), a, 'el reintento repite clave');
  });
  const other = await CorrelationContext.runWith('tick-2', async () => OutboundIdempotency.correlated('scanAsset', { assetId: 'a' }));
  assert.notEqual(other, OutboundIdempotency.fromPayload('scanAsset', { assetId: 'a' }));
  const spring = springRead('asset-vault', { database: 'mongodb', broker: 'rabbitmq' })('/OutboundIdempotency.java');
  assert.ok(spring.includes('CommandSignature.of(Arrays.asList(call, correlationId, payload))'), spring);
});

test('el proyector de la réplica no aplica un hecho del mismo instante, en los dos generadores', () => {
  const stack = { database: 'postgresql', broker: 'kafka' };
  const nest = nestRead('catalog-extended', stack)('supplier-price-projector.ts');
  const spring = springRead('catalog-extended', stack)('/SupplierPriceProjector.java');
  assert.match(nest, /snapshot\.occurredAt <= existing\.occurredAt\) return;/);
  assert.match(spring, /!occurredAt\.isAfter\(existing\.getOccurredAt\(\)\)/);
});
