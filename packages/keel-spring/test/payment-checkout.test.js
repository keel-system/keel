// La fixture de referencia de la capa payments. Su cierre (--ready) lo fija mvp-ready.test.js con
// las demás de READY_FIXTURES; aquí va lo que es propio de ella: la promesa de la capa.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, FIXTURE_DOCS_DIR } from './helpers/workspace.js';

const NAME = 'payment-checkout';

test(`${NAME}: el diseño no nombra ninguna pasarela`, () => {
  // Lo que cambia entre pasarelas lo pone el generador. Un nombre de pasarela en el diseño es la
  // señal de que a la capa le faltó algo y se escribió en prosa.
  const PASARELAS = /\b(stripe|mercado\s*pago|adyen|paypal|braintree|checkout\.com|payu|culqi|wompi)\b/i;
  const files = [
    ...fs.readdirSync(path.join(FIXTURES_DIR, NAME)).map((file) => path.join(FIXTURES_DIR, NAME, file)),
    path.join(FIXTURE_DOCS_DIR, NAME, 'DESIGN.md')
  ];
  for (const file of files) {
    const hit = fs.readFileSync(file, 'utf8').match(PASARELAS);
    assert.equal(hit, null, `${path.basename(file)} nombra una pasarela: «${hit?.[0]}»`);
  }
});
