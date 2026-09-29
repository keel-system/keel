// Las métricas de una corrida, y de la serie de corridas (R8 de recomendaciones-diseno.md).
//
// Hasta aquí una corrida se medía a mano: «413 registrados, 0 adoptados, 53 reescritos, 0 borrados»
// salía de comparar `keel-generated.json` con el árbol, y la comparación entre corridas la hacía
// quien las leyera. Sin número no hay serie, y sin serie no se puede afirmar lo único que justifica
// la fase de diseño: que un diseño cerrado le deja MENOS decisiones al agente.
//
// Dos preguntas, y ninguna necesita el generador:
//   · la HUELLA del agente sobre un proyecto terminado: de lo que escribió build, qué reescribió
//     y qué borró. Lo que el agente añadió de cero no cuenta: es su trabajo, no una corrección;
//   · la SERIE: una fila por corrida registrada en docs/corridas/, con su huella, sus huecos, si
//     el diseño estaba listo y si se generó con --accept-unready, más los designGap que se
//     repiten entre corridas (la regla de «candidato obligatorio a id», mecanizada).

import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from 'keel-core';
import { MANIFEST_FILE } from './generated-manifest.js';

/**
 * La huella del agente sobre un proyecto generado: de lo que `build` registró en su manifiesto,
 * qué sigue igual, qué se reescribió y qué se borró.
 *
 * `rewritten` y `deleted` excluyen lo adoptado: de una ruta adoptada no se sabe quién la escribió,
 * así que no se le puede atribuir al agente ni un cambio ni un borrado.
 */
export function footprint(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) throw new Error(`no hay ${MANIFEST_FILE} en ${projectDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const adopted = new Set(manifest.adopted ?? []);
  const rewritten = [];
  const deleted = [];
  let intact = 0;
  for (const [relative, digest] of Object.entries(manifest.files ?? {})) {
    if (adopted.has(relative)) continue;
    const target = path.join(projectDir, relative);
    if (!fs.existsSync(target)) deleted.push(relative);
    else if (digestOf({ sourceFile: target }) !== digest) rewritten.push(relative);
    else intact += 1;
  }
  rewritten.sort();
  deleted.sort();
  return {
    generator: manifest.generator ?? null,
    design: manifest.design ?? null,
    registered: Object.keys(manifest.files ?? {}).length,
    adopted: adopted.size,
    intact,
    rewritten,
    deleted,
    pendingMerge: Object.keys(manifest.pendingMerge ?? {}).sort()
  };
}

/** Los reescritos agrupados por directorio, para leerlos de un vistazo: dónde decidió el agente. */
export function byDirectory(paths) {
  const groups = new Map();
  for (const relative of paths) {
    const dir = path.posix.dirname(relative);
    groups.set(dir, [...(groups.get(dir) ?? []), path.posix.basename(relative)]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/** La fila de la tabla de cabecera de una corrida, por su etiqueta. */
function row(table, ...labels) {
  for (const label of labels) {
    if (table.has(label)) return table.get(label);
  }
  return null;
}

const number = (text, pattern) => {
  const match = pattern.exec(text ?? '');
  return match ? Number(match[1]) : null;
};

/**
 * Una corrida registrada, leída de su documento. La tabla de cabecera tiene etiquetas fijas
 * (docs/corridas/README.md); lo que falta sale `null`, que no es lo mismo que cero: una corrida
 * anterior al formato no midió eso, y la serie tiene que distinguirlo.
 */
export function parseCorrida(name, text) {
  const table = new Map();
  for (const line of text.split(/\r?\n/)) {
    const cells = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (cells && !/^-+$/.test(cells[1]) && cells[1].trim() !== '') table.set(cells[1].replace(/`/g, ''), cells[2]);
  }
  const huella = row(table, 'Huella del agente');
  const listo = row(table, 'Diseño listo al generar');
  // Solo las etiquetas que hablan del DISEÑO: una fila «Huecos» a secas puede contar los del generador.
  const huecos = row(table, 'Huecos del diseño', 'Huecos reportados');
  const gapsSection = /^##\s+designGaps\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text);
  const gapKeys = gapsSection ? [...gapsSection[1].matchAll(/^\s*[-*]\s+`([^`]+)`/gm)].map((m) => m[1]) : [];
  return {
    name,
    design: row(table, 'Diseño'),
    ready: listo == null ? null : /^s[ií](?!\p{L})/iu.test(listo.trim()) ? true : /anterior a la puerta/i.test(listo) ? null : false,
    readyText: listo,
    acceptedUnready: listo == null ? null : /accept-unready/.test(listo),
    registered: number(huella, /(\d+)\s+archivos? registrados?/),
    adopted: number(huella, /(\d+)\s+adoptados?/),
    rewritten: number(huella, /(\d+)\s+reescritos?/),
    deleted: number(huella, /(\d+)\s+borrados?/),
    designGaps: number(huecos, /(\d+)/),
    gapKeys,
    // Desde el plan de validación de R8 (etiquetas opcionales: una corrida anterior sale null).
    role: (row(table, 'Papel') ?? '').trim().toLowerCase() || null,
    generatorGaps: number(row(table, 'Huecos del generador'), /(\d+)/),
    gateHoles: number(row(table, 'Agujeros de la puerta'), /(\d+)/),
    classification: row(table, 'Clasificación de la huella'),
    designCost: row(table, 'Coste del diseño'),
    careoPasses: careoPasses(row(table, 'Coste del diseño'))
  };
}

// «careo 13→6→0» (o con '->'): los hallazgos de cada pasada, en orden. null si no se midió.
function careoPasses(text) {
  const match = /careo\s+(\d+(?:\s*(?:→|->)\s*\d+)*)/i.exec(text ?? '');
  return match ? match[1].split(/\s*(?:→|->)\s*/).map(Number) : null;
}

/** Cuántas corridas de medición hacen falta para poder declarar la fase de diseño robusta. */
export const H1_MIN_CORRIDAS = 3;

/**
 * El veredicto de H1 del plan de validación (recomendaciones-diseno.md § R8): un diseño que cruza
 * `--ready` no deja decisiones al agente generador. Los criterios se fijaron ANTES de correr, y
 * viven aquí para que el resultado no se interprete a posteriori.
 *
 * Solo cuentan las corridas de MEDICIÓN: las que llevan el sufijo `-r8` y no tienen el papel
 * `control` (la de control mide el residuo del generador, no el diseño).
 *
 * - no-robusta: un agujero de la puerta, un designGap repetido entre corridas de medición, una
 *   corrida generada con --accept-unready, más de un hueco del diseño en toda la serie, o un
 *   careo que no convergió (más de 3 pasadas, o hallazgos que crecen);
 * - robusta: al menos H1_MIN_CORRIDAS corridas medidas y nada de lo anterior;
 * - en-curso: todo lo demás (pocas corridas o algo sin medir), con el motivo.
 */
export function verdict(corridas) {
  const measured = corridas.filter((corrida) => /-r8$/.test(corrida.name) && corrida.role !== 'control');
  const reasons = [];
  const pending = [];

  for (const corrida of measured) {
    if (corrida.acceptedUnready) reasons.push(`${corrida.name}: generada con --accept-unready`);
    if ((corrida.gateHoles ?? 0) > 0) reasons.push(`${corrida.name}: ${corrida.gateHoles} agujero(s) de la puerta`);
    if (corrida.designGaps == null) pending.push(`${corrida.name}: huecos del diseño sin medir`);
    if (corrida.gateHoles == null) pending.push(`${corrida.name}: agujeros de la puerta sin clasificar`);
    const passes = corrida.careoPasses;
    if (passes == null) pending.push(`${corrida.name}: coste del careo sin anotar`);
    else if (passes.length > 3 || passes.some((value, i) => i > 0 && value > passes[i - 1])) {
      reasons.push(`${corrida.name}: el careo no convergió (${passes.join('→')})`);
    }
  }

  const seen = new Map();
  for (const corrida of measured) {
    for (const key of new Set(corrida.gapKeys)) seen.set(key, [...(seen.get(key) ?? []), corrida.name]);
  }
  for (const [key, names] of seen) {
    if (names.length > 1) reasons.push(`designGap repetido '${key}': ${names.join(', ')}`);
  }

  const withGaps = measured.filter((corrida) => (corrida.designGaps ?? 0) > 0);
  if (withGaps.length > 1 || withGaps.some((corrida) => corrida.designGaps > 1)) {
    reasons.push(
      `huecos del diseño en ${withGaps.map((corrida) => `${corrida.name} (${corrida.designGaps})`).join(', ')}: ` +
        'el criterio admite uno solo, en una sola corrida'
    );
  }

  if (reasons.length > 0) return { status: 'no-robusta', measured: measured.length, reasons };
  if (measured.length < H1_MIN_CORRIDAS) pending.push(`${measured.length} de ${H1_MIN_CORRIDAS} corridas de medición`);
  if (pending.length > 0) return { status: 'en-curso', measured: measured.length, reasons: pending };
  return { status: 'robusta', measured: measured.length, reasons: [] };
}

/** La serie: una fila por corrida, más las claves de designGap que aparecen en dos o más. */
export function series(dir) {
  const corridas = fs
    .readdirSync(dir)
    .filter((file) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file))
    .map((file) => parseCorrida(file.replace(/\.md$/, ''), fs.readFileSync(path.join(dir, file), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Map();
  for (const corrida of corridas) {
    for (const key of new Set(corrida.gapKeys)) seen.set(key, [...(seen.get(key) ?? []), corrida.name]);
  }
  const repeated = [...seen].filter(([, names]) => names.length > 1).sort(([a], [b]) => a.localeCompare(b));
  return {
    corridas,
    repeated,
    acceptedUnready: corridas.filter((corrida) => corrida.acceptedUnready === true).length,
    verdict: verdict(corridas)
  };
}
