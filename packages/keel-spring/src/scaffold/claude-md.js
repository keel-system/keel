// CLAUDE.md contextual del proyecto generado: punto de entrada para el agente
// que completa la generación arrancando en contexto limpio con cwd en el propio
// proyecto (o en un clon del repo, sin el workspace Keel). Especializado por
// servicio: solo las capas declaradas del diseño y las skills por tecnología del stack.

import { packageVersion, SKILL } from '../lib/assets.js';
import { selectedInfra } from '../lib/stack-catalog.js';
import { describeStack } from '../lib/stack-config.js';
import { needsDevtools } from './devtools.js';
import { stackSkills } from './generator-docs.js';

const SKILL_HINTS = {
  'keel-spring-database': 'tuning de datasource/Hikari, particularidades del dialecto y validación de la BD (el código JPA ya lo genera build)',
  'keel-spring-kafka': 'broker Apache Kafka',
  'keel-spring-rabbitmq': 'broker RabbitMQ',
  'keel-spring-snssqs': 'broker Amazon SNS/SQS',
  'keel-spring-s3': 'storage S3/MinIO (mismo SDK)',
  'keel-spring-redis': 'cache Redis/Valkey',
  'keel-spring-keycloak': 'auth Keycloak',
  'keel-spring-cognito': 'auth Amazon Cognito'
};

export function generate(model) {
  const { service, layersPresent, stack } = model;
  const techSkills = stackSkills(model);
  const selected = selectedInfra(model);
  const hasDevtools = needsDevtools(selected);
  const brokerRef = layersPresent.messaging && stack.broker ? `.claude/skills/keel-spring-${stack.broker}/SKILL.md` : null;

  const artifacts = [
    ['service.keel.yaml', 'manifiesto: nombre, versión, DSL y capas declaradas'],
    ['domain.keel.yaml', 'entidades, agregados, tipos, invariantes y lifecycle'],
    ['use-cases.keel.yaml', 'operaciones (commands/queries), precondiciones, reglas y errores']
  ];
  if (layersPresent.api) artifacts.push(['api.keel.yaml', 'endpoints, basePath y paginación']);
  if (layersPresent.security) artifacts.push(['security.keel.yaml', 'autenticación, roles, permisos y reglas de acceso']);
  if (layersPresent.messaging) artifacts.push(['messaging.keel.yaml', 'eventos publicados y suscripciones']);
  if (layersPresent.httpClients) artifacts.push(['http-clients.keel.yaml', 'clientes HTTP salientes y su resiliencia']);
  if (layersPresent.storage) artifacts.push(['storage.keel.yaml', 'buckets de archivos y sus restricciones']);
  if (layersPresent.persistence) artifacts.push(['persistence.keel.yaml', 'mapeo a persistencia, claves naturales e índices']);
  artifacts.push(['validation-scenarios.md', 'escenarios FL-* Given/When/Then que cierran el diseño']);

  // Proceso por capas en el orden de la skill: solo las capas declaradas.
  const steps = [
    '**application** (`specs/use-cases.keel.yaml`): implementa cada `handle(...)` marcado `// TODO (agente)` en ' +
      '`application/usecases/`. Usa el **puerto** de `domain/repository` y el `ApplicationMapper`, nunca las clases `Jpa`. ' +
      'Los handlers llevan `@ApplicationComponent` (no añadas `@Component` ni `@Transactional`: la transacción la abre el ' +
      '`UseCaseMediator`). Implementa `preconditions` y `rules` en el orden del artefacto lanzando los errores de `domain/errors`' +
      (stack.cache ? '; las políticas `cache` según la skill `.claude/skills/keel-spring-redis/SKILL.md`' : '') +
      '.',
    '**domain** (`specs/domain.keel.yaml`): protege cada `// TODO invariante` con métodos de dominio en `domain/aggregate`; ' +
      'deriva los campos `computed` marcados `// TODO computed`. El dominio es puro: nada de JPA aquí.'
  ];
  if (layersPresent.api) {
    steps.push(
      '**api** (`specs/api.keel.yaml`): controllers, DTOs y `ApiExceptionHandler` ya generados; revisa solo las rutas marcadas ' +
        '`// TODO: revisar ruta`.'
    );
  }
  if (layersPresent.security) {
    steps.push(
      '**security** (`specs/security.keel.yaml`): ya generado (`SecurityFilterChain`, resource server o filtro api-key, ' +
        '`JwtAuthConverter`). No lo reescribas; interviene solo si el diseño exige lógica que el mapeo de claims no cubre.'
    );
  }
  if (layersPresent.messaging) {
    steps.push(
      `**messaging** (\`specs/messaging.keel.yaml\`): siguiendo la skill \`${brokerRef}\`, implementa cada publisher real (sustituye y ` +
        'elimina su `<Evento>PublisherStub`, con la `reliability` declarada), la configuración del broker si aplica y el ' +
        '`<Evento>Listener` por suscripción (binding, política `onFailure`, despacho vía `UseCaseMediator`).'
    );
  }
  if (layersPresent.httpClients) {
    steps.push(
      '**http-clients** (`specs/http-clients.keel.yaml`): puerto `<Cliente>Client` en `domain/clients` y adaptador RestClient + ' +
        'resilience4j + mapper ACL en `infrastructure/http`, ya generados (con auth saliente si el diseño la declara). Completa los ' +
        '`*Fallback` marcados `// TODO (agente)`; solo si una llamada va en prosa (sin `request`/`response` estructurados), tipa además ' +
        'sus records wire/`<Llamada>Result` y el mapeo del `<Cliente>Mapper`. Consume el cliente siempre por su puerto de `domain/clients`.'
    );
  }
  if (layersPresent.storage) {
    steps.push(
      '**storage** (`specs/storage.keel.yaml`): siguiendo la skill `.claude/skills/keel-spring-s3/SKILL.md`, implementa el bean del cliente y el ' +
        'adaptador del puerto `FileStorage` (upload/download/delete/signedUrl), con la validación de content-type/tamaño ' +
        'de los `buckets` del diseño.'
    );
  }
  if (layersPresent.persistence) {
    steps.push(
      '**persistence** (`specs/persistence.keel.yaml`): entidades `Jpa`, puertos y adaptadores ya generados; respeta ' +
        '`consistency.transactionalBoundary` en los handlers y decide el esquema definitivo (production usa `ddl-auto: validate`). ' +
        'Para tuning del datasource/Hikari y particularidades del dialecto, la skill `.claude/skills/keel-spring-database/SKILL.md`.'
    );
  }
  steps.push(
    '**Configuración por ambiente**: cualquier configuración nueva va en `src/main/resources/parameters/<perfil>/` respetando ' +
      'el gradiente (local literal, develop `${VAR:default}`, production `${VAR}` sin default); nunca credenciales reales.'
  );

  const lines = [
    `# ${service.projectName} — contexto para el agente`,
    '',
    service.description,
    '',
    `Proyecto generado desde el diseño Keel \`${service.name}\` v${service.version} por keel-spring ${packageVersion()} ` +
      '(scaffolding transversal al stack: el proyecto compila y arranca). Tu trabajo es lo que depende de la infraestructura ' +
      'elegida o del negocio: implementaciones de puertos de infraestructura, lógica de negocio e invariantes. ' +
      '**Sin pruebas unitarias**: no las escribas ni ejecutes `./gradlew test` — la suite es un proceso independiente y ' +
      'posterior a que el diseñador valide el servidor; el andamiaje de test que ya está (deps, perfil `test` con H2, ' +
      `\`${service.applicationClass}Tests\`) se deja intacto para esa fase. El criterio de terminado es la compilación en ` +
      'verde más el **100%** de los escenarios de `specs/validation-scenarios.md`. ' +
      'Este repo es **autosuficiente**: diseño, skill, convenciones y guías del stack van incluidos. ' +
      'Localiza los puntos de trabajo con `grep -rn "TODO" src`.',
    '',
    '## Fuente de verdad del diseño',
    '',
    'Los artefactos Keel están en `specs/` (snapshot que `keel-spring build` refresca en cada ejecución). Si trabajas dentro',
    `del workspace Keel que generó este proyecto, el canónico es \`../../specs/${service.name}/\`: ante cualquier duda o cambio`,
    'de diseño, manda el del workspace y se re-ejecuta el build.',
    '',
    '| Artefacto | Contenido |',
    '|---|---|',
    ...artifacts.map(([file, hint]) => `| \`specs/${file}\` | ${hint} |`),
    '',
    'Reglas inviolables completas en `.claude/constitution.md`. Si un escenario contradice el spec, el hueco es del',
    'diseño: proponlo como cambio a los artefactos, no lo acomodes en el código. Todo identificador nuevo (paquetes,',
    'directorios, archivos, clases, métodos, variables, tablas) va en inglés; comentarios y docs en español.',
    '',
    '## Arquitectura',
    '',
    '`.claude/architecture.md` describe la arquitectura hexagonal + CQRS del proyecto y la función de cada paquete',
    '(`domain`, `application`, `infrastructure`). `.claude/constitution.md` recoge las reglas que esa arquitectura',
    'nunca puede romper (frontera hexagonal, transaccionalidad, contratos públicos). Léelos antes de tocar código',
    'si no conoces ya la estructura.',
    '',
    '## Stack elegido',
    '',
    `\`keel-stack.json\`: ${describeStack(stack)}. Respétalo; para cambiarlo, borra ese archivo y re-ejecuta`,
    '`keel-spring build --force` desde la raíz del workspace.',
    '',
    '## Conocimiento local',
    '',
    `La skill \`/${SKILL}\` de este proyecto arranca el proceso; \`.claude/conventions/\` trae las convenciones que consultan los subagentes, y las guías del stack`,
    'están instaladas como skills propias por tecnología (solo las del stack elegido):',
    '',
    '- `.claude/conventions/mapping.md` — mapeo DSL Keel → código Spring, capa por capa. Síguelo estrictamente.',
    '- `.claude/conventions/project-layout.md` — estructura del proyecto y sus paquetes.',
    '- `.claude/conventions/infra-validation.md` — sondeo por tecnología de la infraestructura de prueba.',
    ...techSkills.map((name) => `- \`.claude/skills/${name}/SKILL.md\` — ${SKILL_HINTS[name] ?? name}: qué dejó listo build y qué te toca a ti; sus \`references/\` (configuración, implementación, troubleshooting) se leen bajo demanda.`),
    '',
    '## Proceso: completar el scaffolding, capa por capa',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Verificación (obligatoria antes de dar por terminado)',
    '',
    '1. `./gradlew build -x test` en verde: compilación y empaquetado (en Windows `gradlew.bat build -x test`).'
  ];

  if (selected.length > 0) {
    lines.push(
      '2. Infraestructura de prueba (en `infra/`): `docker compose -f infra/docker-compose.yaml up -d` (con podman,',
      '   `CONTAINER_RUNTIME=podman podman compose -f infra/docker-compose.yaml up -d`)' +
        (hasDevtools ? ' y `bash infra/validate-infra.sh` antes de ejercitar escenarios' : '') +
        ' — un fallo de dependencia no debe confundirse con un bug.',
      '3. Servidor real: `./gradlew bootRun` y ejecuta cada escenario de `specs/validation-scenarios.md` con llamadas',
      '   HTTP reales verificando el Then completo (status, headers y efectos observables). Reporta la matriz escenario → resultado:',
      '   la generación solo se da por terminada con el **100%** de los escenarios en OK.'
    );
  } else {
    lines.push(
      '2. Servidor real: `./gradlew bootRun` y ejecuta cada escenario de `specs/validation-scenarios.md` con llamadas',
      '   HTTP reales verificando el Then completo (status, headers y efectos observables). Reporta la matriz escenario → resultado:',
      '   la generación solo se da por terminada con el **100%** de los escenarios en OK.'
    );
  }

  lines.push(
    '',
    `La skill \`/${SKILL}\` de este proyecto orquesta este flujo con los subagentes de \`.claude/agents/\`:`,
    '`keel-spring-code` (código, sin tests) en paralelo con `keel-spring-infra` (infraestructura arriba y sana), después',
    '`keel-spring-validate` (escenarios contra el servidor real, reseteando datos entre flujos) y al final',
    '`keel-spring-quality` (pase de calidad no-conductual con la compilación en verde), seguido de una re-validación',
    'de los escenarios antes del commit.'
  );

  lines.push(
    '',
    'Al cerrar: commit en este repo (`Generado desde specs/' + service.name + ' v' + service.version + '`) y añade al `README.md`',
    'las decisiones tomadas y cualquier hueco del diseño detectado.',
    ''
  );

  return [{ path: '.claude/CLAUDE.md', content: lines.join('\n') }];
}
