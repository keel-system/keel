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
import { deadLetterName, deadLetterSubscriptions, subscriptionDestination } from '../lib/dead-letter.js';

const MESSAGING_PKG = 'infrastructure.messaging';

/**
 * Las suscripciones con descarte, agrupadas por DESTINO.
 *
 * El mapeo evento→destino no es 1:1: dos suscripciones del mismo proveedor comparten
 * canal (`WithdrawalAccepted` y `WithdrawalRejected` sobre `compliance.events`) y el
 * DSL lo permite a propósito. Emitir un elemento por suscripción producía un
 * `Set.of("a", "b", "b")`, que **no** es un aviso ni un duplicado inofensivo: `Set.of`
 * lanza `IllegalArgumentException: duplicate element` en la inicialización ESTÁTICA de
 * la clase, así que ninguna `@Configuration` completa su enhancement y el
 * `ApplicationContext` entero se cae al arrancar. En la corrida del 13/08/2026 bloqueó
 * el 100% de los escenarios: ni el humo del arnés llegó a levantar el contexto.
 *
 * Agrupar aquí, y no en cada rama, es lo que impide que el siguiente broker lo repita:
 * la de RabbitMQ tenía la misma cardinalidad mal puesta y declaraba dos beans `Queue`
 * para la misma cola.
 */
function byDestination(model, broker, subs) {
  const groups = new Map();
  for (const sub of subs) {
    const destination = subscriptionDestination(broker, model, sub);
    if (!groups.has(destination)) groups.set(destination, { destination, subs: [] });
    groups.get(destination).subs.push(sub);
  }
  return [...groups.values()];
}

export function generate(model) {
  const subs = deadLetterSubscriptions(model);
  // RabbitMQ va aparte y ANTES del corte por descarte: ahí no se declara solo la DLQ, se
  // declara la TOPOLOGÍA de consumo entera (exchange de origen + cola propia + binding), y
  // eso hace falta la declare o no el diseño su descarte. Cuando dependía de `deadLetter`,
  // un diseño sin descarte se quedaba sin dueño de la topología: el agente la improvisaba
  // desde su skill con otro nombre de cola, y la purga y la entrega del arnés —que sí salen
  // de build— hablaban con un destino inexistente (`corrida-mail-rabbit`).
  if (model.stack?.broker === 'rabbitmq') {
    return (model.subscriptions ?? []).length > 0 ? [rabbitConfig(model, subs)] : [];
  }
  if (subs.length === 0) return [];
  if (model.stack?.broker === 'kafka') return [kafkaConfig(model, subs)];
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
    'com.fasterxml.jackson.databind.ObjectMapper',
    'java.nio.charset.StandardCharsets',
    'java.util.Set',
    'org.apache.kafka.common.TopicPartition',
    'org.apache.kafka.common.errors.SerializationException',
    'org.apache.kafka.common.serialization.Serializer',
    'org.apache.kafka.common.serialization.StringSerializer',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.kafka.core.DefaultKafkaProducerFactory',
    'org.springframework.kafka.core.KafkaTemplate',
    'org.springframework.kafka.core.ProducerFactory',
    'org.springframework.kafka.listener.DeadLetterPublishingRecoverer',
    'org.springframework.kafka.listener.DefaultErrorHandler',
    'org.springframework.util.backoff.BackOff',
    `${subPackage(model, 'domain.errors')}.DomainException`
  ]);

  const groups = byDestination(model, 'kafka', subs);
  const topics = groups.map((group) => `"${group.destination}"`).join(', ');
  const backOff = retryBackOff(subs);
  for (const imported of backOff.imports) imports.add(imported);
  const listed = subs.map((sub) => `${sub.name} → ${deadLetterName('kafka', sub.topicDefault)}`).join(', ');
  const shared = groups
    .filter((group) => group.subs.length > 1)
    .map((group) => `${group.subs.map((sub) => sub.name).join(' y ')} comparten {@code ${group.destination}}`)
    .join('; ');

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

    /**
     * Topics de origen con descarte declarado en el diseño. Es un conjunto por TOPIC, no
     * por suscripción${shared ? `: ${shared}` : ''}.
     */
    private static final Set<String> DEAD_LETTERED = Set.of(${topics});

    @Bean
    public DefaultErrorHandler kafkaErrorHandler(ProducerFactory<Object, Object> producerFactory, ObjectMapper objectMapper) {
        // Template propio para republicar, construido como objeto PLANO y no como @Bean:
        // un segundo bean de tipo KafkaTemplate apagaría el autoconfigurado, porque el
        // @ConditionalOnMissingBean de Boot mira el tipo crudo y no los genéricos, y el
        // publicador de eventos se quedaría sin el suyo.
        DefaultKafkaProducerFactory<Object, Object> deadLetterProducerFactory = new DefaultKafkaProducerFactory<>(
                producerFactory.getConfigurationProperties(),
                keySerializer(),
                deadLetterValueSerializer(objectMapper));
        KafkaTemplate<Object, Object> deadLetterTemplate = new KafkaTemplate<>(deadLetterProducerFactory);

        DeadLetterPublishingRecoverer publisher = new DeadLetterPublishingRecoverer(
                deadLetterTemplate,
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
                retryBackOff());

        // Una violación de regla de negocio NO se reintenta: el mensaje no va a procesarse
        // mejor dentro de un segundo, así que reintentarlo solo retrasa el descarte, ocupa
        // el consumidor y —cuando la suscripción declara dead-letter— manda a la DLT algo
        // que ya se resolvió al primer intento. El reintento existe para el fallo
        // TRANSITORIO (la base que no responde, el broker que se cae), que en esta
        // jerarquía es cualquier RuntimeException que no sea DomainException.
        handler.addNotRetryableExceptions(DomainException.class);

        return handler;
    }

${backOff.method}

    /**
     * La clave del record que llega al recoverer es siempre la del origen (String).
     * {@code StringSerializer} declara {@code Serializer<String>}, de ahí el cast a la
     * firma {@code Object} que exige el factory.
     */
    @SuppressWarnings("unchecked")
    private static Serializer<Object> keySerializer() {
        return (Serializer<Object>) (Serializer<?>) new StringSerializer();
    }

    /**
     * Serializador del valor que se republica, y la razón por la que este template existe.
     *
     * <p>Lo que llega al recoverer <b>no siempre es del mismo tipo</b>, y no lo decide esta
     * clase: lo decide la deserialización del consumidor. Con un fallo de deserialización
     * llega el {@code byte[]} crudo; con el {@code StringDeserializer} de partida, un
     * {@code String}; y en cuanto el consumo pasa a {@code JsonDeserializer} —lo normal en
     * cuanto el listener quiere el {@code EventEnvelope} tipado— llega el objeto ya
     * deserializado. Reutilizar el {@code KafkaTemplate} autoconfigurado (cuyo serializador
     * de valor es {@code StringSerializer}) funciona en los dos primeros casos y revienta
     * con {@code ClassCastException} en el tercero — y ahí el {@code DefaultErrorHandler} no
     * logra recuperar, hace seek al mismo offset y <b>reintenta para siempre</b>, dejando la
     * partición atascada para todos los mensajes que vengan detrás.
     *
     * <p>Por eso el serializador es explícito y cubre los tres: los bytes y el texto pasan
     * TAL CUAL —volver a envolverlos en JSON dejaría en el descarte un mensaje distinto del
     * que se recibió, y el que lo inspeccione no encontraría lo que busca— y cualquier otra
     * cosa se serializa con el {@code ObjectMapper} de la aplicación, el mismo que produce
     * los eventos que salen, para que el JSON del descarte sea equivalente al del origen.
     */
    private static Serializer<Object> deadLetterValueSerializer(ObjectMapper objectMapper) {
        return (topic, value) -> {
            if (value == null) {
                return null;
            }
            if (value instanceof byte[] bytes) {
                return bytes;
            }
            if (value instanceof String text) {
                return text.getBytes(StandardCharsets.UTF_8);
            }
            try {
                return objectMapper.writeValueAsBytes(value);
            } catch (Exception failure) {
                throw new SerializationException("No se pudo serializar el mensaje para el descarte de " + topic, failure);
            }
        };
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
    'org.springframework.amqp.core.BindingBuilder',
    'org.springframework.amqp.core.Declarables',
    'org.springframework.amqp.core.Queue',
    'org.springframework.amqp.core.QueueBuilder',
    'org.springframework.amqp.core.TopicExchange',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration'
  ]);

  // Un bean por COLA, no por suscripción: con RabbitMQ las suscripciones que comparten
  // canal de origen consumen de la misma cola, así que emitir uno por evento declararía
  // dos veces la misma —y RabbitMQ rechaza con PRECONDITION_FAILED la redeclaración con
  // argumentos distintos, tumbando el arranque—. Es la misma cardinalidad que en Kafka.
  const deadLettered = new Set(subs.map((sub) => sub.name));
  const beans = byDestination(model, 'rabbitmq', model.subscriptions ?? [])
    .map(({ destination, subs: sharing }) => {
      const bean = beanName(destination);
      const who = sharing.map((sub) => sub.name).join(', ');
      const source = sharing[0].topicDefault;
      // El descarte es propiedad de la COLA, así que basta con que UNA de las suscripciones
      // que la comparten lo declare: no hay forma de dar DLQ a un evento y no a otro si los
      // dos llegan por la misma cola.
      const withDeadLetter = sharing.some((sub) => deadLettered.has(sub.name));
      const dlq = deadLetterName('rabbitmq', destination);
      const args = withDeadLetter
        ? `
                .withArgument("x-dead-letter-exchange", "")
                .withArgument("x-dead-letter-routing-key", "${dlq}")`
        : '';
      const dlqDecl = withDeadLetter ? `
        Queue deadLetter = QueueBuilder.durable("${dlq}").build();` : '';
      const declarables = withDeadLetter
        ? 'source, queue, deadLetter, BindingBuilder.bind(queue).to(source).with("#")'
        : 'source, queue, BindingBuilder.bind(queue).to(source).with("#")';
      return `    /**
     * Topología de consumo de ${who}${withDeadLetter ? ', con su descarte enlazado por argumentos' : ''}.
     *
     * <p>El binding usa {@code "#"} porque el canal de origen transporta todo lo que publica
     * su emisor, no solo lo que este servicio consume: el filtro por {@code eventType} va en
     * el listener, que descarta sin lanzar lo que no le corresponde.
     */
    @Bean
    public Declarables ${bean}Topology() {
        TopicExchange source = new TopicExchange("${source}", true, false);
        Queue queue = QueueBuilder.durable("${destination}")${args}
                .build();${dlqDecl}
        return new Declarables(${declarables});
    }`;
    })
    .join('\n\n');

  const listed = (model.subscriptions ?? [])
    .map((sub) => `${sub.name} → ${subscriptionDestination('rabbitmq', model, sub)}`)
    .join(', ');

  const body = `/**
 * Topología RabbitMQ de las suscripciones: ${listed}.
 *
 * <p>El canal que nombra el diseño es el <b>exchange</b> del emisor, y de un exchange no se
 * consume: cuelga de él una cola propia de este servicio. Dos servicios suscritos al mismo
 * canal necesitan colas distintas, o el broker les repartiría los mensajes en vez de
 * entregárselos a ambos.
 *
 * <p>Estas declaraciones son de <b>build</b>: no las redeclares en el listener ni en otra
 * {@code @Configuration}. Dos declaraciones de la misma cola con argumentos distintos hacen
 * que RabbitMQ rechace la segunda con PRECONDITION_FAILED, y el contenedor no arranca. El
 * nombre de la cola está en {@code messaging.subscriptions.<evento>.queue}: léelo de ahí.
 */
@Configuration
public class RabbitTopologyConfig {

${beans}
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, 'RabbitTopologyConfig'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

// El backoff y los intentos son del diseño (`onFailure.retry`). Si varias suscripciones
// declaran distintos, gana el mayor: el error handler es uno solo para el factory, y
// quedarse corto pierde mensajes de la que más paciencia pedía.
const maxAttempts = (subs) => Math.max(...subs.map((sub) => sub.retry?.maxAttempts ?? 3));
const backoffMs = (subs) => Math.max(...subs.map((sub) => sub.retry?.initialDelayMs ?? 1000));

// `maxDelayMs` solo tiene sentido con curva: con `fixed` no hay nada que acotar. Se toma
// el mayor de las que lo declaran, y `null` si ninguna lo hace (ahí manda el default de
// Spring, 30 s, y ponerle un número sería inventarlo).
function maxDelayMs(subs) {
  const declared = subs.map((sub) => sub.retry?.maxDelayMs).filter((value) => typeof value === 'number');
  return declared.length > 0 ? Math.max(...declared) : null;
}

/**
 * El `BackOff` del error handler, derivado de `onFailure.retry.backoff`.
 *
 * El handler es **uno solo** para el container factory, así que las políticas de las
 * suscripciones hay que reconciliarlas: con `maxAttempts` e `initialDelayMs` ya gana el
 * mayor, y con la curva gana `exponential` en cuanto una la pida — es la más paciente de
 * las dos, y el criterio tiene que ser el mismo (quedarse corto pierde los mensajes de la
 * suscripción que más esperaba).
 *
 * El valor por defecto del DSL es `exponential` (`common.schema.json § retryPolicy`), así
 * que emitir `FixedBackOff` siempre era además el caso menos probable: un diseño que no
 * dice nada pedía curva y recibía intervalo plano.
 *
 * El multiplicador **no está en el DSL**: se deja el de Spring (1.5) en vez de inventar un
 * número que ningún artefacto respalda.
 */
function retryBackOff(subs) {
  const attempts = maxAttempts(subs);
  const initial = backoffMs(subs);
  const exponential = subs.some((sub) => (sub.retry?.backoff ?? 'exponential') === 'exponential');

  if (!exponential) {
    return {
      imports: ['org.springframework.util.backoff.FixedBackOff'],
      method: `    /** Intervalo plano: las suscripciones con descarte declaran {@code backoff: fixed}. */
    private static BackOff retryBackOff() {
        return new FixedBackOff(${initial}L, ${attempts - 1}L);
    }`
    };
  }

  const ceiling = maxDelayMs(subs);
  const ceilingLine = ceiling === null ? '' : `\n        backOff.setMaxInterval(${ceiling}L);`;
  const ceilingDoc =
    ceiling === null
      ? 'El diseño no declara {@code maxDelayMs}, así que\n     * el techo del intervalo es el de Spring (30 s).'
      : `El techo del intervalo ({@code maxDelayMs}) es\n     * ${ceiling} ms.`;

  return {
    imports: ['org.springframework.util.backoff.ExponentialBackOff'],
    method: `    /**
     * Curva exponencial: las suscripciones con descarte declaran
     * {@code backoff: exponential}. ${ceilingDoc} El multiplicador es el de Spring
     * (1.5): el DSL no lo declara y ponerle otro sería un número sin respaldo en el diseño.
     */
    private static BackOff retryBackOff() {
        ExponentialBackOff backOff = new ExponentialBackOff();
        backOff.setInitialInterval(${initial}L);${ceilingLine}
        backOff.setMaxAttempts(${attempts - 1});
        return backOff;
    }`
  };
}

// El nombre del bean sale del DESTINO, que puede traer puntos y guiones (`compliance.events`):
// se camelliza para que sea un identificador Java válido y estable.
const beanName = (name) =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
