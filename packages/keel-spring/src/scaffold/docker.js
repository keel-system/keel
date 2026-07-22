// Infraestructura de prueba del proyecto generado, agrupada bajo `infra/`:
// docker-compose.yaml con solo los contenedores que el diseño + stack elegido
// necesitan (BD, broker, Keycloak/Cognito, cache, storage) más un contenedor
// `devtools` con las CLIs para validarlos y el script `validate-infra.sh`.
// Se genera únicamente si hay al menos un servicio; se ensambla como objeto JS
// y se serializa con yaml (mismo patrón de merge del proyecto de referencia).

import YAML from 'yaml';
import { DATABASES, BROKERS, AUTH, CACHES, STORAGE, selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools, devtoolsService, dockerfileDevtools, validateInfraScript, resetDbScript } from './devtools.js';

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
    const storageServices = STORAGE[stack.storage].composeServices();
    Object.assign(services, storageServices);
    if ('minio' in storageServices) volumes['minio-data'] = null;
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
    files.push({ path: 'infra/validate-infra.sh', content: validateInfraScript(selected, service) });
  }
  // Reset de datos entre flujos: solo si la BD elegida declara cliResetCmd.
  const reset = resetDbScript(selected, service);
  if (reset) {
    files.push({ path: 'infra/reset-db.sh', content: reset });
  }

  return files;
}
