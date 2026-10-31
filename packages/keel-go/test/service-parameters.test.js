// Los parámetros de DESPLIEGUE del servicio (DSL 2.15) en keel-go: hasta el tramo 10c se ignoraban en silencio —ni código
// ni aviso—, y el rescate de job-dispatch lee su plazo de uno.
//
//   · el fragmento de cada perfil es el de keel-nest y keel-dotnet byte a byte y dice lo mismo que el de keel-spring;
//   · `parameters.From` lee la clave `<artifactId>.<key>` de cada parámetro, y el arranque lo llama antes que nada;
//   · el value object de dominio rechaza el valor ausente y el que rompe sus cotas con las frases de los otros tres (en
//     minúscula y sin punto, como pide Go a un error): lo EJECUTA su prueba emitida en `npm run go-check`; aquí se mira
//     que la traiga.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql' };
const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

for (const name of ['job-dispatch', 'job-dispatch-cycles']) {
  test(`${name}: el fragmento de cada perfil es el de keel-nest y keel-dotnet y dice lo de keel-spring; el lector lee sus claves`, () => {
    const { model, files } = plan(name);
    const nest = plan(name, planNest).files;
    const dotnet = plan(name, planDotnet).files;
    const spring = plan(name, planSpring).files;
    const fragment = `${model.service.artifactId}.yaml`;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const file = `config/parameters/${profile}/${fragment}`;
      assert.equal(content(files, file), content(nest, file), file);
      assert.equal(content(files, file), content(dotnet, file), file);
      assert.deepEqual(parseYaml(content(files, file)), parseYaml(content(spring, `parameters/${profile}/${fragment}`)), profile);
    }
    const reader = content(files, 'internal/infrastructure/parameters/parameters.go');
    for (const parameter of model.service.parameters) assert.ok(reader.includes(`"${model.service.artifactId}.${parameter.key}"`), parameter.key);
  });
}

test('el value object valida al construirse con las frases de los otros tres, y la prueba emitida lo ejecuta', () => {
  const jobs = plan('job-dispatch').files;
  const domain = content(jobs, 'internal/domain/job_dispatch_parameters.go');
  assert.ok(domain.includes(`errors.New("falta el parámetro de despliegue 'abandon-after-minutes' (variable JOB_DISPATCH_ABANDON_AFTER_MINUTES)")`));
  assert.ok(domain.includes(`errors.New("el parámetro 'abandon-after-minutes' está fuera del rango declarado")`));
  // Los campos sin exportar: solo se construye validado.
  assert.match(domain, /type JobDispatchParameters struct \{\n\tabandonAfterMinutes int32\n\}/);
  const tests = content(jobs, 'internal/domain/job_dispatch_parameters_test.go');
  assert.match(tests, /domain\.NewJobDispatchParameters\(nil\)/);
  assert.match(tests, /domain\.NewJobDispatchParameters\(ptr\(int32\(0\)\)\)/);
  // La rama del texto (pattern), sobre un diseño que keel-go aún rechaza por otras capas: el texto se emite igual.
  const catalog = plan('catalog-extended').files;
  assert.ok(content(catalog, 'internal/domain/catalog_parameters.go').includes('regexp.MustCompile("^(?:^[A-Z]{3}$)$")'));
  const catalogTests = content(catalog, 'internal/domain/catalog_parameters_test.go');
  assert.ok(catalogTests.includes(`"el parámetro 'currency' no respeta su formato declarado"`));
  assert.match(catalogTests, /domain\.NewCatalogParameters\(ptr\("!"\)\)/);
});

test('el arranque lee los parámetros antes que nada, y sin ellos no se emite nada', () => {
  const main = content(plan('job-dispatch').files, 'cmd/server/main.go');
  assert.ok(main.indexOf('config.Load(') < main.indexOf('serviceParameters, err := parameters.From(cfg)'));
  assert.ok(main.indexOf('serviceParameters, err := parameters.From(cfg)') < main.indexOf('SettingsFrom(cfg)'));
  const without = plan('product-catalog').files;
  assert.ok(!without.some((file) => /_parameters(_test)?\.go$|infrastructure\/parameters\//.test(file.path)));
  assert.doesNotMatch(content(without, 'cmd/server/main.go'), /parameters\.From/);
});
