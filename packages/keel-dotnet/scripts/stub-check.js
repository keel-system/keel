#!/usr/bin/env node
// stub-check: el arnés del proveedor de prueba y el adaptador saliente de keel-dotnet contra un WireMock REAL
// (incremento 11d). El gemelo del stub-check de keel-nest.
//
//   npm run stub-check --workspace packages/keel-dotnet [-- --keep] [-- --sabotage=<id>]
//
// Lo que ni `npm test` ni la prueba emitida OutboundClientsTests pueden juzgar: que lo que programan los helpers de
// Support/HttpStub.cs lo ENTIENDA el stub de verdad, y que el corte de conexión, el retraso y la secuencia de WireMock
// lleguen a HttpClient como el arnés promete. Se levanta SOLO el WireMock del catálogo (la misma imagen que el compose de
// infra/), y contra él corren las sondas de scripts/probes/StubProbes: el arnés emitido, compilado solo, y el adaptador
// emitido de stock-reservation con la configuración del perfil develop apuntando a este WireMock.
//
// --sabotage=<id> rompe el arnés emitido CONSERVANDO LA FORMA, y el check tiene que salir rojo:
//   initial-state  la secuencia arranca en un estado que no es el inicial de WireMock (no casa nunca)
//   fault          el corte de conexión con un nombre que WireMock no conoce (rechaza el mapping)
//   transport-retry  el transporte reutiliza conexiones, y con ellas vuelve el reintento propio de SocketsHttpHandler
//
// Necesita el SDK de .NET 10 y podman o docker; red la primera vez (la imagen y NuGet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HTTP_STUB } from 'keel-core/gen/infra-catalog';
import { HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE } from 'keel-core/gen/http-stub-probes';
import { run, resolveRuntime, freePort } from '../../keel-nest/scripts/lib/database-container.js';
import { planFixture, makeWorkspace } from '../test/helpers/workspace.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const SABOTAGES = {
  'initial-state': ['tests/StockReservation.IntegrationTests/Support/HttpStub.cs', `"${HTTP_STUB_INITIAL_STATE}"`, '"Inicio"'],
  fault: ['tests/StockReservation.IntegrationTests/Support/HttpStub.cs', `"${HTTP_STUB_FAULT}"`, '"CONNECTION_RESET"'],
  'transport-retry': ['src/StockReservation.Infrastructure/Clients/HttpExchange.cs', 'message.Headers.ConnectionClose = true;', 'message.Headers.ConnectionClose = false;']
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

function dotnet(cwd, args, env = {}) {
  const result = spawnSync('dotnet', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

const port = await freePort();
const container = `keel-dotnet-stub-check-${process.pid}`;
const started = run(runtime, ['run', '-d', '--rm', '--name', container, '-p', `${port}:${HTTP_STUB.port}`, HTTP_STUB.image, '--verbose']);
if (!step(`WireMock arranca (${HTTP_STUB.image})`, started.status === 0, started.stderr?.trim().slice(-300))) process.exit(1);

const baseUrl = `http://127.0.0.1:${port}`;
const root = makeWorkspace('keel-dotnet-stub-check-');
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${baseUrl}/__admin/mappings`).then((response) => response.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('el admin API responde', ready)) throw new Error('WireMock no respondió');

  // El proyecto de stock-reservation y las sondas, en una solución.
  const { files } = await planFixture('stock-reservation');
  for (const file of files) {
    const target = path.join(root, 'stock-reservation', file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  for (const shared of ['global.json', 'Directory.Build.props', 'Directory.Packages.props']) {
    fs.copyFileSync(path.join(root, 'stock-reservation', shared), path.join(root, shared));
  }
  const probes = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes', 'StubProbes');
  fs.cpSync(probes, path.join(root, 'StubProbes'), { recursive: true });
  if (sabotage) {
    const [file, from, to] = SABOTAGES[sabotage];
    const harness = path.join(root, 'stock-reservation', file);
    const text = fs.readFileSync(harness, 'utf8');
    if (!text.includes(from)) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
      process.exit(2);
    }
    fs.writeFileSync(harness, text.replace(from, to));
    console.log(`(sabotaje: ${sabotage})`);
  }

  const built = dotnet(root, ['build', 'StubProbes/StubProbes.csproj', '-c', 'Release']);
  if (!step('el arnés emitido (solo) y el adaptador compilan con las sondas', built.ok)) {
    console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 40).join('\n'));
    throw new Error('no compila');
  }
  const tested = dotnet(root, ['test', '--project', 'StubProbes/StubProbes.csproj', '--no-build', '-c', 'Release'], {
    HTTP_STUB_ADMIN: `${baseUrl}/__admin`,
    STUB_CHECK_BASE_URL: baseUrl,
    STUB_CHECK_PROJECT: path.join(root, 'stock-reservation')
  });
  const total = Number(/total: (\d+)/.exec(tested.output)?.[1] ?? 0);
  const failures = tested.output.split('\n').filter((line) => /^\s*(con errores|failed)\s/i.test(line)).map((line) => line.trim().replace(/^.*StubProbes\./, ''));
  step('las sondas pasan contra el WireMock real', tested.ok && total > 0, tested.ok ? `${total} sondas` : failures.join('; ') || 'sin resumen');
  if (!tested.ok) {
    const log = path.join(os.tmpdir(), `keel-dotnet-stub-check-${Date.now()}.log`);
    fs.writeFileSync(log, tested.output);
    console.error(`Salida completa de dotnet test en ${log}`);
  }
} catch (error) {
  if (!results.some((result) => !result.ok)) step('stub-check', false, error.message);
} finally {
  run(runtime, ['rm', '-f', container]);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-stub-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Conservado en ${kept}`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nstub-check: ${results.length}/${results.length} en verde.` : `\nstub-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
