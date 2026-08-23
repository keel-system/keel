// El arnés habla con DESTINOS, y el test escribe CANALES.
//
// Un canal que el servicio publica coincide con su destino físico; el de una suscripción no: la
// cola sale de su `source` (y en SNS/SQS, de la cola propia del consumidor). `deliverXxx` ya lo
// resolvía, pero `purgeMessages(...)` y `publishedMessages(...)` recibían el nombre del canal y se
// lo pasaban al broker tal cual. En una corrida real eso hizo que `purgeMessages("notificationRequests")`
// borrase el contenido de una cola que no existe: `curl` salía con error de transporte, que no dice
// nada del nombre, y costó una ronda entera de arbitraje distinguirlo de un fallo del código.
//
// La mitad silenciosa es peor: la lectura del mismo canal habría devuelto «vacío» para siempre, y
// toda aserción negativa sobre él —«no se publicó nada»— habría salido verde sin mirar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

/** El AbstractFlowIT de la fixture, generado para el broker pedido. */
function harness(fixture, broker) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-physical-dest-');
  const result = scaffoldService({
    manifest,
    layers,
    workspace,
    force: true,
    stack: { broker, database: 'postgresql' }
  });
  const file = walk(path.join(workspace, result.outDir)).find((f) => f.endsWith('AbstractFlowIT.java'));
  assert.ok(file, 'no se generó el arnés');
  return fs.readFileSync(file, 'utf8');
}

/** La línea de la firma: lo que el helper le pasa al broker viaja en su cuerpo. */
function bodyOf(source, method) {
  const from = source.indexOf(`${method}(String`);
  assert.ok(from > 0, `no se generó ${method}`);
  return source.slice(from, source.indexOf('\n    }', from));
}

test('en RabbitMQ el canal de la suscripción se traduce a su cola antes de hablar con el broker', () => {
  // `stockEvents` es el canal declarado; la cola real la da el `source` (`inventory`).
  const source = harness('stock-reservation', 'rabbitmq');

  assert.match(source, /Map\.entry\("stockEvents", "inventory\.events"\)/);
  // Las DOS puertas, no solo la purga: la lectura tenía el mismo defecto sin haberse
  // manifestado todavía, y su fallo es el que no se ve.
  assert.match(bodyOf(source, 'publishedMessages'), /physicalDestination\(destination\)/);
  // La purga se llama `purgeDestination` cuando hay outbox (`purgeMessages` es entonces el
  // envoltorio que espera al relay antes): lo que importa es el método que habla con el broker.
  const purge = source.includes('purgeDestination(String') ? 'purgeDestination' : 'purgeMessages';
  assert.match(bodyOf(source, purge), /physicalDestination\(destination\)/);
});

test('y cuando el canal se reparte en varias colas, el arnés falla en el sitio en vez de purgar una al azar', () => {
  // En SNS/SQS cada consumidor tiene su cola colgada del topic, así que las tres
  // suscripciones de `stockEvents` no tienen UN destino: elegir uno purgaría la cola
  // equivocada y el Then siguiente saldría verde sin haber mirado nada.
  const source = harness('stock-reservation', 'snssqs');

  assert.match(source, /SPLIT_ACROSS/);
  assert.match(source, /IllegalArgumentException/);
  assert.match(source, /StockReserved → stock-reservation-stock-reserved/);
});

test('sin ninguna suscripción con destino propio, resolver es la identidad y no se emite tabla', () => {
  // La simétrica: donde canal y destino coinciden, una tabla vacía sería ruido — y el
  // punto de resolución tiene que seguir existiendo, o los helpers vuelven a saber de esto.
  // `notification-mailer` tiene suscripción, pero sin `channel` declarado: el canal ES su
  // destino y no hay nada que traducir.
  const source = harness('notification-mailer', 'rabbitmq');

  assert.ok(!source.includes('PHYSICAL_OF'), 'emite una tabla que no traduce nada');
  assert.match(source, /protected static String physicalDestination\(String destination\) \{\s*return destination;/);
});
