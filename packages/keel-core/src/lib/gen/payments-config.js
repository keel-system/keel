// La configuración de la pasarela de pago por perfil (`config/parameters/<perfil>/payments.yaml`): la URL de la
// pasarela, la credencial, el secreto de firma de los avisos, los plazos y los números del barrido de pagos.
//
// La comparten keel-nest y keel-dotnet byte a byte, y dice lo mismo que el `payments.yaml` de keel-spring (lo comparan
// las pruebas de pagos de los dos): los tres servidores del mismo diseño leen las MISMAS claves y las MISMAS variables
// de entorno, así que un mismo .env sirve para cualquiera. Estaba escrita en keel-nest; salió aquí al llegar el tercer
// generador (PLAN-KEEL-DOTNET.md, incremento 13).

import { PAYMENT_TEST_SECRETS } from './payment-gateways.js';
import { PAYMENT_SWEEP_PARAMETERS } from './payments-model.js';
import { HTTP_STUB } from './infra-catalog.js';
import { envValue, envWithDefault } from './profile-values.js';
import { envFor } from './runtime-env.js';

/**
 * El `payments.yaml` de un perfil. En production la credencial y el secreto no tienen default —un despliegue que los
 * olvide no arranca, en vez de cobrar contra otra cuenta—; en local y test, la pasarela de prueba de infra/ con el
 * secreto con el que firma el arnés los avisos.
 */
export function paymentsYaml(model, profile) {
  const gateway = model.payments.gateway;
  const isLocalish = profile === 'local' || profile === 'test';
  const baseUrl = isLocalish ? `http://localhost:${HTTP_STUB.publishedPort}` : gateway.baseUrl;
  const lines = [
    'payments:',
    '  gateway:',
    `    base-url: ${isLocalish ? baseUrl : envWithDefault(profile, gateway.env.baseUrl, gateway.baseUrl)}`,
    `    api-key: ${envValue(profile, gateway.env.apiKey, PAYMENT_TEST_SECRETS.apiKey)}`,
    `    webhook-secret: ${envValue(profile, gateway.env.webhookSecret, PAYMENT_TEST_SECRETS.webhookSecret)}`,
    `    connect-timeout: ${envFor('PAYMENT_GATEWAY_CONNECT_TIMEOUT', profile)}`,
    `    read-timeout: ${envFor('PAYMENT_GATEWAY_READ_TIMEOUT', profile)}`,
    `    notice-tolerance-seconds: ${envFor('PAYMENT_NOTICE_TOLERANCE_SECONDS', profile, gateway.webhook.toleranceSeconds)}`,
    '  reconciliation:',
    '    # Lo decide el diseño (payments.reconciliation.unansweredAfterSeconds); en local y test se acorta',
    '    # para que los escenarios del barrido no esperen un cuarto de hora.',
    `    unanswered-after-seconds: ${isLocalish ? PAYMENT_SWEEP_PARAMETERS.unansweredAfterSeconds.local : envWithDefault(profile, PAYMENT_SWEEP_PARAMETERS.unansweredAfterSeconds.env, model.payments.reconciliation.unansweredAfterSeconds)}`,
    '    # Cuántos cobros consulta una pasada como máximo: capacidad, no diseño. Se ajusta con datos de producción.',
    `    batch-size: ${envWithDefault(profile, PAYMENT_SWEEP_PARAMETERS.batchSize.env, PAYMENT_SWEEP_PARAMETERS.batchSize.default)}`
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * La moneda con la que corren los escenarios: el `testValue` del parámetro de despliegue, si la moneda sale de uno; EUR si
 * no. La usan los arneses de los tres generadores para escribir los importes del doble de la pasarela en la unidad de
 * esa moneda, así que tiene que ser la misma en los tres.
 */
export function paymentTestCurrency(model) {
  const parameter = model.payments.charge.currency?.parameter;
  const found = parameter ? (model.service.parameters ?? []).find((entry) => entry.name === parameter) : null;
  return String(found?.testValue ?? 'EUR').toUpperCase();
}
