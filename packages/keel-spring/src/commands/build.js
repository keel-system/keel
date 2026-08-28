import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace, resolveServiceDir, loadService, validateService, copyTree, DECISIONS_FILE } from 'keel-core';
import { SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { scaffoldService } from '../scaffold/index.js';
import { writeFiles } from '../lib/writer.js';
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

  // Frontera del generador: lo que el DSL declara y keel-spring no sabe mapear se
  // rechaza o se avisa aquí, antes de sembrar nada y antes de preguntar el stack.
  const features = checkSupportedFeatures(manifest, layers);
  for (const message of features.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (features.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ El diseño usa capacidades que keel-spring no genera — ${features.errors.length}:`)));
    for (const message of features.errors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return;
  }

  // El workspace de diseño no recibe nada del generador: la skill, los agentes,
  // las conventions y las skills por tecnología se instalan solo en el proyecto
  // generado (el asset del paquete npm es su fuente, leída directamente). La
  // generación se ejecuta siempre con el cwd en services/<servicio>-spring/.

  // Un diseño en progreso no es generable: validación estricta, sin --wip.
  const {
    loadErrors: fullLoadErrors,
    schemaErrors,
    crossRefErrors,
    warnings,
    pending,
    obligations,
    ok
  } = validateService(dir, { wip: false });

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

  // Las decisiones de diseño sin cerrar bloquean como un error, así que el
  // veredicto genérico de abajo tiene que decir cuáles: mientras esto no se
  // imprimía, un diseño rechazado por una obligación abierta era indistinguible
  // de uno roto, y la causa solo se veía ejecutando `keel validate` a mano.
  const sinCerrar = [...obligations.open, ...obligations.stale];
  if (obligations.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ ${DECISIONS_FILE} — ${obligations.errors.length} error(es):`)));
    for (const message of obligations.errors) console.error(`  ${pc.red('•')} ${message}`);
  }
  if (sinCerrar.length > 0) {
    console.error(pc.bold(pc.red(`✘ Decisiones de diseño sin cerrar — ${sinCerrar.length}:`)));
    for (const item of sinCerrar) {
      const caducada = item.since ? pc.dim(` (aceptada en v${item.since}: el diseño cambió, reafírmala)`) : '';
      console.error(`  ${pc.red('•')} ${pc.cyan(item.id)} ${item.scope}: ${item.message}${caducada}`);
    }
    console.error(
      pc.dim(
        `  Ciérralas en el diseño, o acéptalas por escrito en ${DECISIONS_FILE} con su motivo — ver docs/design-obligations.md`
      )
    );
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

  // Snapshot del diseño dentro del proyecto: junto con el conocimiento del agente hace el repo
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

  // Snapshot de los contratos formales (/keel-docs) junto al del diseño: quien
  // clone el proyecto tiene openapi/asyncapi, las colecciones Postman y el panel
  // sin el workspace. Solo lo que produce /keel-docs — DESIGN.md e INTEGRATION.md
  // viven en el mismo directorio pero son de otras skills. También se refresca
  // siempre: el canónico es docs/<servicio>/ del workspace.
  const docsDir = path.join(projectDir, 'docs');
  if (scaffold.docs.files.length > 0) {
    const docsSnapshot = writeFiles(scaffold.docs.files, docsDir, { force: true });
    console.log(
      pc.dim(
        `Snapshot de los contratos → ${path.relative(workspace, docsDir).split(path.sep).join('/')}/ ` +
          `(${docsSnapshot.copied.length} archivo(s), refrescado en cada build)`
      )
    );
  } else {
    console.warn(
      `${pc.yellow('⚠')} El servicio aún no tiene contratos generados (docs/${manifest.service?.name}/). ` +
        `Ejecuta ${pc.cyan(`/keel-docs ${path.relative(workspace, dir).split(path.sep).join('/')}`)} y vuelve a ` +
        'lanzar el build para incluirlos en el proyecto.'
    );
  }

  console.log();
  console.log(pc.bold(pc.green('✔ Scaffolding generado.')) + pc.dim(` — ${manifest.service?.name} v${manifest.service?.version}`));
  console.log(`
Siguiente paso — la generación se completa dentro del proyecto:
  1. ${pc.cyan(`cd ${scaffold.outDir}`)}
  2. abre tu agente ahí y ejecuta ${pc.cyan(`/${SKILL}`)} ${pc.dim('(sin argumentos)')}

Orquesta el completado: código + infraestructura en paralelo, validación funcional de los
escenarios contra el servidor real y pase de calidad al final.`);
}
