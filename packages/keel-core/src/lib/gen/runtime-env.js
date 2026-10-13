// Las VARIABLES DE ENTORNO del servidor generado que no dependen del lenguaje: su nombre, su gradiente por
// perfil y, cuando no sale del diseño, su valor por defecto. Es contrato de operación —quien despliega el
// servicio exporta las mismas variables sea cual sea el generador— y hasta el incremento 1c de
// PLAN-KEEL-DOTNET.md se escribía a mano en cada emisor de keel-spring y de keel-nest: nombres, gradientes y
// defaults copiados («la misma que siembra keel-spring»), que coincidían porque alguien los copió bien.
//
// Dos clases de entrada:
//   - con `default`: el valor lo fija el catálogo, y un emisor que intente pasar otro FALLA — dos generadores
//     con dos defaults para la misma variable es exactamente lo que este módulo existe para impedir;
//   - sin `default`: el valor sale del diseño o del stack (la URL de la base de datos, la audiencia, el
//     issuer del realm) y lo pone el emisor; el catálogo fija el nombre y el gradiente.
//
// Lo que es de UNA plataforma (el `FLYWAY_ENABLED` de keel-spring, los intervalos de reconexión del cliente
// de Kafka de keel-nest) no está aquí: se queda en su generador. Las que ya viven en otro catálogo neutral
// (parámetros del outbox, del barrido, de la pasarela) tampoco: allí ya tienen su nombre y su default.
//
// Los puertos locales son los que publica la `infra/` de prueba (`infra-catalog.js`); lo vigila
// `test/runtime-env.test.js`.

import { envRequired, envValue, envWithDefault } from './profile-values.js';

const GRADIENTS = { value: envValue, default: envWithDefault, required: envRequired };

/** Clave de API del perfil local (la siembra la infra de prueba y la usa el arnés). */
export const LOCAL_API_KEY = 'local-dev-api-key';

/** Orígenes CORS del perfil local: los puertos de dev habituales de una SPA (Create React App / Next.js y Vite). */
export const LOCAL_CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173';

export const RUNTIME_ENV = {
  // Base de datos.
  DB_URL: { gradient: 'value' },
  DB_USERNAME: { gradient: 'value' },
  DB_PASSWORD: { gradient: 'value' },
  DB_POOL_MAX_SIZE: { gradient: 'default', default: 10 },
  DB_POOL_CONNECTION_TIMEOUT_MS: { gradient: 'default', default: 5000 },
  DB_POOL_MAX_LIFETIME_MS: { gradient: 'default', default: 1800000 },
  DB_TRANSACTION_TIMEOUT: { gradient: 'default', default: '30s' },

  // Brokers.
  KAFKA_BOOTSTRAP_SERVERS: { gradient: 'value', default: 'localhost:9092' },
  RABBITMQ_HOST: { gradient: 'value', default: 'localhost' },
  RABBITMQ_PORT: { gradient: 'value', default: 5672 },
  RABBITMQ_USERNAME: { gradient: 'value', default: 'guest' },
  RABBITMQ_PASSWORD: { gradient: 'value', default: 'guest' },
  RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS: { gradient: 'default', default: 5000 },
  AWS_REGION: { gradient: 'value', default: 'us-east-1' },
  AWS_ACCESS_KEY_ID: { gradient: 'value', default: 'test' },
  AWS_SECRET_ACCESS_KEY: { gradient: 'value', default: 'test' },
  AWS_SNS_ENDPOINT: { gradient: 'value', default: 'http://localhost:4566' },
  AWS_SQS_ENDPOINT: { gradient: 'value', default: 'http://localhost:4566' },
  MESSAGING_DESTINATION: { gradient: 'default' },

  // Caché.
  REDIS_HOST: { gradient: 'value', default: 'localhost' },
  REDIS_PORT: { gradient: 'value', default: 6379 },

  // Almacenamiento.
  STORAGE_ENDPOINT: { gradient: 'value', default: 'http://localhost:9000' },
  STORAGE_PUBLIC_BASE_URL: { gradient: 'value', default: 'http://localhost:9000' },
  STORAGE_REGION: { gradient: 'value', default: 'us-east-1' },
  STORAGE_ACCESS_KEY: { gradient: 'value' },
  STORAGE_SECRET_KEY: { gradient: 'value' },

  // Correo.
  MAIL_HOST: { gradient: 'value', default: 'localhost' },
  MAIL_PORT: { gradient: 'value', default: 1025 },
  MAIL_USERNAME: { gradient: 'value', default: '' },
  MAIL_PASSWORD: { gradient: 'value', default: '' },
  MAIL_SMTP_AUTH: { gradient: 'default', default: true },
  MAIL_SMTP_STARTTLS: { gradient: 'default', default: true },
  MAIL_CONNECT_TIMEOUT_MS: { gradient: 'default', default: 5000 },
  MAIL_READ_TIMEOUT_MS: { gradient: 'default', default: 5000 },
  MAIL_WRITE_TIMEOUT_MS: { gradient: 'default', default: 5000 },
  MAIL_SENDER: { gradient: 'value' },
  MAIL_SENDER_FALLBACK: { gradient: 'value' },
  MAIL_REPLY_TO: { gradient: 'value' },

  // Seguridad.
  OAUTH2_ISSUER_URI: { gradient: 'value' },
  SECURITY_AUDIENCE: { gradient: 'value' },
  SECURITY_API_KEY: { gradient: 'required', default: LOCAL_API_KEY },
  SECURITY_CORS_ALLOWED_ORIGINS: { gradient: 'required', default: LOCAL_CORS_ORIGINS },

  // Pagos.
  PAYMENT_GATEWAY_CONNECT_TIMEOUT: { gradient: 'default', default: '2s' },
  PAYMENT_GATEWAY_READ_TIMEOUT: { gradient: 'default', default: '10s' },
  PAYMENT_NOTICE_TOLERANCE_SECONDS: { gradient: 'default' },

  // Operación y telemetría.
  MANAGEMENT_PORT: { gradient: 'default', default: 8081 },
  DEPLOYMENT_ENVIRONMENT: { gradient: 'default' },
  LOG_FORMAT: { gradient: 'default', default: 'ecs' },
  LOG_LEVEL_ROOT: { gradient: 'default' },
  LOG_LEVEL_APP: { gradient: 'default' },
  TRACING_SAMPLING_PROBABILITY: { gradient: 'default' }
};

/** El default del catálogo de una variable (lanza si no lo tiene: entonces lo pone el emisor). */
export function runtimeDefault(name) {
  const entry = entryOf(name);
  if (!('default' in entry)) throw new Error(`runtime-env: ${name} no tiene default en el catálogo; su valor sale del diseño`);
  return entry.default;
}

/**
 * Cómo se escribe la variable `name` en la configuración del perfil `profile`. Con default en el catálogo,
 * `value` no se pasa; sin él, es obligatorio.
 */
export function envFor(name, profile, value) {
  const entry = entryOf(name);
  if ('default' in entry) {
    if (value !== undefined) throw new Error(`runtime-env: ${name} tiene default en el catálogo (${JSON.stringify(entry.default)}); el emisor no puede poner otro`);
    return GRADIENTS[entry.gradient](profile, name, entry.default);
  }
  if (value === undefined) throw new Error(`runtime-env: ${name} no tiene default en el catálogo; el emisor tiene que poner el valor`);
  return GRADIENTS[entry.gradient](profile, name, value);
}

function entryOf(name) {
  const entry = RUNTIME_ENV[name];
  if (!entry) throw new Error(`runtime-env: variable desconocida ${name} (¿es de una plataforma? entonces no va en el catálogo neutral)`);
  return entry;
}
