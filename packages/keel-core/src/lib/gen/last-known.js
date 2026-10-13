// El ÚLTIMO VALOR CONOCIDO de un need (`onUnavailable: lastKnown`), neutral: qué llamadas lo sirven y qué operaciones
// lo usan. Lo comparten keel-spring y keel-nest.
//
// Un valor rescatado es un dato que puede tener hasta `maxAgeSeconds`: se sirve, pero no es igual que uno recién
// leído, y quien lo exponga tiene que poder distinguirlo. Las dos corridas de control de catalog (keel-spring y
// keel-nest, 2026-10-11) le añadieron a mano una marca `stale` al resultado de la llamada para no cachear la ficha
// con él: cacheado, el precio viejo seguiría sirviéndose todo el TTL, más allá de la edad que el diseño declaró.

/** Los needs con `onUnavailable: lastKnown` que se resuelven por una llamada, con su dependencia. */
export function lastKnownNeeds(model) {
  return (model.dependencies ?? []).flatMap((dependency) =>
    (dependency.needs ?? []).filter((need) => need.onUnavailable?.action === 'lastKnown' && need.fetch).map((need) => ({ dependency: dependency.id, need }))
  );
}

/** ¿Esta llamada de este cliente sirve el último valor conocido de algún need? Entonces su resultado lleva `stale`. */
export function servesLastKnown(model, clientId, callName) {
  return lastKnownNeeds(model).some(({ need }) => need.fetch.clientId === clientId && need.fetch.call === callName);
}

/** Los needs con `lastKnown` que usa una operación. */
export function lastKnownNeedsOf(model, operationName) {
  return lastKnownNeeds(model).filter(({ need }) => (need.usedBy ?? []).includes(operationName));
}

/**
 * Tope de entradas vivas de la memoria del último valor conocido. La clave la forman los parámetros de la
 * llamada, así que sin tope es una fuga lenta. Estaba copiado en los dos generadores (incremento 1d de
 * PLAN-KEEL-DOTNET.md).
 */
export const LAST_KNOWN_MAX_ENTRIES = 10_000;
