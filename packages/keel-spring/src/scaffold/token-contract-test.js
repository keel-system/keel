// La prueba que demuestra el contrato entre el servidor y el TOKEN (casos IDT-* de keel-core/gen/token-cases.js), escrita
// en cada proyecto con la forma de token del proveedor elegido. Sin contexto de Spring, sin red y sin el proveedor: cada
// caso construye un Jwt con sus claims y le pregunta a las piezas generadas que lo leen (JwtAuthConverter,
// AudienceAuthorizationFilter, CallerIdentity, JwtCallerScope). Va en el source set `test`, y en el paquete de seguridad
// porque el credential() de CallerIdentity es de paquete.

import { audienceOf, checksAudience } from '@keel-system/keel-core/gen/access-plan';
import { credentialClientId, tokenContract } from '@keel-system/keel-core/gen/identity-providers';
import { translatedClients } from '@keel-system/keel-core/gen/security-config';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { javaFile, javaPath, subPackage } from './render.js';
import { SECURITY_PKG, callerResolution, usesJwtConverter } from './security.js';

const CLASS_NAME = 'TokenContractTest';

function javaLiteral(value) {
  if (Array.isArray(value)) return `List.of(${value.map(javaLiteral).join(', ')})`;
  if (value !== null && typeof value === 'object') return `Map.of(${Object.entries(value).flatMap(([key, item]) => [JSON.stringify(key), javaLiteral(item)]).join(', ')})`;
  return JSON.stringify(value);
}

const claimsLiteral = (claims) => `Map.ofEntries(${Object.entries(claims).map(([key, value]) => `Map.entry(${JSON.stringify(key)}, ${javaLiteral(value)})`).join(', ')})`;

const methodName = (id) => id.toLowerCase().replace(/-(.)/g, (_, letter) => letter.toUpperCase());

/** Las líneas que afirman un caso, o [] si ninguna pieza de este diseño lo lee. */
function assertions(entry, { audienceFilter, identityRead }) {
  const { expect } = entry;
  if (expect.authenticated === false) return ['Assertions.assertThrows(AuthenticationException.class, () -> authenticate(token));'];

  const lines = [];
  if (expect.principal !== undefined) lines.push(`Assertions.assertEquals(${JSON.stringify(expect.principal)}, authenticate(token).getName());`);
  for (const authority of expect.authorities?.includes ?? []) lines.push(`Assertions.assertTrue(authorities(token).contains(${JSON.stringify(authority)}), ${JSON.stringify(`falta ${authority}`)});`);
  for (const authority of expect.authorities?.excludes ?? []) lines.push(`Assertions.assertFalse(authorities(token).contains(${JSON.stringify(authority)}), ${JSON.stringify(`sobra ${authority}`)});`);
  if (expect.identity !== undefined) lines.push('signIn(token);', `Assertions.assertEquals(${JSON.stringify(expect.identity)}, ${identityRead});`);
  if (expect.exempt !== undefined) lines.push('signIn(token);', `Assertions.${expect.exempt ? 'assertTrue' : 'assertFalse'}(new JwtCallerScope().isExempt());`);
  if (expect.scope !== undefined) lines.push(`Assertions.assertEquals(Set.of(${expect.scope.map((value) => JSON.stringify(value)).join(', ')}), new JwtCallerScope().scopedValues());`);
  if (expect.issuedForService !== undefined && audienceFilter) {
    lines.push('signIn(token);');
    lines.push(
      expect.issuedForService
        ? 'Assertions.assertDoesNotThrow(() -> filterAudience());'
        : 'Assertions.assertThrows(AccessDeniedException.class, () -> filterAudience());'
    );
  }
  return lines;
}

export function generate(model) {
  const cases = tokenCases(model);
  if (cases.length === 0) return [];

  const sec = model.security;
  const audience = audienceOf(model);
  const { prefixedScopes } = tokenContract(model.stack.auth);
  const converter = usesJwtConverter(model);
  const audienceFilter = checksAudience(sec);
  const translated = translatedClients(model);
  const identityRead = `CallerIdentity.${callerResolution(model) ? 'credential' : 'resolve'}()`;

  const methods = cases.flatMap((entry) => {
    const lines = assertions(entry, { audienceFilter, identityRead });
    if (lines.length === 0) return [];
    return [
      `    /** ${entry.rule} */
    @Test
    void ${methodName(entry.id)}() {
        Jwt token = jwt(${claimsLiteral(entry.token)});
${[...new Set(lines)].map((line) => `        ${line}`).join('\n')}
    }`
    ];
  });
  if (methods.length === 0) return [];

  const authenticate = converter
    ? `(JwtAuthenticationToken) new JwtAuthConverter(${prefixedScopes ? JSON.stringify(audience) : ''}).converter().convert(token)`
    : 'new JwtAuthenticationToken(token, List.of(), token.getSubject())';
  const setUp = translated.length > 0
    ? `
    @BeforeEach
    void configureClientIds() {
        new ServiceClientIds(new MockEnvironment()${translated.map((client) => `
                .withProperty(${JSON.stringify(`security.client-ids.${client.name}`)}, ${JSON.stringify(credentialClientId(model.stack.auth, client.name))})`).join('')});
    }
`
    : '';
  const requiredClientIds = translated.length > 0
    ? `

    /** P2: sin el id de un cliente del que depende, el servicio no arranca; tampoco con la variable sin resolver. */
    @Test
    void clientIdIsRequired() {
        String key = ${JSON.stringify(`security.client-ids.${translated[0].name}`)};
        Assertions.assertThrows(RuntimeException.class, () -> new ServiceClientIds(new MockEnvironment()));
        Assertions.assertThrows(RuntimeException.class, () -> new ServiceClientIds(new MockEnvironment().withProperty(key, "\${KEEL_UNSET_VARIABLE}")));
    }`
    : '';
  const filterHelper = audienceFilter
    ? `

    private static void filterAudience() throws Exception {
        new AudienceAuthorizationFilter(${JSON.stringify(audience)}).doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), new MockFilterChain());
    }`
    : '';

  const body = `/**
 * El contrato entre este servidor y el token del proveedor de identidad (${model.stack.auth}): dado un token con la
 * forma que emite el proveedor, qué principal, qué authorities, qué identidad y qué exención ve el servidor. Los casos
 * los deriva el generador del diseño y del descriptor del proveedor; no necesitan el proveedor ni infraestructura.
 */
class ${CLASS_NAME} {
${setUp}
    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    private static Jwt jwt(Map<String, Object> claims) {
        return Jwt.withTokenValue("token").header("alg", "none").claims(target -> target.putAll(claims)).build();
    }

    private static JwtAuthenticationToken authenticate(Jwt token) {
        return ${authenticate};
    }

    private static Set<String> authorities(Jwt token) {
        return authenticate(token).getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
    }

    private static void signIn(Jwt token) {
        SecurityContextHolder.getContext().setAuthentication(authenticate(token));
    }${filterHelper}

${methods.join('\n\n')}${requiredClientIds}
}`;

  const usesType = (name) => new RegExp(`\\b${name}\\b`).test(body);
  const imports = [
    'java.util.List',
    'java.util.Map',
    'java.util.Set',
    'java.util.stream.Collectors',
    'org.junit.jupiter.api.AfterEach',
    'org.junit.jupiter.api.Assertions',
    'org.junit.jupiter.api.Test',
    'org.springframework.security.core.GrantedAuthority',
    'org.springframework.security.core.context.SecurityContextHolder',
    'org.springframework.security.oauth2.jwt.Jwt',
    'org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken',
    usesType('BeforeEach') && 'org.junit.jupiter.api.BeforeEach',
    usesType('MockEnvironment') && 'org.springframework.mock.env.MockEnvironment',
    usesType('AuthenticationException') && 'org.springframework.security.core.AuthenticationException',
    usesType('AccessDeniedException') && 'org.springframework.security.access.AccessDeniedException',
    ...(audienceFilter
      ? ['org.springframework.mock.web.MockFilterChain', 'org.springframework.mock.web.MockHttpServletRequest', 'org.springframework.mock.web.MockHttpServletResponse']
      : [])
  ];

  return [{ path: javaPath(model, SECURITY_PKG, CLASS_NAME, 'test'), content: javaFile(subPackage(model, SECURITY_PKG), imports, body) }];
}
