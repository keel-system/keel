// `fixtures.yaml`: el estado de partida de los escenarios, en los nombres del DISEÑO.
//
// Existe por la corrida de control de shop-api (2026-10-23): los flujos recuperados de un legacy partían de su seed
// (productos, categorías que ninguna operación crea, pedidos con ids estables) y el diseño no tenía dónde decirlo, así
// que el `reset-db.sh` del regenerado dejaba la base vacía y 71 de 92 escenarios fallaron por precondición. Los registros
// se escriben con entidades, campos y valores de enum del diseño, nunca con columnas: quien los carga (el generador, la
// paridad de keel-recover) los traduce con su propio mapeo.
//
// Aquí solo se LEE y se CRUZA con las capas. Los errores van con el nombre del archivo delante, como los de
// decisions.yaml: un registro que no casa con el dominio es una incoherencia que se corrige, y tumba `ok`.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { FIXTURES_FILE } from './spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { FIXTURES_FILE } from './spec-files.js';

let validator;

/**
 * Lee `fixtures.yaml` del servicio. Su ausencia no es un error: un diseño cuyos escenarios crean sus propios datos no
 * lo necesita.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function loadFixtures(dir) {
  const file = path.join(dir, FIXTURES_FILE);
  if (!fs.existsSync(file)) return { doc: null, errors: [] };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, errors: [`${FIXTURES_FILE}: YAML inválido — ${error.message}`] };
  }
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('fixtures'), 'utf8')));
  }
  if (!validator(doc)) {
    return { doc: null, errors: validator.errors.map((e) => `${FIXTURES_FILE}: ${e.instancePath || '/'} ${e.message}`) };
  }
  return { doc, errors: [] };
}

const INTEGER = new Set(['int', 'integer', 'long', 'short']);
const NUMBER = new Set(['decimal', 'number', 'float', 'double']);
const TEXT = new Set(['string', 'text', 'email', 'url', 'uuid']);
const TIME = new Set(['timestamp', 'date', 'datetime', 'instant']);

const isToMany = (relation) => relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';
const idFieldOf = (entity) => Object.entries(entity?.fields ?? {}).find(([, field]) => field?.id)?.[0] ?? null;

/** El tipo base al que se reduce un tipo del dominio (un alias escalar: `type: Email` → `string`). */
function resolveType(types, name, seen = new Set()) {
  const declared = types?.[name];
  if (!declared || seen.has(name)) return { base: name };
  if (Array.isArray(declared.values)) return { enum: declared.values };
  if (declared.fields) return { composite: declared.fields };
  seen.add(name);
  return declared.type ? resolveType(types, declared.type, seen) : { base: name };
}

function valueError(types, field, value) {
  if (value === null) return field.required && field.default === undefined && !field.generated ? 'es obligatorio y viene null' : null;
  const resolved = resolveType(types, field.type);
  if (resolved.enum) return resolved.enum.includes(value) ? null : `el valor ${JSON.stringify(value)} no es de su enum ${field.type} (${resolved.enum.join(', ')})`;
  if (resolved.composite) return value && typeof value === 'object' && !Array.isArray(value) ? null : `es un ${field.type} y no trae un objeto con sus campos`;
  const base = resolved.base;
  if (INTEGER.has(base)) return Number.isInteger(value) ? null : `es ${base} y no trae un entero (${JSON.stringify(value)})`;
  if (NUMBER.has(base)) return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) ? null : `es ${base} y no trae un número (${JSON.stringify(value)})`;
  if (base === 'boolean') return typeof value === 'boolean' ? null : `es boolean y no trae true/false (${JSON.stringify(value)})`;
  if (TIME.has(base)) return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `es ${base} y no trae una fecha ISO-8601 (${JSON.stringify(value)})`;
  if (TEXT.has(base)) return typeof value === 'string' ? null : `es ${base} y no trae texto (${JSON.stringify(value)})`;
  return null;
}

/**
 * Los registros contra las capas: la entidad existe y se persiste, cada campo existe y su valor casa con su tipo (un
 * enum, con uno de sus valores), están los obligatorios, cada registro lleva su id sin repetirlo, y cada relación a-uno
 * apunta a un registro que existe. Una relación a-muchos no se escribe: la lleva el otro lado.
 *
 * @returns {string[]} los errores, con el nombre del archivo delante.
 */
export function checkFixtures(layers, doc) {
  if (!doc) return [];
  const errors = [];
  const say = (where, message) => errors.push(`${FIXTURES_FILE}: ${where} ${message}`);
  const entities = layers?.domain?.entities ?? {};
  const types = layers?.domain?.types ?? {};
  const persistence = layers?.persistence;
  const ids = new Map();

  for (const [name, block] of Object.entries(doc.entities ?? {})) {
    const entity = entities[name];
    if (!entity) {
      say(name, 'no es una entidad del dominio');
      continue;
    }
    if (!persistence || persistence.entities?.[name]?.persisted === false) {
      say(name, 'no se persiste (persistence.entities): no hay dónde cargar sus registros');
      continue;
    }
    const idField = idFieldOf(entity);
    const seen = new Set();
    ids.set(name, seen);
    (block.records ?? []).forEach((record, index) => {
      const where = `${name}[${index}]`;
      if (idField && (record[idField] === undefined || record[idField] === null)) say(where, `no lleva su id (${idField})`);
      else if (idField) {
        const key = JSON.stringify(record[idField]);
        if (seen.has(key)) say(where, `repite el id ${key}`);
        seen.add(key);
      }
      for (const [key, value] of Object.entries(record)) {
        const field = entity.fields?.[key];
        const relation = entity.relations?.[key];
        if (field) {
          if (field.list) {
            say(`${where}.${key}`, 'es una colección (list): fixtures.yaml todavía no carga colecciones de valores');
            continue;
          }
          const problem = valueError(types, field, value);
          if (problem) say(`${where}.${key}`, problem);
        } else if (relation) {
          if (isToMany(relation)) say(`${where}.${key}`, `es una relación ${relation.cardinality}: no se escribe aquí, la lleva cada registro de ${relation.entity}`);
          else if (value === null && relation.required) say(`${where}.${key}`, 'es una relación obligatoria y viene null');
        } else {
          say(`${where}.${key}`, `no es un campo ni una relación de ${name}`);
        }
      }
      for (const [key, field] of Object.entries(entity.fields ?? {})) {
        if (!field.required || field.id || field.generated || field.computed || field.default !== undefined) continue;
        if (!(key in record)) say(where, `no trae ${key}, que es obligatorio y no tiene default`);
      }
      for (const [key, relation] of Object.entries(entity.relations ?? {})) {
        if (relation.required && !isToMany(relation) && !(key in record)) say(where, `no trae la relación ${key}, que es obligatoria`);
      }
    });
  }

  // Las relaciones, con todos los ids ya leídos: el orden del archivo no es el de carga.
  for (const [name, block] of Object.entries(doc.entities ?? {})) {
    const entity = entities[name];
    if (!entity || !ids.has(name)) continue;
    (block.records ?? []).forEach((record, index) => {
      for (const [key, relation] of Object.entries(entity.relations ?? {})) {
        if (isToMany(relation) || record[key] === undefined || record[key] === null) continue;
        const target = ids.get(relation.entity);
        if (!target) say(`${name}[${index}].${key}`, `apunta a ${relation.entity}, que no tiene registros en ${FIXTURES_FILE}`);
        else if (!target.has(JSON.stringify(record[key]))) say(`${name}[${index}].${key}`, `apunta a ${relation.entity} ${JSON.stringify(record[key])}, que no es ningún registro`);
      }
    });
  }
  return errors;
}
