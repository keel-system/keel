import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPlan, loadSystemMap, renderPlanTable } from '../src/lib/system-map.js';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Monta un workspace de mentira: `system` es el contenido literal de system.yaml
 * (se escribe a mano para no depender del orden de claves de la librería YAML) y
 * `designs` un mapa slug → { layers } con el contenido de cada capa.
 */
function workspace({ system = null, designs = {}, docs = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-system-'));
  write(path.join(cwd, 'schema', 'service.schema.json'), '{}'); // isKeelWorkspace
  if (system !== null) write(path.join(cwd, 'system.yaml'), system);

  for (const [slug, spec] of Object.entries(designs)) {
    const { version = '1.0.0', layers } = spec;
    const dir = path.join(cwd, 'specs', slug);
    write(
      path.join(dir, 'service.keel.yaml'),
      [
        'keel: "2.3"',
        'service:',
        `  name: ${slug}`,
        `  version: ${version}`,
        `  description: Diseño de ${slug} para las pruebas del mapa de sistema.`,
        '  domain: airline',
        'layers:',
        ...Object.keys(layers).map((layer) => `  ${layer}: ${layer}.keel.yaml`)
      ].join('\n') + '\n'
    );
    for (const [layer, body] of Object.entries(layers)) write(path.join(dir, `${layer}.keel.yaml`), body);
  }

  for (const [file, body] of Object.entries(docs)) write(path.join(cwd, 'docs', file), body);
  return cwd;
}

// --- Capas de fixture -------------------------------------------------------
// Este par pasa `keel validate` sin --wip: es lo que hace que un servicio del
// mapa cuente como `designed` y que se le exija coherencia con sus consumidores.

const DOMAIN = `entities:
  Flight:
    description: Un vuelo programado con su ruta y horario.
    fields:
      id: { type: uuid, id: true }
      code: { type: string }
`;

const USE_CASES = `operations:
  scheduleFlight:
    description: Programa un vuelo nuevo en el catálogo.
    kind: command
    input:
      fields:
        code: { type: string, required: true }
    output: { entity: Flight }
    errors:
      - { code: FLIGHT_CODE_TAKEN, when: Ya existe un vuelo con ese código., http: 409 }
    emits: [FlightScheduled]
`;

const messaging = (events) => `channels:
  flightEvents:
    description: Canal por el que fluyen los cambios del catálogo de vuelos.
publishing:
  reliability: outbox
  events:
${events
  .map(
    (event) => `    ${event}:
      channel: flightEvents
      description: Evento ${event} del catálogo.
      payload:
        flightId: { type: uuid, required: true }`
  )
  .join('\n')}
`;

const dependencies = (names) => `dependencies:
${names
  .map(
    (name) => `  ${name}:
    description: Proveedor ${name} declarado por el diseño.`
  )
  .join('\n')}
`;

const catalogDesign = { layers: { domain: DOMAIN, 'use-cases': USE_CASES, messaging: messaging(['FlightScheduled']) } };

// --- Mapas de fixture -------------------------------------------------------

const CATALOG_ENTRY = `  flight-catalog:
    summary: Vuelos programados, rutas y tramos.
    responsibility: Única fuente de verdad de qué se puede volar y cuándo.
    owns: [Flight]
    publishes: [FlightScheduled]
`;

const systemYaml = (services) => `system:
  name: airline-ticketing
  description: Venta y emisión de tickets de aerolínea para web y app.
services:
${services}`;

const messages = (plan) => plan.findings.map((finding) => finding.message);
const byName = (plan) => Object.fromEntries(plan.services.map((service) => [service.name, service]));

// --- Carga ------------------------------------------------------------------

test('sin system.yaml el plan no existe y no hay hallazgos', () => {
  const plan = buildSystemPlan(workspace());
  assert.equal(plan.exists, false);
  assert.equal(plan.system, null);
  assert.deepEqual(plan.findings, []);
});

test('un system.yaml que no cumple el schema se reporta como error, no revienta', () => {
  const cwd = workspace({ system: 'system:\n  name: airline-ticketing\nservices: {}\n' });
  const { map, errors } = loadSystemMap(cwd);
  assert.equal(map, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no cumple system\.schema\.json/);

  const plan = buildSystemPlan(cwd);
  assert.equal(plan.system, null);
  assert.equal(plan.findings.length, 1);
});

// --- Olas de construcción ---------------------------------------------------

test('las olas salen de las aristas bloqueantes y los externos quedan fuera', () => {
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY +
        `  card-gateway:
    summary: Pasarela de pago con tarjeta.
    responsibility: Autoriza y captura cargos contra la red de tarjetas.
    external: true
  payments:
    summary: Cobro y reembolso de reservas.
    responsibility: Única fuente de verdad del estado de un cobro.
    publishes: [PaymentCaptured]
    consumes:
      - from: card-gateway
        kind: http
        what: [autorización de la tarjeta]
        why: El cobro real lo ejecuta la pasarela contratada.
  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    publishes: [SeatHeld]
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos]
        events: [FlightScheduled]
        strategy: replicated
        why: El mapa de asientos nace al programarse el vuelo.
  booking:
    summary: El PNR y su ciclo de vida.
    responsibility: Única fuente de verdad del estado de una reserva.
    consumes:
      - from: seat-inventory
        kind: http
        what: [retención del asiento]
        why: No se puede confirmar una reserva sin retener el asiento en el instante.
      - from: payments
        kind: http
        what: [cobro de la reserva]
        why: La reserva se confirma solo si el cobro sale bien.
`
    )
  });

  const plan = buildSystemPlan(cwd);
  assert.deepEqual(plan.findings, []);
  assert.deepEqual(
    plan.waves.map((wave) => wave.services),
    [['flight-catalog', 'payments'], ['seat-inventory'], ['booking']]
  );
  // Un externo no se construye aquí: no tiene ola ni bloquea a quien lo consume.
  assert.equal(byName(plan)['card-gateway'].wave, null);
  assert.equal(byName(plan)['card-gateway'].external, true);
  assert.deepEqual(byName(plan)['flight-catalog'].consumedBy, ['seat-inventory']);
});

test('una arista no bloqueante no cuenta para el orden', () => {
  const blocking = (value) =>
    systemYaml(
      CATALOG_ENTRY +
        `  notifications:
    summary: Avisos de itinerario por email.
    responsibility: Única fuente de verdad de qué aviso se envió a quién.
    consumes:
      - from: flight-catalog
        kind: events
        what: [cancelaciones que hay que avisar]
        events: [FlightScheduled]
        why: El aviso reacciona al evento; no necesita el catálogo para existir.
        blocking: ${value}
`
    );

  assert.deepEqual(
    buildSystemPlan(workspace({ system: blocking(true) })).waves.map((wave) => wave.services),
    [['flight-catalog'], ['notifications']]
  );
  assert.deepEqual(
    buildSystemPlan(workspace({ system: blocking(false) })).waves.map((wave) => wave.services),
    [['flight-catalog', 'notifications']]
  );
});

test('un ciclo bloqueante se reporta con sus aristas y deja a los implicados sin ola', () => {
  const cwd = workspace({
    system: systemYaml(
      `  booking:
    summary: El PNR y su ciclo de vida.
    responsibility: Única fuente de verdad del estado de una reserva.
    consumes:
      - from: payments
        kind: http
        what: [cobro de la reserva]
        why: La reserva se confirma solo si el cobro sale bien.
  payments:
    summary: Cobro y reembolso de reservas.
    responsibility: Única fuente de verdad del estado de un cobro.
    consumes:
      - from: booking
        kind: http
        what: [importe a cobrar]
        why: Se acordó que el cobro consulte la reserva en vez de recibir el importe.
`
    )
  });

  const plan = buildSystemPlan(cwd);
  assert.deepEqual(plan.waves, []);
  assert.deepEqual(plan.cycle, ['booking', 'payments']);
  assert.equal(byName(plan).booking.wave, null);
  const message = messages(plan).find((entry) => entry.startsWith('Ciclo bloqueante'));
  assert.ok(message, 'debe reportarse el ciclo');
  assert.match(message, /booking ← payments/);
  assert.match(message, /payments ← booking/);
  assert.match(message, /blocking: false/);
});

// --- Coherencia interna del mapa -------------------------------------------

test('una arista contra un servicio no declarado es un error', () => {
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY +
        `  booking:
    summary: El PNR y su ciclo de vida.
    responsibility: Única fuente de verdad del estado de una reserva.
    consumes:
      - from: fare-pricing
        kind: http
        what: [tarifa vigente del tramo]
        why: No se puede cotizar una reserva sin el precio del momento.
`
    )
  });

  assert.match(messages(buildSystemPlan(cwd))[0], /'fare-pricing' no está declarado en services/);
});

test('suscribirse a un evento que el proveedor no declara publicar es un error', () => {
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY +
        `  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    consumes:
      - from: flight-catalog
        kind: events
        what: [cancelaciones de vuelo]
        events: [FlightCancelled]
        why: Un vuelo cancelado libera todos sus asientos retenidos.
`
    )
  });

  assert.match(
    messages(buildSystemPlan(cwd))[0],
    /'flight-catalog' no declara publicar 'FlightCancelled'/
  );
});

// --- Cruce con los diseños reales ------------------------------------------

test('un proveedor ya diseñado que no publica lo que el mapa promete es un error', () => {
  const cwd = workspace({
    system: systemYaml(
      `  flight-catalog:
    summary: Vuelos programados, rutas y tramos.
    responsibility: Única fuente de verdad de qué se puede volar y cuándo.
    publishes: [FlightScheduled, FlightCancelled]
    status: designed
  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    consumes:
      - from: flight-catalog
        kind: events
        what: [cancelaciones de vuelo]
        events: [FlightCancelled]
        why: Un vuelo cancelado libera todos sus asientos retenidos.
`
    ),
    designs: { 'flight-catalog': catalogDesign }
  });

  const plan = buildSystemPlan(cwd);
  assert.equal(byName(plan)['flight-catalog'].status, 'designed');
  assert.ok(
    messages(plan).some((message) =>
      /specs\/flight-catalog: el mapa dice que publica 'FlightCancelled'.*messaging no lo publica/s.test(message)
    ),
    `esperaba el cruce entre los dos specs, salió: ${messages(plan).join(' | ')}`
  );
});

test('el status declarado se contrasta con el estado real del diseño', () => {
  const cwd = workspace({
    system: systemYaml(CATALOG_ENTRY),
    designs: { 'flight-catalog': catalogDesign }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /declara status 'planned' y el diseño está 'diseñado'/.test(message)
    )
  );
});

test('una dependencia que el diseño declara y el mapa no conoce es deriva siempre', () => {
  const cwd = workspace({
    system: systemYaml(CATALOG_ENTRY),
    designs: {
      'flight-catalog': {
        layers: { ...catalogDesign.layers, dependencies: dependencies(['fare-pricing']) }
      }
    }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /specs\/flight-catalog: depende de 'fare-pricing' y el mapa no lo conoce/.test(message)
    )
  );
});

test('una arista planificada solo se exige al diseño cuando está cerrado', () => {
  const map = systemYaml(
    CATALOG_ENTRY +
      `  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    status: designing
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos]
        events: [FlightScheduled]
        why: El mapa de asientos nace al programarse el vuelo.
`
  );
  const pending = /el mapa planifica consumir 'flight-catalog'/;

  // En diseño: faltar es lo normal, reportarlo sería ruido en cada ejecución.
  const designing = workspace({
    system: map,
    designs: { 'seat-inventory': { layers: { domain: DOMAIN, 'use-cases': 'operations: {}\n' } } }
  });
  assert.ok(!messages(buildSystemPlan(designing)).some((message) => pending.test(message)));

  // Cerrado: el diseño dice que está terminado y la integración no está.
  const closed = workspace({
    system: map.replace('status: designing', 'status: designed'),
    designs: { 'seat-inventory': catalogDesign }
  });
  assert.ok(messages(buildSystemPlan(closed)).some((message) => pending.test(message)));
});

test('una suscripción real contra una fuente que el mapa no contempla es deriva', () => {
  const subscribing = `channels:
  pricingEvents:
    description: Canal de fare-pricing que este servicio consume.
    external: true
subscriptions:
  FareChanged:
    source: fare-pricing
    channel: pricingEvents
    payload:
      segmentId: { type: uuid, required: true }
    triggers: scheduleFlight
`;
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY +
        `  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos]
        events: [FlightScheduled]
        why: El mapa de asientos nace al programarse el vuelo.
`
    ),
    designs: { 'seat-inventory': { layers: { domain: DOMAIN, 'use-cases': USE_CASES, messaging: subscribing } } }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /specs\/seat-inventory: se suscribe a 'FareChanged' de 'fare-pricing' y el mapa no declara/.test(message)
    )
  );
});

test('un diseño del workspace que el mapa no conoce se avisa', () => {
  const cwd = workspace({ system: systemYaml(CATALOG_ENTRY), designs: { 'fare-pricing': catalogDesign } });
  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) => /specs\/fare-pricing no está en el mapa/.test(message))
  );
});

test('un consumidor no puede empezar mientras su proveedor no publique contrato al día', () => {
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY.replace('publishes: [FlightScheduled]', 'publishes: [FlightScheduled]\n    status: designed') +
        `  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos]
        events: [FlightScheduled]
        why: El mapa de asientos nace al programarse el vuelo.
`
    ),
    designs: { 'flight-catalog': catalogDesign }
  });

  const plan = buildSystemPlan(cwd);
  assert.equal(byName(plan)['flight-catalog'].contract, 'missing');
  assert.deepEqual(byName(plan)['seat-inventory'].blockedBy, ['flight-catalog (sin contrato)']);

  // Con su INTEGRATION.md al día, el consumidor deja de estar bloqueado.
  write(
    path.join(cwd, 'docs', 'flight-catalog', 'INTEGRATION.md'),
    '---\nservice: flight-catalog\nversion: 1.0.0\n---\n\n# Integración\n'
  );
  const ready = buildSystemPlan(cwd);
  assert.equal(byName(ready)['flight-catalog'].contract, 'fresh');
  assert.equal(byName(ready)['seat-inventory'].blockedBy, undefined);
});

// --- Presentación -----------------------------------------------------------

test('la tabla es determinista y lista las olas en orden', () => {
  const cwd = workspace({
    system: systemYaml(
      CATALOG_ENTRY +
        `  seat-inventory:
    summary: Disponibilidad y retención de asientos.
    responsibility: Única fuente de verdad de si un asiento está libre.
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos]
        events: [FlightScheduled]
        why: El mapa de asientos nace al programarse el vuelo.
`
    )
  });

  const first = renderPlanTable(buildSystemPlan(cwd));
  assert.equal(first, renderPlanTable(buildSystemPlan(cwd)));
  const rows = first.split('\n');
  assert.ok(rows[0].startsWith('Ola'));
  assert.ok(rows[2].includes('flight-catalog'), rows[2]);
  assert.ok(rows[3].includes('seat-inventory'), rows[3]);
  assert.match(first, /flight-catalog \(events\)/);
});
