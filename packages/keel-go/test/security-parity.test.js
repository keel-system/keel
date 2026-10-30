// Paridad de la AUTORIZACIÓN entre keel-spring y keel-go, sin levantar nada: para cada fixture con capa security se lee
// la SecurityFilterChain que EMITE keel-spring (su SecurityConfig.java) y las reglas que emite keel-go
// (internal/httpapi/security.go), y se exige que digan lo mismo: qué cadenas hay y en qué orden, qué rutas cubre cada
// una, si comprueba la audiencia, cada regla con su método, su ruta y lo que exige, y el cierre.
//
// Las dos salen del mismo plan (keel-core/gen/access-plan.js), así que este test no mide el plan: mide que keel-go lo
// ESCRIBE sin perder nada por el camino. El gemelo de los de keel-nest y keel-dotnet, con el mismo lector de keel-spring
// (keel-spring/test/helpers/security-chains.js). Fuera, con su motivo: las rutas técnicas (Spring abre su actuator y su
// swagger; keel-go, sus sondas /livez y /readyz), que son las reglas sin método.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springChains, normalizeRequirement } from '../../keel-spring/test/helpers/security-chains.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

/** Una exigencia de security.go como el dato del plan. */
function requirementOf(expression) {
  const text = expression.trim();
  if (text === 'permitAll') return { kind: 'public', authorities: [] };
  if (text === 'authenticated') return { kind: 'authenticated', authorities: [] };
  const match = /^anyOf\((.*)\)$/.exec(text);
  assert.ok(match, `exigencia desconocida: ${text}`);
  return { kind: 'anyOf', authorities: JSON.parse(`[${match[1]}]`) };
}

/** Las cadenas de accessChains, en el orden en que se evalúan. */
export function goChains(content) {
  const table = /var accessChains = \[\]accessChain\{\n([\s\S]*?)\n\}\n/.exec(content);
  assert.ok(table, 'security.go no declara accessChains');
  return table[1]
    .split(/\n\t\{\n/)
    .map((block) => block.replace(/^\t\{\n/, ''))
    .filter((block) => block.trim())
    .map((block) => {
      const paths = /paths:\s+(nil|\[\]string\{[^}]*\})/.exec(block)[1];
      const rules = [...block.matchAll(/^\t\t\t\{("[^"]*"), ("[^"]+"), (.+)\},$/gm)].map(([, method, rulePath, requirement]) => ({
        method: JSON.parse(method) || null,
        path: JSON.parse(rulePath),
        requirement: requirementOf(requirement)
      }));
      return {
        paths: paths === 'nil' ? null : JSON.parse(`[${paths.slice('[]string{'.length, -1)}]`),
        checksAudience: /checksAudience: true/.test(block),
        rules,
        fallback: requirementOf(/fallback: (.+),/.exec(block)[1])
      };
    });
}

const secured = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'security.keel.yaml')));

test('hay fixtures con seguridad que comparar', () => {
  assert.ok(secured.length >= 4, secured.join(', '));
});

for (const name of secured) {
  for (const auth of ['keycloak', 'cognito']) {
    test(`${name} (${auth}): la autorización de keel-go es la SecurityFilterChain de keel-spring`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const spring = springChains(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      const go = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
      const rulesFile = go.files.find((file) => file.path === 'internal/httpapi/security.go');
      const declares = rulesFile?.content.includes('var accessChains');
      if (!spring) {
        assert.ok(!declares, 'keel-spring no protege la API y keel-go sí');
        return;
      }
      // Con `protocol: none` keel-go no emite reglas (la API queda abierta) y keel-spring una SecurityConfig que lo abre
      // todo: la misma API.
      if (!declares) {
        for (const chain of spring) {
          assert.deepEqual(chain.rules.filter((rule) => rule.requirement.kind !== 'public'), [], 'keel-spring exige algo y keel-go no');
          assert.equal(chain.fallback?.kind, 'public', 'keel-spring cierra la API y keel-go la deja abierta');
        }
        return;
      }
      const mine = goChains(rulesFile.content);
      assert.equal(mine.length, spring.length, 'número de cadenas');
      for (const [index, chain] of spring.entries()) {
        assert.deepEqual(mine[index].paths, chain.paths, `cadena ${index}: rutas`);
        assert.equal(mine[index].checksAudience, chain.checksAudience, `cadena ${index}: audiencia`);
        assert.deepEqual(
          mine[index].rules.filter((rule) => rule.method != null).map((rule) => ({ ...rule, requirement: normalizeRequirement(rule.requirement) })),
          chain.rules.map((rule) => ({ ...rule, requirement: normalizeRequirement(rule.requirement) })),
          `cadena ${index}: reglas`
        );
        assert.deepEqual(normalizeRequirement(mine[index].fallback), normalizeRequirement(chain.fallback), `cadena ${index}: cierre`);
      }
    });
  }
}
