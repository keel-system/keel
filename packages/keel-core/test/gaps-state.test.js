import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadGaps, resolveGaps, unwalkedCount, GAPS_FILE } from '../src/lib/gaps-state.js';
import { loadReviews } from '../src/lib/review-state.js';
import { REVIEW_FILE } from '../src/lib/spec-files.js';
import { tmpDir } from './helpers/tmp.js';

const INVENTORY = [
  { class: 5, title: 'Consultas', units: ['listOrders', 'getOrder'] },
  { class: 9, title: 'Autorización a nivel de dato', units: ['listOrders', 'getOrder', 'placeOrder'] },
  { class: 12, title: 'Zonas grises de la equivalencia', units: ['service'] }
];

const complete = () => ({
  reviewedAt: '1.2.0',
  coverage: [
    { class: 5, units: ['listOrders', 'getOrder'], result: 'findings' },
    { class: 9, units: ['listOrders', 'getOrder', 'placeOrder'], result: 'clean' },
    { class: 12, units: ['service'], result: 'clean' }
  ],
  findings: [
    { class: 5, unit: 'listOrders', what: 'Sin orden declarado para la colección', severity: 'gap', state: 'decided' }
  ]
});

test('un barrido completo, de esta versión y cerrado no deja nada', () => {
  const gaps = resolveGaps(INVENTORY, complete(), '1.2.3');
  assert.deepEqual([gaps.missingClasses, gaps.missingUnits, gaps.open, gaps.errors, gaps.orphans], [[], [], [], [], []]);
  assert.equal(gaps.stale, false, 'un patch no caduca el análisis');
  assert.equal(unwalkedCount(gaps), 0);
});

test('caduca con el minor', () => {
  assert.equal(resolveGaps(INVENTORY, complete(), '1.3.0').stale, true);
});

test('una clase que falta cuenta todas sus unidades; una unidad que falta, solo esa', () => {
  const doc = complete();
  doc.coverage = doc.coverage.filter((entry) => entry.class !== 9);
  doc.coverage[0].units = ['listOrders'];
  const gaps = resolveGaps(INVENTORY, doc, '1.2.0');
  assert.deepEqual(gaps.missingClasses.map((entry) => entry.class), [9]);
  assert.deepEqual(gaps.missingUnits, [{ class: 5, title: 'Consultas', unit: 'getOrder' }]);
  assert.equal(unwalkedCount(gaps), 4);
});

test('accepted en la clase 9 es un error de formato: ahí no hay default seguro', () => {
  const doc = complete();
  doc.coverage[1].result = 'findings';
  doc.findings.push({
    class: 9, unit: 'getOrder', what: 'Cualquier usuario lee cualquier pedido', severity: 'gap', state: 'accepted',
    reason: 'Es un back-office interno con un único rol de operador.'
  });
  const gaps = resolveGaps(INVENTORY, doc, '1.2.0');
  assert.equal(gaps.errors.length, 1);
  assert.match(gaps.errors[0], /no admite 'accepted'/);
  // En la clase 5 sí se admite: el orden lo veta su CHK, no la clase.
  doc.findings = [{ ...doc.findings[0], state: 'accepted', reason: 'El cliente reordena siempre en su lado.' }];
  doc.coverage[1].result = 'clean';
  assert.deepEqual(resolveGaps(INVENTORY, doc, '1.2.0').errors, []);
});

test('un hallazgo contradice una clase marcada clean, y no puede salir de una clase sin recorrer', () => {
  const doc = complete();
  doc.coverage[0].result = 'clean';
  assert.match(resolveGaps(INVENTORY, doc, '1.2.0').errors.join('\n'), /salió limpia/);
  const sinClase = complete();
  sinClase.coverage = sinClase.coverage.filter((entry) => entry.class !== 5);
  assert.match(resolveGaps(INVENTORY, sinClase, '1.2.0').errors.join('\n'), /no está en coverage/);
});

test('los abiertos se cuentan; una clase repetida es error; lo que ya no existe es huérfano, no error', () => {
  const doc = complete();
  doc.findings[0].state = 'open';
  doc.coverage.push({ class: 12, units: ['service'], result: 'clean' });
  doc.coverage[0].units.push('searchOrders');
  doc.coverage.push({ class: 17, units: ['sendReceipt'], result: 'clean' });
  const gaps = resolveGaps(INVENTORY, doc, '1.2.0');
  assert.equal(gaps.open.length, 1);
  assert.deepEqual(gaps.errors, [`${GAPS_FILE}: la clase 12 aparece dos veces en coverage`]);
  assert.deepEqual(gaps.orphans, [
    { class: 5, units: ['searchOrders'] },
    { class: 17, units: ['sendReceipt'] }
  ]);
});

test('loadGaps: ausente no es error; el schema exige reason en un accepted', () => {
  const dir = tmpDir('gaps-state-');
  assert.deepEqual(loadGaps(dir), { doc: null, errors: [] });
  const doc = complete();
  doc.findings[0].state = 'accepted';
  fs.writeFileSync(path.join(dir, GAPS_FILE), YAML.stringify(doc));
  const { doc: loaded, errors } = loadGaps(dir);
  assert.equal(loaded, null);
  assert.match(errors.join('\n'), /reason/);
});

test('review.yaml con coverage da el error de migración, no el genérico de Ajv', () => {
  const dir = tmpDir('gaps-migration-');
  fs.writeFileSync(
    path.join(dir, REVIEW_FILE),
    YAML.stringify({ reviewedAt: '1.0.0', coverage: [{ gapClass: 4, units: ['x'], result: 'clean' }] })
  );
  const { doc, errors } = loadReviews(dir);
  assert.equal(doc, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /se movió a gaps\.yaml/);
});
