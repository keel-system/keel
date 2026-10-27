// Paridad de la AUTORIZACIÓN entre keel-spring y keel-dotnet, sin levantar nada: para cada fixture con capa security se
// lee la SecurityFilterChain que EMITE keel-spring (su SecurityConfig.java) y las reglas que emite keel-dotnet
// (AccessRules.cs), y se exige que digan lo mismo: qué cadenas hay y en qué orden, qué rutas cubre cada una, si comprueba
// la audiencia, cada regla con su método, su ruta y lo que exige, y el cierre.
//
// Las dos salen del mismo plan (keel-core/gen/access-plan.js), así que este test no mide el plan: mide que keel-dotnet lo
// ESCRIBE sin perder nada por el camino. El gemelo de keel-nest/test/security-parity.test.js, con el mismo lector de
// keel-spring (keel-spring/test/helpers/security-chains.js).
//
// Fuera, con su motivo: las rutas técnicas (Spring abre su actuator y su swagger; keel-dotnet, sus sondas /livez y
// /readyz), que son las reglas sin método. El aviso de la pasarela de pago SÍ se compara: lo abre el plan neutral.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springChains, normalizeRequirement } from '../../keel-spring/test/helpers/security-chains.js';
import { planService as planDotnet } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

/** Una exigencia de AccessRules.cs como el dato del plan. */
function requirementOf(expression) {
  const text = expression.trim();
  if (text === 'Requirement.PermitAll') return { kind: 'public', authorities: [] };
  if (text === 'Requirement.Authenticated') return { kind: 'authenticated', authorities: [] };
  const match = /^Requirement\.AnyOf\((.*)\)$/.exec(text);
  assert.ok(match, `exigencia desconocida: ${text}`);
  return { kind: 'anyOf', authorities: JSON.parse(`[${match[1]}]`) };
}

/** Las cadenas de AccessRules.cs, en el orden en que se evalúan. */
export function dotnetChains(content) {
  const blocks = content.split('new AccessChain(').slice(1);
  return blocks.map((block) => {
    const paths = /Paths: (null|\[[^\]]*\])/.exec(block)[1];
    const rules = [...block.matchAll(/new AccessRule\((null|"[^"]+"), "([^"]+)", (Requirement\.[^\n]*?)\),\n/g)].map(([, method, rulePath, requirement]) => ({
      method: method === 'null' ? null : JSON.parse(method),
      path: rulePath,
      requirement: requirementOf(requirement)
    }));
    return {
      paths: paths === 'null' ? null : JSON.parse(paths),
      checksAudience: /ChecksAudience: true/.test(block),
      rules,
      fallback: requirementOf(/Fallback: (Requirement\.[^\n]*)\),/.exec(block)[1])
    };
  });
}

const secured = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'security.keel.yaml')));

test('hay fixtures con seguridad que comparar', () => {
  assert.ok(secured.length >= 4, secured.join(', '));
});

for (const name of secured) {
  for (const auth of ['keycloak', 'cognito']) {
    test(`${name} (${auth}): la autorización de keel-dotnet es la SecurityFilterChain de keel-spring`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const spring = springChains(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      const dotnet = planDotnet({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
      const rulesFile = dotnet.files.find((file) => file.path.endsWith('/Security/AccessRules.cs'));
      if (!spring) {
        assert.equal(rulesFile, undefined, 'keel-spring no protege la API y keel-dotnet sí');
        return;
      }
      // Con `protocol: none` keel-dotnet no emite reglas (la API queda abierta) y keel-spring una SecurityConfig que lo
      // abre todo: la misma API.
      if (!rulesFile) {
        for (const chain of spring) {
          assert.deepEqual(chain.rules.filter((rule) => rule.requirement.kind !== 'public'), [], 'keel-spring exige algo y keel-dotnet no');
          assert.equal(chain.fallback?.kind, 'public', 'keel-spring cierra la API y keel-dotnet la deja abierta');
        }
        return;
      }
      const mine = dotnetChains(rulesFile.content);
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
