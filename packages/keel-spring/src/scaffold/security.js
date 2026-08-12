// Seguridad del servicio (capa security del diseño). Genera de forma
// determinista el SecurityConfig con su SecurityFilterChain: sesión stateless,
// matchers por ruta derivados de security.access (fuente única con los
// controllers vía model.security.matchers) y, según el protocolo, el resource
// server JWT (oidc/jwt) o un filtro de API key. Cuando el diseño usa roles o
// permisos, un JwtAuthConverter mapea los claims del proveedor (Keycloak/Cognito
// del stack) a authorities de Spring. No hay stubs de negocio: la autorización
// es enteramente derivable del diseño.

import { camelCase } from '../lib/naming.js';
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

// Spring Security acaba en el classpath sin que el diseño lo pida: el starter
// `spring-boot-starter-oauth2-client`, que se añade para la auth SALIENTE de un
// cliente `oauth2-client-credentials`, lo arrastra. Y su autoconfiguración cierra
// la puerta de ENTRADA: sin ninguna SecurityFilterChain declarada, Spring Boot
// registra la suya, que exige login en toda la API —`/actuator/health` incluido, que
// pasa a contestar 302 al formulario—.
//
// El servicio nace roto por un efecto colateral de una dependencia que se pidió para
// otra cosa, y el síntoma no menciona OAuth2 por ninguna parte. Lo destapó el humo
// del arnés en la corrida de autenticación saliente; sin ese sondeo, el diagnóstico
// habría sido mucho más caro.
//
// Los beans de OAuth2 Client quedan intactos: lo que se declara aquí es solo que la
// entrada está abierta, que es lo que dice el diseño al no traer capa `security`.
function needsOpenChain(model) {
  return (model.httpClients ?? []).some((client) => client.auth?.type === 'oauth2-client-credentials');
}

function renderOpenSecurityConfig(model) {
  const imports = [
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.security.config.annotation.web.builders.HttpSecurity',
    'org.springframework.security.config.annotation.web.configuration.EnableWebSecurity',
    'org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer',
    'org.springframework.security.web.SecurityFilterChain'
  ];
  const body = `/**
 * El diseño no declara capa \`security\`: la API es abierta. Esta cadena existe
 * porque el starter de OAuth2 Client —que está aquí por la auth SALIENTE de un
 * cliente— trae Spring Security, y sin una cadena propia su autoconfiguración
 * pondría toda la API (y el actuator) detrás de un login que nadie pidió.
 *
 * No toca los beans de OAuth2 Client: la auth saliente sigue funcionando igual.
 */
@Configuration
@EnableWebSecurity
public class OpenApiSecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .httpBasic(AbstractHttpConfigurer::disable)
            .formLogin(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}`;
  return {
    path: javaPath(model, SECURITY_PKG, 'OpenApiSecurityConfig'),
    content: javaFile(subPackage(model, SECURITY_PKG), imports, body)
  };
}

export function generate(model) {
  const sec = model.security;
  if (!model.layersPresent.security || !sec) {
    return needsOpenChain(model) ? [renderOpenSecurityConfig(model)] : [];
  }

  const files = [renderSecurityConfig(model, sec)];
  if (sec.cors) files.push(renderCorsConfig(model, sec.cors));
  const jwt = sec.protocol === 'oidc' || sec.protocol === 'jwt';
  if (jwt && sec.usesAuthorities) files.push(renderJwtAuthConverter(model));
  if (sec.protocol === 'api-key') files.push(renderApiKeyFilter(model));
  if (jwt && sec.serviceAuth?.validateAudience) files.push(renderAudienceFilter(model));
  if (sec.protocol !== 'none') files.push(renderSecurityErrorHandlers(model));
  if (needsServiceApiKeyFilter(sec)) files.push(renderServiceApiKeyFilter(model));
  return files;
}

// serviceAuth por api-key sobre un protocolo principal basado en token: los
// clientes máquina del catálogo serviceClients se autentican con clave propia.
// (Con protocolo principal api-key basta el ApiKeyAuthFilter clásico.)
function needsServiceApiKeyFilter(sec) {
  return (
    sec.serviceAuth?.protocol === 'api-key' &&
    sec.protocol !== 'api-key' &&
    (sec.serviceClients?.length ?? 0) > 0
  );
}

// Audiencia efectiva: la del diseño o, por defecto, el nombre del servicio.
function audienceOf(model, sec) {
  return sec.serviceAuth?.audience ?? model.service.artifactId;
}

// Bloque authorizeHttpRequests: endpoints técnicos permitidos (solo en la cadena
// que cubre todo), un matcher por regla de operación (antes del anyRequest) y la
// autoridad de cierre como anyRequest.
function authorizeBlock(matchers, { defaultAuthority, permitTechnical = true }) {
  const lines = ['            .authorizeHttpRequests(auth -> auth'];
  if (permitTechnical) {
    lines.push(
      '                    .requestMatchers("/actuator/health/**", "/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**").permitAll()'
    );
  }
  for (const m of matchers) {
    lines.push(`                    .requestMatchers(HttpMethod.${m.method}, "${m.path}").${m.authority}`);
  }
  lines.push(`                    .anyRequest().${defaultAuthority})`);
  return lines.join('\n');
}

// Rutas de audiencia 'services' (clientes máquina). Las 'both' quedan fuera a
// propósito: las sirve también un usuario, cuyo token no lleva la audiencia del
// servicio, así que no pueden caer en la cadena que la valida.
function serviceMatchersOf(sec) {
  return sec.matchers.filter((m) => m.audience === 'services');
}

// Patrones (sin método) para el securityMatcher de la cadena M2M, deduplicados.
function securityMatcherPatterns(matchers) {
  return [...new Set(matchers.map((m) => m.path))];
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

  // La política CORS del diseño se activa aquí: sin esta llamada el preflight
  // OPTIONS muere en la cadena de seguridad antes de llegar al controller. El
  // CorsFilter corre antes de la autorización, así que no hace falta permitir
  // OPTIONS en los matchers. La configuración vive en CorsConfig.
  const corsCall = '            .cors(Customizer.withDefaults())';
  const corsLine = sec.cors ? `${corsCall}\n` : '';
  if (sec.cors) imports.add('org.springframework.security.config.Customizer');

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
${corsLine}            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}`;
    return { path: javaPath(model, SECURITY_PKG, 'SecurityConfig'), content: javaFile(subPackage(model, SECURITY_PKG), [...imports], body) };
  }

  if (sec.matchers.length > 0) imports.add('org.springframework.http.HttpMethod');

  const jwt = sec.protocol === 'oidc' || sec.protocol === 'jwt';
  const validateAudience = jwt && sec.serviceAuth?.validateAudience === true;
  const serviceApiKey = needsServiceApiKeyFilter(sec);

  // Con validación de audiencia y rutas de ambos públicos, una sola cadena no
  // sirve: la comprobación de audiencia rechazaría los tokens de usuario (cuya audiencia
  // es la del IdP, no la del servicio). Se separan por securityMatcher.
  const serviceMatchers = validateAudience && !serviceApiKey ? serviceMatchersOf(sec) : [];
  const splitChains = serviceMatchers.length > 0 && serviceMatchers.length < sec.matchers.length;
  const mainMatchers = splitChains ? sec.matchers.filter((m) => !serviceMatchers.includes(m)) : sec.matchers;

  // 401 y 403 con el ErrorResponse del contrato (SecurityErrorHandlers), no con
  // el body por defecto de Spring Security.
  const exceptionHandling =
    '            .exceptionHandling(ex -> ex.authenticationEntryPoint(securityErrorHandlers).accessDeniedHandler(securityErrorHandlers))';

  const chain = [
    '            .csrf(AbstractHttpConfigurer::disable)',
    ...(sec.cors ? [corsCall] : []),
    '            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))',
    exceptionHandling,
    authorizeBlock(mainMatchers, { defaultAuthority: sec.defaultAuthority })
  ];

  let converterBean = '';
  if (jwt) {
    imports.add('org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter');
    // Todas las cadenas comparten el decoder que autoconfigura Boot desde el
    // issuer-uri: la audiencia ya no es asunto de la autenticación.
    if (sec.usesAuthorities) {
      chain.push(
        '            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter())))'
      );
      converterBean = `

    @Bean
    public JwtAuthenticationConverter jwtAuthConverter() {
        return new JwtAuthConverter().converter();
    }`;
    } else {
      imports.add('org.springframework.security.config.Customizer');
      chain.push('            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))');
    }
    // Sin cadenas separadas (todas las rutas son de audiencia services), la
    // comprobación de audiencia va en la única cadena que hay.
    if (validateAudience && !splitChains) {
      imports.add('org.springframework.security.web.access.intercept.AuthorizationFilter');
      chain.push(
        '            .addFilterBefore(new AudienceAuthorizationFilter(audience), AuthorizationFilter.class)'
      );
    }
  } else if (sec.protocol === 'api-key') {
    imports.add('org.springframework.beans.factory.annotation.Value');
    imports.add('org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter');
    chain.push('            .addFilterBefore(new ApiKeyAuthFilter(apiKey), UsernamePasswordAuthenticationFilter.class)');
  }

  const fields = [];
  if (sec.protocol === 'api-key') {
    imports.add('org.springframework.beans.factory.annotation.Value');
    fields.push(`
    @Value("\${security.api-key:}")
    private String apiKey;
`);
  }

  // Validación del claim aud (serviceAuth.validateAudience). NO va en el
  // JwtDecoder: un decoder que rechaza por audiencia convierte un token válido
  // de otro público en "token inválido" (401), cuando lo que ocurre es que está
  // autenticado y no autorizado (403) — la distinción que exige el diseño. Por
  // eso se comprueba como autorización, en un filtro posterior a la
  // autenticación y anterior al AuthorizationFilter, cuya AccessDeniedException
  // traduce a 403 el ExceptionTranslationFilter.
  //
  // Por eso aquí no se genera NINGÚN bean JwtDecoder: el decoder lo autoconfigura
  // Boot desde `spring.security.oauth2.resourceserver.jwt.*`, que build siembra
  // por perfil (issuer-uri en local/develop/production, jwk-set-uri de juguete en
  // test, ver config.js). Un decoder propio aquí obligaría a hardcodear una clave
  // en src/main y a acoplar esta clase al perfil de pruebas.
  if (validateAudience) {
    imports.add('org.springframework.beans.factory.annotation.Value');
    fields.push(`
    @Value("\${security.audience:${audienceOf(model, sec)}}")
    private String audience;
`);
  }

  // Cadena de los endpoints M2M: se declara primero (@Order(1)) y solo cubre sus
  // rutas; el resto de la API cae en la cadena de orden 2.
  let serviceChainBean = '';
  if (splitChains) {
    imports.add('org.springframework.core.annotation.Order');
    const patterns = securityMatcherPatterns(serviceMatchers)
      .map((p) => JSON.stringify(p))
      .join(', ');
    const resourceServer = sec.usesAuthorities
      ? '.oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter())))'
      : '.oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))';
    if (!sec.usesAuthorities) imports.add('org.springframework.security.config.Customizer');
    imports.add('org.springframework.security.web.access.intercept.AuthorizationFilter');
    serviceChainBean = `
    /**
     * Endpoints de audiencia services (clientes máquina): mismo resource server,
     * más la comprobación de audiencia como paso de AUTORIZACIÓN — un token de
     * usuario válido aquí da 403 (autenticado, sin permiso), no 401.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain serviceFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher(${patterns})
            .csrf(AbstractHttpConfigurer::disable)
${corsLine}            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
${exceptionHandling}
${authorizeBlock(serviceMatchers, { defaultAuthority: 'authenticated()', permitTechnical: false })}
            ${resourceServer}
            .addFilterBefore(new AudienceAuthorizationFilter(audience), AuthorizationFilter.class);
        return http.build();
    }`;
  }

  // Clientes máquina por API key (serviceAuth api-key sobre protocolo token):
  // una clave por serviceClient, con los scopes del diseño como authorities.
  let serviceApiKeyBean = '';
  if (serviceApiKey) {
    imports.add('org.springframework.beans.factory.annotation.Value');
    imports.add('org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter');
    imports.add('java.util.List');
    for (const client of sec.serviceClients) {
      fields.push(`
    @Value("\${security.api-keys.${client.name}:}")
    private String ${camelCase(client.name)}ApiKey;
`);
    }
    const entries = sec.serviceClients
      .map(
        (client) =>
          `                new ServiceApiKeyAuthFilter.ServiceClient("${client.name}", ${camelCase(client.name)}ApiKey, List.of(${client.scopes.map((s) => JSON.stringify(`SCOPE_${s}`)).join(', ')}))`
      )
      .join(',\n');
    chain.push('            .addFilterBefore(new ServiceApiKeyAuthFilter(serviceClients()), UsernamePasswordAuthenticationFilter.class)');
    serviceApiKeyBean = `

    private List<ServiceApiKeyAuthFilter.ServiceClient> serviceClients() {
        return List.of(
${entries});
    }`;
  }

  const mainChainOrder = splitChains ? '\n    @Order(2)' : '';
  // serviceChainBean ya abre con línea en blanco; el \n extra separa del @Bean.
  const beforeMainChain = serviceChainBean ? `${serviceChainBean}\n` : '';
  const errorHandlers = `
    private final SecurityErrorHandlers securityErrorHandlers;

    public SecurityConfig(SecurityErrorHandlers securityErrorHandlers) {
        this.securityErrorHandlers = securityErrorHandlers;
    }
`;
  const body = `@Configuration
@EnableWebSecurity
public class SecurityConfig {
${fields.join('')}${errorHandlers}${beforeMainChain}
    @Bean${mainChainOrder}
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
${chain.join('\n')};
        return http.build();
    }${converterBean}${serviceApiKeyBean}
}`;

  return { path: javaPath(model, SECURITY_PKG, 'SecurityConfig'), content: javaFile(subPackage(model, SECURITY_PKG), [...imports], body) };
}

// Política CORS del diseño (security.cors). Todo sale del diseño salvo los
// orígenes permitidos, que son dato de despliegue y llegan por configuración
// (security.cors.allowed-origins, una variable de entorno por ambiente).
function renderCorsConfig(model, cors) {
  const list = (values) => values.map((v) => JSON.stringify(v)).join(', ');
  // setAllowedOriginPatterns y no setAllowedOrigins: admite comodines de
  // subdominio y es lo único válido cuando se permiten credenciales.
  const body = `/**
 * Política CORS del servicio. Métodos derivados de los endpoints declarados en
 * el diseño (más OPTIONS, el preflight). Los orígenes permitidos se configuran
 * por ambiente en security.cors.allowed-origins: sin ninguno, el servicio no
 * acepta peticiones cross-origin.
 */
@Configuration
public class CorsConfig {

    private static final List<String> ALLOWED_METHODS = List.of(${list(cors.methods)});
    private static final List<String> ALLOWED_HEADERS = List.of(${list(cors.allowedHeaders)});
    private static final List<String> EXPOSED_HEADERS = List.of(${list(cors.exposedHeaders)});
    private static final Duration MAX_AGE = Duration.ofSeconds(${cors.maxAgeSeconds});

    @Value("\${security.cors.allowed-origins:}")
    private List<String> allowedOrigins;

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOriginPatterns(allowedOrigins.stream().filter(origin -> !origin.isBlank()).toList());
        configuration.setAllowedMethods(ALLOWED_METHODS);
        configuration.setAllowedHeaders(ALLOWED_HEADERS);
        configuration.setExposedHeaders(EXPOSED_HEADERS);
        configuration.setAllowCredentials(${cors.allowCredentials});
        configuration.setMaxAge(MAX_AGE);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'CorsConfig'),
    content: javaFile(
      subPackage(model, SECURITY_PKG),
      [
        'java.time.Duration',
        'java.util.List',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration',
        'org.springframework.web.cors.CorsConfiguration',
        'org.springframework.web.cors.CorsConfigurationSource',
        'org.springframework.web.cors.UrlBasedCorsConfigurationSource'
      ],
      body
    )
  };
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

  // security.roleGrants: qué permisos otorga cada rol. Es información del diseño,
  // no del token: ningún IdP la emite por defecto (Keycloak solo manda roles), así
  // que se materializa aquí para que los matchers hasAnyAuthority("<r>:<a>") se
  // satisfagan con el rol correspondiente.
  const grants = model.security?.roleGrants ?? [];
  const roleGrantsConstant = grants.length
    ? `
    /** Permisos que otorga cada rol (security.roleGrants del diseño). */
    private static final java.util.Map<String, java.util.List<String>> ROLE_GRANTS = java.util.Map.ofEntries(
${grants
  .map(
    (g) =>
      `            java.util.Map.entry("${g.role}", java.util.List.of(${g.permissions.map((p) => JSON.stringify(p)).join(', ')}))`
  )
  .join(',\n')});
`
    : '';

  const grantsExtractor = grants.length
    ? `

    /**
     * Expande los roles del token a las authorities de permiso que otorgan, según
     * el catálogo roleGrants del diseño.
     */
    private java.util.Collection<GrantedAuthority> extractGrantedPermissions(java.util.Collection<GrantedAuthority> roles) {
        return roles.stream()
                .map(GrantedAuthority::getAuthority)
                .map(authority -> authority.startsWith("ROLE_") ? authority.substring(5) : authority)
                .flatMap(role -> ROLE_GRANTS.getOrDefault(role, java.util.List.of()).stream())
                .distinct()
                .map(SimpleGrantedAuthority::new)
                .map(GrantedAuthority.class::cast)
                .toList();
    }`
    : '';

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

  const grantsLine = grants.length ? '\n        authorities.addAll(extractGrantedPermissions(roles));' : '';
  const body = `/**
 * Mapea el JWT del proveedor (${model.stack.auth ?? 'genérico'}) a authorities de Spring:
 * roles (ROLE_), scopes OAuth2 (SCOPE_) y permisos granulares (sin prefijo).
 * Claim de roles: ${meta.type === 'nested' ? `${meta.rolesParent}.${meta.rolesField} (anidado)` : `${meta.rolesClaim} (plano)`}.
 * Principal: ${meta.principalClaim}.
 */
public class JwtAuthConverter {
${roleGrantsConstant}
    public JwtAuthenticationConverter converter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(this::extractAuthorities);
        converter.setPrincipalClaimName("${meta.principalClaim}");
        return converter;
    }

    private java.util.Collection<GrantedAuthority> extractAuthorities(Jwt jwt) {
        java.util.Collection<GrantedAuthority> roles = extractRoles(jwt);
        java.util.List<GrantedAuthority> authorities = new java.util.ArrayList<>(roles);
        authorities.addAll(extractScopes(jwt));
        authorities.addAll(extractPermissions(jwt));${grantsLine}
        return authorities;
    }
${rolesExtractor}
${scopesAndPermissions}${grantsExtractor}
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

// 401/403 con el mismo contrato de error que el resto de la API. Sin esto los
// rechazos de la cadena de seguridad salen con el body por defecto de Spring
// Security (o vacío): el @RestControllerAdvice no los ve, porque ocurren en los
// filtros, antes de llegar a ningún controller.
function renderSecurityErrorHandlers(model) {
  const errorResponse = `${subPackage(model, 'infrastructure.rest')}.ErrorResponse`;
  const body = `/**
 * Traduce los rechazos de la cadena de seguridad al ErrorResponse del contrato:
 * 401 cuando falta o no vale la credencial, 403 cuando la credencial es válida
 * pero no basta para la operación.
 */
@Component
public class SecurityErrorHandlers implements AuthenticationEntryPoint, AccessDeniedHandler {

    private final ObjectMapper objectMapper;

    public SecurityErrorHandlers(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
            AuthenticationException exception) throws IOException {
        write(response, HttpStatus.UNAUTHORIZED, "Unauthorized", "Credenciales ausentes o no válidas");
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response,
            AccessDeniedException exception) throws IOException {
        write(response, HttpStatus.FORBIDDEN, "Forbidden", "La credencial no autoriza esta operación");
    }

    private void write(HttpServletResponse response, HttpStatus status, String error, String message)
            throws IOException {
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(), new ErrorResponse(status.value(), error, message));
    }
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'SecurityErrorHandlers'),
    content: javaFile(
      subPackage(model, SECURITY_PKG),
      [
        'com.fasterxml.jackson.databind.ObjectMapper',
        'jakarta.servlet.http.HttpServletRequest',
        'jakarta.servlet.http.HttpServletResponse',
        'java.io.IOException',
        'org.springframework.http.HttpStatus',
        'org.springframework.http.MediaType',
        'org.springframework.security.access.AccessDeniedException',
        'org.springframework.security.core.AuthenticationException',
        'org.springframework.security.web.AuthenticationEntryPoint',
        'org.springframework.security.web.access.AccessDeniedHandler',
        'org.springframework.stereotype.Component',
        errorResponse
      ],
      body
    )
  };
}

// Comprobación del claim aud para serviceAuth.validateAudience. Es una regla de
// AUTORIZACIÓN, no de autenticación: el token es legítimo (firma e issuer
// válidos), lo que falta es que esté emitido para este servicio. Por eso va en
// un filtro posterior a la autenticación —y anterior al AuthorizationFilter—
// que lanza AccessDeniedException: el ExceptionTranslationFilter la traduce a
// 403. Validarlo en el JwtDecoder daría 401 y borraría esa distinción.
function renderAudienceFilter(model) {
  const audience = audienceOf(model, model.security);
  const body = `/**
 * Exige que el claim aud del JWT incluya la audiencia de este servicio
 * (security.audience, por defecto "${audience}"). Un token válido emitido para
 * otro servicio queda autenticado pero no autorizado: 403, no 401.
 */
public class AudienceAuthorizationFilter extends OncePerRequestFilter {

    private final String audience;

    public AudienceAuthorizationFilter(String audience) {
        this.audience = audience;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof JwtAuthenticationToken token
                && (token.getToken().getAudience() == null || !token.getToken().getAudience().contains(audience))) {
            throw new AccessDeniedException("El token no está emitido para la audiencia " + audience);
        }
        chain.doFilter(request, response);
    }
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'AudienceAuthorizationFilter'),
    content: javaFile(
      subPackage(model, SECURITY_PKG),
      [
        'jakarta.servlet.FilterChain',
        'jakarta.servlet.ServletException',
        'jakarta.servlet.http.HttpServletRequest',
        'jakarta.servlet.http.HttpServletResponse',
        'java.io.IOException',
        'org.springframework.security.access.AccessDeniedException',
        'org.springframework.security.core.Authentication',
        'org.springframework.security.core.context.SecurityContextHolder',
        'org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken',
        'org.springframework.web.filter.OncePerRequestFilter'
      ],
      body
    )
  };
}

// Filtro de API key para clientes máquina (serviceAuth api-key + serviceClients):
// autentica al cliente cuya clave (security.api-keys.<cliente>) coincide con el
// header X-API-Key, con los scopes del diseño como authorities SCOPE_*.
function renderServiceApiKeyFilter(model) {
  const body = `/**
 * Autentica clientes máquina por API key: compara el header X-API-Key con la
 * clave de cada serviceClient del diseño (security.api-keys.<cliente>) y, si
 * coincide, autentica como ese cliente con sus scopes (authorities SCOPE_*).
 * Sin coincidencia, la petición sigue sin autenticar.
 */
public class ServiceApiKeyAuthFilter extends OncePerRequestFilter {

    public record ServiceClient(String name, String apiKey, List<String> authorities) {}

    private static final String HEADER = "X-API-Key";

    private final List<ServiceClient> clients;

    public ServiceApiKeyAuthFilter(List<ServiceClient> clients) {
        this.clients = clients;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String provided = request.getHeader(HEADER);
        if (provided != null && !provided.isBlank()
                && SecurityContextHolder.getContext().getAuthentication() == null) {
            for (ServiceClient client : clients) {
                if (client.apiKey() != null && !client.apiKey().isBlank() && client.apiKey().equals(provided)) {
                    UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                            client.name(), null,
                            client.authorities().stream().map(SimpleGrantedAuthority::new).toList());
                    SecurityContextHolder.getContext().setAuthentication(authentication);
                    break;
                }
            }
        }
        chain.doFilter(request, response);
    }
}`;

  return {
    path: javaPath(model, SECURITY_PKG, 'ServiceApiKeyAuthFilter'),
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
        'org.springframework.security.core.authority.SimpleGrantedAuthority',
        'org.springframework.security.core.context.SecurityContextHolder',
        'org.springframework.web.filter.OncePerRequestFilter'
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
