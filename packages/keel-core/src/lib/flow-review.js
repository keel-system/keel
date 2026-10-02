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
import { versionShape } from './decisions.js';
import { splitScenarioBlocks, scenarioFamilyOf, scenarioIdOf, scenarioBody, conventionsText } from './scenario-blocks.js';

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

/**
 * El sello de la sección «Convenciones de determinación» (vacía si el documento no la tiene).
 * Es el tercer sello del careo, junto al de cada flujo: las convenciones cambian el significado de
 * todos los `Then` a la vez, así que tocarlas pide recarear el documento entero. El resto de la
 * prosa (cabecera, matriz, notas) no lo pide: la matriz ya la cruza `keel validate`.
 */
export function conventionsDigest(scenariosContent) {
  const text = Buffer.isBuffer(scenariosContent) ? scenariosContent.toString('utf8') : String(scenariosContent ?? '');
  return scenariosDigest(conventionsText(text) ?? '');
}

/** Los bloques del documento como `{ id, digest }`: el id es el del BLOQUE (`FL-A-001-B` incluido). */
export function flowDigests(scenariosContent) {
  const text = Buffer.isBuffer(scenariosContent) ? scenariosContent.toString('utf8') : String(scenariosContent ?? '');
  return splitScenarioBlocks(text).map((block) => ({ id: scenarioIdOf(block), digest: scenariosDigest(scenarioBody(block)) }));
}

/**
 * Los tres sellos de un careo, tal como van en flow-review.yaml. Es la ÚNICA forma correcta de
 * obtenerlos: el sello de un flujo es el de su bloque recortado y hasheado en latin1, cortado en el
 * siguiente encabezado `##`–`####`, y eso no se reproduce con `sha256sum`. Mientras la definición
 * del agente lo describía a mano, cada careo tenía que adivinarlo probando contra `keel validate`.
 * Lo imprime `keel seals`.
 */
export function flowSeals(scenariosContent) {
  return {
    scenariosSha256: scenariosDigest(scenariosContent),
    conventionsSha256: conventionsDigest(scenariosContent),
    flows: flowDigests(scenariosContent).map(({ id, digest }) => ({ id, sha256: digest }))
  };
}

/** Los sellos como el bloque YAML que se pega en flow-review.yaml. */
export function renderFlowSeals(seals) {
  return [
    `scenariosSha256: ${seals.scenariosSha256}`,
    `conventionsSha256: ${seals.conventionsSha256}`,
    'flows:',
    ...seals.flows.map((flow) => `  - { id: ${flow.id}, sha256: ${flow.sha256} }`)
  ].join('\n');
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
export function flowReviewPlan(dir, scenariosContent, { serviceVersion = null } = {}) {
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

  // El careo caduca con el minor o el major, como review.yaml: otra versión es otro diseño, aunque
  // sus escenarios no hayan cambiado, y le toca su careo, con el presupuesto entero. Sin esta
  // comparación, un careo de la v1 seguía valiendo para la v2, y si la v1 había gastado sus pasadas
  // la v2 nacía agotada, sin salida salvo reescribir `passes` a mano.
  if (serviceVersion && versionShape(doc.reviewedAt) !== versionShape(serviceVersion)) {
    return {
      status: 'stale',
      detail: `el careo es de la v${doc.reviewedAt} y el diseño va por la v${serviceVersion}: otra versión, careo nuevo con presupuesto entero`,
      passes: 0,
      nextPass: 1,
      scope: blocks.map((b) => b.id),
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
  // El resello acotado. Agotado el presupuesto, lo abierto se DECIDE, y decidir `scenario` es
  // editar el flujo: su sello deja de casar y, sin esto, el careo quedaba `exhausted` sin salida
  // salvo aceptar un escenario que se sabe incorrecto o subir de minor, que caduca todo lo demás.
  // Así se aceptó FL-DSP-001 en el par del MVP, y así se atascó asset-vault v1.2.0 (corrida R8).
  // Solo vale sin presupuesto, solo para el flujo exacto del hallazgo, y solo mientras su texto
  // sea el que `sealAfter` dice: una edición más lo devuelve a bloquear.
  const resealed = new Set(
    budgetLeft
      ? []
      : findings
          .filter((finding) => finding.resolution === 'scenario' && finding.sealAfter)
          .filter((finding) => blocks.some((block) => block.id === finding.flow && block.digest === finding.sealAfter))
          .map((finding) => finding.flow)
  );
  const changed = blocks
    .filter((block) => sealed.get(block.id) !== block.digest && !resealed.has(block.id))
    .map((block) => block.id);
  // Un flujo con un hallazgo `cross-flow` vuelve a entrar aunque su propio texto no haya
  // cambiado: ESE hallazgo dice que depende de otro flujo, así que corregir el otro puede
  // haberlo movido. Los demás hallazgos no arrastran a nadie — meter todo flujo que alguna vez
  // tuvo un hallazgo devuelve el careo entero, que es justo lo que el sello por flujo evita.
  const dependent = new Set(
    findings.filter((f) => f.kind === 'cross-flow').map((f) => scenarioFamilyOf(String(f.flow ?? '')))
  );
  // Las convenciones rigen todos los flujos: si cambian, lo careado de cualquiera puede haber
  // dejado de deducirse, y la pasada es completa. Un careo anterior a este sello solo tiene el del
  // documento entero; si ese cambió sin que cambiara ningún flujo, lo que cambió está fuera de los
  // flujos, y no se sabe si fueron las convenciones: también pasada completa. Lo que NO puede
  // salir nunca es «caducado» con alcance vacío, que dejaba el careo sin forma de volver a verde.
  const conventionsChanged =
    doc.conventionsSha256 != null
      ? doc.conventionsSha256 !== conventionsDigest(scenariosContent)
      : doc.scenariosSha256 !== scenariosDigest(scenariosContent) && changed.length === 0 && resealed.size === 0;
  const fullPass = designChanged || conventionsChanged;
  const scope = fullPass
    ? blocks.map((b) => b.id)
    : changed.length === 0
      ? []
      : [...new Set([...changed, ...blocks.map((b) => b.id).filter((id) => dependent.has(scenarioFamilyOf(id)))])];

  const stale = scope.length > 0;
  if (stale && !budgetLeft) {
    // Lo que se puede resellar: los flujos del alcance con un hallazgo resuelto `scenario`. Se
    // imprime el sello a escribir, porque sin él la salida no se puede tomar a mano.
    const resellable = fullPass
      ? []
      : scope.filter((id) => findings.some((finding) => finding.flow === id && finding.resolution === 'scenario'));
    const hint = resellable.length
      ? `; resella los corregidos con sealAfter en su hallazgo: ${resellable
          .map((id) => `${id} → ${blocks.find((block) => block.id === id).digest}`)
          .join(', ')}`
      : '';
    return {
      status: 'exhausted',
      detail: `el careo no describe los escenarios de ahora y ya se han hecho ${passes} pasadas sobre esta versión (tope ${MAX_PASSES})${hint}`,
      passes,
      nextPass: null,
      scope,
      full: fullPass
    };
  }
  if (stale) {
    return {
      status: 'stale',
      detail: designChanged
        ? 'un hallazgo se cerró cambiando el YAML, así que lo careado sobre el diseño anterior deja de valer: toca pasada completa'
        : conventionsChanged
          ? 'cambiaron las convenciones de determinación, que rigen todos los flujos: toca pasada completa'
          : `flujos por recarear: ${scope.join(', ')}`,
      passes,
      nextPass: passes + 1,
      scope,
      full: fullPass || scope.length === blocks.length
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
