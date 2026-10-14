# Pruebas de integración de los escenarios `FL-*`

Cómo se traduce `specs/validation-scenarios.md` a código en `tests/<Raíz>.IntegrationTests/`. Es la convención
del agente `keel-dotnet-tests` y la referencia de `keel-dotnet-validate` cuando arbitra un fallo.

**Qué no es**: la suite unitaria. Lo que hay aquí son escenarios end-to-end contra el servidor real y la
infraestructura de `infra/docker-compose.yaml`: el mismo trabajo que antes se hacía con `curl` a mano, ahora
versionado. Y son la traducción de los **mismos** escenarios que los servidores de keel-spring y keel-nest del
diseño ejecutan en JUnit y en Vitest: si uno pasa en un servidor y no en otro, alguno no es equivalente.

## La caja negra

El proyecto de flujos **no ve ningún tipo del servicio**: no referencia sus proyectos (solo ordena la
compilación del Api, sin ver sus tipos) y arranca el servidor como un proceso aparte. Un flujo que nombre un DTO,
un comando, un enum o un error del servicio **no compila**. Los escenarios se expresan con HTTP y JSON.
`bash infra/check-flows.sh` comprueba además que nadie le añadió una referencia que rompa esa ceguera.

## El arnés: `Support/`

Lo genera build y **no se edita** (ver § El arnés es del generador). Un flujo es una clase que hereda de
`FlowTest`:

| Pieza | Para qué |
|---|---|
| `FlowTest` | la base de cada flujo: arranca el servidor (una vez por suite, perfil `local`, contra `infra/`), **resetea el estado** al empezar cada flujo (`infra/reset-db.sh`), vuelca la evidencia de cada caso que falla y para el servidor al terminar la suite |
| `[Scenario("FL-…: …")]` | un escenario: el título es el nombre del caso en el XML, y los escenarios de un flujo se ejecutan **en el orden en que están escritos** |
| `GivenAsync()` | (`protected override`) el Given común a todo el flujo, después del reset y antes del primer escenario; si falla, el flujo sale OMITIDO |
| `Get/Post/Put/Patch/Delete(ruta, cuerpo?, cabeceras?)` | una petición HTTP de verdad; nunca lanza por un 4xx/5xx: el status es una aserción. El cuerpo es un objeto anónimo (se serializa) o el JSON ya escrito, tal cual viaja |
| `Exchange(método, ruta, cuerpo?, cabeceras?)` | cualquier otro verbo |
| `response.Status`, `.Header(n)`, `.Body` | el intercambio crudo |
| `response.Json()` | el cuerpo como `JsonElement`; un número conserva su texto: `GetRawText()` da `"2.50"` |
| `AssertJson(esperado, response)` | el cuerpo entero contra el JSON esperado, **estricto** (ni una clave de más ni de menos, números por su texto, listas en orden), con los comodines `"<uuid>"`, `"<instant>"` y `"<any>"` para lo que genera el servidor |
| `RouteBase` | el prefijo de todas las rutas (basePath + versión) |
| `Db(sql)` | una sentencia contra la base de prueba (solo con persistencia): para lo que no se ve por HTTP |
| `ResetState()` | el reset, a mano (la base ya lo hace al empezar cada flujo) |
| `Eventually(cond, plazo?, mensaje?)` | espera a que algo asíncrono se cumpla |
| `BaseUrl` | la URL del servidor arrancado, por si un escenario necesita construir una a mano |

Nada de FluentAssertions (licencia comercial desde la 8): las aserciones son las de xUnit y `AssertJson`.

## Una prueba por flujo

```csharp
// tests/<Raíz>.IntegrationTests/ProductCreationFlow.cs
namespace ProductCatalog.IntegrationTests;

using ProductCatalog.IntegrationTests.Support;
using Xunit;

/// <summary>FL-PRD-001 · alta de producto.</summary>
public sealed class ProductCreationFlow : FlowTest
{
    // El estado que encadena los escenarios del flujo: xUnit crea una instancia por caso, así que va en estático.
    private static string productId = "";

    [Scenario("FL-PRD-001-A: alta correcta")]
    public async Task AltaCorrecta()
    {
        var response = await Post($"{RouteBase}/products", """{"sku":"ACM-0001","name":"Martillo","price":{"amount":12.50,"currency":"EUR"}}""");
        Assert.True(response.Status == 201, response.ToString());
        productId = response.Json().GetProperty("id").GetString()!;
        Assert.EndsWith($"/products/{productId}", response.Header("location"));
        AssertJson("""{"id":"<uuid>","sku":"ACM-0001","name":"Martillo","notes":null,"price":{"amount":12.50,"currency":"EUR"},"status":"draft"}""", response);
    }

    [Scenario("FL-PRD-001-B: el sku repetido es 409 SKU_ALREADY_EXISTS")]
    public async Task SkuRepetido()
    {
        var response = await Post($"{RouteBase}/products", """{"sku":"ACM-0001","name":"Otro","price":{"amount":1.00,"currency":"EUR"}}""");
        Assert.True(response.Status == 409, response.ToString());
        Assert.Equal("SKU_ALREADY_EXISTS", response.Json().GetProperty("code").GetString());
    }
}
```

Reglas de forma:

- **Una clase por flujo**, `<Flujo>Flow.cs` en la raíz del proyecto de flujos, que hereda de `FlowTest`, con el
  id del flujo en su comentario.
- **El título de cada caso empieza por su id y dos puntos** (`[Scenario("FL-PRD-001-A: …")]`). De ahí salen la
  matriz de `score-scenarios.sh` y el nombre del volcado de su evidencia. Sin el id, el escenario sale `NO_EJERC`
  aunque se ejecute. Un `[Theory]` da una fila por dato: un escenario es un `[Scenario]`.
- **El reset es por flujo, no entre escenarios**: dentro de un flujo el escenario A crea el estado que B
  verifica. Los escenarios corren en el orden del archivo: escríbelos en el orden del documento. xUnit crea una
  instancia de la clase por caso, así que el estado encadenado vive en campos **estáticos** de la clase del flujo.
- `Assert.True(response.Status == 201, response.ToString())`: el mensaje lleva el cuerpo si falla, que es lo
  primero que hay que leer. `Assert.Equal(201, response.Status)` no lo dice.
- Si el `Given` de un flujo depende de datos creados por **otro** flujo, tras el reset no se sostiene: es un
  hueco del diseño, no se siembra a mano.

## Del DSL al cable

Quien escribe estas pruebas no puede mirar el código, así que la forma exacta de la respuesta hay que
**derivarla**, en este orden de precedencia:

1. **`specs/validation-scenarios.md`**: el `Then` literal y las Convenciones de determinación (ausencia vs. nulo,
   orden de las colecciones, escala decimal, colación, formato temporal).
2. **`docs/openapi.yaml`**: el contrato formal de la API. Existe siempre que hay API —si no se pasó `/keel-docs`,
   build lo DERIVA del mismo modelo que el código (`x-keel-derived`), el mismo que el de keel-spring y keel-nest—:
   rutas, status, cuerpos con sus cotas y cada respuesta con TODOS sus campos, su orden, qué puede ser null y
   `additionalProperties: false`. Con él se aserta el cuerpo entero (`AssertJson`), no campo a campo.
3. **`specs/<capa>.keel.yaml` + `mapping.md`**: la derivación mecánica.
4. Nada más. Lo que estas fuentes no fijan es un `designGap`.

| Qué necesita la prueba | De dónde sale |
|---|---|
| Ruta | `RouteBase` + `endpoints.<op>.path` de `api.keel.yaml` |
| Path / query / cuerpo | cada `{segmento}` es de la ruta; el resto del `input` va en el cuerpo en `POST`/`PUT`/`PATCH` y como query en `GET`/`DELETE` |
| Status de éxito | `endpoints.<op>.successStatus`; si no se declara, 200, salvo `DELETE` (204) y `create*` (201) |
| Cuerpo de error | `{timestamp, status, error, code, message, details, correlationId}`: se afirman el `code` y el status; el resto por presencia y forma, nunca el `message` literal |
| Página | `{items, page, size, totalElements, totalPages}` |
| Instante | ISO-8601 UTC con **tres** decimales y `Z`: `"<instant>"` en `AssertJson` |
| Decimal | con la escala del diseño: `AssertJson` lo compara por su texto (`12.50` no casa con `12.5`) |
| Campo sin valor | `null` o ausente según la convención del servicio: decide si la clave va en el JSON esperado |
| `PATCH` | ausente ≠ `null` explícito cuando el diseño lo declara: dos escenarios |
| `Location` | URL **absoluta** (esquema y host de la petición, como los otros dos servidores): se afirma su **final**, `Assert.EndsWith($"/products/{id}", …)`, nunca la ruta exacta, aunque el `Then` escriba solo la ruta |
| `page`/`size` fuera de rango | no son error: `size` < 1 → `defaultSize`, `size` > `maxSize` → `maxSize`, `page` < 0 → 0 (Spring Data). Un 400 solo si el escenario lo fija |

## Aserciones: el cuerpo completo o nada

- `AssertJson` sobre el cuerpo entero: comprueba los campos presentes **y** que no venga ninguno de más. Con
  `"<uuid>"`/`"<instant>"`/`"<any>"` en lo no determinista.
- La escala es parte de la aserción: `AssertJson` compara los números por su texto, y en una aserción suelta,
  `GetRawText()` (`"12.50"`), nunca `GetDecimal()` (que da `12.5m` igual si el servidor perdió la escala).
- Un id o una marca de tiempo **nunca** por literal: por forma, y reutilizado dentro del flujo.
- Un test que solo comprueba el status **no vale**.

## Traducir el `Given`

Cláusula por cláusula, cada una con su llamada de siembra **cuyo status se comprueba**: crear la entidad no es
dejarla en el estado que el escenario declara.

| Cláusula del `Given` | No basta con | Hace falta |
|---|---|---|
| `p1 (active)` | crear `p1` (nace en el estado inicial) | la operación que lo transiciona a `active` |
| `c1 con 3 productos` | crear `c1` | crear los tres y comprobar que quedan asociados |
| `p1 sin imágenes` | crear `p1` | nada más, pero decláralo en un comentario |

Lo que el flujo entero necesita antes de su primer escenario va en `GivenAsync()`. Si el `Given` **no se puede
materializar por la API**, es `designGap`: no se siembra por la base. `Db(...)` es para **leer** lo que la API no
expone (que una escritura llegó al almacén), y solo excepcionalmente para una precondición que ninguna operación
puede fabricar — y entonces se dice en `assumptions`. Si esa fila lleva una columna sombra `<campo>_normalized`
(un campo con `compare`), va con el valor plegado del campo, nunca con `''`: es la columna que lleva la unicidad,
y dos filas con cadena vacía chocan en `uk_<tabla>_natural`.

Al aislar una guarda tardía, las anteriores se satisfacen con datos **válidos**: un cuerpo `{}` muere en otra
guarda, con otro `code`, y el escenario mide lo que no es suyo.

## Checklist antes de cerrar

1. Toda ruta usada existe en `api.keel.yaml` y su verbo coincide.
2. Todo `code` de error está copiado **literal** del diseño.
3. Todo campo del cuerpo esperado está en el `output` de la operación; uno que no, es `designGap`.
4. Ningún valor no determinista se compara por literal.
5. Cada caso con su id exacto delante de los dos puntos.
6. Toda restricción declarada sobre una entrada (`min`, `max`, `minLength`, `maxLength`, `pattern`…) tiene su
   escenario de rechazo con **400** `VALIDATION_ERROR`, aunque el flujo no la nombre.
7. Cada cláusula del `Given` tiene su siembra con su status comprobado.
8. Los decimales se afirman por su texto.
9. Ningún tipo del servicio (no compilaría: si compila, alguien rompió la caja negra).
10. `bash infra/check-flows.sh` en verde.

## El arnés es del generador

`Support/`, `HarnessSmoke.cs`, `AssemblyInfo.cs`, el `.csproj` de los flujos y los scripts de `infra/` los
escribe `keel-dotnet build`. En la fase 1 son de **solo lectura**: sin infraestructura no se puede saber si están
rotos, y lo que falte va a `blockers` con la firma propuesta. En la fase 2, si el árbitro dice `culprit:
harness`, se parchea **al mínimo** dentro de `Support/`, se verifican **todos** los flujos que usan lo tocado y el
parche se registra en `harnessPatches` — es lo que devuelve el defecto al generador. Un defecto fuera del proyecto
de flujos (`infra/`, la solución, `Directory.*.props`) no se toca: va a `blockers` y lo corrige el orquestador.

## Lo que se declara en vez de simularse

Un escenario que el diseño no permite ejercitar de forma determinista **no se inventa**: va a `uncovered` con su
motivo. Nada de dobles de prueba ni de servidores simulados: lo que se valida es el servidor real contra la
infraestructura levantada.

## Ejecución

```bash
bash infra/check-flows.sh        # compilan y respetan la caja negra (fase 1)
dotnet build && dotnet tests/<Raíz>.IntegrationTests/bin/Debug/net10.0/<Raíz>.IntegrationTests.dll \
  -class "<Raíz>.IntegrationTests.<Flujo>Flow"          # un flujo (fase 2; varios: repite -class)
bash infra/score-scenarios.sh    # la suite y la matriz (lo ejecuta el orquestador)
```

`dotnet test` NO ejecuta los flujos: están fuera de él a propósito (necesitan `infra/`). Cada fallo deja
`build/keel-failures/<FL-id>.json` (escenario, aserción, la última petición y respuesta, el último sondeo) y un
flujo que no arranca, `build/keel-failures/<Flujo>-init.json`: sus casos salen OMITIDOS. La salida del servidor
está en `build/keel-scenarios/server.log`.
