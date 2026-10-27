// Paso 7: la paridad semántica entre el legacy y el servicio regenerado (prototipo: tools/parity.mjs
// del inc. 1). Los escenarios no bastan: en el inc. 1 el regenerado de RealWorld pasó 73/73 escenarios y
// los 19 keep, y llevaba tres defectos del diseño recuperado que nada afirmaba (el `sub` de cada autor
// expuesto, la imagen por defecto perdida, `favorited`/`following` ausentes). Los encontró comparar TODO
// lo que devuelve cada paso en los dos lados, ya en la forma del diseño (contract-map.yaml).
//
// Cada diferencia es equivalente (null frente a ausente si el mapa lo dice, o un valor volátil), declarada
// (`declaredDifferences`, con su fix o su frontera) o SIN DECLARAR, que es una regresión hasta que alguien
// la explique: en el diseño, o en el mapa con su motivo. Y un comparador sin nada que comparar no puede
// salir en verde: con el sandbox del legacy caído, el prototipo dijo «0 diferencias».

import { EXECUTED_MARKS } from '@keel-system/keel-core';

export const KINDS = ['solo-keel', 'valor', 'solo-legacy', 'solo-keel-null'];

/** Hojas de un valor por ruta: `items[1].author.username`. Una lista deja también su tamaño. */
export function flatten(v, prefix = '', out = {}) {
  if (Array.isArray(v)) {
    out[prefix || '.'] = `array(${v.length})`;
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = v;
  return out;
}

const normPath = (p) => p.replace(/\[\d+\]/g, '[]');

/**
 * Una colección que el legacy no ordena (`semantics.unordered`, por su ruta normalizada: `products[]`) se compara como
 * conjunto: sus elementos se ordenan en los dos lados por su contenido, sin los campos volátiles. En shop-api las líneas
 * de un carrito o de un pedido salían en orden aleatorio (un HashSet), y la paridad las daba por distintas elemento a
 * elemento: 14 de sus 23 diferencias.
 */
export function canonical(value, unordered, volatile = [], path = '') {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, unordered, volatile, `${path}[]`));
    if (!unordered.some((re) => re.test(`${path}[]`))) return items;
    const key = (item) => JSON.stringify(stripVolatile(item, volatile, `${path}[]`));
    return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v, unordered, volatile, path ? `${path}.${k}` : k)]));
  return value;
}

function stripVolatile(value, volatile, path) {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, volatile, `${path}[]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !volatile.some((re) => re.test(`${path}.${k}`)))
        .map(([k, v]) => [k, stripVolatile(v, volatile, `${path}.${k}`)])
    );
  }
  return value;
}

/**
 * Compara, paso a paso, los datos de los flujos que salieron bien en los dos lados.
 *
 * @param {object} input
 * @param {object[]} input.legacy   los registros del legacy (recordings/characterization/)
 * @param {object[]} input.target   los del regenerado
 * @param {object[]} input.planned  los flujos planificados (para saber qué pasos de un fix son la diferencia)
 * @param {object} input.map        contract-map.yaml
 * @returns {{ compared: number, rows: object[], undeclared: object[] }}
 */
export function compareRecords({ legacy, target, planned, map }) {
  const legacyById = new Map(legacy.map((r) => [r.id, r]));
  const plannedById = new Map(planned.map((p) => [p.id, p]));
  const volatile = (map.semantics?.volatile ?? []).map((re) => new RegExp(re));
  const declared = (map.declaredDifferences ?? []).map((d) => ({ ...d, re: new RegExp(d.path) }));
  const absentIsNull = Boolean(map.semantics?.absentIsNull);
  const unordered = (map.semantics?.unordered ?? []).map((re) => new RegExp(re));
  const findings = new Map();
  let compared = 0;

  for (const t of target) {
    const l = legacyById.get(t.id);
    if (!l) continue;
    const flow = plannedById.get(t.id)?.flow;
    // Una frontera que el regenerado no cumple ES la diferencia: el DSL no la puede declarar, y ya
    // sale en la tabla de flujos. Comparar sus datos solo repetiría lo mismo como ruido.
    if (t.mark === 'frontier' && !t.ok) continue;
    t.steps.forEach((ts, i) => {
      const ls = l.steps[i];
      if (!ls || ls.op !== ts.op || !(ls.status >= 200 && ls.status < 300) || !(ts.status >= 200 && ts.status < 300)) return;
      // El paso de un fix con expectativa propia del legacy ES la diferencia declarada.
      if (plannedById.get(t.id)?.mark === 'fix' && flow?.steps[i]?.legacy) return;
      compared++;
      const lf = flatten(canonical(ls.data, unordered, volatile));
      const tf = flatten(canonical(ts.data, unordered, volatile));
      for (const p of new Set([...Object.keys(lf), ...Object.keys(tf)])) {
        const norm = normPath(p);
        const inL = p in lf && lf[p] !== undefined;
        const inT = p in tf && tf[p] !== undefined;
        let kind = null;
        if (inT && !inL) kind = tf[p] === null ? (absentIsNull ? null : 'solo-keel-null') : 'solo-keel';
        else if (inL && !inT) kind = 'solo-legacy';
        else if (!volatile.some((re) => re.test(norm)) && JSON.stringify(lf[p]) !== JSON.stringify(tf[p])) kind = 'valor';
        if (!kind) continue;
        const why = declared.find((d) => d.kind === kind && d.re.test(norm) && (!d.ops || d.ops.includes(ts.op)) && (!d.flows || d.flows.includes(t.id)));
        // Con la declaración en la clave: la misma ruta puede estar declarada en un flujo y no en otro.
        const key = `${kind}|${ts.op}|${norm}|${why?.reason ?? ""}`;
        const f = findings.get(key) ?? { kind, op: ts.op, path: norm, legacy: lf[p], keel: tf[p], declared: why?.reason ?? null, flows: [] };
        if (!f.flows.includes(t.id)) f.flows.push(t.id);
        findings.set(key, f);
      }
    });
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...findings.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || cmp(a.op, b.op) || cmp(a.path, b.path));
  return { compared, rows, undeclared: rows.filter((r) => !r.declared) };
}

/** Los flujos contra el regenerado: todas las marcas, con `new` (allí sí existe). */
export const TARGET_MARKS = [...EXECUTED_MARKS, 'new'];

/** El veredicto: verde con todo keep, fix y new en verde, algo comparado y nada sin declarar. */
export function parityVerdict(records, comparison) {
  const reasons = [];
  for (const mark of ['keep', 'fix', 'new']) {
    const red = records.filter((r) => r.mark === mark && !r.ok).map((r) => r.id);
    if (red.length) reasons.push(`${mark} en rojo contra el regenerado: ${red.join(', ')}`);
  }
  if (comparison.compared === 0) reasons.push('ningún paso comparado: un comparador sin nada que comparar no puede salir en verde');
  if (comparison.undeclared.length) reasons.push(`${comparison.undeclared.length} diferencia(s) de datos sin declarar`);
  return { ok: reasons.length === 0, reasons };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const show = (v) => (v === undefined ? '—' : `\`${cell(JSON.stringify(v))}\``);

/** PARITY-<destino>.md: determinista, sin fechas. */
export function renderParity({ service, legacy, target, records, legacyTally, comparison, verdict, unblockedNew = [] }) {
  const out = [];
  const add = (...lines) => out.push(...lines);
  const t = (mark) => {
    const of = records.filter((r) => r.mark === mark);
    return `${of.filter((r) => r.ok).length}/${of.length}`;
  };
  add(
    `# Paridad: ${service} ← ${legacy.name}${legacy.commit ? ` @ ${legacy.commit}` : ''} frente a ${target.name}`,
    '',
    `> Lo escribe \`keel-recover parity\` (paso 7). Los mismos flujos de \`specs/${service}/validation-scenarios.md\` contra el`,
    `> legacy (\`recordings/characterization/\`) y contra el servicio regenerado${target.project ? ` (\`${target.project}\`)` : ''}, traducidos por`,
    '> `contract-map.yaml`, y todos los datos de cada paso comparados. No se edita a mano.',
    '',
    `**Veredicto: ${verdict.ok ? 'en verde' : 'en rojo'}.**${verdict.ok ? '' : ` ${verdict.reasons.join('; ')}.`}`,
    '',
    '## Los flujos',
    '',
    '| Marca | legacy | regenerado | Qué se comprueba en el regenerado |',
    '|---|---|---|---|',
    `| \`keep\` | ${legacyTally.keep.ok}/${legacyTally.keep.total} | **${t('keep')}** | lo mismo que hace el legacy |`,
    `| \`fix\` | ${legacyTally.fix.ok}/${legacyTally.fix.total} (defecto presente) | **${t('fix')}** | el defecto, corregido |`,
    `| \`new\` | no aplica | **${t('new')}** | lo que solo existe en el servicio nuevo |`,
    `| \`frontier\` | ${legacyTally.frontier.ok}/${legacyTally.frontier.total} | ${t('frontier')} | informativo: el DSL no lo puede declarar |`,
    ''
  );
  if (unblockedNew.length) {
    add(`Sin ejecutar aquí por no traer bloque \`keel-flow\` (un \`new\`, o un \`fix\` con \`noFlow\`, no lo necesita: lo mide el arnés del proyecto generado): ${unblockedNew.map((id) => `\`${id}\``).join(', ')}.`, '');
  }
  const red = records.filter((r) => !r.ok);
  if (red.length) {
    add('En rojo contra el regenerado:', '');
    for (const r of red) add(`- \`${r.id}\` (${r.mark}): ${cell(r.failures[0])}${r.failures.length > 1 ? ` (y ${r.failures.length - 1} más)` : ''}`);
    add('');
  }
  const { rows, undeclared, compared } = comparison;
  add(
    '## Los datos',
    '',
    `${compared} paso(s) con éxito en los dos lados comparados; ${rows.length} diferencia(s): **${rows.length - undeclared.length} declarada(s) y ${undeclared.length} sin declarar**.`,
    ''
  );
  if (undeclared.length) {
    add(
      '### Sin declarar',
      '',
      'Cada una es un defecto del diseño recuperado (o del generador) hasta que se explique: se corrige el diseño, o se declara en `contract-map.yaml → declaredDifferences` con su fix o su frontera.',
      '',
      '| Tipo | Operación | Campo | legacy | regenerado | Flujos |',
      '|---|---|---|---|---|---|'
    );
    for (const r of undeclared) add(`| ${r.kind} | ${r.op} | \`${cell(r.path)}\` | ${show(r.legacy)} | ${show(r.keel)} | ${r.flows.slice(0, 3).join(', ')}${r.flows.length > 3 ? ` y ${r.flows.length - 3} más` : ''} |`);
    add('');
  }
  const byReason = new Map();
  for (const r of rows.filter((x) => x.declared)) byReason.set(r.declared, (byReason.get(r.declared) ?? 0) + 1);
  if (byReason.size) {
    add('### Declaradas', '', '| Diferencias | Motivo |', '|---|---|');
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) add(`| ${n} | ${cell(reason)} |`);
    add('');
  }
  return `${out.join('\n')}\n`;
}
