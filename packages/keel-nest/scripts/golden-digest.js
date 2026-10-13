#!/usr/bin/env node
// Línea base de lo que genera keel-nest (incremento 1 de PLAN-KEEL-DOTNET.md).
//
//   npm run golden --workspace packages/keel-nest            # escribe test/golden/digests.json
//   npm run golden --workspace packages/keel-nest -- --check # compara; sale con 1 si algo cambió
//
// Se toma ANTES de un refactor que no debe cambiar la salida y se comprueba DESPUÉS. Un cambio
// intencional del generador también la pone roja: entonces se regenera a sabiendas, en un commit
// propio, nunca dentro del refactor que mide.

import { runGolden } from 'keel-core/gen/golden-digest';
import { GOLDEN_FILE, goldenCombos } from '../src/lib/golden-digest.js';
import { planService } from '../src/scaffold/index.js';

process.exit(runGolden({ goldenFile: GOLDEN_FILE, combos: goldenCombos(), planService }));
