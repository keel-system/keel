// Los cobros con pasarela de keel-dotnet (incremento 13), sobre el texto emitido:
//
//   · el mismo diseño genera lo mismo con cada pasarela, salvo su adaptador, su verificador, su registro y sus pruebas;
//   · payments.yaml es el de keel-nest y dice lo mismo que el de keel-spring en los cuatro perfiles (un mismo .env), y
//     PaymentGatewaySettings solo lee claves que ese YAML declara;
//   · la tabla de monedas, la clave de idempotencia y la traducción de los rechazos son las de keel-core;
//   · la ruta del aviso entra sin credencial y solo por POST, y Program.cs la mapea;
//   · lo que llama a la pasarela se despacha SIN transacción abarcadora, como en keel-spring y keel-nest;
//   · el aplicador despacha la operación de cada desenlace del diseño, y lo que la capa no nombra falla en voz alta.
// Lo que EJECUTA el C# (el adaptador y el verificador de cada pasarela contra una pasarela falsa, el aviso de punta a punta
// en el servidor en memoria) lo miden las pruebas emitidas PaymentGatewayTests y PaymentNoticeEndpointTests en
// `npm run cs-check` (la fixture con Stripe y su variante con MercadoPago).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { CURRENCY_MINOR_UNITS, GATEWAY_TRANSLATIONS, PAYMENT_NOTICE_PATH, paymentIdempotencyKey } from 'keel-core/gen/payment-gateways';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const SUBJECT = 'payment-checkout';
const GATEWAYS = ['stripe', 'mercadopago'];
const PROFILES = ['local', 'develop', 'production', 'test'];

const design = () => loadService(path.join(FIXTURES_DIR, SUBJECT));
const stack = (gateway) => ({ database: 'postgresql', broker: 'rabbitmq', paymentGateway: gateway });
const plan = (gateway, planner = planService) => planner({ ...design(), workspace: FIXTURES_DIR, stack: stack(gateway) });
const plans = new Map(GATEWAYS.map((gateway) => [gateway, plan(gateway)]));
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

/** Las claves de un YAML, aplanadas con ':' como las lee ServiceConfiguration. */
function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]
  );
}

test('el mismo diseño genera lo mismo con cada pasarela, salvo su adaptador, su verificador y lo que los nombra', () => {
  const [stripe, mercadopago] = GATEWAYS.map((gateway) => new Map(plans.get(gateway).files.map((file) => [file.path, file.content])));
  const differing = [...new Set([...stripe.keys(), ...mercadopago.keys()])].filter((file) => stripe.get(file) !== mercadopago.get(file));
  const allowed = [
    /\/Payment\/(Stripe|Mercadopago)\//,
    // El registro nombra el adaptador elegido.
    /\/Payment\/PaymentsRegistration\.cs$/,
    // Las pruebas emitidas de cada pasarela hablan su protocolo.
    /\/PaymentGatewayTests\.cs$/,
    /\/PaymentNoticeEndpointTests\.cs$/,
    // La sección del arnés que imita su protocolo (la API que usan los escenarios es la misma).
    /\/Support\/PaymentGateway\.cs$/,
    // Las variables de su credencial y su URL pública, fuera de local y test.
    /^config\/parameters\/(develop|production)\/payments\.yaml$/,
    // Lo que nombra el stack elegido.
    /^(README|AGENTS|CLAUDE)\.md$/,
    /^\.[a-z]+\/skills\//,
    /^keel-stack\.json$/
  ];
  assert.deepEqual(differing.filter((file) => !allowed.some((pattern) => pattern.test(file))), []);
  assert.ok(differing.some((file) => file.endsWith('StripePaymentGateway.cs')), 'los adaptadores tendrían que diferir');
  // El puerto, en particular, es el mismo: no nombra ninguna pasarela.
  const port = stripe.get([...stripe.keys()].find((file) => file.endsWith('/Ports/IPaymentGateway.cs')));
  assert.doesNotMatch(port, /stripe|mercadopago/i);
});

test('payments.yaml es el de keel-nest y dice lo mismo que el de keel-spring en los cuatro perfiles', () => {
  for (const gateway of GATEWAYS) {
    const { files } = plans.get(gateway);
    const nest = plan(gateway, planNest).files;
    const spring = plan(gateway, planSpring).files;
    for (const profile of PROFILES) {
      const ours = content(files, `config/parameters/${profile}/payments.yaml`);
      assert.ok(ours, `${gateway}/${profile}`);
      assert.equal(ours, content(nest, `config/parameters/${profile}/payments.yaml`), `${gateway}/${profile}: keel-nest`);
      assert.equal(ours, content(spring, `parameters/${profile}/payments.yaml`), `${gateway}/${profile}: keel-spring`);
    }
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/payments.yaml'))));
    const settings = content(files, '/Payment/PaymentGatewaySettings.cs');
    const read = [...settings.matchAll(/\(configuration, "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(read.length >= 8, gateway);
    for (const key of read) assert.ok(declared.has(key), `${gateway}: PaymentGatewaySettings lee ${key}, que payments.yaml no declara`);
  }
});

test('la tabla de monedas, la clave de idempotencia y los rechazos son los de keel-core', () => {
  const { files, model } = plans.get('stripe');
  const money = content(files, '/Payment/MoneyAmounts.cs');
  const emitted = Object.fromEntries([...money.matchAll(/\["([A-Z]{3})"\] = (\d)/g)].map((match) => [match[1], Number(match[2])]));
  assert.deepEqual(emitted, { ...CURRENCY_MINOR_UNITS });
  assert.equal(emitted.IQD, 3, 'IQD tiene tres decimales');
  const keys = content(files, '/Payment/GatewayKeys.cs');
  assert.ok(keys.includes(`=> $"${paymentIdempotencyKey('{reference}', '{action}')}";`), 'la clave de una acción');
  for (const gateway of GATEWAYS) {
    const { files: gatewayFiles } = plans.get(gateway);
    const adapter = gatewayFiles.find((file) => /\/Payment\/(Stripe|Mercadopago)\/\w+PaymentGateway\.cs$/.test(file.path)).content;
    for (const [code, literal] of GATEWAY_TRANSLATIONS[gateway].declines) {
      const member = model.payments.failureReasons.find((entry) => entry.literal === literal).literal;
      assert.ok(adapter.includes(`["${code}"] = ${model.payments.record.failureReasonType}.${member[0].toUpperCase()}${member.slice(1)},`), `${gateway}: ${code}`);
    }
  }
});

test('la ruta del aviso entra sin credencial y solo por POST, y Program.cs la mapea con la pasarela registrada', () => {
  for (const gateway of GATEWAYS) {
    const { files } = plans.get(gateway);
    const rules = content(files, '/Security/AccessRules.cs');
    assert.ok(rules.includes(`new AccessRule("POST", "${PAYMENT_NOTICE_PATH}", Requirement.PermitAll),`), gateway);
    assert.ok(!rules.includes(`new AccessRule("GET", "${PAYMENT_NOTICE_PATH}"`), gateway);
    const program = content(files, '/Program.cs');
    assert.match(program, /builder\.Services\.AddPayments\(PaymentGatewaySettings\.From\(configuration\)\);/);
    assert.match(program, /app\.MapApiRoutes\(\);\n(?:\/\/.*\n)?app\.MapPaymentNotice\(\);/);
    const endpoint = content(files, '/Rest/PaymentNoticeEndpoint.cs');
    assert.ok(endpoint.includes(`public const string Path = "${PAYMENT_NOTICE_PATH}";`));
    // El cuerpo se lee como texto, sin pasar por el contrato del cable: la firma es sobre los bytes que llegaron.
    assert.match(endpoint, /new StreamReader\(context\.Request\.Body, Encoding\.UTF8\)/);
    assert.doesNotMatch(endpoint, /ReadFromJsonAsync|JsonReading/);
  }
  // Sin pagos, nada de esto.
  const plain = planService({ ...loadService(path.join(FIXTURES_DIR, 'job-dispatch')), workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.ok(!plain.some((file) => /Payment(Notice|Gateway)/.test(file.path)));
  assert.doesNotMatch(content(plain, '/Program.cs'), /Payment/);
});

test('lo que llama a la pasarela se despacha SIN transacción abarcadora, como en keel-spring y keel-nest', () => {
  const { files, model } = plans.get('stripe');
  const endpoints = files.filter((file) => file.path.includes('/Endpoints/')).map((file) => file.content).join('\n');
  /** El cuerpo del endpoint de una operación: de su firma a la siguiente. */
  const endpoint = (name) => {
    const start = endpoints.indexOf(`public static async Task ${name[0].toUpperCase()}${name.slice(1)}(HttpContext http)`);
    assert.ok(start >= 0, name);
    return endpoints.slice(start, endpoints.indexOf('\n    }', start));
  };
  for (const name of [model.payments.charge.operation, model.payments.capture.operation, model.payments.refund.operation, model.payments.savePaymentMethod.operation]) {
    assert.match(endpoint(name), /Mediator\(http\)\.DispatchWithoutTransaction\(message, /, name);
  }
  assert.match(endpoint('getPayment'), /Mediator\(http\)\.Dispatch\(message, /, 'una consulta sigue con su transacción');
  assert.match(content(files, '/Scheduling/PaymentScheduler.cs'), /DispatchWithoutTransaction\(new SweepPendingPaymentsCommand\(\), /);
});

test('el aplicador despacha la operación de cada desenlace; lo que la capa no nombra falla en voz alta', () => {
  const { files, model } = plans.get('stripe');
  const applier = content(files, '/Payment/PaymentOutcomeApplier.cs');
  for (const command of model.payments.outcomeCommands) {
    const member = command.status.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    assert.match(applier, new RegExp(`case GatewayStatus\\.${member[0].toUpperCase()}${member.slice(1)}:\\s+await dispatcher\\.Dispatch\\(\\s+new ${command.messageClass}\\b`), command.operation);
    for (const arg of command.args.filter((candidate) => !candidate.known)) {
      assert.ok(applier.includes(`Todo<`) && applier.includes(`("${arg.name}")`), `${command.operation}.${arg.name}`);
    }
  }
  // La acción del cliente viaja embebida (un campo json), no como cadena escapada.
  assert.match(applier, /CustomerAction = Json\(Required\(outcome\.CustomerAction, "customerAction"\)\)/);
  // El barrido aplica el «no llegó» con el motivo del vocabulario.
  assert.match(content(files, '/Payment/PaymentReconciliation.cs'), /GatewayOutcome\.Failed\(reference, null, PaymentFailureReason\.NotReceived\)/);
});

test('el registro cablea la pasarela elegida y el cliente HTTP sin reintentos por debajo', () => {
  for (const [gateway, adapter] of [['stripe', 'StripePaymentGateway'], ['mercadopago', 'MercadopagoPaymentGateway']]) {
    const { files } = plans.get(gateway);
    const registration = content(files, '/Payment/PaymentsRegistration.cs');
    assert.ok(registration.includes(`services.AddSingleton<IPaymentGateway, ${adapter}>();`), gateway);
  }
  const http = content(plans.get('stripe').files, '/Payment/PaymentGatewayHttp.cs');
  assert.match(http, /AllowAutoRedirect = false/);
  assert.match(http, /message\.Headers\.ConnectionClose = true;/);
  assert.match(http, /Interlocked\.Increment\(ref opened\.Value\) > 1/);
});
