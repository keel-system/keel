// La nota de una COMPENSACIÓN (`compensates`) que el handler lleva para el agente: qué deshace, qué estado tiene que
// devolver y qué impide deshacer dos veces. La escribían igual keel-nest y keel-dotnet (auditoría del inc. 1 de
// PLAN-KEEL-GO.md), y como la nota NOMBRA la guarda (`IdempotencyGuard`), un generador nuevo que la use tiene que
// llamar así a la suya o la nota mentiría.

/** La nota de la compensación de una operación, o null si no compensa nada. */
export function compensationNote(operation) {
  if (!operation.compensates) return null;
  const { dependency, undoes, moves, event, deduplicated } = operation.compensates;
  const restored = new Set((operation.transitions ?? []).map((transition) => transition.entity));
  const pending = moves.filter((entity) => !restored.has(entity));
  const guard = (operation.transitions ?? []).length > 0 ? 'transitions' : deduplicated ? 'messageId' : null;
  return (
    `Compensación de ${dependency}${undoes ? ` — deshace la activación '${undoes}'` : ''}: la dispara la suscripción a ${event}. ` +
    (moves.length > 0
      ? `El trabajo que deshaces movió el lifecycle de ${moves.join(', ')}: devolver ese estado es parte de la compensación, no un extra${pending.length > 0 ? ` (el diseño NO declara transición sobre ${pending.join(', ')} — repórtalo como designGap en vez de inventar el estado destino)` : ''}. `
      : '') +
    (guard === 'transitions'
      ? "Aplicarla dos veces no debe deshacer dos veces: la guarda es la transición del agregado, que rechaza la segunda desde un estado que ya no está en 'from'. Va en el DOMINIO, no en el handler."
      : guard === 'messageId'
        ? 'Aplicarla dos veces no debe deshacer dos veces: la guarda es la deduplicación del listener por el id del mensaje (IdempotencyGuard). El handler no añade ninguna otra.'
        : 'Aplicarla dos veces no debe deshacer dos veces y el diseño no declara guarda: repórtalo como designGap.')
  );
}
