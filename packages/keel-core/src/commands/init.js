import pc from 'picocolors';
import { coreDir } from '../lib/assets.js';
import { copyTree } from '../lib/copy.js';

export function init({ force = false } = {}) {
  const target = process.cwd();
  const { copied, skipped } = copyTree(coreDir, target, {
    force,
    renames: { gitignore: '.gitignore' }
  });

  for (const file of copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);

  console.log();
  if (copied.length === 0 && skipped.length > 0) {
    console.log(pc.yellow('El workspace ya estaba inicializado; no se sobrescribió nada (usa --force para sobrescribir).'));
    return;
  }

  console.log(pc.bold(pc.green('✔ Workspace Keel inicializado.')));
  if (skipped.length > 0) {
    console.log(pc.yellow(`  ${skipped.length} archivo(s) existente(s) se dejaron intactos (usa --force para sobrescribir).`));
  }
  console.log(`
Próximos pasos:
  1. ${pc.cyan('keel new mi-servicio')}    crea specs/mi-servicio/ (manifiesto + capas obligatorias)
  2. Abre Claude Code aquí y ejecuta ${pc.cyan('/keel-design specs/mi-servicio')}
  3. ${pc.cyan('keel validate specs/mi-servicio')}
  4. Instala el generador de tu tecnología: ${pc.cyan('npm i -g keel-springboot')} (${pc.cyan('keel list')} para ver los conocidos)
  5. ${pc.cyan('keel-springboot build specs/mi-servicio')}  instala la skill del generador y valida el diseño
  6. En Claude Code: ${pc.cyan('/keel-generate-spring specs/mi-servicio')}

La metodología completa está en ${pc.cyan('docs/methodology.md')}.`);
}
