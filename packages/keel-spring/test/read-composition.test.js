// Resolución de referencias embebidas (`embed`) sin N+1: build genera un
// <Raíz>RefResolver por agregado embebido, le da al puerto de esa raíz el
// findAllById que necesita y lo inyecta en los handlers que lo consumen.
//
// Lo que estos tests protegen es el hueco que había antes: el mapper exige el
// <Raíz>RefDto por parámetro, el agregado solo guarda el id ajeno y el handler
// no recibía nada con que resolverlo — ni compilaba, ni tenía indicación de
// hacerlo por lote.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
const JAVA = 'src/main/java/com/commerce/catalog';

// `patch` permite mover el embed a la operación paginada, que es donde el lote
// importa: la fixture solo lo declara en operaciones de un elemento.
function scaffold(patch) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  if (patch) patch(patched);
  const workspace = tmpDir('keel-readcomp-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  const exists = (relative) => fs.existsSync(path.join(workspace, 'services', 'catalog-spring', relative));
  return { result, read, exists };
}

const resolverPath = (entity) => `${JAVA}/application/support/${entity}RefResolver.java`;

test('embed: genera el RefResolver del agregado embebido con la resolución por lote', () => {
  const { read, exists } = scaffold();
  assert.ok(exists(resolverPath('Category')));
  const resolver = read(resolverPath('Category'));

  // Por lote: una consulta para toda la colección, indexada por id.
  assert.ok(resolver.includes('public Map<UUID, CategoryRefDto> resolve(Collection<UUID> ids)'));
  assert.ok(resolver.includes('categoryRepository.findAllById(distinct)'));
  assert.ok(resolver.includes('Collectors.toMap(Category::getId, categoryApplicationMapper::toCategoryRefDto)'));
  // Colección vacía: ni una consulta.
  assert.ok(resolver.includes('return Map.of();'));
  // Y la variante de un solo elemento, para las operaciones que no listan.
  assert.ok(resolver.includes('public CategoryRefDto resolve(UUID id)'));

  // Es componente de application: sin Spring y sin @Transactional (la abre el mediator).
  assert.ok(resolver.includes('@ApplicationComponent'));
  // Anotación real, no la mención del javadoc que explica por qué no la lleva.
  assert.ok(!/^\s*@Transactional/m.test(resolver));
  assert.ok(!resolver.includes('org.springframework'));
});

test('embed: solo la raíz embebida gana findAllById en su puerto y adaptador', () => {
  const { read } = scaffold();
  const port = read(`${JAVA}/domain/repository/CategoryRepository.java`);
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/CategoryRepositoryImpl.java`);

  assert.ok(port.includes('List<Category> findAllById(Collection<UUID> ids);'));
  assert.ok(adapter.includes('public List<Category> findAllById(Collection<UUID> ids)'));
  assert.ok(adapter.includes('categoryJpaRepository.findAllById(ids).stream().map(this::toDomain).toList()'));

  // Product no lo embebe nadie: su puerto no se ensancha con un método que
  // ningún resolver va a llamar.
  assert.ok(!read(`${JAVA}/domain/repository/ProductRepository.java`).includes('findAllById'));
});

test('embed: el handler recibe el resolver de cada RefDto que su mapper exige', () => {
  const { read } = scaffold();
  const handler = read(`${JAVA}/application/usecases/UpdateProductCommandHandler.java`);
  const mapper = read(`${JAVA}/application/mappers/ProductApplicationMapper.java`);

  // El mapper pide el CategoryRefDto por parámetro...
  assert.ok(mapper.includes('toUpdateProductResponseDto(Product entity, CategoryRefDto category)'));
  // ...y el handler tiene con qué producirlo: sin esto no compila. El resolver
  // es un parámetro del constructor, no necesariamente el último: la operación
  // también dispara una activación, que inyecta su propio puerto.
  assert.ok(handler.includes('import com.commerce.catalog.application.support.CategoryRefResolver;'));
  assert.ok(handler.includes('private final CategoryRefResolver categoryRefResolver;'));
  assert.ok(/public UpdateProductCommandHandler\([^)]*CategoryRefResolver categoryRefResolver[,)]/.test(handler));

  // Y no se le cuela el repositorio de la otra raíz: para esto va el resolver.
  assert.ok(!handler.includes('CategoryRepository'));
});

test('embed sin persistencia ni listado: la nota del stub enseña la variante de un elemento', () => {
  const { read } = scaffold();
  const handler = read(`${JAVA}/application/usecases/UpdateProductCommandHandler.java`);
  assert.ok(handler.includes('// Embed Category: CategoryRefDto = categoryRefResolver.resolve('));
});

test('embed en una operación paginada: la nota del stub prescribe el lote y prohíbe el findById en el stream', () => {
  const { read } = scaffold((layers) => {
    layers['use-cases'].operations.listProducts.output.embed = ['category'];
  });
  const handler = read(`${JAVA}/application/usecases/ListProductsQueryHandler.java`);

  assert.ok(handler.includes('private final CategoryRefResolver categoryRefResolver;'));
  assert.ok(handler.includes('resolver por LOTE'));
  assert.ok(handler.includes('categoryRefResolver.resolve(ids)'));
  assert.ok(handler.includes('NUNCA findById dentro del stream'));
});

test('sin embed no hay resolver ni findAllById: el scaffolding no se ensancha por si acaso', () => {
  const { exists, read } = scaffold((layers) => {
    for (const operation of Object.values(layers['use-cases'].operations)) {
      if (typeof operation.output === 'object' && operation.output?.embed) delete operation.output.embed;
    }
  });

  assert.ok(!exists(resolverPath('Category')));
  assert.ok(!read(`${JAVA}/domain/repository/CategoryRepository.java`).includes('findAllById'));
});
