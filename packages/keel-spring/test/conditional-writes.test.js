// La escritura condicional (DSL 2.25, api.concurrency) en keel-spring: incremento 4 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md.
// Lo emitido se compila y se ejecuta en scripts/precondition-check.js (CW-1 a CW-11, falsados con --sabotage=cw-*). Aquí, lo
// que no necesita JDK: el gate EJECUTADO con bash (CW-12, falsado con cw-gate), la forma del borde que el compilador no
// juzga (el campo que no se acepta del cuerpo, estampado en todas las ramas) y la paridad con keel-nest, keel-dotnet y
// keel-go: las mismas escrituras en el gate, la misma lectura y el mismo ETag expuesto.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { CHECK_CONDITIONAL_WRITES_SH, conditionalWritesOf, corsExposedHeaders } from '@keel-system/keel-core/gen/conditional-writes';
import { CONDITIONAL_WRITE_DESIGNS } from '../../keel-core/test/helpers/conditional-write-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { planFixture as planNest } from '../../keel-nest/test/helpers/emitted.js';

const design = (name) => CONDITIONAL_WRITE_DESIGNS.find((entry) => entry.name === name);

function plan(name, stack = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
}

const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix));

/** Escribe el proyecto y ejecuta el gate; `edit(file)` cambia un archivo antes. Null si no hay bash. */
function runGate(files, { edit = (file) => file.content, script = (text) => text } = {}) {
  const dir = tmpDir('keel-spring-cw-gate-');
  for (const file of files.filter((entry) => typeof entry.content === 'string')) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.path === CHECK_CONDITIONAL_WRITES_SH ? script(file.content) : edit(file));
  }
  try {
    return { code: 0, out: execFileSync('bash', [CHECK_CONDITIONAL_WRITES_SH], { cwd: dir, encoding: 'utf8' }) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: error.status, out: error.stdout };
  }
}

const withCall = (file) =>
  /(Update|Retire)ProductCommandHandler\.java$/.test(file.path)
    ? file.content.replace('throw new UnsupportedOperationException(', 'productRepository.loadExpecting(command.id(), command.expectedVersions());\n        throw new UnsupportedOperationException(')
    : file.content;

test('CW-12: el gate sale ROJO recién generado y VERDE con loadExpecting escrito en cada handler', (t) => {
  const { files } = plan('catalog-conditional');
  const fresh = runGate(files);
  if (!fresh) return t.skip('sin bash');
  assert.equal(fresh.code, 1, fresh.out);
  assert.match(fresh.out, /✗ updateProduct/);
  assert.match(fresh.out, /✗ retireProduct/);
  const written = runGate(files, { edit: withCall });
  assert.equal(written.code, 0, written.out);
  assert.match(written.out, /✓ retireProduct carga Product con loadExpecting/);
});

test('cw-gate: un gate que no mira el handler sale verde sobre lo recién generado, y CW-12 lo ve', (t) => {
  const { files } = plan('catalog-conditional');
  const sabotaged = runGate(files, { script: (text) => text.replace("grep -q 'loadExpecting('", 'true') });
  if (!sabotaged) return t.skip('sin bash');
  assert.equal(sabotaged.code, 0, 'el sabotaje no se aplicó: el gate sigue mirando el handler');
});

test('D5: las versiones no se aceptan del cuerpo y el controller las estampa en todas las ramas', () => {
  const { files } = plan('catalog-conditional');
  const command = fileOf(files, '/UpdateProductCommand.java').content;
  assert.match(command, /@JsonIgnore List<Long> expectedVersions/);
  const controller = fileOf(files, '/ProductV1Controller.java').content;
  // updateProduct (cuerpo + ruta) y retireProduct (sin cuerpo): las dos estampan, y las dos exigen If-Match.
  assert.equal(controller.match(/ConditionalRequests\.expectedVersions\(ifMatch\)/g).length, 2);
  assert.equal(controller.match(/@RequiresIfMatch/g).length, 2);
  // La lectura que da el ETag y las dos escrituras que lo devuelven lo escriben en la respuesta, sin ResponseEntity.eTag
  // (que en un GET evaluaría If-None-Match: fuera de 2.25).
  assert.equal(controller.match(/ConditionalRequests\.writeEtag\(servletResponse, versioned\.version\(\)\)/g).length, 3);
  assert.ok(!controller.includes('.eTag('));
});

test('D6: la lectura derivada y las escrituras que devuelven su raíz devuelven Versioned<T>, también en la caché', () => {
  const { files } = plan('catalog-conditional', { cache: 'redis' });
  assert.match(fileOf(files, '/GetProductBySlugQueryHandler.java').content, /public Versioned<GetProductBySlugResponseDto> handle\(/);
  assert.match(fileOf(files, '/UpdateProductCommandHandler.java').content, /public Versioned<UpdateProductResponseDto> handle\(/);
  assert.match(fileOf(files, '/RedisOperationCache.java').content, /new TypeReference<Versioned<GetProductBySlugResponseDto>>/);
  assert.match(fileOf(files, '/Versioned.java').content, /record Versioned<T>\(@JsonProperty\(required = true\) long version, T value\)/);
});

test('T1: el adaptador JPA de una raíz con escritura condicional guarda con flush y fuerza la versión nueva', () => {
  const { files } = plan('catalog-conditional');
  const adapter = fileOf(files, '/ProductRepositoryImpl.java').content;
  assert.match(adapter, /forceNewVersion\(entity, productJpaRepository\.saveAndFlush\(jpa\)\)/);
  assert.match(adapter, /LockModeType\.PESSIMISTIC_FORCE_INCREMENT/);
  assert.match(adapter, /public Optional<Product> loadExpecting\(UUID id, List<Long> expectedVersions\)/);
});

test('optional: sin interceptor ni @RequiresIfMatch, pero con el campo y el ETag', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  layers.api.concurrency = { conditionalWrites: 'optional', operations: ['updateProduct'] };
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
  assert.ok(!fileOf(files, '/IfMatchInterceptor.java'));
  const controller = fileOf(files, '/ProductV1Controller.java').content;
  assert.ok(!controller.includes('@RequiresIfMatch'));
  assert.match(controller, /ConditionalRequests\.expectedVersions\(ifMatch\)/);
});

test('T3: la frontera rechaza la escritura condicional que además repite por Idempotency-Key', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  design('catalog-conditional').mutate(layers);
  layers['use-cases'].operations.updateProduct.idempotency = { keySource: 'client-key' };
  const { errors } = checkSupportedFeatures(manifest, layers);
  assert.ok(errors.some((message) => message.includes('operations.updateProduct') && message.includes('keel-spring')), errors.join('\n'));
});

test('paridad con keel-nest (y, por ella, con keel-dotnet y keel-go): las mismas escrituras, la misma lectura y el mismo ETag expuesto', () => {
  for (const { name } of CONDITIONAL_WRITE_DESIGNS) {
    const spring = plan(name);
    const nest = planNest(design(name).from, { mutate: design(name).mutate });
    const rows = (files) => [...files.find((file) => file.path === CHECK_CONDITIONAL_WRITES_SH).content.matchAll(/^check '(\w+)' '(\w+)'/gm)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(rows(spring.files), rows(nest.files), name);
    assert.deepEqual(conditionalWritesOf(spring.model), conditionalWritesOf(nest.model), name);
    if (spring.model.security?.cors) {
      const cors = fileOf(spring.files, '/CorsConfig.java').content;
      assert.ok(cors.includes(`EXPOSED_HEADERS = List.of(${corsExposedHeaders(spring.model).map((h) => `"${h}"`).join(', ')})`), name);
    }
  }
});

test('sin api.concurrency no se emite nada de la escritura condicional', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  delete layers.api.concurrency;
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
  assert.ok(!files.some((file) => file.path === CHECK_CONDITIONAL_WRITES_SH));
  // El código emitido, no la documentación del agente, que nombra el mecanismo para cuando el diseño lo pida.
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /loadExpecting|expectedVersions|Versioned<|forceNewVersion/.test(file.content ?? '')));
});

test('el arnés manda If-Match aunque el diseño no declare CORS (corrida catalog-spring, 2026-11-07)', () => {
  // catalog-extended no tiene capa security: exchangeWithHeaders solo existía con CORS, y el agente de pruebas tuvo que
  // escribirse su propio patchIfMatch para los escenarios del 412 y del 428.
  const { files } = plan('catalog-conditional');
  const harness = fileOf(files, '/AbstractFlowIT.java').content;
  assert.match(harness, /protected Response exchangeWithHeaders\(HttpMethod method, String path, String jsonBody, String token,/);
  assert.match(harness, /If-Match/);
});
