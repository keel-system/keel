// La escritura condicional (DSL 2.25, api.concurrency) en keel-dotnet: incremento 1 de
// PLAN-DSL-225-ESCRITURA-CONDICIONAL.md. Lo emitido se compila y se ejecuta en cs-check, db-check y doc-check (CW-1 a CW-11,
// sobre las variantes de keel-core/test/helpers/conditional-write-designs.js); aquí, lo que no necesita SDK: el gate
// EJECUTADO con bash (CW-12, falsado con cw-gate), y que lo emitido diga lo mismo que el núcleo neutral.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECK_CONDITIONAL_WRITES_SH, conditionalWritesOf, corsExposedHeaders } from '@keel-system/keel-core/gen/conditional-writes';
import { FRAMEWORK_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { planFixture, UNCOVERED_BRANCHES } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const plan = async (name) => {
  const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
  return planFixture(branch.from, { mutate: (manifest, layers) => branch.mutate(manifest, layers, name) });
};

/** Escribe el proyecto y ejecuta el gate; `edit(file)` cambia un archivo antes. Null si no hay bash. */
function runGate(files, { edit = (file) => file.content, script = (text) => text } = {}) {
  const dir = tmpDir('keel-dotnet-cw-gate-');
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

// Lo que escribiría el agente en el handler: la carga que compara.
const withCall = (file) =>
  /(UpdateProduct|RetireProduct)CommandHandler\.cs$/.test(file.path)
    ? file.content.replace('throw new NotImplementedException(', 'var product = await productRepository.LoadExpecting(command.Id, command.ExpectedVersions, cancellationToken);\n        throw new NotImplementedException(')
    : file.content;

test('CW-12: el gate sale ROJO recién generado y VERDE con LoadExpecting escrito en cada handler', async (t) => {
  const { files } = await plan('catalog-conditional');
  const fresh = runGate(files);
  if (!fresh) return t.skip('sin bash');
  assert.equal(fresh.code, 1, fresh.out);
  // La nota del handler nombra LoadExpecting en un comentario: eso no cuenta como llamada.
  assert.match(fresh.out, /✗ updateProduct/);
  assert.match(fresh.out, /✗ retireProduct/);
  const written = runGate(files, { edit: withCall });
  assert.equal(written.code, 0, written.out);
  assert.match(written.out, /✓ updateProduct carga Product con LoadExpecting/);
  // Con solo uno de los dos, sigue rojo por el otro.
  const half = runGate(files, { edit: (file) => (file.path.endsWith('RetireProductCommandHandler.cs') ? file.content : withCall(file)) });
  assert.equal(half.code, 1, half.out);
});

test('cw-gate: un gate que no mira el handler sale verde sobre lo recién generado, y CW-12 lo ve', async (t) => {
  const { files } = await plan('catalog-conditional');
  const sabotaged = runGate(files, { script: (text) => text.replace("grep -q 'LoadExpecting('", 'true') });
  if (!sabotaged) return t.skip('sin bash');
  assert.notEqual(sabotaged.out, null);
  assert.equal(sabotaged.code, 0, 'el sabotaje no se aplicó: el gate sigue mirando el handler');
});

test('lo emitido dice lo que el núcleo neutral: las escrituras, las lecturas, el 412 y CORS', async () => {
  for (const name of ['catalog-conditional', 'catalog-conditional-mongo', 'shop-conditional']) {
    const { model, files } = await plan(name);
    const neutral = conditionalWritesOf(model);
    const gate = files.find((file) => file.path === CHECK_CONDITIONAL_WRITES_SH).content;
    assert.deepEqual([...gate.matchAll(/^check '(\w+)'/gm)].map((match) => match[1]), neutral.writes.map((write) => write.name), name);
    const failed = files.find((file) => file.path.endsWith('Errors/PreconditionFailedException.cs')).content;
    assert.match(failed, new RegExp(`ErrorStatus = ${FRAMEWORK_RESPONSES.preconditionFailed.status};`));
    assert.ok(failed.includes(FRAMEWORK_RESPONSES.preconditionFailed.message), name);
    if (model.security?.cors) {
      const cors = files.find((file) => file.path.endsWith('Security/CorsPolicy.cs')).content;
      assert.ok(cors.includes(`ExposedHeaders = [${corsExposedHeaders(model).map((h) => `"${h}"`).join(', ')}]`), name);
      assert.ok(corsExposedHeaders(model).includes('ETag'));
    }
  }
});

test('sin api.concurrency no se emite nada de la escritura condicional', async () => {
  const { files } = await planFixture('catalog-extended');
  assert.ok(!files.some((file) => file.path === CHECK_CONDITIONAL_WRITES_SH));
  assert.ok(!files.some((file) => /LoadExpecting|ExpectedVersions|Versioned</.test(file.content ?? '')));
});
