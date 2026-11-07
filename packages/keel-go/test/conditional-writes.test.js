// La escritura condicional (DSL 2.25, api.concurrency) en keel-go: incremento 3 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md.
// Lo emitido se compila y se ejecuta en go-check (CW-6 a CW-11, falsados con test/helpers/conditional-sabotages.js), db-check
// y doc-check (CW-1 a CW-5, con --sabotage=cw-*). Aquí, lo que no necesita Go: el gate EJECUTADO con bash (CW-12, falsado
// con cw-gate), que cada sabotaje del borde se sigue aplicando y nombra una prueba emitida que existe, y la paridad con
// keel-nest y keel-dotnet: las mismas escrituras y lecturas, el mismo gate y el mismo ETag expuesto.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { CHECK_CONDITIONAL_WRITES_SH, CW_SABOTAGES, conditionalWritesOf, corsExposedHeaders } from '@keel-system/keel-core/gen/conditional-writes';
import { CONDITIONAL_WRITE_DESIGNS } from '../../keel-core/test/helpers/conditional-write-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { CONDITIONAL_SABOTAGES, applySabotage } from './helpers/conditional-sabotages.js';
import { DB_SABOTAGES } from './helpers/db-sabotages.js';
import { DOC_SABOTAGES } from './helpers/doc-sabotages.js';
import { FIXTURES_DIR, UNCOVERED_BRANCHES } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { planFixture as planNest } from '../../keel-nest/test/helpers/emitted.js';
import { planFixture as planDotnet, UNCOVERED_BRANCHES as DOTNET_BRANCHES } from '../../keel-dotnet/test/helpers/workspace.js';

function plan(name) {
  const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, branch.from));
  branch.mutate(manifest, layers);
  return { manifest, layers, ...planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null }) };
}

/** Escribe el proyecto y ejecuta el gate; `edit(file)` cambia un archivo antes. Null si no hay bash. */
function runGate(files, { edit = (file) => file.content, script = (text) => text } = {}) {
  const dir = tmpDir('keel-go-cw-gate-');
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
  /(update|retire)_product_command_handler\.go$/.test(file.path)
    ? file.content.replace('\t// TODO (agente):', '\t_, _, _ = h.productRepository.LoadExpecting(ctx, cmd.ID, cmd.ExpectedVersions)\n\t// TODO (agente):')
    : file.content;

test('la escritura condicional entra en la frontera de keel-go, en las tres siluetas', () => {
  for (const { name } of CONDITIONAL_WRITE_DESIGNS) {
    const { manifest, layers } = plan(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('lo emitido: el mensaje, el borde, la lectura que da el ETag, el puerto y los dos adaptadores', () => {
  for (const [name, store] of [['catalog-conditional', 'postgres'], ['catalog-conditional-mongo', 'mongo']]) {
    const { files } = plan(name);
    const find = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';
    assert.match(find('application/update_product_command.go'), /ExpectedVersions +\[\]int64 +`json:"-"`/, name);
    const endpoints = find('httpapi/product_endpoints.go');
    assert.match(endpoints, /expected, err := expectedVersions\(r, true\)\n\tif err != nil \{\n\t\treturn err\n\t\}\n\tcmd, err := readUpdateProduct\(r\)/, `${name}: If-Match no se lee antes que el lector`);
    assert.equal(endpoints.match(/w\.Header\(\)\.Set\("ETag", etagOf\(versioned\.Version\)\)/g)?.length, 3, `${name}: el ETag de la lectura y de las dos escrituras`);
    assert.match(find('application/get_product_by_slug_query_handler.go'), /\(Versioned\[GetProductBySlugResponseDto\], error\)/, name);
    assert.match(find('domain/product_repository.go'), /LoadExpecting\(ctx context\.Context, id uuid\.UUID, expected \[\]int64\) \(\*Product, bool, error\)/, name);
    assert.match(find(`infrastructure/${store}/product_repository.go`), /domain\.CheckVersion\(expected, loaded\.LockVersion\(\)\)/, name);
    assert.match(find(CHECK_CONDITIONAL_WRITES_SH), /check 'updateProduct' 'Product' 'internal\/application\/update_product_command_handler\.go'/, name);
  }
});

test('CW-12: el gate sale ROJO recién generado y VERDE con LoadExpecting escrito en cada handler', (t) => {
  const { files } = plan('catalog-conditional');
  const fresh = runGate(files);
  if (!fresh) return t.skip('sin bash');
  assert.equal(fresh.code, 1, fresh.out);
  assert.match(fresh.out, /✗ updateProduct/);
  assert.match(fresh.out, /✗ retireProduct/);
  const written = runGate(files, { edit: withCall });
  assert.equal(written.code, 0, written.out);
  assert.match(written.out, /✓ retireProduct carga Product con LoadExpecting/);
});

test('cw-gate: un gate que no mira el handler sale verde sobre lo recién generado, y CW-12 lo ve', (t) => {
  const { files } = plan('catalog-conditional');
  const sabotaged = runGate(files, { script: (text) => text.replace("grep -q 'LoadExpecting('", 'true') });
  if (!sabotaged) return t.skip('sin bash');
  assert.equal(sabotaged.code, 0, 'el sabotaje no se aplicó: el gate sigue mirando el handler');
});

test('los nueve sabotajes de keel-core tienen su sitio en keel-go, con el mismo id', () => {
  const here = new Set([...CONDITIONAL_SABOTAGES.map((s) => s.id), ...Object.keys(DB_SABOTAGES), ...Object.keys(DOC_SABOTAGES), 'cw-gate']);
  for (const { id } of CW_SABOTAGES) assert.ok(here.has(id), id);
});

for (const sabotage of CONDITIONAL_SABOTAGES) {
  test(`el sabotaje ${sabotage.id} se sigue aplicando a ${sabotage.subject} y nombra una prueba emitida`, () => {
    const { files } = plan(sabotage.subject);
    const file = files.find((candidate) => candidate.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
    const emitted = files.filter((candidate) => candidate.path.endsWith('_test.go')).map((candidate) => candidate.content).join('\n');
    assert.match(emitted, new RegExp(`^func ${sabotage.fails}\\(t \\*testing\\.T\\)`, 'm'));
  });
}

test('paridad con keel-nest y keel-dotnet: las mismas escrituras en el gate, la misma lectura y el mismo ETag expuesto', async () => {
  const rows = (files) => [...files.find((file) => file.path === CHECK_CONDITIONAL_WRITES_SH).content.matchAll(/^check '(\w+)' '(\w+)'/gm)].map((m) => `${m[1]}:${m[2]}`);
  for (const { name, from, mutate } of CONDITIONAL_WRITE_DESIGNS) {
    const go = plan(name);
    const nest = planNest(from, { mutate });
    const branch = DOTNET_BRANCHES.find((candidate) => candidate.name === name);
    const dotnet = await planDotnet(branch.from, { mutate: (manifest, layers) => branch.mutate(manifest, layers, name) });
    assert.deepEqual(rows(go.files), rows(nest.files), name);
    assert.deepEqual(rows(go.files), rows(dotnet.files), name);
    assert.deepEqual(conditionalWritesOf(go.model), conditionalWritesOf(nest.model), name);
    if (go.model.security?.cors) {
      const cors = go.files.find((file) => file.path.endsWith('security/cors.go')).content;
      assert.ok(cors.includes(`corsExposedHeaders   = []string{${corsExposedHeaders(go.model).map((h) => `"${h}"`).join(', ')}}`), name);
    }
  }
});

test('sin api.concurrency no se emite nada de la escritura condicional', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
  assert.ok(!files.some((file) => file.path === CHECK_CONDITIONAL_WRITES_SH));
  // El código emitido, no la documentación del agente, que nombra el mecanismo para cuando el diseño lo pida.
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /LoadExpecting|ExpectedVersions|Versioned\[|expectedVersions\(/.test(file.content ?? '')));
});
