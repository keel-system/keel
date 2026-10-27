// Los parámetros de DESPLIEGUE del servicio (DSL 2.15) en keel-dotnet: hasta el incremento 10c se ignoraban en silencio
// —ni código ni aviso—, y el rescate de job-dispatch lee su plazo de uno.
//
//   · el fragmento de cada perfil es el de keel-nest byte a byte y dice lo mismo que el de keel-spring;
//   · ServiceParametersRegistration lee la clave `<artifactId>.<key>` de cada parámetro, y Program.cs lo registra antes que
//     nada;
//   · el value object de dominio rechaza el valor ausente y el que rompe sus cotas con las frases de keel-spring: lo
//     EJECUTA la prueba emitida ServiceParametersTests en `npm run cs-check`; aquí se mira que la traiga.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

for (const name of ['job-dispatch', 'catalog-extended', 'payment-checkout']) {
  test(`${name}: el fragmento de cada perfil es el de keel-nest y dice lo de keel-spring; el registro lee sus claves`, () => {
    const { model, files } = plan(name);
    const nest = plan(name, planNest).files;
    const spring = plan(name, planSpring).files;
    const fragment = `${model.service.artifactId}.yaml`;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const file = `config/parameters/${profile}/${fragment}`;
      assert.equal(content(files, file), content(nest, file), file);
      assert.deepEqual(parseYaml(content(files, file)), parseYaml(content(spring, `parameters/${profile}/${fragment}`)), profile);
    }
    const registration = content(files, 'Config/ServiceParametersRegistration.cs');
    for (const parameter of model.service.parameters) assert.ok(registration.includes(`"${model.service.artifactId}:${parameter.key}"`), parameter.key);
  });
}

test('el value object valida al construirse con las frases de keel-spring, y la prueba emitida lo ejecuta', () => {
  const jobs = plan('job-dispatch').files;
  const domain = content(jobs, 'Parameters/JobDispatchParameters.cs');
  assert.ok(domain.includes("Falta el parámetro de despliegue 'abandon-after-minutes' (variable JOB_DISPATCH_ABANDON_AFTER_MINUTES)."));
  assert.ok(domain.includes("El parámetro 'abandon-after-minutes' está fuera del rango declarado."));
  const tests = content(jobs, 'UnitTests/ServiceParametersTests.cs');
  assert.match(tests, /new JobDispatchParameters\(null\)/);
  assert.match(tests, /new JobDispatchParameters\(0\)/);
  const catalog = content(plan('catalog-extended').files, 'UnitTests/ServiceParametersTests.cs');
  assert.ok(catalog.includes("El parámetro 'currency' no respeta su formato declarado."));
  assert.match(catalog, /new CatalogParameters\("!"\)/);
});

test('los parámetros se registran antes que nada en Program.cs, y sin ellos no se emite nada', () => {
  const program = content(plan('job-dispatch').files, 'Api/Program.cs');
  assert.ok(program.indexOf('AddServiceParameters(configuration)') < program.indexOf('AddUseCases()'));
  assert.ok(program.indexOf('AddServiceParameters(configuration)') > program.indexOf('AddSingleton(configuration)'));
  const without = plan('product-catalog').files;
  assert.ok(!without.some((file) => /Parameters\/\w+Parameters\.cs$|ServiceParametersRegistration/.test(file.path)));
  assert.doesNotMatch(content(without, 'Api/Program.cs'), /AddServiceParameters/);
});
