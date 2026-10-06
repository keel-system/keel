// La PROYECCIÓN TypeScript del modelo (contrato: keel-core/src/lib/gen/projection.js).
//
// `buildModel` interpreta el diseño sin saber en qué lenguaje se escribirá y, cada vez que nace
// un campo, pregunta aquí cómo se escribe en TypeScript. La interpretación es la MISMA que usa
// keel-spring: de esto depende que los dos servidores del mismo diseño sean equivalentes.
//
// Estado (incremento 6 de PLAN-KEEL-NEST.md): proyección de TIPOS completa —el modelo de
// cualquier diseño se construye—, COTAS del dominio y COLUMNAS, las mismas que keel-spring, desde
// keel-core/gen (constraints.js y relational.js). La columna es un DATO (`columnSpec`): el
// renderizador de TypeORM decide el tipo físico de cada motor. La forma del cable de cada tipo la
// fija keel-core/gen/wire.js y la cumplen `Decimal`, `RawJson` y application/support/wire.ts.
//
// Las propiedades que esta proyección pone en cada campo son de keel-nest: `tsType`, `imports`
// (`{ symbol, from }`, con `from` relativo a la raíz del proyecto cuando es un módulo propio),
// `elementTsType` y `text` (formato y longitud del campo, que son las guardas de un value object).
// El modelo nunca las nombra.

import { screamingSnake, numericConstraints, inheritedFormat, textConstraints, validationRules, columnSpec } from 'keel-core/gen';

const BASE_TS_TYPES = {
  string: { tsType: 'string', imports: [] },
  text: { tsType: 'string', imports: [] },
  int: { tsType: 'number', imports: [] },
  // Un `long` no cabe en un number sin perder precisión por encima de 2^53.
  long: { tsType: 'bigint', imports: [] },
  // Nunca `number` para un decimal: es binario y no representa exactamente los decimales. El
  // `Decimal` del proyecto (domain/support) conserva la escala, que es contrato del cable.
  decimal: { tsType: 'Decimal', imports: [{ symbol: 'Decimal', from: 'src/domain/support/decimal.js' }] },
  boolean: { tsType: 'boolean', imports: [] },
  uuid: { tsType: 'string', imports: [] },
  // Fecha sin hora (ISO `YYYY-MM-DD`): TypeScript no tiene un tipo propio que no arrastre una zona.
  date: { tsType: 'string', imports: [] },
  timestamp: { tsType: 'Date', imports: [] },
  // Viaja embebido (contrato del cable, json-embedded): no es un string cualquiera.
  json: { tsType: 'RawJson', imports: [{ symbol: 'RawJson', from: 'src/domain/support/raw-json.js' }] },
  file: { tsType: 'string', imports: [] }
};

const PARAM_TS_TYPES = { string: 'string', int: 'number', long: 'bigint', decimal: 'Decimal', boolean: 'boolean' };

// Las mismas clases base por status que keel-spring: los nombres de la jerarquía de errores son
// parte de la arquitectura compartida, no del framework (el dominio no importa @nestjs/common).
const ERROR_BASE_BY_HTTP = {
  400: 'BadRequestException',
  401: 'UnauthorizedException',
  403: 'ForbiddenException',
  404: 'NotFoundException',
  409: 'ConflictException',
  413: 'PayloadTooLargeException',
  422: 'BusinessException'
};

/** Cómo se crea un uuid que genera el servidor: versión 7, igual que keel-spring. */
export const UUID_V7_CALL = 'Uuids.v7()';

function toTs(resolved) {
  if (resolved.kind === 'enum' || resolved.kind === 'composite') {
    return { kind: resolved.kind, tsType: resolved.name, imports: [] };
  }
  const base = BASE_TS_TYPES[resolved.base] ?? BASE_TS_TYPES.string;
  return { kind: resolved.kind, base: resolved.base, tsType: base.tsType, imports: base.imports.map((imp) => ({ ...imp })) };
}

function typeProps(tsType, imports, list) {
  return list ? { tsType: `${tsType}[]`, imports: [...imports] } : { tsType, imports: [...imports] };
}

function initializer(field, ts) {
  if (field.default !== undefined) {
    if (ts.kind === 'enum' || field.type === 'enum') return `${ts.tsType}.${screamingSnake(field.default)}`;
    if (ts.tsType === 'string') return JSON.stringify(String(field.default));
    if (ts.tsType === 'Decimal') return `Decimal.parse(${JSON.stringify(String(field.default))})`;
    if (ts.tsType === 'bigint') return `${field.default}n`;
    return String(field.default);
  }
  if (field.generated) {
    if (ts.base === 'uuid') return UUID_V7_CALL;
    if (ts.base === 'timestamp') return 'new Date()';
  }
  return null;
}

export const TS_PROJECTION = {
  projectSuffix: 'nest',

  // TypeScript no tiene paquete base: los módulos se resuelven por ruta relativa.
  service() {
    return {};
  },

  parameterType(type) {
    return { tsType: PARAM_TS_TYPES[type] ?? 'string' };
  },

  fieldType(resolved, { list = false } = {}) {
    const ts = toTs(resolved);
    return typeProps(ts.tsType, ts.imports, list);
  },

  elementType(resolved) {
    return { elementTsType: toTs(resolved).tsType };
  },

  namedType(name, { list = false } = {}) {
    return typeProps(name, [], list);
  },

  namedElement(name) {
    return { elementTsType: name };
  },

  renamed(name) {
    return { tsType: name, elementTsType: name };
  },

  typeNameOf(field) {
    return field?.tsType;
  },

  carryType(field) {
    return { tsType: field.tsType };
  },

  uploadType() {
    return { tsType: 'FileUpload', elementTsType: 'FileUpload', imports: [] };
  },

  uploadValidation(required) {
    const rules = required ? [{ rule: 'notNull' }] : [];
    return { validation: rules, inputValidation: rules };
  },

  replicaKey(keyField) {
    return { keyFieldTsType: keyField?.tsType ?? 'string', keyFieldImports: keyField?.imports ?? [] };
  },

  errorBase(http) {
    return ERROR_BASE_BY_HTTP[http] ?? 'DomainException';
  },

  fieldDetails(field, resolved, { fieldName, isList, persisted, collation } = {}) {
    const ts = toTs(resolved);
    return {
      // Las reglas de validación como DATOS (keel-core/gen/constraints.js): las mismas que keel-spring
      // escribe como Bean Validation. Las de entrada las aplica el lector de cada petición
      // (infrastructure/rest), sin class-validator: no vería los tipos del cable.
      validation: validationRules(field, resolved),
      // Escala y cotas numéricas: las hace cumplir el constructor del value object, que es el único
      // punto por el que pasa cualquier valor de ese tipo. La misma decisión que keel-spring.
      numeric: numericConstraints(field, resolved),
      inputValidation: validationRules(field, resolved, { inheritTypeFormat: false, honourDefault: true }),
      // El formato heredado de un value type ESCALAR: sostiene la clase `<Tipo>Format` del dominio,
      // la nota del mensaje y el gate check-domain-guards.sh.
      inheritedPattern: inheritedFormat(field, resolved),
      // Formato y longitud del campo con la mezcla tipo → campo: lo que un value object COMPUESTO
      // comprueba en su constructor. En Java vive en las anotaciones de `validation`; aquí, como dato.
      text: textConstraints(field, resolved),
      // La columna del campo como DATO (keel-core/gen/relational.js): nombre, nulabilidad y cotas, lo
      // mismo que keel-spring escribe como @Column. Una lista no es una columna: es su tabla de
      // elementos, y la columna de cada ELEMENTO va en `elementColumns` (sin `required`/`id`, que son
      // de la lista). El elemento compuesto no: sus columnas son las de su value object.
      columns: persisted && !isList ? columnSpec(fieldName, field, resolved, { collation }) : null,
      elementColumns: persisted && isList && resolved.kind !== 'composite' ? columnSpec(fieldName, {}, resolved) : null,
      initializer: initializer(field, ts)
    };
  },

  messages: {
    lockVersionReserved: (entity) =>
      `Entidad ${entity}: el diseño declara el campo lockVersion, nombre que build reserva para el @VersionColumn de TypeORM (concurrencia optimista). Se anota el declarado en vez de generar uno propio; renombra el campo del diseño si su semántica es de negocio.`,
    readQueriesRef: (persistenceKind) =>
      persistenceKind === 'document'
        ? 'skills/keel-nest-mongodb/references/read-queries.md'
        : 'skills/keel-nest-database/references/read-queries.md',
    pathParamFallback: (opName, path, name) =>
      `Operación '${opName}': la ruta ${path} declara {${name}} pero el input no tiene ese campo; se expone como @Param('${name}') de tipo uuid. Declara el campo en use-cases.keel.yaml o renombra el segmento.`,
    cognitoEmulated: () =>
      'stack auth: cognito — en local se emula el CONTRATO del token (un servidor OAuth2 que emite la forma de Cognito: cognito:groups, scopes prefijados por el resource server y tokens de máquina SIN aud), no Amazon Cognito. Eso permite ejercitar el diseño entero, superficie M2M incluida, que ningún emulador libre de la API de Cognito cubre. Lo que NO queda probado ahí: que el proveedor autentique de verdad (el emulador no valida contraseñas) y el alta de user pool, grupos y usuarios. Las dos se verifican contra Cognito real siguiendo la skill keel-nest-cognito.'
  }
};
