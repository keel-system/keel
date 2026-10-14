// El arnés del proveedor de prueba y el adaptador saliente de keel-dotnet contra un WireMock REAL (incremento 11d).
//
// Lo que la prueba emitida OutboundClientsTests no puede juzgar —allí el proveedor es un HttpMessageHandler falso—: que
// lo que programan los helpers de Support/HttpStub.cs lo ENTIENDA el stub de verdad (un mapping mal formado lo rechaza;
// uno bien formado que no casa no falla nada), y que el corte de conexión, el retraso y la secuencia de WireMock lleguen
// a HttpClient como el arnés promete: transporte, timeout, la segunda respuesta. Los mismos casos que el stub-check de
// keel-nest, sobre stock-reservation.
//
// No es una prueba del proyecto generado: la compila y la ejecuta `npm run stub-check`. La clase hereda de la parte de
// FlowTest que declara HttpStub.cs (la única que se compila aquí): los helpers son los que usan los flujos.

using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using StockReservation.Domain.Clients;
using StockReservation.Infrastructure.Clients;
using StockReservation.Infrastructure.Config;
using StockReservation.IntegrationTests.Support;
using Xunit;

namespace StubProbes;

public sealed class StubProbes : FlowTest, IAsyncLifetime
{
    private const string Route = "/stock/reservations/.*";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    // Un adaptador por caso: el circuito vive lo que su adaptador, y un caso no hereda el del anterior.
    private readonly IInventoryClient inventory = Adapter();

    public async ValueTask InitializeAsync() => await ResetStubs();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    /// <summary>El adaptador emitido, con la configuración del perfil develop apuntando a este WireMock.</summary>
    private static InventoryHttpAdapter Adapter()
    {
        var root = Environment.GetEnvironmentVariable("STUB_CHECK_PROJECT") ?? throw new InvalidOperationException("STUB_CHECK_PROJECT: la raíz del proyecto generado");
        var baseUrl = Environment.GetEnvironmentVariable("STUB_CHECK_BASE_URL") ?? throw new InvalidOperationException("STUB_CHECK_BASE_URL: la URL del WireMock");
        var configuration = ServiceConfiguration.Load(name => name switch
        {
            "PROFILE" => "develop",
            "INVENTORY_BASE_URL" => baseUrl,
            _ => null
        }, root);
        return new InventoryHttpAdapter(HttpClientsSettings.From(configuration), new InventoryMapper(), new HttpExchange(HttpExchange.DefaultHandler()), NullLogger<InventoryHttpAdapter>.Instance);
    }

    private static async Task<IReadOnlyList<string?>> Keys() =>
        (await StubRequests("DELETE", Route)).Select(request => StubRequestHeader(request, "idempotency-key")).ToList();

    [Fact]
    public async Task LoProgramadoLlegaAlAdaptadorYElProveedorRegistraLaPeticion()
    {
        await StubFor("DELETE", Route, 200, new { cancelled = true });
        var result = await inventory.CancelStock(Guid.CreateVersion7(), Cancel);
        Assert.True(result.Cancelled);
        Assert.Equal(1, await StubCallCount("DELETE", Route));
        var request = Assert.Single(await StubRequests("DELETE", Route));
        Assert.Equal("DELETE", request.Method);
        Assert.StartsWith("/stock/reservations/", request.Url, StringComparison.Ordinal);
        // La cabecera, sin distinguir mayúsculas: el caso lo decide el cliente HTTP.
        Assert.False(string.IsNullOrWhiteSpace(StubRequestHeader(request, "IDEMPOTENCY-KEY")));
        Assert.Null(StubRequestBody(request));
    }

    [Fact]
    public async Task ElCorteDeConexionEsTransporteYSeReintentaConLaMismaClave()
    {
        await StubConnectionFault("DELETE", Route);
        var result = await inventory.CancelStock(Guid.CreateVersion7(), Cancel);
        // onFailure: ignore — el fallback devuelve el resultado neutro.
        Assert.Null(result.Cancelled);
        var keys = await Keys();
        Assert.Equal(3, keys.Count);
        Assert.Single(keys.Distinct());
    }

    /// <summary>
    /// SocketsHttpHandler reenvía por su cuenta una petición cuya conexión REUTILIZADA se corta antes de la respuesta. Tras
    /// una llamada buena, el corte siguiente tiene que llegar al proveedor exactamente tantas veces como intentos declara
    /// la política: ni una más por debajo del retry del diseño.
    /// </summary>
    [Fact]
    public async Task UnaConexionQueSeCortaNoSeReenviaPorDebajoDelRetry()
    {
        await StubFor("DELETE", Route, 200, new { cancelled = true });
        Assert.True((await inventory.CancelStock(Guid.CreateVersion7(), Cancel)).Cancelled);
        await ResetStubs();
        await StubConnectionFault("DELETE", Route);
        await inventory.CancelStock(Guid.CreateVersion7(), Cancel);
        Assert.Equal(3, await StubCallCount("DELETE", Route));
    }

    [Fact]
    public async Task ElRetrasoPorEncimaDelTimeoutEsTransporteYSeReintenta()
    {
        // 3500 ms sobre el timeoutMs de 3000 de cancelStock.
        await StubTimeout("DELETE", Route, 3500);
        var result = await inventory.CancelStock(Guid.CreateVersion7(), Cancel);
        Assert.Null(result.Cancelled);
        Assert.Equal(3, await StubCallCount("DELETE", Route));
    }

    [Fact]
    public async Task LaSecuenciaEntregaLaSegundaRespuestaConLaMismaClaveYSeQuedaPegada()
    {
        await StubSequence("DELETE", Route, StubResponse.ConnectionFault(), StubResponse.Ok(200, new { cancelled = true }));
        var order = Guid.CreateVersion7();
        Assert.True((await inventory.CancelStock(order, Cancel)).Cancelled);
        var keys = await Keys();
        Assert.Equal(2, keys.Count);
        Assert.Single(keys.Distinct());
        // La última se queda pegada: una llamada de más vuelve a recibirla.
        Assert.True((await inventory.CancelStock(order, Cancel)).Cancelled);
        Assert.Equal(3, await StubCallCount("DELETE", Route));
        // Una ruta admite UNA secuencia por flujo.
        await Assert.ThrowsAsync<InvalidOperationException>(() => StubSequence("DELETE", Route, StubResponse.Failure(503), StubResponse.Failure(500)));
    }

    [Fact]
    public async Task DiezFallosAbrenElCircuitoYLaSiguienteNiSale()
    {
        await StubFailure("DELETE", Route, 503);
        // El 5xx no se reintenta (retryOn: [timeout, connection]): diez llamadas, diez peticiones, y el circuito se abre.
        for (var i = 0; i < 10; i++)
        {
            Assert.Null((await inventory.CancelStock(Guid.CreateVersion7(), Cancel)).Cancelled);
        }
        Assert.Equal(10, await StubCallCount("DELETE", Route));
        Assert.Null((await inventory.CancelStock(Guid.CreateVersion7(), Cancel)).Cancelled);
        Assert.Equal(10, await StubCallCount("DELETE", Route));
    }

    [Fact]
    public async Task UnRechazoNoSeReintentaYCaeAlFallback()
    {
        await StubFailure("DELETE", Route, 404);
        Assert.Null((await inventory.CancelStock(Guid.CreateVersion7(), Cancel)).Cancelled);
        Assert.Equal(1, await StubCallCount("DELETE", Route));
    }

    [Fact]
    public async Task UnCuerpoQueViolaElContratoSePropagaYNoEsUnaCaida()
    {
        await StubFor("DELETE", Route, 200, "<html>");
        await Assert.ThrowsAsync<OutboundContractException>(() => inventory.CancelStock(Guid.CreateVersion7(), Cancel));
        await StubFor("DELETE", Route, 200, new { cancelled = "sí" });
        await Assert.ThrowsAsync<OutboundContractException>(() => inventory.CancelStock(Guid.CreateVersion7(), Cancel));
        Assert.Equal(2, await StubCallCount("DELETE", Route));
    }

    [Fact]
    public async Task ElResetVaciaLosMappingsYElLog()
    {
        await StubFor("DELETE", Route, 200, new { cancelled = true });
        await inventory.CancelStock(Guid.CreateVersion7(), Cancel);
        Assert.Equal(1, await StubCallCount("DELETE", Route));
        await ResetStubs();
        Assert.Equal(0, await StubCallCount("DELETE", Route));
        // Sin mapping, el stub contesta 404: el adaptador lo trata como rechazo.
        Assert.Null((await inventory.CancelStock(Guid.CreateVersion7(), Cancel)).Cancelled);
    }

    [Fact]
    public void ElCuerpoDeUnaPeticionSeLeeComoJson()
    {
        var request = new StubRequest("/x", "POST", new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), """{"a":1}""");
        Assert.Equal(1, StubRequestBody(request)!.Value.GetProperty("a").GetInt32());
        Assert.Equal(JsonValueKind.Object, StubRequestBody(request)!.Value.ValueKind);
    }
}
