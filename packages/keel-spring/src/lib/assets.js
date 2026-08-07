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
export const SUPPORTED_DSL = ['2.6'];

// Stack del scaffolding generado (un solo sitio para actualizarlo).
export const SPRING_BOOT_VERSION = '3.5.3';
export const JAVA_VERSION = 21;
export const GRADLE_VERSION = '8.14';
export const SPRINGDOC_VERSION = '2.8.9';
export const RESILIENCE4J_VERSION = '2.3.0';
// Wrapper JsonNullable: solo se añade si el diseño declara alguna actualización
// parcial (PATCH), donde el contrato distingue campo ausente de campo nulo.
export const JACKSON_NULLABLE_VERSION = '0.2.6';
// Mongo embebido del perfil `test` del modelo documental (el análogo de H2). El
// artefacto y la versión del servidor que descarga van juntos: son las dos mitades
// de la misma decisión.
export const FLAPDOODLE_SPRING_VERSION = '4.20.0';
export const EMBEDDED_MONGO_VERSION = '7.0.4';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
