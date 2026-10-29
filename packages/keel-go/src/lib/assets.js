import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Assets del generador: fuente neutral del conocimiento del proyecto generado. Nada de esto se
// copia al workspace de diseño.
export const assetsDir = path.join(packageRoot, 'assets');

export const TECH = 'go';
export const SKILL = 'keel-generate-go';

// Versiones del DSL keel que este generador sabe mapear. La misma que los otros tres: el método soporta
// una sola, y dos generadores que aceptaran versiones distintas no podrían recibir el mismo diseño.
export const SUPPORTED_DSL = ['2.23'];

// La plataforma del proyecto generado. Verificada el 2026-10-29 contra el Go instalado (go1.27.3) y
// contra go.dev/dl, que la da como la estable:
//   · `go` de go.mod es la versión MÍNIMA con la que el proyecto compila: la que el código usa de verdad.
//     Es 1.27 porque el contrato del cable va sobre `encoding/json/v2`, estable desde 1.27 (en 1.26 sigue
//     tras GOEXPERIMENT=jsonv2 y no compila: medido en el inc. 3). Se renuncia a soportar 1.26 a cambio de
//     un lector JSON que distingue mayúsculas en los nombres, escribe `[]` para una lista sin elementos y
//     admite un conversor por tipo en cada llamada: con el v1, las tres cosas habría que escribirlas a mano
//     en cada DTO;
//   · `toolchain` fija la estable con la que se mide. Un Go más antiguo que ella la descarga solo
//     (GOTOOLCHAIN=auto), así que todos compilan con la misma.
// Las versiones de cada módulo, con su licencia, viven en `go-stack.js`.
export const GO_MIN_VERSION = '1.27.0';
export const GO_TOOLCHAIN = 'go1.27.3';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
