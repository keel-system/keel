#!/usr/bin/env node
// Imprime la MATRIZ DE LA PUERTA DE DISEÑO: por cada id que keel validate puede emitir, si hay
// una mutación del corpus (test/design-mutations/) que lo pone en rojo y solo a él. Hermano de
// `npm run matrix` de keel-spring, que hace lo mismo con los mecanismos del generador.
//
//   FALSADO           una mutación lo dispara y no dispara nada más.
//   CO-DISPARADO      solo aparece junto a otros ids: la regla dispara, pero ningún diseño la
//                     aísla. Es la cola de trabajo.
//   FUERA DE ALCANCE  lo emite algo que el corpus no ve (los derivados de docs/, el careo), con
//                     el motivo y el test que sí lo falsa.
//   SIN MUTACIÓN      nada lo dispara. `npm test` lo prohíbe, así que aquí debería salir vacío.
//
// Y una línea aparte: los hallazgos SIN id que quedan en crossrefs.js, contados igual que el
// ratchet de test/checks.test.js. No están en la matriz porque no se pueden afirmar por id —que
// es justo lo que les falta—; es el inventario de lo que R5 tiene por delante.
//
// No toca red ni escribe nada: lee el base del corpus y evalúa en memoria. `--json` para
// consumirlo desde otro sitio.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES, classify } from '../test/design-mutations/matrix.js';
import { MUTATIONS } from '../test/design-mutations/catalog.js';

const json = process.argv.includes('--json');
const rows = classify();

const crossrefs = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'crossrefs.js'),
  'utf8'
);
const count = (needle) => crossrefs.split(needle).length - 1;
const anonymous = { errors: count('errors.push('), warnings: count('warnings.push(') };

if (json) {
  console.log(JSON.stringify({ mutations: MUTATIONS.length, rows, anonymous }, null, 2));
  process.exit(0);
}

const MARCA = { falsado: 'OK ', 'co-disparado': '~~ ', 'fuera-de-alcance': '-- ', 'sin-mutacion': '!! ' };

console.log('\nMATRIZ DE LA PUERTA DE DISEÑO — qué comprobación pone en rojo una mutación, y sola\n');
const width = Math.max(...rows.map((row) => row.id.length));
for (const row of rows) {
  const tipo = `${row.severity}/${row.nature}${row.waivable ? '' : ' no-aceptable'}`;
  const detalle = row.state === 'fuera-de-alcance' ? row.reason : row.by.join(', ');
  console.log(`  ${MARCA[row.state]} ${row.id.padEnd(width)}  ${tipo.padEnd(30)} ${detalle}`);
}

const byState = (state) => rows.filter((row) => row.state === state);

console.log('\nCO-DISPARADO — la regla dispara, pero ningún diseño la aísla\n');
for (const row of byState('co-disparado')) console.log(`  ${row.id}  (${row.by.join(', ')})`);
if (byState('co-disparado').length === 0) console.log('  (ninguno)');

console.log('\nSIN MUTACIÓN — nada lo dispara (npm test lo prohíbe)\n');
for (const row of byState('sin-mutacion')) console.log(`  ${row.id}`);
if (byState('sin-mutacion').length === 0) console.log('  (ninguno)');

console.log('\nRESUMEN');
console.log(`  ${MUTATIONS.length} mutaciones sobre ${rows.length} ids`);
for (const state of STATES) console.log(`  ${state.padEnd(17)} ${byState(state).length}`);
console.log(
  `  sin id en crossrefs.js: ${anonymous.errors} errores y ${anonymous.warnings} avisos — no se pueden falsar por id hasta que lo tengan`
);
console.log('');
