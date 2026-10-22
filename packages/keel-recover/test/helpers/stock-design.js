import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// El diseño recuperado de juguete del legacy de fixture `fixtures/sandbox/node-mongo` (stock): sus
// escenarios de caracterización con los pasos en bloques ```keel-flow```, su provenance.yaml y su
// contract-map.yaml. Lo usan `test/characterize.test.js` (contra un legacy falso en memoria que se
// porta como server.js) y `scripts/characterize-check.js` (contra el de verdad). Una sola fuente: si
// divergieran, el test sin red mediría otros flujos que la red en vivo.

export const SCENARIOS = `# stock — Escenarios de validación

> specs/stock v0.1.0. Escenarios de **caracterización** del legacy stock.

## Convenciones de determinación

- **Ausencia vs nulo**: un campo sin valor viaja como \`null\`.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|---|---|---|
| createItem | FL-ITM-001, FL-ITM-002, FL-ITM-003, FL-ITM-004 | pública |
| listItems | FL-ITM-001, FL-ITM-003, FL-ITM-004 | pública |

## Artículos

#### FL-ITM-001: un artículo dado de alta aparece en el listado

**Caracterización**: \`keep\`. Evidencia: recordings/round-1/P-001.

**Given**: ningún artículo.
**When** (1): \`createItem\` con \`{"sku":"a","quantity":2}\`.
**Then**: Status \`201\`; \`sku\` es \`"a"\`.
**When** (2): \`listItems\`.
**Then**: Status \`200\`; un artículo, \`a\` con cantidad \`2\`.

\`\`\`keel-flow
steps:
  - op: createItem
    input: { sku: a, quantity: 2 }
    save: { sku: sku }
    expect: { status: created, body: { sku: a } }
  - op: listItems
    expect: { status: ok, body: { items.length: 1, items.0.sku: "{{sku}}", items.0.quantity: 2 } }
\`\`\`

#### FL-ITM-002: un alta sin sku se rechaza en el borde

**Caracterización**: \`fix\` (\`fix-validation-400\`: el legacy responde \`422\`). Evidencia: recordings/round-1/P-002.

**Given**: ningún artículo.
**When**: \`createItem\` con \`{"quantity":1}\`.
**Then**: Status \`400\` con \`code: SKU_REQUIRED\`.

\`\`\`keel-flow
steps:
  - op: createItem
    input: { quantity: 1 }
    legacy: { status: 422 }
    expect: { status: 400, code: SKU_REQUIRED }
\`\`\`

#### FL-ITM-003: la cantidad que no llega es cero

**Caracterización**: \`keep\`. Evidencia: recordings/round-1/P-003.

**Given**: ningún artículo.
**When** (1): \`createItem\` con \`{"sku":"b"}\`; (2) \`createItem\` con \`{"sku":"c","quantity":5}\`.
**When** (3): \`listItems\`.
**Then**: los dos artículos, \`b\` con \`0\` y \`c\` con \`5\`, en cualquier orden.

\`\`\`keel-flow
steps:
  - { op: createItem, input: { sku: b } }
  - { op: createItem, input: { sku: c, quantity: 5 } }
  - op: listItems
    expect: { status: ok, body: { items: { sameMembers: [{ sku: b, quantity: 0 }, { sku: c, quantity: 5 }] } } }
\`\`\`

#### FL-ITM-004: una cantidad que no es un número se guarda tal cual

**Caracterización**: \`frontier\` (\`F-UNTYPED-QUANTITY\`). Evidencia: recordings/round-1/P-004.

**Given**: ningún artículo.
**When**: \`createItem\` con \`{"sku":"d","quantity":"muchos"}\`, y \`listItems\`.
**Then**: el artículo \`d\` con cantidad \`"muchos"\`.

\`\`\`keel-flow
steps:
  - { op: createItem, input: { sku: d, quantity: muchos }, expect: { status: created } }
  - op: listItems
    expect: { status: ok, body: { items.0.quantity: muchos } }
\`\`\`

#### FL-ITM-005: el listado se pagina

**Caracterización**: \`new\`. El legacy devuelve la lista entera; el servicio nuevo pagina.

**Given**: ningún artículo.
**When**: \`listItems\`.
**Then**: Status \`200\`; una página vacía.
`;

export const PROVENANCE = {
  kind: 'provenance',
  schema: 1,
  legacy: { name: 'stock', commit: 'ba04b70' },
  elements: [],
  fixes: [{ id: 'fix-validation-400', legacy: 'responde 422 a un alta sin sku', reason: 'el método exige 400 en la validación de entrada (decidido por el humano)', evidence: 'recordings/round-1/P-002.json' }],
  frontier: [{ id: 'F-UNTYPED-QUANTITY', what: 'guarda cualquier valor como cantidad', why: 'un campo del DSL tiene un tipo; «cualquier cosa» no se puede declarar', evidence: 'recordings/round-1/P-004.json' }],
};

export const CONTRACT_MAP = {
  kind: 'contract-map',
  schema: 1,
  semantics: { absentIsNull: true },
  legacy: {
    statusClasses: { ok: 200, created: 201 },
    operations: {
      listItems: { method: 'GET', path: '/items', list: '' },
      createItem: { method: 'POST', path: '/items' },
    },
  },
};

/** Escribe el diseño y el mapa en un workspace: `{ legacyDir, specDir }`. */
export function writeStockDesign(root, { scenarios = SCENARIOS, provenance = PROVENANCE, map = CONTRACT_MAP } = {}) {
  const legacyDir = path.join(root, 'legacy', 'stock');
  const specDir = path.join(root, 'specs', 'stock');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'validation-scenarios.md'), scenarios);
  fs.writeFileSync(path.join(specDir, 'provenance.yaml'), YAML.stringify(provenance));
  fs.writeFileSync(path.join(legacyDir, 'contract-map.yaml'), YAML.stringify(map));
  fs.writeFileSync(path.join(legacyDir, 'legacy.yaml'), YAML.stringify({ kind: 'legacy', schema: 1, name: 'stock', repo: '../../repo' }));
  return { legacyDir, specDir };
}

/** Un stock en memoria que se porta como fixtures/sandbox/node-mongo/repo/src/server.js. */
export function fakeStock() {
  let items = [];
  return {
    reset: async () => {
      items = [];
      return { ok: true };
    },
    http: async ({ method, url, body }) => {
      const { pathname } = new URL(url);
      if (method === 'GET' && pathname === '/items') return { status: 200, body: items.map((i) => ({ ...i })) };
      if (method === 'POST' && pathname === '/items') {
        if (!body?.sku) return { status: 422, body: { error: 'sku is required' } };
        items.push({ sku: body.sku, quantity: body.quantity || 0 });
        return { status: 201, body: { sku: body.sku } };
      }
      return { status: 404, body: { error: 'not found' } };
    },
  };
}
