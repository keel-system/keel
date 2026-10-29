// Eventos de dominio (messaging.publishing.events): el contrato `Event`, la `EventMetadata` que el agregado
// estampa al emitir y un struct por evento con el payload del diseño. El nombre del evento es contrato público;
// el tipo añade el sufijo Event, como en los otros tres.
//
// El evento nace DENTRO del agregado (`raise(...)`), así que metadata y contrato viven en el dominio, sin nada
// del broker. El orden de los campos de EventMetadata es el del cable (WIRE_SHAPES.eventMetadata de keel-core):
// encoding/json escribe los campos de un struct en el orden en que se declaran, y la envoltura del incremento 9
// la serializa tal cual.

import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';
import { declType, docComment, domainPath, fieldImports, layout, localName, packageFile } from './render.js';

/**
 * ¿Hace falta EventMetadata aunque el servicio no publique nada? Sí, si consume: la envoltura de los mensajes la
 * lleva por composición (el mismo criterio que los otros tres).
 */
function needsMetadata(model) {
  return (model.events ?? []).length > 0 || (model.subscriptions ?? []).length > 0;
}

// El tipo Go de cada clave de la metadata, en el orden del cable.
const METADATA_TYPES = {
  // Texto, como el String de keel-spring: el emisor lo estampa como uuid, pero un consumidor no puede exigirlo a lo
  // que le llega (la corrida payment-checkout-stripe-dotnet: un eventId que no era uuid se descartaba en un servidor
  // y en los otros se procesaba).
  eventId: 'string',
  eventType: 'string',
  eventVersion: 'int32',
  occurredAt: 'time.Time',
  source: 'string',
  correlationId: '*string',
  traceparent: '*string'
};

export function generate(model) {
  if (!needsMetadata(model)) return [];
  const { domain } = layout(model);
  const file = (name, body, imports) => ({ path: domainPath(model, name), content: packageFile(model, domain, { imports, body }) });
  const files = [file('event_metadata', metadataBody(model), ['time', 'github.com/google/uuid'])];
  if ((model.events ?? []).length === 0) return files;
  files.push(file('event', markerBody(), []));
  for (const event of model.events) files.push(file(event.className, eventBody(event), event.fields.flatMap(fieldImports)));
  return files;
}

function eventBody(event) {
  const name = event.className;
  const fields = event.fields.map((field) => ({ field, member: goExported(field.name), local: localName(field.name) }));
  const struct = alignRows([
    { indent: '\t', cells: ['Metadata', 'EventMetadata', '`json:"metadata"`'] },
    ...fields.map(({ field, member }) => ({ indent: '\t', cells: [member, declType(field), `\`json:"${field.wireName ?? field.name}"\``] }))
  ]);
  const params = fields.map(({ field, local }) => `${local} ${declType(field)}`).join(', ');
  const literal = keyedLiteral([['Metadata', `NewEventMetadata(${goString(event.name)})`], ...fields.map(({ member, local }) => [member, local])], '\t\t');
  return `
${docComment(name, event.description, `evento ${event.name} del diseño`)}type ${name} struct {
${struct.join('\n')}
}

// New${name} es la emisión desde el agregado: estampa la metadata de esta ocurrencia.
func New${name}(${params}) ${name} {
	return ${name}{
${literal.join('\n')}
	}
}

// EventMetadata es la metadata de esta ocurrencia.
func (e ${name}) EventMetadata() EventMetadata {
	return e.Metadata
}
`;
}

function markerBody() {
  return `
// Event es un evento de dominio: algo que YA ocurrió dentro de un agregado. Los agregados lo acumulan con raise y
// el adaptador de repositorio lo drena con PullEvents al persistir.
type Event interface {
	EventMetadata() EventMetadata
}
`;
}

function metadataBody(model) {
  const order = WIRE_SHAPES.eventMetadata;
  const missing = order.filter((name) => !METADATA_TYPES[name]);
  if (missing.length > 0) throw new Error(`EventMetadata: el contrato del cable nombra ${missing.join(', ')} y keel-go no lo emite`);
  const struct = alignRows(order.map((name) => ({ indent: '\t', cells: [goExported(name), METADATA_TYPES[name], `\`json:"${name}"\``] })));
  const now = keyedLiteral(
    [
      ['EventID', 'uuid.NewString()'],
      ['EventType', 'eventType'],
      ['EventVersion', '1'],
      ['OccurredAt', 'time.Now().UTC()'],
      ['Source', goString(model.service.name)]
    ],
    '\t\t'
  );
  return `
// EventMetadata es la metadata de un evento de dominio: id único de esta ocurrencia (clave de idempotencia de
// extremo a extremo, por eso nunca se regenera aguas abajo), tipo lógico, versión del payload, instante en que
// ocurrió y servicio de origen. La correlación y el contexto de traza los rellena la infraestructura de
// publicación, que es quien conoce el contexto de la petición.
//
// Traceparent es el contexto de traza W3C del hecho: parte del contrato del evento con o sin telemetría en este
// servicio. Sin ella viaja a null, y un consumidor que sí la tenga la continúa. El orden de los campos es el del
// cable.
type EventMetadata struct {
${struct.join('\n')}
}

// NewEventMetadata es la metadata de una ocurrencia nueva, la que usa el agregado al emitir: sin correlación ni
// traza, que son de infraestructura.
func NewEventMetadata(eventType string) EventMetadata {
	return EventMetadata{
${now.join('\n')}
	}
}

// WithCorrelationID es una copia con la correlación de la petición; conserva el EventID original.
func (m EventMetadata) WithCorrelationID(correlationID *string) EventMetadata {
	m.CorrelationID = correlationID
	return m
}

// WithContext es una copia con la correlación y el contexto de traza de la petición; conserva el EventID original.
func (m EventMetadata) WithContext(correlationID, traceparent *string) EventMetadata {
	m.CorrelationID = correlationID
	m.Traceparent = traceparent
	return m
}
`;
}
