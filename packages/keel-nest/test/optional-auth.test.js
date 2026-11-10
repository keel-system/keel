// La IDENTIDAD OPCIONAL (DSL 2.27, `level: optional`) en keel-nest, EJECUTANDO lo emitido: el hook de seguridad, las
// reglas, el autenticador JWT (jose, con una clave de la prueba) y el lector del controlador sobre un Fastify real.
// Los casos OA-1 a OA-3 de keel-core/gen/read-scope.js sobre conduit-optional (keel-core/test/helpers/read-scope-designs.js),
// el MISMO sujeto que mide keel-spring con read-scope-check. Y cada sabotaje de OPTIONAL_AUTH_SABOTAGES cae en
// exactamente sus casos: la red se falsa a sí misma.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { OPTIONAL_AUTH_SABOTAGES } from '@keel-system/keel-core/gen/read-scope';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { messageComponents } from '../src/scaffold/services.js';

const SECURITY = 'src/infrastructure/security';
const SUBJECT = 'oa-user';

// Lo emitido importa Nest solo para decorar (el controlador) y para el Logger del hook.
const DECORATORS = ['Body', 'Controller', 'Delete', 'Get', 'Headers', 'HttpCode', 'Inject', 'Injectable', 'Param', 'Patch', 'Post', 'Put', 'Query', 'Req', 'Res', 'Optional', 'Global', 'Module'];
const NEST_STUB = `${DECORATORS.map((name) => `export const ${name} = () => () => {};`).join('\n')}
export class Logger { log() {} warn() {} error() {} }
`;
// El controlador importa el mediator (el token de su @Inject), que traduce los errores del driver: solo sus clases.
const MONGODB_STUB = 'export class MongoError extends Error {}\nexport class MongoServerError extends MongoError {}\n';

/** Lo que rompe cada sabotaje en lo emitido, conservando la forma. */
const SABOTAGES = {
  // Un token que no vale se trata como anónimo en vez de 401.
  'oa-degrade': [
    `${SECURITY}/http-security.ts`,
    'if (error instanceof InvalidCredential) return reject(reply, 401);',
    'if (error instanceof InvalidCredential) return SecurityContext.runWith(null, done);'
  ],
  // Con optional nunca hay identidad, ni con un token válido.
  'oa-ignore-token': [`${SECURITY}/caller-identity.ts`, 'return CallerIdentity.resolve();\n  }', 'return null;\n  }']
};

const conduitOptional = () => {
  const design = READ_SCOPE_DESIGNS.find((entry) => entry.name === 'conduit-optional');
  return planFixture(design.from, { mutate: design.mutate });
};

function sabotaged(files, id) {
  const [target, from, to] = SABOTAGES[id];
  return files.map((file) => {
    if (file.path !== target) return file;
    assert.ok(file.content.includes(from), `el sabotaje ${id} ya no se aplica a ${target}`);
    return { ...file, content: file.content.replace(from, to) };
  });
}

/** Ejecuta OA-1 a OA-3 contra lo emitido y devuelve los casos que cayeron, con su motivo. */
async function measure({ files, model }) {
  const { load } = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB, mongodb: MONGODB_STUB } });
  const { installSecurity } = await load(`${SECURITY}/http-security.ts`);
  const { default: Fastify } = await import('fastify');
  const keys = await generateKeyPair('RS256');
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] });
  const sign = (exp) => new SignJWT({ sub: SUBJECT }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setExpirationTime(exp).sign(keys.privateKey);
  const tokens = { valid: await sign('5m'), expired: await sign(Math.floor(Date.now() / 1000) - 600), invalid: 'no-es-un-token' };

  const fastify = Fastify();
  installSecurity(fastify, { get: (key) => ({ 'security.oauth2.jwks': jwks })[key] });
  const sent = [];
  const mediator = { dispatch: async (message) => (sent.push(message), null) };
  const field = model.security.callerIdentity.field;
  const operations = model.services.flatMap((group) => group.operations).filter((op) => op.optionalAuth && messageComponents(model, op).some((c) => c.resolvedIdentity));
  const routes = [];
  for (const operation of operations) {
    const file = files.find((candidate) => candidate.path.includes('/rest/controllers/') && candidate.content.includes(`function read${operation.messageClass}(`));
    const className = /export class (\w+)/.exec(file.content)[1];
    const Controller = (await load(file.path))[className];
    const controller = new Controller(mediator);
    const url = `${model.api.routeBase}${operation.route.path}`;
    fastify.route({
      method: operation.route.method,
      url: url.replace(/\{([^}]+)\}/g, ':$1'),
      handler: async (request) => (await controller[operation.name](request.params, request.query ?? {}, request.body), {})
    });
    // Un valor de ruta que cumpla cualquier patrón del diseño (alfanumérico): lo que se mide es la identidad, no el lector.
    routes.push({ operation, url: url.replace(/\{[^}]+\}/g, 'oa1') });
  }
  await fastify.ready();

  const fell = new Map();
  const fall = (id, why) => fell.set(id, [...(fell.get(id) ?? []), why]);
  const ask = (route, token) =>
    fastify.inject({ method: route.operation.route.method, url: route.url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const { unauthenticated } = FRAMEWORK_RESPONSES;
  for (const route of routes) {
    const name = route.operation.name;
    sent.length = 0;
    let response = await ask(route, null);
    if (response.statusCode !== 200 || sent.length !== 1 || sent[0][field] != null) fall('OA-1', `${name}: ${response.statusCode}, ${JSON.stringify(sent[0]?.[field])}`);
    sent.length = 0;
    response = await ask(route, tokens.valid);
    if (response.statusCode !== 200 || sent[0]?.[field] !== SUBJECT) fall('OA-2', `${name}: ${response.statusCode}, ${JSON.stringify(sent[0]?.[field])}`);
    for (const token of [tokens.invalid, tokens.expired]) {
      sent.length = 0;
      response = await ask(route, token);
      const body = response.statusCode === 401 ? response.json() : {};
      const wire =
        body.status === unauthenticated.status &&
        body.error === unauthenticated.error &&
        body.code === FRAMEWORK_ERRORS.unauthenticated.code &&
        body.message === unauthenticated.message;
      if (response.statusCode !== 401 || !wire || sent.length > 0) fall('OA-3', `${name}: ${response.statusCode}, ${sent.length} despachados`);
    }
  }
  await fastify.close();
  assert.ok(routes.length > 0, 'conduit-optional no tiene operaciones optional que pedir');
  return fell;
}

test('conduit-optional: la regla concede, el controlador estampa resolveOptional() y el handler lleva la nota', () => {
  const { files } = conduitOptional();
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  assert.match(byPath[`${SECURITY}/access-rules.ts`], /requirement: \{ kind: 'optional' \}/);
  assert.match(byPath[`${SECURITY}/access-rules.ts`], /if \(requirement\.kind === 'public' \|\| requirement\.kind === 'optional'\) return 'granted';/);
  assert.match(byPath[`${SECURITY}/caller-identity.ts`], /resolveOptional\(\): string \| null \{/);
  const article = Object.entries(byPath).find(([file]) => file.endsWith('article-v1-controller.ts'))[1];
  assert.match(article, /callerSubject: CallerIdentity\.resolveOptional\(\)/);
  const handler = Object.entries(byPath).find(([file]) => file.endsWith('get-article-query-handler.ts'))[1];
  assert.match(handler, /Identidad opcional \(level: optional, DSL 2\.27\): sin token, query\.callerSubject llega null/);
});

test('sin ninguna operación optional, CallerIdentity no gana resolveOptional', () => {
  const { files } = planFixture('conduit');
  const identity = files.find((file) => file.path === `${SECURITY}/caller-identity.ts`).content;
  assert.doesNotMatch(identity, /resolveOptional/);
});

test('OA-1 a OA-3, ejecutando lo emitido: anónimo sin token, la identidad con uno válido y 401 con uno roto', async () => {
  const fell = await measure(conduitOptional());
  assert.deepEqual(Object.fromEntries(fell), {});
});

for (const { id, falls } of OPTIONAL_AUTH_SABOTAGES) {
  test(`el sabotaje ${id} cae en exactamente ${falls.join(', ')}`, async () => {
    const plan = conduitOptional();
    const fell = await measure({ ...plan, files: sabotaged(plan.files, id) });
    assert.deepEqual([...fell.keys()].sort(), [...falls].sort(), JSON.stringify(Object.fromEntries(fell)));
  });
}
