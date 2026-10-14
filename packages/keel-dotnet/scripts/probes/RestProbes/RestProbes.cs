// La lectura de peticiones que emite keel-dotnet (Application/Support/JsonReading.cs e InputValidation.cs, y Api/Rest/RequestReading.cs), EJECUTADA:
// convierte lo que llega como lo convierte Spring y valida con los mensajes de Bean Validation. Un servidor que
// aceptara `?active=yes` y otro que respondiera 400 al mismo diseño no serían equivalentes, y eso no lo ve ninguna
// comparación de cadenas. Los mismos casos que keel-nest/test/rest.test.js, sobre la misma fixture.
//
// No es una prueba del proyecto generado (build no la emite): la compila y la ejecuta `cs-check` junto a las
// fixtures.

using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Primitives;
using ProductCatalog.Api.Rest;
using ProductCatalog.Application.Support;
using ProductCatalog.Domain.Enums;
using Xunit;

namespace RestProbes;

public sealed class RestProbes
{
    private static void Malformed(Action action) => Assert.Throws<MalformedRequestException>(action);

    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    [Fact]
    public void UnBooleanoDeQueryAdmiteLoQueAdmiteSpringYVacioEsSinValor()
    {
        foreach (var value in new[] { "true", "ON", "yes", "1" })
        {
            Assert.True(TextValues.Bool(value));
        }
        foreach (var value in new[] { "false", "Off", "no", "0" })
        {
            Assert.False(TextValues.Bool(value));
        }
        Assert.Null(TextValues.Bool(""));
        Assert.Null(TextValues.Bool(StringValues.Empty));
        Malformed(() => TextValues.Bool("quizá"));
    }

    [Fact]
    public void UnUuidDeRutaSeLeeComoUuidFromStringDeJavaYEnElCuerpoSoloCanonico()
    {
        Assert.Equal(Guid.Parse("0192f1d2-0000-7000-8000-000000000001"), TextValues.Uuid("0192F1D2-0000-7000-8000-000000000001"));
        Assert.Equal(Guid.Parse("00000001-0002-0003-0004-000000000005"), TextValues.Uuid("1-2-3-4-5"));
        Malformed(() => TextValues.Uuid("no-es-un-uuid"));
        Malformed(() => TextValues.Uuid("123456789-0000-7000-8000-000000000001"));
        var body = Json("""{"canonical":"0192F1D2-0000-7000-8000-000000000001","short":"1-2-3-4-5","number":42}""");
        Assert.Equal(Guid.Parse("0192f1d2-0000-7000-8000-000000000001"), JsonBodyReader.Value<Guid?>(body, "canonical"));
        Malformed(() => JsonBodyReader.Value<Guid?>(body, "short"));
        Malformed(() => JsonBodyReader.Value<Guid?>(body, "number"));
    }

    [Fact]
    public void UnEnumSeLeePorSuLiteralEnElCuerpoYEnLaQueryTambienPorElNombreDeLaConstante()
    {
        var body = Json("""{"literal":"active","constant":"ACTIVE","other":"Active"}""");
        Assert.Equal(ProductStatus.Active, JsonBodyReader.EnumValue<ProductStatus>(body, "literal"));
        Malformed(() => JsonBodyReader.EnumValue<ProductStatus>(body, "constant"));
        Malformed(() => JsonBodyReader.EnumValue<ProductStatus>(body, "other"));
        Assert.Equal(ProductStatus.Active, TextValues.EnumValue<ProductStatus>("ACTIVE"));
        Assert.Equal(ProductStatus.Retired, TextValues.EnumValue<ProductStatus>("retired"));
        Malformed(() => TextValues.EnumValue<ProductStatus>("borrado"));
    }

    [Fact]
    public void UnEnteroDeQueryFueraDeInt32OConDecimalesEsMalformadoYUnLongCabeEn64Bits()
    {
        Assert.Equal(int.MinValue, TextValues.Int("-2147483648"));
        Malformed(() => TextValues.Int("2147483648"));
        Malformed(() => TextValues.Int("1.5"));
        Assert.Equal(long.MaxValue, TextValues.Long("9223372036854775807"));
        Malformed(() => TextValues.Long("9223372036854775808"));
    }

    [Fact]
    public void ElDecimalDeQueryConservaSuEscalaYNoRedondeaEnSilencio()
    {
        Assert.Equal("2.50", TextValues.Decimal("2.50")!.Value.ToString(CultureInfo.InvariantCulture));
        Malformed(() => TextValues.Decimal("1E-40"));
        Malformed(() => TextValues.Decimal("dos"));
    }

    [Fact]
    public void UnTipoQueNoEncajaEnElCuerpoEsMalformado()
    {
        var body = Json("""{"text":3,"flag":"true","list":"no-es-lista","items":[1,null]}""");
        Malformed(() => JsonBodyReader.Value<string?>(body, "text"));
        Malformed(() => JsonBodyReader.Value<bool?>(body, "flag"));
        Malformed(() => JsonBodyReader.List(body, "list", JsonBodyReader.Element<int>));
        Malformed(() => JsonBodyReader.List(body, "items", JsonBodyReader.Element<int>));
        Assert.Null(JsonBodyReader.Value<string?>(body, "absent"));
        Assert.False(JsonBodyReader.Has(body, "absent"));
    }

    [Fact]
    public void FaltaUnParametroObligatorioSoloSiNoVieneYVacioCuentaComoPresente()
    {
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        context.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?q=");
        TextValues.Require(context.Request, "q");
        var error = Assert.Throws<MissingParameterException>(() => TextValues.Require(context.Request, "other"));
        Assert.Equal("Falta el parámetro 'other' en la petición", error.Message);
    }

    [Fact]
    public void LasViolacionesSalenTodasJuntasCampoMensajeConLosMensajesDeHibernateValidator()
    {
        var violations = new InputViolations(ViolationSource.Body);
        violations.Check("sku", "  ", InputRule.NotBlank, InputRule.Size(null, 8));
        violations.Check("name", new string('x', 10), InputRule.Size(2, 5));
        violations.Check("code", "abc", InputRule.Pattern("[A-Z]+"));
        violations.Check("price", null, InputRule.NotNull);
        violations.Check("tags", Array.Empty<string>(), InputRule.NotEmpty);
        violations.Check("quantity", 0, InputRule.Min("1"));
        violations.Check("amount", 100.50m, InputRule.Max("100"));
        violations.Check("total", 1.234m, InputRule.Digits(17, 2));
        violations.Check("ok", "ABC", InputRule.Pattern("[A-Z]+"));
        violations.CheckEach("labels", new[] { "ok", new string('x', 41) }, InputRule.Size(0, 40));
        var error = Assert.Throws<RequestValidationException>(violations.ThrowIfAny);
        Assert.Equal(ViolationSource.Body, error.Origin);
        Assert.Equal(
            [
                "sku must not be blank",
                "name size must be between 2 and 5",
                "code must match \"[A-Z]+\"",
                "price must not be null",
                "tags must not be empty",
                "quantity must be greater than or equal to 1",
                "amount must be less than or equal to 100",
                "total numeric value out of bounds (<17 digits>.<2 digits> expected)",
                "labels[1] size must be between 0 and 40"
            ],
            error.Details);
    }

    [Fact]
    public void UnValorAusenteNoViolaMasReglaQueLaDePresencia()
    {
        var violations = new InputViolations(ViolationSource.Params);
        violations.Check("q", null, InputRule.Size(3, 5), InputRule.Pattern("x"), InputRule.Min("1"));
        violations.ThrowIfAny();
    }

    [Fact]
    public void UnPatronCasaEnteroComoElMatchesDeJavaSinElSaltoFinal()
    {
        var violations = new InputViolations(ViolationSource.Body);
        violations.Check("sku", "ABC-1234\n", InputRule.Pattern("^[A-Z]{3}-[0-9]{4}$"));
        violations.Check("partial", "xABC", InputRule.Pattern("ABC"));
        Assert.Equal(2, Assert.Throws<RequestValidationException>(violations.ThrowIfAny).Details.Count);
    }

    [Fact]
    public void UnValueObjectDelCuerpoQueSuConstructorRechazaEsUnaPeticionMalformada()
    {
        var money = ValueReaders.ReadMoney(Json("""{"amount":3,"currency":"EUR"}"""));
        Assert.Equal("3.00", money!.Amount.ToString(CultureInfo.InvariantCulture));
        Malformed(() => ValueReaders.ReadMoney(Json("""{"amount":3}""")));
        Malformed(() => ValueReaders.ReadMoney(Json("""{"amount":-1,"currency":"EUR"}""")));
        Malformed(() => ValueReaders.ReadMoney(Json("\"3 EUR\"")));
        Assert.Null(ValueReaders.ReadMoney(null));
    }

    [Fact]
    public void LocationExpandeLaRutaDeLecturaConElEsquemaYElHostDeLaPeticion()
    {
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        context.Request.Scheme = "http";
        context.Request.Host = new Microsoft.AspNetCore.Http.HostString("localhost", 8080);
        var id = Guid.Parse("0192f1d2-0000-7000-8000-000000000001");
        Assert.Equal("http://localhost:8080/api/v1/products/0192f1d2-0000-7000-8000-000000000001", HttpReply.Location(context.Request, "/api/v1/products/{id}", id));
    }
}
