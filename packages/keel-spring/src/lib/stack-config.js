// Elecciones tecnológicas del servicio generado, persistidas en
// services/<name>-spring/keel-stack.json (los specs quedan agnósticos de
// tecnología). Gate del patrón de referencia: si el archivo existe se
// reutiliza sin repreguntar; si no, cuestionario condicionado por las capas
// del diseño y se persiste.

import fs from 'node:fs';
import path from 'node:path';
import {
  DATABASES,
  BROKERS,
  AUTH,
  CACHES,
  STORAGE,
  STACK_DEFAULTS,
  databasesForModel,
  defaultDatabaseFor
} from './stack-catalog.js';
import { select, promptText } from './prompt.js';
import { defaultGroup, isValidPackage } from './naming.js';

export const STACK_FILE = 'keel-stack.json';

export function readStackConfig(projectDir) {
  const file = path.join(projectDir, STACK_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeStackConfig(projectDir, stack) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, STACK_FILE), JSON.stringify(stack, null, 2) + '\n');
}

// ¿El diseño usa caché en alguna operación? (única señal que necesita Redis/Valkey)
export function designUsesCache(layers) {
  const operations = layers['use-cases']?.operations ?? {};
  return Object.values(operations).some((operation) => operation?.cache);
}

function designUsesOidc(layers) {
  const protocol = layers.security?.authentication?.protocol;
  return protocol === 'oidc' || protocol === 'jwt';
}

// Cuándo aplica cada categoría del stack. Fuente única para las dos preguntas: la del
// cuestionario inicial y la de un diseño que EVOLUCIONÓ bajo un `keel-stack.json` ya
// escrito. Con dos copias, la primera categoría nueva que alguien añadiera a una sola
// dejaría a la otra sin preguntarla.
const CATEGORY_APPLIES = {
  database: (layers) => Boolean(layers.persistence),
  broker: (layers) => Boolean(layers.messaging),
  auth: designUsesOidc,
  cache: designUsesCache,
  storage: (layers) => Boolean(layers.storage)
};

/**
 * Lo que el diseño pide hoy y el stack persistido no tiene (`missing`), y lo que el stack
 * tiene y el diseño ya no pide (`stale`).
 *
 * Existe porque `keel-stack.json` se reutiliza sin repreguntar: un diseño que evoluciona
 * y añade la capa `messaging` se quedaba con `broker: null`, y lo que salía era un
 * default que nadie había elegido. Una categoría elegida a `'none'` es una elección, no
 * un hueco.
 */
export function stackDrift(stack, layers) {
  const missing = [];
  const stale = [];
  for (const [category, applies] of Object.entries(CATEGORY_APPLIES)) {
    const value = stack?.[category] ?? null;
    if (applies(layers) && value === null) missing.push(category);
    if (!applies(layers) && value !== null) stale.push(category);
  }
  return { missing, stale };
}

/**
 * Cuestionario condicional: solo pregunta por las categorías que el diseño
 * necesita (capas declaradas / uso de cache). Devuelve el stack normalizado
 * con null en las categorías que no aplican.
 *
 * Con `only` pregunta SOLO esas categorías (y no el grupo, que ya está elegido): es el
 * cuestionario de un diseño que evolucionó, y lo ya elegido no se vuelve a preguntar.
 */
export async function askStackConfig(manifest, layers, { defaults = false, only = null } = {}) {
  const stack = { group: null, database: null, broker: null, auth: null, cache: null, storage: null };
  const asks = (category) => (only ? only.includes(category) : CATEGORY_APPLIES[category](layers));

  if (!only) {
    stack.group = await promptText('¿Qué grupo (groupId) usará el proyecto? Ej. com.example', {
      defaultValue: defaultGroup(manifest),
      validate: (value) => {
        const trimmed = String(value ?? '').trim();
        if (!trimmed) return undefined; // vacío → se usa el default
        if (!isValidPackage(trimmed)) return 'Grupo inválido: usa minúsculas y segmentos separados por punto (com.example).';
      },
      defaults
    });
  }

  if (asks('database')) {
    // El modelo de almacenamiento lo decide el DISEÑO, no el stack: aquí solo se
    // elige el motor dentro del modelo que el diseño ya declaró. Con `document` la
    // lista tiene un solo elemento y select() lo devuelve sin preguntar.
    const persistenceModel = layers.persistence?.default?.model;
    stack.database = await select(
      '¿Qué base de datos usará el servicio?',
      databasesForModel(persistenceModel),
      defaultDatabaseFor(persistenceModel),
      { defaults }
    );
  }
  if (asks('broker')) {
    stack.broker = await select(
      '¿Qué broker de mensajería usará el servicio?',
      Object.values(BROKERS),
      STACK_DEFAULTS.broker,
      { defaults }
    );
  }
  if (asks('auth')) {
    stack.auth = await select(
      '¿Qué servidor de identidad de prueba se añade al docker-compose?',
      Object.values(AUTH),
      STACK_DEFAULTS.auth,
      { defaults }
    );
  }
  if (asks('cache')) {
    stack.cache = await select(
      'El diseño declara operaciones con caché. ¿Qué proveedor usar?',
      Object.values(CACHES),
      STACK_DEFAULTS.cache,
      { defaults }
    );
  }
  if (asks('storage')) {
    stack.storage = await select(
      '¿Qué object storage usará el servicio para los archivos?',
      Object.values(STORAGE),
      STACK_DEFAULTS.storage,
      { defaults }
    );
  }

  return stack;
}

// Resumen legible del stack para consola/README.
export function describeStack(stack) {
  const parts = [];
  if (stack.database) parts.push(DATABASES[stack.database]?.label ?? stack.database);
  if (stack.broker) parts.push(BROKERS[stack.broker]?.label ?? stack.broker);
  if (stack.auth && stack.auth !== 'none') parts.push(AUTH[stack.auth]?.label ?? stack.auth);
  if (stack.cache) parts.push(CACHES[stack.cache]?.label ?? stack.cache);
  if (stack.storage) parts.push(STORAGE[stack.storage]?.label ?? stack.storage);
  const infra = parts.length > 0 ? parts.join(' + ') : 'sin infraestructura externa';
  return stack.group ? `${stack.group} · ${infra}` : infra;
}
