// La matriz de cobertura de la puerta de diseño: por cada id del catálogo, si hay una mutación
// que lo pone en rojo y SOLO a él. Es la fuente única de dos lectores —el test del corpus, que
// exige que no quede ninguno sin mutación, y `scripts/design-matrix.js`, que lo imprime— para que
// no puedan contar distinto.
//
// Los cuatro estados PARTICIONAN los ids, así que la suma del resumen cuadra siempre con el
// catálogo: un id nuevo no puede quedarse fuera de todas las listas sin que se note.
//
//   falsado         una mutación lo dispara y no dispara nada más (con repeticiones: el mismo id
//                   varias veces en unidades distintas sigue siendo «solo él»).
//   co-disparado    aparece en alguna mutación, pero siempre junto a otros ids: la regla existe y
//                   dispara, pero no hay un diseño que la aísle. Es cola de trabajo.
//   fuera-de-alcance  en SIN_MUTACION, con su motivo: lo emite algo que el corpus no ve.
//   sin-mutacion    nada lo dispara. El test lo prohíbe.

import { CHECKS, checkIds } from '../../src/lib/checks.js';
import { OBLIGATIONS, obligationIds } from '../../src/lib/obligations.js';
import { freshBase, evaluate } from './runner.js';
import { EXTENSIONS, MUTATIONS, SIN_MUTACION } from './catalog.js';

export const STATES = ['falsado', 'co-disparado', 'fuera-de-alcance', 'sin-mutacion'];

/** Todos los ids que la puerta mecánica puede emitir: el catálogo de checks y el de obligaciones. */
export function gateIds() {
  return [...checkIds(), ...obligationIds()];
}

/** El diseño de partida de una mutación: el base, extendido si la mutación lo pide. */
export function designFor(mutation) {
  const design = freshBase();
  if (mutation.extends) {
    const extend = EXTENSIONS[mutation.extends];
    if (!extend) throw new Error(`${mutation.id}: extiende '${mutation.extends}', que no está en EXTENSIONS`);
    extend(design);
  }
  return design;
}

const sorted = (list) => [...list].sort();
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Ejecuta una mutación y la compara con lo que afirma. `ok` exige las tres cosas: el schema la
 * acepta, los ids coinciden exactamente (con repeticiones) y el ruido anónimo es el declarado.
 */
export function runMutation(mutation) {
  const design = designFor(mutation);
  mutation.mutate(design);
  const result = evaluate(design);
  const expected = sorted(mutation.expect);
  const anonymous = mutation.anonymous ?? { errors: 0, warnings: 0 };
  const idsMatch = sameList(result.ids, expected);
  const anonymousMatch =
    result.anonymous.errors.length === anonymous.errors && result.anonymous.warnings.length === anonymous.warnings;
  return {
    mutation,
    result,
    expected,
    ok: result.schemaErrors.length === 0 && idsMatch && anonymousMatch
  };
}

/** Todas las mutaciones del catálogo, ejecutadas. */
export function runCorpus(mutations = MUTATIONS) {
  return mutations.map(runMutation);
}

/**
 * Clasifica cada id de la puerta según las ejecuciones. Solo cuentan las mutaciones que dieron
 * lo que afirman: una mutación en rojo no falsa nada, y el test ya la señala por su cuenta.
 *
 * @returns {{ id, state, severity, nature, waivable, layer, by: string[], reason?: string }[]}
 */
export function classify(runs = runCorpus(), outOfScope = SIN_MUTACION) {
  const alone = new Map();
  const together = new Map();
  for (const run of runs) {
    if (!run.ok) continue;
    const distinct = new Set(run.result.ids);
    for (const id of distinct) {
      const bucket = distinct.size === 1 ? alone : together;
      if (!bucket.has(id)) bucket.set(id, []);
      bucket.get(id).push(run.mutation.id);
    }
  }

  return gateIds().map((id) => {
    const entry = CHECKS[id] ?? OBLIGATIONS[id] ?? {};
    const meta = {
      id,
      severity: entry.severity ?? (id.startsWith('OBL-') ? 'obligación' : '?'),
      nature: entry.nature ?? (id.startsWith('OBL-') ? 'undecided' : '?'),
      waivable: entry.waivable !== false,
      // Una obligación no declara capa: su `when` empieza por ella («use-cases: alguna …»).
      layer: entry.layer ?? (String(entry.when ?? '').split(':')[0] || '—')
    };
    if (alone.has(id)) return { ...meta, state: 'falsado', by: alone.get(id) };
    if (together.has(id)) return { ...meta, state: 'co-disparado', by: together.get(id) };
    if (id in outOfScope) return { ...meta, state: 'fuera-de-alcance', by: [], reason: outOfScope[id] };
    return { ...meta, state: 'sin-mutacion', by: [] };
  });
}
