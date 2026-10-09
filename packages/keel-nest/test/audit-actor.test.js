// La autoría de las escrituras (incremento 13h) en la rama RELACIONAL. Ninguna fixture relacional la declara, así
// que se deriva de product-catalog cambiando solo `persistence.audit.authorship` (la documental la ejecuta
// document-persistence.test.js con asset-vault). Se mide que el adaptador estampe lo mismo que el AuditorAware de
// keel-spring: created_by al nacer, que no se reescribe, y updated_by en cada escritura, con el actor de
// currentActor().

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/emitted.js';

const withAuthorship = (authorship) =>
  planFixture('product-catalog', {
    mutate: (layers) => {
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship };
    }
  });

test('authorship: all — el adaptador estampa created_by al nacer y updated_by siempre, con currentActor()', () => {
  const files = Object.fromEntries(withAuthorship('all').files.map((file) => [file.path, file.content]));
  const adapter = Object.entries(files).find(([file]) => file.endsWith('product-repository-impl.ts'))[1];
  assert.match(adapter, /import \{ currentActor \} from '\.\.\/audit-actor\.js';/);
  assert.match(adapter, /const actor = currentActor\(\);\n\s+orm\.createdAt \?\?= now;\n\s+orm\.updatedAt = now;\n\s+orm\.createdBy \?\?= actor;\n\s+orm\.updatedBy = actor;/);
  const auditable = files['src/infrastructure/persistence/entities/auditable-orm.ts'] ?? Object.entries(files).find(([file]) => file.endsWith('auditable-orm.ts'))[1];
  assert.match(auditable, /name: 'created_by'[^)]*update: false/);
  assert.match(auditable, /name: 'updated_by'/);
  assert.ok(files['src/infrastructure/persistence/audit-actor.ts'], 'emite el actor');
});

test('authorship: none — ni actor ni columnas de autoría', () => {
  const files = Object.fromEntries(withAuthorship('none').files.map((file) => [file.path, file.content]));
  assert.ok(!files['src/infrastructure/persistence/audit-actor.ts']);
  assert.ok(!Object.values(files).some((content) => content.includes('currentActor') || content.includes("'created_by'")));
});
