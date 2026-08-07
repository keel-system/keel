// Los comandos de broker tienen DOS consumidores —el Java del arnés y el runner de
// `broker-check`— y su única garantía de no divergir es salir del mismo módulo. Estos
// tests fijan las dos proyecciones: que el Java renderizado sea el que el arnés lleva
// incrustado, y que el argv ejecutable resuelva a lo mismo.
//
// Lo que estos tests NO pueden decir es si el comando es CORRECTO contra el broker:
// eso es `npm run broker-check`, que los ejecuta de verdad.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as generateIntegrationTests } from '../src/scaffold/integration-tests.js';
import { resolveStack } from '../src/scaffold/index.js';
import {
  BROKERS,
  ENDPOINTS,
  UNKNOWN_TOPIC,
  argv,
  deliverParts,
  deliverShell,
  expr,
  isEmptyRead,
  javaArgs,
  offsetsParts,
  purgeParts,
  rabbitProbeBody,
  rabbitProbeBodyJava,
  rabbitPublishBody,
  rabbitPublishBodyJava,
  readParts,
  sqsAttributesJson
} from '../src/lib/broker-probes.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const harnessFor = (broker) => {
  const { manifest, layers } = loadService(path.join(fixturesDir, 'catalog-extended'));
  // Con el stack RESUELTO, como hace scaffoldService: los nombres físicos de los
  // destinos dependen del broker, y el resto del modelo, de la BD elegida.
  const stack = resolveStack({ broker }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return generateIntegrationTests(model).find((file) => file.path.endsWith('AbstractFlowIT.java')).content;
};

test('kafka: la lectura lleva -C, que es lo que separa consumir de no hacer nada', () => {
  const parts = readParts('kafka', { destination: 'catalog.events', offset: 'beginning' });
  assert.deepEqual(argv('kafka', parts), [
    'kcat', '-C', '-b', 'kafka:29092', '-t', 'catalog.events', '-o', 'beginning', '-e', '-q'
  ]);
  // Sin `-C`, kcat elige modo productor cuando su stdin no es un terminal y sale en
  // verde sin leer nada: un falso negativo indistinguible de "aún no ha llegado".
  assert.ok(argv('kafka', parts).includes('-C'));
});

test('snssqs: el prefijo `aws` lo aporta el helper del arnés, no cada comando', () => {
  const parts = readParts('snssqs', { destination: 'catalog-events', count: '10' });
  assert.equal(parts[0], 'sqs');
  assert.deepEqual(argv('snssqs', parts).slice(0, 5), [
    'aws', '--endpoint-url', ENDPOINTS.snssqs.endpoint, '--region', ENDPOINTS.snssqs.region
  ]);
});

test('snssqs: la entrega ENTRANTE publica en el topic, no en la cola', () => {
  // Enviar directo a la cola se salta el filtro por eventType de la suscripción,
  // que es la mitad del contrato de recepción — y además el nombre del topic no es
  // el de ninguna cola: falla con NonExistentQueue.
  const parts = deliverParts('snssqs', { destination: 'pricing-events', bodyFile: '/tmp/b.json' });
  const resolved = argv('snssqs', parts);
  assert.ok(resolved.includes('sns'));
  assert.ok(resolved.includes('publish'));
  assert.ok(resolved.includes(`${ENDPOINTS.snssqs.topicArnPrefix}pricing-events`));
  assert.ok(!resolved.some((piece) => piece.includes('/000000000000/')));
});

test('kafka: la entrega va por shell, con el destino y la clave comillados', () => {
  const line = deliverShell({
    destination: "cat'alog",
    key: 'k1',
    bodyFile: '/tmp/b.json',
    headers: { eventType: 'ProductCreated' }
  });
  assert.match(line, /^kcat -P -b kafka:29092 -t /);
  // La comilla del destino no puede cerrar la cadena de la shell.
  assert.ok(line.includes("'cat'\\''alog'"));
  assert.ok(line.includes("-H 'eventType=ProductCreated'"));
  assert.ok(line.endsWith('-l /tmp/b.json'));
});

test('kafka no tiene purga: su aislamiento es la marca de offset', () => {
  assert.equal(purgeParts('kafka', { destination: 'catalog.events' }), null);
  assert.ok(argv('rabbitmq', purgeParts('rabbitmq', { destination: 'q' })).includes('-XDELETE'));
  assert.ok(argv('snssqs', purgeParts('snssqs', { destination: 'q' })).includes('purge-queue'));
});

test('cada broker dice "vacío" a su manera', () => {
  assert.ok(isEmptyRead('rabbitmq', '[]'));
  assert.ok(!isEmptyRead('rabbitmq', '[{"payload":"x"}]'));
  assert.ok(isEmptyRead('snssqs', '{}'));
  assert.ok(!isEmptyRead('snssqs', '{"Messages":[]}'.replace('[]', '[{"Body":"x"}]')));
  assert.ok(isEmptyRead('kafka', '   '));
  assert.ok(!isEmptyRead('kafka', '{"a":1}'));
});

test('los cuerpos JS y su versión Java son el mismo cuerpo', () => {
  // El Java se DERIVA del constructor JS intercalando expresiones, así que un
  // cambio de forma no puede quedarse en uno de los dos lados. Se comprueba
  // reconstruyendo el JS desde el Java renderizado.
  const java = rabbitProbeBodyJava('count');
  const reconstructed = java
    .split(' + ')
    .map((piece) => (piece === 'count' ? '7' : piece.slice(1, -1).replace(/\\"/g, '"')))
    .join('');
  assert.equal(reconstructed, rabbitProbeBody(7));

  const publishJava = rabbitPublishBodyJava({
    key: 'key',
    headers: 'headersJson(headers)',
    destination: 'destination',
    payload: 'encoded'
  });
  for (const fragment of ['"routing_key"', '"payload_encoding"', '"message_id"']) {
    assert.ok(publishJava.includes(fragment.replace(/"/g, '\\"')), `falta ${fragment} en el Java`);
  }
  assert.ok(rabbitPublishBody({ destination: 'q', key: 'k', headersJson: '{}', payloadBase64: 'eA==' }).includes('"payload":"eA=="'));
});

test('los atributos de SQS llevan el DataType que exige la API', () => {
  assert.equal(
    sqsAttributesJson({ eventType: 'ProductCreated' }),
    '{"eventType":{"DataType":"String","StringValue":"ProductCreated"}}'
  );
});

// ─── Paridad con el Java que se emite ────────────────────────────────────────

test('el arnés generado contiene exactamente los comandos del módulo', () => {
  const kafka = harnessFor('kafka');
  assert.ok(kafka.includes(javaArgs(readParts('kafka', { destination: expr('EVENT_TOPIC'), offset: expr('offset') }))));
  assert.ok(kafka.includes(javaArgs(offsetsParts({ destination: expr('EVENT_TOPIC'), format: '%o\\n' }))));
  // La tolerancia al topic virgen depende de un literal del broker: si Kafka
  // cambiara el texto, el arnés dejaría de traducirlo a "no hay mensajes".
  assert.ok(kafka.includes(UNKNOWN_TOPIC));

  const rabbit = harnessFor('rabbitmq');
  assert.ok(rabbit.includes(`private static final String RABBIT_API = "${ENDPOINTS.rabbitmq.queuesApi}"`));
  assert.ok(rabbit.includes(`private static final String RABBIT_PUBLISH = "${ENDPOINTS.rabbitmq.publishApi}"`));
  assert.ok(rabbit.includes(rabbitProbeBodyJava('count')));

  const sqs = harnessFor('snssqs');
  assert.ok(sqs.includes(`private static final String QUEUE_URL = "${ENDPOINTS.snssqs.queueUrlPrefix}"`));
  assert.ok(sqs.includes(`private static final String TOPIC_ARN = "${ENDPOINTS.snssqs.topicArnPrefix}"`));
  assert.ok(sqs.includes('"sns", "publish", "--topic-arn", TOPIC_ARN + destination'));
});

test('los tres brokers del módulo son los tres que genera el scaffolding', () => {
  assert.deepEqual([...BROKERS].sort(), ['kafka', 'rabbitmq', 'snssqs']);
  for (const broker of BROKERS) {
    assert.ok(harnessFor(broker).includes('publishedMessages'), `${broker} sin sondeo de publicación`);
  }
});
