// Arnés compartido por los tests que ejercitan el registry de extremo a extremo
// (derivar con `keel new --from registry:` y adoptar con `keel registry get`).
//
// Nada aquí toca la red ni el HOME: el fetch se inyecta y la caché vive en un
// temporal por test.

import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { supportedDsl } from '../../src/lib/assets.js';

export const REGISTRY_URL = 'https://example.test/registry/index.json';

export const MANIFEST_ORIGIN = `# Manifiesto del servicio
keel: "2.0"

service:
  name: billing            # kebab-case
  version: 1.2.0
  description: Gestiona la facturación de pedidos.
  domain: commerce

layers:
  domain: domain.keel.yaml
  use-cases: use-cases.keel.yaml
`;

export const SCENARIOS_ORIGIN = `# Escenarios de validación — billing

> specs/billing v1.2.0. Derivados del diseño; regenerar al cambiarlo.

## FL-1 Emitir factura
`;

export const SIDECAR_ORIGIN = `family: billing
summary: Facturación de referencia.
maturity: stable
author: keel
license: Apache-2.0
`;

export const REGISTRY_FILES = {
  'specs/billing/service.keel.yaml': MANIFEST_ORIGIN,
  'specs/billing/domain.keel.yaml': 'entities:\n  Invoice:\n    fields: {}\n',
  'specs/billing/use-cases.keel.yaml': 'operations: {}\n',
  'specs/billing/design.yaml': SIDECAR_ORIGIN,
  'specs/billing/validation-scenarios.md': SCENARIOS_ORIGIN,
  'docs/billing/DESIGN.md': '# Diseño de billing\n',
  'docs/billing/overview.html': '<html></html>',
  'docs/billing/postman/billing-collection.json': '{}'
};

/**
 * fetch de mentira servido por un mapa de rutas. `missing` quita archivos que el
 * índice sí lista, para ejercitar la degradación (un derivado que no descarga es
 * aviso, no error). `derivatives` alimenta el aviso de registry incompleto.
 */
export function registryFixture({ files, missing = [], derivatives = {}, dsl = supportedDsl()[0] }) {
  const index = {
    schemaVersion: 1,
    designs: [
      {
        slug: 'billing',
        family: 'billing',
        variant: null,
        service: { name: 'billing', version: '1.2.0', dsl, domain: 'commerce', basedOn: null, description: 'Facturación.' },
        metadata: null,
        layers: ['domain', 'use-cases'],
        counts: {},
        status: { ok: true, pending: 0, errors: 0 },
        derivatives,
        docs: { design: 'docs/billing/DESIGN.md', overview: null, integration: null },
        files: Object.keys(files)
      }
    ],
    families: []
  };
  const routes = { [REGISTRY_URL]: JSON.stringify(index) };
  for (const [file, body] of Object.entries(files)) routes[`https://example.test/registry/${file}`] = body;
  for (const file of missing) delete routes[`https://example.test/registry/${file}`];

  return async (url) => {
    const body = routes[typeof url === 'string' ? url : url.toString()];
    if (body === undefined) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
}

/**
 * Instala el fetch de mentira como global (downloadDesign usa globalThis.fetch)
 * y devuelve las opciones que esperan los comandos.
 */
export function withRegistry(t, fetchImpl) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const cacheDir = tmpDir('keel-regcache-');
  t.after(() => {
    globalThis.fetch = previous;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
  return { source: REGISTRY_URL, fetchImpl, cacheDir };
}

/**
 * Workspace de mentira con el cwd dentro. `localOrigin` siembra specs/billing
 * para los tests de derivación local; los del registry no lo necesitan.
 */
export function makeWorkspace(t, { localOrigin = true } = {}) {
  const base = tmpDir('keel-derive-');
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  t.after(() => {
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
    fs.rmSync(base, { recursive: true, force: true });
  });

  // isKeelWorkspace solo comprueba que exista schema/service.schema.json
  fs.mkdirSync(path.join(base, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(base, 'schema', 'service.schema.json'), '{}');

  if (localOrigin) {
    const originDir = path.join(base, 'specs', 'billing');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'service.keel.yaml'), MANIFEST_ORIGIN);
    fs.writeFileSync(path.join(originDir, 'domain.keel.yaml'), 'entities:\n  Invoice:\n    fields: {}\n');
    fs.writeFileSync(path.join(originDir, 'use-cases.keel.yaml'), 'operations: {}\n');
    fs.writeFileSync(path.join(originDir, 'validation-scenarios.md'), SCENARIOS_ORIGIN);
  }

  process.chdir(base);
  return base;
}
