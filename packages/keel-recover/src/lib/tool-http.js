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

export function keepHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => KEPT_HEADERS.includes(k)));
}
