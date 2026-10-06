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
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const unquote = (name) => String(name).replace(/`/g, '');

function table(tables, name) {
  if (!tables.has(name)) tables.set(name, { columns: new Map(), names: new Set(), predicates: new Map() });
  return tables.get(name);
}

/** Los atributos que una anotación @Column declara: nulabilidad, cota y escala. */
function springColumn(attrs) {
  const length = /length = (\d+)/.exec(attrs)?.[1] ?? /varchar\((\d+)\)/.exec(attrs)?.[1] ?? null;
  return {
    nullable: !/nullable = false/.test(attrs),
    length: length == null ? null : Number(length),
    scale: /scale = (\d+)/.exec(attrs)?.[1] != null ? Number(/scale = (\d+)/.exec(attrs)[1]) : null
  };
}

function springSchema(files) {
  const tables = new Map();
  // Los índices únicos CONDICIONADOS no están en las anotaciones (JPA no tiene predicado): keel-spring
  // los crea con el apéndice SQL, y es ahí donde se leen, con su predicado.
  const appendix = files.find((f) => f.path.endsWith('db/partial-indexes.sql'))?.content ?? '';
  for (const m of appendix.matchAll(/^CREATE UNIQUE INDEX IF NOT EXISTS (\w+) ON (\w+) \(.*\) WHERE (.*);$/gm)) {
    table(tables, m[2]).names.add(m[1]);
    table(tables, m[2]).predicates.set(m[1], m[3]);
  }
  const jpa = files.filter((f) => f.path.includes('/infrastructure/persistence/entities/') && f.path.endsWith('.java'));
  const classes = new Map();
  for (const file of jpa) {
    const name = /public (?:abstract )?class (\w+)/.exec(file.content)?.[1];
    const tableName = /@Table\(name = "([^"]+)"/.exec(file.content)?.[1];
    classes.set(name, { file, table: tableName ? unquote(tableName) : null, embeddable: /@Embeddable/.test(file.content), mapped: /@MappedSuperclass/.test(file.content) });
  }
  const columnsOf = (content) => [...content.matchAll(/@Column\((name = "([^"]+)"[^)]*)\)/g)].map((m) => [unquote(m[2]), springColumn(m[1])]);
  for (const [, info] of classes) {
    if (!info.table) continue;
    const content = info.file.content;
    const t = table(tables, info.table);
    const header = /@Table\(([\s\S]*?)\)\npublic class/.exec(content)?.[1] ?? '';
    for (const m of header.matchAll(/@(?:UniqueConstraint|Index)\(name = "([^"]+)"/g)) t.names.add(m[1]);
    // Lo heredado de la base de auditoría.
    const parent = /extends (\w+)/.exec(content)?.[1];
    if (parent && classes.get(parent)?.mapped) for (const [name, spec] of columnsOf(classes.get(parent).file.content)) t.columns.set(name, spec);
    const body = content.slice(content.indexOf('public class'));
    for (const block of body.split(/\n\s*\n/)) {
      const collection = /@CollectionTable\(name = "([^"]+)", joinColumns = @JoinColumn\(name = "([^"]+)", foreignKey = @ForeignKey\(name = "([^"]+)"\)\)([\s\S]*?)\)\n/.exec(block);
      if (collection) {
        const ct = table(tables, collection[1]);
        ct.columns.set(collection[2], { nullable: false, length: null, scale: null });
        ct.names.add(collection[3]);
        for (const m of collection[4].matchAll(/@Index\(name = "([^"]+)"/g)) ct.names.add(m[1]);
        const order = /@OrderColumn\(name = "([^"]+)"\)/.exec(block)?.[1];
        if (order) ct.columns.set(order, { nullable: false, length: null, scale: null });
        for (const [name, spec] of columnsOf(block.replace(/@CollectionTable\([\s\S]*?\)\n/, ''))) ct.columns.set(name, spec);
        const element = /List<(\w+)>/.exec(block)?.[1];
        if (classes.get(element)?.embeddable) for (const [name, spec] of columnsOf(classes.get(element).file.content)) ct.columns.set(name, spec);
        continue;
      }
      const join = /@JoinColumn\(name = "([^"]+)"([^)]*?), foreignKey = @ForeignKey\(name = "([^"]+)"\)\)/.exec(block);
      if (join && /@OneToMany/.test(block)) {
        // Unidireccional: la FK vive en la tabla de la HIJA.
        const child = classes.get(/List<(\w+)>/.exec(block)?.[1]);
        const ct = table(tables, child.table);
        ct.columns.set(unquote(join[1]), { nullable: true, length: null, scale: null });
        ct.names.add(join[3]);
        continue;
      }
      if (join) {
        t.columns.set(unquote(join[1]), { nullable: !/nullable = false/.test(join[2]), length: null, scale: null });
        t.names.add(join[3]);
        continue;
      }
      for (const [name, spec] of columnsOf(block)) t.columns.set(name, spec);
    }
  }
  return tables;
}

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
