// Manejo de errores (arquitectura del prototipo, sin paquete shared): todo el
// catálogo vive en domain/errors — DomainException con metadata
// code/httpStatus/args/details, una subclase por status HTTP, los errores del
// diseño (<PascalCode>Error, code exacto: contrato público) y el guard de
// lifecycle. ErrorResponse (contrato HTTP) vive junto al handler en
// infrastructure/rest.

import { javaFile, javaPath, subPackage } from './render.js';
import { sharedExceptionFor } from '../lib/model.js';
import { usesCorrelation, correlationImport } from './correlation.js';

const ERRORS_PKG = 'domain.errors';

// Subclases base y el status al que responde cada una en ApiExceptionHandler.
const BASE_SUBCLASSES = [
  { name: 'BadRequestException', http: 400 },
  { name: 'UnauthorizedException', http: 401 },
  { name: 'ForbiddenException', http: 403 },
  { name: 'NotFoundException', http: 404 },
  { name: 'ConflictException', http: 409 },
  { name: 'PayloadTooLargeException', http: 413 },
  { name: 'BusinessException', http: 422 }
];

export function generate(model) {
  const errorsPkg = subPackage(model, ERRORS_PKG);
  const files = [];

  files.push({
    path: javaPath(model, ERRORS_PKG, 'DomainException'),
    content: javaFile(errorsPkg, ['java.util.Collections', 'java.util.List'], domainExceptionBody())
  });

  for (const subclass of BASE_SUBCLASSES) {
    files.push({
      path: javaPath(model, ERRORS_PKG, subclass.name),
      content: javaFile(errorsPkg, ['java.util.List'], baseSubclassBody(subclass))
    });
  }

  files.push({
    path: javaPath(model, 'infrastructure.rest', 'ErrorResponse'),
    content: javaFile(
      subPackage(model, 'infrastructure.rest'),
      [
        'com.fasterxml.jackson.annotation.JsonInclude',
        'java.time.Instant',
        'java.util.List',
        usesCorrelation(model) ? correlationImport(model) : null
      ],
      errorResponseBody(model)
    )
  });

  for (const error of model.errors) {
    const parent = error.sharedException ?? sharedExceptionFor(error.http);
    const when = error.when ? `/**\n * ${error.when}\n */\n` : '';
    files.push({
      path: javaPath(model, ERRORS_PKG, error.exceptionClass),
      content: javaFile(
        errorsPkg,
        [],
        `${when}public class ${error.exceptionClass} extends ${parent} {

    public ${error.exceptionClass}(String message) {
        super(message, "${error.code}", ${error.http}, null);
    }
}`
      )
    });
  }

  if (model.entities.some((entity) => entity.lifecycle)) {
    files.push({
      path: javaPath(model, ERRORS_PKG, 'InvalidStateTransitionException'),
      content: javaFile(
        errorsPkg,
        [],
        `/**
 * Transición de lifecycle no declarada en el diseño.
 */
public class InvalidStateTransitionException extends ConflictException {

    public InvalidStateTransitionException(String from, String to) {
        super("Transición de estado no permitida: " + from + " -> " + to, "INVALID_STATE_TRANSITION", 409, null);
    }
}`
      )
    });
  }

  return files;
}

function domainExceptionBody() {
  return `/**
 * Base de todos los errores de dominio: violaciones intencionales de reglas de
 * negocio que no deben reintentarse. Las excepciones de infraestructura
 * (timeouts de BD, conexión, etc.) NO extienden esta clase: se dejan como
 * RuntimeException para que puedan tratarse aparte (p. ej. reintentos).
 *
 * Lleva metadata estructurada opcional (code, httpStatus, args, details) que
 * ApiExceptionHandler usa para construir el ErrorResponse con codes estables.
 */
public abstract class DomainException extends RuntimeException {

    private final String code;
    private final Integer httpStatus;
    private final Object[] args;
    private final List<String> details;

    protected DomainException() {
        this(null, null, null, null, null);
    }

    protected DomainException(String message) {
        this(message, null, null, null, null);
    }

    protected DomainException(String message, Throwable cause) {
        super(message, cause);
        this.code = null;
        this.httpStatus = null;
        this.args = null;
        this.details = null;
    }

    protected DomainException(String message, String code, Integer httpStatus, Object[] args) {
        this(message, code, httpStatus, args, null);
    }

    protected DomainException(String message, String code, Integer httpStatus, Object[] args, List<String> details) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.args = args;
        this.details = details == null ? null : Collections.unmodifiableList(details);
    }

    public String getCode() {
        return code;
    }

    public Integer getHttpStatus() {
        return httpStatus;
    }

    public Object[] getArgs() {
        return args;
    }

    public List<String> getDetails() {
        return details;
    }
}`;
}

function baseSubclassBody({ name, http }) {
  return `/**
 * Errores de dominio que responden ${http}; ApiExceptionHandler la mapea.
 */
public class ${name} extends DomainException {

    public ${name}(String message) {
        super(message);
    }

    public ${name}(String message, Throwable cause) {
        super(message, cause);
    }

    public ${name}(String message, String code, Integer httpStatus, Object[] args) {
        super(message, code, httpStatus, args);
    }

    public ${name}(String message, String code, Integer httpStatus, Object[] args, List<String> details) {
        super(message, code, httpStatus, args, details);
    }
}`;
}

function errorResponseBody(model) {
  // Con correlación, el body la lleva: es lo que convierte un error que el
  // usuario reporta en una traza localizable en los logs. Los constructores de
  // conveniencia la resuelven solos para que ningún handler tenga que pasarla.
  const correlated = usesCorrelation(model);
  const component = correlated ? ', String correlationId' : '';
  const arg = correlated ? ', CorrelationContext.get()' : '';

  return `/**
 * Contrato de error de la API: body uniforme para todos los fallos.
 * Los campos nulos no se serializan.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorResponse(Instant timestamp, int status, String error, String code, String message, List<String> details${component}) {

    public ErrorResponse(int status, String error, String message) {
        this(Instant.now(), status, error, null, message, null${arg});
    }

    public ErrorResponse(int status, String error, String code, String message, List<String> details) {
        this(Instant.now(), status, error, code, message, details${arg});
    }
}`;
}
