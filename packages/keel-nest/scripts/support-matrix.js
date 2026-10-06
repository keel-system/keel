#!/usr/bin/env node
// Imprime la matriz de paridad de keel-nest (`src/lib/engine-support.js`) y sus listas:
//
//   SIN EJECUTAR   generado y que ninguna red ejecuta. Es la cola de trabajo.
//   SIN FALSAR     hay red, pero nadie ha comprobado que pueda ponerse roja.
//   PENDIENTE      lo que keel-nest todavía no genera, con el incremento que lo trae.
//
// Proyección pura del módulo, sin red ni disco. `--json` para consumirlo desde otro sitio.

import { MECHANISMS, MECHANISM_CATALOG, SUPPORTED_DATABASES, cells, unverified, unfalsified, pending } from '../src/lib/engine-support.js';

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ mechanisms: MECHANISMS, unverified: unverified(), unfalsified: unfalsified(), pending: pending() }, null, 2));
  process.exit(0);
}

const MARCA = { verificado: 'OK ', razonado: '?? ', degradado: '-- ', 'no-aplica': '   ' };

console.log(`Matriz de paridad de keel-nest (motores relacionales generados: ${SUPPORTED_DATABASES.join(', ')}; los demás, fuera de la frontera)\n`);
for (const [id, row] of Object.entries(MECHANISMS)) {
  const { title, axis } = MECHANISM_CATALOG[id];
  console.log(`${id} — ${title} [${axis}]`);
  if (row.pending) {
    console.log(`    ..  pendiente: ${row.pending}`);
    continue;
  }
  for (const [branch, cell] of Object.entries(row.coverage)) {
    if (cell.pending) console.log(`    ..  ${branch.padEnd(11)} pendiente: ${cell.pending}`);
    else console.log(`    ${MARCA[cell.state]} ${branch.padEnd(11)} ${cell.state}${cell.net ? ` · ${cell.net}` : ''}${cell.state === 'verificado' && !cell.falsified ? ' · SIN FALSAR' : ''}`);
  }
}

const list = (title, items, render) => {
  console.log(`\n${title}`);
  if (items.length === 0) console.log('  (ninguna)');
  for (const item of items) console.log(`  · ${render(item)}`);
};
list('SIN EJECUTAR', unverified(), ({ id, branch }) => `${id} / ${branch}`);
list('SIN FALSAR', unfalsified(), ({ id, branch }) => `${id} / ${branch}`);
list('PENDIENTE', pending(), ({ id, branch, pending: when }) => `${id}${branch ? ` / ${branch}` : ''} → ${when}`);

const all = cells().filter(({ cell }) => !cell.pending);
const count = (state) => all.filter(({ cell }) => cell.state === state).length;
console.log(
  `\nRESUMEN: ${all.length} celdas generadas — verificado ${count('verificado')}, razonado ${count('razonado')}, degradado ${count('degradado')}, no-aplica ${count('no-aplica')}; ${pending().length} pendientes de un incremento`
);
