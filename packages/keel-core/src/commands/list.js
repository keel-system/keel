import pc from 'picocolors';
import { KNOWN_GENERATORS } from '../lib/assets.js';

export function list() {
  console.log(pc.bold('Generadores conocidos (cada uno es un paquete npm con CLI propia):'));
  for (const [tech, pkg] of Object.entries(KNOWN_GENERATORS)) {
    console.log(`  ${pc.cyan(tech)}  →  ${pc.cyan(pkg)}  ${pc.dim(`(npm i -g ${pkg} && ${pkg} build specs/<servicio>)`)}`);
  }
  console.log(pc.dim('\nPara crear un generador nuevo: docs/building-a-generator.md'));
}
