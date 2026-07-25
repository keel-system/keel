// Regresiones del informe de generación de catalog-spring: cada caso reproduce
// un bug determinista del scaffolding con la fixture catalog-extended (binding
// HTTP, status de éxito, paginación, payload de eventos, DTOs con relaciones,
// multipart, mapeo bidireccional, errores con status por operación, caché e
// infraestructura de validación).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
const JAVA = 'src/main/java/com/commerce/catalog';

function scaffoldExtended() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regression-'));
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  return { workspace, result, read };
}

const controllerPath = (group) => `${JAVA}/infrastructure/rest/controllers/${group}/v1/${group === 'product' ? 'Product' : 'ProductImage'}V1Controller.java`;

test('binding HTTP: un @PathVariable por segmento de la ruta declarada', () => {
  const { read } = scaffoldExtended();
  const product = read(controllerPath('product'));
  const image = read(controllerPath('productimage'));

  // {slug} es un path param aunque no se llame "id", y con el tipo del diseño.
  assert.ok(product.includes('getProductBySlug(@PathVariable String slug)'));
  assert.ok(!product.includes('@RequestParam String slug'));
  // Dos segmentos en la misma ruta, ambos ligados, y sin body en un DELETE.
  assert.ok(image.includes('removeProductImage(@PathVariable UUID productId, @PathVariable UUID imageId)'));
  assert.ok(!image.includes('@RequestBody RemoveProductImageCommand'));
});

test('binding HTTP: un POST con cuerpo usa @RequestBody aunque sea una query', () => {
  const { read } = scaffoldExtended();
  const product = read(controllerPath('product'));
  assert.ok(product.includes('@RequestBody GetProductsByIdsQuery'));
  assert.ok(!product.includes('@RequestParam List<UUID> ids'));
});

test('status de éxito: 201 solo al crear; un POST de transición responde 200', () => {
  const { read, result } = scaffoldExtended();
  const product = read(controllerPath('product'));
  const createBlock = product.slice(product.indexOf('@PostMapping("/products")'), product.indexOf('getProductBySlug'));
  const retireBlock = product.slice(product.indexOf('@PostMapping("/products/{id}/retire")'));

  assert.ok(createBlock.includes('@ResponseStatus(HttpStatus.CREATED)'));
  assert.ok(!retireBlock.includes('@ResponseStatus'));
  assert.ok(result.warnings.some((w) => w.includes("'retireProduct'") && w.includes('sin successStatus')));
});

test('paginación: PagedResponse<Dto> sin lista anidada', () => {
  const { read } = scaffoldExtended();
  const query = read(`${JAVA}/application/queries/ListProductsQuery.java`);
  const handler = read(`${JAVA}/application/usecases/ListProductsQueryHandler.java`);
  const controller = read(controllerPath('product'));

  assert.ok(query.includes('Query<PagedResponse<ListProductsResponseDto>>'));
  assert.ok(handler.includes('PagedResponse<ListProductsResponseDto> handle('));
  assert.ok(controller.includes('PagedResponse<ListProductsResponseDto> listProducts('));
  for (const content of [query, handler, controller]) assert.ok(!content.includes('PagedResponse<List<'));
});

test('eventos: el payload declarado se proyecta en el evento y en su gemelo de wire', () => {
  const { read } = scaffoldExtended();
  const domainEvent = read(`${JAVA}/domain/events/ProductCreatedEvent.java`);
  const integration = read(`${JAVA}/infrastructure/messaging/events/ProductCreatedIntegrationEvent.java`);

  assert.ok(domainEvent.includes('UUID productId, String sku, Instant occurredAt'));
  assert.ok(integration.includes('UUID productId, String sku, Instant occurredAt'));
});

test('DTOs: las relaciones entran — referencia por id y entidad hija como DTO propio', () => {
  const { read } = scaffoldExtended();
  const dto = read(`${JAVA}/application/dtos/CreateProductResponseDto.java`);
  const childDto = read(`${JAVA}/application/dtos/ProductImageDto.java`);
  const mapper = read(`${JAVA}/application/mappers/ProductApplicationMapper.java`);

  assert.ok(dto.includes('UUID categoryId'));
  assert.ok(dto.includes('List<ProductImageDto> images'));
  assert.ok(childDto.includes('public record ProductImageDto('));
  // La hija se mapea con su propio DTO, no con un null pendiente.
  assert.ok(mapper.includes('entity.getImages().stream().map(this::toProductImageDto).toList()'));
  assert.ok(mapper.includes('public ProductImageDto toProductImageDto(ProductImage entity)'));
});

test('campos file: endpoint multipart con MultipartFile y FileUpload en el mensaje', () => {
  const { read } = scaffoldExtended();
  const controller = read(controllerPath('productimage'));
  const command = read(`${JAVA}/application/commands/AddProductImageCommand.java`);

  assert.ok(controller.includes('consumes = MediaType.MULTIPART_FORM_DATA_VALUE'));
  assert.ok(controller.includes('@RequestPart(value = "image") MultipartFile image'));
  assert.ok(controller.includes('toFileUpload(image)'));
  assert.ok(command.includes('FileUpload image'));
  assert.ok(!command.includes('String image'));
});

test('relación bidireccional: mappedBy en la raíz y mapeo sin ciclo', () => {
  const { read } = scaffoldExtended();
  const parentJpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);
  const childJpa = read(`${JAVA}/infrastructure/persistence/entities/ProductImageJpa.java`);
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`);
  const childDomain = read(`${JAVA}/domain/entity/ProductImage.java`);

  // Un solo dueño de la FK: la hija.
  assert.ok(parentJpa.includes('@OneToMany(mappedBy = "product"'));
  assert.ok(childJpa.includes('@ManyToOne(optional = false)'));
  // El mapper de la hija no vuelve al padre; el vínculo lo estampa el padre.
  const childToJpa = adapter.slice(adapter.indexOf('private ProductImageJpa toJpa('));
  assert.ok(!childToJpa.includes('toJpa(domain.getProduct())'));
  assert.ok(adapter.includes('.forEach(child -> child.setProduct(jpa))'));
  // Y el dominio de la hija no arrastra la referencia al padre.
  assert.ok(!childDomain.includes('Product product'));
});

test('errores: un code con http distinto por operación recibe el status por constructor', () => {
  const { read, result } = scaffoldExtended();
  const shared = read(`${JAVA}/domain/errors/CategoryNotFoundError.java`);
  const single = read(`${JAVA}/domain/errors/ProductNotFoundError.java`);

  assert.ok(shared.includes('extends DomainException'));
  assert.ok(shared.includes('CategoryNotFoundError(String message, int httpStatus)'));
  assert.ok(result.warnings.some((w) => w.includes("Error 'CATEGORY_NOT_FOUND'") && w.includes('status distintos')));
  // El caso normal (un solo http) no cambia.
  assert.ok(single.includes('extends NotFoundException'));
  assert.ok(single.includes('"PRODUCT_NOT_FOUND", 404'));
});

test('caché: CacheConfig con JavaTimeModule, TTL del diseño y constante por caché', () => {
  const { read } = scaffoldExtended();
  const config = read(`${JAVA}/infrastructure/configurations/cache/CacheConfig.java`);

  assert.ok(config.includes('registerModule(new JavaTimeModule())'));
  assert.ok(config.includes('SerializationFeature.WRITE_DATES_AS_TIMESTAMPS'));
  assert.ok(config.includes('GET_PRODUCT_BY_SLUG_CACHE = "catalog:get-product-by-slug"'));
  assert.ok(config.includes('Duration.ofSeconds(300)'));
  assert.ok(config.includes('disableCachingNullValues()'));
  assert.ok(config.includes('CacheErrorHandler'));
});

test('infra: reset-db.sh borra también las claves de la caché del servicio', () => {
  const { read } = scaffoldExtended();
  const reset = read('infra/reset-db.sh');
  // El comando va entre comillas simples de bash: sq() reescribe las internas.
  assert.ok(reset.includes('redis-cli -h redis --scan --pattern '));
  assert.ok(reset.includes('catalog:*'));
  assert.ok(reset.includes('flyway_schema_history'));
});

test('infra: export-schema.sh verifica los nombres de constraint del diseño', () => {
  const { read } = scaffoldExtended();
  const script = read('infra/export-schema.sh');
  assert.ok(script.includes('uk_products_natural'));
  assert.ok(script.includes('AVISO: el DDL exportado no nombra estas constraints'));
});
