// Inventario de los derivados de un diseño y su frescura.
//
// Un derivado (escenarios, DESIGN.md, contratos formales, panel, INTEGRATION.md)
// nace del spec y lleva estampado el `service.version` del que salió. Comparar
// ese sello con el del manifiesto es lo único mecánico que puede decir si un
// derivado quedó atrás tras editar el diseño; el resto —regenerarlos en orden—
// lo orquesta la skill /keel-evolve.
//
// Allowlist explícita, nunca barrido del directorio: en docs/<servicio>/ conviven
// artefactos de tres skills distintas y ficheros que el equipo pueda dejar ahí.

import fs from 'node:fs';
import path from 'node:path';
import { loadService } from './loader.js';
import { SCENARIOS_FILE } from './spec-files.js';

// Cuántos bytes se leen de cada archivo: el sello vive siempre en la cabecera.
const HEAD_BYTES = 4096;

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * `> specs/<servicio> v1.2.0. …` bajo el título (validation-scenarios.md,
 * DESIGN.md). La versión va seguida de prosa, así que se acota a semver en
 * lugar de tragarse hasta el siguiente espacio.
 */
function stampFromBlockquote(file) {
  const head = readHead(file);
  return head?.match(/^>\s*specs\/\S+\s+v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/m)?.[1] ?? null;
}

/** `version:` dentro del bloque `info:` (openapi.yaml, asyncapi.yaml). */
function stampFromInfoVersion(file) {
  const head = readHead(file);
  if (!head) return null;
  const lines = head.split(/\r?\n/);
  const start = lines.findIndex((line) => /^info:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // se acabó el bloque info
    const match = line.match(/^\s+version:\s*["']?([^"'\s#]+)/);
    if (match) return match[1];
  }
  return null;
}

/** `<!-- keel:version 1.2.0 -->` (overview.html y los visores). */
function stampFromHtmlComment(file) {
  const head = readHead(file);
  return head?.match(/<!--\s*keel:version\s+(\S+?)\s*-->/)?.[1] ?? null;
}

/** `version:` del front-matter YAML (INTEGRATION.md). */
function stampFromFrontMatter(file) {
  const head = readHead(file);
  if (!head?.startsWith('---')) return null;
  const body = head.slice(3).split(/\r?\n---/)[0];
  return body?.match(/^version:\s*["']?([^"'\s#]+)/m)?.[1] ?? null;
}

/** Variable de colección `keelVersion` (colección Postman del servicio). */
function stampFromPostman(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const variable = Array.isArray(doc?.variable)
    ? doc.variable.find((entry) => entry?.key === 'keelVersion')
    : null;
  return typeof variable?.value === 'string' && variable.value !== '' ? variable.value : null;
}

function hasM2mSurface(layers) {
  const api = layers.api;
  const defaultAudience = api?.defaultAudience ?? 'users';
  const endpoints = api?.endpoints && typeof api.endpoints === 'object' ? Object.values(api.endpoints) : [];
  const m2m = endpoints.some((endpoint) => {
    const audience = endpoint?.audience ?? defaultAudience;
    return audience === 'services' || audience === 'both';
  });
  if (m2m) return true;
  if (api && endpoints.length === 0 && (defaultAudience === 'services' || defaultAudience === 'both')) return true;

  const messaging = layers.messaging;
  const published = messaging?.publishing?.events;
  const subscriptions = messaging?.subscriptions;
  return Object.keys(published ?? {}).length > 0 || Object.keys(subscriptions ?? {}).length > 0;
}

/**
 * Catálogo de derivados. `applies(layers)` decide si el derivado procede para
 * este diseño; `stamp(file)` extrae la versión que lleva estampada.
 */
const CATALOG = [
  {
    id: 'validation-scenarios',
    producer: '/keel-design',
    location: 'service',
    file: () => SCENARIOS_FILE,
    stamp: stampFromBlockquote
  },
  {
    id: 'design',
    producer: '/keel-handoff',
    location: 'docs',
    file: () => 'DESIGN.md',
    stamp: stampFromBlockquote
  },
  {
    id: 'openapi',
    producer: '/keel-docs',
    location: 'docs',
    file: () => 'openapi.yaml',
    applies: (layers) => 'api' in layers,
    reason: 'sin capa api',
    stamp: stampFromInfoVersion
  },
  {
    id: 'openapi-viewer',
    producer: '/keel-docs',
    location: 'docs',
    file: () => 'openapi.html',
    applies: (layers) => 'api' in layers,
    reason: 'sin capa api',
    stamp: stampFromHtmlComment
  },
  {
    id: 'asyncapi',
    producer: '/keel-docs',
    location: 'docs',
    file: () => 'asyncapi.yaml',
    applies: (layers) => 'messaging' in layers,
    reason: 'sin capa messaging',
    stamp: stampFromInfoVersion
  },
  {
    id: 'asyncapi-viewer',
    producer: '/keel-docs',
    location: 'docs',
    file: () => 'asyncapi.html',
    applies: (layers) => 'messaging' in layers,
    reason: 'sin capa messaging',
    stamp: stampFromHtmlComment
  },
  {
    id: 'postman',
    producer: '/keel-docs',
    location: 'docs',
    file: (name) => path.join('postman', `${name}-collection.json`),
    applies: (layers) => 'api' in layers,
    reason: 'sin capa api',
    stamp: stampFromPostman
  },
  {
    id: 'overview',
    producer: '/keel-docs',
    location: 'docs',
    file: () => 'overview.html',
    stamp: stampFromHtmlComment
  },
  {
    id: 'integration',
    producer: '/keel-integrate',
    location: 'docs',
    file: () => 'INTEGRATION.md',
    applies: hasM2mSurface,
    reason: 'sin superficie servidor-a-servidor: ni endpoints services/both ni eventos',
    stamp: stampFromFrontMatter
  }
];

const EMPTY_COUNTS = { fresh: 0, stale: 0, unstamped: 0, missing: 0, orphan: 0, notApplicable: 0 };
const COUNT_KEYS = {
  fresh: 'fresh',
  stale: 'stale',
  unstamped: 'unstamped',
  missing: 'missing',
  orphan: 'orphan',
  'not-applicable': 'notApplicable'
};

function relative(cwd, absolute) {
  return path.relative(cwd, absolute).split(path.sep).join('/');
}

/**
 * Inventaría los derivados de un diseño y compara su sello de versión con el
 * `service.version` del manifiesto.
 *
 * Estados: `fresh` (al día), `stale` (nació de una versión anterior),
 * `unstamped` (existe pero no lleva sello — anterior a la convención),
 * `missing` (procede y nunca se generó), `orphan` (existe pero la capa que lo
 * justificaba ya no está) y `not-applicable` (no procede para este diseño).
 *
 * Devuelve { service, derivatives, counts, errors } — objeto puro, sin consola.
 */
export function listDerivatives(dir, { cwd = process.cwd() } = {}) {
  const { manifest, layers, errors = [] } = loadService(dir);

  if (!manifest) {
    return { service: null, derivatives: [], counts: { ...EMPTY_COUNTS }, errors };
  }

  const name = manifest.service?.name ?? path.basename(dir);
  const version = manifest.service?.version ?? null;
  const docsDir = path.join(cwd, 'docs', name);
  const counts = { ...EMPTY_COUNTS };

  const derivatives = CATALOG.map((entry) => {
    const base = entry.location === 'docs' ? docsDir : dir;
    const absolute = path.join(base, entry.file(name));
    const exists = fs.existsSync(absolute);
    const applicable = entry.applies ? entry.applies(layers ?? {}) : true;
    const stampedVersion = exists ? entry.stamp(absolute) : null;

    let status;
    if (!applicable) status = exists ? 'orphan' : 'not-applicable';
    else if (!exists) status = 'missing';
    else if (!stampedVersion || !version) status = 'unstamped';
    else status = stampedVersion === version ? 'fresh' : 'stale';

    counts[COUNT_KEYS[status]] += 1;

    return {
      id: entry.id,
      path: relative(cwd, absolute),
      producer: entry.producer,
      applicable,
      reason: applicable ? null : (entry.reason ?? null),
      exists,
      stampedVersion,
      status
    };
  });

  return { service: { name, version }, derivatives, counts, errors };
}
