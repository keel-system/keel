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

import { runGolden } from '@keel-system/keel-core/gen/golden-digest';
import { GOLDEN_FILE, goldenCombos } from '../src/lib/golden-digest.js';
import { planService } from '../src/scaffold/index.js';

process.exit(runGolden({ goldenFile: GOLDEN_FILE, combos: goldenCombos(), planService }));
