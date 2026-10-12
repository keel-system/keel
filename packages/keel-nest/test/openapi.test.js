// El `openapi.yaml` DERIVADO del modelo neutral (keel-core/gen/openapi.js): el mismo documento para el servidor de
// keel-spring y el de keel-nest, porque los dos sirven ese contrato. Lo pidieron tres corridas seguidas (el agente de
// pruebas deducía la forma de cada respuesta y no podía asertar en STRICT).
//
// Tres oráculos, ninguno escrito para este test: el documento de los dos generadores es el MISMO byte a byte; la
// tabla de rutas que EJECUTA keel-nest (`ROUTES`) y sus DTO dicen lo mismo que el documento; y la comprobación de
// coherencia que ya tenía el diseño (`CHK-DOCS-OPENAPI-DRIFT`) no le encuentra deriva.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadService } from 'keel-core';
import { checkDerivedCoherence } from '../../keel-core/src/lib/derived-coherence.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const DOC = 'docs/openapi.yaml';

/** Los campos de una clase de DTO de keel-nest, en orden (como contract-parity). */
function nestDtoFields(files, name) {
  const fileName = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const file = files.find((f) => f.path === `src/application/dtos/${fileName}.ts`);
  if (!file) return null;
  return [...file.content.split('  constructor(')[0].matchAll(/^ {2}readonly (\w+):/gm)].map((m) => m[1]);
}

/** Resuelve todos los $ref del documento: uno que no apunta a nada es un contrato roto. */
function danglingRefs(document) {
  const missing = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.replace('#/components/schemas/', '');
      if (!document.components?.schemas?.[name]) missing.push(value.$ref);
    }
    Object.values(value).forEach(walk);
  };
  walk(document);
  return missing;
}

for (const name of fs.readdirSync(FIXTURES_DIR)) {
  test(`${name}: el openapi derivado es el mismo en los dos generadores y casa con lo que sirve keel-nest`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
    const nest = planFixture(name);
    const fromSpring = spring.files.find((f) => f.path === DOC)?.content;
    const fromNest = nest.files.find((f) => f.path === DOC)?.content;
    const routed = nest.model.services.flatMap((s) => s.operations).filter((op) => op.route);
    if (!nest.model.layersPresent.api || routed.length === 0) {
      assert.equal(fromNest, undefined, 'sin API no hay contrato');
      assert.equal(fromSpring, undefined);
      return;
    }
    assert.ok(fromNest, 'keel-nest escribe docs/openapi.yaml');
    assert.equal(fromSpring, fromNest, 'el mismo contrato en los dos generadores');

    const document = YAML.parse(fromNest);
    assert.equal(document.openapi, '3.1.0');
    assert.equal(document.info.version, manifest.service.version);
    assert.deepEqual(danglingRefs(document), [], 'todo $ref apunta a un esquema');

    // Oráculo 1: la tabla de rutas EJECUTADA de keel-nest.
    const { ROUTES } = await transpileTree(nest.files).load('src/infrastructure/rest/routes.ts');
    for (const route of ROUTES) {
      const op = document.paths[route.path]?.[route.method.toLowerCase()];
      assert.ok(op, `${route.operation}: ${route.method} ${route.path} está en el contrato`);
      assert.equal(op.operationId, route.operation);
      assert.ok(op.responses[String(route.status)], `${route.operation}: status ${route.status}`);
      assert.equal(Boolean(op.responses[String(route.status)].headers?.Location), route.location, `${route.operation}: Location`);
      const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name).sort();
      assert.deepEqual(query, [...route.query].sort(), `${route.operation}: parámetros de query`);
      const multipart = Boolean(op.requestBody?.content?.['multipart/form-data']);
      if (!multipart) {
        const body = op.requestBody ? (op.requestBody.required ? 'required' : 'optional') : null;
        assert.equal(body, route.body, `${route.operation}: cuerpo`);
      }
      const operation = routed.find((candidate) => candidate.name === route.operation);
      if (operation.responseDto && route.status !== 204) {
        const schema = document.components.schemas[operation.responseDto.name];
        assert.deepEqual(Object.keys(schema.properties), nestDtoFields(nest.files, operation.responseDto.name), `${operation.responseDto.name}: campos y orden`);
      }
    }

    // Oráculo 2: la coherencia con el diseño que ya comprobaba keel validate sobre un openapi de /keel-docs.
    const docsDir = tmpDir('keel-openapi-');
    fs.writeFileSync(path.join(docsDir, 'openapi.yaml'), fromNest);
    const { findings } = checkDerivedCoherence({ layers: { api: layers.api, 'use-cases': layers['use-cases'], domain: layers.domain }, manifest, docsDir });
    assert.deepEqual(findings.filter((finding) => finding.id === 'CHK-DOCS-OPENAPI-DRIFT').map((finding) => finding.message), []);
  });
}

test('asset-vault: la ficha lleva owner como OwnerRefDto, revisions como lista, y los nulos según el contrato', () => {
  const { files } = planFixture('asset-vault', { stack: { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak' } });
  const document = YAML.parse(files.find((f) => f.path === DOC).content);
  // uploadAsset embebe owner; getAsset no (su respuesta se cachea y el diseño se lo quita): lleva ownerId.
  assert.deepEqual(document.components.schemas.UploadAssetResponseDto.properties.owner, { $ref: '#/components/schemas/OwnerRefDto' });
  const card = document.components.schemas.GetAssetResponseDto;
  assert.equal(card.properties.owner, undefined);
  assert.equal(card.properties.ownerId.format, 'uuid');
  assert.equal(card.properties.revisions.type, 'array', 'una lista nunca es null: sale []');
  assert.deepEqual(card.properties.lastScannedAt.type, ['string', 'null']);
  assert.equal(card.properties.sizeBytes.format, 'int64');
  assert.equal(card.additionalProperties, false);
  // La seguridad: la regla de la ruta, con el esquema del protocolo.
  assert.deepEqual(document.paths['/api/v1/assets/{id}'].get.security, [{ bearerAuth: [] }]);
  assert.ok(document.paths['/api/v1/assets'].post.responses['413'], 'la subida declara el 413 del framework');
});

test('si el workspace trae el openapi de /keel-docs, build copia ese y no deriva otro', () => {
  const workspace = tmpDir('keel-openapi-docs-');
  fs.cpSync(path.join(FIXTURES_DIR, 'asset-vault'), path.join(workspace, 'specs', 'asset-vault'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs', 'asset-vault'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'asset-vault', 'openapi.yaml'), 'openapi: 3.1.0\n');
  const { manifest, layers } = loadService(path.join(workspace, 'specs', 'asset-vault'));
  const { files } = planSpring({ manifest, layers, workspace });
  assert.equal(files.find((f) => f.path === DOC), undefined);
});
