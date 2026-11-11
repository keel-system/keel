// La prueba del contrato del token (casos IDT-*) que build deja en el proyecto, EJECUTADA: se transpila con el árbol
// emitido, firma con jose y pasa por el autenticador real. Y cada sabotaje cae en exactamente los casos marcados con
// su defecto: la red se falsa a sí misma.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { IDENTITY_DESIGNS } from '../../keel-core/test/helpers/identity-designs.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { TOKEN_CONTRACT_TEST_TS } from '../src/scaffold/token-contract-test.js';

const SECURITY = 'src/infrastructure/security';
const DECORATORS = ['Inject', 'Injectable', 'Logger', 'Module', 'Global'];
const NEST_STUB = `${DECORATORS.map((name) => `export const ${name} = () => () => {};`).join('\n')}`;
const VITEST_STUB = 'export const test = (name, body) => globalThis.__keelTokenCases.push({ name, body });\n';

const SABOTAGES = {
  'token-use': { defects: ['D1'], edits: [[`${SECURITY}/jwt-authenticator.ts`, "if (payload['token_use'] !== 'access') throw", "if (false) throw"]] },
  'scope-prefix': {
    defects: ['D2'],
    edits: [[
      `${SECURITY}/jwt-authenticator.ts`,
      /\.filter\(\(value\) => value\.startsWith\([^\n]*\n\s*\.map\(\(value\) => value\.slice\(resourceServer\.length \+ 1\)\)/,
      ".map((value) => value.slice(value.indexOf('/') + 1 + (resourceServer.length * 0)))"
    ]]
  },
  'client-translation': {
    defects: ['D3', 'D4'],
    edits: [
      [`${SECURITY}/service-client-ids.ts`, 'return ids[declaredName];', 'return declaredName;'],
      [`${SECURITY}/service-client-ids.ts`, /return Object\.entries\(ids\)[^\n]*\n/, 'return clientId;\n']
    ]
  }
};

const silhouette = (name) => IDENTITY_DESIGNS.find((design) => design.name === name);

function plan(subject, auth) {
  const design = silhouette(subject);
  return design ? planFixture(design.from, { mutate: design.mutate, stack: { auth } }) : planFixture(subject, { stack: { auth } });
}

function applySabotage(files, id) {
  return files.map((file) => {
    let { content } = file;
    for (const [target, from, to] of SABOTAGES[id].edits) {
      if (file.path !== target) continue;
      assert.ok(typeof from === 'string' ? content.includes(from) : from.test(content), `el sabotaje ${id} ya no se aplica a ${target}`);
      content = content.replace(from, to);
    }
    return content === file.content ? file : { ...file, content };
  });
}

async function run(files) {
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB, vitest: VITEST_STUB }, tests: true });
  globalThis.__keelTokenCases = [];
  await tree.load(TOKEN_CONTRACT_TEST_TS);
  const results = [];
  for (const { name, body } of globalThis.__keelTokenCases) {
    try {
      await body();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error });
    }
  }
  return results;
}

const fell = (results) => results.filter((item) => !item.ok).map((item) => item.name.split(':')[0]).sort();

for (const [subject, auth] of [['asset-vault', 'cognito'], ['asset-vault', 'keycloak'], ['shop-api', 'cognito'], ['notification-mailer', 'cognito'], ['mailer-one-to-one', 'cognito']]) {
  test(`${subject} con ${auth}: el servidor emitido cumple cada caso del token`, async () => {
    const results = await run(plan(subject, auth).files);
    assert.ok(results.length > 0, 'sin casos');
    assert.deepEqual(results.filter((item) => !item.ok).map((item) => `${item.name}: ${item.error.message}`), []);
  });
}

for (const [id, subject] of [['token-use', 'asset-vault'], ['scope-prefix', 'asset-vault'], ['client-translation', 'asset-vault'], ['client-translation', 'mailer-one-to-one']]) {
  test(`${id} sobre ${subject}: cae en exactamente sus casos`, async () => {
    const { files, model } = plan(subject, 'cognito');
    const expected = tokenCases(model).filter((entry) => SABOTAGES[id].defects.includes(entry.defect)).map((entry) => entry.id).sort();
    assert.ok(expected.length > 0);
    assert.deepEqual(fell(await run(applySabotage(files, id))), expected);
  });
}

test('sin proveedor no se emite la prueba', () => {
  assert.equal(plan('asset-vault', 'none').files.some((file) => file.path === TOKEN_CONTRACT_TEST_TS), false);
});
