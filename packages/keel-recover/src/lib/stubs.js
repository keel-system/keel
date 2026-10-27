import { toolRequest } from './tool-http.js';
import { HTTP_STUB_ENDPOINTS } from '@keel-system/keel-core/gen/http-stub-probes';

// Los terceros HTTP del legacy, servidos por WireMock (paso 1b): su diario de peticiones es el
// efecto «llamada saliente». Se lee por la API de administración desde el contenedor de
// herramientas. El canario de cada sonda viaja por las MISMAS bases con las que llama el legacy
// (`stubs.hosts`): si una de ellas no acaba en el WireMock cuyo diario se lee, el canario falta.

export const CANARY_PATH = '/__keel-recover/canary/';

const admin = (stubs, p) => `${stubs.admin.replace(/\/$/, '')}${p}`;

function okOrError(r, what) {
  if (r.status >= 200 && r.status < 300) return { ok: true, body: r.body };
  return { ok: false, error: `${what}: ${r.status || 'sin respuesta'} ${JSON.stringify(r.body ?? r.error ?? '').slice(0, 200)}` };
}

export function resetJournal(rt, tool, stubs) {
  return okOrError(toolRequest(rt, tool, { method: 'DELETE', url: admin(stubs, '/requests') }), 'vaciar el diario de WireMock');
}

export function addMapping(rt, tool, stubs, mapping) {
  const r = okOrError(toolRequest(rt, tool, { method: 'POST', url: admin(stubs, HTTP_STUB_ENDPOINTS.mappings), body: { priority: 1, ...mapping } }), 'programar el stub');
  return r.ok ? { ok: true, id: r.body?.id } : r;
}

export function removeMapping(rt, tool, stubs, id) {
  return okOrError(toolRequest(rt, tool, { method: 'DELETE', url: admin(stubs, `${HTTP_STUB_ENDPOINTS.mappings}/${id}`) }), 'quitar el stub');
}

/** Las marcas de canario de una sonda: una por cada base con la que llama el legacy. */
export const canaryTags = (stubs, tag) => stubs.hosts.map((_, i) => `${tag}-h${i + 1}`);

/** Una petición por cada base con la que llama el legacy; responde 404 y queda en el diario. */
export function sendCanary(rt, tool, stubs, tag) {
  const tags = canaryTags(stubs, tag);
  stubs.hosts.forEach((host, i) => toolRequest(rt, tool, { method: 'GET', url: `${host.replace(/\/$/, '')}${CANARY_PATH}${tags[i]}`, timeoutSeconds: 5 }));
  return tags;
}

/** El diario en orden de llegada: `{ ok, value: [{ method, host, url, headers, body, matched, status, canary? }] }`. */
export function readJournal(rt, tool, stubs) {
  const r = okOrError(toolRequest(rt, tool, { method: 'GET', url: admin(stubs, '/requests') }), 'leer el diario de WireMock');
  if (!r.ok) return r;
  if (!Array.isArray(r.body?.requests)) return { ok: false, error: `el diario de WireMock no trae requests: ${JSON.stringify(r.body).slice(0, 200)}` };
  return { ok: true, value: r.body.requests.map(journalEntry).reverse() };
}

const KEPT = ['content-type', 'accept', 'authorization'];

export function journalEntry(e) {
  const req = e.request ?? {};
  const headers = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => KEPT.includes(k.toLowerCase())).map(([k, v]) => [k.toLowerCase(), v]));
  let body = req.body ?? '';
  try {
    body = JSON.parse(body);
  } catch {
    /* texto */
  }
  const out = {
    method: req.method,
    host: req.headers?.Host ?? req.headers?.host ?? null,
    url: req.url,
    headers,
    body: body === '' ? null : body,
    matched: Boolean(e.wasMatched),
    status: e.responseDefinition?.status ?? null,
  };
  if (String(req.url ?? '').startsWith(CANARY_PATH)) out.canary = req.url.slice(CANARY_PATH.length);
  return out;
}
