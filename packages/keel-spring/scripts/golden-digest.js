#!/usr/bin/env node
// Línea base de lo que genera keel-spring (incremento 0 de PLAN-KEEL-NEST.md).
//
//   node packages/keel-spring/scripts/golden-digest.js           # escribe test/golden/digests.json
//   node packages/keel-spring/scripts/golden-digest.js --check   # compara; sale con 1 si algo cambió
//   npm run golden --workspace packages/keel-spring [-- --check]
//
// Se toma ANTES de un refactor que no debe cambiar la salida y se comprueba DESPUÉS. Un
// cambio intencional del generador también la pone roja: entonces se regenera a sabiendas,
// en un commit propio, nunca dentro del refactor que mide.

import fs from 'node:fs';
import path from 'node:path';
import { GOLDEN_FILE, compareGolden, computeGolden, serializeGolden } from '../src/lib/golden-digest.js';

const check = process.argv.includes('--check');
const golden = computeGolden();
const combos = Object.keys(golden.combos).length;
const files = Object.values(golden.combos).reduce((n, digests) => n + Object.keys(digests).length, 0);

if (!check) {
  fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
  fs.writeFileSync(GOLDEN_FILE, serializeGolden(golden));
  console.log(`Línea base escrita: ${combos} combinaciones, ${files} archivos → ${path.relative(process.cwd(), GOLDEN_FILE)}`);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN_FILE)) {
  console.error(`No hay línea base en ${GOLDEN_FILE}: ejecútalo sin --check primero.`);
  process.exit(2);
}
const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
const diffs = compareGolden(expected, golden);
if (diffs.length === 0) {
  console.log(`Idéntico a la línea base: ${combos} combinaciones, ${files} archivos.`);
  process.exit(0);
}
console.log(`La salida difiere de la línea base en ${diffs.length} punto(s):`);
for (const diff of diffs.slice(0, 200)) console.log(`  ${diff}`);
if (diffs.length > 200) console.log(`  … y ${diffs.length - 200} más`);
process.exit(1);
