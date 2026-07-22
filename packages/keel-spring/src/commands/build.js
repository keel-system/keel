import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace, resolveServiceDir, loadService, validateService, copyTree } from 'keel-core';
import { assetsDir, SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { scaffoldService } from '../scaffold/index.js';
import { STACK_FILE, readStackConfig, writeStackConfig, askStackConfig, describeStack } from '../lib/stack-config.js';

function listSpecs(workspace) {
  const specsDir = path.join(workspace, 'specs');
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function printSchemaErrors(file, ajvErrors) {
  console.error(pc.bold(pc.red(`✘ ${file}`)));
  for (const error of ajvErrors) {
    const where = error.instancePath || '(raíz)';
    console.error(`  ${pc.red('•')} ${pc.cyan(where)} ${error.message}`);
  }
}

export async function build(inputPath, { force = false, defaults = false } = {}) {
  const workspace = process.cwd();

  if (!isKeelWorkspace(workspace)) {
    console.error(pc.red('Este directorio no es un workspace Keel (falta schema/service.schema.json).'));
    console.error(`Ejecuta primero ${pc.cyan('keel init')}.`);
    process.exitCode = 1;
    return;
  }

  if (!inputPath) {
    console.error(pc.red('Falta el servicio a preparar: keel-spring build specs/<servicio>'));
    const services = listSpecs(workspace);
    if (services.length > 0) {
      console.error('Servicios en specs/:');
      for (const name of services) console.error(`  ${pc.cyan(`specs/${name}`)}`);
    }
    process.exitCode = 1;
    return;
  }

  const { dir, error: resolveError } = resolveServiceDir(inputPath);
  if (resolveError) {
    console.error(pc.red(resolveError));
    process.exitCode = 1;
    return;
  }

  // Compatibilidad DSL: este generador solo sabe mapear las versiones declaradas en SUPPORTED_DSL.
  const { manifest, layers, errors: loadErrors } = loadService(dir);
  if (!manifest) {
    for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }
  if (!SUPPORTED_DSL.includes(manifest.keel)) {
    console.error(
      pc.red(`✘ DSL keel ${manifest.keel ?? '(sin declarar)'} no soportado por keel-spring (soporta: ${SUPPORTED_DSL.join(', ')}).`)
    );
    console.error(pc.dim('  Actualiza keel-spring o ajusta el diseño a una versión soportada.'));
    process.exitCode = 1;
    return;
  }

  // Instala skill + conventions + skills por tecnología + golden en el workspace (idempotente; --force sobrescribe).
  const { copied, skipped } = copyTree(assetsDir, workspace, { force });
  for (const file of copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);

  // Un diseño en progreso no es generable: validación estricta, sin --wip.
  const { loadErrors: fullLoadErrors, schemaErrors, crossRefErrors, warnings, pending, ok } = validateService(dir, {
    wip: false
  });

  for (const { file, errors } of schemaErrors) printSchemaErrors(file, errors);
  for (const message of fullLoadErrors) console.error(pc.red(`✘ ${message}`));
  if (pending.length > 0) {
    console.error(pc.bold(pc.red(`✘ Diseño incompleto — ${pending.length} pendiente(s):`)));
    for (const message of pending) console.error(`  ${pc.red('•')} ${message}`);
  }
  for (const message of warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (crossRefErrors.length > 0) {
    console.error(pc.bold(pc.red(`✘ Referencias cruzadas — ${crossRefErrors.length} error(es):`)));
    for (const message of crossRefErrors) console.error(`  ${pc.red('•')} ${message}`);
  }

  if (!ok || pending.length > 0) {
    console.error();
    console.error(pc.red('El diseño aún no es generable. Termina el diseño (/keel-design) y valida con keel validate.'));
    process.exitCode = 1;
    return;
  }

  // Stack tecnológico: keel-stack.json del proyecto generado manda; si no
  // existe, cuestionario condicionado por las capas del diseño (o defaults).
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-spring`);
  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  if (stack) {
    console.log();
    console.log(pc.dim(`Stack (${STACK_FILE}): ${describeStack(stack)}`));
  } else {
    stack = await askStackConfig(manifest, layers, { defaults });
    stackIsNew = true;
  }

  // Scaffolding transversal al stack: todo lo derivable mecánicamente del
  // diseño cuyo código no depende de la infra puntual elegida (el resto lo
  // escribe el agente con las skills por tecnología). Regeneración segura: sin --force
  // solo se escriben archivos que no existen.
  const scaffold = scaffoldService({ manifest, layers, workspace, force, stack });
  if (stackIsNew) {
    writeStackConfig(projectDir, scaffold.stack);
    console.log();
    console.log(pc.dim(`Stack elegido: ${describeStack(scaffold.stack)} → ${STACK_FILE}`));
  }
  console.log();
  console.log(pc.bold(`Scaffolding ${scaffold.outDir}/`));
  for (const file of scaffold.copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of scaffold.skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);
  for (const message of scaffold.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  console.log(
    pc.dim(
      `${scaffold.copied.length} archivo(s) generado(s), ${scaffold.skipped.length} omitido(s)` +
        (scaffold.skipped.length > 0 ? ' (usa --force para sobrescribir)' : '')
    )
  );

  // La infraestructura de prueba vive en infra/ desde keel-spring 0.2; los
  // archivos de la raíz de builds anteriores quedan huérfanos (writer.js nunca
  // borra): se avisa para limpiarlos a mano.
  const legacyInfra = ['docker-compose.yaml', 'validate-infra.sh', path.join('docker', 'Dockerfile.devtools')]
    .filter((file) => fs.existsSync(path.join(projectDir, file)));
  if (legacyInfra.length > 0) {
    console.warn(
      `${pc.yellow('⚠')} La infraestructura de prueba ahora vive en infra/; quedaron archivos de una versión ` +
        `anterior en la raíz del proyecto (${legacyInfra.join(', ')}): bórralos manualmente.`
    );
  }

  // Las guías por tecnología ahora son skills keel-spring-<tech>; los
  // references/ de builds anteriores quedan huérfanos (writer.js/copyTree
  // nunca borran): se avisa para limpiarlos a mano.
  const legacyReferences = [
    path.join(projectDir, '.claude', 'skills', SKILL, 'references'),
    path.join(workspace, 'generators', 'spring', 'references')
  ].filter((refDir) => fs.existsSync(refDir));
  if (legacyReferences.length > 0) {
    console.warn(
      `${pc.yellow('⚠')} Las guías por tecnología ahora son skills (.claude/skills/keel-spring-<tech>/); quedaron ` +
        `directorios references/ de una versión anterior (${legacyReferences
          .map((refDir) => path.relative(workspace, refDir).split(path.sep).join('/'))
          .join(', ')}): bórralos manualmente.`
    );
  }

  // Snapshot del diseño dentro del proyecto: junto con .claude/ hace el repo
  // autosuficiente (quien lo clone finaliza la generación sin el workspace).
  // Siempre se refresca: el canónico es specs/<servicio> del workspace.
  const snapshotDir = path.join(projectDir, 'specs');
  const snapshot = copyTree(dir, snapshotDir, { force: true });
  console.log(
    pc.dim(
      `Snapshot del diseño → ${path.relative(workspace, snapshotDir).split(path.sep).join('/')}/ ` +
        `(${snapshot.copied.length} archivo(s), refrescado en cada build)`
    )
  );

  const service = path.relative(workspace, dir).split(path.sep).join('/');
  console.log();
  console.log(pc.bold(pc.green('✔ Scaffolding generado.')) + pc.dim(` — ${manifest.service?.name} v${manifest.service?.version}`));
  console.log(`Abre Claude Code y ejecuta ${pc.cyan(`/${SKILL} ${service}`)} para orquestar el completado: código + infraestructura en paralelo y validación funcional al final.`);
}
