// Dónde acaba un mensaje que agotó sus reintentos.
//
// `subscriptions.<E>.onFailure.deadLetter` es un booleano del DSL, y durante mucho
// tiempo lo único que produjo fue una frase en el comentario del listener («lo configura
// el agente»). Eso dejaba el campo declarando una garantía que nada implementaba, y
// además rompía por abajo los escenarios: un `Then` del tipo «el mensaje se confirma
// sin acabar en la DLQ» no es asertable si la cola no existe, o si su nombre lo eligió
// el agente y es distinto en cada proyecto.
//
// Este módulo es la fuente ÚNICA del destino de descarte. Lo consumen, en cada generador, cuatro
// sitios que tienen que coincidir exactamente o el mecanismo miente:
//
//   - el aprovisionamiento de la topología (el script de SNS/SQS y la configuración
//     que build genera para Kafka y RabbitMQ),
//   - el arnés de integración, que lee ese destino para poder afirmar sobre él,
//   - el `broker-check` del generador, que ejercita la entrega real contra los tres brokers,
//   - la doctrina del comentario del listener, que ahora puede nombrar la cola concreta.
//
// Y vive en keel-core porque el nombre físico es CONTRATO: el servicio que genera keel-spring y el
// que genera keel-nest del mismo diseño tienen que descartar en la misma cola, o la plataforma que
// vigila esas colas deja de ver los mensajes de uno de los dos.
//
// Mismo criterio que `broker-probes.js`: si el nombre se escribiera a mano en cada
// lado, un día el arnés leería una cola distinta de la que el servicio alimenta y el
// escenario saldría verde sin haber mirado nada.

import { kebabCase } from './naming.js';

/**
 * Nombre físico del destino de descarte.
 *
 * No se unifica el sufijo entre brokers a propósito. En Kafka, `.DLT` es la convención
 * del cliente Kafka de Spring —la que aplica su recuperador por defecto, y la que
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
/**
 * El consumer group de una suscripción en KAFKA: `<servicio>-<evento-kebab>`, uno por
 * suscripción (la skill kafka explica por qué no uno por servicio).
 *
 * Era una convención escrita solo en la skill, y el arnés no tenía de dónde sacarla: tras parar
 * la réplica, la clase siguiente arrancaba con los grupos rebalanceando y agotaba su `await`, y el
 * agente lo parcheó con la lista de grupos y el bootstrap escritos a mano (corrida
 * stock-reservation R8). Ahora la emite la configuración generada como propiedad, la lee el listener y el arnés
 * espera a esos mismos grupos.
 */
export function subscriptionGroupId(model, sub) {
  return `${model.service.artifactId}-${subscriptionKey(sub)}`;
}

/** La clave de la suscripción bajo `messaging.subscriptions` (`stock-depleted`). */
export function subscriptionKey(sub) {
  return sub.topicProperty.split('.').slice(-2)[0];
}

export function subscriptionDestination(broker, model, sub) {
  if (broker === 'snssqs') return `${model.service.artifactId}-${kebabCase(sub.name)}`;
  // La cola propia sobre el canal ajeno, agrupada por origen: la deriva el modelo
  // (`queueDefault`), que es donde vive el saneado por broker.
  if (broker === 'rabbitmq') return sub.queueDefault;
  return sub.topicDefault;
}

/**
 * De dónde LEE el arnés lo que este servicio publica en un canal, que tampoco es lo mismo
 * en los tres brokers — y es el gemelo de `subscriptionDestination`, con la misma trampa.
 *
 * Solo en KAFKA el destino de lectura es el de publicación: allí se produce a un topic y se
 * consume de ese mismo topic, que es el único del servicio (`<slug>.events`).
 *
 * En los otros dos, publicar y leer no ocurren en el mismo sitio y resolver es la IDENTIDAD:
 *
 *   · SNS/SQS — `<slug>-events` es un TOPIC, y de un topic no se lee. El aprovisionamiento
 *     cuelga de él una cola de arnés cuyo nombre ES el del canal (`harnessQueueName`).
 *   · RabbitMQ — `<slug>.events` es un EXCHANGE, y de un exchange tampoco se lee. Hay una
 *     cola durable POR CANAL publicado, nombrada exactamente como el canal, con un binding
 *     por routing key; lo declara el agente siguiendo la skill del broker, que lo dice sin
 *     margen: «las pruebas de integración leen los eventos con `publishedMessages("<canal>")`,
 *     que en RabbitMQ consulta la cola cuyo nombre es el del canal».
 *
 * Devolver el exchange en RabbitMQ es el defecto que destapó la corrida `refunds-rabbit`: la
 * API de colas no acepta un nombre de exchange, así que toda lectura de un canal propio daba
 * 404 y el humo del arnés moría en `initializationError` antes de ejercitar un solo `FL-*`.
 * Era además una REGRESIÓN — la precedencia de canales publicados se añadió durante la corrida
 * de SNS/SQS y la rama de RabbitMQ no se volvió a derivar, así que heredó el valor de Kafka.
 *
 * Y su modo de fallo tiene una mitad silenciosa que es la peor: donde no revienta con 404, un
 * `publishedMessages` que no encuentra nada nunca deja pasar en verde toda aserción negativa
 * —«no se publicó ningún evento»— sin haber mirado.
 *
 * Vive aquí por la misma razón que su gemelo: componerlo a mano en cada emisor es
 * exactamente cómo se rompe.
 */
export function publishedDestination(broker, model, channel) {
  // Los dos brokers en los que se publica a un sitio y se lee de otro, y en los dos el sitio
  // de lectura se llama como el canal: la cola de arnés de SNS/SQS
  // (`harnessQueueName` del aprovisionamiento) y la cola por canal de RabbitMQ (la skill
  // del broker de cada generador, § «Configuración del broker»). Resolver es la identidad y no hay
  // entrada que emitir.
  if (broker === 'snssqs' || broker === 'rabbitmq') return channel;
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

// ─── El reintento del consumidor (`onFailure.retry`) ─────────────────────────
//
// Varias suscripciones pueden declarar políticas distintas y el contenedor de listeners (o el error
// handler) es UNO: gana la más paciente, porque quedarse corto pierde mensajes de la que más esperaba.
// Es la reconciliación de keel-spring, y la misma tiene que hacer cualquier otro generador: el mismo
// diseño espera lo mismo en los dos servidores.

/** Los intentos (el primero incluido): el mayor declarado; sin `retry`, uno solo. */
export function retryMaxAttempts(subs) {
  return Math.max(...subs.map((sub) => sub.retry?.maxAttempts ?? 1));
}

/** El primer intervalo: el mayor declarado (1 s si ninguna lo declara). */
export function retryInitialDelayMs(subs) {
  return Math.max(...subs.map((sub) => sub.retry?.initialDelayMs ?? 1000));
}

/**
 * El techo del intervalo: el mayor de las que lo declaran, o null si ninguna (solo tiene sentido con
 * curva; con `fixed` no hay nada que acotar).
 */
export function retryMaxDelayMs(subs) {
  const declared = subs.map((sub) => sub.retry?.maxDelayMs).filter((value) => typeof value === 'number');
  return declared.length > 0 ? Math.max(...declared) : null;
}

/**
 * El reintento del listener de RabbitMQ, derivado de `onFailure.retry`, o `null` si ninguna suscripción
 * lo declara. Sobre TODAS las suscripciones y no solo las que tienen descarte: en RabbitMQ el reintento
 * no depende de la DLQ.
 *
 * El multiplicador no está en el DSL: con `exponential` es 1.5 (el de `ExponentialBackOff` de Spring,
 * para que la curva no dependa del broker ni del generador); con `fixed`, 1.0. Sin `maxDelayMs`
 * declarado, el techo es 30 s.
 */
export function rabbitListenerRetry(model) {
  const subs = (model.subscriptions ?? []).filter((sub) => sub.retry);
  if (subs.length === 0) return null;
  const exponential = subs.some((sub) => (sub.retry.backoff ?? 'exponential') === 'exponential');
  return {
    attempts: retryMaxAttempts(subs),
    initialMs: retryInitialDelayMs(subs),
    multiplier: exponential ? 1.5 : 1.0,
    maxDelayMs: exponential ? retryMaxDelayMs(subs) ?? 30000 : null,
    subscriptions: subs.map((sub) => sub.name)
  };
}

/**
 * El reintento del consumidor de KAFKA, derivado de `onFailure.retry` de las suscripciones con descarte.
 *
 * En keel-spring el error handler es UNO para todo el contenedor (`DeadLetterConfig`), y build solo lo
 * genera si alguna suscripción declara `onFailure.deadLetter`: entonces su curva sale de ESAS
 * suscripciones —no de todas, a diferencia de RabbitMQ— y se aplica a todos los topics, aunque solo los
 * de `deadLettered` publiquen en su `.DLT`. Sin ninguna, rige el `DefaultErrorHandler` de Spring Kafka
 * por defecto: diez intentos seguidos, sin espera, y después se registra y se confirma. Cualquier otro
 * generador tiene que reintentar igual, o el mismo diseño tardaría distinto en descartar en los dos.
 *
 * Mismo multiplicador que `rabbitListenerRetry` (1.5 con `exponential`, el de `ExponentialBackOff`), y el
 * mismo techo por defecto (30 s).
 */
export function kafkaListenerRetry(model) {
  const subs = deadLetterSubscriptions(model);
  if (subs.length === 0) {
    return { attempts: 10, initialMs: 0, multiplier: 1.0, maxDelayMs: null, deadLetteredTopics: [] };
  }
  const exponential = subs.some((sub) => (sub.retry?.backoff ?? 'exponential') === 'exponential');
  return {
    attempts: retryMaxAttempts(subs),
    initialMs: retryInitialDelayMs(subs),
    multiplier: exponential ? 1.5 : 1.0,
    maxDelayMs: exponential ? retryMaxDelayMs(subs) ?? 30000 : null,
    // El descarte es por TOPIC: dos suscripciones de la misma fuente comparten topic, y basta con que una
    // lo declare (es el `DEAD_LETTERED` de `DeadLetterConfig`).
    deadLetteredTopics: [...new Set(subs.map((sub) => subscriptionDestination('kafka', model, sub)))]
  };
}
