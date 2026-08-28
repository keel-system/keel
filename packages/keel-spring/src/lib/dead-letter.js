// Dónde acaba un mensaje que agotó sus reintentos.
//
// `subscriptions.<E>.onFailure.deadLetter` es un booleano del DSL, y durante mucho
// tiempo lo único que produjo fue una frase en el javadoc del listener («lo configura
// el agente»). Eso dejaba el campo declarando una garantía que nada implementaba, y
// además rompía por abajo los escenarios: un `Then` del tipo «el mensaje se confirma
// sin acabar en la DLQ» no es asertable si la cola no existe, o si su nombre lo eligió
// el agente y es distinto en cada proyecto.
//
// Este módulo es la fuente ÚNICA del destino de descarte. Lo consumen cuatro sitios que
// tienen que coincidir exactamente o el mecanismo miente:
//
//   - el aprovisionamiento de la topología (`messaging-provisioning.js` en SNS/SQS,
//     y las clases de configuración que build genera para Kafka y RabbitMQ),
//   - el arnés de integración, que lee ese destino para poder afirmar sobre él,
//   - `scripts/broker-check.js`, que ejercita la entrega real contra los tres brokers,
//   - la doctrina del javadoc, que ahora puede nombrar la cola concreta.
//
// Mismo criterio que `broker-probes.js`: si el nombre se escribiera a mano en cada
// lado, un día el arnés leería una cola distinta de la que el servicio alimenta y el
// escenario saldría verde sin haber mirado nada.

import { kebabCase } from './naming.js';

/**
 * Nombre físico del destino de descarte.
 *
 * No se unifica el sufijo entre brokers a propósito. En Kafka, `.DLT` es la convención
 * de Spring Kafka —la que aplica `DeadLetterPublishingRecoverer` por defecto y la que
 * cualquiera espera al mirar la lista de topics—, y renombrarla obligaría a configurar
 * el recoverer solo para ser distintos. En SQS el sufijo `-dlq` ya estaba en uso por el
 * aprovisionamiento, y un punto no es válido en todos los nombres de cola. RabbitMQ se
 * alinea con SQS porque no tiene convención propia.
 */
export function deadLetterName(broker, destination) {
  return broker === 'kafka' ? `${destination}.DLT` : `${destination}-dlq`;
}

/**
 * De dónde consume una suscripción, que NO es lo mismo en los tres brokers.
 *
 * Con fan-out —SNS/SQS y RabbitMQ— el canal del emisor es un TOPIC o un EXCHANGE, y de
 * ninguno de los dos se consume: cuelga de él una cola por consumidor, porque dos
 * servicios suscritos al mismo canal tienen que recibir ambos el mensaje y una sola cola
 * compartida se lo repartiría. El destino es esa cola, no el canal. En Kafka no hay tal
 * cosa: cada consumidor tiene su grupo sobre el mismo topic y se consume del destino
 * directamente.
 *
 * RabbitMQ vivía en el lado equivocado de esa frontera y costó una corrida entera
 * (`corrida-mail-rabbit`): build daba por hecho que el canal de origen ERA una cola, así
 * que la declaraba con ese nombre, entregaba por el exchange por defecto —cuya routing
 * key es el nombre de la cola— y purgaba ese mismo nombre, mientras el agente montaba la
 * topología que enseña su skill (exchange + cola propia). Nada casaba: la entrega se
 * perdía en silencio y la purga avisaba en cada reset sin vaciar nada.
 *
 * Está aquí y no en cada emisor porque componer el nombre a mano es exactamente cómo
 * este módulo se rompe: la primera versión del arnés leía el descarte del TOPIC con
 * SQS, o sea una cola que no existe, y la aserción negativa habría salido verde para
 * siempre sin mirar nada.
 */
export function subscriptionDestination(broker, model, sub) {
  if (broker === 'snssqs') return `${model.service.artifactId}-${kebabCase(sub.name)}`;
  // La cola propia sobre el canal ajeno, agrupada por origen: la deriva el modelo
  // (lib/model.js § queueDefault), que es donde vive el saneado por broker.
  if (broker === 'rabbitmq') return sub.queueDefault;
  return sub.topicDefault;
}

/**
 * De dónde LEE el arnés lo que este servicio publica en un canal, que tampoco es lo mismo
 * en los tres brokers — y es el gemelo de `subscriptionDestination`, con la misma trampa.
 *
 * En RabbitMQ se publica al destino único del servicio (`<slug>.events`) y de esa cola se
 * lee. En SNS/SQS eso es un TOPIC, y de un topic no se lee: el aprovisionamiento crea una
 * cola de arnés colgada de él cuyo nombre ES el del canal (`harnessQueueName`), así que ahí
 * resolver es la identidad. Confundirlos compone una URL de cola que no existe, y la
 * lectura muere con NonExistentQueue — o, peor, un `publishedMessages` que nunca encuentra
 * nada y deja pasar en verde toda aserción negativa.
 *
 * Vive aquí por la misma razón que su gemelo: componerlo a mano en cada emisor es
 * exactamente cómo se rompe.
 */
export function publishedDestination(broker, model, channel) {
  // En SNS/SQS, la cola de arnés se llama como el canal (messaging-provisioning.js
  // § harnessQueueName): resolver es la identidad y no hay entrada que emitir.
  if (broker === 'snssqs') return channel;
  return model.messaging?.destinationDefault ?? channel;
}

/** El destino de descarte de una suscripción, ya resuelto para su broker. */
export function deadLetterDestination(broker, model, sub) {
  return deadLetterName(broker, subscriptionDestination(broker, model, sub));
}

/** ¿Alguna suscripción del diseño declara `onFailure.deadLetter`? */
export function usesDeadLetter(model) {
  return deadLetterSubscriptions(model).length > 0;
}

/** Las suscripciones que lo declaran, que son las únicas con topología de descarte. */
export function deadLetterSubscriptions(model) {
  return (model.subscriptions ?? []).filter((sub) => sub.deadLetter);
}
