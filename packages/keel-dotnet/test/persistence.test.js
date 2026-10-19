// La persistencia relacional que emite keel-dotnet (incremento 6), sobre el árbol en memoria de las fixtures
// compartidas. Que el esquema es el de keel-spring lo mide schema-parity; que EF construye el modelo y su DDL lleva
// cada nombre del diseño, la prueba emitida PersistenceModelTests en `npm run cs-check` (las 15 fixtures); que el
// servidor arranca contra PostgreSQL aplicando el baseline, el arranque de cs-check. Aquí, lo que se juzga sin SDK:
//   · la configuración por perfil: las MISMAS variables, con el mismo gradiente y los mismos defaults que keel-nest;
//   · un puerto por raíz en el dominio, su adaptador registrado, y el handler de cada operación con el suyo;
//   · la frontera transaccional en el mediator (las consultas, en solo lectura);
//   · el traductor de errores: una fila por cada constraint que keel-core sabe traducir, con su error y su mensaje;
//   · el diseño documental no emite nada de esto (llega en el incremento 12).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService, FRAMEWORK_ERRORS } from 'keel-core';
import { constraintErrors } from 'keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';
import { repositoryRoots, portClass, adapterClass } from '../src/scaffold/repositories.js';
import { MIGRATIONS_TABLE } from '../src/scaffold/persistence-runtime.js';

const RELATIONAL = ['product-catalog', 'catalog-extended', 'notification-mailer', 'payment-checkout'];
const plans = new Map();
for (const name of [...RELATIONAL, 'job-dispatch-mongo']) plans.set(name, await planFixture(name));
const fileOf = (name, suffix) => plans.get(name).files.find((file) => file.path.endsWith(suffix));

/** Las claves hoja de un YAML sencillo (las de db.yaml), con su ruta y su valor tal cual. */
function leaves(yaml) {
  const values = new Map();
  const stack = [];
  for (const line of yaml.split('\n')) {
    const match = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const depth = match[1].length / 2;
    stack.length = depth;
    stack[depth] = match[2];
    if (match[3] !== '') values.set(stack.join('.'), match[3]);
  }
  return values;
}

for (const name of RELATIONAL) {
  test(`${name}: la base se configura con las mismas variables, gradiente y defaults que keel-nest`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const nest = planNest({ manifest, layers, workspace: FIXTURES_DIR }).files;
    for (const profile of ['local', 'develop', 'production']) {
      const ours = leaves(fileOf(name, `config/parameters/${profile}/db.yaml`).content);
      const theirs = leaves(nest.find((file) => file.path === `config/parameters/${profile}/db.yaml`).content);
      for (const key of ['url', 'username', 'password', 'pool.name', 'pool.max-size', 'pool.connection-timeout-ms', 'pool.max-lifetime-ms', 'transaction-timeout']) {
        assert.equal(ours.get(`database.${key}`), theirs.get(`database.${key}`), `${profile}: database.${key}`);
      }
      // El esquema: en local lo crea EF; fuera, las migraciones (el synchronize/migrations-run de keel-nest).
      assert.equal(ours.get('database.schema'), profile === 'local' ? 'create' : 'migrate', profile);
    }
    assert.match(fileOf(name, 'config/parameters/test/db.yaml').content, /enabled: false/, 'el perfil test no tiene base');
  });

  test(`${name}: un puerto por raíz en el dominio, su adaptador registrado y cada handler con el de su agregado`, () => {
    const { model, files } = plans.get(name);
    const roots = repositoryRoots(model);
    assert.ok(roots.length > 0);
    const registration = fileOf(name, '/Persistence/PersistenceRegistration.cs').content;
    for (const root of roots) {
      const port = files.find((file) => file.path.endsWith(`/Domain/Repository/${portClass(root)}.cs`) || file.path.endsWith(`.Domain/Repository/${portClass(root)}.cs`));
      assert.ok(port, `${portClass(root)} en Domain/Repository`);
      assert.doesNotMatch(port.content, /EntityFrameworkCore/, 'el puerto no conoce EF');
      assert.ok(registration.includes(`services.AddScoped<${portClass(root)}, ${adapterClass(root)}>();`), `${adapterClass(root)} registrado`);
    }
    for (const service of model.services) {
      const target = model.entities.find((entity) => entity.name === service.entity);
      const root = roots.find((candidate) => candidate.name === (target?.rootEntity ?? service.entity));
      if (!root) continue;
      for (const operation of service.operations) {
        const handler = files.find((file) => file.path.endsWith(`/UseCases/${operation.handlerClass}.cs`)).content;
        assert.ok(handler.includes(`${portClass(root)} `), `${operation.handlerClass} recibe ${portClass(root)}`);
      }
    }
  });

  test(`${name}: el traductor de errores tiene una fila por cada constraint de keel-core, con su error y su mensaje`, () => {
    const { model } = plans.get(name);
    const errors = fileOf(name, '/Persistence/PersistenceErrors.cs').content;
    for (const entry of constraintErrors(model)) {
      const row = errors.split('\n').find((line) => line.includes(`["${entry.constraint.toLowerCase()}"]`));
      assert.ok(row, `${entry.constraint} sin fila`);
      assert.ok(row.includes(entry.declared ? `new ${entry.declared.exceptionClass}(` : `code: "${entry.code}"`), `${entry.constraint}: su error`);
      assert.ok(row.includes(JSON.stringify(entry.message).slice(1, -1)), `${entry.constraint}: su mensaje`);
    }
    assert.match(errors, new RegExp(FRAMEWORK_ERRORS.transactionTimeout.code));
  });
}

test('el mediator abre la transacción del caso de uso: las consultas en solo lectura, y DispatchWithoutTransaction sin ella', () => {
  const mediator = fileOf('product-catalog', '/UseCase/UseCaseMediator.cs').content;
  assert.match(mediator, /Dispatch<TResult>\(IQuery<TResult> query[\s\S]*?readOnly: true/);
  assert.match(mediator, /Dispatch\(ICommand command[^\n]*\n[^\n]*readOnly: false/);
  assert.match(mediator, /DispatchWithoutTransaction\(ICommand command[^\n]*\n\s*Run\(command, \(\) => Handled\(command, cancellationToken\)\);/);
  // Con persistencia la transacción es la de EF; sin ella, el paso directo.
  assert.match(fileOf('product-catalog', '/Persistence/PersistenceRegistration.cs').content, /Replace\(ServiceDescriptor\.Scoped<IUseCaseTransactions>/);
  assert.match(fileOf('product-catalog', '/UseCase/UseCaseRegistration.cs').content, /TryAddScoped<IUseCaseTransactions, PassThroughUseCaseTransactions>/);
});

test('el historial de migraciones lleva nombre propio en ejecución y en tiempo de diseño', () => {
  for (const file of ['/Persistence/PersistenceRegistration.cs', '/Persistence/DesignTimeDbContextFactory.cs']) {
    assert.ok(fileOf('product-catalog', file).content.includes(`MigrationsHistoryTable("${MIGRATIONS_TABLE}")`), file);
  }
  assert.match(fileOf('product-catalog', '.config/dotnet-tools.json').content, /"dotnet-ef"/);
});

test('un listado paginado con persistencia lee el Pageable de Spring Data, con el tope y el orden del diseño', () => {
  const endpoints = plans.get('product-catalog').files.find((file) => /\/Endpoints\/\w+\.cs$/.test(file.path) && file.content.includes('PageableReading.Read')).content;
  assert.match(endpoints, /PageableReading\.Read\(httpRequest\.Query, defaultSize: 20, maxSize: 100, defaultSort: \[[^\]]*\]\)/);
  const query = plans.get('product-catalog').files.find((file) => file.path.endsWith('/Queries/ListProductsQuery.cs')).content;
  assert.match(query, /public required Pageable Pageable \{ get; init; \}/);
});

test('el diseño documental no emite persistencia RELACIONAL: ni filas, ni DbContext, ni migraciones (la suya es la del incremento 12)', () => {
  const { files } = plans.get('job-dispatch-mongo');
  assert.deepEqual(files.filter((file) => /\/Persistence\/Rows\/|DbContext|DesignTimeDbContextFactory|\.config\/dotnet-tools\.json$/.test(file.path)).map((file) => file.path), []);
  assert.ok(files.some((file) => file.path.endsWith('/Persistence/DocumentIndexes.cs')));
});

test('la nota del filtro plegado nombra la función y la sombra con la grafía de C#, las que existen en el proyecto', async () => {
  // Una búsqueda SIN finder (un input que no enlaza): la consulta es del agente y la nota le dice cómo plegar.
  const { files } = await planFixture('catalog-extended', {
    mutate: (manifest, layers) => {
      layers['use-cases'].operations.listProducts.input.fields.search = { type: 'string', constraints: { maxLength: 60 } };
    }
  });
  const notes = files.filter((file) => /QueryHandler\.cs$/.test(file.path) && /pliega el parámetro/.test(file.content));
  assert.ok(notes.length > 0);
  for (const file of notes) {
    assert.match(file.content, /TextFold\.FoldCase(AndAccents)?\(\.\.\.\)/, file.path);
    assert.match(file.content, /\.[A-Z]\w*Normalized, la sombra/, file.path);
    assert.doesNotMatch(file.content, /TextFold\.fold/, file.path);
  }
});

test('con finder (DSL 2.22), el plegado lo hace el adaptador y la nota del handler ya no lo pide', async () => {
  const { files } = await planFixture('catalog-extended');
  const handler = files.find((file) => file.path.endsWith('ListProductsQueryHandler.cs'));
  assert.doesNotMatch(handler.content, /pliega el parámetro/);
  // La nota va partida en líneas de comentario: se compara sin los saltos.
  const note = handler.content.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(note.includes('await productRepository.ListProducts(new ListProductsFilter(query.Name), query.Pageable, cancellationToken)'));
  const adapter = files.find((file) => file.path.endsWith('Repositories/ProductRepository.cs'));
  assert.ok(adapter.content.includes('var nameFolded = TextFold.FoldCaseAndAccents(name);'));
  assert.ok(adapter.content.includes('query = query.Where(r => r.NameNormalized.Contains(nameFolded));'));
});

test('RowValues.Unmapped solo existe si algún adaptador lo llama: sin uso, es andamiaje que lanza NotImplementedException', async () => {
  const unmapped = (files) => files.filter((file) => file.content.includes('Unmapped<')).map((file) => path.basename(file.path)).sort();
  assert.deepEqual(unmapped((await planFixture('product-catalog')).files), []);
  // Un value object que anida otro: build no sabe aplanarlo, el adaptador lo nombra y RowValues lo trae.
  const nested = await planFixture('product-catalog', {
    mutate: (manifest, layers) => {
      layers.domain.types.Tier = { description: 'Escalón.', fields: { price: { type: 'Money', required: true }, label: { type: 'string' } } };
      layers.domain.entities.Product.fields.tier = { type: 'Tier' };
    }
  });
  assert.deepEqual(unmapped(nested.files), ['ProductRepository.cs', 'RowValues.cs']);
});
