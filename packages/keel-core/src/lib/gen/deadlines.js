// Los plazos de negocio sobre el estado (DSL 2.26, `lifecycle.deadlines`), como decisiones neutrales.
//
// Un plazo es un estado del que la entidad sale sola cuando pasa un tiempo. Lo dispara el cronómetro del servicio
// (timer-store.js; PLAN-DSL-226-PLAZOS.md § El cronómetro), y el rechazo de una transición tardía lo hace el DOMINIO en el
// instante exacto del vencimiento, con la hora que le da el reloj inyectable: así el contrato no depende de cuándo pase
// el cronómetro. Todo lo que los cuatro generadores tienen que decidir igual se decide aquí, como datos.

/** Los plazos declarados en las capas, uno por estado de origen: `{ entityName, entity, state, deadline }`. */
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

// ─── La duración ─────────────────────────────────────────────────────────────

/** Segundos por unidad de `after.unit`. `days` existe solo aquí: un plazo de negocio se mide en días (una invitación). */
export const DEADLINE_UNIT_SECONDS = Object.freeze({ seconds: 1, minutes: 60, hours: 3600, days: 86400 });

/**
 * La duración de un plazo, resuelta: `{ seconds }` si es literal, o `{ parameter, unit, multiplier }` si la da un
 * `service.parameters` (el valor del parámetro por `multiplier` son los segundos). El generador lee el parámetro como ya
 * lee los de `stalledAfter`; aquí solo se fija la aritmética, para que los cuatro la hagan igual.
 */
export function deadlineDuration(deadline) {
  const after = deadline.after ?? {};
  if (Number.isInteger(after.seconds)) return Object.freeze({ seconds: after.seconds });
  return Object.freeze({ parameter: after.parameter, unit: after.unit, multiplier: DEADLINE_UNIT_SECONDS[after.unit] });
}

/**
 * ¿Ha vencido el plazo? `since + after <= now`: vence EN el instante, no después (D3 del plan). Es la regla del rechazo
 * tardío del dominio y la de la revalidación del cronómetro, y la referencia que las pruebas de los cuatro ejecutan.
 * Todo en milisegundos desde la época.
 */
export function isDeadlineDue({ sinceMs, afterSeconds, nowMs }) {
  return sinceMs + afterSeconds * 1000 <= nowMs;
}

// ─── Los plazos del modelo ───────────────────────────────────────────────────

/** El `kind` del temporizador de un plazo en `keel_timer`: `deadline:<Entidad>.<estado>`, con los nombres del diseño. */
export function deadlineKind(entityName, stateName) {
  return `deadline:${entityName}.${stateName}`;
}

/** Los plazos del modelo, con su entidad: `{ entity, deadline, kind, duration }`. */
export function modelDeadlines(model) {
  return (model.entities ?? []).flatMap((entity) =>
    (entity.lifecycle?.deadlines ?? []).map((deadline) => ({
      entity,
      deadline,
      kind: deadlineKind(entity.name, deadline.stateName),
      duration: deadlineDuration(deadline)
    }))
  );
}

/** ¿Declara el servicio algún plazo? */
export function usesDeadlines(model) {
  return modelDeadlines(model).length > 0;
}

/** El plazo que caduca `operation` (es su `by`), o null. */
export function deadlineOf(model, operation) {
  return modelDeadlines(model).find(({ deadline }) => deadline.by === operation.name) ?? null;
}

/**
 * Los rechazos tardíos que el dominio de UNA entidad tiene que hacer: por cada plazo con `lateAction: { error }`, desde
 * qué estado (`from`), qué destino queda exento (`exempt`, el de la caducidad) y con qué `code`. Con `allow` no hay
 * rechazo: la transición tardía se admite mientras la caducidad no haya pasado.
 *
 * El método de transición del dominio recibe el instante actual del reloj inyectable y compara con `isDeadlineDue`: un
 * destino que no es `exempt`, saliendo de `from` con el plazo vencido, es el `code`.
 */
export function lateGuards(entity) {
  return (entity.lifecycle?.deadlines ?? [])
    .filter((deadline) => deadline.lateAction && deadline.lateAction !== 'allow' && deadline.lateAction.error)
    .map((deadline) =>
      Object.freeze({
        from: deadline.state,
        exempt: deadline.to,
        since: deadline.since,
        duration: deadlineDuration(deadline),
        error: deadline.lateAction.error
      })
    );
}

// ─── El reloj inyectable ─────────────────────────────────────────────────────
//
// El inventario del incremento 0 lo midió: ninguno de los cuatro tenía reloj en el dominio ni en los handlers (todo es la
// hora de la instancia, leída en el sitio). El rechazo tardío lo necesita para poder probarse: sin él, la prueba del
// segundo exacto del vencimiento (DL-2) no existe. Solo lo usa lo nuevo; migrar el resto de `now()` no lo pide nada.

/** El puerto del reloj, por su nombre neutral: cada generador lo proyecta al tipo de su plataforma. */
export const CLOCK_PORT = Object.freeze({ name: 'Clock', method: 'now' });

// ─── Lo que lee el agente ────────────────────────────────────────────────────

/**
 * La nota del handler de la operación `by` de un plazo, o null. `entityRef` es cómo se nombra la entidad en el lenguaje
 * del generador. La misma en los cuatro.
 */
export function deadlineHandlerNote(model, operation) {
  const found = deadlineOf(model, operation);
  if (!found) return null;
  const { entity, deadline } = found;
  return (
    `La despacha el cronómetro del servicio, una vez por cada ${entity.name} cuyo plazo en '${deadline.stateName}' venció ` +
    `(desde ${deadline.since}). El cronómetro ya revalidó con la hora de la base que la entidad sigue en '${deadline.stateName}' ` +
    `y que el plazo venció: aplica la transición ${deadline.stateName} → ${deadline.toName} y lo que el diseño pida al caducar, ` +
    'sin volver a comprobar el plazo con la hora de este proceso. Si la entidad ya no está en ese estado (otra réplica o un ' +
    'cliente se adelantaron), la transición la rechaza el lifecycle y no es un error: no hay nada que caducar. Puede llegar ' +
    'más de una vez (el cronómetro es al menos una vez); la transición condicional hace que el efecto ocurra una sola.'
  );
}

/**
 * La nota del handler de una operación que saca a la entidad de un estado con plazo hacia OTRO destino, o null: el
 * rechazo tardío no es suyo, es del dominio, pero tiene que darle la hora.
 */
export function lateTransitionNote(model, operation) {
  // Las transiciones de una operación del modelo llevan los nombres del diseño (`operation.transitions` es el YAML).
  const touched = modelDeadlines(model).filter(({ entity, deadline }) =>
    (operation.transitions ?? []).some(
      (transition) =>
        transition.entity === entity.name && (transition.from ?? []).includes(deadline.stateName) && transition.to !== deadline.toName
    )
  );
  if (touched.length === 0) return null;
  return touched
    .map(({ entity, deadline }) => {
      const late =
        deadline.lateAction === 'allow'
          ? 'el diseño la ADMITE mientras la caducidad no haya pasado (lateAction: allow): no la rechaces'
          : `pasado el plazo la rechaza el dominio con ${deadline.lateAction.error}, en el instante exacto del vencimiento`;
      return (
        `${entity.name} tiene un plazo en '${deadline.stateName}' (desde ${deadline.since}): ${late}. ` +
        `Pasa al método de transición la hora del reloj inyectable (${CLOCK_PORT.name}), nunca la de la instancia leída en el ` +
        'sitio: es lo que deja probar el segundo del vencimiento.'
      );
    })
    .join(' ');
}

// ─── Lo que se mide ──────────────────────────────────────────────────────────

/** Los casos del plazo: qué afirma cada uno. Los ejecutan las redes de cada generador con sus sujetos. */
export const DEADLINE_CASES = Object.freeze([
  { id: 'DL-1', what: 'dentro del plazo, la transición tardía sale' },
  { id: 'DL-2', what: 'en el instante exacto del vencimiento, la transición tardía se rechaza con el code de lateAction' },
  { id: 'DL-3', what: 'pasado el plazo, la transición hacia el destino de la caducidad sale' },
  { id: 'DL-4', what: 'entrar en el estado arma el temporizador en la misma transacción; si revierte, no queda ninguno' },
  { id: 'DL-5', what: 'el reclamo devuelve solo lo vencido, en orden de due_at' },
  { id: 'DL-6', what: 'dos réplicas a la vez no reclaman el mismo temporizador' },
  { id: 'DL-7', what: 'un arriendo vencido lo retoma otra réplica' },
  { id: 'DL-8', what: 'el temporizador de una entidad que ya salió del estado se descarta sin transición' },
  { id: 'DL-9', what: 'con el plazo alargado después de armar, se rearma y no dispara' },
  { id: 'DL-10', what: 'el sondeador duerme hasta el siguiente vencimiento, despierta antes si su réplica arma uno más próximo, y aparca tras max-attempts fallos' }
]);

/** Los sabotajes que falsan los casos: cada uno tiene que caer en exactamente los suyos. */
export const DEADLINE_SABOTAGES = Object.freeze({
  'dl-boundary': { breaks: ['DL-2'], what: 'compara con < en vez de <=: el segundo exacto pasa' },
  'dl-no-guard': { breaks: ['DL-2'], what: 'el dominio no hace el rechazo tardío' },
  'dl-wrong-field': { breaks: ['DL-2', 'DL-9'], what: 'cuenta el plazo desde otra marca' },
  'dl-no-revalidate': { breaks: ['DL-8', 'DL-9'], what: 'dispara sin mirar el estado ni el plazo vigente' },
  'dl-no-lease': { breaks: ['DL-6', 'DL-7'], what: 'reclama sin arriendo: otra réplica se lleva lo arrendado' },
  'dl-app-clock': { breaks: ['DL-5'], what: 'el reclamo compara con la hora de la instancia en vez de la de la base' },
  'dl-outside-tx': { breaks: ['DL-4'], what: 'arma el temporizador fuera de la transacción de la entidad' }
});
