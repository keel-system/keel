// Lectores de la cobertura del legacy, puros: reciben lo que se volcó y cuentan cuánto código de
// LA APP se ejecutó. El juez solo pide que grabe (más de cero); el estancamiento por ronda es del
// paso 1b. Lo de node_modules y lo interno de Node no cuenta: con la instrumentación puesta y la
// app sin cargar, contar eso daría verde con una cobertura vacía.

import { cmp } from './repo.js';

/** CSV de `jacococli report --csv`: líneas y ramas cubiertas. */
export function readJacocoCsv(csv) {
  const rows = String(csv).trim().split(/\r?\n/);
  const header = rows.shift()?.split(',') ?? [];
  const col = (name) => header.indexOf(name);
  const [lm, lc, bm, bc] = ['LINE_MISSED', 'LINE_COVERED', 'BRANCH_MISSED', 'BRANCH_COVERED'].map(col);
  if (lm < 0 || lc < 0) return { unit: 'lines', covered: 0, total: 0, files: 0 };
  let covered = 0;
  let total = 0;
  let branches = 0;
  let branchTotal = 0;
  for (const row of rows) {
    const c = row.split(',');
    covered += Number(c[lc]) || 0;
    total += (Number(c[lc]) || 0) + (Number(c[lm]) || 0);
    branches += Number(c[bc]) || 0;
    branchTotal += (Number(c[bc]) || 0) + (Number(c[bm]) || 0);
  }
  return { unit: 'lines', covered, total, files: rows.length, branches: { covered: branches, total: branchTotal } };
}

const isAppPath = (p, include) => {
  const s = String(p).replace(/\\/g, '/');
  if (s.includes('/node_modules/')) return false;
  return include ? s.includes(include) : true;
};

/** JSON de istanbul que nyc deja en su `--temp-dir` (un archivo por proceso): sentencias. */
export function readIstanbul(jsonDocs, include) {
  const files = new Map();
  for (const doc of jsonDocs) {
    for (const [file, cov] of Object.entries(doc ?? {})) {
      if (!isAppPath(file, include) || !cov || !cov.s) continue;
      const prev = files.get(file) ?? {};
      for (const [id, n] of Object.entries(cov.s)) prev[id] = (prev[id] ?? 0) + n;
      files.set(file, prev);
    }
  }
  let covered = 0;
  let total = 0;
  for (const s of files.values()) {
    for (const n of Object.values(s)) {
      total++;
      if (n > 0) covered++;
    }
  }
  return { unit: 'statements', covered, total, files: files.size };
}

/** JSON crudo de NODE_V8_COVERAGE: funciones de la app que se ejecutaron. */
export function readV8(jsonDocs, include) {
  const files = new Map();
  for (const doc of jsonDocs) {
    for (const script of doc?.result ?? []) {
      const url = String(script.url ?? '');
      if (!url.startsWith('file://') || !isAppPath(url, include)) continue;
      const fns = files.get(url) ?? new Map();
      for (const fn of script.functions ?? []) {
        const key = `${fn.functionName}@${fn.ranges?.[0]?.startOffset}`;
        const count = fn.ranges?.[0]?.count ?? 0;
        fns.set(key, (fns.get(key) ?? 0) + count);
      }
      files.set(url, fns);
    }
  }
  let covered = 0;
  let total = 0;
  for (const fns of files.values()) {
    for (const n of fns.values()) {
      total++;
      if (n > 0) covered++;
    }
  }
  return { unit: 'functions', covered, total, files: files.size };
}

/** Archivos volcados como `@@FILE <ruta>\n<contenido>` (lo que imprime el volcado de verify). */
export function splitDump(text) {
  const out = [];
  for (const part of String(text).split(/^@@FILE /m).slice(1)) {
    const nl = part.indexOf('\n');
    out.push({ path: part.slice(0, nl).trim(), content: part.slice(nl + 1) });
  }
  return out;
}

export function parseJsonFiles(files) {
  const docs = [];
  for (const f of files) {
    if (!f.path.endsWith('.json')) continue;
    try {
      docs.push(JSON.parse(f.content));
    } catch {
      /* un volcado a medio escribir no cuenta */
    }
  }
  return docs;
}

// ── lo que queda sin cubrir (paso 1b): el agente lee solo eso en la ronda siguiente ─────────────

const lineAt = (source, offset) => (source ? source.slice(0, offset).split('\n').length : null);

/**
 * V8: por archivo de la app, las funciones que no se ejecutaron nunca y, dentro de las que sí, los
 * bloques que no (las ramas). Con el fuente, en líneas; sin él, en offsets. Varios procesos suman.
 */
export function v8Uncovered(jsonDocs, include, sources = {}) {
  const files = new Map();
  for (const doc of jsonDocs) {
    for (const script of doc?.result ?? []) {
      const url = String(script.url ?? '');
      if (!url.startsWith('file://') || !isAppPath(url, include)) continue;
      const fns = files.get(url) ?? new Map();
      for (const fn of script.functions ?? []) {
        const [head, ...blocks] = fn.ranges ?? [];
        if (!head) continue;
        const key = `${fn.functionName}@${head.startOffset}`;
        const prev = fns.get(key) ?? { name: fn.functionName || '<anónima>', start: head.startOffset, end: head.endOffset, count: 0, blocks: new Map() };
        prev.count += head.count ?? 0;
        for (const b of blocks) {
          const bk = `${b.startOffset}-${b.endOffset}`;
          prev.blocks.set(bk, (prev.blocks.get(bk) ?? 0) + (b.count ?? 0));
        }
        fns.set(key, prev);
      }
      files.set(url, fns);
    }
  }
  const out = {};
  for (const [url, fns] of [...files].sort(([a], [b]) => cmp(a, b))) {
    const file = url.replace(/^file:\/\//, '');
    const src = sources[file];
    const where = (s, e) => (src ? `${lineAt(src, s)}-${lineAt(src, e)}` : `@${s}-${e}`);
    const rows = [];
    for (const f of [...fns.values()].sort((a, b) => a.start - b.start)) {
      if (f.count === 0) {
        rows.push(`función ${f.name} (${where(f.start, f.end)})`);
        continue;
      }
      for (const [bk, n] of f.blocks) {
        if (n !== 0) continue;
        const [s, e] = bk.split('-').map(Number);
        rows.push(`rama en ${f.name} (${where(s, e)})`);
      }
    }
    if (rows.length) out[file] = [...new Set(rows)];
  }
  return out;
}

/** istanbul (nyc): por archivo de la app, las líneas con sentencias que no se ejecutaron. */
export function istanbulUncovered(jsonDocs, include) {
  const files = new Map();
  for (const doc of jsonDocs) {
    for (const [file, cov] of Object.entries(doc ?? {})) {
      if (!isAppPath(file, include) || !cov?.s) continue;
      const prev = files.get(file) ?? { s: {}, map: cov.statementMap ?? {} };
      for (const [id, n] of Object.entries(cov.s)) prev.s[id] = (prev.s[id] ?? 0) + n;
      files.set(file, prev);
    }
  }
  const out = {};
  for (const [file, { s, map }] of [...files].sort(([a], [b]) => cmp(a, b))) {
    const lines = [...new Set(Object.entries(s).filter(([, n]) => n === 0).map(([id]) => map[id]?.start?.line).filter(Boolean))].sort((a, b) => a - b);
    if (lines.length) out[file] = lines;
  }
  return out;
}

/** JaCoCo (CSV): las clases con líneas sin cubrir y cuántas. */
export function jacocoUncovered(csv) {
  const rows = String(csv).trim().split(/\r?\n/);
  const header = rows.shift()?.split(',') ?? [];
  const [pk, cl, lm] = ['PACKAGE', 'CLASS', 'LINE_MISSED'].map((n) => header.indexOf(n));
  const out = {};
  for (const row of rows) {
    const c = row.split(',');
    const missed = Number(c[lm]) || 0;
    if (missed > 0) out[`${c[pk]}.${c[cl]}`] = missed;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)));
}
