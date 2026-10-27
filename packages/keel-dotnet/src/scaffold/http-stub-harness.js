// El arnés del PROVEEDOR DE PRUEBA (incremento 11d): los helpers con los que un flujo programa qué responde el WireMock
// de infra/ y lee lo que el servidor le mandó, y `AgeForReconciliation`, que fabrica la precondición de un barrido de
// reconciliación. Los mismos que el AbstractFlowIT de keel-spring y el flow.ts de keel-nest (`StubFor`, `StubFailure`,
// `StubConnectionFault`, `StubTimeout`, `StubSequence`, `StubCallCount`, `StubRequests`, …), con el vocabulario del stub
// de keel-core (`gen/http-stub-probes.js`): los tres hablan con el mismo contenedor.
//
// `Support/HttpStub.cs` no usa nada del resto del arnés —solo HttpClient y System.Text.Json—, así que `stub-check` lo
// compila SOLO y lo ejecuta contra un WireMock real. Los flujos llegan a los helpers por FlowTest, de la que es una parte.

import { HTTP_STUB_ADMIN, HTTP_STUB_ENDPOINTS, HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE } from '@keel-system/keel-core/gen/http-stub-probes';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { snakeCase } from '@keel-system/keel-core/gen';
import { csFile, csString, solution } from './render.js';
import { usesRelational } from './persistence.js';

/** ¿Hay proveedor de prueba? Con clientes HTTP salientes (y, cuando llegue, con la capa payments), como en los otros dos. */
export function usesHttpStub(model) {
  return Boolean((model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0) || model.payments);
}

export function httpStubPath(model) {
  return `${solution(model).integrationTests.dir}/Support/HttpStub.cs`;
}

/** El archivo del arnés, o null sin proveedor de prueba. */
export function httpStubFile(model, namespace) {
  if (!usesHttpStub(model)) return null;
  const clients = [...(model.httpClients ?? []).map((client) => client.id), ...(model.payments ? ['la pasarela de pago'] : [])].join(', ');
  return { path: httpStubPath(model), content: csFile({ namespace, usings: ['System.Text', 'System.Text.Json', 'System.Text.Json.Nodes'], body: body(clients) }) };
}

function body(clients) {
  return String.raw`
/// <summary>
/// Una respuesta programada del proveedor de prueba, para <c>StubSequence</c>. Las cuatro formas son las
/// de los helpers de un disparo.
/// </summary>
public static class StubResponse
{
    /// <summary>Respuesta normal, con su cuerpo (un objeto se serializa; un texto viaja tal cual).</summary>
    public static JsonObject Ok(int status, object? body = null) => HttpStubHarness.Response(status, body);

    /// <summary>Fallo sin cuerpo útil: un 5xx es reintentable si el diseño lo dice; un 4xx nunca.</summary>
    public static JsonObject Failure(int status) => HttpStubHarness.Response(status, new { });

    /// <summary>No contesta a tiempo: <paramref name="delayMs"/> tiene que superar el <c>timeoutMs</c> de la llamada.</summary>
    public static JsonObject Timeout(int delayMs) => new()
    {
        ["status"] = 200,
        ["fixedDelayMilliseconds"] = delayMs,
        ["headers"] = new JsonObject { ["Content-Type"] = "application/json" },
        ["body"] = "{}"
    };

    /// <summary>Corta la conexión antes de responder: el servidor lo ve como fallo del transporte.</summary>
    public static JsonObject ConnectionFault() => new() { ["fault"] = ${csString(HTTP_STUB_FAULT)} };
}

/// <summary>Una petición que recibió el proveedor, tal como la registra.</summary>
public sealed record StubRequest(string Url, string Method, IReadOnlyDictionary<string, string> Headers, string Body);

/// <summary>
/// El proveedor de prueba: el WireMock de infra/docker-compose.yaml, al que apuntan las <c>base-url</c> de los clientes
/// salientes en el perfil <c>local</c> (${clients}). Cada flujo programa en su Given lo que responde, y el reset de estado
/// (al empezar cada flujo) lo deja como recién arrancado: un mapping que sobrevive a su escenario es estado global, y el
/// orden de ejecución decidiría el resultado. Los mismos helpers que los arneses de keel-spring y keel-nest.
/// </summary>
public abstract partial class FlowTest
{
    /// <summary>
    /// Programa qué responde el proveedor en ESTE escenario: método, ruta (regex sobre el path, sin query) y la respuesta
    /// que verá el servidor.
    /// </summary>
    protected static Task StubFor(string method, string pathPattern, int status, object? body = null) =>
        HttpStubHarness.MappingAsync(method, pathPattern, StubResponse.Ok(status, body));

    /// <summary>Fallo del proveedor sin cuerpo útil: lo que ejercita el fallback declarado y el circuito.</summary>
    protected static Task StubFailure(string method, string pathPattern, int status) =>
        HttpStubHarness.MappingAsync(method, pathPattern, StubResponse.Failure(status));

    /// <summary>
    /// El proveedor NO contesta: corta la conexión. No es un 5xx, y la diferencia la declara el diseño: una llamada con
    /// <c>retryOn: [timeout, connection]</c> no reintenta un 500 y sí reintenta esto.
    /// </summary>
    protected static Task StubConnectionFault(string method, string pathPattern) =>
        HttpStubHarness.MappingAsync(method, pathPattern, StubResponse.ConnectionFault());

    /// <summary>El proveedor tarda más de lo tolerado (<c>retryOn: [timeout]</c>): <paramref name="delayMs"/> por encima del <c>timeoutMs</c> de la llamada.</summary>
    protected static Task StubTimeout(string method, string pathPattern, int delayMs) =>
        HttpStubHarness.MappingAsync(method, pathPattern, StubResponse.Timeout(delayMs));

    /// <summary>
    /// Respuestas DISTINTAS para llamadas sucesivas a la misma ruta: lo que hace escribible un escenario de REINTENTO
    /// («falla la primera, responde la segunda, y las dos llevan la misma clave de idempotencia»). La última se queda pegada.
    /// Una ruta admite UNA secuencia por flujo: la segunda encadenaría desde un estado que la primera dejó atrás.
    /// </summary>
    /// <example>
    /// <code>
    /// await StubSequence("DELETE", "/stock/reservations/.*", StubResponse.ConnectionFault(), StubResponse.Ok(200, new { cancelled = true }));
    /// // …la acción que dispara la llamada…
    /// var requests = await StubRequests("DELETE", "/stock/reservations/.*");
    /// Assert.Equal(2, requests.Count);
    /// Assert.Equal(StubRequestHeader(requests[0], "Idempotency-Key"), StubRequestHeader(requests[1], "Idempotency-Key"));
    /// </code>
    /// </example>
    protected static Task StubSequence(string method, string pathPattern, params JsonObject[] responses) =>
        HttpStubHarness.SequenceAsync(method, pathPattern, responses);

    /// <summary>Cuántas veces llamó el servidor al proveedor a esa ruta.</summary>
    protected static Task<int> StubCallCount(string method, string pathPattern) => HttpStubHarness.CallCountAsync(method, pathPattern);

    /// <summary>Las peticiones que recibió el proveedor a esa ruta: QUÉ se le mandó, no solo cuántas veces.</summary>
    protected static Task<IReadOnlyList<StubRequest>> StubRequests(string method, string pathPattern) => HttpStubHarness.RequestsAsync(method, pathPattern);

    /// <summary>El cuerpo que viajó en esa petición, como JSON; null si no llevaba.</summary>
    protected static JsonElement? StubRequestBody(StubRequest request) => HttpStubHarness.BodyOf(request);

    /// <summary>Una cabecera de esa petición, sin distinguir mayúsculas (el caso lo decide el cliente HTTP). null si no la llevaba.</summary>
    protected static string? StubRequestHeader(StubRequest request, string name) => HttpStubHarness.HeaderOf(request, name);

    /// <summary>Borra los mappings, el log de peticiones y las secuencias. Ya lo hace el reset de cada flujo.</summary>
    protected static Task ResetStubs() => HttpStubHarness.ResetAsync();
}

/// <summary>El admin API del proveedor de prueba. Solo HttpClient y System.Text.Json: stub-check lo compila solo.</summary>
public static class HttpStubHarness
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private static readonly HashSet<string> Sequenced = new(StringComparer.Ordinal);

    /// <summary>El admin API del stub (o <c>HTTP_STUB_ADMIN</c> del entorno).</summary>
    public static string Admin =>
        Environment.GetEnvironmentVariable("HTTP_STUB_ADMIN") is { Length: > 0 } configured ? configured : ${csString(HTTP_STUB_ADMIN)};

    public static JsonObject Response(int status, object? body) => new()
    {
        ["status"] = status,
        ["headers"] = new JsonObject { ["Content-Type"] = "application/json" },
        ["body"] = body switch
        {
            null => "",
            string text => text,
            _ => JsonSerializer.Serialize(body)
        }
    };

    public static Task MappingAsync(string method, string pathPattern, JsonObject response) => MappingAsync(method, pathPattern, response, null);

    public static async Task SequenceAsync(string method, string pathPattern, IReadOnlyList<JsonObject> responses)
    {
        ArgumentNullException.ThrowIfNull(responses);
        if (responses.Count < 2)
        {
            throw new ArgumentException("StubSequence con menos de dos respuestas no es una secuencia: para una sola usa StubFor, StubFailure, StubTimeout o StubConnectionFault", nameof(responses));
        }
        var key = $"{method} {pathPattern}";
        lock (Sequenced)
        {
            if (!Sequenced.Add(key))
            {
                throw new InvalidOperationException($"ya hay una secuencia programada para {key} en este flujo: la segunda encadenaría desde un estado que la primera dejó atrás. Programa una sola.");
            }
        }
        var scenario = $"seq-{Hash(key)}";
        string? state = ${csString(HTTP_STUB_INITIAL_STATE)};
        for (var index = 0; index < responses.Count; index++)
        {
            var next = index == responses.Count - 1 ? null : $"{scenario}-{index + 1}";
            await MappingAsync(method, pathPattern, responses[index], (scenario, state!, next));
            state = next;
        }
    }

    public static async Task<int> CallCountAsync(string method, string pathPattern)
    {
        var response = await AdminAsync(${csString(HTTP_STUB_ENDPOINTS.count)}, Criterion(method, pathPattern));
        return response.GetProperty("count").GetInt32();
    }

    public static async Task<IReadOnlyList<StubRequest>> RequestsAsync(string method, string pathPattern)
    {
        var response = await AdminAsync(${csString(HTTP_STUB_ENDPOINTS.find)}, Criterion(method, pathPattern));
        var requests = new List<StubRequest>();
        foreach (var request in response.GetProperty("requests").EnumerateArray())
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (request.TryGetProperty("headers", out var sent) && sent.ValueKind == JsonValueKind.Object)
            {
                foreach (var header in sent.EnumerateObject())
                {
                    headers[header.Name] = header.Value.ValueKind == JsonValueKind.Array
                        ? string.Join(", ", header.Value.EnumerateArray().Select(value => value.ToString()))
                        : header.Value.ToString();
                }
            }
            requests.Add(new StubRequest(
                request.GetProperty("url").GetString() ?? "",
                request.GetProperty("method").GetString() ?? "",
                headers,
                request.TryGetProperty("body", out var body) ? body.GetString() ?? "" : ""));
        }
        return requests;
    }

    public static JsonElement? BodyOf(StubRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Body.Length == 0)
        {
            return null;
        }
        using var document = JsonDocument.Parse(request.Body);
        return document.RootElement.Clone();
    }

    public static string? HeaderOf(StubRequest request, string name)
    {
        ArgumentNullException.ThrowIfNull(request);
        return request.Headers.TryGetValue(name, out var value) ? value : null;
    }

    /// <summary>
    /// Un mapping con el criterio y la respuesta ya escritos en el vocabulario del stub. No es de los flujos: lo usará el
    /// arnés de la pasarela de pago.
    /// </summary>
    public static Task RawMappingAsync(JsonObject request, JsonObject response) =>
        AdminAsync(${csString(HTTP_STUB_ENDPOINTS.mappings)}, new JsonObject { ["request"] = request, ["response"] = response });

    public static async Task ResetAsync()
    {
        ForgetSequences();
        await AdminAsync(${csString(HTTP_STUB_ENDPOINTS.reset)}, new JsonObject());
    }

    /// <summary>Olvida las secuencias del flujo anterior (el stub ya lo vació infra/reset-db.sh).</summary>
    public static void ForgetSequences()
    {
        lock (Sequenced)
        {
            Sequenced.Clear();
        }
    }

    private static JsonObject Criterion(string method, string pathPattern) => new() { ["method"] = method, ["urlPathPattern"] = pathPattern };

    private static async Task MappingAsync(string method, string pathPattern, JsonObject response, (string Scenario, string Required, string? Next)? sequence)
    {
        var mapping = new JsonObject();
        if (sequence is { } chained)
        {
            mapping["scenarioName"] = chained.Scenario;
            mapping["requiredScenarioState"] = chained.Required;
            if (chained.Next is not null)
            {
                mapping["newScenarioState"] = chained.Next;
            }
        }
        mapping["request"] = Criterion(method, pathPattern);
        // Una copia: el mismo JsonObject de StubResponse puede ir en dos mappings, y un nodo solo tiene un padre.
        mapping["response"] = JsonNode.Parse(response.ToJsonString());
        await AdminAsync(${csString(HTTP_STUB_ENDPOINTS.mappings)}, mapping);
    }

    private static async Task<JsonElement> AdminAsync(string path, JsonObject body)
    {
        HttpResponseMessage response;
        try
        {
            using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            response = await Http.PostAsync(new Uri(Admin + path), content);
        }
        catch (HttpRequestException error)
        {
            throw new InvalidOperationException($"No se pudo hablar con el proveedor de prueba en {Admin}. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh) — {error.Message}", error);
        }
        using (response)
        {
            var text = await response.Content.ReadAsStringAsync();
            if ((int)response.StatusCode >= 300)
            {
                throw new InvalidOperationException($"El proveedor de prueba rechazó {path} (HTTP {(int)response.StatusCode}): {text}");
            }
            using var document = JsonDocument.Parse(text.Length == 0 ? "{}" : text);
            return document.RootElement.Clone();
        }
    }

    /// <summary>El nombre del escenario de una secuencia: el mismo hash que el arnés de keel-nest.</summary>
    private static string Hash(string text)
    {
        var value = 0;
        foreach (var character in text)
        {
            value = unchecked((value * 31) + character);
        }
        return unchecked((uint)value).ToString("x", System.Globalization.CultureInfo.InvariantCulture);
    }
}`;
}

// ─── AgeForReconciliation, en FlowTest (usa Db) ──────────────────────────────────────────────────

/** Las tablas y marcas de espera de cada activación con barrido (las de keel-nest). */
function agingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        if (!target.table || !target.awaitingField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push(target);
      }
    }
  }
  // El barrido de la capa payments no es un `reconciledBy` de activations, pero su condición de entrada es la misma —la
  // marca de espera del cobro, rancia— y tampoco se alcanza de otra forma. La clave es el nombre del barrido, como en
  // keel-spring y keel-nest.
  const payments = model.payments;
  if (payments?.reconciliation?.sweep && payments.record?.awaitingSince) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === payments.record.entity);
    if (entity?.tableName) {
      if (!targets.has(payments.reconciliation.sweep)) targets.set(payments.reconciliation.sweep, []);
      targets.get(payments.reconciliation.sweep).push({ table: entity.tableName, awaitingField: payments.record.awaitingSince });
    }
  }
  return targets;
}

/**
 * Los miembros de FlowTest con `AgeForReconciliation` y `HoldFromReconciliation`. El mismo criterio que keel-spring y
 * keel-nest: sin los literales del motor (`staleTimestamp`, `uuidLiteral`) no se emiten —un UPDATE que no casa dejaría el
 * escenario verde sin haber envejecido nada—. Usan `Db` e `IdLiteral`, que emite el arnés con base relacional.
 */
export function reconciliationAgingMembers(model) {
  if (!usesRelational(model)) return [];
  const entry = DATABASES[model.stack?.database ?? 'postgresql'];
  if (!entry?.staleTimestamp || !entry?.uuidLiteral) return [];
  const targets = agingTargets(model);
  if (targets.size === 0) return [];
  const known = [...targets.keys()].join(', ');
  const first = [...targets.keys()][0];
  const table = (clock) =>
    [...targets]
      .map(([name, list]) => `        [${csString(name)}] = [${list.map((target) => csString(`UPDATE ${target.table} SET ${snakeCase(target.awaitingField)} = ${clock} WHERE id = `)).join(', ')}],`)
      .join('\n');
  const members = [
    `    /// <summary>Las marcas de espera que envejece AgeForReconciliation, por activación: ${known}.</summary>
    private static readonly Dictionary<string, string[]> ReconciliationAging = new(StringComparer.Ordinal)
    {
${table(entry.staleTimestamp)}
    };`,
    `    /// <summary>
    /// Deja la marca de espera de <paramref name="activation"/> infinitamente rancia para la fila <paramref name="id"/>, de modo
    /// que el barrido la tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron, como en producción—: crea la
    /// condición que busca («lleva esperando más de lo tolerado») sin esperar el plazo real, y solo para esta fila. Bajar el
    /// umbral por configuración sería global y se llevaría las filas de los demás escenarios.
    /// </summary>
    /// <example>
    /// <code>
    /// AgeForReconciliation(${csString(first)}, id);
    /// await Eventually(async () => …, TimeSpan.FromSeconds(90));
    /// </code>
    /// Deja margen para un tick del cron.
    /// </example>
    protected static void AgeForReconciliation(string activation, string id)
    {
        if (!ReconciliationAging.TryGetValue(activation, out var statements))
        {
            throw new ArgumentException($"No hay barrido para la activación '{activation}'. Las que lo tienen: ${known}", nameof(activation));
        }
        foreach (var statement in statements)
        {
            Db(statement + IdLiteral(id));
        }
    }`
  ];
  if (entry.heldTimestamp) {
    members.push(
      `    /// <summary>Las marcas de espera que retiene HoldFromReconciliation, por activación.</summary>
    private static readonly Dictionary<string, string[]> ReconciliationHolding = new(StringComparer.Ordinal)
    {
${table(entry.heldTimestamp)}
    };`,
      `    /// <summary>
    /// El inverso de AgeForReconciliation: deja la marca de espera de <paramref name="activation"/> en el FUTURO para la fila
    /// <paramref name="id"/>, de modo que el barrido NO la tome aunque pasen sus ciclos. Es la palanca de un escenario que pide
    /// «lo que acaba de encargarse no se toca».
    /// </summary>
    protected static void HoldFromReconciliation(string activation, string id)
    {
        if (!ReconciliationHolding.TryGetValue(activation, out var statements))
        {
            throw new ArgumentException($"No hay barrido para la activación '{activation}'. Las que lo tienen: ${known}", nameof(activation));
        }
        foreach (var statement in statements)
        {
            Db(statement + IdLiteral(id));
        }
    }`
    );
  }
  return members;
}

/** El `IdLiteral` del arnés: el id de una fila como literal del motor, validado. Lo comparten el rescate y la reconciliación. */
export function idLiteralMember(model) {
  const entry = DATABASES[model.stack?.database ?? 'postgresql'];
  return `    private static string IdLiteral(string id) =>
        Guid.TryParseExact(id, "D", out _)
            ? ${csString(entry.uuidLiteral.prefix)} + id + ${csString(entry.uuidLiteral.suffix)}
            : throw new ArgumentException($"No es un id: '{id}'", nameof(id));`;
}
