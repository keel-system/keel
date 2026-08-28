// Un diseño rechazado por una decisión sin cerrar tiene que decir CUÁL.
//
// Este test nace de una corrida real: `keel registry get catalog` traía el diseño sin su
// `decisions.yaml` (el índice no lo listaba), y `keel-spring build` lo rechazaba con el
// mensaje genérico «El diseño aún no es generable» sin una sola línea sobre la causa. La
// causa solo aparecía ejecutando `keel validate` a mano sobre el mismo directorio, y eso
// convirtió un diagnóstico de un minuto en dos sesiones.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { build } from '../src/commands/build.js';
import { SUPPORTED_DSL } from '../src/lib/assets.js';

const DSL = SUPPORTED_DSL[0];

const MANIFEST = [
  `keel: "${DSL}"`,
  'service:',
  '  name: billing',
  '  version: 1.0.0',
  '  description: Gestiona la facturación de pedidos.',
  'layers:',
  '  domain: domain.keel.yaml',
  '  use-cases: use-cases.keel.yaml',
  '  api: api.keel.yaml',
  ''
].join('\n');

const DOMAIN = `entities:
  Invoice:
    fields:
      id:    { type: uuid, id: true, generated: true }
      total: { type: decimal, required: true }
`;

// `idempotency` es lo que abre las dos obligaciones: el diseño no nombra el code de la
// carrera de la clave ni el de «misma clave, otro cuerpo».
const USE_CASES = `operations:
  createInvoice:
    description: Da de alta una factura.
    kind: command
    input:
      fields:
        total: { type: decimal, required: true }
    output: { entity: Invoice }
    idempotency: { keySource: client-key, ttlSeconds: 3600 }
    errors:
      - { code: INVALID_TOTAL, when: El importe no es positivo., http: 400 }
`;

const API = `endpoints:
  createInvoice: { method: POST, path: /invoices, successStatus: 201 }
`;

const DECISIONS = `decisions:
  - id: OBL-IDEM-RACE-CODE
    scope: use-cases
    reason: El canónico 409 IDEMPOTENCY_KEY_IN_PROGRESS es el contrato público del servicio.
    since: 1.0.0
  - id: OBL-IDEM-REUSE-CODE
    scope: use-cases
    reason: El canónico 409 IDEMPOTENCY_KEY_REUSED es el contrato público del servicio.
    since: 1.0.0
`;

function makeWorkspace({ decisions = null } = {}) {
  const dir = tmpDir('keel-spring-obl-');
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}'); // isKeelWorkspace

  const serviceDir = path.join(dir, 'specs', 'billing');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, 'service.keel.yaml'), MANIFEST);
  fs.writeFileSync(path.join(serviceDir, 'domain.keel.yaml'), DOMAIN);
  fs.writeFileSync(path.join(serviceDir, 'use-cases.keel.yaml'), USE_CASES);
  fs.writeFileSync(path.join(serviceDir, 'api.keel.yaml'), API);
  if (decisions) fs.writeFileSync(path.join(serviceDir, 'decisions.yaml'), decisions);
  return dir;
}

/** Ejecuta build recogiendo lo que escribe: aquí lo que se mide es la salida. */
async function runBuild(workspace, inputPath) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const previous = { log: console.log, warn: console.warn, error: console.error };
  const salida = [];
  const capture = (...args) => salida.push(args.map((arg) => String(arg)).join(' '));
  console.log = console.warn = console.error = capture;
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await build(inputPath, { defaults: true });
    return { exitCode: process.exitCode, salida: salida.join('\n') };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, previous);
  }
}

test('build nombra las decisiones sin cerrar en vez de rechazar el diseño en silencio', async () => {
  const workspace = makeWorkspace();

  const { exitCode, salida } = await runBuild(workspace, path.join('specs', 'billing'));

  assert.equal(exitCode, 1);
  assert.match(salida, /Decisiones de diseño sin cerrar — 2/);
  assert.match(salida, /OBL-IDEM-RACE-CODE/);
  assert.match(salida, /OBL-IDEM-REUSE-CODE/);
  // Y dice cómo se cierran: sin esto, el mensaje nombra el problema y deja al lector
  // igual de parado que el genérico.
  assert.match(salida, /decisions\.yaml/);
  assert.match(salida, /design-obligations\.md/);
  assert.match(salida, /El diseño aún no es generable/);
});

test('con las decisiones aceptadas por escrito, el mismo diseño pasa el gate de validación', async () => {
  const workspace = makeWorkspace({ decisions: DECISIONS });

  const { exitCode, salida } = await runBuild(workspace, path.join('specs', 'billing'));

  assert.notEqual(exitCode, 1);
  assert.doesNotMatch(salida, /Decisiones de diseño sin cerrar/);
  assert.doesNotMatch(salida, /no es generable/);
  assert.equal(fs.existsSync(path.join(workspace, 'services', 'billing-spring')), true);
});
