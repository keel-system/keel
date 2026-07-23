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
  if (infra.length > 0) lines.push('docker compose -f infra/docker-compose.yaml up -d   # infraestructura de prueba');
  lines.push('./gradlew bootRun', './gradlew build -x test', '```', '', `Requiere Java ${JAVA_VERSION} (el wrapper de Gradle va incluido; en Windows usa \`gradlew.bat\`).`, '');

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
    lines.push('El perfil `test` usa H2 en memoria (no necesita contenedores): queda listo para la suite de pruebas unitarias, que es un proceso posterior a la validación funcional.', '');
  }

  if (infra.length > 0) {
    lines.push(
      '## Validación de infraestructura',
      '',
      'Todo lo relativo a la infraestructura de prueba vive en `infra/`. Antes de ejercitar',
      'los escenarios funcionales, levántala y sondéala (con podman, exporta `CONTAINER_RUNTIME=podman`):',
      '',
      '```bash',
      'docker compose -f infra/docker-compose.yaml up -d',
      'bash infra/validate-infra.sh   # un check por tecnología; sale != 0 si algo falla',
      '```',
      '',
      'Si la BD del stack lo permite, `infra/reset-db.sh` vacía los datos (esquema intacto):',
      'se ejecuta antes de cada flujo `FL-*` de la validación funcional, cuyos Given asumen BD limpia.',
      ''
    );
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
    'controllers `V1` con springdoc y `ApiExceptionHandler`), más configuración por perfiles y la infraestructura de prueba en `infra/`.',
    'El código que depende de la infraestructura elegida (publishers/listeners del broker, adaptador de storage)',
    'lo escribe el agente siguiendo las skills por tecnología `.claude/skills/keel-spring-<tech>/` (instaladas solo las del stack de `keel-stack.json`).',
    'El punto de entrada para el agente es `.claude/CLAUDE.md` (junto con `.claude/architecture.md` y',
    '`.claude/constitution.md`); el repo es autosuficiente: incluye el diseño (snapshot en `specs/`), la skill y las',
    'guías del stack en `.claude/`.',
    '',
    'Swagger UI (local/develop): http://localhost:8080/swagger-ui.html — deshabilitado en production.',
    '',
    'Pendiente para el agente (`/keel-generate-spring`):',
    '',
    '- Implementar los `handle(...)` con `// TODO (agente)` en `application/usecases/` (reglas, precondiciones, errores).',
    '- Proteger los invariantes marcados con `// TODO invariante` en `domain/aggregate/`.',
    '- Validación funcional: ejecutar los escenarios `FL-*` de `specs/validation-scenarios.md` contra el servidor real hasta el 100% en OK (las pruebas unitarias son un proceso posterior, fuera de la generación).'
  );

  const pendingLayers = [];
  if (layersPresent.security && stack.auth === 'keycloak') {
    pendingLayers.push('- `security`: el `SecurityFilterChain` ya está generado; crea el realm en el Keycloak de prueba (http://localhost:8180, admin/admin).');
  }
  if (layersPresent.messaging) {
    pendingLayers.push('- `messaging`: haz `raise(...)` de cada evento en el método de negocio del agregado (la traducción a evento de integración y la entrega ya están generadas) e implementa el envío al broker — `OutboxDispatcher` o `<Evento>Publisher` según la `reliability` — y los `<Evento>Listener` de las suscripciones, según la skill `.claude/skills/keel-spring-<broker>/`.');
  }
  if (layersPresent.storage) {
    pendingLayers.push('- `storage`: implementa el adaptador de `FileStorage` (bean del cliente + upload/download/delete/signedUrl) según la skill `.claude/skills/keel-spring-s3/`.');
  }
  if (layersPresent.httpClients) {
    pendingLayers.push('- `http-clients`: puerto + adaptador RestClient + mapper ACL ya generados; completa los `*Fallback` (y el tipado records/mapper solo en llamadas declaradas en prosa).');
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
