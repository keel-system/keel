// La infraestructura de PRUEBA (`infra/`): la MISMA que la de keel-spring del mismo diseño —los
// mismos contenedores, la misma validación, el mismo reset entre flujos—, porque la escribe
// keel-core/gen/infra-scripts.js. Aquí solo está la plataforma de keel-nest: los textos que nombran
// sus herramientas y la tabla de historial de sus migraciones.

import { infraFiles } from 'keel-core/gen/infra-scripts';
import { identityProvisioningFiles } from 'keel-core/gen/identity-provisioning';

/**
 * La tabla de historial de las migraciones de TypeORM. Explícita (`migrationsTableName` del
 * DataSource) y no la de por defecto, `migrations`, que es un nombre que un diseño puede usar para
 * una tabla propia: el reset la respeta por nombre, y truncarla haría que el siguiente arranque
 * reaplicara el baseline sobre tablas ya existentes.
 */
export const MIGRATIONS_TABLE = 'typeorm_migrations';

export const NEST_INFRA = {
  generator: 'keel-nest',
  // El proveedor de identidad de prueba (keel-core/gen/identity-provisioning.js): quién consume
  // test-credentials.env y qué skill documenta los clientes de prueba.
  identity: { harness: 'test/integration/support/flow.ts', skill: 'keel-nest-keycloak' },
  historyTable: MIGRATIONS_TABLE,
  strayProcess: {
    comment: `# Procesos ajenos a la validación que comparten esta infraestructura. Un
# 'npm run start' (o 'start:dev') olvidado escribe en la misma BD que la suite y
# contamina la matriz con datos que ningún escenario creó — un fallo que parece de
# negocio y no lo es. Es aviso, no error: el puerto ocupado no impide correr las
# pruebas (la suite escucha en un puerto libre), solo explica resultados imposibles.`,
    hint: "¿un 'npm run start' de otra sesión?",
    close: 'ciérralo antes de ejecutar npm run test:integration.'
  },
  schemaRebuiltBy: {
    relational: 'lo vuelve a crear TypeORM al arrancar la app (synchronize del perfil local)',
    document: 'las colecciones nacen al escribir y los índices los recrea la app al arrancar'
  },
  schemaHelp: {
    relational: `# --schema es para después de regenerar entidades: el 'synchronize' de TypeORM no
# sabe RENOMBRAR (borra la columna y crea otra) y falla al añadir un NOT NULL sobre
# una tabla con filas, así que el esquema queda a medias y el arranque muere con un
# error del motor que no apunta a la entidad. Recrear el esquema es la salida; el
# volumen no se toca.`,
    document: `# --schema borra la base entera. Es para después de cambiar un índice de forma:
# Mongo rechaza recrear el mismo nombre con otras claves, así que el arranque falla.
# Vaciar los datos no lo arregla —el índice viejo sigue ahí—; borrar la base sí. El
# volumen no se toca.`
  },
  httpStubsReadme
};

export function generate(model) {
  // La infraestructura de prueba y, con capa security sobre un token, el realm del proveedor de
  // identidad: el mismo que prueba el servidor de keel-spring del mismo diseño.
  return [...infraFiles(model, NEST_INFRA), ...identityProvisioningFiles(model, NEST_INFRA)];
}

// Lo emite infra-scripts.js solo con integraciones salientes, que keel-nest genera desde el
// incremento 11: queda escrito para entonces, con el arnés de este proyecto.
function httpStubsReadme(service) {
  return `# Stubs del proveedor de prueba (WireMock)

Los servicios de los que depende \`${service.name}\` por HTTP no están en \`infra/\`: en su
lugar hay un WireMock en \`http://localhost:8090\` (\`http://wiremock:8080\` desde otro
contenedor), y las \`base-url\` de los clientes de \`http-clients\` apuntan ahí en local.

**Lo normal es no tocar este directorio.** Cada prueba de integración programa lo que
necesita desde el arnés (\`test/integration/support/flow.ts\`) y lo verifica ahí mismo:
así el escenario se lee entero en un sitio, y \`infra/reset-db.sh\` lo deja limpio entre
flujos. Un mapping en un archivo es estado global compartido por toda la suite.

Un \`mappings/*.json\` solo se justifica para lo que no pertenece a ningún flujo.
Formato y opciones: <https://wiremock.org/docs/stubbing/>.
`;
}
