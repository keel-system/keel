// La prueba del contrato del token (casos IDT-*) que build deja en el proyecto. Ejecutarla necesita el SDK: lo hace
// `cs-check --fixtures` sobre las variantes con Cognito, y cada sabotaje de scripts/lib/token-sabotages.js cae en
// exactamente sus casos. Aquí, sin SDK: que se emite un método por caso y que los sabotajes siguen aplicándose a lo
// emitido (si el texto cambia, el sabotaje dejaría de medir sin que nadie lo notara).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { planService } from '../src/scaffold/index.js';
import { tokenCaseMethod } from '../src/scaffold/token-contract-test.js';
import { TOKEN_SABOTAGES } from '../scripts/lib/token-sabotages.js';
import { CS_VARIANTS, FIXTURES_DIR, variantStack } from './helpers/workspace.js';

function plan(name, auth = null) {
  const variant = CS_VARIANTS.find((candidate) => candidate.name === name) ?? { name, from: name };
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, variant.from));
  if (variant.mutate) variant.mutate(manifest, layers, name);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: variantStack(layers, { auth: auth ?? variant.auth }) });
}

const emitted = (files) => files.find((file) => file.path.endsWith('/TokenContractTests.cs'));

for (const [name, auth] of [['asset-vault-cognito'], ['shop-api-cognito'], ['notification-mailer-cognito'], ['mailer-one-to-one-cognito'], ['asset-vault', 'keycloak']]) {
  test(`${name}${auth ? ` con ${auth}` : ''}: un método por caso del token`, () => {
    const { files, model } = plan(name, auth);
    const content = emitted(files)?.content;
    assert.ok(content, 'emite TokenContractTests.cs');
    const methods = [...content.matchAll(/public async Task (IDT_\w+)\(\)/g)].map((match) => match[1]);
    assert.ok(methods.length > 0);
    assert.deepEqual(methods, tokenCases(model).map((entry) => tokenCaseMethod(entry.id)).filter((method) => methods.includes(method)));
  });
}

test('cada caso con un defecto de D1 a D4 está en alguna variante con Cognito', () => {
  const defects = new Set(
    CS_VARIANTS.filter((variant) => variant.auth === 'cognito').flatMap((variant) => {
      const { files, model } = plan(variant.name);
      const content = emitted(files)?.content ?? '';
      return tokenCases(model).filter((entry) => entry.defect && content.includes(`Task ${tokenCaseMethod(entry.id)}()`)).map((entry) => entry.defect);
    })
  );
  assert.deepEqual([...defects].sort(), ['D1', 'D2', 'D3', 'D4']);
});

for (const [id, { defects, edits }] of Object.entries(TOKEN_SABOTAGES)) {
  test(`el sabotaje ${id} se aplica a lo emitido y tiene casos que tumbar`, () => {
    for (const [target, from] of edits) {
      const [design, ...rest] = target.split('/');
      const { files, model } = plan(design);
      const file = files.find((candidate) => candidate.path.split(path.sep).join('/') === rest.join('/'));
      assert.ok(file?.content.includes(from), `${target}: el texto del sabotaje ya no está`);
      assert.ok(tokenCases(model).some((entry) => defects.includes(entry.defect)), `${design}: ningún caso de ${defects.join(', ')}`);
    }
  });
}

test('sin proveedor no se emite la prueba', () => {
  assert.equal(emitted(plan('asset-vault', 'none').files), undefined);
});
