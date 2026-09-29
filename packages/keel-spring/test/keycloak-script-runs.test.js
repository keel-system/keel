// `infra/init-keycloak.sh` EJECUTADO, no comparado como cadena.
//
// Por qué hace falta un test de otra clase. El resto de la suite comprueba que el bash
// generado *contiene* lo que debe contener, y eso no distingue un script correcto de uno
// cuyas líneas son inalcanzables. El caso real: `run()` prometía en su comentario tolerar el
// 409 de un recurso ya existente, y bajo `set -e` moría antes de llegar a esa lógica —
// `generation-regressions.test.js` seguía verde porque el texto de la tolerancia estaba ahí,
// escrito, sin ejecutarse nunca. El síntoma en vivo fue el peor posible: una re-ejecución
// sobre un realm ya sembrado abortaba en silencio tras `== Realm ==`, dejando usuarios, roles
// y clientes sin crear, y el fallo aparecía minutos después como un 403 sin explicación.
//
// El montaje es barato a propósito: sin Keycloak, sin contenedores y sin red. Se sustituye el
// runtime por un stub —la variable `CONTAINER_RUNTIME` que el propio script documenta— que
// imita a kcadm sobre un realm YA SEMBRADO: la sesión admin funciona, los `get` devuelven ids
// y todo `create` contesta 409. Es exactamente el escenario que falló en la corrida.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');

const SECURITY = {
  authentication: {
    protocol: 'oidc',
    serviceAuth: { protocol: 'oauth2', audience: 'catalog-api', validateAudience: true },
    // Con alcance por recurso: así el bash del claim —que resuelve ids de cliente y de
    // usuario antes de escribir el atributo— también se EJECUTA aquí, y no solo se compara
    // como cadena en auth-scoping.test.js.
    scoping: { claim: 'tenants', over: 'Product.sku', error: 'TENANT_FORBIDDEN', exemptRoles: ['admin'] }
  },
  access: {
    default: { level: 'required' },
    rules: { createProduct: { roles: ['admin', 'editor'], scopes: ['catalog:write'] } }
  },
  serviceClients: { billing: { scopes: ['catalog:write'] } }
};

// El stub imita a kcadm contra un realm ya sembrado. `$@` llega como
// `compose -f ... exec -T keycloak /opt/keycloak/bin/kcadm.sh <subcomando> ...`.
const STUB = `#!/usr/bin/env bash
ARGS="$*"
if [ -n "\${STUB_LOG:-}" ]; then echo "$ARGS" >> "$STUB_LOG"; fi
case "$ARGS" in
  *credentials*) exit 0 ;;
esac
if [ "\${STUB_GETS_FAIL:-0}" = "1" ]; then
  # kcadm contesta algo que no es un id: el caso del aprovisionamiento a medias.
  echo "no encontrado"
  exit 0
fi
case "$ARGS" in
  *"get clients"*)       echo "cid-0001"; exit 0 ;;
  *"get users"*)         echo "uid-0001"; exit 0 ;;
  *"get client-scopes"*)
    # csv id,name para cada scope que el script pueda pedir.
    for NAME in \${STUB_SCOPES:-}; do echo "sid-$NAME,$NAME"; done
    exit 0 ;;
esac
# Cualquier create/update sobre un realm ya sembrado.
echo "Failed to create: HTTP 409 Conflict"
exit 1
`;

function buildScript() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = SECURITY;
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  const workspace = tmpDir('keel-kcrun-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true });
  const serviceDir = path.join(workspace, 'services', 'catalog-spring');
  return { serviceDir, script: fs.readFileSync(path.join(serviceDir, 'infra/init-keycloak.sh'), 'utf8') };
}

/** Ejecuta el script (o una variante suya) con el stub como runtime. */
function runScript(serviceDir, content, env = {}) {
  fs.writeFileSync(path.join(serviceDir, 'infra/init-keycloak.sh'), content);
  const stubPath = path.join(serviceDir, 'infra', 'kcadm-stub.sh');
  fs.writeFileSync(stubPath, STUB);
  fs.chmodSync(stubPath, 0o755);

  // Los nombres de client-scope que el script crea: se leen del propio script para que el
  // stub conteste lo que este diseño pide, sin duplicar aquí la lista.
  const scopes = [...content.matchAll(/create client-scopes -r \$REALM -s name=(\S+?)[\s"]/g)]
    .map((match) => match[1])
    .map((name) => name.replace('$SVC', /^SVC=(\S+)/m.exec(content)?.[1] ?? 'catalog-api'));

  return spawnSync('bash', ['infra/init-keycloak.sh'], {
    cwd: serviceDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTAINER_RUNTIME: './infra/kcadm-stub.sh',
      STUB_SCOPES: scopes.join(' '),
      KEEL_KC_WAIT_ATTEMPTS: '1',
      KEEL_KC_WAIT_DELAY: '0',
      ...env
    }
  });
}

test('el script sobrevive a un realm ya sembrado: los 409 se toleran y llega al final', () => {
  const { serviceDir, script } = buildScript();
  const result = runScript(serviceDir, script);

  assert.equal(
    result.status,
    0,
    `el script murió con ${result.status}. Un 409 es la respuesta ESPERADA de un realm ya sembrado y ` +
      `el propio comentario de run() promete tolerarlo.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
  // Llegó al final, no solo salió con 0: un script que aborta en la primera sección también
  // podría salir con 0 si alguien pusiera un `|| true` de más.
  assert.match(result.stdout, /listo\. Verifica con:/);
  // Y recorrió las secciones de después del realm, que es lo que la corrida perdía.
  assert.match(result.stdout, /== Usuarios de prueba/);
  assert.match(result.stdout, /== Alcance por recurso/);
  assert.match(result.stdout, /== Asignacion de client scopes/);
});

test('AUTOCOMPROBACIÓN: con el patrón inseguro de run() el test se pone rojo', () => {
  // Sin esto, el test anterior solo demuestra que el script de hoy pasa — no que mañana no
  // se pueda volver al patrón que rompía. Se revierte el fix a mano y se exige el fallo.
  const { serviceDir, script } = buildScript();
  const roto = script.replace('out=$(eval "$KC $*" 2>&1) && rc=0 || rc=$?', 'out=$(eval "$KC $*" 2>&1); rc=$?');
  assert.notEqual(roto, script, 'no se encontró la línea del fix: ¿cambió run()?');

  const result = runScript(serviceDir, roto);
  assert.notEqual(result.status, 0, 'el patrón inseguro debería matar el script en el primer 409');
  // Y muere en silencio, que es lo que lo hacía tan caro de diagnosticar.
  assert.doesNotMatch(result.stdout, /listo\. Verifica con:/);
});

test('un aprovisionamiento a medias falla con un ERROR legible, no en silencio', () => {
  // El segundo modo de fallo que reportó el agente de infraestructura: «exit 1 tras == Realm ==
  // sin imprimir ERROR». Si un `get` no devuelve un id, el script tiene que decir cuál y por qué,
  // no morir por `set -e` en una asignación sin mensaje.
  const { serviceDir, script } = buildScript();
  const result = runScript(serviceDir, script, { STUB_GETS_FAIL: '1' });

  assert.notEqual(result.status, 0, 'sin ids resueltos el script no puede continuar');
  assert.match(
    result.stderr,
    /ERROR:/,
    `murió sin explicar por qué.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
});

// ─── Quién existe en el realm ───────────────────────────────────────────────
//
// Dos huecos de la serie R8, los dos de lo que el script CREA y no de cómo lo crea: room-booking
// necesitaba dos usuarios con el mismo rol para la titularidad y el script sembraba uno, y en
// notification-mailer —sin roles— la cabecera y test-credentials.env prometían usuarios de prueba
// que nadie creaba. Se afirma sobre lo que el stub RECIBIÓ, no sobre el texto del script.

function runLogged(serviceDir, script) {
  const log = path.join(serviceDir, 'infra', 'kcadm.log');
  const result = runScript(serviceDir, script, { STUB_LOG: log });
  return { result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('con roles se siembran DOS usuarios por rol, y el segundo lleva su rol', () => {
  const { serviceDir, script } = buildScript();
  const { result, calls } = runLogged(serviceDir, script);
  assert.equal(result.status, 0, result.stderr);
  for (const role of ['admin', 'editor']) {
    assert.match(calls, new RegExp(`create users -r \\S+ -s username=${role}-2 `), `no se creó ${role}-2`);
    assert.match(calls, new RegExp(`add-roles -r \\S+ --uusername ${role}-2 --rolename ${role}\\b`), `${role}-2 sin su rol`);
  }
  assert.match(calls, /create users -r \S+ -s username=no-role /);
});

test('sin roles no hay usuarios de prueba, ni cliente público, ni se prometen', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notification-mailer');
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  assert.equal((layers.security?.roles ?? []).length, 0, 'la fixture de control ya declara roles');
  const workspace = tmpDir('keel-kcrun-noroles-');
  scaffoldService({ manifest, layers, workspace, stack: { auth: 'keycloak' }, force: true });
  const serviceDir = path.join(workspace, 'services', 'notification-mailer-spring');
  const script = fs.readFileSync(path.join(serviceDir, 'infra/init-keycloak.sh'), 'utf8');

  const { result, calls } = runLogged(serviceDir, script);
  assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
  assert.doesNotMatch(calls, /create users /, 'se crearon usuarios sin roles que darles');
  assert.doesNotMatch(calls, /publicClient=true/, 'se creó el cliente público de usuario');
  assert.doesNotMatch(script, /usuarios de prueba (grant password)/, 'la cabecera promete usuarios');
  assert.doesNotMatch(script, /USER_CLIENT/);

  const env = fs.readFileSync(path.join(serviceDir, 'infra/test-credentials.env'), 'utf8');
  assert.doesNotMatch(env, /AUTH_TEST_/, 'test-credentials.env promete credenciales de usuario');
  assert.match(env, /AUTH_TOKEN_URL=/);
});
