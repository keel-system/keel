// La persistencia DOCUMENTAL de keel-dotnet (incremento 12b), sin red: lo que se puede afirmar leyendo lo emitido contra
// las fuentes neutrales y contra lo que EMITEN los otros dos generadores del mismo diseño.
//   · el documento que escribe cada adaptador tiene las claves de keel-core/gen/document.js, en su orden, y a todo
//     nivel (las hijas y los value objects también);
//   · los índices que se crean al arrancar son los de keel-core/gen/document.js, con su nombre, claves y filtro;
//   · el traductor conoce cada índice único con su error;
//   · la `DB_URL` de local es la de keel-spring, y la de despliegue sigue el gradiente;
//   · las propiedades por las que se ordena un listado son las de keel-nest (la ruta del espejo de keel-spring);
//   · nada de EF Core en un proyecto documental.
// Que todo esto, ADEMÁS, guarde y lea de verdad lo mide `npm run doc-check` contra un MongoDB real.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { constraintErrors } from 'keel-core/gen';
import { documentShape, documentIndexes } from 'keel-core/gen/document';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';
import { repositoryRoots, adapterClass } from '../src/scaffold/repositories.js';
import { packagesFor, toolsFor } from '../src/scaffold/project.js';

const SUBJECTS = ['inspection-reports', 'job-dispatch-mongo', 'notification-mailer-mongo', 'asset-vault'];

/** Las claves que escribe `ToDocument<Tipo>` de un adaptador, en su orden. */
function writtenKeys(source, type) {
  const start = source.indexOf(`private static BsonDocument ToDocument${type}(`);
  if (start < 0) return null;
  const body = source.slice(start, source.indexOf('};', start));
  return [...body.matchAll(/^\s*\{ "([^"]+)", /gm)].map((match) => match[1]);
}

for (const name of SUBJECTS) {
  const { model, files } = await planFixture(name);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const find = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

  test(`${name}: emite la persistencia documental y nada de EF Core`, () => {
    for (const required of ['DatabaseSettings', 'DocumentDatabase', 'BsonValues', 'DocumentIndexes', 'PersistenceTransactions', 'PersistenceErrors', 'PersistenceRegistration']) {
      assert.ok(find(`/Persistence/${required}.cs`), `emite ${required}.cs`);
    }
    assert.ok(byPath['infra/export-indexes.sh'], 'emite export-indexes.sh');
    assert.ok(!files.some((file) => file.path.includes('/Persistence/Rows/')), 'sin filas de EF');
    assert.ok(!files.some((file) => file.path.endsWith('.cs') && /using Microsoft\.EntityFrameworkCore|using Npgsql/.test(file.content)), 'ningún .cs usa EF Core ni Npgsql');
    assert.ok(packagesFor(model).includes('MongoDB.Driver'));
    assert.ok(!packagesFor(model).some((id) => id.startsWith('Microsoft.EntityFrameworkCore') || id.startsWith('Npgsql')));
    assert.deepEqual(toolsFor(model), [], 'sin dotnet-ef: no hay migraciones');
  });

  test(`${name}: cada adaptador escribe el documento de keel-core/gen/document.js, en su orden y a todo nivel`, () => {
    for (const root of repositoryRoots(model)) {
      const source = find(`/Persistence/Repositories/${adapterClass(root)}.cs`);
      assert.ok(source, adapterClass(root));
      const involved = model.entities.filter((entity) => entity.persisted && (entity === root || entity.rootEntity === root.name));
      for (const entity of involved) {
        // `version` y `audit` de política no salen del dominio: los pone Save.
        const expected = documentShape(model, entity).filter((entry) => entry.kind !== 'version' && entry.kind !== 'audit').map((entry) => entry.name);
        assert.deepEqual(writtenKeys(source, entity.name), expected, `${adapterClass(root)}: ${entity.name}`);
      }
    }
  });

  test(`${name}: los índices del arranque son los de keel-core/gen/document.js`, () => {
    const source = find('/Persistence/DocumentIndexes.cs');
    for (const { collection, specs } of documentIndexes(model, [])) {
      assert.ok(source.includes(`["${collection}"] =`), collection);
      for (const spec of specs) {
        const keys = spec.paths.map((p) => `{ "${p}", 1 }`).join(', ');
        const line = source.split('\n').find((candidate) => candidate.includes(`Name = "${spec.name}"`));
        assert.ok(line, `${collection}: ${spec.name}`);
        assert.ok(line.includes(`new BsonDocument { ${keys} }`), `${spec.name}: claves ${keys}`);
        assert.equal(line.includes('Unique = true'), Boolean(spec.unique), `${spec.name}: unique`);
        if (spec.partialFilter) assert.ok(line.includes(`PartialFilterExpression = new BsonDocument("${spec.partialFilter.path}", ${JSON.stringify(spec.partialFilter.equals)})`), `${spec.name}: filtro`);
        else assert.ok(!line.includes('PartialFilterExpression'), `${spec.name}: sin filtro`);
      }
    }
  });

  test(`${name}: el traductor conoce cada índice único con su error`, () => {
    const source = find('/Persistence/PersistenceErrors.cs');
    for (const entry of constraintErrors(model).filter((candidate) => !candidate.reference)) {
      assert.ok(source.includes(`["${entry.constraint.toLowerCase()}"] = () =>`), entry.constraint);
      assert.ok(source.includes(JSON.stringify(entry.message).slice(1, -1)), `${entry.constraint}: mensaje`);
    }
  });

  test(`${name}: la DB_URL de local es la de keel-spring, y la del despliegue sigue el gradiente`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
    const springLocal = parseYaml(spring.files.find((file) => file.path.endsWith('parameters/local/db.yaml')).content);
    const dotnet = (profile) => parseYaml(byPath[`config/parameters/${profile}/db.yaml`]).database;
    assert.equal(dotnet('local').url, springLocal.spring.data.mongodb.uri);
    assert.equal(dotnet('production').url, '${DB_URL}');
    assert.match(dotnet('develop').url, /^\$\{DB_URL:mongodb:\/\//);
    assert.equal(dotnet('test').enabled, false);
  });

  test(`${name}: las propiedades de orden de un listado son las de keel-nest (la ruta del espejo de keel-spring)`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const nest = planNest({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } });
    for (const root of repositoryRoots(model)) {
      const source = find(`/Persistence/Repositories/${adapterClass(root)}.cs`);
      if (!source.includes('Sortable = new')) continue;
      const mine = [...source.matchAll(/^\s*\["([^"]+)"\] = "([^"]+)",$/gm)].map((match) => [match[1], match[2]]);
      const nestSource = nest.files.find((file) => file.content.includes(`class ${root.name}RepositoryImpl`) || file.content.includes(`export class ${root.name}Repository`))?.content ?? '';
      const theirs = [...nestSource.matchAll(/^\s*\['([^']+)', '([^']+)'\]/gm)].map((match) => [match[1], match[2]]);
      assert.ok(theirs.length > 0, `keel-nest emite el SORTABLE de ${root.name}`);
      assert.deepEqual(mine, theirs, root.name);
    }
  });
}
