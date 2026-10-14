// Las credenciales del arnés de integración: lo que en keel-spring da AbstractFlowIT (`tokenFor`, `serviceCredential`,
// `tokenAs`, `scopedResource`, `tokenWithScope`, `apiKey`) y en keel-nest `flow.ts`, aquí como `Support/Credentials.cs`
// con sus atajos en FlowTest (`TokenFor`, `ServiceCredential`, `TokenAs`, `ScopedResource`, `TokenWithScope`, `ApiKey`
// y `Bearer`).
//
// Los valores salen de `infra/test-credentials.env`, que escribe build junto al script que siembra el proveedor
// (keel-core/gen/identity-provisioning.js): un solo productor, un solo consumidor, ningún literal inventado a los dos
// lados. Una variable de entorno del mismo nombre manda sobre el archivo.
//
// Se emite solo con capa security; y cada función, solo si el diseño la hace posible: sin roles no hay usuarios a los
// que pedir un token, sin `serviceAuth` no hay clientes máquina. Qué credencial satisface la regla de cierre (la del humo)
// lo decide keel-core (`closingCredentialOf`), la misma para los tres generadores.

import { closingCredentialOf, usesTokenProtocol } from 'keel-core/gen/access-plan';
import { tokenUrl, userTestClient, usesPersonaTokens, usesScopedTokens, keycloakAdminCredentials, TEST_USER_PASSWORD } from 'keel-core/gen/identity-realm';
import { csFile, csString } from './render.js';
import { LOCAL_API_KEY, localClientApiKey } from './security.js';

/** ¿Lleva el arnés credenciales? */
export function usesIdentityHarness(model) {
  return Boolean(model.layersPresent?.security && model.security && model.security.protocol !== 'none');
}

const tokens = (model) => usesTokenProtocol(model.security);
const roles = (model) => model.security.roles ?? [];
const machineTokens = (model) => Boolean(model.security.serviceAuth) && model.security.serviceAuth.protocol !== 'api-key';
const machineKeys = (model) => model.security.serviceAuth?.protocol === 'api-key' && (model.security.serviceClients ?? []).length > 0;

/**
 * Las cabeceras de la credencial que satisface la regla de cierre, como expresión C# dentro de un flujo (null si no hay
 * ninguna con la que llamar, `null` literal si el cierre es público).
 */
export function closingCredentialExpression(model) {
  if (!usesIdentityHarness(model)) return null;
  const credential = closingCredentialOf(model);
  if (credential == null) return null;
  switch (credential.kind) {
    case 'open':
      return 'null';
    case 'apiKey':
      return 'new() { ["X-API-Key"] = ApiKey() }';
    case 'role':
      return `Bearer(await TokenFor(${csString(credential.name)}))`;
    default:
      return machineKeys(model)
        ? `new() { ["X-API-Key"] = ServiceCredential(${csString(credential.name)}) }`
        : `Bearer(await ServiceCredential(${csString(credential.name)}))`;
  }
}

/** Los atajos de FlowTest: delegan en Credentials, que es interno al arnés. */
export function flowTestCredentialMembers(model) {
  if (!usesIdentityHarness(model)) return [];
  const members = [];
  if (!tokens(model)) {
    if (model.security.protocol === 'api-key') {
      members.push(`    /// <summary>
    /// La clave de API del perfil local, ya sembrada en config/parameters/local/security.yaml. Uso:
    /// <c>Get(ruta, new() { ["X-API-Key"] = ApiKey() })</c>. Cambiarla solo tiene sentido para ejercitar el 401.
    /// </summary>
    protected static string ApiKey() => Credentials.ApiKey();`);
    }
    if (machineKeys(model)) {
      members.push(`    /// <summary>La clave del cliente máquina declarado en el diseño (security.api-keys.&lt;cliente&gt; del perfil local).</summary>
    protected static string ServiceCredential(string client) => Credentials.ServiceCredential(client);`);
    }
    return members;
  }
  members.push(`    /// <summary>La cabecera <c>Authorization</c> de un token: <c>Get(ruta, Bearer(await TokenFor("rol")))</c>.</summary>
    protected static Dictionary<string, string> Bearer(string token) => new() { ["Authorization"] = "Bearer " + token };`);
  if (roles(model).length > 0) {
    members.push(`    /// <summary>
    /// Bearer token de un usuario con el rol pedido. El realm de prueba siembra DOS por rol, <c>&lt;rol&gt;</c> y
    /// <c>&lt;rol&gt;-2</c>, más uno sin roles (<c>no-role</c>): <c>n = 2</c> es el segundo, para los escenarios de
    /// titularidad. Llámalo en CADA petición y no guardes lo que devuelve: el token dura cinco minutos y se renueva aquí.
    /// </summary>
    protected static Task<string> TokenFor(string role, int n = 1) => Credentials.TokenFor(role, n);`);
  }
  if (machineTokens(model)) {
    members.push(`    /// <summary>
    /// Credencial de máquina (client_credentials) de un cliente de security.serviceClients o de la matriz de prueba
    /// (<c>test-m2m-*</c>). El secreto sale de infra/test-credentials.env. Llámalo en cada petición.
    /// </summary>
    protected static Task<string> ServiceCredential(string client) => Credentials.ServiceCredential(client);`);
  }
  if (usesPersonaTokens(model)) {
    members.push(`    /// <summary>
    /// Token de una PERSONA del documento de escenarios: el usuario cuyo claim <c>sub</c> es exactamente
    /// <paramref name="sub"/>, con los claims de <paramref name="claims"/> (un valor null QUITA ese claim). Existe porque
    /// el diseño identifica al llamante por <c>sub</c> y <see cref="TokenFor"/> no puede elegirlo. Llámalo en cada petición.
    /// </summary>
    protected static Task<string> TokenAs(string sub, IReadOnlyDictionary<string, string?>? claims = null, string? role = null) =>
        Credentials.TokenAs(sub, claims ?? new Dictionary<string, string?>(), role);`);
  }
  if (model.security.scoping) {
    members.push(`    /// <summary>
    /// El recurso al que alcanzan los usuarios de prueba NO exentos del alcance por recurso (el claim
    /// <c>${model.security.scoping.claim}</c> de su token). No lo escribas a mano en un escenario: sale de infra/test-credentials.env.
    /// </summary>
    protected static string ScopedResource() => Credentials.ScopedResource();`);
  }
  if (usesScopedTokens(model)) {
    members.push(`    /// <summary>
    /// Token de un usuario del rol cuyo claim <c>${model.security.scoping.claim}</c> enumera EXACTAMENTE <paramref name="values"/>; sin
    /// valores, el usuario del rol SIN el claim. Es lo que necesita «un titular con otro alcance». Llámalo en cada petición.
    /// </summary>
    protected static Task<string> TokenWithScope(string role, params string[] values) => Credentials.TokenWithScope(role, values);`);
  }
  return members;
}

/** `Support/Credentials.cs`, o null sin capa security. */
export function credentialsCs(model, namespace) {
  if (!usesIdentityHarness(model)) return null;
  const parts = [reader()];
  if (!tokens(model)) parts.push(apiKeySection(model));
  else {
    parts.push(tokenCache(model));
    if (roles(model).length > 0) parts.push(tokenForSection(model));
    if (machineTokens(model)) parts.push(serviceCredentialSection());
    if (model.security.scoping) parts.push(scopedResourceSection(model));
    if (usesPersonaTokens(model)) parts.push(personaSection(model));
    if (usesScopedTokens(model)) parts.push(scopedTokenSection(model));
    if (usesPersonaTokens(model) || usesScopedTokens(model)) parts.push(adminSection(model));
  }
  const usings = ['System.Collections.Concurrent', 'System.Globalization', 'System.Text', 'System.Text.Json', 'System.Text.Json.Nodes'];
  return csFile({
    namespace,
    usings,
    body: `/// <summary>
/// Las credenciales del proveedor de identidad de prueba para los flujos. Por orden: variable de entorno →
/// <c>infra/test-credentials.env</c> (lo escribe build junto al script que siembra el proveedor: los nombres de cliente y
/// los secretos tienen un ÚNICO productor) → valor convencional. Lo generó keel-dotnet build: no se edita.
/// </summary>
internal static class Credentials
{
${parts.join('\n\n')}
}`
  });
}

function reader() {
  return `    private static readonly Lazy<Dictionary<string, string>> Provisioned = new(LoadProvisioned);

    /// <summary>Un valor de credencial: el entorno, después infra/test-credentials.env, después el convencional.</summary>
    public static string Value(string name, string fallback)
    {
        var fromEnvironment = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(fromEnvironment)) return fromEnvironment;
        return Provisioned.Value.TryGetValue(name, out var provisioned) ? provisioned : fallback;
    }

    private static Dictionary<string, string> LoadProvisioned()
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var file = Path.Combine(Harness.Root, "infra", "test-credentials.env");
        if (!File.Exists(file)) return values;
        foreach (var line in File.ReadAllLines(file))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
            var separator = trimmed.IndexOf('=', StringComparison.Ordinal);
            if (separator > 0) values[trimmed[..separator].Trim()] = trimmed[(separator + 1)..].Trim();
        }
        return values;
    }`;
}

function apiKeySection(model) {
  const sec = model.security;
  const lines = [];
  if (sec.protocol === 'api-key') {
    lines.push(`    /// <summary>La clave de API del perfil local (config/parameters/local/security.yaml).</summary>
    public static string ApiKey() => ${csString(LOCAL_API_KEY)};`);
  }
  if (machineKeys(model)) {
    const rows = sec.serviceClients.map((client) => `        [${csString(client.name)}] = ${csString(localClientApiKey(client.name))},`);
    lines.push(`    private static readonly Dictionary<string, string> ServiceKeys = new(StringComparer.Ordinal)
    {
${rows.join('\n')}
    };

    /// <summary>La clave del cliente máquina declarado en el diseño (security.api-keys.&lt;cliente&gt; del perfil local).</summary>
    public static string ServiceCredential(string client) =>
        ServiceKeys.TryGetValue(client, out var key) ? key : throw new InvalidOperationException($"Cliente de servicio no declarado en el diseño: {client}");`);
  }
  return lines.join('\n\n');
}

function tokenCache(model) {
  return `    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    /// <summary>Margen con el que se renueva un token antes de su <c>exp</c>.</summary>
    private static readonly TimeSpan RenewalMargin = TimeSpan.FromSeconds(30);

    private static readonly ConcurrentDictionary<string, string> Tokens = new(StringComparer.Ordinal);

    /// <summary>
    /// El token guardado con esa clave, pedido de nuevo si le queda poca vida. El realm de prueba emite tokens de CINCO
    /// minutos: un flujo con esperas reales se pasa de ahí, y un token guardado en una variable empieza a dar 401 a mitad
    /// del flujo, con un síntoma que no se parece a su causa.
    /// </summary>
    private static async Task<string> Cached(string key, Func<Task<string>> mint)
    {
        if (Tokens.TryGetValue(key, out var cached) && !ExpiresWithin(cached, RenewalMargin)) return cached;
        var fresh = await mint();
        Tokens[key] = fresh;
        return fresh;
    }

    /// <summary>¿Le queda a este token menos de <paramref name="margin"/>? Uno cuyo <c>exp</c> no se lee se da por caducado.</summary>
    private static bool ExpiresWithin(string token, TimeSpan margin)
    {
        try
        {
            var payload = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
            using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
            return !document.RootElement.TryGetProperty("exp", out var exp)
                || DateTimeOffset.UtcNow + margin >= DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64());
        }
        catch (Exception error) when (error is FormatException or JsonException or IndexOutOfRangeException or InvalidOperationException)
        {
            return true;
        }
    }

    /// <summary>Pide un token al endpoint del proveedor (AUTH_TOKEN_URL) con el formulario dado.</summary>
    private static async Task<string> RequestToken(Dictionary<string, string> form)
    {
        using var content = new FormUrlEncodedContent(form);
        using var response = await Http.PostAsync(new Uri(Value("AUTH_TOKEN_URL", ${csString(tokenUrl(model))})), content);
        var text = await response.Content.ReadAsStringAsync();
        if ((int)response.StatusCode != 200) throw new InvalidOperationException($"El proveedor de identidad devolvió {(int)response.StatusCode}: {text}");
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty("access_token", out var token) && token.ValueKind == JsonValueKind.String
            ? token.GetString()!
            : throw new InvalidOperationException($"El proveedor de identidad no devolvió access_token: {text}");
    }

    /// <summary>El password grant del cliente de prueba para un usuario del realm.</summary>
    private static Task<string> PasswordGrant(string username) =>
        RequestToken(new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["client_id"] = Value("AUTH_TEST_CLIENT", ${csString(userTestClient(model))}),
            ["username"] = username,
            ["password"] = Value("AUTH_TEST_PASSWORD", ${csString(TEST_USER_PASSWORD)})
        });`;
}

function tokenForSection() {
  return `    public static Task<string> TokenFor(string role, int n)
    {
        var username = n <= 1 ? role : $"{role}-{n}";
        return Cached($"user:{username}", () => PasswordGrant(username));
    }`;
}

function serviceCredentialSection() {
  return `    public static Task<string> ServiceCredential(string client)
    {
        var specific = Value("AUTH_CLIENT_SECRET_" + new string([.. client.ToUpperInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '_')]), string.Empty);
        var secret = specific.Length > 0 ? specific : Value("AUTH_CLIENT_SECRET", $"{client}-secret");
        return Cached(
            $"client:{client}",
            () => RequestToken(new Dictionary<string, string> { ["grant_type"] = "client_credentials", ["client_id"] = client, ["client_secret"] = secret }));
    }`;
}

function scopedResourceSection(model) {
  return `    public static string ScopedResource() => Value("AUTH_SCOPED_RESOURCE", ${csString(model.security.scoping.testResource)});`;
}

function personaSection(model) {
  return `    private static readonly Dictionary<string, string> PersonaApplied = new(StringComparer.Ordinal);
    private static readonly HashSet<string> PersonaMappers = new(StringComparer.Ordinal);
    private static bool personaRealmReady;

    public static Task<string> TokenAs(string sub, IReadOnlyDictionary<string, string?> claims, string? role)
    {
        if (claims.ContainsKey("sub")) throw new ArgumentException("El sub de la persona va en el primer argumento, no entre los claims", nameof(claims));
        var wanted = claims.Where(claim => claim.Value is not null).OrderBy(claim => claim.Key, StringComparer.Ordinal).ToDictionary(claim => claim.Key, claim => claim.Value!, StringComparer.Ordinal);
        // Los claims QUITADOS también entran en la clave: «sin email» es otro token que «con email».
        var key = $"persona|{sub}|{role}|{JsonSerializer.Serialize(wanted)}|{string.Join(',', claims.Keys.OrderBy(name => name, StringComparer.Ordinal))}";
        return Cached(key, async () =>
        {
            await EnsurePersona(sub, role, wanted, [.. claims.Keys]);
            return await PasswordGrant(sub);
        });
    }

    /// <summary>
    /// Deja a la persona como la pide el escenario, por la API de administración del realm. Tres cosas que no son
    /// evidentes y costaron una pasada cada una en keel-spring: el alta va por <c>partialImport</c> (Keycloak 26 ignora
    /// el id de <c>POST /users</c>, y el <c>sub</c> es el id), los claims salen de atributos propios (<c>kp_&lt;claim&gt;</c>)
    /// con un mapper por claim, y el User Profile deja de exigir email y nombre.
    /// </summary>
    private static async Task EnsurePersona(string sub, string? role, Dictionary<string, string> claims, IReadOnlyList<string> named)
    {
        var admin = await AdminToken();
        if (!personaRealmReady)
        {
            await PreparePersonaRealm(admin);
            personaRealmReady = true;
        }
        foreach (var claim in named)
        {
            if (PersonaMappers.Contains(claim)) continue;
            await EnsurePersonaMapper(admin, claim);
            PersonaMappers.Add(claim);
        }
        var applied = $"{role}|{JsonSerializer.Serialize(claims)}";
        if (PersonaApplied.TryGetValue(sub, out var previous) && previous == applied) return;
        var attributes = new JsonObject();
        foreach (var (name, value) in claims) attributes[$"kp_{name}"] = new JsonArray(value);
        var user = new JsonObject
        {
            ["username"] = sub,
            ["enabled"] = true,
            ["emailVerified"] = true,
            ["requiredActions"] = new JsonArray(),
            ["attributes"] = attributes
        };
        var id = await UserId(admin, sub);
        if (id is not null && id != sub)
        {
            // Resto de otra ejecución creado con id aleatorio: con él el sub no sería el pedido.
            await Admin(admin, HttpMethod.Delete, $"/users/{id}");
            id = null;
        }
        if (id is null)
        {
            var created = (JsonObject)user.DeepClone();
            created["id"] = sub;
            created["credentials"] = new JsonArray(new JsonObject { ["type"] = "password", ["value"] = Value("AUTH_TEST_PASSWORD", ${csString(TEST_USER_PASSWORD)}), ["temporary"] = false });
            await Admin(admin, HttpMethod.Post, "/partialImport", new JsonObject { ["ifResourceExists"] = "SKIP", ["users"] = new JsonArray(created) });
            id = await UserId(admin, sub);
            if (id != sub) throw new InvalidOperationException($"Keycloak no respetó el id pedido para la persona {sub} (asignó {id}): el claim sub del token no sería el del escenario");
            if (role is not null)
            {
                var realmRole = await Admin(admin, HttpMethod.Get, $"/roles/{Uri.EscapeDataString(role)}");
                await Admin(admin, HttpMethod.Post, $"/users/{id}/role-mappings/realm", new JsonArray(realmRole?.DeepClone()));
            }
        }
        else
        {
            await Admin(admin, HttpMethod.Put, $"/users/{id}", user);
        }
        PersonaApplied[sub] = applied;
    }

    /// <summary>User Profile del realm: email y nombre opcionales, y atributos no declarados admitidos.</summary>
    private static async Task PreparePersonaRealm(string admin)
    {
        var profile = (await Admin(admin, HttpMethod.Get, "/users/profile"))!.AsObject();
        foreach (var attribute in profile["attributes"]?.AsArray() ?? new JsonArray())
        {
            if (attribute is JsonObject entry && entry["name"]?.GetValue<string>() is "email" or "firstName" or "lastName") entry.Remove("required");
        }
        profile["unmanagedAttributePolicy"] = "ENABLED";
        await Admin(admin, HttpMethod.Put, "/users/profile", profile);
    }

    /// <summary>Un mapper por claim en el cliente de prueba: el claim sale del atributo kp_&lt;claim&gt;.</summary>
    private static async Task EnsurePersonaMapper(string admin, string claim)
    {
        var clientId = Value("AUTH_TEST_CLIENT", ${csString(userTestClient(model))});
        var clients = (await Admin(admin, HttpMethod.Get, $"/clients?clientId={Uri.EscapeDataString(clientId)}"))!.AsArray();
        if (clients.Count == 0) throw new InvalidOperationException($"No existe el cliente de prueba '{clientId}': ¿se ejecutó infra/init-keycloak.sh?");
        var route = $"/clients/{clients[0]!["id"]!.GetValue<string>()}/protocol-mappers/models";
        var existing = (await Admin(admin, HttpMethod.Get, route))!.AsArray();
        if (existing.Any(mapper => mapper?["name"]?.GetValue<string>() == $"persona-{claim}")) return;
        await Admin(admin, HttpMethod.Post, route, new JsonObject
        {
            ["name"] = $"persona-{claim}",
            ["protocol"] = "openid-connect",
            ["protocolMapper"] = "oidc-usermodel-attribute-mapper",
            ["config"] = new JsonObject
            {
                ["user.attribute"] = $"kp_{claim}",
                ["claim.name"] = claim,
                ["jsonType.label"] = "String",
                ["access.token.claim"] = "true",
                ["id.token.claim"] = "true",
                ["userinfo.token.claim"] = "true"
            }
        });
    }`;
}

function scopedTokenSection(model) {
  const { claim } = model.security.scoping;
  return `    private static readonly HashSet<string> ScopedUsers = new(StringComparer.Ordinal);

    /// <summary>
    /// Da de alta (una vez por rol y valores) un usuario <c>scoped-&lt;rol&gt;-&lt;huella&gt;</c> con el rol y el atributo
    /// <c>${claim}</c>, que el mapper sembrado por infra/init-keycloak.sh proyecta al claim. El nombre es el MISMO que en
    /// keel-spring y keel-nest (la huella es el String.hashCode de Java), así que la siguiente ejecución lo reutiliza.
    /// </summary>
    public static Task<string> TokenWithScope(string role, IReadOnlyList<string> values)
    {
        var wanted = values.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
        var username = $"scoped-{role}-{JavaStringHash(string.Join('\\n', wanted))}";
        return Cached($"scope:{username}", async () =>
        {
            await EnsureScopedUser(username, role, wanted);
            return await PasswordGrant(username);
        });
    }

    /// <summary>El <c>Integer.toHexString(String.hashCode())</c> de Java: el mismo usuario para los servidores del diseño.</summary>
    private static string JavaStringHash(string text)
    {
        var hash = 0;
        foreach (var character in text) hash = unchecked((31 * hash) + character);
        return ((uint)hash).ToString("x", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Deja al usuario del alcance como lo pide el escenario; si ya existe, no se toca. Se comprueba lo que falla en
    /// silencio: que el atributo quedara guardado (el User Profile descarta lo que no conoce, y el token saldría sin claim).
    /// </summary>
    private static async Task EnsureScopedUser(string username, string role, IReadOnlyList<string> values)
    {
        if (ScopedUsers.Contains(username)) return;
        var admin = await AdminToken();
        var id = await UserId(admin, username);
        if (id is null)
        {
            var user = new JsonObject
            {
                ["username"] = username,
                ["enabled"] = true,
                ["email"] = $"{username}@example.com",
                ["emailVerified"] = true,
                ["firstName"] = "Test",
                ["lastName"] = "Scoped",
                ["requiredActions"] = new JsonArray(),
                ["credentials"] = new JsonArray(new JsonObject { ["type"] = "password", ["value"] = Value("AUTH_TEST_PASSWORD", ${csString(TEST_USER_PASSWORD)}), ["temporary"] = false })
            };
            if (values.Count > 0) user["attributes"] = new JsonObject { [${csString(claim)}] = new JsonArray([.. values.Select(value => (JsonNode?)value)]) };
            await Admin(admin, HttpMethod.Post, "/users", user);
            id = await UserId(admin, username) ?? throw new InvalidOperationException($"Keycloak no dio de alta al usuario del alcance {username}");
            var realmRole = await Admin(admin, HttpMethod.Get, $"/roles/{Uri.EscapeDataString(role)}");
            await Admin(admin, HttpMethod.Post, $"/users/{id}/role-mappings/realm", new JsonArray(realmRole?.DeepClone()));
        }
        var stored = (await Admin(admin, HttpMethod.Get, $"/users/{id}"))?["attributes"]?[${csString(claim)}]?.AsArray()
            .Select(value => value!.GetValue<string>()).Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList() ?? [];
        if (!stored.SequenceEqual(values.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal)))
        {
            throw new InvalidOperationException(
                $"El usuario del alcance {username} tiene ${claim}=[{string.Join(", ", stored)}] y el escenario pidió [{string.Join(", ", values)}]: ¿se ejecutó infra/init-keycloak.sh (User Profile)?");
        }
        ScopedUsers.Add(username);
    }`;
}

function adminSection(model) {
  const admin = keycloakAdminCredentials();
  return `    /// <summary>El id del usuario con ese username (Keycloak lo guarda en minúsculas), o null.</summary>
    private static async Task<string?> UserId(string admin, string username)
    {
        var users = (await Admin(admin, HttpMethod.Get, $"/users?exact=true&username={Uri.EscapeDataString(username)}"))!.AsArray();
        return users.FirstOrDefault(user => string.Equals(user?["username"]?.GetValue<string>(), username, StringComparison.OrdinalIgnoreCase))?["id"]?.GetValue<string>();
    }

    /// <summary>Token de administración del realm master, con las credenciales de test-credentials.env.</summary>
    private static async Task<string> AdminToken()
    {
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["client_id"] = "admin-cli",
            ["username"] = Value("AUTH_ADMIN_USER", ${csString(admin.user)}),
            ["password"] = Value("AUTH_ADMIN_PASSWORD", ${csString(admin.password)})
        });
        using var response = await Http.PostAsync(new Uri($"{KeycloakBase()}/realms/master/protocol/openid-connect/token"), content);
        var text = await response.Content.ReadAsStringAsync();
        if ((int)response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Keycloak no dio token de administración ({(int)response.StatusCode}): revisa AUTH_ADMIN_USER/AUTH_ADMIN_PASSWORD en infra/test-credentials.env. {text}");
        }
        return JsonNode.Parse(text)!["access_token"]!.GetValue<string>();
    }

    private static async Task<JsonNode?> Admin(string admin, HttpMethod method, string route, JsonNode? body = null)
    {
        using var request = new HttpRequestMessage(method, new Uri($"{KeycloakBase()}/admin/realms/{RealmName()}{route}"));
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + admin);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await Http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if ((int)response.StatusCode is < 200 or >= 300) throw new InvalidOperationException($"Keycloak admin {method} {route} devolvió {(int)response.StatusCode}: {text}");
        return text.Length == 0 ? null : JsonNode.Parse(text);
    }

    /// <summary>La base del servidor, sacada de AUTH_TOKEN_URL: una sola fuente del servidor y del realm.</summary>
    private static string KeycloakBase()
    {
        var url = Value("AUTH_TOKEN_URL", ${csString(tokenUrl(model))});
        return url[..url.IndexOf("/realms/", StringComparison.Ordinal)];
    }

    private static string RealmName()
    {
        var url = Value("AUTH_TOKEN_URL", ${csString(tokenUrl(model))});
        var start = url.IndexOf("/realms/", StringComparison.Ordinal) + "/realms/".Length;
        return url[start..url.IndexOf('/', start)];
    }`;
}

/** SMOKE-5: el proveedor de identidad emite las credenciales con las que van a llamar los flujos. */
export function smokeCredentialsCase(model) {
  if (!usesIdentityHarness(model) || !tokens(model)) return null;
  const checks = [];
  const role = roles(model)[0];
  const client = model.security.serviceClients?.[0]?.name;
  if (role) checks.push(`        Assert.False(string.IsNullOrEmpty(await TokenFor(${csString(role)})), ${csString(`el proveedor no devolvió token para el rol '${role}'`)});`);
  if (client && machineTokens(model)) {
    checks.push(`        Assert.False(string.IsNullOrEmpty(await ServiceCredential(${csString(client)})), ${csString(`no hay credencial de máquina para '${client}': revisa infra/test-credentials.env`)});`);
  }
  if (checks.length === 0) return null;
  return `    [Scenario("SMOKE-5: el proveedor de identidad emite credenciales")]
    public async Task ElProveedorDeIdentidadEmiteCredenciales()
    {
        // Sin ellas, cada flujo autenticado fallaría con un 401 que parece de negocio. ¿Se ejecutó infra/init-keycloak.sh?
${checks.join('\n')}
    }`;
}
