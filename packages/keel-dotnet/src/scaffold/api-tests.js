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
import { FRAMEWORK_RESPONSES as FW } from 'keel-core/gen/api-errors';
import { apiCases as neutralApiCases } from 'keel-core/gen/api-cases';
import { csFile, csString, solution } from './render.js';
import { messageComponents } from './services.js';
import { usesApi } from './rest-support.js';
import { servedOperation } from './endpoints.js';

export function generate(model) {
  if (!usesApi(model)) return [];
  return [{ path: `${solution(model).unitTests.dir}/ApiTests.cs`, content: apiTestsCs(model) }];
}

/**
 * Los casos que el diseño permite ejercitar, sobre las operaciones que keel-dotnet SIRVE hoy (sin subidas ni
 * identidad del llamante: llegan con su capa).
 */
export function apiCases(model) {
  const served = {
    ...model,
    services: (model.services ?? []).map((service) => ({ ...service, operations: (service.operations ?? []).filter((op) => !op.route || servedOperation(op)) }))
  };
  const cases = neutralApiCases(served, { components: (operation) => messageComponents(operation) });
  delete cases.upload;
  return cases;
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
  const notFound = `${model.api.routeBase}/keel-ruta-que-no-existe`;
  const body = `/// <summary>
/// El contrato HTTP del servidor arrancado en memoria: lo que fija el diseño sin depender de la lógica del agente.
/// Las peticiones salen del diseño (keel-core/gen/api-cases.js), las mismas que pide la prueba de keel-nest.
/// </summary>
public sealed class ApiTests(InMemoryServer server) : IClassFixture<InMemoryServer>
{
    /// <summary>El orden de las claves de ErrorResponse: el del cable (keel-core, WIRE_SHAPES.errorResponse).</summary>
    private static readonly string[] ErrorShape = [${WIRE_SHAPES.errorResponse.map(csString).join(', ')}];

    private async Task<HttpResponseMessage> Send(string method, string url, string? json = null, string? correlationId = null)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(url, UriKind.Relative));
        if (json is not null)
        {
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        if (correlationId is not null)
        {
            request.Headers.TryAddWithoutValidation("X-Correlation-Id", correlationId);
        }
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

${tests.join('\n\n')}
}`;
  return csFile({ namespace: solution(model).unitTests.name, usings: ['System.Text', 'System.Text.Json', 'Xunit'], body });
}
