// La clave única GLOBAL de una hija (keel-core/gen/internal-unique.js): `ExistsBy<Campo>` en el puerto de la raíz y en
// sus dos adaptadores, sobre los sujetos de keel-core/test/helpers/internal-unique-designs.js. Nació de la corrida
// payment-dotnet (2026-11-27): el agente escribió `ExistsByRefundRequestId` a mano en el puerto y el adaptador generados.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';
import { INTERNAL_UNIQUE_DESIGNS } from '../../keel-core/test/helpers/internal-unique-designs.js';

const planOf = (design) =>
  planFixture(design.from, {
    mutate(manifest, layers) {
      manifest.service.name = design.name;
      design.mutate(layers);
    }
  });
const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

test('relacional: el puerto de la raíz pregunta por la clave de la hija sobre su tabla', async () => {
  const { files } = await planOf(INTERNAL_UNIQUE_DESIGNS[0]);
  assert.match(fileOf(files, 'Repository/ITemplateRepository.cs'), /Task<bool> ExistsByCode\(string code, CancellationToken cancellationToken = default\);/);
  assert.match(
    fileOf(files, 'Repositories/TemplateRepository.cs'),
    /public Task<bool> ExistsByCode\(string code, CancellationToken cancellationToken = default\)\n {4}\{\n {8}return db\.Set<TemplateVariableRow>\(\)\.AsNoTracking\(\)\.AnyAsync\(r => r\.Code == code, cancellationToken\);/
  );
});

test('documental: la consulta baja al array embebido de las hijas', async () => {
  const { files } = await planOf(INTERNAL_UNIQUE_DESIGNS[1]);
  assert.match(fileOf(files, 'Repository/ITemplateRepository.cs'), /Task<bool> ExistsByCode\(string code/);
  assert.match(fileOf(files, 'Repositories/TemplateRepository.cs'), /Find\(new BsonDocument\("variables\.code", BsonValues\.Of\(code\)\)\)\.Limit\(1\)\.AnyAsync\(cancellationToken\);/);
});

test('sin la clave, el puerto de la fixture no cambia', async () => {
  const { files } = await planFixture('notification-mailer');
  assert.doesNotMatch(fileOf(files, 'Repository/ITemplateRepository.cs'), /ExistsBy/);
});
