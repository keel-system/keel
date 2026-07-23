// Mensajería del servicio: solo los contratos transversales al broker.
// Build genera EventEnvelope/EventMetadata (contrato estándar de PUBLICACIÓN
// con eventId, timestamp UTC, correlationId y source; al consumir solo aplica
// cuando el diseño declara envelope: keel, es decir cuando la fuente es otro
// servicio Keel), el PUERTO <Evento>Publisher (interfaz junto al record del
// evento en domain/events) con un stub transversal que permite arrancar el
// contexto sin broker, y el record del payload de cada suscripción (contrato de
// la fuente, con su envoltura propia cuando envelope: wrapped). La
// implementación real de publishers y listeners depende del broker elegido
// (keel-stack.json) y la escribe el agente siguiendo la skill
// .claude/skills/keel-spring-<broker>/.

import { javaFile, javaPath, subPackage } from './render.js';

const MESSAGING_PKG = 'infrastructure.messaging';
const EVENTS_PKG = 'domain.events';
const SUBSCRIPTIONS_PKG = 'infrastructure.messaging.subscriptions';

export function generate(model) {
  if (!model.layersPresent.messaging) return [];
  const subscriptions = model.subscriptions ?? [];
  if (model.events.length === 0 && subscriptions.length === 0) return [];

  // El envelope/metadata es el contrato de (de)serialización tanto al publicar
  // como al consumir; se genera si hay publicación o suscripción.
  const files = [renderEnvelope(model), renderMetadata(model)];
  for (const event of model.events) {
    files.push(renderPublisherPort(model, event));
    files.push(renderPublisherStub(model, event));
  }
  for (const sub of subscriptions) {
    files.push(renderSubscriptionMessage(model, sub));
    if (sub.envelopeRecord) files.push(renderSubscriptionEnvelope(model, sub));
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

// Puerto de publicación del evento: interfaz pura en domain/events. Los
// handlers dependen de este puerto, nunca del template del broker.
function renderPublisherPort(model, event) {
  const body = `/**
 * Puerto de publicación del evento ${event.name}. La implementación (broker
 * del stack) vive en infrastructure/messaging.
 */
public interface ${event.publisherClass} {

    void publish(${event.className} event);

    void publish(${event.className} event, String correlationId);
}`;
  return {
    path: javaPath(model, EVENTS_PKG, event.publisherClass),
    content: javaFile(subPackage(model, EVENTS_PKG), [], body)
  };
}

// Stub transversal del puerto: satisface la inyección para que el contexto
// arranque sin broker; el agente lo sustituye por el publisher real.
function renderPublisherStub(model, event) {
  const stubClass = `${event.publisherClass}Stub`;
  const body = `@Component
public class ${stubClass} implements ${event.publisherClass} {

    @Override
    public void publish(${event.className} event) {
        publish(event, UUID.randomUUID().toString());
    }

    @Override
    public void publish(${event.className} event, String correlationId) {
        // TODO (agente): sustituir este stub por el publisher real del broker
        //   elegido en keel-stack.json (skill .claude/skills/keel-spring-<broker>/):
        //   envolver con EventEnvelope.of("${event.name}", event, correlationId),
        //   publicar en el canal declarado y aplicar la reliability del diseño
        //   (outbox / after-commit).
        throw new UnsupportedOperationException("TODO (agente): publicar ${event.name} con el broker del stack");
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, stubClass),
    content: javaFile(subPackage(model, MESSAGING_PKG), [
      'java.util.UUID',
      'org.springframework.stereotype.Component',
      `${subPackage(model, EVENTS_PKG)}.${event.className}`,
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
