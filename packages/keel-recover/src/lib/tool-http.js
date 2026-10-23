// HTTP desde el contenedor de herramientas: la red del sandbox es interna y el host no la alcanza,
// así que toda petición (las sondas y las APIs de los espías) sale de ahí con curl. El cuerpo viaja
// siempre por stdin, nunca en la línea de comandos: en Windows el cliente de contenedores se come
// las comillas del JSON (lección de keel-core/src/lib/gen/broker-probes.js).

const tryJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

// Las cabeceras que dicen algo del comportamiento; el resto (fecha, longitud, servidor) es ruido.
export const KEPT_HEADERS = ['content-type', 'location', 'access-control-allow-origin', 'set-cookie', 'www-authenticate', 'allow', 'retry-after'];

function build({ method = 'GET', url, headers = {}, body, user, timeoutSeconds = 15 }) {
  // $0 es el método y "$@" el resto: así ninguna cabecera pasa por el intérprete de sh.
  const script =
    `curl -s -m ${Number(timeoutSeconds)} -D /tmp/h.$$ -o /tmp/b.$$ -w '%{http_code} %{time_total}' -X "$0" "$@"; ` +
    `echo; echo '<<<H'; cat /tmp/h.$$ 2>/dev/null; echo '<<<B'; cat /tmp/b.$$ 2>/dev/null; rm -f /tmp/h.$$ /tmp/b.$$`;
  const args = ['sh', '-c', script, method];
  if (user) args.push('-u', user);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  let input;
  if (body !== undefined) {
    input = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', '@-');
  }
  args.push(url);
  return { args, input };
}

/** Lee la salida de `build`: `{ status, timeSeconds, headers, raw, body }`; status 0 si no hubo respuesta. */
export function parseCurlOutput(out) {
  const text = String(out);
  const nl = text.indexOf('\n');
  const [code, time] = text.slice(0, nl < 0 ? undefined : nl).trim().split(' ');
  const h = text.indexOf('<<<H\n');
  const b = text.indexOf('<<<B\n');
  const headersRaw = h >= 0 && b > h ? text.slice(h + 5, b) : '';
  const raw = b >= 0 ? text.slice(b + 5) : '';
  // Con redirecciones o 100-continue hay varios bloques: vale el último.
  const blocks = headersRaw.split(/\r?\n\r?\n/).filter((x) => x.trim());
  const headers = {};
  for (const line of (blocks.at(-1) ?? '').split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(code) || 0, timeSeconds: Number(time) || 0, headers, raw, body: raw === '' ? null : tryJson(raw) };
}

export function toolRequest(rt, tool, req) {
  const { args, input } = build(req);
  const r = rt.exec(tool, args, input !== undefined ? { input } : {});
  return { ...parseCurlOutput(r.stdout), error: r.status !== 0 ? r.stderr : null };
}

export async function toolRequestAsync(rt, tool, req) {
  const { args, input } = build(req);
  const r = await rt.execAsync(tool, args, input !== undefined ? { input } : {});
  return { ...parseCurlOutput(r.stdout), error: r.status !== 0 ? r.stderr : null };
}

// ── varias peticiones A LA VEZ ───────────────────────────────────────────────────────────────
// Una sonda de concurrencia solo mide si sus peticiones llegan al legacy juntas. Un `exec` por
// petición no lo consigue: arrancar el exec cuesta más que la petición, así que llegan en serie y la
// carrera no se ve nunca (medido en shop-api: 10/10 un único desenlace; con un solo curl, 10/10 la
// carrera). Por eso todas salen de UN curl con -Z --parallel-immediate dentro del contenedor de
// herramientas. Los cuerpos se dejan antes en archivos (fuera de la ventana de la carrera) y cada
// transferencia escribe sus cabeceras y su cuerpo en los suyos.

const tmp = (token, i, ext) => `/tmp/kr-${token}-${i}.${ext}`;

/** El argv del curl paralelo: opciones globales y una transferencia por petición, separadas por --next. */
export function buildParallel(reqs, token) {
  const n = reqs.length;
  // el volcado no lleva nada de la petición: solo números y el token, que es hexadecimal
  const dump = Array.from({ length: n }, (_, i) => `echo '<<<R ${i}'; cat ${tmp(token, i, 'h')} 2>/dev/null; echo '<<<B'; cat ${tmp(token, i, 'b')} 2>/dev/null; echo`).join('; ');
  const script = `curl -s -Z --parallel-immediate --parallel-max ${n} "$@"; status=$?; ${dump}; rm -f /tmp/kr-${token}-*; exit $status`;
  const args = ['sh', '-c', script, 'curl'];
  reqs.forEach(({ method = 'GET', url, headers = {}, body, user, timeoutSeconds = 15 }, i) => {
    if (i > 0) args.push('--next');
    args.push('-m', String(Number(timeoutSeconds)), '-D', tmp(token, i, 'h'), '-o', tmp(token, i, 'b'), '-X', method);
    if (user) args.push('-u', user);
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    if (body !== undefined) {
      if (typeof body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) args.push('-H', 'Content-Type: application/json');
      args.push('--data-binary', `@${tmp(token, i, 'in')}`);
    }
    args.push(url);
  });
  return args;
}

/** Lee el volcado de `buildParallel`: una respuesta por petición, en el orden de las peticiones. */
export function parseParallelOutput(out, n) {
  const text = String(out);
  return Array.from({ length: n }, (_, i) => {
    const start = text.indexOf(`<<<R ${i}\n`);
    if (start < 0) return { status: 0, timeSeconds: 0, headers: {}, raw: '', body: null };
    const end = text.indexOf(`<<<R ${i + 1}\n`, start);
    const block = text.slice(start + `<<<R ${i}\n`.length, end < 0 ? undefined : end);
    const b = block.indexOf('<<<B\n');
    const headersRaw = b >= 0 ? block.slice(0, b) : block;
    const raw = (b >= 0 ? block.slice(b + 5) : '').replace(/\n$/, '');
    const blocks = headersRaw.split(/\r?\n\r?\n/).filter((x) => x.trim());
    const last = (blocks.at(-1) ?? '').split(/\r?\n/);
    const headers = {};
    for (const line of last.slice(1)) {
      const k = line.indexOf(':');
      if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
    }
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(last[0] ?? '')?.[1]) || 0;
    return { status, timeSeconds: 0, headers, raw, body: raw === '' ? null : tryJson(raw) };
  });
}

/** Las peticiones a la vez desde el contenedor de herramientas, en un solo curl. */
export async function toolRequestsParallel(rt, tool, reqs) {
  const token = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
  for (const [i, r] of reqs.entries()) {
    if (r.body === undefined) continue;
    const staged = rt.exec(tool, ['sh', '-c', `cat > ${tmp(token, i, 'in')}`], { input: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
    if (staged.status !== 0) return reqs.map(() => ({ status: 0, timeSeconds: 0, headers: {}, raw: '', body: null, error: `no se pudo dejar el cuerpo en el contenedor: ${staged.stderr}` }));
  }
  const r = await rt.execAsync(tool, buildParallel(reqs, token));
  // curl sale con el código del último fallo: una transferencia sin respuesta lleva status 0 y el error
  return parseParallelOutput(r.stdout, reqs.length).map((x) => ({ ...x, error: x.status === 0 ? r.stderr || `curl salió con ${r.status}` : null }));
}

export function keepHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => KEPT_HEADERS.includes(k)));
}
