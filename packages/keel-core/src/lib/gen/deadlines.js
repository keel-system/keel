// Los plazos de negocio sobre el estado (DSL 2.26, `lifecycle.deadlines`), como decisiones neutrales.
//
// Un plazo es un estado del que la entidad sale sola cuando pasa un tiempo. Lo dispara el cronómetro del servicio
// (PLAN-DSL-226-PLAZOS.md § El cronómetro), y el rechazo de una transición tardía lo hace el dominio en el instante del
// vencimiento. Aquí se decide una vez para los cuatro generadores; hoy solo el rechazo de los que todavía no lo generan
// (incremento 1 del plan). El resto llega con el incremento 2.

/** Los plazos declarados, uno por estado de origen: `{ entityName, entity, state, deadline }`. */
export function declaredDeadlines(layers) {
  return Object.entries(layers.domain?.entities ?? {}).flatMap(([entityName, entity]) =>
    Object.entries(entity?.lifecycle?.deadlines ?? {}).map(([state, deadline]) => ({ entityName, entity, state, deadline }))
  );
}

/**
 * El rechazo de un generador que todavía no genera los plazos, con el mismo mensaje en los cuatro: llegan por incrementos
 * (PLAN-DSL-226-PLAZOS.md) y, hasta el suyo, se rechazan enteros, nunca a medias. Vacío si el diseño no declara ninguno.
 */
export function deadlinesPendingErrors(layers, generator, increment) {
  return declaredDeadlines(layers).map(
    ({ entityName, state }) =>
      `domain: ${entityName}.lifecycle.deadlines.${state} (plazo de negocio, DSL 2.26): ${generator} todavía no lo genera — ` +
      `llega con el cronómetro del servicio, en el incremento ${increment} de PLAN-DSL-226-PLAZOS.md. Genera este diseño sin el ` +
      'plazo, o espera a ese incremento.'
  );
}
