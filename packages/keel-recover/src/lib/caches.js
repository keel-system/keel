// Los almacenes en memoria del legacy (`caches` en sandbox.yaml): una caché o la sesión en Redis. El snapshot es solo de la
// base, así que sin vaciarlos una sonda leería lo que cacheó la anterior (un @Cacheable de Spring sobre las funciones de
// show-ticketing devolvería lo de antes de la restauración) y una caracterización dependería del orden de los flujos. Se
// vacían en cada restauración, después de la base: lo que la app cachee desde ahí sale de la base restaurada.

import { containerOf } from './sandbox.js';

export const CACHE_TECHS = ['redis'];

const tail = (text, n = 300) => {
  const t = String(text ?? '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** El argv que vacía un almacén dentro de su contenedor: la contraseña por entorno, nunca en la línea de comandos. */
export function flushArgs(cache) {
  return cache.password ? ['env', `REDISCLI_AUTH=${cache.password}`, 'redis-cli', 'FLUSHALL'] : ['redis-cli', 'FLUSHALL'];
}

/** Vacía cada almacén de `caches`: `{ ok }` o `{ ok: false, error }` con el primero que falla. */
export function flushCaches(rt, sandbox) {
  for (const cache of sandbox.spec.caches ?? []) {
    if (!CACHE_TECHS.includes(cache.tech)) return { ok: false, error: `keel-recover no sabe vaciar ${cache.tech} (${cache.service}): solo ${CACHE_TECHS.join(', ')}` };
    const container = containerOf(sandbox, cache.service);
    if (!container) return { ok: false, error: `caches: el servicio ${cache.service} no está en el compose (o no tiene container_name)` };
    const r = rt.exec(container, flushArgs(cache));
    // redis-cli sale con 0 aunque el servidor conteste un error (NOAUTH): lo que vale es el OK
    if (r.status !== 0 || !/^OK\s*$/m.test(r.stdout ?? '')) return { ok: false, error: `no se pudo vaciar ${cache.service}: ${tail(r.stderr || r.stdout) || `redis-cli salió con ${r.status}`}` };
  }
  return { ok: true };
}
