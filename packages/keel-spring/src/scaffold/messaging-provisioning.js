// Aprovisionamiento de la topología de mensajería de prueba (broker: snssqs): `infra/init-messaging.sh` y los
// checks de `validate-infra.sh` que exigen que cada topic y cada cola EXISTAN.
//
// Es NEUTRAL desde el incremento 9g de keel-nest (keel-core/gen/messaging-provisioning.js): el mismo script
// para los dos generadores, porque los nombres son contrato entre el código, el arnés y la infraestructura.
// Aquí solo están los textos con los que el script nombra las piezas de keel-spring.

import {
  harnessQueueName,
  messagingProvisioning as provisioning,
  messagingTopologyChecks,
  needsMessagingProvisioning,
  subscriptionQueues
} from 'keel-core/gen/messaging-provisioning';

export { harnessQueueName, messagingTopologyChecks, needsMessagingProvisioning, subscriptionQueues };

/** Cómo nombra init-messaging.sh las piezas de keel-spring que dependen de su topología. */
export const SPRING_MESSAGING_TEXTS = {
  harnessReaders: 'AbstractFlowIT#publishedMessages / #purgeMessages',
  codeReads: 'por @Value',
  skill: 'keel-spring-snssqs',
  copyHelper: 'AbstractFlowIT#copyToDevtools'
};

/** `infra/init-messaging.sh`, o `null` si el stack no lo necesita. */
export function messagingProvisioning(model) {
  return provisioning(model, { generator: 'keel-spring', messaging: SPRING_MESSAGING_TEXTS });
}
