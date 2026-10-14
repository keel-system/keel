// La AUTORIZACIÓN que emite keel-spring, leída de su SecurityConfig: las cadenas de filtros en el orden en que Spring
// las evalúa, cada una con las rutas que cubre, si comprueba la audiencia, sus reglas (método, ruta y lo que exige) y su
// cierre. Es el oráculo de las paridades de seguridad de los otros generadores (keel-nest y keel-dotnet), que comparan
// lo que ellos emiten contra esto con el vocabulario del plan neutral (keel-core/gen/access-plan.js).

import assert from 'node:assert/strict';

/** Lo que exige una llamada terminal de Spring Security, como el dato del plan. */
export function springRequirement(call) {
  if (call === 'permitAll()') return { kind: 'public', authorities: [] };
  if (call === 'authenticated()') return { kind: 'authenticated', authorities: [] };
  const match = /^(hasAnyRole|hasAnyAuthority|hasRole)\((.*)\)$/.exec(call);
  assert.ok(match, `llamada de Spring desconocida: ${call}`);
  const values = JSON.parse(`[${match[2]}]`);
  return { kind: 'anyOf', authorities: match[1] === 'hasAnyAuthority' ? values : values.map((role) => `ROLE_${role}`) };
}

/** Las cadenas de la SecurityConfig que emite keel-spring, o null si no emite ninguna. */
export function springChains(files) {
  const config = files.find((file) => file.path.endsWith('/SecurityConfig.java'));
  if (!config) return null;
  const beans = config.content.split(/public SecurityFilterChain \w+\(HttpSecurity http\)/).slice(1);
  return beans.map((bean) => {
    const body = bean.slice(0, bean.indexOf('return http.build();'));
    const matcher = /\.securityMatcher\(([^)]*)\)/.exec(body);
    const rules = [...body.matchAll(/\.requestMatchers\(HttpMethod\.(\w+), "([^"]+)"\)\.([\w]+\([^)]*\))/g)].map(([, method, path, call]) => ({
      method,
      path,
      requirement: springRequirement(call)
    }));
    const fallback = /\.anyRequest\(\)\.([\w]+\([^)]*\))/.exec(body);
    return {
      paths: matcher ? JSON.parse(`[${matcher[1]}]`) : null,
      checksAudience: /AudienceAuthorizationFilter/.test(body),
      rules,
      fallback: fallback ? springRequirement(fallback[1]) : null
    };
  });
}

/** Una exigencia comparable: su clase y sus authorities ordenadas. */
export const normalizeRequirement = (requirement) => ({ kind: requirement.kind, authorities: [...(requirement.authorities ?? [])].sort() });
