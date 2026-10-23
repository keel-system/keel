// Qué capacidad del DSL no ejercita ninguna fixture, vista desde keel-nest: el gemelo de
// keel-spring/test/capability-coverage.test.js, con el mismo enumerador (keel-core/test/helpers/capability-coverage.js)
// sobre las MISMAS fixtures.
//
// Lo que este archivo añade al de keel-spring son dos cosas:
//   · la tabla de motivos es la de keel-nest: que una capacidad sea informativa en un generador no dice nada del otro,
//     y una rama sin fixture aquí es TypeScript que no parsea ni compila nadie (ts-syntax y ts-check iteran las
//     fixtures, igual que java-syntax y compile-check);
//   · que «la declara una fixture» signifique «keel-nest la genera»: toda fixture entra entera en su frontera. Si
//     alguna la rechazara, las capacidades que solo ella declara estarían cubiertas para keel-spring y no para
//     keel-nest, y este test seguiría en verde sin mirar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { walk, uncovered as uncoveredIn } from '../../keel-core/test/helpers/capability-coverage.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MOTIVOS = {
  // keel-nest no la lee, o solo la vuelca en un comentario: declararla no cambia ninguna rama de lo emitido.
  informativo: 'informativo',
  // Tiene default y se aplica: declararla cambia un número, no un camino.
  conDefault: 'conDefault',
  // La rama hermana del mismo bloque sí la declara alguna fixture, y el emisor es el mismo código.
  ramaHermana: 'ramaHermana',
  // Un test la genera parcheando el diseño en memoria y exige que el árbol parsee (test/uncovered-branches.test.js).
  soloCadenas: 'soloCadenas',
  // Ni fixture ni test.
  hueco: 'hueco'
};

const EXCEPCIONES = new Map([
  [
    'security.ownership.*.exemptRoles',
    { motivo: MOTIVOS.informativo, porque: 'solo entra en el texto de la nota del handler (keel-core/gen/ownership.js, «Exentos…»): no emite código; lo mide keel-core/test/ownership.test.js.' }
  ],
  [
    'security.cors.maxAgeSeconds',
    { motivo: MOTIVOS.conDefault, porque: 'keel-core/gen/model.js aplica 3600 si falta y security.js lo escribe tal cual: declararlo cambia el número emitido, no el camino.' }
  ],
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
    { motivo: MOTIVOS.soloCadenas, porque: 'la rama `onMiss.action: fail` de una réplica (projections.js, el lector que lanza el error del catálogo); uncovered-branches.test.js la genera sobre catalog-extended.' }
  ],
  [
    'dependencies.dependencies.*.needs.*.replica.onMiss.degradedTo',
    { motivo: MOTIVOS.soloCadenas, porque: 'la prosa de la rama `degrade` de esa misma réplica; uncovered-branches.test.js exige que llegue a lo emitido.' }
  ],
  [
    'dependencies.dependencies.*.activations.*.onFailure.degradedTo',
    {
      motivo: MOTIVOS.soloCadenas,
      porque: 'la tercera rama del fallback de una activación (`degrade` → TODO con la prosa). `ignore` y `fail` las declara alguna fixture; uncovered-branches.test.js genera esta.'
    }
  ],
  [
    'mail.sender.address',
    { motivo: MOTIVOS.ramaHermana, porque: 'remitente `source: fixed`. notification-mailer declara `data` para el remitente y `fixed` para el reply-to, y mail.js emite las dos con la misma función.' }
  ],
  [
    'mail.replyTo.fallback',
    { motivo: MOTIVOS.ramaHermana, porque: 'la simétrica de la anterior: reply-to con `source: data`, cuya rama ya se emite por el remitente.' }
  ],
  [
    'payments.capture.amount',
    {
      motivo: MOTIVOS.hueco,
      porque: 'la captura parcial: payments.js y los dos adaptadores la emiten (`capture(…, amount, currency)`), pero payment-checkout captura siempre entero porque MercadoPago no la cubre, y ningún test la genera.'
    }
  ],
  [
    'payments.charge.currency.input',
    { motivo: MOTIVOS.ramaHermana, porque: 'la moneda por petición: la fixture la toma de un parámetro de despliegue, y el adaptador emite las dos ramas desde la misma expresión de la moneda.' }
  ]
]);

const uncovered = () => uncoveredIn(FIXTURES_DIR);

test('toda fixture entra entera en la frontera de keel-nest: declarada por una fixture es generada por keel-nest', () => {
  for (const name of fs.readdirSync(FIXTURES_DIR)) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], `${name} cae fuera de la frontera de keel-nest`);
  }
});

test('toda capacidad opcional del DSL la declara alguna fixture, o EXCEPCIONES dice por qué no', () => {
  const sinAnotar = uncovered().filter((dataPath) => !EXCEPCIONES.has(dataPath));
  assert.deepEqual(
    sinAnotar,
    [],
    'estas capacidades no las declara ninguna fixture, así que su TypeScript no lo compila nadie.\n' +
      'Declárala en una fixture (entra sola en ts-syntax y ts-check) o añade su fila a EXCEPCIONES con su motivo:\n  ' +
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

test('un soloCadenas de keel-nest tiene su test de verdad', () => {
  const tests = fs.readFileSync(new URL('./uncovered-branches.test.js', import.meta.url), 'utf8');
  for (const [dataPath, fila] of EXCEPCIONES) {
    if (fila.motivo !== MOTIVOS.soloCadenas) continue;
    const leaf = dataPath.split('.').slice(-2).join('.');
    assert.ok(tests.includes(leaf), `${dataPath}: soloCadenas, pero uncovered-branches.test.js no nombra ${leaf}`);
  }
});

// El enumerador es compartido y su autocomprobación vive en keel-spring; aquí basta que vea un mapa.
test('el enumerador compartido desciende por un mapa del diseño', () => {
  const schema = { type: 'object', properties: { clients: { type: 'object', additionalProperties: { type: 'object', properties: { retries: { type: 'integer' } } } } } };
  const counts = new Map();
  walk(schema, schema, [{ clients: { a: {} } }], 'capa', counts, new Set());
  assert.equal(counts.get('capa.clients.*.retries'), 0);
});
