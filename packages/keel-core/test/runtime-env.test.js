// El catálogo de variables de entorno del servidor: un emisor no puede poner otro default que el del
// catálogo ni olvidar el valor de una variable que no lo tiene, y los valores LOCALES apuntan a lo que de
// verdad publica la infra/ de prueba — un puerto que no casa no falla al generar, falla al arrancar en local.

import test from 'node:test';
import assert from 'node:assert/strict';
import { envFor, runtimeDefault, RUNTIME_ENV, LOCAL_API_KEY, LOCAL_CORS_ORIGINS } from '../src/lib/gen/runtime-env.js';
import { BROKERS, CACHES, LOCAL_AWS_ENV, MAIL_SINK, STORAGE } from '../src/lib/gen/infra-catalog.js';

test('con default en el catálogo, envFor aplica su gradiente y rechaza otro valor', () => {
  assert.equal(envFor('DB_POOL_MAX_SIZE', 'local'), '10');
  assert.equal(envFor('DB_POOL_MAX_SIZE', 'production'), '${DB_POOL_MAX_SIZE:10}');
  assert.equal(envFor('RABBITMQ_HOST', 'production'), '${RABBITMQ_HOST}');
  assert.equal(envFor('SECURITY_API_KEY', 'develop'), '${SECURITY_API_KEY}');
  assert.equal(envFor('SECURITY_API_KEY', 'test'), LOCAL_API_KEY);
  assert.throws(() => envFor('DB_POOL_MAX_SIZE', 'local', 20), /tiene default en el catálogo/);
});

test('sin default en el catálogo, el valor lo pone el emisor y es obligatorio', () => {
  assert.equal(envFor('DB_URL', 'develop', 'jdbc:postgresql://localhost:5432/x'), '${DB_URL:jdbc:postgresql://localhost:5432/x}');
  assert.equal(envFor('MAIL_SENDER', 'local', 'no-reply@acme.test'), 'no-reply@acme.test');
  assert.throws(() => envFor('DB_URL', 'local'), /el emisor tiene que poner el valor/);
  assert.throws(() => runtimeDefault('DB_URL'), /no tiene default/);
});

test('con default por perfil, envFor lo toma del perfil y tampoco admite otro', () => {
  assert.equal(envFor('LOG_LEVEL_ROOT', 'local'), 'INFO');
  assert.equal(envFor('LOG_LEVEL_ROOT', 'production'), '${LOG_LEVEL_ROOT:WARN}');
  assert.equal(envFor('LOG_LEVEL_APP', 'develop'), '${LOG_LEVEL_APP:DEBUG}');
  assert.equal(runtimeDefault('LOG_LEVEL_APP', 'production'), 'INFO');
  assert.throws(() => runtimeDefault('LOG_LEVEL_APP'), /depende del perfil/);
  assert.throws(() => envFor('LOG_LEVEL_ROOT', 'local', 'TRACE'), /tiene default en el catálogo/);
});

test('una variable fuera del catálogo no se puede escribir con él', () => {
  assert.throws(() => envFor('FLYWAY_ENABLED', 'local'), /variable desconocida/);
});

test('cada entrada declara un gradiente conocido, y los nombres son de variable de entorno', () => {
  for (const [name, entry] of Object.entries(RUNTIME_ENV)) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, name);
    assert.ok(['value', 'default', 'required'].includes(entry.gradient), `${name}: gradiente ${entry.gradient}`);
  }
  assert.equal(runtimeDefault('SECURITY_CORS_ALLOWED_ORIGINS'), LOCAL_CORS_ORIGINS);
});

// El puerto que la infra/ de prueba publica en el host para un servicio del compose.
function publishedPorts(composeServices) {
  return Object.values(composeServices()).flatMap((service) => (service.ports ?? []).map((mapping) => Number(String(mapping).split(':')[0])));
}

test('los valores locales apuntan a lo que publica la infra/ de prueba', () => {
  const portOf = (value) => Number(String(value).match(/:(\d+)$/)?.[1] ?? value);
  const cases = [
    ['KAFKA_BOOTSTRAP_SERVERS', BROKERS.kafka.composeServices],
    ['RABBITMQ_PORT', BROKERS.rabbitmq.composeServices],
    ['AWS_SNS_ENDPOINT', BROKERS.snssqs.composeServices],
    ['AWS_SQS_ENDPOINT', BROKERS.snssqs.composeServices],
    ['REDIS_PORT', CACHES.redis.composeServices],
    ['STORAGE_ENDPOINT', STORAGE.minio.composeServices]
  ];
  for (const [name, compose] of cases) {
    const port = portOf(runtimeDefault(name));
    assert.ok(publishedPorts(compose).includes(port), `${name}: el puerto ${port} no lo publica la infra/ de prueba`);
  }
  assert.equal(runtimeDefault('MAIL_PORT'), MAIL_SINK.smtpPort);
  assert.equal(runtimeDefault('AWS_ACCESS_KEY_ID'), LOCAL_AWS_ENV.AWS_ACCESS_KEY_ID);
  assert.equal(runtimeDefault('AWS_SECRET_ACCESS_KEY'), LOCAL_AWS_ENV.AWS_SECRET_ACCESS_KEY);
  assert.equal(runtimeDefault('AWS_REGION'), LOCAL_AWS_ENV.AWS_DEFAULT_REGION);
  assert.deepEqual(
    [runtimeDefault('RABBITMQ_USERNAME'), runtimeDefault('RABBITMQ_PASSWORD')],
    Object.values(BROKERS.rabbitmq.composeServices()).map((s) => [s.environment.RABBITMQ_DEFAULT_USER, s.environment.RABBITMQ_DEFAULT_PASS])[0]
  );
});
