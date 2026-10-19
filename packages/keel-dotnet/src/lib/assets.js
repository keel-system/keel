import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Assets del generador: fuente neutral del conocimiento del proyecto generado. Nada de esto se
// copia al workspace de diseño.
export const assetsDir = path.join(packageRoot, 'assets');

export const TECH = 'dotnet';
export const SKILL = 'keel-generate-dotnet';

// Versiones del DSL keel que este generador sabe mapear. La misma que keel-spring y keel-nest: el
// método soporta una sola, y dos generadores que aceptaran versiones distintas no podrían recibir el
// mismo diseño.
export const SUPPORTED_DSL = ['2.22'];

// La plataforma del proyecto generado. Verificada el 2026-10-13 contra el SDK instalado
// (10.0.401) y contra nuget.org con `dotnet package search`:
//   · .NET 10 es la LTS; `global.json` fija la banda 10.0.100 con `rollForward: latestFeature`, así que
//     sirve cualquier SDK 10.0.x igual o posterior y nunca uno de otra versión mayor;
//   · con el SDK 10, xUnit v3 4.x ya NO corre por VSTest: `dotnet test` exige optar por
//     Microsoft.Testing.Platform en `global.json` (`"test": { "runner": … }`), y entonces sobran
//     `xunit.runner.visualstudio` y `Microsoft.NET.Test.Sdk`. Medido: con ellos y sin la opción, el
//     build de pruebas falla («Testing with VSTest target is no longer supported»).
// Las versiones de cada paquete NuGet, con su licencia, viven en `dotnet-stack.js`.
export const DOTNET_SDK_BAND = '10.0.100';
export const TARGET_FRAMEWORK = 'net10.0';
export const TEST_RUNNER = 'Microsoft.Testing.Platform';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
