import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { renderDoc } from '../lib/emit.js';

/**
 * Tronco común de `fingerprint` y `env-deps`: produce el documento, lo valida contra su schema y
 * lo imprime, lo escribe (`--out`) o lo compara con uno escrito (`--check`). Nunca escribe dentro
 * del legacy: su repo se lee y no se toca (principio 2).
 */
export function emitDoc(produce, legacy, options) {
  if (!legacy) fail('falta la ruta del repo del legacy');
  const root = path.resolve(legacy);
  let doc;
  try {
    doc = produce(root);
  } catch (err) {
    fail(err.message);
  }
  const { errors, text } = renderDoc(doc, { json: options.json });
  if (errors.length) fail(`el documento no cumple ${doc.kind}.schema.json (defecto de keel-recover):\n  ${errors.join('\n  ')}`);

  if (options.check) {
    const target = path.resolve(options.check);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== text) {
      console.error(pc.red(`✗ ${options.check} no es lo que escribe hoy keel-recover ${doc.kind === 'runtime' ? 'fingerprint' : 'env-deps'}`));
      process.exit(1);
    }
    console.error(pc.green(`✓ ${options.check} al día`));
  } else if (options.out) {
    const target = path.resolve(options.out);
    const rel = path.relative(root, target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) fail(`--out apunta dentro del legacy (${options.out}): su repo se lee y no se toca`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.error(pc.green(`✓ ${options.out}`));
  } else {
    process.stdout.write(text);
  }
  if (doc.unsupported) {
    console.error(pc.yellow(`! ${doc.unsupported}`));
    process.exit(2);
  }
}

function fail(message) {
  console.error(pc.red(`✗ ${message}`));
  process.exit(1);
}
