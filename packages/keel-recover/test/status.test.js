// `keel-recover status`: la fase siguiente sale de lo que hay en disco, y cada artefacto mueve la fase a la siguiente y
// solo a esa. Es lo que hace reanudable a /keel-recover-run, así que cada prueba quita o pone UN artefacto y afirma la
// fase exacta. El diseño es la fixture conduit (recuperada de RealWorld): con él, los criterios de `--ready` son reales.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readCharacterization } from 'keel-core';
import { recoveryStatus, PHASES } from '../src/lib/status.js';
import { plannedFlows, sealDocument } from '../src/lib/characterize.js';
import { tmpDir } from './helpers/tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONDUIT = path.resolve(here, '..', '..', '..', 'fixtures', 'designs', 'conduit');

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const yaml = (doc) => YAML.stringify(doc);

/** Un workspace con el legacy `realworld-node` y, si se pide, cada artefacto hasta la fase dada. */
function workspace() {
  const root = tmpDir('keel-recover-status-');
  const legacy = path.join(root, 'legacy', 'realworld-node');
  const spec = path.join(root, 'specs', 'conduit');
  const status = (options = {}) => recoveryStatus(legacy, { spec, ...options });
  const steps = {
    init: () => write(path.join(legacy, 'legacy.yaml'), yaml({ kind: 'legacy', schema: 1, name: 'realworld-node', repo: '../../repo' })),
    sandbox: () => write(path.join(legacy, 'sandbox', 'verify.json'), { kind: 'verify', schema: 1, ok: true, criteria: [{ id: 'VER-UP', ok: true }] }),
    observe: () => {
      write(path.join(legacy, 'surface.yaml'), 'kind: surface\n');
      write(path.join(legacy, 'recordings', 'round-1', 'round.json'), { ok: true, criteria: [] });
    },
    explore: () =>
      write(path.join(legacy, 'exploration.yaml'), yaml({ kind: 'exploration', schema: 1, stopped: { date: '2026-10-22', rounds: ['round-1'], coverage: 97.7, reason: 'la cobertura dejó de subir' } })),
    design: () => {
      fs.cpSync(CONDUIT, spec, { recursive: true });
    },
    characterize: () => {
      const text = fs.readFileSync(path.join(spec, 'validation-scenarios.md'), 'utf8');
      const provenance = YAML.parse(fs.readFileSync(path.join(spec, 'provenance.yaml'), 'utf8'));
      const records = plannedFlows(text, readCharacterization(text, provenance).flows).map((flow) => ({ ...flow, ok: true }));
      write(path.join(spec, 'characterized.yaml'), yaml(sealDocument({ legacy: provenance.legacy, scenariosText: text, records })));
    },
    build: () => write(path.join(root, 'services', 'conduit-dotnet', 'keel-generated.json'), { generator: 'keel-dotnet@0.0.2' }),
    generate: () => write(path.join(root, 'services', 'conduit-dotnet', 'design-gaps.yaml'), 'gaps: []\n'),
    parity: () => write(path.join(legacy, 'recordings', 'parity', 'conduit-dotnet.json'), { target: 'conduit-dotnet', verdict: { ok: true, reasons: [] } })
  };
  const upTo = (phase) => {
    for (const name of PHASES.slice(0, PHASES.indexOf(phase))) steps[name]?.();
  };
  return { root, legacy, spec, status, steps, upTo };
}

test('cada artefacto lleva a la fase siguiente, en orden y sin saltarse ninguna', () => {
  const w = workspace();
  // Sin legacy.yaml: init. Después, cada paso cierra el suyo; `close` se salta porque el proyecto generado ya decidió.
  const seen = [w.status().phase];
  for (const name of ['init', 'sandbox', 'observe', 'explore', 'design', 'characterize', 'build', 'generate', 'parity']) {
    w.steps[name]();
    seen.push(w.status().phase);
  }
  assert.deepEqual(seen, ['init', 'sandbox', 'observe', 'explore', 'design', 'characterize', 'close', 'generate', 'parity', 'done']);
});

test('el juez en rojo devuelve a sandbox con los criterios que fallan', () => {
  const w = workspace();
  w.upTo('observe');
  write(path.join(w.legacy, 'sandbox', 'verify.json'), { ok: false, criteria: [{ id: 'VER-EGRESS', ok: false }, { id: 'VER-UP', ok: true }] });
  const s = w.status();
  assert.equal(s.phase, 'sandbox');
  assert.deepEqual(s.details.failed, ['VER-EGRESS']);
});

test('una ronda en rojo no cuenta como observación', () => {
  const w = workspace();
  w.upTo('observe');
  w.steps.observe();
  write(path.join(w.legacy, 'recordings', 'round-1', 'round.json'), { ok: false });
  assert.equal(w.status().phase, 'observe');
});

test('empezado el diseño, la exploración ya no se vuelve a pedir', () => {
  const w = workspace();
  w.upTo('design');
  fs.rmSync(path.join(w.legacy, 'exploration.yaml'));
  w.steps.design();
  assert.equal(w.status().phase, 'characterize');
});

test('una pregunta sin contestar, o contestada y sin aplicar, retiene la fase de diseño', () => {
  const w = workspace();
  w.upTo('characterize');
  const question = {
    id: 'structural-3-2',
    kind: 'omitted',
    question: '¿Idempotencia en createArticle? El legacy crea un duplicado al reintentar.',
    options: [
      { label: 'Como el legacy', description: 'Sin idempotencia: un reintento duplica.' },
      { label: 'Idempotency-Key', description: 'Clave de idempotencia del cliente.' }
    ],
    recommendation: 'Como el legacy: es lo que hace hoy.',
    evidence: 'recordings/round-1/R1-021.json'
  };
  const save = (q) => write(path.join(w.legacy, 'questions.yaml'), yaml({ kind: 'questions', schema: 1, questions: [q] }));
  save(question);
  assert.match(w.status().reason, /1 pregunta\(s\) sin contestar/);
  save({ ...question, answer: 'Como el legacy', date: '2026-10-22' });
  assert.match(w.status().reason, /1 respuesta\(s\) sin aplicar/);
  save({ ...question, answer: 'Como el legacy', date: '2026-10-22', applied: true });
  assert.equal(w.status().phase, 'characterize');
  // Un questions.yaml roto tampoco deja pasar: lo dice su schema.
  save({ id: 'x', kind: 'quizá' });
  assert.equal(w.status().phase, 'design');
  assert.match(w.status().reason, /questions\.yaml/);
});

test('sin proyecto generado y con --ready en verde, la fase es build', () => {
  const w = workspace();
  w.upTo('build');
  const green = () => ({ service: { name: 'conduit', version: '0.1.1' }, ready: true, criteria: [{ id: 'provenance', ok: true }, { id: 'characterized', ok: true }, { id: 'review', ok: true }] });
  assert.equal(w.status().phase, 'close', 'con el cierre en rojo, close');
  assert.equal(w.status({ assess: green }).phase, 'build');
});

test('una paridad en rojo vuelve a parity, con su motivo', () => {
  const w = workspace();
  w.upTo('done');
  write(path.join(w.legacy, 'recordings', 'parity', 'conduit-dotnet.json'), { verdict: { ok: false, reasons: ['33 diferencia(s) sin declarar'] } });
  const s = w.status();
  assert.equal(s.phase, 'parity');
  assert.match(s.reason, /33 diferencia/);
  assert.match(s.project, /services\/conduit-dotnet$/);
});

test('un proyecto de otro nombre no cuenta como generado (conduit-dotnet-v010)', () => {
  const w = workspace();
  w.upTo('build');
  write(path.join(w.root, 'services', 'conduit-dotnet-v010', 'keel-generated.json'), {});
  assert.equal(w.status({ assess: () => ({ criteria: [] }) }).phase, 'build');
});
