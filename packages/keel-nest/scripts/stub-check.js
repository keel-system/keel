#!/usr/bin/env node
// stub-check: el arnés del proveedor de prueba y el adaptador saliente de keel-nest contra un WireMock REAL
// (incremento 11d).
//
//   npm run stub-check --workspace packages/keel-nest [-- --keep]
//
// Lo que `npm test` no puede juzgar: que lo que programan los helpers de `test/integration/support/http-stub.ts`
// lo ENTIENDA el stub de verdad (un mapping mal formado lo rechaza con un 400; uno bien formado que no casa no
// falla nada), y que el corte de conexión, el retraso y la secuencia de WireMock lleguen a `fetch` como el
// arnés promete — transporte, timeout, la segunda respuesta. Se levanta SOLO el WireMock del catálogo (la misma
// imagen que el compose de infra/), y contra él corren los helpers emitidos y el adaptador emitido de
// stock-reservation, con un sustituto de @nestjs/common.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { HTTP_STUB } from 'keel-core/gen/infra-catalog';
import { run, resolveRuntime, freePort } from './lib/database-container.js';
import { planFixture, transpileTree } from '../test/helpers/emitted.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { HTTP_STUB_TS } from '../src/scaffold/http-stub-harness.js';

const keep = process.argv.includes('--keep');
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const runtime = resolveRuntime();
if (!runtime) {
  console.error('stub-check necesita podman o docker en marcha.');
  process.exit(2);
}

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

const port = await freePort();
const name = `keel-nest-stub-check-${process.pid}`;
const started = run(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${port}:${HTTP_STUB.port}`, HTTP_STUB.image, '--verbose']);
if (!step(`WireMock arranca (${HTTP_STUB.image})`, started.status === 0, started.stderr.trim().slice(-300))) process.exit(1);

const admin = `http://127.0.0.1:${port}/__admin`;
// El paso en curso: si algo lanza (el stub rechaza un mapping, un helper revienta), sale en rojo con su nombre y su
// mensaje, en vez de tumbar el script sin resumen — un check que se cae no se distingue de uno mal montado.
let current = 'arranque';
const baseUrl = `http://127.0.0.1:${port}`;
try {
  // Espera al admin API: el mismo sondeo que validate-infra.sh (`/__admin/mappings`).
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${admin}/mappings`).then((response) => response.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('el admin API responde', ready)) process.exit(1);

  const { files } = planFixture('stock-reservation', { stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  // Los helpers del arnés, transpilados, con el admin apuntando a este WireMock.
  const helperDir = tmpDir('keel-nest-stub-check-');
  fs.writeFileSync(path.join(helperDir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(helperDir, 'http-stub.js'),
    ts.transpileModule(byPath[HTTP_STUB_TS], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText
  );
  process.env.HTTP_STUB_ADMIN = admin;
  const stub = await import(pathToFileURL(path.join(helperDir, 'http-stub.js')).href);
  // El adaptador emitido, contra el mismo WireMock.
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { InventoryHttpAdapter } = await tree.load('src/infrastructure/clients/inventory-http-adapter.ts');
  const { InventoryMapper } = await tree.load('src/infrastructure/clients/inventory-mapper.ts');
  const adapter = () => new InventoryHttpAdapter({ inventory: { id: 'inventory', baseUrl, timeoutMs: 500, headers: {} } }, new InventoryMapper());
  const ROUTE = '/stock/reservations/.*';
  const ID = '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f';
  const keysOf = async () => (await stub.stubRequests('DELETE', ROUTE)).map((request) => stub.stubRequestHeader(request, 'Idempotency-Key'));

  current = 'stubFor';
  await stub.resetStubs();
  await stub.stubFor('DELETE', ROUTE, 200, { cancelled: true });
  const happy = await adapter().cancelStock(ID);
  step('stubFor: el adaptador recibe lo programado', happy.cancelled === true, JSON.stringify(happy));
  const [request] = await stub.stubRequests('DELETE', ROUTE);
  step('stubRequests: el stub registró la petición, con su ruta', request?.url === `/stock/reservations/${ID}`, request?.url);
  step('stubRequestHeader: la clave de idempotencia viajó', /^[0-9a-f]{64}$/.test(stub.stubRequestHeader(request, 'idempotency-key') ?? ''));

  current = 'stubConnectionFault';
  await stub.resetStubs();
  await stub.stubConnectionFault('DELETE', ROUTE);
  const cut = await adapter().cancelStock(ID);
  const cutKeys = await keysOf();
  step('stubConnectionFault: llega como transporte, se reintenta 3 veces y cae al fallback', cut.cancelled === null && cutKeys.length === 3, `${cutKeys.length} peticiones`);
  step('…con la MISMA clave en cada intento', new Set(cutKeys).size === 1);

  current = 'stubTimeout';
  await stub.resetStubs();
  await stub.stubTimeout('DELETE', ROUTE, 2_000);
  const slow = await adapter().cancelStock(ID);
  step('stubTimeout: más que el timeout de la llamada es transporte, y se reintenta', slow.cancelled === null && (await stub.stubCallCount('DELETE', ROUTE)) === 3);

  current = 'stubSequence';
  await stub.resetStubs();
  await stub.stubSequence('DELETE', ROUTE, stub.StubResponse.connectionFault(), stub.StubResponse.ok(200, { cancelled: true }));
  const retried = await adapter().cancelStock(ID);
  const retriedKeys = await keysOf();
  step('stubSequence: falla la primera, responde la segunda, y el reintento la recoge', retried.cancelled === true && retriedKeys.length === 2, `${retriedKeys.length} peticiones`);
  step('…y las dos peticiones llevan la misma clave', retriedKeys.length === 2 && retriedKeys[0] === retriedKeys[1]);
  const sticky = await adapter().cancelStock(ID);
  step('…y la última respuesta se queda pegada', sticky.cancelled === true);

  current = 'stubFailure';
  await stub.resetStubs();
  await stub.stubFailure('DELETE', ROUTE, 503);
  const down = adapter();
  for (let i = 0; i < 10; i++) await down.cancelStock(ID);
  const before = await stub.stubCallCount('DELETE', ROUTE);
  const open = await down.cancelStock(ID);
  step('stubFailure: diez 503 abren el circuito y la llamada siguiente ni sale', before === 10 && open.cancelled === null && (await stub.stubCallCount('DELETE', ROUTE)) === 10, `${before} peticiones`);

  current = 'stubFor';
  await stub.resetStubs();
  await stub.stubFor('DELETE', ROUTE, 200, {});
  const broken = await adapter().cancelStock(ID).then(() => null, (error) => error);
  step('un cuerpo que viola el contrato se propaga (no es el proveedor caído)', broken?.name === 'OutboundContractError', broken?.message);
} catch (error) {
  step(`${current}: el paso no llegó a terminar`, false, error instanceof Error ? error.message : String(error));
} finally {
  if (!keep) run(runtime, ['rm', '-f', name]);
  else console.log(`(contenedor conservado: ${name}, puerto ${port})`);
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nstub-check: ${results.length}/${results.length} en verde.` : `\nstub-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
