// La persistencia documental de keel-go (incremento 12), sin red: lo emitido contra los DATOS de keel-core —la forma del
// documento, los índices y la traducción de sus violaciones—, que son los mismos de keel-spring, keel-nest y keel-dotnet.
// Lo que solo ve un MongoDB real (el documento crudo, los índices vivos, la transacción) lo mide doc-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { documentShape, documentIndexes } from '@keel-system/keel-core/gen/document';
import { constraintErrors } from '@keel-system/keel-core/gen/constraint-errors';
import { localMongoUrl } from '@keel-system/keel-core/gen/infra-catalog';
import { repositoryRoots } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { DOC_SABOTAGES, applyDocSabotage } from './helpers/doc-sabotages.js';

const DOCUMENTAL = ['asset-vault', 'conduit', 'inspection-reports', 'job-dispatch-mongo', 'notification-mailer-mongo'];
const plan = (name) => planService({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR });
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const STORE = 'internal/infrastructure/mongo';

for (const name of DOCUMENTAL) {
  test(`${name}: encode<E> escribe las claves del documento de keel-core, en su orden, y decode<E> las lee`, () => {
    const { model, files } = plan(name);
    const all = byPath(files);
    const sources = Object.entries(all).filter(([file]) => file.startsWith(`${STORE}/`) && file.endsWith('_repository.go')).map(([, content]) => content).join('\n');
    const entities = model.entities.filter((entity) => entity.persisted);
    for (const entity of entities) {
      const encode = new RegExp(`func \\(e \\*encoder\\) encode${entity.name}\\(x \\*domain\\.${entity.name}\\) bson\\.D \\{\\n\\treturn bson\\.D\\{\\n([\\s\\S]*?)\\n\\t\\}\\n\\}`).exec(sources);
      if (!encode) continue;
      const written = [...encode[1].matchAll(/\{Key: "([^"]+)"/g)].map((match) => match[1]);
      const expected = documentShape(model, entity)
        .filter((entry) => !(entity.isAggregateRoot && (entry.kind === 'id' || entry.kind === 'version' || entry.kind === 'audit')))
        .filter((entry) => !(entry.kind === 'scalar' && entity.declaresLockVersion && entry.field.name === 'lockVersion'))
        .map((entry) => entry.name);
      assert.deepEqual(written, expected, `${entity.name}: claves de encode${entity.name}`);
      assert.match(sources, new RegExp(`func decode${entity.name}\\(doc bson\\.Raw\\) \\(\\*domain\\.${entity.name}, error\\)`), `${entity.name}: su decode`);
    }
    assert.ok(repositoryRoots(model).every((root) => `${STORE}/${root.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_repository.go` in all));
    // Sin esquema relacional: ni migraciones ni SQL.
    assert.ok(!Object.keys(all).some((file) => file.includes('/migrations/')));
    assert.doesNotMatch(sources, /SELECT |INSERT INTO|database\/sql/);
  });

  test(`${name}: indexes.go crea los índices de documentIndexes y errors.go traduce cada índice único con su error`, () => {
    const { model, files } = plan(name);
    const all = byPath(files);
    const indexes = all[`${STORE}/indexes.go`];
    for (const { collection, specs } of documentIndexes(model, [])) {
      assert.match(indexes, new RegExp(`\\t"${collection}": \\{`), collection);
      for (const spec of specs) {
        const keys = spec.paths.map((p) => `\\{Key: "${p.replace(/\./g, '\\.')}", Value: 1\\}`).join(', ');
        assert.match(indexes, new RegExp(`\\{Keys: bson\\.D\\{${keys}\\}, Options: options\\.Index\\(\\)\\.SetName\\("${spec.name}"\\)${spec.unique ? '\\.SetUnique\\(true\\)' : ''}`), `${collection}.${spec.name}`);
      }
    }
    const errors = all[`${STORE}/errors.go`];
    for (const entry of constraintErrors(model).filter((candidate) => !candidate.reference)) {
      assert.match(errors, new RegExp(`\\t"${entry.constraint.toLowerCase()}": +domain\\.`), entry.constraint);
    }
  });

  test(`${name}: db.yaml lleva la URI de MongoDB de keel-spring, y el perfil test no tiene base`, () => {
    const { model, files } = plan(name);
    const all = byPath(files);
    const dbName = model.service.name.replace(/-/g, '_');
    assert.ok(all['config/parameters/local/db.yaml'].includes(`url: ${localMongoUrl(dbName)}
`), 'la URI local de keel-spring');
    assert.match(all['config/parameters/test/db.yaml'], /enabled: false/);
  });
}

test('cada sabotaje de doc-check se sigue aplicando a lo que emite alguna fixture documental', () => {
  for (const [id, sabotage] of Object.entries(DOC_SABOTAGES)) {
    const changed = DOCUMENTAL.reduce((total, name) => total + applyDocSabotage(sabotage, plan(name).files).changed, 0);
    assert.ok(changed > 0, `${id} ya no se aplica`);
  }
});

// Corrida 12e (2026-11-01): openTx miraba la marca de application.WithoutTransaction, así que la transacción que abría el
// Save de un caso de uso despachado sin transacción (el envío que despacha el barrido) era invisible para su outbox, y
// cada envío revertía. La marca se aplica en Within, una vez; la prueba emitida lo ejecuta en go-check, en los dos modelos.
test('openTx no mira la marca de WithoutTransaction: la aplica Within, y una prueba emitida lo mide en los dos modelos', () => {
  for (const [name, store] of [['notification-mailer-mongo', STORE], ['product-catalog', 'internal/infrastructure/postgres']]) {
    const files = byPath(plan(name).files);
    const openTx = files[`${store}/transactions.go`].match(/func openTx\(ctx context\.Context\)[^]*?\n}\n/)[0];
    assert.doesNotMatch(openTx, /TransactionDetached/, name);
    assert.match(files[`${store}/transactions_test.go`], /func TestSinTransaccionOcultaLaDelLlamanteYVeLaSuya\(t \*testing\.T\)/, name);
  }
});
