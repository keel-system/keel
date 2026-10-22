#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { emitDoc } from './commands/emit-doc.js';
import { fingerprint } from './lib/fingerprint.js';
import { envDeps } from './lib/env-deps.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();

program
  .name('keel-recover')
  .description(
    'Ingeniería inversa de un servicio existente hacia un diseño Keel. Lee el repo del legacy (la única entrada) sin modificarlo.'
  )
  .version(pkg.version);

const docOptions = (cmd) =>
  cmd
    .option('-o, --out <archivo>', 'escribe el documento en ese archivo (nunca dentro del legacy) en vez de imprimirlo')
    .option('--check <archivo>', 'no escribe: falla si el archivo no es lo que la herramienta escribe hoy (puerta de CI)')
    .option('--json', 'JSON en vez de YAML', false);

docOptions(
  program
    .command('fingerprint')
    .description(
      'Paso 0a: huella del runtime (lenguaje y su versión, build, framework, empaquetado, servidor, lockfiles, registros, Dockerfiles, CI y los motores con los que se probaba), con archivo:línea. Sale runtime.yaml'
    )
    .argument('<legacy>', 'directorio del repo del legacy')
).action((legacy, options) => emitDoc(fingerprint, legacy, options));

docOptions(
  program
    .command('env-deps')
    .description(
      'Paso 0b: lo que el legacy lee del entorno, sus dependencias externas clasificadas con su provisión en el sandbox (contenedor, WireMock, Mailpit o pregunta), las llamadas HTTP salientes y el inventario de activos del repo. Sale environment.yaml'
    )
    .argument('<legacy>', 'directorio del repo del legacy')
).action((legacy, options) => emitDoc(envDeps, legacy, options));

await program.parseAsync();
