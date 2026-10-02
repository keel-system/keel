// La promesa de la capa payments, medida: UN diseño genera el mismo servidor con cualquier pasarela
// del menú. Se genera la fixture de referencia con cada pasarela y se compara archivo a archivo.
// Lo único que puede diferir es lo que es de la pasarela por definición —su adaptador y su
// verificador, las variables de su credencial, la sección del arnés que imita su protocolo, su
// skill— y la documentación que nombra el stack. Cualquier otra diferencia significa que la
// pasarela se coló en una pieza que tenía que ser neutra: el dominio, los casos de uso, el puerto, el
// aplicador de desenlaces, el aviso, la configuración local.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { PAYMENT_GATEWAYS } from '../src/lib/stack-catalog.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));

// Lo que PUEDE cambiar entre pasarelas, y por qué.
const ALLOWED = [
  // El adaptador y el verificador de la pasarela: son ella.
  /^src\/main\/java\/.+\/infrastructure\/payment\/[a-z]+\/[A-Za-z]+(PaymentGateway|NoticeVerifier)\.java$/,
  // Las variables de entorno de su credencial y su URL pública, fuera de local y test.
  /^src\/main\/resources\/parameters\/(develop|production)\/payments\.yaml$/,
  // La sección del arnés que imita su protocolo (la API que usan los escenarios es la misma).
  /^src\/integrationTest\/java\/.+\/flows\/AbstractFlowIT\.java$/,
  // Su skill, y las que nombran el stack elegido.
  /^\.[a-z]+\/skills\/keel-spring-(stripe|mercadopago)\//,
  /^\.[a-z]+\/skills\/keel-generate-spring\/SKILL\.md$/,
  /^(README|AGENTS|CLAUDE)\.md$/
];

function generate(gateway) {
  const { files } = planService({ manifest, layers, workspace: '.', stack: { paymentGateway: gateway, broker: 'rabbitmq' } });
  return new Map(files.map((file) => [file.path, file.content]));
}

test('el mismo diseño genera el mismo servidor con cada pasarela, salvo lo que es de la pasarela', () => {
  const [first, ...rest] = Object.keys(PAYMENT_GATEWAYS);
  const reference = generate(first);
  for (const gateway of rest) {
    const other = generate(gateway);
    const differing = [...new Set([...reference.keys(), ...other.keys()])].filter(
      (file) => reference.get(file) !== other.get(file)
    );
    const unexpected = differing.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));
    assert.deepEqual(unexpected, [], `${first} frente a ${gateway}: la pasarela se coló en piezas neutras`);
    // Y la comparación mira algo: si un día dejaran de generarse los adaptadores, el test pasaría
    // en vacío.
    assert.ok(differing.some((file) => /PaymentGateway\.java$/.test(file)), 'los adaptadores tendrían que diferir');
  }
});

test('las piezas neutras son idénticas byte a byte', () => {
  const projects = Object.keys(PAYMENT_GATEWAYS).map(generate);
  for (const suffix of [
    'application/port/out/PaymentGateway.java',
    'application/payment/PaymentOutcomeApplier.java',
    'application/payment/PaymentNotices.java',
    'application/payment/PaymentReconciliation.java',
    'infrastructure/payment/PaymentNoticeController.java',
    'domain/payment/GatewayOutcome.java',
    'parameters/local/payments.yaml',
    'parameters/test/payments.yaml'
  ]) {
    const contents = projects.map((files) => [...files].find(([file]) => file.endsWith(suffix))?.[1]);
    assert.ok(contents[0], `no se generó ${suffix}`);
    assert.ok(contents.every((content) => content === contents[0]), `${suffix} cambia con la pasarela`);
  }
});
