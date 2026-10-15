// La pasarela de pago de prueba de keel-dotnet contra un WireMock REAL (incremento 13d), con las dos pasarelas.
//
// Lo que la prueba emitida PaymentGatewayTests no puede juzgar —allí la pasarela es un HttpMessageHandler falso con las
// formas del doble—: que lo que programan los helpers de Support/PaymentGateway.cs lo ENTIENDA el stub de verdad y que lo
// que el stub devuelve sea lo que lee el adaptador emitido. Cada helper, su desenlace: el cobro casado por la referencia
// en el cuerpo, la consulta por id y por referencia, la captura, la anulación, la devolución, guardar un medio, el corte,
// el rechazo; y el aviso que firma el arnés lo acepta el verificador emitido, y el falsificado no.
//
// Es NEUTRAL: el mismo archivo para las dos pasarelas (stub-check lo compila una vez por pasarela), y la pasarela la elige
// el registro emitido (AddPayments). No es una prueba del proyecto generado: la compila y la ejecuta `npm run stub-check`.

using Microsoft.Extensions.DependencyInjection;
using PaymentCheckout.Application.Ports;
using PaymentCheckout.Domain.Enums;
using PaymentCheckout.Domain.Payment;
using PaymentCheckout.Infrastructure.Payment;
using PaymentCheckout.IntegrationTests.Support;
using Xunit;

namespace PaymentProbes;

public sealed class PaymentProbes : FlowTest, IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly ServiceProvider services = Services();

    private IPaymentGateway Gateway => services.GetRequiredService<IPaymentGateway>();

    public async ValueTask InitializeAsync() => await ResetStubs();

    public async ValueTask DisposeAsync() => await services.DisposeAsync();

    /// <summary>El registro emitido, con la pasarela apuntando a este WireMock y el secreto con el que firma el arnés.</summary>
    private static ServiceProvider Services()
    {
        var baseUrl = Environment.GetEnvironmentVariable("STUB_CHECK_BASE_URL") ?? throw new InvalidOperationException("STUB_CHECK_BASE_URL: la URL del WireMock");
        var settings = new PaymentGatewaySettings(baseUrl, "keel-test-api-key", "keel-test-webhook-secret", TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), 300, 900, 50);
        return new ServiceCollection().AddPayments(settings).BuildServiceProvider();
    }

    private static ChargeRequest Charge(string reference) => new(reference, 25.90m, "BRL", PaymentSource.Token("tok_keel"));

    [Fact]
    public async Task CadaCobroCasaPorSuReferenciaYLlevaSuClave()
    {
        await GatewayAuthorizes("ch-a");
        await GatewayDeclines("ch-b", "insufficientFunds");
        var authorized = await Gateway.Authorize(Charge("ch-a"), Cancel);
        Assert.Equal(GatewayStatus.Authorized, authorized.Status);
        Assert.Equal(GatewayIdFor("ch-a"), authorized.GatewayPaymentId);
        Assert.Equal("ch-a", authorized.Reference);
        var declined = await Gateway.Authorize(Charge("ch-b"), Cancel);
        Assert.Equal(GatewayStatus.Failed, declined.Status);
        Assert.Equal(PaymentFailureReason.InsufficientFunds, declined.FailureReason);
        var requests = await GatewayRequests(GatewayCall.Charge);
        Assert.Equal(2, requests.Count);
        Assert.Contains(requests, request => StubRequestHeader(request, "x-idempotency-key") == "ch-a:authorize" || StubRequestHeader(request, "idempotency-key") == "ch-a:authorize");
    }

    [Fact]
    public async Task ElCobroInmediatoYLaAccionDelCliente()
    {
        await GatewayCharges("ch-c");
        await GatewayRequiresAction("ch-d");
        Assert.Equal(GatewayStatus.Captured, (await Gateway.Authorize(Charge("ch-c"), Cancel)).Status);
        var action = await Gateway.Authorize(Charge("ch-d"), Cancel);
        Assert.Equal(GatewayStatus.ActionRequired, action.Status);
        Assert.False(string.IsNullOrEmpty(action.CustomerAction));
    }

    [Theory]
    [InlineData("declined", PaymentFailureReason.Declined)]
    [InlineData("expiredCard", PaymentFailureReason.ExpiredCard)]
    [InlineData("authenticationFailed", PaymentFailureReason.AuthenticationFailed)]
    [InlineData("fraudSuspected", PaymentFailureReason.FraudSuspected)]
    [InlineData("invalidPaymentMethod", PaymentFailureReason.InvalidPaymentMethod)]
    [InlineData("processingError", PaymentFailureReason.ProcessingError)]
    public async Task CadaMotivoDelArnesVuelveComoEseMotivo(string reason, PaymentFailureReason expected)
    {
        await GatewayDeclines("ch-r", reason);
        var outcome = await Gateway.Authorize(Charge("ch-r"), Cancel);
        Assert.Equal(GatewayStatus.Failed, outcome.Status);
        Assert.Equal(expected, outcome.FailureReason);
    }

    [Fact]
    public async Task SinRespuestaLaAccionQuedaEnDudaYNoSeRepite()
    {
        await GatewayDoesNotAnswer(GatewayCall.Charge);
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway.Authorize(Charge("ch-e"), Cancel));
        Assert.Equal(1, await GatewayCallCount(GatewayCall.Charge));
    }

    [Fact]
    public async Task LaConsultaPorIdYPorReferenciaDicenLoProgramado()
    {
        await GatewayReports("ch-f", "CAPTURED");
        Assert.Equal(GatewayStatus.Captured, (await Gateway.Status(null, GatewayIdFor("ch-f"), Cancel)).Status);
        var byReference = await Gateway.Status("ch-f", null, Cancel);
        Assert.Equal(GatewayStatus.Captured, byReference.Status);
        Assert.Equal(GatewayIdFor("ch-f"), byReference.GatewayPaymentId);
        await GatewayReports("ch-g", "NOT_FOUND");
        Assert.Equal(GatewayStatus.NotFound, (await Gateway.Status(null, GatewayIdFor("ch-g"), Cancel)).Status);
        Assert.Equal(GatewayStatus.NotFound, (await Gateway.Status("ch-g", null, Cancel)).Status);
        await GatewayReports("ch-h", "REFUNDED");
        var refunded = await Gateway.Status(null, GatewayIdFor("ch-h"), Cancel);
        Assert.Equal(GatewayStatus.Refunded, refunded.Status);
        Assert.Equal(10.00m, refunded.RefundedAmount);
    }

    [Fact]
    public async Task CapturaAnulacionYAutorizacionCaducada()
    {
        await GatewayCaptures("ch-i");
        Assert.Equal(GatewayStatus.Captured, (await Gateway.Capture("ch-i", GatewayIdFor("ch-i"), Cancel)).Status);
        await GatewayCancels("ch-j");
        Assert.Equal(GatewayStatus.Canceled, (await Gateway.VoidAuthorization("ch-j", GatewayIdFor("ch-j"), Cancel)).Status);
        await GatewayExpiresAuthorization("ch-k");
        Assert.Equal(GatewayStatus.Canceled, (await Gateway.Capture("ch-k", GatewayIdFor("ch-k"), Cancel)).Status);
    }

    [Fact]
    public async Task LaDevolucionParcialSeCompletaPorSuImporte()
    {
        await GatewayRefunds("ch-l", "5.00");
        var outcome = await Gateway.Refund("ch-l", GatewayIdFor("ch-l"), 5.00m, "BRL", Cancel);
        Assert.Equal(GatewayStatus.Refunded, outcome.Status);
        Assert.Equal(5.00m, outcome.RefundedAmount);
    }

    [Fact]
    public async Task GuardarUnMedioYSuRechazo()
    {
        await GatewaySavesPaymentMethod();
        Assert.StartsWith("cus_keel_test|", await Gateway.SavePaymentMethod("tok_keel", "payer-1", Cancel), StringComparison.Ordinal);
        await ResetStubs();
        await GatewayRejects(GatewayCall.SaveMethod);
        await Assert.ThrowsAsync<GatewayRejectedPaymentMethodException>(() => Gateway.SavePaymentMethod("tok_keel", "payer-1", Cancel));
    }

    [Fact]
    public void ElAvisoQueFirmaElArnesLoAceptaElVerificadorYElFalsificadoNo()
    {
        var verifier = services.GetRequiredService<IPaymentNoticeVerifier>();
        Assert.Equal(GatewayIdFor("ch-m"), verifier.Verify(Received(PaymentGatewayHarness.Notice("ch-m", forged: false))));
        Assert.Throws<InvalidPaymentNoticeException>(() => verifier.Verify(Received(PaymentGatewayHarness.Notice("ch-m", forged: true))));
    }

    /// <summary>El aviso como lo recibe el endpoint: el cuerpo, las cabeceras y los parámetros de la URL.</summary>
    private static PaymentNotice Received(GatewayNotice notice)
    {
        IEnumerable<KeyValuePair<string, string?>> query = notice.Path.Contains('?', StringComparison.Ordinal)
            ? notice.Path[(notice.Path.IndexOf('?', StringComparison.Ordinal) + 1)..].Split('&').Select(pair => pair.Split('=', 2)).Select(pair => new KeyValuePair<string, string?>(Uri.UnescapeDataString(pair[0]), Uri.UnescapeDataString(pair[1])))
            : [];
        return PaymentNotice.Of(notice.Body, notice.Headers.Select(header => new KeyValuePair<string, string?>(header.Key, header.Value)), query);
    }
}
