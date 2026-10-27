// La PROYECCIÓN C# del modelo (contrato: keel-core/src/lib/gen/projection.js).
//
// `buildModel` interpreta el diseño sin saber en qué lenguaje se escribirá y, cada vez que nace un campo,
// pregunta aquí cómo se escribe en C#. La interpretación es la MISMA que usan keel-spring y keel-nest: de
// esto depende que los tres servidores del mismo diseño sean equivalentes.
//
// Estado (incremento 2 de PLAN-KEEL-DOTNET.md): la proyección de TIPOS completa —el modelo de cualquier
// diseño se construye—, con las cotas, las reglas de validación y las columnas como DATOS de keel-core/gen
// (lo mismo que keel-nest). Los renderizadores que las escriben llegan con el dominio (incremento 4).
//
// Las propiedades que esta proyección pone en cada campo son de keel-dotnet: `csType`, `usings` (los
// namespaces del framework que el tipo necesita) y `elementCsType`. El modelo nunca las nombra.

import { pascalCase, numericConstraints, inheritedFormat, textConstraints, validationRules, elementValidationRules, columnSpec } from '@keel-system/keel-core/gen';
import { errorBaseFor } from '@keel-system/keel-core/gen/error-bases';

const BASE_CS_TYPES = {
  string: { csType: 'string', usings: [] },
  text: { csType: 'string', usings: [] },
  int: { csType: 'int', usings: [] },
  // 64 bits con signo: el `long` del DSL cabe entero (el contrato del cable lo escribe como número).
  long: { csType: 'long', usings: [] },
  // El `decimal` de .NET es decimal de verdad y CONSERVA la escala (2.50m no es 2.5m al escribirlo), que es
  // contrato del cable. Nunca `double`.
  decimal: { csType: 'decimal', usings: [] },
  boolean: { csType: 'bool', usings: [] },
  uuid: { csType: 'Guid', usings: [] },
  // Fecha sin hora (ISO `YYYY-MM-DD`): DateOnly no arrastra zona ni hora.
  date: { csType: 'DateOnly', usings: [] },
  // Un instante: con su desplazamiento, que el contrato del cable escribe en UTC con `Z`.
  timestamp: { csType: 'DateTimeOffset', usings: [] },
  // Viaja embebido (contrato del cable, json-embedded): un árbol JSON, no un string.
  json: { csType: 'JsonElement', usings: ['System.Text.Json'] },
  file: { csType: 'string', usings: [] }
};

const PARAM_CS_TYPES = { string: 'string', int: 'int', long: 'long', decimal: 'decimal', boolean: 'bool' };

/**
 * El miembro C# de un valor de enum del diseño: `in-review` → `InReview`. Lo que viaja es el valor, que
 * el enum declara con [JsonStringEnumMemberName]; el miembro solo tiene que ser un identificador válido.
 */
export function enumMember(literal) {
  const member = pascalCase(String(literal));
  return /^[A-Za-z_]/.test(member) ? member : `V${member}`;
}

/** Cómo se crea un uuid que genera el servidor: versión 7 (ordenado por tiempo), como los otros dos. */
export const UUID_V7_CALL = 'Guid.CreateVersion7()';
/** El id `long` que genera la aplicación (keel-core/gen/ids.js), gemelo del `LongIds.next()` de keel-spring y keel-nest. */
export const LONG_ID_CALL = 'LongIds.Next()';

function toCs(resolved) {
  if (resolved.kind === 'enum' || resolved.kind === 'composite') {
    return { kind: resolved.kind, csType: resolved.name, usings: [] };
  }
  const base = BASE_CS_TYPES[resolved.base] ?? BASE_CS_TYPES.string;
  return { kind: resolved.kind, base: resolved.base, csType: base.csType, usings: [...base.usings] };
}

function typeProps(csType, usings, list) {
  return list ? { csType: `IReadOnlyList<${csType}>`, usings: [...usings] } : { csType, usings: [...usings] };
}

/** Un literal C# del default declarado, o la expresión que genera el valor; null si no hay ninguno. */
function initializer(field, cs) {
  if (field.default !== undefined) {
    if (cs.kind === 'enum' || field.type === 'enum') return `${cs.csType}.${enumMember(field.default)}`;
    if (cs.csType === 'string') return JSON.stringify(String(field.default));
    // El sufijo `m` conserva la escala escrita: `2.50m` es 2.50, no 2.5.
    if (cs.csType === 'decimal') return `${field.default}m`;
    if (cs.csType === 'long') return `${field.default}L`;
    if (cs.csType === 'bool') return String(Boolean(field.default));
    return String(field.default);
  }
  if (field.generated) {
    if (cs.base === 'uuid') return UUID_V7_CALL;
    if (cs.base === 'long' && field.id) return LONG_ID_CALL;
    if (cs.base === 'timestamp') return 'DateTimeOffset.UtcNow';
  }
  return null;
}

export const CS_PROJECTION = {
  projectSuffix: 'dotnet',

  // El namespace raíz del servicio: `product-catalog` → `ProductCatalog`. Los proyectos de la solución
  // cuelgan de él (`ProductCatalog.Domain`, `ProductCatalog.Api`…).
  service(manifest) {
    return { rootNamespace: pascalCase(manifest?.service?.name ?? 'service') };
  },

  parameterType(type) {
    return { csType: PARAM_CS_TYPES[type] ?? 'string' };
  },

  fieldType(resolved, { list = false } = {}) {
    const cs = toCs(resolved);
    return typeProps(cs.csType, cs.usings, list);
  },

  elementType(resolved) {
    return { elementCsType: toCs(resolved).csType };
  },

  namedType(name, { list = false } = {}) {
    return typeProps(name, [], list);
  },

  namedElement(name) {
    return { elementCsType: name };
  },

  renamed(name) {
    return { csType: name, elementCsType: name };
  },

  typeNameOf(field) {
    return field?.csType;
  },

  carryType(field) {
    return { csType: field.csType };
  },

  uploadType() {
    return { csType: 'FileUpload', elementCsType: 'FileUpload', usings: [] };
  },

  uploadValidation(required) {
    const rules = required ? [{ rule: 'notNull' }] : [];
    return { validation: rules, inputValidation: rules };
  },

  replicaKey(keyField) {
    return { keyFieldCsType: keyField?.csType ?? 'string', keyFieldUsings: keyField?.usings ?? [] };
  },

  errorBase(http) {
    return errorBaseFor(http);
  },

  fieldDetails(field, resolved, { fieldName, isList, persisted, collation } = {}) {
    const cs = toCs(resolved);
    return {
      // Las reglas de validación como DATOS (keel-core/gen/constraints.js): las mismas que keel-spring
      // escribe como Bean Validation y keel-nest como su lector de peticiones.
      validation: validationRules(field, resolved),
      numeric: numericConstraints(field, resolved),
      inputValidation: validationRules(field, resolved, { input: true, honourDefault: true }),
      elementInputValidation: elementValidationRules(field, resolved),
      inheritedPattern: inheritedFormat(field, resolved),
      text: textConstraints(field, resolved),
      // La columna como DATO (keel-core/gen/relational.js): lo que el mapeo de EF Core escribirá.
      columns: persisted && !isList ? columnSpec(fieldName, field, resolved, { collation }) : null,
      elementColumns: persisted && isList && resolved.kind !== 'composite' ? columnSpec(fieldName, {}, resolved) : null,
      initializer: initializer(field, cs)
    };
  },

  messages: {
    lockVersionReserved: (entity) =>
      `Entidad ${entity}: el diseño declara el campo lockVersion, nombre que build reserva para el token de concurrencia de EF Core (bloqueo optimista). Se usa el declarado en vez de generar uno propio; renombra el campo del diseño si su semántica es de negocio.`,
    readQueriesRef: (persistenceKind) =>
      persistenceKind === 'document'
        ? 'skills/keel-dotnet-mongodb/references/read-queries.md'
        : 'skills/keel-dotnet-database/references/read-queries.md',
    pathParamFallback: (opName, path, name) =>
      `Operación '${opName}': la ruta ${path} declara {${name}} pero el input no tiene ese campo; se expone como parámetro de ruta '${name}' de tipo uuid. Declara el campo en use-cases.keel.yaml o renombra el segmento.`,
    cognitoEmulated: () =>
      'stack auth: cognito — en local se emula el CONTRATO del token (un servidor OAuth2 que emite la forma de Cognito: cognito:groups, scopes prefijados por el resource server y tokens de máquina SIN aud), no Amazon Cognito. Lo que NO queda probado ahí: que el proveedor autentique de verdad y el alta de user pool, grupos y usuarios; las dos se verifican contra Cognito real.'
  }
};
