// El correo de keel-dotnet contra un Mailpit REAL (capa mail, adelantada al 12e). El gemelo del mail-check de keel-nest.
//
// Lo que `npm test` no puede juzgar: que lo que el adaptador EMITIDO entrega por SMTP llegue al buzón tal como el arnés
// EMITIDO lo lee. Mide las dos partes y el adjunto, el remitente de respaldo, el Reply-To fijo y la cabecera propia; un
// cuerpo con acentos y comillas byte a byte; el escapado de la tabla cerrada llegando así al buzón; el asunto saneado;
// el rechazo PARCIAL (sale para el aceptado, y el adaptador lanza diciendo a quién); el rechazo total del relay y su
// vuelta; que dos envíos se cuenten como dos; y el renderizador: marcadores literales, Compile que rechaza, la caché por
// parte.
//
// No es una prueba del proyecto generado: la compila y la ejecuta `npm run mail-check`. La clase hereda de la parte de
// FlowTest que declara Mail.cs (la única que se compila aquí): los helpers son los que usan los flujos.

using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using NotificationMailer.Application.Ports;
using NotificationMailer.Domain.Mail;
using NotificationMailer.Infrastructure.Mail;
using NotificationMailer.IntegrationTests.Support;
using Xunit;

namespace MailProbes;

// Los casos comparten un buzón y son de UNA clase: xUnit los ejecuta uno detrás de otro, y cada uno escribe a sus
// propias direcciones.
public sealed class MailProbes : FlowTest
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    /// <summary>El adaptador emitido, con la configuración del perfil local apuntando a este Mailpit.</summary>
    private static readonly SmtpMailSender Sender = new(
        new MailSettings(
            "127.0.0.1",
            int.Parse(Environment.GetEnvironmentVariable("MAIL_CHECK_SMTP_PORT") ?? throw new InvalidOperationException("MAIL_CHECK_SMTP_PORT"), System.Globalization.CultureInfo.InvariantCulture),
            string.Empty,
            string.Empty,
            Auth: false,
            Starttls: false,
            ConnectTimeoutMs: 5000,
            ReadTimeoutMs: 5000,
            WriteTimeoutMs: 5000,
            Sender: null,
            SenderFallback: "no-reply@ejemplo.com",
            ReplyTo: "soporte@ejemplo.com"),
        NullLogger<SmtpMailSender>.Instance);

    private static readonly HandlebarsTemplateRenderer Renderer = new();

    private static Task Send(MailMessage message) => Sender.Send(message, Cancel);

    [Fact]
    public async Task ElAsuntoLasDosPartesElAdjuntoYLasCabecerasLlegan()
    {
        const string text = "Hola, Ñandú: «comillas» \"dobles\" y 'simples' — áéíóú";
        await Send(new MailMessage(
            ["ana@ejemplo.com"],
            "Bienvenida",
            "<p>Hola</p>",
            text,
            headers: new Dictionary<string, string?> { ["X-Notification-Id"] = "n-1" },
            attachments: [new MailAttachment("factura.txt", "text/plain", Encoding.UTF8.GetBytes("adjunto"))]));
        var full = await LastMailTo("ana@ejemplo.com");
        Assert.Equal("Bienvenida", MailSubject(full));
        Assert.Contains("<p>Hola</p>", MailHtml(full));
        // Byte a byte: un cuerpo que vuelve con los acentos rotos o las comillas cambiadas es un correo ilegible.
        Assert.Equal(text, MailText(full).Trim());
        // Sin remitente del dato, sale desde el de respaldo.
        Assert.Equal("no-reply@ejemplo.com", MailFrom(full));
        var replyTo = full.GetProperty("ReplyTo").EnumerateArray().Select(address => address.GetProperty("Address").GetString()).ToList();
        Assert.Contains("soporte@ejemplo.com", replyTo);
        var attachments = full.GetProperty("Attachments").EnumerateArray().Select(attachment => attachment.GetProperty("FileName").GetString()).ToList();
        Assert.Contains("factura.txt", attachments);
        var headers = await Raw($"/message/{full.GetProperty("ID").GetString()}/headers");
        var notificationId = headers.EnumerateObject().First(header => header.Name.Equals("X-Notification-Id", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(["n-1"], notificationId.Value.EnumerateArray().Select(value => value.GetString()));
    }

    [Fact]
    public async Task ElHtmlLlegaConLaTablaCerradaYElAsuntoSinEscapar()
    {
        var html = Renderer.Render(TemplatePart.Html, "saludo:v1", "<p>Hola {{ name }}</p>", new Dictionary<string, object?> { ["name"] = "O'Hara <b> & \"x\"" });
        var subject = Renderer.Render(TemplatePart.Subject, "saludo:v1", "Pedido & {{ name }}", new Dictionary<string, object?> { ["name"] = "O'Hara" });
        await Send(new MailMessage(["beto@ejemplo.com"], subject, html, "t", from: "app@ejemplo.com"));
        var escaped = await LastMailTo("beto@ejemplo.com");
        // &#39; y no &#x27;: el escapado es contrato, el mismo en los tres servidores.
        Assert.Contains("<p>Hola O&#39;Hara &lt;b&gt; &amp; &quot;x&quot;</p>", MailHtml(escaped));
        Assert.Equal("Pedido & O'Hara", MailSubject(escaped));
        // El remitente del dato manda sobre el de respaldo.
        Assert.Equal("app@ejemplo.com", MailFrom(escaped));
    }

    [Fact]
    public async Task ElAsuntoLlegaSaneadoEnUnaSolaLinea()
    {
        await Send(new MailMessage(["carla@ejemplo.com"], "Hola\r\nBcc: espia@ejemplo.com", text: "t", from: "app@ejemplo.com"));
        var injected = await LastMailTo("carla@ejemplo.com");
        Assert.Equal("Hola  Bcc: espia@ejemplo.com", MailSubject(injected));
        Assert.Equal(0, await MailCount("espia@ejemplo.com"));
    }

    [Fact]
    public async Task ElRechazoParcialLanzaDiciendoAQuienLlegoYElCorreoSale()
    {
        var error = await Assert.ThrowsAsync<MailDeliveryException>(() =>
            Send(new MailMessage(["dani@ejemplo.com", RejectedAddress("luis")], "Parcial", text: "t", from: "app@ejemplo.com")));
        Assert.True(error.Partial(), error.Message);
        Assert.Equal(["dani@ejemplo.com"], error.Accepted);
        Assert.Equal(["luis@rejected.invalid"], error.Rejected);
        Assert.Single(await AwaitMailTo("dani@ejemplo.com", 1));
    }

    [Fact]
    public async Task ConElRelayRechazandoNoHayEnvioParcialYRelayAcceptsLoDevuelve()
    {
        await RelayRejectsRecipients();
        try
        {
            var error = await Assert.ThrowsAsync<MailDeliveryException>(() => Send(new MailMessage(["eva@ejemplo.com"], "x", text: "t", from: "app@ejemplo.com")));
            Assert.False(error.Partial(), error.Message);
        }
        finally
        {
            await RelayAccepts();
        }
        await Send(new MailMessage(["eva@ejemplo.com"], "x", text: "t", from: "app@ejemplo.com"));
        Assert.Single(await AwaitMailTo("eva@ejemplo.com", 1));
    }

    [Fact]
    public async Task DosEnviosSeCuentanComoDosYLaBusquedaDiscrimina()
    {
        await Send(new MailMessage(["fede@ejemplo.com"], "uno", text: "t", from: "app@ejemplo.com"));
        await Send(new MailMessage(["fede@ejemplo.com"], "dos", text: "t", from: "app@ejemplo.com"));
        await AwaitMailTo("fede@ejemplo.com", 2);
        Assert.Equal(2, await MailCount("fede@ejemplo.com"));
        Assert.Equal(0, await MailCount("nadie@ejemplo.com"));
    }

    [Fact]
    public void UnaVariableConNombreDePalabraDelMotorSeResuelveComoVariable()
    {
        var variables = new Dictionary<string, object?> { ["if"] = "uno", ["each"] = "dos", ["this"] = "tres", ["lookup"] = "cuatro", ["firstName"] = "Ana" };
        Assert.Equal("uno dos tres cuatro Ana", Renderer.Render(TemplatePart.Text, "palabras:v1", "{{ if }} {{ each }} {{this}} {{ lookup }} {{firstName}}", variables));
    }

    [Fact]
    public void LosBloquesConservanSuSentido()
    {
        var variables = new Dictionary<string, object?> { ["vip"] = true, ["name"] = "Ana" };
        Assert.Equal("Hola VIP Ana", Renderer.Render(TemplatePart.Text, "bloque:v1", "Hola {{#if vip}}VIP{{else}}cliente{{/if}} {{ name }}", variables));
    }

    [Fact]
    public void CompileRechazaUnaPlantillaQueNoCompilaYAceptaLaQueSi()
    {
        Assert.Throws<TemplateRenderException>(() => Renderer.Compile("Hola {{#if vip}}sin cerrar"));
        Renderer.Compile("Hola {{ name }}");
    }

    [Fact]
    public void LaParteVaEnLaClaveDeLaCache()
    {
        var variables = new Dictionary<string, object?> { ["name"] = "<b>" };
        // La misma clave y la misma fuente: el texto no se escapa aunque antes se haya compilado como HTML.
        Assert.Equal("&lt;b&gt;", Renderer.Render(TemplatePart.Html, "cache:v1", "{{ name }}", variables));
        Assert.Equal("<b>", Renderer.Render(TemplatePart.Text, "cache:v1", "{{ name }}", variables));
    }

    [Fact]
    public void UnaCabeceraReservadaSeRechazaAlConstruir()
    {
        Assert.Throws<ArgumentException>(() => new MailMessage(["a@ejemplo.com"], "x", headers: new Dictionary<string, string?> { ["Bcc"] = "espia@ejemplo.com" }));
        Assert.Throws<ArgumentException>(() => new MailMessage(["a@ejemplo.com"], "x", headers: new Dictionary<string, string?> { ["Content-Type"] = "text/plain" }));
        Assert.Throws<ArgumentException>(() => new MailMessage(["a@ejemplo.com"], "x", headers: new Dictionary<string, string?> { ["X Mal"] = "v" }));
    }

    private static async Task<JsonElement> Raw(string path)
    {
        using var http = new HttpClient();
        using var document = JsonDocument.Parse(await http.GetStringAsync($"{MailHarness.Api}{path}", Cancel));
        return document.RootElement.Clone();
    }
}
