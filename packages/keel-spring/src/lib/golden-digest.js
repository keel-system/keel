// Huella de lo que genera keel-spring, para demostrar que un refactor no cambia nada.
//
// Existe por el incremento 1 de PLAN-KEEL-NEST.md: mover a keel-core la interpretación
// neutral del diseño (model.js y compañía) es un refactor que NO debe cambiar ni un byte del
// proyecto generado, y la suite no basta para demostrarlo — compara rasgos, no el árbol, así que
// un cambio en un archivo que ningún test nombra pasaría en verde.
//
// No es un árbol congelado ni un test de `npm test`: un cambio INTENCIONAL del generador lo
// pondría rojo y acabaría regenerándose a ciegas (building-a-generator.md § Fixtures). Es una
// línea base que se toma ANTES del refactor y se compara DESPUÉS, con `--check`.
//
// Solo usa `planService`, la mitad pura de `build`: renderiza en memoria, sin escribir nada.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { planService } from '../scaffold/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, '..', '..', '..', '..', 'fixtures', 'designs');
export const GOLDEN_FILE = path.join(here, '..', '..', 'test', 'golden', 'digests.json');
export const GOLDEN_SCHEMA = 1;

// planService solo usa el workspace para listar los contratos de /keel-docs (docs/<servicio>/).
// Una ruta que no existe garantiza que la huella no depende de lo que haya en la máquina.
const NO_WORKSPACE = path.join(here, '__golden-without-workspace__');

const BROKERS = ['kafka', 'rabbitmq', 'snssqs'];

/**
 * Las combinaciones fixture × stack. Son las de `npm run compile-check` —cada eje que ahí
 * tiene Java propio (broker, motor, identidad, telemetría, pasarela)— más TODAS las fixtures con
 * el stack por defecto, para que ninguna quede fuera de la línea base.
 */
export function goldenCombos(fixtures = listFixtures()) {
  const combos = [];
  const add = (fixture, stack = {}) => combos.push({ fixture, stack });

  for (const fixture of fixtures) add(fixture);

  // compile-check sin --broker cruza los tres brokers y, si la fixture es relacional, MySQL.
  for (const fixture of ['catalog-extended', 'job-dispatch', 'payout-runs']) {
    for (const broker of BROKERS) add(fixture, { broker });
    add(fixture, { broker: 'kafka', database: 'mysql' });
  }
  for (const broker of BROKERS) add('job-dispatch', { broker, database: 'oracle' });

  add('asset-vault', { broker: 'snssqs' });
  add('asset-vault', { broker: 'kafka', auth: 'cognito' });
  add('asset-vault', { broker: 'snssqs', telemetry: 'otel' });
  add('notification-mailer', { broker: 'snssqs' });
  add('notification-mailer', { broker: 'kafka', auth: 'cognito' });
  add('notification-mailer', { broker: 'kafka', telemetry: 'otel' });
  add('notification-mailer-mongo', { broker: 'kafka' });
  add('job-dispatch-mongo', { broker: 'kafka' });
  add('stock-reservation', { broker: 'kafka' });
  add('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  add('metering-digest', { broker: 'kafka' });
  add('profile-directory', { broker: 'kafka' });
  add('payment-checkout', { broker: 'rabbitmq', paymentGateway: 'stripe' });
  add('payment-checkout', { broker: 'rabbitmq', paymentGateway: 'mercadopago' });

  const seen = new Set();
  return combos
    .map((combo) => ({ ...combo, key: comboKey(combo) }))
    .filter((combo) => (seen.has(combo.key) ? false : seen.add(combo.key)))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function comboKey({ fixture, stack }) {
  const axes = Object.keys(stack)
    .sort()
    .map((axis) => `${axis}=${stack[axis]}`);
  return axes.length > 0 ? `${fixture} [${axes.join(',')}]` : `${fixture} [default]`;
}

export function listFixtures(dir = FIXTURES_DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'service.keel.yaml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Huella de una combinación: { <ruta>: <sha256> }, ordenada por ruta. El bit de ejecución
 * forma parte de lo generado (un script que pierde el +x deja de lanzarse), así que entra en
 * la huella con el prefijo `x:`.
 */
export function digestCombo({ fixture, stack }, fixturesDir = FIXTURES_DIR) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  if (errors.length > 0) throw new Error(`${fixture}: la fixture no carga:\n  ${errors.join('\n  ')}`);
  const { files } = planService({ manifest, layers, workspace: NO_WORKSPACE, stack });
  const digests = {};
  for (const entry of files) {
    const rel = entry.path.split(path.sep).join('/');
    if (rel in digests) throw new Error(`${comboKey({ fixture, stack })}: ruta emitida dos veces: ${rel}`);
    const bytes = entry.sourceFile ? fs.readFileSync(entry.sourceFile) : Buffer.from(entry.content ?? '', 'utf8');
    // 64 bits bastan para detectar un cambio y dividen el archivo de la línea base por dos.
    const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    digests[rel] = entry.executable ? `x:${digest}` : digest;
  }
  return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)));
}

/** La línea base entera. Silencia la consola: los avisos del modelo no son parte de la huella. */
export function computeGolden(combos = goldenCombos(), fixturesDir = FIXTURES_DIR) {
  const result = {};
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    for (const combo of combos) result[combo.key] = digestCombo(combo, fixturesDir);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return { schema: GOLDEN_SCHEMA, combos: result };
}

/**
 * Compara dos líneas base. Devuelve una lista de diferencias legibles, vacía si son idénticas:
 * combinaciones que aparecen o desaparecen, y por combinación los archivos nuevos, retirados
 * y cambiados.
 */
export function compareGolden(expected, actual) {
  const diffs = [];
  if (expected.schema !== actual.schema) {
    diffs.push(`schema: ${expected.schema} → ${actual.schema}`);
    return diffs;
  }
  const keys = new Set([...Object.keys(expected.combos), ...Object.keys(actual.combos)]);
  for (const key of [...keys].sort()) {
    const before = expected.combos[key];
    const after = actual.combos[key];
    if (!before) {
      diffs.push(`${key}: combinación nueva`);
      continue;
    }
    if (!after) {
      diffs.push(`${key}: combinación retirada`);
      continue;
    }
    const files = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const file of [...files].sort()) {
      if (!(file in after)) diffs.push(`${key}: retirado ${file}`);
      else if (!(file in before)) diffs.push(`${key}: nuevo ${file}`);
      else if (before[file] !== after[file]) diffs.push(`${key}: cambiado ${file}`);
    }
  }
  return diffs;
}

export function serializeGolden(golden) {
  return `${JSON.stringify(golden, null, 1)}\n`;
}
