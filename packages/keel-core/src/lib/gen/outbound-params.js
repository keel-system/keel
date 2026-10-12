// Lo que una llamada saliente (`http-clients`) no puede llevar en la URL ni en una cabecera.
//
// Un value object compuesto viaja como objeto JSON: en el cuerpo de la petición y en la respuesta tiene forma,
// pero en la ruta, en la query o en una cabecera no la tiene. Un generador que lo aceptara escribiría ahí la
// representación de texto de su lenguaje (el `toString()` de un record, `[object Object]`), y el proveedor
// recibiría basura sin que nada fallara. La pregunta es neutral: los dos generadores la rechazan en build con
// el mismo mensaje.

/** ¿Es `field` un value object compuesto del dominio (o una lista de ellos)? */
function isComposite(types, field) {
  const type = field?.type ?? field?.items?.type;
  return Boolean(type && types[type] && (types[type].fields || types[type].kind === 'composite'));
}

/**
 * Las llamadas que llevan un value object compuesto en la ruta, la query o una cabecera:
 * `[{ client, call, fields }]`, en el orden del diseño.
 */
export function compositeUrlParams(layers) {
  const types = layers?.domain?.types ?? {};
  const out = [];
  for (const [client, definition] of Object.entries(layers?.['http-clients']?.clients ?? {})) {
    for (const [call, spec] of Object.entries(definition?.calls ?? {})) {
      const params = [
        ...Object.entries(spec?.request?.pathParams ?? {}),
        ...Object.entries(spec?.request?.queryParams ?? {}),
        ...Object.entries(spec?.request?.headers ?? {})
      ];
      const fields = params.filter(([, field]) => isComposite(types, field)).map(([name]) => name);
      if (fields.length > 0) out.push({ client, call, fields });
    }
  }
  return out;
}

/** El rechazo de build de cada una, redactado igual para los dos generadores. */
export function compositeUrlParamErrors(layers, generator) {
  return compositeUrlParams(layers).map(
    ({ client, call, fields }) =>
      `http-clients.${client}.calls.${call}: ${fields.join(', ')} es un value object compuesto en la ruta, la query o una cabecera, ` +
      `donde no tiene forma (solo el cuerpo y la respuesta viajan como JSON): ${generator} escribiría su texto y el proveedor recibiría basura. ` +
      'Pásalo en el cuerpo, o declara sus campos escalares por separado.'
  );
}
