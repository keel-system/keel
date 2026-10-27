import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Assets del generador: fuente neutral del conocimiento del proyecto generado (skill, agentes,
// conventions, skills por tecnología). Nada de esto se copia al workspace de diseño.
export const assetsDir = path.join(packageRoot, 'assets');

// Wrapper de Gradle vendorizado (fuera de assets/: solo va al proyecto generado).
export const wrapperDir = path.join(packageRoot, 'vendor', 'gradle-wrapper');

export const TECH = 'spring';
export const SKILL = 'keel-generate-spring';

// Versiones del DSL keel que este generador sabe mapear (manifest.keel del servicio).
// Una sola, en espejo del enum de service.schema.json: keel-core no acepta
// versiones anteriores porque sus schemas no gatean primitivos por versión.
export const SUPPORTED_DSL = ['2.23'];

// Stack del scaffolding generado (un solo sitio para actualizarlo).
//
// Boot 4.1.2 trae del BOM Spring Framework 7.0.10, Jackson 3.1.7, Hibernate 7.4, Flyway 12,
// Micrometer 1.17, Micrometer Tracing 1.7, OpenTelemetry 1.62 y JUnit 6. Las versiones de abajo
// son las que el BOM NO gestiona, y cada una es la línea de su librería para Boot 4.
//
// La línea de plataforma se estampa en keel-generated.json (`generator.springBoot`): un proyecto
// generado con otra línea no se refresca, se regenera (ver `platformMismatch`).
export const SPRING_BOOT_VERSION = '4.1.2';
export const SPRING_BOOT_LINE = '4';
export const JAVA_VERSION = 21;
export const GRADLE_VERSION = '8.14';
// springdoc 3.x es la línea de Boot 4; la 3.2.0 se publica contra Boot 4.1.2.
export const SPRINGDOC_VERSION = '3.2.0';
// El artefacto de resilience4j va por línea de Boot (`resilience4j-spring-boot4`).
export const RESILIENCE4J_VERSION = '2.4.0';
// Motor de plantillas del correo, sin lógica arbitraria. Solo se añade con capa
// mail: es la elección que impide que un cuerpo escrito fuera del equipo pueda
// invocar métodos de la JVM (ver la nota de gradle.js).
export const HANDLEBARS_VERSION = '4.4.0';
// Wrapper JsonNullable: solo se añade si el diseño declara alguna actualización
// parcial (PATCH), donde el contrato distingue campo ausente de campo nulo. Desde la 0.2.8
// trae también el módulo de Jackson 3 (`JsonNullableJackson3Module`), que es el que se registra.
export const JACKSON_NULLABLE_VERSION = '0.2.13';
// Mongo embebido del perfil `test` del modelo documental (el análogo de H2). El
// artefacto y la versión del servidor que descarga van juntos: son las dos mitades
// de la misma decisión.
export const FLAPDOODLE_SPRING_VERSION = '4.33.0';
export const EMBEDDED_MONGO_VERSION = '7.0.4';
// Telemetría (solo con `telemetry: otel` en keel-stack.json). El resto de piezas —el puente
// de Micrometer Tracing, el SDK y los exportadores OTLP— las gobierna el BOM de Boot; estas dos
// no. El appender de logback va ALINEADO con el SDK que trae Boot (2.28.0-alpha depende de
// opentelemetry-api 1.62.0, el de Boot 4.1.2): subir uno sin el otro mezcla dos SDK en el
// classpath. Y datasource-micrometer es la línea 2.x, la de Boot 4 (la 1.x es de Boot 3).
export const OTEL_LOGBACK_APPENDER_VERSION = '2.28.0-alpha';
export const DATASOURCE_MICROMETER_VERSION = '2.3.0';
// Propagación de contexto entre hilos (ContextPropagatingExecutors). Se declara siempre, y con
// versión: sin telemetría llega solo como dependencia OPCIONAL de micrometer-observation —es
// decir, no llega— y el BOM de Boot no la gestiona. 1.2.1 es la que empareja Micrometer 1.17,
// el de Boot 4.1.2.
export const CONTEXT_PROPAGATION_VERSION = '1.2.1';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
