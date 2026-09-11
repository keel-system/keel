// Escritura y comparación de archivos **generados** (contenido en memoria), la
// contraparte de copy.js —que trabaja sobre un árbol de assets en disco—. Los
// artefactos de harness no son copias: se proyectan desde una fuente neutral, así
// que ni copyTree ni diffTree pueden verlos.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Escribe `[{ path, content }]` dentro de destDir con el mismo contrato que
 * copyTree(): sin force, lo que ya existe se deja intacto y se reporta como
 * omitido; `preserve` son rutas que no se pisan **ni con force**.
 *
 * Devuelve rutas relativas a destDir con separador POSIX, para mostrar.
 */
export function writeFiles(files, destDir, { force = false, preserve = [] } = {}) {
  const untouchable = new Set(preserve);
  const copied = [];
  const skipped = [];
  const preserved = [];

  for (const { path: relative, content } of files) {
    const target = path.join(destDir, relative);
    const exists = fs.existsSync(target);
    if (exists && untouchable.has(relative)) {
      preserved.push(relative);
      continue;
    }
    if (exists && !force) {
      skipped.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    copied.push(relative);
  }

  return { copied, skipped, preserved };
}

/**
 * Compara `[{ path, content }]` con lo que hay en destDir, sin escribir nada.
 * Mismo resultado que diffTree(): `stale` existe pero difiere, `missing` no existe.
 * `ignore` son rutas que el destino tiene derecho a reescribir.
 */
export function diffGenerated(files, destDir, { ignore = [] } = {}) {
  const ignored = new Set(ignore);
  const stale = [];
  const missing = [];

  for (const { path: relative, content } of files) {
    if (ignored.has(relative)) continue;
    const target = path.join(destDir, relative);
    if (!fs.existsSync(target)) missing.push(relative);
    else if (fs.readFileSync(target, 'utf8') !== content) stale.push(relative);
  }

  return { stale, missing };
}

// ─── Propagar un arreglo del generador a un proyecto ya generado ─────────────
//
// `diffGenerated` compara CONTENIDO, y eso basta para un payload estático: en un
// workspace de diseño cualquier diferencia contra el asset es deriva. En un proyecto
// GENERADO no basta, y la razón es exacta: ahí «diferente del stub» es lo esperado en
// cuanto el agente completa los `TODO (agente)`. Un archivo que difiere de lo que el
// generador emite hoy puede serlo porque el GENERADOR cambió o porque el AGENTE lo
// escribió, y comparando contenidos no se distingue.
//
// Tampoco vale una lista de «archivos del agente»: el generador deja los huecos DENTRO
// de archivos por lo demás completos, así que la propiedad no es del archivo.
//
// Lo que falta es la dimensión que ninguna comparación de contenido tiene: qué escribió
// el generador la última vez. Con ese registro, «¿lo tocó alguien?» pasa a ser una
// pregunta contestable, y con ella se puede refrescar lo suyo sin pisar lo ajeno.

import crypto from 'node:crypto';

/** Ruta relativa en forma POSIX, venga con el separador que venga. */
const toPosix = (relative) => relative.split(/[\\/]/).join('/');

/**
 * Huella de lo que se escribiría: el `content` en memoria, o el binario que copiaría
 * `sourceFile` (el jar del wrapper de Gradle es el caso). Se calcula sobre bytes y no
 * sobre texto para que un archivo binario no dependa de una codificación.
 */
export function digestOf(entry) {
  const bytes = entry.sourceFile ? fs.readFileSync(entry.sourceFile) : Buffer.from(entry.content ?? '', 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** La misma huella, de un archivo que ya está en disco. */
function digestOfFile(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

/**
 * Clasifica lo que se generaría contra lo que hay en disco, usando el manifiesto de lo
 * que el generador escribió la última vez. No escribe nada.
 *
 * `manifest` es `{ files: { <ruta>: <sha256> }, adopted: [<ruta>] }`, o null si el
 * proyecto es anterior al mecanismo. `adopted` son rutas cuya línea base se ADOPTÓ de un
 * proyecto que ya existía: no se sabe quién las escribió, así que se reportan y no se
 * refrescan nunca.
 *
 * Los seis cubos, y lo que significa cada uno para quien refresca:
 *
 *   · `nuevos`       — no existe: se escribe sin más.
 *   · `refrescables` — existe, su huella coincide con la del manifiesto y el generador
 *                      cambió: es suyo y nadie lo tocó, así que se puede poner al día.
 *   · `alDia`        — lo que hay ya es lo que se generaría.
 *   · `tuyos`        — lo tocaron, pero el generador NO ha cambiado: no hay nada que
 *                      propagar y el cambio es legítimo.
 *   · `conflictos`   — lo tocaron Y el generador cambió. Es el único caso que pide una
 *                      decisión humana, y el que hay que enseñar con nombre y apellidos.
 *   · `adoptados`    — sin registro de quién lo escribió.
 *
 * Aparte, `huerfanos`: rutas del manifiesto que el generador ya no emite. Aquí solo se
 * reportan. Borrarlos lo decide `pruneOrphans`, y solo cuando se puede demostrar que
 * nadie los tocó.
 */
export function classifyGenerated(files, destDir, manifest = null) {
  const registrado = new Map(Object.entries(manifest?.files ?? {}));
  const adoptado = new Set((manifest?.adopted ?? []).map(toPosix));
  const emitidas = new Set();

  const buckets = { nuevos: [], refrescables: [], alDia: [], tuyos: [], conflictos: [], adoptados: [], huerfanos: [] };

  for (const entry of files) {
    const relative = toPosix(entry.path);
    emitidas.add(relative);
    const target = path.join(destDir, entry.path);

    if (!fs.existsSync(target)) {
      buckets.nuevos.push(relative);
      continue;
    }

    const enDisco = digestOfFile(target);
    const nuevo = digestOf(entry);
    if (enDisco === nuevo) {
      buckets.alDia.push(relative);
      continue;
    }

    const previo = registrado.get(relative);
    if (adoptado.has(relative) || previo === undefined) {
      buckets.adoptados.push(relative);
    } else if (enDisco === previo) {
      buckets.refrescables.push(relative);
    } else if (previo === nuevo) {
      buckets.tuyos.push(relative);
    } else {
      buckets.conflictos.push(relative);
    }
  }

  for (const relative of registrado.keys()) {
    if (!emitidas.has(relative)) buckets.huerfanos.push(relative);
  }

  return buckets;
}

/**
 * Retira los huérfanos que se puede DEMOSTRAR que son del generador.
 *
 * Un huérfano es lo que el generador escribió y ya no emite: el controller de una
 * operación que el diseño quitó, su command, su handler. Dejarlo en su sitio no es
 * neutral, porque el endpoint sigue expuesto aunque el diseño ya no lo tenga. Pero
 * borrarlo a partir de una lista es lo que un día se lleva por delante trabajo ajeno.
 * La línea que separa las dos cosas es la misma que usa `classifyGenerated`:
 *
 *   · `borrados`    — su huella en disco es la que registró el manifiesto: nadie lo
 *                     tocó, es tan del generador como un refrescable. Se borra, y con él
 *                     los directorios que queden vacíos.
 *   · `ausentes`    — ya no está en disco: solo hay que olvidarlo.
 *   · `modificados` — alguien lo tocó. **No se borra nunca**: retirarlo es trabajo de
 *                     quien lo escribió, que sabe qué más depende de él.
 *
 * `orphans` son rutas POSIX relativas a destDir (el cubo `huerfanos`).
 */
export function pruneOrphans(orphans, destDir, manifest = null) {
  const registrado = manifest?.files ?? {};
  const result = { borrados: [], ausentes: [], modificados: [] };
  const root = path.resolve(destDir);

  for (const relative of [...orphans].map(toPosix).sort((a, b) => a.localeCompare(b))) {
    const target = path.join(destDir, relative);
    if (!fs.existsSync(target)) {
      result.ausentes.push(relative);
      continue;
    }
    if (registrado[relative] === undefined || digestOfFile(target) !== registrado[relative]) {
      result.modificados.push(relative);
      continue;
    }
    fs.rmSync(target);
    result.borrados.push(relative);

    // Los directorios que el borrado deja vacíos, hacia arriba y sin salir de destDir:
    // un paquete Java vacío no rompe nada, pero sí dice que ahí hubo algo.
    let dir = path.dirname(path.resolve(target));
    while (dir.startsWith(root) && dir !== root && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  return result;
}
