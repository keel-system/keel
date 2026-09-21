// `flow-review.yaml`: el careo de flujos, leído y contrastado con los escenarios actuales.
//
// El careo lo hace un agente de contexto limpio (keel-flow-review) que ejecuta cada escenario
// `FL-*` paso a paso contra el diseño. Aquí no se juzga lo que encontró —eso es del
// diseñador—: solo si el careo EXISTE, QUÉ parte de él sigue hablando de los escenarios de
// ahora, y si queda presupuesto para otra pasada.
//
// Las dos cosas que este módulo añade sobre `review.yaml`, y las dos existen porque el careo
// no es una lectura sino una EJECUCIÓN, y cuesta (~185k tokens y ~4 minutos sobre 26 flujos):
//
//   · **Sello por flujo.** Con un solo sello del documento, corregir un escenario caduca el
//     careo entero. Con uno por bloque se recarea lo que cambió y nada más.
//   · **Presupuesto.** Cada pasada encuentra algo nuevo —medido: sobre `catalog` 0.1.1, ya
//     corregido, salieron 24 hallazgos—, así que «carear hasta que no haya hallazgos» no
//     termina. Al agotarlo, lo que queda abierto se DECIDE. Un gate que no termina se aprende
//     a ignorar, que es lo contrario de lo que se buscaba.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { FLOW_REVIEW_FILE } from './spec-files.js';
import { splitScenarioBlocks, scenarioFamilyOf, scenarioIdOf, scenarioBody } from './scenario-blocks.js';

export { FLOW_REVIEW_FILE } from './spec-files.js';

/**
 * Pasadas por versión de diseño. Tres, y no es un número redondo cualquiera: la primera
 * encuentra lo gordo, la segunda cierra lo que las correcciones movieron y la tercera es el
 * margen. A partir de ahí, seguir careando deja de ser cerrar el diseño y pasa a ser pulirlo —
 * y si en la tercera siguen saliendo clases NUEVAS de contradicción, lo que dice el careo es
 * que el diseño no está listo para cerrarse, que es una conversación y no otra pasada.
 */
export const MAX_PASSES = 3;

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
let validator;

/** sha256 de un texto sin retornos de carro: un checkout con autocrlf no cambia el diseño. */
export function scenariosDigest(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : Buffer.from(String(content)).toString('latin1');
  return crypto.createHash('sha256').update(Buffer.from(text.replace(/\r/g, ''), 'latin1')).digest('hex');
}

/** Los bloques del documento como `{ id, digest }`: el id es el del BLOQUE (`FL-A-001-B` incluido). */
export function flowDigests(scenariosContent) {
  const text = Buffer.isBuffer(scenariosContent) ? scenariosContent.toString('utf8') : String(scenariosContent ?? '');
  return splitScenarioBlocks(text).map((block) => ({ id: scenarioIdOf(block), digest: scenariosDigest(scenarioBody(block)) }));
}

/**
 * Qué hacer con el careo de este diseño.
 *
 * `status`:
 *   `missing`    no hay careo — pasada completa.
 *   `invalid`    el archivo no cumple su schema.
 *   `stale`      hay flujos que el careo ya no describe — pasada sobre `scope`.
 *   `open`       al día, con hallazgos sin decidir y presupuesto para otra pasada si hiciera falta.
 *   `exhausted`  presupuesto agotado y hallazgos abiertos: se DECIDEN, no se recarea.
 *   `ok`         careado y todo decidido.
 *
 * `scope` son los flujos a recarear (vacío = todos, cuando no hay careo previo).
 */
export function flowReviewPlan(dir, scenariosContent) {
  const file = path.join(dir, FLOW_REVIEW_FILE);
  const blocks = flowDigests(scenariosContent);
  if (!fs.existsSync(file)) {
    return { status: 'missing', detail: null, passes: 0, nextPass: 1, scope: blocks.map((b) => b.id), full: true };
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { status: 'invalid', detail: `YAML inválido — ${error.message}`, passes: 0, nextPass: 1, scope: [], full: true };
  }
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('flow-review'), 'utf8')));
  }
  if (!validator(doc)) {
    const first = validator.errors?.[0];
    return {
      status: 'invalid',
      detail: `no cumple su schema (${first?.instancePath || '/'} ${first?.message ?? ''})`,
      passes: 0,
      nextPass: 1,
      scope: [],
      full: true
    };
  }

  const passes = doc.passes;
  const findings = doc.findings ?? [];
  const open = findings.filter((finding) => !finding.resolution);
  const budgetLeft = passes < MAX_PASSES;

  // Un hallazgo cerrado tocando el YAML invalida el careo ENTERO, no solo su flujo: lo que se
  // simuló de los demás salía de un diseño que ya no es este.
  const designChanged = findings.some((finding) => finding.resolution === 'design');
  const sealed = new Map((doc.flows ?? []).map((entry) => [entry.id, entry.sha256]));
  const changed = blocks.filter((block) => sealed.get(block.id) !== block.digest).map((block) => block.id);
  // Un flujo con un hallazgo `cross-flow` vuelve a entrar aunque su propio texto no haya
  // cambiado: ESE hallazgo dice que depende de otro flujo, así que corregir el otro puede
  // haberlo movido. Los demás hallazgos no arrastran a nadie — meter todo flujo que alguna vez
  // tuvo un hallazgo devuelve el careo entero, que es justo lo que el sello por flujo evita.
  const dependent = new Set(
    findings.filter((f) => f.kind === 'cross-flow').map((f) => scenarioFamilyOf(String(f.flow ?? '')))
  );
  const scope = designChanged
    ? blocks.map((b) => b.id)
    : changed.length === 0
      ? []
      : [...new Set([...changed, ...blocks.map((b) => b.id).filter((id) => dependent.has(scenarioFamilyOf(id)))])];

  const stale = doc.scenariosSha256 !== scenariosDigest(scenariosContent) || scope.length > 0;
  if (stale && !budgetLeft) {
    return {
      status: 'exhausted',
      detail: `el careo no describe los escenarios de ahora y ya se han hecho ${passes} pasadas sobre esta versión (tope ${MAX_PASSES})`,
      passes,
      nextPass: null,
      scope,
      full: designChanged
    };
  }
  if (stale) {
    return {
      status: 'stale',
      detail: designChanged
        ? 'un hallazgo se cerró cambiando el YAML, así que lo careado sobre el diseño anterior deja de valer: toca pasada completa'
        : `flujos por recarear: ${scope.join(', ')}`,
      passes,
      nextPass: passes + 1,
      scope,
      full: designChanged || scope.length === blocks.length
    };
  }
  if (open.length === 0) return { status: 'ok', detail: null, passes, nextPass: null, scope: [], full: false };
  return {
    status: budgetLeft ? 'open' : 'exhausted',
    detail: `${open.length} hallazgo(s) del careo sin decidir (${[...new Set(open.map((f) => f.flow))].join(', ')})`,
    passes,
    nextPass: budgetLeft ? passes + 1 : null,
    scope: [],
    full: false
  };
}
