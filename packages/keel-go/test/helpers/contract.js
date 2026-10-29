// El contrato HTTP que REGISTRA keel-go, leído de la tabla `routes` del Go emitido (internal/httpapi/routes.go), y el
// diseño que keel-go genera hoy de cada fixture. Lo usan la paridad del contrato y la del OpenAPI derivado.

import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { pendingLayers } from '../../src/lib/supported-features.js';
import { FIXTURES_DIR } from './workspace.js';

const STATUS = { StatusOK: 200, StatusCreated: 201, StatusAccepted: 202, StatusNoContent: 204 };
const ROW = /^\t\{(Operation: .*)\},$/gm;

/** La tabla `routes` emitida, por operación. */
export function goRoutes(files) {
  const file = files.find((f) => f.path === 'internal/httpapi/routes.go');
  const routes = new Map();
  for (const [, row] of file?.content.matchAll(ROW) ?? []) {
    const value = (key) => new RegExp(String.raw`(?:^|, )${key}: ((?:\[\]string\{[^}]*\})|[^,]+)`).exec(row)?.[1];
    const status = value('Status');
    routes.set(JSON.parse(value('Operation')), {
      method: value('Method').replace(/^http\.Method/, '').toUpperCase(),
      path: JSON.parse(value('Path')),
      status: STATUS[status?.replace(/^http\./, '')] ?? Number(status),
      location: value('Location') === 'true',
      query: [...(value('Query') ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(),
      body: value('Body') ? JSON.parse(value('Body')) : null,
      handle: /handle: \(\*api\)\.(\w+)/.exec(row)?.[1]
    });
  }
  return routes;
}

/**
 * La fixture tal como keel-go puede generarla hoy: sin las capas que su frontera todavía rechaza. Es el diseño con el
 * que se compara contra los otros generadores, que también lo generan sin ellas.
 */
export function goView(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const pending = new Set(pendingLayers(layers));
  const strippedLayers = Object.fromEntries(Object.entries(layers).filter(([layer]) => !pending.has(layer)));
  const strippedManifest = { ...manifest, layers: Object.fromEntries(Object.entries(manifest.layers ?? {}).filter(([layer]) => !pending.has(layer))) };
  return { manifest: strippedManifest, layers: strippedLayers };
}
