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
 * En SNS/SQS el consumidor tiene cola propia colgada del topic —dos consumidores del
 * mismo topic necesitan colas distintas para recibir ambos el mensaje—, así que el
 * destino es esa cola y no el topic. En Kafka y RabbitMQ se consume del destino
 * directamente.
 *
 * Está aquí y no en cada emisor porque componer el nombre a mano es exactamente cómo
 * este módulo se rompe: la primera versión del arnés leía el descarte del TOPIC con
 * SQS, o sea una cola que no existe, y la aserción negativa habría salido verde para
 * siempre sin mirar nada.
 */
export function subscriptionDestination(broker, model, sub) {
  return broker === 'snssqs' ? `${model.service.artifactId}-${kebabCase(sub.name)}` : sub.topicDefault;
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
