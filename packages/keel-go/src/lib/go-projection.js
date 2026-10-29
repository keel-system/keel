// La PROYECCIÓN Go del modelo (contrato: keel-core/src/lib/gen/projection.js).
//
// `buildModel` interpreta el diseño sin saber en qué lenguaje se escribirá y, cada vez que nace un campo,
// pregunta aquí cómo se escribe en Go. La interpretación es la MISMA que usan keel-spring, keel-nest y
// keel-dotnet: de esto depende que los cuatro servidores del mismo diseño sean equivalentes.
//
// Estado (incremento 2 de PLAN-KEEL-GO.md): la proyección de TIPOS completa —el modelo de cualquier diseño
// se construye—, con las cotas, las reglas de validación y las columnas como DATOS de keel-core/gen. Los
// renderizadores que las escriben llegan con el dominio (incremento 4); `Decimal`, `Date` y `Optional[T]`
// los emite el contrato del cable (src/scaffold/wire.js).
//
// Las propiedades que esta proyección pone en cada campo son de keel-go: `goType`, `goImports` (rutas de
// importación; las del propio módulo empiezan por `internal/` y el renderizador les antepone el módulo) y
// `elementGoType`. El modelo nunca las nombra.
//
// Los NOMBRES siguen la regla de Go (PLAN-KEEL-GO.md § 3.1): MixedCaps y las siglas en un solo caso
// (`customerId` → `CustomerID`, `imageUrls` → `ImageURLs`). El nombre del cable no cambia: va en el tag
// `json:"customerId"`. La tabla de siglas es la de staticcheck (ST1003), la que ve el lint del proyecto.

import { numericConstraints, inheritedFormat, textConstraints, validationRules, elementValidationRules, columnSpec } from '@keel-system/keel-core/gen';
import { errorBaseFor } from '@keel-system/keel-core/gen/error-bases';

/** Las siglas que Go escribe en un solo caso: la lista por defecto de staticcheck (ST1003). */
export const INITIALISMS = [
  'ACL', 'AMQP', 'API', 'ASCII', 'CPU', 'CSS', 'DB', 'DNS', 'EOF', 'GID', 'GUID', 'HTML', 'HTTP', 'HTTPS', 'ID', 'IP',
  'JSON', 'QPS', 'RAM', 'RPC', 'RTP', 'SIP', 'SLA', 'SMTP', 'SQL', 'SSH', 'TCP', 'TLS', 'TS', 'TTL', 'UDP', 'UI', 'UID',
  'URI', 'URL', 'UTF8', 'UUID', 'VM', 'XML', 'XMPP', 'XSRF', 'XSS'
];
const INITIALISM_SET = new Set(INITIALISMS);

/** Las palabras reservadas de Go: un identificador no exportado no puede llamarse así. */
export const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto',
  'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'
]);

// Las sustituciones habituales en Go para un nombre reservado; el resto gana un sufijo que lo dice.
const KEYWORD_RENAMES = { type: 'typ', func: 'fn', package: 'pkg', default: 'def', range: 'rng' };

function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Una palabra en MixedCaps: la sigla entera en mayúsculas (también en plural: `ids` → `IDs`). */
function capitalized(word) {
  const upper = word.toUpperCase();
  if (INITIALISM_SET.has(upper)) return upper;
  if (/s$/i.test(word) && INITIALISM_SET.has(upper.slice(0, -1))) return `${upper.slice(0, -1)}s`;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** Un identificador EXPORTADO: `customer-id` y `customerId` → `CustomerID`. */
export function goExported(name) {
  const result = words(name).map(capitalized).join('');
  return /^[0-9]/.test(result) ? `V${result}` : result;
}

/**
 * Un identificador NO exportado: `customerId` → `customerID`, `id` → `id`, `URLs` → `urls`. Si choca con una
 * palabra reservada (`type`), toma la forma habitual en Go (`typ`).
 */
export function goUnexported(name) {
  const [first, ...rest] = words(name);
  if (!first) return '';
  const head = INITIALISM_SET.has(first.toUpperCase()) || /s$/i.test(first) && INITIALISM_SET.has(first.slice(0, -1).toUpperCase())
    ? first.toLowerCase()
    : first[0].toLowerCase() + first.slice(1).toLowerCase();
  const result = head + rest.map(capitalized).join('');
  if (GO_KEYWORDS.has(result)) return KEYWORD_RENAMES[result] ?? `${result}Value`;
  return /^[0-9]/.test(result) ? `v${result}` : result;
}

/** El nombre de un paquete Go: minúsculas, sin separadores (`product-catalog` → `productcatalog`). */
export function goPackageName(name) {
  return words(name).join('').toLowerCase();
}

/** La constante de un valor de enum: `OrderStatus` + `in-review` → `OrderStatusInReview`. */
export function enumConstant(enumType, literal) {
  return `${enumType}${goExported(String(literal))}`;
}

// Las rutas de los paquetes propios que nombra un tipo. Se escriben relativas al módulo: el renderizador
// antepone la ruta del módulo del servicio (PLAN-KEEL-GO.md § 2).
export const WIRE_PACKAGE = 'internal/platform/wire';
export const UUID_MODULE = 'github.com/google/uuid';

const BASE_GO_TYPES = {
  string: { goType: 'string', goImports: [] },
  text: { goType: 'string', goImports: [] },
  // El `int` del DSL es de 32 bits con signo, como el de Java y C#: un valor fuera de rango es un 400 en los
  // otros tres, y con el `int` de 64 bits de Go sería un dato aceptado. El tipo lo hace cumplir al leer.
  int: { goType: 'int32', goImports: [] },
  long: { goType: 'int64', goImports: [] },
  // Nunca `float64` para un decimal: es binario y no representa exactamente los decimales. `wire.Decimal`
  // conserva la escala, que es contrato del cable (el tipo concreto lo decide el incremento 3).
  decimal: { goType: 'wire.Decimal', goImports: [WIRE_PACKAGE] },
  boolean: { goType: 'bool', goImports: [] },
  // uuid.UUID es un [16]byte en big-endian: el binary(16) de MySQL sale igual que en keel-spring.
  uuid: { goType: 'uuid.UUID', goImports: [UUID_MODULE] },
  // Fecha sin hora (ISO `YYYY-MM-DD`): Go no tiene un tipo civil, y time.Time arrastra hora y zona.
  date: { goType: 'wire.Date', goImports: [WIRE_PACKAGE] },
  // Un instante: el contrato del cable lo escribe en UTC con `Z` y tres decimales.
  timestamp: { goType: 'time.Time', goImports: ['time'] },
  // Viaja embebido (contrato del cable, json-embedded): el valor JSON tal cual, no un string. Es el tipo de
  // encoding/json/v2, con el que el paquete wire lee y escribe todo cuerpo.
  json: { goType: 'jsontext.Value', goImports: ['encoding/json/jsontext'] },
  file: { goType: 'string', goImports: [] }
};

const PARAM_GO_TYPES = { string: 'string', int: 'int32', long: 'int64', decimal: 'wire.Decimal', boolean: 'bool' };

/**
 * Cómo se crea un uuid que genera el servidor: versión 7 (ordenado por tiempo), como los otros tres.
 * `uuid.Must` solo entra en pánico si falla crypto/rand, que desde Go 1.24 no devuelve error: es un
 * invariante imposible, no un error que el llamante pueda tratar (PLAN-KEEL-GO.md § 3.2).
 */
export const UUID_V7_CALL = 'uuid.Must(uuid.NewV7())';
/** El id `long` que genera la aplicación (keel-core/gen/ids.js), gemelo de `LongIds.next()` en los otros tres. */
export const LONG_ID_CALL = 'NextLongID()';

function toGo(resolved) {
  if (resolved.kind === 'enum' || resolved.kind === 'composite') {
    return { kind: resolved.kind, goType: resolved.name, goImports: [] };
  }
  const base = BASE_GO_TYPES[resolved.base] ?? BASE_GO_TYPES.string;
  return { kind: resolved.kind, base: resolved.base, goType: base.goType, goImports: [...base.goImports] };
}

function typeProps(goType, goImports, list) {
  return list ? { goType: `[]${goType}`, goImports: [...goImports] } : { goType, goImports: [...goImports] };
}

/** Un literal Go del default declarado, o la expresión que genera el valor; null si no hay ninguno. */
function initializer(field, go) {
  if (field.default !== undefined) {
    if (go.kind === 'enum' || field.type === 'enum') return enumConstant(go.goType, field.default);
    if (go.goType === 'string') return JSON.stringify(String(field.default));
    // El texto conserva la escala escrita: `2.50` es 2.50, no 2.5.
    if (go.goType === 'wire.Decimal') return `wire.MustDecimal(${JSON.stringify(String(field.default))})`;
    if (go.goType === 'bool') return String(Boolean(field.default));
    return String(field.default);
  }
  if (field.generated) {
    if (go.base === 'uuid') return UUID_V7_CALL;
    if (go.base === 'long' && field.id) return LONG_ID_CALL;
    if (go.base === 'timestamp') return 'time.Now().UTC()';
  }
  return null;
}

/**
 * El error de un `code` no hereda de nada: Go no tiene herencia. Lo que en los otros tres es la excepción
 * base de su status aquí es su CATEGORÍA (`domain.KindConflict`), con la que el borde HTTP elige el status
 * (`errors.As`). Los nombres salen de la misma jerarquía neutral (keel-core/gen/error-bases.js).
 */
export function errorKindFor(http) {
  const base = errorBaseFor(http);
  return `Kind${base.replace(/Exception$/, '')}`;
}

export const GO_PROJECTION = {
  projectSuffix: 'go',

  // La ruta del módulo del servicio es su nombre (`product-catalog`): un módulo que no se publica no
  // necesita dominio, y los paquetes propios cuelgan de él (`product-catalog/internal/domain`).
  service(manifest) {
    const name = manifest?.service?.name ?? 'service';
    return { goModule: name };
  },

  parameterType(type) {
    return { goType: PARAM_GO_TYPES[type] ?? 'string' };
  },

  fieldType(resolved, { list = false } = {}) {
    const go = toGo(resolved);
    return typeProps(go.goType, go.goImports, list);
  },

  elementType(resolved) {
    return { elementGoType: toGo(resolved).goType };
  },

  namedType(name, { list = false } = {}) {
    return typeProps(name, [], list);
  },

  namedElement(name) {
    return { elementGoType: name };
  },

  renamed(name) {
    return { goType: name, elementGoType: name };
  },

  typeNameOf(field) {
    return field?.goType;
  },

  carryType(field) {
    return { goType: field.goType };
  },

  uploadType() {
    return { goType: 'FileUpload', elementGoType: 'FileUpload', goImports: [] };
  },

  uploadValidation(required) {
    const rules = required ? [{ rule: 'notNull' }] : [];
    return { validation: rules, inputValidation: rules };
  },

  replicaKey(keyField) {
    return { keyFieldGoType: keyField?.goType ?? 'string', keyFieldGoImports: keyField?.goImports ?? [] };
  },

  errorBase(http) {
    return errorKindFor(http);
  },

  fieldDetails(field, resolved, { fieldName, isList, persisted, collation } = {}) {
    const go = toGo(resolved);
    return {
      // Las reglas de validación como DATOS (keel-core/gen/constraints.js): las mismas que keel-spring escribe
      // como Bean Validation y keel-nest y keel-dotnet como su lector de peticiones. Aquí también las aplica un
      // lector generado por operación, sin reflexión de tags.
      validation: validationRules(field, resolved),
      numeric: numericConstraints(field, resolved),
      inputValidation: validationRules(field, resolved, { input: true, honourDefault: true }),
      elementInputValidation: elementValidationRules(field, resolved),
      inheritedPattern: inheritedFormat(field, resolved),
      text: textConstraints(field, resolved),
      // La columna como DATO (keel-core/gen/relational.js): lo que el SQL emitido escribirá.
      columns: persisted && !isList ? columnSpec(fieldName, field, resolved, { collation }) : null,
      elementColumns: persisted && isList && resolved.kind !== 'composite' ? columnSpec(fieldName, {}, resolved) : null,
      initializer: initializer(field, go)
    };
  },

  messages: {
    lockVersionReserved: (entity) =>
      `Entidad ${entity}: el diseño declara el campo lockVersion, nombre que build reserva para la versión del bloqueo optimista (UPDATE … WHERE version = ?). Se usa el declarado en vez de generar uno propio; renombra el campo del diseño si su semántica es de negocio.`,
    readQueriesRef: (persistenceKind) =>
      persistenceKind === 'document'
        ? 'skills/keel-go-mongodb/references/read-queries.md'
        : 'skills/keel-go-database/references/read-queries.md',
    pathParamFallback: (opName, path, name) =>
      `Operación '${opName}': la ruta ${path} declara {${name}} pero el input no tiene ese campo; se expone como parámetro de ruta '${name}' (r.PathValue) de tipo uuid. Declara el campo en use-cases.keel.yaml o renombra el segmento.`,
    cognitoEmulated: () =>
      'stack auth: cognito — en local se emula el CONTRATO del token (un servidor OAuth2 que emite la forma de Cognito: cognito:groups, scopes prefijados por el resource server y tokens de máquina SIN aud), no Amazon Cognito. Lo que NO queda probado ahí: que el proveedor autentique de verdad y el alta de user pool, grupos y usuarios; las dos se verifican contra Cognito real.'
  }
};
