// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`, modo `sync`) en keel-go: incremento 4 de
// PLAN-DSL-230-LOTES.md, el gemelo del `BatchRunner` de keel-spring, del `batch.ts` de keel-nest y del `Batch.cs` de
// keel-dotnet. Lo que decide QUÉ (qué operaciones son lotes, qué falla solo su elemento, qué detiene el lote, la respuesta
// como referencia ejecutable, la nota) es de keel-core (gen/batch.js); aquí solo se escribe en Go:
//
//   · el lector de la operación (endpoints.js) lee el SOBRE: el campo que se recorre llega como `[]jsontext.Value` sin
//     leer, y solo se validan su presencia y su `maxItems` (BA-7). Leído con `member` sobre `[]domain.<Elemento>`, el
//     primer elemento mal formado sería un 400 del lote entero (D3). Devuelve el mensaje con todo lo demás ya leído y los
//     elementos, y el endpoint pone en el mensaje uno cada vez;
//   · `internal/httpapi/batch.go`: el bucle. Cada elemento se lee con el MISMO `wire.Unmarshal` que usa el borde (las
//     guardas del constructor del value object incluidas), así que «mal formado» significa lo mismo dentro del lote que
//     fuera, y su fallo es su `failed` con VALIDATION_ERROR y el mensaje de la guarda. Después se despacha por su campo de
//     UseCases, que abre una transacción por elemento (D2) con su reintento del conflicto transitorio. Un fallo se traduce
//     con el propio `errorResponse` de la API: el `code` y el `message` del elemento son los que respondería la operación
//     sola;
//   · `BatchResponse`: la forma de wire-contract.md § Lotes, con las cinco claves de cada elemento siempre (sin
//     `omitzero`: no depende de `conventions.nulls`).
//
// El handler de la operación procesa UN elemento: su mensaje lleva el elemento (`Item`) en vez de la lista (services.js),
// y devuelve `<Op>ItemResult` cuando el diseño declara `batch.output` (keel-core/gen/model.js). El todo o nada abre la
// transacción del lote con `UseCases.InTransaction` (use-cases.js), y cada despacho se une a ella.

import { usesBatch, batchModelOperations, BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, BATCH_MULTI_STATUS } from '@keel-system/keel-core/gen/batch';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';

export { usesBatch };

/** El componente del mensaje que lleva el elemento del lote. */
export const BATCH_ITEM_COMPONENT = 'item';

/** ¿Hay algún lote que se confirma entero? */
export const usesAllOrNothing = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'all-or-nothing');

/** ¿Hay algún lote SÍNCRONO que responde por elemento (207)? */
const usesSyncPerItem = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'per-item' && batch.execution !== 'async');

/** ¿Hay algún lote que responde por elemento, síncrono o asíncrono (un trabajo es siempre per-item, D14)? */
const usesPerItem = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'per-item');

export function generate(model) {
  if (!usesBatch(model)) return [];
  const { httpapi } = layout(model);
  const imports = ['context', 'encoding/json/jsontext', 'errors', 'fmt', 'net/http', 'slices', 'internal/domain', 'internal/platform/wire'];
  return [{ path: `${httpapi.dir}/batch.go`, content: packageFile(model, httpapi, { imports, body: batchBody(model) }) }];
}

function batchBody(model) {
  const validation = FRAMEWORK_ERRORS.validation.code;
  const aborted = FRAMEWORK_ERRORS.batchAborted.code;
  const perItem = usesSyncPerItem(model)
    ? `
// runPerItem es un lote per-item: una transacción por elemento (la abre el caso de uso en cada despacho), en orden de
// índice y sin paralelismo, y la respuesta es SIEMPRE ${BATCH_MULTI_STATUS} (D1), también si todo salió bien.
//
// Fallan solo su elemento los codes de itemErrors y ${validation}. Cualquier otro fallo DETIENE el lote (D4): ese
// elemento sale failed con su code, o con ${aborted} si no tiene; lo anterior queda confirmado y lo siguiente sale
// notAttempted, que es lo que el cliente tiene que reenviar. Solo devuelve un error si el cliente se fue.
func runPerItem[T any](a *api, r *http.Request, items []jsontext.Value, itemErrors []string, process func(context.Context, T) (any, error)) (BatchResponse, error) {
	results := make([]BatchItem, 0, len(items))
	stopped := false
	for index, raw := range items {
		if stopped {
			results = append(results, batchNotAttempted(index))
			continue
		}
		item, problem := readBatchItem[T](raw)
		if problem != "" {
			results = append(results, batchFailed(index, validationCode, problem))
			continue
		}
		result, err := process(r.Context(), item)
		if err == nil {
			results = append(results, batchSucceeded(index, result))
			continue
		}
		if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
			return BatchResponse{}, err
		}
		failure, stops := batchFailureOf(index, a.errorResponse(r, err), itemErrors)
		results = append(results, failure)
		stopped = stops
	}
	return newBatchResponse(results), nil
}

// batchNotAttempted es un elemento que no se intentó porque el lote se detuvo antes.
func batchNotAttempted(index int) BatchItem {
	return BatchItem{Index: index, Status: "notAttempted"}
}
`
    : '';
  // La regla de qué falla solo su elemento y qué detiene el lote: la comparten el bucle síncrono y el procesador de los
  // trabajos asíncronos (batch-jobs.js).
  const failure = usesPerItem(model)
    ? `
// batchFailureOf es el resultado de un elemento que falló y si detiene el lote (D4): fallan solo su elemento los codes de
// itemErrors y ${validation}; cualquier otro fallo lo detiene, con su code o con ${aborted} si no tiene.
func batchFailureOf(index int, response ErrorResponse, itemErrors []string) (BatchItem, bool) {
	if response.Code == nil {
		return batchFailed(index, batchAbortedCode, batchAbortedMessage), true
	}
	stops := *response.Code != validationCode && !slices.Contains(itemErrors, *response.Code)
	return batchFailed(index, *response.Code, response.Message), stops
}
`
    : '';
  const compose = usesSyncPerItem(model) || usesAllOrNothing(model)
    ? `
// newBatchResponse compone la respuesta de los resultados de cada elemento.
func newBatchResponse(items []BatchItem) BatchResponse {
	summary := BatchSummary{Total: len(items)}
	for _, item := range items {
		switch item.Status {
		case "succeeded":
			summary.Succeeded++
		case "failed":
			summary.Failed++
		case "notAttempted":
			summary.NotAttempted++
		}
	}
	return BatchResponse{Summary: summary, Items: items}
}
`
    : '';
  const allOrNothing = usesAllOrNothing(model)
    ? `
// runAllOrNothing es un lote all-or-nothing: todos los elementos en UNA transacción (la abre within, y los casos de uso
// que se despachan con su contexto se unen a ella). El primer fallo la revierte entera y el desenlace es su error, con la
// ruta del elemento culpable en details (items[7]); sin fallos, el mismo cuerpo que un lote por elemento, con el
// successStatus del endpoint. Un fallo AL CONFIRMAR no es de ningún elemento: vuelve como error, sin índice, y lo
// responde writeError como el de cualquier operación. Con sink (un lote con clave, D15), cada resultado y el final del
// trabajo se guardan dentro de la misma transacción: un fallo del sink la revierte entera y vuelve tal cual.
func runAllOrNothing[T any](a *api, r *http.Request, over string, items []jsontext.Value, within func(context.Context, func(context.Context) error) error, process func(context.Context, T) (any, error), sink *batchSink) (*BatchResponse, *ErrorResponse, error) {
	var results []BatchItem
	err := within(r.Context(), func(ctx context.Context) error {
		// Desde cero en cada intento: un conflicto transitorio repite la transacción entera.
		results = make([]BatchItem, 0, len(items))
		for index, raw := range items {
			item, problem := readBatchItem[T](raw)
			if problem != "" {
				return &batchItemFailure{index: index, response: newErrorResponse(r, ${FW.invalidBody.status}, ${goString(FW.invalidBody.error)}, new(validationCode), problem, nil)}
			}
			result, err := process(ctx, item)
			if err != nil {
				if errors.Is(err, context.Canceled) && ctx.Err() != nil {
					return err
				}
				// Ya traducido y sin causa: la transacción que revierte no lo vuelve a traducir.
				return &batchItemFailure{index: index, response: a.errorResponse(r, err)}
			}
			kept := batchSucceeded(index, result)
			results = append(results, kept)
			if sink != nil {
				if err := sink.kept(ctx, kept); err != nil {
					return err
				}
			}
		}
		if sink != nil {
			return sink.completed(ctx)
		}
		return nil
	})
	var failure *batchItemFailure
	if errors.As(err, &failure) {
		response := failure.response
		response.Details = Details{fmt.Sprintf("%s[%d]", over, failure.index)}
		return nil, &response, nil
	}
	if err != nil {
		return nil, nil, err
	}
	body := newBatchResponse(results)
	return &body, nil, nil
}

// batchSink es lo que guarda un lote all-or-nothing con clave (DSL 2.30, D15) DENTRO de su transacción: el resultado de cada
// elemento y el final del trabajo. Si el lote falla, la transacción se lo lleva todo.
type batchSink struct {
	kept      func(context.Context, BatchItem) error
	completed func(context.Context) error
}

// batchItemFailure es el fallo de un elemento de un lote all-or-nothing: revierte la transacción y lleva su índice hasta
// la respuesta.
type batchItemFailure struct {
	index    int
	response ErrorResponse
}

// Error es el mensaje del fallo del elemento.
func (f *batchItemFailure) Error() string {
	return fmt.Sprintf("el elemento %d del lote falló: %s", f.index, f.response.Message)
}
`
    : '';
  return `
// El bucle de los lotes con resultado por elemento (DSL 2.30, wire-contract.md § Lotes). El caso de uso de la operación
// procesa UN elemento; esto lo llama una vez por elemento, en orden de índice y sin paralelismo, y compone la respuesta.
//
// Cada elemento se lee con el MISMO lector que el borde aplica a una petición suelta (D3): un elemento mal formado es su
// failed con ${validation}, no un 400 del lote. Su fallo se traduce con errorResponse, así que el code y el message son
// los que daría la operación sola.

${usesSyncPerItem(model) ? `// batchMultiStatus es el status de un lote por elemento: siempre el mismo, también si todo salió bien (D1).
const batchMultiStatus = ${BATCH_MULTI_STATUS}

` : ''}${usesPerItem(model) ? `// batchAbortedCode es el error del elemento que detiene el lote sin un code propio (D4, framework-errors.md).
const batchAbortedCode = ${goString(aborted)}

// batchAbortedMessage es el mensaje de ese elemento.
const batchAbortedMessage = ${goString(BATCH_ABORTED_MESSAGE)}

` : ''}// batchMalformedMessage es el mensaje de un elemento mal formado cuando ninguna guarda dice por qué.
const batchMalformedMessage = ${goString(BATCH_ITEM_MALFORMED_MESSAGE)}

// BatchItem es un elemento de la respuesta de un lote, con sus cinco claves SIEMPRE: null donde no aplica. Su forma es
// estable, como la del cuerpo de error, y no depende de conventions.nulls.
type BatchItem struct {
	Index   int     \`json:"index"\`
	Status  string  \`json:"status"\`
	Result  any     \`json:"result"\`
	Error   *string \`json:"error"\`
	Message *string \`json:"message"\`
}

// BatchSummary dice cuántos elementos hay y cómo acabó cada uno.
type BatchSummary struct {
	Total        int \`json:"total"\`
	Succeeded    int \`json:"succeeded"\`
	Failed       int \`json:"failed"\`
	NotAttempted int \`json:"notAttempted"\`
}

// BatchResponse es la respuesta de un lote (wire-contract.md § Lotes): el resumen y un resultado por elemento, en orden
// de índice. La forma no la declara el diseño: es la misma en todas las operaciones por lotes y en los cuatro
// generadores.
type BatchResponse struct {
	Summary BatchSummary \`json:"summary"\`
	Items   []BatchItem  \`json:"items"\`
}

// batchSucceeded es un elemento confirmado, con lo que devolvió su caso de uso (nil si no devuelve nada).
func batchSucceeded(index int, result any) BatchItem {
	return BatchItem{Index: index, Status: "succeeded", Result: result}
}

// batchFailed es un elemento que falló, con su code y su mensaje.
func batchFailed(index int, code, message string) BatchItem {
	return BatchItem{Index: index, Status: "failed", Error: &code, Message: &message}
}
${compose}${perItem}${failure}${allOrNothing}
// readBatchItem lee un elemento como lo leería el borde: con el contrato del cable y el constructor de su value object,
// con sus guardas. Devuelve el motivo si no se puede: el mensaje de la guarda que lo rechazó, o el genérico (también
// para un null).
func readBatchItem[T any](raw jsontext.Value) (T, string) {
	var item T
	if raw.Kind() == 'n' {
		return item, batchMalformedMessage
	}
	if err := wire.Unmarshal(raw, &item); err != nil {
		var guard *domain.Error
		if errors.As(err, &guard) && guard.Code() == validationCode && guard.Message() != "" {
			return item, guard.Message()
		}
		return item, batchMalformedMessage
	}
	return item, ""
}
`;
}
