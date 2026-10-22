#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { emitDoc } from './commands/emit-doc.js';
import { fingerprint } from './lib/fingerprint.js';
import { envDeps } from './lib/env-deps.js';
import { verify } from './commands/verify.js';
import { init } from './commands/init.js';

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

program
  .command('init')
  .description(
    'Prepara legacy/<servicio>/ en el workspace de diseño: legacy.yaml (dónde está el repo), runtime.yaml y environment.yaml (pasos 0a y 0b; al repetirlo conserva las adaptaciones), la instrumentación del sandbox y la skill /keel-recover-sandbox para cada harness'
  )
  .argument('<repo>', 'directorio del repo del legacy (la única entrada; no se modifica)')
  .option('--name <servicio>', 'nombre del servicio en kebab-case (por defecto, el del directorio del repo)')
  .option('--workspace <dir>', 'workspace de diseño (por defecto, el directorio actual)')
  .action((repo, options) => init(repo, options));

program
  .command('verify')
  .description(
    'Paso 0f: el juez del sandbox. Red interna, imágenes por digest, motor cruzado con la CI, sin salida a internet desde la app, una lectura y una escritura reales del dominio con rastro en la base y la cobertura grabando. En verde, toma el snapshot de la base. Escribe verify.json'
  )
  .argument('[sandbox]', 'sandbox.yaml o su directorio', '.')
  .option('--no-up', 'no levanta el compose: juzga el sandbox que ya está arriba')
  .option('--no-snapshot', 'no toma el snapshot de la base aunque salga en verde')
  .option('--no-write', 'no escribe verify.json')
  .option('--down', 'baja el compose (y sus volúmenes) al terminar', false)
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((sandbox, options) => verify(sandbox, options));

await program.parseAsync();
