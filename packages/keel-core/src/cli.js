#!/usr/bin/env node
import { Command } from 'commander';
import { packageVersion } from './lib/assets.js';
import { init } from './commands/init.js';
import { add } from './commands/add.js';
import { list } from './commands/list.js';
import { validate } from './commands/validate.js';
import { describe } from './commands/describe.js';
import { createService } from './commands/new.js';

const program = new Command();

program
  .name('keel')
  .description('Diseña servidores como artefactos agnósticos de tecnología y genera implementaciones con agentes.')
  .version(packageVersion());

program
  .command('init')
  .description('Siembra un workspace Keel en el directorio actual (skills, schema, plantillas, docs)')
  .option('-f, --force', 'sobrescribe archivos existentes', false)
  .action((options) => init(options));

program
  .command('add')
  .description('[deprecado] Los generadores son paquetes independientes: npm i -g keel-<tech> && keel-<tech> build')
  .argument('<tech>', 'tecnología del generador (ver: keel list)')
  .action((tech) => add(tech));

program
  .command('list')
  .description('Lista los generadores conocidos y su paquete npm')
  .action(() => list());

program
  .command('new')
  .description('Crea el directorio de un servicio nuevo desde plantillas, o derivado de un diseño existente con --from')
  .argument('<servicio>', 'nombre del servicio en kebab-case (ej. product-catalog)')
  .option('--from <origen>', 'servicio existente del que derivar (nombre o ruta: billing | specs/billing)')
  .action((servicio, options) => createService(servicio, options));

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

program.parse();
