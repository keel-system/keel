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
import { RUNTIME_RESOLUTION, composeResolution } from './devtools.js';

const PASSWORD = 'password';
// Secreto de los clientes M2M que solo existen para las variantes negativas de los
// escenarios; es el valor que documenta skills/keel-spring-keycloak/references/test-clients.md.
const TEST_SECRET = 'test-secret';
// Usuario sin ningún rol: el 403 por rol insuficiente necesita un sujeto autenticado.
const NO_ROLE_USER = 'no-role';
// Resource server ajeno, para la variante negativa de la matriz M2M con Cognito: es
// el prefijo de scope que hace que el token esté emitido para OTRA API.
const FOREIGN_RESOURCE_SERVER = 'audiencia-ajena';
// Valor del claim de alcance por recurso con el que se siembran los usuarios NO exentos.
// Es dato de prueba, no del diseño: el diseño declara de dónde sale la acotación, y qué
// recurso concreto alcanza un usuario de prueba es cosa del escenario. Viaja a
// test-credentials.env (`AUTH_SCOPED_RESOURCE`) para que el arnés lo lea en vez de
// hardcodearlo, igual que ya hace con los secretos.
const SCOPED_VALUE = 'keel-scoped-resource';

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
  // Con cognito, el emulador local sirve OAuth2 estándar bajo el issuerId (que es
  // el nombre del servicio): por eso el arnés no necesita ninguna rama propia y
  // pide los tokens igual que con Keycloak.
  return model.stack.auth === 'cognito'
    ? `http://localhost:${port}/${model.service.name}/token`
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
  // Con alcance por recurso, el recurso acotado necesita PODER ORIGINAR TRÁFICO. Sembrar el claim
  // de los usuarios y no dar credencial a ese recurso deja el alcance probable solo por vías
  // indirectas: en la primera corrida con `scoping`, el agente de pruebas tuvo que ejercitar el
  // escenario por el canal de eventos porque no había forma de pedir nada por HTTP en nombre del
  // recurso acotado. Se prueba entonces por una puerta que no es la que importa.
  if (model.security?.scoping) clients.push(SCOPED_VALUE);
  return clients;
}

/**
 * El realm de prueba como ESTRUCTURA DE DATOS, derivada del diseño.
 *
 * Fuente única de dos artefactos que describen lo mismo en formatos distintos:
 * `infra/init-keycloak.sh` (bash contra kcadm, para la generación) y
 * `deploy/keycloak/realm-export.json` (import declarativo, para las pruebas
 * manuales). Los dos renderizan desde aquí y ninguno recalcula nada, que es lo
 * único que impide que diverjan: un rol añadido al diseño aparece en ambos o en
 * ninguno. Hay además un test de paridad que compara los dos artefactos ya
 * renderizados, por si alguien se salta esta puerta.
 *
 * Devuelve null si el diseño no lleva identidad basada en token.
 */
export function realmSpec(model) {
  if (!model.layersPresent.security || !usesTokens(model)) return null;
  const security = model.security;
  const roles = security?.roles ?? [];
  const scopes = security?.scopes ?? [];
  const scoping = security?.scoping ?? null;
  const serviceClients = (security?.serviceClients ?? []).map((client) => ({
    name: client.name,
    secret: serviceClientSecret(client.name),
    // Un cliente sin scopes propios recibe todos los del servicio (mismo criterio
    // que el script original); se filtra por los declarados para no asignar uno
    // que no existe como client scope.
    scopes: (client.scopes.length > 0 ? client.scopes : scopes).filter((scope) => scopes.includes(scope))
  }));
  const m2m = testM2mClients(model);

  // Cada cliente de prueba varía UNA sola condición respecto al camino feliz:
  // 'ok' lleva audiencia buena y todos los scopes, 'no-scope' pierde los scopes,
  // 'bad-aud' cambia la audiencia, y 'none' es el control sin nada.
  const m2mClients = m2m.map((name) => ({
    name,
    secret: TEST_SECRET,
    audience: name === 'test-m2m-bad-aud' ? 'wrong' : name === 'test-m2m-none' ? null : 'ok',
    scopes: name === 'test-m2m-no-scope' || name === 'test-m2m-none' ? [] : scopes
  }));

  return {
    realm: model.service.name,
    audience: security?.serviceAuth?.audience ?? model.service.name,
    validateAudience: security?.serviceAuth?.validateAudience === true,
    password: PASSWORD,
    userClient: userTestClient(model),
    roles,
    // Un usuario por rol (username = rol) más uno sin ninguno: el 403 por rol
    // insuficiente necesita un sujeto autenticado.
    users: [...roles, NO_ROLE_USER].map((username) => ({
      username,
      roles: roles.includes(username) ? [username] : [],
      // Alcance por recurso: el claim se proyecta desde un atributo de usuario del mismo
      // nombre, y solo lo llevan los roles que NO están exentos. Un usuario exento sin el
      // atributo es justamente lo que hace observable la exención — si todos lo llevaran,
      // el escenario que prueba que el administrador alcanza cualquier recurso no probaría
      // nada. El valor es dato de PRUEBA, no del diseño, y por eso sale de una constante
      // que también viaja a test-credentials.env: el escenario nombra la variable, no el
      // literal.
      attributes:
        scoping && !scoping.exemptRoles.includes(username) && username !== NO_ROLE_USER
          ? { [scoping.claim]: [SCOPED_VALUE] }
          : {}
    })),
    scoping,
    scopes,
    serviceClients,
    m2mClients
  };
}

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

export function generate(model) {
  if (!model.layersPresent.security || !usesTokens(model)) return [];
  const files = [credentialsEnv(model)];
  if (model.stack.auth === 'keycloak') files.push(keycloakScript(model));
  if (model.stack.auth === 'cognito') files.push(cognitoMockConfig(model));
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
  if (model.stack.auth !== 'keycloak' && model.stack.auth !== 'cognito') {
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
      `AUTH_SCOPED_RESOURCE=${SCOPED_VALUE}`
    );
  }
  return { path: 'infra/test-credentials.env', content: `${lines.join('\n')}\n` };
}

// ─── infra/init-keycloak.sh ──────────────────────────────────────────────────

function keycloakScript(model) {
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
run "create realms -s realm=$REALM -s enabled=true"

echo "== Cliente publico para tokens de usuario (password grant) =="
run "create clients -r $REALM -s clientId=$USER_CLIENT -s enabled=true -s publicClient=true -s directAccessGrantsEnabled=true"`);

  if (roles.length > 0) {
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

echo "== Usuarios de prueba: uno por rol (username = rol) + uno sin roles =="
for USER in ${spec.users.map((user) => user.username).join(' ')}; do
  run "create users -r $REALM -s username=$USER -s enabled=true -s email=$USER@example.com -s emailVerified=true -s firstName=Test -s lastName=User"
  run "set-password -r $REALM --username $USER --new-password $PASSWORD"
done
${roles.map((role) => `run "add-roles -r $REALM --uusername ${role} --rolename ${role}"`).join('\n')}`);

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
  run "update users/$SCOPED_UID -r $REALM -s 'attributes.${claim}=[\\"${SCOPED_VALUE}\\"]'"
done`);
    }
  }

  // Audiencia y permisos en client scopes SEPARADOS: si viajan juntos, el cliente
  // "sin scope" pierde también la audiencia y su fallo deja de probar nada sobre el
  // scope (skills/keel-spring-keycloak/references/test-clients.md).
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
# realm + roles + usuarios de prueba (grant password) + clientes maquina. Generado
# por keel-spring build a partir de specs/security.keel.yaml: los nombres y secretos
# son los mismos que infra/test-credentials.env entrega a AbstractFlowIT, y por eso
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
#               references/test-clients.md de la skill keel-spring-keycloak
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
USER_CLIENT=${userTestClient(model)} # cliente publico para tokens de usuario
PASSWORD=${PASSWORD}

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
# id de un usuario por su username exacto (GET users SI soporta -q).
user_id_of() { eval "$KC get users -r $REALM -q username=$1 --fields id --format csv --noquotes" 2>/dev/null | tr -d '\\r' | tail -1 || true; }
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
echo "  curl -s -d 'grant_type=password&client_id=$USER_CLIENT&username=${verifyUser}&password=$PASSWORD' ${tokenUrl(model)} | jq -r .access_token"
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
