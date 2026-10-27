// La lectura POR LOTE por id de keel-dotnet: el `<Raíz>RefResolver` de las referencias embebidas (`embed`) y `FindAllById`
// en el puerto y en los dos adaptadores, con la decisión neutral de keel-core (`refTargets`, `idBatchReason`). Lo que el
// agente de la corrida asset-vault escribió a mano (`FindAllByIdIn` en el puerto, el adaptador y el handler), como las
// primeras corridas de keel-nest; keel-spring lo emitía desde siempre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { refTargets } from '@keel-system/keel-core/gen/ref-targets';
import { planFixture } from './helpers/workspace.js';

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const notesOf = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');

test('cada raíz embebida tiene su resolver por lote, registrado, y FindAllById en el puerto y en el adaptador documental', async () => {
  const { files, model } = await planFixture('asset-vault');
  const targets = refTargets(model);
  assert.ok(targets.length > 0);
  for (const { entity, ref } of targets) {
    const resolver = content(files, `/Support/${entity.name}RefResolver.cs`);
    assert.match(resolver, new RegExp(`public sealed class ${entity.name}RefResolver\\(I${entity.name}Repository repository, ${entity.name}ApplicationMapper mapper\\)`));
    assert.match(resolver, /await repository\.FindAllById\(distinct, cancellationToken\)/);
    assert.match(resolver, new RegExp(`found\\.ToDictionary\\(root => root\\.Id, mapper\\.To${ref.name}\\)`));
    assert.match(content(files, `/Repository/I${entity.name}Repository.cs`), new RegExp(`Task<IReadOnlyList<${entity.name}>> FindAllById\\(IReadOnlyCollection<Guid> ids`));
    assert.match(content(files, `/Repositories/${entity.name}Repository.cs`), /new BsonDocument\("\$in", new BsonArray\(keys\.Select\(key => /);
    assert.match(content(files, '/UseCase/UseCaseRegistration.cs'), new RegExp(`services\\.AddScoped<${entity.name}RefResolver>\\(\\);`));
  }
});

test('el handler de un listado que embebe recibe el resolver y la nota del lote; el de un elemento, la de Resolve', async () => {
  const { files } = await planFixture('asset-vault');
  const list = content(files, '/UseCases/ListAssetsQueryHandler.cs');
  assert.match(list, /OwnerRefResolver ownerRefResolver/);
  assert.match(notesOf(list), /Embed Owner: por LOTE — recoge los ids de Owner de la página, UNA llamada a await ownerRefResolver\.ResolveAll/);
  assert.doesNotMatch(list, /IOwnerRepository/);
});

test('en la rama relacional, FindAllById sobre la clave primaria; sin embed ni ids listados, ni resolver ni lote', async () => {
  const { files, model } = await planFixture('catalog-extended');
  for (const { entity } of refTargets(model)) {
    assert.match(content(files, `/Repositories/${entity.name}Repository.cs`), /Where\(r => keys\.Contains\(r\.Id\)\)/, entity.name);
  }
  const plain = await planFixture('job-dispatch');
  assert.ok(!plain.files.some((file) => /RefResolver\.cs$/.test(file.path)));
  assert.ok(!plain.files.some((file) => /FindAllById\(/.test(file.content)));
});
