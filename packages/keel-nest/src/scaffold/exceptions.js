// Errores del dominio: la misma jerarquía que keel-spring, en TypeScript puro.
//
// Todo vive en domain/errors —DomainException con metadata code/httpStatus/args/details, una
// subclase por status HTTP, los errores del diseño (<PascalCode>Error, `code` exacto: contrato
// público) y los dos que lanza el propio dominio generado: la transición de lifecycle no declarada
// y el valor que incumple su value object—. Ninguno importa @nestjs: los nombres de las subclases
// coinciden con las excepciones HTTP de Nest a propósito (son los de la arquitectura compartida), y
// el filtro de la API (incremento 5) es quien traduce DomainException a la respuesta.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { DIRS, classPath, tsModule, tsdoc, tsString } from './render.js';

// Subclases base y el status al que responde cada una (el mismo reparto que keel-spring).
export const BASE_SUBCLASSES = [
  { name: 'BadRequestException', http: 400 },
  { name: 'UnauthorizedException', http: 401 },
  { name: 'ForbiddenException', http: 403 },
  { name: 'NotFoundException', http: 404 },
  { name: 'ConflictException', http: 409 },
  { name: 'PayloadTooLargeException', http: 413 },
  { name: 'BusinessException', http: 422 }
];

export const DOMAIN_EXCEPTION_TS = classPath(DIRS.errors, 'DomainException');
export const INVALID_VALUE_TS = classPath(DIRS.errors, 'InvalidValueException');
export const INVALID_TRANSITION_TS = classPath(DIRS.errors, 'InvalidStateTransitionException');
export const VALUE_FORMAT_TS = classPath(DIRS.errors, 'ValueFormatException');

const errorPath = (name) => classPath(DIRS.errors, name);

export function generate(model) {
  const files = [{ path: DOMAIN_EXCEPTION_TS, content: tsModule(DOMAIN_EXCEPTION_TS, [], domainExceptionBody()) }];

  for (const subclass of BASE_SUBCLASSES) {
    const file = errorPath(subclass.name);
    files.push({
      path: file,
      content: tsModule(
        file,
        [
          { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
          { symbol: 'DomainExceptionOptions', from: DOMAIN_EXCEPTION_TS, type: true }
        ],
        baseSubclassBody(subclass)
      )
    });
  }

  for (const error of model.errors ?? []) {
    const file = errorPath(error.exceptionClass);
    const parent = error.dynamicStatus ? 'DomainException' : (error.sharedException ?? 'DomainException');
    files.push({
      path: file,
      content: tsModule(file, [{ symbol: parent, from: errorPath(parent) }], errorClassBody(error, parent))
    });
  }

  // El valor que incumple lo que su value object declara (formato, longitud, cotas, escala). Es el
  // equivalente de la IllegalArgumentException del constructor compacto de keel-spring, que su API
  // traduce a 400 VALIDATION_ERROR: aquí el status y el `code` van en la propia excepción, que es
  // lo que hace que los dos servidores respondan lo mismo.
  if ((model.valueObjects ?? []).length > 0) {
    files.push({
      path: INVALID_VALUE_TS,
      content: tsModule(
        INVALID_VALUE_TS,
        [{ symbol: 'BadRequestException', from: errorPath('BadRequestException') }],
        `/**
 * Un valor no cumple lo que declara su value object: presencia, formato, longitud, cotas o escala.
 * Lo lanza el constructor del value object, que es el único punto por el que pasa cualquier valor
 * de ese tipo, venga del cable, de la base de datos o de otro punto del dominio.
 */
export class InvalidValueException extends BadRequestException {
  constructor(message: string) {
    super(message, { code: ${tsString(FRAMEWORK_ERRORS.validation.code)}, httpStatus: ${FRAMEWORK_ERRORS.validation.http} });
  }
}`
      )
    });
  }

  // Formato de un value type escalar incumplido tras normalizar. Solo si hay algún tipo escalar con
  // `pattern`: sin eso nadie la lanzaría.
  if ((model.formatTypes ?? []).length > 0) {
    files.push({
      path: VALUE_FORMAT_TS,
      content: tsModule(
        VALUE_FORMAT_TS,
        [{ symbol: 'BadRequestException', from: errorPath('BadRequestException') }],
        `/**
 * Un valor no cumple el formato de su value type declarado. Lo lanza la clase <Tipo>Format del
 * dominio, que es donde vive la regex del diseño.
 *
 * Sobre una petición HTTP el formato ya lo rechaza el lector de entrada; esto es la guarda del
 * dominio, para lo que llega por otra puerta (un evento, una operación interna). Mismo code y status.
 */
export class ValueFormatException extends BadRequestException {
  constructor(message: string) {
    super(message, { code: ${tsString(FRAMEWORK_ERRORS.validation.code)}, httpStatus: ${FRAMEWORK_ERRORS.validation.http} });
  }
}`
      )
    });
  }

  if ((model.entities ?? []).some((entity) => entity.lifecycle)) {
    files.push({
      path: INVALID_TRANSITION_TS,
      content: tsModule(
        INVALID_TRANSITION_TS,
        [{ symbol: 'ConflictException', from: errorPath('ConflictException') }],
        `/** Transición de lifecycle no declarada en el diseño. */
export class InvalidStateTransitionException extends ConflictException {
  constructor(from: string, to: string) {
    super(\`Transición de estado no permitida: \${from} -> \${to}\`, {
      code: ${tsString(FRAMEWORK_ERRORS.invalidTransition.code)},
      httpStatus: ${FRAMEWORK_ERRORS.invalidTransition.http}
    });
  }
}`
      )
    });
  }

  return files;
}

// Error declarado del diseño. Con un único `http` el status va fijado y la clase cuelga de la
// subclase de ese status; si el diseño usa el mismo `code` con status distintos según la operación,
// el status es un parámetro y la clase extiende DomainException.
function errorClassBody(error, parent) {
  const doc = [];
  if (error.when) doc.push(error.when);
  if (error.dynamicStatus) {
    for (const usage of error.usages ?? []) doc.push(`${usage.http} en ${usage.operations.join(', ')}.`);
    doc.push('El status depende de la operación: pásalo al construir el error.');
    return `${tsdoc(doc)}export class ${error.exceptionClass} extends ${parent} {
  constructor(message: string, httpStatus: number) {
    super(message, { code: ${tsString(error.code)}, httpStatus });
  }
}`;
  }
  return `${tsdoc(doc)}export class ${error.exceptionClass} extends ${parent} {
  constructor(message: string) {
    super(message, { code: ${tsString(error.code)}, httpStatus: ${error.http} });
  }
}`;
}

function domainExceptionBody() {
  return `/** Metadata opcional de un error de dominio. */
export interface DomainExceptionOptions {
  readonly code?: string | null;
  readonly httpStatus?: number | null;
  readonly args?: readonly unknown[] | null;
  readonly details?: readonly string[] | null;
  readonly cause?: unknown;
}

/**
 * Base de todos los errores de dominio: violaciones intencionales de reglas de negocio que no deben
 * reintentarse. Los errores de infraestructura (un timeout de la base, una conexión caída) NO
 * extienden esta clase, para que puedan tratarse aparte (reintentos).
 *
 * Lleva metadata estructurada opcional (code, httpStatus, args, details) con la que la API
 * construye el ErrorResponse con códigos estables.
 */
export abstract class DomainException extends Error {
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly args: readonly unknown[] | null;
  readonly details: readonly string[] | null;

  protected constructor(message?: string, options: DomainExceptionOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.args = options.args ?? null;
    this.details = options.details == null ? null : Object.freeze([...options.details]);
  }
}`;
}

function baseSubclassBody({ name, http }) {
  return `/** Errores de dominio que responden ${http}. */
export class ${name} extends DomainException {
  constructor(message?: string, options: DomainExceptionOptions = {}) {
    super(message, options);
  }
}`;
}
