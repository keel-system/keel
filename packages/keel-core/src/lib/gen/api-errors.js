// Los TEXTOS con los que la API responde a cada fallo: el `error` (la frase del status) y el `message` por
// defecto de cada clase base de la jerarquía de errores, y los de los fallos que pone el propio framework (una
// petición que no se puede leer, que no supera las validaciones, un método que no existe). Son contrato
// observable —los escenarios afirman `error` y `message`—, así que el mismo diseño tiene que responder con
// las mismas palabras en todos los servidores generados. Estaban escritos a mano en el ApiExceptionHandler de
// keel-spring y copiados en el filtro de keel-nest (incremento 5a de PLAN-KEEL-DOTNET.md).
//
// El `code` de cada caso NO va aquí: es de framework-errors.js (lista cerrada, con su override por diseño).

import { ERROR_BASES } from './error-bases.js';

/**
 * Por clase base de la jerarquía: el `error` de su respuesta y el `message` cuando la excepción no trae uno.
 * Una por cada entrada de ERROR_BASES, en el mismo orden (lo vigila un test).
 */
export const DOMAIN_ERROR_RESPONSES = {
  BadRequestException: { error: 'Bad Request', fallback: 'Petición inválida' },
  UnauthorizedException: { error: 'Unauthorized', fallback: 'Autenticación requerida' },
  ForbiddenException: { error: 'Forbidden', fallback: 'Acceso denegado' },
  NotFoundException: { error: 'Not Found', fallback: 'Recurso no encontrado' },
  ConflictException: { error: 'Conflict', fallback: 'Conflicto con el estado actual del recurso' },
  PayloadTooLargeException: { error: 'Payload Too Large', fallback: 'El contenido enviado supera el tamaño permitido' },
  BusinessException: { error: 'Business Rule Violation', fallback: 'Se violó una regla de negocio' }
};

/** Las bases de ERROR_BASES con su texto de respuesta, en orden: lo que recorre cada manejador de errores. */
export function domainErrorResponses() {
  return ERROR_BASES.map((base) => {
    const texts = DOMAIN_ERROR_RESPONSES[base.name];
    if (!texts) throw new Error(`api-errors: la base ${base.name} no tiene texto de respuesta`);
    return { ...base, ...texts };
  });
}

/**
 * Los fallos que pone el framework antes de llegar a ningún caso de uso, con su status, su `error` y su
 * `message`. `missingParameter` es una plantilla: `{name}` es el parámetro que falta.
 */
export const FRAMEWORK_RESPONSES = {
  /** El cuerpo leído incumple lo que el diseño declara (Bean Validation sobre el cuerpo). */
  invalidBody: { status: 400, error: 'Validation Error', message: 'La petición no supera las validaciones' },
  /** Un parámetro de ruta o de query incumple lo que el diseño declara. */
  invalidParams: { status: 400, error: 'Validation Error', message: 'La petición viola restricciones declaradas' },
  /** La petición no se puede leer: JSON roto, un tipo que no encaja, un value object que su constructor rechaza. */
  malformed: { status: 400, error: 'Bad Request', message: 'Petición malformada' },
  /** Falta un parámetro obligatorio de la query. */
  missingParameter: { status: 400, error: 'Bad Request', message: "Falta el parámetro '{name}' en la petición" },
  /** El camino existe, con otro método. */
  methodNotAllowed: { status: 405, error: 'Method Not Allowed', message: 'Método HTTP no soportado' },
  /** Ninguna ruta casa con el camino. */
  notFound: { status: 404, error: 'Not Found', message: 'Recurso no encontrado' },
  /**
   * El cuerpo de una petición supera el tope de la entrada, sin code. Solo lo emite keel-go: net/http no pone tope
   * por defecto y el suyo es explícito (`MaxBytesReader`); Tomcat no limita un cuerpo JSON, y el tope de Kestrel o
   * de Fastify cae en el manejador de cada uno sin texto propio.
   */
  bodyTooLarge: { status: 413, error: 'Payload Too Large', message: 'El cuerpo de la petición supera el tamaño permitido' },
  /** Lo que nadie tradujo: el catch-all. */
  internal: { status: 500, error: 'Internal Server Error', message: 'Ocurrió un error inesperado' },
  /** La cadena de seguridad: la petición no trae credencial, o la que trae no vale (code UNAUTHENTICATED). */
  unauthenticated: { status: 401, error: 'Unauthorized', message: 'Credenciales ausentes o no válidas' },
  /** La cadena de seguridad: la credencial vale pero no autoriza la operación (code ACCESS_DENIED). */
  accessDenied: { status: 403, error: 'Forbidden', message: 'La credencial no autoriza esta operación' },
  // La subida multipart (capa storage). Su `code` no vive aquí: el 413 lleva el que declara el diseño o el canónico
  // (FRAMEWORK_ERRORS.fileTooLarge), y lo ilegible y lo vacío, FILE_UNREADABLE (FRAMEWORK_ERRORS.fileUnreadable).
  /** Falta la parte binaria obligatoria (el MissingServletRequestPartException de keel-spring), sin code. */
  missingPart: { status: 400, error: 'Bad Request', message: "Falta la parte '{name}' en la petición multipart" },
  /** Una operación de subida recibió un cuerpo que no es multipart/form-data, sin code. */
  notMultipart: { status: 415, error: 'Unsupported Media Type', message: 'La operación espera multipart/form-data' },
  /** El cuerpo supera el límite de la ENTRADA (el doble del mayor `maxSizeMb`). */
  fileTooLarge: { status: 413, error: 'Payload Too Large', message: 'El archivo supera el tamaño máximo permitido' },
  /** El cuerpo multipart no se puede leer: cortado o mal formado. */
  fileUnreadable: { status: 400, error: 'Bad Request', message: 'No se pudo leer el archivo enviado' },
  /** Una parte obligatoria llegó con cero bytes: es una subida rota, no «sin archivo». */
  fileEmpty: { status: 400, error: 'Bad Request', message: 'El archivo enviado está vacío' }
};

/** El mensaje de una parte obligatoria ausente en una subida multipart, con el nombre ya puesto. */
export function missingPartMessage(name) {
  return FRAMEWORK_RESPONSES.missingPart.message.replace('{name}', name);
}

/** El mensaje de un parámetro obligatorio ausente, con el nombre ya puesto. */
export function missingParameterMessage(name) {
  return FRAMEWORK_RESPONSES.missingParameter.message.replace('{name}', name);
}
