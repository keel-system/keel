// La infraestructura de PRUEBA (`infra/`): la MISMA que la de keel-spring, keel-nest y keel-dotnet del mismo diseño
// —los mismos contenedores, la misma validación, el mismo reset entre flujos—, porque la escribe
// keel-core/gen/infra-scripts.js. Aquí solo está la plataforma de keel-go: los textos que nombran sus herramientas y
// la tabla de historial de sus migraciones.

import { infraFiles } from '@keel-system/keel-core/gen/infra-scripts';
import { identityProvisioningFiles } from '@keel-system/keel-core/gen/identity-provisioning';
import { messagingProvisioning, messagingTopologyChecks } from '@keel-system/keel-core/gen/messaging-provisioning';

/**
 * La tabla de historial de goose (la de por defecto: `persistence-runtime.js` no la renombra). El reset la respeta
 * por nombre: truncarla haría que el siguiente arranque reaplicara la baseline sobre tablas que ya existen.
 */
export const MIGRATIONS_TABLE = 'goose_db_version';

export const GO_INFRA = {
  generator: 'keel-go',
  // El proveedor de identidad de prueba (keel-core/gen/identity-provisioning.js): quién consume test-credentials.env
  // y qué skill documenta los clientes de prueba. Llega con la seguridad (incremento 8).
  identity: { harness: 'tests/integration/credentials_test.go', skill: 'keel-go-keycloak' },
  historyTable: MIGRATIONS_TABLE,
  strayProcess: {
    comment: `# Procesos ajenos a la validación que comparten esta infraestructura. Un
# 'go run ./cmd/server' olvidado escribe en la misma BD que la suite y contamina la
# matriz con datos que ningún escenario creó — un fallo que parece de negocio y no lo
# es. Es aviso, no error: el puerto ocupado no impide correr las pruebas (el arnés
# arranca el servidor en un puerto libre), solo explica resultados imposibles.`,
    hint: "¿un 'go run ./cmd/server' de otra sesión?",
    close: 'ciérralo antes de ejecutar bash infra/score-scenarios.sh.'
  },
  schemaRebuiltBy: {
    relational: 'lo vuelve a crear goose al arrancar la app (la migración baseline embebida en el binario)',
    // La persistencia documental (incremento 12): los índices los crea la app al arrancar.
    document: 'las colecciones nacen al escribir y los índices los recrea la app al arrancar'
  },
  schemaHelp: {
    relational: `# --schema es para después de regenerar el esquema: goose solo aplica las
# migraciones que su historial no tiene, así que una baseline reescrita no llega nunca
# a una base que ya la aplicó, y el primer flujo falla con un error del motor que no
# apunta a la fila. Recrear el esquema (historial incluido) es la salida; el volumen
# no se toca.`,
    document: `# --schema borra la base entera. Es para después de cambiar un índice de forma:
# Mongo rechaza recrear el mismo nombre con otras claves, así que el arranque falla.
# Vaciar los datos no lo arregla —el índice viejo sigue ahí—; borrar la base sí. El
# volumen no se toca.`
  },
  httpStubsReadme,
  // La topología de SNS/SQS (keel-core/gen/messaging-provisioning.js): cómo nombra init-messaging.sh las piezas de
  // keel-go, que los topics y colas que siembra EXISTAN, y el script mismo. Llega con la mensajería (incremento 9).
  messaging: {
    harnessReaders: 'PublishedMessages / PurgeMessages de tests/integration/messaging_test.go',
    codeReads: 'por la configuracion de cada perfil',
    skill: 'keel-go-snssqs',
    copyHelper: 'CopyToDevtools del arnes'
  },
  extraChecks: (model) => messagingTopologyChecks(model),
  extraFiles: (model) => [messagingProvisioning(model, GO_INFRA)].filter(Boolean)
};

export function generate(model) {
  return [...infraFiles(model, GO_INFRA), ...identityProvisioningFiles(model, GO_INFRA)];
}

// Lo emite infra-scripts.js solo con integraciones salientes, que keel-go genera desde el incremento 11: queda
// escrito para entonces, con el arnés de este proyecto.
function httpStubsReadme(service) {
  return `# Stubs del proveedor de prueba (WireMock)

Los servicios de los que depende \`${service.name}\` por HTTP no están en \`infra/\`: en su
lugar hay un WireMock en \`http://localhost:8090\` (\`http://wiremock:8080\` desde otro
contenedor), y las \`base-url\` de los clientes de \`http-clients\` apuntan ahí en local.

**Lo normal es no tocar este directorio.** Cada prueba de flujo programa lo que necesita
desde el arnés (\`tests/integration/\`) y lo verifica ahí mismo: así el escenario se lee
entero en un sitio, y \`infra/reset-db.sh\` lo deja limpio entre flujos. Un mapping en un
archivo es estado global compartido por toda la suite.

Un \`mappings/*.json\` solo se justifica para lo que no pertenece a ningún flujo.
Formato y opciones: <https://wiremock.org/docs/stubbing/>.
`;
}
