#!/usr/bin/env node
// Restaura, compila, prueba y ARRANCA de verdad el proyecto que genera keel-dotnet.
//
// Por qué no está en `npm test`: necesita el SDK de .NET 10, red (NuGet descarga los paquetes la primera
// vez) y podman o docker (el servidor de referencia persiste en PostgreSQL), y tarda minutos. La suite de este paquete compara el texto emitido; esto es lo único que dice que
// ese texto es una solución que compila sin un solo warning, que sus pruebas pasan, que lo que NuGet
// resuelve tiene licencia permisiva (transitivas incluidas) y que el servidor arranca y responde a sus
// sondas con el contrato de los otros dos generadores. Es el equivalente de `ts-check` de keel-nest y de
// `compile-check` de keel-spring, y como ellos se lanza antes de dar por bueno cualquier cambio en lo que
// se emite.
//
//   node packages/keel-dotnet/scripts/cs-check.js [--keep] [--sabotage=<id>] [--fixtures]
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
//   wiring            el registro pierde el handler de una consulta
//   correlation       el middleware deja de abrir la correlación (el cuerpo de error la pierde)
//   method-405        un camino que existe con otro método responde como si no existiera
//   not-blank         la regla notBlank deja de rechazar el texto en blanco

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { makeWorkspace, mountDesign, runCommand, DOTNET_READY_DESIGN, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { solution } from '../src/scaffold/render.js';
import { build } from '../src/commands/build.js';
import { licenseProblems, verifiedLicense } from '../src/lib/dotnet-stack.js';
import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { resolveRuntime, startDatabase, stopDatabase, run } from '../../keel-nest/scripts/lib/database-container.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// Los sabotajes: [archivo, texto que se sustituye, sustituto]. Si el texto ya no está, el check lo dice y sale
// rojo: un sabotaje que dejó de aplicarse no puede pasar por medido.
const WIRE_DIR = 'src/ProductCatalog.Application/Support';
const REST_DIR = 'src/ProductCatalog.Api/Rest';
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
  utf8: [`${WIRE_DIR}/WireJson.cs`, 'options.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;', 'options.Encoder = JavaScriptEncoder.Default;'],
  // Nada depende del handler de una consulta, así que el contenedor arranca igual: solo la fila de esa
  // operación en UseCasesTests puede notarlo.
  wiring: [
    'src/ProductCatalog.Infrastructure/UseCase/UseCaseRegistration.cs',
    'services.AddScoped<IQueryHandler<GetProductQuery, GetProductResponseDto>, GetProductQueryHandler>();',
    '// (sabotaje) sin el handler de GetProductQuery'
  ],
  // La cabecera de la respuesta sigue saliendo: solo el cuerpo de error puede notar que no se abrió.
  correlation: [`${REST_DIR}/CorrelationMiddleware.cs`, 'using (CorrelationContext.Open(correlationId))', 'using ((IDisposable?)null)'],
  'method-405': [`${REST_DIR}/ApiErrorMiddleware.cs`, 'context.Response.StatusCode == StatusCodes.Status405MethodNotAllowed', 'context.Response.StatusCode < 0'],
  'not-blank': [`src/ProductCatalog.Application/Support/InputValidation.cs`, '(value is string text && string.IsNullOrWhiteSpace(text))', '(value is string text && text.Length < 0)']
};

// Los sabotajes de lo que solo emiten las FIXTURES (el proyecto de referencia no lo tiene): se aplican en la solución de
// todas ellas, y cae la prueba emitida de esa regla. Con `--fixtures` no se genera el proyecto de referencia.
//   circuit-strict      el circuito abre con la tasa ESTRICTAMENTE mayor que el umbral (la de cockatiel, no la de resilience4j)
//   circuit-4xx         el circuito cuenta como fallo todo lo que no sea el propio circuito abierto (un 4xx incluido)
//   retry-all           el retry reintenta cualquier fallo del proveedor, no los de su política
//   idempotency-random  la clave saliente cambia en cada intento
//   fallback-any        el fallback atiende cualquier excepción, también un cuerpo que viola el contrato
//   cancel-as-timeout   la cancelación de quien llama se toma por un timeout del proveedor
const CLIENTS_DIR = 'stock-reservation/src/StockReservation.Infrastructure/Clients';
const FIXTURE_SABOTAGES = {
  'circuit-strict': [`${CLIENTS_DIR}/CircuitBreaker.cs`, '* 100.0 / outcomes.Count >= spec.FailureRateThreshold', '* 100.0 / outcomes.Count > spec.FailureRateThreshold'],
  'circuit-4xx': [`${CLIENTS_DIR}/OutboundResilience.cs`, 'ProviderFailures.Recorded.Contains(failure.Kind)', 'failure.Kind != ProviderFailureKind.CircuitOpen'],
  'retry-all': [`${CLIENTS_DIR}/OutboundResilience.cs`, 'retry.Retries.Contains(failure.Kind)', 'failure.Kind != ProviderFailureKind.CircuitOpen'],
  'idempotency-random': [`${CLIENTS_DIR}/OutboundIdempotency.cs`, 'CommandSignature.Of(new object?[] { call, payload })', 'CommandSignature.Of(new object?[] { call, payload, Guid.NewGuid() })'],
  'fallback-any': [
    `${CLIENTS_DIR}/InventoryHttpAdapter.cs`,
    'catch (ProviderFailureException failure) when (CancelStockFallback.Contains(failure.Kind))',
    'catch (Exception error) when (error is not OperationCanceledException && (error as ProviderFailureException ?? new ProviderTransportException(error.Message)) is var failure)'
  ],
  'cancel-as-timeout': [`${CLIENTS_DIR}/HttpExchange.cs`, 'when (!cancellationToken.IsCancellationRequested)', 'when (client.Timeout > TimeSpan.Zero)']
};
if (sabotage && !SABOTAGES[sabotage] && !FIXTURE_SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay del proyecto (${Object.keys(SABOTAGES).join(', ')}) y de las fixtures (${Object.keys(FIXTURE_SABOTAGES).join(', ')}).`);
  process.exit(2);
}

// Las sondas que EJECUTAN lo emitido para todas las fixtures (scripts/probes/): C# de verdad, no plantillas.
const PROBES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes');
// El dominio (DomainProbes) y la lectura de peticiones de la API (RestProbes).
const PROBES = ['DomainProbes', 'RestProbes'];

// Variantes derivadas en memoria de una fixture real, para lo que ninguna declara. Cada una cambia el
// nombre del servicio, que es el namespace raíz: dos variantes de la misma fixture no pueden chocar.
const DERIVED = [
  // La mensajería sobre KAFKA (incremento 9f) y sobre SNS/SQS (9g): las fixtures con mensajería compilan sobre RabbitMQ;
  // estas dos, con outbox y best-effort, compilan además la conexión, el consumo y el arnés de cada uno.
  ...['kafka', 'snssqs'].flatMap((broker) =>
    ['stock-reservation-events', 'metering-digest'].map((from) => ({
      name: `${from}-${broker}`,
      from,
      broker,
      mutate: (manifest, layers, name) => {
        manifest.service.name = name;
      }
    }))
  ),
  {
    name: 'inspection-reports-reject',
    from: 'inspection-reports',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      layers.domain.types.GeoPoint.fields.latitude.constraints.scalePolicy = 'reject';
    }
  },
  {
    // El decimal ESCALAR de una entrada con `scalePolicy: round` se redondea en el propio mensaje
    // (`init => field = ...`, C# 14). Ninguna fixture lo declara: las dos ramas, la obligatoria y la opcional.
    name: 'payment-checkout-round',
    from: 'payment-checkout',
    mutate: (manifest, layers, name) => {
      manifest.service.name = name;
      for (const operation of ['requestCharge', 'refundPayment']) {
        layers['use-cases'].operations[operation].input.fields.amount.constraints.scalePolicy = 'round';
      }
    }
  }
];
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

/** ¿Es el cuerpo un ErrorResponse con las claves del cable, en su orden, y con este status? */
function errorShaped(body, status) {
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(Object.keys(parsed)) === JSON.stringify(WIRE_SHAPES.errorResponse) && parsed.status === status && typeof parsed.correlationId === 'string';
  } catch {
    return false;
  }
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

// --fixtures: solo la compilación del dominio y la aplicación de todas las fixtures (la más lenta de
// iterar), sin generar ni arrancar el proyecto de referencia.
if (process.argv.includes('--fixtures')) {
  const root = compileAllFixtures();
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Fixtures conservadas en ${kept}`);
  }
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

const workspace = makeWorkspace('keel-dotnet-cs-check-');
mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${DOTNET_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${DOTNET_READY_DESIGN.name}-dotnet`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}

if (sabotage && SABOTAGES[sabotage]) {
  const [file, from, to] = SABOTAGES[sabotage];
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
    // Lo que solo declara una URL vale si está leído a mano para ESA versión (dotnet-stack.js, VERIFIED_LICENSES).
    problems.push(...licenseProblems({ id, version, license: (await nugetLicense(id, version)) ?? verifiedLicense(id, version) }));
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

// El baseline del esquema, como lo crea el pase de calidad: `dotnet ef` (herramienta local, versión fijada) compara
// el modelo con la última migración —ninguna— y escribe la primera. Sin él, `develop` no arranca: EF se niega a
// migrar un modelo con cambios pendientes.
const tools = dotnet(projectDir, ['tool', 'restore']);
const baseline = tools.ok ? dotnet(projectDir, ['ef', 'migrations', 'add', 'Baseline', '--project', 'src/ProductCatalog.Infrastructure']) : tools;
const rebuilt = baseline.ok ? dotnet(projectDir, ['build', '-c', 'Release']) : baseline;
if (!step('dotnet ef genera el baseline desde el modelo y compila con él', rebuilt.ok)) console.error(rebuilt.output);

// El servidor arranca en `develop` (el único perfil que se redirige por entorno) contra un PostgreSQL de verdad: al
// arrancar aplica el baseline, y cada caso de uso abre su transacción en esa base.
const runtime = resolveRuntime();
let database = null;
if (results.every((result) => result.ok)) {
  if (!runtime) step('podman o docker disponible para la base del arranque', false, 'instala podman (o docker) y arráncalo');
  else {
    try {
      database = await startDatabase(runtime, 'postgresql');
    } catch (error) {
      step('PostgreSQL en contenedor', false, error.message);
    }
  }
}

if (results.every((result) => result.ok) && database) {
  const port = await freePort();
  const dll = path.join(projectDir, 'src', 'ProductCatalog.Api', 'bin', 'Release', 'net10.0', 'ProductCatalog.Api.dll');
  const app = spawn('dotnet', [dll], {
    cwd: projectDir,
    env: {
      ...process.env,
      PROFILE: 'develop',
      SERVER_PORT: String(port),
      DB_URL: database.url,
      DB_USERNAME: database.user,
      DB_PASSWORD: database.password,
      DOTNET_NOLOGO: '1'
    },
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
  step('una ruta que no existe → 404 con ErrorResponse', missing?.status === 404 && errorShaped(missing.body, 404), missing ? `${missing.status} ${missing.body}` : 'sin respuesta');
  // Una ruta del DISEÑO, en el servidor arrancado de verdad: el uuid mal formado lo rechaza el lector antes de
  // llegar al handler, con el cuerpo de error del contrato.
  const malformed = await get(port, '/api/v1/products/no-es-un-uuid');
  step(
    'GET /api/v1/products/no-es-un-uuid → 400 «Petición malformada» con ErrorResponse',
    malformed?.status === 400 && errorShaped(malformed.body, 400) && JSON.parse(malformed.body).message === 'Petición malformada',
    malformed ? `${malformed.status} ${malformed.body}` : 'sin respuesta'
  );

  // El arranque aplicó el baseline: las tablas del diseño y el historial de migraciones con su nombre propio.
  const tables = run(runtime, ['exec', database.name, 'psql', '-U', database.user, '-d', 'keel_db_check', '-At', '-c', "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'"]);
  step(
    'el arranque aplica el baseline (products y ef_migrations_history en la base)',
    tables.status === 0 && tables.stdout.trim().split(',').includes('products') && tables.stdout.trim().split(',').includes('ef_migrations_history'),
    tables.stdout.trim() || tables.stderr.trim()
  );

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
if (database) stopDatabase(runtime, database);

// ─── La solución ENTERA de todas las fixtures ────────────────────────────────────────────────────
// La frontera de keel-dotnet todavía rechaza casi todas las fixtures (persistencia, mensajería…), pero lo que
// ya se emite para ellas —dominio, aplicación, mediator y sus pruebas— tiene que compilar y pasar: es donde se
// cuelan los nombres que no son identificadores, los tipos que no existen, los usings que faltan y la
// dependencia sin registrar en el contenedor. Van todas en UNA solución, que MSBuild compila en paralelo, en
// vez de quince compilaciones sueltas, junto a las sondas que ejecutan el dominio (scripts/probes).
function compileAllFixtures() {
  const root = makeWorkspace('keel-dotnet-fixtures-');
  const projects = [];
  const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
  const designs = [...fixtures.map((name) => ({ name, from: name })), ...DERIVED];
  for (const { name, from, mutate, broker } of designs) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    if (mutate) mutate(manifest, layers, name);
    // Con mensajería, sobre RabbitMQ: es el broker que la frontera admite (el default del stack es Kafka).
    const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: layers.messaging ? { broker: broker ?? 'rabbitmq' } : null });
    for (const file of files) {
      const target = path.join(root, name, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
      // El SDK se fija desde la raíz de la solución común: el global.json de cualquier fixture vale (es el mismo).
      if (file.path === 'global.json') fs.writeFileSync(path.join(root, 'global.json'), file.content);
      if (file.path.endsWith('.csproj')) projects.push(`${name}/${file.path}`);
    }
  }
  if (sabotage && FIXTURE_SABOTAGES[sabotage]) {
    const [file, from, to] = FIXTURE_SABOTAGES[sabotage];
    const target = path.join(root, file);
    const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (!text.includes(from)) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
      process.exit(2);
    }
    fs.writeFileSync(target, text.replace(from, to));
    console.log(`(sabotaje de las fixtures: ${sabotage})`);
  }
  for (const probes of PROBES) fs.cpSync(path.join(PROBES_DIR, probes), path.join(root, probes), { recursive: true });
  // Las sondas encuentran los props comunes subiendo desde su carpeta: les vale los de cualquier fixture.
  for (const shared of ['Directory.Build.props', 'Directory.Packages.props']) fs.copyFileSync(path.join(root, fixtures[0], shared), path.join(root, shared));
  const lines = [...projects, ...PROBES.map((probes) => `${probes}/${probes}.csproj`)].map((p) => `  <Project Path="${p}" />`);
  fs.writeFileSync(path.join(root, 'Fixtures.slnx'), ['<Solution>', ...lines, '</Solution>', ''].join('\n'));
  const built = dotnet(root, ['build', 'Fixtures.slnx', '-c', 'Release']);
  // Que la solución compile no basta: tiene que haber salido un ensamblado por proyecto declarado.
  const assemblies = projects.filter((project) => {
    const dir = path.dirname(path.join(root, project));
    return fs.existsSync(path.join(dir, 'bin', 'Release', 'net10.0', `${path.basename(project, '.csproj')}.dll`));
  });
  const detail = `${assemblies.length}/${projects.length} ensamblados`;
  const title = `la solución de las ${fixtures.length} fixtures y ${DERIVED.length} variante(s) compila sin warnings`;
  if (!step(title, built.ok && assemblies.length === projects.length, detail)) {
    const problems = new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)));
    console.error([...problems].slice(0, 60).join('\n'));
    return root;
  }
  // Las pruebas emitidas de cada fixture (configuración, sondas, cable, cableado de los casos de uso, API) y las
  // sondas del dominio y de la lectura de peticiones, en una sola ejecución.
  const tested = dotnet(root, ['test', '--solution', 'Fixtures.slnx', '--no-build', '-c', 'Release']);
  const totals = [...tested.output.matchAll(/total: (\d+)/g)].map((match) => Number(match[1]));
  const total = totals.length > 0 ? Math.max(...totals) : null;
  if (!step('las pruebas emitidas de todas las fixtures y las sondas del dominio y de la API pasan', tested.ok, total ? `${total} pruebas` : '')) {
    console.error(tested.output.split('\n').filter((line) => /con errores|failed|error/i.test(line)).slice(0, 80).join('\n'));
  }
  return root;
}

compileAllFixtures();

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // El directorio temporal se borra al salir; para conservarlo se copia fuera.
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ncs-check: ${results.length}/${results.length} en verde.` : `\ncs-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
