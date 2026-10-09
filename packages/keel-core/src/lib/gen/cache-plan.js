// La caché de lectura del diseño (`use-cases.<op>.cache`) como DATOS: qué cachés hay, cómo se llaman en el
// store, con qué TTL y qué operaciones las invalidan. Lo comparten los dos generadores, porque el nombre de
// cada caché es contrato operativo: `infra/reset-db.sh` y el `clearCache()` del arnés borran las claves
// `<servicio>:*`, y una caché que se llamara distinto en un servidor sobreviviría al reset de ese.
//
// La forma de la clave es la de RedisCacheManager de Spring: `<caché>::<clave>`, con la caché como
// `<servicio>:<operación-en-kebab>`. keel-nest la escribe igual aunque su cliente no imponga ninguna, para que
// una misma `infra/` y una misma inspección con redis-cli valgan para los dos.

import { kebabCase, screamingSnake } from './naming.js';

/** Separador entre el nombre de la caché y la clave de la entrada (el `::` de RedisCacheManager). */
export const CACHE_ENTRY_SEPARATOR = '::';

/** Separador entre los `keyFields` de una clave compuesta, en el orden declarado. */
export const CACHE_KEY_PART_SEPARATOR = ':';

/**
 * Las operaciones con `cache` declarado, en el orden del diseño: el nombre de la caché en el store
 * (`<servicio>:<operación>`), su constante, el TTL, los campos de la clave y los eventos que la invalidan.
 */
export function cachedOperations(model) {
  const slug = model.service.artifactId;
  const entries = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (!operation.cache) continue;
      entries.push({
        operation: operation.name,
        messageClass: operation.messageClass,
        constant: `${screamingSnake(operation.name)}_CACHE`,
        cacheName: `${slug}:${kebabCase(operation.name)}`,
        ttlSeconds: operation.cache.ttlSeconds,
        keyFields: operation.cache.keyFields ?? [],
        invalidatedBy: operation.cache.invalidatedBy ?? [],
        responseDto: operation.responseDto,
        returnsList: operation.returnsList,
        paginated: operation.paginated
      });
    }
  }
  return entries;
}

/**
 * Qué operaciones invalidan qué cachés, derivado de los hechos del diseño: una caché la invalida la
 * operación que EMITE uno de sus eventos (`emits`) y la que DISPARA la suscripción a uno de ellos (un
 * evento consumido que cambia lo que la lectura devuelve: el nombre de la suscripción es el del evento).
 *
 * Se invalida la caché ENTERA, no la entrada: la clave es la entrada de la LECTURA (un slug de categoría,
 * un id) y el evento no tiene por qué llevarla. Invalida de más, nunca de menos —que es el error que no
 * se ve: sirve datos viejos hasta el TTL sin fallar nada—.
 *
 * Devuelve `[{ operation, messageClass, caches: [{ cacheName, constant, events }] }]`, en el orden del diseño.
 */
export function cacheInvalidations(model) {
  const caches = cachedOperations(model);
  if (caches.length === 0) return [];
  const triggeredBy = new Map();
  for (const subscription of model.subscriptions ?? []) {
    if (!subscription.trigger) continue;
    if (!triggeredBy.has(subscription.trigger)) triggeredBy.set(subscription.trigger, []);
    triggeredBy.get(subscription.trigger).push(subscription.name);
  }
  const result = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      const events = new Set([...(operation.emits ?? []), ...(triggeredBy.get(operation.name) ?? [])]);
      const hits = caches
        .map((cache) => ({ cacheName: cache.cacheName, constant: cache.constant, events: cache.invalidatedBy.filter((event) => events.has(event)) }))
        .filter((hit) => hit.events.length > 0);
      if (hits.length > 0) result.push({ operation: operation.name, messageClass: operation.messageClass, caches: hits });
    }
  }
  return result;
}

/**
 * Los eventos de `invalidatedBy` que ninguna operación emite ni consume: con ellos la caché solo caduca por
 * su TTL. El generador lo avisa en vez de callarlo.
 */
export function unbackedInvalidations(model) {
  const backed = new Set(cacheInvalidations(model).flatMap((entry) => entry.caches.flatMap((cache) => cache.events.map((event) => `${cache.cacheName}|${event}`))));
  return cachedOperations(model).flatMap((cache) =>
    cache.invalidatedBy.filter((event) => !backed.has(`${cache.cacheName}|${event}`)).map((event) => ({ operation: cache.operation, event }))
  );
}
