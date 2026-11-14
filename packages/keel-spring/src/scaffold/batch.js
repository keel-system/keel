// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`, modo `sync`) en keel-spring: incremento 1 de
// PLAN-DSL-230-LOTES.md. Lo que decide QUÉ (qué operaciones son lotes, qué falla solo su elemento, qué detiene el lote,
// la respuesta como referencia ejecutable, la nota) es de keel-core (gen/batch.js); aquí solo se escribe en Java:
//
//   · `<Op>BatchRequest`: el SOBRE del lote, que es lo único que valida el borde (D3). El campo que se recorre llega como
//     `List<JsonNode>`: con `List<<Elemento>>`, Jackson construiría todos los elementos al leer el cuerpo y el primero mal
//     formado sería un 400 del lote entero. Son 400 solo el campo ausente o con más elementos que su `maxItems` (BA-7).
//   · `BatchRunner`: el bucle. Cada elemento se lee con el MISMO ObjectMapper y se valida con el MISMO Validator que el
//     borde (las guardas del value object y su Bean Validation), así que «mal formado» significa lo mismo dentro del lote
//     que fuera; y su fallo es su `failed` con VALIDATION_ERROR. Después se despacha por el mediator, que abre una
//     transacción por elemento (D2) con su reintento del conflicto transitorio. Un fallo se traduce con el propio
//     ApiExceptionHandler: el `code` y el `message` del elemento son los que respondería la operación sola.
//   · `BatchResponse`: la forma de wire-contract.md § Lotes, con las cinco claves de cada elemento siempre (también con
//     `conventions.nulls: omit`).
//
// El handler de la operación procesa UN elemento: su mensaje lleva el elemento (`item`) en vez de la lista, y devuelve
// `<Op>ItemResult` cuando el diseño declara `batch.output` (src/lib/model.js, `shapeBatchOperation`).

import { usesBatch, batchModelOperations, BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE } from '@keel-system/keel-core/gen/batch';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { javaFile, javaPath, subPackage } from './render.js';
import { domainTypeImport } from './entities.js';
import { REST_PKG } from './conditional-writes.js';

export const BATCH_PKG = 'infrastructure.rest.batch';
export const BATCH_ITEM_COMPONENT = 'item';

const javaText = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

export { usesBatch };

/** El record del sobre de una operación por lotes. */
export const batchRequestClass = (operation) => `${capital(operation.name)}BatchRequest`;

/** ¿Hay algún lote que se confirma entero? Solo entonces el runner necesita la transacción abarcadora. */
const usesAllOrNothing = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'all-or-nothing');

export function generate(model) {
  if (!usesBatch(model)) return [];
  const files = [renderResponse(model), renderRunner(model)];
  for (const operation of model.services.flatMap((service) => service.operations)) {
    if (operation.batch) files.push(renderRequest(model, operation));
  }
  return files;
}

function renderResponse(model) {
  const body = `/**
 * La respuesta de un lote (DSL 2.30, wire-contract.md § Lotes): el resumen y un resultado por elemento, en orden de
 * índice. La forma no la declara el diseño: es la misma en todas las operaciones por lotes y en los cuatro generadores.
 */
public record BatchResponse(Summary summary, List<Item> items) {

    /** Cuántos elementos hay y cómo acabó cada uno. */
    public record Summary(int total, int succeeded, int failed, int notAttempted) {
    }

    /**
     * Un elemento, con sus cinco claves SIEMPRE: null donde no aplica. Su forma es estable, como la del cuerpo de error,
     * y no depende de conventions.nulls; por eso lleva su propia inclusión.
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Item(int index, String status, Object result, String error, String message) {

        public static Item succeeded(int index, Object result) {
            return new Item(index, "succeeded", result, null, null);
        }

        public static Item failed(int index, String error, String message) {
            return new Item(index, "failed", null, error, message);
        }

        public static Item notAttempted(int index) {
            return new Item(index, "notAttempted", null, null, null);
        }
    }

    public static BatchResponse of(List<Item> items) {
        int succeeded = 0;
        int failed = 0;
        int notAttempted = 0;
        for (Item item : items) {
            switch (item.status()) {
                case "succeeded" -> succeeded++;
                case "failed" -> failed++;
                default -> notAttempted++;
            }
        }
        return new BatchResponse(new Summary(items.size(), succeeded, failed, notAttempted), List.copyOf(items));
    }
}`;
  return {
    path: javaPath(model, BATCH_PKG, 'BatchResponse'),
    content: javaFile(subPackage(model, BATCH_PKG), ['com.fasterxml.jackson.annotation.JsonInclude', 'java.util.List'], body)
  };
}

function renderRunner(model) {
  const atomic = usesAllOrNothing(model);
  const transactional = atomic && model.layersPresent.persistence;
  const validation = FRAMEWORK_ERRORS.validation.code;
  const aborted = FRAMEWORK_ERRORS.batchAborted.code;
  const imports = [
    `${subPackage(model, REST_PKG)}.ApiExceptionHandler`,
    `${subPackage(model, REST_PKG)}.ErrorResponse`,
    'jakarta.validation.ConstraintViolation',
    'jakarta.validation.Validator',
    'java.lang.reflect.InvocationTargetException',
    'java.lang.reflect.Method',
    'java.util.ArrayList',
    'java.util.List',
    'java.util.Set',
    'java.util.function.Function',
    'java.util.stream.Collectors',
    'org.springframework.http.HttpStatus',
    'org.springframework.http.ResponseEntity',
    'org.springframework.stereotype.Component',
    'org.springframework.web.method.annotation.ExceptionHandlerMethodResolver',
    'tools.jackson.core.JacksonException',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper'
  ];
  if (transactional) imports.push('org.springframework.transaction.PlatformTransactionManager', 'org.springframework.transaction.support.TransactionTemplate');

  const fields = [
    '    private final ObjectMapper mapper;',
    '    private final Validator validator;',
    '    private final ApiExceptionHandler errors;',
    ...(transactional ? ['    private final TransactionTemplate transaction;'] : [])
  ];
  const params = ['ObjectMapper mapper', 'Validator validator', 'ApiExceptionHandler errors', ...(transactional ? ['PlatformTransactionManager transactionManager'] : [])];
  const assigns = [
    '        this.mapper = mapper;',
    '        this.validator = validator;',
    '        this.errors = errors;',
    ...(transactional ? ['        this.transaction = new TransactionTemplate(transactionManager);'] : [])
  ];

  const allOrNothing = atomic
    ? `

    /**
     * Un lote {@code all-or-nothing}: todos los elementos en UNA transacción. El primer fallo la revierte entera y la
     * respuesta es su error, con la ruta del elemento culpable en {@code details} ({@code items[7]}); sin fallos, el
     * mismo cuerpo que un lote por elemento con el {@code successStatus} del endpoint.
     *
     * <p>Un fallo AL CONFIRMAR (una unicidad que el motor comprueba en el commit) no es de ningún elemento: sale sin
     * índice, traducido por ApiExceptionHandler como el de cualquier operación.
     */
    public <T> ResponseEntity<?> allOrNothing(String over, List<JsonNode> items, Class<T> itemType, HttpStatus successStatus,
            Function<T, Object> process) {
        try {
            List<BatchResponse.Item> results = ${transactional ? 'transaction.execute(status -> processAll(items, itemType, process))' : 'processAll(items, itemType, process)'};
            return ResponseEntity.status(successStatus).body(BatchResponse.of(results));
        } catch (ItemFailure failure) {
            ErrorResponse error = failure.invalid != null ? invalidResponse(failure.invalid) : translate(failure.error);
            List<String> details = List.of(over + "[" + failure.index + "]");
            return ResponseEntity.status(error.status())
                    .body(new ErrorResponse(error.status(), error.error(), error.code(), error.message(), details));
        }
    }

    private <T> List<BatchResponse.Item> processAll(List<JsonNode> items, Class<T> itemType, Function<T, Object> process) {
        List<BatchResponse.Item> results = new ArrayList<>(items.size());
        for (int index = 0; index < items.size(); index++) {
            T item;
            try {
                item = read(items.get(index), itemType);
            } catch (InvalidItem invalid) {
                throw new ItemFailure(index, invalid, null);
            }
            try {
                results.add(BatchResponse.Item.succeeded(index, process.apply(item)));
            } catch (RuntimeException ex) {
                throw new ItemFailure(index, null, ex);
            }
        }
        return results;
    }

    private static ErrorResponse invalidResponse(InvalidItem invalid) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Validation Error", VALIDATION_ERROR, invalid.getMessage(), null);
    }

    /** El fallo de un elemento de un lote all-or-nothing: revierte la transacción y lleva su índice hasta la respuesta. */
    private static final class ItemFailure extends RuntimeException {

        private final int index;
        private final InvalidItem invalid;
        private final RuntimeException error;

        ItemFailure(int index, InvalidItem invalid, RuntimeException error) {
            super(null, null, false, false);
            this.index = index;
            this.invalid = invalid;
            this.error = error;
        }
    }`
    : '';

  const body = `/**
 * El bucle de los lotes con resultado por elemento (DSL 2.30, wire-contract.md § Lotes). El handler de la operación
 * procesa UN elemento; esto lo llama una vez por elemento, en orden de índice y sin paralelismo, y compone la respuesta.
 *
 * <p>Cada elemento se lee con el ObjectMapper y se valida con el Validator de la aplicación, los mismos que el borde
 * aplica a una petición suelta (D3): un elemento mal formado es su {@code failed} con ${validation}, no un 400 del
 * lote. Su fallo se traduce con ApiExceptionHandler, así que el {@code code} y el {@code message} son los que daría la
 * operación sola.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class BatchRunner {

    /** El fallo de forma de un elemento: falla solo él (D3). */
    static final String VALIDATION_ERROR = ${javaText(validation)};

    /** El elemento que detiene el lote sin un code propio (D4, framework-errors.md). */
    static final String BATCH_ABORTED = ${javaText(aborted)};

    static final String BATCH_ABORTED_MESSAGE = ${javaText(BATCH_ABORTED_MESSAGE)};

    static final String MALFORMED_MESSAGE = ${javaText(BATCH_ITEM_MALFORMED_MESSAGE)};

    private static final ExceptionHandlerMethodResolver TRANSLATIONS = new ExceptionHandlerMethodResolver(ApiExceptionHandler.class);

${fields.join('\n')}

    public BatchRunner(${params.join(', ')}) {
${assigns.join('\n')}
    }

    /**
     * Un lote {@code per-item}: una transacción por elemento (la abre el mediator en cada despacho), y la respuesta es
     * SIEMPRE 207 (D1), también si todo salió bien.
     *
     * <p>Fallan solo su elemento los codes de {@code itemErrors} y ${validation}. Cualquier otro fallo DETIENE el lote
     * (D4): ese elemento sale {@code failed} con su code, o con ${aborted} si no tiene; lo anterior queda confirmado y lo
     * siguiente sale {@code notAttempted}, que es lo que el cliente tiene que reenviar.
     */
    public <T> ResponseEntity<BatchResponse> perItem(List<JsonNode> items, Class<T> itemType, Set<String> itemErrors,
            Function<T, Object> process) {
        List<BatchResponse.Item> results = new ArrayList<>(items.size());
        boolean stopped = false;
        for (int index = 0; index < items.size(); index++) {
            if (stopped) {
                results.add(BatchResponse.Item.notAttempted(index));
                continue;
            }
            T item;
            try {
                item = read(items.get(index), itemType);
            } catch (InvalidItem invalid) {
                results.add(BatchResponse.Item.failed(index, VALIDATION_ERROR, invalid.getMessage()));
                continue;
            }
            try {
                results.add(BatchResponse.Item.succeeded(index, process.apply(item)));
            } catch (RuntimeException ex) {
                ErrorResponse error = translate(ex);
                String code = error.code();
                if (code != null && (VALIDATION_ERROR.equals(code) || itemErrors.contains(code))) {
                    results.add(BatchResponse.Item.failed(index, code, error.message()));
                } else {
                    stopped = true;
                    results.add(code != null
                            ? BatchResponse.Item.failed(index, code, error.message())
                            : BatchResponse.Item.failed(index, BATCH_ABORTED, BATCH_ABORTED_MESSAGE));
                }
            }
        }
        return ResponseEntity.status(HttpStatus.MULTI_STATUS).body(BatchResponse.of(results));
    }${allOrNothing}

    /**
     * El elemento como lo leería el borde: Jackson con el ObjectMapper de la aplicación (las guardas del constructor del
     * value object incluidas) y después Bean Validation.
     */
    private <T> T read(JsonNode node, Class<T> itemType) {
        if (node == null || node.isNull()) {
            throw new InvalidItem(MALFORMED_MESSAGE);
        }
        T item;
        try {
            item = mapper.treeToValue(node, itemType);
        } catch (JacksonException | IllegalArgumentException malformed) {
            throw new InvalidItem(guardMessage(malformed));
        }
        Set<ConstraintViolation<T>> violations = validator.validate(item);
        if (!violations.isEmpty()) {
            throw new InvalidItem(violations.stream()
                    .map(violation -> violation.getPropertyPath() + " " + violation.getMessage())
                    .sorted()
                    .collect(Collectors.joining("; ")));
        }
        return item;
    }

    /** El mensaje de la guarda del value object que rechazó el elemento, o el genérico si no fue una guarda. */
    private static String guardMessage(Throwable malformed) {
        for (Throwable cause = malformed; cause != null; cause = cause.getCause() == cause ? null : cause.getCause()) {
            if (cause instanceof IllegalArgumentException guard && guard.getMessage() != null) {
                return guard.getMessage();
            }
        }
        return MALFORMED_MESSAGE;
    }

    /**
     * El cuerpo de error que respondería la operación sola ante este fallo: el método de ApiExceptionHandler que Spring
     * elegiría para la excepción, invocado aquí. Así una unicidad que viola el motor sale con el error que el diseño
     * declara para ella, y un fallo inesperado, con el catch-all (sin code, y con su pila en el log).
     */
    private ErrorResponse translate(RuntimeException ex) {
        Method method = TRANSLATIONS.resolveMethodByThrowable(ex);
        if (method == null) {
            throw ex;
        }
        try {
            Object answer = method.invoke(errors, ex);
            if (answer instanceof ResponseEntity<?> entity) {
                answer = entity.getBody();
            }
            return (ErrorResponse) answer;
        } catch (IllegalAccessException | InvocationTargetException unreachable) {
            throw new IllegalStateException("ApiExceptionHandler no pudo traducir el fallo de un elemento", unreachable);
        }
    }

    /** Un elemento mal formado: su mensaje es el que viaja en el resultado. */
    private static final class InvalidItem extends RuntimeException {

        InvalidItem(String message) {
            super(message, null, false, false);
        }
    }
}`;
  return { path: javaPath(model, BATCH_PKG, 'BatchRunner'), content: javaFile(subPackage(model, BATCH_PKG), imports, body) };
}

/**
 * El sobre: los campos del cuerpo, con el que se recorre como `List<JsonNode>` y la validación de la LISTA (presencia y
 * `maxItems`), no la de sus elementos. Los estampados (la identidad, la puerta…) y los de la ruta no viajan en él.
 */
function renderRequest(model, operation) {
  const imports = new Set(['tools.jackson.databind.JsonNode', 'java.util.List']);
  const components = requestComponents(operation).map((field) => {
    const annotations = [];
    for (const annotation of field.inputValidation ?? field.validation ?? []) {
      imports.add(`jakarta.validation.constraints.${annotation.slice(1).split('(')[0]}`);
      annotations.push(annotation);
    }
    if (field.name === operation.batch.over) return `        ${[...annotations, 'List<JsonNode>'].join(' ')} ${field.name}`;
    for (const name of field.imports ?? []) imports.add(name);
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
    if (field.kind === 'composite') {
      imports.add('jakarta.validation.Valid');
      annotations.push('@Valid');
    }
    return `        ${[...annotations, field.javaType].join(' ')} ${field.name}`;
  });
  const body = `/**
 * El sobre del lote ${operation.name} (DSL 2.30): lo único que valida el borde. Los elementos de '${operation.batch.over}'
 * llegan sin leer y los valida BatchRunner uno a uno, para que uno mal formado sea su resultado y no un 400 del lote.
 */
public record ${batchRequestClass(operation)}(
${components.join(',\n')}
) {
}`;
  return { path: javaPath(model, BATCH_PKG, batchRequestClass(operation)), content: javaFile(subPackage(model, BATCH_PKG), [...imports], body) };
}

/** Los campos que viajan en el cuerpo de un lote: ni los de la ruta ni los que estampa el servidor. */
export function requestComponents(operation) {
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
  return operation.bodyFields.filter((field) => !fromPath.has(field.name) && !field.resolvedIdentity);
}

/**
 * La llamada del controller a BatchRunner. `args` es la lista de argumentos del mensaje de UN elemento, ya resuelta por
 * el controller (el elemento, la ruta, lo estampado y el resto del sobre).
 */
export function controllerBatchCall(model, operation, { args, imports }) {
  const batch = operation.batch;
  imports.add(`${subPackage(model, BATCH_PKG)}.BatchRunner`);
  imports.add(`${subPackage(model, BATCH_PKG)}.${batchRequestClass(operation)}`);
  const itemField = operation.bodyFields.find((field) => field.name === batch.over);
  const typeImport = domainTypeImport(model, itemField);
  if (typeImport) imports.add(typeImport);
  const message = `new ${operation.messageClass}(${args.join(', ')})`;
  const dispatch = batch.resultFields.length > 0 ? `item -> mediator.dispatch(${message})` : `item -> {\n                    mediator.dispatch(${message});\n                    return null;\n                }`;
  if (batch.atomicity === 'per-item') {
    imports.add('java.util.Set');
    const errors = batch.itemErrors.map(javaText).join(', ');
    return {
      returnType: 'ResponseEntity<BatchResponse>',
      responseImports: [`${subPackage(model, BATCH_PKG)}.BatchResponse`, 'org.springframework.http.ResponseEntity'],
      call: `return batchRunner.perItem(request.${batch.over}(), ${batch.itemType}.class, Set.of(${errors}),
                ${dispatch});`
    };
  }
  imports.add('org.springframework.http.HttpStatus');
  return {
    returnType: 'ResponseEntity<?>',
    responseImports: ['org.springframework.http.ResponseEntity'],
    call: `return batchRunner.allOrNothing(${javaText(batch.over)}, request.${batch.over}(), ${batch.itemType}.class, HttpStatus.valueOf(${operation.route.status}),
                ${dispatch});`
  };
}
