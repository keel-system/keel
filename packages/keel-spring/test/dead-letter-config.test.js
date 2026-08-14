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

// El tercer defecto del mismo archivo, encontrado en la corrida del 14/08/2026: el
// `BackOff` era un `FixedBackOff` fijo y `onFailure.retry.backoff` no se leía nunca. Las
// tres suscripciones de la fixture declaran `exponential` —que además es el DEFAULT del
// DSL—, así que el caso que el scaffold emitía era el menos probable de los dos: un diseño
// que no dice nada pide curva y recibía intervalo plano. No rompió ningún escenario (el
// número total de intentos sí coincidía), y por eso llegó a una corrida sin que nada lo
// avisara: el gate de este archivo son los tests, no la matriz.
function withBackoff(policy) {
  const { manifest, layers } = sharedChannelDesign();
  const messaging = structuredClone(layers.messaging);
  for (const sub of Object.values(messaging.subscriptions)) {
    if (sub.onFailure?.deadLetter) sub.onFailure.retry = { ...sub.onFailure.retry, ...policy };
  }
  return { manifest, layers: { ...layers, messaging } };
}

test('kafka: la curva del BackOff sale de onFailure.retry.backoff', () => {
  const exponential = configFor('kafka', withBackoff({ maxAttempts: 5, backoff: 'exponential', initialDelayMs: 500, maxDelayMs: 30000 }));

  assert.ok(exponential.includes('new ExponentialBackOff()'), exponential);
  assert.ok(exponential.includes('backOff.setInitialInterval(500L);'), exponential);
  assert.ok(exponential.includes('backOff.setMaxInterval(30000L);'), exponential);
  // maxAttempts del DSL son ENTREGAS totales; el BackOff cuenta REINTENTOS, así que 5 → 4.
  // Es la misma aritmética que tenía FixedBackOff y no puede cambiar al cambiar la curva.
  assert.ok(exponential.includes('backOff.setMaxAttempts(4);'), exponential);
  assert.ok(!exponential.includes('FixedBackOff'), exponential);
  assert.ok(exponential.includes('import org.springframework.util.backoff.ExponentialBackOff;'), exponential);
  assert.ok(!exponential.includes('import org.springframework.util.backoff.FixedBackOff;'), exponential);

  const fixed = configFor('kafka', withBackoff({ maxAttempts: 5, backoff: 'fixed', initialDelayMs: 500 }));
  assert.ok(fixed.includes('new FixedBackOff(500L, 4L)'), fixed);
  assert.ok(!fixed.includes('ExponentialBackOff'), fixed);
  assert.ok(!fixed.includes('import org.springframework.util.backoff.ExponentialBackOff;'), fixed);
});

test('kafka: sin backoff declarado gana el default del DSL, que es exponencial', () => {
  // `common.schema.json § retryPolicy` fija `backoff` con default `exponential`, así que
  // un diseño que solo declara `maxAttempts` está pidiendo curva. Emitir intervalo plano
  // ahí es cambiar el diseño en silencio, no elegir un default conservador.
  const config = configFor('kafka', withBackoff({ maxAttempts: 3, backoff: undefined, initialDelayMs: undefined, maxDelayMs: undefined }));

  assert.ok(config.includes('new ExponentialBackOff()'), config);
  assert.ok(config.includes('backOff.setMaxAttempts(2);'), config);
  // Sin `maxDelayMs` no se estampa techo: manda el default de Spring (30 s). Poner un
  // número aquí sería inventarlo, que es justo lo que este archivo dejó de hacer.
  assert.ok(!config.includes('setMaxInterval'), config);
  assert.ok(config.includes('el techo del intervalo es el de Spring'), config);
});

test('kafka: con políticas distintas gana la más paciente, curva incluida', () => {
  // El error handler es UNO para el container factory, así que las políticas de las
  // suscripciones hay que reconciliarlas. Con `maxAttempts` e `initialDelayMs` ya ganaba
  // el mayor; la curva sigue el mismo criterio: basta que una pida exponencial.
  const { manifest, layers } = sharedChannelDesign();
  const messaging = structuredClone(layers.messaging);
  const withDlq = Object.values(messaging.subscriptions).filter((sub) => sub.onFailure?.deadLetter);
  assert.ok(withDlq.length > 1, 'la fixture parcheada tiene que traer más de una suscripción con descarte');
  withDlq[0].onFailure.retry = { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 100 };
  withDlq[1].onFailure.retry = { maxAttempts: 5, backoff: 'exponential', initialDelayMs: 500, maxDelayMs: 20000 };

  const config = configFor('kafka', { manifest, layers: { ...layers, messaging } });

  assert.ok(config.includes('new ExponentialBackOff()'), config);
  assert.ok(config.includes('backOff.setInitialInterval(500L);'), config);
  assert.ok(config.includes('backOff.setMaxInterval(20000L);'), config);
  assert.ok(config.includes('backOff.setMaxAttempts(4);'), config);
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
