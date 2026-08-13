// El descarte cuando DOS suscripciones comparten destino.
//
// El DSL lo permite y es lo normal: un proveedor publica todos sus hechos por el mismo
// canal (`WithdrawalAccepted` y `WithdrawalRejected` sobre `compliance.events`). Ninguna
// fixture del repo tenía esa forma con `deadLetter` en las dos, así que la cardinalidad
// mal puesta —un elemento por SUSCRIPCIÓN en vez de por DESTINO— pasó todos los tests y
// llegó a una corrida en vivo, donde bloqueó el 100% de los escenarios: `Set.of` con un
// literal repetido lanza en la inicialización ESTÁTICA de la clase, así que ninguna
// `@Configuration` completa su enhancement y el ApplicationContext entero se cae. Ni el
// humo del arnés llegó a levantarse.
//
// Estos tests fijan la forma en los dos brokers que generan clase. Se construyen sobre un
// modelo parcheado y no sobre una fixture nueva a propósito: lo que hay que cubrir es una
// relación entre dos suscripciones, no una silueta de servicio distinta.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { resolveStack } from '../src/scaffold/index.js';
import { generate as generateDeadLetter } from '../src/scaffold/dead-letter-config.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * El diseño de la fixture con una suscripción MÁS sobre el canal que ya usa otra, las
 * dos con descarte. Es el caso real de `compliance.events`.
 */
function sharedChannelDesign() {
  const { manifest, layers } = loadService(path.join(fixturesDir, 'catalog-extended'));
  const messaging = structuredClone(layers.messaging);
  const rejected = messaging.subscriptions.WithdrawalRejected;
  messaging.subscriptions.WithdrawalAccepted = {
    ...structuredClone(rejected),
    description: 'El registro regulatorio aceptó una retirada inscrita.',
    payload: { productId: { type: 'uuid', required: true } },
    triggers: rejected.triggers
  };
  return { manifest, layers: { ...layers, messaging } };
}

function configFor(broker, design = sharedChannelDesign()) {
  const { manifest, layers } = design;
  const stack = resolveStack({ database: 'postgresql', broker }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  const files = generateDeadLetter(model);
  return files.length > 0 ? files[0].content : null;
}

test('kafka: el conjunto de topics con descarte no repite el canal compartido', () => {
  const config = configFor('kafka');
  const declaration = config.split('\n').find((line) => line.includes('DEAD_LETTERED = Set.of('));
  assert.ok(declaration, config);

  const topics = declaration.slice(declaration.indexOf('Set.of(') + 7, declaration.lastIndexOf(')')).split(',').map((t) => t.trim());
  assert.deepEqual(
    [...new Set(topics)].length,
    topics.length,
    `Set.of con literales repetidos: lanza IllegalArgumentException al cargar la clase — ${declaration}`
  );
  // Y el canal compartido sigue estando: deduplicar no puede acabar en perderlo.
  assert.ok(topics.includes('"compliance.events"'), declaration);

  // Las dos suscripciones se siguen nombrando en la documentación de la clase: lo que se
  // agrupa es el destino, no la información de qué evento acaba dónde.
  assert.ok(config.includes('WithdrawalAccepted'), config);
  assert.ok(config.includes('WithdrawalRejected'), config);
});

test('rabbitmq: una sola pareja de beans por cola, aunque dos suscripciones la compartan', () => {
  const config = configFor('rabbitmq');

  const declared = [...config.matchAll(/QueueBuilder\.durable\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(declared)].length, declared.length, `cola declarada dos veces: ${declared.join(', ')}`);
  assert.ok(declared.includes('compliance.events'));
  assert.ok(declared.includes('compliance.events-dlq'));

  // Y los nombres de bean son identificadores Java válidos: el destino trae un punto.
  const beans = [...config.matchAll(/public Queue ([A-Za-z0-9_]+)\(\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(beans)].length, beans.length, `bean duplicado: ${beans.join(', ')}`);
  assert.ok(beans.includes('complianceEventsQueue'), beans.join(', '));
  assert.ok(!config.includes('compliance.eventsQueue()'), config);
});

// El segundo defecto del mismo archivo en la misma corrida, y el más caro de arreglar
// (~58 min): el recoverer republicaba con el KafkaTemplate autoconfigurado, cuyo
// serializador de valor es StringSerializer. El tipo de lo que llega al recoverer NO lo
// decide esta clase —lo decide la deserialización del consumidor, que build delega—, así
// que en cuanto el consumo pasó a JsonDeserializer llegó un objeto y reventó con
// ClassCastException. Y ahí DefaultErrorHandler no recupera: hace seek al mismo offset
// para siempre y atasca la partición entera.
test('kafka: el recoverer no usa el KafkaTemplate autoconfigurado', () => {
  const config = configFor('kafka');

  // Toma el ProducerFactory y construye el suyo; el template autoconfigurado no entra.
  assert.match(config, /kafkaErrorHandler\(ProducerFactory<Object, Object> producerFactory, ObjectMapper objectMapper\)/);
  assert.ok(config.includes('new DefaultKafkaProducerFactory<>('), config);
  // Y NO como @Bean: un segundo bean de tipo KafkaTemplate apaga el autoconfigurado,
  // porque el @ConditionalOnMissingBean de Boot mira el tipo crudo y no los genéricos.
  assert.ok(!/@Bean\s+public KafkaTemplate/.test(config), config);
});

test('kafka: el serializador del descarte cubre los tres tipos que puede recibir', () => {
  const config = configFor('kafka');

  // byte[] y String pasan tal cual —reenvolverlos dejaría en el descarte un mensaje
  // distinto del recibido— y cualquier otra cosa va por el ObjectMapper de la app.
  assert.ok(config.includes('value instanceof byte[] bytes'), config);
  assert.ok(config.includes('value instanceof String text'), config);
  assert.ok(config.includes('objectMapper.writeValueAsBytes(value)'), config);
  // El nulo primero: `instanceof` con null es false y acabaría en el ObjectMapper.
  const serializer = config.slice(config.indexOf('deadLetterValueSerializer(ObjectMapper'));
  assert.ok(serializer.indexOf('value == null') < serializer.indexOf('instanceof'), serializer);
});

test('sin canal compartido el resultado no cambia: la deduplicación no altera el caso simple', () => {
  // La fixture tal cual: solo `WithdrawalRejected` declara descarte, así que hay un
  // único topic y nada que agrupar. Es la mitad que impide que este arreglo se lea como
  // «se deduplicó de más» — un canal con una sola suscripción sigue apareciendo.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'catalog-extended'));
  const config = configFor('kafka', { manifest, layers });
  const declaration = config.split('\n').find((line) => line.includes('DEAD_LETTERED = Set.of('));

  assert.match(declaration, /Set\.of\("compliance\.events"\);/);
});
