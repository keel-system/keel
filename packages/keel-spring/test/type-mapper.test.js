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

test('beanValidationAnnotations usa DecimalMin para decimales', () => {
  const resolved = resolveType('decimal', domainTypes);
  const annotations = beanValidationAnnotations({ required: true, constraints: { min: 0 } }, resolved);
  assert.ok(annotations.includes('@NotNull'));
  assert.ok(annotations.includes('@DecimalMin("0")'));
});

test('columnAnnotations produce @Column con nombre snake y flags', () => {
  const resolved = resolveType('SKU', domainTypes);
  const annotations = columnAnnotations('sku', { required: true, unique: true }, resolved);
  assert.deepEqual(annotations, ['@Column(name = "sku", nullable = false, unique = true, length = 8)']);
});

test('columnAnnotations añade @Enumerated para enums y columnDefinition para text', () => {
  const enumAnnotations = columnAnnotations('status', { type: 'ProductStatus' }, resolveType('ProductStatus', domainTypes));
  assert.equal(enumAnnotations[0], '@Enumerated(EnumType.STRING)');
  const textAnnotations = columnAnnotations('notes', { type: 'text' }, resolveType('text', domainTypes));
  assert.ok(textAnnotations[0].includes('columnDefinition = "text"'));
});
