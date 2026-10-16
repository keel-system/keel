// El puerto IAfterCommit de keel-dotnet, gemelo del AfterCommit de keel-spring y keel-nest: la corrida catalog-dotnet
// (2026-10-16) se paró en removeProductImage porque la única vía para «borrar el binario tras confirmar» vivía en
// Infrastructure, y el agente acabó borrándolo dentro de la transacción.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';
import { generate } from '../src/scaffold/after-commit.js';

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

for (const fixture of ['catalog-extended', 'asset-vault']) {
  test(`${fixture}: el puerto en Application sin nada de Infrastructure, y su adaptador registrado sobre la transacción`, async () => {
    const { files } = await planFixture(fixture);
    const port = files.find((file) => /\.Application\/Ports\/IAfterCommit\.cs$/.test(file.path));
    assert.ok(port, 'falta el puerto');
    assert.match(port.content, /public interface IAfterCommit\s*\{\s*Task Run\(Func<Task> action\);\s*\}/);
    assert.doesNotMatch(port.content, /Infrastructure|PersistenceTransactions/);
    const adapter = content(files, '/Persistence/AfterCommitAdapter.cs');
    // Sin transacción, el efecto ocurre antes de volver: AfterCommitOrNow, no el AfterCommit que lo lanza sin esperar.
    assert.match(adapter, /AfterCommitAdapter\(PersistenceTransactions transactions\) : IAfterCommit/);
    assert.match(adapter, /=> transactions\.AfterCommitOrNow\(action\);/);
    assert.match(content(files, '/Persistence/PersistenceRegistration.cs'), /services\.AddScoped<IAfterCommit, AfterCommitAdapter>\(\);/);
  });
}

test('sin persistencia no hay transacción que esperar: ni puerto ni adaptador', async () => {
  const { model } = await planFixture('catalog-extended');
  assert.deepEqual(generate({ ...model, layersPresent: { ...model.layersPresent, persistence: false } }), []);
});
