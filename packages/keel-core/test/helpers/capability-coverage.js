// Qué capacidad OPCIONAL del DSL declara alguna fixture: el enumerador que comparten los `capability-coverage.test.js`
// de los generadores (keel-spring y keel-nest leen las MISMAS fixtures, fixtures/designs/ en la raíz del monorepo).
//
// Se recorren schema y datos JUNTOS porque el camino de datos depende del schema: un `additionalProperties` es un mapa
// cuyas claves son nombres del diseño, no propiedades del DSL, y sin el schema delante no hay forma de distinguirlo de
// un objeto normal. Cada generador pone su tabla de EXCEPCIONES con SU motivo: lo que es informativo en uno puede ser
// una rama sin compilar en el otro.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LAYERS, schemaPathFor, loadService } from '../../src/index.js';

/** Sigue los `$ref` locales. Un `$ref` a otro archivo (common.schema.json) es una hoja. */
function resolveRef(schema, node, seen) {
  let current = node;
  while (current && current.$ref) {
    if (!current.$ref.startsWith('#/')) return null;
    if (seen.has(current.$ref)) return null;
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce((acc, key) => acc?.[key], schema);
  }
  return current;
}

/** Subesquemas que describen EL MISMO nodo de datos (allOf/anyOf/oneOf, then/else de un if). */
function branches(node) {
  const out = [node];
  for (const key of ['allOf', 'anyOf', 'oneOf']) for (const branch of node[key] ?? []) out.push(branch);
  for (const key of ['then', 'else']) if (node[key]) out.push(node[key]);
  return out;
}

/** Cuenta, por ruta de datos, cuántos valores declaran cada propiedad opcional de `node`. */
export function walk(schema, node, dataList, prefix, counts, seen) {
  const resolved = resolveRef(schema, node, new Set(seen));
  if (!resolved || typeof resolved !== 'object') return;
  for (const branch of branches(resolved)) {
    const current = branch === resolved ? resolved : resolveRef(schema, branch, new Set(seen));
    if (!current || typeof current !== 'object') continue;
    const required = new Set(current.required ?? []);
    for (const [key, sub] of Object.entries(current.properties ?? {})) {
      const dataPath = prefix ? `${prefix}.${key}` : key;
      const declared = dataList
        .filter((value) => value && typeof value === 'object' && value[key] !== undefined)
        .map((value) => value[key]);
      // La prosa queda fuera a propósito: lo que se busca es la rama de código que nadie compila.
      if (!required.has(key) && key !== 'description') {
        counts.set(dataPath, (counts.get(dataPath) ?? 0) + declared.length);
      }
      walk(schema, sub, declared, dataPath, counts, seen);
    }
    if (current.additionalProperties && typeof current.additionalProperties === 'object') {
      const values = dataList.flatMap((value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : []));
      walk(schema, current.additionalProperties, values, prefix ? `${prefix}.*` : '*', counts, seen);
    }
    if (current.items) {
      const values = dataList.flatMap((value) => (Array.isArray(value) ? value : []));
      walk(schema, current.items, values, `${prefix}[]`, counts, seen);
    }
  }
}

/** Las capas de cada fixture del directorio. */
export function fixtureLayers(fixturesDir) {
  return fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const { layers, errors } = loadService(path.join(fixturesDir, entry.name));
      assert.deepEqual(errors, [], `la fixture ${entry.name} no carga`);
      return layers;
    });
}

/** ruta → número de fixtures que la declaran. */
export function coverage(fixturesDir) {
  const counts = new Map();
  const loaded = fixtureLayers(fixturesDir);
  for (const layer of LAYERS) {
    const schema = JSON.parse(fs.readFileSync(schemaPathFor(layer), 'utf8'));
    const data = loaded.map((layers) => layers[layer]).filter(Boolean);
    walk(schema, schema, data, layer, counts, new Set());
  }
  return counts;
}

/** Las capacidades opcionales que no declara ninguna fixture, ordenadas. */
export function uncovered(fixturesDir) {
  return [...coverage(fixturesDir)]
    .filter(([, declaradas]) => declaradas === 0)
    .map(([dataPath]) => dataPath)
    .sort();
}
