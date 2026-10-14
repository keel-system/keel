// Errores del dominio: la misma jerarquía que keel-spring y keel-nest, en C# puro.
//
// Todo vive en Domain/Errors: DomainException con su metadata (código, status, argumentos, detalles), una
// subclase por status HTTP (ERROR_BASES de keel-core/gen), los errores del diseño (<PascalCode>Error, con el
// `code` exacto, que es contrato público) y los que lanza el propio dominio generado: la transición de
// lifecycle no declarada y el valor que incumple su value object. Ninguno conoce ASP.NET Core: el manejador
// de errores de la API (incremento 5) es quien traduce una DomainException a la respuesta.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { ERROR_BASES } from 'keel-core/gen/error-bases';
import { csFile, csString, located, xmlDoc } from './render.js';

export function generate(model) {
  const file = (className, body) => {
    const { namespace, path } = located(model, 'errors', className);
    return { path, content: csFile({ namespace, body }) };
  };
  const files = [file('DomainException', domainExceptionBody())];
  for (const base of ERROR_BASES) files.push(file(base.name, baseBody(base)));
  for (const error of model.errors ?? []) files.push(file(error.exceptionClass, errorBody(error)));

  // El valor que incumple lo que declara su value object (formato, longitud, cotas, escala). Es el
  // equivalente de la IllegalArgumentException del constructor compacto de keel-spring, que su API
  // traduce a 400 VALIDATION_ERROR: aquí el status y el `code` van en la propia excepción, como en keel-nest.
  if ((model.valueObjects ?? []).length > 0) {
    files.push(
      file(
        'InvalidValueException',
        frameworkBody(
          'InvalidValueException',
          'BadRequestException',
          [
            'Un valor no cumple lo que declara su value object: presencia, formato, longitud, cotas o escala.',
            'Lo lanza el constructor del value object, el único punto por el que pasa cualquier valor de ese tipo,',
            'venga del cable, de la base de datos o de otro punto del dominio.'
          ],
          FRAMEWORK_ERRORS.validation
        )
      )
    );
  }
  // El formato de un value type escalar incumplido tras normalizar: solo si algún tipo escalar lo declara.
  if ((model.formatTypes ?? []).length > 0) {
    files.push(
      file(
        'ValueFormatException',
        frameworkBody(
          'ValueFormatException',
          'BadRequestException',
          [
            'Un valor no cumple el formato de su value type. La lanza la clase <Tipo>Format del dominio, donde vive',
            'la expresión regular del diseño. Sobre una petición HTTP el formato ya lo rechaza el lector de entrada:',
            'esto es la guarda del dominio para lo que llega por otra puerta (un evento, una operación interna).'
          ],
          FRAMEWORK_ERRORS.validation
        )
      )
    );
  }
  if ((model.entities ?? []).some((entity) => entity.lifecycle)) {
    const { code, http } = FRAMEWORK_ERRORS.invalidTransition;
    files.push(
      file(
        'InvalidStateTransitionException',
        `/// <summary>Transición de lifecycle no declarada en el diseño.</summary>
public sealed class InvalidStateTransitionException(string from, string to)
    : ConflictException($"Transición de estado no permitida: {from} -> {to}", code: ${csString(code)}, httpStatus: ${http});`
      )
    );
  }
  return files;
}

function domainExceptionBody() {
  return `/// <summary>
/// Base de todos los errores de dominio: violaciones intencionales de reglas de negocio que no deben
/// reintentarse. Los errores de infraestructura (un timeout de la base, una conexión caída) NO extienden
/// esta clase, para que puedan tratarse aparte (reintentos).
/// </summary>
/// <remarks>
/// Lleva metadata estructurada opcional (código, status, argumentos, detalles) con la que la API construye
/// el cuerpo de error con códigos estables.
/// </remarks>
public abstract class DomainException : Exception
{
    protected DomainException(
        string? message,
        string? code = null,
        int? httpStatus = null,
        IReadOnlyList<object?>? args = null,
        IReadOnlyList<string>? details = null,
        Exception? cause = null)
        : base(message, cause)
    {
        GivenMessage = message;
        Code = code;
        HttpStatus = httpStatus;
        Args = args;
        Details = details is null ? null : [.. details];
    }

    /// <summary>
    /// El mensaje con el que se construyó, o null. <see cref="Exception.Message"/> nunca es null (sin mensaje,
    /// .NET inventa uno en inglés), y la API necesita saber si responder con el de la clase base.
    /// </summary>
    public string? GivenMessage { get; }

    /// <summary>El código estable del error (contrato público), o null si el diseño no lo nombra.</summary>
    public string? Code { get; }

    /// <summary>El status HTTP con el que responde la API, o null para el de su clase base.</summary>
    public int? HttpStatus { get; }

    public IReadOnlyList<object?>? Args { get; }

    public IReadOnlyList<string>? Details { get; }
}`;
}

function baseBody({ name, http }) {
  return `/// <summary>Errores de dominio que responden ${http}.</summary>
public class ${name}(
    string? message,
    string? code = null,
    int? httpStatus = null,
    IReadOnlyList<object?>? args = null,
    IReadOnlyList<string>? details = null,
    Exception? cause = null)
    : DomainException(message, code, httpStatus ?? ${http}, args, details, cause);`;
}

/**
 * Error declarado del diseño. Con un único `http`, el status va fijado y la clase cuelga de la base de ese
 * status; si el diseño usa el mismo `code` con status distintos según la operación, el status es un
 * parámetro y la clase extiende DomainException.
 */
function errorBody(error) {
  const doc = [];
  if (error.when) doc.push(error.when);
  if (error.dynamicStatus) {
    for (const usage of error.usages ?? []) doc.push(`${usage.http} en ${usage.operations.join(', ')}.`);
    doc.push('El status depende de la operación: pásalo al construir el error.');
    return `${xmlDoc(doc)}public sealed class ${error.exceptionClass}(string message, int httpStatus)
    : DomainException(message, code: ${csString(error.code)}, httpStatus: httpStatus);`;
  }
  const parent = error.sharedException ?? 'DomainException';
  return `${xmlDoc(doc)}public sealed class ${error.exceptionClass}(string message)
    : ${parent}(message, code: ${csString(error.code)}, httpStatus: ${error.http});`;
}

function frameworkBody(name, parent, doc, { code, http }) {
  return `${xmlDoc(doc)}public sealed class ${name}(string message)
    : ${parent}(message, code: ${csString(code)}, httpStatus: ${http});`;
}
