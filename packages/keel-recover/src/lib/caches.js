// Los almacenes en memoria del legacy (`caches` en sandbox.yaml): una caché o la sesión en Redis. El snapshot es solo de la
// base, así que sin vaciarlos una sonda leería lo que cacheó la anterior (un @Cacheable de Spring sobre las funciones de
// show-ticketing devolvería lo de antes de la restauración) y una caracterización dependería del orden de los flujos. Se
// vacían en cada restauración, después de la base: lo que la app cachee desde ahí sale de la base restaurada.
//
// El puerto es el del servidor dentro de su contenedor: el `port` de la entrada si lo dice, si no el `--port` del
// `command` del servicio en el compose (un legacy que fija otro puerto lo reproduce así: en show-ticketing la caché
// escucha en 6380, el de application-local.properties) y, sin ninguno de los dos, el 6379 de la imagen.

import { containerOf } from './sandbox.js';

export const CACHE_TECHS = ['redis'];
const DEFAULT_PORT = { redis: 6379 };

const tail = (text, n = 300) => {
  const t = String(text ?? '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** El `--port` con que el compose arranca el servidor (`command` en lista o en texto), o null. */
export function composePort(service) {
  const command = service?.command;
  const args = Array.isArray(command) ? command.map(String) : typeof command === 'string' ? command.split(/\s+/) : [];
  for (const [i, arg] of args.entries()) {
    const inline = /^--port=(\d+)$/.exec(arg);
    if (inline) return Number(inline[1]);
    if (arg === '--port' && /^\d+$/.test(args[i + 1] ?? '')) return Number(args[i + 1]);
  }
  return null;
}

/** El puerto en que escucha el almacén dentro de su contenedor. */
export function cachePort(sandbox, cache) {
  return cache.port ?? composePort(sandbox.compose.services?.[cache.service]) ?? DEFAULT_PORT[cache.tech];
}

/** El argv que vacía un almacén dentro de su contenedor: la contraseña por entorno, nunca en la línea de comandos. */
export function flushArgs(cache, port = DEFAULT_PORT.redis) {
  const cli = ['redis-cli', ...(port !== DEFAULT_PORT.redis ? ['-p', String(port)] : []), 'FLUSHALL'];
  return cache.password ? ['env', `REDISCLI_AUTH=${cache.password}`, ...cli] : cli;
}

/** Vacía cada almacén de `caches`: `{ ok }` o `{ ok: false, error }` con el primero que falla. */
export function flushCaches(rt, sandbox) {
  for (const cache of sandbox.spec.caches ?? []) {
    if (!CACHE_TECHS.includes(cache.tech)) return { ok: false, error: `keel-recover no sabe vaciar ${cache.tech} (${cache.service}): solo ${CACHE_TECHS.join(', ')}` };
    const container = containerOf(sandbox, cache.service);
    if (!container) return { ok: false, error: `caches: el servicio ${cache.service} no está en el compose (o no tiene container_name)` };
    const port = cachePort(sandbox, cache);
    const r = rt.exec(container, flushArgs(cache, port));
    // redis-cli sale con 0 aunque el servidor conteste un error (NOAUTH): lo que vale es el OK
    if (r.status !== 0 || !/^OK\s*$/m.test(r.stdout ?? '')) {
      const why = tail(r.stderr || r.stdout) || `redis-cli salió con ${r.status}`;
      return { ok: false, error: `no se pudo vaciar ${cache.service} en el puerto ${port}: ${why}${/Could not connect/.test(why) ? ' (si escucha en otro, `port` en su entrada de caches o `--port` en su command del compose)' : ''}` };
    }
  }
  return { ok: true };
}
