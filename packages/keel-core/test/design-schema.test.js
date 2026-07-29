import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from '../src/lib/assets.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(fs.readFileSync(schemaPathFor('design'), 'utf8'))
);

const valid = {
  family: 'notifications',
  variant: 'multichannel',
  summary: 'Notificaciones multicanal con plantillas versionadas.',
  differsIn: 'Añade SMS y push sobre email, con outbox por canal.',
  maturity: 'reference',
  tags: ['email', 'sms', 'push'],
  author: 'keel-system',
  license: 'Apache-2.0',
  requires: ['catalog']
};

const errorsFor = (doc) => (validate(doc) ? [] : validate.errors);

test('un sidecar completo valida', () => {
  assert.deepEqual(errorsFor(valid), []);
});

test('summary y maturity son obligatorios; el resto es opcional', () => {
  assert.deepEqual(errorsFor({ summary: valid.summary, maturity: 'draft' }), []);
  assert.ok(errorsFor({ maturity: 'draft' }).some((error) => error.params.missingProperty === 'summary'));
  assert.ok(errorsFor({ summary: valid.summary }).some((error) => error.params.missingProperty === 'maturity'));
});

test('maturity solo admite los tres estados definidos', () => {
  for (const maturity of ['draft', 'stable', 'reference']) {
    assert.deepEqual(errorsFor({ ...valid, maturity }), [], maturity);
  }
  assert.ok(errorsFor({ ...valid, maturity: 'produccion' }).some((error) => error.keyword === 'enum'));
});

test('family, variant, tags y requires van en kebab-case', () => {
  for (const bad of [{ family: 'Notifications' }, { variant: 'multi_channel' }, { tags: ['Email'] }, { requires: ['Catalog'] }]) {
    assert.ok(errorsFor({ ...valid, ...bad }).length > 0, JSON.stringify(bad));
  }
});

test('los campos desconocidos se rechazan: el sidecar no es un cajón de sastre', () => {
  const errors = errorsFor({ ...valid, precio: 42 });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].keyword, 'additionalProperties');
  assert.equal(errors[0].params.additionalProperty, 'precio');
});

test('summary y differsIn exigen una frase, no una palabra suelta', () => {
  assert.ok(errorsFor({ ...valid, summary: 'corto' }).some((error) => error.keyword === 'minLength'));
  assert.ok(errorsFor({ ...valid, differsIn: 'nada' }).some((error) => error.keyword === 'minLength'));
});

test('tags no admite duplicados ni lista vacía', () => {
  assert.ok(errorsFor({ ...valid, tags: ['email', 'email'] }).some((error) => error.keyword === 'uniqueItems'));
  assert.ok(errorsFor({ ...valid, tags: [] }).some((error) => error.keyword === 'minItems'));
});

test('el schema declara el $id del DSL y prohíbe propiedades extra', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPathFor('design'), 'utf8'));

  assert.equal(schema.$id, 'https://keel.dev/schema/2.0/design.schema.json');
  assert.equal(schema.additionalProperties, false);
});
