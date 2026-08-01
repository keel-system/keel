#!/usr/bin/env node
import { Command } from 'commander';
import { packageVersion } from './lib/assets.js';
import { build } from './commands/build.js';

const program = new Command();

program
  .name('keel-spring')
  .description('Generador Spring Boot para diseños Keel: valida el diseño agnóstico y genera el proyecto en services/<servicio>-spring/, donde el agente completa la generación.')
  .version(packageVersion());

program
  .command('build')
  .description('Valida el servicio, pregunta el stack y genera en services/<servicio>-spring/ el scaffolding transversal al stack más el conocimiento del agente (skill, agentes y conventions, sembrados para los harnesses soportados); los adaptadores de infraestructura y la lógica de negocio se completan después con /keel-generate-spring dentro del proyecto')
  .argument('[ruta]', 'directorio del servicio o su manifiesto (ej. specs/mi-servicio)')
  .option('-f, --force', 'sobrescribe el scaffolding ya generado (incluido el código implementado por el agente)', false)
  .option('-y, --defaults', 'usa los defaults del stack sin cuestionario (PostgreSQL, Kafka, Keycloak, Redis)', false)
  .action((ruta, options) => build(ruta, options));

program.parse();
