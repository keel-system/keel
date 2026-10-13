// El gradiente por perfil (qué variable lee cada clave y con qué default en cada perfil) es contrato del
// servidor y vive en `keel-core/gen/profile-values.js`, el mismo para todos los generadores. keel-nest
// llegó a tener doce copias con dos semánticas distintas para el perfil test, sin que nadie lo decidiera
// (incremento 1c de PLAN-KEEL-DOTNET.md): este test impide que vuelva a nacer una.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scaffoldDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scaffold');
const GRADIENT = /^(?:function\s+(envValue|envWithDefault|envRequired|cronWithDefault)\s*\(|const\s+(envValue|envWithDefault|envRequired|cronWithDefault)\s*=)/gm;

// Las únicas definiciones locales admitidas, cada una con su motivo.
const ALLOWED = {
  'mail.js:envValue':
    'entrecomilla el vacío (`username: \'\'`): el cargador de keel-nest lee un escalar vacío como nulo y ' +
    'las credenciales del SMTP son cadenas; keel-spring escribe `username: ` y Spring lo trata como ' +
    'ausente. Mismo significado (sin credencial), distinta lectura de YAML: es de la plataforma, no del contrato.'
};

test('ningún emisor define su propio gradiente por perfil: se importa de keel-core/gen/profile-values', () => {
  const found = [];
  for (const name of fs.readdirSync(scaffoldDir).filter((file) => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(scaffoldDir, name), 'utf8');
    for (const match of source.matchAll(GRADIENT)) found.push(`${name}:${match[1] ?? match[2]}`);
  }
  assert.deepEqual(found.filter((key) => !(key in ALLOWED)), []);
  for (const key of Object.keys(ALLOWED)) assert.ok(found.includes(key), `${key} ya no existe: retira su excepción`);
});
