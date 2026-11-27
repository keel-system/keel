// payment-check se falsa con sabotajes que reescriben el Java generado (src/lib/payment-check-test.js).
// Un sabotaje cuyo texto ya no aparece en lo que se genera dejaría de aplicarse, y la falsación
// pasaría a medir nada sin que nadie lo notara: el saboteador lanza, pero solo cuando alguien lo
// ejecuta con Gradle. Esto lo comprueba sin JDK, contra la generación en memoria.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { PAYMENT_GATEWAYS } from '../src/lib/stack-catalog.js';
import { paymentCheckTest, PAYMENT_CHECK_SABOTAGES, PAYMENT_CHECK_SABOTAGE_GATEWAY } from '../src/lib/payment-check-test.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));

for (const gateway of Object.keys(PAYMENT_GATEWAYS)) {
  test(`${gateway}: cada sabotaje de payment-check se aplica al Java que se genera hoy`, () => {
    const { model, files } = planService({ manifest, layers, workspace: '.', stack: { paymentGateway: gateway, broker: 'rabbitmq' } });
    const projectDir = tmpDir('keel-payment-sabotage-');
    // OutboundAddressPolicy vive en infrastructure/http y la sabotea `filter`.
    for (const file of files.filter((entry) => entry.path.startsWith('src/main/java/') && /payment|OutboundAddressPolicy/.test(entry.path))) {
      fs.mkdirSync(path.dirname(path.join(projectDir, file.path)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, file.path), file.content);
    }
    const { saboteur, content, relativePath } = paymentCheckTest(model, gateway);
    assert.match(content, /class PaymentCheckTest/);
    // `transport-retry` sabotea la pasarela de prueba, que vive en la propia clase de payment-check.
    fs.mkdirSync(path.dirname(path.join(projectDir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, relativePath), content);
    for (const kind of PAYMENT_CHECK_SABOTAGES.filter((k) => !PAYMENT_CHECK_SABOTAGE_GATEWAY[k] || PAYMENT_CHECK_SABOTAGE_GATEWAY[k] === gateway)) {
      assert.doesNotThrow(() => saboteur(projectDir, kind), `el sabotaje '${kind}' ya no se aplica con ${gateway}`);
    }
    // Un sabotaje de la otra pasarela se niega en voz alta en vez de aplicarse a medias.
    for (const kind of PAYMENT_CHECK_SABOTAGES.filter((k) => PAYMENT_CHECK_SABOTAGE_GATEWAY[k] && PAYMENT_CHECK_SABOTAGE_GATEWAY[k] !== gateway)) {
      assert.throws(() => saboteur(projectDir, kind), /es de/);
    }
  });
}
