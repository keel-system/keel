// Decisiones sobre la RÉPLICA de datos de otro servicio (`dependencies.<d>.replica`) que no dependen del
// lenguaje. Estaban copiadas en keel-spring (`dependencies.js`) y keel-nest (`projections.js`); incremento 1d
// de PLAN-KEEL-DOTNET.md.

/**
 * El campo con el instante del hecho, si la copia lo guarda. Se compara antes de escribir: es lo que impide
 * que una reentrega tardía pise un valor más nuevo. El DSL deliberadamente no lo declara (sería un SLA de
 * implementación); lo resuelve el generador porque es una decisión de solución.
 */
export function occurredAtField(entity) {
  return entity.fields.find((field) => /^(occurredAt|updatedAt|eventTime)$/.test(field.name)) ?? null;
}
