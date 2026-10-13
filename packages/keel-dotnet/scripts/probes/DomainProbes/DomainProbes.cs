// Rasgos del DOMINIO que emite keel-dotnet, juzgados EJECUTANDO el código emitido: lo que hace un value
// object con un valor fuera de su tipo, cómo normaliza una escala, qué transición niega un agregado y con
// qué código. Los mismos casos que keel-nest/test/domain.test.js, sobre las mismas fixtures compartidas.
//
// No es una prueba del proyecto generado (build no la emite): la compila y la ejecuta `cs-check` contra el
// dominio de varias fixtures a la vez, y de una variante derivada en memoria (inspection-reports con
// `scalePolicy: reject`, que ninguna fixture declara dentro de un value object).

using System.Globalization;
using System.Reflection;
using System.Text.Json;
using Xunit;
using Pc = ProductCatalog.Domain;
using Extended = global::Catalog.Domain;
using Reject = InspectionReportsReject.Domain;
using Reports = InspectionReports.Domain;
using Stock = StockReservation.Domain;

namespace DomainProbes;

public sealed class DomainProbes
{
    private static string Text(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    private static T Rejects<T>(Action action, string code, int status, string message)
        where T : Exception
    {
        var error = Assert.Throws<T>(action);
        var (actualCode, actualStatus) = error switch
        {
            Pc.Errors.DomainException e => (e.Code, e.HttpStatus),
            Reports.Errors.DomainException e => (e.Code, e.HttpStatus),
            Reject.Errors.DomainException e => (e.Code, e.HttpStatus),
            _ => (null, null)
        };
        Assert.Equal(code, actualCode);
        Assert.Equal(status, actualStatus);
        Assert.Contains(message, error.Message, StringComparison.Ordinal);
        return error;
    }

    [Fact]
    public void UnValueObjectNormalizaLaEscalaQueDeclaraSuTipo()
    {
        var money = new Pc.ValueObject.Money(12.5m, "EUR");
        Assert.Equal("12.50", Text(money.Amount));
        // Y por eso dos importes iguales con distinta escala de entrada son el mismo valor.
        Assert.Equal(money, new Pc.ValueObject.Money(12.500m, "EUR"));
        Assert.Equal(money.GetHashCode(), new Pc.ValueObject.Money(12.500m, "EUR").GetHashCode());
        Assert.NotEqual(money, new Pc.ValueObject.Money(12.51m, "EUR"));
    }

    [Fact]
    public void UnValueObjectRechazaCon400LoQueSuTipoProhibe()
    {
        Rejects<Pc.Errors.InvalidValueException>(() => _ = new Pc.ValueObject.Money(-0.01m, "EUR"), "VALIDATION_ERROR", 400, "menor que el mínimo");
        Rejects<Pc.Errors.InvalidValueException>(() => _ = new Pc.ValueObject.Money(1m, "EU"), "VALIDATION_ERROR", 400, "más corto");
        Rejects<Pc.Errors.InvalidValueException>(() => _ = new Pc.ValueObject.Money(1m, "EURO"), "VALIDATION_ERROR", 400, "más largo");
        Rejects<Pc.Errors.InvalidValueException>(() => _ = new Pc.ValueObject.Money(1m, null!), "VALIDATION_ERROR", 400, "Money.currency es obligatorio");
    }

    [Fact]
    public void UnValueObjectAnidadoComparaPorValorATravesDeSuContenedor()
    {
        var here = new Reports.ValueObject.Location(new Reports.ValueObject.GeoPoint(40.4168m, -3.7038m), "Madrid");
        Assert.Equal("40.416800", Text(here.Coords.Latitude));
        Assert.Equal(here, new Reports.ValueObject.Location(new Reports.ValueObject.GeoPoint(40.416800m, -3.7038m), "Madrid"));
        Assert.NotEqual(here, new Reports.ValueObject.Location(new Reports.ValueObject.GeoPoint(40.4168m, -3.7038m), "Toledo"));
        Rejects<Reports.Errors.InvalidValueException>(
            () => _ = new Reports.ValueObject.GeoPoint(90.000001m, 0m), "VALIDATION_ERROR", 400, "mayor que el máximo declarado por su tipo (90)");
    }

    [Fact]
    public void ConScalePolicyRejectSeRechazanLosDecimalesDeMasEnVezDeRedondear()
    {
        Assert.Equal("40.416800", Text(new Reject.ValueObject.GeoPoint(40.4168000m, 0m).Latitude));
        Rejects<Reject.Errors.InvalidValueException>(
            () => _ = new Reject.ValueObject.GeoPoint(40.1234567m, 0m), "VALIDATION_ERROR", 400, "como mucho 6 decimales");
        // La longitud sigue con round (la mitad, lejos del cero): la política es del campo.
        Assert.Equal("-3.123457", Text(new Reject.ValueObject.GeoPoint(1m, -3.12345678m).Longitude));
    }

    [Fact]
    public void LaClaseFormatDeUnEscalarJuzgaElValorEnteroYToleraElVacio()
    {
        Assert.True(Pc.ValueObject.SKUFormat.Matches("ABC-1234"));
        Assert.False(Pc.ValueObject.SKUFormat.Matches("abc-1234"));
        Assert.False(Pc.ValueObject.SKUFormat.Matches("XABC-1234"));
        // El `$` de .NET casa antes de un salto final; el valor ENTERO es el `\z`.
        Assert.False(Pc.ValueObject.SKUFormat.Matches("ABC-1234\n"));
        Assert.True(Pc.ValueObject.SKUFormat.Matches(null));
        Assert.True(Pc.ValueObject.SKUFormat.Matches("  "));
        Rejects<Pc.Errors.ValueFormatException>(() => Pc.ValueObject.SKUFormat.Validate("ABC-12"), "VALIDATION_ERROR", 400, "formato declarado por SKU");
    }

    [Fact]
    public void UnEnumViajaPorElValorDelDisenoNoPorElNombreDelMiembro() =>
        Assert.Equal(
            """{"status":"draft"}""",
            JsonSerializer.Serialize(new { status = Pc.Enums.ProductStatus.Draft }, ProductCatalog.Application.Support.WireJson.Options));

    private static Pc.Aggregate.Product Lamp() =>
        new(new Pc.Aggregate.ProductState
        {
            Id = Guid.CreateVersion7(),
            Sku = "ABC-1234",
            Name = "Lámpara",
            Notes = null,
            Price = new Pc.ValueObject.Money(10m, "EUR"),
            ApiToken = null,
            Status = Pc.Enums.ProductStatus.Draft,
            LockVersion = null
        });

    private static void TransitionTo(object aggregate, object target)
    {
        var method = aggregate.GetType().GetMethod("TransitionTo", BindingFlags.Instance | BindingFlags.NonPublic)!;
        try
        {
            method.Invoke(aggregate, [target]);
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            throw error.InnerException;
        }
    }

    [Fact]
    public void ElAgregadoRehidrataSinSettersPublicosYNiegaLaTransicionNoDeclaradaCon409()
    {
        var product = Lamp();
        Assert.Equal("ABC-1234", product.Sku);
        Assert.Equal(Pc.Enums.ProductStatus.Draft, product.Status);
        Assert.False(typeof(Pc.Aggregate.Product).GetProperty("Status")!.SetMethod!.IsPublic, "el estado no se asigna desde fuera");
        TransitionTo(product, Pc.Enums.ProductStatus.Retired);
        Assert.Equal(Pc.Enums.ProductStatus.Retired, product.Status);
        Rejects<Pc.Errors.InvalidStateTransitionException>(
            () => TransitionTo(product, Pc.Enums.ProductStatus.Active), "INVALID_STATE_TRANSITION", 409, "Retired -> Active");
    }

    [Fact]
    public void LasColeccionesDelAgregadoNoSeCambianDesdeFuera()
    {
        var source = new List<Extended.Entity.ProductImage>();
        var product = new Extended.Aggregate.Product(new Extended.Aggregate.ProductState
        {
            Id = Guid.CreateVersion7(),
            Sku = "ABC-1234",
            Name = "Lámpara",
            Status = Extended.Enums.ProductStatus.Draft,
            Version = 1,
            CreatedAt = DateTimeOffset.UtcNow,
            RecordWithdrawalAwaitingSince = null,
            CategoryId = Guid.CreateVersion7(),
            Images = source,
            LockVersion = null
        });
        Assert.Throws<NotSupportedException>(() => ((IList<Extended.Entity.ProductImage>)product.Images).Add(null!));
        source.Add(null!);
        Assert.Empty(product.Images);
    }

    [Fact]
    public void LaEventMetadataLlevaLasClavesEnElOrdenDelCable()
    {
        var metadata = Stock.Events.EventMetadata.Now("StockReserved");
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(metadata, StockReservation.Application.Support.WireJson.Options));
        Assert.Equal(
            ["eventId", "eventType", "eventVersion", "occurredAt", "source", "correlationId", "traceparent"],
            json.RootElement.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal("stock-reservation", metadata.Source);
        Assert.Equal(metadata.EventId, metadata.WithCorrelationId("c-1").EventId);
    }

    [Fact]
    public void UnaClaseBaseDeErrorRespondeConSuStatusSiNadieLoDice() =>
        Assert.Equal(404, new Pc.Errors.NotFoundException("no está").HttpStatus);

    [Fact]
    public void ConScalePolicyRoundElMensajeRedondeaYSubeLaEscalaAlEntrar()
    {
        static PaymentCheckoutRound.Application.Commands.RequestChargeCommand Charge(decimal amount) => new()
        {
            ChargeRequestId = "c-1",
            OrderId = "o-1",
            PayerId = "p-1",
            Amount = amount,
            PaymentToken = null,
            PaymentMethodRef = null
        };
        Assert.Equal("10.01", Text(Charge(10.005m).Amount));
        Assert.Equal("10.50", Text(Charge(10.5m).Amount));
        // El opcional: null entra, null sale; con valor, se redondea igual.
        var refund = new PaymentCheckoutRound.Application.Commands.RefundPaymentCommand { ChargeRequestId = "c-1", Amount = null };
        Assert.Null(refund.Amount);
        Assert.Equal("3.00", Text(new PaymentCheckoutRound.Application.Commands.RefundPaymentCommand { ChargeRequestId = "c-1", Amount = 3m }.Amount!.Value));
    }
}
