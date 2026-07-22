import pc from 'picocolors';
import { KNOWN_GENERATORS } from '../lib/assets.js';

// Deprecado: los generadores dejaron de venir empaquetados en keel-core.
// Cada uno es un paquete npm con CLI propia (ej. keel-springboot).
export function add(tech) {
  const pkg = KNOWN_GENERATORS[tech];
  console.error(pc.yellow('`keel add` está deprecado: los generadores ahora son paquetes independientes.'));
  if (pkg) {
    console.error(`Instala el generador y prepara el workspace con su propia CLI:`);
    console.error(`  ${pc.cyan(`npm i -g ${pkg}`)}`);
    console.error(`  ${pc.cyan(`${pkg} build specs/<servicio>`)}`);
  } else {
    console.error(`No hay un generador conocido para "${tech}". Consulta ${pc.cyan('keel list')}.`);
  }
  process.exitCode = 1;
}
