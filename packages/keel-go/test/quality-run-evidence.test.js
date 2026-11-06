// El pase de calidad no da por terminada una no-regresión que no ha terminado, y el orquestador no baja la
// infraestructura sin la evidencia de que terminó. Lo destapó la corrida de control de notification-mailer con
// keel-spring (2026-11-06): la herramienta de shell pasó la suite de calidad a segundo plano, el agente leyó los
// resultados a medias y reportó «28 tests, 0 fallos», y el orquestador ejecutó infra/down.sh con la suite corriendo;
// lo que quedó en disco era rojo sobre una corrida verde. La evidencia es `scenariosRun`, la línea final literal de esa
// ejecución, y el contrato es el mismo en los cuatro generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const GENERATORS = { 'keel-go': planGo, 'keel-dotnet': planDotnet, 'keel-nest': planNest, 'keel-spring': planSpring };
const compact = (text) => text.replace(/\s+/g, ' ');

function plan(generator) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'notification-mailer'));
  return GENERATORS[generator]({ manifest, layers, workspace: FIXTURES_DIR }).files;
}

for (const generator of Object.keys(GENERATORS)) {
  const tech = generator.replace('keel-', '');

  test(`${generator}: la skill exige scenariosRun ANTES de bajar la infraestructura`, () => {
    const skills = plan(generator).filter((file) => file.path.endsWith(`keel-generate-${tech}/SKILL.md`));
    assert.ok(skills.length > 0, 'no se emite la skill');
    for (const skill of skills) {
      const text = compact(skill.content);
      const evidence = text.indexOf('exige en su reporte `scenariosRun`');
      const teardown = text.indexOf('Al terminar, baja la infraestructura');
      assert.ok(evidence >= 0, `${skill.path}: no exige scenariosRun`);
      assert.ok(teardown > evidence, `${skill.path}: baja la infraestructura sin haber exigido scenariosRun antes`);
    }
  });

  test(`${generator}: el agente de calidad espera a su no-regresión y reporta su línea final`, () => {
    const agents = plan(generator).filter((file) => path.basename(file.path) === `${generator}-quality.md`);
    assert.ok(agents.length > 0, 'no se emite el agente de calidad');
    for (const agent of agents) {
      assert.ok(compact(agent.content).includes('**Espera a que termine**'), `${agent.path}: no pide esperar a la suite`);
      assert.match(agent.content, /^scenariosRun: /m, `${agent.path}: el reporte no declara scenariosRun`);
    }
  });
}
