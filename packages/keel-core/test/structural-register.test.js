// El registro de decisiones estructurales (`structural:` en decisions.yaml). Lo que protegen estos
// tests son las formas en que un registro puede mentir sin que nadie lo note: faltar donde el
// catálogo aplica, seguir vigente cuando el diseño cambió de forma, y decir una cosa mientras el
// YAML dice otra — que es la peor, porque /keel-handoff la contaría como cierta en DESIGN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { STRUCTURAL_SECTIONS, resolveStructural } from '../src/lib/structural-register.js';
import { GAP_CLASSES } from '../src/lib/gap-classes.js';
import { loadDecisions, DECISIONS_FILE } from '../src/lib/decisions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = fs.readFileSync(
  path.join(here, '..', 'assets', 'skills', 'keel-design', 'references', 'structural-decisions.md'),
  'utf8'
);

const record = (section, extra = {}) => ({
  section,
  chosen: 'outbox',
  discarded: 'best-effort',
  reason: 'Perder el evento de facturación no es aceptable para el negocio.',
  since: '1.0.0',
  ...extra
});

/** Un diseño con eventos publicados y persistencia: aplican 3.1, 3.2, 3.7, 3.9 y 3.9b. */
const layers = (reliability) => ({
  domain: { entities: { Order: { fields: { id: { type: 'uuid', id: true } } } } },
  'use-cases': { operations: { placeOrder: { kind: 'command' } } },
  messaging: { publishing: { ...(reliability ? { reliability } : {}), events: { OrderPlaced: {} } } },
  persistence: { entities: { Order: {} } }
});

const fullRecord = (l) => GAP_CLASSES[16].units(l).map((section) => record(section));

test('las secciones son los encabezados ### 3.x del catálogo, con su título', () => {
  const headings = [...CATALOG.matchAll(/^### (3\.\d+b?) (.+)$/gm)].map(([, section, rest]) => ({
    section,
    title: rest.split(' — ')[0]
  }));
  assert.deepEqual(
    STRUCTURAL_SECTIONS.map((entry) => entry.section).sort(),
    headings.map((entry) => entry.section).sort()
  );
  for (const { section, title } of headings) {
    assert.equal(STRUCTURAL_SECTIONS.find((entry) => entry.section === section).title, title, `§${section}`);
  }
});

test('toda sección que la clase 16 puede pedir está en el catálogo del registro', () => {
  // Un diseño con todo: si la clase 16 emitiera una sección desconocida, el registro no podría cubrirla.
  const everything = {
    ...layers('outbox'),
    'use-cases': {
      operations: { placeOrder: { kind: 'command' }, listOrders: { kind: 'query', output: { entity: 'Order', list: true } } }
    },
    api: { endpoints: { listOrders: { audience: 'services' } } },
    messaging: { publishing: { events: { OrderPlaced: {} } }, subscriptions: { PaymentFailed: {} } },
    'http-clients': { clients: { ledger: {} } },
    storage: { buckets: { photos: {} } },
    dependencies: { dependencies: { ledger: { compensations: [{ onEvent: 'X' }] } } }
  };
  const known = new Set(STRUCTURAL_SECTIONS.map((entry) => entry.section));
  const units = GAP_CLASSES[16].units(everything);
  assert.equal(units.length, STRUCTURAL_SECTIONS.length, 'el diseño de prueba debería activarlas todas');
  for (const section of units) assert.ok(known.has(section), `§${section}`);
});

test('completo y de esta versión: nada que decir', () => {
  const l = layers('outbox');
  const result = resolveStructural({ structural: fullRecord(l) }, l, '1.0.0');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.recorded, result.inventory.length);
});

test('sin registro, falta toda sección aplicable — también sin decisions.yaml', () => {
  const l = layers('outbox');
  const result = resolveStructural(null, l, '1.0.0');
  assert.deepEqual(
    result.missing.map((item) => item.section),
    GAP_CLASSES[16].units(l)
  );
  assert.ok(result.missing.every((item) => item.title), 'cada sección con su título, para imprimirla');
});

test('una sección cubierta por una entrada con scope cuenta como registrada', () => {
  const l = layers('outbox');
  const structural = fullRecord(l).map((entry) =>
    entry.section === '3.9b' ? { ...entry, scope: 'persistence.audit.timestamps', chosen: 'all' } : entry
  );
  assert.deepEqual(resolveStructural({ structural }, l, '1.0.0').missing, []);
});

test('un cambio de minor caduca la entrada; un patch no', () => {
  const l = layers('outbox');
  assert.equal(resolveStructural({ structural: fullRecord(l) }, l, '1.1.0').stale.length, fullRecord(l).length);
  assert.deepEqual(resolveStructural({ structural: fullRecord(l) }, l, '1.0.7').stale, []);
});

test('un registro que contradice al YAML es incoherente', () => {
  const l = layers('best-effort');
  const structural = fullRecord(l).map((entry) =>
    entry.section === '3.1' ? { ...entry, scope: 'messaging.publishing.reliability', chosen: 'outbox' } : entry
  );
  const { mismatched } = resolveStructural({ structural }, l, '1.0.0');
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].actual, 'best-effort');
});

test('con el campo sin escribir se compara con el default, que es lo que aplicará el generador', () => {
  // `reliability` ausente es best-effort: registrar «outbox» ahí es contar como decidido algo que no está.
  const l = layers(undefined);
  const structural = fullRecord(l).map((entry) =>
    entry.section === '3.1' ? { ...entry, scope: 'messaging.publishing.reliability', chosen: 'outbox' } : entry
  );
  assert.equal(resolveStructural({ structural }, l, '1.0.0').mismatched[0]?.actual, 'best-effort');
  const coherent = structural.map((entry) => (entry.section === '3.1' ? { ...entry, chosen: 'best-effort' } : entry));
  assert.deepEqual(resolveStructural({ structural: coherent }, l, '1.0.0').mismatched, []);
});

test('un scope que no es un campo escalar del catálogo no se compara', () => {
  const l = layers('outbox');
  const structural = fullRecord(l).map((entry) =>
    entry.section === '3.2' ? { ...entry, scope: 'use-cases.placeOrder.idempotency', chosen: 'sin idempotencia' } : entry
  );
  assert.deepEqual(resolveStructural({ structural }, l, '1.0.0').mismatched, []);
});

test('una sección que ya no aplica es huérfana, no un error', () => {
  const l = layers('outbox');
  const result = resolveStructural({ structural: [...fullRecord(l), record('3.10')] }, l, '1.0.0');
  assert.deepEqual(result.orphans.map((entry) => entry.section), ['3.10']);
  assert.deepEqual(result.errors, []);
});

test('una sección fuera del catálogo o registrada dos veces es error', () => {
  const l = layers('outbox');
  const result = resolveStructural({ structural: [...fullRecord(l), record('3.99'), record('3.1')] }, l, '1.0.0');
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /3\.99/);
  assert.match(result.errors[1], /dos veces/);
});

// --- el schema ---

function withDecisions(t, content) {
  const dir = tmpDir('keel-structural-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, DECISIONS_FILE), content);
  return dir;
}

test('decisions.yaml admite structural con elegido, descartado, porqué y versión', (t) => {
  const { doc, errors } = loadDecisions(
    withDecisions(
      t,
      "structural:\n  - section: '3.1'\n    chosen: outbox\n    discarded: best-effort\n    reason: Perder el evento de facturación no es aceptable.\n    since: 1.0.0\n"
    )
  );
  assert.deepEqual(errors, []);
  assert.equal(doc.structural[0].section, '3.1');
});

test('sin la alternativa descartada no es un registro: el protocolo la exige', (t) => {
  const { errors } = loadDecisions(
    withDecisions(t, "structural:\n  - section: '3.1'\n    chosen: outbox\n    reason: Perder el evento de facturación no es aceptable.\n    since: 1.0.0\n")
  );
  assert.ok(errors.some((message) => message.includes('discarded')), errors.join('\n'));
});
