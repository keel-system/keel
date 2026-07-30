#!/usr/bin/env node
import { Command } from 'commander';
import { packageVersion } from './lib/assets.js';
import { init } from './commands/init.js';
import { list } from './commands/list.js';
import { validate } from './commands/validate.js';
import { describe } from './commands/describe.js';
import { createService } from './commands/new.js';
import { writeIndex } from './commands/index-cmd.js';
import { checkSystem, showSystem } from './commands/system.js';
import { listRegistry, searchRegistry, showRegistryDesign } from './commands/registry.js';

/**
 * Opciones comunes de los subcomandos que hablan con el registry remoto.
 * Commander no propaga opciones a los subcomandos, así que se añaden a cada uno.
 */
function withRegistryOptions(command) {
  return command
    .option('--source <url>', 'URL del index.json del registry (por defecto, KEEL_REGISTRY_URL o el oficial)')
    .option('--refresh', 'ignora la caché y vuelve a descargar el índice', false)
    .option('--offline', 'usa solo la copia local del índice, sin red', false);
}

const program = new Command();

program
  .name('keel')
  .description('Diseña servidores como artefactos agnósticos de tecnología y genera implementaciones con agentes.')
  .version(packageVersion());

program
  .command('init')
  .description('Siembra un workspace Keel en el directorio actual (skills, schema, plantillas, docs)')
  .option('-f, --force', 'sobrescribe archivos existentes', false)
  .option('--check', 'no escribe: falla si el payload del workspace quedó atrás respecto a esta CLI', false)
  .action((options) => init(options));

program
  .command('list')
  .description('Lista los generadores conocidos y su paquete npm')
  .action(() => list());

withRegistryOptions(
  program
    .command('new')
    .description('Crea el directorio de un servicio nuevo desde plantillas, o derivado de un diseño existente con --from')
    .argument('<servicio>', 'nombre del servicio en kebab-case (ej. product-catalog)')
    .option(
      '--from <origen>',
      'diseño del que derivar: nombre local (billing), ruta (specs/billing) o del registry (registry:catalog)'
    )
    .option('--no-docs', 'al derivar del registry, no descarga la documentación del origen (solo el spec)')
).action((servicio, options) => createService(servicio, options));

program
  .command('validate')
  .description('Valida un servicio multi-artefacto: schema por capa + referencias cruzadas')
  .argument('<ruta>', 'directorio del servicio o su manifiesto (ej. specs/mi-servicio)')
  .option('--wip', 'diseño en progreso: capas en plantilla y referencias pendientes son avisos, no errores', false)
  .action((ruta, options) => validate(ruta, options));

program
  .command('describe')
  .description('Resume un diseño para leerlo o reutilizarlo: identidad, estado, capas y contenido por capa')
  .argument('<servicio>', 'nombre del servicio (busca specs/<servicio>) o ruta al directorio/manifiesto')
  .action((servicio) => describe(servicio));

program
  .command('index')
  .description('Genera el índice de diseños del workspace: la tabla del README y index.json')
  .option('--check', 'no escribe: falla si el índice quedó atrás (para CI)', false)
  .action((options) => writeIndex(options));

const system = program
  .command('system')
  .description('Mapa del sistema (system.yaml): olas de construcción, mapa de contextos y deriva contra los diseños');

system
  .command('show', { isDefault: true })
  .description('Muestra las olas de construcción, el estado de cada servicio y el mapa de contextos')
  .option('--json', 'emite el plan completo en JSON (entrada de /keel-decompose)', false)
  .action((options) => showSystem(options));

system
  .command('check')
  .description('Contrasta el mapa con los diseños reales: la única comprobación cross-servicio (para CI)')
  .action(() => checkSystem());

const registry = program
  .command('registry')
  .description('Explora el registry de diseños reutilizables de la comunidad');

withRegistryOptions(
  registry.command('list', { isDefault: true }).description('Lista los diseños publicados, agrupados por familia')
).action((options) => listRegistry(options));

withRegistryOptions(
  registry
    .command('search')
    .description('Busca diseños por nombre, tags, dominio o descripción')
    .argument('<término>', 'texto a buscar (ej. notifications, outbox, billing)')
).action((termino, options) => searchRegistry(termino, options));

withRegistryOptions(
  registry
    .command('show')
    .description('Muestra la ficha completa de un diseño del registry')
    .argument('<diseño>', 'slug del diseño (ej. catalog, notifications-multichannel)')
).action((diseno, options) => showRegistryDesign(diseno, options));

await program.parseAsync();
