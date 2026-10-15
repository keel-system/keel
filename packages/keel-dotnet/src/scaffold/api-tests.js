// La prueba emitida de la API: `ApiTests.cs`. Arranca el servidor REAL en memoria (el mismo Program.cs) y le
// pide lo que el contrato fija sin depender de la lógica que escribe el agente, igual que la de keel-nest:
//   · una operación llega a su handler (sin afirmar qué responde: eso lo decide el agente);
//   · un cuerpo que no es JSON, un cuerpo que incumple lo declarado, un uuid de ruta mal formado;
//   · una ruta que no existe (404) y una que existe con otro método (405);
//   · la correlación: la recibida vuelve en la respuesta y en el cuerpo de error; una inválida se sustituye.
// Las peticiones las elige del DISEÑO keel-core/gen/api-cases.js, la misma elección que en keel-nest: si un caso
// no tiene operación que lo ejercite, no se emite.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { FRAMEWORK_RESPONSES as FW, missingParameterMessage, missingPartMessage } from 'keel-core/gen/api-errors';
import { declaredErrorFor } from 'keel-core/gen/declared-errors';
import { apiCases as neutralApiCases, securityCases as neutralSecurityCases } from 'keel-core/gen/api-cases';
import { csFile, csString, solution } from './render.js';
import { messageComponents } from './services.js';
import { usesApi } from './rest-support.js';
import { servedOperation } from './endpoints.js';
import { securityPlan, usesJwt } from './security.js';
import { usesTestCredential } from './test-credential.js';

export function generate(model) {
  if (!usesApi(model)) return [];
  return [{ path: `${solution(model).unitTests.dir}/ApiTests.cs`, content: apiTestsCs(model) }];
}

/** Los casos que el diseño permite ejercitar, sobre las operaciones que keel-dotnet sirve (las de keel-nest). */
export function apiCases(model) {
  const served = {
    ...model,
    services: (model.services ?? []).map((service) => ({ ...service, operations: (service.operations ?? []).filter((op) => !op.route || servedOperation(op)) }))
  };
  return neutralApiCases(served, { components: (operation) => messageComponents(operation, model) });
}

/** La llamada a Send para un caso. */
function send(entry, json = null) {
  return `await Send(${csString(entry.method)}, ${csString(entry.url)}${json != null ? `, json: ${csString(json)}` : ''})`;
}

/** Los argumentos de ExpectError para un fallo del framework. */
function expected(key, code = null) {
  return `${FW[key].status}, ${csString(FW[key].error)}, ${code ? csString(code) : 'null'}, ${csString(FW[key].message)}`;
}

function apiTestsCs(model) {
  const cases = apiCases(model);
  const validation = FRAMEWORK_ERRORS.validation.code;
  const credential = usesTestCredential(model);
  const tests = [];
  if (cases.reachesHandler) {
    // No afirma QUÉ responde el handler, solo que la ruta llega a él: así sigue en verde cuando el agente lo
    // implementa (sin persistencia, un handler con su TODO sale como 500).
    tests.push(`    [Fact]
    public async Task UnaOperacionLlegaASuHandlerNiElDe404NiElDe405()
    {
        using var response = ${send(cases.reachesHandler)};
        Assert.NotEqual(405, (int)response.StatusCode);
        if ((int)response.StatusCode >= 400)
        {
            var body = await Body(response);
            Assert.Equal(ErrorShape, body.EnumerateObject().Select(property => property.Name).ToArray());
            Assert.NotEqual(${csString(FW.notFound.message)}, body.GetProperty("message").GetString());
        }
    }`);
  }
  if (cases.malformedBody) {
    tests.push(`    [Fact]
    public async Task UnCuerpoQueNoEsJsonEs400PeticionMalformadaSinDetails()
    {
        using var response = ${send(cases.malformedBody, '{"roto":')};
        var body = await ExpectError(response, ${expected('malformed', validation)});
        Assert.Equal(JsonValueKind.Null, body.GetProperty("details").ValueKind);
    }`);
  }
  if (cases.invalidBody) {
    // Un campo `notBlank` va EN BLANCO, no ausente: ausente lo rechaza también la rama del null, y la prueba no
    // distinguiría una regla que deja pasar los espacios (lo falsa `cs-check --sabotage=not-blank`).
    const payload = cases.invalidBody.message === 'must not be blank' ? JSON.stringify({ [cases.invalidBody.field]: '  ' }) : '{}';
    tests.push(`    [Fact]
    public async Task UnCuerpoQueIncumpleLoDeclaradoEs400ValidationErrorConElCampoEnDetails()
    {
        using var response = ${send(cases.invalidBody, payload)};
        var body = await ExpectError(response, ${expected('invalidBody', validation)});
        Assert.Contains(${csString(`${cases.invalidBody.field} ${cases.invalidBody.message}`)}, body.GetProperty("details").EnumerateArray().Select(detail => detail.GetString()));
    }`);
  }
  if (cases.malformedPath) {
    tests.push(`    [Fact]
    public async Task UnUuidDeRutaMalFormadoEs400PeticionMalformada()
    {
        using var response = ${send(cases.malformedPath, '{}')};
        await ExpectError(response, ${expected('malformed', validation)});
    }`);
  }
  if (cases.wrongMethod) {
    tests.push(`    [Fact]
    public async Task UnCaminoQueExisteConOtroMetodoEs405()
    {
        using var response = ${send(cases.wrongMethod)};
        await ExpectError(response, ${expected('methodNotAllowed')});
    }`);
  }
  if (cases.upload) tests.push(...uploadTests(model, cases.upload));
  const notFound = `${model.api.routeBase}/keel-ruta-que-no-existe`;
  const body = `/// <summary>
/// El contrato HTTP del servidor arrancado en memoria: lo que fija el diseño sin depender de la lógica del agente.
/// Las peticiones salen del diseño (keel-core/gen/api-cases.js), las mismas que pide la prueba de keel-nest.
/// </summary>
public sealed class ApiTests(InMemoryServer server) : IClassFixture<InMemoryServer>
{
    /// <summary>El orden de las claves de ErrorResponse: el del cable (keel-core, WIRE_SHAPES.errorResponse).</summary>
    private static readonly string[] ErrorShape = [${WIRE_SHAPES.errorResponse.map(csString).join(', ')}];

    private async Task<HttpResponseMessage> Send(string method, string url, string? json = null, string? correlationId = null${credential ? ', (string Name, string Value)? credential = null, bool anonymous = false' : ''}${cases.upload ? ', HttpContent? content = null' : ''})
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(url, UriKind.Relative));
        if (json is not null)
        {
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }${cases.upload ? CONTENT_BODY : ''}
        if (correlationId is not null)
        {
            request.Headers.TryAddWithoutValidation("X-Correlation-Id", correlationId);
        }${credential ? CREDENTIAL_HEADER : ''}
        using var client = server.CreateClient();
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    private static async Task<JsonElement> Body(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        return document.RootElement.Clone();
    }

    private static string Correlation(HttpResponseMessage response) => response.Headers.GetValues("X-Correlation-Id").Single();

    /// <summary>Un ErrorResponse con la forma del contrato y la correlación de la propia respuesta.</summary>
    private static async Task<JsonElement> ExpectError(HttpResponseMessage response, int status, string error, string? code, string message)
    {
        Assert.Equal(status, (int)response.StatusCode);
        var body = await Body(response);
        Assert.Equal(ErrorShape, body.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(status, body.GetProperty("status").GetInt32());
        Assert.Equal(error, body.GetProperty("error").GetString());
        Assert.Equal(code, body.GetProperty("code").GetString());
        Assert.Equal(message, body.GetProperty("message").GetString());
        Assert.Matches(@"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\z", body.GetProperty("timestamp").GetString());
        Assert.Equal(Correlation(response), body.GetProperty("correlationId").GetString());
        return body;
    }

    [Fact]
    public async Task UnaRutaQueNoExisteEs404ConErrorResponse()
    {
        using var response = await Send("GET", ${csString(notFound)});
        await ExpectError(response, ${expected('notFound')});
    }

    [Fact]
    public async Task LaCorrelacionRecibidaVuelveEnLaRespuestaYUnaQueNoCumpleElFormatoSeSustituye()
    {
        using var kept = await Send("GET", "/livez", correlationId: "pedido-42");
        Assert.Equal("pedido-42", Correlation(kept));
        using var replaced = await Send("GET", "/livez", correlationId: "con espacios");
        Assert.Matches("^[0-9a-f-]{36}\\\\z", Correlation(replaced));
        using var generated = await Send("GET", "/livez");
        Assert.Matches("^[0-9a-f-]{36}\\\\z", Correlation(generated));
    }

${[...tests, ...securityTests(model)].join('\n\n')}${cases.upload ? FORM_HELPER : ''}
}`;
  const usings = ['System.Text', 'System.Text.Json', 'Xunit', ...(cases.upload ? ['System.Net.Http.Headers', `${solution(model).api.name}.Rest`] : [])];
  return csFile({ namespace: solution(model).unitTests.name, usings, body });
}

const CONTENT_BODY = `
        if (content is not null)
        {
            request.Content = content;
        }`;

const FORM_HELPER = `

    /// <summary>Un cuerpo multipart/form-data: los campos y, si se pide, una parte binaria.</summary>
    private static MultipartFormDataContent Form(IReadOnlyDictionary<string, string> fields, (string Part, byte[] Content, string ContentType)? file = null)
    {
        var form = new MultipartFormDataContent("keel-boundary-0192f1d2");
        foreach (var (name, value) in fields)
        {
            form.Add(new StringContent(value), name);
        }
        if (file is { } binary)
        {
            var part = new ByteArrayContent(binary.Content);
            part.Headers.ContentType = new MediaTypeHeaderValue(binary.ContentType);
            form.Add(part, binary.Part, "muestra.pdf");
        }
        return form;
    }`;

/**
 * Los casos de la SUBIDA (capa storage), sobre la operación que elige keel-core/gen/api-cases.js: los tres de keel-nest
 * (lo primero que falta, el 415 y una subida completa que llega a su handler) y lo que keel-nest medía en su test sobre
 * Fastify: el 413 de la entrada con el code del diseño, un cuerpo cortado y una parte obligatoria vacía (FILE_UNREADABLE).
 */
function uploadTests(model, upload) {
  const { url, part, fields, firstMissing } = upload;
  const tooLarge = declaredErrorFor(model, FRAMEWORK_ERRORS.fileTooLarge)?.code ?? FRAMEWORK_ERRORS.fileTooLarge.code;
  const unreadable = FRAMEWORK_ERRORS.fileUnreadable.code;
  const post = (content) => `await Send("POST", ${csString(url)}, content: ${content})`;
  const dictionary = (entries) => `new Dictionary<string, string> { ${Object.entries(entries).map(([key, value]) => `[${csString(key)}] = ${csString(value)}`).join(', ')} }`;
  const missing = firstMissing.parameter
    ? `await ExpectError(response, ${FW.missingParameter.status}, ${csString(FW.missingParameter.error)}, ${csString(FRAMEWORK_ERRORS.validation.code)}, ${csString(missingParameterMessage(firstMissing.parameter))});`
    : `await ExpectError(response, ${FW.missingPart.status}, ${csString(FW.missingPart.error)}, null, ${csString(missingPartMessage(firstMissing.part))});`;
  const truncated = `--keel-boundary-0192f1d2\r\nContent-Disposition: form-data; name="${part}"; filename="muestra.pdf"\r\n\r\n%PDF-1.7 a medias`;
  const tests = [
    `    [Fact]
    public async Task UnaSubidaVaciaEchaEnFaltaLoPrimeroQueElMensajePideComoKeelSpring()
    {
        // El formulario vacío como lo escribe la prueba de keel-nest (solo el cierre): MultipartFormDataContent sin partes
        // escribe una sección sin cabeceras, que ASP.NET no lee como formulario.
        using var form = new StringContent("--keel-boundary-0192f1d2--\\r\\n");
        form.Headers.ContentType = MediaTypeHeaderValue.Parse("multipart/form-data; boundary=keel-boundary-0192f1d2");
        using var response = ${post('form')};
        ${missing}
    }`,
    `    [Fact]
    public async Task UnCuerpoJsonEnUnaSubidaEs415()
    {
        using var response = await Send("POST", ${csString(url)}, json: "{}");
        await ExpectError(response, ${expected('notMultipart')});
    }`,
    `    [Fact]
    public async Task UnCuerpoQuePasaDelLimiteDeLaEntradaEs413ConElCodeDelDiseno()
    {
        using var content = new ByteArrayContent(new byte[MultipartReading.LimitBytes + 1]);
        content.Headers.ContentType = MediaTypeHeaderValue.Parse("multipart/form-data; boundary=keel-boundary-0192f1d2");
        using var response = ${post('content')};
        await ExpectError(response, ${expected('fileTooLarge', tooLarge)});
    }`,
    `    [Fact]
    public async Task UnCuerpoMultipartCortadoEs400FileUnreadable()
    {
        using var content = new StringContent(${csString(truncated)});
        content.Headers.ContentType = MediaTypeHeaderValue.Parse("multipart/form-data; boundary=keel-boundary-0192f1d2");
        using var response = ${post('content')};
        await ExpectError(response, ${expected('fileUnreadable', unreadable)});
    }`
  ];
  if (fields) {
    tests.push(
      `    [Fact]
    public async Task UnaParteObligatoriaVaciaEs400FileUnreadable()
    {
        using var form = Form(${dictionary(fields)}, (${csString(part)}, [], "application/pdf"));
        using var response = ${post('form')};
        await ExpectError(response, ${expected('fileEmpty', unreadable)});
    }`,
      `    [Fact]
    public async Task UnaSubidaCompletaLlegaASuHandlerLeeLosCamposYElBinario()
    {
        using var form = Form(${dictionary(fields)}, (${csString(part)}, "%PDF-1.7 muestra"u8.ToArray(), "application/pdf"));
        using var response = ${post('form')};
        Assert.DoesNotContain((int)response.StatusCode, new[] { 400, 404, 405, 413, 415 });
    }`
    );
  }
  return tests;
}

// Con la API protegida, cada petición de la prueba lleva la credencial de acceso total (TestCredential) salvo que el
// caso pida otra o ninguna: así los demás casos miden la API y no la autorización.
const CREDENTIAL_HEADER = `
        if (!anonymous)
        {
            var (name, value) = credential ?? TestCredential.Header;
            request.Headers.TryAddWithoutValidation(name, value);
        }`;

/**
 * Los casos propios de la seguridad, con las peticiones de keel-core/gen/api-cases.js (las mismas que la prueba de
 * keel-nest): el 401 antes de enrutar, la clave o el token que no valen (malformado, caducado, firmado con otra clave) y
 * el 403 de una regla.
 */
function securityTests(model) {
  if (!usesTestCredential(model)) return [];
  const cases = neutralSecurityCases(model, securityPlan(model));
  const rejected = expected('unauthenticated', FRAMEWORK_ERRORS.unauthenticated.code);
  const tests = [];
  if (cases.protectedPath) {
    tests.push(`    [Fact]
    public async Task SinCredencialUnCaminoProtegidoEs401ExistaONo()
    {
        // Spring Security decide antes de enrutar: sin credencial no se sabe siquiera si la ruta existe.
        using var response = await Send("GET", ${csString(cases.protectedPath)}, anonymous: true);
        await ExpectError(response, ${rejected});
    }`);
  }
  if (!usesJwt(model)) {
    tests.push(`    [Fact]
    public async Task UnaClaveDeApiQueNoEsLaConfiguradaNoAutentica401()
    {
        using var response = await Send("GET", ${csString(cases.notFound)}, credential: ("X-API-Key", "no-es-la-clave"));
        await ExpectError(response, ${rejected});
    }`);
    return tests;
  }
  tests.push(`    [Fact]
    public async Task UnTokenQueNoValidaEs401TambienEnUnaRutaAbierta()
    {
        // Como el resource server de Spring: un bearer que no vale es 401 aunque la ruta no exija nada.
        using var response = await Send("GET", "/livez", credential: ("Authorization", "Bearer no.es-un.token"));
        await ExpectError(response, ${rejected});
    }`);
  tests.push(`    [Fact]
    public async Task UnTokenCaducadoEs401()
    {
        var expired = TestCredential.TokenWith(TestCredential.FullAccess, DateTimeOffset.UtcNow.AddMinutes(-5));
        using var response = await Send("GET", ${csString(cases.notFound)}, credential: ("Authorization", "Bearer " + expired));
        await ExpectError(response, ${rejected});
    }`);
  tests.push(`    [Fact]
    public async Task UnTokenFirmadoConOtraClaveEs401()
    {
        var forged = TestCredential.ForgedWith(TestCredential.FullAccess);
        using var response = await Send("GET", ${csString(cases.notFound)}, credential: ("Authorization", "Bearer " + forged));
        await ExpectError(response, ${rejected});
    }`);
  if (cases.forbidden) {
    tests.push(`    /// <summary>Una credencial válida sin lo que exige la regla (${cases.forbidden.authorities.join(' o ')}) es 403.</summary>
    [Fact]
    public async Task UnaCredencialValidaSinLoQueExigeLaReglaEs403()
    {
        var bare = TestCredential.TokenWith("""{"sub":"keel-sin-permisos"}""");
        using var response = await Send(${csString(cases.forbidden.method)}, ${csString(cases.forbidden.url)}, credential: ("Authorization", "Bearer " + bare));
        await ExpectError(response, ${expected('accessDenied', FRAMEWORK_ERRORS.accessDenied.code)});
    }`);
  }
  return tests;
}
