// `keel-recover status`: en qué paso está la recuperación de un legacy, derivado de lo que hay en disco.
//
// Es lo que hace reanudable a `/keel-recover-run`: el orquestador no guarda dónde se quedó ni lo adivina, pregunta aquí.
// Cada fase tiene id estable y sale de un artefacto que ya escribe otra pieza (verify.json, round.json, el sello de
// characterize, los criterios de `keel validate --ready`, el `design-gaps.yaml` con el que cierra el pipeline del
// generador, el resultado de parity). Nada de aquí arranca un contenedor ni escribe nada: lo que solo se sabe con el
// sandbox en marcha (que el snapshot siga vivo) lo comprueban `characterize` y `probe` antes de empezar.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { assessReadiness, scenarioIdOf, splitScenarioBlocks } from 'keel-core';
import { readFlowBlock } from './characterize.js';
import { validateAs } from './schema.js';

/** Las fases, en orden. La primera sin cumplir es la siguiente. */
export const PHASES = ['init', 'sandbox', 'observe', 'explore', 'design', 'characterize', 'close', 'build', 'generate', 'parity', 'done'];

/** Los generadores a los que puede ir un diseño recuperado (`services/<servicio>-<tech>`). */
export const GENERATORS = ['spring', 'nest', 'dotnet'];

/** Los criterios de `--ready` que son de la fase de diseño; el resto, menos `characterized`, son del cierre. */
const DESIGN_CRITERIA = ['provenance'];
const CHARACTERIZE_CRITERIA = ['characterized'];

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const readYaml = (file) => (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : null);

/**
 * Los pasos marcados como hipótesis (`hypothesis`: su expectativa del lado legacy salió de leer el código) en los flujos
 * de `validation-scenarios.md`: `[{ id, step, op, at }]`. Es lo que la ronda dirigida del explorador graba antes de
 * caracterizar; sale del disco, no del reporte del diseñador, que no queda en ninguna parte.
 */
export function flowHypotheses(specDir) {
  const file = path.join(specDir, 'validation-scenarios.md');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const block of splitScenarioBlocks(fs.readFileSync(file, 'utf8'))) {
    const id = scenarioIdOf(block);
    if (!id || !block.includes('```keel-flow')) continue;
    const { flow } = readFlowBlock(block);
    for (const [i, step] of (flow?.steps ?? []).entries()) if (step.hypothesis) out.push({ id, step: i + 1, op: step.op, at: step.hypothesis });
  }
  return out;
}

/** Las preguntas de `questions.yaml` (vacío si no hay archivo) y sus errores de schema. */
export function loadQuestions(legacyDir) {
  const file = path.join(legacyDir, 'questions.yaml');
  const doc = readYaml(file);
  if (!doc) return { questions: [], errors: [] };
  return { questions: doc.questions ?? [], errors: validateAs('questions', doc).map((e) => `questions.yaml: ${e}`) };
}

/** `exploration.yaml`: si el humano dio la exploración por cerrada. */
export function loadExploration(legacyDir) {
  const doc = readYaml(path.join(legacyDir, 'exploration.yaml'));
  if (!doc) return { stopped: null, errors: [] };
  return { stopped: doc.stopped ?? null, errors: validateAs('exploration', doc).map((e) => `exploration.yaml: ${e}`) };
}

/** Las rondas grabadas por `probe`, con su veredicto (`recordings/<ronda>/round.json`). */
function rounds(legacyDir) {
  const dir = path.join(legacyDir, 'recordings');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ round: entry.name, result: readJson(path.join(dir, entry.name, 'round.json')) }))
    .filter((entry) => entry.result)
    .map((entry) => ({ round: entry.round, ok: entry.result.ok === true }));
}

/** El proyecto generado del diseño: `services/<servicio>-<tech>/` con su `keel-generated.json`. */
function generatedProjects(workspace, service) {
  return GENERATORS.map((tech) => ({ tech, dir: path.join(workspace, 'services', `${service}-${tech}`) })).filter((project) =>
    fs.existsSync(path.join(project.dir, 'keel-generated.json'))
  );
}

/**
 * La fase siguiente de la recuperación de `legacyDir` (`legacy/<servicio>/`).
 *
 * @param {string} legacyDir
 * @param {{ spec?: string, assess?: Function }} options `spec`: el diseño recuperado si no está en `specs/<servicio>` del
 *   mismo workspace; `assess`: la evaluación de `--ready` (la de keel-core; las pruebas la sustituyen)
 * @returns {{ phase, reason, action, legacy, spec, project, details }}
 */
export function recoveryStatus(legacyDir, { spec, assess = assessReadiness } = {}) {
  const legacy = path.resolve(legacyDir);
  const name = path.basename(legacy);
  const specDir = path.resolve(spec ?? path.join(legacy, '..', '..', 'specs', name));
  const workspace = path.dirname(path.dirname(specDir));
  const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/') || '.';
  const out = (phase, reason, action, extra = {}) => ({
    phase,
    reason,
    action,
    legacy: rel(legacy),
    spec: rel(specDir),
    project: null,
    details: {},
    ...extra
  });

  // init: lo que deja `keel-recover init` (legacy.yaml; runtime.yaml en un legacy preparado antes de que existiera).
  if (!fs.existsSync(path.join(legacy, 'legacy.yaml')) && !fs.existsSync(path.join(legacy, 'runtime.yaml'))) {
    return out('init', `no hay ${rel(path.join(legacy, 'legacy.yaml'))}`, 'keel-recover init <repo> --name <servicio>');
  }

  // sandbox: el juez en verde. Hace falta en todo el recorrido: characterize parte de su snapshot.
  const verify = readJson(path.join(legacy, 'sandbox', 'verify.json'));
  if (!verify || verify.ok !== true) {
    const failed = (verify?.criteria ?? []).filter((c) => !c.ok).map((c) => c.id);
    return out('sandbox', verify ? `verify en rojo: ${failed.join(', ')}` : 'no hay sandbox/verify.json', `/keel-recover-sandbox ${rel(legacy)} y keel-recover verify ${rel(path.join(legacy, 'sandbox'))}`, {
      details: { failed }
    });
  }

  // observe y explore: solo mientras no haya diseño. Empezado el diseño, una grabación que falte la pide el diseñador
  // como sonda nueva, no se vuelve a la fase de exploración.
  const designStarted = fs.existsSync(path.join(specDir, 'provenance.yaml'));
  const exploration = loadExploration(legacy);
  if (!designStarted) {
    const recorded = rounds(legacy);
    const green = recorded.filter((r) => r.ok);
    if (!fs.existsSync(path.join(legacy, 'surface.yaml')) || green.length === 0) {
      return out(
        'observe',
        !fs.existsSync(path.join(legacy, 'surface.yaml')) ? 'no hay surface.yaml' : 'ninguna ronda de sondas en verde',
        `keel-recover introspect ${rel(path.join(legacy, 'sandbox'))} y una ronda de keel-recover probe`,
        { details: { rounds: recorded } }
      );
    }
    if (!exploration.stopped) {
      const coverage = readJson(path.join(legacy, 'recordings', 'coverage.json')) ?? [];
      return out('explore', 'el humano no ha cerrado la exploración (exploration.yaml)', 'otra ronda, o cerrar la exploración', {
        details: { rounds: recorded, coverage: coverage.at(-1) ?? null, errors: exploration.errors }
      });
    }
  }

  // design: el diseño existe, sus preguntas están contestadas y aplicadas, y la procedencia está en verde.
  const { questions, errors: questionErrors } = loadQuestions(legacy);
  const open = questions.filter((q) => q.answer === undefined || q.answer === null);
  const unapplied = questions.filter((q) => q.answer != null && q.applied !== true);
  if (!fs.existsSync(path.join(specDir, 'service.keel.yaml'))) {
    return out('design', `no hay diseño en ${rel(specDir)}`, '/keel-recover (o el agente keel-recover-designer)');
  }
  if (questionErrors.length || open.length || unapplied.length) {
    return out(
      'design',
      questionErrors.length
        ? questionErrors.join('; ')
        : open.length
          ? `${open.length} pregunta(s) sin contestar en questions.yaml`
          : `${unapplied.length} respuesta(s) sin aplicar al diseño`,
      open.length ? 'preguntar al humano y escribir answer' : 'aplicar las respuestas al diseño (applied: true)',
      { details: { open: open.map((q) => q.id), unapplied: unapplied.map((q) => q.id) } }
    );
  }
  const readiness = assess(specDir);
  const red = (ids) => readiness.criteria.filter((c) => ids.includes(c.id) && !c.ok);
  const designRed = red(DESIGN_CRITERIA);
  if (designRed.length) {
    return out('design', `criterio provenance en rojo`, '/keel-recover hasta que keel validate --ready no diga nada de provenance', {
      details: { criteria: designRed.map((c) => c.id) }
    });
  }
  if (red(CHARACTERIZE_CRITERIA).length) {
    const hypotheses = flowHypotheses(specDir);
    return out('characterize', 'criterio characterized en rojo', `keel-recover characterize ${rel(legacy)}${spec ? ` --spec ${rel(specDir)}` : ''}`, {
      details: { hypotheses }
    });
  }

  // close, build y generate: el resto de --ready, el proyecto generado y el cierre de su pipeline. Un proyecto ya
  // generado salta el cierre: build lo dejó estampado (acceptedUnready) y la decisión ya está tomada.
  const service = readiness.service?.name ?? name;
  const projects = generatedProjects(workspace, service);
  if (projects.length === 0) {
    const closing = readiness.criteria.filter((c) => !c.ok && !DESIGN_CRITERIA.includes(c.id) && !CHARACTERIZE_CRITERIA.includes(c.id));
    if (closing.length) {
      return out('close', `--ready en rojo: ${closing.map((c) => c.id).join(', ')}`, 'cerrar el diseño (/keel-validate, huecos, careo, DESIGN.md) o generar con --accept-unready', {
        details: { criteria: closing.map((c) => c.id) }
      });
    }
    return out('build', `no hay proyecto generado en services/${service}-<${GENERATORS.join('|')}>`, `keel-<tech> build ${rel(specDir)}`);
  }
  const project = projects[0];
  const projectRel = rel(project.dir);
  if (!fs.existsSync(path.join(project.dir, 'design-gaps.yaml'))) {
    return out('generate', 'el pipeline del generador no ha cerrado (no hay design-gaps.yaml)', `cd ${projectRel} && /keel-generate-${project.tech}`, {
      project: projectRel
    });
  }

  // parity: el resultado de keel-recover parity contra ese proyecto.
  const target = path.basename(project.dir);
  const result = readJson(path.join(legacy, 'recordings', 'parity', `${target}.json`));
  if (!result || result.verdict?.ok !== true) {
    return out('parity', result ? `paridad en rojo: ${(result.verdict?.reasons ?? []).join('; ')}` : `no hay paridad contra ${target}`, `bash ${projectRel}/deploy/up.sh, keel-recover target ${projectRel} y keel-recover parity ${rel(legacy)}`, {
      project: projectRel
    });
  }
  return out('done', `paridad en verde contra ${target}`, 'nada: leer FIDELITY.md y PARITY-*.md', { project: projectRel });
}
