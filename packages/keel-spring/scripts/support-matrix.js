#!/usr/bin/env node
// Imprime la matriz de paridad (`src/lib/engine-support.js`) y, sobre todo, las tres listas con
// las que se decide qué hacer después:
//
//   SIN EJECUTAR   generado y que ninguna red ejecuta. Es la cola de trabajo.
//   SIN FALSAR     hay red, pero nadie ha comprobado que pueda ponerse roja. Es más barato de
//                  cerrar y suele dar más información: `mongo-check` estuvo aquí durante meses.
//   DEGRADADO      lo que el generador NO sostiene en ese motor. No es cola de trabajo: es una
//                  declaración de alcance, y lo que se pide de ella es leerla, no vaciarla.
//
// La tercera llegó tarde, y por un motivo que conviene no perder: sin ella, una celda `degradado`
// no salía en ninguna lista NI se contaba en el RESUMEN, así que este comando podía cerrar con
// «SIN FALSAR: (ninguna)» y parecer terminado teniendo una garantía del diseño que nada sostiene
// en un motor que el catálogo ofrece. Pasó con MySQL y la unicidad condicionada. De ahí también
// que el RESUMEN cuente ahora los CUATRO estados, que sí particionan las celdas: una celda nueva
// no puede quedarse fuera sin que la suma deje de cuadrar.
//
// No toca red, ni contenedores, ni disco: es una proyección pura del módulo, así que sirve igual
// en una revisión que en CI. `--json` para consumirlo desde otro sitio.

import { MECHANISMS, STATES, cells, unverified, unfalsified, degraded } from '../src/lib/engine-support.js';

const json = process.argv.includes('--json');

const MARCA = {
  verificado: 'OK ',
  razonado: '?? ',
  degradado: '-- ',
  'no-aplica': '   '
};

if (json) {
  console.log(
    JSON.stringify(
      { mechanisms: MECHANISMS, unverified: unverified(), unfalsified: unfalsified(), degraded: degraded() },
      null,
      2
    )
  );
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
const degradadas = degraded();

console.log('SIN EJECUTAR — nadie lo corre contra un motor\n');
for (const row of sinEjecutar) console.log(`  ${row.id}/${row.key}\n    ${row.why}\n`);
if (sinEjecutar.length === 0) console.log('  (ninguna)\n');

console.log('SIN FALSAR — hay red, pero nadie la ha roto a propósito\n');
for (const row of sinFalsar) console.log(`  ${row.id}/${row.key} — ${row.net}\n    ${row.why}\n`);
if (sinFalsar.length === 0) console.log('  (ninguna)\n');

console.log('DEGRADADO — el motor no sostiene la garantía, y el generador lo dice en vez de fingirla\n');
for (const row of degradadas) {
  console.log(`  ${row.id}/${row.key}`);
  console.log(`    pidió:  ${row.guarantee}`);
  console.log(`    pasa:   ${row.consequence}`);
  // Las salidas son la mitad que convierte un aviso en una decisión, y son también lo que hay que
  // RELEER cuando alguien vuelve por aquí: la de MySQL estuvo enumerando la salida cara —una
  // columna generada declarada— mientras existía una barata que nadie había buscado.
  for (const way of row.ways) console.log(`    salida: ${way}`);
  console.log('');
}
if (degradadas.length === 0) console.log('  (ninguna)\n');

const total = cells().length;
const conteo = (state) => cells().filter(({ cell }) => cell.state === state).length;
const verificadas = conteo('verificado');
const noAplica = conteo('no-aplica');
const falsadas = cells().filter(({ cell }) => cell.falsified === true).length;
// Los cuatro estados PARTICIONAN las celdas; `falsadas` y `sin falsar` son cortes transversales
// de las verificadas y por eso van en su propia línea. Si la suma no cuadra hay un estado sin
// contar — que es exactamente como las degradadas pasaron desapercibidas.
const suma = verificadas + sinEjecutar.length + degradadas.length + noAplica;
console.log(
  `RESUMEN: ${total} celdas · ${verificadas} verificadas · ${sinEjecutar.length} sin ejecutar · ` +
    `${degradadas.length} degradadas · ${noAplica} no aplican` +
    (suma === total ? '' : `  [!] la suma da ${suma}: hay un estado sin contar`)
);
console.log(`         de las verificadas, ${falsadas} falsadas y ${sinFalsar.length} sin falsar`);
console.log(`\nEstados: ${Object.keys(STATES).join(' · ')}`);
