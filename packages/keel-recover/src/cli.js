#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { emitDoc } from './commands/emit-doc.js';
import { fingerprint } from './lib/fingerprint.js';
import { envDeps } from './lib/env-deps.js';
import { verify } from './commands/verify.js';
import { init } from './commands/init.js';
import { introspect, probe } from './commands/observe.js';
import { characterize } from './commands/characterize.js';

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

program
  .command('introspect')
  .description(
    'Paso 1a: la superficie del legacy preguntada al runtime (rutas del framework, colecciones con índices y columnas de estado, topología del broker). Funde el resultado en surface.yaml'
  )
  .argument('[sandbox]', 'sandbox.yaml o su directorio', '.')
  .option('-o, --out <archivo>', 'surface.yaml (por defecto, junto al directorio del sandbox)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((sandbox, options) => introspect(sandbox, options));

program
  .command('probe')
  .description(
    'Paso 1b: ejecuta una ronda de sondas (probes/round-N.yaml) contra el sandbox en verde. Cada sonda parte del snapshot y graba sus respuestas y sus efectos (diff de la base, llamadas a WireMock, publicaciones en el broker y correo), normalizados; un canario por canal prueba que cada efecto se está capturando. Vuelca la cobertura de la ronda y vuelve a preguntar la superficie'
  )
  .argument('<ronda>', 'archivo de la ronda (legacy/<servicio>/probes/round-N.yaml)')
  .option('--sandbox <dir>', 'sandbox.yaml o su directorio (por defecto, ../sandbox desde la ronda)')
  .option('--only <ids>', 'solo estas sondas, separadas por comas (no cuenta para la serie de cobertura)')
  .option('--out <dir>', 'dónde escribir las grabaciones (por defecto, recordings/<ronda>/)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((round, options) => probe(round, options));

program
  .command('characterize')
  .description(
    'Paso 5: ejecuta los escenarios de caracterización (los flujos keep, fix y frontier de specs/<servicio>/validation-scenarios.md, con sus pasos en el bloque ```keel-flow```) contra el legacy en marcha, traducidos por contract-map.yaml. Cada flujo parte del snapshot de verify. Escribe el sello specs/<servicio>/characterized.yaml (criterio characterized de keel validate --ready), las grabaciones y FIDELITY.md'
  )
  .argument('<legacy>', 'directorio legacy/<servicio>/ del workspace')
  .option('--spec <dir>', 'el diseño recuperado (por defecto, specs/<servicio> del mismo workspace)')
  .option('--only <ids>', 'solo estos flujos, separados por comas (no escribe ni el sello ni FIDELITY.md)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((legacy, options) => characterize(legacy, options));

await program.parseAsync();
