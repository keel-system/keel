// La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`) en keel-nest: incremento 2 de
// PLAN-DSL-225-ESCRITURA-CONDICIONAL.md, con el reparto de keel-dotnet. Lo que decide QUÉ (las escrituras listadas, las
// lecturas que dan el ETag, la cabecera, los errores, la nota y el gate) es de keel-core/gen/conditional-writes.js; aquí
// solo se escribe en TypeScript:
//
//   · `Versioned<T>` (application/interfaces): lo que devuelve el handler de una lectura derivada y de una escritura que
//     devuelve su raíz (D6). El compilador obliga al agente a dar la versión.
//   · `PreconditionFailedException` (412) y `PreconditionRequiredException` (428), en domain/errors: DomainException con
//     el code efectivo y el texto de keel-core/gen/api-errors.js. El filtro de errores ya traduce su status.
//   · `conditional-requests.ts` (infrastructure/rest): lee If-Match a la lista de versiones que se estampa en el mensaje
//     (D2, D5), da el 428 y escribe el ETag (D1). Lo llama el controlador ANTES del lector: el 428 va antes que todo 400
//     del lector (D3). Un cuerpo que no es JSON lo rechaza Fastify antes de la ruta, como Spring.
//   · `loadExpecting` en el puerto de cada raíz escrita y en sus dos adaptadores (D4).
//   · `infra/check-conditional-writes.sh` (CW-12), el gate neutral.

import {
  CHECK_CONDITIONAL_WRITES_SH,
  EXPECTED_VERSIONS_FIELD,
  VERSION_FIELD,
  conditionalWrite,
  conditionalWriteErrors,
  conditionalWriteNote,
  conditionalWritePolicy,
  conditionalWritesGateScript,
  conditionalWritesOf,
  returnsVersioned,
  usesConditionalWrites
} from '@keel-system/keel-core/gen/conditional-writes';
import { idParamNames } from '@keel-system/keel-core/gen/api-contract';
import { conditionalWriteCases } from '@keel-system/keel-core/gen/api-cases';
import { WIRE_ETAG_CASES } from '@keel-system/keel-core/gen/wire';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';

export const VERSIONED_TS = classPath(DIRS.interfaces, 'Versioned');
export const CONDITIONAL_REQUESTS_TS = 'src/infrastructure/rest/conditional-requests.ts';
export const PRECONDITION_FAILED_TS = classPath(DIRS.errors, 'PreconditionFailedException');
export const PRECONDITION_REQUIRED_TS = classPath(DIRS.errors, 'PreconditionRequiredException');
export const LOAD_EXPECTING = 'loadExpecting';
export const EXPECTED_VERSIONS = EXPECTED_VERSIONS_FIELD;

export { usesConditionalWrites, returnsVersioned };

/** El tipo de retorno de un handler que devuelve la versión: `Versioned<ProductResponseDto>`. */
export function versionedType(result) {
  return `Versioned<${result}>`;
}

/** ¿Lleva el mensaje de esta operación la versión esperada? Solo las escrituras condicionales. */
export function carriesExpectedVersions(model, operation) {
  return Boolean(conditionalWrite(model, operation));
}

/** Las raíces que una escritura condicional carga: su puerto y sus adaptadores ganan `loadExpecting`. */
export function loadsExpecting(model, entity) {
  return (conditionalWritesOf(model)?.writes ?? []).some((write) => write.root === entity.name);
}

/** El método abstracto del puerto. */
export function loadExpectingPort(entity, idName, idType) {
  return `  /**
   * Carga el agregado comparando su versión con la que el cliente leyó (If-Match, api.concurrency): si no es ninguna de
   * \`expectedVersions\` lanza PreconditionFailedException (412) sin tocar nada; con null no compara. Null si no existe:
   * el NOT_FOUND del diseño va antes que el 412.
   */
  abstract ${LOAD_EXPECTING}(${idName}: ${idType}, expectedVersions: readonly number[] | null): Promise<${entity.name} | null>;`;
}

/**
 * El método de los dos adaptadores: carga con su findById y compara. La escritura que siga guarda con la versión LEÍDA,
 * así que otra escritura entre la carga y el commit sigue siendo el 409 de concurrencia y no el 412 (CW-5).
 */
export function loadExpectingAdapter(entity, idName, idType) {
  return `  async ${LOAD_EXPECTING}(${idName}: ${idType}, expectedVersions: readonly number[] | null): Promise<${entity.name} | null> {
    const found = await this.findById(${idName});
    if (found == null || expectedVersions == null) return found;
    const version = found.${VERSION_FIELD};
    if (version != null && expectedVersions.includes(Number(version))) return found;
    throw new PreconditionFailedException();
  }`;
}

/** La nota del handler, la de keel-core, con los nombres de TypeScript. */
export function conditionalHandlerNote(model, operation, param, repository) {
  const write = conditionalWrite(model, operation);
  const owns = idParamNames(write?.root ?? operation.responseDto?.entity ?? 'Raiz');
  const id = (operation.pathParams ?? []).find((pathParam) => owns.has(pathParam.name))?.name ?? 'id';
  return conditionalWriteNote(model, operation, {
    read: `${param}.${EXPECTED_VERSIONS}`,
    load: `this.${repository}.${LOAD_EXPECTING}(${param}.${id}, ${param}.${EXPECTED_VERSIONS})`,
    versioned: versionedType(operation.responseDto?.name ?? 'T')
  });
}

/** La línea del controlador que lee If-Match, antes del lector (D3). */
export function controllerLine(model) {
  return `    const expectedVersions = readExpectedVersions(ifMatch, ${conditionalWritePolicy(model) === 'required'});`;
}

export function generate(model) {
  if (!usesConditionalWrites(model)) return [];
  const files = [versionedFile(), ...exceptionFiles(model), requestsFile()];
  const gate = conditionalWritesGateScript(model, { handlerPath: (row) => classPath(DIRS.usecases, row.handlerClass), call: LOAD_EXPECTING });
  if (gate) files.push({ path: CHECK_CONDITIONAL_WRITES_SH, content: gate, executable: true });
  const tests = conditionalTestsFile(model);
  if (tests) files.push(tests);
  return files;
}

function versionedFile() {
  const body = `/**
 * Una respuesta con la versión de su raíz (api.concurrency): el controlador la escribe en la cabecera ETag. La versión es
 * la PERSISTIDA —la que devuelve save, o la del agregado leído—, nunca la que el handler tenía antes del commit: con esa,
 * el ETag va un número por detrás y la siguiente edición encadenada da 412 sin conflicto.
 */
export interface Versioned<T> {
  readonly version: number;
  readonly value: T;
}

/** Una respuesta con su versión. */
export function versioned<T>(version: number, value: T): Versioned<T> {
  return { version, value };
}`;
  return { path: VERSIONED_TS, content: tsModule(VERSIONED_TS, [], body) };
}

function exceptionFiles(model) {
  const { failed, required } = conditionalWriteErrors(model);
  return [
    exceptionFile(PRECONDITION_FAILED_TS, 'PreconditionFailedException', failed, 'If-Match no coincide con la versión vigente: otro escribió entre la lectura y la escritura del cliente. No se escribe nada.'),
    exceptionFile(PRECONDITION_REQUIRED_TS, 'PreconditionRequiredException', required, 'La escritura exige If-Match (api.concurrency.conditionalWrites: required) y la petición no lo trae. Se responde en el borde, sin cargar nada.')
  ];
}

function exceptionFile(file, name, error, summary) {
  const body = `/** ${summary} */
export class ${name} extends DomainException {
  static readonly CODE = ${tsString(error.code)};
  static readonly STATUS = ${error.status};
  static readonly DEFAULT_MESSAGE = ${tsString(error.message)};

  constructor(message?: string) {
    super(message ?? ${name}.DEFAULT_MESSAGE, { code: ${name}.CODE, httpStatus: ${name}.STATUS });
  }
}`;
  return { path: file, content: tsModule(file, [{ symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS }], body) };
}

function requestsFile() {
  const body = `// La escritura condicional en el borde (api.concurrency; los casos, en keel-core/gen/wire.js). El ETag es la versión
// entre comillas, fuerte y opaco; If-Match se compara en fuerte: '*' se cumple si el recurso existe (no compara), una
// lista si coincide cualquiera, y un W/"…", un valor sin comillas o ilegible no coincide con nada (412, no 400).

const STRONG_VERSION = /^"(0|[1-9][0-9]*)"$/;

/**
 * Lo que se estampa en el mensaje: null si no se compara (sin cabecera, vacía o '*') y si no las versiones fuertes que
 * trae. Sin cabecera y con \`required\`, el 428, antes de leer nada más.
 */
export function readExpectedVersions(header: string | string[] | undefined, required: boolean): number[] | null {
  const value = (Array.isArray(header) ? header.join(',') : (header ?? '')).trim();
  if (value === '') {
    if (required) throw new PreconditionRequiredException();
    return null;
  }
  if (value === '*') return null;
  const versions: number[] = [];
  for (const element of value.split(',')) {
    const match = STRONG_VERSION.exec(element.trim());
    if (match) versions.push(Number(match[1]));
  }
  return versions;
}

/** El ETag de una versión: entre comillas, fuerte. */
export function etagOf(version: number): string {
  return \`"\${version}"\`;
}`;
  return { path: CONDITIONAL_REQUESTS_TS, content: tsModule(CONDITIONAL_REQUESTS_TS, [{ symbol: 'PreconditionRequiredException', from: PRECONDITION_REQUIRED_TS }], body) };
}

// ─── Las pruebas emitidas (CW-6 a CW-10) ─────────────────────────────────────────────────────────────────────────

/**
 * CW-6, dentro de la prueba de la API (el servidor en memoria, sin base): una escritura condicional sin If-Match con
 * `required` da 428 con la forma de error del cable. Que no llegó al caso de uso lo dice el propio 428: sin base, uno que
 * empieza responde 500. `request` es cómo escribe esa prueba la petición de un caso.
 */
export function conditionalApiTests(model, request) {
  const cases = conditionalWriteCases(model);
  if (!cases?.required || !cases.write) return [];
  const { required } = cases.errors;
  return [
    `  it('CW-6: una escritura condicional sin If-Match es 428 y no llega al caso de uso', async () => {
    const response = await app.inject(${request(cases.write)});
    expectError(response, ${required.status}, ${tsString(required.error)}, ${tsString(required.code)}, ${tsString(required.message)});
  });`
  ];
}

export const CONDITIONAL_TEST = 'test/conditional-requests.test.ts';

/**
 * `test/conditional-requests.test.ts`: CW-7 (los casos de la cabecera de keel-core/gen/wire.js, leídos por el borde), CW-8
 * (la precondición sale del filtro como 412 con su code y su texto), CW-9 (CORS expone ETag, si el diseño declara CORS)
 * y CW-10 (el formato del ETag).
 */
export function conditionalTestsFile(model) {
  const cases = conditionalWriteCases(model);
  if (!cases) return null;
  const cors = Boolean(model.security?.cors);
  const rows = cases.headerCases.map((entry) => `  [${tsString(entry.id)}, ${entry.header == null ? 'undefined' : tsString(entry.header)}, ${JSON.stringify(entry.expected)}, ${tsString(entry.outcome)}, ${entry.current}]`);
  const { failed } = cases.errors;
  const imports = [
    `import { describe, expect, it } from 'vitest';`,
    `import { etagOf, readExpectedVersions } from '../src/infrastructure/rest/conditional-requests.js';`,
    `import { PreconditionFailedException } from '../src/domain/errors/precondition-failed-exception.js';`,
    `import { ApiExceptionFilter } from '../src/infrastructure/rest/api-exception-filter.js';`,
    ...(cors
      ? [`import { CorsPolicy } from '../src/infrastructure/security/cors-policy.js';`, `import { loadConfiguration } from '../src/infrastructure/config/configuration.js';`]
      : [])
  ];
  const corsTest = cors
    ? `

  it('CW-9: CORS expone el ETag', () => {
    // El perfil test fija los orígenes de una SPA en desarrollo (config/parameters/test/security.yaml).
    const policy = CorsPolicy.from(loadConfiguration({ ...process.env, PROFILE: 'test' }));
    const headers: Record<string, string> = {};
    const reply = { header: (name: string, value: string) => ((headers[name.toLowerCase()] = value), reply) };
    const request = { method: 'GET', headers: { origin: 'http://localhost:5173' }, protocol: 'http', host: 'localhost' };
    policy.apply(request as never, reply as never);
    expect((headers['access-control-expose-headers'] ?? '').split(',').map((name) => name.trim())).toContain(${tsString(cases.exposedHeader)});
  });`
    : '';
  const body = `${imports.join('\n')}

// La escritura condicional en el borde (api.concurrency): los casos de la cabecera y del ETag son los de keel-core/gen/wire.js,
// los mismos que ejecutan los otros generadores. La comparación con la versión la hace el adaptador (loadExpecting), y la
// miden db-check y doc-check.

const IF_MATCH_CASES: ReadonlyArray<[string, string | undefined, number[] | null, string, number]> = [
${rows.join(',\n')}
];

describe('escritura condicional', () => {
  it.each(IF_MATCH_CASES)('CW-7: If-Match se lee como dicen los casos del cable (%s)', (_id, header, expected, outcome, current) => {
    const stamped = readExpectedVersions(header, false);
    expect(stamped).toEqual(expected);
    // Ausente es el 428 con required, y eso lo afirma CW-6 en el servidor: aquí solo que no se compara.
    if (outcome === 'absent') return;
    // Lo mismo que compara loadExpecting: null no compara; si no, la vigente tiene que estar en la lista.
    expect(stamped == null || stamped.includes(current)).toBe(outcome === 'match');
  });

  it('CW-8: la precondición sale del filtro como 412 con su code y su texto', () => {
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const reply = {
      status: (status: number) => ((sent.status = status), reply),
      send: (payload: Record<string, unknown>) => ((sent.body = payload), reply),
      header: () => reply
    };
    const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({}) }) };
    new ApiExceptionFilter().catch(new PreconditionFailedException(), host as never);
    expect(sent.status).toBe(${failed.status});
    expect(sent.body?.status).toBe(${failed.status});
    expect(sent.body?.error).toBe(${tsString(failed.error)});
    expect(sent.body?.code).toBe(${tsString(failed.code)});
    expect(sent.body?.message).toBe(${tsString(failed.message)});
  });

  it.each(${JSON.stringify(WIRE_ETAG_CASES.map((entry) => [entry.version, entry.etag]))} as const)('CW-10: el ETag de la versión %d es %s', (version, etag) => {
    expect(etagOf(version)).toBe(etag);
  });${corsTest}
});
`;
  return { path: CONDITIONAL_TEST, content: body };
}
