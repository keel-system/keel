import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Directorios que no son el legacy sino lo que dejó un build o una instalación. Si el repo los
// trae versionados, siguen sin ser fuente: son el resultado de una cadena que el sandbox va a
// reconstruir.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.mvn-cache',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
]);

// Por encima de este tamaño un archivo no es configuración ni código que haya que leer línea a
// línea (un lockfile grande sí se lee: se exime por nombre).
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const ALWAYS_READ = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']);

/**
 * Vista de solo lectura del repo de un legacy. Todas las rutas son relativas a la raíz y con `/`,
 * y la lista va ordenada: lo que sale de aquí tiene que ser igual byte a byte en Windows y en
 * Linux, y en dos ejecuciones seguidas.
 */
export function openRepo(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`no existe el directorio del legacy: ${root}`);
  }
  const files = walk(abs);
  const cache = new Map();
  const text = (rel) => {
    if (!cache.has(rel)) {
      const full = path.join(abs, rel);
      let value = null;
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && (stat.size <= MAX_TEXT_BYTES || ALWAYS_READ.has(path.posix.basename(rel)))) {
          const buf = fs.readFileSync(full);
          value = buf.includes(0) ? null : buf.toString('utf8').replace(/^﻿/, '');
        }
      } catch {
        value = null;
      }
      cache.set(rel, value);
    }
    return cache.get(rel);
  };
  return {
    root: abs,
    files,
    has: (rel) => files.includes(rel),
    text,
    lines: (rel) => {
      const t = text(rel);
      return t === null ? null : t.split(/\r?\n/);
    },
  };
}

function walk(root) {
  const out = [];
  const visit = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit(root, '');
  return out.sort(cmp);
}

/** Orden por código de unidad: el de `localeCompare` cambia con el idioma de la máquina. */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Commit y fecha del legacy, solo si la raíz es ella misma un clon (`.git` en la raíz): un
 * directorio cualquiera dentro de otro repo heredaría el commit de ese otro repo, y eso no es la
 * huella del legacy.
 */
export function gitSource(root, buildFiles = []) {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const log = (...args) =>
    execFileSync('git', ['-C', root, 'log', '-1', '--format=%H %aI', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const [commit, date] = log().split(' ');
    if (!commit) return null;
    const source = { commit, date: date.slice(0, 10) };
    // La época de las dependencias no es la del último commit (un repo archivado acaba en un
    // «Add deprecation notice» años después), sino la de la última vez que se tocó el build.
    const files = buildFiles.filter((f) => fs.existsSync(path.join(root, f)));
    if (files.length) {
      const [, built] = log('--', ...files).split(' ');
      if (built) source.build_changed = { date: built.slice(0, 10), files };
    }
    return source;
  } catch {
    return null;
  }
}

/** `archivo:línea`, `archivo:a-b` o `archivo:a,b-c`, con las líneas comprimidas en tramos. */
export function evidence(file, lines = []) {
  const sorted = [...new Set(lines.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (sorted.length === 0) return file;
  const spans = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    spans.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  spans.push(start === prev ? `${start}` : `${start}-${prev}`);
  return `${file}:${spans.join(',')}`;
}

/** Orden de evidencias: por archivo y después por número de línea (`a:9` antes que `a:10`). */
export function cmpEvidence(a, b) {
  const pa = /^([^:;]*)(?::(\d+))?/.exec(a ?? '');
  const pb = /^([^:;]*)(?::(\d+))?/.exec(b ?? '');
  return cmp(pa[1], pb[1]) || Number(pa[2] ?? 0) - Number(pb[2] ?? 0) || cmp(a ?? '', b ?? '');
}

/** Une evidencias de varios archivos en una sola cadena, sin repetir y en orden estable. */
export function joinEvidence(items) {
  return [...new Set(items.filter(Boolean))].join('; ');
}

/** Línea (1-based) del primer `pattern` en `lines` a partir de `from`, o 0. */
export function findLine(lines, pattern, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (typeof pattern === 'string' ? lines[i].includes(pattern) : pattern.test(lines[i])) return i + 1;
  }
  return 0;
}

/** Línea (1-based) de un desplazamiento en un texto. */
export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Directorios cuyo contenido es prueba o arnés de prueba, no código del servicio.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'it', 'integration-test']);

export function isTestPath(rel) {
  // El layout de Maven y Gradle manda: un paquete Java que se llame `spec` sigue siendo código.
  if (rel.startsWith('src/main/')) return false;
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => TEST_SEGMENTS.has(p))) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(parts[parts.length - 1]);
}
