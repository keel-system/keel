// La topología de descarte, que ahora la posee `build`.
//
// `subscriptions.<E>.onFailure.deadLetter` declaraba una garantía que solo existía en
// SNS/SQS (donde el aprovisionamiento crea la cola) y que en Kafka y RabbitMQ era una
// frase en el javadoc: «lo configura el agente». Con eso, el mismo diseño tenía o no
// tenía descarte según el stack, y ningún escenario podía afirmar sobre la cola porque
// su nombre lo elegía quien implementara el listener.
//
// Aquí se genera lo que falta para los dos brokers que no lo tenían. El nombre del
// destino sale de `lib/dead-letter.js`, que es el mismo sitio del que lo lee el arnés.

import { javaFile, javaPath, subPackage } from './render.js';
import { deadLetterName, deadLetterSubscriptions } from '../lib/dead-letter.js';

const MESSAGING_PKG = 'infrastructure.messaging';

export function generate(model) {
  const subs = deadLetterSubscriptions(model);
  if (subs.length === 0) return [];
  if (model.stack?.broker === 'kafka') return [kafkaConfig(model, subs)];
  if (model.stack?.broker === 'rabbitmq') return [rabbitConfig(model, subs)];
  // snssqs: la topología la crea infra/init-messaging.sh (RedrivePolicy), porque en
  // SQS el descarte es del BROKER — lo hace él al agotar maxReceiveCount, sin que haya
  // código de reintento que escribir. No hay clase que generar.
  return [];
}

// ─── Kafka ───────────────────────────────────────────────────────────────────
//
// El error handler de Spring Kafka es del container factory, no de la suscripción, así
// que un `DeadLetterPublishingRecoverer` a secas mandaría a DLT TODO lo que falle —
// incluidas las suscripciones que el diseño dejó sin descarte. De ahí el conjunto de
// topics: el recoverer solo publica para los que lo declaran, y para el resto se
// comporta como el default (registra y sigue), que es lo que significa no declararlo.
function kafkaConfig(model, subs) {
  const imports = new Set([
    'java.util.Set',
    'org.apache.kafka.common.TopicPartition',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.kafka.core.KafkaTemplate',
    'org.springframework.kafka.listener.DeadLetterPublishingRecoverer',
    'org.springframework.kafka.listener.DefaultErrorHandler',
    'org.springframework.util.backoff.FixedBackOff'
  ]);

  const topics = subs.map((sub) => `"${sub.topicDefault}"`).join(', ');
  const attempts = maxAttempts(subs);
  const delay = backoffMs(subs);
  const listed = subs.map((sub) => `${sub.name} → ${deadLetterName('kafka', sub.topicDefault)}`).join(', ');

  const body = `/**
 * Descarte de los mensajes que agotan sus reintentos: ${listed}.
 *
 * <p>El destino es el topic de origen con el sufijo {@code .DLT}, que es la convención
 * de Spring Kafka. Solo se publica para las suscripciones que declaran
 * {@code onFailure.deadLetter}: las demás se registran y se confirman, que es lo que
 * significa no declararlo.
 *
 * <p>La partición del destino se deja en -1 a propósito. Reutilizar
 * {@code record.partition()} revienta cuando el DLT tiene menos particiones que el
 * topic de origen, y es un fallo que solo aparece en producción con el reparto real.
 */
@Configuration
public class DeadLetterConfig {

    private static final Logger log = LoggerFactory.getLogger(DeadLetterConfig.class);

    /** Suscripciones con descarte declarado en el diseño. */
    private static final Set<String> DEAD_LETTERED = Set.of(${topics});

    @Bean
    public DefaultErrorHandler kafkaErrorHandler(KafkaTemplate<Object, Object> kafkaTemplate) {
        DeadLetterPublishingRecoverer publisher = new DeadLetterPublishingRecoverer(
                kafkaTemplate,
                (record, exception) -> new TopicPartition(record.topic() + ".DLT", -1));

        DefaultErrorHandler handler = new DefaultErrorHandler(
                (record, exception) -> {
                    if (DEAD_LETTERED.contains(record.topic())) {
                        publisher.accept(record, exception);
                        return;
                    }
                    log.error("Mensaje descartado de {} tras agotar los reintentos; el diseño no declara dead-letter para esta suscripción",
                            record.topic(), exception);
                },
                new FixedBackOff(${delay}L, ${attempts - 1}L));

        return handler;
    }
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, 'DeadLetterConfig'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

// ─── RabbitMQ ────────────────────────────────────────────────────────────────
//
// Es el único broker del que `build` no declaraba NADA de topología: la sembraba la
// aplicación, o sea el agente, al escribir el listener. Eso dejaba el nombre de la cola
// —y por tanto el del descarte— fuera del alcance de cualquier escenario.
//
// Se usa el exchange por defecto (`""`), cuya routing key ES el nombre de la cola. Es
// la misma convención que ya asume `broker-probes.js` para publicar, así que el arnés
// y la aplicación hablan del mismo sitio sin un exchange más que declarar.
function rabbitConfig(model, subs) {
  const imports = new Set([
    'org.springframework.amqp.core.Queue',
    'org.springframework.amqp.core.QueueBuilder',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration'
  ]);

  const beans = subs
    .map((sub) => {
      const queue = sub.topicDefault;
      const dlq = deadLetterName('rabbitmq', queue);
      const bean = beanName(sub.name);
      return `    /** Cola de ${sub.name}, con su descarte enlazado por argumentos. */
    @Bean
    public Queue ${bean}Queue() {
        return QueueBuilder.durable("${queue}")
                .withArgument("x-dead-letter-exchange", "")
                .withArgument("x-dead-letter-routing-key", "${dlq}")
                .build();
    }

    @Bean
    public Queue ${bean}DeadLetterQueue() {
        return QueueBuilder.durable("${dlq}").build();
    }`;
    })
    .join('\n\n');

  const listed = subs.map((sub) => `${sub.name} → ${deadLetterName('rabbitmq', sub.topicDefault)}`).join(', ');

  const body = `/**
 * Colas de suscripción con su descarte: ${listed}.
 *
 * <p>El descarte se enlaza por argumentos de cola ({@code x-dead-letter-exchange} vacío
 * más {@code x-dead-letter-routing-key}), así que lo aplica el broker cuando el consumidor
 * rechaza el mensaje sin reencolar. No hay código de reintento que escribir.
 *
 * <p>Estas declaraciones son de <b>build</b>: no las redeclares en el listener. Dos
 * declaraciones de la misma cola con argumentos distintos hacen que RabbitMQ rechace la
 * segunda con PRECONDITION_FAILED, y el contenedor no arranca.
 */
@Configuration
public class DeadLetterConfig {

${beans}
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, 'DeadLetterConfig'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

// El backoff y los intentos son del diseño (`onFailure.retry`). Si varias suscripciones
// declaran distintos, gana el mayor: el error handler es uno solo para el factory, y
// quedarse corto pierde mensajes de la que más paciencia pedía.
const maxAttempts = (subs) => Math.max(...subs.map((sub) => sub.retry?.maxAttempts ?? 3));
const backoffMs = (subs) => Math.max(...subs.map((sub) => sub.retry?.initialDelayMs ?? 1000));

const beanName = (name) => name.charAt(0).toLowerCase() + name.slice(1);
