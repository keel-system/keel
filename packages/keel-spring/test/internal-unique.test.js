// La clave única GLOBAL de una hija (keel-core/gen/internal-unique.js): `existsBy<Campo>` en el puerto de la raíz, en
// Spring Data JPA (JPQL sobre la entidad de la hija) y en MongoDB (la ruta del array embebido), sobre los sujetos de
// keel-core/test/helpers/internal-unique-designs.js. Nació de la corrida payment-dotnet (2026-11-27).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { INTERNAL_UNIQUE_DESIGNS } from '../../keel-core/test/helpers/internal-unique-designs.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function planOf(design, document) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  manifest.service.name = design.name;
  design.mutate(layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } }).files;
}
const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

test('relacional: el puerto pregunta y el repositorio JPA consulta la entidad de la hija', () => {
  const files = planOf(INTERNAL_UNIQUE_DESIGNS[0], false);
  assert.match(fileOf(files, 'domain/repository/TemplateRepository.java'), /boolean existsByCode\(String code\);/);
  const jpa = fileOf(files, 'TemplateJpaRepository.java');
  assert.match(jpa, /@Query\("select case when count\(c\) > 0 then true else false end from TemplateVariableJpa c where c\.code = :code"\)\n {4}boolean existsByCode\(@Param\("code"\) String code\);/);
  assert.match(jpa, /import org\.springframework\.data\.repository\.query\.Param;/);
  assert.match(fileOf(files, 'TemplateRepositoryImpl.java'), /public boolean existsByCode\(String code\) \{\n {8}return \w+\.existsByCode\(code\);/);
});

test('documental: la consulta va por la ruta del array embebido', () => {
  const files = planOf(INTERNAL_UNIQUE_DESIGNS[1], true);
  assert.match(fileOf(files, 'domain/repository/TemplateRepository.java'), /boolean existsByCode\(String code\);/);
  assert.match(fileOf(files, 'TemplateMongoRepository.java'), /@Query\(value = "\{ 'variables\.code': \?0 \}", exists = true\)\n {4}boolean existsByCode\(String code\);/);
});
