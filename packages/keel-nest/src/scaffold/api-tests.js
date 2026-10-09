// La prueba emitida de la API: `test/api.test.ts`. Arranca el servidor REAL (mismo AppModule y misma
// plataforma HTTP que main.ts) y le pide, por app.inject(), lo que el contrato fija sin depender de
// la lógica que escribe el agente:
//   · una operación llega a su handler (sin afirmar qué responde: eso lo decide el agente);
//   · un cuerpo que no es JSON, un cuerpo que incumple lo declarado, un uuid de ruta mal formado;
//   · una ruta que no existe (404) y una que existe con otro método (405);
//   · la correlación: la recibida vuelve en la respuesta y en el cuerpo de error; una inválida se
//     sustituye.
// Las peticiones se eligen del DISEÑO: si un caso no tiene operación que lo ejercite, no se emite (y
// el test de keel-nest que mira esta prueba lo dice), en vez de inventar una ruta.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { requestShape } from 'keel-core/gen/api-contract';
import { usesApi } from './rest-support.js';
import { messageComponents } from './services.js';
import { tsString } from './render.js';
import { securityPlan, usesJwt } from './security.js';

export const API_TEST = 'test/api.test.ts';
const SAMPLE_UUID = '0192f1d2-0000-7000-8000-000000000001';

export function generate(model) {
  if (!usesApi(model)) return [];
  return [{ path: API_TEST, content: apiTest(model) }];
}

const routed = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route && !op.multipart);
const fullPath = (model, path) => `${model.api.routeBase}${path}`;
const hasRule = (field, name) => (field.inputValidation ?? []).some((rule) => rule.rule === name);

/** Un valor de muestra para un parámetro de ruta, o null si no hay uno que seguro pase su regla. */
function sample(param) {
  if (hasRule(param, 'pattern') || hasRule(param, 'min') || hasRule(param, 'max') || param.list) return null;
  if (param.kind === 'enum') return null;
  return { uuid: SAMPLE_UUID, int: '1', long: '1', string: 'abc', text: 'abc' }[param.base] ?? null;
}

function concrete(model, operation) {
  let path = fullPath(model, operation.route.path);
  for (const param of operation.pathParams ?? []) {
    const value = sample(param);
    if (value == null) return null;
    path = path.replace(`{${param.name}}`, value);
  }
  return path;
}

/** Los casos que el diseño permite ejercitar, cada uno con su petición. */
export function apiCases(model) {
  const operations = routed(model);
  const cases = {};
  // Llega al handler: sin campos obligatorios fuera de la ruta y sin cuerpo.
  for (const operation of operations) {
    const fromPath = new Set((operation.pathParams ?? []).map((p) => p.name));
    const required = messageComponents(model, operation).filter((c) => !fromPath.has(c.name) && c.required && !['page', 'size'].includes(c.name));
    const url = concrete(model, operation);
    if (required.length === 0 && url && !requestShape(operation).asBody && !messageComponents(model, operation).some((c) => c.resolvedIdentity)) {
      cases.reachesHandler = { method: operation.route.method, url, operation: operation.name };
      break;
    }
  }
  const bodyOp = operations.find((op) => requestShape(op).asBody && concrete(model, op));
  if (bodyOp) cases.malformedBody = { method: bodyOp.route.method, url: concrete(model, bodyOp) };
  for (const operation of operations) {
    const { asBody, bodyRequired } = requestShape(operation);
    // La identidad del llamante no viaja en el cuerpo (la resuelve la seguridad): no sirve de caso.
    if ((operation.bodyFields ?? []).some((f) => f.resolvedIdentity)) continue;
    const field = (operation.bodyFields ?? []).find((f) => hasRule(f, 'notBlank') || hasRule(f, 'notNull'));
    const url = concrete(model, operation);
    if (asBody && bodyRequired && field && url) {
      cases.invalidBody = { method: operation.route.method, url, field: field.name, message: hasRule(field, 'notBlank') ? 'must not be blank' : 'must not be null' };
      break;
    }
  }
  for (const operation of operations) {
    const param = (operation.pathParams ?? []).find((p) => p.base === 'uuid' && !p.list);
    if (!param) continue;
    let url = fullPath(model, operation.route.path).replace(`{${param.name}}`, 'no-es-un-uuid');
    let ok = true;
    for (const other of (operation.pathParams ?? []).filter((p) => p !== param)) {
      const value = sample(other);
      if (value == null) ok = false;
      else url = url.replace(`{${other.name}}`, value);
    }
    if (ok) {
      cases.malformedPath = { method: operation.route.method, url };
      break;
    }
  }
  // 405: un camino que existe, con un método que ninguna operación sirve en él.
  for (const operation of operations) {
    const url = concrete(model, operation);
    if (!url) continue;
    const served = new Set(operations.filter((op) => op.route.path === operation.route.path).map((op) => op.route.method));
    const other = ['DELETE', 'PUT', 'PATCH', 'POST', 'GET'].find((method) => !served.has(method));
    if (other) {
      cases.wrongMethod = { method: other, url };
      break;
    }
  }
  // La subida: la primera operación multipart con una ruta concreta y campos de los que hay muestra segura.
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route && op.multipart)) {
    const url = concrete(model, operation);
    if (!url) continue;
    const fromPath = new Set((operation.pathParams ?? []).map((p) => p.name));
    const components = messageComponents(model, operation).filter((c) => !fromPath.has(c.name) && !c.resolvedIdentity);
    const file = components.find((c) => c.file && c.required);
    if (!file) continue;
    const fields = {};
    let sampled = true;
    for (const component of components.filter((c) => !c.file && c.required)) {
      const value = sample(component);
      if (value == null || hasRule(component, 'minLength') || hasRule(component, 'size')) sampled = false;
      else fields[component.name] = value;
    }
    // El primer obligatorio, en el orden del mensaje: es el que el servidor echa en falta primero.
    const first = components.find((c) => c.required);
    cases.upload = { url, part: file.name, fields: sampled ? fields : null, firstMissing: first.file ? { part: first.name } : { parameter: first.name } };
    break;
  }
  return cases;
}

/**
 * Las opciones de app.inject() para un caso: con seguridad, la credencial que satisface toda regla del
 * diseño (CREDENTIAL, la firma la propia prueba) — el caso mide la API, no la autorización.
 */
function request(entry, { json = null, secured = false } = {}) {
  const headers = [secured ? '...CREDENTIAL' : null, json != null ? "'content-type': 'application/json'" : null].filter(Boolean);
  return `{ method: ${tsString(entry.method)}, url: ${tsString(entry.url)}${headers.length > 0 ? `, headers: { ${headers.join(', ')} }` : ''}${
    json != null ? `, payload: ${tsString(json)}` : ''
  } }`;
}

function apiTest(model) {
  const cases = apiCases(model);
  const security = securityCases(model);
  const secured = security != null;
  const validation = FRAMEWORK_ERRORS.validation.code;
  const tests = [];
  if (cases.reachesHandler) {
    // No afirma QUÉ responde el handler, solo que la ruta llega a él: así sigue en verde cuando el
    // agente lo implementa (en el perfil test no hay base, y un handler que la use sale como 500).
    tests.push(`  it('una operación llega a su handler: ni el 404 de una ruta que no existe ni el 405', async () => {
    const response = await app.inject(${request(cases.reachesHandler, { secured })});
    expect(response.statusCode).not.toBe(405);
    if (response.statusCode >= 400) {
      const parsed = body(response);
      expect(Object.keys(parsed)).toEqual(ERROR_SHAPE);
      expect(parsed.message).not.toBe('Recurso no encontrado');
    }
  });`);
  }
  if (cases.malformedBody) {
    tests.push(`  it('un cuerpo que no es JSON es 400 «Petición malformada», sin details', async () => {
    const response = await app.inject(${request(cases.malformedBody, { json: '{"roto":', secured })});
    expectError(response, 400, 'Bad Request', '${validation}', 'Petición malformada');
    expect(body(response).details).toBeNull();
  });`);
  }
  if (cases.invalidBody) {
    tests.push(`  it('un cuerpo que incumple lo declarado es 400 Validation Error, con el campo en details', async () => {
    const response = await app.inject(${request(cases.invalidBody, { json: '{}', secured })});
    expectError(response, 400, 'Validation Error', '${validation}', 'La petición no supera las validaciones');
    expect(body(response).details).toContain(${tsString(`${cases.invalidBody.field} ${cases.invalidBody.message}`)});
  });`);
  }
  if (cases.malformedPath) {
    tests.push(`  it('un uuid de ruta mal formado es 400 «Petición malformada»', async () => {
    const response = await app.inject(${request(cases.malformedPath, { json: '{}', secured })});
    expectError(response, 400, 'Bad Request', '${validation}', 'Petición malformada');
  });`);
  }
  if (cases.wrongMethod) {
    tests.push(`  it('un camino que existe con otro método es 405', async () => {
    const response = await app.inject(${request(cases.wrongMethod, { secured })});
    expectError(response, 405, 'Method Not Allowed', null, 'Método HTTP no soportado');
  });`);
  }
  if (cases.upload) {
    const { url, part, fields, firstMissing } = cases.upload;
    const headers = secured ? '...CREDENTIAL, ' : '';
    const expected = firstMissing.parameter
      ? `expectError(response, 400, 'Bad Request', '${validation}', ${tsString(`Falta el parámetro '${firstMissing.parameter}' en la petición`)});`
      : `expectError(response, 400, 'Bad Request', null, ${tsString(`Falta la parte '${firstMissing.part}' en la petición multipart`)});`;
    tests.push(`  it('una subida vacía echa en falta lo primero que el mensaje pide, como keel-spring', async () => {
    const form = multipart({});
    const response = await app.inject({ method: 'POST', url: ${tsString(url)}, headers: { ${headers}...form.headers }, payload: form.payload });
    ${expected}
  });

  it('un cuerpo JSON en una subida es 415', async () => {
    const response = await app.inject({ method: 'POST', url: ${tsString(url)}, headers: { ${headers}'content-type': 'application/json' }, payload: '{}' });
    expectError(response, 415, 'Unsupported Media Type', null, 'La operación espera multipart/form-data');
  });`);
    if (fields) {
      tests.push(`  it('una subida completa llega a su handler: lee los campos y el binario', async () => {
    const form = multipart(${JSON.stringify(fields)}, { part: ${tsString(part)}, filename: 'muestra.pdf', contentType: 'application/pdf', content: '%PDF-1.7 muestra' });
    const response = await app.inject({ method: 'POST', url: ${tsString(url)}, headers: { ${headers}...form.headers }, payload: form.payload });
    expect([400, 404, 405, 413, 415]).not.toContain(response.statusCode);
  });`);
    }
  }
  const multipartHelper = cases.upload
    ? `

/** Un cuerpo multipart/form-data escrito a mano: los campos y, si se pide, una parte binaria. */
function multipart(fields: Record<string, string>, file?: { part: string; filename: string; contentType: string; content: string }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'keel-boundary-0192f1d2';
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${name}"\\r\\n\\r\\n\${value}\\r\\n\`);
  }
  if (file) {
    chunks.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${file.part}"; filename="\${file.filename}"\\r\\nContent-Type: \${file.contentType}\\r\\n\\r\\n\${file.content}\\r\\n\`);
  }
  chunks.push(\`--\${boundary}--\\r\\n\`);
  return { payload: Buffer.from(chunks.join('')), headers: { 'content-type': \`multipart/form-data; boundary=\${boundary}\` } };
}`
    : '';
  return `import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfiguration } from '../src/infrastructure/config/configuration.js';
import { HTTP_APPLICATION_OPTIONS, configureHttp, createHttpAdapter } from '../src/infrastructure/http/http-platform.js';${security ? security.header : ''}

/** El orden de las claves de ErrorResponse: el del cable (keel-core, WIRE_SHAPES.errorResponse). */
const ERROR_SHAPE = ${JSON.stringify(WIRE_SHAPES.errorResponse)};

type Injected = { statusCode: number; payload: string; headers: Record<string, unknown> };

function body(response: Injected): Record<string, unknown> {
  return JSON.parse(response.payload) as Record<string, unknown>;
}

/** Un ErrorResponse con la forma del contrato y la correlación de la propia respuesta. */
function expectError(response: Injected, status: number, error: string, code: string | null, message: string): void {
  expect(response.statusCode).toBe(status);
  const parsed = body(response);
  expect(Object.keys(parsed)).toEqual(ERROR_SHAPE);
  expect(parsed.status).toBe(status);
  expect(parsed.error).toBe(error);
  expect(parsed.code).toBe(code);
  expect(parsed.message).toBe(message);
  expect(parsed.timestamp).toMatch(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/);
  expect(parsed.correlationId).toBe(response.headers['x-correlation-id']);
}${multipartHelper}

describe('API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
${security ? security.setup : "    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test' });"}
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(configuration)] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(), HTTP_APPLICATION_OPTIONS);
    configureHttp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('una ruta que no existe es 404 con ErrorResponse', async () => {
    const response = await app.inject({ method: 'GET', url: ${tsString(`${model.api.routeBase}/keel-ruta-que-no-existe`)}${secured ? ', headers: CREDENTIAL' : ''} });
    expectError(response, 404, 'Not Found', null, 'Recurso no encontrado');
  });

  it('la correlación recibida vuelve en la respuesta; una que no cumple el formato se sustituye', async () => {
    const kept = await app.inject({ method: 'GET', url: '/livez', headers: { 'x-correlation-id': 'pedido-42' } });
    expect(kept.headers['x-correlation-id']).toBe('pedido-42');
    const replaced = await app.inject({ method: 'GET', url: '/livez', headers: { 'x-correlation-id': 'con espacios\\ny saltos' } });
    expect(replaced.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const generated = await app.inject({ method: 'GET', url: '/livez' });
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

${[...tests, ...(security?.tests ?? [])].join('\n\n')}
});
`;
}

// ─── La seguridad, cuando el diseño la declara ───────────────────────────────

const REJECTED_401 = `'Unauthorized', '${FRAMEWORK_ERRORS.unauthenticated.code}', 'Credenciales ausentes o no válidas'`;
const REJECTED_403 = `'Forbidden', '${FRAMEWORK_ERRORS.accessDenied.code}', 'La credencial no autoriza esta operación'`;

/** El token del caso como cabecera, escrito en el TypeScript emitido. */
const bearer = (expression) => `{ authorization: \`Bearer \${${expression}}\` }`;

/**
 * Lo que la prueba de la API necesita de la seguridad: la credencial con la que pasa toda regla (para
 * que los demás casos midan la API y no la autorización, de test/support/test-credential.ts) y los
 * casos propios de la seguridad: el 401 antes de enrutar, el token que no valida, el caducado, el de otra
 * clave y el 403 de una regla.
 */
function securityCases(model) {
  const plan = securityPlan(model);
  if (!plan || plan.open) return null;
  const main = plan.chains[plan.chains.length - 1];
  const notFound = fullPath(model, '/keel-ruta-que-no-existe');
  const tests = [];
  if (main.fallback.kind !== 'public') {
    tests.push(`  it('sin credencial, un camino protegido es 401, exista o no (Spring Security decide antes de enrutar)', async () => {
    const response = await app.inject({ method: 'GET', url: ${tsString(notFound)} });
    expectError(response, 401, ${REJECTED_401});
  });`);
  }

  // La credencial de las pruebas del perfil test: test/support/test-credential.ts.
  const jwt = usesJwt(model);
  const header = `
import { testCredential, type TestCredential${jwt ? ', FULL_ACCESS, KEY_ID' : ''} } from './support/test-credential.js';${
    jwt ? "\nimport { SignJWT, generateKeyPair } from 'jose';" : ''
  }

/** La credencial de la prueba: el perfil test acepta sus tokens (test/support/test-credential.ts). */
let credential: TestCredential;
/** La cabecera con la que los casos de la API pasan la autorización. */
let CREDENTIAL: Readonly<Record<string, string>> = {};`;
  const setup = `    credential = await testCredential();
    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test', ...credential.env });
    CREDENTIAL = credential.headers;`;

  if (!jwt) {
    tests.push(`  it('una clave de API que no es la configurada no autentica: 401', async () => {
    const response = await app.inject({ method: 'GET', url: ${tsString(notFound)}, headers: { 'x-api-key': 'no-es-la-clave' } });
    expectError(response, 401, ${REJECTED_401});
  });`);
    return { header, setup, tests };
  }

  tests.push(`  it('un token que no valida es 401, también en una ruta abierta (como el resource server de Spring)', async () => {
    const response = await app.inject({ method: 'GET', url: '/livez', headers: { authorization: 'Bearer no.es-un.token' } });
    expectError(response, 401, ${REJECTED_401});
  });`);
  tests.push(`  it('un token caducado es 401', async () => {
    const expired = await credential.tokenWith(FULL_ACCESS, Math.floor(Date.now() / 1000) - 300);
    const response = await app.inject({ method: 'GET', url: ${tsString(notFound)}, headers: ${bearer('expired')} });
    expectError(response, 401, ${REJECTED_401});
  });`);
  tests.push(`  it('un token firmado con otra clave es 401', async () => {
    const stranger = await generateKeyPair('RS256');
    const forged = await new SignJWT(FULL_ACCESS).setProtectedHeader({ alg: 'RS256', kid: KEY_ID }).setExpirationTime('5m').sign(stranger.privateKey);
    const response = await app.inject({ method: 'GET', url: ${tsString(notFound)}, headers: ${bearer('forged')} });
    expectError(response, 401, ${REJECTED_401});
  });`);
  // El 403: la primera regla que exige algo, sobre una ruta de la que hay una URL concreta.
  const routed = (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route);
  for (const rule of plan.chains.flatMap((chain) => chain.rules)) {
    if (rule.requirement.kind !== 'anyOf' || !rule.method) continue;
    const operation = routed.find((op) => op.route.method === rule.method && fullPath(model, op.route.path) === rule.path);
    const url = operation ? concrete(model, operation) : null;
    if (!url) continue;
    tests.push(`  it(${tsString(`una credencial válida sin lo que exige la regla (${rule.requirement.authorities.join(' o ')}) es 403`)}, async () => {
    const bare = await credential.tokenWith({ sub: 'keel-sin-permisos' });
    const response = await app.inject({ method: ${tsString(rule.method)}, url: ${tsString(url)}, headers: ${bearer('bare')} });
    expectError(response, 403, ${REJECTED_403});
  });`);
    break;
  }

  return { header, setup, tests };
}
