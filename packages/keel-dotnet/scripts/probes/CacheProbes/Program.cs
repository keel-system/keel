// La caché de lectura de keel-dotnet contra un Redis o un Valkey REALES (incremento 13f): el store (StackExchange.Redis
// con la configuración que emite build) y el adaptador de catalog-extended, emitidos. Lo que OperationCacheTests no puede
// juzgar, porque allí el store es un diccionario: que el cliente guarde y lea en el servidor de verdad lo que el adaptador
// cree, y que una caché CAÍDA no retenga a quien lee. Los mismos pasos que el cache-check de keel-nest.
//
// No es una prueba del proyecto generado: la compila y la ejecuta `npm run cache-check`, que le pasa por el entorno el
// puerto, el runtime de contenedores, el contenedor y la orden de vaciado de infra/reset-db.sh.

using System.Diagnostics;
using System.Text.Json;
using Catalog.Application.Dtos;
using Catalog.Application.Support;
using Catalog.Domain.Enums;
using Catalog.Infrastructure.Cache;
using Microsoft.Extensions.Logging.Abstractions;

var port = int.Parse(Required("CACHE_CHECK_PORT"), System.Globalization.CultureInfo.InvariantCulture);
var runtime = Required("CACHE_CHECK_RUNTIME");
var container = Required("CACHE_CHECK_CONTAINER");
var flush = Required("CACHE_CHECK_FLUSH");
var service = Required("CACHE_CHECK_SERVICE");
var failures = 0;
const string Slug = "sillas";

void Step(string name, bool ok, string detail = "")
{
    if (!ok)
    {
        failures++;
    }
    Console.WriteLine($"{(ok ? "OK   " : "FALLA")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
}

string Exec(params string[] arguments)
{
    var info = new ProcessStartInfo(runtime) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    foreach (var argument in arguments)
    {
        info.ArgumentList.Add(argument);
    }
    using var process = Process.Start(info)!;
    var output = process.StandardOutput.ReadToEnd();
    process.StandardError.ReadToEnd();
    process.WaitForExit();
    return output.TrimEnd('\r', '\n');
}

string Cli(params string[] arguments) => Exec(["exec", container, "redis-cli", .. arguments]);

// Una ficha como la construiría el handler: un decimal con escala, un long que no cabe en un double, un instante y una
// cadena que no es ASCII.
var card = new GetProductBySlugResponseDto
{
    Id = Guid.Parse("0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f"),
    Sku = "SKU-1",
    Name = "Silla «Ñandú»",
    Status = Enum.GetValues<ProductStatus>()[0],
    Version = 9007199254740993,
    CreatedAt = DateTimeOffset.Parse("2026-10-09T10:11:12.345Z", System.Globalization.CultureInfo.InvariantCulture),
    CategoryId = Guid.Parse("0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e70"),
    Images = [new ProductImageDto { Id = Guid.Parse("0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e71"), StorageKey = "k/1.png", Position = 1, Primary = true, ProductId = Guid.Parse("0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f") }],
    CurrentPrice = new CurrentPriceDto { Amount = 12.50m, Currency = "EUR" },
    ProductCost = null
};
var wire = JsonSerializer.Serialize(card, WireJson.Options);

await using var store = new RedisCacheStore(new CacheSettings(true, "127.0.0.1", port, 2000, 2000), NullLogger<RedisCacheStore>.Instance);
var cache = new RedisOperationCache(new CacheState(), NullLogger<RedisOperationCache>.Instance, store);
var operation = CachedOperations.GetProductBySlug;
var key = $"{operation.Name}::{Slug}";
var loads = 0;
Task<GetProductBySlugResponseDto> Read() => cache.GetOrLoad(operation, new Catalog.Application.Queries.GetProductBySlugQuery { Slug = Slug }, _ => { loads++; return Task.FromResult(card); });

for (var attempt = 0; attempt < 40; attempt++)
{
    try
    {
        await store.Get("sonda");
        break;
    }
    catch (Exception)
    {
        await Task.Delay(250);
    }
}

await Read();
var stored = Cli("GET", key);
Step($"el miss guarda {key} con el JSON del cable", stored == wire, stored.Length > 120 ? stored[..120] : stored);
var ttl = int.Parse(Cli("TTL", key), System.Globalization.CultureInfo.InvariantCulture);
Step("con el TTL del diseño (300 s)", ttl is > 290 and <= 300, $"TTL {ttl}");

var hit = await Read();
Step("el acierto no vuelve al origen", loads == 1, $"{loads} cargas");
Step("y sale byte a byte igual en el cable", JsonSerializer.Serialize(hit, WireJson.Options) == wire);

Cli("SET", $"{service}:otra-cache::x", "1");
Cli("SET", "otro-servicio:get-x::x", "1");
await cache.Clear(operation);
Step("vaciar una caché borra sus entradas y ninguna más", Cli("EXISTS", key) == "0" && Cli("EXISTS", $"{service}:otra-cache::x") == "1");

await Read();
Exec("exec", container, "sh", "-c", flush);
Step("la orden de infra/reset-db.sh borra lo de este servicio y nada más", Cli("EXISTS", key) == "0" && Cli("EXISTS", "otro-servicio:get-x::x") == "1");

Exec("stop", "-t", "0", container);
await Task.Delay(500);
var before = loads;
var watch = Stopwatch.StartNew();
GetProductBySlugResponseDto? answered = null;
string error = "";
try
{
    answered = await Read();
}
catch (Exception failure)
{
    error = failure.Message;
}
watch.Stop();
Step("con el store parado, la lectura va al origen y no falla", ReferenceEquals(answered, card) && loads == before + 1, error);
Step("y en el acto, sin esperar al plazo de la orden", watch.ElapsedMilliseconds < 1000, $"{watch.ElapsedMilliseconds} ms");

Exec("start", container);
var back = false;
for (var attempt = 0; attempt < 40 && !back; attempt++)
{
    await Task.Delay(500);
    await Read();
    back = Cli("EXISTS", key) == "1";
}
Step("con el store de vuelta, la caché vuelve a guardar sin reiniciar nada", back);

return failures == 0 ? 0 : 1;

static string Required(string name) => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name}: lo pone cache-check");
