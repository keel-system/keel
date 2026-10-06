// La prueba emitida de la API: `test/api.test.ts`. Arranca el servidor REAL (mismo AppModule y misma
// plataforma HTTP que main.ts) y le pide, por app.inject(), lo que el contrato fija sin depender de
// la lógica que escribe el agente:
//   · una operación que llega a su handler sale, mientras sea un TODO, como 500 con ErrorResponse;
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
  return cases;
}

function request(entry, extra = '') {
  return `{ method: ${tsString(entry.method)}, url: ${tsString(entry.url)}${extra} }`;
}

function apiTest(model) {
  const cases = apiCases(model);
  const validation = FRAMEWORK_ERRORS.validation.code;
  const tests = [];
  if (cases.reachesHandler) {
    tests.push(`  it('una operación llega a su handler; mientras es un TODO, sale como 500 con ErrorResponse', async () => {
    const response = await app.inject(${request(cases.reachesHandler)});
    // Cuando el agente implemente ${cases.reachesHandler.operation}, este caso deja de dar 500: ajústalo a su desenlace.
    expectError(response, 500, 'Internal Server Error', null, 'Ocurrió un error inesperado');
  });`);
  }
  if (cases.malformedBody) {
    tests.push(`  it('un cuerpo que no es JSON es 400 «Petición malformada», sin details', async () => {
    const response = await app.inject(${request(cases.malformedBody, ", headers: { 'content-type': 'application/json' }, payload: '{\"roto\":'")});
    expectError(response, 400, 'Bad Request', '${validation}', 'Petición malformada');
    expect(body(response).details).toBeNull();
  });`);
  }
  if (cases.invalidBody) {
    tests.push(`  it('un cuerpo que incumple lo declarado es 400 Validation Error, con el campo en details', async () => {
    const response = await app.inject(${request(cases.invalidBody, ", headers: { 'content-type': 'application/json' }, payload: '{}'")});
    expectError(response, 400, 'Validation Error', '${validation}', 'La petición no supera las validaciones');
    expect(body(response).details).toContain(${tsString(`${cases.invalidBody.field} ${cases.invalidBody.message}`)});
  });`);
  }
  if (cases.malformedPath) {
    tests.push(`  it('un uuid de ruta mal formado es 400 «Petición malformada»', async () => {
    const response = await app.inject(${request(cases.malformedPath, ", headers: { 'content-type': 'application/json' }, payload: '{}'")});
    expectError(response, 400, 'Bad Request', '${validation}', 'Petición malformada');
  });`);
  }
  if (cases.wrongMethod) {
    tests.push(`  it('un camino que existe con otro método es 405', async () => {
    const response = await app.inject(${request(cases.wrongMethod)});
    expectError(response, 405, 'Method Not Allowed', null, 'Método HTTP no soportado');
  });`);
  }
  return `import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfiguration } from '../src/infrastructure/config/configuration.js';
import { HTTP_APPLICATION_OPTIONS, configureHttp, createHttpAdapter } from '../src/infrastructure/http/http-platform.js';

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
}

describe('API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test' });
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
    const response = await app.inject({ method: 'GET', url: ${tsString(`${model.api.routeBase}/keel-ruta-que-no-existe`)} });
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

${tests.join('\n\n')}
});
`;
}
