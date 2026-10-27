// La credencial de las pruebas que build deja escritas (`tests/<Servicio>.UnitTests`, perfil `test`), cuando el diseño
// protege la API: sin ella, cada petición de esas pruebas sería un 401 y medirían la autorización en vez de lo que dicen
// medir (el contrato del cable, la lectura de peticiones, los errores).
//
// Con un token, la prueba genera su par de claves RSA, publica el JWKS en SECURITY_TEST_JWKS (lo lee el perfil test:
// `security.oauth2.jwks`) y firma ella misma: la validación que se ejercita es la real, sin red ni proveedor. Sin variable
// publicada, el perfil test no acepta ningún token, así que no hay ninguna clave en el repositorio que un despliegue con
// el perfil equivocado aceptara. La misma decisión que keel-nest; los claims de acceso total son los de keel-core.

import { fullAccessClaims } from '@keel-system/keel-core/gen/access-plan';
import { csFile, csString, solution } from './render.js';
import { securityPlan, usesJwt, TEST_JWKS_VARIABLE, LOCAL_API_KEY, localClientApiKey } from './security.js';

/** ¿Necesitan credencial las pruebas del perfil test? Sí si alguna regla exige algo. */
export function usesTestCredential(model) {
  const plan = securityPlan(model);
  return Boolean(plan && !plan.open);
}

export function generate(model) {
  if (!usesTestCredential(model)) return [];
  const sln = solution(model);
  return [{ path: `${sln.unitTests.dir}/TestCredential.cs`, content: usesJwt(model) ? tokenCredential(model) : keyCredential(model) }];
}

/** Un literal C# raw (`"""…"""`) con el JSON de los claims: se lee igual que en el diseño. */
function rawJson(value) {
  return `"""${JSON.stringify(value)}"""`;
}

function tokenCredential(model) {
  const sln = solution(model);
  const body = `/// <summary>
/// La credencial de las pruebas del perfil test: un par de claves RSA propio, su JWKS publicado al perfil en
/// ${TEST_JWKS_VARIABLE} (lo hace InMemoryServer) y tokens firmados aquí. La validación que se ejercita es la del servidor,
/// sin red. Lo generó keel-dotnet build: no se edita.
/// </summary>
public static class TestCredential
{
    public const string KeyId = "keel-test";

    /// <summary>Lo que satisface toda regla de acceso del diseño: sus roles, permisos y scopes, y la audiencia.</summary>
    public const string FullAccess = ${rawJson(fullAccessClaims(model, securityPlan(model)))};

    private static readonly RSA Key = RSA.Create(2048);

    private static readonly SigningCredentials Signing = new(new RsaSecurityKey(Key) { KeyId = KeyId }, SecurityAlgorithms.RsaSha256);

    /// <summary>El JWKS con la clave pública: lo que el perfil test acepta.</summary>
    public static string Jwks { get; } = JwksOf(Key);

    /// <summary>La cabecera con la que una petición pasa toda regla de acceso.</summary>
    public static (string Name, string Value) Header => ("Authorization", "Bearer " + TokenWith(FullAccess));

    /// <summary>Un token con esos claims (JSON), firmado con la clave de la prueba; caduca a los 5 minutos o cuando se diga.</summary>
    public static string TokenWith(string claims, DateTimeOffset? expiresAt = null) => Sign(claims, expiresAt, Signing);

    /// <summary>Un token con esos claims firmado con OTRA clave y el mismo kid: el que la validación tiene que rechazar.</summary>
    public static string ForgedWith(string claims)
    {
        using var stranger = RSA.Create(2048);
        return Sign(claims, null, new SigningCredentials(new RsaSecurityKey(stranger) { KeyId = KeyId }, SecurityAlgorithms.RsaSha256));
    }

    private static string Sign(string claims, DateTimeOffset? expiresAt, SigningCredentials credentials)
    {
        var payload = JsonNode.Parse(claims)!.AsObject();
        var now = DateTimeOffset.UtcNow;
        payload["iat"] = now.ToUnixTimeSeconds();
        payload["exp"] = (expiresAt ?? now.AddMinutes(5)).ToUnixTimeSeconds();
        return new JsonWebTokenHandler().CreateToken(payload.ToJsonString(), credentials);
    }

    private static string JwksOf(RSA key)
    {
        var parameters = key.ExportParameters(includePrivateParameters: false);
        var jwk = new JsonObject
        {
            ["kty"] = "RSA",
            ["kid"] = KeyId,
            ["alg"] = "RS256",
            ["use"] = "sig",
            ["n"] = Base64UrlEncoder.Encode(parameters.Modulus),
            ["e"] = Base64UrlEncoder.Encode(parameters.Exponent)
        };
        return new JsonObject { ["keys"] = new JsonArray(jwk) }.ToJsonString();
    }
}`;
  return csFile({
    namespace: sln.unitTests.name,
    usings: ['System.Security.Cryptography', 'System.Text.Json.Nodes', 'Microsoft.IdentityModel.JsonWebTokens', 'Microsoft.IdentityModel.Tokens'],
    body
  });
}

function keyCredential(model) {
  const sln = solution(model);
  const plan = securityPlan(model);
  const key = plan.protocol === 'api-key' ? LOCAL_API_KEY : localClientApiKey(model.security.serviceClients[0].name);
  const body = `/// <summary>
/// La credencial de las pruebas del perfil test: la clave de API que siembra su configuración. Lo generó keel-dotnet
/// build: no se edita.
/// </summary>
public static class TestCredential
{
    /// <summary>La cabecera con la que una petición pasa toda regla de acceso.</summary>
    public static (string Name, string Value) Header => ("X-API-Key", ${csString(key)});
}`;
  return csFile({ namespace: sln.unitTests.name, body });
}
