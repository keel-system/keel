// El careo de flujos: el subagente se proyecta al workspace, y `keel validate` sabe si el
// careo existe, si habla de ESTOS escenarios y si dejó hallazgos sin decidir.
//
// El careo en sí no se prueba aquí —es juicio de un agente—; lo que se prueba es la puerta que
// impide que un diseño se dé por cerrado sin él, y el sello que lo ata al texto que simuló.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { harnessFiles } from '../src/commands/init.js';
import { HARNESSES } from '../src/lib/harness.js';
import { FLOW_REVIEW_FILE, flowReviewStatus, scenariosDigest } from '../src/lib/flow-review.js';
import { SPEC_SIDE_FILES } from '../src/lib/spec-files.js';

const SCENARIOS = '# x\n\n### FL-PRD-001: alta\n**Then**:\n1. Status `201`.\n';

function dirWith(review) {
  const dir = tmpDir('keel-flow-review-');
  fs.writeFileSync(path.join(dir, 'validation-scenarios.md'), SCENARIOS);
  if (review) fs.writeFileSync(path.join(dir, FLOW_REVIEW_FILE), YAML.stringify(review));
  return dir;
}

const finding = (extra = {}) => ({
  flow: 'FL-PRD-001',
  step: 'Then 1',
  kind: 'carried-state',
  evidence: 'El Then afirma algo que el YAML no deduce en este paso.',
  proposal: 'Corregir el escenario.',
  ...extra
});

test('el subagente keel-flow-review se proyecta a TODOS los harnesses, sin rutas de harness en su fuente', () => {
  const files = harnessFiles();
  for (const harness of HARNESSES) {
    const agent = files.find((f) => f.path === harness.agentPath('keel-flow-review'));
    assert.ok(agent, `${harness.id}: no se emitió el agente`);
    assert.doesNotMatch(agent.content, /\{\{keel:/, `${harness.id}: quedó un token sin resolver`);
    assert.match(agent.content, /keel-design\/references\/flow-walkthrough\.md/);
  }
});

test('el estado del careo: falta, caducado, abierto y al día', () => {
  const sello = scenariosDigest(SCENARIOS);
  assert.equal(flowReviewStatus(dirWith(null), SCENARIOS).status, 'missing');
  assert.equal(
    flowReviewStatus(dirWith({ reviewedAt: '1.0.0', scenariosSha256: '0'.repeat(64), findings: [] }), SCENARIOS).status,
    'stale'
  );
  const abierto = flowReviewStatus(dirWith({ reviewedAt: '1.0.0', scenariosSha256: sello, findings: [finding()] }), SCENARIOS);
  assert.equal(abierto.status, 'open');
  assert.match(abierto.detail, /FL-PRD-001/);
  assert.equal(
    flowReviewStatus(dirWith({ reviewedAt: '1.0.0', scenariosSha256: sello, findings: [finding({ resolution: 'scenario' })] }), SCENARIOS).status,
    'ok'
  );
  // Un careo limpio también es un resultado.
  assert.equal(flowReviewStatus(dirWith({ reviewedAt: '1.0.0', scenariosSha256: sello, findings: [] }), SCENARIOS).status, 'ok');
});

test('el sello ignora los retornos de carro: un checkout con autocrlf no caduca el careo', () => {
  assert.equal(scenariosDigest(SCENARIOS), scenariosDigest(SCENARIOS.replace(/\n/g, '\r\n')));
  assert.notEqual(scenariosDigest(SCENARIOS), scenariosDigest(SCENARIOS.replace('201', '200')));
});

test('accepted sin motivo no cierra el hallazgo: lo rechaza el schema', () => {
  const sello = scenariosDigest(SCENARIOS);
  const result = flowReviewStatus(
    dirWith({ reviewedAt: '1.0.0', scenariosSha256: sello, findings: [finding({ resolution: 'accepted' })] }),
    SCENARIOS
  );
  assert.equal(result.status, 'invalid');
});

test('flow-review.yaml viaja al publicar y no al derivar', () => {
  const entry = SPEC_SIDE_FILES.find((e) => e.file === FLOW_REVIEW_FILE);
  assert.deepEqual({ publish: entry.publish, derive: entry.derive }, { publish: true, derive: false });
});
