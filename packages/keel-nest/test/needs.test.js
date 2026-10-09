// El dato que se PIDE a otro servidor bajo demanda (`dependencies.needs`, strategy on-demand; incremento 13i). Lo
// que build pone, el mismo reparto que keel-spring: el puerto del cliente inyectado en el handler de la operación
// que lo usa (`usedBy`) con la nota de su política, y la política del diseño (`onUnavailable`) en el fallback del
// adaptador. `fail` se EJECUTA contra un proveedor que no contesta; `degrade` deja el TODO con el resultado que el
// diseño describe; `lastKnown` y la réplica siguen fuera de la frontera (13j).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { planFixture, transpileTree } from './helpers/emitted.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;
const ASSET_ID = '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f';
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

test('asset-vault: el handler de getAsset recibe el puerto del renderizador y la nota de cómo pedir la miniatura', () => {
  const files = byPath(planFixture('asset-vault').files);
  const handler = files['src/application/usecases/get-asset-query-handler.ts'];
  assert.match(handler, /static readonly inject = \[[^\]]*RenderingClient[^\]]*\] as const;/);
  assert.match(handler, /import \{ RenderingClient \} from '\.\.\/\.\.\/domain\/clients\/rendering-client\.js';/);
  assert.match(handler, /Dependencia rendering\.thumbnail \(on-demand\)/);
  assert.match(handler.replace(/\n\s*\/\/\s*/g, ' '), /await this\.renderingClient\.getThumbnail\(\.\.\.\), que ya devuelve el resultado de dominio \(GetThumbnailResult\)/);
});

test('onUnavailable: fail — con el proveedor caído, el adaptador lanza el error que declara el diseño', async (t) => {
  const { files } = planFixture('asset-vault', {
    mutate: (layers) => {
      layers.dependencies.dependencies.rendering.needs.thumbnail.onUnavailable = { action: 'fail', error: 'ASSET_NOT_FOUND' };
    }
  });
  const adapterSource = byPath(files)['src/infrastructure/clients/rendering-http-adapter.ts'];
  assert.match(adapterSource, /Política declarada por el need rendering\.thumbnail \(onUnavailable: fail\)/);
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { RenderingHttpAdapter } = await tree.load('src/infrastructure/clients/rendering-http-adapter.ts');
  const { RenderingMapper } = await tree.load('src/infrastructure/clients/rendering-mapper.ts');
  const { AssetNotFoundError } = await tree.load('src/domain/errors/asset-not-found-error.ts');
  // Un proveedor que corta cada conexión: transporte, se reintenta y cae al fallback.
  let requests = 0;
  const server = http.createServer((request) => {
    requests++;
    request.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = new RenderingHttpAdapter({ rendering: { id: 'rendering', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500, headers: {} } }, new RenderingMapper());
  await assert.rejects(adapter.getThumbnail(ASSET_ID), (error) => error instanceof AssetNotFoundError && /rendering no está disponible para thumbnail/.test(error.message));
  assert.equal(requests, 2, 'retry.maxAttempts: 2 antes de rendirse');
});

test('onUnavailable: degrade — el fallback deja al agente el resultado degradado que describe el diseño', () => {
  const { files } = planFixture('asset-vault', {
    mutate: (layers) => {
      layers.dependencies.dependencies.rendering.needs.thumbnail.onUnavailable = { action: 'degrade', degradedTo: 'La ficha sale sin miniatura.' };
    }
  });
  const adapterSource = byPath(files)['src/infrastructure/clients/rendering-http-adapter.ts'];
  assert.match(adapterSource, /onUnavailable: degrade/);
  assert.match(adapterSource, /\/\/ {3}La ficha sale sin miniatura\./);
  const handler = byPath(files)['src/application/usecases/get-asset-query-handler.ts'];
  assert.match(handler.replace(/\n\s*\/\/\s*/g, ' '), /el fallback del adaptador ya aplica onUnavailable: degrade/);
});
