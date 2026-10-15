// La infraestructura de PRUEBA (`infra/`): la MISMA que la de keel-spring y keel-nest del mismo diseño —los
// mismos contenedores, la misma validación, el mismo reset entre flujos—, porque la escribe
// keel-core/gen/infra-scripts.js. Aquí solo está la plataforma de keel-dotnet: los textos que nombran sus
// herramientas y la tabla de historial de sus migraciones.

import { infraFiles } from 'keel-core/gen/infra-scripts';
import { identityProvisioningFiles } from 'keel-core/gen/identity-provisioning';
import { messagingProvisioning, messagingTopologyChecks } from 'keel-core/gen/messaging-provisioning';
import { MIGRATIONS_TABLE } from './persistence-runtime.js';

export const DOTNET_INFRA = {
  generator: 'keel-dotnet',
  // El proveedor de identidad de prueba (keel-core/gen/identity-provisioning.js): quién consume test-credentials.env
  // y qué skill documenta los clientes de prueba.
  identity: { harness: 'tests/<Servicio>.IntegrationTests/Support/Credentials.cs', skill: 'keel-dotnet-keycloak' },
  // El historial de EF Core con su nombre propio (`MigrationsHistoryTable`, persistence-runtime.js): el reset lo
  // respeta por nombre, y truncarlo haría que el siguiente arranque en develop reaplicara el baseline sobre tablas
  // ya existentes.
  historyTable: MIGRATIONS_TABLE,
  strayProcess: {
    comment: `# Procesos ajenos a la validación que comparten esta infraestructura. Un
# 'dotnet run' olvidado escribe en la misma BD que la suite y contamina la matriz
# con datos que ningún escenario creó — un fallo que parece de negocio y no lo es.
# Es aviso, no error: el puerto ocupado no impide correr las pruebas (el arnés
# arranca el servidor en un puerto libre), solo explica resultados imposibles.`,
    hint: "¿un 'dotnet run' de otra sesión?",
    close: 'ciérralo antes de ejecutar bash infra/score-scenarios.sh.'
  },
  schemaRebuiltBy: {
    relational: 'lo vuelve a crear EF Core al arrancar la app (EnsureCreated del perfil local)',
    // La persistencia documental (incremento 12): los índices los crea DocumentIndexes al arrancar.
    document: 'las colecciones nacen al escribir y los índices los recrea la app al arrancar'
  },
  schemaHelp: {
    relational: `# --schema es para después de regenerar el mapeo: el EnsureCreated del perfil local
# solo crea el esquema cuando la base no tiene ninguna tabla, así que una columna
# nueva no llega nunca a una base que ya existe, y el primer flujo falla con un error
# del motor que no apunta a la fila. Recrear el esquema es la salida; el volumen no se
# toca.`,
    document: `# --schema borra la base entera. Es para después de cambiar un índice de forma:
# Mongo rechaza recrear el mismo nombre con otras claves, así que el arranque falla.
# Vaciar los datos no lo arregla —el índice viejo sigue ahí—; borrar la base sí. El
# volumen no se toca.`
  },
  httpStubsReadme,
  // La topología de SNS/SQS (keel-core/gen/messaging-provisioning.js): cómo nombra init-messaging.sh las piezas de
  // keel-dotnet, que los topics y colas que siembra EXISTAN, y el script mismo.
  messaging: {
    harnessReaders: 'PublishedMessages / PurgeMessages de tests/<Servicio>.IntegrationTests/Support/Messaging.cs',
    codeReads: 'por la configuracion de cada perfil',
    skill: 'keel-dotnet-snssqs',
    copyHelper: 'CopyToDevtools del arnes'
  },
  extraChecks: (model) => messagingTopologyChecks(model),
  extraFiles: (model) => [messagingProvisioning(model, DOTNET_INFRA)].filter(Boolean)
};

export function generate(model) {
  return [...infraFiles(model, DOTNET_INFRA), ...identityProvisioningFiles(model, DOTNET_INFRA)];
}

// Lo emite infra-scripts.js solo con integraciones salientes, que keel-dotnet genera desde el incremento 11: queda
// escrito para entonces, con el arnés de este proyecto.
function httpStubsReadme(service) {
  return `# Stubs del proveedor de prueba (WireMock)

Los servicios de los que depende \`${service.name}\` por HTTP no están en \`infra/\`: en su
lugar hay un WireMock en \`http://localhost:8090\` (\`http://wiremock:8080\` desde otro
contenedor), y las \`base-url\` de los clientes de \`http-clients\` apuntan ahí en local.

**Lo normal es no tocar este directorio.** Cada prueba de flujo programa lo que necesita
desde el arnés (\`tests/<Servicio>.IntegrationTests/Support/\`) y lo verifica ahí mismo: así
el escenario se lee entero en un sitio, y \`infra/reset-db.sh\` lo deja limpio entre flujos.
Un mapping en un archivo es estado global compartido por toda la suite.

Un \`mappings/*.json\` solo se justifica para lo que no pertenece a ningún flujo.
Formato y opciones: <https://wiremock.org/docs/stubbing/>.
`;
}
