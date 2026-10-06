// El CONTRATO de la proyección de lenguaje que `buildModel` recibe (keel-core/gen).
//
// El modelo interpreta el diseño sin saber en qué lenguaje se escribirá; cada vez que nace un
// campo, le pide a la proyección cómo se escribe. Un generador nuevo (keel-nest) implementa
// exactamente estos miembros y nada más: si el modelo necesitara otra cosa del lenguaje, se
// añade aquí primero, con su motivo, y se implementa en TODAS las proyecciones a la vez.
//
// Lo que devuelven los miembros de tipo son PROPIEDADES que el modelo esparce en el campo: sus
// nombres los elige cada proyección (la de Java usa `javaType`, `imports`, `elementJavaType`),
// porque quien las lee es el renderizador de ese mismo generador. El modelo nunca las nombra.
// La implementación de referencia es `keel-spring/src/lib/java-projection.js`.

/** Miembros obligatorios, con lo que devuelven. */
export const PROJECTION_MEMBERS = {
  projectSuffix: 'cadena: sufijo del proyecto generado (`services/<servicio>-<sufijo>`)',
  service: '(manifest, stack) → propiedades que el servicio añade por el lenguaje (su paquete, su módulo)',
  parameterType: '(type) → propiedades de tipo de un parámetro de despliegue escalar',
  fieldType: '(resolved, { list }) → propiedades de tipo de un campo resuelto (keel-core/gen/types)',
  elementType: '(resolved) → propiedades de tipo del ELEMENTO de un campo',
  namedType: '(name, { list }) → propiedades de tipo de una clase generada por nombre (un DTO)',
  namedElement: '(name) → propiedades de tipo del elemento cuando es una clase generada',
  renamed: '(name) → propiedades que cambian el tipo de un campo a otra clase generada',
  typeNameOf: '(field) → el nombre de tipo con el que se escribe un campo ya proyectado',
  carryType: '(field) → las propiedades de tipo de un campo, para copiarlas a otra estructura',
  uploadType: '() → propiedades de tipo de una subida binaria (un `file` en la entrada)',
  uploadValidation: '(required) → validación de una subida',
  replicaKey: '(keyField) → propiedades de la clave de una réplica (capa dependencies)',
  errorBase: '(http) → la excepción base que extiende el error de un `code` con ese status',
  fieldDetails: '(field, resolved, { fieldName, isList, persisted, collation }) → validación, cotas, columnas e inicializador',
  messages: 'objeto con los textos que nombran el framework (ver PROJECTION_MESSAGES)'
};

/** Los avisos cuyo texto depende del generador: nombran su framework o sus skills. */
export const PROJECTION_MESSAGES = {
  lockVersionReserved: '(entity) → aviso: el diseño usa el nombre del campo de bloqueo optimista',
  readQueriesRef: '(persistenceKind) → la referencia de la skill de lecturas con join proyectado',
  pathParamFallback: '(opName, path, name) → aviso: un segmento de ruta sin campo en el input',
  cognitoEmulated: '() → aviso: qué se emula en local con el stack de Cognito y qué no'
};

/**
 * Comprueba que una proyección implementa el contrato entero. Lanza nombrando lo que falta:
 * una proyección a medias no falla aquí sino en el primer campo que la necesite, lejos de la
 * causa, y solo con el diseño que lo tenga.
 */
export function assertProjection(projection) {
  if (!projection || typeof projection !== 'object') {
    throw new Error('buildModel: falta la proyección del lenguaje destino');
  }
  const missing = Object.keys(PROJECTION_MEMBERS).filter((member) => projection[member] === undefined);
  missing.push(
    ...Object.keys(PROJECTION_MESSAGES)
      .filter((message) => typeof projection.messages?.[message] !== 'function')
      .map((message) => `messages.${message}`)
  );
  if (missing.length > 0) {
    throw new Error(`buildModel: la proyección no implementa ${missing.join(', ')} (ver keel-core/gen/projection.js)`);
  }
}
