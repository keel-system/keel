// El dato que una operación PIDE a otro servidor (`dependencies.needs`, tramo 13h) sobre el texto emitido de keel-go: bajo
// demanda, con el último valor conocido y replicado, y la concesión OAuth2 de un cliente. Lo que EJECUTA el Go —el fallback, el
// almacén, la concesión contra un emisor falso— lo mide la prueba emitida clients_test.go en `go-check`, falsada con los
// sabotajes de test/helpers/needs-sabotages.js; la réplica contra el motor, `npm run db-check -- --only=catalog-extended`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { httpClientsYaml } from '@keel-system/keel-core/gen/http-clients-config';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  if (mutate) mutate(layers, manifest);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'kafka' } });
}

const catalog = plan('catalog-extended');
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
const handler = (files, name) => content(files, `internal/application/${name}.go`);

test('catalog-extended entra entero en la frontera', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
});

test('el handler del usedBy recibe el cliente y la nota del need; los demás handlers no', () => {
  const { files, model } = catalog;
  const text = handler(files, 'get_product_by_slug_query_handler');
  assert.match(text, /pricingClient domain\.PricingClient/);
  assert.match(text, /legacyErpClient domain\.LegacyErpClient/);
  const notes = flat(text);
  assert.match(notes, /Dependencia pricing\.currentPrice \(on-demand\)/);
  assert.match(notes, /pide el dato con h\.pricingClient\.GetPrice\(ctx, \.\.\.\), que ya devuelve el resultado de dominio \(domain\.GetPriceResult\)/);
  assert.match(notes, /el fallback del adaptador ya aplica onUnavailable: lastKnown/);
  assert.match(notes, /El dato SALE en la respuesta: la función de mapeo pide un CurrentPriceDto/);
  // Ni el cliente en una operación que no lo pide (salvo por una activación).
  const users = new Set(['getProductBySlug']);
  for (const operation of model.services.flatMap((service) => service.operations).filter((candidate) => !users.has(candidate.name))) {
    const other = files.find((file) => file.path.endsWith(`/${operation.handlerClass.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}.go`));
    if (other) assert.doesNotMatch(other.content, /PricingClient/, operation.name);
  }
});

test('degrade deja en el fallback el TODO con el degradedTo del diseño, en un archivo sin la cabecera', () => {
  const text = content(catalog.files, 'clients/legacy_erp_fallback.go');
  assert.match(text, /Política declarada por el need legacy-erp\.productCost \(onUnavailable: degrade\)/);
  assert.match(flat(text), /La ficha se devuelve sin coste de aprovisionamiento/);
  assert.match(text, /TODO \(agente\)/);
  assert.doesNotMatch(text, /Code generated/);
});

test('fail devuelve el error del diseño desde el fallback, y la prueba emitida lo afirma', () => {
  const failing = plan('catalog-extended', (layers) => {
    layers.dependencies.dependencies['legacy-erp'].needs.productCost.onUnavailable = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
  });
  const text = content(failing.files, 'clients/legacy_erp_fallback.go');
  assert.match(text, /domain\.Errorf\(domain\.ErrPriceUnavailable, "legacy-erp no está disponible para productCost"\)/);
  assert.doesNotMatch(text, /TODO \(agente\)/);
  assert.match(content(failing.files, 'clients/clients_test.go'), /func TestLegacyErpHTTPAdapterGetCostConElProveedorCaidoDevuelveElErrorDelDiseno/);
});

test('lastKnown: el adaptador recuerda en el camino feliz y el fallback sirve dentro de la ventana y se rinde', () => {
  const adapter = content(catalog.files, 'clients/pricing_adapter.go');
  assert.match(adapter, /a\.lastKnown\.Remember\("getPrice", LastKnownKey\(sku\), result\)/);
  const fallback = content(catalog.files, 'clients/pricing_fallback.go');
  assert.match(fallback, /Recall\[domain\.GetPriceResult\]\(a\.lastKnown, "getPrice", LastKnownKey\(sku\), 900\*time\.Second\)/);
  assert.match(fallback, /remembered\.Stale = true/);
  assert.match(fallback, /domain\.ErrPriceUnavailable/);
  assert.match(content(catalog.files, 'internal/domain/pricing_client.go'), /Stale\s+bool/);
  assert.match(content(catalog.files, 'clients/last_known.go'), /const maxLastKnownEntries = 10000/);
  assert.match(content(catalog.files, 'clients/clients_test.go'), /SirveElUltimoValorConocidoDentroDeSuVentanaYDespuesSeRinde/);
  // Uno por proceso, lo comparten los adaptadores que lo sirven; los demás no lo reciben.
  const server = content(catalog.files, 'cmd/server/main.go');
  assert.match(server, /lastKnown := clients\.NewLastKnownValues\(nil\)/);
  assert.match(server, /NewPricingHTTPAdapter\(clientSettings, exchange, logger, lastKnown\)/);
  assert.match(server, /NewLegacyErpHTTPAdapter\(clientSettings, exchange, logger\)/);
});

test('OAuth2: el token se pide antes de cada intento, y lee las MISMAS claves que los otros tres', () => {
  const settings = content(catalog.files, 'clients/settings.go');
  assert.match(settings, /grantOf\(value, "partner-catalog", "[\w.-]+", \[\]string\{"catalog\.write"\}/);
  assert.match(content(catalog.files, 'clients/exchange.go'), /client\.Authorization\(ctx\)/);
  assert.match(content(catalog.files, 'clients/partner_catalog_adapter.go'), /KindAuthGrant/);
  const yaml = httpClientsYaml(catalog.model, 'develop');
  assert.match(yaml, /client-id: \$\{PARTNER_CATALOG_CLIENT_ID/);
  const prefix = /grantOf\(value, "partner-catalog", "([\w.-]+)"/.exec(settings)[1];
  assert.ok(yaml.includes(prefix.split('.').at(-1)), `${prefix} tiene que ser una clave de http-clients.yaml`);
  // Un cliente sin concesión no recibe el fallo de la concesión en su lista.
  assert.doesNotMatch(content(catalog.files, 'clients/pricing_adapter.go'), /KindAuthGrant/);
  assert.equal(content(plan('stock-reservation').files, 'clients/client_credentials.go'), undefined);
});

test('el proyector crea y actualiza la copia sin TODO y descarta el hecho anterior o igual', () => {
  const projector = content(catalog.files, 'application/supplier_price_projector.go');
  assert.match(projector, /Code generated/);
  assert.doesNotMatch(projector, /TODO/);
  assert.match(projector, /p\.repository\.FindBySku\(ctx, snapshot\.Sku\)/);
  assert.match(projector, /if !snapshot\.OccurredAt\.After\(existing\.OccurredAt\(\)\) \{\s+return nil/);
  assert.match(projector, /ID:\s+existing\.ID\(\)/);
  assert.match(projector, /LockVersion: existing\.LockVersion\(\)/);
  assert.match(projector, /ID:\s+uuid\.Must\(uuid\.NewV7\(\)\)/);
});

test('el lector aplica onMiss fetch con la hydrate del agente, en su archivo, y lee por lote para los listados', () => {
  const reader = content(catalog.files, 'application/supplier_price_reader.go');
  assert.match(reader, /Code generated/);
  assert.doesNotMatch(reader, /TODO/);
  assert.match(reader, /return r\.hydrate\(ctx, sku\)/);
  assert.match(reader, /func \(r \*SupplierPriceReader\) ByKeys\(ctx context\.Context, skus \[\]string\) \(map\[string\]\*domain\.SupplierPrice, error\)/);
  assert.match(reader, /r\.repository\.FindAllBySkuIn\(ctx, skus\)/);
  const hydrate = content(catalog.files, 'application/supplier_price_hydrate.go');
  assert.doesNotMatch(hydrate, /Code generated/);
  assert.match(hydrate, /TODO \(agente\): invoca r\.pricingClient\.GetPrice/);
});

test('onMiss fail y degrade: el error del diseño, o decir que no está', () => {
  const failing = plan('catalog-extended', (layers) => {
    layers.dependencies.dependencies.pricing.needs.supplierPrice.replica.onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
  });
  const reader = content(failing.files, 'application/supplier_price_reader.go');
  assert.match(reader, /domain\.Errorf\(domain\.ErrPriceUnavailable/);
  assert.equal(content(failing.files, 'application/supplier_price_hydrate.go'), undefined);
  const degrading = plan('catalog-extended', (layers) => {
    layers.dependencies.dependencies.pricing.needs.supplierPrice.replica.onMiss = { action: 'degrade', degradedTo: 'sin precio de proveedor' };
  });
  assert.match(flat(content(degrading.files, 'application/supplier_price_reader.go')), /entonces el servicio DEGRADA: sin precio de proveedor/);
});

test('el Save de la réplica abre su PROPIA transacción; el de las demás raíces, no', () => {
  const adapter = content(catalog.files, 'postgres/supplier_price_repository.go');
  assert.match(adapter, /err := r\.tx\.apart\(ctx, sql\.TxOptions\{\}, func\(q DBTX\) error \{/);
  assert.doesNotMatch(content(catalog.files, 'postgres/product_repository.go'), /r\.tx\.apart/);
  assert.match(content(catalog.files, 'postgres/transactions.go'), /func \(t \*Transactions\) apart\(/);
});

test('el handler del usedBy recibe el lector con su nota y no el repositorio de la réplica; la proyección, el proyector', () => {
  const list = handler(catalog.files, 'list_products_query_handler');
  assert.match(list, /supplierPriceReader \*SupplierPriceReader/);
  assert.doesNotMatch(list, /supplierPriceRepository/);
  assert.doesNotMatch(list, /pricingClient/);
  const notes = flat(list);
  assert.match(notes, /lee SupplierPrice con h\.supplierPriceReader\.ByKey\(ctx, \.\.\.\), que ya aplica onMiss: fetch/);
  assert.match(notes, /lee la página entera con h\.supplierPriceReader\.ByKeys/);
  const project = handler(catalog.files, 'project_supplier_price_command_handler');
  assert.match(project, /supplierPriceProjector \*SupplierPriceProjector/);
  assert.match(flat(project), /aplica el estado que informa el evento con h\.supplierPriceProjector\.Apply\(ctx, SupplierPriceSnapshot\{\.\.\.\}\)/);
  const wiring = content(catalog.files, 'application/use_cases.go');
  assert.match(wiring, /NewSupplierPriceReader\(deps\.SupplierPriceRepository, deps\.PricingClient\)/);
  assert.match(wiring, /NewSupplierPriceProjector\(deps\.SupplierPriceRepository\)/);
});

test('la réplica sobre documentos se rechaza con su motivo', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  layers.persistence.default = { ...layers.persistence.default, model: 'document' };
  assert.match(checkSupportedFeatures(manifest, layers).errors.join('\n'), /supplierPrice\): la réplica sobre documentos/);
});
