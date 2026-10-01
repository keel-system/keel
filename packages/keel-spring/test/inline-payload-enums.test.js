// Un enum inline en el payload de una OPERACIÓN o de un MENSAJE tiene que existir como clase.
//
// `payloadFields` le da nombre (`<Op><Campo>`, `<Evento><Campo>`) y el command, el DTO o el
// evento generados lo importan de `domain.enums`; `collectEnums` solo recorría types, entidades y
// http-clients, así que el import apuntaba a una clase que nadie emitía y el proyecto recién
// generado NO COMPILABA. Lo destapó la corrida `notifications` (2026-09-30) con
// `reportEmailBounce.input.bounceType` y `suppressAddress.input.reason`; ninguna fixture tenía esa
// forma, de ahí que ninguna suite lo viera.
//
// Dos comprobaciones: el caso concreto, con el diseño parcheado en memoria, y el invariante
// general sobre TODAS las fixtures —todo `domain.enums.X` importado se emite—, que es el que
// habría cazado este defecto sin necesitar saber de antemano dónde iba a aparecer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function plan(name, patch = null) {
  const dir = path.join(fixturesDir, name);
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  if (patch) patch(patched);
  return planService({ manifest, layers: patched, workspace: dir });
}

/** Los `import <paquete>.domain.enums.X;` que no tienen su `domain/enums/X.java` en el árbol. */
function danglingEnumImports(files) {
  const emitted = new Set(
    files
      .map((f) => f.path.match(/\/domain\/enums\/([A-Za-z0-9_]+)\.java$/)?.[1])
      .filter(Boolean)
  );
  const dangling = new Set();
  for (const f of files) {
    if (!f.path.endsWith('.java')) continue;
    for (const [, name] of f.content.matchAll(/^import [\w.]+\.domain\.enums\.([A-Za-z0-9_]+);$/gm)) {
      if (!emitted.has(name)) dangling.add(`${name} (en ${f.path})`);
    }
  }
  return [...dangling];
}

test('un enum inline en el input de una operación y en el payload de un evento se emite como clase', () => {
  const { files } = plan('catalog-extended', (layers) => {
    layers['use-cases'].operations.retireProduct.input.fields.reason = {
      type: 'enum',
      values: ['discontinued', 'recalled'],
      required: true,
      description: 'Motivo de la retirada.'
    };
    layers.messaging.publishing.events.ProductCreated.payload.origin = {
      type: 'enum',
      values: ['manual', 'import'],
      required: false
    };
  });

  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const opEnum = [...byPath.keys()].find((p) => p.endsWith('/domain/enums/RetireProductReason.java'));
  assert.ok(opEnum, 'falta domain/enums/RetireProductReason.java');
  assert.match(byPath.get(opEnum), /DISCONTINUED\("discontinued"\)/);
  assert.match(byPath.get(opEnum), /RECALLED\("recalled"\)/);

  const eventEnum = [...byPath.keys()].find((p) => p.endsWith('/domain/enums/ProductCreatedOrigin.java'));
  assert.ok(eventEnum, 'falta domain/enums/ProductCreatedOrigin.java');

  // Y quien lo usa lo importa: si el nombre emitido y el referenciado divergieran, el test de
  // abajo lo vería igual, pero aquí se dice qué archivo concreto lo necesita.
  const command = [...byPath.entries()].find(([p]) => p.endsWith('/RetireProductCommand.java'));
  assert.ok(command, 'falta RetireProductCommand.java');
  assert.match(command[1], /RetireProductReason reason/);
  assert.deepEqual(danglingEnumImports(files), []);
});

test('ningún archivo generado importa un enum de domain.enums que build no emite (todas las fixtures)', () => {
  for (const name of fs.readdirSync(fixturesDir)) {
    if (!fs.existsSync(path.join(fixturesDir, name, 'service.keel.yaml'))) continue;
    const { files } = plan(name);
    assert.deepEqual(danglingEnumImports(files), [], `fixture ${name}`);
  }
});
