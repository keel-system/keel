// La identidad resuelta contra VARIAS credenciales (`resolvedBy`, incremento 12e): la credencial del token o
// del mensaje es UNA de las del recurso, no su clave natural. Lo que se mide es lo que hace keel-spring sobre
// el mismo diseño:
//
//   · el finder `findBy<Campo>Containing` en el puerto, con el MISMO nombre que el de keel-spring, y en los dos
//     adaptadores (relacional y documental);
//   · el controlador resuelve la credencial a la clave natural ANTES de despachar, y el mensaje admite null
//     (la credencial no es de nadie: la operación responde con el error que declare el diseño);
//   · el resolutor, EJECUTADO: con una credencial conocida devuelve la clave natural; con una ajena, null.
// Contra los motores reales lo miden db-check (la tabla de elementos) y doc-check (el array del documento).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
`;

const SUBJECTS = [
  { name: 'notification-mailer', stack: { database: 'postgresql', broker: 'rabbitmq' }, adapter: /manager\.findOne\(ApplicationCredentialKeysElement, \{ where: \{ value: credentialKey \} \}\)/ },
  { name: 'notification-mailer-mongo', stack: { database: 'mongodb', broker: 'rabbitmq' }, adapter: /this\.collection\.findOne\(\{ 'credential_keys': credentialKey \}, \{ session: this\.session \}\)/ }
];

for (const { name, stack, adapter } of SUBJECTS) {
  test(`${name}: el finder de la credencial es el de keel-spring, en el puerto y en el adaptador`, () => {
    const files = Object.fromEntries(planFixture(name, { stack, withoutLayers: ['mail'] }).files.map((f) => [f.path, f.content]));
    const port = files['src/domain/repository/application-repository.ts'];
    assert.match(port, /abstract findByCredentialKeysContaining\(credentialKey: string\): Promise<Application \| null>;/);
    assert.match(files['src/infrastructure/persistence/repositories/application-repository-impl.ts'], adapter);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((f) => f.path.endsWith('/domain/repository/ApplicationRepository.java')).content;
    assert.match(spring, /Optional<Application> findByCredentialKeysContaining\(String credentialKey\);/, 'el mismo nombre en keel-spring');
  });
}

test('el controlador resuelve la credencial ANTES de despachar, y el mensaje admite null', () => {
  const files = Object.fromEntries(planFixture('notification-mailer', { stack: SUBJECTS[0].stack, withoutLayers: ['mail'] }).files.map((f) => [f.path, f.content]));
  const controller = Object.entries(files).find(([file, content]) => file.includes('/rest/controllers/') && content.includes('async requestNotification('))[1];
  assert.match(controller, /@Inject\(CallerIdentityResolver\) private readonly callerIdentity: CallerIdentityResolver/);
  assert.match(controller, /const message = new RequestNotificationCommand\(\{ \.\.\.read, applicationKey: await this\.callerIdentity\.resolve\(read\.applicationKey\) \}\);/);
  assert.match(controller, /this\.mediator\.dispatch\(message\)/);
  const message = files['src/application/commands/request-notification-command.ts'];
  assert.match(message, /readonly applicationKey: string \| null;/);
  assert.match(message, /Llega YA resuelto a la clave natural de Application/);
  assert.match(files['src/infrastructure/security/security-module.ts'], /providers: \[CallerIdentityResolver\]/);
  assert.match(files['src/app.module.ts'], /SecurityModule/);
  // Por el canal de eventos, la nota del listener nombra el MISMO finder.
  const listenerNote = Object.values(files).find((content) => content.includes('resolvedBy: Application.credentialKeys') && content.includes('pasa la clave natural'));
  assert.ok(listenerNote, 'la nota de la suscripción nombra la resolución');
  assert.match(listenerNote, /ApplicationRepository\.findByCredentialKeysContaining/);
});

test('el resolutor, ejecutado: la credencial conocida da la clave natural; la ajena, null', async () => {
  const { files } = planFixture('notification-mailer', { stack: SUBJECTS[0].stack, withoutLayers: ['mail'] });
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { CallerIdentityResolver } = await tree.load('src/infrastructure/security/caller-identity.ts');
  const asked = [];
  const repository = {
    async findByCredentialKeysContaining(credential) {
      asked.push(credential);
      return credential === 'pipeline-client' ? { key: 'facturacion' } : null;
    }
  };
  const resolver = new CallerIdentityResolver(repository);
  assert.equal(await resolver.resolve('pipeline-client'), 'facturacion');
  assert.equal(await resolver.resolve('nadie'), null);
  assert.deepEqual(asked, ['pipeline-client', 'nadie']);
});
