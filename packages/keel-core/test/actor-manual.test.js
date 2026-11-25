// El manual de uso por actor (`keel describe --manual`, docs/<servicio>/MANUAL.md): quién puede hacer qué, sobre qué
// y qué le puede salir mal, derivado de las capas. Determinista y con el sello que lee derivatives.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/lib/loader.js';
import { actorManual, renderActorManual } from '../src/lib/actor-manual.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const load = (name) => loadService(path.join(FIXTURES, name));
const manualOf = (name) => actorManual(load(name).layers);
const actor = (manual, id) => manual.actors.find((entry) => entry.id === id);
const operation = (manual, id, name) => actor(manual, id).operations.find((op) => op.name === name);

test('los actores salen de security: anónimo, autenticado sin rol y cada rol, con lo que pasa su regla', () => {
  const manual = manualOf('shop-api');
  assert.deepEqual(
    manual.actors.map((entry) => [entry.id, entry.operations.length]),
    [['anonymous', 3], ['authenticated', 8], ['role:customer', 15], ['role:employee', 11], ['role:manager', 13]]
  );
  // El permiso lo da roleGrants: el cliente llega al carrito sin que la regla lo nombre.
  assert.ok(operation(manual, 'role:customer', 'checkout'));
  assert.equal(operation(manual, 'role:employee', 'checkout'), undefined);
  assert.equal(operation(manual, 'anonymous', 'register'), undefined);
});

test('ownership: el ajeno es su error, un 404 con readMiss not-found, o no aparece en un listado; el exento no tiene condición', () => {
  const manual = manualOf('shop-api');
  assert.equal(operation(manual, 'role:customer', 'updateProfile').condition, 'solo los User cuyo email es su identidad; el ajeno es 403 PROFILE_NOT_OWNED');
  assert.equal(operation(manual, 'role:customer', 'getProfile').condition, 'solo los User cuyo email es su identidad; el ajeno responde como si no existiera (404)');
  assert.equal(operation(manual, 'role:customer', 'listOrders').condition, 've solo los OrderMain cuyo buyerEmail es su identidad');
  assert.equal(operation(manual, 'role:employee', 'listOrders').condition, null);
  assert.equal(operation(manual, 'role:customer', 'cancelOrder').transitions, 'OrderMain: NEW → CANCELED');
});

test('scoping acota al actor entero, salvo a los roles y clientes exentos', () => {
  const manual = manualOf('asset-vault');
  assert.match(actor(manual, 'role:vault-reader').scope, /claim `vaults`.*ASSET_OUT_OF_SCOPE/);
  assert.equal(actor(manual, 'role:vault-admin').scope, null);
  assert.equal(actor(manual, 'client:rendering-service').scope, null);
  const quarantine = manual.system.find((entry) => entry.name === 'quarantineAsset');
  assert.deepEqual(quarantine.triggers, ['la despacha reconcileScans', 'el evento MalwareDetected de security-scanner']);
});

test('lo que dispara el sistema: los desenlaces del cobro y su barrido no son hallazgos', () => {
  const manual = manualOf('payment-checkout');
  assert.deepEqual(manual.system.find((entry) => entry.name === 'markCaptured').triggers, ['el desenlace captured del cobro']);
  assert.deepEqual(manual.findings, []);
});

test('una operación sin puerta ni disparador declarado es hallazgo, con las transiciones que dependen de ella', () => {
  for (const name of ['notification-mailer', 'notification-mailer-mongo']) {
    assert.deepEqual(manualOf(name).findings, [
      'sendAcceptedNotification: no se llama por HTTP y nada declarado la dispara (ni reloj, ni evento, ni plazo, ni desenlace, ni el dispatches de otra operación), y de ella depende Notification: queued → sending; Notification: sending → sent; Notification: sending → failed.'
    ], name);
  }
});

test('una operación cuya regla exige algo que ningún actor tiene es hallazgo', () => {
  const layers = {
    'use-cases': { operations: { purge: { kind: 'command' }, read: { kind: 'query' } } },
    api: { basePath: '/api', endpoints: { purge: { method: 'POST', path: '/purge' }, read: { method: 'GET', path: '/x' } } },
    security: {
      authentication: { protocol: 'oidc' },
      roles: { reader: { description: 'Lee.' } },
      permissions: { 'x:purge': {}, 'x:read': {} },
      roleGrants: { reader: ['x:read'] },
      access: { default: { level: 'required', permissions: ['x:read'] }, rules: { purge: { level: 'required', permissions: ['x:purge'] } } }
    }
  };
  const manual = actorManual(layers);
  assert.deepEqual(manual.actors.map((entry) => entry.id), ['role:reader']);
  assert.deepEqual(manual.findings, ['purge: ninguno de los actores declarados pasa su regla de acceso — exige algo que ningún rol concede ni ningún cliente lleva.']);
});

test('la transición pedida desde otro estado añade el error del generador, o el que el diseño declara en su lugar', () => {
  const layers = (errors) => ({
    'use-cases': {
      operations: {
        close: { kind: 'command', transitions: [{ entity: 'Ticket', from: ['open'], to: 'closed' }], errors },
        reopen: { kind: 'command', transitions: [{ entity: 'Ticket', from: ['closed'], to: 'open' }] }
      }
    }
  });
  const canonical = actorManual(layers([])).operations.find((op) => op.name === 'reopen').errors;
  assert.deepEqual(canonical, [{ code: 'INVALID_STATE_TRANSITION', http: 409, when: 'La entidad no está en closed.', framework: true }]);

  const declared = [{ code: 'TICKET_INVALID_STATE', http: 409, when: 'No está abierto.' }];
  const overridden = actorManual(layers(declared)).operations;
  assert.deepEqual(overridden.find((op) => op.name === 'close').errors, declared);
  assert.equal(overridden.find((op) => op.name === 'reopen').errors[0].code, 'TICKET_INVALID_STATE');
});

test('sin capa security hay un solo actor, y con api.auto las operaciones CRUD tienen ruta automática', () => {
  const open = manualOf('catalog-extended');
  assert.deepEqual(open.actors.map((entry) => entry.id), ['anyone']);
  assert.equal(open.actors[0].operations.length, 9);

  const auto = manualOf('product-catalog').operations;
  assert.equal(auto.find((op) => op.name === 'createProduct').route, 'ruta CRUD automática');
  assert.equal(auto.find((op) => op.name === 'activateProduct').route, 'POST /api/products/{id}/activate');
});

test('el markdown lleva el sello que lee derivatives.js y es determinista en todas las fixtures', () => {
  const names = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'use-cases.keel.yaml')));
  for (const name of names) {
    const { layers, manifest } = load(name);
    const text = renderActorManual(layers, manifest);
    assert.equal(text, renderActorManual(layers, manifest), name);
    assert.equal(text.match(/^>\s*specs\/\S+\s+v(\d+\.\d+\.\d+)/m)?.[1], manifest.service.version, name);
  }
});
