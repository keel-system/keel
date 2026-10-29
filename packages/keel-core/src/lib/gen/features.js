// Qué piezas pide un diseño: las preguntas «¿usa este diseño X?» de las que cuelga si un generador emite
// un módulo entero. Vivían copiadas, con el mismo cuerpo, en keel-nest y en keel-dotnet (auditoría del
// inc. 1 de PLAN-KEEL-GO.md); una pregunta que cambia de respuesta en uno solo es un servidor que deja de
// ser equivalente sin que nada lo diga.
//
// Solo están las que tienen el MISMO cierre en los generadores: un predicado que llama a otro que difiere
// (`usesMessaging`, `usesJwt`) no es neutral aunque su cuerpo lo parezca, y se queda en el generador
// hasta que se decida cuál de los dos es el bueno.

/** ¿Expone el servicio una API? Sin capa api, o sin ninguna operación con ruta, no hay nada de esto. */
export function usesApi(model) {
  return Boolean(model.layersPresent?.api) && (model.services ?? []).some((service) => (service.operations ?? []).some((op) => op.route));
}

/** ¿El diseño persiste en un motor relacional? */
export function usesRelational(model) {
  return Boolean(model.layersPresent?.persistence) && model.persistenceKind !== 'document';
}

/** ¿El diseño persiste en documentos (MongoDB)? */
export function usesDocument(model) {
  return Boolean(model.layersPresent?.persistence) && model.persistenceKind === 'document';
}

/**
 * ¿Hay persistencia, del modelo que sea? Es lo que mira lo que está ENCIMA de ella —el mediator, el arranque, el
 * mapeo de errores, la página—: las dos ramas emiten los mismos nombres, así que nada de arriba distingue qué
 * almacén tiene debajo.
 */
export function usesPersistence(model) {
  return usesRelational(model) || usesDocument(model);
}

/** Las raíces que tienen repositorio: persistidas y raíz de su agregado. */
export function repositoryRoots(model) {
  if (!usesPersistence(model)) return [];
  return model.entities.filter((entity) => entity.persisted && entity.isAggregateRoot);
}

/** La raíz con repositorio sobre la que trabaja una operación: la de su servicio, o la raíz del agregado de una hija. */
export function repositoryOf(model, operation) {
  const service = (model.services ?? []).find((group) => (group.operations ?? []).includes(operation));
  if (!service) return null;
  const target = model.entities.find((entity) => entity.name === service.entity);
  const rootName = target?.rootEntity ?? service.entity;
  return repositoryRoots(model).find((entity) => entity.name === rootName) ?? null;
}

/** ¿Alguna operación de la raíz pagina? Entonces su puerto lista por página. */
export function isPaginated(model, entity) {
  return (model.services ?? []).some((group) => group.entity === entity.name && (group.operations ?? []).some((op) => op.paginated));
}

/** ¿Es una actualización parcial (PATCH)? Un opcional del cuerpo tiene TRES estados. */
export function isPartialUpdate(operation) {
  return operation.route?.method === 'PATCH';
}

/** `resolvedBy` como `{ entity, field }`: el diseño lo escribe `Entidad.campo`, y una prueba puede pasarlo ya partido. */
export function resolvedByOf(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const [entity, field] = String(raw).split('.');
  return { entity, field };
}

/** ¿Hay casos de uso que despachar? Sin operaciones no hay mediator. */
export function usesMediator(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).length > 0);
}

/** ¿Genera este diseño clientes salientes? */
export function usesHttpClients(model) {
  return Boolean(model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0);
}

/** ¿Algún cliente se autentica con `oauth2-client-credentials`? */
export function usesOAuth2(model) {
  return (model.httpClients ?? []).some((client) => client.auth?.type === 'oauth2-client-credentials');
}

/** ¿Hay proveedor de prueba? Con clientes HTTP salientes o con la capa payments (la pasarela de prueba). */
export function usesHttpStub(model) {
  return Boolean((model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0) || model.payments);
}

/** ¿Lleva el arnés credenciales? */
export function usesIdentityHarness(model) {
  return Boolean(model.layersPresent?.security && model.security && model.security.protocol !== 'none');
}

/** ¿Declara el diseño la capa mail? */
export function usesMail(model) {
  return Boolean(model.layersPresent?.mail && model.mail);
}

/** ¿El diseño le atribuye a esta operación la salida por correo? (`mail.sentBy`) */
export function sendsMail(model, operation) {
  return usesMail(model) && (model.mail.sentBy ?? []).includes(operation.name);
}

/** ¿Alguna operación con ruta recibe un binario? Entonces la entrada HTTP lee multipart/form-data. */
export function usesMultipart(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).some((operation) => operation.route && operation.multipart));
}

/** ¿Declara el diseño la capa storage? Entonces se emite el contrato, aunque el stack no elija almacén. */
export function usesStorage(model) {
  return Boolean(model.layersPresent?.storage && model.storage);
}

/** ¿Se puede parar el almacenamiento en un flujo? Solo con un almacén que levanta contenedor (minio). */
export function usesStorageControl(model) {
  return usesStorage(model) && model.stack?.storage === 'minio';
}

/** ¿Declara el diseño la capa payments? */
export function usesPayments(model) {
  return Boolean(model.payments);
}

/** ¿Declara el servicio parámetros de despliegue (`service.parameters`)? */
export function usesServiceParameters(model) {
  return (model.service.parameters ?? []).length > 0;
}

/** ¿Cuenta el arnés las sentencias de una petición? Con API y persistencia relacional. */
export function usesStatementCount(model) {
  return usesApi(model) && usesRelational(model);
}
