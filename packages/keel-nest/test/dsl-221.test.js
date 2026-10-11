// DSL 2.21: los dos enlaces que solo cabían en prosa, y el mismo `designGap` en las cuatro corridas del incremento 13.
//
//   · `scoping.exemptClients`: el cliente máquina que lee cualquier recurso. Cada agente lo resolvía a mano y de
//     forma distinta (por scope en keel-spring, por el nombre del cliente en keel-nest). Aquí se EJECUTA el
//     adaptador del alcance con principales de los dos tipos.
//   · `operations.<op>.dispatches`: la operación que despacha otra recibe el puerto de despacho y su nota. Se
//     comprueba el handler emitido y que keel-spring dice lo mismo.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { JWT_CALLER_SCOPE_TS, SECURITY_CONTEXT_TS } from '../src/scaffold/security.js';

const STACK = { database: 'mongodb', broker: 'rabbitmq' };

const principal = (kind, name, { roles = [], claims = {} } = {}) => ({
  kind,
  name,
  authorities: new Set(roles.map((role) => `ROLE_${role}`)),
  claims
});

test('exemptClients: el cliente exento lee cualquier recurso; un custodio, solo lo que enumera su claim', async () => {
  const { files } = planFixture('asset-vault', { stack: STACK });
  const tree = transpileTree(files);
  const { JwtCallerScope } = await tree.load(JWT_CALLER_SCOPE_TS);
  const { SecurityContext } = await tree.load(SECURITY_CONTEXT_TS);
  const scope = new JwtCallerScope();
  const as = (who, action) => SecurityContext.runWith(who, action);

  // El renderizador, por client-credentials: Keycloak pone el cliente en azp; otros proveedores, en client_id.
  assert.equal(as(principal('token', 'service-account-x', { claims: { azp: 'rendering-service' } }), () => scope.covers('ACME')), true);
  assert.equal(as(principal('token', 'abc', { claims: { client_id: 'rendering-service' } }), () => scope.isExempt()), true);
  // Con una clave de API el nombre del principal es el cliente.
  assert.equal(as(principal('key', 'rendering-service'), () => scope.isExempt()), true);
  // Otro cliente, no.
  assert.equal(as(principal('token', 'x', { claims: { azp: 'otro-servicio' } }), () => scope.covers('ACME')), false);
  // Un custodio: su claim y nada más; el rol exento, todo.
  const reader = principal('token', 'u1', { roles: ['vault-reader'], claims: { azp: 'asset-vault-app', vaults: ['ACME'] } });
  assert.equal(as(reader, () => scope.covers('ACME')), true);
  assert.equal(as(reader, () => scope.covers('OTRO')), false);
  assert.equal(as(principal('token', 'u2', { roles: ['vault-admin'] }), () => scope.covers('OTRO')), true);
  // Sin petición, nadie está exento.
  assert.equal(scope.isExempt(), false);
});

test('exemptClients: keel-spring reconoce el mismo cliente con el mismo criterio', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'asset-vault'));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  const java = spring.find((f) => f.path.endsWith('/JwtCallerScope.java')).content;
  assert.ok(java.includes('static final Set<String> EXEMPT_CLIENTS = Set.of("rendering-service");'), java);
  assert.ok(java.includes('getClaimAsString("azp")') && java.includes('getClaimAsString("client_id")'), java);
});

test('dispatches: el barrido recibe el puerto de despacho y la nota, igual en los dos generadores', () => {
  const { files } = planFixture('asset-vault', { stack: STACK });
  const handler = files.find((f) => f.path.endsWith('reconcile-scans-command-handler.ts')).content;
  assert.match(handler, /static readonly inject = \[[^\]]*CommandDispatcher[^\]]*\] as const;/);
  assert.match(handler, /private readonly commandDispatcher: CommandDispatcher/);
  assert.match(handler.replace(/\n\s*\/\/\s*/g, ' '), /Despacha \(use-cases\.dispatches\): quarantineAsset \(await this\.commandDispatcher\.dispatch\(new QuarantineAssetCommand\(\.\.\.\)\)\)/);
  // Solo el que despacha: el handler de la suscripción no lo recibe.
  assert.doesNotMatch(files.find((f) => f.path.endsWith('quarantine-asset-command-handler.ts')).content, /CommandDispatcher/);

  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'asset-vault'));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  const java = spring.find((f) => f.path.endsWith('/ReconcileScansCommandHandler.java')).content;
  assert.ok(java.includes('private final CommandDispatcher commandDispatcher;'), java);
  assert.ok(/Despacha \(use-cases\.dispatches\): quarantineAsset \(commandDispatcher\.dispatch\(new QuarantineAssetCommand\(\.\.\.\)\)\)/.test(java.replace(/\n\s*\/\/\s*/g, ' ')), java);
  const port = spring.find((f) => f.path.endsWith('/CommandDispatcher.java')).content;
  assert.ok(port.includes('use-cases.dispatches: reconcileScans → quarantineAsset'), port);
});
