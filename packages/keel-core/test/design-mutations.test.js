// La puerta de diseño, medida por mutación (R6 de recomendaciones-diseno.md).
//
// Hasta aquí keel-core probaba sus reglas con fixtures hechas a mano para cada una y aserciones
// del tipo `some(e => e.includes(…))`: se comprobaba que la regla dijera ALGO parecido a lo
// esperado, no que dijera eso y nada más, ni que el resto de reglas callara. De las cincuenta
// comprobaciones con id, veinticinco no aparecían en ningún test del paquete. keel-spring mide
// sus mecanismos rompiéndolos y mirando qué se pone rojo; esto es lo mismo sobre el diseño.
//
// El orden de los tests importa para leer un fallo: si el base deja de estar en silencio, todas
// las mutaciones fallan a la vez, y el primero dice por qué.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateService } from '../src/lib/validate-service.js';
import { CHECKS } from '../src/lib/checks.js';
import { OBLIGATIONS } from '../src/lib/obligations.js';
import { BASE_DIR, freshBase, evaluate } from './design-mutations/runner.js';
import { EXTENSIONS, MUTATIONS, SIN_MUTACION } from './design-mutations/catalog.js';
import { classify, gateIds, runMutation, runCorpus } from './design-mutations/matrix.js';

const entityOf = (design, name) => design.layers.domain.entities[name];

const silence = (label, result) => {
  assert.deepEqual(result.schemaErrors, [], `${label}: el schema lo rechaza`);
  assert.deepEqual(result.ids, [], `${label}: dispara ${result.ids.join(', ')}`);
  assert.deepEqual(result.anonymous, { errors: [], warnings: [] }, `${label}: dispara hallazgos sin id`);
  assert.deepEqual(result.pending, [], `${label}: deja pendientes`);
};

test('el diseño base está en silencio mecánico', () => {
  silence('base', evaluate(freshBase()));

  // Y por la puerta entera, desde disco: lo mismo que ve `keel validate`. El base no vive en
  // specs/ de un workspace, así que no hay derivados que cruzar; el careo sí se evalúa (hay
  // escenarios y no hay flow-review.yaml), y es aviso, no bloquea: por eso se mira `ok` y las
  // decisiones, no la lista de avisos.
  const result = validateService(BASE_DIR, { wip: false });
  assert.equal(result.ok, true, [...result.crossRefErrors, ...result.schemaErrors.map((e) => e.file)].join('\n'));
  assert.deepEqual(result.obligations.open, []);
  assert.deepEqual(result.undecided.open, []);
});

test('cada extensión deja el base en silencio', () => {
  for (const [name, extend] of Object.entries(EXTENSIONS)) {
    const design = freshBase();
    extend(design);
    silence(`extensión ${name}`, evaluate(design));
  }
});

test('el corpus es coherente consigo mismo y con los catálogos', () => {
  const known = new Set(gateIds());
  const seen = new Set();
  for (const mutation of MUTATIONS) {
    assert.match(mutation.id, /^M-[A-Z0-9-]+$/, `${mutation.id}: el id no sigue M-<ÁMBITO>-<NOMBRE>`);
    assert.ok(!seen.has(mutation.id), `${mutation.id}: repetido`);
    seen.add(mutation.id);
    assert.ok(mutation.title?.length > 10, `${mutation.id}: sin título`);
    // Una mutación que no espera nada no mide nada: para decir «el base sigue limpio» ya está
    // el primer test.
    assert.ok(mutation.expect.length > 0, `${mutation.id}: no espera ningún id`);
    for (const id of mutation.expect) assert.ok(known.has(id), `${mutation.id}: espera '${id}', que no está en ningún catálogo`);
    if (mutation.extends) assert.ok(mutation.extends in EXTENSIONS, `${mutation.id}: extiende algo que no existe`);
    // El ruido anónimo se declara con número y motivo, o no se declara.
    if (mutation.anonymous) assert.ok(mutation.anonymous.why?.length > 10, `${mutation.id}: ruido anónimo sin motivo`);
  }
  for (const [id, reason] of Object.entries(SIN_MUTACION)) {
    assert.ok(known.has(id), `SIN_MUTACION nombra '${id}', que no está en ningún catálogo`);
    assert.ok(reason.length > 10, `SIN_MUTACION['${id}'] sin motivo`);
  }
});

// Una por mutación, para que el fallo nombre cuál y enseñe las dos listas.
for (const mutation of MUTATIONS) {
  test(`mutación ${mutation.id}: ${mutation.title}`, () => {
    const run = runMutation(mutation);
    assert.deepEqual(run.result.schemaErrors, [], 'el schema rechaza el diseño mutado: la mutación mide un camino que la CLI no recorre');
    assert.deepEqual(run.result.ids, run.expected, 'no dispara exactamente los ids que afirma');
    const anonymous = mutation.anonymous ?? { errors: 0, warnings: 0 };
    assert.equal(run.result.anonymous.errors.length, anonymous.errors, `errores sin id:\n${run.result.anonymous.errors.join('\n')}`);
    assert.equal(
      run.result.anonymous.warnings.length,
      anonymous.warnings,
      `avisos sin id:\n${run.result.anonymous.warnings.join('\n')}`
    );
  });
}

test('todo id de la puerta está falsado por una mutación o declarado fuera de alcance', () => {
  // El ratchet de R6: una comprobación nueva con id no entra sin su mutación. Sin esto el corpus
  // envejece como las fixtures hechas a mano —cubre lo que había el día que se escribió—.
  const matrix = classify(runCorpus());
  const sinMutacion = matrix.filter((row) => row.state === 'sin-mutacion').map((row) => row.id);
  assert.deepEqual(sinMutacion, [], 'escribe su mutación en test/design-mutations/catalog.js, o su motivo en SIN_MUTACION');
  // Y SIN_MUTACION no puede esconder algo que el corpus sí ve: si una mutación lo dispara, sobra
  // la excusa.
  const fired = matrix.filter((row) => row.state !== 'fuera-de-alcance' && row.id in SIN_MUTACION).map((row) => row.id);
  assert.deepEqual(fired, [], 'estos ids están en SIN_MUTACION y una mutación los dispara: sácalos de ahí');
});

test('los estados de la matriz particionan el catálogo', () => {
  const matrix = classify(runCorpus());
  assert.equal(matrix.length, Object.keys(CHECKS).length + Object.keys(OBLIGATIONS).length);
  assert.equal(new Set(matrix.map((row) => row.id)).size, matrix.length);
});

test('el comparador se pone rojo cuando la mutación afirma otra cosa', () => {
  // El test se falsa a sí mismo, como checks.test.js: se toma una mutación verde y se le cambia
  // en caliente lo que afirma. Si el comparador tolerara un id de más, uno de menos o el ruido
  // anónimo, estas tres variantes saldrían verdes y el corpus entero sería decorativo.
  const base = MUTATIONS.find((mutation) => mutation.id === 'M-API-POST-NO-STATUS');
  assert.ok(runMutation(base).ok, 'la mutación de referencia tiene que estar verde para falsar el comparador');

  assert.equal(runMutation({ ...base, expect: [] }).ok, false, 'no ve un id de más');
  assert.equal(runMutation({ ...base, expect: [...base.expect, ...base.expect] }).ok, false, 'no ve un id de menos');
  assert.equal(runMutation({ ...base, expect: ['CHK-HTTP-NO-TIMEOUT'] }).ok, false, 'no ve un id cambiado');
  assert.equal(
    runMutation({
      ...base,
      mutate: (design) => {
        base.mutate(design);
        // Una relación a una entidad que no existe: error sin id (los avisos ya tienen todos).
        entityOf(design, 'Queue').relations = { ghost: { entity: 'Ghost', cardinality: 'many-to-one' } };
      }
    }).ok,
    false,
    'no ve un hallazgo anónimo que nadie declaró'
  );
  assert.equal(
    runMutation({
      ...base,
      mutate: (design) => {
        base.mutate(design);
        design.layers.api.endpoints.createTicket.bogus = true;
      }
    }).ok,
    false,
    'no ve que el schema rechaza el diseño mutado'
  );
});
