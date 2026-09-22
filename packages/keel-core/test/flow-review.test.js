// El careo de flujos: el subagente se proyecta al workspace, `keel validate` sabe qué parte del
// careo sigue valiendo, y —lo que más importa— el careo TERMINA.
//
// El careo en sí no se prueba aquí (es juicio de un agente). Lo que se prueba es la puerta: que
// no se pueda cerrar un diseño sin careo, que recarear cueste solo lo que cambió, y que el bucle
// «carear → corregir → carear» tenga tope. Sin tope no converge: medido, una segunda pasada sobre
// un diseño ya corregido devolvió 24 hallazgos nuevos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { harnessFiles } from '../src/commands/init.js';
import { HARNESSES } from '../src/lib/harness.js';
import { FLOW_REVIEW_FILE, MAX_PASSES, flowDigests, flowReviewPlan, scenariosDigest } from '../src/lib/flow-review.js';
import { SPEC_SIDE_FILES } from '../src/lib/spec-files.js';
import { validateService } from '../src/lib/validate-service.js';

const flow = (id, then) => `### ${id}: título\n**Given**: algo.\n**When**: \`op\`\n**Then**:\n1. Status \`${then}\`.\n\n`;
const SCENARIOS = `# x\n\n${flow('FL-PRD-001', 201)}${flow('FL-PRD-010', 200)}${flow('FL-SEC-001', 401)}`;

/** Un careo al día de un documento: sellos por flujo incluidos. */
function reviewOf(scenarios, { passes = 1, findings = [] } = {}) {
  return {
    reviewedAt: '1.0.0',
    passes,
    scenariosSha256: scenariosDigest(scenarios),
    flows: flowDigests(scenarios).map((entry) => ({ id: entry.id, sha256: entry.digest })),
    findings
  };
}

function dirWith(review, scenarios = SCENARIOS) {
  const dir = tmpDir('keel-flow-review-');
  fs.writeFileSync(path.join(dir, 'validation-scenarios.md'), scenarios);
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

test('sin careo se pide la pasada 1 sobre todos los flujos; con todo decidido, nada', () => {
  const sin = flowReviewPlan(dirWith(null), SCENARIOS);
  assert.equal(sin.status, 'missing');
  assert.equal(sin.nextPass, 1);
  assert.deepEqual(sin.scope, ['FL-PRD-001', 'FL-PRD-010', 'FL-SEC-001']);

  const cerrado = reviewOf(SCENARIOS, { findings: [finding({ resolution: 'scenario' })] });
  assert.equal(flowReviewPlan(dirWith(cerrado), SCENARIOS).status, 'ok');
  // Un careo limpio también es un resultado.
  assert.equal(flowReviewPlan(dirWith(reviewOf(SCENARIOS)), SCENARIOS).status, 'ok');
});

test('corregir UN escenario recarea ese flujo, no los 26', () => {
  // EL CASO QUE JUSTIFICA EL SELLO POR FLUJO. Con un solo sello del documento, esto pedía
  // recarear los tres — y sobre un diseño real, los 26: cuatro minutos y 185k tokens.
  const despues = SCENARIOS.replace('### FL-PRD-010: título\n**Given**: algo.', '### FL-PRD-010: título\n**Given**: algo MUY distinto.');

  const antes = reviewOf(SCENARIOS, { findings: [finding({ resolution: 'scenario' })] });
  const plan = flowReviewPlan(dirWith(antes, despues), despues);
  assert.equal(plan.status, 'stale');
  assert.deepEqual(plan.scope, ['FL-PRD-010'], 'solo el que cambió');
  assert.equal(plan.full, false);
  assert.equal(plan.nextPass, 2);

  // Un hallazgo `cross-flow` sí arrastra a su flujo: dice que depende de otro, y el otro cambió.
  const conDependencia = reviewOf(SCENARIOS, { findings: [finding({ kind: 'cross-flow', resolution: 'scenario' })] });
  assert.deepEqual(flowReviewPlan(dirWith(conDependencia, despues), despues).scope, ['FL-PRD-010', 'FL-PRD-001']);
});

test('un hallazgo cerrado tocando el YAML obliga a pasada completa', () => {
  // Lo careado de los demás flujos salía de un diseño que ya no es este: recarearlos no es
  // exceso de celo, es que sus conclusiones dejaron de estar respaldadas.
  const antes = reviewOf(SCENARIOS, { findings: [finding({ resolution: 'design' })] });
  const despues = SCENARIOS.replace('Status `201`', 'Status `202`');
  const plan = flowReviewPlan(dirWith(antes, despues), despues);
  assert.equal(plan.status, 'stale');
  assert.equal(plan.full, true);
  assert.deepEqual(plan.scope, ['FL-PRD-001', 'FL-PRD-010', 'FL-SEC-001']);
});

test('el presupuesto se agota: con hallazgos abiertos se DECIDE, no se recarea', () => {
  const abierto = (passes) => dirWith(reviewOf(SCENARIOS, { passes, findings: [finding()] }));
  const conMargen = flowReviewPlan(abierto(MAX_PASSES - 1), SCENARIOS);
  assert.equal(conMargen.status, 'open');
  assert.equal(conMargen.nextPass, MAX_PASSES);

  const agotado = flowReviewPlan(abierto(MAX_PASSES), SCENARIOS);
  assert.equal(agotado.status, 'exhausted');
  assert.equal(agotado.nextPass, null, 'no hay pasada siguiente que ofrecer');

  // Agotado y todo decidido NO es un hallazgo: el careo terminó, que es de lo que se trata.
  const cerrado = reviewOf(SCENARIOS, { passes: MAX_PASSES, findings: [finding({ resolution: 'accepted', reason: 'El escenario es deliberadamente laxo aquí y se acepta.' })] });
  assert.equal(flowReviewPlan(dirWith(cerrado), SCENARIOS).status, 'ok');

  // Y con el presupuesto agotado, un escenario retocado tampoco reabre el careo.
  const retocado = SCENARIOS.replace('Status `401`', 'Status `403`');
  const plan = flowReviewPlan(dirWith(reviewOf(SCENARIOS, { passes: MAX_PASSES }), retocado), retocado);
  assert.equal(plan.status, 'exhausted');
});

test('subir la versión del diseño devuelve presupuesto', () => {
  // El careo va sellado con `reviewedAt`: otra versión es otro diseño, y le toca su careo. No es
  // una escotilla — es la misma caducidad que ya gobierna review.yaml y decisions.yaml.
  const agotado = reviewOf(SCENARIOS, { passes: MAX_PASSES, findings: [finding()] });
  const dir = dirWith(agotado);
  assert.equal(flowReviewPlan(dir, SCENARIOS).status, 'exhausted');
  fs.writeFileSync(path.join(dir, FLOW_REVIEW_FILE), YAML.stringify({ ...agotado, reviewedAt: '1.1.0', passes: 1 }));
  assert.equal(flowReviewPlan(dir, SCENARIOS).status, 'open');
});

test('el sello ignora los retornos de carro, y el schema exige el número de pasada', () => {
  assert.equal(scenariosDigest(SCENARIOS), scenariosDigest(SCENARIOS.replace(/\n/g, '\r\n')));
  assert.notEqual(scenariosDigest(SCENARIOS), scenariosDigest(SCENARIOS.replace('201', '200')));

  const sinPasses = { ...reviewOf(SCENARIOS) };
  delete sinPasses.passes;
  assert.equal(flowReviewPlan(dirWith(sinPasses), SCENARIOS).status, 'invalid');
  // Y `accepted` sin motivo no cierra el hallazgo.
  const sinMotivo = reviewOf(SCENARIOS, { findings: [finding({ resolution: 'accepted' })] });
  assert.equal(flowReviewPlan(dirWith(sinMotivo), SCENARIOS).status, 'invalid');
});

test('flow-review.yaml viaja al publicar y no al derivar', () => {
  const entry = SPEC_SIDE_FILES.find((e) => e.file === FLOW_REVIEW_FILE);
  assert.deepEqual({ publish: entry.publish, derive: entry.derive }, { publish: true, derive: false });
});

test('keel validate dice qué hacer: carear lo que cambió, o decidir', () => {
  const dir = tmpDir('keel-flow-validate-');
  fs.writeFileSync(path.join(dir, 'service.keel.yaml'), 'keel: "2.15"\nservice:\n  name: demo\n  version: 1.0.0\n  description: Un servicio de prueba para el careo.\nlayers:\n  domain: domain.keel.yaml\n  use-cases: use-cases.keel.yaml\n');
  fs.writeFileSync(path.join(dir, 'domain.keel.yaml'), 'entities:\n  Thing:\n    description: Una cosa cualquiera del dominio.\n    fields:\n      id: { type: uuid, id: true, generated: true }\n');
  fs.writeFileSync(path.join(dir, 'use-cases.keel.yaml'), 'operations:\n  getThing:\n    description: Devuelve una cosa por su identificador.\n    kind: query\n    input: "void"\n    output: "void"\n');
  fs.writeFileSync(path.join(dir, 'validation-scenarios.md'), SCENARIOS);

  const avisos = () => validateService(dir).findings.filter((f) => f.id.startsWith('CHK-SCEN-FLOW-REVIEW'));
  assert.match(avisos()[0].message, /no hay careo de flujos/);
  assert.equal(avisos()[0].id, 'CHK-SCEN-FLOW-REVIEW-STALE');

  fs.writeFileSync(
    path.join(dir, FLOW_REVIEW_FILE),
    YAML.stringify(reviewOf(SCENARIOS, { passes: MAX_PASSES, findings: [finding()] }))
  );
  const agotado = avisos()[0];
  assert.equal(agotado.id, 'CHK-SCEN-FLOW-REVIEW-EXHAUSTED');
  assert.match(agotado.message, /NO lances otra pasada: decide lo que queda/);
});
