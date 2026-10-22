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
  if (!validators.has(doc.kind)) {
    if (!fs.existsSync(schemaPath(doc.kind))) return [`kind desconocido: ${doc.kind}`];
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validators.set(doc.kind, ajv.compile(JSON.parse(fs.readFileSync(schemaPath(doc.kind), 'utf8'))));
  }
  const validate = validators.get(doc.kind);
  if (validate(doc)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}
