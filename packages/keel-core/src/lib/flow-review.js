// `flow-review.yaml`: el careo de flujos, leído y contrastado con los escenarios actuales.
//
// El careo lo hace un agente de contexto limpio (keel-flow-review) que ejecuta cada escenario
// `FL-*` paso a paso contra el diseño. Aquí no se juzga lo que encontró —eso es del
// diseñador—: solo si el careo EXISTE, si habla de ESTOS escenarios y si dejó algo sin
// decidir. Es la misma forma que `review.yaml`, con otro sello: la revisión caduca con el
// minor del diseño, el careo con el TEXTO de los escenarios, que es lo que simuló.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { FLOW_REVIEW_FILE } from './spec-files.js';

export { FLOW_REVIEW_FILE } from './spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
let validator;

/** sha256 del documento sin retornos de carro: un checkout con autocrlf no cambia los escenarios. */
export function scenariosDigest(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : Buffer.from(String(content)).toString('latin1');
  return crypto.createHash('sha256').update(Buffer.from(text.replace(/\r/g, ''), 'latin1')).digest('hex');
}

/**
 * Estado del careo: `ok`, `missing` (no hay archivo), `stale` (otro texto de escenarios),
 * `invalid` (no cumple su schema) u `open` (hallazgos sin resolution). `detail` lo explica.
 */
export function flowReviewStatus(dir, scenariosContent) {
  const file = path.join(dir, FLOW_REVIEW_FILE);
  if (!fs.existsSync(file)) return { status: 'missing', detail: null };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { status: 'invalid', detail: `YAML inválido — ${error.message}` };
  }
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('flow-review'), 'utf8')));
  }
  if (!validator(doc)) {
    const first = validator.errors?.[0];
    return { status: 'invalid', detail: `no cumple su schema (${first?.instancePath || '/'} ${first?.message ?? ''})` };
  }
  if (doc.scenariosSha256 !== scenariosDigest(scenariosContent)) return { status: 'stale', detail: null };
  const open = (doc.findings ?? []).filter((finding) => !finding.resolution);
  if (open.length > 0) {
    return {
      status: 'open',
      detail: `${open.length} hallazgo(s) del careo sin decidir (${open.map((f) => f.flow).join(', ')}) — cada uno se cierra en el escenario, en el diseño o aceptándolo con su motivo`
    };
  }
  return { status: 'ok', detail: null };
}
