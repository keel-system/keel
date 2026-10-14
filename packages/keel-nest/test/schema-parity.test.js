// La PARIDAD DEL ESQUEMA: para cada fixture relacional, las tablas que emite keel-nest (decoradores de
// TypeORM) son las que emite keel-spring (anotaciones JPA) — mismas tablas, mismas columnas con la
// misma nulabilidad, cota de texto y escala, y los mismos NOMBRES de constraint única, índice y FK.
//
// Es la red sin contenedores, como contract-parity lo es del HTTP: compara lo que EMITEN los dos
// generadores, no el modelo del que salen los dos. Lo que el motor hace con ello lo juzga
// `npm run db-check` (podman/docker).
//
// Lo que se lee de cada lado es lo DECLARADO: en JPA, lo que Hibernate deja al dialecto (el tipo de
// un UUID, el 255 de un String sin cota) no está escrito, y aquí solo se compara lo que lo está.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema, schemaTable } from '../../keel-spring/test/helpers/schema-table.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const table = schemaTable;

function nestSchema(files) {
  const tables = new Map();
  const orm = files.filter((f) => f.path.startsWith('src/infrastructure/persistence/entities/'));
  const bases = new Map();
  for (const file of orm) {
    const abstract = /export abstract class (\w+)/.exec(file.content);
    if (abstract) bases.set(abstract[1], file.content);
  }
  const columnsOf = (content) =>
    [...content.matchAll(/@(?:Column|PrimaryColumn)\(\{ name: '([^']+)'([^}]*)\}\)/g)].map((m) => [
      m[1],
      {
        nullable: /nullable: true/.test(m[2]),
        length: /length: (\d+)/.exec(m[2]) && !/type: 'binary'/.test(m[2]) ? Number(/length: (\d+)/.exec(m[2])[1]) : null,
        scale: /scale: (\d+)/.exec(m[2]) ? Number(/scale: (\d+)/.exec(m[2])[1]) : null
      }
    ]);
  for (const file of orm) {
    // Un archivo puede llevar varias clases (la entidad y las tablas de sus listas).
    for (const part of file.content.split(/(?=^\/\*\*[^\n]*\n(?:@\w+[^\n]*\n)*@Entity)/m)) {
      const entity = /@Entity\(\{ name: '([^']+)' \}\)/.exec(part);
      if (!entity) continue;
      const t = table(tables, entity[1]);
      for (const m of part.matchAll(/@(?:Unique|Index)\('([^']+)'/g)) t.names.add(m[1]);
      for (const m of part.matchAll(/@Index\('([^']+)', \[[^\]]*\], \{ unique: true, where: '((?:[^'\\]|\\.)*)' \}\)/g)) t.predicates.set(m[1], m[2].replace(/\\'/g, "'"));
      for (const m of part.matchAll(/foreignKeyConstraintName: '([^']+)'/g)) t.names.add(m[1]);
      const parent = /export class \w+ extends (\w+)/.exec(part)?.[1];
      if (parent && bases.has(parent)) for (const [name, spec] of columnsOf(bases.get(parent))) t.columns.set(name, spec);
      for (const [name, spec] of columnsOf(part)) t.columns.set(name, spec);
    }
  }
  return tables;
}

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});

test('hay fixtures relacionales que comparar', () => {
  assert.ok(relational.length >= 6, relational.join(', '));
});

for (const name of relational) {
  test(`${name}: el esquema de keel-nest es el de keel-spring`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = springSchema(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
    const nest = nestSchema(planFixture(name).files);
    assert.deepEqual([...nest.keys()].sort(), [...spring.keys()].sort(), 'las mismas tablas');
    for (const [tableName, want] of spring) {
      const got = nest.get(tableName);
      assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${tableName}: los mismos nombres de constraint, índice y FK`);
      assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${tableName}: las mismas columnas`);
      // El predicado de un índice condicionado, letra a letra: con el literal del diseño en vez de la
      // constante del enum el índice se crea y no casa con ninguna fila.
      assert.deepEqual(Object.fromEntries(got.predicates), Object.fromEntries(want.predicates), `${tableName}: los mismos predicados`);
      for (const [column, spec] of want.columns) {
        const have = got.columns.get(column);
        if (spec.length != null) assert.equal(have.length, spec.length, `${tableName}.${column}: la cota declarada`);
        if (spec.scale != null) assert.equal(have.scale, spec.scale, `${tableName}.${column}: la escala declarada`);
        assert.equal(have.nullable, spec.nullable, `${tableName}.${column}: ${spec.nullable ? 'admite null' : 'NOT NULL'}`);
      }
    }
  });
}

// Ninguna fixture relacional aplana un value object OPCIONAL (solo `Product.price`, obligatorio), así que
// esa rama —sus columnas dejan de ser NOT NULL— se deriva de product-catalog en memoria. Sin esto, un
// emisor que olvidara la nulabilidad del dueño saldría verde en todas las fixtures.
test('product-catalog con el precio OPCIONAL: sus columnas aplanadas admiten null en los dos', () => {
  const optionalPrice = (layers) => {
    layers.domain.entities.Product.fields.price.required = false;
  };
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  optionalPrice(layers);
  const spring = springSchema(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
  const nest = nestSchema(planFixture('product-catalog', { mutate: optionalPrice }).files);
  for (const column of ['price_amount', 'price_currency']) {
    assert.equal(spring.get('products').columns.get(column).nullable, true, `keel-spring: ${column}`);
    assert.equal(nest.get('products').columns.get(column).nullable, true, `keel-nest: ${column}`);
  }
});
