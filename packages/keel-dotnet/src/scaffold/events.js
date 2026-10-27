// Eventos de dominio (messaging.publishing.events → Domain/Events): el contrato IDomainEvent, la
// EventMetadata que el agregado estampa al emitir y un record inmutable por evento con el payload del
// diseño. El nombre del evento es contrato público; la clase añade el sufijo Event.
//
// El evento nace DENTRO del agregado (`Raise(...)`), así que metadata y contrato viven en el dominio, sin
// nada de ASP.NET Core ni del broker. El orden de los campos de EventMetadata es el del cable
// (WIRE_SHAPES.eventMetadata de keel-core): System.Text.Json escribe las propiedades de un record en el
// orden en que se declaran, y la envoltura del incremento 9 la serializa tal cual.

import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { csFile, csLocal, csMember, csString, declType, fieldUsings, located, xmlDoc } from './render.js';

/**
 * ¿Hace falta EventMetadata aunque el servicio no publique nada? Sí, si consume: la envoltura de los
 * mensajes la lleva por composición (el mismo criterio que keel-spring y keel-nest).
 */
function needsMetadata(model) {
  return (model.events ?? []).length > 0 || (model.subscriptions ?? []).length > 0;
}

// El tipo C# de cada clave de la metadata, en el orden del cable.
const METADATA_TYPES = {
  // Texto, como el String de keel-spring y el string de keel-nest: el emisor lo estampa como uuid, pero un consumidor
  // no puede exigirlo a lo que le llega (la corrida payment-checkout-stripe-dotnet: un eventId que no era uuid se
  // descartaba aquí y en los otros dos servidores se procesaba).
  eventId: 'string',
  eventType: 'string',
  eventVersion: 'int',
  occurredAt: 'DateTimeOffset',
  source: 'string',
  correlationId: 'string?',
  traceparent: 'string?'
};

export function generate(model) {
  if (!needsMetadata(model)) return [];
  const file = (name, body, usings = []) => {
    const { namespace, path } = located(model, 'events', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [file('EventMetadata', metadataBody(model))];
  if ((model.events ?? []).length === 0) return files;
  files.push(file('IDomainEvent', markerBody()));
  for (const event of model.events) {
    const usings = event.fields.flatMap((field) => fieldUsings(model, field));
    files.push(file(event.className, eventBody(event), usings));
  }
  return files;
}

function eventBody(event) {
  const params = event.fields.map((field) => `${declType(field)} ${csMember(field.name)}`);
  const ofParams = event.fields.map((field) => `${declType(field)} ${csLocal(field.name)}`).join(', ');
  const args = event.fields.map((field) => csLocal(field.name)).join(', ');
  return `${xmlDoc(event.description ?? `Evento ${event.name} del diseño.`)}public sealed record ${event.className}(
    EventMetadata Metadata${params.length > 0 ? `,\n    ${params.join(',\n    ')}` : ''}) : IDomainEvent
{
    /// <summary>Emisión desde el agregado: estampa la metadata de esta ocurrencia.</summary>
    public static ${event.className} Of(${ofParams}) =>
        new(EventMetadata.Now(${csString(event.name)})${args ? `, ${args}` : ''});
}`;
}

function markerBody() {
  return `/// <summary>
/// Un evento de dominio: algo que YA ocurrió dentro de un agregado. Los agregados lo acumulan con Raise(...)
/// y el adaptador de repositorio lo drena con PullDomainEvents() al persistir.
/// </summary>
public interface IDomainEvent
{
    EventMetadata Metadata { get; }
}`;
}

function metadataBody(model) {
  const order = WIRE_SHAPES.eventMetadata;
  const missing = order.filter((name) => !METADATA_TYPES[name]);
  if (missing.length > 0) throw new Error(`EventMetadata: el contrato del cable nombra ${missing.join(', ')} y keel-dotnet no lo emite`);
  const params = order.map((name) => `    ${METADATA_TYPES[name]} ${csMember(name)}`).join(',\n');
  return `/// <summary>
/// Metadata de un evento de dominio: id único de esta ocurrencia (clave de idempotencia de extremo a
/// extremo, por eso nunca se regenera aguas abajo), tipo lógico, versión del payload, instante en que
/// ocurrió y servicio de origen. La correlación y el contexto de traza los rellena la infraestructura de
/// publicación, que es quien conoce el contexto de la petición.
/// </summary>
/// <remarks>
/// <c>Traceparent</c> es el contexto de traza W3C del hecho: parte del contrato del evento con o sin
/// telemetría en este servicio. Sin ella viaja a null, y un consumidor que sí la tenga la continúa. El
/// orden de los parámetros es el del cable.
/// </remarks>
public sealed record EventMetadata(
${params})
{
    /// <summary>Fábrica que usa el agregado al emitir: sin correlación ni traza, que son de infraestructura.</summary>
    public static EventMetadata Now(string eventType) =>
        new(Guid.NewGuid().ToString(), eventType, 1, DateTimeOffset.UtcNow, ${csString(model.service.name)}, null, null);

    /// <summary>Copia con la correlación de la petición; conserva el EventId original.</summary>
    public EventMetadata WithCorrelationId(string? correlationId) => this with { CorrelationId = correlationId };

    /// <summary>Copia con la correlación y el contexto de traza de la petición; conserva el EventId original.</summary>
    public EventMetadata WithContext(string? correlationId, string? traceparent) =>
        this with { CorrelationId = correlationId, Traceparent = traceparent };
}`;
}
