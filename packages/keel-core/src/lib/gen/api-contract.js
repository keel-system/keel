// Las decisiones del CONTRATO HTTP que el diseño no escribe pero que el servidor tiene que tomar, y
// tomar igual en los dos generadores (keel-core/gen): dónde viaja la entrada de una operación (cuerpo
// o query), si el cuerpo es obligatorio y a dónde apunta la cabecera `Location` de un 201.
//
// Estaban dentro del controlador de keel-spring, y escritas dos veces divergirían al primer matiz:
// un servidor respondería 400 a una petición sin cuerpo que el otro acepta.

/** Métodos que admiten cuerpo: el DSL no declara requestBody, lo declara el verbo del endpoint. */
export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Cómo llega la entrada de una operación con ruta.
 *
 *   · `asBody`: el verbo admite cuerpo Y queda algo que leer de él. La identidad del llamante la
 *     resuelve el servidor, así que un POST cuyo único campo fuera de la ruta es ella no tiene
 *     cuerpo — con un cuerpo obligatorio, la petición correcta respondía 400 (corrida
 *     notification-mailer v2.0.0).
 *   · `bodyRequired`: si ningún campo del cuerpo es obligatorio, el cuerpo entero tampoco: una
 *     petición sin cuerpo es válida según el contrato y no puede dar 400.
 *   · si no hay cuerpo, los campos fuera de la ruta viajan en la query.
 */
export function requestShape(operation) {
  const method = operation.route?.method;
  const asBody = BODY_METHODS.has(method) && (operation.bodyFields ?? []).some((field) => !field.resolvedIdentity);
  return { asBody, bodyRequired: asBody && (operation.bodyFields ?? []).some((field) => field.required) };
}

/** Nombres con los que una ruta identifica a la entidad: genérico ({id}) o con su nombre ({productId}). */
export function idParamNames(entity) {
  return new Set(['id', `${entity[0].toLowerCase()}${entity.slice(1)}Id`]);
}

/**
 * La ruta de la operación que LEE por id la entidad de la respuesta: un GET sin lista cuya ruta tiene
 * un solo parámetro y es el id de esa entidad. Es la única ruta a la que `Location` puede apuntar sin
 * mentir; la de la petición + id solo coincide con ella por casualidad.
 */
export function readingPath(model, entity) {
  const owns = idParamNames(entity);
  for (const service of model.services ?? []) {
    for (const candidate of service.operations ?? []) {
      if (candidate.route?.method !== 'GET' || candidate.returnsList || candidate.paginated) continue;
      if (candidate.responseDto?.entity !== entity) continue;
      const params = candidate.pathParams ?? [];
      if (params.length === 1 && owns.has(params[0].name)) return String(candidate.route.path);
    }
  }
  return null;
}

/**
 * Parámetro de ruta que ya identifica a la entidad del `output`, si lo hay. Distingue «creo un
 * recurso y lo devuelvo» de «añado algo a la colección de un agregado y devuelvo el agregado»: en el
 * segundo caso `Location` apunta al padre (`POST /products/{productId}/images` → `/products/{productId}`).
 */
export function parentPathParam(operation) {
  const entity = operation.responseDto?.entity;
  if (!entity) return null;
  const owns = idParamNames(entity);
  return (operation.pathParams ?? []).find((param) => owns.has(param.name)) ?? null;
}

/**
 * A dónde apunta `Location`: la plantilla de la ruta de lectura con la base de la API
 * (`/api/v1/products/{productId}`) y con qué se expande — `param` es el parámetro de ruta del padre,
 * o null para el `id` de la respuesta. Null si ninguna operación lee ese recurso.
 */
export function locationTarget(model, operation) {
  const entity = operation.responseDto?.entity;
  if (!entity) return null;
  const path = readingPath(model, entity);
  if (!path) return null;
  const parent = parentPathParam(operation);
  return { path: `${model.api.routeBase}${path}`, param: parent ? parent.name : null };
}

/**
 * ¿Devuelve la operación `Location`? Un 201 con id en la salida y una lectura por id que lo sirva: es
 * contrato HTTP y los escenarios lo afirman. Sin lectura por id no hay `Location` —una cabecera que
 * apunta a una ruta que nadie sirve es un 404 prometido (hallazgo 3 de R9)—, y
 * `CHK-API-CREATED-NO-READ` ya se lo pregunta al diseño.
 */
export function returnsLocation(model, operation) {
  return (
    operation.route?.status === 201 &&
    !operation.returnsList &&
    !operation.paginated &&
    Boolean(operation.responseDto?.fields.some((field) => field.name === 'id')) &&
    locationTarget(model, operation) !== null
  );
}
