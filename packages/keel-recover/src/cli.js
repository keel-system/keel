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
import { fixtures } from './commands/fixtures.js';
import { parity } from './commands/parity.js';
import { status } from './commands/status.js';
import { target } from './commands/target.js';

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

program
  .command('fixtures')
  .description(
    'El estado de partida de los escenarios: restaura la base del legacy al snapshot de verify, la exporta y la traduce con contract-map.yaml → data a specs/<servicio>/fixtures.yaml, con los nombres del diseño. Lo cargan el arnés del proyecto generado (infra/reset-db.sh) y la paridad. No escribe nada si algo no casa con el diseño'
  )
  .argument('<legacy>', 'directorio legacy/<servicio>/ del workspace')
  .option('--spec <dir>', 'el diseño recuperado (por defecto, specs/<servicio> del mismo workspace)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((legacy, options) => fixtures(legacy, options));

program
  .command('parity')
  .description(
    'Paso 7: ejecuta los mismos flujos contra el servicio regenerado (en marcha con el deploy/ de su proyecto, descrito en target.yaml) y compara todos los datos de cada paso con los que grabó characterize del legacy, traducidos por contract-map.yaml. Sale en rojo con un keep, fix o new en rojo, con una diferencia de datos sin declarar (declaredDifferences) o sin nada que comparar. Escribe PARITY-<destino>.md'
  )
  .argument('<legacy>', 'directorio legacy/<servicio>/ del workspace')
  .requiredOption('--target <archivo>', 'target.yaml del servicio regenerado')
  .option('--spec <dir>', 'el diseño recuperado (por defecto, specs/<servicio> del mismo workspace)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((legacy, options) => parity(legacy, options));

program
  .command('status')
  .description(
    'En qué paso está la recuperación de un legacy (init, sandbox, observe, explore, design, characterize, close, build, generate, parity, done), derivado de lo que hay en disco: el veredicto de verify, las rondas grabadas, exploration.yaml y questions.yaml, los criterios de keel validate --ready, el proyecto generado y el resultado de parity. Es lo que lee /keel-recover-run para seguir donde se quedó'
  )
  .argument('<legacy>', 'directorio legacy/<servicio>/ del workspace')
  .option('--spec <dir>', 'el diseño recuperado (por defecto, specs/<servicio> del mismo workspace)')
  .option('--json', 'el estado como JSON (lo que lee el orquestador)', false)
  .action((legacy, options) => status(legacy, options));

program
  .command('target')
  .description(
    'Paso 7: escribe el target.yaml de la paridad desde el deploy/ del proyecto generado, ya en marcha (bash deploy/up.sh): la URL del servicio, la base que se vacía entre flujos, el proveedor de identidad y cómo dar de alta a las personas de los flujos. Los contenedores se preguntan al runtime por sus etiquetas de compose'
  )
  .argument('<proyecto>', 'el proyecto generado (services/<servicio>-<tech>)')
  .option('-o, --out <archivo>', 'dónde escribirlo (por defecto, lo imprime)')
  .option('--runtime <podman|docker>', 'runtime de contenedores (por defecto, el primero en marcha)')
  .action((project, options) => target(project, options));

await program.parseAsync();
