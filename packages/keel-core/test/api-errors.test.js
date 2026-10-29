// Los textos de la respuesta de error de la API (keel-core/gen/api-errors.js): una entrada por clase base, y
// ningún generador los vuelve a escribir a mano. Estaban copiados en keel-spring y keel-nest; una copia que se
// queda atrás responde con otras palabras al mismo fallo, y los escenarios afirman `error` y `message`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_BASES } from '../src/lib/gen/error-bases.js';
import { DOMAIN_ERROR_RESPONSES, FRAMEWORK_RESPONSES, domainErrorResponses, missingParameterMessage } from '../src/lib/gen/api-errors.js';

const packages = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('cada clase base de la jerarquía tiene su texto de respuesta, en el orden de ERROR_BASES', () => {
  assert.deepEqual(Object.keys(DOMAIN_ERROR_RESPONSES), ERROR_BASES.map((base) => base.name));
  assert.deepEqual(
    domainErrorResponses().map(({ name, http }) => [name, http]),
    ERROR_BASES.map(({ name, http }) => [name, http])
  );
});

test('el mensaje del parámetro ausente lleva su nombre', () => {
  assert.equal(missingParameterMessage('q'), "Falta el parámetro 'q' en la petición");
});

/** Los .js de `src/` de un paquete hermano. */
function sources(pkg) {
  const root = path.join(packages, pkg, 'src');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.js')).map((file) => path.join(root, file));
}

test('ningún generador escribe a mano un texto de la respuesta de error', () => {
  const texts = [
    ...Object.values(DOMAIN_ERROR_RESPONSES).map((entry) => entry.fallback),
    ...Object.values(FRAMEWORK_RESPONSES).map((entry) => entry.message.split('{name}')[0])
  ];
  const found = [];
  for (const pkg of ['keel-spring', 'keel-nest', 'keel-dotnet', 'keel-go']) {
    for (const file of sources(pkg)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const text of texts) if (content.includes(`'${text}`) || content.includes(`"${text}`)) found.push(`${path.relative(packages, file)}: ${text}`);
    }
  }
  assert.deepEqual(found, []);
});
