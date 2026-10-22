import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LEGACY_DIR } from './helpers/golden.js';
import { envDeps } from '../src/lib/env-deps.js';
import { placeholders, resolveDefaults, springEnvName } from '../src/lib/placeholders.js';
import { findUrls } from '../src/lib/readers/urls.js';
import { stripComments } from '../src/lib/source-text.js';

const env = (name) => envDeps(path.join(LEGACY_DIR, name));
const dep = (doc, tech) => doc.dependencies.find((d) => d.tech === tech);
const cfg = (doc, key) => doc.config.find((c) => c.key === key);

test('placeholders de Spring con anidamiento y binding relajado', () => {
  assert.deepEqual(placeholders('mongodb://${db:orders-db}:27017/data').map((p) => [p.key, p.default]), [['db', 'orders-db']]);
  assert.deepEqual(placeholders('${a:${b:c}}').map((p) => [p.key, p.default]), [['a', '${b:c}']]);
  assert.equal(resolveDefaults('${a:${b:c}}/x'), 'c/x');
  assert.equal(resolveDefaults('${sin_default}'), null);
  assert.equal(springEnvName('spring.data.mongodb.uri'), 'SPRING_DATA_MONGODB_URI');
  assert.equal(springEnvName('warehouse.default-code'), 'WAREHOUSE_DEFAULTCODE');
});

test('URLs: host desde un placeholder, JDBC y la llave que cierra un default', () => {
  const [m] = findUrls('mongodb://${db:orders-db}:27017/data');
  assert.deepEqual([m.tech, m.host, m.host_key, m.port, m.database], ['mongodb', 'orders-db', 'db', 27017, 'data']);
  const [j] = findUrls('jdbc:postgresql://${DB_HOST:billing-db}:5432/billing');
  assert.deepEqual([j.tech, j.host, j.host_key, j.database], ['postgresql', 'billing-db', 'DB_HOST', 'billing']);
  assert.equal(findUrls('${TAX_URL:http://tax-service/rates}')[0].url, 'http://tax-service/rates');
  assert.equal(findUrls('jdbc:h2:mem:test')[0].embedded, true);
  // `"http://" + host` (orders) no tiene host: no es una URL.
  assert.deepEqual(findUrls('return "http://" + host;', { quoted: true }), []);
});

test('quitar comentarios conserva las líneas y no toca las cadenas', () => {
  const src = '/* http://licencia\n */\nString u = "http://x//y"; // http://comentario\n';
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /"http:\/\/x\/\/y"/);
  assert.doesNotMatch(out, /licencia|comentario/);
});

test('java8-maven: puerto no estándar, alias que el legacy ya espera y credenciales en el código', () => {
  const doc = env('java8-maven');
  // inc. 1: el operador sondeó orders en el 8080 copiado de shipping; escucha en el 8082.
  assert.deepEqual(doc.listen, { port: 8081, key: 'port', env: 'PORT', evidence: 'src/main/resources/application.properties:2' });
  const mongo = dep(doc, 'mongodb');
  assert.deepEqual(mongo.provision, { via: 'container', aliases: ['inventory-db'] });
  assert.ok(mongo.endpoints.some((e) => e.host_key === 'db' && e.database === 'stock'));
  assert.ok(mongo.endpoints.some((e) => e.profile === 'dev'), 'el perfil dev se declara, no se mezcla');
  assert.deepEqual(dep(doc, 'rabbitmq').credentials, [
    { user: 'guest', password: 'guest', hardcoded: true, where: 'code', evidence: 'src/main/java/com/example/inventory/config/RabbitConfig.java:20-21' },
  ]);
  assert.deepEqual(dep(doc, 'smtp').provision, { via: 'mailpit', aliases: ['smtp'] });
  assert.deepEqual(dep(doc, 'http').provision, { via: 'wiremock', aliases: ['pricing'] });
  assert.deepEqual(dep(doc, 'zipkin').provision, { via: 'none', reason: 'apagado por defecto' });
  assert.equal(doc.dependencies.some((d) => d.kind === 'unknown'), false);
  // orders parte la cadena de @Value en dos literales.
  assert.equal(cfg(doc, 'http.timeout').default, '5');
  assert.deepEqual(
    doc.config.filter((c) => c.via.includes('configuration-properties')).map((c) => [c.key, c.default]),
    [
      ['warehouse.default-code', 'MAD-1'],
      ['warehouse.max-items', '50'],
    ]
  );
  assert.equal(cfg(doc, 'REGION').via[0], 'getenv');
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /apache\.org|ejemplo-en-comentario/, 'una URL en un comentario no es una dependencia');
  assert.deepEqual(doc.outbound_http.call_sites.map((s) => s.call), ['restTemplate.getForObject']);
  assert.deepEqual(doc.adaptations, []);
});

test('java8-gradle: datasource por JDBC, JPA plegado en el motor y activos de esquema y datos', () => {
  const doc = env('java8-gradle');
  const pg = dep(doc, 'postgresql');
  assert.equal(dep(doc, 'relational'), undefined);
  assert.deepEqual(pg.provision.aliases, ['billing-db']);
  assert.deepEqual(
    pg.clients.map((c) => c.library),
    ['org.postgresql:postgresql', 'org.springframework.boot:spring-boot-starter-data-jpa']
  );
  assert.deepEqual([pg.credentials[0].user, pg.credentials[0].password_key, pg.credentials[0].hardcoded], ['billing', 'DB_PASSWORD', false]);
  assert.deepEqual(dep(doc, 'redis').provision.aliases, ['cache']);
  assert.deepEqual(dep(doc, 'kafka').provision.aliases, ['kafka']);
  assert.equal(dep(doc, 'http').endpoints[0].url, 'http://tax-service/rates');
  assert.deepEqual(
    doc.assets.map((a) => [a.kind, a.format ?? null]),
    [
      ['migration', 'flyway'],
      ['seed', null],
      ['test', null],
    ]
  );
});

test('node14: el modo, el puerto, el destino sin resolver y las URLs candidatas', () => {
  const doc = env('node14');
  assert.deepEqual(cfg(doc, 'NODE_ENV').compared_with, ['production']);
  assert.deepEqual(doc.listen, { port: 3000, env: 'PORT', evidence: 'src/server.js:16' });
  // CATALOG_URL no dice a qué habla: se pregunta, no se adivina.
  const unknown = doc.dependencies.find((d) => d.kind === 'unknown');
  assert.deepEqual([unknown.endpoints[0].key, unknown.provision.via], ['CATALOG_URL', 'ask']);
  // Una URL http literal del código es candidata, no dependencia.
  assert.equal(dep(doc, 'http'), undefined);
  assert.deepEqual(doc.outbound_http.urls.map((u) => u.host), ['cdn.example.invalid']);
  assert.deepEqual(doc.outbound_http.call_sites.map((s) => s.call), ['axios.get']);
  assert.equal(dep(doc, 'rabbitmq').credentials.length, 1, 'la URL del default y el literal son la misma');
  assert.deepEqual(dep(doc, 'smtp').provision, { via: 'mailpit', aliases: ['mailpit'] });
  assert.equal(doc.assets.find((a) => a.kind === 'collection').requests, 2);
  assert.deepEqual(
    doc.assets.filter((a) => a.kind === 'script').map((a) => a.evidence),
    ['package.json:6', 'package.json:7', 'package.json:8']
  );
});
