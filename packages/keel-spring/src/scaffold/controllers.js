// Controllers REST versionados (patrón del prototipo): <Grupo>V1Controller en
// infrastructure/rest/controllers/<grupo>/v1 con @RequestMapping("<base>/v1").
// El binding sale del endpoint declarado, no del nombre de los campos: cada
// {segmento} de la ruta es un @PathVariable, y el resto del input viaja en el
// body (@Valid @RequestBody del propio Command) cuando el método lo admite
// (POST/PUT/PATCH) o como @RequestParam/@PageableDefault en GET/DELETE. El
// controller fusiona los path params reconstruyendo el record. Todo se despacha
// vía UseCaseMediator. Incluye @Tag/@Operation (springdoc) y el
// @RestControllerAdvice central en infrastructure/rest.

import { FRAMEWORK_ERRORS, conditionalUniquenessToken } from 'keel-core';
import { declaredErrorFor, declaredUniquenessErrorFor, declaredReferenceError } from '../lib/declared-errors.js';
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
import { crossAggregateForeignKeys } from './persistence-members.js';
import { screamingSnake } from '../lib/naming.js';
import { escapeJava } from '../lib/type-mapper.js';

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
 *
 * La lista es la de ENTRADA (`inputValidation`), la misma que usan los mensajes de
 * command y query, y por el mismo motivo: el `pattern` que un campo hereda de su value
 * type describe el valor YA NORMALIZADO, y aquí se está validando lo que llega por el
 * cable. Emitirlo cierra la puerta a `/applications/Billing` o a `?code=BILLING`, que el
 * diseño normaliza a minúsculas antes de comparar — un 400 sobre una petición que el
 * contrato acepta, y encima con el error equivocado. El `pattern` que el campo declara
 * POR SU CUENTA sobrevive en esa lista y se sigue emitiendo: es una restricción de esa
 * entrada concreta, no la forma del tipo (ver conventions/mapping.md § Normalización
 * antes que validación de formato).
 */
function paramValidation(component, imports, { presence = true } = {}) {
  const annotations = (component.inputValidation ?? component.validation ?? []).filter(
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

  const constants = routed.flatMap((operation) => defaultOrderConstant(operation));
  const methods = routed.map((operation) => renderMethod(model, operation, imports));
  if (routed.some((operation) => operation.multipart)) methods.push(fileUploadHelper(model, imports));
  if (constants.length > 0) {
    imports.add('org.springframework.data.domain.PageRequest');
    imports.add('org.springframework.data.domain.Pageable');
    imports.add('org.springframework.data.domain.Sort');
    methods.push(defaultOrderHelper());
  }

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
${constants.length > 0 ? '\n' + constants.join('\n') + '\n' : ''}
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

/**
 * Parámetro de ruta que ya identifica a la entidad del `output`, si lo hay.
 *
 * Es lo que distingue "creo un recurso y lo devuelvo" de "añado algo a la
 * colección de un agregado y devuelvo **el agregado**". En el segundo caso el `id`
 * de la respuesta es el del padre, no el del sub-recurso creado, y la regla
 * general (URI de la petición + id del output) produce un absurdo:
 * `POST /products/{productId}/images` daba
 * `Location: /products/{productId}/images/{productId}`.
 */
function parentPathParam(operation) {
  const entity = operation.responseDto?.entity;
  if (!entity) return null;
  // El diseño nombra el segmento con el id de la entidad ({productId}) o
  // genéricamente ({id}); ambos apuntan al mismo agregado.
  const owns = new Set(['id', `${entity[0].toLowerCase()}${entity.slice(1)}Id`]);
  return (operation.pathParams ?? []).find((param) => owns.has(param.name)) ?? null;
}

/**
 * Ruta del recurso al que apunta `Location`, en forma de plantilla de URI
 * (`/api/v1/products/{productId}`), truncada tras el segmento que identifica al
 * agregado devuelto.
 */
function parentLocationPath(model, operation, param) {
  const path = String(operation.route.path);
  const marker = `{${param.name}}`;
  return `${model.api.routeBase}${path.slice(0, path.indexOf(marker) + marker.length)}`;
}

// Orden por defecto declarado en el diseño (`sort`). Va en el controller y no en
// el adaptador porque es una decisión POR OPERACIÓN —dos listados del mismo
// agregado pueden ordenar distinto y comparten un único list(Pageable)— y porque
// es el contrato HTTP: es lo que recibe quien no manda ?sort=. El desempate por
// id lo pone el adaptador aparte, y sí es universal.
//
// Un criterio sobre un agregado embebido no se traduce: 'brand.name' no es una
// property path válida (no hay asociación navegable). Ese caso lo resuelve el
// agente con un adaptador de lectura, ya avisado por model.js y por el stub.
function orderConstantName(operation) {
  return `${operation.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_ORDER`;
}

function translatableSort(operation) {
  const sort = operation.sort ?? [];
  if (sort.length === 0 || sort.some((criterion) => criterion.embedded)) return [];
  return sort;
}

function defaultOrderConstant(operation) {
  const sort = translatableSort(operation);
  if (sort.length === 0) return [];
  const orders = sort.map((c) => `Sort.Order.${c.direction}("${c.property}")`).join(', ');
  return [`    private static final Sort ${orderConstantName(operation)} = Sort.by(${orders});`];
}

function defaultOrderHelper() {
  return `    /**
     * Aplica el orden por defecto del diseño cuando el cliente no pide uno propio.
     * El desempate por id lo añade el adaptador de repositorio, sobre cualquiera
     * de los dos órdenes.
     */
    private static Pageable withDefaultOrder(Pageable pageable, Sort defaultOrder) {
        if (pageable.getSort().isSorted()) {
            return pageable;
        }
        return PageRequest.of(pageable.getPageNumber(), pageable.getPageSize(), defaultOrder);
    }`;
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
  // La identidad del llamante gana a cualquier otra fuente, esté donde esté el campo.
  //
  // Esto era un `else if` de la rama sin parámetros de ruta, y por eso no se alcanzaba nunca en
  // una operación que tuviera cuerpo Y ruta: ganaba la rama que fusiona la ruta, que lee el campo
  // del comando… donde SIEMPRE es null, porque `services.js` le pone @JsonIgnore a propósito. El
  // servicio se quedaba sin saber quién llama y respondía 403 en el camino feliz. Lo destapó la
  // corrida notification-mailer sobre PostgreSQL: `requestNotification` (sin ruta) salía bien y
  // `registerTemplate` (PUT /v1/templates/{templateKey}/{locale}) salía con la identidad a null.
  //
  // Gana también a `fromPath`: si el diseño pusiera ese campo en la URL, la identidad la elegiría
  // quien hace la petición — que es exactamente lo que este mecanismo existe para impedir.
  const identityArg = () => {
    imports.add(`${model.service.basePackage}.infrastructure.configurations.security.CallerIdentity`);
    return 'CallerIdentity.resolve()';
  };

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
      if (component.resolvedIdentity) return identityArg();
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
      const args = components.map((c) =>
        c.resolvedIdentity ? identityArg() : fromPath.has(c.name) ? c.name : read(c)
      );
      // Un argumento por línea cuando la fusión es larga (cuerpo opcional con
      // muchos campos): en una sola línea el método es ilegible.
      const inline = `new ${operation.messageClass}(${args.join(', ')})`;
      dispatchArg =
        inline.length > 110
          ? `new ${operation.messageClass}(\n                ${args.join(',\n                ')})`
          : inline;
    } else if (components.some((component) => component.resolvedIdentity)) {
      // La identidad del llamante NO se acepta del cuerpo: se reconstruye el record poniendo el
      // valor que resuelve el servidor. Sin esto, el campo llegaría de quien hace la petición —que
      // es exactamente quien no debería elegirlo—, y la alternativa era un segundo campo sintético
      // que alguien tenía que reconciliar a mano.
      const args = components.map((component) =>
        component.resolvedIdentity ? identityArg() : `command.${component.name}()`
      );
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
      // La identidad del llamante tampoco se acepta por la QUERY STRING. Esta rama es la de
      // los verbos sin cuerpo, y era la única que no lo miraba: la de multipart y la del cuerpo
      // ya lo hacían. El resultado era un `@RequestParam` con el campo de la identidad, o sea la
      // identidad elegida por quien hace la petición — en una lectura, leer los datos de otro
      // inquilino con solo poner su clave en la URL. Lo destapó la corrida de evolución de
      // notification-mailer: `listTemplateVersions` fue la primera query con `callerIdentity`.
      if (component.resolvedIdentity) continue;
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
    const withOrder = translatableSort(operation).length > 0;
    const args = components.map((c) => {
      if (c.resolvedIdentity) return identityArg();
      return c.name === 'pageable' && withOrder ? `withDefaultOrder(pageable, ${orderConstantName(operation)})` : c.name;
    });
    dispatchArg = `new ${operation.messageClass}(${args.join(', ')})`;
  }

  const dispatch = `mediator.dispatch(${dispatchArg});`;
  let call;
  if (location) {
    const parent = parentPathParam(operation);
    call = parent
      ? // El output es el agregado que la ruta ya identifica: `Location` es la ruta
        // de ese agregado, no la de la petición (que apunta a su subcolección).
        `${dtoType} response = ${dispatch}
        return ResponseEntity.created(
                ServletUriComponentsBuilder.fromCurrentContextPath()
                    .path("${parentLocationPath(model, operation, parent)}").buildAndExpand(${parent.name}).toUri())
            .body(response);`
      : // Location del recurso recién creado: la ruta de la petición + su id.
        `${dtoType} response = ${dispatch}
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
  const errorsPkg = subPackage(model, 'domain.errors');
  const resolved = constraints.map((constraint) => {
    // Unicidad CONDICIONADA (`indexes[].when`): no dice «ya existe uno con esos campos» sino
    // «ya hay uno en ese estado» —una imagen principal, una versión activa—, así que ni su
    // familia ni su mensaje salen de los campos. El code lo busca por la CONDICIÓN
    // (framework-errors § uniqueness.conditionalFamilyFor) y, si el diseño no lo nombró, el
    // choque solo puede venir de una carrera: la regla del caso de uso resuelve el caso normal
    // y el índice es el respaldo concurrente. Antes salía PRODUCT_IMAGE_PRODUCT_ID_ALREADY_EXISTS
    // con «Ya existe un ProductImage con ese productId», que es falso: hay muchas por producto.
    if (constraint.when) {
      const family = FRAMEWORK_ERRORS.uniqueness.conditionalFamilyFor(conditionalUniquenessToken(constraint.when));
      const declared = declaredErrorFor(model, FRAMEWORK_ERRORS.uniqueness, family);
      return { ...constraint, conditional: true, raceOnly: !declared, declared: declared ?? declaredConcurrencyError(model) };
    }
    const raceOnly = raceOnlyConstraint(model, constraint);
    const soleConstraint = constraints.filter((other) => other.entity === constraint.entity).length === 1;
    // Acotada a la colección, el diseño SÍ puede nombrarla —es lo que pide
    // CHK-PERSIST-CHILD-UNIQUE-CODE—, y si lo hace manda él: dentro del padre ese choque puede
    // ser de verdad un error del cliente. La carrera es el default, no el veredicto.
    const nombrada =
      raceOnly === 'collection'
        ? declaredUniquenessError(model, constraint.entity, constraint.fields, soleConstraint)
        : null;
    if (nombrada) return { ...constraint, raceOnly: null, declared: nombrada };
    return {
      ...constraint,
      raceOnly,
      // Con `raceOnly` el error que toca es el de concurrencia, no el de unicidad: el
      // conflicto no es «ya existe uno así» sino dos escrituras que se pisaron. El
      // override del diseño se sigue respetando, solo que sobre la otra familia.
      declared: raceOnly
        ? declaredConcurrencyError(model)
        : declaredUniquenessError(model, constraint.entity, constraint.fields, soleConstraint)
    };
  });
  // FK entre agregados: su violación llega por el mismo camino (una constraint con nombre
  // dentro del mensaje del driver) y, hasta la corrida `catalog`, no la mapeaba nadie — así
  // que el 409 que el diseño declara para «la marca tiene productos» se degradaba a genérico.
  // Solo entra si el diseño DECLARA el error: aquí no se inventa ningún code.
  const references = crossAggregateForeignKeys(model)
    .map((fk) => ({ ...fk, declared: declaredReferenceError(model, fk.refEntity) }))
    .filter((fk) => fk.declared)
    .map((fk) => ({ constraint: fk.name, entity: fk.refEntity, fields: [fk.column], reference: fk, declared: fk.declared }));

  for (const { declared } of [...resolved, ...references]) {
    if (declared) imports.add(`${errorsPkg}.${declared.exceptionClass}`);
  }
  constantsOut.push(constraintMapConstant([...resolved, ...references]));

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

/**
 * ¿Esta constraint solo puede romperla una carrera? Y si sí, POR QUÉ — el motivo decide el
 * mensaje y el comentario que se emiten, así que se devuelve él y no un booleano
 * (`'computed'` | `'collection'`, o `null` si el conflicto sí es «ya existe uno así»).
 *
 * Un campo `computed` no lo manda nunca el cliente: lo calcula el servicio. Si además el
 * agregado que lo contiene lleva bloqueo optimista, violar su unicidad no es «ya existe
 * uno así» —nadie pidió ese valor— sino dos escrituras concurrentes que calcularon el
 * mismo. Traducirlo a un error de negocio de "ya existe" manda al cliente a corregir una
 * entrada que no envió; el 409 de concurrencia le dice lo que de verdad ocurrió, que es
 * que reintente.
 */
function raceOnlyConstraint(model, constraint) {
  const entity = model.entities.find((e) => e.name === constraint.entity);
  if (!entity) return null;

  // El bloqueo se mira en la RAÍZ del agregado, no en la entidad: una entidad interna
  // nunca lleva @Version propia (solo las raíces), y sin embargo está protegida por la
  // de su raíz. Preguntárselo a ella misma daría siempre que no.
  const root = model.entities.find((e) => e.name === entity.rootEntity) ?? entity;
  if (!root.usesOptimisticLocking) return null;

  // Unicidad ACOTADA A LA COLECCIÓN. Un índice único de una entidad interna que incluye la
  // relación a su raíz —«dos imágenes del mismo producto no comparten posición»— no dice «ya
  // existe un X con ese Y». La raíz es implícita en la petición (viaja en la ruta), y el otro
  // miembro lo REPARTE el servicio entre toda la colección: al insertar elige la primera libre
  // y al reordenar desplaza las demás. El cliente puede pedir una posición y pedirla es legal
  // —siempre hay una imagen ocupándola—, así que lo único que rompe la constraint es el estado
  // intermedio del reparto o una carrera. Un `*_ALREADY_EXISTS` lo mandaría a corregir una
  // entrada correcta; aguas arriba lo avisa CHK-PERSIST-CHILD-UNIQUE-CODE.
  if (!entity.isAggregateRoot && collectionScopedConstraint(entity, constraint)) return 'collection';

  // Basta con que UNO de los campos sea computed. Los demás pueden salir del cliente
  // —en una clave (plantilla, versión) la plantilla la elige él—, pero si el que colisiona
  // es el calculado, las dos filas tuvieron que calcularlo por separado. Lo que el cliente
  // mandó no distingue este caso de ningún otro: no hay nada que pueda corregir.
  return constraint.fields.some((name) => entity.fields.find((f) => f.name === name)?.computed)
    ? 'computed'
    : null;
}

/**
 * ¿La constraint acota la unicidad a la COLECCIÓN de una raíz, en vez de al servicio entero?
 *
 * Lo dice la back-reference: si entre los miembros del índice está la relación de la hija
 * hacia su raíz, «único» significa «único DENTRO de ese padre». Se pregunta por el miembro
 * con los dos nombres con los que el diseño puede escribirlo (`product` y `productId`), igual
 * que hace `columnsFor`: cuál de los dos nombra al miembro Java es decisión del generador.
 */
function collectionScopedConstraint(entity, constraint) {
  const toRoot = (entity.relations ?? []).filter((relation) => relation.backReference);
  if (toRoot.length === 0) return false;
  return (constraint.fields ?? []).some((member) => {
    const head = String(member).split('.')[0];
    return toRoot.some((relation) => head === relation.name || head === `${relation.name}Id`);
  });
}

// La unicidad es el único canónico DERIVADO: su familia depende de los campos de la clave,
// porque un servicio con varias claves naturales necesita un error por cada una.
function declaredUniquenessError(model, entity, fields, soleConstraint) {
  return declaredUniquenessErrorFor(model, FRAMEWORK_ERRORS.uniqueness, entity, fields, { soleConstraint });
}

function constraintMapConstant(constraints) {
  const entries = constraints
    .map(({ constraint, entity, fields, declared, raceOnly, conditional, when, description, reference }) => {
      const label = fields.join(', ');
      if (reference) {
        return `            // Referencia entre AGREGADOS (${reference.table}.${reference.column} → ${reference.refTable}):
            // la FK existe solo en el baseline de migraciones (una asociación navegable entre
            // raíces rompería la frontera del agregado), y la cierra en el borrado del padre.
            // El sentido inverso —alta contra un padre recién borrado— llega a esta MISMA
            // constraint y su error honesto sería otro; lo impide aguas arriba el bloqueo
            // compartido del handler, así que aquí se traduce el desenlace que sí es de negocio.
            Map.entry("${constraint}", () -> new ${declared.exceptionClass}(
                    "${escapeJava(String(declared.when ?? `No se puede borrar: hay ${reference.table} que lo referencian`).replace(/\.\s*$/, ''))}"))`;
      }
      const condition = conditional ? `${when.field} = ${JSON.stringify(when.equals)}` : null;
      const message = conditional
        ? escapeJava((description ?? `Solo puede haber un ${entity} por ${label} con ${condition}`).replace(/\.\s*$/, '')) +
          (raceOnly ? '; otra operación lo cambió a la vez, reintenta' : '')
        : raceOnly === 'collection'
          ? `Otra operación cambió ${label} de ${entity} a la vez; reintenta con el estado actual`
          : raceOnly
            ? `Otra operación registró ${entity}.${label} a la vez; reintenta`
            : `Ya existe un ${entity} con ese ${label}`;
      const why = conditional
        ? `            // Unicidad CONDICIONADA de ${entity}.${label} (${condition}): «como mucho uno en ese
            // estado», no «ya existe». ${raceOnly ? `El diseño no la nombra (keel validate: CHK-PERSIST-CONDITIONAL-UNIQUE-CODE):
            // la regla del caso de uso resuelve el caso normal, así que chocar aquí es una carrera.` : 'Es el error que el diseño declara para ella.'}`
        : raceOnly === 'collection'
        ? `            // Unicidad de ${entity}.${label} ACOTADA A LA COLECCIÓN de su raíz: el índice
            // incluye la relación al padre, así que "único" es "único dentro de ese padre". El
            // padre es implícito en la petición y el resto lo reparte el servicio entre toda la
            // colección, así que romperlo no es "ya existe uno así" —pedir esa posición es
            // legal— sino el estado intermedio del reparto o una carrera. El diseño no la
            // nombra (keel validate: CHK-PERSIST-CHILD-UNIQUE-CODE).`
        : raceOnly
        ? `            // ${entity}.${label} incluye un campo calculado por el servicio, y el agregado
            // lleva bloqueo optimista: nadie PIDIÓ este valor, así que romper la constraint
            // solo puede ser una carrera. Por eso es conflicto de concurrencia y no un "ya
            // existe": el cliente no mandó nada que pueda corregir, lo que toca es reintentar.`
        : `            // Unicidad de ${entity}.${label} → el error que el diseño declara para ella.`;
      if (declared) {
        return `${why}
            Map.entry("${constraint}", () -> new ${declared.exceptionClass}(
                    "${message}"))`;
      }
      const code = raceOnly
        ? FRAMEWORK_ERRORS.concurrency.code
        : `${screamingSnake(entity)}_${screamingSnake(fields.join('_'))}_ALREADY_EXISTS`;
      if (raceOnly) {
        return `${why}
            Map.entry("${constraint}", () -> new ConflictException(
                    "${message}", "${code}", 409, null))`;
      }
      return `            // TODO (agente): el diseño no declara (o declara de forma ambigua) un error
            // para la unicidad de ${entity}.${label}; este code es una convención del
            // scaffolding, no el contrato. Si el diseño lo declara, sustitúyelo.
            Map.entry("${constraint}", () -> new ConflictException(
                    "${message}", "${code}", 409, null))`;
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

// @RestControllerAdvice central: validación, errores de framework, jerarquía
// DomainException (una respuesta por subclase + genérico con httpStatus de la
// metadata) y catch-all 500. El body es siempre ErrorResponse (mismo paquete).
// Excepciones que lanza el propio Spring en una subida multipart, antes de que
// la petición llegue al controller: sin estos handlers caen en el catch-all y
// devuelven 500 donde el diseño (storage.maxSizeMb, error FILE_TOO_LARGE) espera
// 413/400. Son mecánicas: no dependen de la lógica del servicio.
function renderMultipartHandlers(imports, model) {
  imports.add('org.springframework.web.multipart.MaxUploadSizeExceededException');
  imports.add('org.springframework.web.multipart.support.MissingServletRequestPartException');
  // El diseño manda también aquí. Antes este handler emitía el canónico pasara lo que
  // pasara, así que una fixture que declaraba FILE_TOO_LARGE en su operación recibía por
  // el cable el code del scaffolding: dos nombres para el mismo 413 según por dónde
  // llegara el rechazo (la política del bucket dentro del handler, o el límite de Spring
  // antes de entrar).
  const declared = declaredErrorFor(model, FRAMEWORK_ERRORS.fileTooLarge);
  const tooLarge = declared?.code ?? FRAMEWORK_ERRORS.fileTooLarge.code;
  return `
    // ── Subida de archivos (capa storage) ────────────────────────────────────

    @ResponseStatus(HttpStatus.PAYLOAD_TOO_LARGE)
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ErrorResponse onMaxUploadSizeExceeded(MaxUploadSizeExceededException exception) {
        return new ErrorResponse(HttpStatus.PAYLOAD_TOO_LARGE.value(), "Payload Too Large",
                "${tooLarge}", "El archivo supera el tamaño máximo permitido", List.of());
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
// agregado): dos operaciones simultáneas escribieron sobre la misma versión. Sin
// este handler caería en el catch-all como 500. Es un 409: el cliente debe releer y
// reintentar con el estado actual. No lo confundas con un conflicto de
// `expectedVersion` que declare el diseño: ese lo comprueba el dominio contra su
// propio contador.
//
// La excepción concreta depende del modelo, y por eso se ramifica en vez de capturar
// siempre la superclase: JPA lanza ObjectOptimisticLockingFailureException (Spring
// traduce el OptimisticLockException al hacer commit) y Spring Data MongoDB lanza
// directamente OptimisticLockingFailureException, su padre. Capturar el padre
// funcionaría en ambos, pero cambiaría el Java ya generado de todos los servicios
// relacionales sin necesidad.
function renderOptimisticLockHandler(model, imports) {
  const exception =
    model.persistenceKind === 'document'
      ? 'OptimisticLockingFailureException'
      : 'ObjectOptimisticLockingFailureException';
  imports.add(
    model.persistenceKind === 'document'
      ? 'org.springframework.dao.OptimisticLockingFailureException'
      : 'org.springframework.orm.ObjectOptimisticLockingFailureException'
  );
  const message = 'El recurso fue modificado por otra operación concurrente; reintenta con el estado actual';
  const declared = declaredConcurrencyError(model);
  if (declared) {
    imports.add(`${subPackage(model, 'domain.errors')}.${declared.exceptionClass}`);
    return `
    // El diseño declara '${declared.code}' para este conflicto y ese code viaja en la
    // respuesta pública: es contrato con el integrador, así que gana al genérico del
    // scaffolding. Se delega en onDomainException para que status y forma del cuerpo
    // salgan de la misma metadata que el resto de errores declarados.
    @ExceptionHandler(${exception}.class)
    public ResponseEntity<ErrorResponse> onOptimisticLockingFailure(${exception} exception) {
        return onDomainException(new ${declared.exceptionClass}("${message}"));
    }
`;
  }
  const canonical = FRAMEWORK_ERRORS.concurrency;
  return `
    // El diseño no nombra este conflicto, así que sale con el código CANÓNICO del
    // framework (docs/framework-errors.md). No es una invención del scaffolding ni un
    // hueco que reportar: es el contrato de este mecanismo cuando el diseño no declara
    // uno propio. Para cambiarlo, decláralo en los errors de la operación donde se
    // observe, con status ${canonical.http} y un code de su familia.
    @ResponseStatus(HttpStatus.CONFLICT)
    @ExceptionHandler(${exception}.class)
    public ErrorResponse onOptimisticLockingFailure(${exception} exception) {
        return new ErrorResponse(HttpStatus.CONFLICT.value(), "Conflict", "${canonical.code}",
                "${message}", List.of());
    }
`;
}

// El error de conflicto por concurrencia que declara el diseño, si lo hay.
function declaredConcurrencyError(model) {
  return declaredErrorFor(model, FRAMEWORK_ERRORS.concurrency);
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
    'org.springframework.web.bind.MissingServletRequestParameterException',
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
      ? renderOptimisticLockHandler(model, imports)
      : '';
  const multipart = model.layersPresent.storage ? renderMultipartHandlers(imports, model) : '';

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
                "${FRAMEWORK_ERRORS.validation.code}", "La petición no supera las validaciones", details);
    }

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(ConstraintViolationException.class)
    public ErrorResponse onConstraintViolation(ConstraintViolationException exception) {
        List<String> details = exception.getConstraintViolations().stream()
                .map(violation -> violation.getPropertyPath() + " " + violation.getMessage())
                .toList();
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Validation Error",
                "${FRAMEWORK_ERRORS.validation.code}", "La petición viola restricciones declaradas", details);
    }

    // ── Errores de framework ─────────────────────────────────────────────────

    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ErrorResponse onMalformedRequest(Exception exception) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Bad Request",
                "${FRAMEWORK_ERRORS.validation.code}", "Petición malformada", null);
    }

    // Un @RequestParam obligatorio que no viaja en la query lo rechaza Spring
    // ANTES de Bean Validation, así que ningún @NotBlank del parámetro llega a
    // evaluarse: sin este handler el caso "parámetro ausente" cae en el catch-all
    // y devuelve 500 donde el contrato espera 400.
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ErrorResponse onMissingRequestParameter(MissingServletRequestParameterException exception) {
        return new ErrorResponse(HttpStatus.BAD_REQUEST.value(), "Bad Request",
                "${FRAMEWORK_ERRORS.validation.code}",
                "Falta el parámetro '" + exception.getParameterName() + "' en la petición", null);
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
