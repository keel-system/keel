// Elecciones tecnológicas del servicio generado, persistidas en
// services/<name>-<tech>/keel-stack.json (los specs quedan agnósticos de tecnología).
// Si el archivo existe se reutiliza sin repreguntar; si no, cuestionario condicionado por las
// capas del diseño y se persiste.
//
// NEUTRAL (keel-core/gen): las categorías, cuándo aplica cada una, sus opciones y sus defaults
// son las mismas para cualquier generador, porque la infraestructura es la misma
// (infra-catalog.js). Lo único propio de un lenguaje es la pregunta de IDENTIDAD del proyecto
// —el groupId de Java, por ejemplo—, que cada generador pasa como `identity`.

import fs from 'node:fs';
import path from 'node:path';
import {
  DATABASES,
  BROKERS,
  AUTH,
  CACHES,
  STORAGE,
  PAYMENT_GATEWAYS,
  TELEMETRY,
  STACK_DEFAULTS,
  databasesForModel,
  defaultDatabaseFor
} from './infra-catalog.js';
import { select } from './prompt.js';

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
  storage: (layers) => Boolean(layers.storage),
  paymentGateway: (layers) => Boolean(layers.payments)
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
 * Con `only` pregunta SOLO esas categorías (y no la identidad, que ya está elegida): es el
 * cuestionario de un diseño que evolucionó, y lo ya elegido no se vuelve a preguntar.
 *
 * `identity({ defaults })`, si el generador la pasa, pregunta lo que el proyecto necesita por su
 * lenguaje y devuelve las claves que añade al stack (`{ group }` en keel-spring). Sus claves van
 * PRIMERO en el archivo, que es como siempre se ha escrito.
 */
export async function askStackConfig(manifest, layers, { defaults = false, only = null, telemetry = null, identity = null } = {}) {
  const stack = {
    ...(identity ? await identityDefaults(identity, only, defaults) : {}),
    database: null,
    broker: null,
    auth: null,
    cache: null,
    storage: null,
    paymentGateway: null,
    telemetry: null
  };
  const asks = (category) => (only ? only.includes(category) : CATEGORY_APPLIES[category](layers));

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
  if (asks('paymentGateway')) {
    // La pasarela la elige el stack, no el diseño: la capa payments no nombra ninguna. Que la
    // elegida cubra lo que el diseño exige lo comprueba el build de cada generador.
    stack.paymentGateway = await select(
      '¿Con qué pasarela de pago se cobra?',
      Object.values(PAYMENT_GATEWAYS),
      STACK_DEFAULTS.paymentGateway,
      { defaults }
    );
  }
  // La telemetría no la pide ninguna capa: se pregunta siempre en el cuestionario inicial y
  // nunca en el de un diseño que evolucionó (`only`), porque no hay deriva posible — ver
  // `normalizeTelemetry`. Cambiarla después es `build --telemetry <otel|none>`.
  if (!only && telemetry != null) {
    // Ya elegida por flag (`--telemetry`): no se pregunta.
    stack.telemetry = normalizeTelemetry(telemetry);
  } else if (!only) {
    stack.telemetry = await select(
      '¿Añadir telemetría al servidor (OpenTelemetry vía colector)?',
      Object.values(TELEMETRY),
      STACK_DEFAULTS.telemetry,
      { defaults }
    );
  }

  return stack;
}

// La identidad solo se pregunta en el cuestionario inicial; en el de un diseño que evolucionó
// (`only`) sus claves salen a null, como siempre salió el grupo, y el build conserva las del
// stack persistido.
async function identityDefaults(identity, only, defaults) {
  if (only) return Object.fromEntries(Object.keys(await identity({ defaults: true })).map((key) => [key, null]));
  return identity({ defaults });
}

/**
 * La telemetría elegida, con un keel-stack.json anterior a la opción leído como `none`.
 *
 * No es deriva y no se repregunta: ninguna capa del diseño la pide, así que su ausencia no es un
 * hueco sino la elección por defecto. Un valor que el catálogo no conoce se rechaza en voz alta
 * —aceptarlo en silencio generaría un servidor sin telemetría con un stack que dice tenerla—.
 */
export function normalizeTelemetry(value) {
  if (value == null) return STACK_DEFAULTS.telemetry;
  if (!TELEMETRY[value]) {
    throw new Error(`Telemetría '${value}' no soportada. Opciones: ${Object.keys(TELEMETRY).join(', ')}.`);
  }
  return value;
}

// Resumen legible del stack para consola/README. `stack.group`, si lo hay, va delante.
export function describeStack(stack) {
  const parts = [];
  if (stack.database) parts.push(DATABASES[stack.database]?.label ?? stack.database);
  if (stack.broker) parts.push(BROKERS[stack.broker]?.label ?? stack.broker);
  if (stack.auth && stack.auth !== 'none') parts.push(AUTH[stack.auth]?.label ?? stack.auth);
  if (stack.cache) parts.push(CACHES[stack.cache]?.label ?? stack.cache);
  if (stack.storage) parts.push(STORAGE[stack.storage]?.label ?? stack.storage);
  if (stack.paymentGateway) parts.push(PAYMENT_GATEWAYS[stack.paymentGateway]?.label ?? stack.paymentGateway);
  if (stack.telemetry && stack.telemetry !== 'none') parts.push(TELEMETRY[stack.telemetry]?.label ?? stack.telemetry);
  const infra = parts.length > 0 ? parts.join(' + ') : 'sin infraestructura externa';
  return stack.group ? `${stack.group} · ${infra}` : infra;
}

/**
 * Normaliza el stack: defaults para lo que el diseño necesita y no fue elegido (p. ej. tests o
 * scaffolding sin cuestionario), null para lo que no aplica. Las claves de identidad del lenguaje
 * (el grupo de Java) las añade cada generador delante.
 */
export function resolveStack(stack, layers) {
  const protocol = layers.security?.authentication?.protocol;
  // Un motor que el catálogo no conoce se rechaza en voz alta. El caso real es un
  // `keel-stack.json` con un motor retirado —H2 lo estuvo hasta que se vio que tres de sus
  // mecanismos no se podían probar—: sin esto, `DATABASES[...]` sale `undefined`, el modelo
  // cae al `kind` relacional por defecto y el proyecto se genera a medias con la mitad de la
  // infraestructura sin resolver. Un fallo así aparece lejísimos de su causa.
  if (stack?.database && !DATABASES[stack.database]) {
    throw new Error(
      `El motor '${stack.database}' no está soportado. Los del catálogo son: ${Object.keys(DATABASES).join(', ')}. ` +
        `Si viene de un keel-stack.json anterior, elige uno de esos y vuelve a lanzar el build.`
    );
  }
  // Igual que con el motor: una pasarela que el catálogo no conoce se rechaza en voz alta.
  if (stack?.paymentGateway && !PAYMENT_GATEWAYS[stack.paymentGateway]) {
    throw new Error(
      `La pasarela '${stack.paymentGateway}' no está soportada. Las del catálogo son: ${Object.keys(PAYMENT_GATEWAYS).join(', ')}.`
    );
  }
  return {
    // El default sigue al modelo que declara el diseño: sin esto, un diseño
    // `document` sin stack explícito (tests, scaffolding sin cuestionario)
    // generaría el modelo relacional en silencio contra una base que no lo entiende.
    database: layers.persistence ? (stack?.database ?? defaultDatabaseFor(layers.persistence?.default?.model)) : null,
    broker: layers.messaging ? (stack?.broker ?? STACK_DEFAULTS.broker) : null,
    auth: protocol === 'oidc' || protocol === 'jwt' ? (stack?.auth ?? STACK_DEFAULTS.auth) : null,
    cache: designUsesCache(layers) ? (stack?.cache ?? STACK_DEFAULTS.cache) : null,
    storage: layers.storage ? (stack?.storage ?? STACK_DEFAULTS.storage) : null,
    paymentGateway: layers.payments ? (stack?.paymentGateway ?? STACK_DEFAULTS.paymentGateway) : null,
    // No depende del diseño: siempre tiene valor, y un stack anterior a la opción es `none`.
    telemetry: normalizeTelemetry(stack?.telemetry)
  };
}
