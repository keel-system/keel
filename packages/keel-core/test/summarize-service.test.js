import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveServiceRef } from '../src/lib/loader.js';
import { summarizeService } from '../src/lib/summarize-service.js';

function makeServiceDir(t, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-summarize-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(base, name), content);
  }
  return base;
}

function manifest({ layers, basedOn } = {}) {
  const layerLines = (layers ?? ['domain', 'use-cases']).map((l) => `  ${l}: ${l}.keel.yaml`).join('\n');
  return (
    'keel: "2.0"\n' +
    'service:\n' +
    '  name: billing\n' +
    '  version: 1.2.0\n' +
    '  description: Gestiona la facturación de pedidos.\n' +
    '  domain: commerce\n' +
    (basedOn ? `  basedOn: ${basedOn}\n` : '') +
    `layers:\n${layerLines}\n`
  );
}

const DOMAIN_FULL = `
types:
  Money:
    fields:
      amount:   { type: decimal, required: true }
      currency: { type: string, required: true }
  InvoiceStatus:
    values: [draft, paid]
entities:
  Invoice:
    fields:
      id:     { type: uuid, id: true, generated: true }
      total:  { type: Money, required: true }
      status: { type: InvoiceStatus, required: true }
    lifecycle:
      field: status
      transitions:
        draft: [paid]
        paid: []
  InvoiceLine:
    fields:
      id: { type: uuid, id: true, generated: true }
aggregates:
  Invoice:
    root: Invoice
    entities: [InvoiceLine]
`;

const USE_CASES_FULL = `
operations:
  createInvoice:
    description: Da de alta una factura en estado draft.
    kind: command
    input:
      fields:
        total: { type: Money, required: true }
    output: { entity: Invoice }
    emits: [InvoiceCreated]
  getInvoice:
    description: Recupera una factura por su id.
    kind: query
    input:
      fields:
        id: { type: uuid, required: true }
    output: { entity: Invoice }
  reconcile:
    description: Reconcilia facturas contra pagos cada noche.
    kind: command
    internal: true
    input: "void"
    output: "void"
    schedule: { cron: "0 3 * * *" }
`;

test('summarizeService resume un servicio completo domain + use-cases', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ basedOn: 'catalog@2.0.0' }),
    'domain.keel.yaml': DOMAIN_FULL,
    'use-cases.keel.yaml': USE_CASES_FULL.replace('    emits: [InvoiceCreated]\n', '')
  });

  const result = summarizeService(dir);

  assert.deepEqual(result.service, {
    name: 'billing',
    version: '1.2.0',
    dsl: '2.0',
    domain: 'commerce',
    basedOn: 'catalog@2.0.0',
    description: 'Gestiona la facturación de pedidos.'
  });
  assert.equal(result.status.loadFailed, false);
  assert.equal(result.status.errorCount, 0, JSON.stringify(result.status.errors));
  assert.deepEqual(result.status.pending, []);
  assert.equal(result.status.ok, true);
  assert.deepEqual(result.layers.present, ['domain', 'use-cases']);
  assert.deepEqual(result.layers.absent, ['api', 'security', 'messaging', 'http-clients', 'persistence', 'storage']);

  const { domain, useCases } = result.summary;
  assert.equal(domain.typeCount, 2);
  assert.deepEqual(domain.entities, [
    { name: 'Invoice', lifecycle: true, aggregate: 'Invoice', aggregateRoot: true },
    { name: 'InvoiceLine', lifecycle: false, aggregate: 'Invoice', aggregateRoot: false }
  ]);
  assert.deepEqual(domain.aggregates, [{ name: 'Invoice', root: 'Invoice', entities: ['InvoiceLine'] }]);

  assert.deepEqual(useCases.operations, [
    { name: 'createInvoice', kind: 'command', emits: [], internal: false, schedule: false },
    { name: 'getInvoice', kind: 'query', emits: [], internal: false, schedule: false },
    { name: 'reconcile', kind: 'command', emits: [], internal: true, schedule: true }
  ]);
});

test('summarizeService resume las capas opcionales', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({
      layers: ['domain', 'use-cases', 'api', 'security', 'messaging', 'http-clients', 'persistence', 'storage']
    }),
    'domain.keel.yaml': DOMAIN_FULL,
    'use-cases.keel.yaml': USE_CASES_FULL,
    'api.keel.yaml':
      'style: rest\nbasePath: /api/v1\nauto: true\nendpoints:\n  reconcile: { method: POST, path: "/invoices/reconcile" }\n',
    'security.keel.yaml':
      'authentication:\n  protocol: oidc\nroles:\n  billing-admin: { description: Gestiona facturas. }\naccess:\n  default: { level: required }\n',
    'messaging.keel.yaml':
      'publishing:\n  reliability: outbox\n  events:\n    InvoiceCreated:\n      payload:\n        invoiceId: { type: uuid, required: true }\nsubscriptions:\n  OrderPlaced:\n    source: orders\n    payload:\n      orderId: { type: uuid, required: true }\n    triggers: createInvoice\n',
    'http-clients.keel.yaml':
      'clients:\n  payment-gateway:\n    purpose: Cobrar facturas.\n    auth: { type: api-key }\n    calls:\n      charge:\n        contract: Autoriza el cobro de una factura.\n        method: POST\n        path: /charges\n        request:\n          body:\n            invoiceId: { type: uuid, required: true }\n      getStatus:\n        contract: "GET /charges/{id} -> { status: string }"\n',
    'persistence.keel.yaml': 'default:\n  model: relational\nentities:\n  Invoice: { persisted: true }\n',
    'storage.keel.yaml': 'buckets:\n  invoicePdfs:\n    visibility: private\n  logos: {}\n'
  });

  const { layers, summary } = summarizeService(dir);

  assert.equal(layers.present.length, 8);
  assert.deepEqual(layers.absent, []);
  assert.deepEqual(summary.api, {
    style: 'rest',
    basePath: '/api/v1',
    auto: true,
    defaultAudience: 'users',
    endpoints: [{ operation: 'reconcile', method: 'POST', path: '/invoices/reconcile', audience: 'users' }]
  });
  assert.deepEqual(summary.security, {
    authentication: 'oidc',
    serviceAuth: null,
    roles: ['billing-admin'],
    serviceClients: [],
    defaultAccess: 'required'
  });
  assert.deepEqual(summary.messaging, { reliability: 'outbox', published: ['InvoiceCreated'], subscriptions: ['OrderPlaced'] });
  assert.deepEqual(summary.httpClients, {
    clients: [
      {
        name: 'payment-gateway',
        auth: 'api-key',
        calls: [
          { name: 'charge', method: 'POST', path: '/charges', typed: true },
          { name: 'getStatus', method: null, path: null, typed: false }
        ]
      }
    ]
  });
  assert.deepEqual(summary.persistence, { model: 'relational', entities: ['Invoice'] });
  assert.deepEqual(summary.storage.buckets, [
    { name: 'invoicePdfs', visibility: 'private' },
    { name: 'logos', visibility: 'private' }
  ]);
  assert.deepEqual(summary.useCases.operations[0].emits, ['InvoiceCreated']);
});

test('summarizeService marca pendientes en un servicio recién sembrado', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest().replace(
      'description: Gestiona la facturación de pedidos.',
      'description: "TODO: describe en una frase qué resuelve."'
    ),
    'domain.keel.yaml': '# plantilla\nentities:\n',
    'use-cases.keel.yaml': 'operations:\n'
  });

  const result = summarizeService(dir);

  assert.equal(result.status.loadFailed, false);
  assert.ok(result.status.pending.length >= 3); // domain plantilla + use-cases plantilla + description placeholder
  assert.deepEqual(result.summary.domain.entities, []);
  assert.deepEqual(result.summary.useCases.operations, []);
});

test('summarizeService con manifiesto roto devuelve loadFailed', (t) => {
  const dir = makeServiceDir(t, { 'service.keel.yaml': 'service: [roto\n' });

  const result = summarizeService(dir);

  assert.equal(result.status.loadFailed, true);
  assert.equal(result.service, null);
  assert.ok(result.status.errorCount > 0);
});

test('summarizeService cuenta como error una capa declarada sin archivo', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN_FULL
    // falta use-cases.keel.yaml
  });

  const result = summarizeService(dir);

  assert.equal(result.status.loadFailed, false);
  assert.ok(result.status.errorCount > 0);
  assert.ok(result.status.errors.some((e) => e.includes('use-cases')));
});

test('summarizeService refleja la ausencia de basedOn', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN_FULL,
    'use-cases.keel.yaml': USE_CASES_FULL.replace('    emits: [InvoiceCreated]\n', '')
  });

  assert.equal(summarizeService(dir).service.basedOn, null);
});

test('resolveServiceRef resuelve nombre kebab-case a specs/<nombre>', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ref-'));
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dir = path.join(base, 'specs', 'billing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'service.keel.yaml'), manifest());

  assert.equal(resolveServiceRef('billing', base).dir, dir);
  assert.ok(resolveServiceRef('no-existe', base).error);
  // una ruta se resuelve como resolveServiceDir (relativa a process.cwd)
  process.chdir(base);
  assert.equal(resolveServiceRef(path.join('specs', 'billing'), base).dir, path.resolve(dir));
});
