import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'schema');

const validators = new Map();

/** Ruta del schema de un documento de keel-recover (`runtime`, `environment`). */
export function schemaPath(kind) {
  return path.join(schemaDir, `${kind}.schema.json`);
}

/** Errores de schema de un documento, en líneas legibles (vacío si es válido). */
export function validateDoc(doc) {
  return validateAs(doc.kind, doc);
}

/** Lo mismo, para un documento que no lleva `kind` (una ronda de sondas). */
export function validateAs(kind, doc) {
  if (!validators.has(kind)) {
    if (!fs.existsSync(schemaPath(kind))) return [`kind desconocido: ${kind}`];
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validators.set(kind, ajv.compile(JSON.parse(fs.readFileSync(schemaPath(kind), 'utf8'))));
  }
  const validate = validators.get(kind);
  if (validate(doc)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}
