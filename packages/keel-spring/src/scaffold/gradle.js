// build.gradle + settings.gradle + .gitignore + .gitattributes del proyecto
// generado. Dependencias condicionales según las capas declaradas y el stack
// elegido en el cuestionario (keel-stack.json).

import { SPRING_BOOT_VERSION, JAVA_VERSION, SPRINGDOC_VERSION, RESILIENCE4J_VERSION } from '../lib/assets.js';
import { DATABASES, BROKERS, CACHES, STORAGE } from '../lib/stack-catalog.js';

export function generate(model) {
  const { service, layersPresent, stack } = model;

  const dependencies = [
    "implementation 'org.springframework.boot:spring-boot-starter-web'",
    "implementation 'org.springframework.boot:spring-boot-starter-validation'",
    "implementation 'org.springframework.boot:spring-boot-starter-aop'",
    `implementation 'org.springdoc:springdoc-openapi-starter-webmvc-ui:${SPRINGDOC_VERSION}'`
  ];
  if (layersPresent.persistence) {
    dependencies.push(
      "implementation 'org.springframework.boot:spring-boot-starter-data-jpa'",
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
  dependencies.push(
    "testImplementation 'org.springframework.boot:spring-boot-starter-test'",
    "testRuntimeOnly 'org.junit.platform:junit-platform-launcher'"
  );

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

tasks.named('test') {
    useJUnitPlatform()
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

  const gitattributes = `/gradlew        text eol=lf
*.bat           text eol=crlf
*.jar           binary
`;

  return [
    { path: 'build.gradle', content: buildGradle },
    { path: 'settings.gradle', content: settingsGradle },
    { path: '.gitignore', content: gitignore },
    { path: '.gitattributes', content: gitattributes }
  ];
}

function groupOf(service) {
  // El grupo es el paquete base sin el último segmento (el nombre del servicio).
  return service.basePackage.split('.').slice(0, -1).join('.');
}
