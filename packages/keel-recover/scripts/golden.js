#!/usr/bin/env node
// Reescribe (o, con --check, compara) lo esperado de cada fixture de legacy:
// fixtures/expected/<fixture>/{runtime,environment}.yaml. Reescribirlo es aceptar un cambio
// de la herramienta: se revisa el diff antes de commitearlo.
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_DIR, listLegacyFixtures, renderFixture } from '../test/helpers/golden.js';

const check = process.argv.includes('--check');
let drift = 0;
for (const name of listLegacyFixtures()) {
  for (const [file, text] of Object.entries(renderFixture(name))) {
    const target = path.join(EXPECTED_DIR, name, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === text) continue;
    drift++;
    if (check) {
      console.error(`✗ ${name}/${file} cambió`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      console.log(`✓ ${name}/${file} reescrito`);
    }
  }
}
if (check && drift) process.exit(1);
console.log(drift ? `${drift} archivo(s) ${check ? 'con deriva' : 'reescritos'}` : 'sin cambios');
