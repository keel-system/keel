// MongoDB desde dentro de su contenedor: lo que el juez y el ejecutor de sondas le preguntan a la
// base del legacy. El shell es `mongosh` en las imágenes modernas y `mongo` en las antiguas (3.x,
// 4.x), y no hablan igual: el moderno escribe Extended JSON con EJSON y el antiguo solo sabe
// `tojson`, que no es JSON (`ObjectId("…")`, `ISODate("…")`). Las dos salidas se traducen aquí al
// mismo JSON plano, con funciones puras.

export const SNAPSHOT_ARCHIVE = '/tmp/recover-snapshot.archive';

function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * `{ ok, value (última línea), out (todo stdout) }` o `{ ok: false, error }`. `auth` para una base con
 * credenciales (la del servicio regenerado; los sandboxes del legacy no las llevan).
 */
export function mongoEval(rt, db, js, { auth = null } = {}) {
  const creds = auth ? ['-u', auth.user, '-p', auth.password, '--authenticationDatabase', auth.authDb ?? 'admin'] : [];
  for (const shell of ['mongosh', 'mongo']) {
    const r = rt.exec(db, [shell, '--quiet', ...creds, '--eval', js]);
    if (r.status === 0) return { ok: true, value: r.stdout.trim().split(/\r?\n/).pop(), out: r.stdout };
    if (!/not found|no such file|executable file|exec failed/i.test(r.stderr + r.stdout)) return { ok: false, error: tail(r.stderr || r.stdout) };
  }
  return { ok: false, error: 'ni mongosh ni mongo en el contenedor de la base' };
}

const dbRef = (name) => `db.getSiblingDB(${JSON.stringify(name)})`;

/** dbHash cambia con cualquier escritura y existe desde los Mongo 3.x. */
export function dbHash(rt, db, name) {
  return mongoEval(rt, db, `print(${dbRef(name)}.runCommand({dbHash: 1}).md5)`);
}

// Imprime con una marca qué shell escribió, para traducir cada salida con su regla.
const PRINT_DOC = (expr) =>
  `var __r = ${expr}; if (typeof EJSON !== 'undefined') print('@@EJSON ' + EJSON.stringify(__r, null, 0, {relaxed: true})); else print('@@TOJSON ' + tojson(__r, '', true));`;

/** Todas las colecciones (sin las de sistema), ordenadas por `_id`, como JSON plano. */
export function exportDb(rt, db, name) {
  const r = mongoEval(
    rt,
    db,
    PRINT_DOC(`(function(){ var d = ${dbRef(name)}, out = {}; d.getCollectionNames().sort().forEach(function(c){ if (c.indexOf('system.') !== 0) out[c] = d.getCollection(c).find().sort({_id: 1}).toArray(); }); return out; })()`)
  );
  if (!r.ok) return r;
  try {
    return { ok: true, value: parseShellDoc(r.out) };
  } catch (err) {
    return { ok: false, error: `la salida del shell no se pudo leer: ${err.message}` };
  }
}

/** Traduce la salida de PRINT_DOC (la línea marcada) a JSON plano. */
export function parseShellDoc(out) {
  const line = String(out)
    .split(/\r?\n/)
    .find((l) => l.startsWith('@@EJSON ') || l.startsWith('@@TOJSON '));
  if (!line) throw new Error('sin la línea marcada');
  if (line.startsWith('@@EJSON ')) return fromExtendedJson(JSON.parse(line.slice(8)));
  return JSON.parse(tojsonToJson(line.slice(9)));
}

/** Extended JSON relajado → JSON plano: los ids y las fechas como texto, los números como número. */
export function fromExtendedJson(v) {
  if (Array.isArray(v)) return v.map(fromExtendedJson);
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const [k] = keys;
    const x = v[k];
    if (k === '$oid') return x;
    if (k === '$date') return typeof x === 'object' ? (x.$numberLong ? new Date(Number(x.$numberLong)).toISOString() : x) : x;
    if (k === '$numberLong' || k === '$numberInt' || k === '$numberDouble') return Number(x);
    if (k === '$numberDecimal') return x;
    if (k === '$binary') return typeof x === 'object' ? x.base64 : x;
    if (k === '$uuid') return x;
    if (k === '$timestamp') return `${x.t}:${x.i}`;
    if (k === '$regularExpression') return `/${x.pattern}/${x.options}`;
  }
  if (keys.length === 2 && keys.includes('$ref') && keys.includes('$id')) return { $ref: v.$ref, $id: fromExtendedJson(v.$id) };
  return Object.fromEntries(keys.map((k) => [k, fromExtendedJson(v[k])]));
}

/** `tojson` del shell antiguo → JSON (regla del inc. 1, `tools/probe.mjs`). */
export function tojsonToJson(text) {
  return String(text)
    .replace(/DBRef\("([^"]+)", (?:ObjectId\()?"([^"]+)"\)?\)/g, '{"$$ref":"$1","$$id":"$2"}')
    .replace(/ObjectId\("([0-9a-f]{24})"\)/g, '"$1"')
    .replace(/ISODate\("([^"]+)"\)/g, '"$1"')
    .replace(/NumberLong\("?(-?\d+)"?\)/g, '$1')
    .replace(/NumberInt\((-?\d+)\)/g, '$1')
    .replace(/NumberDecimal\("([^"]+)"\)/g, '"$1"')
    .replace(/BinData\(\d+,\s*"([^"]*)"\)/g, '"$1"')
    .replace(/UUID\("([^"]+)"\)/g, '"$1"')
    .replace(/Timestamp\((\d+),\s*(\d+)\)/g, '"$1:$2"');
}

/** El estado de partida de las sondas: el volcado y su huella, para comprobar cada restauración. */
export function takeSnapshot(rt, db, name) {
  const hash = dbHash(rt, db, name);
  if (!hash.ok) return { ok: false, error: hash.error };
  const r = rt.exec(db, ['mongodump', '--quiet', `--db=${name}`, `--archive=${SNAPSHOT_ARCHIVE}`]);
  return r.status === 0 ? { ok: true, where: `${db}:${SNAPSHOT_ARCHIVE}`, hash: hash.value } : { ok: false, error: tail(r.stderr || r.stdout) };
}

/**
 * ¿Sigue el snapshot de verify en el contenedor de la base? Vive en su /tmp, así que recrear el sandbox lo pierde, y sin
 * comprobarlo antes cada sonda o flujo fallaba por su cuenta con «mongorestore salió con 1».
 */
export function hasSnapshot(rt, db) {
  return rt.exec(db, ['test', '-s', SNAPSHOT_ARCHIVE]).status === 0;
}

export const NO_SNAPSHOT = (db, sandboxRel) =>
  `no hay snapshot en ${db}:${SNAPSHOT_ARCHIVE} (se pierde al recrear el sandbox): vuelve a pasar keel-recover verify ${sandboxRel} --no-up`;

/** Vuelve la base al snapshot: lo que creó la sonda anterior (colecciones incluidas) desaparece. */
export function restoreSnapshot(rt, db, name) {
  const drop = mongoEval(rt, db, `${dbRef(name)}.dropDatabase()`);
  if (!drop.ok) return drop;
  const r = rt.exec(db, ['mongorestore', '--quiet', '--drop', `--archive=${SNAPSHOT_ARCHIVE}`]);
  return r.status === 0 ? { ok: true } : { ok: false, error: `mongorestore salió con ${r.status} sobre ${SNAPSHOT_ARCHIVE}${tail(r.stderr || r.stdout) ? `: ${tail(r.stderr || r.stdout)}` : ''}` };
}

/**
 * Vacía todas las colecciones (sin las de sistema) y cuenta lo que queda: lo que necesita la paridad
 * para que cada flujo parta de la base vacía del regenerado. `{ ok, remaining }` o `{ ok: false, error }`.
 */
export function emptyDatabase(rt, db, name, { auth = null } = {}) {
  const js = `var d = ${dbRef(name)}; var cs = d.getCollectionNames().filter(function (c) { return c.indexOf('system.') !== 0; }); cs.forEach(function (c) { d[c].deleteMany({}); }); print(cs.reduce(function (n, c) { return n + d[c].countDocuments({}); }, 0));`;
  const r = mongoEval(rt, db, js, { auth });
  return r.ok ? { ok: true, remaining: r.value } : r;
}

/** Lo que cambió en la base entre dos exportaciones, por `_id`. */
export function dbDiff(before, after) {
  const diff = {};
  for (const c of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const b = new Map((before?.[c] ?? []).map((d) => [JSON.stringify(d._id), d]));
    const a = new Map((after?.[c] ?? []).map((d) => [JSON.stringify(d._id), d]));
    const added = [...a].filter(([k]) => !b.has(k)).map(([, d]) => d);
    const removed = [...b].filter(([k]) => !a.has(k)).map(([, d]) => d);
    const changed = [...a].filter(([k, d]) => b.has(k) && JSON.stringify(b.get(k)) !== JSON.stringify(d)).map(([k, d]) => ({ before: b.get(k), after: d }));
    if (added.length || removed.length || changed.length) diff[c] = { added, removed, changed };
  }
  return diff;
}

// Las columnas de estado se reconocen por su forma, no por su nombre: texto, en todos los
// documentos que la tienen, con pocos valores distintos.
export const ENUM_MAX_VALUES = 12;

/**
 * Paso 1a, datos: colecciones con su número de documentos, índices (con `unique`), los campos de
 * primer nivel con sus tipos y, para los de texto con pocos valores distintos, esos valores.
 */
export function introspectDb(rt, db, name) {
  const js = `(function(){
    var d = ${dbRef(name)}, out = [];
    d.getCollectionNames().sort().forEach(function(c){
      if (c.indexOf('system.') === 0) return;
      var col = d.getCollection(c), fields = {}, values = {}, n = 0;
      col.find().limit(5000).forEach(function(doc){
        n++;
        Object.keys(doc).forEach(function(k){
          var v = doc[k], t = v === null ? 'null' : Array.isArray(v) ? 'array' : (v instanceof Date ? 'date' : (v && v._bsontype ? v._bsontype.toLowerCase() : typeof v));
          fields[k] = fields[k] || {}; fields[k][t] = true;
          if (typeof v === 'string') { values[k] = values[k] || {}; if (Object.keys(values[k]).length <= ${ENUM_MAX_VALUES}) values[k][v] = true; }
        });
      });
      out.push({ name: c, count: (col.countDocuments ? col.countDocuments({}) : col.count()), sampled: n, indexes: col.getIndexes().map(function(i){ var x = { name: i.name, key: i.key }; if (i.unique) x.unique = true; if (i.sparse) x.sparse = true; if (i.expireAfterSeconds !== undefined) x.expireAfterSeconds = i.expireAfterSeconds; return x; }),
        fields: Object.keys(fields).sort().map(function(k){ return { name: k, types: Object.keys(fields[k]).sort() }; }),
        values: Object.keys(values).sort().map(function(k){ return { field: k, values: Object.keys(values[k]).sort() }; }) });
    });
    return out;
  })()`;
  const r = mongoEval(rt, db, PRINT_DOC(js));
  if (!r.ok) return r;
  let collections;
  try {
    collections = parseShellDoc(r.out);
  } catch (err) {
    return { ok: false, error: `la salida del shell no se pudo leer: ${err.message}` };
  }
  return { ok: true, value: collections.map(shapeCollection) };
}

/** Qué campos de texto parecen una columna de estado: pocos valores y en más de un documento. */
export function shapeCollection(c) {
  const out = { name: c.name, count: Number(c.count), indexes: c.indexes, fields: c.fields };
  const enums = (c.values ?? []).filter((v) => v.values.length > 0 && v.values.length <= ENUM_MAX_VALUES && Number(c.sampled) > 1 && v.field !== '_id' && v.values.length < Number(c.sampled));
  if (enums.length) out.enums = enums;
  return out;
}
