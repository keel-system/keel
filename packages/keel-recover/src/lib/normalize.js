// La normalización de una grabación (paso 1b): lo que cambia entre dos ejecuciones idénticas de la
// misma sonda se sustituye por una marca, para que comparar grabaciones compare comportamiento. Del
// inc. 1: con estas reglas, dos ejecuciones de la misma ronda dieron 22 de 24 grabaciones
// idénticas, y las 2 restantes eran de concurrencia (su desenlace es una distribución).
//
//   - un JWT se identifica por sus claims sin `iat`/`exp`: dos tokens del mismo usuario emitidos en
//     segundos distintos son el mismo token a efectos de comportamiento;
//   - uuid y ObjectId se etiquetan por orden de aparición (<oid#1>, <oid#2>…): lo que importa es
//     qué valores son el mismo, no cuáles son;
//   - las fechas y los epoch en milisegundos se borran, menos la fecha cero de MySQL (`0000-00-00T00:00:00`):
//     es el «sin fecha» del legacy, la misma en cada ejecución, y borrarla esconde cuándo el flujo la rellena;
//   - las claves de medida de la herramienta (`_timeSeconds`, `_timestamp`) no se tocan y no se
//     comparan. Es una lista cerrada y no «todo lo que empiece por `_`»: el `_id` de MongoDB es
//     justo lo que más hay que normalizar;
//   - el valor de la cabecera `set-cookie` se etiqueta como un uuid (<cookie#1>): un id de sesión cambia en cada login;
//   - el legacy añade sus reglas en sandbox.yaml (`probe.normalize`): lo aleatorio de su framework.

/** Lo que se graba pero no se compara entre dos ejecuciones. */
export const UNCOMPARED = new Set(['_timeSeconds', '_timestamp']);

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OID = /\b[0-9a-f]{24}\b/g;
const DATE = /(?!0000-00-00T00:00:00)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_MS = /\b1[6-9]\d{11}\b/g;
const EPOCH_MS_NUMBER = /^1[6-9]\d{11}$/;

export function normalizer(extra = []) {
  const seen = new Map();
  const counts = new Map();
  const tag = (kind, v) => {
    const key = `${kind}\u0000${v}`;
    if (!seen.has(key)) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      seen.set(key, `<${kind}#${n}>`);
    }
    return seen.get(key);
  };
  const rules = [
    [
      JWT,
      (m) => {
        let claims = m;
        try {
          const { iat, exp, nbf, ...rest } = JSON.parse(Buffer.from(m.split('.')[1], 'base64url').toString());
          claims = JSON.stringify(rest);
        } catch {
          /* no es un JWT decodificable: se etiqueta tal cual */
        }
        return tag('jwt', claims);
      },
    ],
    [UUID, (m) => tag('uuid', m.toLowerCase())],
    [OID, (m) => tag('oid', m)],
    [DATE, () => '<date>'],
    [EPOCH_MS, () => '<epoch-ms>'],
    ...extra.map(({ pattern, replace }) => [new RegExp(pattern, 'g'), (m) => (replace === 'tag' ? tag('v', m) : replace)]),
  ];
  const str = (s) => rules.reduce((acc, [re, fn]) => acc.replace(re, fn), s);
  // el valor de una cookie que fija la respuesta (el id de sesión) es aleatorio; su nombre y sus atributos, no
  const cookie = (s) => s.replace(/^([^=;\s]+)=([^;]*)/, (_, name, value) => `${name}=${value === '' ? '' : tag('cookie', value)}`);
  const walk = (v) => {
    if (typeof v === 'string') return str(v);
    if (typeof v === 'number' && EPOCH_MS_NUMBER.test(String(v))) return '<epoch-ms>';
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, UNCOMPARED.has(k) ? x : k === 'set-cookie' && typeof x === 'string' ? str(cookie(x)) : walk(x)]));
    return v;
  };
  return walk;
}

/** Copia sin las claves de medida: lo que se compara entre dos grabaciones. */
export function comparable(v) {
  if (Array.isArray(v)) return v.map(comparable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !UNCOMPARED.has(k)).map(([k, x]) => [k, comparable(x)]));
  return v;
}
