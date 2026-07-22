// README.md del servicio generado: procedencia, cómo ejecutarlo, infraestructura
// de prueba y qué queda pendiente para el agente (/keel-generate-spring).

import { JAVA_VERSION, packageVersion } from '../lib/assets.js';
import { selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools } from './devtools.js';

export function generate(model) {
  const { service, layersPresent, stack } = model;
  const selected = selectedInfra(model);
  const infra = infraRows(selected);
  const hasDevtools = needsDevtools(selected);

  const lines = [
    `# ${service.projectName}`,
    '',
    service.description,
    '',
    `Generado desde \`specs/${service.name}\` v${service.version} por keel-spring ${packageVersion()} (scaffolding transversal al stack).`,
    '',
    '## Ejecutar',
    '',
    '```bash'
  ];
  if (infra.length > 0) lines.push('docker compose up -d   # infraestructura de prueba');
  lines.push('./gradlew bootRun', './gradlew test', '```', '', `Requiere Java ${JAVA_VERSION} (el wrapper de Gradle va incluido; en Windows usa \`gradlew.bat\`).`, '');

  if (infra.length > 0) {
    lines.push(
      '## Infraestructura de prueba',
      '',
      'Elegida en el cuestionario de `keel-spring build` y persistida en `keel-stack.json`',
      '(bórralo y re-ejecuta el build con `--force` para cambiarla).',
      '',
      '| Servicio | Imagen | Puerto |',
      '|---|---|---|',
      ...infra.map(({ name, image, port }) => `| ${name} | ${image} | ${port} |`)
    );
    if (hasDevtools) {
      lines.push(`| devtools (validación) | alpine:3.20 (build local) | — (interno) |`);
    }
    lines.push('');
  }
  if (layersPresent.persistence) {
    lines.push('Los tests usan H2 en memoria (no necesitan contenedores).', '');
  }

  if (infra.length > 0) {
    lines.push(
      '## Validación de infraestructura',
      '',
      'Antes de ejercitar los escenarios funcionales, levanta y sondea la infraestructura:',
      '',
      '```bash',
      'docker compose up -d'
    );
    if (hasDevtools) {
      lines.push(
        'chmod +x validate-infra.sh   # una vez (en Windows: bash validate-infra.sh)',
        './validate-infra.sh          # un check por tecnología; sale != 0 si algo falla'
      );
    } else {
      lines.push('bash validate-infra.sh       # un check por tecnología; sale != 0 si algo falla');
    }
    lines.push('```', '');
    if (hasDevtools) {
      lines.push(
        `El contenedor \`${service.name}-devtools\` trae solo las CLIs del stack elegido; sondéalas a mano con`,
        `\`docker exec ${service.name}-devtools <cli> ...\` (p. ej. \`psql\`, \`redis-cli\`, \`kcat\`, \`mc\`, \`aws\`).`,
        ''
      );
    }
  }

  lines.push(
    '## Perfiles y ambientes',
    '',
    'El perfil activo se elige con la env var `PROFILE` (default `local`): `local`, `develop`, `production` y `test`.',
    'Cada `application-<perfil>.yaml` importa sus fragmentos de `src/main/resources/parameters/<perfil>/`,',
    'con gradiente de externalización: local usa valores literales (los del docker-compose), develop env vars',
    'con default (`${VAR:default}`) y production env vars obligatorias sin default (`${VAR}`).',
    '',
    '```bash',
    'PROFILE=production DB_URL=... DB_USERNAME=... DB_PASSWORD=... java -jar build/libs/*.jar',
    '```',
    '',
    '## Qué genera el scaffolding y qué completa el agente',
    '',
    'El scaffolding (transversal al stack, re-ejecutable con `keel-spring build`) produce la arquitectura hexagonal + CQRS',
    'del prototipo de referencia, en un único microservicio (sin paquete shared ni Spring Modulith): dominio puro',
    '(`domain/aggregate|entity|valueobject|enums|errors|events` + puertos en `domain/repository`), capa application',
    '(commands/queries con Bean Validation, handlers stub en `usecases/`, ResponseDtos y mappers), e infraestructura',
    '(entidades `Jpa` con auditoría automática, adaptadores `RepositoryImpl` con mapeo explícito, `UseCaseMediator`',
    'con la frontera transaccional (la capa application no importa Spring: `@ApplicationComponent` propia),',
    '`@LogExceptions` con su aspecto, contratos `EventEnvelope`/`EventMetadata` con puertos `<Evento>Publisher` y stub,',
    'controllers `V1` con springdoc y `ApiExceptionHandler`), más configuración por perfiles y docker-compose de prueba.',
    'El código que depende de la infraestructura elegida (publishers/listeners del broker, adaptador de storage)',
    'lo escribe el agente siguiendo `generators/spring/references/<tech>.md` según `keel-stack.json`.',
    '',
    'Swagger UI (local/develop): http://localhost:8080/swagger-ui.html — deshabilitado en production.',
    '',
    'Pendiente para el agente (`/keel-generate-spring`):',
    '',
    '- Implementar los `handle(...)` con `// TODO (agente)` en `application/usecases/` (reglas, precondiciones, errores).',
    '- Proteger los invariantes marcados con `// TODO invariante` en `domain/aggregate/`.',
    '- Tests: camino feliz + un test por error, invariantes, lifecycle y escenarios FL-* del diseño.'
  );

  const pendingLayers = [];
  if (layersPresent.security && stack.auth === 'keycloak') {
    pendingLayers.push('- `security`: el `SecurityFilterChain` ya está generado; crea el realm en el Keycloak de prueba (http://localhost:8180, admin/admin).');
  }
  if (layersPresent.messaging) {
    pendingLayers.push('- `messaging`: implementa los publishers reales del broker (sustituyendo cada `<Evento>PublisherStub`, con la `reliability` declarada) y los `<Evento>Listener` de las suscripciones, según `references/<broker>.md`.');
  }
  if (layersPresent.storage) {
    pendingLayers.push('- `storage`: implementa el adaptador de `FileStorage` (bean del cliente + upload/download/delete/signedUrl) según `references/s3.md`.');
  }
  if (layersPresent.httpClients) {
    pendingLayers.push('- `http-clients`: los clientes RestClient resilientes ya están generados; tipa cada `<Llamada>Response` y completa los `*Fallback`.');
  }
  if (stack.cache) pendingLayers.push('- `cache`: configurar Spring Cache según las políticas `cache` de use-cases.');
  if (pendingLayers.length > 0) lines.push(...pendingLayers);

  if (model.warnings.length > 0) {
    lines.push('', '## Avisos del scaffolding', '');
    for (const warning of model.warnings) lines.push(`- ${warning}`);
  }

  lines.push('');
  return [{ path: 'README.md', content: lines.join('\n') }];
}

// Filas de la tabla de infraestructura, derivadas del catálogo (misma fuente que
// el docker-compose): cada tecnología elegida que levanta contenedor.
function infraRows(selected) {
  return selected.map(({ entry }) => ({ name: entry.label, image: entry.image, port: entry.port }));
}
