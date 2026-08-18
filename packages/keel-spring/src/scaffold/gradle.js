// build.gradle + settings.gradle + .gitignore + .gitattributes del proyecto
// generado. Dependencias condicionales según las capas declaradas y el stack
// elegido en el cuestionario (keel-stack.json).

import {
  SPRING_BOOT_VERSION,
  JAVA_VERSION,
  SPRINGDOC_VERSION,
  RESILIENCE4J_VERSION,
  JACKSON_NULLABLE_VERSION,
  FLAPDOODLE_SPRING_VERSION
} from '../lib/assets.js';
import { DATABASES, BROKERS, CACHES, STORAGE } from '../lib/stack-catalog.js';
import { usesPartialUpdate } from './services.js';

export function generate(model) {
  const { service, layersPresent, stack } = model;

  const dependencies = [
    "implementation 'org.springframework.boot:spring-boot-starter-web'",
    "implementation 'org.springframework.boot:spring-boot-starter-validation'",
    "implementation 'org.springframework.boot:spring-boot-starter-aop'",
    // Actuator: health con probes liveness/readiness (Kubernetes) + info/metrics.
    // Los health indicators de BD/broker/redis los aportan sus starters.
    "implementation 'org.springframework.boot:spring-boot-starter-actuator'",
    `implementation 'org.springdoc:springdoc-openapi-starter-webmvc-ui:${SPRINGDOC_VERSION}'`
  ];
  if (layersPresent.persistence && model.persistenceKind === 'document') {
    dependencies.push(
      ...(DATABASES[stack.database]?.gradleDependencies ?? []),
      // Mongo embebido para el perfil `test`, análogo de H2: sin contenedor y con
      // el ciclo de vida del contexto. No hay dependencia de migraciones porque no
      // hay esquema que migrar — los índices los crea MongoIndexConfig.
      //
      // El artefacto es `spring3x`, el genérico para Spring Boot 3.x, y no uno de los
      // `spring3Nx`: esos están congelados en la línea de Boot que los nombra
      // (`spring30x` se quedó en 4.11.0) y pedir la versión al día de uno de ellos no
      // resuelve. Es un fallo que no se ve compilando `main` —el arnés sí lo arrastra
      // por el classpath— y que solo caza `npm run compile-check`.
      `testImplementation 'de.flapdoodle.embed:de.flapdoodle.embed.mongo.spring3x:${FLAPDOODLE_SPRING_VERSION}'`
    );
  } else if (layersPresent.persistence) {
    dependencies.push(
      "implementation 'org.springframework.boot:spring-boot-starter-data-jpa'",
      // Publica las estadísticas de Hibernate como métricas del actuator. Es lo que
      // convierte «¿cuántas consultas cuesta esta lectura?» en un dato que un escenario
      // puede afirmar, en vez de una lectura del código: sin él, un N+1 solo se ve
      // revisando, y lo que solo se ve revisando vuelve en la siguiente refactorización.
      // La versión la gobierna el BOM de Boot.
      "implementation 'org.hibernate.orm:hibernate-micrometer'",
      ...(DATABASES[stack.database]?.gradleDependencies ?? []),
      // Migraciones de esquema: motor + módulo del dialecto elegido. Gobiernan el
      // esquema en develop/production (ahí Hibernate solo valida); en local están
      // apagadas mientras se itera con ddl-auto: update.
      ...(DATABASES[stack.database]?.flywayDependencies ?? []),
      "testRuntimeOnly 'com.h2database:h2'"
    );
  }
  if (layersPresent.messaging) {
    dependencies.push(...(BROKERS[stack.broker]?.gradleDependencies ?? []));
  }
  if (layersPresent.security) {
    dependencies.push("implementation 'org.springframework.boot:spring-boot-starter-security'");
    // El resource server JWT solo aplica a protocolos basados en token (oidc/jwt);
    // api-key/none usan filtro propio o quedan abiertos.
    const protocol = model.security?.protocol;
    if (protocol === 'oidc' || protocol === 'jwt') {
      dependencies.push("implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'");
    }
  }
  if (stack.cache) {
    dependencies.push(
      "implementation 'org.springframework.boot:spring-boot-starter-cache'",
      ...(CACHES[stack.cache]?.gradleDependencies ?? [])
    );
  }
  if (layersPresent.storage) {
    dependencies.push(...(STORAGE[stack.storage]?.gradleDependencies ?? []));
  }
  if (layersPresent.httpClients) {
    // RestClient (starter-web) + resilience4j sobre AOP (starter-aop ya presente)
    // para @Retry/@CircuitBreaker de los clientes salientes.
    dependencies.push(`implementation 'io.github.resilience4j:resilience4j-spring-boot3:${RESILIENCE4J_VERSION}'`);
    if (model.httpClients?.some((client) => client.auth?.type === 'oauth2-client-credentials')) {
      dependencies.push("implementation 'org.springframework.boot:spring-boot-starter-oauth2-client'");
    }
  }
  if (usesPartialUpdate(model)) {
    // Tri-estado de las actualizaciones parciales (PATCH): ausente / null / valor.
    dependencies.push(`implementation 'org.openapitools:jackson-databind-nullable:${JACKSON_NULLABLE_VERSION}'`);
  }
  dependencies.push(
    "testImplementation 'org.springframework.boot:spring-boot-starter-test'",
    "testRuntimeOnly 'org.junit.platform:junit-platform-launcher'"
  );

  // El mongod embebido es la base del perfil `test` (el análogo de H2), y el source
  // set `integrationTest` hereda las dependencias de `test`. Con eso en el classpath,
  // su autoconfiguración se activa TAMBIÉN bajo el perfil `local` de las IT y sustituye
  // el MongoDatabaseFactory que debe apuntar al Mongo real de infra/: el contexto ni
  // siquiera arranca (falla instanciando `version`, que solo declara parameters/test).
  // No es simétrico con H2, que se limita a estar en el classpath sin reclamar la
  // conexión, y por eso hace falta excluirlo explícitamente aquí.
  const embeddedDbExclusion =
    layersPresent.persistence && model.persistenceKind === 'document'
      ? `
    // El mongod embebido es del perfil \`test\`: fuera del classpath de las IT, que
    // corren con perfil \`local\` contra el Mongo real de infra/. Si entra, su
    // autoconfiguración reemplaza la conexión y el contexto no arranca.
    integrationTestImplementation.exclude group: 'de.flapdoodle.embed'
    integrationTestRuntimeOnly.exclude group: 'de.flapdoodle.embed'`
      : '';

  // Con política CORS declarada, el arnés manda `Origin` en el preflight y en la
  // petición normal cross-origin. El HttpClient del JDK —el que fija
  // JdkClientHttpRequestFactory en AbstractFlowIT— la tiene en su lista de cabeceras
  // RESTRINGIDAS y la descarta sin avisar: el servidor contesta entonces lo mismo que a
  // una petición sin origen, así que un preflight que en realidad RECHAZA el origen se
  // lee como 2xx sin ninguna cabecera `Access-Control-*`. Falso negativo mudo, que es
  // justo el modo de fallo que el resto del arnés evita.
  const corsJvmArgs = model.security?.cors
    ? "\n    jvmArgs '-Djdk.httpclient.allowRestrictedHeaders=origin'"
    : '';

  const buildGradle = `plugins {
    id 'java'
    id 'org.springframework.boot' version '${SPRING_BOOT_VERSION}'
    id 'io.spring.dependency-management' version '1.1.7'
}

group = '${groupOf(service)}'
version = '${service.version}'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(${JAVA_VERSION})
    }
}

repositories {
    mavenCentral()
}

dependencies {
${dependencies.map((dep) => `    ${dep}`).join('\n')}
}

sourceSets {
    integrationTest {
        // Solo runtimeClasspath: las IT son caja negra (hablan HTTP, no importan
        // DTOs ni entidades), así que compilan sin src/main/java. Es lo que permite
        // que el agente de pruebas trabaje en paralelo con el de código y cierre su
        // gate de compilación sin depender de un main a medio escribir. main hace
        // falta al ejecutar, no al compilar.
        runtimeClasspath += sourceSets.main.output
    }
}

configurations {
    integrationTestImplementation.extendsFrom testImplementation
    integrationTestRuntimeOnly.extendsFrom testRuntimeOnly${embeddedDbExclusion}
}

tasks.named('test') {
    useJUnitPlatform()
}

// Escenarios FL-* de specs/validation-scenarios.md contra la infra real de infra/.
// Fuera de \`check\` a propósito: sin infraestructura levantada no tiene sentido,
// y \`./gradlew build -x test\` debe seguir siendo el gate de compilación.
tasks.register('integrationTest', Test) {
    testClassesDirs = sourceSets.integrationTest.output.classesDirs
    classpath = sourceSets.integrationTest.runtimeClasspath
    useJUnitPlatform()
    shouldRunAfter tasks.named('test')${corsJvmArgs}
}
`;

  const settingsGradle = `rootProject.name = '${service.projectName}'\n`;

  const gitignore = `.gradle/
build/
out/
*.class
.idea/
.vscode/
`;

  // El contexto de build de deploy/Dockerfile es la RAÍZ del proyecto (necesita
  // src/ y el wrapper vendorizado), así que el .dockerignore va aquí y no en
  // deploy/. Fuera queda todo lo que no entra en la imagen: lo ya compilado (que
  // se recompila dentro y solo serviría para invalidar capas), la infraestructura
  // de la generación y la documentación.
  const dockerignore = `.git/
.gradle/
build/
out/
infra/
deploy/
docs/
specs/
.idea/
.vscode/
*.md
`;

  // Los scripts de infra/ los ejecuta bash (contenedor o Git Bash): con CRLF el
  // shebang se rompe. Un clon en Windows con core.autocrlf=true los convertiría
  // si no se fijan aquí, igual que ya se fija gradlew.
  // Un Dockerfile con CRLF rompe el build en cuanto hay una línea continuada con
  // `\`: el `\r` queda dentro del comando. Mismo motivo que los .sh.
  const gitattributes = `/gradlew        text eol=lf
*.sh            text eol=lf
Dockerfile*     text eol=lf
*.bat           text eol=crlf
*.jar           binary
`;

  return [
    { path: 'build.gradle', content: buildGradle },
    { path: 'settings.gradle', content: settingsGradle },
    { path: '.gitignore', content: gitignore },
    { path: '.gitattributes', content: gitattributes },
    { path: '.dockerignore', content: dockerignore }
  ];
}

function groupOf(service) {
  // El grupo es el paquete base sin el último segmento (el nombre del servicio).
  return service.basePackage.split('.').slice(0, -1).join('.');
}
