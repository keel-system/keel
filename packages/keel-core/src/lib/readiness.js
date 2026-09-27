// «Diseño listo para generar»: un veredicto calculado, en vez de tres definiciones en prosa.
//
// Hasta aquí el cierre de un diseño se definía en tres sitios que no decían lo mismo: la
// skill /keel-design § Cierre (validación, huecos, escenarios con matriz, DESIGN.md),
// `validateService().ok` (validación + obligaciones + revisión sin hallazgos abiertos) y
// `keel-<tech> build`, que acepta lo segundo. Un diseño a medio cerrar entraba a generación
// y el agente rellenaba lo que faltaba — distinto en cada corrida y en cada stack.
//
// Este módulo COMPONE lo que ya se calcula en otros sitios; no juzga nada nuevo. Cada
// criterio lleva un id estable porque se estampa en el proyecto generado y se cuenta entre
// corridas: citarlo por su redacción en español lo rompería al primer retoque.
//
// Regla para añadir un criterio: que tenga artefacto que leer. Uno que no se puede evaluar no se
// pinta ni en verde ni en rojo. Así entraron las decisiones no tomadas de los avisos (R2, con
// decisions.yaml), el análisis de huecos (R3, con gaps.yaml) y el registro de decisiones
// estructurales (R4.2, con `structural:` en decisions.yaml).

import fs from 'node:fs';
import path from 'node:path';
import { validateService, workspaceRootOf } from './validate-service.js';
import { listDerivatives } from './derivatives.js';
import { flowReviewPlan, FLOW_REVIEW_FILE } from './flow-review.js';
import { parseCoverageMatrix } from './scenario-blocks.js';
import { SCENARIOS_FILE, REVIEW_FILE, DECISIONS_FILE, GAPS_FILE } from './spec-files.js';
import { unwalkedCount, GAPS_AGENT } from './gaps-state.js';
import { REVIEW_AGENT } from './review-state.js';

/** Los hallazgos con id que dicen que la matriz de cobertura no cubre el diseño. */
const MATRIX_FINDINGS = [
  'CHK-SCEN-MATRIX-MISSING-OP',
  'CHK-SCEN-MATRIX-UNKNOWN-OP',
  'CHK-SCEN-MATRIX-DANGLING-FL',
  'CHK-SCEN-MATRIX-EMPTY-ROW',
  'CHK-SCEN-ERROR-UNCOVERED'
];

/** Los criterios, en el orden en que se cierran durante una sesión de diseño. */
export const READINESS_CRITERIA = [
  { id: 'validation', title: 'validación estricta en verde' },
  { id: 'obligations', title: 'obligaciones de diseño cerradas o aceptadas y vigentes' },
  { id: 'undecided', title: 'decisiones de los avisos tomadas en el DSL o aceptadas y vigentes' },
  { id: 'structural', title: 'registro de decisiones estructurales completo, vigente y coherente con el diseño' },
  { id: 'review', title: 'revisión semántica completa y vigente' },
  { id: 'gaps', title: 'análisis de huecos completo, vigente y sin hallazgos abiertos' },
  { id: 'scenarios', title: 'escenarios de validación de esta versión' },
  { id: 'coverage-matrix', title: 'matriz de cobertura completa' },
  { id: 'flow-review', title: 'careo de flujos al día y decidido' },
  { id: 'design-doc', title: 'DESIGN.md de esta versión' }
];

const TITLES = new Map(READINESS_CRITERIA.map((entry) => [entry.id, entry.title]));

function criterion(id, ok, detail, fix) {
  return { id, title: TITLES.get(id), ok, detail: ok ? null : detail, fix: ok ? null : fix };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Por qué un derivado no está al día, en una frase con la versión delante. */
function derivativeDetail(entry, version) {
  if (!entry) return 'no se pudo inventariar';
  if (entry.status === 'missing') return `no existe ${entry.path}`;
  if (entry.status === 'stale') return `sellado en v${entry.stampedVersion} y el diseño va por v${version}`;
  if (entry.status === 'unstamped') return `${entry.path} no lleva sello de versión`;
  return entry.status;
}

/**
 * Evalúa si el diseño de `dir` está listo para generar.
 *
 * `validation` es el resultado de `validateService(dir, { wip: false })` cuando quien llama
 * ya lo tiene (build lo calcula antes): recalcularlo daría lo mismo y costaría el doble.
 *
 * Todos los criterios se evalúan siempre, también con la validación en rojo: la checklist
 * entera es lo que permite retomar una sesión sin depender de la memoria del agente.
 *
 * @returns {{ service: { name, version }|null, ready: boolean,
 *            criteria: { id, title, ok, detail, fix }[] }}
 */
export function assessReadiness(dir, { validation = null } = {}) {
  const result = validation ?? validateService(dir, { wip: false });
  const manifest = result.manifest;
  const name = manifest?.service?.name ?? path.basename(path.resolve(dir));
  const version = manifest?.service?.version ?? null;
  const spec = `specs/${name}`;
  const criteria = [];

  // 1 — La validación estricta, sin contar obligaciones ni revisión (van en su criterio).
  const schemaCount = result.schemaErrors.reduce((total, entry) => total + (entry.errors?.length ?? 1), 0);
  const problems = [
    [result.loadErrors.length, 'de carga'],
    [schemaCount, 'de schema'],
    [result.crossRefErrors.length, 'de referencias cruzadas'],
    [result.pending.length, 'pendiente(s) de diseño']
  ].filter(([count]) => count > 0);
  // validateService corta antes de las referencias cruzadas si hay errores de carga, de
  // schema o pendientes: entonces obligaciones, revisión y hallazgos vienen VACÍOS, no en
  // verde. Pintarlos en verde diría que se cumplen cosas que nadie ha mirado.
  const evaluated = Boolean(manifest) && result.loadErrors.length === 0 && schemaCount === 0 && result.pending.length === 0;
  const notEvaluated = 'sin evaluar: la validación no llega hasta aquí mientras no esté en verde';

  criteria.push(
    criterion(
      'validation',
      problems.length === 0 && Boolean(manifest),
      problems.map(([count, label]) => `${count} ${label}`).join(', ') || 'sin manifiesto',
      `keel validate ${spec}`
    )
  );

  // 2 — Las obligaciones: abiertas, aceptadas en otra versión o con el registro roto.
  const { obligations } = result;
  const unsettled = obligations.open.length + obligations.stale.length;
  criteria.push(
    criterion(
      'obligations',
      evaluated && unsettled === 0 && obligations.errors.length === 0,
      !evaluated ? notEvaluated : [
        unsettled > 0 ? `${unsettled} sin cerrar` : null,
        obligations.errors.length > 0 ? `${obligations.errors.length} error(es) en ${DECISIONS_FILE}` : null
      ]
        .filter(Boolean)
        .join(', '),
      `ciérralas en el diseño o acéptalas en ${DECISIONS_FILE} con su motivo`
    )
  );

  // 2b — Los avisos que son decisiones no tomadas (`nature: 'undecided'` en checks.js). No
  // bloquean la generación, pero un diseño con un POST sin status no está listo: ese status lo
  // elegiría el generador. Se nombran los ids, que es lo que el diseñador busca en la salida.
  const { undecided } = result;
  const pendingDecisions = [...undecided.open, ...undecided.stale];
  const undecidedById = new Map();
  for (const item of pendingDecisions) undecidedById.set(item.id, (undecidedById.get(item.id) ?? 0) + 1);
  criteria.push(
    criterion(
      'undecided',
      evaluated && pendingDecisions.length === 0,
      !evaluated
        ? notEvaluated
        : [...undecidedById]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, count]) => `${count}× ${id}`)
            .join(', '),
      `decídelas en el DSL, o acepta en ${DECISIONS_FILE} las que lo admitan (id + scope + motivo) — keel validate ${spec} las lista`
    )
  );

  // 2c — El registro de decisiones estructurales (decisions.yaml → structural). Toda sección del
  // catálogo que aplica tiene que decir qué se eligió, qué se descartó y por qué; y donde nombra un
  // campo, decir lo mismo que el YAML. Se escribe al cerrar cada capa, por eso va antes que la revisión.
  const { structural } = result;
  const structuralProblems = !evaluated ? [notEvaluated] : [
    structural.missing.length > 0
      ? `${structural.inventory.length - structural.missing.length}/${structural.inventory.length} secciones registradas (faltan ${structural.missing.map((item) => `§${item.section}`).join(', ')})`
      : null,
    structural.stale.length > 0 ? `${structural.stale.length} de otra versión` : null,
    ...structural.mismatched.map(
      (entry) => `§${entry.section} dice '${entry.chosen}' y ${entry.scope} es '${entry.actual}'`
    ),
    structural.errors.length > 0 ? `${structural.errors.length} error(es) en ${DECISIONS_FILE}` : null
  ].filter(Boolean);
  criteria.push(
    criterion(
      'structural',
      structuralProblems.length === 0,
      structuralProblems.join(', '),
      `/keel-design ${spec}: cada § 3.x aplicable, con elegido, descartado y porqué, en ${DECISIONS_FILE} (structural:)`
    )
  );

  // 3 — La revisión: que exista, que cubra todo lo aplicable, que sea de esta versión y
  // que no deje nada abierto. `missing` y `stale` no bloquean en validateService; aquí sí
  // cuentan, porque un diseño revisado a medias y uno revisado entero no están igual de listos.
  const { reviews } = result;
  const total = reviews.covered.length + reviews.missing.length;
  const reviewProblems = !evaluated ? [notEvaluated] : [
    !reviews.reviewedAt ? `no hay ${REVIEW_FILE}` : null,
    // La revisión la hace un contexto limpio: quien escribió el diseño lee sus decisiones como quiso
    // tomarlas. Sin `reviewedBy`, la hizo el autor.
    reviews.reviewedAt && reviews.reviewedBy !== REVIEW_AGENT ? `no la hizo ${REVIEW_AGENT} (sin reviewedBy)` : null,
    reviews.reviewedAt && reviews.missing.length > 0 ? `${reviews.covered.length}/${total} ids con veredicto` : null,
    reviews.stale ? `es de la v${reviews.reviewedAt} y el diseño va por v${version}` : null,
    reviews.open.length > 0 ? `${reviews.open.length} hallazgo(s) abierto(s)` : null,
    reviews.errors.length > 0 ? `${reviews.errors.length} error(es) de formato` : null
  ].filter(Boolean);
  criteria.push(
    criterion(
      'review',
      reviewProblems.length === 0,
      reviewProblems.join(', '),
      `/keel-validate ${spec}, que lanza el agente ${REVIEW_AGENT} y repasa sus veredictos contigo`
    )
  );

  // 3b — El análisis de huecos: que exista, que recorra TODAS las unidades que la máquina deriva
  // (gap-classes.js), que sea de esta versión y que no deje nada abierto. Sin esta pregunta la
  // tabla de cobertura no la rellenaba nadie: se intentó persistir dos veces sin lector.
  const { gaps } = result;
  const applicableClasses = gaps.inventory.length;
  const unwalked = unwalkedCount(gaps);
  const gapProblems = !evaluated ? [notEvaluated] : [
    !gaps.reviewedAt ? `no hay ${GAPS_FILE}` : null,
    gaps.reviewedAt && gaps.reviewedBy !== GAPS_AGENT ? `no lo hizo ${GAPS_AGENT} (sin reviewedBy)` : null,
    gaps.reviewedAt && gaps.missingClasses.length > 0
      ? `${applicableClasses - gaps.missingClasses.length}/${applicableClasses} clases recorridas`
      : null,
    gaps.reviewedAt && unwalked > 0 ? `${unwalked} unidad(es) sin recorrer` : null,
    gaps.stale ? `es de la v${gaps.reviewedAt} y el diseño va por v${version}` : null,
    gaps.open.length > 0 ? `${gaps.open.length} hallazgo(s) abierto(s)` : null,
    gaps.errors.length > 0 ? `${gaps.errors.length} error(es) de formato` : null
  ].filter(Boolean);
  criteria.push(
    criterion(
      'gaps',
      gapProblems.length === 0,
      gapProblems.join(', '),
      `/keel-design ${spec} (paso 4b: lanza el agente ${GAPS_AGENT} y repasa sus hallazgos contigo) — keel validate --ready ${spec} lista las unidades`
    )
  );

  // 4 y 7 — Los derivados, buscados desde la raíz del workspace que se deduce del diseño.
  const root = workspaceRootOf(dir);
  const derivatives = listDerivatives(dir, { cwd: root ?? process.cwd() }).derivatives;
  const byId = new Map(derivatives.map((entry) => [entry.id, entry]));

  const scenariosEntry = byId.get('validation-scenarios');
  criteria.push(
    criterion(
      'scenarios',
      scenariosEntry?.status === 'fresh',
      derivativeDetail(scenariosEntry, version),
      `/keel-design ${spec} (paso 5: escenarios de validación)`
    )
  );

  // 5 — La matriz. Las cinco comprobaciones ya existen con id y se reutilizan; lo que
  // ninguna ve es un documento SIN sección de matriz, porque todas cruzan sus filas.
  const scenarios = readText(path.join(dir, SCENARIOS_FILE));
  const matrixFindings = (result.findings ?? []).filter((finding) => MATRIX_FINDINGS.includes(finding.id));
  const byFinding = new Map();
  for (const finding of matrixFindings) byFinding.set(finding.id, (byFinding.get(finding.id) ?? 0) + 1);
  const matrixDetail =
    scenarios === null
      ? `no hay ${SCENARIOS_FILE}`
      : !evaluated
        ? notEvaluated
      : parseCoverageMatrix(scenarios).length === 0
        ? `${SCENARIOS_FILE} no tiene sección «Matriz de cobertura» con filas de operación`
        : [...byFinding].map(([id, count]) => `${count}× ${id}`).join(', ');
  criteria.push(
    criterion(
      'coverage-matrix',
      evaluated && scenarios !== null && parseCoverageMatrix(scenarios).length > 0 && matrixFindings.length === 0,
      matrixDetail,
      `toda operación con fila y todo code provocado por un escenario — keel validate ${spec} los lista`
    )
  );

  // 6 — El careo: sin escenarios no hay nada careado, y eso no es «al día».
  const plan = scenarios === null ? null : flowReviewPlan(dir, scenarios, { serviceVersion: version });
  const flowDetail =
    plan === null
      ? 'sin escenarios que carear'
      : plan.status === 'missing'
        ? `no hay ${FLOW_REVIEW_FILE}`
        : `${plan.status}${plan.detail ? ` — ${plan.detail}` : ''}`;
  criteria.push(
    criterion(
      'flow-review',
      plan?.status === 'ok',
      flowDetail,
      plan?.status === 'exhausted'
        ? `decide lo abierto en ${FLOW_REVIEW_FILE} (scenario, design o accepted con motivo); no lances otra pasada`
        : `keel-flow-review (paso 5b de /keel-design)`
    )
  );

  const designEntry = byId.get('design');
  criteria.push(
    criterion(
      'design-doc',
      root !== null && designEntry?.status === 'fresh',
      root === null ? 'el diseño no vive en specs/ de un workspace' : derivativeDetail(designEntry, version),
      `/keel-handoff ${spec}`
    )
  );

  return {
    service: manifest ? { name, version } : null,
    ready: criteria.every((entry) => entry.ok),
    criteria
  };
}
