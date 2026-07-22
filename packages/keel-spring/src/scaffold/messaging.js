// Mensajería del servicio (portada del shared del prototipo, como
// funcionalidad propia): EventEnvelope/EventMetadata (contrato estándar de
// publicación con eventId, timestamp UTC, correlationId y source), un
// publisher por evento que publica el evento ENVUELTO al exchange/topic
// <servicio>.events, y la configuración del broker (RabbitMqConfig con
// conversor JSON; en Kafka los serializadores van en parameters/<perfil>).
// Reliability (outbox / after-commit) queda como TODO del agente.

import { kebabCase } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { MEDIATOR_PKG } from './mediator.js';

const MESSAGING_PKG = 'infrastructure.messaging';
const BROKER_CONFIG_PKG = 'infrastructure.configurations.broker';

export function generate(model) {
  if (!model.layersPresent.messaging) return [];
  const subscriptions = model.subscriptions ?? [];
  if (model.events.length === 0 && subscriptions.length === 0) return [];

  // El envelope/metadata es el contrato de (de)serialización tanto al publicar
  // como al consumir; se genera si hay publicación o suscripción.
  const files = [renderEnvelope(model), renderMetadata(model)];
  if (model.stack.broker === 'rabbitmq' && model.events.length > 0) files.push(renderRabbitConfig(model));
  files.push(...model.events.map((event) => renderPublisher(model, event)));

  for (const sub of subscriptions) {
    files.push(renderSubscriptionMessage(model, sub));
    files.push(renderListener(model, sub));
  }
  return files;
}

function renderEnvelope(model) {
  const body = `/**
 * Envoltura estándar de los eventos publicados: metadata + payload.
 */
public record EventEnvelope<T>(EventMetadata metadata, T data) {

    public static <T> EventEnvelope<T> of(String eventType, T data, String correlationId) {
        return new EventEnvelope<>(EventMetadata.create(eventType, correlationId), data);
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, 'EventEnvelope'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [], body)
  };
}

function renderMetadata(model) {
  const body = `/**
 * Metadata de un evento publicado: id único, tipo, timestamp UTC, correlación
 * y servicio de origen.
 */
public record EventMetadata(String eventId, String eventType, String timestamp, String correlationId, String source) {

    public static EventMetadata create(String eventType, String correlationId) {
        return new EventMetadata(
                UUID.randomUUID().toString(),
                eventType,
                Instant.now().toString(),
                correlationId,
                "${model.service.name}");
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, 'EventMetadata'),
    content: javaFile(subPackage(model, MESSAGING_PKG), ['java.time.Instant', 'java.util.UUID'], body)
  };
}

// Configuración RabbitMQ (patrón del prototipo): exchange de eventos del
// servicio + conversor JSON para publicar/consumir records.
function renderRabbitConfig(model) {
  const body = `@Configuration
public class RabbitMqConfig {

    public static final String EXCHANGE_NAME = "${model.service.name}.events";

    @Bean
    public TopicExchange domainEventsExchange() {
        return new TopicExchange(EXCHANGE_NAME, true, false);
    }

    @Bean
    public MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }

    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory connectionFactory, MessageConverter messageConverter) {
        RabbitTemplate template = new RabbitTemplate(connectionFactory);
        template.setMessageConverter(messageConverter);
        return template;
    }

    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
            ConnectionFactory connectionFactory,
            MessageConverter messageConverter) {
        SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
        factory.setConnectionFactory(connectionFactory);
        factory.setMessageConverter(messageConverter);
        return factory;
    }
}`;

  return {
    path: javaPath(model, BROKER_CONFIG_PKG, 'RabbitMqConfig'),
    content: javaFile(
      subPackage(model, BROKER_CONFIG_PKG),
      [
        'com.fasterxml.jackson.databind.ObjectMapper',
        'org.springframework.amqp.core.TopicExchange',
        'org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory',
        'org.springframework.amqp.rabbit.connection.ConnectionFactory',
        'org.springframework.amqp.rabbit.core.RabbitTemplate',
        'org.springframework.amqp.support.converter.Jackson2JsonMessageConverter',
        'org.springframework.amqp.support.converter.MessageConverter',
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration'
      ],
      body
    )
  };
}

// Publisher por evento: inyecta el template del broker ELEGIDO (kafka/rabbit/sns)
// y publica el EventEnvelope. Simétrico a renderListener: cada broker tiene su
// helper de partes (imports/campos/envío); nunca se inyecta un template ajeno al
// broker del stack.
function renderPublisher(model, event) {
  const broker = model.stack.broker;
  let parts;
  if (broker === 'rabbitmq') parts = rabbitPublisherParts(model, event);
  else if (broker === 'snssqs') parts = snsPublisherParts(model, event);
  else parts = kafkaPublisherParts(model, event);

  const imports = new Set([
    'java.util.UUID',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.stereotype.Component',
    `${subPackage(model, 'domain.events')}.${event.className}`,
    ...parts.imports
  ]);

  const body = `@Component
public class ${event.publisherClass} {

    private static final Logger log = LoggerFactory.getLogger(${event.publisherClass}.class);

${parts.fields}

    public void publish(${event.className} event) {
        publish(event, UUID.randomUUID().toString());
    }

    public void publish(${event.className} event, String correlationId) {
        // TODO (agente): aplicar la reliability declarada en messaging.keel.yaml
        // (outbox / after-commit) antes de dar esta publicación por definitiva.
        EventEnvelope<${event.className}> envelope = EventEnvelope.of("${event.name}", event, correlationId);
        log.info("Publicando {} (correlationId={})", "${event.name}", correlationId);
        ${parts.send}
    }
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, event.publisherClass),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

function kafkaPublisherParts(model, event) {
  return {
    imports: ['org.springframework.kafka.core.KafkaTemplate'],
    fields: `    private static final String TOPIC = "${model.service.name}.events";

    private final KafkaTemplate<String, Object> kafkaTemplate;

    public ${event.publisherClass}(KafkaTemplate<String, Object> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }`,
    send: `kafkaTemplate.send(TOPIC, "${event.name}", envelope);`
  };
}

function rabbitPublisherParts(model, event) {
  const eventKebab = kebabCase(event.name);
  return {
    imports: [
      'org.springframework.amqp.rabbit.core.RabbitTemplate',
      `${subPackage(model, BROKER_CONFIG_PKG)}.RabbitMqConfig`
    ],
    fields: `    private static final String ROUTING_KEY = "${model.service.name}.${eventKebab}";

    private final RabbitTemplate rabbitTemplate;

    public ${event.publisherClass}(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }`,
    send: `rabbitTemplate.convertAndSend(RabbitMqConfig.EXCHANGE_NAME, ROUTING_KEY, envelope);`
  };
}

function snsPublisherParts(model, event) {
  return {
    imports: ['io.awspring.cloud.sns.core.SnsTemplate'],
    // El destino real (ARN del topic SNS) es negocio/infra: queda como hueco
    // explícito, pero el publisher inyecta el SnsTemplate correcto (no Kafka).
    fields: `    // TODO (agente): resolver el ARN/nombre real del topic SNS de destino
    //   (p. ej. desde parameters/<perfil>/snssqs.yaml vía @Value).
    private static final String TOPIC_ARN = "${model.service.name}-events";

    private final SnsTemplate snsTemplate;

    public ${event.publisherClass}(SnsTemplate snsTemplate) {
        this.snsTemplate = snsTemplate;
    }`,
    send: `snsTemplate.sendNotification(TOPIC_ARN, envelope, "${event.name}");`
  };
}

// ─── Suscripciones (consumers) ───────────────────────────────────────────────

const SUBSCRIPTIONS_PKG = 'infrastructure.messaging.subscriptions';

// Record del payload esperado del evento suscrito (contrato de la fuente).
function renderSubscriptionMessage(model, sub) {
  const imports = new Set();
  for (const field of sub.fields) for (const name of field.imports) imports.add(name);
  const components = sub.fields.map((f) => `${f.javaType} ${f.name}`).join(', ');

  const body = `/**
 * Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
 */
public record ${sub.messageRecord}(${components}) {
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.messageRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

// Listener por suscripción: enlaza el canal del broker, aplica la política
// onFailure (retry/DLQ) y deja el mapeo payload→operación (negocio) como stub.
function renderListener(model, sub) {
  const broker = model.stack.broker;
  if (broker === 'rabbitmq') return renderRabbitListener(model, sub);
  if (broker === 'snssqs') return renderSqsListener(model, sub);
  return renderKafkaListener(model, sub);
}

// Cuerpo común del método consumidor: recibe el payload tipado y despacha la
// operación 'triggers' vía mediator (mapeo payload→mensaje = // TODO agente).
function dispatchStub(sub) {
  const target = sub.triggerMessageClass
    ? `        //   mediator.dispatch(new ${sub.triggerMessageClass}(...));`
    : '        //   (declara triggers en la suscripción para saber qué operación despachar)';
  return `        // TODO (agente): mapear ${sub.messageRecord} → operación '${sub.trigger ?? '?'}' y despachar.
${target}
        throw new UnsupportedOperationException("TODO: consumir ${sub.name}");`;
}

function renderKafkaListener(model, sub) {
  const imports = new Set([
    'org.springframework.kafka.annotation.KafkaListener',
    'org.springframework.stereotype.Component',
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`
  ]);

  // Retry + DLT por listener con @RetryableTopic (mecanismo nativo de Spring
  // Kafka): reintentos con backoff del diseño y topic .DLT tras agotarlos.
  let retryable = '';
  if (sub.retry || sub.deadLetter) {
    imports.add('org.springframework.kafka.annotation.RetryableTopic');
    imports.add('org.springframework.kafka.retrytopic.DltStrategy');
    imports.add('org.springframework.retry.annotation.Backoff');
    const attempts = sub.retry?.maxAttempts ?? 3;
    const delay = sub.retry?.initialDelayMs ?? 1000;
    const multiplier = (sub.retry?.backoff ?? 'exponential') === 'exponential' ? ', multiplier = 2.0' : '';
    const dlt = sub.deadLetter ? 'DltStrategy.FAIL_ON_ERROR' : 'DltStrategy.NO_DLT';
    retryable = `    @RetryableTopic(attempts = "${attempts}", backoff = @Backoff(delay = ${delay}${multiplier}), dltStrategy = ${dlt})\n`;
  }

  const body = `@Component
public class ${sub.listenerClass} {

    private final UseCaseMediator mediator;

    public ${sub.listenerClass}(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

${retryable}    @KafkaListener(topics = "\${${sub.topicProperty}:${sub.topicDefault}}", groupId = "\${spring.application.name}")
    public void on(${sub.messageRecord} message) {
${dispatchStub(sub)}
    }
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.listenerClass),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

function renderRabbitListener(model, sub) {
  const imports = new Set([
    'org.springframework.amqp.rabbit.annotation.RabbitListener',
    'org.springframework.stereotype.Component',
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`
  ]);
  const onFailure =
    sub.retry || sub.deadLetter
      ? '    // TODO (agente): política onFailure (retry/DLQ) vía DLX/DLQ del contenedor Rabbit.\n'
      : '';
  const body = `@Component
public class ${sub.listenerClass} {

    private final UseCaseMediator mediator;

    public ${sub.listenerClass}(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

${onFailure}    @RabbitListener(queues = "\${${sub.topicProperty}:${sub.topicDefault}}")
    public void on(${sub.messageRecord} message) {
${dispatchStub(sub)}
    }
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.listenerClass),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

function renderSqsListener(model, sub) {
  const imports = new Set([
    'io.awspring.cloud.sqs.annotation.SqsListener',
    'org.springframework.stereotype.Component',
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`
  ]);
  const onFailure =
    sub.retry || sub.deadLetter
      ? '    // TODO (agente): política onFailure (redrive/DLQ) en la cola SQS.\n'
      : '';
  const body = `@Component
public class ${sub.listenerClass} {

    private final UseCaseMediator mediator;

    public ${sub.listenerClass}(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

${onFailure}    @SqsListener("\${${sub.topicProperty}:${sub.topicDefault}}")
    public void on(${sub.messageRecord} message) {
${dispatchStub(sub)}
    }
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.listenerClass),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}
