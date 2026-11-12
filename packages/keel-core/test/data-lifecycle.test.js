// El ciclo de vida del dato (DSL 2.28, src/lib/gen/data-lifecycle.js e implicit-predicates.js): qué raíces borran
// lógicamente, se restauran y caducan, qué es personal, la referencia ejecutable de la aritmética (el corte de la
// retención, la ventana, el sustituto) y la frontera común de los generadores. Los sujetos son los de
// test/helpers/data-lifecycle-designs.js, los mismos que medirán los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import {
  ANONYMOUS_PREFIX,
  DATA_LIFECYCLE_CASES,
  DATA_LIFECYCLE_SABOTAGES,
  anonymizedValue,
  anonymousSubstitute,
  dataLifecyclePendingErrors,
  dataLifecycleRoots,
  deletedRoots,
  incomingReferences,
  isRestorable,
  isRetentionDue,
  lifecycleRoots,
  personalFields,
  retentionCutoffMs,
  retentionSpan,
  substituteProblem
} from '../src/lib/gen/data-lifecycle.js';
import { implicitPredicates } from '../src/lib/gen/implicit-predicates.js';
import { PERSONAL_DATA_FILE, personalDataInventory, personalFieldNames, usesPersonalData } from '../src/lib/gen/personal-data.js';
import { DATA_LIFECYCLE_DESIGNS } from './helpers/data-lifecycle-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { manifest, layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}
const derived = (name) => {
  const design = DATA_LIFECYCLE_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, design.mutate);
};
const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);
const DAY = 86_400_000;

test('los sujetos validan sin errores ni obligaciones del ciclo de vida abiertas', () => {
  for (const design of DATA_LIFECYCLE_DESIGNS) {
    const { manifest, layers } = derived(design.name);
    const { errors, warnings } = checkCrossRefs({ layers, manifest });
    assert.deepEqual(errors, [], design.name);
    assert.deepEqual(
      warnings.filter((warning) => /OBL-PERSONAL|CHK-PERSIST-(DELETION|RESTORE|RETENTION|ANONYMIZE|LIFECYCLE)/.test(warning)),
      [],
      design.name
    );
  }
});

test('cards-logical: borrado lógico con su restauración, su purga desde el borrado y sus campos personales', () => {
  const { layers, model } = derived('cards-logical');
  assert.deepEqual(lifecycleRoots(model), [
    {
      entity: 'ContactCard',
      logical: true,
      restore: { operation: 'restoreMyCard', error: 'CARD_NOT_RESTORABLE', days: 30 },
      retention: { kind: 'retention:ContactCard', from: 'deletedAt', fromDeleted: true, span: { days: 30 }, then: 'delete', anonymize: [] }
    }
  ]);
  assert.deepEqual(personalFields(model), [{ entity: 'ContactCard', fields: ['displayName', 'email'] }]);
  assert.deepEqual(deletedRoots(layers), ['ContactCard']);
  assert.deepEqual(dataLifecycleRoots(layers), ['ContactCard']);
  assert.equal(operationOf(model, 'restoreMyCard').restores, 'ContactCard');
});

test('codes-anonymize: la retención anonimiza el email, que es obligatorio, con el sustituto', () => {
  const { model } = derived('codes-anonymize');
  const [root] = lifecycleRoots(model);
  assert.equal(root.logical, false);
  assert.equal(root.restore, null);
  assert.deepEqual(root.retention.anonymize, [{ entity: 'VerificationCode', fields: [{ name: 'email', required: true }] }]);
  assert.deepEqual(root.retention.span, { days: 30 });
  assert.equal(root.retention.from, 'issuedAt');
});

test('el predicado de vida se suma al alcance en el finder, y sin finder lo aplica el listado entero', () => {
  const { model } = derived('vault-logical-scoped');
  const listAssets = operationOf(model, 'listAssets');
  assert.equal(listAssets.finder.live, true, 'el finder acotado lleva también la vida de la fila');
  assert.ok(listAssets.finder.scope, 'y conserva el alcance: ninguno sustituye al otro');
  const asset = model.entities.find((entity) => entity.name === 'Asset');
  assert.deepEqual(implicitPredicates(listAssets, asset), { scope: listAssets.readScope, live: true });
  // Sin borrado lógico no hay predicado de vida.
  const { model: plain } = designOf('asset-vault');
  assert.equal(operationOf(plain, 'listAssets').finder.live, false);
});

test('la retención se corta en el instante: los días son de 24 h y los años de calendario', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  assert.equal(retentionCutoffMs({ nowMs: now, days: 30 }), now - 30 * DAY);
  assert.equal(retentionCutoffMs({ nowMs: now, years: 6 }), Date.UTC(2020, 10, 11, 12, 0, 0));
  // Un 29 de febrero sin equivalente cae en el 28.
  assert.equal(retentionCutoffMs({ nowMs: Date.UTC(2028, 1, 29, 8), years: 1 }), Date.UTC(2027, 1, 28, 8));
  const cutoff = retentionCutoffMs({ nowMs: now, days: 30 });
  assert.equal(isRetentionDue({ fromMs: cutoff, cutoffMs: cutoff }), true, 'vence EN el corte');
  assert.equal(isRetentionDue({ fromMs: cutoff + 1, cutoffMs: cutoff }), false);
  assert.equal(isRetentionDue({ fromMs: null, cutoffMs: cutoff }), false, 'sin from no vence nunca');
  assert.deepEqual(retentionSpan({ keep: { parameter: 'keepDays', unit: 'days' } }), { parameter: 'keepDays', unit: 'days' });
});

test('la ventana de restauración incluye su último milisegundo', () => {
  const deletedAtMs = Date.UTC(2026, 0, 1);
  assert.equal(isRestorable({ deletedAtMs, days: 30, nowMs: deletedAtMs + 30 * DAY - 1 }), true);
  assert.equal(isRestorable({ deletedAtMs, days: 30, nowMs: deletedAtMs + 30 * DAY }), false);
});

test('el sustituto: anon-<id> en un obligatorio de texto, null en un opcional, y cuándo no sirve', () => {
  const id = '0190f2c1-7c1e-7a33-9d2e-3f6b8a0c4d21';
  assert.equal(anonymousSubstitute(id), `${ANONYMOUS_PREFIX}${id}`);
  assert.equal(anonymizedValue({ required: true }, id), `anon-${id}`);
  assert.equal(anonymizedValue({ required: false }, id), null);
  const layers = {
    domain: {
      types: { Level: { values: ['low', 'high'] }, Phone: { base: 'string', constraints: { pattern: '^[0-9]+$' } } },
      entities: { Person: { fields: { id: { type: 'uuid', id: true } } } }
    }
  };
  const problem = (spec) => substituteProblem(layers, 'Person', 'x', spec);
  assert.equal(problem({ type: 'string', required: false }), null, 'un opcional va a null');
  assert.equal(problem({ type: 'string', required: true }), null);
  assert.equal(problem({ type: 'string', required: true, constraints: { maxLength: 41 } }), null, 'anon- y un uuid caben justos');
  assert.match(problem({ type: 'string', required: true, constraints: { maxLength: 40 } }), /maxLength/);
  assert.match(problem({ type: 'int', required: true }), /texto/);
  assert.match(problem({ type: 'Level', required: true }), /enum/);
  assert.match(problem({ type: 'Phone', required: true }), /pattern/);
});

test('las referencias que entran desde otro agregado son las que impiden borrar', () => {
  const { layers } = designOf('shop-api');
  const incoming = incomingReferences(layers, 'ProductInfo');
  assert.ok(Array.isArray(incoming));
  for (const ref of incoming) assert.notEqual(ref.entity, 'ProductInfo');
});

test('la frontera común: rechaza cada pieza del ciclo de vida con el mismo mensaje, y nada con deletion: physical', () => {
  const { layers } = derived('cards-logical');
  const errors = dataLifecyclePendingErrors(layers, 'keel-x', 9);
  assert.equal(errors.length, 4, errors.join('\n'));
  for (const error of errors) {
    assert.match(error, /keel-x todavía no lo genera — llega en el incremento 9 de PLAN-DSL-228-CICLO-DE-VIDA\.md/);
  }
  const { layers: physical } = designOf('profile-directory', (l) => {
    l.persistence.entities.ContactCard.deletion = 'physical';
  });
  assert.deepEqual(dataLifecyclePendingErrors(physical, 'keel-x', 9), []);
});

test('cada sabotaje cae en casos que existen, y cada caso lo derriba algún sabotaje o es de un gate', () => {
  const ids = new Set(DATA_LIFECYCLE_CASES.map((entry) => entry.id));
  assert.equal(ids.size, DATA_LIFECYCLE_CASES.length, 'ids repetidos');
  const covered = new Set();
  for (const [sabotage, cases] of Object.entries(DATA_LIFECYCLE_SABOTAGES)) {
    assert.match(sabotage, /^(lc|rt|pd)-[a-z-]+$/);
    for (const id of cases) {
      assert.ok(ids.has(id), `${sabotage}: ${id} no es un caso`);
      covered.add(id);
    }
  }
  // Lo que ningún sabotaje derriba se mide por su lado: PD-1 es el propio gate (sale rojo sobre la forma vetada), y LC-6,
  // LC-8 y RT-4 son el camino feliz de mecanismos que otros sabotajes ya rompen (la ventana, la unicidad y el reloj).
  const unsabotaged = [...ids].filter((id) => !covered.has(id)).sort();
  assert.deepEqual(unsabotaged, ['LC-6', 'LC-8', 'PD-1', 'RT-4']);
});

test('el inventario de datos personales: una fila por campo, con su borrado y su retención, y nada sin datos personales', () => {
  const { model } = derived('codes-anonymize');
  const inventory = personalDataInventory(model);
  assert.equal(inventory.path, PERSONAL_DATA_FILE);
  assert.match(inventory.content, /\| VerificationCode \| email \| sí \| físico \| 30 días desde `issuedAt`, y después se anonimiza \|/);
  assert.equal(personalDataInventory(derived('codes-anonymize').model).content, inventory.content, 'determinista');
  assert.match(personalDataInventory(derived('cards-logical').model).content, /30 días desde el borrado, y después se borra/);
  assert.deepEqual(personalFieldNames(derived('cards-logical').model), ['displayName', 'email']);
  const { model: plain } = designOf('verification-codes');
  assert.equal(usesPersonalData(plain), false);
  assert.equal(personalDataInventory(plain), null);
});

// ─── Lo que pide el primer generador (inc. 1) ────────────────────────────────

test('la unicidad entre vivas (D4): toda unicidad de una raíz con borrado lógico es un índice parcial con su mismo nombre', async () => {
  const { partialIndexSpecs, uniqueConstraints } = await import('../src/lib/gen/relational.js');
  const { model } = derived('cards-logical');
  const specs = partialIndexSpecs({ ...model, stack: { database: 'postgresql' } }, 'postgresql').filter((spec) => spec.entity === 'ContactCard');
  assert.deepEqual(specs.map((spec) => [spec.name, spec.columns, spec.predicate, spec.live]), [
    ['uk_contact_cards_natural', 'subject', 'deleted_at IS NULL', true],
    ['uk_contact_cards_email', 'email', 'deleted_at IS NULL', true]
  ]);
  // Los nombres son los del traductor de errores: una unicidad entre vivas sigue traduciéndose al error del diseño.
  const known = new Set(uniqueConstraints(model).map((entry) => entry.constraint));
  for (const spec of specs) assert.ok(known.has(spec.name), spec.name);
  // Con borrado físico, nada cambia: sin índices parciales que el diseño no declaró.
  const physical = designOf('profile-directory').model;
  assert.deepEqual(partialIndexSpecs({ ...physical, stack: { database: 'postgresql' } }, 'postgresql'), []);
});

test('la unicidad entre vivas en documental (T1): el filtro parcial suma deletedAt nulo, solo a las únicas', async () => {
  const { documentIndexSpecs } = await import('../src/lib/gen/document.js');
  const { model } = derived('cards-logical-mongo');
  const specs = documentIndexSpecs(model, model.entities.find((entity) => entity.name === 'ContactCard'), []);
  assert.ok(specs.length > 0);
  for (const spec of specs) assert.deepEqual(spec.live, spec.unique ? { path: 'deletedAt', equals: null } : undefined, spec.name);
});

test('la retención es un recurrente del cronómetro en modo clúster (D8), con sus parámetros', async () => {
  const { clusterRecurrings, generatorRetentions, usesTimer } = await import('../src/lib/gen/timer-plan.js');
  const { model } = derived('codes-delete');
  assert.ok(usesTimer(model));
  assert.deepEqual(generatorRetentions(model), [
    {
      entity: 'VerificationCode',
      kind: 'retention:VerificationCode',
      cron: { key: 'retention.verification-code.cron', env: 'RETENTION_VERIFICATION_CODE_CRON', default: '0 30 2 * * *', cron: true },
      batchSize: { key: 'retention.verification-code.batch-size', env: 'RETENTION_VERIFICATION_CODE_BATCH_SIZE', default: 500 }
    }
  ]);
  assert.ok(clusterRecurrings(model).some((recurring) => recurring.kind === 'retention:VerificationCode'));
  // Una retención basta para que haya cronómetro, aunque no haya plazos ni purgas.
  const { model: cards } = derived('cards-logical');
  assert.ok(usesTimer(cards));
});

test('T5: borrar o restaurar invalida la caché de las lecturas de la raíz, y la retención sabe cuáles vaciar', async () => {
  const { cacheInvalidations, retentionCaches } = await import('../src/lib/gen/cache-plan.js');
  const { model } = derived('cards-logical');
  const cached = designOf('profile-directory', (layers) => {
    DATA_LIFECYCLE_DESIGNS.find((entry) => entry.name === 'cards-logical').mutate(layers);
    layers['use-cases'].operations.getMyCard.cache = { ttlSeconds: 60, keyFields: ['callerSubject'] };
  }).model;
  assert.deepEqual(cacheInvalidations(model), []);
  assert.deepEqual(
    cacheInvalidations(cached).map((entry) => [entry.operation, entry.caches.map((cache) => cache.events).flat()]),
    [
      ['deleteMyCard', ['el borrado lógico de ContactCard']],
      ['restoreMyCard', ['la restauración de ContactCard']]
    ]
  );
  assert.deepEqual(retentionCaches(cached, 'ContactCard').map((cache) => cache.operation), ['getMyCard']);
});

test('las notas del handler: el borrado que marca y la restauración, con las llamadas del generador', async () => {
  const { deletedRootOf, deletedLookupOf, logicalDeletionNote, restoreNote } = await import('../src/lib/gen/data-lifecycle.js');
  const { model } = derived('cards-logical');
  assert.equal(deletedRootOf(model, operationOf(model, 'deleteMyCard')).name, 'ContactCard');
  assert.equal(deletedRootOf(model, operationOf(model, 'saveMyCard')), null);
  assert.deepEqual(deletedLookupOf(model.entities.find((entity) => entity.name === 'ContactCard')), { fields: ['subject'] });
  const deletion = logicalDeletionNote(model, operationOf(model, 'deleteMyCard'), { deleteCall: 'repo.deleteById(id)' });
  assert.match(deletion, /repo\.deleteById\(id\) MARCA la fila/);
  assert.match(deletion, /Se puede deshacer con restoreMyCard durante 30 días\./);
  const restore = restoreNote(model, operationOf(model, 'restoreMyCard'), { findCall: 'repo.findDeleted(x)', restoreCall: 'repo.restore(id)' });
  assert.match(restore, /repo\.findDeleted\(x\)[\s\S]*repo\.restore\(id\)[\s\S]*CARD_NOT_RESTORABLE/);
  assert.equal(logicalDeletionNote(model, operationOf(model, 'saveMyCard'), { deleteCall: 'x' }), null);
});
