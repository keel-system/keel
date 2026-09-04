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
import { publishedDestination } from '../src/lib/dead-letter.js';

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

test('en RabbitMQ lo publicado se lee de la cola HOMÓNIMA del canal, no del exchange', () => {
  // `stockEvents` se usa en los dos sentidos: publicamos en él y nos suscribimos a él. Este
  // caso ha corregido DOS veces el mismo mapa, y la segunda es la que enseña algo.
  //
  // Primero mapeaba a la cola del PROVEEDOR (`inventory.events`), porque el mapa se construía
  // solo desde las suscripciones: un Then sobre lo que publicamos se afirmaba contra mensajes
  // que no eran nuestros. Al arreglarlo se pasó al otro extremo —el destino único del servicio,
  // `stock-reservation.events`—, y eso en RabbitMQ es un EXCHANGE: la API de colas no lo
  // acepta, así que toda lectura de un canal propio daba 404. Lo destapó la corrida
  // `refunds-rabbit`, con el humo del arnés muriendo antes de ejercitar un solo `FL-*`.
  //
  // Lo correcto es la identidad, igual que en SNS/SQS y por el mismo motivo: se publica al
  // exchange y se lee de la cola por canal que declara el agente, nombrada como el canal
  // (skill keel-spring-rabbitmq). Ninguno de los dos extremos anteriores era esa cola.
  const source = harness('stock-reservation', 'rabbitmq');

  assert.ok(!source.includes('Map.entry("stockEvents", "stock-reservation.events")'), 'traduce al exchange, del que no se lee');
  assert.ok(!source.includes('Map.entry("stockEvents", "inventory.events")'), source);
  assert.ok(!source.includes('Map.entry("stockEvents"'), 'traduce un canal cuyo destino de lectura ya es él mismo');
  // Las DOS puertas, no solo la purga: la lectura tenía el mismo defecto sin haberse
  // manifestado todavía, y su fallo es el que no se ve.
  assert.match(bodyOf(source, 'publishedMessages'), /physicalDestination\(destination\)/);
  // La purga se llama `purgeDestination` cuando hay outbox (`purgeMessages` es entonces el
  // envoltorio que espera al relay antes): lo que importa es el método que habla con el broker.
  const purge = source.includes('purgeDestination(String') ? 'purgeDestination' : 'purgeMessages';
  assert.match(bodyOf(source, purge), /physicalDestination\(destination\)/);
});

test('y ese nombre es el MISMO que la skill le manda declarar al agente', () => {
  // Las dos mitades del mismo hecho, atadas.
  //
  // La cola de un canal publicado en RabbitMQ no la declara build: la declara el AGENTE, en
  // `RabbitMqConfig`, siguiendo la skill del broker. Build solo tiene que saber cómo se llama
  // para poder leerla. Son dos proyecciones de una decisión que vive en un tercer sitio, y
  // mientras nadie las cruzara podían separarse sin que nada se pusiera rojo — que es
  // exactamente lo que pasó: build resolvía al exchange, el agente declaraba la cola por canal,
  // y el desacuerdo se vio en una corrida en vivo con el humo del arnés muriendo.
  //
  // Y NO lo caza `broker-check`: ese runner SIEMBRA su propia topología antes de leerla, así
  // que con el valor equivocado sería igual de autoconsistente y saldría verde. Lo único que
  // discrimina es contrastar el resolutor con lo que la skill prescribe.
  const skill = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'generators', 'spring',
      'skills', 'keel-spring-rabbitmq', 'SKILL.md'),
    'utf8'
  );

  assert.match(
    skill,
    /consulta \*\*la cola cuyo nombre es el del canal\*\*/,
    'la skill dejó de mandar declarar la cola con el nombre del canal: si cambió la topología, publishedDestination tiene que cambiar con ella'
  );
  assert.match(skill, /nombrada exactamente como el canal/, 'la skill dejó de nombrar la cola como el canal');

  // Y el resolutor de build dice lo mismo: la identidad.
  const model = { messaging: { destinationDefault: 'stock-reservation.events' } };
  assert.equal(
    publishedDestination('rabbitmq', model, 'stockEvents'),
    'stockEvents',
    'build leería de un sitio distinto del que el agente declara'
  );
  // La simétrica, que es la que evita «arreglarlo» devolviendo siempre el canal: en Kafka se
  // consume del MISMO topic al que se produce, y ahí el destino único sí es la respuesta.
  assert.equal(publishedDestination('kafka', model, 'stockEvents'), 'stock-reservation.events');
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
