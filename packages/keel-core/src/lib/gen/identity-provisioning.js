// Aprovisionamiento del proveedor de identidad de prueba: los ARTEFACTOS de infra/ (keel-core/gen).
//
// NEUTRAL: el realm como dato lo deriva `realmSpec()` (identity-realm.js), y su proyección a la
// infraestructura de prueba es la misma para cualquier generador, porque el servicio de keel-spring
// y el de keel-nest del mismo diseño se prueban contra el MISMO realm:
//
//   infra/init-keycloak.sh                 — lo que hay que crear (realm, roles, usuarios, clientes
//                                            de diseño y la matriz M2M de prueba).
//   infra/test-credentials.env             — los valores con los que se crea, que es lo que lee el
//                                            arnés de pruebas. Un solo productor, un solo consumidor,
//                                            ningún literal inventado a los dos lados.
//   infra/cognito/mock-oauth2-config.json  — el emulador del contrato de token de Cognito.
//
// Lo único que cambia entre generadores son los TEXTOS de su plataforma (`platform`): quién genera
// (`generator`), qué parte del arnés consume las credenciales (`identity.harness`) y qué skill
// documenta los clientes de prueba (`identity.skill`). El agente de infraestructura no escribe el
// script: lo ejecuta y verifica.

import { RUNTIME_RESOLUTION, composeResolution } from './infra-scripts.js';
import {
  TEST_USER_PASSWORD as PASSWORD,
  TEST_CLIENT_SECRET as TEST_SECRET,
  NO_ROLE_USER,
  FOREIGN_RESOURCE_SERVER,
  scopedValue,
  usesTokens,
  testM2mClients,
  serviceClientSecret,
  secretEnvKey,
  tokenUrl,
  userTestClient,
  usesPersonaTokens,
  keycloakAdminCredentials,
  realmSpec
} from './identity-realm.js';

/**
 * Clientes con asignación de client scopes, en el orden en que se emiten: primero
 * los del diseño (audiencia buena + sus scopes) y luego la matriz de prueba.
 * Solo tiene sentido si el diseño declara scopes y hay algún cliente.
 */
function scopeAssignments(spec) {
  if (spec.scopes.length === 0) return [];
  return [
    ...spec.serviceClients.map((client) => ({ name: client.name, audience: 'ok', scopes: client.scopes })),
    ...spec.m2mClients
  ];
}

/**
 * Los artefactos del proveedor de identidad de prueba para el stack elegido. Vacío sin capa security
 * o con un protocolo que no es de token (api-key, none): ahí no hay proveedor que aprovisionar.
 */
export function identityProvisioningFiles(model, platform) {
  if (!model.layersPresent.security || !usesTokens(model)) return [];
  const files = [credentialsEnv(model, platform)];
  if (model.stack.auth === 'keycloak') files.push(keycloakScript(model, platform));
  if (model.stack.auth === 'cognito') files.push(cognitoMockConfig(model));
  return files;
}

// ─── infra/test-credentials.env ──────────────────────────────────────────────

function credentialsEnv(model, platform) {
  const security = model.security;
  const lines = [
    `# Credenciales del proveedor de identidad de prueba de ${model.service.name}.`,
    '#',
    '# Fuente ÚNICA compartida por infra/init-keycloak.sh (quien las crea) y por',
    `# ${platform.identity.harness} (quien las consume). No se edita a mano ni se duplica en el`,
    '# código de las pruebas: cambiar un valor aquí y reejecutar el script del',
    '# proveedor es lo que mantiene a los dos lados de acuerdo.',
    '#',
    '# Cualquier variable de entorno del mismo nombre tiene prioridad sobre este archivo.',
    ''
  ];
  if (model.stack.auth !== 'keycloak' && model.stack.auth !== 'cognito') {
    lines.push(
      `# Stack de identidad '${model.stack.auth}': build no genera el script de aprovisionamiento,`,
      '# pero estos son los valores con los que el arnés va a llamar. El agente de',
      '# infraestructura debe dejar el proveedor exactamente así (skill del proveedor).',
      ''
    );
  }
  lines.push(`AUTH_TOKEN_URL=${tokenUrl(model)}`);
  if (security?.roles?.length) {
    lines.push(`AUTH_TEST_CLIENT=${userTestClient(model)}`, `AUTH_TEST_PASSWORD=${PASSWORD}`);
  }

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
    const users = realmSpec(model)?.users.map((user) => user.username) ?? [];
    lines.push('', `# Usuarios de prueba (<rol> y <rol>-2, más uno sin roles): ${users.join(', ')}`);
  }
  if (usesPersonaTokens(model)) {
    const admin = keycloakAdminCredentials();
    lines.push(
      '',
      `# Administración del realm, para tokenAs(sub, claims) de ${platform.identity.harness}: da de alta a la`,
      '# persona del escenario con su sub exacto y le pone los claims de cada petición. Son las del',
      '# contenedor de infra/ (KC_BOOTSTRAP_ADMIN_*), las mismas con las que entra init-keycloak.sh.',
      `AUTH_ADMIN_USER=${admin.user}`,
      `AUTH_ADMIN_PASSWORD=${admin.password}`
    );
  }
  if (security?.scoping) {
    const exempt = security.scoping.exemptRoles;
    lines.push(
      '',
      `# Alcance por recurso: el claim '${security.scoping.claim}' de los usuarios NO exentos lleva`,
      '# este valor. Los escenarios que ejercitan el alcance crean el recurso con este código y',
      '# comprueban el rechazo sobre cualquier otro: se lee de aquí, no se escribe a mano.',
      '# Hay además un cliente máquina con ESE MISMO nombre, para que el recurso acotado pueda',
      '# originar tráfico por HTTP; sin él, el alcance solo sería ejercitable por vías indirectas.',
      '# Su secreto es el compartido de la matriz de prueba (AUTH_CLIENT_SECRET).',
      exempt.length > 0 ? `# Exentos (su token no lleva el claim): ${exempt.join(', ')}` : '# Ningún rol exento.',
      `AUTH_SCOPED_RESOURCE=${scopedValue(model)}`
    );
  }
  return { path: 'infra/test-credentials.env', content: `${lines.join('\n')}\n` };
}

// ─── infra/init-keycloak.sh ──────────────────────────────────────────────────

function keycloakScript(model, platform) {
  const spec = realmSpec(model);
  const { realm, audience, roles, scopes, serviceClients, m2mClients, validateAudience } = spec;

  const blocks = [];

  // La sesion admin NO pasa por run(): es prerrequisito de todo lo que sigue y
  // run() traga cualquier error para tolerar el 409 de idempotencia. Contra un
  // Keycloak todavia arrancando ('start-dev' tarda decenas de segundos en la
  // primera pasada, y el compose no le pone healthcheck), kcadm.sh falla, y sin
  // esta espera el script recorreria todas sus secciones sin aprovisionar nada y
  // saldria con 0 — un proveedor vacio que la suite descubre mucho despues.
  // El propio 'config credentials' es el sondeo: comprueba justo lo que el script
  // necesita, sin depender de otro contenedor ni de un curl dentro de la imagen.
  blocks.push(`echo "== Sesion admin (espera a que Keycloak acepte kcadm) =="
KC_WAIT_ATTEMPTS="\${KEEL_KC_WAIT_ATTEMPTS:-60}"
KC_WAIT_DELAY="\${KEEL_KC_WAIT_DELAY:-2}"
attempt=1
while :; do
  if eval "$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin" >/dev/null 2>&1; then
    echo "  sesion admin establecida (intento $attempt)"
    break
  fi
  if [ "$attempt" -ge "$KC_WAIT_ATTEMPTS" ]; then
    echo "Keycloak no acepto una sesion admin tras $KC_WAIT_ATTEMPTS intentos ($((KC_WAIT_ATTEMPTS * KC_WAIT_DELAY))s)." >&2
    echo "Diagnostica con: \${COMPOSE[*]} logs keycloak" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$KC_WAIT_DELAY"
done

echo "== Realm =="
run "create realms -s realm=$REALM -s enabled=true"`);

  if (roles.length > 0) {
    blocks.push(`echo "== Cliente publico para tokens de usuario (password grant) =="
run "create clients -r $REALM -s clientId=$USER_CLIENT -s enabled=true -s publicClient=true -s directAccessGrantsEnabled=true"`);
    blocks.push(`echo "== Roles del diseno (security.keel.yaml) =="
${roles.map((role) => `run "create roles -r $REALM -s name=${role}"`).join('\n')}

echo "== User Profile: atributos no gestionados =="
# Keycloak 24+ usa User Profile DECLARATIVO por defecto: cualquier atributo de usuario
# que no este en el schema del perfil se descarta AL GUARDAR, en silencio — sin error en
# la respuesta (204) ni en la salida de kcadm. Un diseno cuyo control de acceso se acota
# por un claim que sale de un atributo de usuario (el caso tipico: un claim con los
# codigos de recurso a los que ese usuario alcanza) no puede aprovisionarlo sin esto, y
# el sintoma no es un fallo de este script sino un 403 sin explicacion, minutos despues,
# dentro de un test de integracion. El DSL no tiene hoy forma de declarar esos claims, asi
# que el paso va SIEMPRE: no cuesta nada y quita la trampa a quien anada el atributo.
run "update users/profile -r $REALM -s unmanagedAttributePolicy=ENABLED"

echo "== Usuarios de prueba: dos por rol (<rol> y <rol>-2) + uno sin roles =="
for USER in ${spec.users.map((user) => user.username).join(' ')}; do
  run "create users -r $REALM -s username=$USER -s enabled=true -s email=$USER@example.com -s emailVerified=true -s firstName=Test -s lastName=User"
  run "set-password -r $REALM --username $USER --new-password $PASSWORD"
done
${spec.users
  .filter((user) => user.roles.length > 0)
  .map((user) => `run "add-roles -r $REALM --uusername ${user.username} --rolename ${user.roles[0]}"`)
  .join('\n')}`);

    // Alcance por recurso (security.authentication.scoping): el claim que acota qué recursos
    // alcanza el titular. Son DOS piezas y las dos son imprescindibles — el atributo en cada
    // usuario no exento, y el protocol mapper que lo proyecta al token—. Sin el mapper el
    // atributo existe y el claim no llega; sin el atributo el mapper no tiene qué proyectar.
    // En ninguno de los dos casos falla nada aquí: falla un 403 sin explicación dentro de un
    // test de integración, minutos después.
    const scoped = spec.users.filter((user) => Object.keys(user.attributes ?? {}).length > 0);
    if (spec.scoping && scoped.length > 0) {
      const { claim } = spec.scoping;
      const mapperConfig = [
        `-s name=${claim}-mapper`,
        '-s protocol=openid-connect',
        '-s protocolMapper=oidc-usermodel-attribute-mapper',
        `-s 'config.\\"user.attribute\\"=${claim}'`,
        `-s 'config.\\"claim.name\\"=${claim}'`,
        `-s 'config.\\"jsonType.label\\"=String'`,
        `-s 'config.\\"multivalued\\"=true'`,
        `-s 'config.\\"access.token.claim\\"=true'`,
        `-s 'config.\\"id.token.claim\\"=true'`
      ].join(' ');
      blocks.push(`echo "== Alcance por recurso: claim '${claim}' (security.authentication.scoping) =="
# El claim sale de un atributo de usuario del mismo nombre, proyectado por un protocol mapper
# sobre el cliente publico de usuario. Los roles exentos NO reciben el atributo: su token no
# lleva el claim y su alcance es transversal por diseno.
USER_CID=$(client_id_of "$USER_CLIENT")
require_id "$USER_CID" "el cliente $USER_CLIENT"
run "create clients/$USER_CID/protocol-mappers/models -r $REALM ${mapperConfig}"
for SCOPED_USER in ${scoped.map((user) => user.username).join(' ')}; do
  SCOPED_UID=$(user_id_of "$SCOPED_USER")
  require_id "$SCOPED_UID" "el usuario $SCOPED_USER"
  run "update users/$SCOPED_UID -r $REALM -s 'attributes.${claim}=[\\"${scopedValue(model)}\\"]'"
  # Lectura de vuelta: un 204 no prueba que el atributo se guardara (el User Profile descarta
  # en silencio lo que no conoce). Si falta, se muere AQUI, nombrando al usuario, y no veinte
  # escenarios despues en un 403 sin pista.
  if ! eval "$KC get users/$SCOPED_UID -r $REALM" 2>/dev/null | tr -d '\\r' | grep -q '"${scopedValue(model)}"'; then
    echo "ERROR: el atributo ${claim} no quedo persistido en $SCOPED_USER ($SCOPED_UID)." >&2
    exit 1
  fi
done`);
    }
  }

  // Audiencia y permisos en client scopes SEPARADOS: si viajan juntos, el cliente
  // "sin scope" pierde también la audiencia y su fallo deja de probar nada sobre el
  // scope (references/test-clients.md de la skill de Keycloak de cada generador).
  if (scopes.length > 0) {
    const audienceBlock = [
      'echo "== Client scopes de audiencia (desacoplados de los de permisos) =="',
      'run "create client-scopes -r $REALM -s name=aud-$SVC -s protocol=openid-connect"',
      'AUD_OK=$(scope_id_of "aud-$SVC")',
      'require_id "$AUD_OK" "el client-scope aud-$SVC"',
      'run "create client-scopes/$AUD_OK/protocol-mappers/models -r $REALM -s name=aud-mapper -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper -s \'config.\\"included.custom.audience\\"=$SVC\' -s \'config.\\"access.token.claim\\"=true\'"'
    ];
    if (validateAudience) {
      audienceBlock.push(
        '',
        'run "create client-scopes -r $REALM -s name=aud-wrong -s protocol=openid-connect"',
        'AUD_BAD=$(scope_id_of "aud-wrong")',
        'require_id "$AUD_BAD" "el client-scope aud-wrong"',
        'run "create client-scopes/$AUD_BAD/protocol-mappers/models -r $REALM -s name=aud-mapper -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper -s \'config.\\"included.custom.audience\\"=audiencia-ajena\' -s \'config.\\"access.token.claim\\"=true\'"'
      );
    }
    blocks.push(audienceBlock.join('\n'));

    blocks.push(`echo "== Client scopes de permiso (sin mapper de audiencia) =="
${scopes
  .map(
    (scope, index) =>
      `run "create client-scopes -r $REALM -s name=${scope} -s protocol=openid-connect -s 'attributes.\\"include.in.token.scope\\"=true'"\n` +
      `SCOPE_${index}=$(scope_id_of "${scope}")\nrequire_id "$SCOPE_${index}" "el client-scope ${scope}"`
  )
  .join('\n')}`);
  }

  const machineClient = (client) =>
    `run "create clients -r $REALM -s clientId=${client.name} -s enabled=true -s publicClient=false -s serviceAccountsEnabled=true -s secret=${client.secret}"`;

  if (serviceClients.length > 0) {
    blocks.push(`echo "== Clientes maquina del diseno (security.serviceClients) =="
${serviceClients.map(machineClient).join('\n')}`);
  }

  if (m2mClients.length > 0) {
    blocks.push(`echo "== Clientes M2M de prueba (matriz scope x audiencia) =="
${m2mClients.map(machineClient).join('\n')}`);
  }

  const assigned = scopeAssignments(spec);
  if (assigned.length > 0) {
    const assignments = [];
    for (const client of assigned) {
      // test-m2m-none no lleva ninguno: es el control.
      if (client.audience === 'ok') assignments.push(`assign_scope ${client.name} "$AUD_OK"`);
      if (client.audience === 'wrong') assignments.push(`assign_scope ${client.name} "$AUD_BAD"`);
      for (const scope of client.scopes) {
        assignments.push(`assign_scope ${client.name} "$SCOPE_${scopes.indexOf(scope)}"`);
      }
    }

    blocks.push(`assign_scope() {
  local CLIENT_ID="$1" SCOPE_ID="$2"
  local CID
  CID=$(client_id_of "$CLIENT_ID")
  require_id "$CID" "el cliente $CLIENT_ID"
  run "update clients/$CID/default-client-scopes/$SCOPE_ID -r $REALM"
}

echo "== Asignacion de client scopes =="
${assignments.join('\n')}`);
  }

  const verifyUser = roles[0] ?? NO_ROLE_USER;
  const content = `#!/usr/bin/env bash
# Prepara el realm de prueba "${realm}" en el Keycloak de infra/docker-compose.yaml:
# ${roles.length > 0 ? 'realm + roles + usuarios de prueba (grant password) + clientes maquina' : 'realm + clientes maquina (el diseno no declara roles: no hay usuarios de prueba)'}. Generado
# por ${platform.generator} build a partir de specs/security.keel.yaml: los nombres y secretos
# son los mismos que infra/test-credentials.env entrega a ${platform.identity.harness}, y por eso
# no se editan aqui a mano — si algo tiene que cambiar, cambia en el diseno.
#
# Idempotente: las creaciones toleran el 409 de Keycloak (recurso ya existente), asi
# que se puede reejecutar tras cada 'compose up'. Espera a que Keycloak acepte una
# sesion admin antes de empezar (KEEL_KC_WAIT_ATTEMPTS / KEEL_KC_WAIT_DELAY) y aborta
# si no lo consigue: aprovisionar a medias es peor que no aprovisionar.
#
# Nota: el GET client-scopes de Keycloak NO filtra por -q name=... (devuelve el
# listado completo), a diferencia de GET clients; por eso el id de un client-scope se
# busca por coincidencia exacta ",<nombre>$" sobre el csv id,name.
#
# Convenciones: docs/keel/conventions/infra-validation.md
#               references/test-clients.md de la skill ${platform.identity.skill}
set -euo pipefail
export MSYS_NO_PATHCONV=1

# Runtime y frontend de compose con la MISMA lógica que up.sh, y no una propia: este
# script hardcodeaba \`podman compose\`, que en Windows delega en el docker-compose.exe del
# PATH y no encuentra el named pipe de la máquina de podman. El síntoma era «Keycloak no
# aceptó una sesión admin tras N intentos» con Keycloak perfectamente sano — un falso
# negativo que acusa al servidor de un problema que es del frontend de compose.
${RUNTIME_RESOLUTION}

${composeResolution(['-f', 'infra/docker-compose.yaml'])}

KC="\${COMPOSE[*]} exec -T keycloak /opt/keycloak/bin/kcadm.sh"
REALM=${realm}
SVC=${audience}                     # audiencia del servicio (security.serviceAuth.audience)
${roles.length > 0 ? `USER_CLIENT=${userTestClient(model)} # cliente publico para tokens de usuario
` : ''}PASSWORD=${PASSWORD}

# El script es IDEMPOTENTE: re-ejecutarlo sobre un realm ya sembrado devuelve 409 en
# cada \`create\`, y eso es normal. Lo que NO es normal es cualquier otro fallo de kcadm,
# y la versión anterior de este helper —un \`|| true\` incondicional— los tragaba todos:
# el aprovisionamiento quedaba a medias, el script salía 0, y el defecto reaparecía
# minutos después como un 403 sin explicación dentro de un test de integración. Se
# tolera el conflicto, que es la única forma de fallo esperada, y se aborta con el resto.
#
# OJO con la forma de capturar el codigo de salida. \`out=$(...); rc=$?\` NO sirve bajo
# \`set -e\`: una asignacion por sustitucion de comandos toma el estado de salida de la
# sustitucion, asi que un kcadm que devuelve != 0 —incluido el 409 que esta funcion existe
# para tolerar— dispara errexit en la propia asignacion y jamas se llega a leer \`rc\`. El
# efecto observado fue el peor posible: reejecutar el script sobre un realm ya sembrado
# abortaba en silencio justo despues de crear el realm, dejando usuarios, roles y clientes
# sin aprovisionar, con exit 1 y sin una sola linea de ERROR. La forma segura es capturar
# el codigo en la MISMA sentencia, que es un contexto de condicion y suspende errexit.
run() {
  out=$(eval "$KC $*" 2>&1) && rc=0 || rc=$?
  printf '%s\\n' "$out" | grep -v "compose provider\\|^\\[0m$\\|^$" || true
  if [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -qi "409\\|already exists\\|exists with same\\|Conflict"; then
    echo "ERROR: kcadm falló ($rc) en: $*" >&2
    exit 1
  fi
}
# Los dos helpers de abajo terminan en un pipeline con grep/tail: bajo \`pipefail\` un «no
# encontrado» —que es un resultado legitimo, no un fallo— devuelve != 0 y mataria el script
# en la asignacion que lo llama, otra vez sin mensaje. Se cierra con \`|| true\` y el vacio se
# juzga en require_id, que si dice QUE no se pudo resolver: morir es correcto aqui, morir
# callado no.
# id de un cliente por su clientId exacto (GET clients SI soporta -q).
client_id_of() { eval "$KC get clients -r $REALM -q clientId=$1 --fields id --format csv --noquotes" 2>/dev/null | tr -d '\\r' | tail -1 || true; }
# id de un client-scope por su name exacto (GET client-scopes NO soporta -q: filtra en local).
scope_id_of() { eval "$KC get client-scopes -r $REALM --fields id,name --format csv --noquotes" 2>/dev/null | tr -d '\\r' | grep ",$1\\$" | cut -d, -f1 || true; }
# id de un usuario por su username EXACTO. GET users?username=x busca por SUBCADENA:
# 'editor' casa tambien con 'editor-2', y quedarse con la ultima fila escribia el atributo
# del claim en el usuario '-2' y dejaba al original sin claim (corrida notifications,
# 2026-09-30: 20 escenarios en 403). Se pide exact=true Y se filtra en local por la columna
# del username: lo segundo no depende de que la version de Keycloak honre lo primero.
user_id_of() { eval "$KC get users -r $REALM -q username=$1 -q exact=true --fields id,username --format csv --noquotes" 2>/dev/null | tr -d '\\r' | grep ",$1\\$" | head -1 | cut -d, -f1 || true; }
# Un id vacio significa que el recurso no esta donde deberia: el aprovisionamiento va a medias
# y seguir solo produce peticiones malformadas contra rutas con un id en blanco.
require_id() {
  if [ -z "$1" ]; then
    echo "ERROR: no se pudo resolver $2 — el realm '$REALM' esta aprovisionado a medias." >&2
    echo "  Revisa la salida anterior; si Keycloak se reinicio, vuelve a ejecutar este script." >&2
    exit 1
  fi
}

${blocks.join('\n\n')}

echo "Realm '$REALM' listo. Verifica con:"
${
  roles.length > 0
    ? `echo "  curl -s -d 'grant_type=password&client_id=$USER_CLIENT&username=${verifyUser}&password=$PASSWORD' ${tokenUrl(model)} | jq -r .access_token"`
    : `echo "  curl -s -u '${serviceClients[0]?.name ?? 'CLIENTE'}:<secreto de test-credentials.env>' -d 'grant_type=client_credentials' ${tokenUrl(model)} | jq -r .access_token"`
}
`;

  return { path: 'infra/init-keycloak.sh', content };
}

// ─── infra/cognito/mock-oauth2-config.json ───────────────────────────────────
//
// Tercera proyección de `realmSpec()`, hermana del script de Keycloak y de su
// realm-export: los mismos roles, usuarios, scopes y clientes, escritos esta vez
// como `tokenCallbacks` de mock-oauth2-server.
//
// Lo que emite NO es «un token cualquiera que sirva»: es un token con la forma
// EXACTA de los de Cognito, incluidas sus dos rarezas, porque es lo único que
// hace que lo que pase en local prediga lo que pasará contra el pool real:
//
//   - los scopes vienen prefijados por el resource server (`<servicio>/<scope>`),
//     no como el `recurso:accion` pelado que emite Keycloak, y
//   - los access token de `client_credentials` NO traen `aud`, traen `client_id`.
//
// Las dos las absorbe el código generado (security.js), y por eso el emulador
// tiene que producirlas: un mock más cómodo dejaría verde un servicio que en
// producción devuelve 403 a todas las máquinas.
export function cognitoMockConfig(model) {
  const spec = realmSpec(model);
  const issuerId = spec.realm;

  // Un mapping por usuario, emparejado por `username` (el grant es ROPC, como con
  // Keycloak). El usuario sin roles emite el array vacío: sin él, «autenticado
  // pero sin permiso» no sería observable y el 403 por rol no tendría sujeto.
  const users = spec.users.map((user) => ({
    requestParam: 'username',
    match: user.username,
    claims: {
      sub: user.username,
      username: user.username,
      token_use: 'access',
      'cognito:groups': user.roles,
      client_id: spec.userClient
    }
  }));

  // Un mapping por cliente máquina, emparejado por `client_id`.
  //
  // La matriz de prueba conserva su significado bajo semántica Cognito, y la clave
  // está en el PREFIJO: como sus tokens de máquina no llevan `aud`, la audiencia se
  // expresa en el resource server que prefija cada scope (`catalog/product:read` =
  // «vale para la API de catalog»). Así, «audiencia ajena» se emite como scopes con
  // OTRO prefijo, que es exactamente lo que el filtro generado rechaza — sin
  // inventar ningún claim que Cognito real no emitiría.
  const machines = [...spec.serviceClients, ...spec.m2mClients].map((client) => {
    const resourceServer = client.audience === 'wrong' ? FOREIGN_RESOURCE_SERVER : spec.audience;
    const claims = {
      sub: client.name,
      token_use: 'access',
      client_id: client.name
    };
    // Sin scopes no hay claim `scope`: es el control de la matriz (`test-m2m-none`),
    // y un claim vacío no significaría lo mismo que su ausencia.
    if (client.scopes.length > 0) {
      claims.scope = client.scopes.map((scope) => `${resourceServer}/${scope}`).join(' ');
    }
    return { requestParam: 'client_id', match: client.name, claims };
  });

  const config = {
    interactiveLogin: false,
    tokenCallbacks: [
      {
        issuerId,
        tokenExpiry: 3600,
        requestMappings: [...users, ...machines]
      }
    ]
  };
  return {
    path: 'infra/cognito/mock-oauth2-config.json',
    content: `${JSON.stringify(config, null, 2)}\n`
  };
}
