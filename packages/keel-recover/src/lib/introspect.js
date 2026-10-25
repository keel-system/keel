import { containerOf } from './sandbox.js';
import { toolRequest } from './tool-http.js';
import { actuatorRoutes, expressRoutes, springLogRoutes } from './routes.js';
import { databaseAdapter } from './db/index.js';
import { brokerTopology } from './rabbit.js';
import { cmp } from './repo.js';

// Paso 1a: la superficie del legacy preguntada al RUNTIME, no al código. Rutas con su handler (del
// framework), colecciones con sus índices y sus columnas de estado (de la base) y la topología del
// broker (de su API). Sale `surface.yaml`.
//
// La superficie se declara de forma perezosa (inc. 1): una colección nace con su primer documento
// y una cola, con la primera conexión. Por eso se vuelve a preguntar al final de cada ronda y se
// FUSIONA: cada elemento guarda la pasada en que apareció (`seen`) y, si deja de verse, en cuál
// faltó (`absent`), que también es un hallazgo (una cola no durable que no sobrevive a un reinicio).

function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** La tabla de rutas de la fuente que declara sandbox.yaml (`introspection.routes`): `{ ok, value | error }`, y value null si no declara ninguna. */
export function readRoutes(rt, sandbox) {
  const src = sandbox.spec.introspection?.routes;
  // `none`: declarado sin fuente (un router a mano sobre http nativo); la superficie HTTP sale de las sondas.
  if (!src || src.kind === 'none') return { ok: true, value: null };
  const app = containerOf(sandbox, sandbox.spec.app.service);
  const tool = containerOf(sandbox, sandbox.spec.tool.service);
  if (src.kind === 'express') {
    // Por un contenedor con los volúmenes de la app y como root: la precarga escribe con el
    // usuario de la app y su imagen puede no traer ni cat.
    const r = rt.run(['--user', '0', '--volumes-from', app, '--entrypoint', 'cat', rt.image(tool), src.file]);
    if (r.status !== 0) return { ok: false, error: `no se pudo leer ${src.file} (¿falta la precarga express-routes.cjs en NODE_OPTIONS?): ${tail(r.stderr)}` };
    try {
      return { ok: true, value: { source: 'express', ...expressRoutes(JSON.parse(r.stdout)) } };
    } catch (err) {
      return { ok: false, error: `${src.file} no es JSON: ${err.message}` };
    }
  }
  if (src.kind === 'spring-log') {
    const r = rt.logs(app);
    const out = springLogRoutes(`${r.stdout}\n${r.stderr}`);
    if (out.routes.length === 0) return { ok: false, error: 'el log de arranque no trae la tabla de rutas: en Boot 1.x son las líneas Mapped "{[...]}"; en Boot 2+ solo salen con RequestMappingHandlerMapping a TRACE (SPRING_APPLICATION_JSON en el servicio de la app, ver sandbox-files.md)' };
    return { ok: true, value: { source: 'spring-log', ...out } };
  }
  const r = toolRequest(rt, tool, { method: 'GET', url: `${sandbox.spec.app.base.replace(/\/$/, '')}${src.path}` });
  if (r.status !== 200 || typeof r.body !== 'object') return { ok: false, error: `${src.path} respondió ${r.status || 'nada'}` };
  return { ok: true, value: { source: 'actuator', ...actuatorRoutes(r.body) } };
}

/** `{ ok, surface, errors }`: lo que se pudo preguntar, y por qué no lo demás. */
export function introspect(sandbox, rt) {
  const { spec } = sandbox;
  const tool = containerOf(sandbox, spec.tool.service);
  const errors = [];
  const surface = { kind: 'surface', schema: 1 };

  const routes = readRoutes(rt, sandbox);
  if (!routes.ok) errors.push(`rutas: ${routes.error}`);
  else if (routes.value) surface.http = routes.value;

  if (spec.database) {
    const adapter = databaseAdapter(spec.database.tech);
    const db = adapter ? adapter.introspect(rt, containerOf(sandbox, spec.database.service), spec.database) : { ok: false, error: `introspección sin implementar para ${spec.database.tech}` };
    if (!db.ok) errors.push(`base: ${db.error}`);
    else surface.data = { tech: spec.database.tech, database: spec.database.name, ...db.value };
  }
  if (spec.broker) {
    const b = brokerTopology(rt, tool, spec.broker);
    if (!b.ok) errors.push(`broker: ${b.error}`);
    else surface.broker = { tech: spec.broker.tech, vhost: spec.broker.vhost ?? '/', ...b.value };
  }
  return { ok: errors.length === 0, surface, errors };
}

// ── fusión entre pasadas ─────────────────────────────────────────────────────────────────────

const KEYS = {
  'http.routes': (r) => `${r.method} ${r.path}`,
  'http.middleware': (m) => `${m.name}@${m.mount}`,
  'data.collections': (c) => c.name,
  'data.tables': (t) => t.name,
  'data.sequences': (s) => s.name,
  'data.types': (t) => t.name,
  'broker.exchanges': (e) => e.name,
  'broker.queues': (q) => q.name,
  'broker.bindings': (b) => `${b.source}|${b.destination}|${b.routing_key}`,
};

function mergeList(prev = [], fresh = [], keyOf, label) {
  const before = new Map(prev.map((x) => [keyOf(x), x]));
  const now = new Map(fresh.map((x) => [keyOf(x), x]));
  const out = [];
  for (const [k, x] of now) {
    const old = before.get(k);
    const { absent, ...rest } = x;
    out.push({ ...rest, seen: old?.seen ?? label });
  }
  for (const [k, old] of before) if (!now.has(k)) out.push({ ...old, absent: label });
  return out.sort((a, b) => cmp(keyOf(a), keyOf(b)));
}

/**
 * Funde una pasada nueva en la superficie anterior. `label` es la pasada (`introspect`, `round-1`…).
 * Una sección que esta pasada no pudo preguntar se conserva tal cual.
 */
export function mergeSurface(prev, fresh, label) {
  if (!prev) prev = { kind: 'surface', schema: 1 };
  const out = { kind: 'surface', schema: 1 };
  for (const section of ['http', 'data', 'broker']) {
    const p = prev[section];
    const f = fresh[section];
    if (!p && !f) continue;
    if (!f) {
      out[section] = p;
      continue;
    }
    const merged = { ...f };
    for (const [path, keyOf] of Object.entries(KEYS)) {
      const [sec, list] = path.split('.');
      if (sec !== section || !f[list]) continue;
      merged[list] = mergeList(p?.[list], f[list], keyOf, label);
    }
    out[section] = merged;
  }
  out.passes = [...new Set([...(prev.passes ?? []), label])];
  return out;
}
