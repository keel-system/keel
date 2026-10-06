// La infraestructura de prueba (`infra/`) es NEUTRAL y la escribe keel-core/gen/infra-scripts.js,
// la misma para keel-spring y keel-nest: los dos servidores del mismo diseño se puntúan contra los
// mismos contenedores, reseteados del mismo modo. Aquí solo queda la PLATAFORMA de keel-spring —los
// textos que nombran Flyway, Hibernate, Gradle o el arnés JUnit, y la topología de mensajería que
// siembra— y los envoltorios que la fijan para el resto del scaffolding.

import * as infra from 'keel-core/gen/infra-scripts';
import { messagingProvisioning, messagingTopologyChecks } from './messaging-provisioning.js';

export const SPRING_INFRA = {
  generator: 'keel-spring',
  // El historial de migraciones de Flyway: el reset de datos lo respeta (ver infra-catalog.js).
  historyTable: 'flyway_schema_history',
  strayProcess: {
    comment: `# Procesos ajenos a la validación que comparten esta infraestructura. Un
# 'gradlew bootRun' olvidado escribe en la misma BD que la suite y contamina la
# matriz con datos que ningún escenario creó — un fallo que parece de negocio y
# no lo es. Es aviso, no error: el puerto ocupado no impide correr las pruebas
# (la suite arranca en un puerto aleatorio), solo explica resultados imposibles.`,
    hint: "¿un 'gradlew bootRun' de otra sesión?",
    close: 'ciérralo antes de ejecutar integrationTest.'
  },
  schemaRebuiltBy: {
    relational: 'lo vuelve a crear Hibernate al arrancar la app',
    document: 'las colecciones nacen al escribir y los índices los recrea MongoIndexConfig al arrancar la app'
  },
  schemaHelp: {
    relational: `# --schema es para después de regenerar entidades: 'ddl-auto: update' no elimina
# columnas obsoletas ni afloja un NOT NULL preexistente, así que el esquema queda
# con restos que ninguna entidad mapea y todo INSERT falla con un 409 sin relación
# aparente con la causa. Recrear el esquema es la salida; el volumen no se toca.`,
    document: `# --schema borra la base entera. Es para después de cambiar un índice de forma:
# Mongo rechaza recrear el mismo nombre con otras claves, así que MongoIndexConfig
# falla al arrancar y el arranque se queda a medias. Vaciar los datos no lo arregla
# —el índice viejo sigue ahí—; borrar la base sí. El volumen no se toca.`
  },
  httpStubsReadme,
  // Topología de mensajería: que los topics y colas que siembra init-messaging.sh EXISTAN.
  extraChecks: (model) => messagingTopologyChecks(model),
  // Topología de mensajería: solo los brokers que no la autocrean (hoy, snssqs).
  extraFiles: (model) => [messagingProvisioning(model)].filter(Boolean)
};

export const { RUNTIME_RESOLUTION, HOSTPATH_HELPER, composeResolution, needsDevtools, cacheFlushCmd } = infra;

export function concreteCmd(entry, dbName, cmd = entry.cliValidateCmd) {
  return infra.concreteCmd(entry, dbName, cmd, SPRING_INFRA);
}

export function dockerfileDevtools(selected) {
  return infra.dockerfileDevtools(selected, SPRING_INFRA);
}

export function devtoolsImageTag(selected) {
  return infra.devtoolsImageTag(selected, SPRING_INFRA);
}

export function validateInfraScript(selected, service, model = null) {
  return infra.validateInfraScript(selected, service, model, SPRING_INFRA);
}

export function resetDbScript(selected, service, model = null) {
  return infra.resetDbScript(selected, service, model, SPRING_INFRA);
}

// Los mappings los programa cada prueba desde el arnés (AbstractFlowIT), que es
// donde se ve qué responde el proveedor en ese escenario. Este directorio existe
// para el montaje y para los stubs permanentes que no pertenecen a ningún flujo.
function httpStubsReadme(service) {
  return `# Stubs del proveedor de prueba (WireMock)

Los servicios de los que depende \`${service.name}\` por HTTP no están en \`infra/\`: en su
lugar hay un WireMock en \`http://localhost:8090\` (\`http://wiremock:8080\` desde otro
contenedor), y las \`base-url\` de los clientes de \`http-clients\` apuntan ahí en local.

**Lo normal es no tocar este directorio.** Cada prueba de integración programa lo que
necesita desde el arnés (\`stubFor(...)\` en \`AbstractFlowIT\`) y lo verifica ahí mismo:
así el escenario se lee entero en un sitio, y \`infra/reset-db.sh\` lo deja limpio entre
flujos. Un mapping en un archivo es estado global compartido por toda la suite.

Un \`mappings/*.json\` solo se justifica para lo que no pertenece a ningún flujo (por
ejemplo, un endpoint que el proveedor expone siempre igual y que se consulta al
arrancar). Formato y opciones: <https://wiremock.org/docs/stubbing/>.
`;
}
