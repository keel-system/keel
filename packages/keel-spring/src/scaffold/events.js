// Eventos de dominio (messaging.publishing.events → domain/events): el marker
// DomainEvent, la EventMetadata que el agregado estampa al emitir y un record
// inmutable por evento con el payload del diseño. El nombre del evento es
// contrato público; el record añade el sufijo Event.
//
// El evento nace DENTRO del agregado (raise(...), ver conventions/domain-modeling.md):
// por eso metadata y marker viven en domain, sin nada de Spring ni del broker.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { domainTypeImport } from './entities.js';

const EVENTS_PKG = 'domain.events';

export function generate(model) {
  if (model.events.length === 0) return [];

  const files = [renderMarker(model), renderMetadata(model)];

  for (const event of model.events) {
    const imports = new Set();
    const components = event.fields.map((field) => {
      for (const name of field.imports) imports.add(name);
      const typeImport = domainTypeImport(model, field);
      if (typeImport) imports.add(typeImport);
      return `${field.javaType} ${field.name}`;
    });

    const payloadParams = components.join(', ');
    const payloadArgs = event.fields.map((f) => f.name).join(', ');
    const body = `${javadoc(event.description ?? `Evento ${event.name} del diseño.`)}public record ${event.className}(EventMetadata metadata${payloadParams ? `, ${payloadParams}` : ''}) implements DomainEvent {

    /** Emisión desde el agregado: estampa la metadata de esta ocurrencia. */
    public static ${event.className} of(${payloadParams}) {
        return new ${event.className}(EventMetadata.now("${event.name}")${payloadArgs ? `, ${payloadArgs}` : ''});
    }
}`;

    files.push({
      path: javaPath(model, EVENTS_PKG, event.className),
      content: javaFile(subPackage(model, EVENTS_PKG), [...imports], body)
    });
  }

  return files;
}

// Marker de los eventos de dominio: lo que el agregado acumula y el adaptador
// de repositorio drena. Sin él no hay tipo común para pullDomainEvents().
function renderMarker(model) {
  const body = `/**
 * Marca de evento de dominio: algo que YA ocurrió dentro de un agregado.
 * Los agregados lo acumulan con raise(...) y el adaptador de repositorio lo
 * drena con pullDomainEvents() al persistir.
 */
public interface DomainEvent {

    EventMetadata metadata();
}`;
  return {
    path: javaPath(model, EVENTS_PKG, 'DomainEvent'),
    content: javaFile(subPackage(model, EVENTS_PKG), [], body)
  };
}

// Metadata estampada en el momento del raise: es la MISMA que viaja al wire
// dentro de la EventEnvelope (el eventId es la clave de idempotencia extremo a
// extremo, por eso nunca se regenera aguas abajo).
function renderMetadata(model) {
  const body = `/**
 * Metadata de un evento de dominio: id único de esta ocurrencia (clave de
 * idempotencia), tipo lógico, versión del payload, instante en que ocurrió y
 * servicio de origen. La correlación la rellena la infraestructura de
 * publicación, que es quien conoce el contexto de la petición.
 */
public record EventMetadata(
        String eventId,
        String eventType,
        int eventVersion,
        Instant occurredAt,
        String source,
        String correlationId) {

    /** Fábrica que usa el agregado al emitir: sin correlación, que es de infraestructura. */
    public static EventMetadata now(String eventType) {
        return new EventMetadata(
                UUID.randomUUID().toString(),
                eventType,
                1,
                Instant.now(),
                "${model.service.name}",
                null);
    }

    /** Copia con la correlación del request; conserva el eventId original. */
    public EventMetadata withCorrelationId(String correlationId) {
        return new EventMetadata(eventId, eventType, eventVersion, occurredAt, source, correlationId);
    }
}`;
  return {
    path: javaPath(model, EVENTS_PKG, 'EventMetadata'),
    content: javaFile(subPackage(model, EVENTS_PKG), ['java.time.Instant', 'java.util.UUID'], body)
  };
}
