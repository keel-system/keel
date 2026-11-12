// Montar un workspace de diseño para los tests de keel-go.
//
// Las fixtures son las MISMAS que usan keel-spring, keel-nest y keel-dotnet (fixtures/designs/ en la raíz del
// monorepo): el objetivo es que el mismo diseño genere servidores equivalentes con los cuatro generadores.
// Mientras la frontera de keel-go no cubra una capa, los tests derivan de una fixture real el diseño
// que sí puede generar, quitando esas capas (`withoutLayers`), en vez de inventarse uno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';
import { FINDER_DESIGNS } from '../../../keel-core/test/helpers/finder-designs.js';
import { CONDITIONAL_WRITE_DESIGNS } from '../../../keel-core/test/helpers/conditional-write-designs.js';
import { READ_SCOPE_DESIGNS } from '../../../keel-core/test/helpers/read-scope-designs.js';
import { DATA_LIFECYCLE_DESIGNS } from '../../../keel-core/test/helpers/data-lifecycle-designs.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.join(here, '..', '..', '..');
export const FIXTURES_DIR = path.join(repoRoot, 'fixtures', 'designs');

/** Un workspace Keel vacío: basta el marcador que comprueba `isKeelWorkspace`. */
export function makeWorkspace(prefix = 'keel-go-') {
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

/** El diseño que mide go-check: product-catalog entero, con su persistencia relacional (tramo 6b). */
export const GO_READY_DESIGN = { name: 'product-catalog', withoutLayers: [] };

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
 * Los diseños DERIVADOS de la autoría (tramo 13g): lo que ninguna fixture que keel-go genere declara. La política
 * `authorship: all` solo la declaran asset-vault (documental, fuera de la frontera por otras capas) y shop-api
 * (relacional); la autoría `declared`, ninguna. Son los MISMOS parches que mide keel-dotnet (`product-catalog-authorship`
 * en su db-check, `mailer-author` y `mailer-mongo-author` en UNCOVERED_BRANCHES), con otro nombre de servicio: cada
 * sujeto es su propio módulo. Los recorren go-syntax, go-check, db-check y doc-check.
 */
export const AUTHORSHIP_DESIGNS = [
  {
    name: 'product-catalog-authorship',
    from: 'product-catalog',
    mutate(manifest, layers) {
      manifest.service.name = 'product-catalog-authorship';
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'all' };
    }
  },
  ...[
    { name: 'mailer-author', from: 'notification-mailer' },
    { name: 'mailer-mongo-author', from: 'notification-mailer-mongo' }
  ].map(({ name, from }) => ({
    name,
    from,
    mutate(manifest, layers) {
      manifest.service.name = name;
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'declared' };
      for (const entity of ['Template', 'TemplateVariable']) {
        layers.domain.entities[entity].fields.createdBy = { type: 'string', generated: true };
        layers.domain.entities[entity].fields.updatedBy = { type: 'string', generated: true };
      }
    }
  }))
];

const DEGRADED_REPLICA = 'Se cotiza sin precio del proveedor y la ficha lo dice.';
const DEGRADED_ACTIVATION = 'El producto queda sin reindexar hasta el próximo cambio; la búsqueda lo encuentra con sus datos viejos.';
const replicaOf = (layers) => Object.values(layers.dependencies.dependencies.pricing.needs).find((need) => need.replica).replica;

/**
 * Las ramas del DSL que ninguna fixture declara y keel-go genera (incremento 16): los MISMOS parches que mide keel-dotnet en
 * sus UNCOVERED_BRANCHES, con cuidado de que cada uno sea su propio módulo. Las recorren `uncovered-branches.test.js` (la rama
 * en lo emitido, sin red), go-syntax y go-check, que las compila y ejecuta sus pruebas emitidas.
 */
export const UNCOVERED_BRANCHES = [
  {
    name: 'catalog-extended-replica-fail',
    from: 'catalog-extended',
    mutate(manifest, layers) {
      manifest.service.name = 'catalog-extended-replica-fail';
      replicaOf(layers).onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
    }
  },
  {
    name: 'catalog-extended-replica-degrade',
    from: 'catalog-extended',
    prose: DEGRADED_REPLICA,
    mutate(manifest, layers) {
      manifest.service.name = 'catalog-extended-replica-degrade';
      replicaOf(layers).onMiss = { action: 'degrade', degradedTo: DEGRADED_REPLICA };
    }
  },
  {
    name: 'catalog-extended-activation-degrade',
    from: 'catalog-extended',
    prose: DEGRADED_ACTIVATION,
    mutate(manifest, layers) {
      manifest.service.name = 'catalog-extended-activation-degrade';
      layers.dependencies.dependencies['search-index'].activations.indexProduct.onFailure = { action: 'degrade', degradedTo: DEGRADED_ACTIVATION };
    }
  },
  {
    // Una subida con `keySource: client-key` y campos de muestra (asset-vault la declara, pero sus campos no tienen muestra).
    name: 'catalog-extended-upload-client-key',
    from: 'catalog-extended',
    mutate(manifest, layers) {
      manifest.service.name = 'catalog-extended-upload-client-key';
      layers['use-cases'].operations.addProductImage.idempotency = { keySource: 'client-key', ttlSeconds: 86400 };
    }
  },
  {
    // Un value object compuesto en el cuerpo y en la respuesta de una llamada saliente (el parche de keel-nest y keel-dotnet).
    name: 'stock-reservation-compuesto-saliente',
    from: 'stock-reservation',
    mutate(manifest, layers) {
      manifest.service.name = 'stock-reservation-compuesto-saliente';
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
  {
    // Los finders sobre documentos (DSL 2.22): el diseño compartido, lista y página, plegado y sin plegar, y rangos.
    name: 'jobs-mongo-finder',
    from: 'job-dispatch-mongo',
    mutate(manifest, layers) {
      manifest.service.name = 'jobs-mongo-finder';
      FINDER_DESIGNS.find((design) => design.name === 'jobs-mongo-finder').mutate(layers);
    }
  },
  {
    // `optimisticLocking: declared`: la raíz porta el bloqueo en el lockVersion que declara su dominio, en los dos modelos.
    name: 'product-catalog-declared-lock',
    from: 'product-catalog',
    mutate(manifest, layers) {
      manifest.service.name = 'product-catalog-declared-lock';
      layers.persistence.consistency = { ...(layers.persistence.consistency ?? {}), optimisticLocking: 'declared' };
      layers.domain.entities.Product.fields.lockVersion = { type: 'int', generated: true };
    }
  },
  {
    name: 'mailer-mongo-lock',
    from: 'notification-mailer-mongo',
    mutate(manifest, layers) {
      manifest.service.name = 'mailer-mongo-lock';
      layers.persistence.consistency = { ...(layers.persistence.consistency ?? {}), optimisticLocking: 'declared' };
      layers.domain.entities.Template.fields.lockVersion = { type: 'int', generated: true };
    }
  },
  {
    // La captura PARCIAL: payment-checkout captura siempre entero porque MercadoPago no la cubre; sobre Stripe sí.
    name: 'payment-checkout-partial-capture',
    from: 'payment-checkout',
    paymentGateway: 'stripe',
    stack: { paymentGateway: 'stripe' },
    mutate(manifest, layers) {
      manifest.service.name = 'payment-checkout-partial-capture';
      const operation = layers['use-cases'].operations.capturePayment;
      operation.input.fields.amount = { ...layers['use-cases'].operations.refundPayment.input.fields.amount };
      operation.rules = operation.rules.map((rule) => (rule === 'Se captura el importe entero autorizado.' ? 'Se captura el importe pedido, o el entero si no se pide.' : rule));
      layers.payments.capture.amount = 'amount';
      layers.payments.capabilities = [...layers.payments.capabilities, 'partial-capture'];
    }
  },
  // La escritura condicional (DSL 2.25): los diseños de keel-core/test/helpers/conditional-write-designs.js, los MISMOS que
  // miden keel-dotnet y keel-nest (relacional, documental y con seguridad y CORS), cada uno su propio módulo.
  ...CONDITIONAL_WRITE_DESIGNS.map((design) => ({
    name: design.name,
    from: design.from,
    mutate(manifest, layers) {
      manifest.service.name = design.name;
      design.mutate(layers);
      // La réplica sobre documentos es un rechazo escrito de keel-go (README § La frontera): en la silueta documental el
      // precio del proveedor se pide en el momento. No toca nada de la escritura condicional (Product y sus operaciones).
      if (layers.persistence.default?.model === 'document') {
        const need = layers.dependencies.dependencies.pricing.needs.supplierPrice;
        delete need.replica;
        need.strategy = 'on-demand';
      }
    }
  })),
  // La lectura acotada (DSL 2.27, PLAN-DSL-227-LECTURA-ACOTADA.md): los diseños de keel-core/test/helpers/read-scope-designs.js,
  // los MISMOS que miden keel-spring, keel-nest y keel-dotnet, conduit-optional (level: optional) incluido.
  ...READ_SCOPE_DESIGNS.map((design) => ({
    name: design.name,
    from: design.from,
    mutate(manifest, layers) {
      manifest.service.name = design.name;
      design.mutate(layers);
    }
  })),
  // El ciclo de vida del dato (DSL 2.28, PLAN-DSL-228-CICLO-DE-VIDA.md): los diseños de
  // keel-core/test/helpers/data-lifecycle-designs.js, los MISMOS que miden los otros tres.
  ...DATA_LIFECYCLE_DESIGNS.map((design) => ({
    name: design.name,
    from: design.from,
    mutate(manifest, layers) {
      manifest.service.name = design.name;
      design.mutate(layers);
    }
  }))
];

/**
 * Las siluetas con telemetría (`telemetry: otel`), que ninguna fixture pide: cada punto de paso observado al menos una vez. El
 * relacional con cada motor, el documental, sin API (solo reloj y mensajes), con broker, con clientes salientes, caché, storage,
 * correo, pagos, y con seguridad. Las recorren go-syntax, go-idioms, los gates y go-check.
 */
export const TELEMETRY_DESIGNS = [
  { name: 'product-catalog-otel', from: 'product-catalog', stack: { telemetry: 'otel' } },
  { name: 'product-catalog-mysql-otel', from: 'product-catalog', stack: { telemetry: 'otel', database: 'mysql' } },
  { name: 'job-dispatch-mongo-otel', from: 'job-dispatch-mongo', stack: { telemetry: 'otel' } },
  { name: 'metering-digest-otel', from: 'metering-digest', stack: { telemetry: 'otel' } },
  { name: 'stock-reservation-events-otel', from: 'stock-reservation-events', stack: { telemetry: 'otel', broker: 'rabbitmq' } },
  { name: 'stock-reservation-otel', from: 'stock-reservation', stack: { telemetry: 'otel' } },
  { name: 'catalog-extended-otel', from: 'catalog-extended', stack: { telemetry: 'otel' } },
  { name: 'notification-mailer-otel', from: 'notification-mailer', stack: { telemetry: 'otel' } },
  { name: 'payment-checkout-otel', from: 'payment-checkout', stack: { telemetry: 'otel' } },
  { name: 'asset-vault-otel', from: 'asset-vault', stack: { telemetry: 'otel' } },
  { name: 'profile-directory-otel', from: 'profile-directory', stack: { telemetry: 'otel' } }
];
