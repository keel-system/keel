#!/usr/bin/env node
// Restaura, compila, prueba y ARRANCA de verdad el proyecto que genera keel-dotnet.
//
// Por qué no está en `npm test`: necesita el SDK de .NET 10 y red (NuGet descarga los paquetes la primera
// vez), y tarda minutos. La suite de este paquete compara el texto emitido; esto es lo único que dice que
// ese texto es una solución que compila sin un solo warning, que sus pruebas pasan, que lo que NuGet
// resuelve tiene licencia permisiva (transitivas incluidas) y que el servidor arranca y responde a sus
// sondas con el contrato de los otros dos generadores. Es el equivalente de `ts-check` de keel-nest y de
// `compile-check` de keel-spring, y como ellos se lanza antes de dar por bueno cualquier cambio en lo que
// se emite.
//
//   node packages/keel-dotnet/scripts/cs-check.js [--keep] [--sabotage=<id>]
//   npm run cs-check --workspace packages/keel-dotnet
//
// --keep deja el proyecto generado (y dice dónde) para inspeccionarlo.
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA (sigue compilando) y el check tiene que salir rojo
// en las pruebas, con las de esa regla y solo esas:
//   decimal-scale     el decimal se escribe normalizado (2.50 → 2.5)
//   decimal-exact     el decimal con más de 28 decimales se redondea en silencio en vez de rechazarse
//   timestamp-format  el instante se escribe sin los ceros finales del milisegundo (.000 → nada)
//   utf8              vuelve el codificador por defecto, que escapa lo que no es ASCII

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, DOTNET_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { licenseProblems } from '../src/lib/dotnet-stack.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// Los sabotajes: [archivo, texto que se sustituye, sustituto]. Si el texto ya no está, el check lo dice y sale
// rojo: un sabotaje que dejó de aplicarse no puede pasar por medido.
const WIRE_DIR = 'src/ProductCatalog.Application/Support';
const SABOTAGES = {
  'decimal-scale': [
    `${WIRE_DIR}/WireConverters.cs`,
    'writer.WriteRawValue(value.ToString(CultureInfo.InvariantCulture), skipInputValidation: true);',
    'writer.WriteRawValue((value / 1.000000000000000000000000000000000m).ToString(CultureInfo.InvariantCulture), skipInputValidation: true);'
  ],
  // `scale < 0` nunca es cierto y compila sin warning; un `&& false` sería código inalcanzable, y con los
  // warnings como errores el sabotaje no compilaría, que no falsa nada.
  'decimal-exact': [`${WIRE_DIR}/WireConverters.cs`, 'if (value.Scale != scale)', 'if (value.Scale != scale && scale < 0)'],
  'timestamp-format': [`${WIRE_DIR}/WireConverters.cs`, `"yyyy-MM-dd'T'HH:mm:ss.fff'Z'"`, `"yyyy-MM-dd'T'HH:mm:ss.FFF'Z'"`],
  utf8: [`${WIRE_DIR}/WireJson.cs`, 'options.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;', 'options.Encoder = JavaScriptEncoder.Default;']
};
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function dotnet(projectDir, args) {
  // Sin el logo ni la telemetría de la primera ejecución en la salida, que es lo que se imprime si falla.
  const env = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const result = spawnSync('dotnet', args, { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(port, route) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => request.destroy());
  });
}

async function waitFor(port, route, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const response = await get(port, route);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

/** La licencia que declara un paquete y versión en el catálogo de nuget.org (null si no declara una SPDX). */
async function nugetLicense(id, version) {
  const registration = await fetch(`https://api.nuget.org/v3/registration5-semver1/${id.toLowerCase()}/${version.toLowerCase()}.json`);
  if (!registration.ok) throw new Error(`${id} ${version}: el catálogo respondió ${registration.status}`);
  const entry = await (await fetch((await registration.json()).catalogEntry)).json();
  return entry.licenseExpression ?? null;
}

/** Los paquetes que NuGet resolvió para la solución, directos y transitivos, sin repetir. */
function resolvedPackages(projectDir) {
  const listed = dotnet(projectDir, ['list', 'package', '--include-transitive', '--format', 'json']);
  if (!listed.ok) throw new Error(listed.output);
  const packages = new Map();
  for (const project of JSON.parse(listed.output.slice(listed.output.indexOf('{'))).projects ?? []) {
    for (const framework of project.frameworks ?? []) {
      for (const item of [...(framework.topLevelPackages ?? []), ...(framework.transitivePackages ?? [])]) {
        packages.set(`${item.id}@${item.resolvedVersion}`, { id: item.id, version: item.resolvedVersion });
      }
    }
  }
  return [...packages.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const sdk = dotnet(process.cwd(), ['--version']);
if (!step('SDK de .NET disponible', sdk.ok && /^10\./.test(sdk.output.trim()), sdk.ok ? sdk.output.trim() : 'instala el SDK 10: winget install Microsoft.DotNet.SDK.10')) {
  process.exit(1);
}

const workspace = makeWorkspace('keel-dotnet-cs-check-');
mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${DOTNET_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${DOTNET_READY_DESIGN.name}-dotnet`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}

if (sabotage) {
  const [file, from, to] = SABOTAGES[sabotage] ?? [];
  const target = file ? path.join(projectDir, file) : null;
  const content = target && fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (!content.includes(from)) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
    process.exit(2);
  }
  fs.writeFileSync(target, content.replace(from, to));
  console.log(`(sabotaje: ${sabotage})`);
}

const restore = dotnet(projectDir, ['restore']);
if (!step('dotnet restore (escribe los packages.lock.json)', restore.ok)) {
  console.error(restore.output);
  process.exit(1);
}
const locked = dotnet(projectDir, ['restore', '--locked-mode']);
if (!step('dotnet restore --locked-mode (los lockfiles se sostienen)', locked.ok)) console.error(locked.output);

try {
  const packages = resolvedPackages(projectDir);
  const problems = [];
  for (const { id, version } of packages) {
    problems.push(...licenseProblems({ id, version, license: await nugetLicense(id, version) }));
  }
  if (!step(`licencias de los ${packages.length} paquetes resueltos, transitivos incluidos`, problems.length === 0, problems.join('; '))) {
    for (const problem of problems) console.error(`  ${problem}`);
  }
} catch (error) {
  step('licencias de los paquetes resueltos', false, error.message);
}

const compiled = dotnet(projectDir, ['build', '--no-restore', '-c', 'Release']);
if (!step('dotnet build sin warnings (TreatWarningsAsErrors)', compiled.ok)) console.error(compiled.output);
const tested = dotnet(projectDir, ['test', '--no-build', '-c', 'Release']);
if (!step('pruebas del proyecto bajo el perfil test (dotnet test)', tested.ok)) console.error(tested.output);

if (results.every((result) => result.ok)) {
  const port = await freePort();
  const dll = path.join(projectDir, 'src', 'ProductCatalog.Api', 'bin', 'Release', 'net10.0', 'ProductCatalog.Api.dll');
  const app = spawn('dotnet', [dll], {
    cwd: projectDir,
    env: { ...process.env, PROFILE: 'local', SERVER_PORT: String(port), DOTNET_NOLOGO: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appOutput = '';
  app.stdout.on('data', (chunk) => (appOutput += chunk));
  app.stderr.on('data', (chunk) => (appOutput += chunk));
  const exited = new Promise((resolve) => app.on('exit', (code, signal) => resolve({ code, signal })));

  const livez = await waitFor(port, '/livez', 30_000);
  step('arranca y GET /livez → 200 {"status":"UP"}', livez?.status === 200 && livez.body === '{"status":"UP"}', livez ? `${livez.status} ${livez.body}` : 'no respondió en 30 s');
  const readyz = await get(port, '/readyz');
  step('GET /readyz → 200 {"status":"UP"}', readyz?.status === 200 && readyz.body === '{"status":"UP"}', readyz ? `${readyz.status} ${readyz.body}` : 'sin respuesta');
  const missing = await get(port, '/no-existe');
  step('una ruta que no existe → 404', missing?.status === 404, missing ? String(missing.status) : 'sin respuesta');

  app.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  if (isWindows) {
    // En Windows SIGTERM termina el proceso sin dejarle ejecutar nada: el apagado ordenado no se puede
    // observar aquí. Se dice en voz alta en vez de darlo por bueno; lo cubre la prueba emitida del drenaje.
    console.log('(no medido) apagado ordenado tras SIGTERM — en Windows la señal mata el proceso sin ejecutar sus hooks');
  } else {
    step('SIGTERM → apagado ordenado con salida 0', end?.code === 0, end ? `code=${end.code} signal=${end.signal}` : 'no terminó en 15 s');
  }
  if (!end) app.kill('SIGKILL');
  if (results.some((result) => !result.ok)) console.error(appOutput);
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // El directorio temporal se borra al salir; para conservarlo se copia fuera.
  const kept = fs.mkdtempSync(path.join(path.dirname(workspace), 'keel-dotnet-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ncs-check: ${results.length}/${results.length} en verde.` : `\ncs-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
