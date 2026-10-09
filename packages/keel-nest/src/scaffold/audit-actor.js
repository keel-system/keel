// La AUTORÍA de las escrituras (`persistence.audit.authorship`, incremento 13h): quién crea y quién modifica cada
// agregado. Es el AuditorAware de keel-spring, con la misma regla, porque lo que queda en `created_by` y
// `updated_by` es contrato de los datos —lo lee quien audita, con cualquiera de los dos servidores—:
//
//   · con un token, el SUJETO (`sub`): el identificador estable, no el nombre del principal, que es para mostrar
//     y puede cambiar; el nombre solo si el token no trae `sub`;
//   · con una clave de API, el cliente que autenticó;
//   · sin petición autenticada detrás (un listener, un barrido, el relay): el centinela `system`, con la
//     correlación si la hay (`system:<correlationId>`), que dice la verdad —«esto no lo hizo una persona»— en vez
//     de un null que obligue a adivinarlo. Nunca vacío: las columnas son NOT NULL.

import { usesPersistence } from './persistence-entities.js';
import { usesApi, CORRELATION_TS, usesCorrelation } from './rest-support.js';
import { SECURITY_CONTEXT_TS, usesHttpSecurity } from './security.js';
import { tsModule } from './render.js';

export const AUDIT_ACTOR_TS = 'src/infrastructure/persistence/audit-actor.ts';

/** ¿Alguna raíz o hija registra QUIÉN escribe, por política o en campos declarados? */
export function usesAuthorship(model) {
  if (!usesPersistence(model)) return false;
  if (model.audit?.authorship === 'all') return true;
  return (model.entities ?? []).some((entity) => entity.persisted && entity.auditAuthorship === 'declared');
}

export function generate(model) {
  if (!usesAuthorship(model)) return [];
  const security = usesHttpSecurity(model);
  const correlation = usesApi(model) || usesCorrelation(model);
  const imports = [
    security ? { symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS } : null,
    correlation ? { symbol: 'CorrelationContext', from: CORRELATION_TS } : null
  ];
  const principal = security
    ? `  const principal = SecurityContext.current();
  if (principal != null) {
    // Con un token, el sujeto; con una clave de API, el cliente que la presentó.
    const subject = principal.kind === 'token' ? principal.claims['sub'] : null;
    return typeof subject === 'string' && subject !== '' ? subject : principal.name;
  }
`
    : '';
  const fallback = correlation
    ? `  // Escritura sin petición autenticada detrás: no hay actor, pero sí traza.
  const correlationId = CorrelationContext.get();
  return correlationId != null ? \`\${SYSTEM_ACTOR}:\${correlationId}\` : SYSTEM_ACTOR;`
    : '  return SYSTEM_ACTOR;';
  const body = `/** El autor de las escrituras que no nacen de una petición autenticada. */
export const SYSTEM_ACTOR = 'system';

/**
 * Quién escribe, para \`created_by\`/\`updated_by\`: la misma regla que el AuditorAware de keel-spring. Nunca vacío.${
   security ? '' : '\n * Sin capa de seguridad no hay principal: toda escritura es del sistema.'
 }
 */
export function currentActor(): string {
${principal}${fallback}
}`;
  return [{ path: AUDIT_ACTOR_TS, content: tsModule(AUDIT_ACTOR_TS, imports, body) }];
}
