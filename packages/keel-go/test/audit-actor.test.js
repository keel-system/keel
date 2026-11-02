// La AUTORÍA que emite keel-go (tramo 13g), sin Go y sin base. Lo que solo se ve ejecutando lo miden la prueba emitida
// `audit_actor_test.go` (en go-check) y la sonda de autoría de db-check y doc-check, falsadas con sus sabotajes:
//   · el actor va en UN archivo del paquete del almacén y con lo que el servicio tiene (seguridad, correlación);
//   · sin autoría no se emite, y `createdAuthor` solo con un createdBy declarado (en Go una función sin usar es un hallazgo);
//   · la declarada se estampa en los dos modelos, en la raíz y en las hijas, y `created_by` no entra en el UPDATE;
//   · el centinela es el de keel-core, y la frontera rechaza lo que el adaptador no sabe estampar.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { SYSTEM_ACTOR } from '@keel-system/keel-core/gen/relational';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { AUTHORSHIP_DESIGNS, FIXTURES_DIR, makeWorkspace } from './helpers/workspace.js';

const workspace = makeWorkspace();

function plan(name, stack = null) {
  const design = AUTHORSHIP_DESIGNS.find((candidate) => candidate.name === name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design?.from ?? name));
  design?.mutate(manifest, layers);
  return planService({ manifest, layers, workspace, ...(stack ? { stack } : {}) }).files;
}

const contentOf = (files, suffix) => files.filter((file) => file.path.endsWith(suffix)).map((file) => file.content).join('\n');

test('con seguridad, el actor es el sub del token y después el nombre del principal; la prueba emitida los recorre', () => {
  const files = plan('shop-api');
  const actor = contentOf(files, 'postgres/audit_actor.go');
  assert.match(actor, /security\.PrincipalFrom\(ctx\)/);
  assert.match(actor, /security\.ClaimText\(principal\.Claims, "sub"\)/);
  assert.ok(actor.indexOf('"sub"') < actor.indexOf('principal.Name'), 'el sub va antes que el nombre');
  assert.match(actor, new RegExp(`const systemActor = "${SYSTEM_ACTOR}"`));
  const emitted = contentOf(files, 'postgres/audit_actor_test.go');
  for (const name of ['ConUnTokenEsElSujetoNoElNombre', 'ConUnTokenSinSujetoEsElNombre', 'ConUnaClaveDeAPIEsElCliente', 'SinPrincipalEsElSistemaConLaCorrelacion', 'SinPrincipalNiCorrelacionEsElSistema']) {
    assert.match(emitted, new RegExp(`func TestAuditActor${name}\\(`));
  }
});

test('sin seguridad no hay principal: el sistema con la correlación, y el archivo no importa el paquete de seguridad', () => {
  const files = plan('product-catalog-authorship');
  const actor = contentOf(files, 'postgres/audit_actor.go');
  assert.doesNotMatch(actor, /internal\/platform\/security/);
  assert.match(actor, /correlation\.ID\(ctx\)/);
  assert.doesNotMatch(contentOf(files, 'postgres/audit_actor_test.go'), /security\./);
});

test('sin autoría no se emite el actor, y el almacén ya no lo declara por su cuenta', () => {
  assert.equal(plan('product-catalog').some((file) => file.path.endsWith('audit_actor.go')), false);
  for (const name of ['shop-api', 'product-catalog-authorship', 'mailer-author', 'mailer-mongo-author']) {
    const files = plan(name);
    const declarations = files.filter((file) => /^func auditActor\(/m.test(file.content)).map((file) => file.path);
    assert.equal(declarations.length, 1, `${name}: ${declarations.join(', ')}`);
    assert.match(declarations[0], /audit_actor\.go$/);
  }
});

test('createdAuthor solo existe con un createdBy declarado', () => {
  assert.doesNotMatch(contentOf(plan('product-catalog-authorship'), 'audit_actor.go'), /createdAuthor/);
  assert.match(contentOf(plan('mailer-author'), 'audit_actor.go'), /func createdAuthor\(/);
});

for (const database of ['postgresql', 'mysql']) {
  test(`la autoría declarada se estampa en la raíz y en la hija sobre ${database}, y created_by no entra en el UPDATE`, () => {
    const adapter = contentOf(plan('mailer-author', { database }), 'template_repository.go');
    assert.equal(adapter.match(/actor := auditActor\(ctx\)/g).length, 2, 'la raíz y la hija');
    assert.equal(adapter.match(/createdAuthor\(e\.CreatedBy\(\), actor\)/g).length, 2);
    assert.doesNotMatch(adapter, /e\.UpdatedBy\(\)/);
    for (const statement of adapter.match(/"UPDATE templates SET [^"]*"/g)) assert.doesNotMatch(statement, /created_by/);
  });
}

test('sobre documentos, el encoder lleva el actor solo con autoría declarada', () => {
  const declared = plan('mailer-mongo-author');
  const adapter = contentOf(declared, 'mongo/template_repository.go');
  assert.match(adapter, /e := &encoder\{actor: auditActor\(ctx\)\}/);
  assert.equal(adapter.match(/createdAuthor\(x\.CreatedBy\(\), e\.actor\)/g).length, 2, 'la raíz y la hija');
  assert.equal(adapter.match(/Key: "updated_by", Value: e\.actor/g).length, 2);
  assert.match(contentOf(declared, 'mongo/bson_values.go'), /\tactor string/);
  const without = plan('notification-mailer-mongo');
  assert.doesNotMatch(contentOf(without, 'mongo/bson_values.go'), /actor string/);
  assert.match(contentOf(without, 'mongo/template_repository.go'), /e := &encoder\{\}/);
});

test('la frontera rechaza una autoría declarada que el adaptador no sabe estampar, y acepta la generada', () => {
  const load = (mutate) => {
    const design = AUTHORSHIP_DESIGNS.find((candidate) => candidate.name === 'mailer-author');
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
    design.mutate(manifest, layers);
    mutate?.(layers);
    return checkSupportedFeatures(manifest, layers).errors.filter((error) => error.includes('autoría declarada'));
  };
  assert.deepEqual(load(), []);
  const optional = load((layers) => {
    layers.domain.entities.Template.fields.createdBy = { type: 'string' };
  });
  assert.equal(optional.length, 1);
  assert.match(optional[0], /Template\.fields\.createdBy/);
  const typed = load((layers) => {
    layers.domain.entities.Template.fields.updatedBy = { type: 'uuid', generated: true };
  });
  assert.equal(typed.length, 1);
  assert.match(typed[0], /Template\.fields\.updatedBy/);
});
