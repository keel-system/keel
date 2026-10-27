// El arnés del BUZÓN (capa mail, adelantada al 12e): los helpers con los que un flujo afirma sobre el correo que salió.
// Los mismos que el AbstractFlowIT de keel-spring y el flow.ts de keel-nest (`AwaitMailTo`, `LastMailTo`, `MailCount`,
// `AssertNoMailTo`, `RelayRejectsRecipients`, `RejectedAddress`, `RelayAccepts`, `MailSubject`, `MailHtml`,
// `MailText`, `MailFrom`), con el vocabulario de keel-core (`gen/mail-probes.js`): las rutas, los campos, la
// repaginación y el rechazo hablan con el mismo Mailpit, y salen del mismo módulo que el sondeo de validate-infra.sh y
// la purga de reset-db.sh.
//
// `Support/Mail.cs` no usa nada del resto del arnés —solo HttpClient y System.Text.Json—, así que `mail-check` lo
// compila SOLO y lo ejecuta contra un Mailpit real. Los flujos llegan a los helpers por FlowTest, de la que es una parte.

import {
  HOST_BASE,
  HTTP_PORT,
  ROUTES,
  SEARCH_PREFIX,
  SEARCH_LIMIT,
  SEARCH_LIMIT_PARAM,
  searchSuffix,
  CHAOS_REJECT_CODE,
  CHAOS_REJECT_RECIPIENTS,
  CHAOS_OFF,
  REJECTED_DOMAIN,
  MAIL_AWAIT,
  mailAwaitSeconds
} from '@keel-system/keel-core/gen/mail-probes';
import { csFile, csString, solution } from './render.js';
import { usesMail } from './mail.js';

export function mailHarnessPath(model) {
  return `${solution(model).integrationTests.dir}/Support/Mail.cs`;
}

/** El archivo del arnés, o null sin capa mail. */
export function mailHarnessFile(model, namespace) {
  if (!usesMail(model)) return null;
  return { path: mailHarnessPath(model), content: csFile({ namespace, usings: ['System.Text', 'System.Text.Json'], body: body(model) }) };
}

/** SMOKE-7, el mismo de keel-spring y keel-nest: el buzón responde y el reset lo deja vacío. */
export function mailSmokeCase(model) {
  if (!usesMail(model)) return null;
  return `    [Scenario("SMOKE-7: el buzón de prueba responde y el reset lo deja vacío")]
    public async Task ElBuzonDePruebaRespondeYElResetLoDejaVacio()
    {
        // Un correo de la corrida anterior haría que el primer AwaitMailTo de un flujo devolviera el mensaje equivocado.
        Assert.Equal(0, await MailCount("humo@keel.test"));
    }`;
}

function body(model) {
  const senders = model.mail.sentBy.join(', ');
  const parts = model.mail.multipart ? 'las dos partes del cuerpo (HTML y texto)' : model.mail.hasHtml ? 'solo el cuerpo HTML' : 'solo el cuerpo en texto';
  const wait = mailAwaitSeconds(model);
  const tooSlow = wait.period != null && wait.period + MAIL_AWAIT.marginSeconds > MAIL_AWAIT.capSeconds;
  const waitDoc =
    wait.period == null
      ? `    /// El correo sale dentro de la operación que atiende la petición: no hay barrido de por medio y lo único que cubre esta
    /// espera es el viaje al relay.`
      : `    /// Sale del contrato, no de un número redondo: el correo lo empuja un barrido con cadencia de ${wait.period} s (el schedule más
    /// rápido del diseño), y una espera más corta que su periodo falla según la fase en que arranque la suite. Lleva
    /// ${MAIL_AWAIT.marginSeconds} s de margen por el desfase que build reparte entre barridos de la misma cadencia.${
      tooSlow
        ? `
    /// OJO: ese periodo excede el techo de ${MAIL_AWAIT.capSeconds} s y se ha recortado ahí. Ningún escenario que dependa del barrido
    /// va a pasar tal cual: si tiene que ser verificable, el diseño necesita un disparador además del schedule.`
        : ''
    }`;
  return `
/// <summary>
/// El buzón de prueba: el Mailpit de infra/docker-compose.yaml, al que el perfil <c>local</c> entrega el correo. El reset
/// de estado (al empezar cada flujo) lo vacía y le quita el rechazo: un correo de un flujo anterior haría que el primer
/// AwaitMailTo devolviera el mensaje equivocado. Los mismos helpers que los arneses de keel-spring y keel-nest.
/// </summary>
public abstract partial class FlowTest
{
    /// <summary>
    /// Espera a que haya <paramref name="count"/> correos para esa dirección y devuelve sus ids, el más reciente primero.
    /// </summary>
    /// <remarks>
    /// ES EL HELPER CON EL QUE EMPIEZA CUALQUIER THEN SOBRE CORREO, y la espera no es opcional. Las operaciones que lo
    /// mandan (${senders}) responden aceptando el encargo, no habiéndolo cumplido: la entrega ocurre DESPUÉS de la
    /// respuesta. Una lectura seca justo tras el 2xx es una carrera, y el escenario fallaría unas veces sí y otras no.
    /// </remarks>
    protected static Task<IReadOnlyList<string>> AwaitMailTo(string address, int count) => MailHarness.AwaitMailToAsync(address, count);

    /// <summary>El correo más reciente para esa dirección, ya resuelto a su detalle completo.</summary>
    protected static Task<JsonElement> LastMailTo(string address) => MailHarness.LastMailToAsync(address);

    /// <summary>Cuántos correos hay AHORA para esa dirección, sin esperar.</summary>
    /// <remarks>
    /// Para el Then que afirma que no se duplicó: se espera primero al que sí debe llegar (con AwaitMailTo) y solo entonces
    /// se cuenta. Contar sin haber esperado nada mide el estado de antes, y eso sale verde siempre.
    /// </remarks>
    protected static Task<int> MailCount(string address) => MailHarness.MailCountAsync(address);

    /// <summary>
    /// Que NO salió ningún correo para esa dirección: el Then de los rechazos. Espera un margen a propósito —el MISMO techo
    /// que AwaitMailTo—: sin él, «no ha llegado» y «todavía no ha llegado» son indistinguibles.
    /// </summary>
    protected static Task AssertNoMailTo(string address) => MailHarness.AssertNoMailToAsync(address);

    /// <summary>
    /// A partir de aquí el relay de prueba RECHAZA todo destinatario con un ${CHAOS_REJECT_CODE} (rechazo permanente), hasta
    /// RelayAccepts() o hasta el reset del siguiente flujo. Es como se alcanza en caja negra el envío que acaba fallido, sin
    /// fabricarlo escribiendo en el almacén. Es GLOBAL: el Given lo activa justo antes del When.
    /// </summary>
    protected static Task RelayRejectsRecipients() => MailHarness.RelayRejectsRecipientsAsync();

    /// <summary>
    /// Una dirección que el relay de prueba RECHAZA siempre, ella sola (un ${CHAOS_REJECT_CODE} a su RCPT TO), mientras el resto
    /// de destinatarios del mismo envío se aceptan: el rechazo SELECTIVO. No hay que activarla: el buzón arranca rechazando
    /// el dominio reservado ${REJECTED_DOMAIN} (RFC 2606).
    /// </summary>
    /// <remarks>
    /// Ojo al afirmar: el buzón indexa la cabecera To, así que el correo que SÍ salió para los demás sigue NOMBRANDO al
    /// rechazado. Que no le llegó se afirma por el desenlace del envío, no con AssertNoMailTo.
    /// </remarks>
    protected static string RejectedAddress(string localPart) => MailHarness.RejectedAddress(localPart);

    /// <summary>El relay vuelve a aceptarlo todo. El reset entre flujos lo hace siempre.</summary>
    protected static Task RelayAccepts() => MailHarness.RelayAcceptsAsync();

    /// <summary>Asunto tal como lo lee quien recibe el correo: ya interpolado y ya saneado.</summary>
    protected static string MailSubject(JsonElement message) => MailHarness.Subject(message);

    /// <summary>Cuerpo HTML. Cadena vacía si el mensaje no lleva parte HTML.</summary>
    protected static string MailHtml(JsonElement message) => MailHarness.Html(message);

    /// <summary>Cuerpo en texto plano. Este servicio envía ${parts}.</summary>
    protected static string MailText(JsonElement message) => MailHarness.Text(message);

    /// <summary>Dirección desde la que salió el correo: el remitente que el diseño resuelve por envío.</summary>
    protected static string? MailFrom(JsonElement message) => MailHarness.From(message);
}

/// <summary>La API del buzón de prueba. Solo HttpClient y System.Text.Json: mail-check lo compila solo.</summary>
public static class MailHarness
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    /// <summary>
    /// Techo de cualquier espera de correo, en segundos.
${waitDoc}
    /// </summary>
    public const int AwaitSeconds = ${wait.seconds};

    /// <summary>Techo de una búsqueda en el buzón, y el punto donde se repagina (ver IdsToAsync).</summary>
    private const int SearchLimit = ${SEARCH_LIMIT};

    /// <summary>API del buzón (o <c>MAIL_API</c> del entorno).</summary>
    public static string Api =>
        Environment.GetEnvironmentVariable("MAIL_API") is { Length: > 0 } configured ? configured : ${csString(HOST_BASE)};

    public static async Task<IReadOnlyList<string>> AwaitMailToAsync(string address, int count)
    {
        IReadOnlyList<string> ids = [];
        var deadline = DateTime.UtcNow.AddSeconds(AwaitSeconds);
        while (DateTime.UtcNow < deadline)
        {
            ids = await IdsToAsync(address);
            if (ids.Count >= count)
            {
                return ids;
            }
            await Task.Delay(200);
        }
        throw new InvalidOperationException(
            $"Se esperaban {count} correo(s) para {address} y llegaron {ids.Count} en {AwaitSeconds} s. El buzón se mira en http://localhost:${HTTP_PORT}");
    }

    public static async Task<JsonElement> LastMailToAsync(string address)
    {
        var ids = await AwaitMailToAsync(address, 1);
        return await MessageAsync(ids[0]);
    }

    public static async Task<int> MailCountAsync(string address) => (await IdsToAsync(address)).Count;

    public static async Task AssertNoMailToAsync(string address)
    {
        await Task.Delay(TimeSpan.FromSeconds(AwaitSeconds));
        var count = await MailCountAsync(address);
        if (count > 0)
        {
            throw new InvalidOperationException($"No debía salir ningún correo para {address} y salieron {count}");
        }
    }

    public static Task RelayRejectsRecipientsAsync() => PutAsync(${csString(ROUTES.chaos())}, ${csString(CHAOS_REJECT_RECIPIENTS)});

    public static Task RelayAcceptsAsync() => PutAsync(${csString(ROUTES.chaos())}, ${csString(CHAOS_OFF)});

    public static string RejectedAddress(string localPart) => $"{localPart}@${REJECTED_DOMAIN}";

    public static string Subject(JsonElement message) => TextOf(message, "Subject");

    public static string Html(JsonElement message) => TextOf(message, "HTML");

    public static string Text(JsonElement message) => TextOf(message, "Text");

    public static string? From(JsonElement message) =>
        message.TryGetProperty("From", out var from) && from.ValueKind == JsonValueKind.Object
        && from.TryGetProperty("Address", out var address) && address.ValueKind == JsonValueKind.String
            ? address.GetString()
            : null;

    private static string TextOf(JsonElement message, string field) =>
        message.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;

    /// <summary>
    /// Ids de los correos para esa dirección, más reciente primero. La respuesta trae dos números: la lista, RECORTADA por
    /// limit, y el conteo de los que casan, que no se recorta. Leer solo la lista pone un techo a MailCount; por eso se mira
    /// el total y, si supera el techo, se repite la búsqueda pidiendo exactamente ese total.
    /// </summary>
    private static async Task<IReadOnlyList<string>> IdsToAsync(string address)
    {
        var query = Uri.EscapeDataString($"to:{address}");
        var body = await GetAsync($"${SEARCH_PREFIX}{query}${searchSuffix()}");
        var matching = body.TryGetProperty("messages_count", out var total) && total.ValueKind == JsonValueKind.Number ? total.GetInt32() : 0;
        if (matching > SearchLimit)
        {
            body = await GetAsync($"${SEARCH_PREFIX}{query}${SEARCH_LIMIT_PARAM}{matching}");
        }
        if (!body.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        return [.. messages.EnumerateArray().Select(message => message.GetProperty("ID").GetString() ?? string.Empty)];
    }

    /// <summary>El mensaje COMPLETO por su id: la búsqueda solo trae el resumen, y sin esto no se afirma sobre el cuerpo.</summary>
    private static Task<JsonElement> MessageAsync(string id) => GetAsync($"${ROUTES.message('')}{id}");

    private static async Task<JsonElement> GetAsync(string path)
    {
        HttpResponseMessage response;
        try
        {
            response = await Http.GetAsync($"{Api}{path}");
        }
        catch (HttpRequestException error)
        {
            throw new InvalidOperationException($"No se pudo hablar con el buzón de prueba en {Api}. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh)", error);
        }
        using (response)
        {
            var text = await response.Content.ReadAsStringAsync();
            if ((int)response.StatusCode >= 300)
            {
                throw new InvalidOperationException($"El buzón de prueba rechazó {path} (HTTP {(int)response.StatusCode}): {text}");
            }
            using var document = JsonDocument.Parse(text);
            return document.RootElement.Clone();
        }
    }

    private static async Task PutAsync(string path, string json)
    {
        HttpResponseMessage response;
        try
        {
            response = await Http.PutAsync($"{Api}{path}", new StringContent(json, Encoding.UTF8, "application/json"));
        }
        catch (HttpRequestException error)
        {
            throw new InvalidOperationException($"No se pudo hablar con el buzón de prueba en {Api}", error);
        }
        using (response)
        {
            if ((int)response.StatusCode >= 300)
            {
                throw new InvalidOperationException(
                    $"El buzón de prueba rechazó {path} (HTTP {(int)response.StatusCode}): {await response.Content.ReadAsStringAsync()}. ¿Arrancó con MP_ENABLE_CHAOS? (infra/docker-compose.yaml)");
            }
        }
    }
}`;
}
