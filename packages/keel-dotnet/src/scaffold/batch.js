// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`, modo `sync`) en keel-dotnet: incremento 3 de
// PLAN-DSL-230-LOTES.md, el gemelo del `BatchRunner` de keel-spring y del `batch.ts` de keel-nest. Lo que decide QUÉ
// (qué operaciones son lotes, qué falla solo su elemento, qué detiene el lote, la respuesta como referencia ejecutable,
// la nota) es de keel-core (gen/batch.js); aquí solo se escribe en C#:
//
//   · el lector de la operación (endpoints.js) lee el SOBRE: el campo que se recorre llega como JsonElement sin leer, y
//     solo se validan su presencia y su `maxItems` (BA-7). Leído con `JsonBodyReader.List(…, ReadProductDraft)`, el
//     primer elemento mal formado sería un 400 del lote entero (D3);
//   · `Api/Rest/Batch.cs`: el bucle. Cada elemento se lee con el MISMO `ValueReaders.Read<Elemento>` que usa el borde (las
//     guardas del constructor del value object incluidas), así que «mal formado» significa lo mismo dentro del lote que
//     fuera, y su fallo es su `failed` con VALIDATION_ERROR y el mensaje de la guarda. Después se despacha por el
//     mediator, que abre una transacción por elemento (D2) con su reintento del conflicto transitorio. Un fallo se
//     traduce con el propio ApiErrorMiddleware: el `code` y el `message` del elemento son los que respondería la operación
//     sola;
//   · `BatchResponse`: la forma de wire-contract.md § Lotes, con las cinco claves de cada elemento siempre (también con
//     `conventions.nulls: omit`: no lleva la marca [OmitNulls]).
//
// El handler de la operación procesa UN elemento: su mensaje lleva el elemento (`Item`) en vez de la lista (services.js),
// y devuelve `<Op>ItemResult` cuando el diseño declara `batch.output` (keel-core/gen/model.js).

import { usesBatch, batchModelOperations, BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, BATCH_MULTI_STATUS } from '@keel-system/keel-core/gen/batch';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { csFile, csString, located, namespaceOf } from './render.js';

export { usesBatch };

/** El componente del mensaje que lleva el elemento del lote. */
export const BATCH_ITEM_COMPONENT = 'item';

/** ¿Hay algún lote que se confirma entero? */
export const usesAllOrNothing = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'all-or-nothing');

export function generate(model) {
  if (!usesBatch(model)) return [];
  const { namespace, path } = located(model, 'rest', 'Batch');
  const usings = ['System.Text.Json', 'System.Text.Json.Serialization', namespaceOf(model, 'appSupport'), namespaceOf(model, 'errors')];
  if (usesAllOrNothing(model)) usings.push(namespaceOf(model, 'useCaseInfra'));
  return [{ path, content: csFile({ namespace, usings, body: batchBody(model) }) }];
}

function batchBody(model) {
  const validation = FRAMEWORK_ERRORS.validation.code;
  const aborted = FRAMEWORK_ERRORS.batchAborted.code;
  const allOrNothing = usesAllOrNothing(model)
    ? `

    /// <summary>
    /// Un lote <c>all-or-nothing</c>: todos los elementos en UNA transacción (la abre aquí IUseCaseTransactions, y los
    /// despachos del mediator se unen a ella). El primer fallo la revierte entera y el desenlace es su error, con la ruta
    /// del elemento culpable en <c>details</c> (<c>items[7]</c>); sin fallos, el mismo cuerpo que un lote por elemento,
    /// con el <c>successStatus</c> del endpoint.
    /// </summary>
    /// <remarks>
    /// Un fallo AL CONFIRMAR no es de ningún elemento: sale sin índice, por el middleware, como el de cualquier operación. Con
    /// <paramref name="sink"/> (un lote con clave, DSL 2.30, D15), cada resultado y el final del trabajo se guardan dentro de
    /// la misma transacción: un fallo del sink la revierte entera y sale tal cual.
    /// </remarks>
    public static async Task<AtomicOutcome> AllOrNothing<T>(
        string over,
        IReadOnlyList<JsonElement> items,
        Func<JsonElement?, T?> read,
        IUseCaseTransactions transactions,
        Func<T, Task<object?>> process,
        Func<Exception, ErrorResponse> translate,
        IAtomicSink? sink,
        CancellationToken cancellationToken)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(transactions);
        ArgumentNullException.ThrowIfNull(process);
        ArgumentNullException.ThrowIfNull(translate);
        try
        {
            var results = await transactions.Run(
                async () =>
                {
                    var done = new List<BatchItem>();
                    for (var index = 0; index < items.Count; index++)
                    {
                        T item;
                        try
                        {
                            item = ReadItem(items[index], read) ?? throw Invalid;
                        }
                        catch (InvalidItemException invalid)
                        {
                            throw new ItemFailure(index, ErrorResponse.Of(${FW.invalidBody.status}, ${csString(FW.invalidBody.error)}, ValidationError, invalid.Message));
                        }
                        BatchItem kept;
                        try
                        {
                            kept = BatchItem.Succeeded(index, await process(item));
                        }
                        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                        {
                            throw;
                        }
                        catch (Exception error)
                        {
                            // Ya traducido y sin causa: la transacción que revierte no tiene que volver a traducirlo (la
                            // traducción de la persistencia mira la cadena de causas y perdería el índice).
                            throw new ItemFailure(index, translate(error));
                        }
                        done.Add(kept);
                        if (sink is not null)
                        {
                            await sink.Kept(kept, cancellationToken);
                        }
                    }
                    if (sink is not null)
                    {
                        await sink.Completed(cancellationToken);
                    }
                    return done;
                },
                readOnly: false,
                cancellationToken);
            return new AtomicOutcome(BatchResponse.Of(results), null);
        }
        catch (ItemFailure failure)
        {
            var failed = failure.Response;
            return new AtomicOutcome(null, ErrorResponse.Of(failed.Status, failed.Error, failed.Code, failed.Message, [$"{over}[{failure.Index}]"]));
        }
    }

    /// <summary>El fallo de un elemento de un lote all-or-nothing: revierte la transacción y lleva su índice hasta la respuesta.</summary>
    private sealed class ItemFailure(int index, ErrorResponse response) : Exception(response.Message)
    {
        public int Index { get; } = index;

        public ErrorResponse Response { get; } = response;
    }`
    : '';
  const atomicOutcome = usesAllOrNothing(model)
    ? `

/// <summary>El desenlace de un lote todo o nada: el cuerpo con su successStatus, o el error del elemento culpable.</summary>
public sealed record AtomicOutcome(BatchResponse? Body, ErrorResponse? Error);

/// <summary>
/// Lo que guarda un lote todo o nada con clave (DSL 2.30, D15) DENTRO de su transacción: el resultado de cada elemento y el
/// final del trabajo. Si el lote falla, la transacción se lo lleva todo.
/// </summary>
public interface IAtomicSink
{
    Task Kept(BatchItem item, CancellationToken cancellationToken);

    Task Completed(CancellationToken cancellationToken);
}`
    : '';
  return `// El bucle de los lotes con resultado por elemento (DSL 2.30, wire-contract.md § Lotes). El handler de la operación
// procesa UN elemento; esto lo llama una vez por elemento, en orden de índice y sin paralelismo, y compone la respuesta.
//
// Cada elemento se lee con el MISMO lector que el borde aplica a una petición suelta (D3): un elemento mal formado es su
// \`failed\` con ${validation}, no un 400 del lote. Su fallo se traduce con ApiErrorMiddleware, así que el \`code\` y el
// \`message\` son los que daría la operación sola.
//
// No lo edites: lo regenera build.

/// <summary>
/// Un elemento, con sus cinco claves SIEMPRE: null donde no aplica. Su forma es estable, como la del cuerpo de error, y
/// no depende de conventions.nulls; por eso el tipo no lleva la marca [OmitNulls].
/// </summary>
public sealed record BatchItem
{
    [JsonPropertyName("index")]
    public required int Index { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("result")]
    public required object? Result { get; init; }

    [JsonPropertyName("error")]
    public required string? Error { get; init; }

    [JsonPropertyName("message")]
    public required string? Message { get; init; }

    public static BatchItem Succeeded(int index, object? result) =>
        new() { Index = index, Status = "succeeded", Result = result, Error = null, Message = null };

    public static BatchItem Failed(int index, string error, string? message) =>
        new() { Index = index, Status = "failed", Result = null, Error = error, Message = message };

    public static BatchItem NotAttempted(int index) =>
        new() { Index = index, Status = "notAttempted", Result = null, Error = null, Message = null };
}

/// <summary>Cuántos elementos hay y cómo acabó cada uno.</summary>
public sealed record BatchSummary(
    [property: JsonPropertyName("total")] int Total,
    [property: JsonPropertyName("succeeded")] int Succeeded,
    [property: JsonPropertyName("failed")] int Failed,
    [property: JsonPropertyName("notAttempted")] int NotAttempted);

/// <summary>
/// La respuesta de un lote (wire-contract.md § Lotes): el resumen y un resultado por elemento, en orden de índice. La
/// forma no la declara el diseño: es la misma en todas las operaciones por lotes y en los cuatro generadores.
/// </summary>
public sealed record BatchResponse(
    [property: JsonPropertyName("summary")] BatchSummary Summary,
    [property: JsonPropertyName("items")] IReadOnlyList<BatchItem> Items)
{
    public static BatchResponse Of(IReadOnlyList<BatchItem> items)
    {
        ArgumentNullException.ThrowIfNull(items);
        int Count(string status) => items.Count(item => item.Status == status);
        return new BatchResponse(new BatchSummary(items.Count, Count("succeeded"), Count("failed"), Count("notAttempted")), [.. items]);
    }
}${atomicOutcome}

/// <summary>El sobre de un lote, leído: los elementos SIN leer y cómo construir el mensaje de UNO, con lo demás ya leído.</summary>
public sealed record BatchEnvelope<TItem, TMessage>(IReadOnlyList<JsonElement> Items, Func<TItem, TMessage> Message);

/// <summary>El bucle de los lotes: lo llama el endpoint de cada operación por lotes.</summary>
public static class BatchRunner
{
    /// <summary>El fallo de forma de un elemento: falla solo él (D3).</summary>
    public const string ValidationError = ${csString(validation)};

    /// <summary>El elemento que detiene el lote sin un code propio (D4, framework-errors.md).</summary>
    public const string BatchAborted = ${csString(aborted)};

    public const string BatchAbortedMessage = ${csString(BATCH_ABORTED_MESSAGE)};

    public const string MalformedMessage = ${csString(BATCH_ITEM_MALFORMED_MESSAGE)};

    /// <summary>El status de un lote por elemento: siempre el mismo, también si todo salió bien (D1).</summary>
    public const int MultiStatus = ${BATCH_MULTI_STATUS};

    /// <summary>
    /// Un lote <c>per-item</c>: una transacción por elemento (la abre el mediator en cada despacho), y la respuesta es
    /// SIEMPRE ${BATCH_MULTI_STATUS} (D1), también si todo salió bien.
    /// </summary>
    /// <remarks>
    /// Fallan solo su elemento los codes de <c>itemErrors</c> y ${validation}. Cualquier otro fallo DETIENE el lote (D4):
    /// ese elemento sale <c>failed</c> con su code, o con ${aborted} si no tiene; lo anterior queda confirmado y lo
    /// siguiente sale <c>notAttempted</c>, que es lo que el cliente tiene que reenviar.
    /// </remarks>
    public static async Task<BatchResponse> PerItem<T>(
        IReadOnlyList<JsonElement> items,
        Func<JsonElement?, T?> read,
        IReadOnlyCollection<string> itemErrors,
        Func<T, Task<object?>> process,
        Func<Exception, ErrorResponse> translate,
        CancellationToken cancellationToken)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(itemErrors);
        ArgumentNullException.ThrowIfNull(process);
        ArgumentNullException.ThrowIfNull(translate);
        var results = new List<BatchItem>(items.Count);
        var stopped = false;
        for (var index = 0; index < items.Count; index++)
        {
            if (stopped)
            {
                results.Add(BatchItem.NotAttempted(index));
                continue;
            }
            T item;
            try
            {
                item = ReadItem(items[index], read) ?? throw Invalid;
            }
            catch (InvalidItemException invalid)
            {
                results.Add(BatchItem.Failed(index, ValidationError, invalid.Message));
                continue;
            }
            try
            {
                results.Add(BatchItem.Succeeded(index, await process(item)));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                var (failed, stops) = FailureOf(index, translate(error), itemErrors);
                results.Add(failed);
                if (stops)
                {
                    stopped = true;
                }
            }
        }
        return BatchResponse.Of(results);
    }${allOrNothing}

    /// <summary>
    /// El resultado de un elemento que falló, desde el cuerpo de error que respondería la operación sola, y si DETIENE el
    /// lote: fallan solo su elemento los codes de <c>itemErrors</c> y ${validation}; cualquier otro fallo lo detiene (D4) con su
    /// code, o con ${aborted} si no tiene. Una sola regla para el lote síncrono y el procesador de los trabajos asíncronos.
    /// </summary>
    internal static (BatchItem Item, bool Stops) FailureOf(int index, ErrorResponse response, IReadOnlyCollection<string> itemErrors)
    {
        ArgumentNullException.ThrowIfNull(response);
        ArgumentNullException.ThrowIfNull(itemErrors);
        if (response.Code is { } code && (code == ValidationError || itemErrors.Contains(code)))
        {
            return (BatchItem.Failed(index, code, response.Message), false);
        }
        return (response.Code is { } stop ? BatchItem.Failed(index, stop, response.Message) : BatchItem.Failed(index, BatchAborted, BatchAbortedMessage), true);
    }

    /// <summary>
    /// El elemento como lo leería el borde: el lector de su value object, con las guardas de su constructor. Un null, o un
    /// valor que no se puede leer como el tipo, es su ${validation} con el mensaje de la guarda que lo rechazó, o el
    /// genérico. Null solo si el lector no devolvió nada (otro ${validation} con el genérico).
    /// </summary>
    internal static T? ReadItem<T>(JsonElement value, Func<JsonElement?, T?> read)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(read);
        if (value.ValueKind == JsonValueKind.Null)
        {
            throw Invalid;
        }
        try
        {
            return read(value);
        }
        catch (MalformedRequestException malformed)
        {
            throw new InvalidItemException(GuardMessage(malformed));
        }
    }

    /// <summary>El mensaje de la guarda del value object que rechazó el elemento, o el genérico si no fue una guarda.</summary>
    private static string GuardMessage(Exception error)
    {
        for (var cause = error.InnerException; cause is not null; cause = cause.InnerException)
        {
            if (cause is InvalidValueException guard && !string.IsNullOrEmpty(guard.Message))
            {
                return guard.Message;
            }
        }
        return MalformedMessage;
    }

    internal static InvalidItemException Invalid => new(MalformedMessage);

    /// <summary>Un elemento mal formado: su mensaje es el que viaja en el resultado.</summary>
    internal sealed class InvalidItemException(string message) : Exception(message);
}`;
}
