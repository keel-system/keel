// Qué capacidad del DSL no ejercita ninguna fixture, vista desde keel-dotnet: el gemelo de los de keel-spring y keel-nest,
// con el mismo enumerador (keel-core/test/helpers/capability-coverage.js) sobre las MISMAS fixtures.
//
// Lo que este archivo añade a los otros dos:
//   · la tabla de motivos es la de keel-dotnet: que una capacidad sea informativa en un generador no dice nada de otro,
//     y una rama sin fixture aquí es C# que no compila nadie (cs-check compila las fixtures y sus variantes);
//   · que «la declara una fixture» signifique «keel-dotnet la genera»: toda fixture entra entera en su frontera;
//   · que un `soloCadenas` tenga sus DOS redes: la rama en lo emitido (uncovered-branches.test.js) y su variante en
//     cs-check, que la compila y ejecuta sus pruebas emitidas (UNCOVERED_BRANCHES de test/helpers/workspace.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { checkGatewaySupport } from 'keel-core/gen/payment-gateways';
import { walk, uncovered as uncoveredIn } from '../../keel-core/test/helpers/capability-coverage.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { CS_VARIANTS, FIXTURES_DIR, UNCOVERED_BRANCHES, fixtureNames } from './helpers/workspace.js';

const MOTIVOS = {
  // keel-dotnet no la lee, o solo la vuelca en un comentario: declararla no cambia ninguna rama de lo emitido.
  informativo: 'informativo',
  // Tiene default y se aplica: declararla cambia un número, no un camino.
  conDefault: 'conDefault',
  // La rama hermana del mismo bloque sí la declara alguna fixture, y el emisor es el mismo código.
  ramaHermana: 'ramaHermana',
  // Un parche de UNCOVERED_BRANCHES la genera: uncovered-branches.test.js exige la rama y cs-check la compila.
  soloCadenas: 'soloCadenas',
  // Ni fixture ni parche.
  hueco: 'hueco'
};

const EXCEPCIONES = new Map([
  [
    'messaging.subscriptions.*.contract.schemaRef',
    { motivo: MOTIVOS.informativo, porque: 'solo entra en la línea «Formato: …» del comentario de la clase del mensaje (messaging.js): ningún lector depende de él.' }
  ],
  [
    'dependencies.dependencies.*.contract.source',
    { motivo: MOTIVOS.informativo, porque: 'el propio schema lo declara informativo: ni la validación ni los generadores lo resuelven.' }
  ],
  [
    'dependencies.dependencies.*.needs.*.replica.onMiss.error',
    { motivo: MOTIVOS.soloCadenas, porque: 'la rama `onMiss.action: fail` de una réplica (projections.js, el lector que lanza la excepción del error): catalog-extended-replica-fail.' }
  ],
  [
    'dependencies.dependencies.*.needs.*.replica.onMiss.degradedTo',
    { motivo: MOTIVOS.soloCadenas, porque: 'la prosa de la rama `degrade` de esa misma réplica, en el lector y en la nota del handler: catalog-extended-replica-degrade.' }
  ],
  [
    'dependencies.dependencies.*.activations.*.onFailure.degradedTo',
    {
      motivo: MOTIVOS.soloCadenas,
      porque: 'la tercera rama del fallback de una activación (`degrade` → TODO con la prosa). `ignore` y `fail` las declara alguna fixture; catalog-extended-activation-degrade genera esta.'
    }
  ],
  [
    'mail.sender.address',
    { motivo: MOTIVOS.ramaHermana, porque: 'remitente `source: fixed`. notification-mailer declara `data` para el remitente y `fixed` para el reply-to, y mail.js emite las dos con la misma expresión.' }
  ],
  [
    'mail.replyTo.fallback',
    { motivo: MOTIVOS.ramaHermana, porque: 'la simétrica de la anterior: reply-to con `source: data`, cuya rama ya se emite por el remitente.' }
  ],
  [
    'payments.capture.amount',
    {
      motivo: MOTIVOS.soloCadenas,
      porque: 'la captura parcial: payment-checkout captura siempre entero porque MercadoPago no la cubre; payment-checkout-partial-capture la genera sobre Stripe (amount_to_capture).'
    }
  ],
  [
    'payments.charge.currency.input',
    { motivo: MOTIVOS.ramaHermana, porque: 'la moneda por petición: la fixture la toma de un parámetro de despliegue, y el adaptador emite las dos ramas desde la misma expresión de la moneda.' }
  ]
]);

const uncovered = () => uncoveredIn(FIXTURES_DIR);

test('toda fixture entra entera en la frontera de keel-dotnet: declarada por una fixture es generada por keel-dotnet', () => {
  for (const name of fixtureNames()) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], `${name} cae fuera de la frontera de keel-dotnet`);
  }
});

test('toda capacidad opcional del DSL la declara alguna fixture, o EXCEPCIONES dice por qué no', () => {
  const sinAnotar = uncovered().filter((dataPath) => !EXCEPCIONES.has(dataPath));
  assert.deepEqual(
    sinAnotar,
    [],
    'estas capacidades no las declara ninguna fixture, así que su C# no lo compila nadie.\n' +
      'Declárala en una fixture (entra sola en cs-check) o añade su fila a EXCEPCIONES con su motivo:\n  ' +
      sinAnotar.join('\n  ')
  );
});

test('EXCEPCIONES no acumula filas muertas', () => {
  const abiertas = new Set(uncovered());
  const muertas = [...EXCEPCIONES.keys()].filter((dataPath) => !abiertas.has(dataPath));
  assert.deepEqual(muertas, [], `ya hay fixture que declara esto: borra su fila de EXCEPCIONES.\n  ${muertas.join('\n  ')}`);
});

test('cada excepción declara un motivo de la tabla y lo explica', () => {
  for (const [dataPath, fila] of EXCEPCIONES) {
    assert.ok(Object.values(MOTIVOS).includes(fila.motivo), `${dataPath}: motivo desconocido '${fila.motivo}'`);
    assert.ok((fila.porque ?? '').length > 40, `${dataPath}: el motivo tiene que decir POR QUÉ, no solo etiquetarlo`);
  }
});

test('un soloCadenas nombra su parche, el test lo recorre y cs-check lo compila', () => {
  const tests = fs.readFileSync(new URL('./uncovered-branches.test.js', import.meta.url), 'utf8');
  const csCheck = fs.readFileSync(new URL('../scripts/cs-check.js', import.meta.url), 'utf8');
  // cs-check compila CS_VARIANTS (la lista que comparte con cs-syntax), y esa lista lleva todos los parches.
  assert.match(csCheck, /const DERIVED = CS_VARIANTS;/, 'cs-check no compila las variantes de CS_VARIANTS');
  for (const branch of UNCOVERED_BRANCHES) assert.ok(CS_VARIANTS.includes(branch), `CS_VARIANTS no lleva el parche ${branch.name}`);
  for (const [dataPath, fila] of EXCEPCIONES) {
    if (fila.motivo !== MOTIVOS.soloCadenas) continue;
    const branch = UNCOVERED_BRANCHES.find((candidate) => fila.porque.includes(candidate.name));
    assert.ok(branch, `${dataPath}: soloCadenas, pero su motivo no nombra ningún parche de UNCOVERED_BRANCHES`);
    assert.ok(tests.includes(`'${branch.name}'`), `${dataPath}: uncovered-branches.test.js no recorre ${branch.name}`);
    const leaf = dataPath.split('.').slice(-2).join('.');
    assert.ok(tests.includes(leaf), `${dataPath}: uncovered-branches.test.js no nombra ${leaf}`);
  }
});

test('el parche de una pasarela es uno que esa pasarela cubre', () => {
  for (const branch of UNCOVERED_BRANCHES.filter((candidate) => candidate.paymentGateway)) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, branch.from));
    branch.mutate(manifest, layers, branch.from);
    assert.deepEqual(checkGatewaySupport(layers, branch.paymentGateway).errors, [], `${branch.name}: ${branch.paymentGateway} no lo cubre`);
  }
});

// El enumerador es compartido y su autocomprobación vive en keel-spring; aquí basta que vea un mapa.
test('el enumerador compartido desciende por un mapa del diseño', () => {
  const schema = { type: 'object', properties: { clients: { type: 'object', additionalProperties: { type: 'object', properties: { retries: { type: 'integer' } } } } } };
  const counts = new Map();
  walk(schema, schema, [{ clients: { a: {} } }], 'capa', counts, new Set());
  assert.equal(counts.get('capa.clients.*.retries'), 0);
});
