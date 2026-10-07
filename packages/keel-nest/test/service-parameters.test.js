// Los parámetros de DESPLIEGUE del servicio (DSL 2.15) en keel-nest: hasta el incremento 10c se
// ignoraban en silencio —ni código ni aviso—, y el rescate de job-dispatch lee su plazo de uno.
//
//   · el fragmento de cada perfil dice lo mismo que el de keel-spring (clave, variable y gradiente);
//   · el value object de dominio, EJECUTADO: rechaza el valor ausente y el que rompe sus cotas con los
//     mensajes de keel-spring, y acepta el bueno;
//   · el módulo lee la clave `<artifactId>.<key>` de cada parámetro y se registra antes que nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { SERVICE_PARAMETERS_MODULE_TS, parametersClass, parametersPath } from '../src/scaffold/service-parameters.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

function spring(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
}

for (const name of ['job-dispatch', 'catalog-extended', 'payment-checkout']) {
  test(`${name}: el fragmento de cada perfil es el de keel-spring`, () => {
    const { model, files } = planFixture(name, { stack: STACK });
    const theirs = spring(name);
    const fragment = `${model.service.artifactId}.yaml`;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const ours = parseYaml(content(files, `config/parameters/${profile}/${fragment}`));
      const reference = parseYaml(content(theirs, `parameters/${profile}/${fragment}`));
      assert.deepEqual(ours, reference, profile);
    }
    // Y el módulo lee exactamente esas claves.
    const module = content(files, SERVICE_PARAMETERS_MODULE_TS);
    for (const parameter of model.service.parameters) assert.ok(module.includes(`'${model.service.artifactId}.${parameter.key}'`), parameter.key);
  });
}

test('el value object valida al construirse: ausente, fuera de rango y con el formato roto no arrancan', async () => {
  const jobs = planFixture('job-dispatch', { stack: STACK });
  const Jobs = (await transpileTree(jobs.files).load(parametersPath(jobs.model)))[parametersClass(jobs.model)];
  assert.equal(new Jobs(5).abandonAfterMinutes, 5);
  assert.throws(() => new Jobs(null), /Falta el parámetro de despliegue 'abandon-after-minutes' \(variable JOB_DISPATCH_ABANDON_AFTER_MINUTES\)/);
  assert.throws(() => new Jobs(0), /'abandon-after-minutes' está fuera del rango declarado/);

  const catalog = planFixture('catalog-extended', { stack: STACK });
  const Catalog = (await transpileTree(catalog.files).load(parametersPath(catalog.model)))[parametersClass(catalog.model)];
  assert.equal(new Catalog('EUR').currency, 'EUR');
  assert.throws(() => new Catalog('eur'), /'currency' no respeta su formato declarado/);
  assert.throws(() => new Catalog('EURO'), /'currency' no respeta su formato declarado/);
});

test('los parámetros se registran antes que nada en el módulo raíz, y sin ellos no se emite nada', () => {
  const { files } = planFixture('job-dispatch', { stack: STACK });
  assert.match(content(files, 'src/app.module.ts'), /imports: \[ServiceParametersModule\.register\(configuration\), /);
  const without = planFixture('product-catalog', { stack: STACK }).files;
  assert.ok(!without.some((file) => file.path === SERVICE_PARAMETERS_MODULE_TS));
  assert.doesNotMatch(content(without, 'src/app.module.ts'), /ServiceParametersModule/);
});
