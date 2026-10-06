// La PROYECCIÓN Java del modelo: lo que `buildModel` necesita saber del lenguaje destino y no
// puede decidir el diseño.
//
// El modelo interpreta el diseño —qué entidades hay, qué campos, qué operaciones, qué reclamos—
// y esa interpretación tiene que ser la misma para cualquier generador. Pero cada campo que
// produce lo consume un renderizador que interpola su tipo, sus imports, sus anotaciones de
// validación y de columna y su inicializador, y eso sí es de Java. En vez de escribirlo dentro
// del modelo, el modelo se lo pide a esta proyección en cada punto donde nace un campo: así la
// interpretación puede vivir en keel-core sin nombrar un solo tipo de un lenguaje, y keel-nest le
// pasa la suya.
//
// Regla: aquí no se toma ninguna decisión del DISEÑO. Si una función de este módulo necesita
// mirar el diseño para decidir algo que no sea cómo se escribe en Java, esa decisión es del
// modelo.

import { screamingSnake, basePackage } from './naming.js';
import { toJava, beanValidationAnnotations, columnAnnotations } from './type-mapper.js';
import { numericConstraints, inheritedFormat } from 'keel-core/gen/constraints';

// http declarado en el diseño → excepción base de shared/exception que extiende
// el error generado; los status sin subclase dedicada extienden DomainException
// pasando el httpStatus por metadata.
const SHARED_EXCEPTION_BY_HTTP = {
  400: 'BadRequestException',
  401: 'UnauthorizedException',
  403: 'ForbiddenException',
  404: 'NotFoundException',
  409: 'ConflictException',
  413: 'PayloadTooLargeException',
  422: 'BusinessException'
};

export function sharedExceptionFor(http) {
  return SHARED_EXCEPTION_BY_HTTP[http] ?? 'DomainException';
}

// Un parámetro de despliegue es un escalar: lo que necesita estructura es diseño.
const PARAM_JAVA_TYPES = {
  string: 'String',
  int: 'Integer',
  long: 'Long',
  decimal: 'BigDecimal',
  boolean: 'Boolean'
};

/**
 * Cómo se crea un uuid que genera el servidor: el helper de la versión 7 (scaffold/ids.js), no
 * `UUID.randomUUID()`. Vive en la proyección porque es la forma Java del inicializador.
 */
export const UUID_V7_CALL = 'Uuids.v7()';

function fieldInitializer(field, java) {
  if (field.default !== undefined) {
    if (java.kind === 'enum' || field.type === 'enum') return `${java.javaType}.${screamingSnake(field.default)}`;
    if (java.javaType === 'String') return JSON.stringify(String(field.default));
    if (java.javaType === 'BigDecimal') return `new BigDecimal("${field.default}")`;
    return String(field.default);
  }
  if (field.generated) {
    if (java.base === 'uuid') return UUID_V7_CALL;
    if (java.base === 'timestamp') return 'Instant.now()';
  }
  return null;
}

/** Las propiedades de tipo de un campo: su tipo (envuelto en List si es colección) y sus imports. */
function typeProps(javaType, imports, list) {
  return list
    ? { javaType: `List<${javaType}>`, imports: [...imports, 'java.util.List'] }
    : { javaType, imports: [...imports] };
}

export const JAVA_PROJECTION = {
  /** Sufijo del proyecto generado: `services/<servicio>-spring`. */
  projectSuffix: 'spring',

  /** Lo que el servicio añade por ser Java: su paquete base. */
  service(manifest, stack) {
    return { basePackage: basePackage(manifest, stack?.group) };
  },

  /** El tipo de un parámetro de despliegue (`service.parameters`). */
  parameterType(type) {
    return { javaType: PARAM_JAVA_TYPES[type] ?? 'String' };
  },

  /** Tipo e imports de un campo resuelto; `list` lo envuelve en colección. */
  fieldType(resolved, { list = false } = {}) {
    const java = toJava(resolved);
    return typeProps(java.javaType, java.imports, list);
  },

  /** El tipo del ELEMENTO de un campo (el mismo que el del campo si no es colección). */
  elementType(resolved) {
    return { elementJavaType: toJava(resolved).javaType };
  },

  /** Tipo e imports de una clase generada por nombre (un DTO), con o sin colección. */
  namedType(name, { list = false } = {}) {
    return typeProps(name, [], list);
  },

  /** El tipo del elemento cuando es una clase generada por nombre. */
  namedElement(name) {
    return { elementJavaType: name };
  },

  /** Cambia el tipo de un campo a otra clase generada (la variante recortada de un DTO). */
  renamed(name) {
    return { javaType: name, elementJavaType: name };
  },

  /** El nombre de tipo con el que un campo ya proyectado se escribe. */
  typeNameOf(field) {
    return field?.javaType;
  },

  /** Las propiedades de tipo de un campo ya proyectado, para copiarlas a otra estructura. */
  carryType(field) {
    return { javaType: field.javaType };
  },

  /** Tipo de una subida binaria (un campo `file` en la ENTRADA de una operación). */
  uploadType() {
    return { javaType: 'FileUpload', elementJavaType: 'FileUpload', imports: [] };
  },

  /**
   * Validación de una subida. `@NotBlank` es de String: sobre un record component FileUpload
   * reventaría en runtime. Hay que corregir las DOS listas: el DTO de entrada se anota desde
   * `validation` y el command desde `inputValidation` (services.js), así que arreglar solo una
   * deja la anotación inválida en el otro lado.
   */
  uploadValidation(required) {
    return { validation: required ? ['@NotNull'] : [], inputValidation: required ? ['@NotNull'] : [] };
  },

  /** Clave de la réplica de una dependencia: su tipo y sus imports. */
  replicaKey(keyField) {
    return { keyFieldJavaType: keyField?.javaType ?? 'UUID', keyFieldImports: keyField?.imports ?? [] };
  },

  /** Excepción base que extiende el error de un `code` según su status. */
  errorBase(http) {
    return sharedExceptionFor(http);
  },

  /**
   * Validación, cotas, columnas e inicializador de un campo: todo lo que el renderizador escribe
   * como anotación o como expresión Java. El orden de las claves es el del campo.
   */
  fieldDetails(field, resolved, { fieldName, isList, persisted, collation }) {
    const java = toJava(resolved);
    return {
      validation: beanValidationAnnotations(field, java),
      // Escala y cotas del campo, que `validation` no puede llevar: la escala se NORMALIZA
      // (no se rechaza) y eso no es una anotación. Lo consume el constructor compacto del
      // value object, que es el único punto por el que pasa cualquier valor de ese tipo.
      numeric: numericConstraints(field, java),
      // La misma lista para un DTO de entrada: sin el formato heredado del value
      // type, que solo se cumple después de normalizar, y sin la anotación de
      // presencia de un campo con `default`, que por definición el cliente puede
      // omitir (ver type-mapper.js). Las dos diferencias son del lado de ENTRADA:
      // `validation` describe el valor ya formado y aquí se describe lo que llega
      // por el cable, que es antes de que el dominio ponga nada.
      inputValidation: beanValidationAnnotations(field, java, { inheritTypeFormat: false, honourDefault: true }),
      // El formato que el campo hereda de su value type ESCALAR y que la entrada deja
      // caer. Es lo que sostiene la clase `<Tipo>Format` del dominio y el gate que
      // comprueba que alguien la llama: sin este dato aquí, el único sitio donde vive
      // es la diferencia entre dos listas de anotaciones, que no es consultable.
      // La misma cota que `collectFormatTypes`, y tiene que serlo: este dato es el que
      // hace que la nota del command cite `<Tipo>Format` y que el gate exija una llamada.
      // Si los dos lados no coincidieran, la nota mandaría a una clase que no se generó.
      inheritedPattern: inheritedFormat(field, resolved),
      // Una colección no es una columna: su mapeo (@ElementCollection) lo pone la Jpa,
      // no columnAnnotations. Sin persistence o sin list, comportamiento previo.
      columns: persisted && !isList ? columnAnnotations(fieldName, field, java, { collation }) : [],
      // Pero cada ELEMENTO de esa colección sí es una columna: vive en la tabla hija
      // que genera @CollectionTable, y ahí es donde tienen que aterrizar las
      // constraints de su value type. Sin esto, un `EmailAddress` con maxLength 254
      // sale `varchar(255)` dentro de la lista mientras el mismo tipo, usado suelto,
      // sale `varchar(254)`: la única cota que llega al DDL se pierde justo en la
      // tabla que crece. El elemento compuesto no entra aquí — su espejo @Embeddable
      // pone sus propias columnas (embeddables.js).
      //
      // El `field` va vacío a propósito: `required`, `id` y `unique` son de la LISTA,
      // no de sus elementos, y sus constraints son de cardinalidad (maxItems).
      elementColumns: persisted && isList && java.kind !== 'composite' ? columnAnnotations(fieldName, {}, java) : [],
      initializer: fieldInitializer(field, java)
    };
  },

  /** Textos que nombran el framework: el modelo los emite como aviso, la proyección los redacta. */
  messages: {
    lockVersionReserved: (entity) =>
      `Entidad ${entity}: el diseño declara el campo lockVersion, nombre que build reserva para el @Version de JPA (concurrencia optimista). Se anota el declarado en vez de generar uno propio; renombra el campo del diseño si su semántica es de negocio.`,
    readQueriesRef: (persistenceKind) =>
      persistenceKind === 'document'
        ? 'skills/keel-spring-mongodb/references/read-queries.md'
        : 'skills/keel-spring-database/references/read-queries.md',
    pathParamFallback: (opName, path, name) =>
      `Operación '${opName}': la ruta ${path} declara {${name}} pero el input no tiene ese campo; se expone como @PathVariable UUID ${name}. Declara el campo en use-cases.keel.yaml o renombra el segmento.`,
    cognitoEmulated: () =>
      'stack auth: cognito — en local se emula el CONTRATO del token (un servidor OAuth2 que emite la forma de Cognito: cognito:groups, scopes prefijados por el resource server y tokens de máquina SIN aud), no Amazon Cognito. Eso permite ejercitar el diseño entero, superficie M2M incluida, que ningún emulador libre de la API de Cognito cubre. Lo que NO queda probado ahí: que el proveedor autentique de verdad (el emulador no valida contraseñas) y el alta de user pool, grupos y usuarios. Las dos se verifican contra Cognito real siguiendo la skill keel-spring-cognito.'
  }
};
