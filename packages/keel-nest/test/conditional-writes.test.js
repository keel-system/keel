// La escritura condicional (DSL 2.25, api.concurrency) en keel-nest: incremento 2 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md.
// Lo emitido se compila y se ejecuta en ts-check (CW-6 a CW-10, falsados con --sabotage=cw-*), db-check y doc-check (CW-1
// a CW-5). Aquí, lo que no necesita red: el gate EJECUTADO con bash (CW-12, falsado con cw-gate), la entrada de la caché
// que conserva la versión (CW-11, falsado con cw-cache-etag) y la paridad con keel-dotnet: la misma nota, el mismo gate y
// las mismas escrituras y lecturas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECK_CONDITIONAL_WRITES_SH, conditionalWritesOf, corsExposedHeaders } from '@keel-system/keel-core/gen/conditional-writes';
import { CONDITIONAL_WRITE_DESIGNS } from '../../keel-core/test/helpers/conditional-write-designs.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { tmpDir } from './helpers/tmp.js';
import { sampleResponse } from './helpers/response-samples.js';
import { CACHED_RESPONSES_TS } from '../src/scaffold/cache.js';
import { planFixture as planDotnet, UNCOVERED_BRANCHES } from '../../keel-dotnet/test/helpers/workspace.js';

const design = (name) => CONDITIONAL_WRITE_DESIGNS.find((entry) => entry.name === name);
const plan = (name, stack = null) => planFixture(design(name).from, { mutate: design(name).mutate, stack });

/** Escribe el proyecto y ejecuta el gate; `edit(file)` cambia un archivo antes. Null si no hay bash. */
function runGate(files, { edit = (file) => file.content, script = (text) => text } = {}) {
  const dir = tmpDir('keel-nest-cw-gate-');
  for (const file of files) {
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
  /(update|retire)-product-command-handler\.ts$/.test(file.path)
    ? file.content.replace("throw new Error('TODO:", "await this.productRepository.loadExpecting(command.id, command.expectedVersions);\n    throw new Error('TODO:")
    : file.content;

test('CW-12: el gate sale ROJO recién generado y VERDE con loadExpecting escrito en cada handler', async (t) => {
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

test('cw-gate: un gate que no mira el handler sale verde sobre lo recién generado, y CW-12 lo ve', async (t) => {
  const { files } = plan('catalog-conditional');
  const sabotaged = runGate(files, { script: (text) => text.replace("grep -q 'loadExpecting('", 'true') });
  if (!sabotaged) return t.skip('sin bash');
  assert.equal(sabotaged.code, 0, 'el sabotaje no se aplicó: el gate sigue mirando el handler');
});

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { log() {} warn() {} error() {} }
`;

const bySlug = (model) => model.services.flatMap((service) => service.operations).find((operation) => operation.name === 'getProductBySlug');

/** El codec de la caché de getProductBySlug, ejecutado: lo que escribe y lo que vuelve a leer. */
async function bySlugCodec(files) {
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { RESPONSE_CODECS } = await tree.load(CACHED_RESPONSES_TS);
  const { GET_PRODUCT_BY_SLUG_CACHE } = await tree.load('src/application/support/cached-operations.ts');
  return RESPONSE_CODECS.get(GET_PRODUCT_BY_SLUG_CACHE.name);
}

test('CW-11: la entrada de la caché de la lectura que da el ETag guarda la versión con el cuerpo, y vuelve igual', async () => {
  const { files, model } = plan('catalog-conditional', { cache: 'redis' });
  const codec = await bySlugCodec(files);
  const value = sampleResponse(model, bySlug(model));
  // Un acierto devuelve la versión con la que se escribió la entrada: el MISMO ETag que la lectura que la llenó.
  const hit = codec.decode(`{"version":7,"value":${value}}`);
  assert.equal(hit.version, 7);
  assert.match(codec.encode(hit), /^\{"version":7,"value":\{/, 'la entrada no empieza por la versión, en el orden del cable');
  // Una entrada sin versión (la de un servicio que guardaba solo el cuerpo) no se lee: es un miss, no un ETag inventado.
  assert.throws(() => codec.decode(`{"value":${value}}`), /la entrada no tiene la forma/);
});

test('cw-cache-etag: una caché que guarda solo el cuerpo pierde la versión, y CW-11 lo ve', async () => {
  const { files, model } = plan('catalog-conditional', { cache: 'redis' });
  const sabotaged = files.map((file) =>
    file.path === CACHED_RESPONSES_TS
      ? { ...file, content: file.content.replace("return { version: required(entry['version'], count), value:", "return { version: 0, value:") }
      : file
  );
  assert.notDeepEqual(sabotaged, files, 'el sabotaje no se aplicó');
  const codec = await bySlugCodec(sabotaged);
  // El decodificador saboteado da por buena una entrada sin versión: la aserción de CW-11 caería.
  const value = sampleResponse(model, bySlug(model));
  assert.doesNotThrow(() => codec.decode(`{"value":${value}}`));
  assert.notEqual(codec.decode(`{"version":7,"value":${value}}`).version, 7);
});

test('paridad con keel-dotnet: las mismas escrituras en el gate, la misma lectura y el mismo ETag expuesto', async () => {
  for (const name of ['catalog-conditional', 'catalog-conditional-mongo', 'shop-conditional']) {
    const nest = plan(name);
    const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
    const dotnet = await planDotnet(branch.from, { mutate: (manifest, layers) => branch.mutate(manifest, layers, name) });
    const rows = (files) => [...files.find((file) => file.path === CHECK_CONDITIONAL_WRITES_SH).content.matchAll(/^check '(\w+)' '(\w+)'/gm)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(rows(nest.files), rows(dotnet.files), name);
    assert.deepEqual(conditionalWritesOf(nest.model), conditionalWritesOf(dotnet.model), name);
    if (nest.model.security?.cors) {
      const cors = nest.files.find((file) => file.path.endsWith('security/cors-policy.ts')).content;
      assert.ok(cors.includes(`EXPOSED_HEADERS: readonly string[] = [${corsExposedHeaders(nest.model).map((h) => `'${h}'`).join(', ')}]`), name);
    }
  }
});

test('sin api.concurrency no se emite nada de la escritura condicional', () => {
  const { files } = planFixture('catalog-extended');
  assert.ok(!files.some((file) => file.path === CHECK_CONDITIONAL_WRITES_SH));
  // El código emitido, no la documentación del agente, que nombra el mecanismo para cuando el diseño lo pida.
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /loadExpecting|expectedVersions|Versioned</.test(file.content ?? '')));
});
