// El arnés de integración del proyecto generado: la base de la que cuelgan las pruebas de flujo
// (`test/integration/<flujo>.test.ts`) que escribe el agente de pruebas a partir de
// specs/validation-scenarios.md, el humo que comprueba la fontanería, la configuración de Vitest que
// escribe el XML JUnit y `infra/score-scenarios.sh`, que lo puntúa.
//
// Es el equivalente de AbstractFlowIT + FailureCapture + HarnessSmokeIT de keel-spring, con las
// mismas promesas: el servidor real escuchando en un puerto libre contra la infraestructura de
// `infra/`, peticiones HTTP de verdad (caja negra), el reset de estado por flujo con
// `infra/reset-db.sh`, y la evidencia de cada fallo volcada a `build/keel-failures/<FL-id>.json`
// con el último intercambio y el último sondeo, que es lo que lee el árbitro.
//
// La matriz se lee con los MISMOS programas awk que la de keel-spring (keel-core/gen/junit-scoring):
// Vitest escribe JUnit, y su configuración pone en `name` el título del caso (`FL-x: …`) y en
// `classname` el archivo sin extensión. Un escenario no puede puntuar distinto según el generador.
//
// Aquí NO se genera ninguna prueba de flujo: eso es derivado del diseño y lo escribe el agente.

import path from 'node:path';
import { DATABASES, selectedInfra } from 'keel-core/gen/infra-catalog';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK, specsSealCheck } from 'keel-core/gen/junit-scoring';
import { resetDbScript } from 'keel-core/gen/infra-scripts';
import { missingClockCountSql, rescueProbes, stallSql } from 'keel-core/gen';
import { NEST_INFRA } from './infra.js';
import { usesApi } from './rest-support.js';
import { usesRelational, engineOf } from './persistence-entities.js';
import { tsString } from './render.js';
import { closingCredential, identitySection, usesIdentityHarness } from './identity-harness.js';
import { messagingHarnessImports, messagingHarnessSection, usesMessagingHarness } from './messaging-harness.js';
import * as httpStubHarness from './http-stub-harness.js';
import { documentHarnessSection, documentProbe } from './document-harness.js';
import { usesNestOutbox } from './messaging.js';
import { usesScheduling } from './scheduling.js';
import { usesRequestIdempotency } from './request-idempotency.js';

/** Dónde escribe Vitest el XML JUnit de la suite de integración: lo lee score-scenarios.sh. */
export const INTEGRATION_RESULTS = 'build/test-results/integration';
export const INTEGRATION_CONFIG = 'vitest.integration.config.ts';
export const FLOW_SUPPORT_TS = 'test/integration/support/flow.ts';
export const HARNESS_SMOKE_TS = 'test/integration/harness-smoke.test.ts';
export const SCORE_SCENARIOS_SH = 'infra/score-scenarios.sh';
export const CHECK_FLOWS_SH = 'infra/check-flows.sh';

export function generate(model) {
  return [
    { path: INTEGRATION_CONFIG, content: integrationConfig(model) },
    { path: FLOW_SUPPORT_TS, content: flowSupportTs(model) },
    { path: HARNESS_SMOKE_TS, content: harnessSmokeTs(model) },
    { path: SCORE_SCENARIOS_SH, content: scoreScenariosScript(model) },
    { path: 'tsconfig.flows.json', content: flowsTsconfig() },
    { path: CHECK_FLOWS_SH, content: checkFlowsScript() },
    // El proveedor de prueba (incremento 11d): en su propio módulo, sin Nest, y reexportado por flow.ts.
    ...httpStubHarness.generate(model)
  ];
}

/** ¿Hay `infra/reset-db.sh`? Las mismas condiciones con las que lo escribe infra-scripts.js. */
export function hasResetScript(model) {
  return resetDbScript(selectedInfra(model), model.service, model, NEST_INFRA) !== null;
}

/** La base de prueba como contenedor al que se le pueden mandar sentencias (relacional con CLI). */
function dbProbe(model) {
  if (!usesRelational(model)) return null;
  const entry = DATABASES[engineOf(model)];
  if (!entry?.cliQueryArgv || !entry.composeService) return null;
  const dbName = model.service.name.replaceAll('-', '_');
  return {
    container: `${model.service.name}-db`,
    argv: entry.cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName }),
    label: entry.label
  };
}

// ─── vitest.integration.config.ts ───────────────────────────────────────────

function integrationConfig(model) {
  // Con mensajería, un caso puede parar y levantar el broker (stopBroker/startBroker): con Kafka eso solo ya pasa
  // de 30 s —cada consulta al broker parado tarda varios segundos en rendirse, y la reconexión y el reenvío del
  // outbox suman otros tantos— sin que nada vaya mal (broker-check, 2026-10-07). Spring no pone plazo por caso.
  const testTimeout = usesMessagingHarness(model) ? '120_000' : '30_000';
  return `import { defineConfig } from 'vitest/config';

// La suite de integración: los flujos FL-* contra el servidor real y la infraestructura de infra/.
// Se ejecuta con \`npm run test:integration\` o, para puntuarla, con \`bash infra/score-scenarios.sh\`.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.test.ts'],
    // El perfil de la infraestructura de prueba: la base de infra/docker-compose.yaml, y el esquema
    // lo crea el ORM al arrancar (synchronize), como el ddl-auto: update de keel-spring.
    env: { PROFILE: 'local' },
    // Los flujos comparten la base, el broker y la caché: en serie, nunca a la vez. El reset es por
    // flujo (archivo), y dos flujos simultáneos se borrarían el Given el uno al otro.
    fileParallelism: false,
    testTimeout: ${testTimeout},
    // Arrancar el servidor y resetear la infraestructura cuesta más que un caso.
    hookTimeout: 120_000,
    reporters: [
      'default',
      [
        'junit',
        {
          outputFile: '${INTEGRATION_RESULTS}/junit.xml',
          // \`name\` es el título del caso tal cual (\`FL-PRD-001-A: …\`), sin los describe delante, y
          // \`classname\` el archivo sin extensión ni directorio: es lo que lee infra/score-scenarios.sh,
          // con los mismos programas que puntúan el XML de keel-spring.
          titleTemplate: '{title}',
          classnameTemplate: (vars: { basename: string }) => vars.basename.replace(/\\.test\\.ts$/, '')
        }
      ]
    ]
  }
});
`;
}

// ─── test/integration/support/flow.ts ────────────────────────────────────────

function flowSupportTs(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const messaging = usesMessagingHarness(model);
  const stub = httpStubHarness.usesHttpStub(model);
  const replica = usesReplica(model);
  return `/**
 * Base de las pruebas de flujo (\`test/integration/<flujo>.test.ts\`) que ejecutan los escenarios FL-*
 * de specs/validation-scenarios.md contra el servidor REAL —escuchando en un puerto libre, bajo el
 * perfil \`local\`— y la infraestructura de infra/docker-compose.yaml.
 *
 * Uso, un archivo por flujo:
 *
 *   describe('FL-PRD-001 · alta de producto', () => {
 *     const flow = useFlow();
 *     it('FL-PRD-001-A: crea el producto', async () => {
 *       const response = await flow.post(\`\${ROUTE_BASE}/products\`, { sku: 'A-1' });
 *       expect(response.status, response.body).toBe(201);
 *     });
 *   });
 *
 * **Caja negra.** Una prueba de flujo importa SOLO de este módulo (y de vitest): ningún DTO, comando
 * ni entidad del servicio. Lo vigila la regla \`flujos-caja-negra\` de .dependency-cruiser.json. Este
 * archivo es la única excepción, porque arranca el servidor; los escenarios se expresan con HTTP y
 * JSON, que es lo que exige la equivalencia con el servidor de keel-spring del mismo diseño.
 *
 * **El título de cada caso empieza por su id** y dos puntos (\`FL-PRD-001-A: …\`): de ahí sale la
 * matriz de infra/score-scenarios.sh, y el nombre del volcado de su evidencia.
 *
 * Lo generó keel-nest build: no se edita. Lo que un flujo necesite y no esté aquí se escribe en el
 * propio archivo del flujo.
 */
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../../src/app.module.js';
import { loadConfiguration } from '../../../src/infrastructure/config/configuration.js';
import { HTTP_APPLICATION_OPTIONS, configureHttp, createHttpAdapter } from '../../../src/infrastructure/http/http-platform.js';${messagingHarnessImports(model)}${stub ? `
import { forgetSequences } from './http-stub.js';

// El proveedor de prueba (WireMock de infra/): los flujos lo programan con estos helpers, importados de aquí.
export { ${httpStubHarness.HTTP_STUB_EXPORTS.join(', ')} } from './http-stub.js';
export type { StubRequest } from './http-stub.js';` : ''}
${api ? `
/** Prefijo de todas las rutas del servicio (basePath del diseño + versión). */
export const ROUTE_BASE = ${tsString(model.api.routeBase)};
` : ''}
/** Intercambio HTTP completo: lo que se asserta y lo que se vuelca al fallar. */
export interface Response {
  readonly status: number;
  /** Cabeceras de la respuesta, con el nombre en minúsculas. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Una cabecera por nombre, sin distinguir mayúsculas. */
  header(name: string): string | undefined;
  /**
   * El cuerpo leído como JSON. Lanza nombrando el cuerpo si no lo es. OJO: un número pasa por
   * \`number\`, así que \`2.50\` se lee \`2.5\` y un entero de más de 2^53 pierde dígitos: para
   * afirmar la escala de un decimal o un \`long\`, \`jsonExact()\`.
   */
  json(): any;
  /**
   * El cuerpo con CADA número como el texto exacto que viajó (\`2.50\` → \`'2.50'\`). Es la lectura
   * para afirmar la escala de un decimal, que es contrato observable: \`expect(r.jsonExact()).toStrictEqual({ amount: '2.50', … })\`.
   */
  jsonExact(): any;
}

/** Matcher de forma para un id generado (UUID): \`{ id: UUID_SHAPE }\` dentro de un \`toStrictEqual\`. */
export const UUID_SHAPE = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Matcher de forma para un instante del cable: ISO-8601 UTC con exactamente tres decimales y \`Z\`. */
export const INSTANT_SHAPE = expect.stringMatching(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/);

export type Headers = Readonly<Record<string, string>>;

/** Lo que una prueba de flujo usa para hablar con el servidor. */
export interface Flow {
  /** URL base del servidor arrancado (http://127.0.0.1:<puerto>). */
  readonly baseUrl: string;
  get(path: string, headers?: Headers): Promise<Response>;
  /** \`body\` es un objeto (se serializa) o el JSON ya escrito, tal cual viaja. */
  post(path: string, body?: unknown, headers?: Headers): Promise<Response>;
  put(path: string, body?: unknown, headers?: Headers): Promise<Response>;
  patch(path: string, body?: unknown, headers?: Headers): Promise<Response>;
  delete(path: string, headers?: Headers): Promise<Response>;
  exchange(method: string, path: string, body?: unknown, headers?: Headers): Promise<Response>;
}

// ── Evidencia ────────────────────────────────────────────────────────────────

const EVIDENCE_DIR = path.join('build', 'keel-failures');

interface Exchange {
  request: { method: string; path: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
}

interface Probe {
  command: string;
  exitCode: number | null;
  output: string;
}

// Los flujos corren en serie (fileParallelism: false) y cada caso espera a sus peticiones, así que
// basta con el último intercambio y el último sondeo del proceso.
let lastExchange: Exchange | null = null;
let lastProbe: Probe | null = null;

function clearEvidence(): void {
  lastExchange = null;
  lastProbe = null;
}

/**
 * Vuelca el informe de un fallo a \`build/keel-failures/<escenario>.json\` con la evidencia que haya
 * en memoria: es lo que lee el árbitro junto al XML, para decidir \`culprit: code | test | design\`
 * sin reproducir el escenario a mano. Mismo formato que el de keel-spring.
 */
function dumpFailure(scenario: string, displayName: string, testClass: string, phase: string | null, error: unknown): void {
  const report: Record<string, unknown> = { scenario, displayName, testClass };
  if (phase) report.phase = phase;
  report.assertion = error instanceof Error ? error.message : String(error);
  if (lastExchange) Object.assign(report, lastExchange);
  if (lastProbe) report.probe = lastProbe;
  const name = scenario.replace(/[^A-Za-z0-9_.-]/g, '_') || 'unnamed';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, \`\${name}.json\`), \`\${JSON.stringify(report, null, 2)}\\n\`);
  clearEvidence();
}

/** El id del escenario: lo que va delante de los dos puntos del título del caso. */
function scenarioOf(title: string): string {
  return title.split(':')[0].trim();
}

/** El archivo de un flujo sin directorio ni extensión: lo mismo que pone el XML en \`classname\`. */
function flowName(file: string | undefined): string {
  return path.basename(file ?? 'unknown').replace(/\\.test\\.ts$/, '');
}

// ── Servidor ─────────────────────────────────────────────────────────────────

/** El servidor del flujo en curso: lo usan los helpers que preguntan al propio servicio (mensajería). */
let currentApp: NestFastifyApplication | null = null;

/**
 * Registra el ciclo de vida de un flujo y devuelve con qué hablarle al servidor. Se llama UNA vez,
 * dentro del \`describe\` del archivo:
 *
 *   · antes de todo, arranca el servidor${reset ? ' y deja el estado como recién arrancado (\`resetState()\`): el reset es POR FLUJO, nunca entre escenarios —dentro de un flujo, un escenario usa lo que dejó el anterior—' : ''};
 *   · al fallar un caso, vuelca su evidencia;
 *   · al terminar, cierra el servidor.
 *
 * Si el arranque falla, Vitest da los casos del archivo por OMITIDOS (no por fallidos): por eso se
 * vuelca \`build/keel-failures/<flujo>-init.json\`, que infra/score-scenarios.sh lee para decir que
 * el arnés —no el servidor— está roto.
 */
export function useFlow(): Flow {
  let app: NestFastifyApplication | null = null;
  let baseUrl = '';

  // Vitest 5: el primer argumento es el contexto de fixtures (tiene que desestructurarse) y la
  // suite llega en el segundo.
  beforeAll(async ({}, suite) => {
    try {
      app = await startServer();
      currentApp = app;
      const address = app.getHttpServer().address() as AddressInfo;
      baseUrl = \`http://127.0.0.1:\${address.port}\`;${reset ? `
      resetState();` : ''}${stub ? `
      // El reset ya vació el stub; las secuencias que programó el flujo anterior, también se olvidan.
      forgetSequences();` : ''}${messaging ? `
      // El broker arriba (un flujo anterior pudo dejarlo parado) y la conexión del servicio hecha, con su
      // topología: sin ella, la primera entrega del flujo no encontraría cola.
      await prepareMessaging();` : ''}
    } catch (error) {
      const file = flowName(suite.file?.name);
      dumpFailure(\`\${file}-init\`, suite.name, file, 'beforeAll', error);
      throw error;
    }
  });

  afterAll(async () => {${replica ? `
    // La red de los escenarios de clúster: una réplica viva seguiría publicando y barriendo en el flujo siguiente.
    await stopReplica();` : ''}
    await app?.close();
    currentApp = null;
  });

  beforeEach((context) => {
    clearEvidence();
    context.onTestFailed(({ task }) => {
      const error = task.result?.errors?.[0];
      dumpFailure(scenarioOf(task.name), task.name, flowName(task.file?.name), null, error?.message ?? error ?? 'fallo sin error');
    });
  });

  const exchange = (method: string, route: string, body?: unknown, headers?: Headers) =>
    send(baseUrl, method, route, body, headers);
  return {
    get baseUrl() {
      return baseUrl;
    },
    get: (route, headers) => exchange('GET', route, undefined, headers),
    post: (route, body, headers) => exchange('POST', route, body, headers),
    put: (route, body, headers) => exchange('PUT', route, body, headers),
    patch: (route, body, headers) => exchange('PATCH', route, body, headers),
    delete: (route, headers) => exchange('DELETE', route, undefined, headers),
    exchange
  };
}

/** El servidor del proyecto, el mismo que arranca src/main.ts, escuchando en un puerto libre. */
async function startServer(): Promise<NestFastifyApplication> {
  const configuration = loadConfiguration({ ...process.env, PROFILE: process.env.PROFILE ?? 'local' });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(configuration),
    createHttpAdapter(),
    { ...HTTP_APPLICATION_OPTIONS, logger: ['error', 'warn'] }
  );
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

${replica ? replicaSection(model) : ''}/**
 * Una petición HTTP de verdad. Nunca lanza por un 4xx/5xx: el status es una aserción del escenario,
 * no un error. Registra el intercambio para la evidencia.
 */
async function send(baseUrl: string, method: string, route: string, body?: unknown, headers: Headers = {}): Promise<Response> {
  if (!baseUrl) throw new Error('El servidor no está arrancado: useFlow() se llama dentro del describe del flujo.');
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const requestHeaders: Record<string, string> = { accept: 'application/json', ...headers };
  if (payload !== null && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-type')) {
    requestHeaders['content-type'] = 'application/json';
  }
  const response = await fetch(new URL(route, baseUrl), { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  const received: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    received[name] = value;
  });
  lastExchange = {
    request: { method, path: route, headers: requestHeaders, body: payload },
    response: { status: response.status, headers: received, body: text }
  };
  return {
    status: response.status,
    headers: received,
    body: text,
    header: (name) => received[name.toLowerCase()],
    json: () => parseJson(text, response.status, false),
    jsonExact: () => parseJson(text, response.status, true)
  };
}

function parseJson(text: string, status: number, exact: boolean): any {
  try {
    // Node 22+: el reviver recibe el texto fuente de cada primitivo (context.source).
    return exact
      ? JSON.parse(text, (_key, value, context?: { source?: string }) => (typeof value === 'number' && context?.source ? context.source : value))
      : JSON.parse(text);
  } catch {
    throw new Error(\`La respuesta no es JSON (status \${status}): \${text.slice(0, 400)}\`);
  }
}

// ── Infraestructura ──────────────────────────────────────────────────────────

/**
 * Ejecuta un comando, registra su salida como el último SONDEO (la evidencia de lo que no es HTTP) y
 * lanza nombrando sus últimas líneas si sale mal. Argumentos siempre como lista, nunca concatenados
 * en una cadena para un shell: en Windows el cliente de contenedores reinterpreta las comillas.
 */
export function run(command: string, args: readonly string[], hint = '', input?: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', input });
  const output = \`\${result.stdout ?? ''}\${result.stderr ?? ''}\${result.error ? String(result.error) : ''}\`;
  lastProbe = { command: [command, ...args].join(' '), exitCode: result.status, output };
  if (result.status !== 0) {
    const tail = output.trim().split(/\\r?\\n/).slice(-12).join('\\n') || '(no escribió nada)';
    throw new Error(\`\${command} \${args.join(' ')} falló (código \${result.status}). \${hint}\\n\${tail}\`);
  }
  return result.stdout ?? '';
}

/**
 * El bash con el que se invocan los scripts de infra/. En Windows, \`bash\` a secas puede resolver al
 * lanzador de WSL (System32 va antes que el PATH), un Linux aislado que no ve el PATH ni las
 * variables de Windows: se busca el de Git for Windows, con override por \`BASH_EXECUTABLE\`.
 */
function bashExecutable(): string {
  const configured = process.env.BASH_EXECUTABLE;
  if (configured) return configured;
  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
      'C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe'
    ];
    for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'bash';
}

/** El runtime de contenedores: \`CONTAINER_RUNTIME\`, o docker si está, o podman. */
export function containerRuntime(): string {
  if (process.env.CONTAINER_RUNTIME) return process.env.CONTAINER_RUNTIME;
  return spawnSync('docker', ['--version']).status === 0 ? 'docker' : 'podman';
}
${reset ? `
/**
 * Deja el estado como recién arrancado: exactamente lo que enumera \`infra/reset-db.sh\`. Un recurso
 * que no esté en esa lista NO se puede dar por limpio. \`useFlow()\` ya lo llama al empezar cada
 * flujo; llamarlo a mano solo tiene sentido para un escenario que necesite empezar de cero.
 */
export function resetState(): void {
  run(bashExecutable(), ['infra/reset-db.sh'], '¿Está la infraestructura arriba (bash infra/up.sh)?');
}
` : ''}${probe ? `
const DB_CONTAINER = ${tsString(probe.container)};
const DB_QUERY_ARGV: readonly string[] = ${JSON.stringify(probe.argv)};

/**
 * Ejecuta una sentencia contra la base de prueba (${probe.label}) y devuelve su salida en crudo.
 *
 * Es para lo que no se ve por HTTP: que una escritura llegó de verdad al almacén, o la precondición
 * de un escenario que ninguna operación del diseño puede fabricar. No es la vía por defecto: si el
 * servicio lo expone por su API, se comprueba por ahí, que es lo que haría un cliente. La sentencia
 * viaja como UN argumento más, nunca armada para un shell.
 */
export function db(sql: string): string {
  return run(containerRuntime(), ['exec', DB_CONTAINER, ...DB_QUERY_ARGV, sql], '¿Está la base arriba (bash infra/up.sh)?');
}
${rescueSection(model)}${httpStubHarness.reconciliationAgingSection(model, { idLiteralDeclared: rescueSection(model) !== '' })}` : ''}${documentHarnessSection(model)}${identitySection(model)}${messagingHarnessSection(model)}

/** Espera hasta que \`condition\` se cumpla o se agote \`timeoutMs\`; lanza con \`message\` si no llega. */
export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, message = 'la condición no se cumplió a tiempo'): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
`;
}

// ─── test/integration/harness-smoke.test.ts ──────────────────────────────────

function harnessSmokeTs(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const documentDb = documentProbe(model);
  const credential = api ? closingCredential(model) : null;
  const identity = usesIdentityHarness(model) ? smokeCredentials(model) : null;
  const imports = [
    'useFlow',
    api ? 'ROUTE_BASE' : null,
    reset ? 'resetState' : null,
    probe ? 'db' : null,
    documentDb ? 'mongoEval' : null,
    ...['bearer', 'tokenFor', 'serviceCredential', 'apiKey'].filter((name) => `${credential ?? ''}${identity ?? ''}`.includes(`${name}(`))
  ].filter(Boolean);
  const cases = [];
  if (reset) {
    cases.push(`  it('SMOKE-1: el reset de estado se ejecuta sin error', () => {
    // Sin él, ningún flujo arranca con el Given que declara.
    expect(() => resetState()).not.toThrow();
  });`);
  }
  cases.push(`  it('SMOKE-2: el servidor responde', async () => {
    const response = await flow.get('/livez');
    expect(response.status, response.body).toBe(200);
  });`);
  if (probe) {
    cases.push(`  it('SMOKE-3: la base de prueba responde a una sentencia', () => {
    // Es la vía de los Then que miran el almacén: si no responde, fallarían por la fontanería.
    expect(db('SELECT 1').trim()).toBe('1');
  });`);
  }
  if (documentDb) {
    cases.push(`  it('SMOKE-3: la base de prueba responde a un script', () => {
    // Es la vía de los Then que miran el almacén y de las precondiciones del rescate y la reconciliación: el
    // script viaja por ARCHIVO e impreso. Si esto no devuelve 1, devolverían vacío, que parece un cero.
    expect(mongoEval('db.runCommand({ ping: 1 }).ok').trim()).toBe('1');
  });`);
  }
  if (api) {
    cases.push(`  it('SMOKE-4: la API responde con ErrorResponse y correlación', async () => {
    // Con seguridad, con la credencial que satisface la regla de cierre: sin ella, un camino que no
    // existe es 401 (se decide antes de enrutar), y el humo mediría la autorización.
    const response = await flow.get(\`\${ROUTE_BASE}/keel-smoke-ruta-inexistente\`, { ${credential && credential !== '{}' ? `...${credential}, ` : ''}'X-Correlation-Id': 'keel-smoke' });
    expect(response.status, response.body).toBe(404);
    expect(response.json().status).toBe(404);
    expect(response.header('x-correlation-id')).toBe('keel-smoke');
  });`);
  }
  if (identity) cases.push(identity);
  if (httpStubHarness.usesHttpStub(model)) {
    imports.push('stubFor', 'stubCallCount');
    cases.push(`  it('SMOKE-6: el proveedor de prueba se deja programar', async () => {
    // Sin él, cada flujo con una llamada saliente fallaría por el stub, no por lo que mide. ¿Está WireMock arriba?
    await stubFor('GET', '/__keel-smoke', 200, { ok: true });
    const response = await fetch('http://localhost:8090/__keel-smoke');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
    expect(await stubCallCount('GET', '/__keel-smoke')).toBe(1);
  });`);
  }
  return `// Humo del arnés: la fontanería de la que dependen TODOS los flujos (servidor vivo${reset ? ', reset' : ''}${
    probe ? ', base de prueba' : ''
  }${api ? ', API' : ''}).
// infra/score-scenarios.sh lo ejecuta ANTES que la suite: correrla sobre una fontanería rota produce
// decenas de fallos que parecen de negocio y no lo son. Lo generó keel-nest build: no se edita.
import { describe, expect, it } from 'vitest';
import { ${imports.join(', ')} } from './support/flow.js';

describe('humo del arnés', () => {
  const flow = useFlow();

${cases.join('\n\n')}
});
`;
}

// ─── infra/score-scenarios.sh ────────────────────────────────────────────────
//
// Puntuación MECÁNICA de la matriz de escenarios: «FL-x → OK | FALLO | NO_EJERCITADO» sale del XML
// de JUnit, sin criterio de por medio. Mismo contrato de salida y de códigos que el de keel-spring,
// para que el orquestador sea el mismo: la causa de un rojo llega por stdout y la salida de Vitest
// va entera a un log.

function scoreScenariosScript(model) {
  return `#!/usr/bin/env bash
# score-scenarios.sh — ejecuta las pruebas de integración de ${model.service.name} y
# puntúa los escenarios FL-* contra specs/validation-scenarios.md.
#
# La matriz sale del XML JUnit que escribe Vitest (${INTEGRATION_CONFIG}), sin
# criterio de por medio: el título de cada caso lleva el id delante de los dos puntos
# (FL-PRD-001-A: …). Arbitrar de quién es la culpa de un fallo NO es trabajo de este
# script — para eso está el agente de validación, que se invoca solo si aquí sale algo
# en rojo.
#
# Uso (desde la raíz del proyecto, con la infraestructura arriba y npm ci hecho):
#   bash infra/score-scenarios.sh           # humo del arnés + suite + matriz
#   bash infra/score-scenarios.sh --score   # solo re-puntúa el XML ya existente
#
# Salida: la matriz por stdout (la de Vitest va al log). Código de salida:
#   0  todos los escenarios en OK
#   1  hay FALLO o NO_EJERCITADO → hay algo que arbitrar
#   2  precondición o arnés roto Y NADA QUE ARBITRAR: la suite no se ejecutó, o un
#      flujo no llegó a arrancar sin dejar ni un FL-* en FALLO. Si además hay
#      escenarios en FALLO, sale 1: esos se arbitran.
#   (3, entorno bloqueado, es del script de keel-spring: Vitest no deja workers que
#   sostengan el directorio entre corridas.)
set -u

RESULTS="${INTEGRATION_RESULTS}"
LOG_DIR="build/keel-scenarios"
LOG="$LOG_DIR/run.log"
EVIDENCE="build/keel-failures"
SCENARIOS="specs/validation-scenarios.md"
VITEST="./node_modules/.bin/vitest"

if [ ! -f package.json ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró package.json)." >&2
  exit 2
fi
if [ ! -e "$VITEST" ]; then
  echo "No están instaladas las dependencias (falta $VITEST): ejecuta npm ci (o npm install la primera vez)." >&2
  exit 2
fi

mkdir -p "$LOG_DIR"

# La evidencia de la corrida ANTERIOR se borra antes de empezar: un volcado que sobrevive a
# una corrida verde se lee igual que uno recién escrito, y engaña.
rm -rf "$EVIDENCE"

${specsSealCheck('keel-nest')}

score_only=0
[ "\${1:-}" = "--score" ] && score_only=1
suite_failed=0

if [ "$score_only" -eq 0 ]; then
  rm -rf "$RESULTS"
  # Humo del arnés primero: son segundos y comprueba la fontanería de la que dependen
  # TODOS los flujos. En rojo no se ejecuta la suite.
  echo "Humo del arnés (${path.basename(HARNESS_SMOKE_TS)})…"
  if ! "$VITEST" run --config ${INTEGRATION_CONFIG} ${HARNESS_SMOKE_TS} >"$LOG" 2>&1; then
    echo ""
    echo "HARNESS: KO — la suite NO se ejecutó."
    echo "  El defecto está en el andamiaje que generó build (${FLOW_SUPPORT_TS},"
    echo "  ${HARNESS_SMOKE_TS}) o falta infraestructura (bash infra/up.sh && bash infra/validate-infra.sh)."
    if ls "$EVIDENCE"/*.json >/dev/null 2>&1; then
      echo "  evidencia: $EVIDENCE/"
    fi
    echo "  log: $LOG"
    exit 2
  fi
  echo "Humo del arnés: OK."
  rm -rf "$EVIDENCE" "$RESULTS"
  echo "Ejecutando la suite completa…"
  # El código de salida de Vitest se GUARDA: la matriz solo mira los FL-*, y una prueba en
  # rojo que no sea un escenario no aparecería en ninguna fila.
  "$VITEST" run --config ${INTEGRATION_CONFIG} >>"$LOG" 2>&1 || suite_failed=1
fi

if ! ls "$RESULTS"/*.xml >/dev/null 2>&1; then
  echo ""
  echo "No hay resultados en $RESULTS: la suite no llegó a ejecutarse."
  echo "  log: $LOG"
  exit 2
fi

# Matriz desde el XML de JUnit (los mismos programas que puntúan el de keel-spring).
matrix="$(awk '
${JUNIT_MATRIX_AWK}
' "$RESULTS"/*.xml 2>/dev/null | sort -k2,2)"

# Escenarios que el documento declara y ninguna prueba ejercita: cobertura que falta.
uncovered=""
if [ -f "$SCENARIOS" ]; then
  covered="$(printf '%s\\n' "$matrix" | cut -f2)"
  for id in $(grep -oE '^#{1,6}[[:space:]]*FL-[A-Za-z0-9-]+' "$SCENARIOS" \\
              | grep -oE 'FL-[A-Za-z0-9-]+' | sort -u); do
    printf '%s\\n' "$covered" | grep -qE "^\${id}(-|$)" || uncovered="$uncovered $id"
  done
fi

echo ""
echo "MATRIZ"
printf '%s\\n' "$matrix" | while IFS="$(printf '\\t')" read -r result id cls; do
  [ -n "\${id:-}" ] || continue
  if [ "$result" = "FALLO" ]; then
    printf '  %-8s %-20s %-28s %s\\n' "$result" "$id" "$cls" "$EVIDENCE/$id.json"
  else
    printf '  %-8s %-20s %s\\n' "$result" "$id" "$cls"
  fi
done
for id in $uncovered; do
  printf '  %-8s %s\\n' "NO_EJERC" "$id"
done

ok=$(printf '%s\\n' "$matrix" | grep -c '^OK')
ko=$(printf '%s\\n' "$matrix" | grep -c '^FALLO')
sk=$(printf '%s\\n' "$matrix" | grep -c '^OMITIDO')
nc=0
for id in $uncovered; do nc=$((nc + 1)); done

# Las pruebas en rojo que NO son escenarios: la matriz solo conoce los FL-*.
non_scenario_failures() {
  awk '
${JUNIT_NON_SCENARIO_AWK}
  ' "$RESULTS"/*.xml 2>/dev/null
}

# Los flujos que no llegaron a arrancar. En Vitest un beforeAll que revienta da los casos del
# archivo por OMITIDOS, no por fallidos —el gemelo del initializationError de JUnit—, y el arnés
# deja el volcado <flujo>-init.json. Sin esto, «omitido» diría «alguien lo saltó» cuando lo que
# hubo fue un rojo del arranque.
init_failures() {
  for file in "$EVIDENCE"/*-init.json; do
    [ -f "$file" ] || continue
    node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const msg = String(report.assertion ?? "").replace(/\\s+/g, " ").slice(0, 400);
      console.log("    " + report.testClass + "  (arranque del flujo)");
      if (msg) console.log("      " + msg);
    ' "$file"
  done
}

broken="$(non_scenario_failures)$(init_failures)"

echo ""
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$ok" -gt 0 ]; then
  if [ "$suite_failed" -ne 0 ]; then
    echo "RESULTADO: KO — los $ok escenario(s) FL-* están en OK, pero la suite falló."
    echo "  Hay pruebas en rojo que NO son escenarios y por eso no salen en la matriz:"
    printf '%s\\n' "$broken"
    echo "  log completo de Vitest: $LOG"
    echo "  Son del agente de pruebas, no del diseño: o las arregla o las retira."
    echo "  Sale con 2 y NO con 1: no hay ningún FL-* en FALLO, así que no hay ningún Then"
    echo "  que arbitrar."
    exit 2
  fi
  echo "RESULTADO: OK — $ok escenario(s) al 100%."
  exit 0
fi

echo "RESULTADO: KO — $ok OK · $ko FALLO · $sk omitido(s) · $nc no ejercitado(s)."
echo "  evidencia por fallo: $EVIDENCE/<FL-id>.json (request, response y aserción)"
echo "  log completo de Vitest: $LOG"
if [ -n "$broken" ]; then
  echo ""
  echo "  ARNÉS: hay pruebas en rojo que NO son escenarios, o flujos que no llegaron a arrancar."
  printf '%s\\n' "$broken"
  echo "  Un flujo que no arrancó deja sus FL-* como OMITIDO: no es falta de cobertura ni un"
  echo "  salto. La causa va debajo de cada uno; el volcado, en $EVIDENCE/<flujo>-init.json."
  if [ "$ko" -eq 0 ]; then
    echo "  No hay ningún escenario en FALLO: no hay nada que arbitrar, así que esto sale"
    echo "  con 2 (arnés roto) y no con 1: se arregla el flujo y se vuelve a puntuar."
    exit 2
  fi
  echo "  PERO hay $ko escenario(s) FL-* en FALLO, y eso SÍ se arbitra: esto sale con 1."
fi

# La matriz VACÍA no es un rojo que arbitrar: la suite corrió y no ejercitó ni un FL-*.
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ]; then
  echo ""
  echo "  ARNÉS: la matriz está VACÍA — la suite no ejercitó ni un escenario FL-*."
  echo "  No hay nada que arbitrar: sale con 2 y vuelve al agente de pruebas."
  exit 2
fi
exit 1
`;
}

// ─── infra/check-flows.sh ────────────────────────────────────────────────────
//
// El gate de compilación del agente de PRUEBAS. En keel-spring compila src/integrationTest sin
// src/main/java (está fuera de su classpath), y eso es lo que le deja trabajar en paralelo con el
// agente de código. En TypeScript tsc sigue los imports de support/flow.ts hasta src/, así que un
// src/ a medio escribir pondría rojo el chequeo de quien no lo escribe: aquí solo cuentan los errores
// de test/integration/. Los de src/ se dicen aparte, como de otro.

function flowsTsconfig() {
  const config = {
    extends: './tsconfig.json',
    compilerOptions: { noEmit: true, incremental: false },
    include: ['test/integration', 'src/types', 'vitest.integration.config.ts']
  };
  return `${JSON.stringify(config, null, 2)}
`;
}

function checkFlowsScript() {
  // String.raw: el bash va tal cual, sin escapar barras (no lleva ninguna interpolación de JS).
  return String.raw`#!/usr/bin/env bash
# check-flows.sh — compila las pruebas de flujo (test/integration/) y solo juzga ESAS.
#
# tsc sigue los imports del arnés hasta src/, así que un src/ a medio escribir también daría errores;
# esos no son de las pruebas de flujo y se listan aparte, sin poner este gate en rojo. Además
# ejecuta la regla de la caja negra (un flujo no importa src/).
#
# Uso (desde la raíz; no necesita infraestructura):
#   bash infra/check-flows.sh
# Sale con 0 si las pruebas de flujo compilan y respetan la caja negra, y con 1 si no.
set -u
cd "$(dirname "$0")/.."
mkdir -p build

out="$(./node_modules/.bin/tsc -p tsconfig.flows.json 2>&1)"
mine="$(printf '%s\n' "$out" | grep -E '^test/integration/' || true)"
others="$(printf '%s\n' "$out" | grep -E '^[^ ].*\([0-9]+,[0-9]+\): error' | grep -vE '^test/integration/' || true)"

fail=0
if [ -n "$mine" ]; then
  echo "Las pruebas de flujo no compilan:"
  printf '%s\n' "$mine" | sed 's/^/  /'
  fail=1
fi
if [ -n "$others" ]; then
  echo "AVISO: hay errores FUERA de test/integration/ (no son de las pruebas de flujo; no cuentan aquí):"
  printf '%s\n' "$others" | sed 's/^/  /' | head -20
fi
if ! ./node_modules/.bin/depcruise test/integration --config .dependency-cruiser.json >build/keel-flows-depcruise.log 2>&1; then
  echo "Caja negra rota: una prueba de flujo importa src/ (regla flujos-caja-negra):"
  sed 's/^/  /' build/keel-flows-depcruise.log | head -20
  fail=1
fi
[ "$fail" -eq 0 ] && echo "Pruebas de flujo: compilan y respetan la caja negra."
exit "$fail"
`;
}

/** SMOKE-5: el proveedor de identidad emite las credenciales con las que van a llamar los flujos. */
function smokeCredentials(model) {
  const sec = model.security;
  if (sec.protocol !== 'oidc' && sec.protocol !== 'jwt') return null;
  const checks = [];
  const role = sec.roles?.[0];
  const client = sec.serviceClients?.[0]?.name;
  if (role) checks.push(`    expect(await tokenFor(${tsString(role)}), ${tsString(`el proveedor no devolvió token para el rol '${role}'`)}).not.toBe('');`);
  if (client && sec.serviceAuth && sec.serviceAuth.protocol !== 'api-key') {
    checks.push(`    expect(await serviceCredential(${tsString(client)}), ${tsString(`no hay credencial de máquina para '${client}': revisa infra/test-credentials.env`)}).not.toBe('');`);
  }
  if (checks.length === 0) return null;
  return `  it('SMOKE-5: el proveedor de identidad emite credenciales', async () => {
    // Sin ellas, cada flujo autenticado fallaría con un 401 que parece de negocio. ¿Se ejecutó infra/init-keycloak.sh?
${checks.join('\n')}
  });`;
}

// ─── El rescate de un barrido (incremento 10c) ───────────────────────────────

/**
 * Los helpers con los que un flujo fabrica la precondición del RESCATE: una fila en vuelo que una réplica
 * muerta dejó a medias (`stallInFlight`), la misma recién entrada en vuelo, que el rescate NO debe tocar
 * (`putInFlight`), y cuántas quedaron en vuelo sin reloj (`inFlightWithoutClock`, que vale cero siempre).
 * Los mismos que el AbstractFlowIT de keel-spring, con las mismas sentencias (keel-core/gen/scheduling.js) y
 * los literales del motor de su catálogo. Sin un motor que declare esos literales no se emiten: un UPDATE
 * que no casa dejaría el escenario verde sin haber atascado nada.
 */
function rescueSection(model) {
  const entry = DATABASES[engineOf(model)];
  if (!entry?.staleTimestamp || !entry?.uuidLiteral) return '';
  const probes = rescueProbes(model);
  if (probes.length === 0) return '';
  const now = entry.nowTimestamp ?? 'CURRENT_TIMESTAMP';
  const rows = probes
    .map(
      (probe) => `  ${tsString(probe.operation)}: {
    stall: ${tsString(stallSql({ ...probe, clockSql: entry.staleTimestamp }))},
    put: ${tsString(stallSql({ ...probe, clockSql: now }))},
    missing: ${tsString(missingClockCountSql(probe))}
  }`
    )
    .join(',\n');
  const known = probes.map((probe) => probe.operation).join(', ');
  return `
/** Las sentencias del rescate de cada barrido que lo tiene: ${known}. */
const RESCUES: Readonly<Record<string, { readonly stall: string; readonly put: string; readonly missing: string }>> = {
${rows}
};

function rescueOf(operation: string): { readonly stall: string; readonly put: string; readonly missing: string } {
  const rescue = RESCUES[operation];
  if (rescue == null) throw new Error(\`No hay rescate para el barrido '\${operation}'. Los que lo tienen: ${known}\`);
  return rescue;
}

function idLiteral(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(\`No es un id: '\${id}'\`);
  return ${tsString(entry.uuidLiteral.prefix)} + id + ${tsString(entry.uuidLiteral.suffix)};
}

/**
 * Deja la fila \`id\` EN VUELO con el reloj infinitamente rancio: el estado exacto en el que queda una réplica
 * que murió con ella en la mano, que es lo que el rescate busca. No dispara el barrido —lo dispara su cron,
 * como en producción— y no siembra la fila: mueve una creada por la API.
 */
export function stallInFlight(operation: string, id: string): void {
  db(rescueOf(operation).stall + idLiteral(id));
}

/**
 * Lo mismo con el reloj a AHORA: la fila acaba de entrar en vuelo y hay alguien trabajando en ella. Es la mitad
 * que separa rescatar de robarle el trabajo a quien lo está haciendo: un rescate sin cota temporal pasa el
 * escenario del rescate y falla aquí.
 */
export function putInFlight(operation: string, id: string): void {
  db(rescueOf(operation).put + idLiteral(id));
}

/**
 * Cuántas filas quedaron EN VUELO con el reloj sin estampar. Tiene que valer cero siempre: si el reclamo mueve el
 * estado sin estampar la marca en el MISMO UPDATE, la fila que caiga en esa ventana queda irrescatable.
 */
export function inFlightWithoutClock(operation: string): number {
  const output = db(rescueOf(operation).missing).trim();
  const count = Number(output.split(/\\s+/).pop());
  if (!Number.isInteger(count)) throw new Error(\`La cuenta de filas sin reloj no es un número: '\${output}'\`);
  return count;
}
`;
}

// ─── La segunda réplica (escenarios de clúster) ───────────────────────────────

/**
 * ¿Hay escenarios de clúster posibles? Las mismas condiciones que keel-spring: el relay del outbox, un barrido
 * por reloj o el registro de idempotencia, que son las garantías «aunque haya varias réplicas».
 */
export function usesReplica(model) {
  return usesNestOutbox(model) || usesScheduling(model) || usesRequestIdempotency(model);
}


function replicaSection(model) {
  const onReplica = usesApi(model)
    ? `
/**
 * Una petición dirigida a la SEGUNDA réplica, no a la del flujo: es lo que permite que dos peticiones
 * simultáneas con la misma clave lleguen a instancias distintas, el caso que el registro de idempotencia
 * existe para cerrar.
 */
export function onReplica(method: string, route: string, body?: unknown, headers?: Headers): Promise<Response> {
  if (!replica) throw new Error('La réplica no está arrancada: llama antes a startReplica()');
  return send(replicaUrl, method, route, body, headers);
}
`
    : '';
  return `// ── Segunda réplica ──────────────────────────────────────────────────────────

/** La segunda instancia del servicio, si un escenario de clúster la arrancó. */
let replica: NestFastifyApplication | null = null;
let replicaUrl = '';

/**
 * Arranca una SEGUNDA instancia del servicio contra la misma infraestructura y devuelve su URL base. Es la
 * palanca de los escenarios de clúster: con dos instancias vivas hay dos relays del outbox y dos barridos
 * compitiendo por las mismas filas, y una petición puede dirigirse a una u otra. Sin esto, «lo arbitra la
 * clave primaria» y «cada réplica se lleva un lote disjunto» son afirmaciones que ningún escenario toca.
 *
 * Es un segundo AppModule en este proceso, con su propio puerto, su propio pool de conexiones, su propio
 * planificador y su propio relay: lo que se contrasta es que dos instancias con estado propio no se pisan.
 * (En keel-spring es un proceso aparte, porque dos contextos en la misma JVM comparten demasiado; aquí cada
 * AppModule construye su grafo entero y no comparte nada salvo el event loop.)
 *
 * **El escenario que la arranca la para**, en un \`finally\` con \`stopReplica()\`: una réplica viva sigue
 * publicando y barriendo. Como red, el flujo la para al cerrar.
 */
export async function startReplica(): Promise<string> {
  if (replica) return replicaUrl;
  replica = await startServer();
  const address = replica.getHttpServer().address() as AddressInfo;
  replicaUrl = \`http://127.0.0.1:\${address.port}\`;
  return replicaUrl;
}

/** Para la réplica, ordenadamente (cierra su servidor, sus consumidores y su pool). Idempotente. */
export async function stopReplica(): Promise<void> {
  const running = replica;
  replica = null;
  replicaUrl = '';
  await running?.close();
}
${onReplica}
`;
}
