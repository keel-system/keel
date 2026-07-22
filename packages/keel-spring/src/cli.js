#!/usr/bin/env node
import { Command } from 'commander';
import { packageVersion } from './lib/assets.js';
import { build } from './commands/build.js';

const program = new Command();

program
  .name('keel-spring')
  .description('Generador Spring Boot para diseños Keel: prepara el workspace (skill + convenciones) y valida el diseño agnóstico.')
  .version(packageVersion());

program
  .command('build')
  .description('Instala la skill keel-generate-spring, valida el servicio y genera el scaffolding transversal al stack; los adaptadores de infraestructura y la lógica de negocio los completa el agente')
  .argument('[ruta]', 'directorio del servicio o su manifiesto (ej. specs/mi-servicio)')
  .option('-f, --force', 'sobrescribe archivos del generador ya instalados y el scaffolding', false)
  .option('-y, --defaults', 'usa los defaults del stack sin cuestionario (PostgreSQL, Kafka, Keycloak, Redis)', false)
  .action((ruta, options) => build(ruta, options));

program.parse();
