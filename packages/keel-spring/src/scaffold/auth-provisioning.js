// Aprovisionamiento del proveedor de identidad de prueba.
//
// Existe porque el realm, el cliente de test, los usuarios y los secretos M2M son
// un CONTRATO entre dos agentes (keel-spring-infra los crea, keel-spring-tests los
// consume desde AbstractFlowIT) que hasta ahora solo vivía en prosa: cada uno lo
// reinventaba desde su lectura de la convention y el desajuste solo aparecía al
// ejecutar la suite entera. Aquí se materializa una única vez, derivado del diseño:
//
//   infra/init-keycloak.sh     — lo que hay que crear (realm, roles, usuarios,
//                                clientes de diseño y la matriz M2M de prueba).
//   infra/test-credentials.env — los valores con los que se crea, que es lo que
//                                AbstractFlowIT lee. Un solo productor, un solo
//                                consumidor, ningún literal inventado a los dos lados.
//
// El agente de infraestructura ya no escribe el script: lo ejecuta y verifica.

import { AUTH } from '../lib/stack-catalog.js';

const PASSWORD = 'password';
// Secreto de los clientes M2M que solo existen para las variantes negativas de los
// escenarios; es el valor que documenta skills/keel-spring-keycloak/references/test-clients.md.
const TEST_SECRET = 'test-secret';
// Usuario sin ningún rol: el 403 por rol insuficiente necesita un sujeto autenticado.
const NO_ROLE_USER = 'no-role';

/** Protocolos de identidad basados en token: son los que necesitan aprovisionamiento. */
function usesTokens(model) {
  const protocol = model.security?.protocol ?? 'none';
  return protocol === 'oidc' || protocol === 'jwt';
}

/** Secreto del cliente máquina declarado en el diseño. Convención: `<cliente>-secret`. */
export function serviceClientSecret(clientName) {
  return `${clientName}-secret`;
}

/** Clave por cliente en test-credentials.env (`AUTH_CLIENT_SECRET_<CLIENTE>`). */
export function secretEnvKey(clientName) {
  return `AUTH_CLIENT_SECRET_${clientName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** URL del endpoint de token del proveedor del stack. */
export function tokenUrl(model) {
  const port = AUTH[model.stack.auth]?.port ?? 8180;
  return model.stack.auth === 'cognito'
    ? `http://localhost:${port}/local_userpool/protocol/openid-connect/token`
    : `http://localhost:${port}/realms/${model.service.name}/protocol/openid-connect/token`;
}

/**
 * Cliente público con el que AbstractFlowIT pide tokens de usuario. El nombre es el
 * artifactId **del proyecto Gradle** (`<servicio>-spring`), que es lo que dice la
 * convention infra-validation.md § Obtener un token — no el nombre del servicio.
 */
export function userTestClient(model) {
  return `${model.service.projectName}-test`;
}

/** Clientes M2M que solo existen para las variantes negativas (matriz scope × audiencia). */
function testM2mClients(model) {
  const serviceAuth = model.security?.serviceAuth;
  if (!serviceAuth || serviceAuth.protocol === 'api-key') return [];
  if ((model.security?.scopes ?? []).length === 0) return [];
  const clients = ['test-m2m-ok', 'test-m2m-no-scope'];
  if (serviceAuth.validateAudience) clients.push('test-m2m-bad-aud', 'test-m2m-none');
  return clients;
}

export function generate(model) {
  if (!model.layersPresent.security || !usesTokens(model)) return [];
  const files = [credentialsEnv(model)];
  if (model.stack.auth === 'keycloak') files.push(keycloakScript(model));
  return files;
}

// ─── infra/test-credentials.env ──────────────────────────────────────────────

function credentialsEnv(model) {
  const security = model.security;
  const lines = [
    `# Credenciales del proveedor de identidad de prueba de ${model.service.name}.`,
    '#',
    '# Fuente ÚNICA compartida por infra/init-keycloak.sh (quien las crea) y por',
    '# AbstractFlowIT (quien las consume). No se edita a mano ni se duplica en el',
    '# código de las pruebas: cambiar un valor aquí y reejecutar el script del',
    '# proveedor es lo que mantiene a los dos lados de acuerdo.',
    '#',
    '# Cualquier variable de entorno del mismo nombre tiene prioridad sobre este archivo.',
    ''
  ];
  if (model.stack.auth !== 'keycloak') {
    lines.push(
      `# Stack de identidad '${model.stack.auth}': build no genera el script de aprovisionamiento,`,
      '# pero estos son los valores con los que el arnés va a llamar. El agente de',
      '# infraestructura debe dejar el proveedor exactamente así (skill del proveedor).',
      ''
    );
  }
  lines.push(
    `AUTH_TOKEN_URL=${tokenUrl(model)}`,
    `AUTH_TEST_CLIENT=${userTestClient(model)}`,
    `AUTH_TEST_PASSWORD=${PASSWORD}`
  );

  const clients = security?.serviceClients ?? [];
  const m2m = testM2mClients(model);
  if (clients.length > 0 || m2m.length > 0) {
    lines.push(
      '',
      '# Secretos de los clientes máquina (grant client_credentials). El default cubre',
      '# los clientes de prueba; cada cliente del diseño tiene además su propia clave.',
      `AUTH_CLIENT_SECRET=${TEST_SECRET}`
    );
    for (const client of clients) {
      lines.push(`${secretEnvKey(client.name)}=${serviceClientSecret(client.name)}`);
    }
  }
  if (security?.roles?.length) {
    lines.push('', `# Usuarios de prueba (username = rol): ${security.roles.join(', ')}, ${NO_ROLE_USER}`);
  }
  return { path: 'infra/test-credentials.env', content: `${lines.join('\n')}\n` };
}

// ─── infra/init-keycloak.sh ──────────────────────────────────────────────────

function keycloakScript(model) {
  const security = model.security;
  const realm = model.service.name;
  const audience = security?.serviceAuth?.audience ?? model.service.name;
  const roles = security?.roles ?? [];
  const scopes = security?.scopes ?? [];
  const serviceClients = security?.serviceClients ?? [];
  const m2m = testM2mClients(model);
  const validateAudience = security?.serviceAuth?.validateAudience === true;

  const blocks = [];

  blocks.push(`echo "== Sesion admin =="
run "config credentials --server http://localhost:8080 --realm master --user admin --password admin"

echo "== Realm =="
run "create realms -s realm=$REALM -s enabled=true"

echo "== Cliente publico para tokens de usuario (password grant) =="
run "create clients -r $REALM -s clientId=$USER_CLIENT -s enabled=true -s publicClient=true -s directAccessGrantsEnabled=true"`);

  if (roles.length > 0) {
    blocks.push(`echo "== Roles del diseno (security.keel.yaml) =="
${roles.map((role) => `run "create roles -r $REALM -s name=${role}"`).join('\n')}

echo "== Usuarios de prueba: uno por rol (username = rol) + uno sin roles =="
for USER in ${[...roles, NO_ROLE_USER].join(' ')}; do
  run "create users -r $REALM -s username=$USER -s enabled=true -s email=$USER@example.com -s emailVerified=true -s firstName=Test -s lastName=User"
  run "set-password -r $REALM --username $USER --new-password $PASSWORD"
done
${roles.map((role) => `run "add-roles -r $REALM --uusername ${role} --rolename ${role}"`).join('\n')}`);
  }

  // Audiencia y permisos en client scopes SEPARADOS: si viajan juntos, el cliente
  // "sin scope" pierde también la audiencia y su fallo deja de probar nada sobre el
  // scope (skills/keel-spring-keycloak/references/test-clients.md).
  if (scopes.length > 0) {
    const audienceBlock = [
      'echo "== Client scopes de audiencia (desacoplados de los de permisos) =="',
      'run "create client-scopes -r $REALM -s name=aud-$SVC -s protocol=openid-connect"',
      'AUD_OK=$(scope_id_of "aud-$SVC")',
      'run "create client-scopes/$AUD_OK/protocol-mappers/models -r $REALM -s name=aud-mapper -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper -s \'config.\\"included.custom.audience\\"=$SVC\' -s \'config.\\"access.token.claim\\"=true\'"'
    ];
    if (validateAudience) {
      audienceBlock.push(
        '',
        'run "create client-scopes -r $REALM -s name=aud-wrong -s protocol=openid-connect"',
        'AUD_BAD=$(scope_id_of "aud-wrong")',
        'run "create client-scopes/$AUD_BAD/protocol-mappers/models -r $REALM -s name=aud-mapper -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper -s \'config.\\"included.custom.audience\\"=audiencia-ajena\' -s \'config.\\"access.token.claim\\"=true\'"'
      );
    }
    blocks.push(audienceBlock.join('\n'));

    blocks.push(`echo "== Client scopes de permiso (sin mapper de audiencia) =="
${scopes
  .map(
    (scope, index) =>
      `run "create client-scopes -r $REALM -s name=${scope} -s protocol=openid-connect -s 'attributes.\\"include.in.token.scope\\"=true'"\nSCOPE_${index}=$(scope_id_of "${scope}")`
  )
  .join('\n')}`);
  }

  if (serviceClients.length > 0) {
    blocks.push(`echo "== Clientes maquina del diseno (security.serviceClients) =="
${serviceClients
  .map(
    (client) =>
      `run "create clients -r $REALM -s clientId=${client.name} -s enabled=true -s publicClient=false -s serviceAccountsEnabled=true -s secret=${serviceClientSecret(client.name)}"`
  )
  .join('\n')}`);
  }

  if (m2m.length > 0) {
    blocks.push(`echo "== Clientes M2M de prueba (matriz scope x audiencia) =="
${m2m
  .map(
    (client) =>
      `run "create clients -r $REALM -s clientId=${client} -s enabled=true -s publicClient=false -s serviceAccountsEnabled=true -s secret=${TEST_SECRET}"`
  )
  .join('\n')}`);
  }

  if (scopes.length > 0 && (serviceClients.length > 0 || m2m.length > 0)) {
    const assignments = [];
    for (const client of serviceClients) {
      assignments.push(`assign_scope ${client.name} "$AUD_OK"`);
      const own = client.scopes.length > 0 ? client.scopes : scopes;
      for (const scope of own) {
        const index = scopes.indexOf(scope);
        if (index >= 0) assignments.push(`assign_scope ${client.name} "$SCOPE_${index}"`);
      }
    }
    // La matriz: cada cliente de prueba varía UNA sola condición respecto al camino feliz.
    const allScopes = scopes.map((_, index) => `$SCOPE_${index}`);
    if (m2m.includes('test-m2m-ok')) {
      assignments.push('assign_scope test-m2m-ok "$AUD_OK"');
      for (const ref of allScopes) assignments.push(`assign_scope test-m2m-ok "${ref}"`);
    }
    if (m2m.includes('test-m2m-no-scope')) assignments.push('assign_scope test-m2m-no-scope "$AUD_OK"');
    if (m2m.includes('test-m2m-bad-aud')) {
      assignments.push('assign_scope test-m2m-bad-aud "$AUD_BAD"');
      for (const ref of allScopes) assignments.push(`assign_scope test-m2m-bad-aud "${ref}"`);
    }
    // test-m2m-none no lleva ninguno: es el control.

    blocks.push(`assign_scope() {
  local CLIENT_ID="$1" SCOPE_ID="$2"
  local CID
  CID=$(client_id_of "$CLIENT_ID")
  run "update clients/$CID/default-client-scopes/$SCOPE_ID -r $REALM"
}

echo "== Asignacion de client scopes =="
${assignments.join('\n')}`);
  }

  const verifyUser = roles[0] ?? NO_ROLE_USER;
  const content = `#!/usr/bin/env bash
# Prepara el realm de prueba "${realm}" en el Keycloak de infra/docker-compose.yaml:
# realm + roles + usuarios de prueba (grant password) + clientes maquina. Generado
# por keel-spring build a partir de specs/security.keel.yaml: los nombres y secretos
# son los mismos que infra/test-credentials.env entrega a AbstractFlowIT, y por eso
# no se editan aqui a mano — si algo tiene que cambiar, cambia en el diseno.
#
# Idempotente: las creaciones toleran el 409 de Keycloak (recurso ya existente), asi
# que se puede reejecutar tras cada 'compose up'.
#
# Nota: el GET client-scopes de Keycloak NO filtra por -q name=... (devuelve el
# listado completo), a diferencia de GET clients; por eso el id de un client-scope se
# busca por coincidencia exacta ",<nombre>$" sobre el csv id,name.
#
# Convenciones: .claude/conventions/infra-validation.md
#               .claude/skills/keel-spring-keycloak/references/test-clients.md
set -euo pipefail
export MSYS_NO_PATHCONV=1

RUNTIME="\${CONTAINER_RUNTIME:-docker}"
COMPOSE=(docker compose -f infra/docker-compose.yaml)
if [ "$RUNTIME" = "podman" ]; then
  COMPOSE=(podman compose -f infra/docker-compose.yaml)
fi

KC="\${COMPOSE[*]} exec -T keycloak /opt/keycloak/bin/kcadm.sh"
REALM=${realm}
SVC=${audience}                     # audiencia del servicio (security.serviceAuth.audience)
USER_CLIENT=${userTestClient(model)} # cliente publico para tokens de usuario
PASSWORD=${PASSWORD}

run() { eval "$KC $*" 2>&1 | grep -v "compose provider\\|^\\[0m$\\|^$" || true; }
# id de un cliente por su clientId exacto (GET clients SI soporta -q).
client_id_of() { eval "$KC get clients -r $REALM -q clientId=$1 --fields id --format csv --noquotes" 2>/dev/null | tr -d '\\r' | tail -1; }
# id de un client-scope por su name exacto (GET client-scopes NO soporta -q: filtra en local).
scope_id_of() { eval "$KC get client-scopes -r $REALM --fields id,name --format csv --noquotes" 2>/dev/null | tr -d '\\r' | grep ",$1\\$" | cut -d, -f1; }

${blocks.join('\n\n')}

echo "Realm '$REALM' listo. Verifica con:"
echo "  curl -s -d 'grant_type=password&client_id=$USER_CLIENT&username=${verifyUser}&password=$PASSWORD' ${tokenUrl(model)} | jq -r .access_token"
`;

  return { path: 'infra/init-keycloak.sh', content };
}
