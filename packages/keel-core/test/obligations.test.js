// El catálogo de obligaciones vive en dos formatos —el módulo que consume `crossrefs.js` y la
// tabla en prosa que lee el diseñador— y ese reparto se rompe solo. Estos tests atan los dos,
// igual que `framework-errors.test.js` ata su catálogo con su documento.
//
// La consecuencia de que diverjan es peor aquí que allí: una obligación bloquea. Un id que la
// CLI levanta y el documento no explica manda a cerrar algo que nadie sabe qué es, y la única
// salida a mano sería aceptarlo sin entenderlo — que es exactamente el hábito que este mecanismo
// existe para romper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { OBLIGATIONS, obligationIds, obligationFor } from '../src/lib/obligations.js';
import { supportedDsl } from '../src/lib/assets.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { validateService } from '../src/lib/validate-service.js';

const DSL = supportedDsl()[0];

const docPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'core',
  'docs',
  'design-obligations.md'
);
const doc = fs.readFileSync(docPath, 'utf8');
const docRows = doc.split('\n').filter((line) => line.startsWith('| `OBL-'));

// --- paridad módulo ↔ documento ---

test('cada obligación del módulo tiene su fila en la tabla del documento', () => {
  for (const id of obligationIds()) {
    const row = docRows.find((line) => line.includes(`\`${id}\``));
    assert.ok(row, `${id} no está en la tabla de design-obligations.md`);

    const entry = OBLIGATIONS[id];
    // La clase del análisis de huecos va en la fila porque es lo que hace que el barrido del
    // agente y la validación mecánica hablen del mismo hueco con el mismo nombre.
    assert.ok(row.includes(`| ${entry.gapClass} |`), `${id}: la tabla no dice clase ${entry.gapClass} — ${row}`);
    // Y si admite aceptación o no: es la diferencia entre «decídelo tú» y «decídelo o se lo
    // queda el generador», y leerla al revés lleva a aceptar lo que no se puede aceptar.
    const aceptable = entry.waivable === false ? 'no' : 'sí';
    assert.ok(row.trimEnd().endsWith(`| ${aceptable} |`), `${id}: la tabla no dice Aceptable=${aceptable} — ${row}`);
  }
});

test('la tabla no promete obligaciones que el módulo no tenga', () => {
  // Al revés que el anterior, y hace falta: un id que se retira del módulo y se queda en el
  // documento manda a cerrar una decisión que nada levanta.
  for (const row of docRows) {
    const id = row.match(/`(OBL-[A-Z0-9-]+)`/)?.[1];
    assert.ok(obligationFor(id), `la tabla cita '${id}', que el módulo no tiene`);
  }
});

test('toda obligación declara los campos que la CLI usa para reportarla', () => {
  for (const [id, entry] of Object.entries(OBLIGATIONS)) {
    assert.ok(entry.title?.length > 10, `${id}: sin título`);
    assert.ok(entry.closes?.length > 10, `${id}: no dice cómo se cierra`);
    assert.ok(['decision', 'scenario', 'review'].includes(entry.kind), `${id}: kind desconocido`);
    assert.ok(Number.isInteger(entry.gapClass) && entry.gapClass >= 1 && entry.gapClass <= 17, `${id}: gapClass`);
  }
});

// --- lo que crossrefs levanta ---

function makeServiceDir(t, files) {
  const base = tmpDir('keel-obligations-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(base, name), content);
  return base;
}

const MANIFEST =
  `keel: "${DSL}"\n` +
  'service:\n' +
  '  name: billing\n' +
  '  version: 1.0.0\n' +
  '  description: Gestiona la facturación de pedidos.\n' +
  'layers:\n' +
  '  domain: domain.keel.yaml\n' +
  '  use-cases: use-cases.keel.yaml\n' +
  '  api: api.keel.yaml\n';

const DOMAIN = `
entities:
  Invoice:
    fields:
      id:    { type: uuid, id: true, generated: true }
      total: { type: decimal, required: true }
`;

const USE_CASES = `
operations:
  createInvoice:
    description: Da de alta una factura.
    kind: command
    input:
      fields:
        total: { type: decimal, required: true }
    output: { entity: Invoice }
    idempotency: { keySource: client-key, ttlSeconds: 3600 }
    errors:
      - { code: INVALID_TOTAL, when: El importe no es positivo., http: 400 }
`;

const API = `
endpoints:
  createInvoice: { method: POST, path: /invoices, successStatus: 201 }
`;

const layers = () => ({
  domain: { entities: { Invoice: { fields: { id: { type: 'uuid', id: true, generated: true } } } } },
  'use-cases': {
    operations: {
      createInvoice: {
        description: 'Da de alta una factura.',
        kind: 'command',
        input: { fields: { total: { type: 'decimal', required: true } } },
        output: { entity: 'Invoice' },
        idempotency: { keySource: 'client-key', ttlSeconds: 3600 }
      }
    }
  },
  api: { endpoints: { createInvoice: { method: 'POST', path: '/invoices', successStatus: 201 } } }
});

test('toda obligación que crossrefs levanta está en el catálogo', () => {
  // El helper `obligation(...)` de crossrefs ya lo garantiza lanzando, pero eso solo protege a
  // los caminos que algún test recorre. Esto lo comprueba sobre un diseño real.
  const { obligations } = checkCrossRefs({ layers: layers() });
  assert.ok(obligations.length > 0, 'el diseño de prueba no levanta ninguna obligación: no mide nada');
  for (const item of obligations) {
    assert.ok(obligationFor(item.id), `crossrefs levanta '${item.id}', que el catálogo no tiene`);
    assert.ok(item.scope?.length > 0, `${item.id}: sin scope, no se puede aceptar por escrito`);
    assert.ok(item.message?.length > 20, `${item.id}: sin mensaje`);
  }
});

// --- la puerta ---
//
// Estos dos son el par que hace que el gate signifique algo. El primero es la autocomprobación:
// si un diseño con una decisión sin tomar saliera en verde, el mecanismo entero no distinguiría
// «cerrado» de «no mira».

test('un diseño con una obligación abierta NO es generable', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': MANIFEST,
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES,
    'api.keel.yaml': API
  });
  const result = validateService(dir);

  assert.deepEqual(result.crossRefErrors, [], 'el diseño es coherente: lo que falla es la decisión sin tomar');
  assert.deepEqual(
    result.obligations.open.map((item) => item.id).sort(),
    ['OBL-IDEM-RACE-CODE', 'OBL-IDEM-REUSE-CODE']
  );
  assert.equal(result.ok, false, 'una decisión sin cerrar tiene que bloquear igual que un error');
});

test('la misma obligación aceptada por escrito deja el diseño generable', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': MANIFEST,
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES,
    'api.keel.yaml': API,
    'decisions.yaml':
      'decisions:\n' +
      '  - id: OBL-IDEM-RACE-CODE\n' +
      '    scope: use-cases\n' +
      '    reason: El canónico 409 IDEMPOTENCY_KEY_IN_PROGRESS es el contrato público del servicio.\n' +
      '    since: 1.0.0\n' +
      '  - id: OBL-IDEM-REUSE-CODE\n' +
      '    scope: use-cases\n' +
      '    reason: El canónico 409 IDEMPOTENCY_KEY_REUSED es el contrato público del servicio.\n' +
      '    since: 1.0.0\n'
  });
  const result = validateService(dir);

  assert.deepEqual(result.obligations.open, []);
  assert.equal(result.obligations.accepted.length, 2);
  assert.equal(result.ok, true);
  // Aceptada no es escondida: la CLI la sigue listando, con su motivo.
  for (const item of result.obligations.accepted) assert.ok(item.reason.length > 20, item.id);
});

test('con --wip una obligación abierta no bloquea', (t) => {
  // A mitad de diseño lo normal es tenerlas todas abiertas; exigirlas ahí solo enseñaría a
  // validar siempre con --wip.
  const dir = makeServiceDir(t, {
    'service.keel.yaml': MANIFEST,
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES,
    'api.keel.yaml': API
  });
  const result = validateService(dir, { wip: true });
  assert.equal(result.obligations.open.length, 2);
  assert.equal(result.ok, true);
});
