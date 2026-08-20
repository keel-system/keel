import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { supportedDsl } from '../src/lib/assets.js';

// Versión vigente del DSL: derivada, no escrita. Solo se soporta una, y un literal
// aquí volvería a romper estos tests en el siguiente cambio de versión.
const DSL = supportedDsl()[0];
import { validateService } from '../src/lib/validate-service.js';

function makeServiceDir(t, files) {
  const base = tmpDir('keel-validate-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(base, name), content);
  }
  return base;
}

function manifest({ layers = ['domain', 'use-cases'], description = 'Gestiona la facturación de pedidos.' } = {}) {
  const layerLines = layers.map((l) => `  ${l}: ${l}.keel.yaml`).join('\n');
  return (
    `keel: "${DSL}"\n` +
    'service:\n' +
    '  name: billing\n' +
    '  version: 1.0.0\n' +
    `  description: ${description}\n` +
    `layers:\n${layerLines}\n`
  );
}

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
    internal: true
    input:
      fields:
        total: { type: decimal, required: true }
    output: { entity: Invoice }
`;

// --- camino feliz ---

test('un diseño completo y coherente valida en verde', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES
  });
  const result = validateService(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.loadErrors, []);
  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.crossRefErrors, []);
  assert.deepEqual(result.pending, []);
});

test('los warnings no impiden que el diseño sea generable', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN,
    // sin internal ni endpoint ni schedule: operación huérfana, que es warning
    'use-cases.keel.yaml': USE_CASES.replace('    internal: true\n', '')
  });
  const result = validateService(dir);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('operación huérfana')));
});

// --- capa 0: diseño incompleto (plantillas y placeholders) ---

test('una capa obligatoria en estado plantilla es pending, no error de schema', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': 'operations:\n'
  });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.schemaErrors, []);
  assert.ok(result.pending.some((p) => p.includes('use-cases.keel.yaml sigue siendo la plantilla: no define ninguna operación')));
});

test('cada capa con plantilla reconocible se detecta por su hint', (t) => {
  const cases = {
    domain: ['entities:\n', 'no define ninguna entidad'],
    'use-cases': ['operations:\n', 'no define ninguna operación'],
    messaging: ['publishing:\n  events:\n', 'no define eventos publicados ni suscripciones'],
    'http-clients': ['clients:\n', 'no define ningún cliente'],
    dependencies: ['dependencies:\n', 'no declara ninguna dependencia'],
    persistence: ['entities:\n', 'no menciona ninguna entidad']
  };
  for (const [layer, [content, hint]] of Object.entries(cases)) {
    const files = {
      'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', layer].filter((l, i, a) => a.indexOf(l) === i) }),
      'domain.keel.yaml': DOMAIN,
      'use-cases.keel.yaml': USE_CASES
    };
    files[`${layer}.keel.yaml`] = content;
    const result = validateService(makeServiceDir(t, files));
    assert.ok(
      result.pending.some((p) => p.includes(`${layer}.keel.yaml sigue siendo la plantilla: ${hint}`)),
      `${layer}: no se detectó la plantilla (${JSON.stringify(result.pending)})`
    );
  }
});

test('una description que sigue siendo TODO es pending', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ description: 'TODO describe el servicio' }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES
  });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.ok(result.pending.some((p) => p.includes('service.description sigue siendo un placeholder')));
});

test('el placeholder heredado de las plantillas antiguas también es pending', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({
      description: 'Describe en una frase qué problema de negocio resuelve este servicio.'
    }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES
  });
  const result = validateService(dir);
  assert.ok(result.pending.some((p) => p.includes('service.description sigue siendo un placeholder')));
});

// --- schema: las dos formas de depender ---

test('una dependencia que ni lee ni pide trabajo no cumple el schema', (t) => {
  const withDependency = (body) => ({
    'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', 'dependencies'] }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES,
    'dependencies.keel.yaml': `dependencies:\n  catalog:\n    description: Fuente de verdad de productos.\n${body}`
  });

  // Ni needs ni activations: declarar el proveedor no declara ninguna dependencia.
  const empty = validateService(makeServiceDir(t, withDependency('')));
  assert.ok(empty.schemaErrors.some((entry) => entry.file === 'dependencies.keel.yaml'));

  // Solo activations: es una dependencia legítima, no una a la que le falte algo.
  const activationOnly = validateService(
    makeServiceDir(
      t,
      withDependency(
        '    activations:\n' +
          '      requestInvoice:\n' +
          '        triggeredBy: [reconcile]\n' +
          '        via: { publishes: InvoiceRequested }\n' +
          '        effect: El proveedor emite la factura del pedido.\n'
      )
    ),
    { wip: true }
  );
  assert.deepEqual(activationOnly.schemaErrors, []);
});

// --- el corte antes de las referencias cruzadas ---

test('sin --wip los pendientes cortan antes de cruzar referencias', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ description: 'TODO describe el servicio' }),
    'domain.keel.yaml': DOMAIN,
    // referencia una entidad inexistente: si se llegara a cruzar, saldría en crossRefErrors
    'use-cases.keel.yaml': USE_CASES.replace('{ entity: Invoice }', '{ entity: Receipt }')
  });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.crossRefErrors, []);
  assert.deepEqual(result.warnings, []);
});

test('con --wip los pendientes no cortan y las referencias sí se cruzan', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ description: 'TODO describe el servicio' }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES.replace('{ entity: Invoice }', '{ entity: Receipt }')
  });
  const result = validateService(dir, { wip: true });
  assert.equal(result.ok, false);
  assert.ok(result.crossRefErrors.some((e) => e.includes(`la entidad 'Receipt' no existe en domain: entities`)));
});

test('un error de schema corta antes de cruzar referencias', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest(),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES + '    campoDesconocido: 1\n'
  });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.ok(result.schemaErrors.some((entry) => entry.file === 'use-cases.keel.yaml'));
  assert.deepEqual(result.crossRefErrors, []);
});

test('una capa en plantilla no se valida contra su schema', (t) => {
  // `messaging: publishing: events:` sin events viola el anyOf del schema; como es
  // plantilla, se reporta como pending y no como error de schema.
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', 'messaging'] }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES,
    'messaging.keel.yaml': 'publishing:\n  events:\n'
  });
  const result = validateService(dir);
  assert.deepEqual(result.schemaErrors, []);
  assert.ok(result.pending.some((p) => p.includes('messaging.keel.yaml sigue siendo la plantilla')));
});

// --- en modo wip, una capa en plantilla se trata como ausente al cruzar ---

test('con --wip un emits contra una messaging en plantilla queda pendiente, no roto', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', 'messaging'] }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES + '    emits: [InvoiceCreated]\n',
    'messaging.keel.yaml': 'publishing:\n  events:\n'
  });
  const result = validateService(dir, { wip: true });
  assert.deepEqual(result.crossRefErrors, []);
  assert.ok(
    result.pending.some((p) => p.includes(`emits: el evento 'InvoiceCreated' está pendiente de definir en messaging`))
  );
});

test('con la capa messaging ya diseñada un emits desconocido sí es error', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', 'messaging'] }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES + '    emits: [InvoiceCreated]\n',
    'messaging.keel.yaml': 'publishing:\n  events:\n    InvoicePaid:\n      payload: { id: { type: uuid } }\n'
  });
  const result = validateService(dir, { wip: true });
  assert.equal(result.ok, false);
  assert.ok(
    result.crossRefErrors.some((e) =>
      e.includes(`emits: el evento 'InvoiceCreated' no está en messaging: publishing.events`)
    )
  );
});

// --- carga ---

test('sin manifiesto se devuelve el resultado vacío sin tocar schemas', (t) => {
  const dir = makeServiceDir(t, { 'domain.keel.yaml': DOMAIN });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.equal(result.manifest, undefined);
  assert.ok(result.loadErrors.length > 0);
  assert.deepEqual(result.schemaErrors, []);
});

test('un error de carga corta antes de cruzar referencias', (t) => {
  const dir = makeServiceDir(t, {
    'service.keel.yaml': manifest({ layers: ['domain', 'use-cases', 'persistence'] }),
    'domain.keel.yaml': DOMAIN,
    'use-cases.keel.yaml': USE_CASES
    // persistence.keel.yaml declarado en layers pero ausente del disco
  });
  const result = validateService(dir);
  assert.equal(result.ok, false);
  assert.ok(result.loadErrors.length > 0);
  assert.deepEqual(result.crossRefErrors, []);
});

// validation-scenarios.md es el único derivado que la validación mecánica lee, y solo
// para una regla: la obligación de los dos escenarios de una compensación. Aquí se
// comprueba el CABLEADO —que el archivo llegue desde disco hasta la regla—; el
// contenido de la regla lo cubre crossrefs.test.js.

const COMPENSATION_LAYERS = {
  'domain.keel.yaml': `
entities:
  Shipment:
    description: Un envío encargado a la transportista.
    fields:
      id:     { type: uuid, id: true, generated: true }
      status: { type: enum, values: [requested, dispatched, cancelled], default: requested }
      requestShipmentAwaitingSince: { type: timestamp }
    lifecycle:
      field: status
      transitions:
        requested: [dispatched, cancelled]
        dispatched: [cancelled]
        cancelled: [requested]
`,
  'use-cases.keel.yaml': `
operations:
  dispatchShipment:
    description: Encarga el envío a la transportista.
    kind: command
    internal: true
    input:
      fields:
        shipmentId: { type: uuid, required: true }
    output: void
    transitions:
      - { entity: Shipment, from: [requested], to: dispatched }
  cancelShipment:
    description: Anula el envío que la transportista rechazó.
    kind: command
    internal: true
    input:
      fields:
        shipmentId: { type: uuid, required: true }
    output: void
    transitions:
      - { entity: Shipment, from: [dispatched], to: cancelled }
  sweepShipments:
    description: Revisa los envíos encargados que siguen sin desenlace.
    kind: command
    internal: true
    input: void
    output: void
    schedule: { cron: '0 * * * *' }
`,
  'messaging.keel.yaml': `
subscriptions:
  ShipmentRejected:
    description: La transportista rechazó el envío encargado.
    source: carrier
    payload:
      shipmentId: { type: uuid, required: true }
    triggers: cancelShipment
    onFailure:
      retry: { maxAttempts: 3, backoff: exponential }
      deadLetter: true
`,
  'http-clients.keel.yaml': `
clients:
  carrier:
    purpose: Encargar envíos a la transportista.
    calls:
      requestShipment: { contract: 'POST /shipments -> acuse del encargo.' }
`,
  'dependencies.keel.yaml': `
dependencies:
  carrier:
    description: Transportista que ejecuta los envíos.
    activations:
      requestShipment:
        triggeredBy: [dispatchShipment, sweepShipments]
        via: { client: carrier, call: requestShipment }
        effect: La transportista recoge y entrega el paquete.
        reconciledBy: sweepShipments
        awaitingSince: requestShipmentAwaitingSince
        onFailure: { action: ignore }
    compensations:
      - onEvent: ShipmentRejected
        undoes: requestShipment
        description: La transportista rechazó el envío; se anula.
`
};

const compensationService = (t, scenarios) =>
  makeServiceDir(t, {
    'service.keel.yaml':
      `keel: "${DSL}"\n` +
      'service:\n  name: shipping\n  version: 1.0.0\n' +
      '  description: Coordina los envíos con la transportista.\n' +
      'layers:\n' +
      Object.keys(COMPENSATION_LAYERS)
        .map((file) => `  ${file.replace('.keel.yaml', '')}: ${file}`)
        .join('\n') +
      '\n',
    ...COMPENSATION_LAYERS,
    ...(scenarios === null ? {} : { 'validation-scenarios.md': scenarios })
  });

test('sin validation-scenarios.md la regla de los dos escenarios no se evalúa', (t) => {
  const { warnings } = validateService(compensationService(t, null));
  assert.ok(!warnings.some((w) => w.includes('validation-scenarios.md')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('REENTREGA')), warnings.join('\n'));
});

test('el documento llega desde disco: una compensación sin escenario de reentrega se avisa', (t) => {
  const dir = compensationService(
    t,
    `# shipping — Escenarios de validación\n\n` +
      `### FL-SHP-001: la transportista rechaza el envío\n` +
      `**Given**: un envío en dispatched.\n**When**: llega ShipmentRejected.\n` +
      `**Then**: el envío queda en cancelled, leído por la API.\n`
  );
  const { warnings } = validateService(dir);
  assert.ok(
    warnings.some((w) => w.includes("los escenarios de 'ShipmentRejected' cubren el efecto pero no encuentro el de REENTREGA")),
    warnings.join('\n')
  );
});

test('con los tres escenarios el diseño valida limpio de punta a punta', (t) => {
  const dir = compensationService(
    t,
    `# shipping — Escenarios de validación\n\n` +
      `### FL-SHP-001: la transportista rechaza el envío\n` +
      `**Given**: un envío en dispatched.\n**When**: llega ShipmentRejected.\n` +
      `**Then**: el envío queda en cancelled, leído por la API.\n\n` +
      `### FL-SHP-002: ShipmentRejected se reentrega\n` +
      `**Given**: la compensación ya se aplicó.\n**When**: se entrega el mismo mensaje otra vez.\n` +
      `**Then**: no hay segundo efecto.\n\n` +
      `### FL-SHP-003: ShipmentRejected llega dos veces a la vez\n` +
      `**Given**: un envío en dispatched.\n**When**: se entregan dos copias del mensaje simultáneamente.\n` +
      `**Then**: el envío queda en cancelled y la API cuenta una sola cancelación.\n`
  );
  const { ok, crossRefErrors, warnings } = validateService(dir);
  assert.deepEqual(crossRefErrors, []);
  assert.ok(ok);
  assert.ok(!warnings.some((w) => w.includes('ShipmentRejected') && w.includes('escenario')), warnings.join('\n'));
});
