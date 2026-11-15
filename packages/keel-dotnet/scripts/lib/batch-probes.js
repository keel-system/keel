// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) contra lo emitido, para db-check y doc-check: BA-1 a BA-7
// de keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check) y keel-nest (scripts/lib/batch-probes.js)
// sobre los MISMOS diseños (keel-core/test/helpers/batch-designs.js). Dos cosas se escriben dentro del sujeto, y no forman
// parte del proyecto:
//
//   · el HANDLER de `importProducts`, en el lugar del stub (batchProbePatch): lo que escribiría el agente para UN
//     elemento —un nombre «BOOM» es un fallo que ningún diseño declara—. Como la de keel-nest, no busca el sku antes de
//     guardar: el duplicado lo rechaza la UNICIDAD del motor y lo traduce la persistencia al error que el diseño declara;
//   · un [Fact] por caso, con el id en el nombre (`Batch_BA3_…`), dentro de la clase de sondas de cada sujeto, como las del
//     historial: comparte la base con el resto de sondas, así que NO vacía nada. Cada caso usa sus propios sku (el prefijo
//     `ZZ<letra>`, que ninguna muestra genera) y lee solo esos.
//
// Lo que se mide es lo que build pone alrededor del handler: el sobre, el bucle, la transacción por elemento, la lectura de
// cada elemento y la respuesta, y lo que quedó en la base. El endpoint emitido se llama como lo llama ASP.NET Core: un
// HttpContext con el cuerpo, los servicios de un ámbito y el ApiErrorMiddleware emitido delante, que traduce el 400 del sobre.

import { BATCH_CASES, BATCH_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { csFile, csMember, csString, namespaceOf, solution } from '../../src/scaffold/render.js';
import { endpointsClass } from '../../src/scaffold/endpoints.js';
import { portClass, repositoriesNamespace } from '../../src/scaffold/repositories.js';

const js = (value) => JSON.stringify(value);

/** Lo que el nombre de un elemento pide al handler de la sonda: fallar con algo que el diseño no declara (BA-4). */
export const UNDECLARED_FAILURE_NAME = 'BOOM';

/** Las operaciones por lotes del modelo, de los dos modos: el handler de la sonda, el registro y la referencia a la API. */
export const allBatchOperations = (model) => model.services.flatMap((service) => service.operations).filter((operation) => operation.batch);

/** Las operaciones por lotes SÍNCRONAS: las de BA-1 a BA-7 (las asíncronas las mide batch-job-probes.js). */
export const batchOperations = (model) => allBatchOperations(model).filter((operation) => operation.batch.execution !== 'async');

/** Los sujetos por almacén: los de batch-designs.js. */
export const BATCH_SUBJECTS = { relational: ['catalog-batch', 'catalog-batch-atomic'], document: ['catalog-batch-mongo'] };

/** Los casos que ejecuta este diseño: los mismos que keel-spring y keel-nest (batch-parity.test.js lo compara). */
export function batchCases(model) {
  const atomicities = new Set(batchOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5');
  if (atomicities.has('all-or-nothing')) ids.push('BA-6');
  if (atomicities.size > 0) ids.push('BA-7');
  return BATCH_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const BATCH = 'Rest/Batch.cs';
const ENDPOINTS = 'Endpoints/';

const SAME = (spec) => ({ relational: spec, document: spec });

/**
 * Lo que se busca y se sustituye en lo emitido, por sabotaje y por almacén: [sufijo del archivo, texto o expresión,
 * sustituto]. Rompen lo emitido CONSERVANDO LA FORMA (sigue compilando).
 */
export const BATCH_SABOTAGE_SPECS = {
  // El lote entero en UNA transacción: los despachos del mediator se unen a ella (no abre otra si hay una en curso).
  'ba-one-tx': SAME([
    ENDPOINTS,
    /^(namespace (\w+)\.Api\.Endpoints;[\s\S]*?)var response = await (BatchRunner\.PerItem<[\s\S]*?http\.RequestAborted\));/,
    (match, head, root, call) =>
      `${head}var response = await http.RequestServices.GetRequiredService<global::${root}.Infrastructure.UseCase.IUseCaseTransactions>().Run(() => ${call}, readOnly: false, http.RequestAborted);`
  ]),
  // Un elemento mal formado tumba el lote entero con un 400, como si el borde validara el cuerpo completo.
  'ba-validate-whole': SAME([BATCH, 'results.Add(BatchItem.Failed(index, ValidationError, invalid.Message));\n                continue;', 'throw new MalformedRequestException(invalid);']),
  // Un fallo que no es de su elemento no detiene el lote.
  'ba-continue-on-undeclared': SAME([BATCH, 'stopped = true;', 'stopped = false;']),
  // El lote por elemento responde 200: el status deja de ser el del método.
  'ba-status': SAME([ENDPOINTS, 'await HttpReply.Json(http, BatchRunner.MultiStatus, response);', 'await HttpReply.Json(http, 200, response);']),
  // all-or-nothing sin la transacción que abarca el lote: cada elemento se confirma en la suya.
  'ba-atomic-no-tx': SAME([BATCH, 'var results = await transactions.Run(', 'var results = await new PassThroughUseCaseTransactions().Run('])
};

export const isBatchSabotage = (id) => Boolean(BATCH_SABOTAGE_SPECS[id]);

/**
 * Dónde cae `ba-one-tx` en keel-dotnet, por motor: MEDIDO, y no donde lo declara keel-core (el de keel-spring, BA-2, BA-4 y
 * BA-5). En EF Core un error capturado no marca la transacción para revertir, así que BA-4 no cae: lo anterior al que
 * detiene el lote se confirma igual. Y EF abre un SAVEPOINT antes de cada SaveChanges dentro de una transacción que no es
 * suya y vuelve a él si falla, así que el duplicado no aborta la transacción del lote (BA-5 no cae, al revés que en
 * keel-nest); lo que la delata es que la fila rechazada SIGUE en el change tracker —solo la transacción que el adaptador
 * abre él mismo lo vacía al traducir el fallo—, y el elemento siguiente la vuelve a insertar y choca (BA-2). En MongoDB no
 * hay savepoint: el servidor aborta la transacción tras el duplicado y su commit falla, como en keel-nest (BA-2, BA-5).
 */
export const BATCH_ONE_TX = { postgresql: ['BA-2'], mysql: ['BA-2'], mongodb: ['BA-2', 'BA-5'] };

/** Lo que tiene que caer con un sabotaje en este diseño y este motor: sus casos que la sonda ejecuta, y solo esos. */
export function batchSabotageVerdict(failures, id, model, engine) {
  const cases = batchCases(model);
  const declared = id === 'ba-one-tx' && BATCH_ONE_TX[engine] ? BATCH_ONE_TX[engine] : BATCH_SABOTAGES[id];
  const want = declared.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/Batch_BA(\d+)_/g)].map((match) => `BA-${match[1]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El handler de la sonda ──────────────────────────────────────────────────────────────────────────────────────

/** El namespace que declara el archivo emitido que termina en `suffix`. */
function namespaceIn(files, suffix) {
  const file = files.find((candidate) => candidate.path.endsWith(suffix));
  return file ? /^namespace ([\w.]+);/m.exec(file.content)?.[1] ?? null : null;
}

/** El handler de la sonda en el lugar del stub de `importProducts`; el resto de archivos, tal cual. */
export function batchProbePatch(model, file, files) {
  const operation = allBatchOperations(model)[0];
  if (!operation || typeof file.content !== 'string' || !file.path.endsWith(`/UseCases/${operation.handlerClass}.cs`)) return file;
  const result = operation.batch.resultFields.length > 0;
  const aggregate = namespaceIn(files, '/Product.cs');
  const enums = namespaceIn(files, '/ProductStatus.cs');
  const namespace = /^namespace ([\w.]+);/m.exec(file.content)[1];
  const usings = [...file.content.matchAll(/^using ([\w.]+);/gm)].map((match) => match[1]);
  const contract = result ? `IReturningCommandHandler<${operation.messageClass}, ${operation.responseDto.name}>` : `ICommandHandler<${operation.messageClass}>`;
  const returns = result ? `Task<${operation.responseDto.name}>` : 'Task';
  return {
    ...file,
    content: csFile({
      namespace,
      usings: [...usings, aggregate, enums],
      body: `/// <summary>La sonda de db-check y doc-check: lo que escribiría el agente para UN elemento.</summary>
public sealed class ${operation.handlerClass}(IProductRepository productRepository) : ${contract}
{
    /// <summary>
    /// Lo que corre tras el efecto, dentro de la transacción del elemento: la réplica que se lleva el trabajo de un lote
    /// asíncrono (BJ-5) mueve aquí el cursor. Null: nada.
    /// </summary>
    public static Func<Task>? AfterEffect { get; set; }

    public async ${returns} Handle(${operation.messageClass} command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var draft = command.Item;
        if (draft.Name == ${csString(UNDECLARED_FAILURE_NAME)})
        {
            throw new InvalidOperationException("sonda: un fallo que el diseño no declara");
        }
        // Sin buscar el sku antes: el duplicado lo rechaza la unicidad del motor, y la persistencia lo traduce al error declarado.
        var saved = await productRepository.Save(
            new Product(new ProductState { Id = Guid.CreateVersion7(), Sku = draft.Sku, Name = draft.Name, Notes = null, Price = draft.Price, ApiToken = "sonda", Status = ProductStatus.Draft, LockVersion = null }),
            cancellationToken);
        if (AfterEffect is { } afterEffect)
        {
            await afterEffect();
        }
        ${result ? `return new ${operation.responseDto.name} { ProductId = saved.Id };` : '_ = saved;'}
    }
}`
    })
  };
}

// ─── El contenedor ───────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que el contenedor de la sonda registra DESPUÉS de la persistencia: los casos de uso (el mediator y los handlers). */
export function batchFixtureRegistration(model) {
  if (allBatchOperations(model).length === 0) return '';
  return `
        // Los lotes (DSL 2.30): el mediator y los handlers, detrás de la persistencia (su transacción no la pisa: TryAdd).
        services.AddUseCases();`;
}

/** Los using que añaden las sondas de los lotes. */
export function batchProbeUsings(model) {
  if (allBatchOperations(model).length === 0) return [];
  return [
    'System.Text',
    'System.Text.Json',
    'System.Text.Json.Nodes',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.Logging',
    namespaceOf(model, 'useCaseInfra'),
    namespaceOf(model, 'rest'),
    namespaceOf(model, 'endpoints'),
    repositoriesNamespace(model)
  ];
}

/** Las líneas del .csproj de las sondas: el proyecto de la API, cuyo endpoint se llama. */
export function batchProjectReference(model) {
  if (allBatchOperations(model).length === 0) return '';
  return `\n    <ProjectReference Include="..\\..\\${solution(model).api.csproj.replaceAll('/', '\\')}" />`;
}

// ─── Los casos ───────────────────────────────────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });

/** Los [Fact] de los lotes, dentro de la clase de sondas; null si el diseño no tiene lotes. */
export function batchProbeBlock(model) {
  const operations = batchOperations(model);
  if (operations.length === 0) return null;
  const cases = new Set(batchCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const port = portClass(product);
  const service = model.services.find((candidate) => candidate.operations.includes(operations[0]));
  const endpoints = endpointsClass(service);
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const body = (...items) => csString(js({ items }));
  const methods = [];
  const fact = (id, title, code) => {
    if (!cases.has(id)) return;
    methods.push(`    /// <summary>${id}: ${title}.</summary>
    [Fact]
    public async Task Batch_${id.replace('-', '')}_${title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('')}()
    {
${code}
    }`);
  };
  if (perItem) {
    const post = (items) => `await BatchPost(${endpoints}.${csMember(perItem.name)}, ${items})`;
    fact('BA-1', 'sin fallos 207 con todos succeeded y su result en orden', `        var (status, json) = ${post(body(draft('ZZA-9001'), draft('ZZA-9002'), draft('ZZA-9003')))};
        Assert.True(status == 207, $"un lote per-item responde 207 también si todo salió bien: {status}");
        AssertSummary(json, 3, 3, 0, 0);
        var items = json["items"]!.AsArray();
        for (var index = 0; index < items.Count; index++)
        {
            Assert.Equal(index, items[index]!["index"]!.GetValue<int>());
            Assert.Equal("succeeded", items[index]!["status"]!.GetValue<string>());
            Assert.NotNull(items[index]!["result"]?["productId"]);
            AssertStable(items[index]);
        }`);
    fact('BA-2', 'un error de itemErrors falla solo su elemento', `        ${post(body(draft('ZZB-9001')))};
        Assert.NotNull(await BatchProduct("ZZB-9001"));
        var (_, json) = ${post(body(draft('ZZB-9001'), draft('ZZB-9002')))};
        AssertSummary(json, 2, 1, 1, 0);
        AssertFailed(json["items"]![0], "SKU_ALREADY_EXISTS");
        Assert.Equal("succeeded", json["items"]![1]!["status"]!.GetValue<string>());
        Assert.NotNull(await BatchProduct("ZZB-9002"));`);
    fact('BA-3', 'un elemento mal formado es su failed con VALIDATION_ERROR', `        var (status, json) = ${post(csString(js({ items: [draft('ZZC-9001'), draft('mal'), draft('ZZC-9003', 'x'.repeat(121)), null, draft('ZZC-9005')] })))};
        Assert.True(status != 400, $"un elemento mal formado no es un 400 del lote: {json}");
        AssertSummary(json, 5, 2, 3, 0);
        foreach (var index in new[] { 1, 2, 3 })
        {
            AssertFailed(json["items"]![index], "VALIDATION_ERROR");
        }
        Assert.Contains("sku", json["items"]![1]!["message"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.NotNull(await BatchProduct("ZZC-9005"));`);
    fact('BA-4', 'un error no declarado detiene el lote', `        var (_, json) = ${post(body(draft('ZZD-9001'), draft('ZZD-9002', UNDECLARED_FAILURE_NAME), draft('ZZD-9003')))};
        AssertSummary(json, 3, 1, 1, 1);
        AssertFailed(json["items"]![1], "BATCH_ABORTED");
        Assert.Equal("notAttempted", json["items"]![2]!["status"]!.GetValue<string>());
        AssertStable(json["items"]![2]);
        Assert.NotNull(await BatchProduct("ZZD-9001"));
        Assert.Null(await BatchProduct("ZZD-9003"));`);
    fact('BA-5', 'la misma clave dos veces en el lote falla en el segundo', `        var (_, json) = ${post(body(draft('ZZE-9001'), draft('ZZE-9001')))};
        Assert.Equal("succeeded", json["items"]![0]!["status"]!.GetValue<string>());
        AssertFailed(json["items"]![1], "SKU_ALREADY_EXISTS");
        Assert.NotNull(await BatchProduct("ZZE-9001"));`);
    fact('BA-7', 'el sobre el campo ausente y exceder maxItems son un 400 del lote', envelope(perItem, 'ZZG'));
  }
  if (atomic) {
    const post = (items) => `await BatchPost(${endpoints}.${csMember(atomic.name)}, ${items})`;
    fact('BA-6', 'all-or-nothing revierte entero y responde el error del culpable', `        var (status, json) = ${post(body(draft('ZZF-9001'), draft('ZZF-9002'), draft('ZZF-9001')))};
        Assert.True(status == 409 && json["code"]?.GetValue<string>() == "SKU_ALREADY_EXISTS", $"el error del elemento culpable: {status} {json}");
        Assert.Equal("items[2]", json["details"]![0]!.GetValue<string>());
        Assert.Null(await BatchProduct("ZZF-9001"));
        Assert.Null(await BatchProduct("ZZF-9002"));
        var (invalidStatus, invalid) = ${post(body(draft('ZZF-9003'), draft('mal')))};
        Assert.True(invalidStatus == 400 && invalid["details"]![0]!.GetValue<string>() == "items[1]", $"un elemento mal formado es el 400 del culpable: {invalid}");
        Assert.Null(await BatchProduct("ZZF-9003"));
        var (goodStatus, good) = ${post(body(draft('ZZF-9004'), draft('ZZF-9005')))};
        Assert.Equal(${atomic.route.status}, goodStatus);
        AssertSummary(good, 2, 2, 0, 0);`);
    if (!perItem) fact('BA-7', 'el sobre el campo ausente y exceder maxItems son un 400 del lote', envelope(atomic, 'ZZH'));
  }

  function envelope(operation, prefix) {
    const call = `${endpoints}.${csMember(operation.name)}`;
    const many = (operation.batch.maxItems ?? 0) + 1;
    return `        var (absent, _) = await BatchPost(${call}, "{}");
        Assert.Equal(400, absent);
        var many = Enumerable.Range(0, ${many}).Select(n => new { sku = $"${prefix}-{n:D4}", name = "Producto", price = new { amount = "10.00", currency = "EUR" } }).ToList();
        var (tooMany, _) = await BatchPost(${call}, JsonSerializer.Serialize(new { items = many }));
        Assert.Equal(400, tooMany);
        // Un 400 del sobre no procesa ningún elemento: ni el primero, ni el último.
        Assert.Null(await BatchProduct("${prefix}-0000"));
        Assert.Null(await BatchProduct($"${prefix}-{${many - 1}:D4}"));`;
  }

  const helpers = `    /// <summary>El endpoint emitido, llamado como lo llama ASP.NET Core: el cuerpo, los servicios de un ámbito y el middleware de errores delante.</summary>
    private static async Task<(int Status, JsonNode Json)> BatchPost(Func<HttpContext, Task> endpoint, string body)
    {
        await using var scope = root.CreateAsyncScope();
        var http = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        http.Request.Method = "POST";
        http.Request.ContentType = "application/json";
        http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        http.Response.Body = new MemoryStream();
        var middleware = new ApiErrorMiddleware(context => endpoint(context), scope.ServiceProvider.GetRequiredService<ILogger<ApiErrorMiddleware>>());
        await middleware.InvokeAsync(http);
        http.Response.Body.Position = 0;
        return (http.Response.StatusCode, JsonNode.Parse(http.Response.Body)!);
    }

    private static Task<${product.name}?> BatchProduct(string sku) => InScope(other => other.GetRequiredService<${port}>().FindBySku(sku, Cancel));

    private static void AssertSummary(JsonNode json, int total, int succeeded, int failed, int notAttempted)
    {
        var summary = json["summary"] ?? throw new Xunit.Sdk.XunitException($"sin summary: {json}");
        Assert.Equal((total, succeeded, failed, notAttempted), (summary["total"]!.GetValue<int>(), summary["succeeded"]!.GetValue<int>(), summary["failed"]!.GetValue<int>(), summary["notAttempted"]!.GetValue<int>()));
    }

    /// <summary>Las cinco claves de un elemento, siempre.</summary>
    private static void AssertStable(JsonNode? element)
    {
        var keys = element!.AsObject().Select(pair => pair.Key).ToList();
        Assert.Equal(new[] { "index", "status", "result", "error", "message" }, keys);
    }

    private static void AssertFailed(JsonNode? element, string code)
    {
        AssertStable(element);
        Assert.Equal("failed", element!["status"]!.GetValue<string>());
        Assert.Equal(code, element["error"]!.GetValue<string>());
        Assert.Null(element["result"]);
    }`;
  return { methods: `    // ─── Lotes (DSL 2.30): BA-1 a BA-7, con el endpoint, el mediator y el almacén emitidos ───\n\n${[...methods, helpers].join('\n\n')}` };
}
