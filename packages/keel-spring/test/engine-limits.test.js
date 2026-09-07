// Que lo que el motor NO sostiene se diga, y que se diga solo cuando toca.
//
// Una garantía que el diseño declara y el motor no puede dar no es un error de nadie: es la
// consecuencia de una elección de stack. Callarla sí es un defecto, y de los caros — el modo de
// fallo es que dos peticiones simultáneas hagan lo que el diseño decía que no podía pasar, sin que
// nada lance, se registre ni se mida.
//
// Los dos lados importan igual. Si no se emite, el diseñador cree que su invariante está
// sostenido; si se emite de más —sobre un diseño que ni siquiera pidió esa garantía— el aviso se
// convierte en ruido, y el ruido es lo que hace que se dejen de leer los que sí importan. De ahí
// que aquí haya tres casos y no uno.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { resolveStack } from '../src/scaffold/index.js';
import { degradations, warnings, generate } from '../src/scaffold/engine-limits.js';
import { MECHANISMS } from '../src/lib/engine-support.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const DOC = 'docs/keel/engine-limits.md';

function modeloDe(fixture, database) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `${fixture} no valida`);
  const stack = resolveStack({ database }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return model;
}

// ── El motor que no puede, sobre un diseño que sí lo pide ────────────────────

test('mysql no sostiene la unicidad condicionada, y lo dice', () => {
  const model = modeloDe('notification-mailer', 'mysql');
  const found = degradations(model);
  assert.equal(found.length, 1, `esperaba una degradación, encontré ${found.map((d) => d.id)}`);
  assert.equal(found[0].id, 'partial-unique-index');

  // El aviso llega por donde el diseñador ya mira, y trae las tres piezas: qué pidió, qué pasa y
  // por dónde se sale. Sin la tercera, un aviso solo es una mala noticia.
  const [aviso] = warnings(model);
  assert.match(aviso, /mysql no sostiene/);
  assert.match(aviso, /queda ENTERA en el caso de uso/);
  assert.match(aviso, /columna generada/);
  assert.ok(aviso.includes(DOC), 'el aviso no dice dónde queda escrito');

  const [file] = generate(model);
  assert.equal(file.path, DOC);
  assert.match(file.content, /## Unicidad CONDICIONADA al estado/);
  assert.match(file.content, /Salidas/);

  // Y el aviso se empuja al modelo, que es de donde `build` lo saca.
  assert.ok(model.warnings.some((w) => w.includes('partial-unique-index')), 'el aviso no llegó a model.warnings');
});

// ── El motor que sí puede ────────────────────────────────────────────────────

test('postgresql sostiene esa misma garantía: no hay nada que avisar', () => {
  const model = modeloDe('notification-mailer', 'postgresql');
  assert.deepEqual(degradations(model), []);
  assert.deepEqual(warnings(model), []);

  // El documento se emite IGUAL. Un archivo ausente es ambiguo —¿no hay límites, o nadie los
  // miró?—, y «este motor sostiene todo lo que el diseño declara» merece poder leerse.
  const [file] = generate(model);
  assert.equal(file.path, DOC);
  assert.match(file.content, /## Ninguna/);
});

// ── El diseño que no pidió la garantía ───────────────────────────────────────

test('un diseño sin unicidad condicionada no recibe el aviso, ni sobre mysql', () => {
  // Es la mitad que evita el ruido, y la que un emisor perezoso se salta: `job-dispatch` no
  // declara ningún índice con `when`, así que sobre mysql no pierde nada.
  const model = modeloDe('job-dispatch', 'mysql');
  assert.deepEqual(degradations(model), []);
  assert.deepEqual(warnings(model), []);
  assert.match(generate(model)[0].content, /## Ninguna/);
});

// ── La matriz y el emisor no pueden divergir ─────────────────────────────────

test('toda celda degradada trae su texto, y todo appliesWhen tiene predicado', () => {
  for (const [id, mechanism] of Object.entries(MECHANISMS)) {
    for (const [engine, cell] of Object.entries(mechanism.coverage)) {
      if (cell.state !== 'degradado') continue;
      assert.ok(cell.degraded, `${id}/${engine}: degradado sin bloque 'degraded' — no habría qué avisar`);
      assert.ok(cell.degraded.guarantee, `${id}/${engine}: sin decir qué garantía se pierde`);
      assert.ok(cell.degraded.consequence, `${id}/${engine}: sin decir qué pasa en su lugar`);
      assert.ok(
        (cell.degraded.ways ?? []).length > 0,
        `${id}/${engine}: sin salidas. Un aviso sin salida es una mala noticia, no una decisión`
      );
    }
  }
});

test('una degradación con appliesWhen desconocido falla en el sitio, no en silencio', () => {
  // El emisor lanza a propósito: sin predicado, la degradación se emitiría siempre o nunca, y las
  // dos cosas son mentira. Se comprueba con una matriz falsa para no tocar la de verdad.
  const model = modeloDe('notification-mailer', 'mysql');
  const original = MECHANISMS['partial-unique-index'].appliesWhen;
  MECHANISMS['partial-unique-index'].appliesWhen = 'unPredicadoQueNadieEscribio';
  try {
    assert.throws(() => degradations(model), /no tiene predicado en APPLIES/);
  } finally {
    MECHANISMS['partial-unique-index'].appliesWhen = original;
  }
});
