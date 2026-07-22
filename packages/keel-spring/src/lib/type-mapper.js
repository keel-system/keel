// Mapeo de tipos del DSL keel a Java (ver conventions/mapping.md, sección "Tipos base").
// Los value types escalares se aplanan a su tipo base; sus constraints se propagan
// a Bean Validation y a la columna.

import { snakeCase } from './naming.js';

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
 * Resuelve una referencia de tipo del diseño (tipo base, value type declarado en
 * domain.types, o nombre de clase generada) a su representación Java.
 * Devuelve { kind, javaType, imports, base?, constraints? }:
 * - kind 'base'       → tipo base del DSL.
 * - kind 'scalar-vt'  → value type escalar, aplanado a su base.
 * - kind 'enum'       → enum nominal (clase generada en domain).
 * - kind 'composite'  → value object compuesto (clase generada en domain).
 */
export function resolveType(typeRef, domainTypes = {}) {
  if (BASE_TYPES[typeRef]) {
    return { kind: 'base', base: typeRef, ...BASE_TYPES[typeRef], constraints: {} };
  }
  const declared = domainTypes[typeRef];
  if (declared?.base) {
    const base = BASE_TYPES[declared.base] ?? BASE_TYPES.string;
    return {
      kind: 'scalar-vt',
      base: declared.base,
      javaType: base.javaType,
      imports: [...base.imports],
      constraints: { ...(declared.constraints ?? {}) }
    };
  }
  if (declared?.values) {
    return { kind: 'enum', javaType: typeRef, imports: [], constraints: {} };
  }
  if (declared?.fields) {
    return { kind: 'composite', javaType: typeRef, imports: [], constraints: {} };
  }
  // Referencia no declarada: la validación de referencias cruzadas ya la habría
  // rechazado; se conserva el nombre como clase de domain por robustez.
  return { kind: 'composite', javaType: typeRef, imports: [], constraints: {} };
}

/**
 * Anotaciones Bean Validation para un campo de DTO de entrada.
 * Combina las constraints del campo con las del value type escalar (aplanado).
 */
export function beanValidationAnnotations(field, resolved) {
  const annotations = [];
  const constraints = { ...resolved.constraints, ...(field.constraints ?? {}) };
  const isString = resolved.javaType === 'String';

  if (field.required) {
    annotations.push(isString ? '@NotBlank' : '@NotNull');
  }
  if (constraints.minLength != null || constraints.maxLength != null) {
    const parts = [];
    if (constraints.minLength != null) parts.push(`min = ${constraints.minLength}`);
    if (constraints.maxLength != null) parts.push(`max = ${constraints.maxLength}`);
    annotations.push(`@Size(${parts.join(', ')})`);
  }
  if (constraints.pattern != null) {
    annotations.push(`@Pattern(regexp = "${escapeJava(constraints.pattern)}")`);
  }
  if (constraints.min != null) {
    annotations.push(resolved.base === 'decimal' ? `@DecimalMin("${constraints.min}")` : `@Min(${constraints.min})`);
  }
  if (constraints.max != null) {
    annotations.push(resolved.base === 'decimal' ? `@DecimalMax("${constraints.max}")` : `@Max(${constraints.max})`);
  }
  return annotations;
}

/**
 * Anotaciones JPA de columna para un campo de entidad persistida.
 * Devuelve una lista (puede incluir @Enumerated además de @Column).
 */
export function columnAnnotations(fieldName, field, resolved) {
  const annotations = [];
  const attrs = [`name = "${snakeCase(fieldName)}"`];
  const constraints = { ...resolved.constraints, ...(field.constraints ?? {}) };

  if (field.required || field.id) attrs.push('nullable = false');
  if (field.unique) attrs.push('unique = true');
  if (field.id) attrs.push('updatable = false');
  if (resolved.base === 'text') attrs.push('columnDefinition = "text"');
  if (constraints.maxLength != null && resolved.javaType === 'String' && resolved.base !== 'text') {
    attrs.push(`length = ${constraints.maxLength}`);
  }
  if (resolved.base === 'decimal' && constraints.scale != null) {
    attrs.push(`precision = 19, scale = ${constraints.scale}`);
  }

  if (resolved.kind === 'enum' || field.type === 'enum') {
    annotations.push('@Enumerated(EnumType.STRING)');
  }
  annotations.push(`@Column(${attrs.join(', ')})`);
  return annotations;
}

function escapeJava(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
