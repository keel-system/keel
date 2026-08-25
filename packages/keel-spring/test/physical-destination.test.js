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
import { harnessQueueName } from '../src/scaffold/messaging-provisioning.js';

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

test('en RabbitMQ un canal que PUBLICAMOS se traduce a nuestro destino, no al del proveedor', () => {
  // `stockEvents` se usa en los dos sentidos: publicamos en él y nos suscribimos a él. Antes
  // este mapa se construía SOLO desde las suscripciones, así que ganaba la cola del proveedor
  // (`inventory.events`) y `publishedMessages("stockEvents")` leía el buzón equivocado: un
  // Then sobre lo que publicamos se afirmaba contra mensajes que no eran nuestros.
  const source = harness('stock-reservation', 'rabbitmq');

  assert.match(source, /Map\.entry\("stockEvents", "stock-reservation\.events"\)/);
  assert.ok(!source.includes('Map.entry("stockEvents", "inventory.events")'), source);
  // Las DOS puertas, no solo la purga: la lectura tenía el mismo defecto sin haberse
  // manifestado todavía, y su fallo es el que no se ve.
  assert.match(bodyOf(source, 'publishedMessages'), /physicalDestination\(destination\)/);
  // La purga se llama `purgeDestination` cuando hay outbox (`purgeMessages` es entonces el
  // envoltorio que espera al relay antes): lo que importa es el método que habla con el broker.
  const purge = source.includes('purgeDestination(String') ? 'purgeDestination' : 'purgeMessages';
  assert.match(bodyOf(source, purge), /physicalDestination\(destination\)/);
});

test('en SNS/SQS lo publicado se lee de la cola de arnés, que se llama como el canal', () => {
  // Aquí había dos defectos encadenados, y el segundo lo destapó la corrida de SNS/SQS.
  //
  // El primero: las tres suscripciones de `stockEvents` dan tres colas distintas, así que el
  // canal caía en SPLIT_ACROSS y resolver LANZABA — reventando el humo del arnés para un
  // canal cuyo destino de publicación está perfectamente definido. Un canal que publicamos
  // nunca es ambiguo.
  //
  // El segundo: ese destino NO es el mismo que en RabbitMQ. En SNS/SQS `<slug>-events` es un
  // TOPIC, y de un topic no se lee; el aprovisionamiento crea una cola de arnés cuyo nombre
  // ES el del canal (`harnessQueueName`). Traducir aí el topic compone una URL de cola que no
  // existe: la lectura muere con NonExistentQueue, o peor, no encuentra nada nunca y toda
  // aserción negativa pasa en verde sin mirar.
  const source = harness('stock-reservation', 'snssqs');

  assert.equal(harnessQueueName('stockEvents'), 'stockEvents');
  assert.ok(!source.includes('Map.entry("stockEvents"'), 'traduce un canal cuyo destino ya es él mismo');
  assert.ok(!source.includes('SPLIT_ACROSS'), source);
  // Resolver sigue siendo un punto único aunque aquí sea la identidad.
  assert.match(source, /protected static String physicalDestination\(String destination\)/);
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
