#!/usr/bin/env node
import { Command } from 'commander';
import { packageVersion } from './lib/assets.js';
import { build } from './commands/build.js';
import { check } from './commands/check.js';

const program = new Command();

program
  .name('keel-nest')
  .description(
    'Generador NestJS para diseños Keel: valida el diseño agnóstico y genera el proyecto en services/<servicio>-nest/, donde el agente completa la generación.'
  )
  .version(packageVersion());

program
  .command('build')
  .description(
    'Valida el servicio, pregunta el stack y genera en services/<servicio>-nest/ el scaffolding transversal al stack; la lógica de negocio y los adaptadores de infraestructura se completan después con /keel-generate-nest dentro del proyecto'
  )
  .argument('[ruta]', 'directorio del servicio o su manifiesto (ej. specs/mi-servicio)')
  .option('--check', 'no escribe: falla si el proyecto se quedó atrás respecto al generador instalado', false)
  .option('--refresh', 'pone al día los archivos que generó build y nadie ha tocado; nunca pisa el código del agente', false)
  .option('--accept-unready', 'genera aunque el diseño no esté listo (keel validate --ready en rojo); queda estampado en keel-generated.json', false)
  .option('--prune', 'con --refresh: borra lo que build generó, ya no emite y nadie ha tocado; lo tocado se deja al agente', false)
  .option('-f, --force', 'sobrescribe TODO el scaffolding, incluido el código implementado por el agente (para propagar un arreglo usa --refresh)', false)
  .option('--telemetry <otel|none>', 'añade (otel) o retira (none) la telemetría; se persiste en keel-stack.json (por defecto, sin telemetría)')
  .option('-y, --defaults', 'usa los defaults del stack sin cuestionario', false)
  .action((ruta, options) => build(ruta, options));

program
  .command('check')
  .description(
    'No escribe nada: dice si el diseño es generable con keel-nest y qué avisos traería, desde el workspace de diseño y antes de sembrar el proyecto'
  )
  .argument('[ruta]', 'directorio del servicio o su manifiesto (ej. specs/mi-servicio)')
  .option('--strict', 'trata cualquier aviso como bloqueo (puerta de CI)', false)
  .action((ruta, options) => check(ruta, options));

await program.parseAsync();
