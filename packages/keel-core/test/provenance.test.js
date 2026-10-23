import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from '../src/lib/loader.js';
import { PROVENANCE_FILE, loadProvenance, provenanceInventory, readCharacterization, resolveProvenance } from '../src/lib/provenance.js';
import { SPEC_SIDE_FILES, sideFilesOf } from '../src/lib/spec-files.js';

// La procedencia de un diseño recuperado (keel-recover, PLAN-KEEL-RECOVER.md § 0). Lo que importa
// es el inventario: lo deriva la máquina de las capas, así que un elemento que el agente añadió sin
// declararlo (el rol copiado de una fixture del inc. 1) sale como `missing` aunque ninguna fila mienta.

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(here, 'design-mutations', 'base');
const { layers } = loadService(BASE);

function dirWith(doc) {
  const dir = tmpDir('keel-provenance-');
  if (doc !== undefined) fs.writeFileSync(path.join(dir, PROVENANCE_FILE), typeof doc === 'string' ? doc : YAML.stringify(doc));
  return dir;
}

const full = (ids, over = {}) => ({
  kind: 'provenance',
  schema: 1,
  legacy: { name: 'ticket-desk', commit: 'ba04b70' },
  elements: ids.map((element) => ({ element, level: 'measured', evidence: 'recordings/round-1/P-001.json' })),
  ...over,
});

test('inventario: cada colección con nombre, los campos, los errores, el acceso, los eventos; nunca la prosa', () => {
  const ids = provenanceInventory(layers);
  for (const id of [
    'domain.entities.Ticket',
    'domain.entities.Ticket.fields.status',
    'domain.entities.Ticket.lifecycle',
    'domain.aggregates.Ticket',
    'use-cases.operations.createTicket',
    'use-cases.operations.getTicket.errors.TICKET_NOT_FOUND',
    'persistence.entities.Ticket',
    'api.endpoints.createTicket',
    'security.roles.agent',
    'security.permissions.ticket:write',
    'security.access.default',
    'messaging.publishing.reliability',
    'messaging.publishing.events.TicketClosed',
    'messaging.subscriptions.TicketEscalated',
    'storage.buckets.ticketAttachments',
    'mail.delivery',
  ]) {
    assert.ok(ids.includes(id), `${id} en el inventario`);
  }
  assert.ok(!ids.some((id) => id.endsWith('.description')), 'la prosa no es un elemento');
  assert.equal(new Set(ids).size, ids.length, 'sin repetidos');
  assert.deepEqual(provenanceInventory(layers), ids, 'determinista');
  assert.deepEqual(provenanceInventory({}), []);
});

test('un diseño hacia delante (sin provenance.yaml ni origin) no tiene procedencia que juzgar', () => {
  const r = resolveProvenance(loadProvenance(dirWith()), layers, { structural: [{ section: '3.1' }] });
  assert.equal(r.applies, false);
  assert.deepEqual(r.missing, []);
});

test('procedencia entera: sin faltas; la forma `elements` cubre varios con la misma evidencia', () => {
  const ids = provenanceInventory(layers);
  const doc = full(ids.slice(2));
  doc.elements.push({ elements: ids.slice(0, 2), level: 'read', evidence: 'src/models/Ticket.js:12' });
  const r = resolveProvenance(loadProvenance(dirWith(doc)), layers, null);
  assert.equal(r.applies, true);
  for (const k of ['missing', 'inferred', 'orphans', 'unsourced', 'structuralUnsourced', 'errors']) assert.deepEqual(r[k], [], k);
});

test('lo que el agente añadió sin fila es `missing`, aunque ninguna fila escrita mienta', () => {
  const ids = provenanceInventory(layers).filter((id) => id !== 'security.roles.agent');
  const r = resolveProvenance(loadProvenance(dirWith(full(ids))), layers, null);
  assert.deepEqual(r.missing, ['security.roles.agent']);
});

test('inferred, read sin archivo:línea, filas de otro diseño y filas repetidas', () => {
  const ids = provenanceInventory(layers);
  const doc = full(ids);
  doc.elements[0].level = 'inferred';
  Object.assign(doc.elements[1], { level: 'read', evidence: 'lo dice el código' });
  doc.elements.push({ element: 'domain.entities.Ghost', level: 'measured', evidence: 'R1-001' });
  doc.elements.push({ element: ids[2], level: 'asked', evidence: 'decisión del humano' });
  const r = resolveProvenance(loadProvenance(dirWith(doc)), layers, null);
  assert.deepEqual(r.inferred, [ids[0]]);
  assert.deepEqual(r.unsourced, [ids[1]]);
  assert.deepEqual(r.orphans, ['domain.entities.Ghost']);
  assert.deepEqual(r.errors, [`${PROVENANCE_FILE}: ${ids[2]} tiene dos filas`]);
});

test('en un diseño recuperado, cada decisión estructural dice qué hacía el legacy (origin)', () => {
  const ids = provenanceInventory(layers);
  const decisions = { structural: [{ section: '3.1', origin: 'observed', evidence: 'R1-021' }, { section: '3.2', scope: 'use-cases.operations.createTicket' }] };
  const r = resolveProvenance(loadProvenance(dirWith(full(ids))), layers, decisions);
  assert.deepEqual(r.structuralUnsourced, ['§3.2 (use-cases.operations.createTicket)']);

  // y al revés: un registro con origin sin provenance.yaml delata un recuperado sin procedencia
  const orphanRegister = resolveProvenance(loadProvenance(dirWith()), layers, { structural: [{ section: '3.1', origin: 'omitted' }] });
  assert.equal(orphanRegister.applies, true);
  assert.equal(orphanRegister.missing.length, ids.length);
  assert.match(orphanRegister.errors[0], /no hay provenance\.yaml/);
});

test('un provenance.yaml roto sigue declarando un diseño recuperado: error, nunca «no aplica»', () => {
  const broken = loadProvenance(dirWith('elements: [: nada'));
  assert.equal(broken.present, true);
  assert.match(broken.errors[0], /YAML inválido/);
  const bad = loadProvenance(dirWith({ kind: 'provenance', schema: 1, legacy: { name: 'x' }, elements: [{ element: 'a', level: 'operator', evidence: 'R1' }] }));
  assert.ok(bad.errors.some((e) => /level/.test(e) || /allowed values/.test(e)), bad.errors.join('; '));
  const r = resolveProvenance(bad, layers, null);
  assert.equal(r.applies, true);
  assert.ok(r.errors.length > 0);
});

test('provenance.yaml no viaja ni al publicar ni al derivar: cita un código privado', () => {
  assert.deepEqual(SPEC_SIDE_FILES.find((e) => e.file === PROVENANCE_FILE), { file: PROVENANCE_FILE, publish: false, derive: false });
  const dir = dirWith(full([]));
  assert.deepEqual(sideFilesOf(dir, 'publish'), []);
  assert.deepEqual(sideFilesOf(dir, 'derive'), []);
});

test('paso 4: cada flujo dice keep, fix, frontier o new, y lo que cita existe', () => {
  const text = [
    '# Escenarios',
    '### FL-A-001: uno\n**Caracterización**: `keep`. Evidencia: R1-001.\n**Given**: nada.',
    '### FL-A-002: dos\n**Caracterizacion**: `fix` (`fix-409`: el legacy responde `422`). Evidencia: R1-002.',
    '### FL-A-003: tres\n**Caracterización**: `frontier` (`F-OWNER`).',
    '### FL-A-004: cuatro\n**Caracterización**: `frontier` (`F-NADA`).',
    '### FL-A-005: cinco\n**Given**: sin marca.',
    '### FL-A-006: seis\n**Caracterización**: `quizá`.',
  ].join('\n\n');
  const doc = {
    fixes: [{ id: 'fix-409' }, { id: 'fix-huerfano' }],
    frontier: [{ id: 'F-OWNER' }],
  };
  const c = readCharacterization(text, doc);
  assert.deepEqual(c.flows.map((f) => `${f.id}:${f.mark}:${f.ref}`), ['FL-A-001:keep:null', 'FL-A-002:fix:fix-409', 'FL-A-003:frontier:F-OWNER', 'FL-A-004:frontier:F-NADA']);
  assert.deepEqual(c.unmarked, ['FL-A-005', 'FL-A-006']);
  assert.deepEqual(c.unknown, [`FL-A-004: frontier F-NADA no está en ${PROVENANCE_FILE} → frontier`]);
  assert.deepEqual(c.unusedFixes, ['fix-huerfano'], 'un cambio sin escenario no es un cambio');
  assert.deepEqual(readCharacterization(null, doc), { flows: [], unmarked: [], unknown: [], unusedFixes: [] });
});

test('paso 4: un fix que ningún flujo HTTP ve lo dice con noFlow, y un flujo que lo cita lo contradice', () => {
  const noFlow = { why: 'los huérfanos solo se ven en la base', proof: 'recordings/round-1/R1-032.json' };
  const doc = { fixes: [{ id: 'fix-409' }, { id: 'fix-cascada', noFlow }, { id: 'fix-identidad', noFlow }], frontier: [] };
  const text = [
    '### FL-A-001: uno\n**Caracterización**: `fix` (`fix-409`).',
    '### FL-A-002: dos\n**Caracterización**: `fix` (`fix-identidad`).',
  ].join('\n\n');
  const c = readCharacterization(text, doc);
  assert.deepEqual(c.unusedFixes, [], 'fix-cascada no tiene flujo y lo declara');
  assert.deepEqual(c.unknown, [`FL-A-002: fix fix-identidad declara noFlow en ${PROVENANCE_FILE} y este flujo lo demuestra`]);
  const sinDeclarar = readCharacterization(text, { ...doc, fixes: [{ id: 'fix-409' }, { id: 'fix-cascada' }] });
  assert.deepEqual(sinDeclarar.unusedFixes, ['fix-cascada'], 'sin noFlow sigue siendo un cambio sin escenario');
});

test('el schema exige el porqué y la otra prueba de un noFlow', () => {
  const base = { kind: 'provenance', schema: 1, legacy: { name: 'x', commit: 'abc1234' }, elements: [], frontier: [] };
  const fix = { id: 'fix-cascada', legacy: 'deja huérfanos', reason: 'decidido por el humano', evidence: 'R1-032' };
  const ok = loadProvenance(dirWith({ ...base, fixes: [{ ...fix, noFlow: { why: 'solo se ve en la base', proof: 'R1-032' } }] }));
  assert.deepEqual(ok.errors, []);
  const bad = loadProvenance(dirWith({ ...base, fixes: [{ ...fix, noFlow: { why: 'solo se ve en la base' } }] }));
  assert.ok(bad.errors.some((e) => /proof/.test(e)), bad.errors.join('; '));
});
