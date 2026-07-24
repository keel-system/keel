import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { accessAuthority, buildModel, sharedExceptionFor } from '../src/lib/model.js';

test('accessAuthority: scopes como authorities SCOPE_ y mezclas', () => {
  assert.equal(accessAuthority({ level: 'service', scopes: ['product:read'] }), 'hasAnyAuthority("SCOPE_product:read")');
  assert.equal(accessAuthority({ level: 'service' }), 'authenticated()');
  assert.equal(
    accessAuthority({ level: 'required', scopes: ['product:read'], roles: ['catalog-admin'] }),
    'hasAnyAuthority("ROLE_catalog-admin", "SCOPE_product:read")'
  );
  // sin scopes, el mapeo previo se conserva (retrocompatibilidad)
  assert.equal(accessAuthority({ level: 'required', permissions: ['product:write'] }), 'hasAnyAuthority("product:write")');
  assert.equal(accessAuthority({ level: 'admin', roles: ['admin'] }), 'hasAnyRole("admin")');
});

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');

function loadModel() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  return buildModel({ manifest, layers });
}

test('service: paquete base, artifactId y clase de aplicación', () => {
  const model = loadModel();
  assert.equal(model.service.basePackage, 'com.commerce.productcatalog');
  assert.equal(model.service.projectName, 'product-catalog-spring');
  assert.equal(model.service.applicationClass, 'ProductCatalogApplication');
  assert.equal(model.layersPresent.persistence, true);
  assert.equal(model.layersPresent.messaging, false);
});

test('enums: nominal ProductStatus con literales preservados', () => {
  const model = loadModel();
  const status = model.enums.find((e) => e.name === 'ProductStatus');
  assert.ok(status);
  assert.deepEqual(status.values, [
    { constant: 'DRAFT', literal: 'draft' },
    { constant: 'ACTIVE', literal: 'active' },
    { constant: 'RETIRED', literal: 'retired' }
  ]);
});

test('value objects: Money compuesto y embeddable con persistence', () => {
  const model = loadModel();
  const money = model.valueObjects.find((v) => v.name === 'Money');
  assert.ok(money);
  assert.equal(money.embeddable, true);
  assert.equal(money.fields.find((f) => f.name === 'amount').javaType, 'BigDecimal');
});

test('entidad Product: tabla, id, aplanado de SKU, lifecycle y sensitive', () => {
  const model = loadModel();
  const product = model.entities.find((e) => e.name === 'Product');
  assert.equal(product.tableName, 'products');
  assert.equal(product.persisted, true);
  assert.equal(product.idField.name, 'id');
  assert.equal(product.idField.initializer, 'UUID.randomUUID()');

  const sku = product.fields.find((f) => f.name === 'sku');
  assert.equal(sku.javaType, 'String'); // value type escalar aplanado
  assert.ok(sku.columns.some((c) => c.includes('unique = true')));

  const status = product.fields.find((f) => f.name === 'status');
  assert.equal(status.javaType, 'ProductStatus');
  assert.equal(status.initializer, 'ProductStatus.DRAFT');

  assert.equal(product.lifecycle.enumType, 'ProductStatus');
  assert.deepEqual(product.lifecycle.transitions.find((t) => t.from === 'RETIRED').to, []);
  assert.deepEqual(product.naturalKey, ['sku']);
});

test('operaciones: DTOs derivados, rutas CRUD y endpoint explícito', () => {
  const model = loadModel();
  const productService = model.services.find((s) => s.entity === 'Product');
  assert.equal(productService.className, 'ProductService');

  const create = productService.operations.find((o) => o.name === 'createProduct');
  assert.deepEqual(create.route, { method: 'POST', path: '/products', status: 201, audience: 'users' });
  const bodyFieldNames = create.bodyFields.map((f) => f.name);
  assert.ok(!bodyFieldNames.includes('id')); // id generado fuera del input
  assert.ok(bodyFieldNames.includes('apiToken')); // sensitive sí entra en input
  assert.equal(create.responseDto.name, 'CreateProductResponseDto');
  assert.equal(create.responseDto.entity, 'Product');
  const responseFieldNames = create.responseDto.fields.map((f) => f.name);
  assert.ok(!responseFieldNames.includes('apiToken')); // sensitive fuera del output

  const get = productService.operations.find((o) => o.name === 'getProduct');
  assert.deepEqual(get.route, { method: 'GET', path: '/products/{id}', status: 200, audience: 'users' });
  assert.equal(get.hasIdParam, true);
  assert.deepEqual(get.bodyFields, []); // el único campo del input era id → va por path

  const list = productService.operations.find((o) => o.name === 'listProducts');
  assert.equal(list.paginated, true);
  assert.deepEqual(list.route, { method: 'GET', path: '/products', status: 200, audience: 'users' });

  const retire = productService.operations.find((o) => o.name === 'retireProduct');
  assert.deepEqual(retire.route, { method: 'POST', path: '/products/{id}/retire', status: 204, audience: 'users' });
});

test('errores deduplicados con clase de excepción, http y subclase shared', () => {
  const model = loadModel();
  const codes = model.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['PRODUCT_ALREADY_RETIRED', 'PRODUCT_NOT_FOUND', 'SKU_ALREADY_EXISTS']);
  const notFound = model.errors.find((e) => e.code === 'PRODUCT_NOT_FOUND');
  assert.equal(notFound.exceptionClass, 'ProductNotFoundError'); // naming del prototipo
  assert.equal(notFound.http, 404);
  assert.equal(notFound.sharedException, 'NotFoundException');
  const conflict = model.errors.find((e) => e.code === 'SKU_ALREADY_EXISTS');
  assert.equal(conflict.sharedException, 'ConflictException');
});

test('sharedExceptionFor: subclase por status y DomainException para extendidos', () => {
  assert.equal(sharedExceptionFor(404), 'NotFoundException');
  assert.equal(sharedExceptionFor(422), 'BusinessException');
  assert.equal(sharedExceptionFor(429), 'DomainException');
});

test('mensajes CQRS por operación: Query, ReturningCommand y Command', () => {
  const model = loadModel();
  const operations = model.services.flatMap((s) => s.operations);
  const create = operations.find((o) => o.name === 'createProduct');
  assert.equal(create.messageKind, 'returningCommand');
  assert.equal(create.messageClass, 'CreateProductCommand');
  assert.equal(create.handlerClass, 'CreateProductCommandHandler');
  const get = operations.find((o) => o.name === 'getProduct');
  assert.equal(get.messageKind, 'query');
  assert.equal(get.messageClass, 'GetProductQuery');
  assert.equal(get.handlerClass, 'GetProductQueryHandler');
  const retire = operations.find((o) => o.name === 'retireProduct');
  assert.equal(retire.messageKind, 'command');
  assert.equal(retire.messageClass, 'RetireProductCommand');
});

test('paginación de la capa api', () => {
  const model = loadModel();
  assert.equal(model.pagination.defaultSize, 20);
});

test('ruta base versionada y controller V1 por grupo', () => {
  const model = loadModel();
  assert.equal(model.api.routeBase, '/api/v1'); // basePath del diseño + /v1
  const productService = model.services.find((s) => s.entity === 'Product');
  assert.equal(productService.controllerClass, 'ProductV1Controller');
  assert.equal(productService.controllerPackage, 'infrastructure.rest.controllers.product.v1');
});

// Carga el fixture y le aplica un parche de capas (+ las declara en el manifiesto),
// para probar capas que el fixture compartido no trae.
function loadModelWithLayers(patch) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patchedManifest = structuredClone(manifest);
  const patched = structuredClone(layers);
  for (const [name, value] of Object.entries(patch)) {
    patchedManifest.layers[name] = `${name}.keel.yaml`;
    patched[name] = value === null ? patched[name] : { ...(patched[name] ?? {}), ...value };
  }
  return buildModel({ manifest: patchedManifest, layers: patched });
}

test('routeBase: se versiona una sola vez aunque el basePath ya traiga versión', () => {
  // El diseño no versiona: build añade /v1 (comportamiento histórico).
  assert.equal(loadModelWithLayers({ api: { basePath: '/api' } }).api.routeBase, '/api/v1');
  // El diseño ya versiona: se respeta tal cual (antes salía /api/v1/v1).
  assert.equal(loadModelWithLayers({ api: { basePath: '/api/v1' } }).api.routeBase, '/api/v1');
  assert.equal(loadModelWithLayers({ api: { basePath: '/api/v2' } }).api.routeBase, '/api/v2');
  // Una versión en medio de la ruta no es la versión del recurso: se versiona igual.
  assert.equal(loadModelWithLayers({ api: { basePath: '/v1/api' } }).api.routeBase, '/v1/api/v1');
});

// ─── security: audiencia por ruta y roleGrants ────────────────────────────────

const SECURITY_LAYER = {
  authentication: {
    protocol: 'oidc',
    serviceAuth: { protocol: 'client-credentials', validateAudience: true, audience: 'catalog-api' }
  },
  roleGrants: { 'catalog-admin': ['product:write'] },
  access: {
    default: { level: 'required' },
    rules: {
      listProducts: { level: 'public' },
      createProduct: { level: 'required', permissions: ['product:write'] },
      retireProduct: { level: 'service', scopes: ['product:write'] }
    }
  }
};

test('security: cada matcher lleva la audiencia de su endpoint', () => {
  const model = loadModelWithLayers({
    api: { defaultAudience: 'users', endpoints: { retireProduct: { method: 'POST', path: '/products/{id}/retire', successStatus: 204, audience: 'services' } } },
    security: SECURITY_LAYER
  });

  const byPath = Object.fromEntries(model.security.matchers.map((m) => [m.path, m.audience]));
  assert.equal(byPath['/api/v1/products'], 'users'); // default de la capa api
  assert.equal(byPath['/api/v1/products/{id}/retire'], 'services'); // audience propia
});

test('security: defaultAudience gobierna también las rutas derivadas por auto', () => {
  const model = loadModelWithLayers({ api: { defaultAudience: 'services' }, security: SECURITY_LAYER });
  assert.ok(model.security.matchers.every((m) => m.audience === 'services'));
});

test('security: roleGrants del diseño llega al modelo, sin roles vacíos', () => {
  const model = loadModelWithLayers({
    security: { ...SECURITY_LAYER, roleGrants: { 'catalog-admin': ['product:write', 'category:write'], viewer: [] } }
  });
  assert.deepEqual(model.security.roleGrants, [
    { role: 'catalog-admin', permissions: ['product:write', 'category:write'] }
  ]);
});

// ─── storage: política por bucket ─────────────────────────────────────────────

test('storage: buckets con visibility, tamaño y content-types; maxSizeMb es el mayor', () => {
  const model = loadModelWithLayers({
    storage: {
      buckets: {
        productImages: { visibility: 'public', allowedContentTypes: ['image/png'], maxSizeMb: 5 },
        invoices: { allowedContentTypes: ['application/pdf'], maxSizeMb: 20 }
      }
    }
  });

  assert.equal(model.storage.maxSizeMb, 20);
  assert.equal(model.storage.hasPublicBucket, true);
  const invoices = model.storage.buckets.find((b) => b.name === 'invoices');
  assert.equal(invoices.visibility, 'private'); // default del schema
  assert.deepEqual(invoices.allowedContentTypes, ['application/pdf']);
});

test('storage: sin la capa, el modelo no la inventa', () => {
  assert.equal(loadModel().storage, null);
});

// ─── aggregates.entities: relación raíz → entidad interna ─────────────────────

// Diseño mínimo con un agregado que declara una entidad interna; `relations`
// se inyecta desde el test para cubrir el caso explícito.
function modelWithInternalEntity(productRelations) {
  const manifest = { keel: '2.0', service: { name: 'catalog', version: '0.1.0' }, layers: {} };
  const layers = {
    domain: {
      entities: {
        Product: {
          description: 'Producto.',
          fields: { id: { type: 'uuid', id: true }, name: { type: 'string' } },
          ...(productRelations ? { relations: productRelations } : {})
        },
        ProductImage: {
          description: 'Imagen del producto.',
          fields: { id: { type: 'uuid', id: true }, storageKey: { type: 'string' } }
        }
      },
      aggregates: { Product: { root: 'Product', entities: ['ProductImage'] } }
    },
    'use-cases': { operations: {} },
    persistence: { entities: { Product: {}, ProductImage: {} } }
  };
  return buildModel({ manifest, layers });
}

test('aggregates.entities: sin relations explícita, la relación raíz → interna se deriva', () => {
  const model = modelWithInternalEntity(null);
  const product = model.entities.find((e) => e.name === 'Product');

  assert.deepEqual(product.relations, [
    { name: 'productImages', entity: 'ProductImage', cardinality: 'one-to-many', required: false, internal: true, implicit: true }
  ]);
  // La entidad interna sigue sin ser raíz de agregado (no lleva repository propio).
  assert.equal(model.entities.find((e) => e.name === 'ProductImage').isAggregateRoot, false);
  // Y se avisa, para que el diseñador pueda declararla si quiere otro nombre.
  assert.ok(model.warnings.some((w) => w.includes('ProductImage') && w.includes('Product.productImages')));
});

test('aggregates.entities: con relations explícita no se duplica la relación', () => {
  const model = modelWithInternalEntity({ images: { entity: 'ProductImage', cardinality: 'one-to-many' } });
  const product = model.entities.find((e) => e.name === 'Product');

  assert.equal(product.relations.length, 1);
  assert.equal(product.relations[0].name, 'images'); // el nombre del diseño, no el derivado
  assert.equal(product.relations[0].implicit, undefined);
  assert.deepEqual(model.warnings, []);
});

// ─── http-clients: contrato estructurado, legacy en prosa y auth saliente ─────

function loadModelWithHttpClients(httpClients) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';
  const patched = structuredClone(layers);
  patched['http-clients'] = httpClients;
  return buildModel({ manifest: patchedManifest, layers: patched });
}

test('http-clients estructurado: method/path del diseño ganan a la prosa y los fields se tipan', () => {
  const model = loadModelWithHttpClients({
    clients: {
      'pricing-service': {
        purpose: 'Precios vigentes.',
        auth: { type: 'api-key' },
        calls: {
          getPrice: {
            contract: 'POST /otra-ruta (prosa contradictoria: ganan los campos estructurados)',
            method: 'GET',
            path: '/prices/{sku}',
            request: {
              pathParams: { sku: { type: 'uuid', required: true } },
              queryParams: { currency: { type: 'string' } }
            },
            response: { fields: { amount: { type: 'decimal', required: true } } }
          }
        }
      }
    }
  });

  assert.deepEqual(model.warnings, []);
  const [client] = model.httpClients;
  assert.equal(client.adapterClass, 'PricingServiceHttpAdapter');
  assert.equal(client.mapperClass, 'PricingServiceMapper');
  const [call] = client.calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/prices/{sku}');
  assert.equal(call.typed, true);
  assert.equal(call.resultType, 'GetPriceResult');
  assert.equal(call.pathParams[0].javaType, 'UUID');
  assert.equal(call.queryParams[0].javaType, 'String');
  assert.equal(call.responseFields[0].javaType, 'BigDecimal');
  assert.equal(call.requestType, null); // sin body no hay wire request
  assert.deepEqual(client.auth, {
    type: 'api-key',
    headerName: 'X-Api-Key',
    tokenUrl: null,
    scopes: [],
    propertyPrefix: 'http-clients.pricing-service.auth',
    registrationId: 'pricing-service'
  });
});

test('http-clients solo-prosa: salida legacy intacta (regresión)', () => {
  const model = loadModelWithHttpClients({
    clients: {
      'pricing-service': {
        purpose: 'Precios vigentes.',
        calls: { getPrice: { contract: 'GET /prices/{sku} -> { amount: decimal }' } }
      }
    }
  });
  const [client] = model.httpClients;
  assert.equal(client.auth, null);
  const [call] = client.calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/prices/{sku}');
  assert.deepEqual(call.pathVars, ['sku']);
  assert.equal(call.typed, false);
  assert.equal(call.pathParams[0].javaType, 'String'); // legacy: sin tipado
  assert.equal(call.hasBody, false);
  assert.deepEqual(model.warnings, []);
});

test('http-clients oauth2: normalización de auth y enums inline registrados', () => {
  const model = loadModelWithHttpClients({
    clients: {
      'payment-gateway': {
        purpose: 'Cobros con tarjeta.',
        auth: { type: 'oauth2-client-credentials', tokenUrl: 'https://auth.example.com/token', scopes: ['payments:write'] },
        calls: {
          charge: {
            contract: 'Autoriza un cobro.',
            method: 'POST',
            path: '/charges',
            request: { body: { amount: { type: 'decimal', required: true } } },
            response: { fields: { status: { type: 'enum', values: ['approved', 'declined'] } } }
          }
        }
      }
    }
  });
  const [client] = model.httpClients;
  assert.equal(client.auth.type, 'oauth2-client-credentials');
  assert.equal(client.auth.tokenUrl, 'https://auth.example.com/token');
  assert.deepEqual(client.auth.scopes, ['payments:write']);
  const [call] = client.calls;
  assert.equal(call.requestType, 'ChargeRequest');
  assert.equal(call.hasBody, true);
  // El enum inline de la respuesta existe como clase generable.
  assert.ok(model.enums.some((e) => e.name === 'ChargeResponseStatus'));
  assert.equal(call.responseFields[0].javaType, 'ChargeResponseStatus');
});

// ─── exclude con dot-path: lo plano lo aplica build, lo anidado se avisa ──────

// Dominio con una relación a hija (lines → OrderLine) y un value object compuesto
// (address → Address): los dos casos que el DTO plano del scaffolding no puede recortar.
function loadModelWithExclude(exclude) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patchedManifest = structuredClone(manifest);
  delete patchedManifest.layers.api;
  delete patchedManifest.layers.persistence;
  const patched = structuredClone(layers);
  delete patched.api;
  delete patched.persistence;
  patched.domain = {
    types: { Address: { fields: { zip: { type: 'string' }, city: { type: 'string' } } } },
    entities: {
      Order: {
        fields: {
          id: { type: 'uuid', id: true, generated: true },
          reference: { type: 'string', required: true },
          internalNote: { type: 'string' },
          address: { type: 'Address' }
        },
        relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } }
      },
      OrderLine: {
        fields: { id: { type: 'uuid', id: true, generated: true }, costPrice: { type: 'decimal' } }
      }
    }
  };
  patched['use-cases'] = {
    operations: {
      getOrder: {
        description: 'Recupera un pedido con sus lineas de detalle.',
        kind: 'query',
        input: { fields: { id: { type: 'uuid', required: true } } },
        output: { entity: 'Order', ...(exclude ? { exclude } : {}) }
      }
    }
  };
  const model = buildModel({ manifest: patchedManifest, layers: patched });
  const operation = model.services.flatMap((s) => s.operations).find((o) => o.name === 'getOrder');
  return { model, operation, dtoFields: (operation.responseDto?.fields ?? []).map((f) => f.name) };
}

test('exclude plano: build lo aplica al DTO y no avisa', () => {
  const { model, dtoFields } = loadModelWithExclude(['internalNote']);
  assert.ok(!dtoFields.includes('internalNote'));
  assert.deepEqual(dtoFields, ['id', 'reference', 'address']);
  assert.deepEqual(model.warnings.filter((w) => w.includes('exclude')), []);
});

test('exclude sin dot-path no añade warnings (retrocompatibilidad)', () => {
  const { model, dtoFields } = loadModelWithExclude(null);
  assert.deepEqual(dtoFields, ['id', 'reference', 'internalNote', 'address']);
  assert.deepEqual(model.warnings.filter((w) => w.includes('exclude')), []);
});

test('exclude con dot-path hacia una relación: avisa y deja el DTO raíz intacto', () => {
  const { model, dtoFields } = loadModelWithExclude(['lines.costPrice']);
  // El DTO plano no contiene la relación, así que no hay nada que recortar aquí.
  assert.deepEqual(dtoFields, ['id', 'reference', 'internalNote', 'address']);
  assert.ok(
    model.warnings.some(
      (w) =>
        w.includes(`exclude 'lines.costPrice' de Order`) &&
        w.includes(`no genera el DTO anidado de la relación 'lines'`) &&
        w.includes(`sin 'costPrice'`)
    ),
    `warnings: ${JSON.stringify(model.warnings)}`
  );
});

test('exclude con dot-path hacia un value object: avisa de que el VO sale entero', () => {
  const { model, dtoFields } = loadModelWithExclude(['address.zip']);
  // El value object entra al DTO como su record completo: build no puede quitarle un subcampo.
  assert.ok(dtoFields.includes('address'));
  assert.ok(
    model.warnings.some(
      (w) =>
        w.includes(`exclude 'address.zip' de Order`) &&
        w.includes(`el value object 'Address' sale entero`) &&
        w.includes(`recortar 'zip'`)
    ),
    `warnings: ${JSON.stringify(model.warnings)}`
  );
});

test('exclude combina plano y dot-paths: aplica el plano y avisa de cada anidado', () => {
  const { model, dtoFields } = loadModelWithExclude(['internalNote', 'lines.costPrice', 'address.zip']);
  assert.deepEqual(dtoFields, ['id', 'reference', 'address']);
  assert.equal(model.warnings.filter((w) => w.includes('exclude')).length, 2);
});
