// La QUERY de un listado (DSL 2.32, U3, D10, D14, D16 y U8) en keel-spring: `QueryParameters` (infrastructure/rest)
// lee `?sort=` contra el `sortable` de la operación y una lista en la query, con su 400. Lo que se acepta y lo que es
// 400 lo fija keel-core: `readClientSort` (gen/pagination.js) y `readQueryList` (gen/wire.js), las referencias que
// cumplen los cuatro generadores; aquí solo se escribe en Java.
//
// Los dos leen los valores CRUDOS de la petición (`getParameterValues`) y no un `@RequestParam`: Spring convierte un
// único valor a lista partiendo por comas y varios valores sin partir, y el resolver del Pageable lee `?sort=` con
// mayúsculas, espacios y cualquier propiedad (B0, M9 y M12). El Pageable sigue llegando por @PageableDefault, que es lo
// que lee `page` y `size` con la indulgencia de siempre (D16); su orden se descarta y lo pone este lector.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { translatableSort } from '@keel-system/keel-core/gen/pagination';
import { screamingSnake } from '@keel-system/keel-core/gen/naming';
import { javaFile, javaPath, subPackage } from './render.js';
import { REST_PKG } from './conditional-writes.js';

export const QUERY_PARAMETERS = 'QueryParameters';
const INVALID_SORT = FW.invalidSort.message.split('{sort}');

/** El paquete completo de la clase, para el import de los controllers y del manejador de errores. */
export const queryParametersImport = (model) => `${subPackage(model, REST_PKG)}.${QUERY_PARAMETERS}`;

const routedOperations = (model) => model.services.flatMap((group) => group.operations).filter((operation) => operation.route);

/**
 * ¿Lee este componente del mensaje la query como lista (U8)? Las que declaran cotas —de la lista (`required`,
 * `minItems`, `maxItems`) o de cada elemento— siguen con @RequestParam, que es lo que lleva su Bean Validation: leerlas
 * aquí las dejaría sin validar. Ninguna fixture tiene hoy las dos cosas a la vez.
 */
export function readsQueryList(component) {
  return (
    Boolean(component.list) &&
    (component.inputValidation ?? []).length === 0 &&
    (component.elementInputValidation ?? []).length === 0 &&
    elementParser(component) !== null
  );
}

/** ¿Emite el proyecto QueryParameters? Con algún listado paginado o alguna lista en la query de una ruta sin cuerpo. */
export function usesQueryParameters(model, componentsOf) {
  return routedOperations(model).some((operation) => {
    if (!['GET', 'DELETE'].includes(operation.route.method)) return false;
    return componentsOf(operation).some((component) => component.name === 'pageable' || readsQueryList(component));
  });
}

/** Cómo se lee UN elemento de una lista en la query, como expresión Java de una Function<String, T>, o null si no se sabe. */
export function elementParser(component) {
  if (component.kind === 'enum' && component.namedType) return `${QUERY_PARAMETERS}.enumValue(${component.namedType}.class)`;
  const PARSERS = {
    String: 'value -> value',
    UUID: 'UUID::fromString',
    Integer: 'Integer::valueOf',
    int: 'Integer::valueOf',
    Long: 'Long::valueOf',
    long: 'Long::valueOf',
    BigDecimal: 'BigDecimal::new',
    Boolean: 'Boolean::valueOf',
    boolean: 'Boolean::valueOf',
    Instant: 'Instant::parse',
    LocalDate: 'LocalDate::parse'
  };
  return PARSERS[component.elementJavaType] ?? null;
}

/** Los imports que necesita el parser de un elemento. */
export function elementParserImports(component) {
  return { UUID: ['java.util.UUID'], BigDecimal: ['java.math.BigDecimal'], Instant: ['java.time.Instant'], LocalDate: ['java.time.LocalDate'] }[component.elementJavaType] ?? [];
}

// ─── Las constantes y la llamada de cada controller ───────────────────────────────────────────────────────────────

const sortableConstant = (operation) => `${screamingSnake(operation.name)}_SORTABLE`;
const orderConstant = (operation) => `${screamingSnake(operation.name)}_ORDER`;

/**
 * Las constantes de un listado paginado: el orden del diseño (`Sort.unsorted()` si no declara uno traducible) y lo que
 * el cliente puede pedir, ruta del contrato → propiedad del espejo (vacío sin `sortable`: todo `?sort=` es 400).
 */
export function sortConstants(operation) {
  const sort = translatableSort(operation);
  const orders = sort.map((criterion) => `Sort.Order.${criterion.direction}("${criterion.property}")`).join(', ');
  const sortable = operation.sortable ?? [];
  const entries = sortable.map((entry) => `"${entry.path}", "${entry.property}"`);
  return [
    `    /** El orden de ${operation.name} cuando el cliente no manda ?sort= (el desempate por id lo añade el adaptador). */`,
    `    private static final Sort ${orderConstant(operation)} = ${sort.length > 0 ? `Sort.by(${orders})` : 'Sort.unsorted()'};`,
    `    /** Por qué puede ordenar el cliente ${operation.name} (output.sortable): ruta del contrato → propiedad del espejo. */`,
    `    private static final Map<String, String> ${sortableConstant(operation)} = ${entries.length > 0 ? `Map.of(${entries.join(', ')})` : 'Map.of()'};`
  ];
}

/** El argumento del Pageable que el controller pasa al mensaje: el de la petición con el orden leído por QueryParameters. */
export function sortedPageableArg(operation) {
  return `${QUERY_PARAMETERS}.sorted(pageable, request, ${sortableConstant(operation)}, ${orderConstant(operation)})`;
}

/** El argumento de una lista en la query. */
export function queryListArg(component) {
  return `${QUERY_PARAMETERS}.list(request, "${component.name}", ${elementParser(component)})`;
}

// ─── La clase ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderQueryParameters(model) {
  const hasEnums = model.enums.length > 0;
  const enumValue = hasEnums
    ? `

    /** El lector de un elemento enum: el literal del contrato, con el mismo conversor que un @RequestParam. */
    @SuppressWarnings({"rawtypes", "unchecked"})
    public static <T extends Enum<T>> Function<String, T> enumValue(Class<T> type) {
        Converter<String, T> converter = (Converter<String, T>) ENUMS.getConverter((Class) type);
        return converter::convert;
    }`
    : '';
  const body = `/**
 * La query de un listado (DSL 2.32): el orden que pide el cliente (?sort=) y las listas. Lee los valores CRUDOS de la
 * petición, porque el binding de Spring parte por comas un valor único y no varios, y el resolver del Pageable acepta
 * cualquier propiedad con cualquier dirección. Lo que se acepta lo fija keel-core (readClientSort y readQueryList): no
 * se ajusta a mano, porque los cuatro servidores del mismo diseño tienen que responder lo mismo.
 */
public final class ${QUERY_PARAMETERS} {
${hasEnums ? '\n    private static final JsonValueEnumConverterFactory ENUMS = new JsonValueEnumConverterFactory();\n' : ''}
    private ${QUERY_PARAMETERS}() {
    }

    /** El Pageable de la petición con el orden que pidió el cliente, o el del diseño si no pidió ninguno. */
    public static Pageable sorted(Pageable pageable, HttpServletRequest request, Map<String, String> sortable, Sort defaultOrder) {
        return PageRequest.of(pageable.getPageNumber(), pageable.getPageSize(), sort(request.getParameterValues("sort"), sortable, defaultOrder));
    }

    /**
     * Lee ?sort=: cada valor es campo o campo,asc|desc, con el campo en sortable y la dirección en minúsculas; uno vacío,
     * con más de una coma o con el mismo campo dos veces es 400. El orden del cliente SUSTITUYE al del diseño.
     */
    public static Sort sort(String[] values, Map<String, String> sortable, Sort defaultOrder) {
        if (values == null || values.length == 0) {
            return defaultOrder;
        }
        List<Sort.Order> orders = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String value : values) {
            String[] parts = value.split(",", -1);
            String path = parts[0];
            String direction = parts.length > 1 ? parts[1] : "asc";
            String property = sortable.get(path);
            if (parts.length > 2 || property == null || !(direction.equals("asc") || direction.equals("desc")) || !seen.add(path)) {
                throw new InvalidQuery("${FW.invalidSort.error}", "${INVALID_SORT[0]}" + value + "${INVALID_SORT[1]}", null);
            }
            orders.add(direction.equals("desc") ? Sort.Order.desc(property) : Sort.Order.asc(property));
        }
        return Sort.by(orders);
    }

    /**
     * Lee una lista de la query: el parámetro repetido, y cada valor partido por comas (un elemento con coma solo viaja
     * repitiendo el parámetro). Ausente es null (no filtra); vacía, o con un elemento vacío, es 400.
     */
    public static <T> List<T> list(HttpServletRequest request, String name, Function<String, T> element) {
        String[] values = request.getParameterValues(name);
        if (values == null || values.length == 0) {
            return null;
        }
        List<T> read = new ArrayList<>();
        for (String value : values) {
            for (String part : value.split(",", -1)) {
                if (part.isEmpty()) {
                    throw new InvalidQuery("${FW.invalidParams.error}", "${FW.invalidParams.message}", name);
                }
                T converted;
                try {
                    converted = element.apply(part);
                } catch (RuntimeException unreadable) {
                    throw new InvalidQuery("${FW.malformed.error}", "${FW.malformed.message}", null);
                }
                read.add(converted);
            }
        }
        return List.copyOf(read);
    }${enumValue}

    /** Una query que no se puede leer: 400 VALIDATION_ERROR (ApiExceptionHandler). {@code parameter} es la lista vacía. */
    public static final class InvalidQuery extends RuntimeException {

        private final String error;
        private final String parameter;

        InvalidQuery(String error, String message, String parameter) {
            super(message);
            this.error = error;
            this.parameter = parameter;
        }

        public String error() {
            return error;
        }

        public String parameter() {
            return parameter;
        }
    }
}`;
  const imports = [
    'jakarta.servlet.http.HttpServletRequest',
    'java.util.ArrayList',
    'java.util.HashSet',
    'java.util.List',
    'java.util.Map',
    'java.util.Set',
    'java.util.function.Function',
    'org.springframework.data.domain.PageRequest',
    'org.springframework.data.domain.Pageable',
    'org.springframework.data.domain.Sort',
    ...(hasEnums ? ['org.springframework.core.convert.converter.Converter', `${subPackage(model, 'infrastructure.web')}.JsonValueEnumConverterFactory`] : [])
  ];
  return { path: javaPath(model, REST_PKG, QUERY_PARAMETERS), content: javaFile(subPackage(model, REST_PKG), imports, body) };
}

/** El @ExceptionHandler de InvalidQuery, para ApiExceptionHandler: el 400 de la query, con VALIDATION_ERROR. */
export function invalidQueryHandler(model, imports) {
  imports.add(queryParametersImport(model));
  return `
    // ?sort= fuera de sortable y la lista de la query vacía o ilegible (DSL 2.32): 400 con VALIDATION_ERROR.
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(${QUERY_PARAMETERS}.InvalidQuery.class)
    public ErrorResponse onInvalidQuery(${QUERY_PARAMETERS}.InvalidQuery exception) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), exception.error(),
                "${FRAMEWORK_ERRORS.validation.code}", exception.getMessage(),
                exception.parameter() != null ? List.of(exception.parameter()) : null);
    }
`;
}
