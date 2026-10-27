// La copia de una réplica que lee una operación de listado se lee POR LOTE (corridas catalog de keel-nest y
// keel-spring, que escribieron `findBySkus` y `findAllBySkuIn` a mano).
//
// `supplierPrice` es `replicated` precisamente porque se expone en un listado; leer la copia elemento a elemento
// reintroduce, contra la base, la llamada por elemento que la réplica existe para evitar. La decisión de cuándo es
// de keel-core (`naturalKeyBatchReason`); aquí se ejecuta el lector emitido y se comparan los finders con keel-spring.
// Y el orden de las hijas en la rama documental, que keel-nest no restablecía y keel-spring sí.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const READER = 'src/application/projection/supplier-price-reader.ts';
const PORT = 'src/domain/repository/supplier-price-repository.ts';
const ADAPTER = 'src/infrastructure/persistence/repositories/supplier-price-repository-impl.ts';

function plan(database) {
  const { files } = planFixture('catalog-extended', { stack: { database, broker: 'kafka' } });
  return { files, read: (p) => files.find((f) => f.path === p)?.content };
}

test('el puerto y los dos adaptadores traen el finder por lote, con la firma del de keel-spring', () => {
  for (const database of ['postgresql', 'mongodb']) {
    const { read } = plan(database);
    assert.match(read(PORT), /abstract findAllBySkuIn\(skus: readonly string\[\]\): Promise<SupplierPrice\[\]>;/, database);
    assert.match(read(ADAPTER), /async findAllBySkuIn\(skus: readonly string\[\]\): Promise<SupplierPrice\[\]> \{\n\s+if \(skus\.length === 0\) return \[\];/, database);
  }
  assert.match(plan('postgresql').read(ADAPTER), /where: \{ sku: In\(\[\.\.\.skus\]\) \}/);
  assert.match(plan('mongodb').read(ADAPTER), /\.find\(\{ 'sku': \{ \$in: skus\.map\(\(value\) => value\) \} \}, \{ session: this\.session \}\)/);

  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'kafka' } }).files;
  const port = spring.find((f) => f.path.endsWith('/SupplierPriceRepository.java')).content;
  assert.ok(port.includes('List<SupplierPrice> findAllBySkuIn(Collection<String> skus);'), 'el mismo nombre en keel-spring');
});

test('el lector lee la página entera en una consulta y devuelve solo lo ya replicado', async () => {
  const { files, read } = plan('postgresql');
  assert.match(read('src/application/usecases/get-products-by-ids-query-handler.ts'), /supplierPriceReader\.byKeys\(\.\.\.\)/);
  const tree = transpileTree(files);
  const { SupplierPriceReader } = await tree.load(READER);
  const calls = [];
  const repository = {
    async findAllBySkuIn(skus) {
      calls.push([...skus]);
      return skus.filter((sku) => sku !== 'MISSING').map((sku) => ({ sku, amount: sku.length }));
    }
  };
  const reader = new SupplierPriceReader(repository, {});
  const copies = await reader.byKeys(['A-1', 'MISSING', 'B-22']);
  assert.equal(calls.length, 1, 'una sola consulta para toda la página');
  assert.deepEqual([...copies.keys()].sort(), ['A-1', 'B-22']);
  assert.equal(copies.has('MISSING'), false, 'lo que falta no aparece: su onMiss es de byKey(...)');
  assert.equal(copies.get('B-22').amount, 4);
});

test('sin una operación de listado que la lea, no hay lote', () => {
  const { files } = planFixture('catalog-extended', {
    stack: { database: 'postgresql', broker: 'kafka' },
    mutate: (layers) => {
      layers.dependencies.dependencies.pricing.needs.supplierPrice.usedBy = ['getProductBySlug'];
    }
  });
  const port = files.find((f) => f.path === PORT).content;
  assert.doesNotMatch(port, /findAllBySkuIn/);
});

test('rama documental: las hijas salen por posición y, ante empate, por id', () => {
  const { files } = planFixture('inspection-reports', { stack: { database: 'mongodb', broker: 'kafka' } });
  const adapter = files.find((f) => f.path.endsWith('inspection-report-repository-impl.ts')).content;
  const match = /sections: \(\(document\.sections \?\? \[\]\) as Document\[\]\)\.map\(toDomainReportSection\)\.sort\((\(a, b\) => .*)\),\n/.exec(adapter);
  assert.ok(match, adapter);
  const compare = new Function(`return ${match[1]};`)();
  const sections = [
    { id: 'c', position: 1 },
    { id: 'a', position: 1 },
    { id: 'b', position: 0 }
  ];
  assert.deepEqual([...sections].sort(compare).map((s) => s.id), ['b', 'a', 'c']);
});
