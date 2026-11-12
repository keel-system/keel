// Los datos personales del servicio (DSL 2.28, `personal`), como decisiones neutrales: qué campos son, qué vacía una
// anonimización y el inventario que el proyecto generado lleva en `docs/keel/personal-data.md`, el mismo byte a byte en
// los cuatro generadores. Es lo que un auditor lee para saber qué datos personales guarda el servicio, cuánto viven y
// qué garantiza el servidor sobre ellos, sin leer el código (D10 de PLAN-DSL-228-CICLO-DE-VIDA.md).

import { lifecycleRoots, personalFields, ANONYMOUS_PREFIX } from './data-lifecycle.js';

/** Ruta del inventario en el proyecto generado. */
export const PERSONAL_DATA_FILE = 'docs/keel/personal-data.md';

/** ¿Guarda el servicio algún dato personal? Sin ninguno no hay inventario que escribir. */
export function usesPersonalData(model) {
  return personalFields(model).length > 0;
}

/**
 * Los nombres de los campos personales de todas las entidades, sin repetir y ordenados: lo que el gate de logs del
 * agente veta como accesor dentro de una llamada de log (PD-1). Por nombre, como el resto de ese gate: grep no ve tipos.
 */
export function personalFieldNames(model) {
  return [...new Set(personalFields(model).flatMap((entry) => entry.fields))].sort();
}

function keepText(span) {
  if (span.days) return `${span.days} días`;
  if (span.years) return `${span.years} años`;
  return `el valor del parámetro \`${span.parameter}\` (${span.unit === 'years' ? 'años' : 'días'})`;
}

/** El inventario de datos personales, en markdown. Determinista: el mismo modelo da el mismo texto. */
export function personalDataInventory(model) {
  const personal = personalFields(model);
  if (personal.length === 0) return null;
  const roots = new Map(lifecycleRoots(model).map((root) => [root.entity, root]));
  const rootOf = (entityName) => model.entities.find((entity) => entity.name === entityName)?.aggregateRoot ?? entityName;
  const lines = [
    `# Datos personales de ${model.service?.name ?? 'el servicio'}`,
    '',
    'Generado desde el diseño (`personal`, `deletion` y `retention`, DSL 2.28). No se edita: cambia el diseño y vuelve a generar.',
    '',
    '| Entidad | Campo | Obligatorio | Borrado | Retención |',
    '|---|---|---|---|---|'
  ];
  for (const { entity, fields } of personal) {
    const modelEntity = model.entities.find((candidate) => candidate.name === entity);
    const root = roots.get(rootOf(entity));
    const deletion = root?.logical ? 'lógico' : 'físico';
    const retention = root?.retention
      ? `${keepText(root.retention.span)} desde ${root.retention.fromDeleted ? 'el borrado' : `\`${root.retention.from}\``}, y después ${root.retention.then === 'delete' ? 'se borra' : 'se anonimiza'}`
      : 'sin retención declarada';
    for (const field of fields) {
      const required = modelEntity?.fields.find((candidate) => candidate.name === field)?.required ? 'sí' : 'no';
      lines.push(`| ${entity} | ${field} | ${required} | ${deletion} | ${retention} |`);
    }
  }
  lines.push(
    '',
    '## Lo que garantiza el servidor',
    '',
    '- Ningún log ni traza que escribe el servidor lleva el valor de un campo de esta tabla, tampoco el mensaje del motor al violar una unicidad. El gate `check-logging` impide que lo haga el código escrito a mano.',
    `- Al anonimizar, un campo opcional queda vacío y uno obligatorio recibe \`${ANONYMOUS_PREFIX}<id>\`, que no deriva del valor y conserva la unicidad.`,
    '- Un borrado lógico oculta la fila a toda consulta, total de página y lectura por id o por clave natural; la siguen viendo las referencias desde otro agregado.',
    ''
  );
  return { path: PERSONAL_DATA_FILE, content: lines.join('\n') };
}
