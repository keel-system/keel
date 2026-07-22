// Elecciones tecnológicas del servicio generado, persistidas en
// services/<name>-spring/keel-stack.json (los specs quedan agnósticos de
// tecnología). Gate del patrón de referencia: si el archivo existe se
// reutiliza sin repreguntar; si no, cuestionario condicionado por las capas
// del diseño y se persiste.

import fs from 'node:fs';
import path from 'node:path';
import { DATABASES, BROKERS, AUTH, CACHES, STORAGE, STACK_DEFAULTS } from './stack-catalog.js';
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

/**
 * Cuestionario condicional: solo pregunta por las categorías que el diseño
 * necesita (capas declaradas / uso de cache). Devuelve el stack normalizado
 * con null en las categorías que no aplican.
 */
export async function askStackConfig(manifest, layers, { defaults = false } = {}) {
  const stack = { group: null, database: null, broker: null, auth: null, cache: null, storage: null };

  stack.group = await promptText('¿Qué grupo (groupId) usará el proyecto? Ej. com.example', {
    defaultValue: defaultGroup(manifest),
    validate: (value) => {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return undefined; // vacío → se usa el default
      if (!isValidPackage(trimmed)) return 'Grupo inválido: usa minúsculas y segmentos separados por punto (com.example).';
    },
    defaults
  });

  if (layers.persistence) {
    stack.database = await select(
      '¿Qué base de datos usará el servicio?',
      Object.values(DATABASES),
      STACK_DEFAULTS.database,
      { defaults }
    );
  }
  if (layers.messaging) {
    stack.broker = await select(
      '¿Qué broker de mensajería usará el servicio?',
      Object.values(BROKERS),
      STACK_DEFAULTS.broker,
      { defaults }
    );
  }
  if (designUsesOidc(layers)) {
    stack.auth = await select(
      '¿Añadir Keycloak al docker-compose como servidor de identidad de prueba?',
      Object.values(AUTH),
      STACK_DEFAULTS.auth,
      { defaults }
    );
  }
  if (designUsesCache(layers)) {
    stack.cache = await select(
      'El diseño declara operaciones con caché. ¿Qué proveedor usar?',
      Object.values(CACHES),
      STACK_DEFAULTS.cache,
      { defaults }
    );
  }
  if (layers.storage) {
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
