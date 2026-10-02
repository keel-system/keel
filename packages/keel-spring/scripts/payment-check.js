#!/usr/bin/env node
// payment-check: EJECUTA el adaptador y el verificador de avisos que genera build, con cada pasarela,
// contra una pasarela falsa servida por el HttpServer del propio JDK. Sin contenedores y sin red.
//
// Por qué existe. Los tests de keel-spring comparan cadenas y compile-check compila: ninguno de los
// dos sabe si la firma de un aviso falso se rechaza de verdad, si la clave de idempotencia que sale
// por el cable es la de la referencia, o si un 503 deja la acción en duda en vez de reintentarse.
// Son justo las defensas que build emite porque su ausencia no rompe ningún escenario feliz.
//
// Qué hace, por pasarela: genera la fixture payment-checkout en un workspace temporal, escribe en el
// source set de test UNA clase JUnit (PaymentCheckTest, que no forma parte del proyecto generado) y
// ejecuta `./gradlew test --tests PaymentCheckTest`. Cada caso nombra la defensa que mide.
//
// Uso:
//   node packages/keel-spring/scripts/payment-check.js [--payment-gateway=<id>] [--sabotage=<defensa>]
//   npm run payment-check --workspace packages/keel-spring
//
// Falsado (ver test/payment-check-script.test.js y el README de la regla): rompiendo a propósito la
// comparación de la firma o la clave de idempotencia en el Java generado, la pasada sale en rojo.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { planService, scaffoldService } from '../src/scaffold/index.js';
import { PAYMENT_GATEWAYS } from '../src/lib/stack-catalog.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { paymentCheckTest } from '../src/lib/payment-check-test.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'test', 'fixtures', 'payment-checkout');
const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--payment-gateway='))?.split('=')[1];
// Para falsar la red: aplica un sabotaje al Java generado antes de ejecutar (ver payment-check-test.js).
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

const gateways = only ? [only] : Object.keys(PAYMENT_GATEWAYS);
const { manifest, layers, errors } = loadService(fixtureDir);
if (errors.length > 0) {
  console.error(`payment-checkout no carga:\n  ${errors.join('\n  ')}`);
  process.exit(2);
}

let failed = 0;
for (const gateway of gateways) {
  const workspace = tmpDir(`keel-payment-check-${gateway}-`);
  const stack = { paymentGateway: gateway, broker: 'rabbitmq' };
  const { model } = planService({ manifest, layers, workspace, stack });
  const { outDir } = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const projectDir = path.join(workspace, outDir);
  const { relativePath, content, saboteur } = paymentCheckTest(model, gateway);
  fs.mkdirSync(path.dirname(path.join(projectDir, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(projectDir, relativePath), content);
  if (sabotage) saboteur(projectDir, sabotage);

  process.stdout.write(`payment-check ${gateway}${sabotage ? ` (sabotaje: ${sabotage})` : ''}: `);
  const result = spawnSync('sh', ['gradlew', 'test', '--tests', '*PaymentCheckTest', '--console=plain', '--no-daemon'], {
    cwd: projectDir,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    console.log('OK');
  } else {
    failed++;
    console.log('FALLA');
    const report = path.join(projectDir, 'build', 'test-results', 'test');
    const summary = fs.existsSync(report)
      ? fs.readdirSync(report).filter((file) => file.endsWith('.xml')).map((file) => fs.readFileSync(path.join(report, file), 'utf8'))
      : [];
    const failures = summary.flatMap((xml) => [...xml.matchAll(/<testcase name="([^"]+)"[^>]*>\s*<failure message="([^"]*)"/g)]);
    for (const [, name, message] of failures) console.error(`  ✘ ${name}: ${message.slice(0, 600)}`);
    if (failures.length === 0) console.error((result.stdout ?? '').split('\n').slice(-40).join('\n'));
  }
}
process.exit(failed > 0 ? 1 : 0);
