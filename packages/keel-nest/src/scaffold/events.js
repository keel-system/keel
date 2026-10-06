// Eventos de dominio (messaging.publishing.events → domain/events): el contrato DomainEvent, la
// EventMetadata que el agregado estampa al emitir y una clase inmutable por evento con el payload del
// diseño. El nombre del evento es contrato público; la clase añade el sufijo Event.
//
// El evento nace DENTRO del agregado (`raise(...)`), así que metadata y contrato viven en el
// dominio, sin nada de Nest ni del broker. El orden de los campos de EventMetadata es el del cable
// (WIRE_SHAPES.eventMetadata de keel-core): la envoltura del incremento 9 la serializa tal cual.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { DIRS, classPath, declType, fieldImports, tsModule, tsdoc, tsString } from './render.js';

export const DOMAIN_EVENT_TS = classPath(DIRS.events, 'DomainEvent');
export const EVENT_METADATA_TS = classPath(DIRS.events, 'EventMetadata');

/**
 * ¿Hace falta EventMetadata aunque el servicio no publique nada? Sí, si consume: la envoltura de
 * los mensajes la lleva por composición (mismo criterio que keel-spring).
 */
function needsMetadata(model) {
  return (model.events ?? []).length > 0 || (model.subscriptions ?? []).length > 0;
}

export function generate(model) {
  if (!needsMetadata(model)) return [];
  const files = [{ path: EVENT_METADATA_TS, content: tsModule(EVENT_METADATA_TS, [{ symbol: 'randomUUID', from: 'node:crypto' }], metadataBody(model)) }];
  if ((model.events ?? []).length === 0) return files;
  files.push({ path: DOMAIN_EVENT_TS, content: tsModule(DOMAIN_EVENT_TS, [{ symbol: 'EventMetadata', from: EVENT_METADATA_TS, type: true }], markerBody()) });

  for (const event of model.events) {
    const file = classPath(DIRS.events, event.className);
    const imports = [
      { symbol: 'DomainEvent', from: DOMAIN_EVENT_TS, type: true },
      { symbol: 'EventMetadata', from: EVENT_METADATA_TS }
    ];
    for (const field of event.fields) imports.push(...fieldImports(model, field));
    const params = event.fields.map((field) => `readonly ${field.name}: ${declType(field)}`);
    const ofParams = event.fields.map((field) => `${field.name}: ${declType(field)}`).join(', ');
    const args = event.fields.map((field) => field.name).join(', ');
    const body = `${tsdoc(event.description ?? `Evento ${event.name} del diseño.`)}export class ${event.className} implements DomainEvent {
  constructor(
    readonly metadata: EventMetadata${params.length > 0 ? `,\n    ${params.join(',\n    ')}` : ''}
  ) {}

  /** Emisión desde el agregado: estampa la metadata de esta ocurrencia. */
  static of(${ofParams}): ${event.className} {
    return new ${event.className}(EventMetadata.now(${tsString(event.name)})${args ? `, ${args}` : ''});
  }
}`;
    files.push({ path: file, content: tsModule(file, imports, body) });
  }
  return files;
}

function markerBody() {
  return `/**
 * Un evento de dominio: algo que YA ocurrió dentro de un agregado. Los agregados lo acumulan con
 * raise(...) y el adaptador de repositorio lo drena con pullDomainEvents() al persistir.
 */
export interface DomainEvent {
  readonly metadata: EventMetadata;
}`;
}

function metadataBody(model) {
  const fields = {
    eventId: 'string',
    eventType: 'string',
    eventVersion: 'number',
    occurredAt: 'Date',
    source: 'string',
    correlationId: 'string | null',
    traceparent: 'string | null'
  };
  const order = WIRE_SHAPES.eventMetadata;
  const missing = order.filter((name) => !fields[name]);
  if (missing.length > 0) throw new Error(`EventMetadata: el contrato del cable nombra ${missing.join(', ')} y keel-nest no lo emite`);
  const params = order.map((name) => `    readonly ${name}: ${fields[name]}`).join(',\n');
  return `/**
 * Metadata de un evento de dominio: id único de esta ocurrencia (clave de idempotencia de extremo a
 * extremo, por eso nunca se regenera aguas abajo), tipo lógico, versión del payload, instante en que
 * ocurrió y servicio de origen. La correlación y el contexto de traza los rellena la infraestructura
 * de publicación, que es quien conoce el contexto de la petición.
 *
 * \`traceparent\` es el contexto de traza W3C del hecho: parte del contrato del evento con o sin
 * telemetría en este servicio. Sin ella viaja a null, y un consumidor que sí la tenga la continúa.
 *
 * El orden de los campos es el del cable.
 */
export class EventMetadata {
  constructor(
${params}
  ) {}

  /** Fábrica que usa el agregado al emitir: sin correlación ni traza, que son de infraestructura. */
  static now(eventType: string): EventMetadata {
    return new EventMetadata(randomUUID(), eventType, 1, new Date(), ${tsString(model.service.name)}, null, null);
  }

  /** Copia con la correlación de la petición; conserva el eventId original. */
  withCorrelationId(correlationId: string | null): EventMetadata {
    return this.withContext(correlationId, this.traceparent);
  }

  /** Copia con la correlación y el contexto de traza de la petición; conserva el eventId original. */
  withContext(correlationId: string | null, traceparent: string | null): EventMetadata {
    return new EventMetadata(this.eventId, this.eventType, this.eventVersion, this.occurredAt, this.source, correlationId, traceparent);
  }
}`;
}
