// Mensajería del servicio: solo los contratos transversales al broker.
// Build genera EventEnvelope/EventMetadata (contrato estándar de publicación
// con eventId, timestamp UTC, correlationId y source), el PUERTO
// <Evento>Publisher (interfaz junto al record del evento en domain/events) con
// un stub transversal que permite arrancar el contexto sin broker, y el record
// del payload de cada suscripción (contrato de la fuente). La implementación
// real de publishers y listeners depende del broker elegido (keel-stack.json)
// y la escribe el agente siguiendo generators/spring/references/<broker>.md.

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
        //   elegido en keel-stack.json (ver generators/spring/references/):
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
// (generators/spring/references/<broker>.md) despachando la operación
// 'triggers' vía UseCaseMediator.
function renderSubscriptionMessage(model, sub) {
  const imports = new Set();
  for (const field of sub.fields) for (const name of field.imports) imports.add(name);
  const components = sub.fields.map((f) => `${f.javaType} ${f.name}`).join(', ');

  const body = `/**
 * Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
 * Lo consume ${sub.listenerClass} (listener del broker del stack; lo escribe
 * el agente${sub.trigger ? ` despachando la operación '${sub.trigger}'` : ''}).
 */
public record ${sub.messageRecord}(${components}) {
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.messageRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}
