import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supportedDsl } from '../src/lib/assets.js';

// Versión vigente del DSL: derivada, no escrita. Solo se soporta una, y un literal
// aquí volvería a romper estos tests en el siguiente cambio de versión.
const DSL = supportedDsl()[0];
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
        `keel: "${DSL}"`,
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

// Un proveedor del que se LEE: lo contrasta el mapa contra `consumes`.
const dependencies = (names) => `dependencies:
${names
  .map(
    (name) => `  ${name}:
    description: Proveedor ${name} declarado por el diseño.
    needs:
      ${name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}Data:
        usedBy: [searchFlights]
        strategy: on-demand`
  )
  .join('\n')}
`;

// Un proveedor al que se le PIDE trabajo: lo contrasta el mapa contra `invokes`.
const activations = (names) => `dependencies:
${names
  .map(
    (name) => `  ${name}:
    description: Proveedor ${name} al que este diseño le delega trabajo.
    activations:
      notify${name.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase())}:
        triggeredBy: [searchFlights]
        via: { publishes: FlightScheduled }
        effect: El proveedor hace su trabajo al recibir el mensaje.`
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
      /specs\/flight-catalog: lee datos de 'fare-pricing' y el mapa no lo conoce/.test(message)
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

// --- Compensaciones ---------------------------------------------------------
// Relación SOLO de compensación: se le encarga trabajo a un proveedor y se
// consume su evento de fallo, sin leerle ningún dato. No hay `needs`, así que la
// arista `consumes` que la suscripción exige la justifica la compensación.

const paymentsDependency = ({ compensated = true } = {}) => `dependencies:
  payments:
    description: Cobro de la reserva, del que este diseño solo espera el desenlace.
    activations:
      chargeBooking:
        triggeredBy: [scheduleFlight]
        via: { publishes: FlightScheduled }
        effect: Se inicia el cobro de la reserva contra el medio de pago del pasajero.
        awaits: nothing
${
  compensated
    ? `    compensations:
      - onEvent: PaymentFailed
        undoes: chargeBooking
        description: El cobro se rechazó a posteriori y el vuelo deja de estar reservado.
`
    : ''
}`;

// El evento de fallo del proveedor: un `fact` suyo, no un encargo nuestro.
const PAYMENTS_MESSAGING = `${messaging(['FlightScheduled'])}subscriptions:
  PaymentFailed:
    description: El cobro aceptado no pudo completarse.
    source: payments
    payload:
      code: { type: string, required: true }
    triggers: scheduleFlight
`;

const compensatingDesign = (options) => ({
  layers: {
    domain: DOMAIN,
    'use-cases': USE_CASES,
    messaging: PAYMENTS_MESSAGING,
    dependencies: paymentsDependency(options)
  }
});

const PAYMENTS_ENTRY = `  payments:
    summary: Cobro y reembolso de reservas.
    responsibility: Única fuente de verdad del estado de un cobro.
    publishes: [PaymentFailed]
`;

const CATALOG_INVOKES_PAYMENTS = `  flight-catalog:
    summary: Vuelos programados, rutas y tramos.
    responsibility: Única fuente de verdad de qué se puede volar y cuándo.
    owns: [Flight]
    publishes: [FlightScheduled]
    status: designed
    invokes:
      - to: payments
        kind: events
        what: [cobro de la reserva]
        events: [FlightScheduled]
        why: Cobrar no es responsabilidad del catálogo de vuelos.
        blocking: false
`;

const READS_PAYMENT_OUTCOME = `    consumes:
      - from: payments
        kind: events
        what: [desenlace del cobro]
        events: [PaymentFailed]
        why: Sin el desenlace real del cobro no se puede compensar lo que se encargó.
        blocking: false
`;

test('una compensación justifica la arista de lectura hacia el proveedor al que se le encarga trabajo', () => {
  const cwd = workspace({
    system: systemYaml(PAYMENTS_ENTRY + CATALOG_INVOKES_PAYMENTS + READS_PAYMENT_OUTCOME),
    designs: { 'flight-catalog': compensatingDesign() }
  });

  // El diseño tiene que estar cerrado: es la rama que antes dejaba el catch-22.
  assert.equal(byName(buildSystemPlan(cwd))['flight-catalog'].status, 'designed');

  const found = messages(buildSystemPlan(cwd));
  assert.ok(!found.some((message) => /planifica consumir 'payments'/.test(message)), found.join(' · '));
  assert.ok(!found.some((message) => /no declara esa arista de eventos/.test(message)), found.join(' · '));
});

test('una compensación sin su arista de eventos en el mapa sigue siendo deriva', () => {
  const cwd = workspace({
    system: systemYaml(PAYMENTS_ENTRY + CATALOG_INVOKES_PAYMENTS),
    designs: { 'flight-catalog': compensatingDesign() }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /specs\/flight-catalog: se suscribe a 'PaymentFailed' de 'payments' y el mapa no declara esa arista de eventos/.test(
        message
      )
    )
  );
});

test('una arista de lectura sin need ni compensación sigue avisando en un diseño cerrado', () => {
  const cwd = workspace({
    system: systemYaml(PAYMENTS_ENTRY + CATALOG_INVOKES_PAYMENTS + READS_PAYMENT_OUTCOME),
    designs: { 'flight-catalog': compensatingDesign({ compensated: false }) }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /specs\/flight-catalog: el mapa planifica consumir 'payments' y su capa dependencies no declara ningún need ni compensación suya/.test(
        message
      )
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

// --- Aristas de activación ---------------------------------------------------

// El servicio genérico al que se le pide trabajo. Su diseño tiene que cerrar en
// verde: el check espejo solo se le exige a un proveedor ya diseñado.
const NOTIFY_USE_CASES = `operations:
  sendNotice:
    description: Envía un aviso al destinatario indicado.
    kind: command
    input:
      fields:
        code: { type: string, required: true }
    output: { entity: Flight }
`;

// Consume el mensaje como `request`: eso es lo que lo convierte en una puerta de
// entrada suya en vez de en una reacción por cuenta propia.
const NOTIFY_SUBSCRIPTION = `subscriptions:
  DeliveryRequested:
    source: booking
    nature: request
    payload:
      code: { type: string, required: true }
    triggers: sendNotice
`;

const NOTIFY_ENTRY = `  notifications:
    summary: Envío de correos y avisos a los pasajeros.
    responsibility: Única fuente de verdad de qué aviso se mandó y cuándo.
`;

const bookingInvokes = (extra = '') => `  booking:
    summary: Reservas de vuelo de principio a fin.
    responsibility: Única fuente de verdad del estado de una reserva.
    publishes: [DeliveryRequested]
    invokes:
      - to: notifications
        kind: events
        what: [enviar el correo de confirmación al pasajero]
        events: [DeliveryRequested]
        why: El aviso al pasajero es trabajo de notifications, no de booking.
${extra}`;

test('una invocación bloqueante pone al invocador DESPUÉS del proveedor', () => {
  const plan = buildSystemPlan(
    workspace({ system: systemYaml(NOTIFY_ENTRY + bookingInvokes()) })
  );

  // El invocador necesita la firma de entrada del otro para saber qué mandarle:
  // es exactamente el caso que antes el mapa ordenaba al revés.
  assert.deepEqual(plan.waves, [
    { level: 1, services: ['notifications'] },
    { level: 2, services: ['booking'] }
  ]);
  assert.deepEqual(byName(plan).notifications.invokedBy, ['booking']);
  assert.deepEqual(byName(plan).booking.invokedBy, []);
});

test('una invocación no bloqueante no ordena las olas', () => {
  const plan = buildSystemPlan(
    workspace({
      system: systemYaml(NOTIFY_ENTRY + bookingInvokes().replace('why: El aviso', 'blocking: false\n        why: El aviso'))
    })
  );

  assert.deepEqual(plan.waves, [{ level: 1, services: ['booking', 'notifications'] }]);
});

test('invocar por eventos exige que el proveedor los consuma como request', () => {
  const design = (nature) => ({
    notifications: {
      layers: {
        domain: DOMAIN,
        'use-cases': NOTIFY_USE_CASES,
        messaging: NOTIFY_SUBSCRIPTION.replace('nature: request', nature)
      }
    }
  });

  // Tratado como hecho: nadie se ha comprometido a hacer el trabajo.
  const asFact = buildSystemPlan(
    workspace({ system: systemYaml(NOTIFY_ENTRY + bookingInvokes()), designs: design('nature: fact') })
  );
  assert.ok(
    messages(asFact).some((message) => /consume 'DeliveryRequested' como 'fact'/.test(message)),
    messages(asFact).join('\n')
  );

  // Tratado como petición: el acuerdo está cerrado por los dos lados.
  const asRequest = buildSystemPlan(
    workspace({ system: systemYaml(NOTIFY_ENTRY + bookingInvokes()), designs: design('nature: request') })
  );
  assert.ok(!messages(asRequest).some((message) => /DeliveryRequested/.test(message)), messages(asRequest).join('\n'));
});

test('un mensaje no puede ser a la vez petición nuestra y hecho al que el otro reacciona', () => {
  const cwd = workspace({
    system: systemYaml(
      NOTIFY_ENTRY.trimEnd() +
        `
    consumes:
      - from: booking
        kind: events
        what: [reservas confirmadas]
        events: [DeliveryRequested]
        why: Reacciona a la confirmación por su cuenta.
` +
        bookingInvokes()
    )
  });

  const plan = buildSystemPlan(cwd);
  assert.ok(
    messages(plan).some((message) => /le pide trabajo a 'notifications' y 'notifications' declara que consume/.test(message)),
    messages(plan).join('\n')
  );
  // El ciclo espurio que esa contradicción fabricaría no debe tragarse el error.
  assert.ok(plan.findings.some((finding) => finding.level === 'error'));
});

test('pedir trabajo por HTTP a quien no expone puerta M2M es aviso', () => {
  const cwd = workspace({
    system: systemYaml(
      NOTIFY_ENTRY +
        `  booking:
    summary: Reservas de vuelo de principio a fin.
    responsibility: Única fuente de verdad del estado de una reserva.
    invokes:
      - to: notifications
        kind: http
        what: [enviar el correo de confirmación al pasajero]
        why: El aviso al pasajero es trabajo de notifications, no de booking.
`
    ),
    designs: {
      notifications: {
        layers: {
          domain: DOMAIN,
          'use-cases': NOTIFY_USE_CASES,
          api: 'style: rest\nbasePath: /api/v1\nendpoints:\n  sendNotice: { method: POST, path: /notices }\n'
        }
      }
    }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) => /no expone ningún endpoint con audience/.test(message)),
    messages(buildSystemPlan(cwd)).join('\n')
  );
});

test('una activación que el mapa no conoce es deriva siempre', () => {
  const cwd = workspace({
    system: systemYaml(CATALOG_ENTRY),
    designs: {
      'flight-catalog': {
        layers: { ...catalogDesign.layers, dependencies: activations(['notifications']) }
      }
    }
  });

  assert.ok(
    messages(buildSystemPlan(cwd)).some((message) =>
      /specs\/flight-catalog: le pide trabajo a 'notifications' y el mapa no lo conoce/.test(message)
    ),
    messages(buildSystemPlan(cwd)).join('\n')
  );
});

test('la tabla separa lo que se lee de lo que se pide', () => {
  const plan = buildSystemPlan(workspace({ system: systemYaml(NOTIFY_ENTRY + bookingInvokes()) }));
  const rendered = renderPlanTable(plan);

  assert.equal(rendered, renderPlanTable(buildSystemPlan(workspace({ system: systemYaml(NOTIFY_ENTRY + bookingInvokes()) }))));
  assert.ok(rendered.split('\n')[0].includes('Le pide a'));
  assert.match(rendered, /notifications \(events\)/);
});
