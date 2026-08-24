import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as valueTypeFiles } from '../src/scaffold/value-types.js';
import { generate as exceptionFiles } from '../src/scaffold/exceptions.js';
import { generate as entityFiles } from '../src/scaffold/entities.js';

// El formato de un value type ESCALAR no tiene dónde vivir: el DTO de entrada lo deja
// caer a propósito (describe el valor ya normalizado) y el tipo se aplana a String, así
// que no hay constructor compacto que lo recoja. Estas pruebas fijan la pieza que cierra
// ese hueco: una clase `<Tipo>Format` por tipo, con la regex del diseño escrita UNA vez.

const fixture = (name) => path.join(process.cwd(), 'test', 'fixtures', name);

function modelOf(name, mutate = null) {
  const { manifest, layers, errors } = loadService(fixture(name));
  assert.deepEqual(errors, []);
  const used = mutate ? structuredClone(layers) : layers;
  if (mutate) mutate(used);
  return buildModel({ manifest, layers: used });
}

const fileNamed = (files, name) => files.find((file) => file.path.endsWith(`${name}.java`));

test('un value type escalar con pattern gana su clase de formato con la regex del diseño', () => {
  const model = modelOf('product-catalog');
  const file = fileNamed(valueTypeFiles(model), 'SKUFormat');

  assert.ok(file, 'no se generó SKUFormat');
  assert.match(file.path, /domain[\/]valueobject/);
  assert.match(file.content, /Pattern\.compile\("\^\[A-Z\]\{3\}-\[0-9\]\{4\}\$"\)/);
  assert.match(file.content, /public static void validate\(String value\)/);
  assert.match(file.content, /public static boolean matches\(String value\)/);
  // Tolerante a null/blank: la presencia la decide la regla de negocio, no el formato.
  // Un guard que además exigiera presencia rechazaría el vaciado de un campo opcional.
  assert.match(file.content, /value == null \|\| value\.isBlank\(\)/);
  // La regex, una sola vez: quien la vuelva a compilar crea una segunda definición.
  assert.equal(file.content.split('Pattern.compile(').length - 1, 1);
});

test('sin pattern no hay clase de formato: una que no comprueba nada no distingue «cumple» de «no mira»', () => {
  const model = modelOf('product-catalog', (layers) => {
    delete layers.domain.types.SKU.constraints.pattern;
  });

  assert.equal(fileNamed(valueTypeFiles(model), 'SKUFormat'), undefined);
  assert.equal(model.formatTypes.length, 0);
});

test('un value type COMPUESTO sigue con su constructor compacto y no gana clase de formato', () => {
  const model = modelOf('product-catalog');
  const files = valueTypeFiles(model);

  // Money es compuesto: su formato (el que tenga) vive en el record, que sí existe.
  assert.ok(fileNamed(files, 'Money'), 'falta el record del value object compuesto');
  assert.equal(fileNamed(files, 'MoneyFormat'), undefined);
});

test('la excepción del formato lleva el code canónico del catálogo, y solo existe si hay formatos', () => {
  const conFormato = fileNamed(exceptionFiles(modelOf('product-catalog')), 'ValueFormatException');
  assert.ok(conFormato, 'no se generó ValueFormatException');
  assert.match(conFormato.content, /extends BadRequestException/);
  // El code del framework no se escribe a mano: sale de FRAMEWORK_ERRORS.validation.
  assert.match(conFormato.content, /"VALIDATION_ERROR", 400/);

  const sinFormato = exceptionFiles(
    modelOf('product-catalog', (layers) => {
      delete layers.domain.types.SKU.constraints.pattern;
    })
  );
  assert.equal(fileNamed(sinFormato, 'ValueFormatException'), undefined);
});

test('la entidad nombra el guard que le toca, campo a campo', () => {
  const model = modelOf('product-catalog');
  const product = fileNamed(entityFiles(model), 'Product');

  // Sin decir CUÁL, la instrucción no tiene destinatario: en la corrida real el guard
  // solo se escribió donde un escenario lo exigía.
  assert.match(product.content, /SKUFormat\.validate\(sku\);/);
  assert.match(product.content, /import .*domain\.valueobject\.SKUFormat;/);
});

test('el patrón heredado tiene una sola fuente: el campo lo lleva resuelto', () => {
  const model = modelOf('product-catalog');
  const product = model.entities.find((entity) => entity.name === 'Product');
  const sku = product.fields.find((field) => field.name === 'sku');

  assert.equal(sku.inheritedPattern, '^[A-Z]{3}-[0-9]{4}$');
  assert.equal(sku.typeName, 'SKU');
  // Y el campo que NO lo hereda no lo inventa.
  const name = product.fields.find((field) => field.name === 'name');
  assert.equal(name.inheritedPattern, null);
});

test('un pattern sobre un base NO textual no genera clase ni nota: no habría dónde aplicarlo', () => {
  const model = modelOf('product-catalog', (layers) => {
    layers.domain.types.SKU.base = 'decimal';
  });

  // Las dos cotas tienen que coincidir: si el campo llevara `inheritedPattern` sin que
  // exista la clase, la nota del command mandaría a un archivo que build no generó.
  assert.equal(model.formatTypes.length, 0);
  const sku = model.entities
    .find((entity) => entity.name === 'Product')
    .fields.find((field) => field.name === 'sku');
  assert.equal(sku.inheritedPattern, null);
});
