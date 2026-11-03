// Las ramas del DSL que ninguna fixture declara y keel-go genera: las que `capability-coverage.test.js` anota como
// `soloCadenas`, y lo que la frontera de keel-go rechazaba hasta el incremento 16. Sin fixture, go-check no las compilaría
// nunca, así que aquí se derivan de una fixture real parcheando el diseño en memoria, como en keel-nest y keel-dotnet, y se
// exige la rama en lo emitido. La compilación y las pruebas emitidas de cada una las pone su variante de go-check, con el
// MISMO parche: las dos redes no pueden mirar diseños distintos.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkCrossRefs, loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const branch = (name) => UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);

function emitted(name) {
  const { from, mutate, stack } = branch(name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
  mutate(manifest, layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: stack ?? null }).files;
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';
const allGo = (files) => files.filter((file) => file.path.endsWith('.go')).map((file) => file.content).join('\n');

test('catalog-extended-replica-fail: el lector devuelve el error declarado (replica.onMiss.error)', () => {
  assert.match(allGo(emitted('catalog-extended-replica-fail')), /return [^\n]*ErrPriceUnavailable/);
});

test('catalog-extended-replica-degrade: la prosa llega al lector o a la nota del handler (replica.onMiss.degradedTo)', () => {
  const { prose } = branch('catalog-extended-replica-degrade');
  assert.ok(allGo(emitted('catalog-extended-replica-degrade')).includes(prose.slice(0, 30)), 'la prosa de degradedTo no llega a lo emitido');
});

test('catalog-extended-activation-degrade: la prosa llega a lo emitido (activations.onFailure.degradedTo)', () => {
  const { prose } = branch('catalog-extended-activation-degrade');
  assert.ok(allGo(emitted('catalog-extended-activation-degrade')).includes(prose.slice(0, 30)), 'la prosa de degradedTo no llega a lo emitido');
});

test('payment-checkout-partial-capture: el puerto y el adaptador llevan el importe (payments.capture.amount)', () => {
  const files = emitted('payment-checkout-partial-capture');
  assert.match(content(files, 'internal/domain/payment_gateway.go'), /Capture\(ctx context\.Context, [^)]*amount \*wire\.Decimal/);
  assert.ok(content(files, 'stripe.go').includes('amount_to_capture'), 'el adaptador no manda el importe a capturar');
});

test('stock-reservation-compuesto-saliente: entra en la frontera, el cuerpo lo escribe el cable y la respuesta lo lee con su constructor', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'stock-reservation'));
  branch('stock-reservation-compuesto-saliente').mutate(manifest, layers);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], 'la frontera todavía lo rechaza');
  const files = emitted('stock-reservation-compuesto-saliente');
  const adapter = files.find((file) => file.path.endsWith('_adapter.go') && file.content.includes('ReportRefund'))?.content ?? '';
  assert.match(adapter, /Refund\s+domain\.Refund\s+`json:"refund"`/, 'el cuerpo no lleva el value object');
  assert.match(adapter, /required\(fields, "accepted"/);
  assert.match(adapter, /list\(fields, "refunds", "inventory\.reportRefund\.refunds", "una lista de Refund"/);
  // El lector del value object: un obligatorio que falta NO es su valor cero.
  const vo = content(files, 'internal/domain/refund.go');
  assert.match(vo, /Amount\s+\*wire\.Decimal/);
  assert.ok(vo.includes('if in.Amount == nil {'), 'el lector no distingue el obligatorio que falta');
  // La prueba emitida lo EJECUTA (go-check): llega como su value object, y lo que no se construye viola el contrato.
  const tests = content(files, 'clients_test.go');
  assert.ok(tests.includes('LeeRefundComoSuValueObject'));
  assert.ok(tests.includes('UnRefundQueNoSeConstruyeViolaElContrato'));
  assert.ok(tests.includes('EscribeElCompuestoDelCuerpoComoObjeto'));
  assert.ok(tests.includes('func must[T any]'));
});

test('jobs-mongo-finder: los finders sobre documentos, con los filtros del diseño como condiciones y el texto LITERAL', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch-mongo'));
  branch('jobs-mongo-finder').mutate(manifest, layers);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], 'la frontera todavía lo rechaza');
  const files = emitted('jobs-mongo-finder');
  const adapter = content(files, 'internal/infrastructure/mongo/job_repository.go');
  assert.match(adapter, /func \(r \*JobRepository\) ListQueuedJobs\(ctx context\.Context, filter domain\.ListQueuedJobsFilter\) \(\[\]\*domain\.Job, error\)/);
  assert.match(adapter, /func \(r \*JobRepository\) SearchJobs\(ctx context\.Context, filter domain\.SearchJobsFilter, pageable domain\.Pageable\) \(domain\.Page\[\*domain\.Job\], error\)/);
  assert.ok(adapter.includes('regexp.QuoteMeta'), 'el texto buscado no se escapa');
  assert.ok(adapter.includes('"$gte"') && adapter.includes('"$lt"'), 'los rangos no llegan');
  assert.ok(content(files, 'internal/infrastructure/mongo/documents.go').includes('func matching(conditions bson.A) bson.D'));
});

for (const [name, root] of [['product-catalog-declared-lock', 'Product'], ['mailer-mongo-lock', 'Template']]) {
  test(`${name}: el lockVersion declarado es opcional en el dominio (optimisticLocking: declared)`, () => {
    const entity = content(emitted(name), `internal/domain/${root.toLowerCase()}.go`);
    assert.match(entity, /lockVersion\s+\*int32/, 'el agregado lleva el lockVersion sin nil');
  });
}

// go-check, 2026-11-02: el adaptador documental leía y sembraba la versión como int64 aunque el campo declarado fuera int, y no compilaba.
test('mailer-mongo-lock: sobre documentos, la versión declarada int se lee y se siembra como Int32, el tipo de su campo', () => {
  const adapter = content(emitted('mailer-mongo-lock'), 'internal/infrastructure/mongo/template_repository.go');
  assert.ok(adapter.includes('"lock_version", optional(asInt32))'), 'la versión no se lee con el tipo del campo');
  assert.ok(adapter.includes('Key: "lock_version", Value: int32(0)'), 'la versión no se siembra con el tipo del campo');
  assert.ok(!adapter.includes('asInt64'), 'queda una lectura Int64 en el adaptador');
});

// Cada parche es un diseño VÁLIDO: uno que la validación rechaza no llegaría nunca a build.
for (const { name, from, mutate } of UNCOVERED_BRANCHES) {
  test(`${name}: es un diseño válido, y entra en la frontera`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(manifest, layers);
    assert.deepEqual(checkCrossRefs({ layers, manifest }).errors, []);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  });
}
