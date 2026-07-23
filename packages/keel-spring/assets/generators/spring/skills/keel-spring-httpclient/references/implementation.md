# HTTP clients — patrones de implementación

Complementa la sección «Qué implementa el agente» del SKILL.md. El mapeo
normativo DSL → código sigue en `.claude/conventions/mapping.md`. Todo el código
de este documento vive en `infrastructure/http` (adaptador y mapper); el puerto y
los `<X>Result` están en `domain/clients`.

> Verifica la API concreta de Spring `RestClient` y de resilience4j contra la
> documentación vigente (skill `find-docs` / `ctx7`) si dudas de una firma: aquí
> se describe el patrón, no una versión congelada.

## La llamada RestClient

El bean lo inyecta build por `@Qualifier("<c>RestClient")`. Una llamada típica
encadena verbo → URI → headers → body → `retrieve()` → deserialización:

```java
@Override
public ProductPriceResult getPrice(UUID sku, String currency) {
    PriceResponse response = restClient.get()
            .uri(uri -> uri.path("/prices/{sku}").queryParam("currency", currency).build(sku))
            .retrieve()
            .body(PriceResponse.class);
    return mapper.toPriceResult(response);
}
```

- **Path vars** (`{sku}`) → argumentos posicionales de `build(...)` en el orden en
  que aparecen en la ruta. Sin query params, basta `.uri("/prices/{sku}", sku)`.
- **Query params** → `.uri(uri -> uri.path(...).queryParam("k", v)...build(args))`.
- **Headers por llamada** → `.header("X-Trace", value)` (los headers fijos y la
  auth ya van en el bean, no los repitas aquí).
- **Body** (POST/PUT/PATCH) → `.body(mapper.to<X>Request(campo1, campo2))`; el
  mapper arma el DTO wire desde los valores del dominio.
- **Respuesta** → `.retrieve().body(<X>Response.class)`; luego el mapper la traduce
  a `<X>Result`. Para colecciones usa `ParameterizedTypeReference<List<...>>`.

## Manejo de errores: `onStatus`

`retrieve()` lanza `HttpClientErrorException` (4xx) / `HttpServerErrorException`
(5xx) por defecto. **No dejes que suban a application**: o bien las traduce
`@Retry`/fallback (5xx), o las interceptas con `.onStatus(...)` y lanzas la
excepción de dominio con el `code` que dicte use-cases:

```java
PriceResponse response = restClient.get()
        .uri("/prices/{sku}", sku)
        .retrieve()
        .onStatus(HttpStatusCode::is4xxClientError, (req, res) -> {
            if (res.getStatusCode().value() == 404) {
                throw new PriceNotFoundException(sku); // code exacto de use-cases
            }
            throw new UpstreamRejectedException(res.getStatusCode().value());
        })
        .body(PriceResponse.class);
```

Regla del DSL: **4xx no se reintenta** (input a corregir); 5xx/timeout sí
(reintentable, lo cubre resilience4j). Nunca conviertas un 4xx en reintento.

## Anticorrupción wire ↔ dominio (el mapper)

El mapper aísla el contrato del tercero. Cuando el `contract` es solo-prosa, build
deja los records vacíos y el método con `// TODO`: decláralos tú.

```java
// infrastructure/http — refleja al TERCERO (nombres/tipos wire tal cual)
public record PriceResponse(String currencyCode, BigDecimal grossAmount) {}

// domain/clients — refleja al DOMINIO
public record ProductPriceResult(Currency currency, Money amount) {}

// el mapper traduce; si el tercero cambia, el cambio se absorbe AQUÍ
public ProductPriceResult toPriceResult(PriceResponse response) {
    return new ProductPriceResult(
            Currency.of(response.currencyCode()),
            Money.of(response.grossAmount()));
}
```

No filtres tipos wire al dominio ni tipos de dominio al wire: cada lado habla su
propio vocabulario y el mapper es el único puente.

## Resilience4j: `@Retry`, `@CircuitBreaker` y fallback

build ya anotó los métodos y generó las instancias en
`parameters/<perfil>/http-clients.yaml`. El `name` es `<cliente>-<llamada>`. Tú
completas la **lógica** del método de fallback (build deja un stub):

```java
@Override
@Retry(name = "pricing-service-get-price", fallbackMethod = "getPriceFallback")
public ProductPriceResult getPrice(UUID sku, String currency) { ... }

// misma firma + Throwable final; implementa la frase `fallback` del diseño
private ProductPriceResult getPriceFallback(UUID sku, String currency, Throwable t) {
    // p. ej. valor degradado documentado, o error de negocio con su code:
    throw new PriceUnavailableException(sku); // code exacto de use-cases
}
```

- Con `@Retry` **y** `@CircuitBreaker`, el `fallbackMethod` va en el
  `@CircuitBreaker` (build ya lo coloca ahí): el retry agota intentos y, si el
  circuito abre, dispara el fallback una sola vez.
- La firma del fallback = la del método + un `Throwable` al final. Un fallback que
  no compila suele ser una firma desalineada.
- El fallback es **lógica de negocio**, no un `UnsupportedOperationException`: o
  devuelve un resultado degradado válido o lanza el error de dominio declarado.

## Sin `method`/`path` en el diseño

build deja `throw new UnsupportedOperationException("TODO: ...")` con el `contract`
en un comentario. Deriva de la frase el verbo, la ruta (relativa a `base-url`), los
params y el body, y arma la llamada como arriba. Si la prosa es ambigua, es un
**hueco del diseño**: repórtalo, no inventes la ruta.
