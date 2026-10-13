// El gradiente por perfil es contrato del servidor —qué variable lee y con qué default en cada perfil—,
// así que se fija entero, perfil por perfil: un cambio aquí cambia la configuración que emiten todos los
// generadores, y tiene que ser a sabiendas.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cronWithDefault, envRequired, envValue, envWithDefault } from '../src/lib/gen/profile-values.js';

const PROFILES = ['local', 'test', 'develop', 'production'];

function row(fn, ...args) {
  return Object.fromEntries(PROFILES.map((profile) => [profile, fn(profile, ...args)]));
}

test('envValue: literal en local y test, default en develop, obligatoria en production', () => {
  assert.deepEqual(row(envValue, 'DB_URL', 'jdbc:x'), {
    local: 'jdbc:x',
    test: 'jdbc:x',
    develop: '${DB_URL:jdbc:x}',
    production: '${DB_URL}'
  });
});

test('envWithDefault: literal solo en local, con default en el resto (test incluido)', () => {
  assert.deepEqual(row(envWithDefault, 'LOG_LEVEL_ROOT', 'WARN'), {
    local: 'WARN',
    test: '${LOG_LEVEL_ROOT:WARN}',
    develop: '${LOG_LEVEL_ROOT:WARN}',
    production: '${LOG_LEVEL_ROOT:WARN}'
  });
});

test('envRequired: literal solo en local, obligatoria en el resto', () => {
  assert.deepEqual(row(envRequired, 'OAUTH2_ISSUER_URI', 'http://localhost:8180'), {
    local: 'http://localhost:8180',
    test: '${OAUTH2_ISSUER_URI}',
    develop: '${OAUTH2_ISSUER_URI}',
    production: '${OAUTH2_ISSUER_URI}'
  });
});

test('cronWithDefault: el escalar entero entre comillas y el default desnudo', () => {
  assert.equal(cronWithDefault('local', 'SWEEP_CRON', '0 0 4 * * *'), '"0 0 4 * * *"');
  assert.equal(cronWithDefault('production', 'SWEEP_CRON', '0 0 4 * * *'), '"${SWEEP_CRON:0 0 4 * * *}"');
  assert.doesNotMatch(cronWithDefault('develop', 'SWEEP_CRON', '0 0 4 * * *'), /:"/);
});

test('los valores no cadena se escriben con String()', () => {
  assert.equal(envValue('local', 'DB_POOL_MAX_SIZE', 10), '10');
  assert.equal(envWithDefault('develop', 'STORAGE_ENSURE_BUCKETS', true), '${STORAGE_ENSURE_BUCKETS:true}');
});
