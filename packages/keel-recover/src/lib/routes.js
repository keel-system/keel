import { cmp } from './repo.js';
// Paso 1a, superficie HTTP: la tabla de rutas que el FRAMEWORK del legacy declara, leída del
// proceso en marcha y no del código. Lectores puros, uno por fuente; los tres devuelven
// `{ routes: [{ method, path, handler }], middleware? }` ordenado.
//
// Medido en el inc. 1: el `/mappings` de actuator 1.x NO lista ni Spring Data REST ni los
// `@RepositoryRestController`, pero el log de arranque sí (líneas `Mapped "{[...]}"`); en Express
// no hay endpoint que pregunte, y la tabla sale del proceso con la precarga express-routes.cjs.

const sortRoutes = (routes) =>
  [...new Map(routes.map((r) => [`${r.path} ${r.method}`, r])).values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));

/** Lo que escribe la precarga express-routes.cjs. */
export function expressRoutes(table) {
  const routes = [];
  const middleware = [];
  for (const row of Array.isArray(table) ? table : []) {
    if (row.method) {
      const r = { method: row.method, path: row.path, handler: (row.handlers ?? []).join(' → ') };
      if (row.mount) r.mount = row.mount;
      routes.push(r);
    } else if (row.middleware) middleware.push({ name: row.middleware, mount: row.mount });
  }
  return { routes: sortRoutes(routes), middleware };
}

/** `{[/orders || /o],methods=[POST],produces=[…]}` → `{ paths, methods }` (Spring 4 / Boot 1.x). */
export function parseSpringPredicate(text) {
  const inner = String(text).trim().replace(/^\{/, '').replace(/\}$/, '');
  const field = (name) => {
    const m = new RegExp(`(?:^|,)${name}=\\[([^\\]]*)\\]`).exec(inner);
    return m ? m[1].split(/\s*\|\|\s*|\s*,\s*/).filter(Boolean) : [];
  };
  const head = /^\[([^\]]*)\]/.exec(inner);
  const paths = head ? head[1].split(/\s*\|\|\s*|\s*,\s*/).filter(Boolean) : field('patterns');
  return { paths: paths.length ? paths : ['/'], methods: field('methods') };
}

// `public java.lang.String works.weave.socks.orders.controllers.OrdersController.newOrder(…)` → `OrdersController.newOrder`
export function springHandler(signature) {
  const m = /([\w$]+)\.([\w$]+)\(/.exec(String(signature));
  return m ? `${m[1]}.${m[2]}` : String(signature).trim();
}

const expand = (paths, methods, handler) => paths.flatMap((path) => (methods.length ? methods : ['*']).map((method) => ({ method, path, handler })));

/** Las líneas `Mapped "{[...]}" onto <método>` del log de arranque (Spring MVC 4, Boot 1.x). */
export function springLogRoutes(log) {
  const routes = [];
  for (const m of String(log).matchAll(/Mapped "(\{.*?\})" onto (.+)$/gm)) {
    const { paths, methods } = parseSpringPredicate(m[1]);
    routes.push(...expand(paths, methods, springHandler(m[2])));
  }
  return { routes: sortRoutes(routes) };
}

/** El JSON de `/mappings` (Boot 1.x: claves predicado) o de `/actuator/mappings` (Boot 2+). */
export function actuatorRoutes(doc) {
  const routes = [];
  if (doc?.contexts) {
    for (const ctx of Object.values(doc.contexts)) {
      for (const list of Object.values(ctx?.mappings?.dispatcherServlets ?? {})) {
        for (const row of list ?? []) {
          const cond = row.details?.requestMappingConditions;
          if (cond) routes.push(...expand(cond.patterns ?? [], cond.methods ?? [], springHandler(row.handler)));
          else {
            const { paths, methods } = parsePredicate2(row.predicate);
            routes.push(...expand(paths, methods, springHandler(row.handler)));
          }
        }
      }
    }
  } else {
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (!key.startsWith('{')) continue;
      const { paths, methods } = parseSpringPredicate(key);
      routes.push(...expand(paths, methods, springHandler(value?.method ?? value?.bean ?? '')));
    }
  }
  return { routes: sortRoutes(routes) };
}

// Boot 2+: `{GET [/orders], produces [application/json]}` o `{[/orders]}`.
function parsePredicate2(text) {
  const m = /^\{(?:([A-Z, ]+?) )?\[([^\]]*)\]/.exec(String(text ?? ''));
  if (!m) return { paths: [], methods: [] };
  return { paths: m[2].split(/\s*,\s*/).filter(Boolean), methods: (m[1] ?? '').split(/\s*,\s*/).filter(Boolean) };
}
