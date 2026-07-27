// Controllers REST versionados (patrón del prototipo): <Grupo>V1Controller en
// infrastructure/rest/controllers/<grupo>/v1 con @RequestMapping("<base>/v1").
// El binding sale del endpoint declarado, no del nombre de los campos: cada
// {segmento} de la ruta es un @PathVariable, y el resto del input viaja en el
// body (@Valid @RequestBody del propio Command) cuando el método lo admite
// (POST/PUT/PATCH) o como @RequestParam/@PageableDefault en GET/DELETE. El
// controller fusiona los path params reconstruyendo el record. Todo se despacha
// vía UseCaseMediator. Incluye @Tag/@Operation (springdoc) y el
// @RestControllerAdvice central en infrastructure/rest.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import {
  messageComponents,
  returnTypeOf,
  returnTypeImports,
  messagePackage,
  isPartialUpdate,
  JSON_NULLABLE_IMPORT
} from './services.js';
import { MEDIATOR_PKG } from './mediator.js';
import { domainTypeImport } from './entities.js';
import { uniqueConstraints } from './persistence-entities.js';
import { screamingSnake } from '../lib/naming.js';

const MAPPING_BY_METHOD = {
  GET: 'GetMapping',
  POST: 'PostMapping',
  PUT: 'PutMapping',
  PATCH: 'PatchMapping',
  DELETE: 'DeleteMapping'
};

const HTTP_STATUS_CONSTANTS = {
  200: 'OK',
  201: 'CREATED',
  202: 'ACCEPTED',
  203: 'NON_AUTHORITATIVE_INFORMATION',
  204: 'NO_CONTENT',
  205: 'RESET_CONTENT',
  206: 'PARTIAL_CONTENT',
  207: 'MULTI_STATUS',
  208: 'ALREADY_REPORTED',
  226: 'IM_USED'
};

// Métodos HTTP que admiten cuerpo: es la señal que decide @RequestBody frente a
// @RequestParam (el DSL no declara requestBody, lo declara el verbo del endpoint).
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Anotaciones de presencia: en un @PathVariable no dicen nada (el segmento existe
// o la ruta no casa), así que solo se emiten sobre parámetros de query.
const PRESENCE_ANNOTATIONS = new Set(['@NotNull', '@NotBlank', '@NotEmpty']);

/**
 * Bean Validation de un parámetro suelto (query o ruta). Sin esto, una constraint
 * que el diseño declara sobre un filtro (`min`, `maxLength`, `pattern`, `minItems`)
 * no existiría en el servidor: el record del mensaje se construye a mano en el
 * controller, así que sus anotaciones nunca se evalúan por esta vía. Exige
 * `@Validated` en la clase, que renderController añade al detectarlas.
 */
function paramValidation(component, imports, { presence = true } = {}) {
  const annotations = (component.validation ?? []).filter(
    (annotation) => presence || !PRESENCE_ANNOTATIONS.has(annotation)
  );
  if (annotations.length === 0) return '';
  for (const annotation of annotations) {
    imports.add(`jakarta.validation.constraints.${annotation.slice(1).split('(')[0]}`);
  }
  return `${annotations.join(' ')} `;
}

export function generate(model) {
  const files = model.services
    .map((service) => renderController(model, service))
    .filter(Boolean);
  // El @RestControllerAdvice solo intercepta invocaciones de controller: sin capa
  // api no hay nada que traducir a respuesta HTTP (los fallos de un listener o de
  // un schedule los gestiona su propio manejador de errores).
  if (model.layersPresent.api) files.push(renderExceptionHandler(model));
  return files;
}

function renderController(model, service) {
  const routed = service.operations.filter((operation) => operation.route);
  if (routed.length === 0) return null;

  const groupName = service.controllerClass.replace(/V1Controller$/, '');
  const imports = new Set([
    'io.swagger.v3.oas.annotations.tags.Tag',
    'org.springframework.web.bind.annotation.RequestMapping',
    'org.springframework.web.bind.annotation.RestController',
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`
  ]);

  const methods = routed.map((operation) => renderMethod(model, operation, imports));
  if (routed.some((operation) => operation.multipart)) methods.push(fileUploadHelper(model, imports));

  const tagDescription = model.service.description
    ? `, description = ${JSON.stringify(model.service.description)}`
    : '';
  // Spring solo evalúa Bean Validation sobre parámetros sueltos (@RequestParam,
  // @PathVariable) si la clase está anotada con @Validated; sin él, las
  // constraints que acaban de emitirse serían decorativas. Las violaciones salen
  // como ConstraintViolationException, que ApiExceptionHandler ya traduce a 400.
  const validatesParams = [...imports].some((name) => name.startsWith('jakarta.validation.constraints.'));
  if (validatesParams) imports.add('org.springframework.validation.annotation.Validated');

  const body = `@RestController
${validatesParams ? '@Validated\n' : ''}@RequestMapping("${model.api.routeBase}")
@Tag(name = "${groupName}"${tagDescription})
public class ${service.controllerClass} {

    private final UseCaseMediator mediator;

    public ${service.controllerClass}(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

${methods.join('\n\n')}
}`;

  return {
    path: javaPath(model, service.controllerPackage, service.controllerClass),
    content: javaFile(subPackage(model, service.controllerPackage), [...imports], body)
  };
}

// Adaptación MultipartFile → FileUpload: la única traducción que el controller
// hace sobre un binario. Un archivo ilegible es un 400 del cliente, no un 500.
function fileUploadHelper(model, imports) {
  imports.add(`${subPackage(model, 'application.dtos')}.FileUpload`);
  imports.add(`${subPackage(model, 'domain.errors')}.BadRequestException`);
  imports.add('java.io.IOException');

  return `    private static FileUpload toFileUpload(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            return null;
        }
        try {
            return new FileUpload(file.getBytes(), file.getOriginalFilename(), file.getContentType(), file.getSize());
        } catch (IOException exception) {
            throw new BadRequestException("No se pudo leer el archivo enviado", "FILE_UNREADABLE", 400, null);
        }
    }`;
}

// Un 201 con id en la salida devuelve `Location`: es contrato HTTP y los
// escenarios de validación lo assertan. Se deriva del diseño (successStatus + el
// `id` del output), no de que alguien se acuerde de añadirlo a mano.
function returnsLocation(operation) {
  return (
    operation.route?.status === 201 &&
    !operation.returnsList &&
    !operation.paginated &&
    Boolean(operation.responseDto?.fields.some((field) => field.name === 'id'))
  );
}

function renderMethod(model, operation, imports) {
  const route = operation.route;
  const location = returnsLocation(operation);
  const dtoType = returnTypeOf(operation);
  const returnType = location ? `ResponseEntity<${dtoType}>` : dtoType;
  returnTypeImports(model, operation, imports);
  imports.add(`${subPackage(model, messagePackage(operation))}.${operation.messageClass}`);

  const mapping = MAPPING_BY_METHOD[route.method];
  imports.add(`org.springframework.web.bind.annotation.${mapping}`);

  const annotations = [];
  if (route.fallback) annotations.push('    // TODO: revisar ruta (sin endpoint explícito ni patrón CRUD en el diseño).');
  if (operation.description) {
    imports.add('io.swagger.v3.oas.annotations.Operation');
    annotations.push(`    @Operation(summary = ${JSON.stringify(operation.description)})`);
  }
  if (operation.multipart) {
    // Subida binaria: el endpoint es multipart/form-data, no JSON.
    imports.add('org.springframework.http.MediaType');
    annotations.push(`    @${mapping}(value = "${route.path}", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)`);
  } else {
    annotations.push(`    @${mapping}("${route.path}")`);
  }
  if (location) {
    // El status lo pone ResponseEntity.created(...): con @ResponseStatus además,
    // se declararía dos veces la misma cosa.
    imports.add('org.springframework.http.ResponseEntity');
    imports.add('org.springframework.web.servlet.support.ServletUriComponentsBuilder');
  } else if (route.status !== 200) {
    imports.add('org.springframework.web.bind.annotation.ResponseStatus');
    imports.add('org.springframework.http.HttpStatus');
    const constant = HTTP_STATUS_CONSTANTS[route.status];
    annotations.push(
      `    @ResponseStatus(${constant ? `HttpStatus.${constant}` : `HttpStatus.valueOf(${route.status})`})`
    );
  }

  const components = messageComponents(model, operation);
  const pathParams = operation.pathParams ?? [];
  const fromPath = new Set(pathParams.map((param) => param.name));
  // El cuerpo solo existe si el verbo lo admite: un POST de consulta en lote
  // lleva su lote en el body, no en query params.
  const asBody = BODY_METHODS.has(route.method) && operation.bodyFields.length > 0;
  const params = [];
  let dispatchArg;

  // Un @PathVariable por cada {segmento} de la ruta, con el tipo del diseño.
  for (const param of pathParams) {
    for (const name of param.imports) imports.add(name);
    const typeImport = domainTypeImport(model, param);
    if (typeImport) imports.add(typeImport);
    imports.add('org.springframework.web.bind.annotation.PathVariable');
    const validation = paramValidation(param, imports, { presence: false });
    params.push(`@PathVariable ${validation}${param.javaType} ${param.name}`);
  }

  if (operation.multipart) {
    // Partes del formulario: el binario como @RequestPart, el resto como campos.
    const args = components.map((component) => {
      if (fromPath.has(component.name)) return component.name;
      if (component.file) {
        imports.add('org.springframework.web.bind.annotation.RequestPart');
        imports.add('org.springframework.web.multipart.MultipartFile');
        const required = component.required ? '' : ', required = false';
        params.push(`@RequestPart(value = "${component.name}"${required}) MultipartFile ${component.name}`);
        return `toFileUpload(${component.name})`;
      }
      for (const name of component.imports) imports.add(name);
      const typeImport = domainTypeImport(model, component);
      if (typeImport) imports.add(typeImport);
      imports.add('org.springframework.web.bind.annotation.RequestParam');
      const required = component.required ? '' : '(required = false)';
      const validation = paramValidation(component, imports);
      params.push(`@RequestParam${required} ${validation}${component.javaType} ${component.name}`);
      return component.name;
    });
    dispatchArg = `new ${operation.messageClass}(${args.join(', ')})`;
  } else if (asBody) {
    imports.add('jakarta.validation.Valid');
    imports.add('org.springframework.web.bind.annotation.RequestBody');
    // Si ningún campo del cuerpo es obligatorio, el cuerpo entero lo es: una
    // petición sin body es válida según el contrato y no puede dar 400.
    const bodyRequired = operation.bodyFields.some((field) => field.required);
    const requiredAttr = bodyRequired ? '' : '(required = false)';
    params.push(`@Valid @RequestBody${requiredAttr} ${operation.messageClass} command`);

    if (pathParams.length > 0) {
      // Fusiona los parámetros de ruta reconstruyendo el record. Con cuerpo
      // opcional, command puede ser null: cada campo se lee protegido, y los
      // envueltos en JsonNullable caen a undefined (ausente), no a null (vaciar).
      const wrapped = new Set(
        isPartialUpdate(operation)
          ? operation.bodyFields.filter((field) => !field.required && !field.file).map((field) => field.name)
          : []
      );
      const read = (component) => {
        if (bodyRequired) return `command.${component.name}()`;
        let absent = 'null';
        if (wrapped.has(component.name)) {
          imports.add(JSON_NULLABLE_IMPORT);
          // Testigo de tipo explícito: sin él, el ternario infiere
          // JsonNullable<? extends Object> y no compila contra el componente.
          // El testigo nombra el tipo, así que el controller necesita importarlo
          // aunque no aparezca en su firma.
          for (const name of component.imports) imports.add(name);
          const typeImport = domainTypeImport(model, component);
          if (typeImport) imports.add(typeImport);
          absent = `JsonNullable.<${component.javaType}>undefined()`;
        }
        return `(command == null ? ${absent} : command.${component.name}())`;
      };
      const args = components.map((c) => (fromPath.has(c.name) ? c.name : read(c)));
      // Un argumento por línea cuando la fusión es larga (cuerpo opcional con
      // muchos campos): en una sola línea el método es ilegible.
      const inline = `new ${operation.messageClass}(${args.join(', ')})`;
      dispatchArg =
        inline.length > 110
          ? `new ${operation.messageClass}(\n                ${args.join(',\n                ')})`
          : inline;
    } else {
      dispatchArg = 'command';
    }
  } else {
    for (const component of components) {
      if (fromPath.has(component.name)) continue;
      for (const name of component.imports) imports.add(name);
      const typeImport = domainTypeImport(model, component);
      if (typeImport) imports.add(typeImport);
      if (component.name === 'pageable') {
        imports.add('org.springframework.data.web.PageableDefault');
        const size = model.pagination?.defaultSize ? `(size = ${model.pagination.defaultSize})` : '';
        params.push(`@PageableDefault${size} Pageable pageable`);
      } else if (component.name === 'page' || component.name === 'size') {
        imports.add('org.springframework.web.bind.annotation.RequestParam');
        const defaultValue = component.name === 'size' ? String(model.pagination?.defaultSize ?? 20) : '0';
        params.push(`@RequestParam(defaultValue = "${defaultValue}") int ${component.name}`);
      } else {
        // Filtros de query como request params.
        imports.add('org.springframework.web.bind.annotation.RequestParam');
        const required = component.required ? '' : '(required = false)';
        const validation = paramValidation(component, imports);
        params.push(`@RequestParam${required} ${validation}${component.javaType} ${component.name}`);
      }
    }
    dispatchArg = `new ${operation.messageClass}(${components.map((c) => c.name).join(', ')})`;
  }

  const dispatch = `mediator.dispatch(${dispatchArg});`;
  let call;
  if (location) {
    // Location del recurso recién creado: la ruta de la petición + su id.
    call = `${dtoType} response = ${dispatch}
        return ResponseEntity.created(
                ServletUriComponentsBuilder.fromCurrentRequest().path("/{id}").buildAndExpand(response.id()).toUri())
            .body(response);`;
  } else {
    call = returnType === 'void' ? dispatch : `return ${dispatch}`;
  }

  return `${javadoc(operation.description, '    ')}${annotations.join('\n')}
    public ${returnType} ${operation.name}(${params.join(', ')}) {
        ${call}
    }`;
}

// Traducción de una violación de integridad al error de negocio que le
// corresponde. Las constraints únicas las nombra el scaffolding
// (persistence-entities.js), así que aquí se sabe qué campo violó cuál: sin
// esto, dos peticiones simultáneas que compiten por el mismo valor único
// reciben un 409 anónimo en vez del error declarado del diseño.
function renderDataIntegrityHandler(model, imports, constantsOut) {
  imports.add('org.springframework.dao.DataIntegrityViolationException');

  const constraints = uniqueConstraints(model);
  if (constraints.length === 0) {
    return `
    @ResponseStatus(HttpStatus.CONFLICT)
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ErrorResponse onDataIntegrityViolation(DataIntegrityViolationException exception) {
        return new ErrorResponse(HttpStatus.CONFLICT.value(), "Conflict",
                "Violación de integridad de datos: alguna restricción no se cumplió");
    }
`;
  }

  imports.add('java.util.Locale');
  imports.add('java.util.Map');
  imports.add('java.util.function.Supplier');
  constantsOut.push(constraintMapConstant(constraints));

  return `
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ErrorResponse> onDataIntegrityViolation(DataIntegrityViolationException exception) {
        DomainException translated = translateConstraint(exception);
        if (translated != null) {
            return onDomainException(translated);
        }
        log.warn("Violación de integridad no asociada a ninguna constraint conocida", exception);
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new ErrorResponse(HttpStatus.CONFLICT.value(),
                "Conflict", "Violación de integridad de datos: alguna restricción no se cumplió"));
    }

    /**
     * Busca el nombre de alguna constraint conocida en el mensaje del driver.
     * Se mira la causa más específica porque es la que trae el texto del motor;
     * el mensaje de Spring solo lo envuelve.
     */
    private static DomainException translateConstraint(DataIntegrityViolationException exception) {
        String detail = String.valueOf(exception.getMostSpecificCause().getMessage())
                .concat(" ")
                .concat(String.valueOf(exception.getMessage()))
                .toLowerCase(Locale.ROOT);
        for (Map.Entry<String, Supplier<DomainException>> candidate : CONSTRAINT_TO_ERROR.entrySet()) {
            if (detail.contains(candidate.getKey())) {
                return candidate.getValue().get();
            }
        }
        return null;
    }
`;
}

function constraintMapConstant(constraints) {
  const entries = constraints
    .map(({ constraint, entity, fields }) => {
      const code = `${screamingSnake(entity)}_${screamingSnake(fields.join('_'))}_ALREADY_EXISTS`;
      const label = fields.join(', ');
      return `            // TODO (agente): si el diseño declara un error para la unicidad de ${entity}.${label},
            // sustituye este ConflictException genérico por ese error (p. ej. ${entity}${fields.map(capitalizeFirst).join('')}AlreadyExistsError::new).
            Map.entry("${constraint}", () -> new ConflictException(
                    "Ya existe un ${entity} con ese ${label}", "${code}", 409, null))`;
    })
    .join(',\n');

  return `
    /**
     * Nombre de constraint única → error de negocio que representa violarla.
     * La clave está en minúsculas: el nombre llega con la caja que le dé el
     * dialecto y se compara normalizado.
     */
    private static final Map<String, Supplier<DomainException>> CONSTRAINT_TO_ERROR = Map.ofEntries(
${entries});`;
}

function capitalizeFirst(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// @RestControllerAdvice central: validación, errores de framework, jerarquía
// DomainException (una respuesta por subclase + genérico con httpStatus de la
// metadata) y catch-all 500. El body es siempre ErrorResponse (mismo paquete).
// Excepciones que lanza el propio Spring en una subida multipart, antes de que
// la petición llegue al controller: sin estos handlers caen en el catch-all y
// devuelven 500 donde el diseño (storage.maxSizeMb, error FILE_TOO_LARGE) espera
// 413/400. Son mecánicas: no dependen de la lógica del servicio.
function renderMultipartHandlers(imports) {
  imports.add('org.springframework.web.multipart.MaxUploadSizeExceededException');
  imports.add('org.springframework.web.multipart.support.MissingServletRequestPartException');
  return `
    // ── Subida de archivos (capa storage) ────────────────────────────────────

    @ResponseStatus(HttpStatus.PAYLOAD_TOO_LARGE)
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ErrorResponse onMaxUploadSizeExceeded(MaxUploadSizeExceededException exception) {
        return new ErrorResponse(HttpStatus.PAYLOAD_TOO_LARGE.value(), "Payload Too Large",
                "FILE_TOO_LARGE", "El archivo supera el tamaño máximo permitido", List.of());
    }

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(MissingServletRequestPartException.class)
    public ErrorResponse onMissingRequestPart(MissingServletRequestPartException exception) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Bad Request",
                "Falta la parte '" + exception.getRequestPartName() + "' en la petición multipart");
    }
`;
}

// Conflicto de concurrencia optimista (lockVersion, el @Version de la raíz de
// agregado): dos operaciones simultáneas escribieron sobre la misma versión.
// Spring traduce el OptimisticLockException de JPA a
// ObjectOptimisticLockingFailureException al hacer commit; sin este handler caería
// en el catch-all como 500. Es un 409: el cliente debe releer y reintentar con el
// estado actual. No lo confundas con un conflicto de `expectedVersion` que declare
// el diseño: ese lo comprueba el dominio contra su propio contador.
function renderOptimisticLockHandler(imports) {
  imports.add('org.springframework.orm.ObjectOptimisticLockingFailureException');
  return `
    @ResponseStatus(HttpStatus.CONFLICT)
    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    public ErrorResponse onOptimisticLockingFailure(ObjectOptimisticLockingFailureException exception) {
        return new ErrorResponse(HttpStatus.CONFLICT.value(), "Conflict", "OPTIMISTIC_LOCK_CONFLICT",
                "El recurso fue modificado por otra operación concurrente; reintenta con el estado actual", List.of());
    }
`;
}

function renderExceptionHandler(model) {
  const errorsPkg = subPackage(model, 'domain.errors');
  const imports = new Set([
    `${errorsPkg}.BadRequestException`,
    `${errorsPkg}.BusinessException`,
    `${errorsPkg}.ConflictException`,
    `${errorsPkg}.DomainException`,
    `${errorsPkg}.ForbiddenException`,
    `${errorsPkg}.NotFoundException`,
    `${errorsPkg}.PayloadTooLargeException`,
    `${errorsPkg}.UnauthorizedException`,
    'jakarta.validation.ConstraintViolationException',
    'java.util.List',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.http.HttpStatus',
    'org.springframework.http.ResponseEntity',
    'org.springframework.http.converter.HttpMessageNotReadableException',
    'org.springframework.web.HttpRequestMethodNotSupportedException',
    'org.springframework.web.bind.MethodArgumentNotValidException',
    'org.springframework.web.bind.annotation.ExceptionHandler',
    'org.springframework.web.bind.annotation.ResponseStatus',
    'org.springframework.web.bind.annotation.RestControllerAdvice',
    'org.springframework.web.method.annotation.MethodArgumentTypeMismatchException'
  ]);

  // Las constantes van arriba, junto al logger; los @ExceptionHandler, en su
  // sección temática más abajo.
  const constants = [];
  const dataIntegrity = model.layersPresent.persistence
    ? renderDataIntegrityHandler(model, imports, constants)
    : '';
  // Solo si alguna raíz porta control de versión. Con
  // consistency.optimisticLocking: none no hay de dónde salga la excepción, y
  // generar el handler documentaría un 409 que el contrato niega.
  const optimisticLock =
    model.layersPresent.persistence && model.entities.some((entity) => entity.usesOptimisticLocking)
      ? renderOptimisticLockHandler(imports)
      : '';
  const multipart = model.layersPresent.storage ? renderMultipartHandlers(imports) : '';

  const body = `@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);
${constants.join('')}

    // ── Validación ───────────────────────────────────────────────────────────
    // Errores de FORMA de la petición: 400. El 422 queda para las reglas de
    // negocio tipadas que declara use-cases.keel.yaml (BusinessException), que
    // es la distinción que esperan los escenarios de validación.

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ErrorResponse onMethodArgumentNotValid(MethodArgumentNotValidException exception) {
        List<String> details = exception.getBindingResult().getFieldErrors().stream()
                .map(error -> error.getField() + " " + error.getDefaultMessage())
                .toList();
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Validation Error",
                "VALIDATION_ERROR", "La petición no supera las validaciones", details);
    }

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(ConstraintViolationException.class)
    public ErrorResponse onConstraintViolation(ConstraintViolationException exception) {
        List<String> details = exception.getConstraintViolations().stream()
                .map(violation -> violation.getPropertyPath() + " " + violation.getMessage())
                .toList();
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Validation Error",
                "VALIDATION_ERROR", "La petición viola restricciones declaradas", details);
    }

    // ── Errores de framework ─────────────────────────────────────────────────

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ErrorResponse onMalformedRequest(Exception exception) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Bad Request", "Petición malformada");
    }

    @ResponseStatus(HttpStatus.METHOD_NOT_ALLOWED)
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ErrorResponse onMethodNotAllowed(HttpRequestMethodNotSupportedException exception) {
        return new ErrorResponse(HttpStatus.METHOD_NOT_ALLOWED.value(), "Method Not Allowed", "Método HTTP no soportado");
    }
${multipart}${dataIntegrity}${optimisticLock}
    // ── Errores de dominio (jerarquía DomainException) ───────────────────────

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(BadRequestException.class)
    public ErrorResponse onBadRequest(BadRequestException exception) {
        return buildResponse(HttpStatus.BAD_REQUEST, "Bad Request", exception, "Petición inválida");
    }

    @ResponseStatus(HttpStatus.UNAUTHORIZED)
    @ExceptionHandler(UnauthorizedException.class)
    public ErrorResponse onUnauthorized(UnauthorizedException exception) {
        return buildResponse(HttpStatus.UNAUTHORIZED, "Unauthorized", exception, "Autenticación requerida");
    }

    @ResponseStatus(HttpStatus.FORBIDDEN)
    @ExceptionHandler(ForbiddenException.class)
    public ErrorResponse onForbidden(ForbiddenException exception) {
        return buildResponse(HttpStatus.FORBIDDEN, "Forbidden", exception, "Acceso denegado");
    }

    @ResponseStatus(HttpStatus.NOT_FOUND)
    @ExceptionHandler(NotFoundException.class)
    public ErrorResponse onNotFound(NotFoundException exception) {
        return buildResponse(HttpStatus.NOT_FOUND, "Not Found", exception, "Recurso no encontrado");
    }

    @ResponseStatus(HttpStatus.CONFLICT)
    @ExceptionHandler(ConflictException.class)
    public ErrorResponse onConflict(ConflictException exception) {
        return buildResponse(HttpStatus.CONFLICT, "Conflict", exception, "Conflicto con el estado actual del recurso");
    }

    @ResponseStatus(HttpStatus.PAYLOAD_TOO_LARGE)
    @ExceptionHandler(PayloadTooLargeException.class)
    public ErrorResponse onPayloadTooLarge(PayloadTooLargeException exception) {
        return buildResponse(HttpStatus.PAYLOAD_TOO_LARGE, "Payload Too Large", exception,
                "El contenido enviado supera el tamaño permitido");
    }

    @ResponseStatus(HttpStatus.UNPROCESSABLE_ENTITY)
    @ExceptionHandler(BusinessException.class)
    public ErrorResponse onBusinessException(BusinessException exception) {
        return buildResponse(HttpStatus.UNPROCESSABLE_ENTITY, "Business Rule Violation", exception,
                "Se violó una regla de negocio");
    }

    // Errores con status extendido (402, 429, 503…): extienden DomainException
    // directamente y llevan el httpStatus en la metadata.
    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ErrorResponse> onDomainException(DomainException exception) {
        Integer status = exception.getHttpStatus();
        HttpStatus http = status != null ? HttpStatus.valueOf(status) : HttpStatus.UNPROCESSABLE_ENTITY;
        ErrorResponse body = new ErrorResponse(http.value(), http.getReasonPhrase(), exception.getCode(),
                exception.getMessage() != null ? exception.getMessage() : http.getReasonPhrase(),
                exception.getDetails());
        return ResponseEntity.status(http).body(body);
    }

    // ── Catch-all ────────────────────────────────────────────────────────────

    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    @ExceptionHandler(Exception.class)
    public ErrorResponse onServerError(Exception exception) {
        log.error("Excepción no controlada", exception);
        return new ErrorResponse(HttpStatus.INTERNAL_SERVER_ERROR.value(), "Internal Server Error",
                "Ocurrió un error inesperado");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static ErrorResponse buildResponse(HttpStatus status, String error, DomainException exception, String fallbackMessage) {
        String message = exception.getMessage() != null ? exception.getMessage() : fallbackMessage;
        return new ErrorResponse(status.value(), error, exception.getCode(), message, exception.getDetails());
    }
}`;

  return {
    path: javaPath(model, 'infrastructure.rest', 'ApiExceptionHandler'),
    content: javaFile(subPackage(model, 'infrastructure.rest'), [...imports], body)
  };
}
