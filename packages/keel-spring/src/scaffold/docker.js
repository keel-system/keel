// Infraestructura de prueba del proyecto generado, agrupada bajo `infra/`:
// docker-compose.yaml con solo los contenedores que el diseño + stack elegido
// necesitan (BD, broker, Keycloak/Cognito, cache, storage) más un contenedor
// `devtools` con las CLIs para validarlos y el script `validate-infra.sh`.
// Se genera únicamente si hay al menos un servicio; se ensambla como objeto JS
// y se serializa con yaml (mismo patrón de merge del proyecto de referencia).

import YAML from 'yaml';
import { DATABASES, BROKERS, AUTH, CACHES, STORAGE, HTTP_STUB, selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools, devtoolsService, dockerfileDevtools, validateInfraScript, resetDbScript } from './devtools.js';
import { messagingProvisioning } from './messaging-provisioning.js';

export function generate(model) {
  const { service, layersPresent, stack } = model;
  const network = `keel-${service.name}`;
  const services = {};
  const volumes = {};

  if (layersPresent.persistence && stack.database) {
    const db = DATABASES[stack.database];
    // h2 y otras opciones en memoria no levantan contenedor (composeService null).
    if (db?.composeService) {
      services.db = { container_name: `${service.name}-db`, ...db.composeService(service.name.replace(/-/g, '_')) };
      volumes['db-data'] = null;
    }
  }
  if (layersPresent.messaging && stack.broker) {
    Object.assign(services, BROKERS[stack.broker].composeServices());
  }
  if (stack.auth && stack.auth !== 'none') {
    Object.assign(services, AUTH[stack.auth].composeServices());
  }
  if (stack.cache) {
    Object.assign(services, CACHES[stack.cache].composeServices());
  }
  if (layersPresent.storage && stack.storage) {
    const storageServices = STORAGE[stack.storage].composeServices(model);
    Object.assign(services, storageServices);
    if ('minio' in storageServices) volumes['minio-data'] = null;
  }

  // Proveedor de prueba de las integraciones salientes: sin él, un flujo que
  // llama a otro servicio no se puede puntuar (ver HTTP_STUB en stack-catalog).
  if (layersPresent.httpClients) {
    Object.assign(services, HTTP_STUB.composeServices());
  }

  if (Object.keys(services).length === 0) return [];

  // Toolbox de validación: se añade si alguna CLI del stack vive en devtools.
  const selected = selectedInfra(model);
  if (needsDevtools(selected)) {
    services.devtools = devtoolsService(selected, service);
  }

  for (const definition of Object.values(services)) {
    definition.networks = [network];
  }

  const compose = {
    name: service.projectName,
    services,
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    networks: { [network]: { driver: 'bridge' } }
  };

  const header = '# Infraestructura de prueba generada por keel-spring (según keel-stack.json).\n';
  const files = [{ path: 'infra/docker-compose.yaml', content: header + YAML.stringify(compose, { nullStr: '' }) }];

  if (needsDevtools(selected)) {
    files.push({ path: 'infra/docker/Dockerfile.devtools', content: dockerfileDevtools(selected) });
  }
  // El script de validación existe siempre que haya algo que sondear (incluye el
  // caso 'dbcontainer', p. ej. Oracle, que no necesita devtools).
  if (selected.some((s) => s.entry.cliValidateCmd)) {
    files.push({ path: 'infra/validate-infra.sh', content: validateInfraScript(selected, service, model) });
  }
  // Reset de estado entre flujos: datos de la BD, claves de la caché y destinos
  // de mensajería declarados (el modelo aporta los canales a purgar).
  const reset = resetDbScript(selected, service, model);
  if (reset) {
    files.push({ path: 'infra/reset-db.sh', content: reset });
  }
  // El montaje del stub necesita el directorio: si no existe, el runtime lo crea
  // como root y el contenedor no puede leerlo (podman rootless, sobre todo).
  if (layersPresent.httpClients) {
    files.push({ path: 'infra/http-stubs/mappings/.gitkeep', content: '' });
    files.push({ path: 'infra/http-stubs/README.md', content: httpStubsReadme(service) });
  }
  // Topología de mensajería: solo los brokers que no la autocrean (hoy, snssqs).
  // Sin ella la app arranca apuntando a un topic que no existe.
  const messagingTopology = messagingProvisioning(model);
  if (messagingTopology) {
    files.push(messagingTopology);
  }

  return files;
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
