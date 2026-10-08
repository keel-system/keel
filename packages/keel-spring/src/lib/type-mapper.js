// Mapeo de tipos del DSL keel a Java (ver conventions/mapping.md, sección "Tipos base").
// Los value types escalares se aplanan a su tipo base; sus constraints se propagan
// a Bean Validation y a la columna.

import { snakeCase } from './naming.js';
import { quoteIdentifier } from './sql-reserved.js';
import { resolveType as resolveDslType, isBaseType as isDslBaseType } from 'keel-core/gen/types';
import { validationRules, DECIMAL_PRECISION } from 'keel-core/gen/constraints';
import { columnSpec } from 'keel-core/gen/relational';

const BASE_TYPES = {
  string: { javaType: 'String', imports: [] },
  text: { javaType: 'String', imports: [] },
  int: { javaType: 'Integer', imports: [] },
  long: { javaType: 'Long', imports: [] },
  decimal: { javaType: 'BigDecimal', imports: ['java.math.BigDecimal'] },
  boolean: { javaType: 'Boolean', imports: [] },
  uuid: { javaType: 'UUID', imports: ['java.util.UUID'] },
  date: { javaType: 'LocalDate', imports: ['java.time.LocalDate'] },
  timestamp: { javaType: 'Instant', imports: ['java.time.Instant'] },
  json: { javaType: 'String', imports: [] },
  // Un archivo se representa por la clave/referencia del objeto en su bucket (String);
  // la subida/descarga y las URLs firmadas las resuelve el adaptador de storage.
  file: { javaType: 'String', imports: [] }
};

/**
 * ¿Este nombre de tipo es un primitivo del DSL, y no un value type declarado?
 *
 * La diferencia importa cuando se quiere ATAR dos sitios que hablan del mismo dato:
 * dos campos `string` no tienen nada que ver entre sí, pero dos campos `EmailAddress`
 * sí — el diseño les puso nombre justamente para decirlo.
 */
export function isBaseType(typeName) {
  return isDslBaseType(typeName);
}

/**
 * Resuelve una referencia de tipo del diseño (tipo base, value type declarado en
 * domain.types, o nombre de clase generada) a su representación Java.
 * Devuelve { kind, javaType, imports, base?, constraints? }:
 * - kind 'base'       → tipo base del DSL.
 * - kind 'scalar-vt'  → value type escalar, aplanado a su base.
 * - kind 'enum'       → enum nominal (clase generada en domain).
 * - kind 'composite'  → value object compuesto (clase generada en domain).
 */
export function resolveType(typeRef, domainTypes = {}) {
  return toJava(resolveDslType(typeRef, domainTypes));
}

/**
 * La representación Java de un tipo ya resuelto por keel-core/gen/types: el tipo y sus imports.
 * La pregunta de QUÉ tipo es la responde keel-core, igual para cualquier generador; aquí solo se
 * dice cómo se escribe en Java. Un value type sobre una base que el DSL no conoce cae en String.
 */
export function toJava(resolved) {
  if (resolved.kind === 'enum' || resolved.kind === 'composite') {
    return { kind: resolved.kind, javaType: resolved.name, imports: [], constraints: resolved.constraints };
  }
  const base = BASE_TYPES[resolved.base] ?? BASE_TYPES.string;
  return {
    kind: resolved.kind,
    base: resolved.base,
    javaType: base.javaType,
    imports: [...base.imports],
    constraints: resolved.constraints
  };
}

/**
 * Anotaciones Bean Validation para un campo de DTO de entrada.
 * Combina las constraints del campo con las del value type escalar (aplanado).
 *
 * `honourDefault: true` (lo pasa el lado de ENTRADA) deja fuera la anotación de
 * PRESENCIA de un campo que declara `default`. No es una relajación del contrato:
 * el DSL define `default` como «valor si el cliente no lo provee»
 * (docs/dsl/domain.md), así que un campo con default es, por definición, omitible
 * en el cable — y exigirlo rechaza con 400 justo el caso para el que el default
 * existe. Con `required: true` **y** `default`, las dos cosas siguen siendo
 * ciertas y no se contradicen: obligatorio es el VALOR (la columna es
 * `nullable = false`, y eso lo pone `columnAnnotations`, que no mira aquí),
 * opcional es que lo mande el cliente.
 *
 * Se descubrió generando `createProduct` sobre un agregado cuyo `status` declara
 * `default: draft`: el DTO salía con `@NotNull` y el camino feliz de la operación
 * —ningún cliente manda el estado inicial de un recurso que aún no existe—
 * devolvía 400 antes de llegar al handler. El resto de anotaciones (formato,
 * rango, tamaño) no se toca: si el cliente SÍ manda el campo, tiene que ser válido.
 */
export function beanValidationAnnotations(field, resolved, { input = false, honourDefault = false } = {}) {
  // QUÉ se valida es una decisión del diseño y vive en keel-core/gen (validationRules), la misma
  // para keel-nest; aquí solo se escribe como Bean Validation.
  return validationRules(field, resolved, { input, honourDefault }).map(beanValidationAnnotation);
}

function beanValidationAnnotation(rule) {
  switch (rule.rule) {
    case 'notBlank':
      return '@NotBlank';
    case 'notNull':
      return '@NotNull';
    case 'notEmpty':
      return '@NotEmpty';
    case 'size': {
      const parts = [];
      if (rule.min != null) parts.push(`min = ${rule.min}`);
      if (rule.max != null) parts.push(`max = ${rule.max}`);
      return `@Size(${parts.join(', ')})`;
    }
    case 'pattern':
      return `@Pattern(regexp = "${escapeJava(rule.regexp)}")`;
    case 'min':
      return rule.decimal ? `@DecimalMin("${rule.value}")` : `@Min(${rule.value})`;
    case 'max':
      return rule.decimal ? `@DecimalMax("${rule.value}")` : `@Max(${rule.value})`;
    case 'digits':
      return `@Digits(integer = ${rule.integer}, fraction = ${rule.fraction})`;
    default:
      throw new Error(`Regla de validación sin traducción a Bean Validation: ${rule.rule}`);
  }
}

/** Precisión de toda columna decimal con escala (keel-core/gen): la misma que la de los dígitos de entrada. */
export { DECIMAL_PRECISION };

// Las cotas numéricas y el formato heredado son decisiones del DISEÑO: viven en keel-core/gen para
// que keel-spring y keel-nest hagan cumplir lo mismo (constraints.js).
export { numericConstraints, inheritedTypePattern } from 'keel-core/gen/constraints';

/**
 * Anotaciones JPA de columna para un campo de entidad persistida.
 * Devuelve una lista (puede incluir @Enumerated además de @Column).
 */
/**
 * @param {object} [opts]
 * @param {string|null} [opts.collation] Cláusula de collation con la que este motor hace la columna
 *   sensible a mayúsculas. Solo llega con valor cuando el campo participa en una constraint ÚNICA y
 *   el motor pliega por defecto (ver `caseSensitiveCollationFor` en stack-catalog.js). Va aquí y no
 *   en el renderizador porque `columnDefinition` SUSTITUYE al tipo entero de la columna: compuesto
 *   fuera, la `length` del diseño se quedaría fuera del DDL — el mismo defecto que ya costó un
 *   `numeric(38,2)` en vez de la escala declarada.
 */
export function columnAnnotations(fieldName, field, resolved, { collation = null } = {}) {
  // QUÉ lleva la columna (nombre, nulabilidad, cotas, collation) lo decide keel-core/gen
  // (`columnSpec`), el mismo dato que keel-nest escribe como decorador de TypeORM; aquí solo se
  // escribe como anotación JPA.
  const spec = columnSpec(fieldName, field, resolved, { collation });
  const annotations = [];
  const attrs = [`name = "${quoteIdentifier(spec.name)}"`];

  if (!spec.nullable) attrs.push('nullable = false');
  // NO se emite `unique = true` de columna, y no es un olvido. Toda columna única del
  // diseño ya recibe su `@UniqueConstraint` NOMBRADA en el `@Table` —`uk_<tabla>_natural`
  // para la clave natural, `uk_<tabla>_<campo>` para el resto (`renderTableAnnotation`)—, y
  // ese nombre es el contrato: `uniqueConstraints()` lo usa para traducir la violación al
  // `code` que el diseño declara. Con las dos, Hibernate emite además una constraint SIN
  // nombre, la base rechaza por esa, y `ApiExceptionHandler` —que mapea por nombre— ya no
  // reconoce el conflicto: un `409 CODE_ALREADY_EXISTS` degradado a error genérico, que es
  // justo el caso que más importa porque solo aparece en la carrera.
  if (!spec.updatable) attrs.push('updatable = false');

  // La collation se emite DENTRO del columnDefinition porque este sustituye al tipo: emitirla
  // junto a `length = N` dejaría la cota del diseño fuera del DDL y la columna saldría con el
  // ancho por defecto del dialecto. De ahí que las ramas con collation compongan el tipo entero.
  if (spec.long) {
    attrs.push(spec.collation ? `columnDefinition = "text collate ${spec.collation}"` : 'columnDefinition = "text"');
  } else if (spec.collation) {
    attrs.push(`columnDefinition = "varchar(${spec.length}) collate ${spec.collation}"`);
  } else if (spec.length != null) {
    attrs.push(`length = ${spec.length}`);
  }
  if (spec.scale != null) {
    attrs.push(`precision = ${DECIMAL_PRECISION}, scale = ${spec.scale}`);
  }

  if (spec.enum) {
    annotations.push('@Enumerated(EnumType.STRING)');
  }
  annotations.push(`@Column(${attrs.join(', ')})`);
  return annotations;
}

/**
 * Anotaciones de campo de documento (Spring Data MongoDB), equivalente documental
 * de columnAnnotations(). Devuelve una lista, igual que aquella.
 *
 * Es mucho más corta y no por descuido: en Mongo no hay esquema, así que
 * `nullable`, `length`, `unique` y `columnDefinition` no tienen dónde aterrizar.
 * La consecuencia hay que decirla en voz alta: `required` y `maxLength` los hacía
 * cumplir la base de datos en la rama relacional, y aquí solo los hace cumplir la
 * Bean Validation del borde (documentado en conventions/mapping.md; recuperarlos en
 * la base es un validador $jsonSchema, que es tuning del agente y no generación).
 *
 * Tampoco hace falta quoteIdentifier: las restricciones de Mongo sobre un nombre de
 * campo son no empezar por `$`, no contener `.` y no llamarse `_id`, y snakeCase()
 * sobre un identificador del DSL no produce ninguna de las tres.
 */
export function documentAnnotations(fieldName, base) {
  const attrs = [`name = "${snakeCase(fieldName)}"`];

  // Sin targetType, el driver serializa BigDecimal como String y toda comparación u
  // ordenación en la base pasa a ser lexicográfica ("10" < "9"). Decimal128 es el
  // tipo decimal nativo, y es lo que exige la precisión numérica de constitution.md.
  if (base === 'decimal') attrs.push('targetType = FieldType.DECIMAL128');

  return [`@Field(${attrs.join(', ')})`];
}

/** ¿Este campo necesita el import de FieldType además del de Field? */
export function needsFieldType(base) {
  return base === 'decimal';
}

export function escapeJava(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
