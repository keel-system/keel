// Ejecutar el TypeScript que emite keel-nest SIN instalar el proyecto generado.
//
// Lo que el dominio hace en ejecución —normalizar una escala, rechazar un valor, negar una
// transición— no lo puede juzgar una comparación de cadenas ni un parser. Aquí se planifica una
// fixture, se transpila el árbol emitido con el compilador de TypeScript (sin tipos: eso lo mide
// `npm run ts-check`) a un directorio temporal y se importan sus módulos. Solo sirve para lo que no
// importa Nest (dominio, mensajes, contenedor de casos de uso): Nest no está instalado en keel-nest.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadService } from 'keel-core';
import { planService } from '../../src/scaffold/index.js';
import { FIXTURES_DIR } from './workspace.js';
import { tmpDir } from './tmp.js';

const require = createRequire(import.meta.url);

/** Carga una fixture; `mutate(layers)` permite derivar de ella una variante en memoria. */
export function planFixture(name, { mutate = null, withoutLayers = [], stack = null } = {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  for (const layer of withoutLayers) {
    delete manifest.layers[layer];
    delete layers[layer];
  }
  if (mutate) mutate(layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
}

/**
 * Transpila los `.ts` de `files` bajo `src/` a un directorio temporal y devuelve `load(ruta)`, que
 * importa el módulo emitido en `ruta` (desde la raíz del proyecto, con `.ts`).
 */
export function transpileTree(files, { stubs = {} } = {}) {
  const root = tmpDir('keel-nest-emitted-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  // Paquetes sustitutos (`{ '@nestjs/common': fuente }`): lo emitido que importa Nest solo para decorar se
  // puede ejecutar así sin instalarlo. El sustituto es del test que lo pide, nunca del árbol emitido.
  for (const [name, source] of Object.entries(stubs)) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
  }
  // Los paquetes que importa el código emitido sin Nest (decimal.js del dominio, jose de la seguridad, handlebars
  // y nodemailer del correo, el cliente de Redis de la caché) se resuelven desde el node_modules del monorepo.
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  for (const dependency of ['decimal.js', 'jose', 'handlebars', 'nodemailer', '@redis/client']) {
    const dir = path.dirname(require.resolve(`${dependency}/package.json`));
    const link = path.join(root, 'node_modules', ...dependency.split('/'));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(dir, link, 'junction');
  }
  for (const file of files) {
    if (!file.path.startsWith('src/') || !file.path.endsWith('.ts') || file.path.endsWith('.d.ts')) continue;
    const { outputText } = ts.transpileModule(file.content, {
      fileName: file.path,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        experimentalDecorators: true,
        useDefineForClassFields: true
      }
    });
    const out = path.join(root, file.path.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, outputText);
  }
  return {
    root,
    load: (file) => import(pathToFileURL(path.join(root, file.replace(/\.ts$/, '.js'))).href)
  };
}

export const here = path.dirname(fileURLToPath(import.meta.url));
