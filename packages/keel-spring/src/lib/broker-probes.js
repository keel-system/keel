// Los comandos con los que se habla con cada broker, en su versión JAVA.
//
// La fuente única de los comandos, los cuerpos de petición y la política de lectura es neutral
// y vive en keel-core/gen/broker-probes.js: la comparten todos los generadores, y el runner de
// conformidad (`scripts/broker-check.js`) ejecuta exactamente lo que de ahí se renderiza. Aquí
// solo queda cómo se escribe eso en el arnés Java: los literales, los cuerpos con expresiones
// intercaladas y los predicados como expresión sobre una lectura.

import { renderParts, spliceBody, hole, rabbitProbeBody, rabbitPublishBody } from 'keel-core/gen/broker-probes';

export * from 'keel-core/gen/broker-probes';

/** `["kcat", "-C", …]` → `"kcat", "-C", …`, con las expresiones sin comillas. */
export function javaArgs(parts) {
  return renderParts(parts, javaString);
}

/**
 * El colapso a una línea, como EXPRESIÓN Java, para el arnés generado: la cadena Java que se
 * emite es el patrón que casa el retorno de carro y el salto de línea.
 */
export function collapseToSingleLineJava(expression) {
  return `${expression}.replaceAll("[\\r\\n]+", " ")`;
}

export function rabbitProbeBodyJava(countExpr = 'count') {
  return spliceBody(rabbitProbeBody(hole(0)), [countExpr], javaString);
}

export function rabbitPublishBodyJava({ key, headers, routingKey, payload }) {
  return spliceBody(
    rabbitPublishBody({ key: hole(0), headersJson: hole(1), routingKey: hole(2), payloadBase64: hole(3) }),
    [key, headers, routingKey, payload],
    javaString
  );
}

/** El predicado de «no hay mensajes», como expresión Java sobre una lectura. */
export function emptyReadJava(broker, read) {
  if (broker === 'rabbitmq') return `${read}.trim().equals("[]")`;
  if (broker === 'snssqs') return `!${read}.contains("\\"Messages\\"")`;
  return `${read}.isBlank()`;
}

function javaString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
