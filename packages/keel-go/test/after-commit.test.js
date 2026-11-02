// «Después de confirmar» en keel-go: el asentamiento en toda operación con persistencia, con caché o sin ella, y el puerto
// del almacenamiento en todo comando. La corrida catalog (2026-11-02) no pudo cumplir la regla «el binario se borra tras
// confirmar» de removeProductImage sin ninguna de las dos cosas. Lo que EJECUTA el Go (cuándo corre el efecto) lo mide la
// prueba emitida after_commit_test.go en `npm run go-check`, falsada con los sabotajes after-commit-*.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const plan = (name) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR });
};
const content = (files, file) => files.find((candidate) => candidate.path === file)?.content;

test('con persistencia y sin caché, toda operación va dentro de settle y se emite afterCommit', () => {
  const { files } = plan('product-catalog');
  const wiring = content(files, 'internal/application/use_cases.go');
  const useCases = wiring.split('\n').filter((line) => /^\tuc\.\w+ = /.test(line));
  assert.ok(useCases.length > 0);
  for (const line of useCases) assert.match(line, /= settle(Command)?\(logger, observe(Command)?\(logger, tx, /, line);
  assert.match(content(files, 'internal/application/after_commit.go'), /^func afterCommit\(ctx context\.Context, effect func\(context\.Context\) error\) \{$/m);
  assert.ok(content(files, 'internal/application/after_commit_test.go'));
});

test('el asentamiento vive en un solo sitio, tenga el diseño caché o no', () => {
  const { files } = plan('catalog-extended');
  assert.match(content(files, 'internal/application/after_commit.go'), /^func settle\[/m);
  assert.doesNotMatch(content(files, 'internal/application/operation_cache.go'), /^func settle|^type settlement/m);
});

test('removeProductImage, un comando que no sube ni devuelve una URL, recibe el puerto del almacenamiento', () => {
  const { files } = plan('catalog-extended');
  const wiring = content(files, 'internal/application/use_cases.go').split('\n').find((line) => line.includes('NewRemoveProductImageCommandHandler('));
  assert.ok(wiring.includes('deps.FileStorage'), wiring);
  const handler = content(files, 'internal/application/remove_product_image_command_handler.go');
  assert.match(handler, /fileStorage domain\.FileStorage/);
  assert.match(handler, /Un borrado «tras confirmar» va por afterCommit/);
});

test('la constitución y la skill de S3 enseñan afterCommit, y lo que enseñan existe', () => {
  const { files } = plan('catalog-extended');
  const constitution = files.find((file) => file.path === 'docs/keel/constitution.md').content;
  assert.match(constitution, /afterCommit\(ctx, func\(ctx context\.Context\) error/);
  assert.match(constitution, /internal\/application\/after_commit\.go/);
  assert.ok(content(files, 'internal/application/after_commit.go'));
});
