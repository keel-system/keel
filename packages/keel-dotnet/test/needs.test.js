// El dato que una operación PIDE a otro servidor bajo demanda (`dependencies.needs`, strategy on-demand, incremento 13i),
// sobre el texto emitido:
//
//   · el handler de la operación del `usedBy` recibe el puerto del cliente y la nota de la política, como en keel-spring y
//     keel-nest (sin el puerto delante, el camino de menor resistencia es no pedirlo);
//   · `onUnavailable` va en el fallback del adaptador: `fail` lanza el error del diseño y `degrade` deja el TODO con el
//     `degradedTo` del diseño;
//   · la prueba emitida del adaptador afirma el `fail`.
// Lo que EJECUTA el C# (el fallback contra un proveedor caído) lo mide la prueba emitida OutboundClientsTests en
// `npm run cs-check` sobre la variante asset-vault-need-fail, falsada con `--sabotage=need-fail`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const notesOf = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');

const failing = (manifest, layers) => {
  layers['use-cases'].operations.getAsset.errors = [
    ...(layers['use-cases'].operations.getAsset.errors ?? []),
    { code: 'RENDERING_UNAVAILABLE', when: 'El renderizador no responde.', http: 503 }
  ];
  layers.dependencies.dependencies.rendering.needs.thumbnail.onUnavailable = { action: 'fail', error: 'RENDERING_UNAVAILABLE' };
};

test('el handler del usedBy recibe el cliente y la nota del need; los demás handlers no', async () => {
  const { files, model } = await planFixture('asset-vault');
  const handler = content(files, '/UseCases/GetAssetQueryHandler.cs');
  assert.match(handler, /IRenderingClient renderingClient/);
  const notes = notesOf(handler);
  assert.match(notes, /Dependencia rendering\.thumbnail \(on-demand\)/);
  assert.match(notes, /pide el dato con await renderingClient\.GetThumbnail\(\.\.\., cancellationToken\), que ya devuelve el resultado de dominio/);
  assert.match(notes, /el fallback del adaptador ya aplica onUnavailable: degrade/);
  assert.match(notes, /El dato SALE en la respuesta: el mapper pide un \w+ por parámetro y lo pone en el campo 'thumbnail'/);
  // Ni el cliente ni la nota en una operación que no lo pide (salvo la que lo usa por una activación).
  const users = new Set(['getAsset', 'quarantineAsset']);
  for (const operation of model.services.flatMap((s) => s.operations).filter((op) => !users.has(op.name))) {
    assert.doesNotMatch(content(files, `/UseCases/${operation.handlerClass}.cs`) ?? '', /IRenderingClient/, operation.name);
  }
});

test('degrade deja en el fallback el TODO con el degradedTo del diseño', async () => {
  const { files } = await planFixture('asset-vault');
  const adapter = content(files, '/Clients/RenderingHttpAdapter.cs');
  assert.match(adapter, /Política declarada por el need rendering\.thumbnail \(onUnavailable: degrade\)/);
  assert.match(adapter, /La ficha se devuelve completa con thumbnail nulo/);
});

test('fail lanza el error del diseño desde el fallback, y la prueba emitida del adaptador lo afirma', async () => {
  const { files } = await planFixture('asset-vault', { mutate: failing });
  const adapter = content(files, '/Clients/RenderingHttpAdapter.cs');
  assert.match(adapter, /Política declarada por el need rendering\.thumbnail \(onUnavailable: fail\)\.\s+throw new RenderingUnavailableError\("rendering no está disponible para thumbnail"\);/);
  const tests = content(files, '/OutboundClientsTests.cs');
  assert.match(tests, /public async Task RenderingHttpAdapterGetThumbnailConElProveedorCaidoLanzaElErrorDelDiseno\(\)/);
  assert.match(tests, /Assert\.ThrowsAsync<AssetVault\.Domain\.Errors\.RenderingUnavailableError>/);
  assert.match(tests, /Assert\.Equal\("RENDERING_UNAVAILABLE", error\.Code\);/);
  assert.match(notesOf(content(files, '/UseCases/GetAssetQueryHandler.cs')), /onUnavailable: fail; no lo captures/);
});
