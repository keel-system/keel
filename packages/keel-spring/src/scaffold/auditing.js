// Autoría de las escrituras: el bean que Spring Data JPA consulta para poblar
// @CreatedBy/@LastModifiedBy. Es lo único de la auditoría que no puede salir de
// las anotaciones, porque depende de dónde viva el actor — y eso lo sabe el
// diseño: `persistence.audit.authorship` solo se admite con capa security, así
// que el actor es siempre el principal autenticado.
//
// El bean es TOTAL a propósito: nunca devuelve Optional.empty(). Las columnas de
// autoría pueden ser NOT NULL y las escrituras que no nacen de una petición (relay
// del outbox, listeners del broker, procesos programados) siguen funcionando, con
// un centinela que dice la verdad — "esto no lo hizo una persona" — en vez de un
// null que obliga a adivinarlo.

import { javaFile, javaPath, subPackage } from './render.js';
import { usesCorrelation, correlationImport } from './correlation.js';

const AUDIT_PKG = 'infrastructure.configurations.audit';

/** ¿El diseño registra algo de cada escritura? Decide el @EnableJpaAuditing. */
export function auditsAnything(model) {
  return model.audit?.timestamps !== 'none' || model.audit?.authorship !== 'none';
}

/** La autoría es lo único que necesita un bean; los timestamps los pone el reloj. */
export function usesAuthorship(model) {
  return Boolean(model.layersPresent.persistence) && model.audit?.authorship !== 'none';
}

export function generate(model) {
  if (!usesAuthorship(model)) return [];
  return [renderAuditorAware(model)];
}

function renderAuditorAware(model) {
  const imports = [
    'java.util.Optional',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.data.domain.AuditorAware',
    'org.springframework.security.core.Authentication',
    'org.springframework.security.core.context.SecurityContextHolder'
  ];

  // Con protocolo de token el principal es el JWT: getName() devuelve el claim que
  // JwtAuthConverter fijó como principalClaim (preferred_username en Keycloak,
  // username en Cognito, sub en el proveedor genérico). Con api-key el principal
  // es el cliente máquina que autenticó el filtro, y getName() ya lo da.
  const jwt = model.security?.protocol === 'oidc' || model.security?.protocol === 'jwt';
  if (jwt) imports.push('org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken');

  const hasCorrelation = usesCorrelation(model);
  if (hasCorrelation) imports.push(correlationImport(model));

  const principal = jwt
    ? `            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication instanceof JwtAuthenticationToken token) {
                return Optional.of(token.getName());
            }`
    : `            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.isAuthenticated() && authentication.getName() != null) {
                return Optional.of(authentication.getName());
            }`;

  const fallback = hasCorrelation
    ? `            // Escritura sin petición detrás (relay, listener, tarea programada): no hay
            // actor, pero sí traza. El centinela lleva la correlación para poder seguirla.
            String correlationId = CorrelationContext.get();
            return Optional.of(correlationId != null ? SYSTEM + ":" + correlationId : SYSTEM);`
    : `            // Escritura sin petición detrás (tarea programada, arranque): no hay actor.
            return Optional.of(SYSTEM);`;

  const body = `/**
 * Actor de las escrituras, para @CreatedBy/@LastModifiedBy.
 *
 * Nunca devuelve vacío: una columna de autoría sin valor obligaría a interpretar
 * el null, y las escrituras que no nacen de una petición son legítimas. En esos
 * casos el valor es el centinela {@code system}, no un usuario inventado.
 */
@Configuration
public class AuditorAwareConfig {

    /** Autor de las escrituras que no nacen de una petición autenticada. */
    private static final String SYSTEM = "system";

    @Bean
    public AuditorAware<String> auditorProvider() {
        return () -> {
${principal}
${fallback}
        };
    }
}`;

  return {
    path: javaPath(model, AUDIT_PKG, 'AuditorAwareConfig'),
    content: javaFile(subPackage(model, AUDIT_PKG), imports.sort(), body)
  };
}
