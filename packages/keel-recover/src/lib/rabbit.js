import { toolRequest } from './tool-http.js';
import { cmp } from './repo.js';

// El espía de RabbitMQ (paso 1b) y su topología (paso 1a), por la API de gestión desde el
// contenedor de herramientas y por rabbitmqctl dentro del del broker.
//
// Por qué el firehose y no leer las colas del legacy, como hacía el prototipo del inc. 1: leer una
// cola del legacy le roba el mensaje a su consumidor (y cambia el comportamiento que se graba), no
// ve lo publicado a un exchange sin colas, y no ve el exchange por defecto. El firehose
// (`rabbitmqctl trace_on`) copia CADA publicación del vhost a `amq.rabbitmq.trace` con la clave
// `publish.<exchange>`, se enlaza o no haya consumidores y aunque el mensaje no se enrute a nadie.
// Su precio: no sobrevive a un reinicio del broker, así que se vuelve a encender tras uno.

export const SPY_QUEUE = 'keel-recover.spy';
export const TRACE_EXCHANGE = 'amq.rabbitmq.trace';
export const SPY_BINDING = 'publish.#';
// Los mensajes que pone la propia herramienta: los canarios y los eventos entrantes de una sonda.
export const CANARY_ID = 'keel-recover-canary-';
export const PROBE_ID = 'keel-recover-probe-';

const enc = (s) => encodeURIComponent(s);

export function brokerApi(rt, tool, broker, method, path, body) {
  const r = toolRequest(rt, tool, {
    method,
    url: `${broker.api.replace(/\/$/, '')}${path}`,
    user: `${broker.user ?? 'guest'}:${broker.password ?? 'guest'}`,
    headers: { 'content-type': 'application/json' },
    body,
  });
  return r;
}

const vhostOf = (broker) => enc(broker.vhost ?? '/');

function okOrError(r, what) {
  if (r.status >= 200 && r.status < 300) return { ok: true, body: r.body };
  return { ok: false, error: `${what}: ${r.status || 'sin respuesta'} ${typeof r.body === 'string' ? r.body.slice(0, 160) : JSON.stringify(r.body ?? r.error ?? '').slice(0, 160)}` };
}

/**
 * Enciende el firehose y monta la cola espía. Idempotente: se llama al empezar la ronda y tras
 * cada reinicio del broker. `unbound` es el sabotaje de la puerta: la cola existe pero sin
 * enlace, y el canario tiene que verlo.
 */
export function ensureSpy(rt, tool, brokerContainer, broker, { unbound = false } = {}) {
  const trace = rt.exec(brokerContainer, ['rabbitmqctl', '-q', 'trace_on', '-p', broker.vhost ?? '/']);
  if (trace.status !== 0) return { ok: false, error: `rabbitmqctl trace_on falló: ${(trace.stderr || trace.stdout).trim().slice(-200)}` };
  const q = okOrError(brokerApi(rt, tool, broker, 'PUT', `/queues/${vhostOf(broker)}/${enc(SPY_QUEUE)}`, { durable: true, auto_delete: false, arguments: {} }), 'declarar la cola espía');
  if (!q.ok) return q;
  const bindPath = `/bindings/${vhostOf(broker)}/e/${enc(TRACE_EXCHANGE)}/q/${enc(SPY_QUEUE)}`;
  if (unbound) {
    brokerApi(rt, tool, broker, 'DELETE', `${bindPath}/${enc(SPY_BINDING)}`);
    return { ok: true };
  }
  return okOrError(brokerApi(rt, tool, broker, 'POST', bindPath, { routing_key: SPY_BINDING, arguments: {} }), 'enlazar la cola espía');
}

export function purgeSpy(rt, tool, broker) {
  const r = brokerApi(rt, tool, broker, 'DELETE', `/queues/${vhostOf(broker)}/${enc(SPY_QUEUE)}/contents`);
  return r.status === 404 ? { ok: true } : okOrError(r, 'vaciar la cola espía');
}

/** Publica por la API de gestión. `routed: false` no es un error: el firehose lo ve igual. */
export function publish(rt, tool, broker, { exchange = '', routingKey, payload, headers = {}, messageId, persistent = true }) {
  const body = {
    properties: { delivery_mode: persistent ? 2 : 1, headers, ...(messageId ? { message_id: messageId } : {}), content_type: typeof payload === 'string' ? 'text/plain' : 'application/json' },
    routing_key: routingKey,
    payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64'),
    payload_encoding: 'base64',
  };
  const r = brokerApi(rt, tool, broker, 'POST', `/exchanges/${vhostOf(broker)}/${enc(exchange || 'amq.default')}/publish`, body);
  const res = okOrError(r, `publicar en ${exchange || 'amq.default'}`);
  return res.ok ? { ok: true, routed: Boolean(r.body?.routed) } : res;
}

export function publishCanary(rt, tool, broker, tag) {
  return publish(rt, tool, broker, { exchange: '', routingKey: 'keel-recover.canary', payload: `canario ${tag}`, messageId: `${CANARY_ID}${tag}` });
}

/** Lo que el firehose copió desde la última purga, en orden de publicación, y lo consume. */
export function readSpy(rt, tool, broker) {
  const r = brokerApi(rt, tool, broker, 'POST', `/queues/${vhostOf(broker)}/${enc(SPY_QUEUE)}/get`, { count: 100000, ackmode: 'ack_requeue_false', encoding: 'auto' });
  const res = okOrError(r, 'leer la cola espía');
  if (!res.ok) return res;
  return { ok: true, value: (Array.isArray(r.body) ? r.body : []).map(traceToMessage) };
}

/** Un mensaje del firehose → la publicación original (exchange, claves, propiedades, cuerpo). */
export function traceToMessage(m) {
  const h = m.properties?.headers ?? {};
  const props = { ...(h.properties ?? {}) };
  const out = { exchange: h.exchange_name ?? '', routingKeys: h.routing_keys ?? [] };
  if (props.timestamp !== undefined) {
    out._timestamp = props.timestamp;
    delete props.timestamp;
  }
  const id = String(props.message_id ?? '');
  out.origin = id.startsWith(CANARY_ID) ? 'canary' : id.startsWith(PROBE_ID) ? 'probe' : 'legacy';
  out.properties = props;
  const raw = m.payload_encoding === 'base64' ? Buffer.from(m.payload ?? '', 'base64').toString('utf8') : m.payload;
  try {
    out.payload = JSON.parse(raw);
  } catch {
    out.payload = raw;
  }
  return out;
}

/** El broker otra vez arriba y su API respondiendo. */
export async function waitBroker(rt, tool, broker, { pollMs = 2000 } = {}) {
  const deadline = Date.now() + (broker.startup_seconds ?? 90) * 1000;
  for (;;) {
    const r = brokerApi(rt, tool, broker, 'GET', '/overview');
    if (r.status === 200) return { ok: true };
    if (Date.now() > deadline) return { ok: false, error: `el broker no volvió en ${broker.startup_seconds ?? 90} s` };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** Paso 1a: exchanges, colas y enlaces del legacy (sin los del sistema ni los de la herramienta). */
export function brokerTopology(rt, tool, broker) {
  const v = vhostOf(broker);
  const ex = okOrError(brokerApi(rt, tool, broker, 'GET', `/exchanges/${v}`), 'listar exchanges');
  const qs = okOrError(brokerApi(rt, tool, broker, 'GET', `/queues/${v}`), 'listar colas');
  const bs = okOrError(brokerApi(rt, tool, broker, 'GET', `/bindings/${v}`), 'listar enlaces');
  for (const r of [ex, qs, bs]) if (!r.ok) return r;
  return { ok: true, value: shapeTopology(ex.body, qs.body, bs.body) };
}

export function shapeTopology(exchanges = [], queues = [], bindings = []) {
  const mine = (name) => String(name).startsWith('keel-recover.');
  const system = (name) => name === '' || String(name).startsWith('amq.');
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== false && !(x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0)));
  return {
    exchanges: exchanges
      .filter((e) => !system(e.name))
      .map((e) => clean({ name: e.name, type: e.type, durable: e.durable, auto_delete: e.auto_delete, internal: e.internal, arguments: e.arguments }))
      .sort((a, b) => cmp(a.name, b.name)),
    queues: queues
      .filter((q) => !mine(q.name))
      .map((q) => clean({ name: q.name, durable: q.durable, auto_delete: q.auto_delete, exclusive: q.exclusive, arguments: q.arguments, consumers: q.consumers ?? 0 }))
      .sort((a, b) => cmp(a.name, b.name)),
    bindings: bindings
      .filter((b) => !system(b.source) && !mine(b.destination))
      .map((b) => clean({ source: b.source, destination: b.destination, destination_type: b.destination_type, routing_key: b.routing_key, arguments: b.arguments }))
      .sort((a, b) => cmp(`${a.source}|${a.destination}|${a.routing_key}`, `${b.source}|${b.destination}|${b.routing_key}`)),
  };
}
