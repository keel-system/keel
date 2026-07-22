import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Assets del generador: skill + conventions + golden que `build` copia al workspace.
export const assetsDir = path.join(packageRoot, 'assets');

// Wrapper de Gradle vendorizado (fuera de assets/: solo va al proyecto generado).
export const wrapperDir = path.join(packageRoot, 'vendor', 'gradle-wrapper');

export const TECH = 'spring';
export const SKILL = 'keel-generate-spring';

// Versiones del DSL keel que este generador sabe mapear (manifest.keel del servicio).
export const SUPPORTED_DSL = ['2.0'];

// Stack del scaffolding generado (un solo sitio para actualizarlo).
export const SPRING_BOOT_VERSION = '3.5.3';
export const JAVA_VERSION = 21;
export const GRADLE_VERSION = '8.14';
export const SPRINGDOC_VERSION = '2.8.9';
export const RESILIENCE4J_VERSION = '2.3.0';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
