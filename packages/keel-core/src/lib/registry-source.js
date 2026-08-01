// Acceso al registry remoto de diseños: índice y descarga selectiva.
//
// El registry es un repositorio git servido por URLs raw, no un servicio con
// API: el índice es un archivo (`index.json`) y cada diseño son los archivos que
// ese índice enumera en su campo `files`. Descargar un diseño es traerse esa
// lista, no un tarball — así no hace falta descomprimir nada y la CLI se queda
// sin dependencias nuevas.
//
// Todo lo de red vive aquí y entra por parámetro (`fetchImpl`, `now`, `cacheDir`)
// para que los tests no toquen red ni el HOME del usuario.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { supportedDsl } from './assets.js';
import { INDEX_FILE, INDEX_SCHEMA_VERSION } from './design-index.js';

export const DEFAULT_REGISTRY_URL = `https://raw.githubusercontent.com/keel-system/keel-registry/main/${INDEX_FILE}`;

/** Un día: el registry cambia por pull request, no en tiempo real. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const REGISTRY_PREFIX = 'registry:';

export function defaultCacheDir() {
  return path.join(os.homedir(), '.keel', 'registry');
}

/** Precedencia: --source > KEEL_REGISTRY_URL > el registry oficial. */
export function resolveSourceUrl({ source, env = process.env } = {}) {
  return source || env.KEEL_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

/**
 * Raíz del registry a partir de la URL del índice: los `files` del índice son
 * rutas relativas a esa raíz.
 */
export function baseUrlOf(indexUrl) {
  const cut = indexUrl.lastIndexOf('/');
  return cut === -1 ? indexUrl : indexUrl.slice(0, cut + 1);
}

/** ¿Es una referencia al registry (`registry:<slug>`)? */
export function parseRegistryRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(REGISTRY_PREFIX)) return null;
  const slug = ref.slice(REGISTRY_PREFIX.length).trim();
  return slug === '' ? { slug: null, error: `Referencia incompleta: '${ref}'. Usa registry:<diseño> (ej. registry:catalog).` } : { slug };
}

// Una entrada de caché por URL: un registry privado y el oficial no pueden
// compartir archivo.
function cacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function cachePaths(dir, url) {
  const key = cacheKey(url);
  return { index: path.join(dir, `${key}.json`), meta: path.join(dir, `${key}.meta.json`) };
}

function readCache(dir, url) {
  const { index, meta } = cachePaths(dir, url);
  if (!fs.existsSync(index)) return null;
  try {
    return {
      text: fs.readFileSync(index, 'utf8'),
      meta: fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : {}
    };
  } catch {
    return null;
  }
}

function writeCache(dir, url, text, etag, now) {
  const { index, meta } = cachePaths(dir, url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(index, text);
  fs.writeFileSync(meta, `${JSON.stringify({ url, etag: etag ?? null, fetchedAt: now }, null, 2)}\n`);
}

/**
 * Parsea y comprueba que el índice es de un formato que esta CLI entiende.
 * Devuelve { index } o { error }.
 */
function parseIndex(text, url) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { error: `El índice de ${url} no es JSON válido — ${error.message}` };
  }
  if (typeof doc?.schemaVersion !== 'number' || !Array.isArray(doc?.designs)) {
    return { error: `El índice de ${url} no tiene la forma esperada (schemaVersion + designs).` };
  }
  if (doc.schemaVersion > INDEX_SCHEMA_VERSION) {
    return {
      error:
        `El índice de ${url} usa el formato ${doc.schemaVersion} y esta CLI entiende hasta el ${INDEX_SCHEMA_VERSION}.\n` +
        '  Actualiza keel-core para consumir este registry.'
    };
  }
  return { index: doc };
}

/**
 * Carga el índice del registry, de la red o de la caché.
 *
 * Devuelve { index, url, from: 'red'|'caché', warnings } o { error }.
 * - `offline`: solo caché; sin caché, error.
 * - `refresh`: ignora el TTL y revalida contra la red.
 * - Si la red falla y hay caché, se usa la caché con un aviso: quedarse sin
 *   índice por un corte de red sería peor que servir uno de ayer.
 */
export async function loadRegistryIndex({
  source,
  offline = false,
  refresh = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  cacheDir = defaultCacheDir(),
  now = Date.now()
} = {}) {
  const url = resolveSourceUrl({ source, env });
  const cached = readCache(cacheDir, url);
  const warnings = [];

  if (offline) {
    if (!cached) {
      return {
        error:
          `No hay copia local del registry (${url}) y --offline impide descargarlo.\n` +
          '  Ejecuta el comando sin --offline una vez, o clona el registry y usa `keel new <servicio> --from <ruta>`.'
      };
    }
    const parsed = parseIndex(cached.text, url);
    return parsed.error ? parsed : { index: parsed.index, url, from: 'caché', warnings };
  }

  const fresh = cached?.meta?.fetchedAt != null && now - cached.meta.fetchedAt < CACHE_TTL_MS;
  if (cached && fresh && !refresh) {
    const parsed = parseIndex(cached.text, url);
    if (!parsed.error) return { index: parsed.index, url, from: 'caché', warnings };
    // Caché corrupta: no es motivo para fallar, se vuelve a la red.
  }

  if (typeof fetchImpl !== 'function') {
    return { error: `Esta versión de Node no trae fetch y no se puede descargar el registry (${url}).` };
  }

  let response;
  try {
    const headers = {};
    if (cached?.meta?.etag) headers['If-None-Match'] = cached.meta.etag;
    response = await fetchImpl(url, { headers });
  } catch (error) {
    if (cached) {
      warnings.push(`No se pudo contactar con ${url} (${error.message}); se usa la copia local.`);
      const parsed = parseIndex(cached.text, url);
      return parsed.error ? parsed : { index: parsed.index, url, from: 'caché', warnings };
    }
    return { error: `No se pudo descargar el registry (${url}) — ${error.message}` };
  }

  if (response.status === 304 && cached) {
    writeCache(cacheDir, url, cached.text, cached.meta?.etag, now);
    const parsed = parseIndex(cached.text, url);
    return parsed.error ? parsed : { index: parsed.index, url, from: 'caché', warnings };
  }

  if (!response.ok) {
    if (cached) {
      warnings.push(`${url} respondió ${response.status}; se usa la copia local.`);
      const parsed = parseIndex(cached.text, url);
      return parsed.error ? parsed : { index: parsed.index, url, from: 'caché', warnings };
    }
    return { error: `No se pudo descargar el registry (${url}) — HTTP ${response.status}.` };
  }

  const text = await response.text();
  const parsed = parseIndex(text, url);
  if (parsed.error) return parsed;

  try {
    writeCache(cacheDir, url, text, response.headers?.get?.('etag'), now);
  } catch (error) {
    warnings.push(`No se pudo guardar la caché del registry (${error.message}).`);
  }

  return { index: parsed.index, url, from: 'red', warnings };
}

/**
 * ¿Entiende esta CLI el DSL con el que se escribió el diseño?
 *
 * - `ok`: la versión está entre las soportadas.
 * - `incompatible`: el diseño usa un DSL que esta CLI no acepta. Derivarlo
 *   produciría un workspace que `keel validate` rechaza (el enum del schema del
 *   manifiesto es el mismo que alimenta `supportedDsl()`), así que es un error
 *   al derivar. Cubre las dos direcciones: la versión puede ser más nueva que
 *   esta CLI o más vieja que lo que ya acepta — con una sola versión soportada,
 *   lo segundo es lo habitual.
 * - `desconocida`: el índice no declara la versión — se avisa, no se bloquea.
 */
export function dslSupport(design, { supported = supportedDsl() } = {}) {
  const dsl = design?.service?.dsl;
  if (typeof dsl !== 'string' || dsl === '') return 'desconocida';
  return supported.includes(dsl) ? 'ok' : 'incompatible';
}

/**
 * Mensaje accionable para un diseño con DSL no soportado, con la misma forma que
 * el gate de compatibilidad de los generadores (`keel-spring build`).
 *
 * La salida depende de la dirección: actualizar la CLI solo arregla el caso de un
 * diseño escrito con un DSL más nuevo. Si el diseño es de una versión anterior,
 * actualizar no sirve de nada y el consejo sería una pista falsa.
 */
export function dslMismatchMessage(design, { supported = supportedDsl() } = {}) {
  const dsl = design.service?.dsl;
  const masNuevo = typeof dsl === 'string' && supported.every((version) => compareDsl(dsl, version) > 0);
  const salida = masNuevo
    ? '  Actualiza keel-core para poder derivarlo (`npm i -g keel-core@latest`).'
    : '  Es una versión anterior a la que esta CLI acepta: hay que migrar el diseño al DSL vigente.';

  return `El diseño '${design.slug}' usa el DSL keel ${dsl} y esta CLI soporta: ${supported.join(', ')}.\n${salida}`;
}

/** Orden numérico de dos versiones `mayor.menor` del DSL. */
function compareDsl(a, b) {
  const [aMayor, aMenor] = String(a).split('.').map(Number);
  const [bMayor, bMenor] = String(b).split('.').map(Number);
  return aMayor !== bMayor ? aMayor - bMayor : aMenor - bMenor;
}

/** Busca un diseño por slug. Devuelve { design } o { error } con sugerencias. */
export function findDesign(index, slug) {
  const design = index.designs.find((entry) => entry.slug === slug);
  if (design) return { design };

  const family = index.families?.find((entry) => entry.name === slug);
  if (family && family.designs.length > 0) {
    return {
      error:
        `'${slug}' es una familia con ${family.designs.length} variante(s), no un diseño. Elige una:\n` +
        family.designs.map((name) => `    registry:${name}`).join('\n')
    };
  }

  const similar = index.designs
    .map((entry) => entry.slug)
    .filter((name) => name.includes(slug) || slug.includes(name))
    .slice(0, 5);
  return {
    error:
      `No existe el diseño '${slug}' en el registry.` +
      (similar.length > 0 ? `\n  ¿Quisiste decir?\n${similar.map((name) => `    registry:${name}`).join('\n')}` : '') +
      '\n  Lista los diseños disponibles con `keel registry`.'
  };
}

/** Filtra por slug, familia, variante, tags, dominio, resumen y descripción. */
export function searchDesigns(index, term) {
  const needle = term.trim().toLowerCase();
  return index.designs.filter((design) => {
    const haystack = [
      design.slug,
      design.family,
      design.variant,
      design.service?.domain,
      design.service?.description,
      design.metadata?.summary,
      design.metadata?.differsIn,
      ...(design.metadata?.tags ?? [])
    ];
    return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
  });
}

/**
 * Descarga los artefactos del diseño a un directorio temporal con dos ramas:
 *
 * - `<root>/spec/` — los `specs/<slug>/`, con los nombres planos que espera un
 *   directorio de servicio: es lo que consume la derivación.
 * - `<root>/docs/` — los derivados publicados (`DESIGN.md`, `openapi.yaml`,
 *   `overview.html`, `postman/`…), relativos a `docs/<servicio>/`. Los usa
 *   **adoptar** (`keel registry get`), que los deja en `docs/<slug>/` como
 *   derivados al día del servicio. Derivar pasa `docs: false`: los del origen
 *   describen al servicio del origen y se regeneran al cerrar el derivado.
 *
 * Un fallo descargando el spec es fatal (sin manifiesto no hay diseño); un
 * fallo descargando un derivado solo suma un aviso: perder la derivación entera
 * porque falta un `DESIGN.md` sería peor que quedarse sin él.
 *
 * Devuelve { root, dir, files, docsDir, docsFiles, warnings } o { error }.
 * Quien llama es responsable de borrar `root`.
 */
export async function downloadDesign(design, { indexUrl, fetchImpl = globalThis.fetch, tmpRoot = os.tmpdir(), docs = true }) {
  const prefix = `specs/${design.slug}/`;
  const all = design.files ?? [];
  const wanted = all.filter((file) => file.startsWith(prefix));

  if (!wanted.some((file) => file.endsWith('/service.keel.yaml'))) {
    return { error: `El índice del registry no lista el manifiesto de '${design.slug}': no se puede derivar.` };
  }

  const base = baseUrlOf(indexUrl);
  const root = fs.mkdtempSync(path.join(tmpRoot, 'keel-registry-'));
  const dir = path.join(root, 'spec');
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  const written = [];
  const docsWritten = [];
  const warnings = [];

  const fetchText = async (file) => {
    const url = `${base}${file}`;
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      return { error: `No se pudo descargar ${file} — ${error.message}` };
    }
    if (!response.ok) {
      return { error: `No se pudo descargar ${file} — HTTP ${response.status} en ${url}` };
    }
    return { text: await response.text() };
  };

  for (const file of wanted) {
    const result = await fetchText(file);
    if (result.error) {
      fs.rmSync(root, { recursive: true, force: true });
      return { error: result.error };
    }
    const target = path.join(dir, file.slice(prefix.length));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.text);
    written.push(file);
  }

  if (docs) {
    for (const file of all) {
      const relative = docsTargetOf(file, prefix);
      if (!relative) continue;
      const result = await fetchText(file);
      if (result.error) {
        warnings.push(result.error);
        continue;
      }
      const target = path.join(docsDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, result.text);
      docsWritten.push(file);
    }
  }

  return { root, dir, files: written, docsDir, docsFiles: docsWritten, warnings };
}

/**
 * Ruta de un archivo del índice dentro de la rama de docs, relativa a
 * `docs/<servicio>/`, o null si no es un derivado de ahí. Conservan su subruta
 * para que `postman/<n>-collection.json` siga en su carpeta.
 *
 * `validation-scenarios.md` **no** entra aquí aunque sea un derivado: vive en el
 * directorio del servicio y viaja por la rama del spec. Duplicarlo dejaría un
 * `docs/<servicio>/validation-scenarios.md` que `listDerivatives()` no espera.
 */
function docsTargetOf(file, specPrefix) {
  if (file.startsWith(specPrefix) || !file.startsWith('docs/')) return null;
  const rest = file.slice('docs/'.length);
  const cut = rest.indexOf('/');
  return cut === -1 ? null : rest.slice(cut + 1);
}
