// Toda columna FK lleva índice, salvo la que ya encabeza otro.
//
// PostgreSQL, SQL Server y Oracle no indexan una FK por su cuenta (MySQL y MariaDB sí). Sin el
// índice nada falla: el `IN (...)` del @BatchSize que carga las hijas de una página recorre la
// tabla hija entera, borrar el padre la recorre para comprobar la FK, y en Oracle ese borrado
// bloquea la tabla hija completa. Es una degradación que crece con la tabla y que ningún
// escenario ve, así que la red es afirmar sobre lo que build emite.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { foreignKeyIndexColumns } from '../src/scaffold/persistence-entities.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixturesDir = path.join(FIXTURES_DIR);

function load(fixture, patchLayers = () => {}) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patchLayers(patched);
  return { manifest, layers: patched };
}

function fkColumns(loaded, entityName) {
  const model = buildModel({ ...loaded, stack: { database: 'postgresql' } });
  return foreignKeyIndexColumns(model, model.entities.find((entity) => entity.name === entityName));
}

function jpaSources(loaded) {
  const workspace = tmpDir('keel-fkindex-');
  scaffoldService({ ...loaded, workspace, force: true, stack: { database: 'postgresql' } });
  return fs
    .readdirSync(workspace, { recursive: true })
    .filter((file) => file.endsWith('Jpa.java'))
    .map((file) => fs.readFileSync(path.join(workspace, file), 'utf8'));
}

test('la referencia a otro agregado y el @OneToMany unidireccional ganan índice', () => {
  // `parent` apunta a otra Category, raíz persistida: lleva FK en el baseline.
  assert.deepEqual(fkColumns(load('catalog-extended'), 'Category'), ['parent_id']);
  // `Template.variables` es unidireccional: la columna la pone el padre en la tabla de la hija.
  assert.deepEqual(fkColumns(load('notification-mailer'), 'TemplateVariable'), ['template_id']);
});

test('no se duplica la FK que ya encabeza un índice o una clave natural', () => {
  // `category_id` encabeza el índice declarado (category, status).
  assert.deepEqual(fkColumns(load('catalog-extended'), 'Product'), []);
  // `product_id` —la vuelta de la hija a su padre— encabeza (product, position, primary).
  assert.deepEqual(fkColumns(load('catalog-extended'), 'ProductImage'), []);
  // `application_id` encabeza la clave natural de Template.
  assert.deepEqual(fkColumns(load('notification-mailer'), 'Template'), []);
});

test('sin el índice que la encabezaba, la vuelta de la hija a su padre sí lo gana', () => {
  // El caso anterior en negativo: es la misma columna, y lo único que cambia es si otro índice
  // ya la cubre. Sin esto, «no emite nada» pasaría igual con la regla rota.
  const withoutIndex = load('catalog-extended', (layers) => {
    delete layers.persistence.entities.ProductImage.indexes;
  });
  assert.deepEqual(fkColumns(withoutIndex, 'ProductImage'), ['product_id']);
  // Un índice CONDICIONADO solo cubre las filas de su condición: no cuenta.
  const conditional = load('catalog-extended', (layers) => {
    layers.persistence.entities.ProductImage.indexes = [
      { fields: ['product', 'primary'], unique: true, when: { field: 'primary', equals: true } }
    ];
  });
  assert.deepEqual(fkColumns(conditional, 'ProductImage'), ['product_id']);
});

test('el índice llega al @Table de la entidad', () => {
  const sources = jpaSources(load('catalog-extended'));
  const category = sources.find((source) => source.includes('public class CategoryJpa'));
  assert.match(category, /@Index\(name = "ix_categories_parent_id", columnList = "parent_id"\)/);
  const product = sources.find((source) => source.includes('public class ProductJpa'));
  assert.ok(!product.includes('ix_products_category_id'), 'se duplicó un índice que (category, status) ya cubre');
});

test('la tabla de elementos de una lista indexa su FK a la raíz', () => {
  // Es la ÚNICA red de esta mitad. El exportador que produce el V1 de producción escribe la PK
  // como (<campo>_order, <entidad>_id), con el ORDEN delante, así que no sirve para cargar la lista
  // de una raíz; pero `ddl-auto: update` la crea al revés y la cubre, y mapping-check —que corre con
  // update— sale verde con o sin este índice. Medido sobre notification-mailer el 2026-10-05.
  const annotations = jpaSources(load('notification-mailer'))
    .flatMap((source) => source.match(/@CollectionTable\([^\n]*/g) ?? []);
  assert.ok(annotations.length > 0, 'la fixture ya no tiene ninguna lista: el caso se quedó sin sujeto');
  for (const annotation of annotations) {
    const table = annotation.match(/@CollectionTable\(name = "([^"]+)"/)[1];
    const joinColumn = annotation.match(/@JoinColumn\(name = "([^"]+)"/)[1];
    assert.ok(
      annotation.includes(`@Index(name = "ix_${table}_${joinColumn}", columnList = "${joinColumn}")`),
      `la tabla de elementos no indexa su FK a la raíz: ${annotation}`
    );
  }
});
