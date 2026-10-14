// La seguridad del servicio (capa security del diseño): quién llama y qué puede pedir.
//
// El contrato es el de los servidores de keel-spring y keel-nest del mismo diseño, y la decisión la toma keel-core
// (gen/access-plan.js): qué exige cada regla, qué rutas comprueban la audiencia y en qué orden se evalúa todo. Aquí
// solo se escribe en C#:
//
//   · un MIDDLEWARE propio de la entrada HTTP (no el de autorización de ASP.NET Core) que evalúa el plan por método y
//     ruta, delante de los endpoints. Spring Security decide antes de enrutar: sin credencial, un camino que no existe
//     responde 401 y no 404, y uno que existe con otro método también. El enrutado de ASP.NET Core ya eligió endpoint
//     cuando corre el middleware, así que la regla compara la FORMA de la ruta que casó (su plantilla), y si no casó
//     ninguna, el camino;
//   · la validación del JWT con Microsoft.IdentityModel.JsonWebTokens (MIT) contra el JWKS del proveedor —discovery
//     del issuer-uri, perezoso, como el resource server de Spring—, con las authorities de Spring: `ROLE_<rol>`, el
//     permiso tal cual y `SCOPE_<scope>`, los roles del diseño expandidos a sus permisos (`roleGrants`). No se usa el
//     handler JwtBearer: decide DESPUÉS de enrutar y convierte un proveedor caído en un 401, que culparía a la
//     credencial de un fallo que no es suyo (aquí es un 500, como en los otros dos);
//   · los rechazos como ErrorResponse con los `code` del catálogo (UNAUTHENTICATED, ACCESS_DENIED);
//   · CORS con la semántica del DefaultCorsProcessor de Spring, dentro del mismo middleware y ANTES de autenticar;
//   · la identidad del llamante (`callerIdentity`) en un único punto, y el alcance por recurso (`scoping`) como un
//     puerto de la aplicación con su adaptador.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { FRAMEWORK_RESPONSES as FW } from 'keel-core/gen/api-errors';
import { accessPlan, audienceOf, tokenClaims, usesTokenProtocol } from 'keel-core/gen/access-plan';
import { envRequired } from 'keel-core/gen/profile-values';
import { envFor, runtimeDefault } from 'keel-core/gen/runtime-env';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesApi } from './rest-support.js';
import { wireNamespace } from './wire.js';

/** Clave de API del perfil local (catálogo neutral: keel-core/gen/runtime-env). */
export const LOCAL_API_KEY = runtimeDefault('SECURITY_API_KEY');
export const localClientApiKey = (client) => `local-${client}-key`;
/** La variable con la que las pruebas del perfil `test` publican el JWKS con el que firman. */
export const TEST_JWKS_VARIABLE = 'SECURITY_TEST_JWKS';
/** El puerto del alcance por recurso, en Application/Support. */
export const CALLER_SCOPE_PORT = 'ICallerScope';

/** El plan de autorización, o null sin capa security o sin API que proteger. */
export function securityPlan(model) {
  if (!usesApi(model)) return null;
  return accessPlan(model);
}

/** ¿Hay middleware en la entrada HTTP? Con el protocolo `none`, solo si hay CORS. */
export function usesHttpSecurity(model) {
  const plan = securityPlan(model);
  return Boolean(plan && (!plan.open || model.security?.cors));
}

export function usesJwt(model) {
  const plan = securityPlan(model);
  return Boolean(plan && !plan.open) && usesTokenProtocol(model.security);
}

/** Los clientes que autentican con clave de API, con la clave de configuración y sus authorities. */
export function apiKeyClients(model) {
  const plan = securityPlan(model);
  if (!plan || plan.open) return [];
  if (plan.protocol === 'api-key') return [{ name: 'api-key-client', key: 'security:api-key', authorities: [] }];
  if (plan.serviceApiKeys) {
    return model.security.serviceClients.map((client) => ({
      name: client.name,
      key: `security:api-keys:${client.name}`,
      authorities: client.scopes.map((scope) => `SCOPE_${scope}`)
    }));
  }
  return [];
}

/** ¿Resuelve el servidor la identidad del llamante desde la credencial? */
export function usesCallerIdentity(model) {
  const plan = securityPlan(model);
  return Boolean(plan && !plan.open && model.security?.callerIdentity);
}

/** ¿Hay alcance por recurso con su puerto? Solo sobre un token: es un claim. */
export function usesCallerScope(model) {
  return Boolean(usesJwt(model) && model.security?.scoping);
}

/** Las operaciones cuyo handler recibe el alcance: las que declaran su error. */
export function scopedOperation(model, operation) {
  const scoping = model.security?.scoping;
  return Boolean(usesCallerScope(model) && scoping && (operation.errors ?? []).includes(scoping.error));
}

export function securityNamespace(model) {
  return namespaceOf(model, 'security');
}

export function generate(model) {
  if (!usesHttpSecurity(model)) return [];
  const plan = securityPlan(model);
  const files = [file(model, 'security', 'SecurityContext', securityContextBody(model), ['System.Text.Json'])];
  if (!plan.open) files.push(file(model, 'security', 'AccessRules', accessRulesBody(model), ['System.Collections.Concurrent', 'System.Text.RegularExpressions']));
  if (usesJwt(model)) {
    files.push(
      file(model, 'security', 'JwtAuthenticator', jwtAuthenticatorBody(model), [
        'System.Text.Json',
        'System.Text.RegularExpressions',
        'Microsoft.IdentityModel.JsonWebTokens',
        'Microsoft.IdentityModel.Tokens',
        configNamespace(model)
      ])
    );
  }
  if (apiKeyClients(model).length > 0) {
    files.push(file(model, 'security', 'ApiKeyAuthenticator', apiKeyAuthenticatorBody(model), ['System.Security.Cryptography', 'System.Text', 'System.Text.Json', configNamespace(model)]));
  }
  if (model.security?.cors) {
    files.push(file(model, 'security', 'CorsPolicy', corsPolicyBody(model), ['System.Text.RegularExpressions', 'Microsoft.AspNetCore.Http', configNamespace(model)]));
  }
  if (usesCallerIdentity(model)) files.push(file(model, 'security', 'CallerIdentity', callerIdentityBody(model)));
  if (usesCallerScope(model)) {
    files.push(file(model, 'appSupport', CALLER_SCOPE_PORT, callerScopePortBody(model)));
    files.push(file(model, 'security', 'JwtCallerScope', jwtCallerScopeBody(model), ['System.Text.Json', namespaceOf(model, 'appSupport')]));
  }
  files.push(registration(model));
  files.push(middleware(model));
  files.push(...configFragments(model));
  return files;
}

function file(model, place, className, body, usings = []) {
  const { namespace, path } = located(model, place, className);
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── SecurityContext.cs ─────────────────────────────────────────────────────────────────────────

function securityContextBody() {
  return `/// <summary>De dónde sale la credencial de un principal: un token validado o una clave de API.</summary>
public enum PrincipalKind
{
    Token,
    Key
}

/// <summary>
/// Quién hace la petición en curso, ya autenticado: lo que en Spring es el SecurityContextHolder.
/// </summary>
/// <param name="Kind">Un token validado o una clave de API.</param>
/// <param name="Name">El nombre del principal: el claim del proveedor en un token, el cliente en una clave.</param>
/// <param name="Authorities"><c>ROLE_&lt;rol&gt;</c>, el permiso tal cual (<c>recurso:accion</c>) y <c>SCOPE_&lt;scope&gt;</c>, como en Spring.</param>
/// <param name="Claims">Los claims del token tal como llegaron (vacío con una clave de API).</param>
public sealed record Principal(PrincipalKind Kind, string Name, IReadOnlySet<string> Authorities, IReadOnlyDictionary<string, JsonElement> Claims);

/// <summary>
/// El principal de la petición en curso. Vive en un <see cref="AsyncLocal{T}"/> que abre el middleware de seguridad
/// (HttpSecurityMiddleware) y que sigue a la petición por todos sus await. Fuera de una petición (un listener, un
/// barrido) no hay ninguno: <see cref="Get"/> devuelve null.
/// </summary>
public static class SecurityContext
{
    private static readonly AsyncLocal<Principal?> Current = new();

    /// <summary>El principal de la petición en curso, o null si es anónima o no hay petición.</summary>
    public static Principal? Get() => Current.Value;

    /// <summary>Abre el principal indicado (null: anónima) hasta que se libera lo que devuelve.</summary>
    public static IDisposable Open(Principal? principal)
    {
        var previous = Current.Value;
        Current.Value = principal;
        return new Restore(previous);
    }

    private sealed class Restore(Principal? previous) : IDisposable
    {
        public void Dispose() => Current.Value = previous;
    }
}

/// <summary>Cómo se lee un claim, igual que los getClaimAs* del Jwt de Spring.</summary>
public static class ClaimValues
{
    /// <summary>Un claim como texto: un número o un booleano se convierten; un objeto o una lista, no.</summary>
    public static string? Text(IReadOnlyDictionary<string, JsonElement> claims, string name)
    {
        ArgumentNullException.ThrowIfNull(claims);
        return claims.TryGetValue(name, out var value) ? Text(value) : null;
    }

    public static string? Text(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => null
    };

    /// <summary>Un claim de lista; un texto suelto cuenta como lista de uno, como getClaimAsStringList.</summary>
    public static IReadOnlyList<string> List(IReadOnlyDictionary<string, JsonElement> claims, string name)
    {
        ArgumentNullException.ThrowIfNull(claims);
        return claims.TryGetValue(name, out var value) ? List(value) : [];
    }

    public static IReadOnlyList<string> List(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Array => [.. value.EnumerateArray().Select(element => Text(element) ?? element.GetRawText())],
        JsonValueKind.String => [value.GetString()!],
        _ => []
    };
}`;
}

// ─── AccessRules.cs ─────────────────────────────────────────────────────────────────────────────

/** Una exigencia del plan como expresión C#. */
export function requirementLiteral(requirement) {
  if (requirement.kind === 'anyOf') return `Requirement.AnyOf(${requirement.authorities.map(csString).join(', ')})`;
  return requirement.kind === 'public' ? 'Requirement.PermitAll' : 'Requirement.Authenticated';
}

function accessRulesBody(model) {
  const plan = securityPlan(model);
  const chains = plan.chains.map((chain) => {
    const rules = chain.rules.map((rule) => `                new AccessRule(${rule.method ? csString(rule.method) : 'null'}, ${csString(rule.path)}, ${requirementLiteral(rule.requirement)}),`);
    return `        new AccessChain(
            Paths: ${chain.paths ? `[${chain.paths.map(csString).join(', ')}]` : 'null'},
            ChecksAudience: ${chain.checksAudience},
            Rules:
            [
${rules.join('\n')}
            ],
            Fallback: ${requirementLiteral(chain.fallback)}),`;
  });
  return `/// <summary>Lo que exige una regla: nada, una credencial cualquiera, o alguna de unas authorities.</summary>
public enum RequirementKind
{
    PermitAll,
    Authenticated,
    AnyOf
}

public sealed record Requirement(RequirementKind Kind, IReadOnlyList<string> Authorities)
{
    public static Requirement PermitAll { get; } = new(RequirementKind.PermitAll, []);

    public static Requirement Authenticated { get; } = new(RequirementKind.Authenticated, []);

    public static Requirement AnyOf(params string[] authorities) => new(RequirementKind.AnyOf, authorities);
}

/// <summary>Una regla: el método (null: cualquiera), la ruta del diseño y lo que exige.</summary>
public sealed record AccessRule(string? Method, string Path, Requirement Requirement);

/// <summary>
/// Una cadena: las rutas que cubre (null: todas), si exige que el token esté emitido para este servicio (audiencia),
/// sus reglas en orden y el cierre.
/// </summary>
public sealed record AccessChain(IReadOnlyList<string>? Paths, bool ChecksAudience, IReadOnlyList<AccessRule> Rules, Requirement Fallback);

/// <summary>
/// La petición vista por las reglas: su método, su camino ya decodificado y, si una ruta casó, su plantilla
/// (<c>/api/v1/products/{id}</c>). Con plantilla se compara la FORMA de la ruta, que es lo que vio el enrutador: una
/// regla no se puede esquivar codificando un carácter del camino.
/// </summary>
public sealed record AccessTarget(string Method, string Path, string? Pattern);

/// <summary>Lo que se decide para una petición: qué exige y si comprueba la audiencia.</summary>
public sealed record AccessDecision(Requirement Requirement, bool ChecksAudience);

/// <summary>El veredicto: concedida, falta credencial (401) o la credencial no basta (403).</summary>
public enum AccessVerdict
{
    Granted,
    Unauthenticated,
    Denied
}

/// <summary>
/// La autorización de la entrada HTTP como DATOS, derivada del diseño (security.access) por el plan neutral de
/// keel-core: el mismo que el servidor de keel-spring escribe como su SecurityFilterChain y el de keel-nest como su
/// hook de entrada.
/// </summary>
/// <remarks>
/// Se evalúa como una cadena de filtros: la petición cae en la PRIMERA cadena cuyo patrón de rutas casa (sin mirar el
/// método) y, dentro, en la PRIMERA regla que casa por método y ruta; si ninguna casa, en el cierre de esa cadena. Un
/// camino que no existe también cae ahí.
/// </remarks>
public static partial class AccessRules
{
    public static IReadOnlyList<AccessChain> Chains { get; } =
    [
${chains.join('\n')}
    ];

    private static readonly ConcurrentDictionary<string, Regex> PathPatterns = new(StringComparer.Ordinal);

    /// <summary>La regla que se aplica a la petición.</summary>
    public static AccessDecision Decide(AccessTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        var method = target.Method.ToUpperInvariant();
        var chain = Chains.FirstOrDefault(candidate => candidate.Paths is null || candidate.Paths.Any(path => Matches(path, target))) ?? Chains[^1];
        var rule = chain.Rules.FirstOrDefault(candidate =>
            (candidate.Method is null || string.Equals(candidate.Method, method, StringComparison.Ordinal)) && Matches(candidate.Path, target));
        return new AccessDecision(rule?.Requirement ?? chain.Fallback, chain.ChecksAudience);
    }

    /// <summary>El veredicto de una exigencia para un principal (null: anónimo).</summary>
    public static AccessVerdict Judge(Requirement requirement, Principal? principal)
    {
        ArgumentNullException.ThrowIfNull(requirement);
        if (requirement.Kind == RequirementKind.PermitAll)
        {
            return AccessVerdict.Granted;
        }
        if (principal is null)
        {
            return AccessVerdict.Unauthenticated;
        }
        if (requirement.Kind == RequirementKind.Authenticated)
        {
            return AccessVerdict.Granted;
        }
        return requirement.Authorities.Any(principal.Authorities.Contains) ? AccessVerdict.Granted : AccessVerdict.Denied;
    }

    private static bool Matches(string rulePath, AccessTarget target)
    {
        if (target.Pattern is not null)
        {
            return string.Equals(ShapeOf(rulePath), ShapeOf(target.Pattern), StringComparison.Ordinal);
        }
        var regex = PathPatterns.GetOrAdd(
            rulePath,
            path => new Regex("^" + string.Join("[^/]+", Parameter().Split(path).Select(Regex.Escape)) + "\\\\z", RegexOptions.CultureInvariant));
        return regex.IsMatch(target.Path);
    }

    private static string ShapeOf(string path) => Parameter().Replace(path, "{}");

    [GeneratedRegex(@"\\{[^}]+\\}", RegexOptions.CultureInvariant)]
    private static partial Regex Parameter();
}`;
}

// ─── JwtAuthenticator.cs ────────────────────────────────────────────────────────────────────────

function jwtAuthenticatorBody(model) {
  const sec = model.security;
  const claims = tokenClaims(model.stack?.auth);
  const cognito = model.stack?.auth === 'cognito';
  // Sin roles, permisos ni scopes en ninguna regla, Spring usa su conversor por defecto, cuyo principal es el `sub`:
  // el nombre que ve la identidad del llamante tiene que ser el mismo.
  const principalClaim = sec.usesAuthorities ? claims.principalClaim : 'sub';
  const grants = (sec.roleGrants ?? []).map((grant) => `        [${csString(grant.role)}] = [${grant.permissions.map(csString).join(', ')}],`);
  const roles =
    claims.type === 'nested'
      ? `        if (!claims.TryGetValue(${csString(claims.rolesParent)}, out var parent) || parent.ValueKind != JsonValueKind.Object
            || !parent.TryGetProperty(${csString(claims.rolesField)}, out var roles) || roles.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        return [.. roles.EnumerateArray().Where(role => role.ValueKind == JsonValueKind.String).Select(role => role.GetString()!)];`
      : `        return [.. ClaimValues.List(claims, ${csString(claims.rolesClaim)}).Where(role => !string.IsNullOrWhiteSpace(role))];`;
  const issuedFor = cognito
    ? `    /// <summary>
    /// ¿Está el token emitido para ESTE servicio? Cognito no pone <c>aud</c> en los tokens de client_credentials: dice a
    /// qué API vale cada permiso con el PREFIJO del scope (<c>&lt;audiencia&gt;/&lt;scope&gt;</c>), así que la audiencia es ese
    /// prefijo. Un token de usuario, sin scopes de máquina, tampoco pasa.
    /// </summary>
    public static bool IssuedFor(Principal principal, string audience)
    {
        ArgumentNullException.ThrowIfNull(principal);
        var scope = ClaimValues.Text(principal.Claims, "scope");
        return scope is not null && scope.Split(' ').Any(value => value.StartsWith(audience + "/", StringComparison.Ordinal));
    }`
    : `    /// <summary>¿Está el token emitido para ESTE servicio? Su claim <c>aud</c> tiene que incluir la audiencia.</summary>
    public static bool IssuedFor(Principal principal, string audience)
    {
        ArgumentNullException.ThrowIfNull(principal);
        return ClaimValues.List(principal.Claims, "aud").Contains(audience, StringComparer.Ordinal);
    }`;
  return `/// <summary>La credencial no vale: el middleware responde 401.</summary>
public sealed class InvalidCredentialException(string message, Exception? cause = null) : Exception(message, cause);

/// <summary>
/// Valida el JWT de la petición y lo convierte en un Principal con las authorities de Spring: <c>ROLE_&lt;rol&gt;</c>
/// (${claims.type === 'nested' ? `claim anidado <c>${claims.rolesParent}.${claims.rolesField}</c>` : `claim <c>${claims.rolesClaim}</c>`}), <c>SCOPE_&lt;scope&gt;</c> (claim <c>scope</c>${cognito ? ', sin el prefijo del resource server que pone Cognito' : ''}),
/// los permisos del claim <c>${claims.permissionsClaim}</c> y los que otorga cada rol según el diseño (security.roleGrants).
/// </summary>
/// <remarks>
/// Las claves salen de la configuración, como en el resource server de Spring:
/// <c>security.oauth2.issuer-uri</c> (el discovery OIDC del emisor da el JWKS, y el claim <c>iss</c> tiene que ser
/// exactamente ese emisor); <c>security.oauth2.jwk-set-uri</c> (el JWKS directamente, sin comprobar <c>iss</c>: el
/// emisor visto desde dentro de una red de contenedores no es el que firma los tokens pedidos desde fuera); y
/// <c>security.oauth2.jwks</c>, el JWKS en línea, que solo usa el perfil <c>test</c> (lo publican las pruebas en
/// ${TEST_JWKS_VARIABLE} con la clave con la que firman).
/// Se resuelven en la PRIMERA petición con token, no al arrancar: el servicio arranca aunque el proveedor aún no esté,
/// igual que los de keel-spring y keel-nest. Un fallo al resolverlas es un 500 (el servidor no puede decidir), nunca un
/// 401: diría al cliente que su credencial no vale cuando quien falla es el proveedor. Una resolución fallida no se
/// guarda: la siguiente petición lo vuelve a intentar.
/// </remarks>
public sealed partial class JwtAuthenticator
{
    /// <summary>Permisos que otorga cada rol (security.roleGrants del diseño): ningún proveedor los emite.</summary>
    private static readonly Dictionary<string, string[]> RoleGrants = new(StringComparer.Ordinal)
    {
${grants.join('\n')}
    };

    /// <summary>El claim del nombre del principal.</summary>
    private const string PrincipalClaim = ${csString(principalClaim)};

    /// <summary>Margen de reloj al comprobar <c>exp</c> y <c>nbf</c>: el de Spring (60 s).</summary>
    private static readonly TimeSpan ClockTolerance = TimeSpan.FromSeconds(60);

    /// <summary>Lo mínimo entre dos lecturas del JWKS remoto cuando llega un token firmado con una clave que no se conoce.</summary>
    private static readonly TimeSpan RefreshCooldown = TimeSpan.FromSeconds(30);

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };

    private readonly string? issuerUri;
    private readonly string? jwkSetUri;
    private readonly string? inlineJwks;
    private readonly JsonWebTokenHandler handler = new();
    private SigningKeys? keys;

    private sealed record SigningKeys(IReadOnlyList<SecurityKey> Keys, string? Issuer, bool Remote, DateTimeOffset LoadedAt);

    public JwtAuthenticator(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        issuerUri = Setting(configuration, "security:oauth2:issuer-uri");
        jwkSetUri = Setting(configuration, "security:oauth2:jwk-set-uri");
        inlineJwks = Setting(configuration, "security:oauth2:jwks");
    }

    /// <summary>El principal del token, o <see cref="InvalidCredentialException"/> si no vale (401).</summary>
    public async Task<Principal> Authenticate(string token, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);
        if (!TokenFormat().IsMatch(token))
        {
            throw new InvalidCredentialException("El bearer token no tiene la forma de RFC 6750");
        }
        var current = await Resolve(null, cancellationToken);
        if (current.Keys.Count == 0)
        {
            throw new InvalidCredentialException("No hay ninguna clave configurada con la que validar el token");
        }
        var result = await Validate(token, current);
        // Una clave que no se conoce puede ser una rotación del proveedor: se relee el JWKS, como mucho cada 30 s.
        if (!result.IsValid && result.Exception is SecurityTokenInvalidSignatureException && current.Remote && DateTimeOffset.UtcNow - current.LoadedAt > RefreshCooldown)
        {
            current = await Resolve(current, cancellationToken);
            result = await Validate(token, current);
        }
        if (!result.IsValid)
        {
            throw new InvalidCredentialException(result.Exception?.Message ?? "El token no es válido", result.Exception);
        }
        return ToPrincipal((JsonWebToken)result.SecurityToken);
    }

${issuedFor}

    private Task<TokenValidationResult> Validate(string token, SigningKeys current) =>
        handler.ValidateTokenAsync(
            token,
            new TokenValidationParameters
            {
                IssuerSigningKeys = current.Keys,
                ValidateIssuer = current.Issuer is not null,
                ValidIssuer = current.Issuer,
                // La audiencia es AUTORIZACIÓN y la comprueba el middleware solo donde el plan la pide.
                ValidateAudience = false,
                ValidateLifetime = true,
                // Como el JwtTimestampValidator de Spring: exp se comprueba si viene, pero no se exige.
                RequireExpirationTime = false,
                ClockSkew = ClockTolerance
            });

    /// <summary>Las claves vigentes; con <paramref name="stale"/>, las relee si siguen siendo esas.</summary>
    private async Task<SigningKeys> Resolve(SigningKeys? stale, CancellationToken cancellationToken)
    {
        var current = Volatile.Read(ref keys);
        if (current is not null && !ReferenceEquals(current, stale))
        {
            return current;
        }
        var loaded = await Load(cancellationToken);
        Volatile.Write(ref keys, loaded);
        return loaded;
    }

    private async Task<SigningKeys> Load(CancellationToken cancellationToken)
    {
        if (inlineJwks is not null)
        {
            return new SigningKeys([.. new JsonWebKeySet(inlineJwks).GetSigningKeys()], null, false, DateTimeOffset.UtcNow);
        }
        if (jwkSetUri is not null)
        {
            return new SigningKeys(await FetchKeys(new Uri(jwkSetUri), cancellationToken), null, true, DateTimeOffset.UtcNow);
        }
        if (issuerUri is not null)
        {
            var discovery = new Uri($"{issuerUri.TrimEnd('/')}/.well-known/openid-configuration");
            using var response = await Http.GetAsync(discovery, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"El discovery del emisor respondió {(int)response.StatusCode}: {discovery}");
            }
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            if (!document.RootElement.TryGetProperty("jwks_uri", out var jwksUri) || jwksUri.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException($"El discovery del emisor no trae jwks_uri: {discovery}");
            }
            return new SigningKeys(await FetchKeys(new Uri(jwksUri.GetString()!), cancellationToken), issuerUri, true, DateTimeOffset.UtcNow);
        }
        // Sin ninguna fuente (el perfil test sin ${TEST_JWKS_VARIABLE}): ningún token vale.
        return new SigningKeys([], null, false, DateTimeOffset.UtcNow);
    }

    private static async Task<IReadOnlyList<SecurityKey>> FetchKeys(Uri uri, CancellationToken cancellationToken)
    {
        using var response = await Http.GetAsync(uri, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"El JWKS del emisor respondió {(int)response.StatusCode}: {uri}");
        }
        return [.. new JsonWebKeySet(await response.Content.ReadAsStringAsync(cancellationToken)).GetSigningKeys()];
    }

    private static Principal ToPrincipal(JsonWebToken token)
    {
        var claims = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        using (var document = JsonDocument.Parse(Base64UrlEncoder.Decode(token.EncodedPayload)))
        {
            foreach (var claim in document.RootElement.EnumerateObject())
            {
                claims[claim.Name] = claim.Value.Clone();
            }
        }
        var roles = RolesOf(claims);
        var authorities = new HashSet<string>(roles.Select(role => "ROLE_" + role), StringComparer.Ordinal);
        foreach (var scope in ScopesOf(claims))
        {
            authorities.Add("SCOPE_" + scope);
        }
        foreach (var permission in ClaimValues.List(claims, ${csString(claims.permissionsClaim)}).Where(permission => !string.IsNullOrWhiteSpace(permission)))
        {
            authorities.Add(permission);
        }
        foreach (var role in roles)
        {
            if (RoleGrants.TryGetValue(role, out var granted))
            {
                authorities.UnionWith(granted);
            }
        }
        var name = ClaimValues.Text(claims, PrincipalClaim) ?? ClaimValues.Text(claims, "sub") ?? string.Empty;
        return new Principal(PrincipalKind.Token, name, authorities, claims);
    }

    private static List<string> RolesOf(Dictionary<string, JsonElement> claims)
    {
${roles}
    }

    private static IEnumerable<string> ScopesOf(Dictionary<string, JsonElement> claims) =>
        (ClaimValues.Text(claims, "scope") ?? string.Empty)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)${cognito ? `
            // Cognito: <resource-server>/<scope>. Sin prefijo, se queda igual.
            .Select(value => value[(value.IndexOf('/', StringComparison.Ordinal) + 1)..])` : ''};

    private static string? Setting(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    /// <summary>La forma de un bearer token (RFC 6750): Spring rechaza con 401 lo que no la tiene.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9\\-._~+/]+=*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex TokenFormat();
}`;
}

// ─── ApiKeyAuthenticator.cs ─────────────────────────────────────────────────────────────────────

function apiKeyAuthenticatorBody(model) {
  const clients = apiKeyClients(model);
  const single = securityPlan(model).protocol === 'api-key';
  const rows = clients.map(
    (client) =>
      `            new Client(${csString(client.name)}, Key(configuration, ${csString(client.key)}), new HashSet<string>([${client.authorities.map(csString).join(', ')}], StringComparer.Ordinal)),`
  );
  return `/// <summary>
/// Autentica por clave de API: compara la cabecera <c>X-API-Key</c> con ${
    single
      ? 'la clave del servicio (<c>security.api-key</c>). Coincide: el cliente <c>api-key-client</c>, sin authorities'
      : 'la de cada cliente máquina del diseño (<c>security.api-keys.&lt;cliente&gt;</c>). Coincide: ese cliente, con sus scopes como <c>SCOPE_&lt;scope&gt;</c>'
  }.
/// Sin coincidencia, la petición sigue sin autenticar (la rechaza la regla de la ruta si exige credencial). Una clave
/// vacía en la configuración deja a ese cliente deshabilitado.
/// </summary>
public sealed class ApiKeyAuthenticator
{
    public const string Header = "X-API-Key";

    private static readonly Dictionary<string, JsonElement> NoClaims = [];

    private readonly IReadOnlyList<Client> clients;

    private sealed record Client(string Name, byte[] Key, IReadOnlySet<string> Authorities);

    public ApiKeyAuthenticator(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        clients =
        [
${rows.join('\n')}
        ];
    }

    /// <summary>El cliente de la clave, o null si no es la de ninguno.</summary>
    public Principal? Authenticate(string provided)
    {
        ArgumentNullException.ThrowIfNull(provided);
        var offered = Encoding.UTF8.GetBytes(provided);
        foreach (var client in clients)
        {
            // En tiempo constante: la comparación no dice cuántos caracteres acertó quien prueba claves.
            if (client.Key.Length > 0 && client.Key.Length == offered.Length && CryptographicOperations.FixedTimeEquals(client.Key, offered))
            {
                return new Principal(PrincipalKind.Key, client.Name, client.Authorities, NoClaims);
            }
        }
        return null;
    }

    private static byte[] Key(ServiceConfiguration configuration, string key) => Encoding.UTF8.GetBytes(configuration.Get(key) ?? string.Empty);
}`;
}

// ─── CorsPolicy.cs ──────────────────────────────────────────────────────────────────────────────

function corsPolicyBody(model) {
  const cors = model.security.cors;
  const list = (values) => `[${values.map(csString).join(', ')}]`;
  return `/// <summary>Lo que decide la política CORS para una petición.</summary>
public enum CorsOutcome
{
    NotCors,
    Allowed,
    Preflight,
    Rejected
}

/// <summary>
/// La política CORS del diseño (security.cors), con la semántica del DefaultCorsProcessor de Spring que aplica el
/// servidor de keel-spring.
/// </summary>
/// <remarks>
/// Una petición es CORS si trae <c>Origin</c> y no es del mismo origen. Un origen no permitido, o un método o unas
/// cabeceras que la política no admite, se rechaza con 403 «Invalid CORS request», también la petición real y no solo
/// el preflight. El preflight (OPTIONS con <c>Access-Control-Request-Method</c>) se contesta en el middleware con 200,
/// sin llegar a autenticar: no lleva credencial. Los métodos salen de los endpoints del diseño (más OPTIONS); los
/// orígenes, de la configuración (<c>security.cors.allowed-origins</c>, una lista separada por comas, con <c>*</c> como
/// comodín). Sin ninguno, el servicio no acepta peticiones cross-origin.
/// </remarks>
public sealed partial class CorsPolicy
{
    private static readonly string[] AllowedMethods = ${list(cors.methods)};
    private static readonly string[] AllowedHeaders = ${list(cors.allowedHeaders)};
    private static readonly string[] ExposedHeaders = ${list(cors.exposedHeaders)};
    private static readonly bool AllowCredentials = ${cors.allowCredentials};
    private const int MaxAgeSeconds = ${cors.maxAgeSeconds};

    private readonly IReadOnlyList<Regex> origins;

    public CorsPolicy(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        origins =
        [
            .. (configuration.Get("security:cors:allowed-origins") ?? string.Empty)
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(origin => OriginPattern(origin.TrimEnd('/')))
        ];
    }

    /// <summary>Decide y escribe las cabeceras; con Rejected o Preflight la respuesta la da quien llama.</summary>
    public CorsOutcome Apply(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var request = context.Request;
        var headers = context.Response.Headers;
        headers.Vary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
        var origin = Header(request, "Origin");
        if (origin is null || string.Equals(origin, $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase))
        {
            return CorsOutcome.NotCors;
        }
        var requestedMethod = Header(request, "Access-Control-Request-Method");
        var preflight = HttpMethods.IsOptions(request.Method) && requestedMethod is not null;

        if (!origins.Any(pattern => pattern.IsMatch(origin)))
        {
            return CorsOutcome.Rejected;
        }
        var method = (preflight ? requestedMethod! : request.Method).ToUpperInvariant();
        if (!AllowedMethods.Contains(method, StringComparer.Ordinal))
        {
            return CorsOutcome.Rejected;
        }
        var requestedHeaders = preflight
            ? (Header(request, "Access-Control-Request-Headers") ?? string.Empty).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            : [];
        var allowedHeaders = AllowedHeaders.Contains("*", StringComparer.Ordinal)
            ? requestedHeaders
            : [.. requestedHeaders.Where(name => AllowedHeaders.Contains(name, StringComparer.OrdinalIgnoreCase))];
        if (requestedHeaders.Length > 0 && allowedHeaders.Length == 0)
        {
            return CorsOutcome.Rejected;
        }

        headers.AccessControlAllowOrigin = origin;
        if (preflight)
        {
            headers.AccessControlAllowMethods = string.Join(',', AllowedMethods);
            if (allowedHeaders.Length > 0)
            {
                headers.AccessControlAllowHeaders = string.Join(", ", allowedHeaders);
            }
        }
        else if (ExposedHeaders.Length > 0)
        {
            headers.AccessControlExposeHeaders = string.Join(", ", ExposedHeaders);
        }
        if (AllowCredentials)
        {
            headers.AccessControlAllowCredentials = "true";
        }
        if (preflight)
        {
            headers.AccessControlMaxAge = MaxAgeSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        return preflight ? CorsOutcome.Preflight : CorsOutcome.Allowed;
    }

    private static string? Header(HttpRequest request, string name) =>
        request.Headers.TryGetValue(name, out var values) && !string.IsNullOrEmpty(values.FirstOrDefault()) ? values.FirstOrDefault() : null;

    /// <summary>Un patrón de origen de Spring: <c>*</c> es cualquier cosa y <c>:[*]</c> cualquier puerto (o ninguno).</summary>
    private static Regex OriginPattern(string pattern)
    {
        if (pattern == "*")
        {
            return AnyOrigin();
        }
        var source = string.Join(@"(:\\d+)?", pattern.Split(":[*]").Select(part => Regex.Escape(part).Replace(@"\\*", ".*", StringComparison.Ordinal)));
        return new Regex($"^{source}\\\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    [GeneratedRegex("^.*\\\\z", RegexOptions.Singleline)]
    private static partial Regex AnyOrigin();
}`;
}

// ─── CallerIdentity.cs ──────────────────────────────────────────────────────────────────────────

function callerIdentityBody(model) {
  const identity = model.security.callerIdentity;
  const extract =
    identity.source === 'claim'
      ? `        var value = ClaimValues.Text(principal.Claims, ${csString(identity.claim ?? 'sub')});`
      : `        // El cliente máquina de la credencial: Keycloak lo pone en azp y otros proveedores en client_id; con
        // client_credentials, el nombre del principal también es el cliente.
        var value = ClaimValues.Text(principal.Claims, "azp") ?? ClaimValues.Text(principal.Claims, "client_id") ?? principal.Name;`;
  return `/// <summary>
/// De dónde sale, por HTTP, la identidad de QUIÉN pide el trabajo (security.authentication.callerIdentity):
/// ${identity.source === 'claim' ? `el claim <c>${identity.claim ?? 'sub'}</c> del token` : 'el cliente máquina de la credencial'}, que llega al campo <c>${identity.field}</c> del mensaje.
/// </summary>
/// <remarks>
/// Un solo punto de resolución: la operación la recibe ya resuelta y en ningún otro sitio se vuelve a mirar el token. El
/// campo NO se acepta del cuerpo de la petición: quien la hace es justamente quien no debería poder elegir en nombre de
/// quién actúa.
/// </remarks>
public static class CallerIdentity
{
    /// <summary>
    /// El identificador del llamante, ya resuelto. Lanza si no hay: una operación que lo necesita no puede continuar sin
    /// él, y seguir con un valor vacío escribiría datos a nombre de nadie. La regla de acceso ya rechaza al anónimo, así
    /// que llegar aquí sin token es un fallo de configuración.
    /// </summary>
    public static string Resolve()
    {
        var principal = SecurityContext.Get();
        if (principal is not { Kind: PrincipalKind.Token })
        {
            throw new InvalidOperationException(${csString(`No hay credencial en el contexto: '${identity.field}' se resuelve de la identidad del llamante.`)});
        }
${extract}
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException(${csString(`La credencial no identifica ningún recurso para '${identity.field}'.`)});
        }
        return value;
    }
}`;
}

// ─── El alcance por recurso: ICallerScope ───────────────────────────────────────────────────────

function callerScopePortBody(model) {
  const scoping = model.security.scoping;
  const exempt = scoping.exemptRoles.length > 0 ? scoping.exemptRoles.map((role) => `<c>${role}</c>`).join(', ') : 'ninguno';
  const clients = (scoping.exemptClients ?? []).length > 0 ? scoping.exemptClients.map((client) => `<c>${client}</c>`).join(', ') : 'ninguno';
  return `/// <summary>
/// Alcance por recurso del llamante (security.authentication.scoping: claim <c>${scoping.claim}</c> sobre <c>${scoping.over}</c>).
/// </summary>
/// <remarks>
/// Es un puerto para que los handlers no sepan de tokens: lo implementa JwtCallerScope en Infrastructure leyendo el
/// principal de la petición en curso. Solo tiene sentido dentro de una petición HTTP; los listeners y los barridos no lo
/// consultan.
/// </remarks>
public interface ${CALLER_SCOPE_PORT}
{
    /// <summary>El llamante está exento del alcance (roles exentos del diseño: ${exempt}; clientes máquina exentos: ${clients}).</summary>
    bool IsExempt();

    /// <summary>Los valores de <c>${scoping.over}</c> que enumera el claim del llamante (vacío si no trae ninguno).</summary>
    IReadOnlySet<string> ScopedValues();

    /// <summary>¿El valor está en el alcance? Se evalúa contra el valor tal como llega, exista o no.</summary>
    bool Covers(string? value) => IsExempt() || (value is not null && ScopedValues().Contains(value));
}`;
}

function jwtCallerScopeBody(model) {
  const scoping = model.security.scoping;
  const exempt = scoping.exemptRoles;
  const clients = scoping.exemptClients ?? [];
  return `/// <summary>
/// Alcance por recurso leído del token de la petición en curso (security.authentication.scoping): el claim
/// <c>${scoping.claim}</c> como lista o como texto separado por comas o espacios; exentos, los roles del diseño y los clientes
/// máquina de scoping.exemptClients, reconocidos por el cliente de la credencial (<c>azp</c>, <c>client_id</c> o el
/// nombre del principal, el mismo criterio que la identidad del llamante). La exención es solo del alcance: las reglas
/// de acceso ya se aplicaron.
/// </summary>
public sealed class JwtCallerScope : ${CALLER_SCOPE_PORT}
{
    private const string ScopingClaim = ${csString(scoping.claim)};
    private static readonly string[] ExemptAuthorities = [${exempt.map((role) => csString(`ROLE_${role}`)).join(', ')}];
    private static readonly string[] ExemptClients = [${clients.map(csString).join(', ')}];
    private static readonly char[] Separators = [' ', '\\t', '\\n', '\\r', ','];

    public bool IsExempt()
    {
        var principal = SecurityContext.Get();
        if (principal is null)
        {
            return false;
        }
        if (ExemptAuthorities.Any(principal.Authorities.Contains))
        {
            return true;
        }
        var client = NonEmpty(ClaimValues.Text(principal.Claims, "azp")) ?? NonEmpty(ClaimValues.Text(principal.Claims, "client_id")) ?? NonEmpty(principal.Name);
        return client is not null && ExemptClients.Contains(client, StringComparer.Ordinal);
    }

    public IReadOnlySet<string> ScopedValues()
    {
        var principal = SecurityContext.Get();
        if (principal is not { Kind: PrincipalKind.Token } || !principal.Claims.TryGetValue(ScopingClaim, out var claim))
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }
        if (claim.ValueKind == JsonValueKind.Array)
        {
            return new HashSet<string>(ClaimValues.List(claim), StringComparer.Ordinal);
        }
        if (claim.ValueKind == JsonValueKind.String)
        {
            return new HashSet<string>(claim.GetString()!.Split(Separators, StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);
        }
        return new HashSet<string>(StringComparer.Ordinal);
    }

    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}`;
}

// ─── SecurityRegistration.cs ────────────────────────────────────────────────────────────────────

function registration(model) {
  const lines = [];
  if (usesJwt(model)) lines.push('        services.AddSingleton(new JwtAuthenticator(configuration));');
  if (apiKeyClients(model).length > 0) lines.push('        services.AddSingleton(new ApiKeyAuthenticator(configuration));');
  if (model.security?.cors) lines.push('        services.AddSingleton(new CorsPolicy(configuration));');
  const usings = ['Microsoft.Extensions.DependencyInjection', configNamespace(model)];
  if (usesCallerScope(model)) {
    lines.push('        services.AddCallerScope();');
    usings.push(namespaceOf(model, 'appSupport'));
  }
  const body = `/// <summary>
/// La seguridad del servicio en el contenedor: lo que necesita el middleware de la entrada HTTP${usesCallerScope(model) ? ' y el alcance por recurso que reciben los handlers' : ''}.
/// </summary>
public static class SecurityRegistration
{
    public static IServiceCollection AddHttpSecurity(this IServiceCollection services, ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}        return services;
    }${
      usesCallerScope(model)
        ? `

    /// <summary>
    /// El alcance por recurso que reciben los handlers (${CALLER_SCOPE_PORT}). Aparte y sin configuración: lo registra también
    /// la prueba del cableado de los casos de uso, que construye el contenedor sin la entrada HTTP.
    /// </summary>
    public static IServiceCollection AddCallerScope(this IServiceCollection services)
    {
        services.AddSingleton<${CALLER_SCOPE_PORT}, JwtCallerScope>();
        return services;
    }`
        : ''
    }
}`;
  return file(model, 'security', 'SecurityRegistration', body, usings);
}

// ─── HttpSecurityMiddleware.cs ──────────────────────────────────────────────────────────────────

function middleware(model) {
  const plan = securityPlan(model);
  const jwt = usesJwt(model);
  const keys = apiKeyClients(model).length > 0;
  const cors = Boolean(model.security?.cors);
  const audience = jwt ? plan.audience : null;
  const dependencies = ['RequestDelegate next'];
  if (jwt) dependencies.push('JwtAuthenticator tokens');
  if (keys) dependencies.push('ApiKeyAuthenticator keys');
  if (cors) dependencies.push('CorsPolicy cors');
  if (audience) dependencies.push('ServiceConfiguration configuration');
  const usings = ['Microsoft.AspNetCore.Http', securityNamespace(model), wireNamespace(model)];
  if (audience) usings.push(configNamespace(model));
  if (!plan.open) usings.push('Microsoft.AspNetCore.Routing');

  const corsBlock = cors
    ? `        // CORS antes que nada: el preflight no lleva credencial, y un rechazo tiene que salir con sus cabeceras o el
        // navegador no deja leerlo.
        switch (cors.Apply(context))
        {
            case CorsOutcome.Rejected:
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("Invalid CORS request", context.RequestAborted);
                return;
            case CorsOutcome.Preflight:
                context.Response.StatusCode = StatusCodes.Status200OK;
                return;
        }
`
    : '';
  const decision = plan.open
    ? `        // El diseño declara la capa security sin autenticación (protocol: none): todo abierto.
        await next(context);`
    : `        Principal? principal;
        try
        {
            principal = await Authenticate(context);
        }
        catch (InvalidCredentialException)
        {
            await Reject(context, StatusCodes.Status401Unauthorized);
            return;
        }
        // Cualquier otro fallo (el proveedor no responde) sigue hacia ApiErrorMiddleware: 500, nunca un 401 que culpe
        // a la credencial.
        var pattern = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
        var decision = AccessRules.Decide(new AccessTarget(context.Request.Method, context.Request.Path.Value ?? "/", pattern));${
          audience
            ? `
        // La audiencia es AUTORIZACIÓN, no autenticación: un token legítimo emitido para otro servicio está autenticado
        // y no autorizado (403), no es un token inválido (401).
        if (decision.ChecksAudience && principal is { Kind: PrincipalKind.Token } && !JwtAuthenticator.IssuedFor(principal, audience))
        {
            await Reject(context, StatusCodes.Status403Forbidden);
            return;
        }`
            : ''
        }
        switch (AccessRules.Judge(decision.Requirement, principal))
        {
            case AccessVerdict.Unauthenticated:
                await Reject(context, StatusCodes.Status401Unauthorized);
                return;
            case AccessVerdict.Denied:
                await Reject(context, StatusCodes.Status403Forbidden);
                return;
        }
        using (SecurityContext.Open(principal))
        {
            await next(context);
        }`;

  const authenticate = plan.open
    ? ''
    : `

    /// <summary>
    /// Quién llama. Un bearer token${jwt ? ' se valida, y si no vale es un 401 aunque la ruta sea pública (como el resource server de Spring)' : ' no se mira: el protocolo del diseño no es de token'};${
        keys ? ' si no hay, una clave de API que coincida autentica a su cliente;' : ''
      } si no hay nada, la petición es anónima.
    /// </summary>
    private ${jwt ? 'async ' : ''}Task<Principal?> Authenticate(HttpContext context)
    {
${
  jwt
    ? `        var authorization = context.Request.Headers.Authorization.FirstOrDefault();
        if (authorization is not null && authorization.StartsWith("bearer", StringComparison.OrdinalIgnoreCase))
        {
            var token = authorization.Length > 7 && authorization[6] == ' ' ? authorization[7..].Trim() : string.Empty;
            return await tokens.Authenticate(token, context.RequestAborted);
        }
`
    : ''
}${
  keys
    ? `        var key = context.Request.Headers[ApiKeyAuthenticator.Header].FirstOrDefault();
        if (!string.IsNullOrEmpty(key))
        {
            return ${jwt ? 'keys.Authenticate(key)' : 'Task.FromResult(keys.Authenticate(key))'};
        }
`
    : ''
}        return ${jwt ? 'null' : 'Task.FromResult<Principal?>(null)'};
    }

    /// <summary>401 y 403 con el ErrorResponse del contrato y su code del catálogo, como SecurityErrorHandlers de keel-spring.</summary>
    private static Task Reject(HttpContext context, int status)
    {
        var body = status == StatusCodes.Status401Unauthorized
            ? ErrorResponse.Of(${FW.unauthenticated.status}, ${csString(FW.unauthenticated.error)}, ${csString(FRAMEWORK_ERRORS.unauthenticated.code)}, ${csString(FW.unauthenticated.message)})
            : ErrorResponse.Of(${FW.accessDenied.status}, ${csString(FW.accessDenied.error)}, ${csString(FRAMEWORK_ERRORS.accessDenied.code)}, ${csString(FW.accessDenied.message)});
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(body, WireJson.Options, context.RequestAborted);
    }`;

  const audienceField = audience
    ? `
    /// <summary>La audiencia que tienen que traer los tokens de las rutas de máquinas (security.audience).</summary>
    private readonly string audience = configuration.Get("security:audience") is { Length: > 0 } configured ? configured : ${csString(audience)};
`
    : '';
  const fields = [
    jwt ? '    private readonly JwtAuthenticator tokens = tokens;' : null,
    keys ? '    private readonly ApiKeyAuthenticator keys = keys;' : null,
    cors ? '    private readonly CorsPolicy cors = cors;' : null
  ].filter(Boolean);
  const body = `/// <summary>
/// La seguridad de la entrada HTTP: un middleware que va DETRÁS de la correlación y del de errores (un 401 o un 403
/// llevan su correlationId, y un proveedor caído sale como el 500 del contrato) y DELANTE de los endpoints.
/// </summary>
/// <remarks>
/// Es un middleware propio y no la autorización de ASP.NET Core por equivalencia con el servidor de keel-spring: Spring
/// Security decide antes de enrutar, así que sin credencial un camino que no existe responde 401 (no 404) y uno que
/// existe con otro método, también. Deja el principal abierto (SecurityContext) para todo lo que haga la petición: la
/// identidad del llamante y el alcance por recurso lo leen de ahí.
/// </remarks>
public sealed class HttpSecurityMiddleware(${dependencies.join(', ')})
{
${fields.join('\n')}${fields.length > 0 ? '\n' : ''}${audienceField}
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
${corsBlock}${decision}
    }${authenticate}
}`;
  const { namespace, path } = located(model, 'rest', 'HttpSecurityMiddleware');
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Configuración: config/parameters/<perfil>/security.yaml ───────────────────────────────────

/** El issuer del perfil local: el del proveedor de prueba de infra/, el mismo que en keel-spring y keel-nest. */
export function localIssuer(model) {
  if (model.stack?.auth === 'keycloak') return `http://localhost:8180/realms/${model.service.name}`;
  if (model.stack?.auth === 'cognito') return `http://localhost:9229/${model.service.name}`;
  return 'https://tu-issuer';
}

/**
 * Los fragmentos `security.yaml` de cada perfil: las MISMAS claves y variables que keel-nest (y que keel-spring en su
 * forma de Spring), con el gradiente del catálogo neutral. Las dos imágenes del mismo diseño se despliegan igual.
 */
function configFragments(model) {
  const sec = model.security;
  const plan = securityPlan(model);
  return ['local', 'develop', 'production', 'test']
    .map((profile) => {
      const lines = ['security:'];
      if (usesJwt(model)) {
        lines.push('  oauth2:');
        if (profile === 'test') {
          lines.push(
            '    # Perfil test: no hay proveedor de identidad. Las pruebas firman sus tokens con una clave',
            `    # propia y publican su JWKS en ${TEST_JWKS_VARIABLE}; sin ella, ningún token vale.`,
            `    jwks: \${${TEST_JWKS_VARIABLE}:}`
          );
        } else {
          if (profile === 'local') {
            lines.push(
              model.stack?.auth === 'keycloak' || model.stack?.auth === 'cognito'
                ? '    # El proveedor de identidad de prueba de infra/docker-compose.yaml.'
                : '    # TODO (agente): issuer real del resource server según security.keel.yaml.'
            );
          }
          lines.push(`    issuer-uri: ${envFor('OAUTH2_ISSUER_URI', profile, localIssuer(model))}`);
          if (profile === 'develop' || profile === 'production') {
            // El JWKS directo, si se da: gana al discovery del issuer y no comprueba `iss`. Es la salida del emisor
            // PARTIDO de deploy/ (el token lo emite localhost:8180, la app alcanza keycloak:8080). Vacía, manda issuer-uri.
            lines.push(`    jwk-set-uri: \${OAUTH2_JWK_SET_URI:}`);
          }
        }
      }
      if (plan.protocol === 'api-key' && !plan.open) {
        lines.push(
          profile === 'production'
            ? '  # Clave que deben enviar los clientes; obligatoria (sin ella la app no arranca).'
            : '  # Clave que deben enviar los clientes; esta es la de los escenarios de validación.',
          `  api-key: ${envFor('SECURITY_API_KEY', profile)}`
        );
      }
      // Como keel-spring y keel-nest: la variable existe siempre que el diseño valida la audiencia (y en production es
      // obligatoria), aunque hoy ninguna ruta de máquinas la compruebe.
      if (usesJwt(model) && sec.serviceAuth?.validateAudience === true) {
        lines.push('  # Audiencia que tienen que traer los tokens de los clientes máquina.', `  audience: ${envFor('SECURITY_AUDIENCE', profile, audienceOf(model))}`);
      }
      if (plan.serviceApiKeys) {
        lines.push('  # Clave por cliente máquina del diseño (serviceClients); vacía = cliente deshabilitado.', '  api-keys:');
        for (const client of sec.serviceClients) {
          lines.push(`    ${client.name}: ${envRequired(profile, `API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`, localClientApiKey(client.name))}`);
        }
      }
      if (sec.cors) {
        lines.push(
          '  cors:',
          profile === 'local' || profile === 'test'
            ? '    # Orígenes del navegador (CSV); estos son los puertos de dev habituales de una SPA.'
            : '    # Orígenes del navegador (CSV); obligatorio (sin él la app no arranca).',
          `    allowed-origins: ${envFor('SECURITY_CORS_ALLOWED_ORIGINS', profile)}`
        );
      }
      return lines.length > 1 ? { path: `config/parameters/${profile}/security.yaml`, content: `${lines.join('\n')}\n` } : null;
    })
    .filter(Boolean);
}

export { audienceOf };
