// Contexto del proyecto generado (CLAUDE.md / AGENTS.md según el harness): punto
// de entrada para el agente que completa la generación arrancando en contexto
// limpio con cwd en el propio proyecto (o en un clon del repo, sin el workspace
// Keel). Especializado por servicio: solo las capas declaradas del diseño y las
// skills por tecnología del stack.

import { emitHarnessFiles } from 'keel-core';
import { packageVersion, SKILL } from '../lib/assets.js';
import { selectedInfra } from '../lib/stack-catalog.js';
import { describeStack } from '../lib/stack-config.js';
import { needsDevtools } from './devtools.js';
import { DOCS_DIR, stackSkills } from './generator-docs.js';

const SKILL_HINTS = {
  'keel-spring-database': 'tuning de datasource/Hikari, particularidades del dialecto y validación de la BD (el código JPA ya lo genera build)',
  'keel-spring-mongodb': 'índices, transacciones sobre replica set, tuning del driver y lecturas compuestas ($lookup) — el código documental ya lo genera build',
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
  const brokerRef = layersPresent.messaging && stack.broker ? `{{keel:skills}}/keel-spring-${stack.broker}/SKILL.md` : null;

  const artifacts = [
    ['service.keel.yaml', 'manifiesto: nombre, versión, DSL y capas declaradas'],
    ['domain.keel.yaml', 'entidades, agregados, tipos, invariantes y lifecycle'],
    ['use-cases.keel.yaml', 'operaciones (commands/queries), precondiciones, reglas y errores']
  ];
  if (layersPresent.api) artifacts.push(['api.keel.yaml', 'endpoints, basePath y paginación']);
  if (layersPresent.security) artifacts.push(['security.keel.yaml', 'autenticación, roles, permisos y reglas de acceso']);
  if (layersPresent.messaging) artifacts.push(['messaging.keel.yaml', 'eventos publicados y suscripciones']);
  if (layersPresent.httpClients) artifacts.push(['http-clients.keel.yaml', 'clientes HTTP salientes y su resiliencia']);
  if (layersPresent.dependencies) artifacts.push(['dependencies.keel.yaml', 'servidores de los que depende y cómo lee su dato']);
  if (layersPresent.storage) artifacts.push(['storage.keel.yaml', 'buckets de archivos y sus restricciones']);
  if (layersPresent.persistence) artifacts.push(['persistence.keel.yaml', 'mapeo a persistencia, claves naturales e índices']);
  artifacts.push(['validation-scenarios.md', 'escenarios FL-* Given/When/Then que cierran el diseño']);

  // Proceso por capas en el orden de la skill: solo las capas declaradas.
  const steps = [
    '**application** (`specs/use-cases.keel.yaml`): implementa cada `handle(...)` marcado `// TODO (agente)` en ' +
      '`application/usecases/`. Usa el **puerto** de `domain/repository` y el `ApplicationMapper`, nunca las clases `Jpa`. ' +
      'Los handlers llevan `@ApplicationComponent` (no añadas `@Component` ni `@Transactional`: la transacción la abre el ' +
      '`UseCaseMediator`). Implementa `preconditions` y `rules` en el orden del artefacto lanzando los errores de `domain/errors`' +
      (stack.cache
        ? '; las políticas `cache` se anotan sobre los adaptadores con las constantes de `CacheConfig` (ya generado), ' +
          'según la skill `{{keel:skills}}/keel-spring-redis/SKILL.md`'
        : '') +
      '.',
    '**domain** (`specs/domain.keel.yaml`): siguiendo `{{keel:docs}}/conventions/domain-modeling.md`, escribe el factory de creación, ' +
      'los métodos semánticos de cada transición del `lifecycle` y la guarda de cada `// TODO invariante` en `domain/aggregate`; ' +
      'deriva los campos `computed` marcados `// TODO computed`. El agregado sale sin setters: la mutación va por métodos de ' +
      'negocio. El dominio es puro: nada de JPA aquí.'
  ];
  if (layersPresent.api) {
    steps.push(
      '**api** (`specs/api.keel.yaml`): controllers, DTOs y `ApiExceptionHandler` ya generados. Atiende las rutas marcadas ' +
        '`// TODO: revisar ruta` y, al cerrar el código, cruza cada endpoint con su firma: un `@PathVariable` por cada ' +
        '`{segmento}`, cuerpo solo en POST/PUT/PATCH y el `successStatus` declarado. Un desajuste es defecto del scaffolding: ' +
        'repórtalo, no lo compenses cambiando el contrato.'
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
      '**messaging** (`specs/messaging.keel.yaml`): los eventos los emite el **agregado** con `raise(<Evento>Event.of(...))` en su ' +
        'método de negocio (build dejó el buffer y un TODO por evento); el adaptador de repositorio los drena al persistir y el ' +
        '`<Servicio>DomainEventBridge` los traduce a evento de integración y los entrega. Tú, siguiendo la skill ' +
        `\`${brokerRef}\`, implementas solo el envío al broker (\`OutboxDispatcher\` con \`reliability: outbox\`, ` +
        '`<Evento>Publisher` con `best-effort` — sustituye y elimina su stub), la configuración del broker si aplica y el ' +
        '`<Evento>Listener` por suscripción (binding, política `onFailure`, apertura de la correlación con ' +
        '`CorrelationContext.runWith(...)`, deduplicación con el `IdempotencyGuard` ya generado y despacho vía `UseCaseMediator`).'
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
  if (layersPresent.dependencies) {
    steps.push(
      '**dependencies** (`specs/dependencies.keel.yaml`): por cada necesidad `replicated` ya están generados `<Entidad>Projector` ' +
        '(upsert idempotente de la copia local) y `<Entidad>Reader` (lectura con la política `onMiss`). El cableado es ' +
        '`listener → IdempotencyGuard → UseCaseMediator → handler de la operación de proyección → Projector`: **nunca** llames al ' +
        'Projector desde el listener. Completa los `// TODO (agente)`: en el dominio, `<Entidad>.projectionOf(...)` y ' +
        '`<Entidad>.applySnapshot(...)` (el dominio no tiene setters), y en el Reader la hidratación por el puerto del cliente. ' +
        'Las necesidades `on-demand` no generan nada nuevo: se resuelven por el puerto de ' +
        '`domain/clients` que ya existe. Reglas completas en `{{keel:docs}}/conventions/dependencies.md`.'
    );
  }
  if (layersPresent.storage) {
    steps.push(
      '**storage** (`specs/storage.keel.yaml`): siguiendo la skill `{{keel:skills}}/keel-spring-s3/SKILL.md`, implementa el bean del cliente y el ' +
        'adaptador del puerto `FileStorage` (upload devuelve `StoredObject`), con la validación ' +
        'de content-type/tamaño de los `buckets` del diseño. Implementa **exactamente** los métodos que declara el ' +
        'puerto: los de lectura son condicionales a la visibilidad de los buckets.'
    );
  }
  if (layersPresent.persistence && model.persistenceKind === 'document') {
    steps.push(
      '**persistence** (`specs/persistence.keel.yaml`, `default.model: document`): documentos `XxxDocument`, puertos y ' +
        'adaptadores ya generados; respeta `consistency.transactionalBoundary` en los handlers. **El agregado es el ' +
        'documento**: las entidades hijas van anidadas dentro de la raíz y una relación a otro agregado es un `UUID`, nunca ' +
        'un `@DBRef`. Los índices los crea `MongoIndexConfig`, derivado entero del diseño: no hay migraciones que escribir, ' +
        'y el cierre los **verifica** con `bash infra/export-indexes.sh`. ' +
        'Para índices, transacciones, tuning y lecturas compuestas, la skill `{{keel:skills}}/keel-spring-mongodb/SKILL.md`.'
    );
  } else if (layersPresent.persistence) {
    steps.push(
      '**persistence** (`specs/persistence.keel.yaml`): entidades `Jpa`, puertos y adaptadores ya generados; respeta ' +
        '`consistency.transactionalBoundary` en los handlers. El esquema de los ambientes desplegados lo gobiernan las ' +
        'migraciones de `src/main/resources/db/migration/` (production usa `ddl-auto: validate`): el baseline se exporta de ' +
        'las entidades **ya finales** con `bash infra/export-schema.sh` en el cierre, no al empezar. ' +
        'Para migraciones, tuning del datasource/Hikari y particularidades del dialecto, la skill `{{keel:skills}}/keel-spring-database/SKILL.md`.'
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
    // Enrutado por audiencia, lo primero: este documento lo cargan tanto el
    // orquestador como los agentes hoja, y sin decir quién es quién un agente
    // acaba leyendo el pipeline de abajo como su propia lista de tareas.
    '> **Quién eres.** Si acabas de invocar `/' + SKILL + '`, eres el **orquestador**: tu proceso está en la',
    '> skill, y este documento es el contexto que pasas a los agentes. Si eres uno de los agentes de',
    '> `{{keel:agents}}/`, manda **tu propio archivo de agente**: aquí tienes el mapa del repo (diseño,',
    '> stack, arquitectura, orden de las capas), no tu lista de tareas — tu alcance y tu criterio de',
    '> terminado son los de tu agente, y **tú no lanzas agentes**.',
    '',
    `Proyecto generado desde el diseño Keel \`${service.name}\` v${service.version} por keel-spring ${packageVersion()} ` +
      '(scaffolding transversal al stack: el proyecto compila y arranca). Lo que queda pendiente es lo que depende de la ' +
      'infraestructura elegida o del negocio: implementaciones de puertos de infraestructura, lógica de negocio e invariantes ' +
      '(repartido entre los agentes; ver § Quién ejecuta esto). ' +
      '**Sin pruebas unitarias**: no las escribas ni ejecutes `./gradlew test` — la suite es un proceso independiente y ' +
      'posterior a que el diseñador valide el servidor; el andamiaje de test que ya está (deps, perfil `test` con H2, ' +
      `\`${service.applicationClass}Tests\`) se deja intacto para esa fase. Los escenarios \`FL-*\` sí se traducen a pruebas de ` +
      'integración en `src/integrationTest/` (caja negra contra el contrato, source set aparte). El criterio de terminado **del ' +
      'pipeline** es la compilación en verde más `./gradlew integrationTest` con el **100%** de los escenarios de ' +
      '`specs/validation-scenarios.md` en OK. ' +
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
    'Reglas inviolables completas en `{{keel:docs}}/constitution.md`. Si un escenario contradice el spec, el hueco es del',
    'diseño: proponlo como cambio a los artefactos, no lo acomodes en el código. Todo identificador nuevo (paquetes,',
    'directorios, archivos, clases, métodos, variables, tablas) va en inglés; comentarios y docs en español.',
    '',
    '## Arquitectura',
    '',
    '`{{keel:docs}}/architecture.md` describe la arquitectura hexagonal + CQRS del proyecto y la función de cada paquete',
    '(`domain`, `application`, `infrastructure`). `{{keel:docs}}/constitution.md` recoge las reglas que esa arquitectura',
    'nunca puede romper (frontera hexagonal, transaccionalidad, contratos públicos, precisión numérica). Léelos antes de tocar código',
    'si no conoces ya la estructura.',
    '',
    '## Stack elegido',
    '',
    `\`keel-stack.json\`: ${describeStack(stack)}. Respétalo; para cambiarlo, borra ese archivo y re-ejecuta`,
    '`keel-spring build --force` desde la raíz del workspace.',
    '',
    '## Conocimiento local',
    '',
    `La skill \`/${SKILL}\` de este proyecto arranca el proceso; \`{{keel:docs}}/conventions/\` trae las convenciones que consultan los agentes de \`{{keel:agents}}/\`, y las guías del stack`,
    'están instaladas como skills propias por tecnología (solo las del stack elegido):',
    '',
    '- `{{keel:docs}}/conventions/mapping.md` — mapeo DSL Keel → código Spring, capa por capa. Síguelo estrictamente.',
    '- `{{keel:docs}}/conventions/project-layout.md` — estructura del proyecto y sus paquetes.',
    '- `{{keel:docs}}/conventions/domain-modeling.md` — cómo se modela el dominio: agregados ricos, invariantes, value objects y',
    '  reparto de la validación entre capas.',
    '- `{{keel:docs}}/conventions/infra-validation.md` — sondeo por tecnología de la infraestructura de prueba.',
    '- `{{keel:docs}}/conventions/integration-tests.md` — cómo se traducen los escenarios `FL-*` a pruebas de integración.',
    ...techSkills.map((name) => `- \`{{keel:skills}}/${name}/SKILL.md\` — ${SKILL_HINTS[name] ?? name}: qué dejó listo build y qué te toca a ti; sus \`references/\` (configuración, implementación, troubleshooting) se leen bajo demanda.`),
    '',
    '## Orden de trabajo: completar el scaffolding, capa por capa',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Verificación — criterio de salida del pipeline',
    '',
    'Lo que hace falta para dar por terminada **la generación**, repartido entre varios agentes. No es',
    'el criterio de ninguno en particular: si eres un agente de `{{keel:agents}}/`, el tuyo está en tu',
    'archivo y suele ser más estrecho que esta lista.',
    '',
    '1. `./gradlew build -x test` en verde: compilación y empaquetado (en Windows `gradlew.bat build -x test`).'
  ];

  if (selected.length > 0) {
    lines.push(
      '2. Infraestructura de prueba (en `infra/`): `docker compose -f infra/docker-compose.yaml up -d` (con podman,',
      '   `CONTAINER_RUNTIME=podman podman compose -f infra/docker-compose.yaml up -d`)' +
        (hasDevtools ? ' y `bash infra/validate-infra.sh` antes de ejercitar escenarios' : '') +
        ' — un fallo de dependencia no debe confundirse con un bug.',
      '3. Escenarios: `./gradlew integrationTest` — los flujos `FL-*` de `specs/validation-scenarios.md`, ya traducidos a',
      '   pruebas de integración en `src/integrationTest/`, contra el servidor real (lo arranca JUnit) y esta infraestructura.',
      '   Reporta la matriz escenario → resultado: la generación solo se da por terminada con el **100%** en OK.'
    );
  } else {
    lines.push(
      '2. Escenarios: `./gradlew integrationTest` — los flujos `FL-*` de `specs/validation-scenarios.md`, ya traducidos a',
      '   pruebas de integración en `src/integrationTest/`, contra el servidor real (lo arranca JUnit).',
      '   Reporta la matriz escenario → resultado: la generación solo se da por terminada con el **100%** en OK.'
    );
  }

  // Arranque del contexto: los escenarios corren con @ActiveProfiles("local")
  // contra infraestructura real, así que no ven lo que se rompe en el perfil
  // `test` (H2, sin contenedores, sin red) — un adaptador que conecta al
  // construirse, o un bean que espera config que ese perfil no declara.
  const contextStep = selected.length > 0 ? 4 : 3;
  lines.push(
    `${contextStep}. Arranque del contexto: \`./gradlew test\` — en este punto la suite unitaria es solo \`contextLoads()\`, y es lo`,
    '   único que comprueba que **todos los beans arrancan bajo el perfil `test`** que genera `build`. No se escriben',
    '   pruebas unitarias nuevas aquí: la suite unitaria es un proceso posterior.'
  );

  // Gate de migraciones: se comprueba al final, cuando las entidades ya no cambian.
  if (layersPresent.persistence) {
    const step = contextStep + 1;
    lines.push(
      `${step}. Migraciones: con las entidades ya finales, \`bash infra/export-schema.sh\`, revisa el DDL y cópialo como`,
      '   `src/main/resources/db/migration/V1__baseline_schema.sql`; verifícalo con el **doble check estático** (`diff`',
      '   contra el DDL exportado + contraste con las entidades `Jpa` y el diseño). Sin baseline el servicio no puede',
      '   desplegarse: en `production` Hibernate no crea nada. La prueba en vivo —arrancar con `PROFILE=local,migrations`',
      '   sobre una BD **sin esquema**— es una verificación **manual del diseñador**, posterior a la generación: exige',
      '   borrar el volumen de la BD, que es la misma sobre la que corren los escenarios.'
    );
  }

  // Descriptivo a propósito ("quién ejecuta qué"), no imperativo: este párrafo lo
  // lee también cada agente hoja, y redactado como procedimiento se convierte en
  // su receta para lanzar agentes — incluido él mismo.
  lines.push(
    '',
    '## Quién ejecuta esto',
    '',
    `Lo reparte la skill \`/${SKILL}\`, **único orquestador** del pipeline: los agentes de \`{{keel:agents}}/\` son`,
    '**hojas** y ninguno invoca a otro (su frontmatter no se lo permite). El reparto es: `keel-spring-code` (código, sin',
    'tests) en paralelo con `keel-spring-infra` (infraestructura arriba y sana) y con `keel-spring-tests` (escenarios',
    '`FL-*` → `src/integrationTest/`, en caja negra). Con los tres en OK, la skill ejecuta `bash infra/score-scenarios.sh`,',
    'que corre la suite y compone la matriz desde el XML de JUnit: eso es determinista y no gasta un agente. Solo si la',
    'matriz trae algo en rojo se invoca `keel-spring-validate`, que **solo arbitra** de quién es la culpa de cada fallo.',
    'Al final, `keel-spring-quality` (pase de calidad no-conductual con la compilación en verde' +
      (layersPresent.persistence ? ', más el baseline de migraciones del punto 4' : '') +
      ', y los escenarios al 100% como no-regresión propia). El pipeline completo —fases, gating y handoffs— está en',
    '`{{keel:docs}}/orchestration.md`.'
  );

  lines.push(
    '',
    'El cierre —commit en este repo (`Generado desde specs/' + service.name + ' v' + service.version + '`) y el `README.md`',
    'con las decisiones tomadas y los huecos del diseño detectados— lo hace **quien orquesta**, con todo lo anterior en verde.',
    ''
  );

  // Un archivo por harness, cada uno con sus rutas resueltas. Duplicar no cuesta
  // aquí: esto lo regenera `build` en cada ejecución y nadie lo edita a mano —
  // al contrario que el contexto del workspace, que sí es del equipo.
  return emitHarnessFiles({ context: { content: lines.join('\n') }, extraTokens: { docs: DOCS_DIR } });
}
