// La prueba del contrato del token (casos IDT-*) que build deja en el proyecto. Ejecutarla necesita Go: lo hace
// `go-check --token` sobre los sujetos de test/helpers/token-sabotages.js, y cada sabotaje cae en exactamente sus casos.
// Aquí, sin Go: el Go de cada sujeto (también el que solo sale con Cognito, que go-syntax no recorre) parsea y sus imports
// se usan, hay una prueba por caso, y los sabotajes siguen aplicándose a lo emitido.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { planService } from '../src/scaffold/index.js';
import { TOKEN_CONTRACT_TEST, tokenCaseTest } from '../src/scaffold/token-contract-test.js';
import { TOKEN_SABOTAGES, TOKEN_SUBJECTS, applyTokenEdit } from './helpers/token-sabotages.js';
import { checkGoTree } from './helpers/go-tree.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(subject) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, subject.from));
  manifest.service.name = subject.name;
  subject.mutate?.(layers);
  return planService({ manifest, layers, workspace: '.', stack: { auth: subject.auth } });
}

const fileOf = (files, wanted) => files.find((file) => file.path.split(path.sep).join('/') === wanted);

for (const subject of TOKEN_SUBJECTS) {
  test(`${subject.name}: una prueba por caso del token, y el Go parsea con sus imports usados`, async () => {
    const { files, model } = plan(subject);
    const content = fileOf(files, `internal/httpapi/${TOKEN_CONTRACT_TEST}`)?.content;
    assert.ok(content, `emite ${TOKEN_CONTRACT_TEST}`);
    const emitted = [...content.matchAll(/^func (TestIDT\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);
    // Un caso cuya única afirmación no lee ninguna pieza del diseño (la audiencia, sin validateAudience) no se emite.
    const cases = tokenCases(model).map((entry) => ({ ...entry, test: tokenCaseTest(entry.id) }));
    assert.ok(emitted.length > 0);
    assert.deepEqual(emitted, cases.map((entry) => entry.test).filter((name) => emitted.includes(name)));
    for (const entry of cases.filter((candidate) => candidate.defect)) assert.ok(emitted.includes(entry.test), `${entry.id} (${entry.defect}) no se emite`);
    assert.deepEqual(await checkGoTree(files, model.service.goModule), []);
  });
}

test('cada defecto de D1 a D4 tiene su caso en algún sujeto con Cognito', () => {
  const defects = TOKEN_SUBJECTS.filter((subject) => subject.auth === 'cognito').flatMap((subject) => tokenCases(plan(subject).model).map((entry) => entry.defect));
  assert.deepEqual([...new Set(defects.filter(Boolean))].sort(), ['D1', 'D2', 'D3', 'D4']);
});

for (const sabotage of TOKEN_SABOTAGES) {
  test(`el sabotaje ${sabotage.id} se aplica a lo emitido y tiene casos que tumbar`, () => {
    for (const edit of sabotage.edits) {
      const subject = TOKEN_SUBJECTS.find((candidate) => candidate.name === edit.subject);
      const { files, model } = plan(subject);
      assert.ok(applyTokenEdit(edit, fileOf(files, edit.file)?.content ?? ''), `${edit.subject}/${edit.file}: el texto del sabotaje ya no está`);
      assert.ok(tokenCases(model).some((entry) => sabotage.defects.includes(entry.defect)), `${edit.subject}: ningún caso de ${sabotage.defects.join(', ')}`);
    }
  });
}

test('sin proveedor no se emite la prueba', () => {
  const { files } = plan({ name: 'asset-vault', from: 'asset-vault', auth: 'none' });
  assert.equal(fileOf(files, `internal/httpapi/${TOKEN_CONTRACT_TEST}`), undefined);
});
