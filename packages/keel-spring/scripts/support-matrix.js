#!/usr/bin/env node
// Imprime la matriz de paridad (`src/lib/engine-support.js`) y, sobre todo, las dos listas con
// las que se decide qué hacer después:
//
//   SIN EJECUTAR   generado y que ninguna red ejecuta. Es la cola de trabajo.
//   SIN FALSAR     hay red, pero nadie ha comprobado que pueda ponerse roja. Es más barato de
//                  cerrar y suele dar más información: `mongo-check` estuvo aquí durante meses.
//
// No toca red, ni contenedores, ni disco: es una proyección pura del módulo, así que sirve igual
// en una revisión que en CI. `--json` para consumirlo desde otro sitio.

import { MECHANISMS, STATES, cells, unverified, unfalsified } from '../src/lib/engine-support.js';

const json = process.argv.includes('--json');

const MARCA = {
  verificado: 'OK ',
  razonado: '?? ',
  degradado: '-- ',
  'no-aplica': '   '
};

if (json) {
  console.log(JSON.stringify({ mechanisms: MECHANISMS, unverified: unverified(), unfalsified: unfalsified() }, null, 2));
  process.exit(0);
}

console.log('\nMATRIZ DE PARIDAD — qué se genera en cada rama y quién lo EJECUTA\n');

for (const [id, mechanism] of Object.entries(MECHANISMS)) {
  console.log(`  ${id}  (${mechanism.axis})`);
  console.log(`    ${mechanism.title}`);
  for (const [key, cell] of Object.entries(mechanism.coverage)) {
    const falsada = cell.state === 'verificado' ? (cell.falsified ? ' · falsada' : ' · SIN FALSAR') : '';
    console.log(`    ${MARCA[cell.state] ?? '?  '} ${key.padEnd(12)} ${cell.state.padEnd(10)} ${cell.net}${falsada}`);
  }
  console.log('');
}

const sinEjecutar = unverified();
const sinFalsar = unfalsified();

console.log('SIN EJECUTAR — nadie lo corre contra un motor\n');
for (const row of sinEjecutar) console.log(`  ${row.id}/${row.key}\n    ${row.why}\n`);
if (sinEjecutar.length === 0) console.log('  (ninguna)\n');

console.log('SIN FALSAR — hay red, pero nadie la ha roto a propósito\n');
for (const row of sinFalsar) console.log(`  ${row.id}/${row.key} — ${row.net}\n    ${row.why}\n`);
if (sinFalsar.length === 0) console.log('  (ninguna)\n');

const total = cells().length;
const verificadas = cells().filter(({ cell }) => cell.state === 'verificado').length;
const falsadas = cells().filter(({ cell }) => cell.falsified === true).length;
console.log(
  `RESUMEN: ${total} celdas · ${verificadas} verificadas · ${falsadas} falsadas · ` +
    `${sinEjecutar.length} sin ejecutar · ${sinFalsar.length} sin falsar`
);
console.log(`\nEstados: ${Object.keys(STATES).join(' · ')}`);
