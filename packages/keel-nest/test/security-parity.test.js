// Paridad de la AUTORIZACIÓN entre keel-spring y keel-nest, sin levantar nada: para cada fixture con
// capa security se lee la SecurityFilterChain que EMITE keel-spring (su SecurityConfig.java) y las reglas
// que emite keel-nest (access-rules.ts, transpilado y ejecutado), y se exige que digan lo mismo: qué
// cadenas hay y en qué orden, qué rutas cubre cada una, si comprueba la audiencia, cada regla con su
// método, su ruta y lo que exige, y el cierre.
//
// Las dos salen del mismo plan (keel-core/gen/access-plan.js), así que este test no mide el plan: mide
// que cada generador lo ESCRIBE sin perder nada por el camino.
//
// Fuera, con su motivo: las rutas técnicas (Spring abre su actuator y su swagger; keel-nest, sus sondas
// /livez y /readyz) y el aviso de la pasarela de pago, que keel-nest genera con la capa payments (inc. 13).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { PAYMENT_NOTICE_PATH } from 'keel-core/gen/payment-gateways';
import { planService as planNest } from '../src/scaffold/index.js';
import { transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

/** Lo que exige una llamada terminal de Spring Security, como el dato del plan. */
function requirementOf(call) {
  if (call === 'permitAll()') return { kind: 'public', authorities: [] };
  if (call === 'authenticated()') return { kind: 'authenticated', authorities: [] };
  const match = /^(hasAnyRole|hasAnyAuthority|hasRole)\((.*)\)$/.exec(call);
  assert.ok(match, `llamada de Spring desconocida: ${call}`);
  const values = JSON.parse(`[${match[2]}]`);
  return { kind: 'anyOf', authorities: match[1] === 'hasAnyAuthority' ? values : values.map((role) => `ROLE_${role}`) };
}

/** Las cadenas de la SecurityConfig que emite keel-spring, en el orden en que Spring las evalúa. */
function springChains(files) {
  const config = files.find((file) => file.path.endsWith('/SecurityConfig.java'));
  if (!config) return null;
  const beans = config.content.split(/public SecurityFilterChain \w+\(HttpSecurity http\)/).slice(1);
  return beans.map((bean) => {
    const body = bean.slice(0, bean.indexOf('return http.build();'));
    const matcher = /\.securityMatcher\(([^)]*)\)/.exec(body);
    const rules = [...body.matchAll(/\.requestMatchers\(HttpMethod\.(\w+), "([^"]+)"\)\.([\w]+\([^)]*\))/g)]
      .map(([, method, path, call]) => ({ method, path, requirement: requirementOf(call) }))
      .filter((rule) => rule.path !== PAYMENT_NOTICE_PATH);
    const fallback = /\.anyRequest\(\)\.([\w]+\([^)]*\))/.exec(body);
    return {
      paths: matcher ? JSON.parse(`[${matcher[1]}]`) : null,
      checksAudience: /AudienceAuthorizationFilter/.test(body),
      rules,
      fallback: fallback ? requirementOf(fallback[1]) : null
    };
  });
}

const normalize = (requirement) => ({ kind: requirement.kind, authorities: [...(requirement.authorities ?? [])].sort() });

const secured = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'security.keel.yaml')));

test('hay fixtures con seguridad que comparar', () => {
  assert.ok(secured.length >= 4, secured.join(', '));
});

for (const name of secured) {
  for (const auth of ['keycloak', 'cognito']) {
    test(`${name} (${auth}): la autorización de keel-nest es la SecurityFilterChain de keel-spring`, async () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const spring = springChains(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      const nest = planNest({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
      const rulesFile = nest.files.find((file) => file.path === 'src/infrastructure/security/access-rules.ts');
      if (!spring) {
        assert.equal(rulesFile, undefined, 'keel-spring no protege la API y keel-nest sí');
        return;
      }
      // Con `protocol: none` keel-nest no emite ningún hook (la API queda abierta sin código) y keel-spring
      // una SecurityConfig que lo abre todo: la misma API. Sin hook en keel-nest, keel-spring no puede
      // exigir nada en ninguna ruta.
      if (!rulesFile) {
        for (const chain of spring) {
          assert.deepEqual(chain.rules.filter((rule) => rule.requirement.kind !== 'public'), [], 'keel-spring exige algo y keel-nest no tiene hook');
          assert.equal(chain.fallback?.kind, 'public', 'keel-spring cierra la API y keel-nest la deja abierta');
        }
        return;
      }
      const { load } = transpileTree(nest.files);
      const { CHAINS } = await load('src/infrastructure/security/access-rules.ts');
      assert.equal(CHAINS.length, spring.length, 'número de cadenas');
      for (const [index, chain] of spring.entries()) {
        const mine = CHAINS[index];
        assert.deepEqual(mine.paths, chain.paths, `cadena ${index}: rutas`);
        assert.equal(mine.checksAudience, chain.checksAudience, `cadena ${index}: audiencia`);
        const methodRules = mine.rules.filter((rule) => rule.method != null);
        assert.deepEqual(
          methodRules.map((rule) => ({ method: rule.method, path: rule.path, requirement: normalize(rule.requirement) })),
          chain.rules.map((rule) => ({ ...rule, requirement: normalize(rule.requirement) })),
          `cadena ${index}: reglas`
        );
        assert.deepEqual(normalize(mine.fallback), normalize(chain.fallback), `cadena ${index}: cierre`);
      }
    });
  }
}
