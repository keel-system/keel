// La idempotencia de petición (adelantada del incremento 10 al 7, como en keel-nest): build genera el mecanismo —el
// mismo que keel-spring y keel-nest— y el agente escribe el uso. Aquí, sin red: qué se emite y cuándo, que el handler
// recibe el puerto y la nota con el algoritmo, que la cabecera tiene su middleware y que cada conflicto lleva el code
// de SU operación. La firma canónica la EJECUTA la prueba emitida (IdempotencyTests, en cs-check); lo que solo juzga
// el motor (guardar, la carrera, la caducidad, el rollback), `npm run db-check`; la tabla contra la de keel-spring,
// `schema-parity.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { loadService } from 'keel-core';
import path from 'node:path';
import { DOTNET_READY_DESIGN, FIXTURES_DIR, planFixture } from './helpers/workspace.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const MECHANISM = [
  'src/ProductCatalog.Domain/Idempotency/IIdempotencyStore.cs',
  'src/ProductCatalog.Domain/Idempotency/IdempotencyConflictException.cs',
  'src/ProductCatalog.Domain/Idempotency/IdempotencyReuseException.cs',
  'src/ProductCatalog.Application/Support/CommandSignature.cs',
  'src/ProductCatalog.Application/Support/IdempotencyContext.cs',
  'src/ProductCatalog.Infrastructure/Persistence/Rows/IdempotencyRecordRow.cs',
  'src/ProductCatalog.Infrastructure/Persistence/IdempotencyStore.cs',
  'src/ProductCatalog.Api/Rest/IdempotencyKeyMiddleware.cs',
  'tests/ProductCatalog.UnitTests/IdempotencyTests.cs'
];

const withoutPersistence = (manifest, layers) => {
  delete manifest.layers.persistence;
  delete layers.persistence;
};

test('con idempotencia y persistencia, build emite el mecanismo entero y lo cablea; sin persistencia, nada', async () => {
  const files = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files);
  for (const file of MECHANISM) assert.ok(file in files, file);
  assert.match(files['src/ProductCatalog.Infrastructure/Persistence/ProductCatalogDbContext.cs'], /ApplyConfiguration\(new IdempotencyRecordRowConfiguration\(\)\)/);
  assert.match(files['src/ProductCatalog.Infrastructure/Persistence/PersistenceRegistration.cs'], /services\.AddScoped<IIdempotencyStore, IdempotencyStore>\(\);/);
  assert.match(files['src/ProductCatalog.Api/Program.cs'], /UseMiddleware<ApiErrorMiddleware>\(\);\napp\.UseMiddleware<IdempotencyKeyMiddleware>\(\);/);
  const bare = byPath((await planFixture(DOTNET_READY_DESIGN.name, { mutate: withoutPersistence })).files);
  for (const file of MECHANISM) assert.equal(bare[file], undefined, file);
  assert.doesNotMatch(bare['src/ProductCatalog.Api/Program.cs'], /IdempotencyKeyMiddleware/);
});

test('la fila es la tabla de keel-core: clave primaria compuesta con nombre, cotas e índice de la purga', async () => {
  const row = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files)['src/ProductCatalog.Infrastructure/Persistence/Rows/IdempotencyRecordRow.cs'];
  assert.match(row, /row\.ToTable\("idempotency_record"\);/);
  assert.match(row, /row\.HasKey\(r => new \{ r\.OperationScope, r\.IdempotencyKey \}\)\.HasName\("idempotency_record_pkey"\);/);
  assert.match(row, /r\.ResourceId\)\.HasColumnName\("resource_id"\)\.HasMaxLength\(255\)\.IsRequired\(false\)/);
  assert.match(row, /HasIndex\(r => r\.ExpiresAt, "ix_idempotency_record_expires_at"\)\.HasDatabaseName\("ix_idempotency_record_expires_at"\)/);
});

test('el handler de la operación idempotente recibe el puerto y la nota con el algoritmo; los demás no', async () => {
  const files = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files);
  // Las notas se parten en líneas de comentario: se juntan para leerlas como texto.
  const create = files['src/ProductCatalog.Application/UseCases/CreateProductCommandHandler.cs'].replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(create, /CreateProductCommandHandler\(ProductApplicationMapper productApplicationMapper, IProductRepository productRepository, IIdempotencyStore idempotencyStore\)/);
  assert.match(create, /RECLAMA PRIMERO/);
  assert.match(create, /IdempotencyConflictException \(409 IDEMPOTENCY_KEY_IN_PROGRESS\)/);
  assert.match(create, /NO escribas otro registro/);
  assert.match(create, /IdempotencyContext\.Get\(\)/);
  assert.doesNotMatch(files['src/ProductCatalog.Application/UseCases/RetireProductCommandHandler.cs'], /IIdempotencyStore/);
  // El ámbito es un MÉTODO del comando: la firma recorre propiedades, y el ámbito no es contenido.
  assert.match(files['src/ProductCatalog.Application/Commands/CreateProductCommand.cs'], /public string IdempotencyScope\(\) => "createProduct";/);
});

test('el code del diseño, si nombra el conflicto, es el de SU operación y no el de todo el servicio', async () => {
  // catalog-extended nombra PRODUCT_KEY_* en createProduct y nada en removeProductImage, que también tiene
  // idempotencia: el override de una no puede salir por la carrera de la otra (corrida catalog, FL-IMG-001-G).
  const files = byPath((await planFixture('catalog-extended')).files);
  const conflict = Object.entries(files).find(([file]) => file.endsWith('/IdempotencyConflictException.cs'))[1];
  assert.match(conflict, /\["createProduct"\] = "PRODUCT_KEY_IN_PROGRESS"/);
  assert.doesNotMatch(conflict, /removeProductImage/);
  assert.match(conflict, /GetValueOrDefault\(scope\.Split\(':'\)\[0\], "IDEMPOTENCY_KEY_IN_PROGRESS"\)/);
  // Y la prueba emitida afirma cada operación con su code.
  const tests = Object.entries(files).find(([file]) => file.endsWith('/IdempotencyTests.cs'))[1];
  assert.match(tests, /\[InlineData\("createProduct", "PRODUCT_KEY_IN_PROGRESS", "PRODUCT_KEY_REUSED"\)\]/);
  assert.match(tests, /\[InlineData\("removeProductImage", "IDEMPOTENCY_KEY_IN_PROGRESS", "IDEMPOTENCY_KEY_REUSED"\)\]/);
});

test('el ámbito con partitionBy se compone en el comando, con cultura invariable', async () => {
  const files = byPath(
    (
      await planFixture(DOTNET_READY_DESIGN.name, {
        mutate: (_manifest, layers) => {
          layers['use-cases'].operations.createProduct.idempotency.partitionBy = ['sku'];
        }
      })
    ).files
  );
  assert.match(files['src/ProductCatalog.Application/Commands/CreateProductCommand.cs'], /IdempotencyScope\(\) => string\.Create\(CultureInfo\.InvariantCulture, \$"createProduct:\{Sku\}"\);/);
});

test('la frontera ya no avisa de la idempotencia con persistencia; sin ella, sí', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, DOTNET_READY_DESIGN.name));
  assert.deepEqual(
    checkSupportedFeatures(manifest, layers).warnings.filter((w) => /idempotency/.test(w)),
    []
  );
  withoutPersistence(manifest, layers);
  assert.ok(checkSupportedFeatures(manifest, layers).warnings.some((w) => /idempotency, pero el diseño no tiene persistencia/.test(w)));
});
