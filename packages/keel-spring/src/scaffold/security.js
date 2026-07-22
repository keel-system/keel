// Seguridad del servicio (capa security del diseño). Genera de forma
// determinista el SecurityConfig con su SecurityFilterChain: sesión stateless,
// matchers por ruta derivados de security.access (fuente única con los
// controllers vía model.security.matchers) y, según el protocolo, el resource
// server JWT (oidc/jwt) o un filtro de API key. Cuando el diseño usa roles o
// permisos, un JwtAuthConverter mapea los claims del proveedor (Keycloak/Cognito
// del stack) a authorities de Spring. No hay stubs de negocio: la autorización
// es enteramente derivable del diseño.

import { javaFile, javaPath, subPackage } from './render.js';

const SECURITY_PKG = 'infrastructure.configurations.security';

// Claims por proveedor del stack; el default (proveedor genérico) usa claims
// planos habituales. keycloak anida los roles en realm_access.roles.
const AUTH_PROVIDERS = {
  keycloak: { type: 'nested', rolesParent: 'realm_access', rolesField: 'roles', permissionsClaim: 'permissions', principalClaim: 'preferred_username' },
  cognito: { type: 'flat', rolesClaim: 'cognito:groups', permissionsClaim: 'permissions', principalClaim: 'username' }
};

function providerMeta(model) {
  return (
    AUTH_PROVIDERS[model.stack.auth] ?? { type: 'flat', rolesClaim: 'roles', permissionsClaim: 'permissions', principalClaim: 'sub' }
  );
}

export function generate(model) {
  const sec = model.security;
  if (!model.layersPresent.security || !sec) return [];

  const files = [renderSecurityConfig(model, sec)];
  const jwt = sec.protocol === 'oidc' || sec.protocol === 'jwt';
  if (jwt && sec.usesAuthorities) files.push(renderJwtAuthConverter(model));
  if (sec.protocol === 'api-key') files.push(renderApiKeyFilter(model));
  return files;
}

// Bloque authorizeHttpRequests: endpoints técnicos permitidos, un matcher por
// regla de operación (antes del anyRequest) y el default como anyRequest.
function authorizeBlock(sec) {
  const lines = [
    '            .authorizeHttpRequests(auth -> auth',
    '                    .requestMatchers("/actuator/health/**", "/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**").permitAll()'
  ];
  for (const m of sec.matchers) {
    lines.push(`                    .requestMatchers(HttpMethod.${m.method}, "${m.path}").${m.authority}`);
  }
  lines.push(`                    .anyRequest().${sec.defaultAuthority})`);
  return lines.join('\n');
}

function renderSecurityConfig(model, sec) {
  const imports = new Set([
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.security.config.annotation.web.builders.HttpSecurity',
    'org.springframework.security.config.annotation.web.configuration.EnableWebSecurity',
    'org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer',
    'org.springframework.security.config.http.SessionCreationPolicy',
    'org.springframework.security.web.SecurityFilterChain'
  ]);

  // Protocolo 'none': capa security declarada sin autenticación → todo abierto
  // (evita que el starter de Spring Security bloquee el servicio por defecto).
  if (sec.protocol === 'none') {
    const body = `@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}`;
    return { path: javaPath(model, SECURITY_PKG, 'SecurityConfig'), content: javaFile(subPackage(model, SECURITY_PKG), [...imports], body) };
  }

  if (sec.matchers.length > 0) imports.add('org.springframework.http.HttpMethod');

  const chain = [
    '            .csrf(AbstractHttpConfigurer::disable)',
    '            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))',
    authorizeBlock(sec)
  ];

  let converterBean = '';
  if (sec.protocol === 'oidc' || sec.protocol === 'jwt') {
    imports.add('org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter');
    if (sec.usesAuthorities) {
      chain.push('            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter())))');
      converterBean = `

    @Bean
    public JwtAuthenticationConverter jwtAuthConverter() {
        return new JwtAuthConverter().converter();
    }`;
    } else {
      imports.add('org.springframework.security.config.Customizer');
      chain.push('            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))');
    }
  } else if (sec.protocol === 'api-key') {
    imports.add('org.springframework.beans.factory.annotation.Value');
    imports.add('org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter');
    chain.push('            .addFilterBefore(new ApiKeyAuthFilter(apiKey), UsernamePasswordAuthenticationFilter.class)');
  }

  const apiKeyField =
    sec.protocol === 'api-key'
      ? `
    @Value("\${security.api-key:}")
    private String apiKey;
`
      : '';

  const body = `@Configuration
@EnableWebSecurity
public class SecurityConfig {
${apiKeyField}
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
${chain.join('\n')};
        return http.build();
    }${converterBean}
}`;

  return { path: javaPath(model, SECURITY_PKG, 'SecurityConfig'), content: javaFile(subPackage(model, SECURITY_PKG), [...imports], body) };
}

// Convierte el JWT entrante en authorities de Spring combinando tres fuentes:
// roles (prefijo ROLE_), scopes OAuth2 (prefijo SCOPE_) y permisos granulares
// (sin prefijo), para que hasAnyRole/hasAnyAuthority funcionen en los matchers.
function renderJwtAuthConverter(model) {
  const meta = providerMeta(model);
  const pkg = subPackage(model, SECURITY_PKG);

  const scopesAndPermissions = `
    private java.util.Collection<GrantedAuthority> extractScopes(Jwt jwt) {
        String scopeClaim = jwt.getClaimAsString("scope");
        if (scopeClaim == null || scopeClaim.isBlank()) {
            return java.util.Collections.emptyList();
        }
        return java.util.List.of(scopeClaim.split(" ")).stream()
                .filter(s -> !s.isBlank())
                .map(scope -> new SimpleGrantedAuthority("SCOPE_" + scope))
                .map(GrantedAuthority.class::cast)
                .toList();
    }

    private java.util.Collection<GrantedAuthority> extractPermissions(Jwt jwt) {
        java.util.List<String> permissions = jwt.getClaimAsStringList("${meta.permissionsClaim}");
        if (permissions == null || permissions.isEmpty()) {
            return java.util.Collections.emptyList();
        }
        return permissions.stream()
                .filter(p -> !p.isBlank())
                .map(SimpleGrantedAuthority::new)
                .map(GrantedAuthority.class::cast)
                .toList();
    }`;

  let rolesExtractor;
  if (meta.type === 'nested') {
    rolesExtractor = `
    private java.util.Collection<GrantedAuthority> extractRoles(Jwt jwt) {
        java.util.Map<String, Object> parent = jwt.getClaimAsMap("${meta.rolesParent}");
        if (parent == null) {
            return java.util.Collections.emptyList();
        }
        Object rolesObj = parent.get("${meta.rolesField}");
        if (!(rolesObj instanceof java.util.List<?> roles)) {
            return java.util.Collections.emptyList();
        }
        return roles.stream()
                .filter(String.class::isInstance)
                .map(role -> new SimpleGrantedAuthority("ROLE_" + role))
                .map(GrantedAuthority.class::cast)
                .toList();
    }`;
  } else {
    rolesExtractor = `
    private java.util.Collection<GrantedAuthority> extractRoles(Jwt jwt) {
        java.util.List<String> roles = jwt.getClaimAsStringList("${meta.rolesClaim}");
        if (roles == null || roles.isEmpty()) {
            return java.util.Collections.emptyList();
        }
        return roles.stream()
                .filter(r -> !r.isBlank())
                .map(role -> new SimpleGrantedAuthority("ROLE_" + role))
                .map(GrantedAuthority.class::cast)
                .toList();
    }`;
  }

  const body = `/**
 * Mapea el JWT del proveedor (${model.stack.auth ?? 'genérico'}) a authorities de Spring:
 * roles (ROLE_), scopes OAuth2 (SCOPE_) y permisos granulares (sin prefijo).
 * Claim de roles: ${meta.type === 'nested' ? `${meta.rolesParent}.${meta.rolesField} (anidado)` : `${meta.rolesClaim} (plano)`}.
 * Principal: ${meta.principalClaim}.
 */
public class JwtAuthConverter {

    public JwtAuthenticationConverter converter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(this::extractAuthorities);
        converter.setPrincipalClaimName("${meta.principalClaim}");
        return converter;
    }

    private java.util.Collection<GrantedAuthority> extractAuthorities(Jwt jwt) {
        java.util.List<GrantedAuthority> authorities = new java.util.ArrayList<>(extractRoles(jwt));
        authorities.addAll(extractScopes(jwt));
        authorities.addAll(extractPermissions(jwt));
        return authorities;
    }
${rolesExtractor}
${scopesAndPermissions}
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'JwtAuthConverter'),
    content: javaFile(
      pkg,
      [
        'org.springframework.security.core.GrantedAuthority',
        'org.springframework.security.core.authority.SimpleGrantedAuthority',
        'org.springframework.security.oauth2.jwt.Jwt',
        'org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter'
      ],
      body
    )
  };
}

// Filtro de API key para protocol: api-key. Autentica la petición cuando el
// header X-API-Key coincide con la clave configurada (security.api-key).
function renderApiKeyFilter(model) {
  const body = `/**
 * Autentica por API key: compara el header X-API-Key con la clave configurada
 * en security.api-key. Sin clave configurada o sin coincidencia, la petición
 * sigue sin autenticar (la rechaza el SecurityFilterChain si la ruta lo exige).
 */
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    private static final String HEADER = "X-API-Key";

    private final String apiKey;

    public ApiKeyAuthFilter(String apiKey) {
        this.apiKey = apiKey;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String provided = request.getHeader(HEADER);
        if (apiKey != null && !apiKey.isBlank() && apiKey.equals(provided)) {
            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken("api-key-client", null, List.of());
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }
        chain.doFilter(request, response);
    }
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'ApiKeyAuthFilter'),
    content: javaFile(
      subPackage(model, SECURITY_PKG),
      [
        'jakarta.servlet.FilterChain',
        'jakarta.servlet.ServletException',
        'jakarta.servlet.http.HttpServletRequest',
        'jakarta.servlet.http.HttpServletResponse',
        'java.io.IOException',
        'java.util.List',
        'org.springframework.security.authentication.UsernamePasswordAuthenticationToken',
        'org.springframework.security.core.context.SecurityContextHolder',
        'org.springframework.web.filter.OncePerRequestFilter'
      ],
      body
    )
  };
}
