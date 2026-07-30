import pc from 'picocolors';
import { CUSTOMIZABLE_PAYLOAD, coreDir, packageVersion } from '../lib/assets.js';
import { copyTree, diffTree } from '../lib/copy.js';

const RENAMES = { gitignore: '.gitignore', gitattributes: '.gitattributes' };

/**
 * Comprueba si el payload del workspace sigue al día respecto a la CLI instalada,
 * sin escribir nada. Los schemas y docs del workspace son **copias**: `keel
 * validate` usa siempre los del paquete (`schemaPathFor`), así que una copia
 * desfasada no invalida nada — desorienta a quien lee `schema/` o `docs/dsl/`, y
 * al editor que los usa para autocompletar. De ahí que esto sea detección.
 */
export function checkPayload() {
  const target = process.cwd();
  const { stale, missing } = diffTree(coreDir, target, {
    renames: RENAMES,
    ignore: CUSTOMIZABLE_PAYLOAD
  });

  if (stale.length === 0 && missing.length === 0) {
    console.log(pc.green(`✔ El payload del workspace está al día con keel-core ${packageVersion()}.`));
    return;
  }

  if (missing.length > 0) {
    console.error(pc.bold(pc.yellow(`${missing.length} archivo(s) del payload no existen en este workspace:`)));
    for (const file of missing) console.error(`  ${pc.yellow('○')} ${file}`);
  }
  if (stale.length > 0) {
    console.error(pc.bold(pc.yellow(`${stale.length} archivo(s) del payload quedaron atrás respecto a keel-core ${packageVersion()}:`)));
    for (const file of stale) console.error(`  ${pc.yellow('~')} ${file}`);
  }
  console.error(pc.dim(`\n  Ponlos al día con \`keel init --force\`.`));
  console.error(
    pc.dim(`  No afecta a la validación (usa los schemas de la CLI), pero sí a lo que leen las personas y el editor.`)
  );
  console.error(pc.dim(`  Se ignoran a propósito los archivos que el workspace puede editar: ${CUSTOMIZABLE_PAYLOAD.join(', ')}.`));
  process.exitCode = 1;
}

export function init({ force = false, check = false } = {}) {
  if (check) {
    checkPayload();
    return;
  }

  const target = process.cwd();
  // preserve: los archivos que el workspace reescribe a propósito (la portada de un registry,
  // su CLAUDE.md) no se pisan ni con --force. Es la misma lista que checkPayload() ignora.
  const { copied, skipped, preserved } = copyTree(coreDir, target, {
    force,
    renames: RENAMES,
    preserve: CUSTOMIZABLE_PAYLOAD
  });

  for (const file of copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);
  for (const file of preserved) console.log(`  ${pc.cyan('=')} ${file} ${pc.dim('(es tuyo, no se sobrescribe)')}`);

  console.log();
  // Los archivos existentes nunca se pisan sin --force. Al actualizar keel-core eso deja el
  // workspace con schemas y docs de la versión anterior (un manifiesto con una versión del DSL
  // más nueva sería rechazado por su propio schema), así que aquí se dice explícitamente.
  const updateHint = pc.dim(
    '  Tras actualizar keel-core, ejecuta `keel init --force` para poner al día schemas, plantillas, docs y skills\n' +
      '  del workspace (tus specs/ y docs/<servicio>/ no se tocan: no forman parte del payload,\n' +
      `  y ${CUSTOMIZABLE_PAYLOAD.join(', ')} se conservan aunque uses --force).\n` +
      '  `keel init --check` dice, sin escribir, si alguna copia quedó atrás.'
  );

  if (copied.length === 0 && skipped.length > 0) {
    console.log(pc.yellow('El workspace ya estaba inicializado; no se sobrescribió nada (usa --force para sobrescribir).'));
    console.log(updateHint);
    return;
  }

  console.log(pc.bold(pc.green('✔ Workspace Keel inicializado.')));
  if (preserved.length > 0) {
    console.log(pc.cyan(`  ${preserved.length} archivo(s) tuyo(s) se conservaron: ${preserved.join(', ')}.`));
  }
  if (skipped.length > 0) {
    console.log(pc.yellow(`  ${skipped.length} archivo(s) existente(s) se dejaron intactos (usa --force para sobrescribir).`));
    console.log(updateHint);
  }
  console.log(`
Próximos pasos:
  1. ${pc.cyan('keel new mi-servicio')}    crea specs/mi-servicio/ (manifiesto + capas obligatorias)
  2. Abre Claude Code aquí y ejecuta ${pc.cyan('/keel-design specs/mi-servicio')}
  3. ${pc.cyan('keel validate specs/mi-servicio')}
  4. Instala el generador de tu tecnología: ${pc.cyan('npm i -g keel-spring')} (${pc.cyan('keel list')} para ver los conocidos)
  5. ${pc.cyan('keel-spring build specs/mi-servicio')}  elige el stack y genera services/mi-servicio-spring/
  6. ${pc.cyan('cd services/mi-servicio-spring')}
  7. Abre Claude Code ahí y ejecuta ${pc.cyan('/keel-generate-spring')} ${pc.dim('(sin argumentos)')}

La metodología completa está en ${pc.cyan('docs/methodology.md')}.`);
}
