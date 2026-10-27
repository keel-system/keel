// Montar un workspace de diseño para los tests de keel-dotnet.
//
// Las fixtures son las MISMAS que usan keel-spring y keel-nest (fixtures/designs/ en la raíz del
// monorepo): el objetivo es que el mismo diseño genere servidores equivalentes con los tres generadores.
// Mientras la frontera de keel-dotnet no cubra una capa, los tests derivan de una fixture real el diseño
// que sí puede generar, quitando esas capas (`withoutLayers`), en vez de inventarse uno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';
import { FINDER_DESIGNS } from '../../../keel-core/test/helpers/finder-designs.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.join(here, '..', '..', '..');
export const FIXTURES_DIR = path.join(repoRoot, 'fixtures', 'designs');

/** Un workspace Keel vacío: basta el marcador que comprueba `isKeelWorkspace`. */
export function makeWorkspace(prefix = 'keel-dotnet-') {
  const dir = tmpDir(prefix);
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}');
  return dir;
}

/**
 * Copia la fixture `name` a `specs/<name>` del workspace quitando `withoutLayers` del manifiesto y de
 * disco. Devuelve la ruta del diseño.
 */
export function mountDesign(workspace, name, { withoutLayers = [] } = {}) {
  const specDir = path.join(workspace, 'specs', name);
  fs.cpSync(path.join(FIXTURES_DIR, name), specDir, { recursive: true });
  const manifestFile = path.join(specDir, 'service.keel.yaml');
  let manifest = fs.readFileSync(manifestFile, 'utf8');
  for (const layer of withoutLayers) {
    const line = new RegExp(`^\\s*${layer}:\\s*(\\S+)\\s*$`, 'm');
    const match = manifest.match(line);
    if (!match) throw new Error(`${name} no declara la capa ${layer}`);
    fs.rmSync(path.join(specDir, match[1]));
    manifest = manifest.replace(line, '').replace(/\n{2,}$/, '\n');
  }
  fs.writeFileSync(manifestFile, manifest);
  return specDir;
}

/** El diseño que keel-dotnet sabe generar entero: product-catalog, con su persistencia relacional (incremento 6). */
export const DOTNET_READY_DESIGN = { name: 'product-catalog', withoutLayers: [] };

/** Ejecuta un comando de la CLI en `workspace`, en silencio, y devuelve su exitCode y lo que imprimió. */
export async function runCommand(workspace, command, ...args) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const output = [];
  console.log = console.warn = console.error = (...parts) => output.push(parts.join(' '));
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await command(...args);
    return { exitCode: process.exitCode, output: output.join('\n') };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, saved);
  }
}

/**
 * Las ramas del DSL que ninguna fixture declara y keel-dotnet genera (incremento 16): un parche en memoria sobre una
 * fixture real. Las recorren `uncovered-branches.test.js` (la rama en lo emitido, sin red) y cs-check, que las compila
 * y ejecuta sus pruebas emitidas como variantes DERIVED. `mutate(manifest, layers, name)` es la firma de cs-check: el
 * nombre del servicio es el namespace raíz, y dos variantes de la misma fixture no pueden chocar.
 */
const replicaOf = (layers) => Object.values(layers.dependencies.dependencies.pricing.needs).find((need) => need.replica).replica;
const DEGRADED_REPLICA = 'Se cotiza sin precio del proveedor y la ficha lo dice.';
const DEGRADED_ACTIVATION = 'El producto queda sin reindexar hasta el próximo cambio; la búsqueda lo encuentra con sus datos viejos.';
export const UNCOVERED_BRANCHES = [
  {
    name: 'catalog-extended-replica-fail',
    from: 'catalog-extended',
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      replicaOf(layers).onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
    }
  },
  {
    name: 'catalog-extended-replica-degrade',
    from: 'catalog-extended',
    prose: DEGRADED_REPLICA,
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      replicaOf(layers).onMiss = { action: 'degrade', degradedTo: DEGRADED_REPLICA };
    }
  },
  {
    name: 'catalog-extended-activation-degrade',
    from: 'catalog-extended',
    prose: DEGRADED_ACTIVATION,
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      layers.dependencies.dependencies['search-index'].activations.indexProduct.onFailure = { action: 'degrade', degradedTo: DEGRADED_ACTIVATION };
    }
  },
  {
    // Un value object compuesto en el cuerpo y en la respuesta de una llamada saliente (el mismo parche que keel-nest).
    name: 'stock-reservation-compuesto-saliente',
    from: 'stock-reservation',
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      layers.domain.types.Refund = {
        description: 'Importe devuelto.',
        fields: { amount: { type: 'decimal', required: true }, currency: { type: 'string', required: true } }
      };
      const calls = layers['http-clients'].clients.inventory.calls;
      calls.cancelStock.response.fields.refund = { type: 'Refund' };
      calls.reportRefund = {
        contract: 'POST /stock/refunds informa de un reembolso y devuelve { accepted, refunds }.',
        method: 'POST',
        path: '/stock/refunds',
        request: { body: { refund: { type: 'Refund', required: true }, history: { type: 'Refund', list: true } } },
        response: { fields: { accepted: { type: 'boolean', required: true }, refunds: { type: 'Refund', list: true } } }
      };
    }
  },
  // `audit.authorship: declared`: la autoría la declara el dominio (raíz e hija) y el adaptador la estampa. El alta la deja
  // vacía, y vacía es AUSENTE: con `??=` se guardaba "" en lugar del actor (corrida catalog-dotnet del registry,
  // 2026-10-19). La miden db-check y doc-check.
  ...[
    { name: 'mailer-author', from: 'notification-mailer' },
    { name: 'mailer-mongo-author', from: 'notification-mailer-mongo' }
  ].map(({ name, from }) => ({
    name,
    from,
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'declared' };
      for (const entity of ['Template', 'TemplateVariable']) {
        layers.domain.entities[entity].fields.createdBy = { type: 'string', generated: true };
        layers.domain.entities[entity].fields.updatedBy = { type: 'string', generated: true };
      }
    }
  })),
  // `optimisticLocking: declared`: la raíz porta el bloqueo en el `lockVersion` que declara su dominio, en los dos
  // modelos. Declarado `int`, el dominio salía sin null y el `expected is null` del Save no compilaba (corrida
  // catalog-dotnet del registry, 2026-10-19).
  // Nombres cortos: la ruta de la variante dentro de cs-check pasa de 260 y Roslyn no deja la DLL (MSB3030).
  ...[
    { name: 'product-catalog-declared-lock', from: 'product-catalog', root: 'Product' },
    { name: 'mailer-mongo-lock', from: 'notification-mailer-mongo', root: 'Template' }
  ].map(({ name, from, root }) => ({
    name,
    from,
    root,
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      layers.persistence.consistency = { ...(layers.persistence.consistency ?? {}), optimisticLocking: 'declared' };
      layers.domain.entities[root].fields.lockVersion = { type: 'int', generated: true };
    }
  })),
  // Los finders de las búsquedas (DSL 2.22) en las formas que catalog-extended no declara: los diseños de
  // keel-core/test/helpers/finder-designs.js, los MISMOS que mide keel-nest. Los ejecutan db-check y doc-check.
  ...FINDER_DESIGNS.map((design) => ({
    name: design.name,
    from: design.from,
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      design.mutate(layers);
    }
  })),
  {
    // La captura PARCIAL: payment-checkout captura siempre entero porque MercadoPago no la cubre; sobre Stripe sí.
    name: 'payment-checkout-partial-capture',
    from: 'payment-checkout',
    paymentGateway: 'stripe',
    mutate(manifest, layers, name) {
      manifest.service.name = name;
      const operation = layers['use-cases'].operations.capturePayment;
      operation.input.fields.amount = { ...layers['use-cases'].operations.refundPayment.input.fields.amount };
      operation.rules = operation.rules.map((rule) => (rule === 'Se captura el importe entero autorizado.' ? 'Se captura el importe pedido, o el entero si no se pide.' : rule));
      layers.payments.capture.amount = 'amount';
      layers.payments.capabilities = [...layers.payments.capabilities, 'partial-capture'];
    }
  }
];

/** Las fixtures compartidas (las que tienen manifiesto). */
export function fixtureNames() {
  return fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
}

/**
 * El plan (modelo + árbol en memoria) de una fixture ENTERA, sin pasar por la frontera: el dominio y la
 * aplicación se emiten para cualquier diseño aunque `build` todavía rechace alguna de sus capas.
 * `mutate(manifest, layers)` deriva una variante en memoria.
 */
export async function planFixture(name, { mutate = null, stack = null } = {}) {
  const { loadService } = await import('@keel-system/keel-core');
  const { planService } = await import('../../src/scaffold/index.js');
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  if (mutate) mutate(manifest, layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
}

/** Las fixtures RELACIONALES (las documentales declaran `model: document` y van a MongoDB): las que se generan también sobre MySQL. */
export const MYSQL_FIXTURES = [
  'catalog-extended',
  'job-dispatch',
  'job-dispatch-cycles',
  'metering-digest',
  'notification-mailer',
  'payment-checkout',
  'payout-runs',
  'product-catalog',
  'profile-directory',
  'stock-reservation',
  'stock-reservation-events'
];

// Las variantes derivadas en memoria de una fixture real, para lo que ninguna declara: las compila cs-check y las parsea
// cs-syntax.test.js, las dos sobre esta lista. Cada una cambia el
// nombre del servicio, que es el namespace raíz: dos variantes de la misma fixture no pueden chocar.
export const CS_VARIANTS = [
  // La mensajería sobre KAFKA (incremento 9f) y sobre SNS/SQS (9g): las fixtures con mensajería compilan sobre RabbitMQ;
  // estas dos, con outbox y best-effort, compilan además la conexión, el consumo y el arnés de cada uno.
  ...['kafka', 'snssqs'].flatMap((broker) =>
    ['stock-reservation-events', 'metering-digest'].map((from) => ({
      name: `${from}-${broker}`,
      from,
      broker,
      mutate: (manifest, layers, name) => {
        manifest.service.name = name;
      }
    }))
  ),
  {
    // Un servicio que PUBLICA sin suscribirse, sobre SNS/SQS y MySQL: la forma del catálogo del registry. Ninguna fixture
    // la tenía, y la corrida catalog-dotnet-mysql-sns (2026-10-21) encontró un [Theory] sin filas que no compilaba y la
    // marca del aparcado del outbox con una zona que MySQL rechaza.
    name: 'catalog-extended-publish-snssqs',
    from: 'catalog-extended',
    broker: 'snssqs',
    database: 'mysql',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      layers.messaging.subscriptions = {};
    }
  },
  {
    name: 'inspection-reports-reject',
    from: 'inspection-reports',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      layers.domain.types.GeoPoint.fields.latitude.constraints.scalePolicy = 'reject';
    }
  },
  {
    // El decimal ESCALAR de una entrada con `scalePolicy: round` se redondea en el propio mensaje
    // (`init => field = ...`, C# 14). Ninguna fixture lo declara: las dos ramas, la obligatoria y la opcional.
    // La pasarela de pago con MERCADOPAGO (incremento 13): payment-checkout compila con Stripe, el default del stack.
    name: 'payment-checkout-mp',
    from: 'payment-checkout',
    paymentGateway: 'mercadopago',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
    }
  },
  {
    // El dato bajo demanda con `onUnavailable: fail` (incremento 13i): ninguna fixture lo declara (asset-vault degrada).
    // Con el renderizador caído, getAsset falla con su error: lo EJECUTA la prueba emitida del adaptador.
    name: 'asset-vault-need-fail',
    from: 'asset-vault',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      layers['use-cases'].operations.getAsset.errors = [
        ...(layers['use-cases'].operations.getAsset.errors ?? []),
        { code: 'RENDERING_UNAVAILABLE', when: 'El renderizador no responde y la ficha no puede salir sin su miniatura.', http: 503 }
      ];
      layers.dependencies.dependencies.rendering.needs.thumbnail.onUnavailable = { action: 'fail', error: 'RENDERING_UNAVAILABLE' };
    }
  },
  // La telemetría (incremento 14c): las siluetas que mide keel-nest con ella, cada una con su prueba emitida TelemetryTests.
  ...['product-catalog', 'stock-reservation', 'catalog-extended', 'asset-vault', 'notification-mailer', 'notification-mailer-mongo'].map((from) => ({
    name: `${from}-otel`,
    from,
    telemetry: 'otel',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
    }
  })),
  // Las ramas del DSL que ninguna fixture declara (incremento 16): los MISMOS parches que recorre
  // test/uncovered-branches.test.js, aquí compilados y con sus pruebas emitidas.
  ...UNCOVERED_BRANCHES,
  // MySQL: toda fixture relacional, otra vez sobre el otro motor (el proveedor, el uuid en binary(16), la unicidad
  // condicionada con su columna generada, los reclamos en READ COMMITTED, la reconciliación sin ON CONFLICT y los errores
  // por errno), y una con telemetría (el pool de MySqlConnector, con sus nombres).
  ...MYSQL_FIXTURES.map((from) => ({
    name: `${from}-mysql`,
    from,
    database: 'mysql',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
    }
  })),
  {
    name: 'stock-reservation-mysql-otel',
    from: 'stock-reservation',
    database: 'mysql',
    telemetry: 'otel',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
    }
  },
  {
    name: 'payment-checkout-round',
    from: 'payment-checkout',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      for (const operation of ['requestCharge', 'refundPayment']) {
        layers['use-cases'].operations[operation].input.fields.amount.constraints.scalePolicy = 'round';
      }
    }
  }
];

/**
 * El stack con el que se genera una fixture o una variante: el motor si la variante lo pide (si no, el del modelo de
 * persistencia: PostgreSQL o MongoDB); con mensajería, RabbitMQ (el default del stack es Kafka); con
 * pagos, Stripe salvo que la variante diga otra pasarela (sin una, la capa no se emite); y la telemetría que pida la variante.
 */
export function variantStack(layers, { broker = null, paymentGateway = null, telemetry = null, database = null } = {}) {
  const stack = {
    ...(database ? { database } : {}),
    ...(layers.messaging ? { broker: broker ?? 'rabbitmq' } : {}),
    ...(layers.payments ? { paymentGateway: paymentGateway ?? 'stripe' } : {}),
    ...(telemetry ? { telemetry } : {})
  };
  return Object.keys(stack).length > 0 ? stack : null;
}
