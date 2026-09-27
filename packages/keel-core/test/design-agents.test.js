// Los dos subagentes de contexto limpio que se sumaron al careo: la revisión semántica
// (keel-design-review) y el análisis de huecos (keel-gap-sweep).
//
// Existen por lo que midió el cierre del par del MVP (R9): la lectura que hizo un contexto sin la
// conversación del diseño fue la que más encontró, y la revisión y el barrido los seguía escribiendo
// el autor. Lo que se prueba aquí es la mitad mecánica: que se proyectan a todos los harnesses, que
// su procedimiento apunta a la referencia correcta, y que firman lo que `--ready` exige.

import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFiles } from '../src/commands/init.js';
import { HARNESSES } from '../src/lib/harness.js';
import { REVIEW_AGENT } from '../src/lib/review-state.js';
import { GAPS_AGENT } from '../src/lib/gaps-state.js';

const AGENTS = [
  { name: REVIEW_AGENT, reference: /keel-validate\/references\/review-checklist\.md/, output: 'review.yaml' },
  { name: GAPS_AGENT, reference: /keel-design\/references\/gap-analysis\.md/, output: 'gaps.yaml' }
];

for (const { name, reference, output } of AGENTS) {
  test(`el subagente ${name} se proyecta a TODOS los harnesses, sin rutas de harness en su fuente`, () => {
    const files = harnessFiles();
    for (const harness of HARNESSES) {
      const agent = files.find((f) => f.path === harness.agentPath(name));
      assert.ok(agent, `${harness.id}: no se emitió el agente`);
      assert.doesNotMatch(agent.content, /\{\{keel:/, `${harness.id}: quedó un token sin resolver`);
      assert.match(agent.content, reference);
    }
  });

  test(`${name} firma ${output} con el nombre que exige --ready`, () => {
    // La firma que el agente escribe y la que readiness.js compara tienen que ser la misma cadena:
    // con dos fuentes, un renombrado dejaría a todos los diseños en rojo por una firma «ajena».
    const agent = harnessFiles().find((f) => f.path === HARNESSES[0].agentPath(name));
    assert.match(agent.content, new RegExp(`reviewedBy: ${name}\\b`));
  });
}
