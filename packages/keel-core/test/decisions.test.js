// El registro de decisiones: lo que convierte «aceptado» de una frase en la conversación a un
// artefacto versionado. Lo que estos tests protegen no es el formato sino las tres formas en
// que un registro puede mentir: aceptar algo que nadie sabe qué es (id fuera del catálogo),
// aceptar lo que no se puede aceptar, y seguir vigente cuando el diseño que lo sostenía cambió.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { OBLIGATIONS } from '../src/lib/obligations.js';
import { loadDecisions, resolveObligations, resolveUndecided, DECISIONS_FILE } from '../src/lib/decisions.js';

const raised = (id = 'OBL-IDEM-REUSE-CODE', scope = 'use-cases') => [{ id, scope, message: 'sin nombrar el code' }];

const entry = (extra = {}) => ({
  id: 'OBL-IDEM-REUSE-CODE',
  scope: 'use-cases',
  reason: 'El canónico es el contrato público de este servicio.',
  since: '1.0.0',
  ...extra
});

function withDecisions(t, content) {
  const dir = tmpDir('keel-decisions-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (content != null) fs.writeFileSync(path.join(dir, DECISIONS_FILE), content);
  return dir;
}

// --- lectura del archivo ---

test('la ausencia del archivo no es un error', (t) => {
  // Un diseño que cierra todo en el DSL no necesita el archivo, y a mitad de diseño todavía
  // no existe. Exigirlo obligaría a sembrar un archivo vacío en cada servicio.
  const { doc, errors } = loadDecisions(withDecisions(t, null));
  assert.equal(doc, null);
  assert.deepEqual(errors, []);
});

test('un motivo que no dice nada no vale como decisión', (t) => {
  // El motivo es lo único que distingue una decisión de un olvido: sin cota, `reason: ok`
  // convierte el registro en un sello de goma.
  const dir = withDecisions(
    t,
    'decisions:\n  - id: OBL-IDEM-REUSE-CODE\n    scope: use-cases\n    reason: ok\n    since: 1.0.0\n'
  );
  const { doc, errors } = loadDecisions(dir);
  assert.equal(doc, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reason/);
});

test('YAML roto se reporta como tal y no revienta la validación', (t) => {
  const { doc, errors } = loadDecisions(withDecisions(t, 'decisions: [\n'));
  assert.equal(doc, null);
  assert.match(errors[0], /YAML inválido/);
});

// --- cruce con lo que el diseño levanta ---

test('una decisión sobre una obligación levantada la deja aceptada', () => {
  const result = resolveObligations(raised(), { decisions: [entry()] }, '1.0.0');
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.open, []);
  assert.deepEqual(result.errors, []);
});

test('un id que el catálogo no tiene es error', () => {
  const result = resolveObligations(raised(), { decisions: [entry({ id: 'OBL-INVENTADA' })] }, '1.0.0');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /no está en el catálogo/);
  // Y la obligación real sigue abierta: un id inventado no cierra nada.
  assert.equal(result.open.length, 1);
});

test('el scope importa: aceptar una obligación en otro sitio no la cierra aquí', () => {
  const result = resolveObligations(raised(), { decisions: [entry({ scope: 'persistence' })] }, '1.0.0');
  assert.equal(result.open.length, 1);
  assert.equal(result.orphans.length, 1);
});

test('una decisión sobre algo que el diseño ya no levanta es huérfana', () => {
  const result = resolveObligations([], { decisions: [entry()] }, '1.0.0');
  assert.deepEqual(result.open, []);
  assert.equal(result.orphans.length, 1);
  // No es un error: cerrarlo en el DSL es justo lo que se quería. Es basura que confunde.
  assert.deepEqual(result.errors, []);
});

test('la misma obligación aceptada dos veces es error', () => {
  const result = resolveObligations(raised(), { decisions: [entry(), entry({ reason: 'Otro motivo distinto.' })] }, '1.0.0');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /dos veces/);
});

// --- caducidad ---

test('un cambio de minor caduca la aceptación', () => {
  const result = resolveObligations(raised(), { decisions: [entry({ since: '1.0.0' })] }, '1.1.0');
  assert.deepEqual(result.accepted, []);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].since, '1.0.0');
});

test('un cambio de major caduca la aceptación', () => {
  const result = resolveObligations(raised(), { decisions: [entry({ since: '1.4.0' })] }, '2.0.0');
  assert.equal(result.stale.length, 1);
});

test('un patch NO caduca la aceptación', () => {
  // Reafirmar por cada errata corregida enseña a subir el número sin leer, que es el hábito
  // que este archivo existe para romper.
  const result = resolveObligations(raised(), { decisions: [entry({ since: '1.4.0' })] }, '1.4.7');
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.stale, []);
});

// --- lo que no se puede aceptar ---

test('una obligación que no admite aceptación no se puede aceptar', (t) => {
  // Todavía no hay ninguna así en el catálogo, y por eso se fabrica: la regla llega del análisis
  // de huecos (hay clases sin default seguro, donde «aceptado» significa dejárselo al generador)
  // y tiene que estar viva antes de que exista la primera, no después.
  OBLIGATIONS['OBL-TEST-NO-WAIVABLE'] = {
    gapClass: 9,
    when: 'test',
    kind: 'decision',
    waivable: false,
    title: 'obligación de prueba que no admite aceptación',
    closes: 'ciérrala en el diseño'
  };
  t.after(() => {
    delete OBLIGATIONS['OBL-TEST-NO-WAIVABLE'];
  });

  const result = resolveObligations(
    raised('OBL-TEST-NO-WAIVABLE', 'security'),
    { decisions: [entry({ id: 'OBL-TEST-NO-WAIVABLE', scope: 'security' })] },
    '1.0.0'
  );
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /no admite aceptación/);
  assert.equal(result.open.length, 1, 'y sigue abierta: la entrada no la cierra');
});

// --- los avisos que son decisiones no tomadas (CHK-* con nature: undecided) ---
// Mismo registro y mismas tres formas de mentir, más una propia: aceptar una INCOHERENCIA,
// que no es una pregunta sino un diseño roto.

const finding = (id = 'CHK-USECASES-CODE-MULTI-STATUS', scope = 'use-cases.errors.NOT_FOUND') => ({
  id,
  scope,
  severity: 'warning',
  message: 'el mismo code con dos status'
});
const accepted = (extra = {}) => ({
  id: 'CHK-USECASES-CODE-MULTI-STATUS',
  scope: 'use-cases.errors.NOT_FOUND',
  reason: 'Deliberado: el 404 y el 410 son la misma ausencia vista desde dos operaciones.',
  since: '1.0.0',
  ...extra
});

test('un aviso undecided aceptado con su id y su scope queda aceptado', () => {
  const result = resolveUndecided([finding()], { decisions: [accepted()] }, '1.0.0');
  assert.deepEqual(result.open, []);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].reason, accepted().reason);
  assert.deepEqual(result.errors, []);
});

test('sin aceptación, un aviso undecided queda abierto y dice si se puede aceptar', () => {
  const result = resolveUndecided(
    [finding(), finding('CHK-API-POST-NO-STATUS', 'api.endpoints.createOrder')],
    null,
    '1.0.0'
  );
  assert.deepEqual(
    result.open.map((item) => [item.id, item.waivable]),
    [
      ['CHK-USECASES-CODE-MULTI-STATUS', true],
      ['CHK-API-POST-NO-STATUS', false]
    ]
  );
});

test('los avisos que son incoherencias no entran en la cuenta', () => {
  const result = resolveUndecided([finding('CHK-SEC-UNUSED-ROLE', undefined)], null, '1.0.0');
  assert.deepEqual(result.open, []);
});

test('la aceptación de un aviso caduca con el minor y queda huérfana si el diseño ya no lo levanta', () => {
  assert.equal(resolveUndecided([finding()], { decisions: [accepted()] }, '1.1.0').stale.length, 1);
  assert.equal(resolveUndecided([finding()], { decisions: [accepted()] }, '1.0.7').accepted.length, 1);
  assert.equal(resolveUndecided([], { decisions: [accepted()] }, '1.0.0').orphans.length, 1);
});

test('aceptar una incoherencia, lo no aceptable o un id que no existe es error', () => {
  const casos = [
    [accepted({ id: 'CHK-SEC-UNUSED-ROLE' }), /es una incoherencia/],
    [accepted({ id: 'CHK-API-POST-NO-STATUS', scope: 'api.endpoints.createOrder' }), /no admite aceptación/],
    [accepted({ id: 'CHK-USECASES-COLLECTION-NO-SORT' }), /no admite aceptación/],
    [accepted({ id: 'CHK-NO-EXISTE' }), /no está en el catálogo de comprobaciones/]
  ];
  for (const [entry, pattern] of casos) {
    const { errors, accepted: ok } = resolveUndecided([finding(entry.id, entry.scope)], { decisions: [entry] }, '1.0.0');
    assert.equal(errors.length, 1, entry.id);
    assert.match(errors[0], pattern);
    assert.deepEqual(ok, []);
  }
  const dos = resolveUndecided([finding()], { decisions: [accepted(), accepted()] }, '1.0.0');
  assert.match(dos.errors[0], /dos veces/);
});

test('las dos resoluciones leen el mismo archivo sin pisarse', () => {
  // Una entrada CHK-* no es una obligación desconocida para resolveObligations, ni una OBL-*
  // un aviso desconocido para resolveUndecided: cada una mira lo suyo.
  const doc = { decisions: [entry(), accepted()] };
  const obligations = resolveObligations(raised(), doc, '1.0.0');
  assert.deepEqual(obligations.errors, []);
  assert.equal(obligations.accepted.length, 1);
  const undecided = resolveUndecided([finding()], doc, '1.0.0');
  assert.deepEqual(undecided.errors, []);
  assert.equal(undecided.accepted.length, 1);
});

test('el schema de decisions.yaml admite CHK-* además de OBL-*', (t) => {
  const dir = withDecisions(
    t,
    [
      'decisions:',
      '  - id: CHK-USECASES-CODE-MULTI-STATUS',
      '    scope: use-cases.errors.NOT_FOUND',
      '    reason: Deliberado, la misma ausencia vista desde dos operaciones.',
      '    since: 1.0.0',
      ''
    ].join('\n')
  );
  const { doc, errors } = loadDecisions(dir);
  assert.deepEqual(errors, []);
  assert.equal(doc.decisions[0].id, 'CHK-USECASES-CODE-MULTI-STATUS');
});
