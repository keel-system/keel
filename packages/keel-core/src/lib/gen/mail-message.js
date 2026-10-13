// Las defensas del mensaje de correo que build genera ENTERO en los dos generadores (el contenido de origen
// externo no se le pide al agente: su ausencia no rompe ninguna prueba). Lo que no depende del lenguaje es el
// DATO de cada defensa, y estaba copiado (incremento 1d de PLAN-KEEL-DOTNET.md).

/**
 * Cabeceras que el diseño no puede poner a mano: las escribe el transporte a partir del resto del mensaje, y
 * una cabecera con uno de estos nombres duplicaría o pisaría lo que el mensaje ya dice. Se rechazan al
 * construir. En minúsculas: la comparación no distingue mayúsculas.
 */
export const RESERVED_MAIL_HEADERS = ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'mime-version', 'return-path'];

/** Nombre de cabecera (RFC 5322): imprimibles sin espacio ni dos puntos, como clase de caracteres. */
export const MAIL_HEADER_NAME_CLASS = '[!-9;-~]+';

/**
 * El escapado HTML de las variables, con una tabla CERRADA: el conjunto que basta para escribir un dato como
 * texto dentro de un elemento o de un atributo entrecomillado. No es el de los motores de plantillas por
 * defecto (Handlebars escribe el apóstrofo como `&#x27;` y escapa además `` ` `` y `=`), y por eso un escenario
 * que afirma `O&#39;Hara` puede fallar con un servidor y pasar con el otro. El `&` va primero: escapado
 * después, se comería los demás.
 */
export const HTML_ESCAPES = [
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;']
];

/** Plantillas compiladas que el renderizador conserva en memoria (la clave es la plantilla). */
export const COMPILED_TEMPLATES_LIMIT = 500;
