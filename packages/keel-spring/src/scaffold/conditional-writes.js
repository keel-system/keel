// La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`) en keel-spring: incremento 4 de
// PLAN-DSL-225-ESCRITURA-CONDICIONAL.md, con el reparto de keel-dotnet, keel-nest y keel-go. Lo que decide QUÉ (las
// escrituras listadas, las lecturas que dan el ETag, la cabecera, los errores, la nota y el gate) es de
// keel-core/gen/conditional-writes.js; aquí solo se escribe en Java:
//
//   · `Versioned<T>` (application/interfaces): lo que devuelve el handler de una lectura derivada y de una escritura que
//     devuelve su raíz (D6). La versión es `@JsonProperty(required = true)`: una entrada de la caché sin ella es ilegible
//     (un miss, no un ETag inventado).
//   · `PreconditionFailedException` (412) y `PreconditionRequiredException` (428), en domain/errors: DomainException con
//     el code efectivo y el texto de keel-core/gen/api-errors.js. onDomainException ya traduce su status.
//   · `ConditionalRequests` (infrastructure/rest): lee If-Match a la lista de versiones que el controller estampa en el
//     mensaje (D2, D5) y escribe el ETag (D1). Con `required`, `RequiresIfMatch` + `IfMatchInterceptor` dan el 428 en
//     el preHandle, ANTES de resolver los argumentos del método: antes que todo 400 de la ruta o del cuerpo (D3).
//   · `loadExpecting` en el puerto de cada raíz escrita y en sus dos adaptadores (D4); el `save` de esas raíces devuelve
//     la versión PERSISTIDA (T1): con JPA, `saveAndFlush`.
//   · `infra/check-conditional-writes.sh` (CW-12), el gate neutral.
//
// El ETag lo pone el controller sobre la HttpServletResponse y no con ResponseEntity.eTag(...): con un ETag en el
// ResponseEntity de un GET, HttpEntityMethodProcessor evalúa If-None-Match y puede responder 304, que está fuera de
// 2.25 (D7) y ningún otro generador hace.

import {
  CHECK_CONDITIONAL_WRITES_SH,
  ETAG_HEADER,
  IF_MATCH_HEADER,
  conditionalWrite,
  conditionalWriteErrors,
  conditionalWriteNote,
  conditionalWritePolicy,
  conditionalWritesGateScript,
  conditionalWritesOf,
  returnsVersioned,
  usesConditionalWrites
} from '@keel-system/keel-core/gen/conditional-writes';
import { idParamNames } from '@keel-system/keel-core/gen/api-contract';
import { javaFile, javaPath, subPackage } from './render.js';
import { INTERFACES_PKG } from './mediator.js';

export const LOAD_EXPECTING = 'loadExpecting';
export const EXPECTED_VERSIONS = 'expectedVersions';
export const ERRORS_PKG = 'domain.errors';
export const REST_PKG = 'infrastructure.rest';
export const PRECONDITION_FAILED = 'PreconditionFailedException';
export const PRECONDITION_REQUIRED = 'PreconditionRequiredException';

export { usesConditionalWrites, returnsVersioned };

/** ¿Lleva el mensaje de esta operación la versión esperada? Solo las escrituras condicionales. */
export function carriesExpectedVersions(model, operation) {
  return Boolean(conditionalWrite(model, operation));
}

/** El componente del mensaje (D5): no llega del cuerpo, lo estampa el controller desde If-Match. */
export function expectedVersionsComponent(model) {
  return { javaType: 'List<Long>', name: EXPECTED_VERSIONS, imports: ['java.util.List'], validation: [], kind: 'base', expectedVersions: true };
}

/** El tipo de retorno de un handler que devuelve la versión: `Versioned<ProductResponseDto>`. */
export function versionedType(result) {
  return `Versioned<${result}>`;
}

export function versionedImport(model) {
  return `${subPackage(model, INTERFACES_PKG)}.Versioned`;
}

/** Las raíces que una escritura condicional carga: su puerto y sus adaptadores ganan `loadExpecting`. */
export function loadsExpecting(model, entity) {
  return (conditionalWritesOf(model)?.writes ?? []).some((write) => write.root === entity.name);
}

/** El método del puerto. */
export function loadExpectingPort(entity, id) {
  return `    /**
     * Carga el agregado comparando su versión con la que el cliente leyó (If-Match, api.concurrency): si no es ninguna
     * de {@code expectedVersions} lanza PreconditionFailedException (412) sin tocar nada; con null no compara. Vacío si
     * no existe: el NOT_FOUND del diseño va antes que el 412.
     */
    Optional<${entity.name}> ${LOAD_EXPECTING}(${id.javaType} ${id.name}, List<Long> ${EXPECTED_VERSIONS});`;
}

/**
 * El método de los dos adaptadores: carga con su findById y compara. La escritura que siga guarda con la versión LEÍDA,
 * así que otra escritura entre la carga y el commit sigue siendo el 409 de concurrencia y no el 412 (CW-5).
 */
export function loadExpectingAdapter(model, entity, id, imports) {
  imports.add('java.util.List');
  imports.add(`${subPackage(model, ERRORS_PKG)}.${PRECONDITION_FAILED}`);
  return `    @Override
    public Optional<${entity.name}> ${LOAD_EXPECTING}(${id.javaType} ${id.name}, List<Long> ${EXPECTED_VERSIONS}) {
        Optional<${entity.name}> found = findById(${id.name});
        if (found.isEmpty() || ${EXPECTED_VERSIONS} == null) {
            return found;
        }
        Number version = found.get().getLockVersion();
        if (version != null && ${EXPECTED_VERSIONS}.contains(version.longValue())) {
            return found;
        }
        throw new ${PRECONDITION_FAILED}();
    }`;
}

/** La nota del handler, la de keel-core, con los nombres de Java. */
export function conditionalHandlerNote(model, operation, param, repository) {
  const write = conditionalWrite(model, operation);
  const owns = idParamNames(write?.root ?? operation.responseDto?.entity ?? 'Raiz');
  const id = (operation.pathParams ?? []).find((pathParam) => owns.has(pathParam.name))?.name ?? 'id';
  return conditionalWriteNote(model, operation, {
    read: `${param}.${EXPECTED_VERSIONS}()`,
    load: `${repository}.${LOAD_EXPECTING}(${param}.${id}(), ${param}.${EXPECTED_VERSIONS}())`,
    versioned: versionedType(operation.responseDto?.name ?? 'T')
  });
}

/** Lo que estampa el controller en el componente del mensaje. */
export const STAMP_EXPECTED_VERSIONS = 'ConditionalRequests.expectedVersions(ifMatch)';

/** El parámetro del método del controller que lee If-Match. */
export function ifMatchParam(imports) {
  imports.add('org.springframework.web.bind.annotation.RequestHeader');
  return `@RequestHeader(value = "${IF_MATCH_HEADER}", required = false) String ifMatch`;
}

export function generate(model) {
  if (!usesConditionalWrites(model)) return [];
  const files = [versionedFile(model), ...exceptionFiles(model), requestsFile(model)];
  if (conditionalWritePolicy(model) === 'required') files.push(...requiredFiles(model));
  const gate = conditionalWritesGateScript(model, {
    handlerPath: (row) => javaPath(model, 'application.usecases', row.handlerClass),
    call: LOAD_EXPECTING
  });
  if (gate) files.push({ path: CHECK_CONDITIONAL_WRITES_SH, content: gate });
  return files;
}

function versionedFile(model) {
  const body = `/**
 * Una respuesta con la versión de su raíz (api.concurrency): el controller la escribe en la cabecera ETag. La versión
 * es la PERSISTIDA —la que devuelve save, o la del agregado leído—, nunca la que el handler tenía antes del commit: con
 * esa, el ETag va un número por detrás y la siguiente edición encadenada da 412 sin conflicto.
 *
 * <p>La versión es obligatoria también al LEER el JSON: la caché guarda {@code Versioned<T>}, y una entrada que solo
 * traiga el cuerpo es ilegible —un miss, no una respuesta con un ETag inventado—.
 */
public record Versioned<T>(@JsonProperty(required = true) long version, T value) {
}`;
  return {
    path: javaPath(model, INTERFACES_PKG, 'Versioned'),
    content: javaFile(subPackage(model, INTERFACES_PKG), ['com.fasterxml.jackson.annotation.JsonProperty'], body)
  };
}

function exceptionFiles(model) {
  const { failed, required } = conditionalWriteErrors(model);
  return [
    exceptionFile(model, PRECONDITION_FAILED, failed, 'If-Match no coincide con la versión vigente: otro escribió entre la lectura y la escritura del cliente. No se escribe nada.'),
    exceptionFile(model, PRECONDITION_REQUIRED, required, 'La escritura exige If-Match (api.concurrency.conditionalWrites: required) y la petición no lo trae. Se responde en el borde, sin cargar nada.')
  ];
}

function exceptionFile(model, name, error, summary) {
  const body = `/**
 * ${summary}
 */
public class ${name} extends DomainException {

    public static final String CODE = ${JSON.stringify(error.code)};
    public static final int STATUS = ${error.status};
    public static final String DEFAULT_MESSAGE = ${JSON.stringify(error.message)};

    public ${name}() {
        super(DEFAULT_MESSAGE, CODE, STATUS, null);
    }
}`;
  return { path: javaPath(model, ERRORS_PKG, name), content: javaFile(subPackage(model, ERRORS_PKG), [], body) };
}

function requestsFile(model) {
  const body = `/**
 * La escritura condicional en el borde (api.concurrency; los casos, en keel-core/gen/wire.js). El ETag es la versión
 * entre comillas, fuerte y opaco; If-Match se compara en fuerte: '*' se cumple si el recurso existe (no compara), una
 * lista si coincide cualquiera, y un W/"…", un valor sin comillas o ilegible no coincide con nada (412, no 400).
 */
public final class ConditionalRequests {

    private static final Pattern STRONG_VERSION = Pattern.compile("^\\"(0|[1-9][0-9]*)\\"$");

    private ConditionalRequests() {
    }

    /** ¿Falta la cabecera? Ausente o vacía: es lo que da 428 con {@code required}. */
    public static boolean absent(String header) {
        return header == null || header.isBlank();
    }

    /**
     * Lo que se estampa en el mensaje: null si no se compara (sin cabecera, vacía o '*') y si no las versiones fuertes
     * que trae. Una cabecera con solo elementos débiles o ilegibles da una lista vacía, que no casa con nada.
     */
    public static List<Long> expectedVersions(String header) {
        if (absent(header) || header.trim().equals("*")) {
            return null;
        }
        List<Long> versions = new ArrayList<>();
        for (String element : header.split(",")) {
            Matcher match = STRONG_VERSION.matcher(element.trim());
            if (match.matches()) {
                try {
                    versions.add(Long.parseLong(match.group(1)));
                } catch (NumberFormatException tooLarge) {
                    // Más allá de un long no es ninguna versión que este servicio haya dado: no casa.
                }
            }
        }
        return List.copyOf(versions);
    }

    /** El ETag de una versión: entre comillas, fuerte. */
    public static String etagOf(long version) {
        return "\\"" + version + "\\"";
    }

    /** Escribe el ETag de la versión en la respuesta. */
    public static void writeEtag(HttpServletResponse response, long version) {
        response.setHeader("${ETAG_HEADER}", etagOf(version));
    }
}`;
  return {
    path: javaPath(model, REST_PKG, 'ConditionalRequests'),
    content: javaFile(
      subPackage(model, REST_PKG),
      ['jakarta.servlet.http.HttpServletResponse', 'java.util.ArrayList', 'java.util.List', 'java.util.regex.Matcher', 'java.util.regex.Pattern'],
      body
    )
  };
}

/** Con `required`: la anotación de los métodos que exigen If-Match, el interceptor que da el 428 y su registro. */
function requiredFiles(model) {
  const pkg = subPackage(model, REST_PKG);
  const annotation = `/**
 * Marca un método del controller cuya escritura exige If-Match (api.concurrency.conditionalWrites: required). La lee
 * {@link IfMatchInterceptor}, que responde 428 antes de resolver ningún argumento.
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresIfMatch {
}`;
  const interceptor = `/**
 * El 428 de la escritura condicional, en el borde y sin cargar nada (D3). Va en el preHandle porque corre ANTES de
 * resolver los argumentos del método: un id de ruta mal formado o un cuerpo inválido darían 400, y una escritura sin
 * If-Match es 428 diga lo que diga el resto de la petición. La seguridad (401/403) va antes, en su cadena de filtros.
 */
public class IfMatchInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (handler instanceof HandlerMethod method && method.hasMethodAnnotation(RequiresIfMatch.class)
                && ConditionalRequests.absent(request.getHeader("${IF_MATCH_HEADER}"))) {
            throw new ${PRECONDITION_REQUIRED}();
        }
        return true;
    }
}`;
  const config = `/** Registra {@link IfMatchInterceptor}: el 428 de las escrituras condicionales (api.concurrency). */
@Configuration
public class ConditionalRequestsConfig implements WebMvcConfigurer {

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new IfMatchInterceptor());
    }
}`;
  return [
    { path: javaPath(model, REST_PKG, 'RequiresIfMatch'), content: javaFile(pkg, ['java.lang.annotation.ElementType', 'java.lang.annotation.Retention', 'java.lang.annotation.RetentionPolicy', 'java.lang.annotation.Target'], annotation) },
    {
      path: javaPath(model, REST_PKG, 'IfMatchInterceptor'),
      content: javaFile(
        pkg,
        [
          `${subPackage(model, ERRORS_PKG)}.${PRECONDITION_REQUIRED}`,
          'jakarta.servlet.http.HttpServletRequest',
          'jakarta.servlet.http.HttpServletResponse',
          'org.springframework.web.method.HandlerMethod',
          'org.springframework.web.servlet.HandlerInterceptor'
        ],
        interceptor
      )
    },
    {
      path: javaPath(model, REST_PKG, 'ConditionalRequestsConfig'),
      content: javaFile(
        pkg,
        [
          'org.springframework.context.annotation.Configuration',
          'org.springframework.web.servlet.config.annotation.InterceptorRegistry',
          'org.springframework.web.servlet.config.annotation.WebMvcConfigurer'
        ],
        config
      )
    }
  ];
}
