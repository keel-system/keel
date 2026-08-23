import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveType, beanValidationAnnotations, columnAnnotations } from '../src/lib/type-mapper.js';

const domainTypes = {
  SKU: { base: 'string', constraints: { pattern: '^[A-Z]{3}-[0-9]{4}$', maxLength: 8 } },
  ProductStatus: { values: ['draft', 'active', 'retired'] },
  Money: { fields: { amount: { type: 'decimal', required: true }, currency: { type: 'string', required: true } } }
};

test('resolveType mapea los tipos base', () => {
  assert.deepEqual(resolveType('string', domainTypes).javaType, 'String');
  assert.equal(resolveType('decimal', domainTypes).javaType, 'BigDecimal');
  assert.deepEqual(resolveType('decimal', domainTypes).imports, ['java.math.BigDecimal']);
  assert.equal(resolveType('uuid', domainTypes).javaType, 'UUID');
  assert.equal(resolveType('timestamp', domainTypes).javaType, 'Instant');
  assert.equal(resolveType('date', domainTypes).javaType, 'LocalDate');
  assert.equal(resolveType('text', domainTypes).base, 'text');
});

test('resolveType aplana value types escalares con sus constraints', () => {
  const resolved = resolveType('SKU', domainTypes);
  assert.equal(resolved.kind, 'scalar-vt');
  assert.equal(resolved.javaType, 'String');
  assert.equal(resolved.constraints.maxLength, 8);
});

test('resolveType distingue enums nominales y compuestos', () => {
  assert.equal(resolveType('ProductStatus', domainTypes).kind, 'enum');
  assert.equal(resolveType('Money', domainTypes).kind, 'composite');
  assert.equal(resolveType('Money', domainTypes).javaType, 'Money');
});

test('beanValidationAnnotations combina required y constraints', () => {
  const resolved = resolveType('SKU', domainTypes);
  const annotations = beanValidationAnnotations({ required: true }, resolved);
  assert.ok(annotations.includes('@NotBlank'));
  assert.ok(annotations.some((a) => a.startsWith('@Size(max = 8')));
  assert.ok(annotations.some((a) => a.startsWith('@Pattern')));
});

test('beanValidationAnnotations sin inheritTypeFormat deja fuera el patrón del value type', () => {
  const resolved = resolveType('SKU', domainTypes);

  // El formato del value type describe el valor ya normalizado, así que no puede
  // replicarse en un DTO de ENTRADA: Bean Validation corre antes de que el handler
  // normalice (conventions/mapping.md § Normalización antes que validación).
  const inherited = beanValidationAnnotations({ required: true }, resolved, { inheritTypeFormat: false });
  assert.ok(inherited.includes('@NotBlank'));
  assert.ok(inherited.some((a) => a.startsWith('@Size(max = 8')), inherited.join(' '));
  assert.ok(!inherited.some((a) => a.startsWith('@Pattern')), inherited.join(' '));

  // El que el CAMPO declara por su cuenta sí se queda: es una restricción de esta
  // entrada, no la forma del tipo.
  const own = beanValidationAnnotations(
    { required: true, constraints: { pattern: '^[a-z]+$' } },
    resolved,
    { inheritTypeFormat: false }
  );
  assert.ok(own.includes('@Pattern(regexp = "^[a-z]+$")'), own.join(' '));
});

// Un campo con `default` es, por definición del DSL, omitible en el cable («valor si
// el cliente no lo provee»). Exigirlo en la ENTRADA rechaza con 400 justo el caso para
// el que el default existe — el camino feliz de crear un recurso cuyo estado inicial lo
// decide el dominio. Es un defecto que apareció DOS veces en la misma corrida.
test('beanValidationAnnotations omite la presencia de un campo con default solo en la entrada', () => {
  const resolved = resolveType('ProductStatus', domainTypes);
  const field = { required: true, default: 'draft' };

  // Salida / entidad: el valor sigue siendo obligatorio.
  assert.ok(beanValidationAnnotations(field, resolved).includes('@NotNull'));

  // Entrada: obligatorio es el VALOR, no que lo mande el cliente.
  const input = beanValidationAnnotations(field, resolved, { inheritTypeFormat: false, honourDefault: true });
  assert.deepEqual(input, []);
});

test('beanValidationAnnotations conserva las demás constraints de un campo con default', () => {
  const resolved = resolveType('string', domainTypes);
  const annotations = beanValidationAnnotations(
    { required: true, default: 'x', constraints: { maxLength: 10, pattern: '^[a-z]+$' } },
    resolved,
    { inheritTypeFormat: false, honourDefault: true }
  );
  // Si el cliente SÍ lo manda, tiene que ser válido: solo cae la presencia.
  assert.ok(!annotations.includes('@NotBlank'), annotations.join(' '));
  assert.ok(annotations.some((a) => a.startsWith('@Size(max = 10')), annotations.join(' '));
  assert.ok(annotations.includes('@Pattern(regexp = "^[a-z]+$")'), annotations.join(' '));
});

// `default: 0` y `default: false` son los que un `if (field.default)` se deja fuera, y
// son justo los defaults típicos: el contador que arranca en cero y la bandera apagada.
test('beanValidationAnnotations trata 0 y false como defaults legítimos', () => {
  const zero = beanValidationAnnotations(
    { required: true, default: 0 },
    resolveType('int', domainTypes),
    { inheritTypeFormat: false, honourDefault: true }
  );
  assert.deepEqual(zero, []);

  const off = beanValidationAnnotations(
    { required: true, default: false },
    resolveType('boolean', domainTypes),
    { inheritTypeFormat: false, honourDefault: true }
  );
  assert.deepEqual(off, []);
});

test('beanValidationAnnotations omite @NotEmpty de una lista con default', () => {
  const resolved = resolveType('string', domainTypes);
  const field = { required: true, list: true, default: [] };
  assert.ok(beanValidationAnnotations(field, resolved).includes('@NotEmpty'));
  assert.deepEqual(beanValidationAnnotations(field, resolved, { inheritTypeFormat: false, honourDefault: true }), []);
});

test('beanValidationAnnotations usa DecimalMin para decimales', () => {
  const resolved = resolveType('decimal', domainTypes);
  const annotations = beanValidationAnnotations({ required: true, constraints: { min: 0 } }, resolved);
  assert.ok(annotations.includes('@NotNull'));
  assert.ok(annotations.includes('@DecimalMin("0")'));
});

test('columnAnnotations produce @Column con nombre snake y flags', () => {
  const resolved = resolveType('SKU', domainTypes);
  const annotations = columnAnnotations('sku', { required: true, unique: true }, resolved);
  assert.deepEqual(annotations, ['@Column(name = "sku", nullable = false, length = 8)']);
});

test('columnAnnotations NO duplica la unicidad en la columna', () => {
  // La constraint del campo único la pone el `@Table` CON NOMBRE, y ese nombre es lo que
  // traduce la violación al `code` del diseño. Un `unique = true` de columna añade una
  // segunda constraint anónima: la base rechaza por ella y el handler, que mapea por
  // nombre, ya no reconoce el conflicto.
  const annotations = columnAnnotations('sku', { required: true, unique: true }, resolveType('SKU', domainTypes));
  assert.ok(!annotations.some((a) => a.includes('unique')), 'la unicidad se declara dos veces');
});

test('columnAnnotations añade @Enumerated para enums y columnDefinition para text', () => {
  const enumAnnotations = columnAnnotations('status', { type: 'ProductStatus' }, resolveType('ProductStatus', domainTypes));
  assert.equal(enumAnnotations[0], '@Enumerated(EnumType.STRING)');
  const textAnnotations = columnAnnotations('notes', { type: 'text' }, resolveType('text', domainTypes));
  assert.ok(textAnnotations[0].includes('columnDefinition = "text"'));
});
