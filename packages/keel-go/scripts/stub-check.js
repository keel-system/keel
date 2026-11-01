#!/usr/bin/env node
// stub-check: el arnés del proveedor de prueba y el adaptador saliente de keel-go contra un WireMock REAL (incremento
// 11d). El gemelo del stub-check de keel-nest y del de keel-dotnet.
//
//   npm run stub-check --workspace packages/keel-go [-- --keep] [-- --sabotage=<id>]
//
// Lo que ni `npm test` ni la prueba emitida clients_test.go pueden juzgar: que lo que programan los métodos de
// tests/integration/http_stub_test.go lo ENTIENDA el stub de verdad, y que el corte de conexión, el retraso y la
// secuencia de WireMock lleguen a net/http como el arnés promete. Se levanta SOLO el WireMock del catálogo (la misma
// imagen que el compose de infra/), y contra él corren las sondas de scripts/probes/stub_probe_test.go, copiadas a
// tests/integration del stock-reservation generado: el arnés emitido y el adaptador emitido con la configuración del
// perfil develop apuntando a este WireMock.
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA, y el check tiene que salir rojo en la sonda que lo mide:
//   initial-state    la secuencia arranca en un estado que no es el inicial de WireMock (no casa nunca)
//   fault            el corte de conexión con un nombre que WireMock no conoce (rechaza el mapping)
//   transport-retry  el transporte reutiliza conexiones, y con ellas vuelve el reenvío propio de net/http
//   payment-body     el cobro del doble deja de casar por la referencia en el cuerpo (dos cobros a la vez se pisan)
//   payment-forged   el arnés firma el aviso «falsificado» con el secreto bueno
//
// Y la pasarela de pago (incremento 13c): las sondas de scripts/probes/payment_probe_test.go, copiadas a
// tests/integration de un payment-checkout generado con cada pasarela del catálogo, con el arnés emitido
// (tests/integration/payment_gateway_test.go) y el adaptador y el verificador emitidos apuntando a este WireMock. Los
// sabotajes de la pasarela se aplican a los dos y caen en las mismas sondas con las dos.
//
// Necesita Go y podman o docker; red la primera vez (la imagen y los módulos).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { HTTP_STUB } from '@keel-system/keel-core/gen/infra-catalog';
import { HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE } from '@keel-system/keel-core/gen/http-stub-probes';
import { run, resolveRuntime, freePort } from '../../keel-nest/scripts/lib/database-container.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR, makeWorkspace } from '../test/helpers/workspace.js';

const SUBJECT = 'stock-reservation';
const PAYMENT_SUBJECT = 'payment-checkout';
const PAYMENT_GATEWAYS = ['stripe', 'mercadopago'];
const PAYMENT_HARNESS = 'tests/integration/payment_gateway_test.go';
const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
// [archivo, texto, sustituto, las sondas que tienen que caer: exactamente esas]
const SEQUENCE = 'TestStubProbeLaSecuenciaEntregaLaSegundaRespuestaConLaMismaClaveYSeQuedaPegada';
const FAULT = 'TestStubProbeElCorteDeConexionEsTransporteYSeReintentaConLaMismaClave';
const REUSED = 'TestStubProbeUnaConexionQueSeCortaNoSeReenviaPorDebajoDelRetry';
const SABOTAGES = {
  'initial-state': ['tests/integration/http_stub_test.go', `"${HTTP_STUB_INITIAL_STATE}"`, '"Inicio"', [SEQUENCE]],
  // Las tres sondas que programan el corte.
  fault: ['tests/integration/http_stub_test.go', `"${HTTP_STUB_FAULT}"`, '"CONNECTION_RESET"', [FAULT, REUSED, SEQUENCE]],
  'transport-retry': ['internal/infrastructure/clients/exchange.go', 'DisableKeepAlives:   true,', 'DisableKeepAlives:   false,', [REUSED]],
  // Las dos sondas que programan dos cobros a la vez.
  'payment-body': [
    PAYMENT_HARNESS,
    'request["bodyPatterns"] = []any{map[string]any{"contains": bodyContains}}',
    '_ = bodyContains',
    ['TestPaymentProbeCadaCobroCasaPorSuReferenciaYLlevaSuClave', 'TestPaymentProbeElCobroInmediatoYLaAccionDelCliente']
  ],
  'payment-forged': [PAYMENT_HARNESS, 'return paymentWebhookSecret + "-falso"', 'return paymentWebhookSecret', ['TestPaymentProbeElAvisoQueFirmaElArnesLoAceptaElVerificadorYElFalsificadoNo']]
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function go(cwd, args, env = {}) {
  const result = spawnSync('go', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

const port = await freePort();
const container = `keel-go-stub-check-${process.pid}`;
const started = run(runtime, ['run', '-d', '--rm', '--name', container, '-p', `${port}:${HTTP_STUB.port}`, HTTP_STUB.image, '--verbose']);
if (!step(`WireMock arranca (${HTTP_STUB.image})`, started.status === 0, started.stderr?.trim().slice(-300))) process.exit(1);

const baseUrl = `http://127.0.0.1:${port}`;

/**
 * Genera el sujeto, le copia sus sondas, le aplica el sabotaje si es suyo (los de la pasarela, a los payment-checkout; los
 * demás, a stock-reservation) y ejecuta las sondas contra el WireMock: sin sabotaje, todas en verde; con uno, en rojo
 * exactamente las suyas.
 */
function runSubject({ name, dir, fixture, stack, probes, prefix, harness }) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const plan = planService({ manifest, layers, workspace: root, stack });
  for (const file of plan.files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes', probes), 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'integration', probes), source.replaceAll('__MODULE__', plan.model.service.name));
  let expected = null;
  if (sabotage && (SABOTAGES[sabotage][0] === PAYMENT_HARNESS) === harness) {
    const [file, from, to, caught] = SABOTAGES[sabotage];
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(from)) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy en ${name} (¿cambió el texto?).`);
      process.exit(2);
    }
    fs.writeFileSync(target, text.replace(from, to));
    expected = [...caught].sort();
    console.log(`(sabotaje: ${sabotage} en ${name})`);
  }

  const tidied = go(dir, ['mod', 'tidy']);
  if (!step(`${name}: go mod tidy`, tidied.ok, tidied.ok ? '' : tidied.output.slice(-600))) return;
  // Se compila aparte (go test -c) y se ejecuta desde el proyecto: en Windows el antivirus denegó alguna vez el .test.exe
  // que go test enlaza en %TEMP% (lo mismo que hace db-check).
  const binary = path.join(dir, 'build', process.platform === 'win32' ? 'stub-probe.test.exe' : 'stub-probe.test');
  const built = go(dir, ['test', '-c', '-tags', 'integration', '-o', binary, './tests/integration/']);
  if (!step(`${name}: el arnés emitido y el adaptador compilan con las sondas`, built.ok, built.ok ? '' : built.output.slice(-1500))) return;
  const tested = spawnSync(binary, ['-test.run', `^${prefix}`, '-test.count', '1', '-test.v'], {
    cwd: path.join(dir, 'tests', 'integration'),
    encoding: 'utf8',
    env: { ...process.env, HTTP_STUB_ADMIN: `${baseUrl}/__admin`, STUB_CHECK_BASE_URL: baseUrl },
    maxBuffer: 64 * 1024 * 1024
  });
  const output = `${tested.stdout ?? ''}${tested.stderr ?? ''}`;
  const verdicts = (verdict) => [...output.matchAll(new RegExp(`^--- ${verdict}: (${prefix}\\w+)`, 'gm'))].map((match) => match[1]);
  const passed = verdicts('PASS');
  const failed = verdicts('FAIL');
  const caught = expected && JSON.stringify([...failed].sort()) === JSON.stringify(expected);
  if (expected) {
    step(`${name}: el sabotaje ${sabotage} cae en sus sondas, y solo en ellas`, caught, failed.length > 0 ? `en rojo: ${failed.join(', ')}` : 'ninguna sonda en rojo');
  } else {
    step(`${name}: las sondas pasan contra el WireMock real`, tested.status === 0 && passed.length > 0 && failed.length === 0, failed.length > 0 ? `en rojo: ${failed.join(', ')}` : `${passed.length} sondas`);
  }
  const unexpected = tested.status !== 0 && failed.length === 0;
  if (unexpected || (!expected && failed.length > 0) || (expected && !caught)) {
    const log = path.join(os.tmpdir(), `keel-go-stub-check-${Date.now()}.log`);
    fs.writeFileSync(log, output);
    console.error(output.split('\n').filter((line) => /FAIL|_test\.go:\d+/.test(line)).slice(0, 40).join('\n'));
    console.error(`Salida completa de las sondas en ${log}`);
    if (unexpected) step(`${name}: las sondas terminaron`, false, `código ${tested.status}`);
  }
}
const root = makeWorkspace('keel-go-stub-check-');
const project = path.join(root, SUBJECT);
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    // Con su propio plazo, y un temporizador que mantiene vivo el proceso: un fetch contra un puerto que podman ya publica
    // pero WireMock aún no atiende puede quedarse colgado, y Node salía sin decir nada («unsettled top-level await»).
    ready = await Promise.race([
      fetch(`${baseUrl}/__admin/mappings`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('el admin API responde', ready)) throw new Error('WireMock no respondió');

  const subjects = [
    { name: SUBJECT, dir: project, fixture: SUBJECT, stack: STACK, probes: 'stub_probe_test.go', prefix: 'TestStubProbe', harness: false },
    ...PAYMENT_GATEWAYS.map((gateway) => ({
      name: `${PAYMENT_SUBJECT} (${gateway})`,
      dir: path.join(root, `${PAYMENT_SUBJECT}-${gateway}`),
      fixture: PAYMENT_SUBJECT,
      stack: { database: 'postgresql', broker: 'rabbitmq', paymentGateway: gateway },
      probes: 'payment_probe_test.go',
      prefix: 'TestPaymentProbe',
      harness: true
    }))
  ];
  for (const subject of subjects) runSubject(subject);
} catch (error) {
  if (!results.some((result) => !result.ok)) step('stub-check', false, error.message);
} finally {
  run(runtime, ['rm', '-f', container]);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-go-stub-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Conservado en ${kept}`);
  }
}

const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\nstub-check: ${results.length}/${results.length} en verde.` : `\nstub-check: ${failedSteps} paso(s) en rojo.`);
process.exit(failedSteps === 0 ? 0 : 1);
