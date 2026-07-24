// Mensajería del servicio: solo los contratos transversales al broker.
// Build genera la EventEnvelope (envoltura de wire que reutiliza la
// EventMetadata que el agregado estampó al emitir: el eventId es la clave de
// idempotencia y no se regenera), por evento el record de integración
// <Evento>IntegrationEvent (gemelo de wire, desacoplado del dominio) y el
// PUERTO <Evento>Publisher (interfaz junto al record del evento en
// domain/events), y el bridge <Servicio>DomainEventBridge que traduce cada
// evento de dominio a su evento de integración y lo entrega según la
// reliability declarada (outbox transaccional o envío tras commit). También el
// record del payload de cada suscripción (contrato de la fuente, con su
// envoltura propia cuando envelope: wrapped).
//
// Lo único que depende del broker elegido (keel-stack.json) es el ENVÍO: la
// implementación de OutboxDispatcher (modo outbox) o de <Evento>Publisher
// (best-effort) y los listeners, que escribe el agente siguiendo la skill
// .claude/skills/keel-spring-<broker>/.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainTypeImport } from './entities.js';
import { usesOutbox } from './outbox.js';
import { correlationImport } from './correlation.js';

const MESSAGING_PKG = 'infrastructure.messaging';
const INTEGRATION_PKG = 'infrastructure.messaging.events';
const EVENTS_PKG = 'domain.events';
const SUBSCRIPTIONS_PKG = 'infrastructure.messaging.subscriptions';

export function generate(model) {
  if (!model.layersPresent.messaging) return [];
  const subscriptions = model.subscriptions ?? [];
  if (model.events.length === 0 && subscriptions.length === 0) return [];

  // El envelope es el contrato de (de)serialización tanto al publicar como al
  // consumir; se genera si hay publicación o suscripción.
  const files = [renderEnvelope(model)];
  const outbox = usesOutbox(model);
  for (const event of model.events) {
    files.push(renderIntegrationEvent(model, event));
    if (!outbox) {
      files.push(renderPublisherPort(model, event));
      files.push(renderPublisherStub(model, event));
    }
  }
  if (model.events.length > 0) files.push(renderBridge(model, outbox));
  for (const sub of subscriptions) {
    files.push(renderSubscriptionMessage(model, sub));
    if (sub.envelopeRecord) files.push(renderSubscriptionEnvelope(model, sub));
  }
  return files;
}

function renderEnvelope(model) {
  const body = `/**
 * Envoltura estándar de los eventos publicados: metadata + payload.
 *
 * La metadata es la MISMA que el agregado estampó al emitir el evento de
 * dominio (ver domain/events/EventMetadata): conserva el eventId, que es la
 * clave de idempotencia del consumidor. Aquí solo se le añade la correlación
 * del request, que el dominio no conoce.
 */
public record EventEnvelope<T>(EventMetadata metadata, T data) {

    public static <T> EventEnvelope<T> of(EventMetadata metadata, T data, String correlationId) {
        return new EventEnvelope<>(metadata.withCorrelationId(correlationId), data);
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, 'EventEnvelope'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [`${subPackage(model, EVENTS_PKG)}.EventMetadata`], body)
  };
}

// Gemelo de wire del evento de dominio: lo que sale del servicio. Existe para
// que un cambio de serialización o de broker nunca obligue a tocar el dominio.
function renderIntegrationEvent(model, event) {
  const imports = new Set([
    `${subPackage(model, EVENTS_PKG)}.EventMetadata`,
    'com.fasterxml.jackson.annotation.JsonIgnore'
  ]);
  const components = event.fields.map((field) => {
    for (const name of field.imports) imports.add(name);
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
    return `${field.javaType} ${field.name}`;
  });
  const payloadParams = components.join(', ');

  const body = `/**
 * Evento de integración ${event.name}: proyección de wire del evento de dominio
 * ${event.className}${event.channel ? `, publicado en el canal '${event.channel}'` : ''}.
 *
 * Deliberadamente desacoplado del dominio: cambiar el broker o el formato de
 * serialización no debe alcanzar a domain/events.
 *
 * La metadata se conserva como componente (el bridge la necesita para construir
 * la EventEnvelope) pero NO se serializa: la metadata autoritativa del mensaje
 * es la del envelope, y duplicarla en 'data' confundiría al consumidor.
 */
public record ${event.integrationClass}(@JsonIgnore EventMetadata metadata${payloadParams ? `, ${payloadParams}` : ''}) {
}`;
  return {
    path: javaPath(model, INTEGRATION_PKG, event.integrationClass),
    content: javaFile(subPackage(model, INTEGRATION_PKG), [...imports], body)
  };
}

// Bridge domain → integración. Escucha lo que el adaptador de repositorio
// publicó al drenar el agregado y entrega según la reliability del diseño:
//   outbox      → @EventListener síncrono, DENTRO de la transacción del cambio
//                 (la fila y el cambio confirman o revierten juntos).
//   best-effort → @TransactionalEventListener(AFTER_COMMIT): nunca se publica
//                 un evento de una transacción que revirtió.
function renderBridge(model, outbox) {
  const imports = new Set([
    correlationImport(model),
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.stereotype.Component'
    // EventEnvelope vive en este mismo paquete: no se importa.
  ]);
  for (const event of model.events) {
    imports.add(`${subPackage(model, EVENTS_PKG)}.${event.className}`);
    imports.add(`${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`);
  }

  const fields = [];
  const ctorParams = [];
  const ctorAssigns = [];

  if (outbox) {
    imports.add('org.springframework.context.event.EventListener');
    imports.add('com.fasterxml.jackson.core.JsonProcessingException');
    imports.add('com.fasterxml.jackson.databind.ObjectMapper');
    imports.add(`${subPackage(model, 'infrastructure.messaging.outbox')}.OutboxEventJpa`);
    imports.add(`${subPackage(model, 'infrastructure.messaging.outbox')}.OutboxEventJpaRepository`);
    imports.add('java.time.Instant');
    imports.add('java.util.UUID');
    fields.push(
      '    private final OutboxEventJpaRepository outboxRepository;',
      '    private final ObjectMapper objectMapper;'
    );
    ctorParams.push('OutboxEventJpaRepository outboxRepository', 'ObjectMapper objectMapper');
    ctorAssigns.push('        this.outboxRepository = outboxRepository;', '        this.objectMapper = objectMapper;');
  } else {
    imports.add('org.springframework.transaction.event.TransactionalEventListener');
    imports.add('org.springframework.transaction.event.TransactionPhase');
    for (const event of model.events) {
      imports.add(`${subPackage(model, EVENTS_PKG)}.${event.publisherClass}`);
      const field = publisherField(event);
      fields.push(`    private final ${event.publisherClass} ${field};`);
      ctorParams.push(`${event.publisherClass} ${field}`);
      ctorAssigns.push(`        this.${field} = ${field};`);
    }
  }

  const destinationField = model.events[0]
    ? `    @Value("\${${model.events[0].destinationProperty}:${model.events[0].destinationDefault}}")\n    private String destination;`
    : '';
  const routingFields = model.events
    .map(
      (event) =>
        `    @Value("\${${event.routingKeyProperty}:${event.routingKeyDefault}}")\n    private String ${routingField(event)};`
    )
    .join('\n\n');

  const methods = model.events.map((event) => renderBridgeMethod(event, outbox)).join('\n\n');

  const body = `/**
 * ${model.service.className}DomainEventBridge — traduce cada evento de dominio a su evento de
 * integración y lo entrega ${
   outbox
     ? 'al outbox DENTRO de la transacción que provocó el cambio: la fila y el\n * cambio del agregado confirman o revierten juntos (reliability: outbox).'
     : 'tras confirmar la transacción (reliability: best-effort): un rollback\n * no publica nada, pero un fallo del broker sí pierde el evento.'
 }
 *
 * Los eventos llegan aquí porque el adaptador de repositorio drena
 * pullDomainEvents() al persistir el agregado. Nadie más publica eventos.
 */
@Component
public class ${model.service.className}DomainEventBridge {

${[destinationField, routingFields].filter(Boolean).join('\n\n')}

${fields.join('\n')}

    public ${model.service.className}DomainEventBridge(${ctorParams.join(', ')}) {
${ctorAssigns.join('\n')}
    }

${methods}${outbox ? `\n\n${renderOutboxAppend(model)}` : ''}
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, `${model.service.className}DomainEventBridge`),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

function renderBridgeMethod(event, outbox) {
  const args = event.fields.map((f) => `event.${f.name}()`).join(', ');
  const listener = outbox ? '@EventListener' : '@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)';
  const delivery = outbox
    ? `        append(${routingField(event)}, "${event.integrationClass}", envelope);`
    : `        ${publisherField(event)}.publish(integrationEvent, correlationId);`;

  return `    /** ${event.name}: evento de dominio → evento de integración. */
    ${listener}
    public void on${event.className}(${event.className} event) {
        String correlationId = CorrelationContext.get();
        ${event.integrationClass} integrationEvent = new ${event.integrationClass}(event.metadata()${args ? `, ${args}` : ''});
        EventEnvelope<${event.integrationClass}> envelope = EventEnvelope.of(event.metadata(), integrationEvent, correlationId);
${delivery}
    }`;
}

// Escritura de la fila del outbox: misma transacción que el cambio del agregado.
function renderOutboxAppend(model) {
  return `    private void append(String routingKey, String eventType, EventEnvelope<?> envelope) {
        try {
            outboxRepository.save(new OutboxEventJpa(
                    UUID.randomUUID(),
                    destination,
                    routingKey,
                    eventType,
                    objectMapper.writeValueAsString(envelope),
                    Instant.now(),
                    null,
                    0,
                    null,
                    null));
        } catch (JsonProcessingException ex) {
            // Serializar un evento propio no puede fallar: si falla, el diseño
            // del payload está roto y la transacción debe revertir.
            throw new IllegalStateException("No se pudo serializar el evento " + eventType, ex);
        }
    }`;
}

function publisherField(event) {
  return event.publisherClass[0].toLowerCase() + event.publisherClass.slice(1);
}

function routingField(event) {
  return `${event.className[0].toLowerCase()}${event.className.slice(1).replace(/Event$/, '')}RoutingKey`;
}

// Puerto de publicación del evento: interfaz pura en domain/events. Solo existe
// en modo best-effort; con outbox la entrega la hace el relay vía OutboxDispatcher.
function renderPublisherPort(model, event) {
  const body = `/**
 * Puerto de publicación del evento de integración ${event.name}. La
 * implementación (broker del stack) vive en infrastructure/messaging y la
 * escribe el agente; el único que lo invoca es el bridge de eventos.
 */
public interface ${event.publisherClass} {

    void publish(${event.integrationClass} event, String correlationId);
}`;
  return {
    path: javaPath(model, EVENTS_PKG, event.publisherClass),
    content: javaFile(subPackage(model, EVENTS_PKG), [`${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`], body)
  };
}

// Stub transversal del puerto: satisface la inyección para que el contexto
// arranque sin broker; el agente lo sustituye por el publisher real.
function renderPublisherStub(model, event) {
  const stubClass = `${event.publisherClass}Stub`;
  const body = `@Component
public class ${stubClass} implements ${event.publisherClass} {

    private static final Logger log = LoggerFactory.getLogger(${stubClass}.class);

    @Override
    public void publish(${event.integrationClass} event, String correlationId) {
        // TODO (agente): sustituir este stub por el publisher real del broker
        //   elegido en keel-stack.json (skill .claude/skills/keel-spring-<broker>/):
        //   envolver con EventEnvelope.of(event.metadata(), event, correlationId)
        //   y publicar en el destino/routing key declarados. Mientras tanto solo
        //   se traza, para que el contexto arranque sin broker.
        log.warn("Publisher no implementado: {} no salió del servicio (correlationId={})", "${event.name}", correlationId);
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, stubClass),
    content: javaFile(subPackage(model, MESSAGING_PKG), [
      'org.slf4j.Logger',
      'org.slf4j.LoggerFactory',
      'org.springframework.stereotype.Component',
      `${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`,
      `${subPackage(model, EVENTS_PKG)}.${event.publisherClass}`
    ], body)
  };
}

// Record del payload esperado del evento suscrito (contrato de la fuente).
// El listener que lo consume depende del broker: lo escribe el agente
// (skill .claude/skills/keel-spring-<broker>/) despachando la operación
// 'triggers' vía UseCaseMediator.
function renderSubscriptionMessage(model, sub) {
  const imports = new Set();
  for (const field of sub.fields) for (const name of field.imports) imports.add(name);
  // wireName: la fuente externa nombra el campo distinto que el diseño.
  const components = sub.fields
    .map((f) => {
      if (!f.wireName) return `${f.javaType} ${f.name}`;
      imports.add('com.fasterxml.jackson.annotation.JsonProperty');
      return `@JsonProperty("${f.wireName}") ${f.javaType} ${f.name}`;
    })
    .join(', ');

  const annotations = [];
  if (sub.unknownFields !== 'fail') {
    imports.add('com.fasterxml.jackson.annotation.JsonIgnoreProperties');
    annotations.push('@JsonIgnoreProperties(ignoreUnknown = true)');
  }

  const body = `/**
 * Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
${contractJavadoc(sub)} */
${annotations.map((a) => `${a}\n`).join('')}public record ${sub.messageRecord}(${components}) {
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.messageRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

// Envoltura propia de la fuente (envelope: wrapped): el payload cuelga de
// payloadPath, no de la EventEnvelope de Keel.
function renderSubscriptionEnvelope(model, sub) {
  const imports = new Set(['com.fasterxml.jackson.annotation.JsonIgnoreProperties']);
  const components = [];
  const path = sub.payloadPath.split('.');
  if (path.length > 1) {
    // Payload anidado: el agente completa los niveles intermedios.
    components.push(`Object ${path[0]}`);
  } else {
    components.push(`${sub.messageRecord} ${path[0]}`);
  }
  if (sub.discriminator?.location === 'field' && !sub.discriminator.name.includes('.')) {
    components.push(`String ${sub.discriminator.name}`);
  }
  if (sub.messageId?.location === 'field' && !sub.messageId.name.includes('.')) {
    components.push(`String ${sub.messageId.name}`);
  }

  const body = `/**
 * Envoltura con la que ${sub.source ?? 'la fuente'} publica ${sub.name}: el
 * payload cuelga de '${sub.payloadPath}'.
${path.length > 1 ? ` * TODO (agente): tipar los niveles intermedios de '${sub.payloadPath}' hasta ${sub.messageRecord}.\n` : ''} */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ${sub.envelopeRecord}(${components.join(', ')}) {
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.envelopeRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

// El contrato de recepción, escrito donde el agente lo va a leer al escribir el listener.
function contractJavadoc(sub) {
  const lines = [];
  if (sub.envelope === 'wrapped') {
    lines.push(`Llega envuelto en ${sub.envelopeRecord}; el payload cuelga de '${sub.payloadPath}'.`);
  } else if (sub.envelope === 'keel') {
    lines.push('Llega en la EventEnvelope estándar de Keel (metadata + data).');
  } else {
    lines.push('Llega plano: el mensaje es este payload.');
  }
  if (sub.format !== 'json') {
    lines.push(`Formato: ${sub.format}${sub.schemaRef ? ` (schema '${sub.schemaRef}')` : ''}.`);
  }
  if (sub.discriminator) {
    lines.push(
      `Se reconoce por ${sub.discriminator.location} '${sub.discriminator.name}' == '${sub.discriminator.value}': el canal transporta más tipos, descarta el resto.`
    );
  }
  if (sub.messageId) {
    lines.push(
      `Deduplica por ${sub.messageId.location} '${sub.messageId.name}' antes de despachar (la entrega es at-least-once).`
    );
  }
  if (sub.trigger) {
    const args = sub.triggerArguments
      .map((a) => `${a.component} = ${a.source ? `payload.${a.source}()` : 'TODO (agente)'}`)
      .join(', ');
    lines.push(
      `Lo consume ${sub.listenerClass} (listener del broker del stack; lo escribe el agente) despachando ${sub.triggerMessageClass ?? sub.trigger}${args ? `(${args})` : ''} vía UseCaseMediator.`
    );
  } else {
    lines.push(`Lo consume ${sub.listenerClass} (listener del broker del stack; lo escribe el agente).`);
  }
  return lines.map((line) => ` * ${line}\n`).join('');
}
