// La autorización por propietario (`security.ownership`, DSL 2.23) en los TRES generadores: la nota del handler es
// neutral (keel-core/gen/ownership.js) y solo cambia cómo se lee el campo del llamante en cada lenguaje. Sujeto: la
// fixture conduit, recuperada de RealWorld por keel-recover, donde «solo el autor edita o borra» fue frontera hasta 2.23.
// Aquí vive la comparación de los tres porque keel-core no importa de los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planDotnet } from '../src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR, fixtureNames, variantStack } from './helpers/workspace.js';

const plan = (generator, name) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: variantStack(layers) }).files;
};
// Las notas salen partidas en líneas de comentario (`//`, ` * `): se leen como un solo texto.
const flat = (text) => (text ?? '').replace(/\s*\n\s*(?:\/\/\/?|\*(?!\/)|#)?\s*/g, ' ');
const content = (files, suffix) => flat(files.find((file) => file.path.endsWith(suffix))?.content);
const NOTE = /Propiedad \(security\.ownership\.(\w+)\)/g;

test('conduit: la nota de propiedad, con el camino al dueño y el code, en los handlers de los tres', () => {
  const handlers = {
    dotnet: ['UseCases/UpdateArticleCommandHandler.cs', 'UseCases/DeleteCommentCommandHandler.cs', 'command.CallerSubject'],
    nest: ['usecases/update-article-command-handler.ts', 'usecases/delete-comment-command-handler.ts', 'command.callerSubject'],
    spring: ['UpdateArticleCommandHandler.java', 'DeleteCommentCommandHandler.java', 'command.callerSubject()']
  };
  const generators = { dotnet: planDotnet, nest: planNest, spring: planSpring };
  for (const [name, [article, comment, read]] of Object.entries(handlers)) {
    const files = plan(generators[name], 'conduit');
    const update = content(files, article);
    const remove = content(files, comment);
    assert.ok(update.includes('Propiedad (security.ownership.Article)'), `${name}: ${article}`);
    assert.ok(update.includes(`sigue author hasta subject (author.subject) y compáralo con ${read}`), `${name}: el camino y el campo del llamante`);
    assert.ok(update.includes('NOT_ARTICLE_AUTHOR (403)'), `${name}: el code del rechazo`);
    assert.ok(remove.includes('Propiedad (security.ownership.Comment)') && remove.includes('NOT_COMMENT_AUTHOR (403)'), `${name}: ${comment}`);
  }
});

test('la nota sale en las operaciones que nombra ownership y solo en esas, en los tres', () => {
  for (const name of fixtureNames()) {
    const noted = (generator) =>
      plan(generator, name)
        .flatMap((file) => [...flat(file.content).matchAll(NOTE)].map((m) => `${path.basename(file.path).replace(/[-.].*$/, '').toLowerCase()}:${m[1]}`))
        .sort();
    // shop-api (recuperado de un legacy) acota por propietario el pedido y el perfil, con exentos en el pedido.
    const EXPECTED = {
      conduit: ['deletearticlecommandhandler:Article', 'deletecommentcommandhandler:Comment', 'updatearticlecommandhandler:Article'],
      'shop-api': ['cancelordercommandhandler:OrderMain', 'getorderqueryhandler:OrderMain', 'getprofilequeryhandler:User', 'updateprofilecommandhandler:User']
    };
    const expected = EXPECTED[name] ?? [];
    assert.deepEqual(noted(planDotnet), expected, `${name} (keel-dotnet)`);
    assert.deepEqual(noted(planSpring), expected, `${name} (keel-spring)`);
    // keel-nest nombra sus archivos en kebab-case: el basename se corta en el primer guion.
    assert.deepEqual(
      noted(planNest),
      expected.map((entry) => entry.replace(/^(delete|update|cancel|get)[a-z]*(command|query)handler/, '$1')).sort(),
      `${name} (keel-nest)`
    );
  }
});

// La misma corrida destapó el humo de la API: con `access.default: required`, sin roles ni clientes, la regla de cierre
// solo la satisface una persona autenticada, y el humo pedía sin token (401 donde esperaba 404). keel-spring no tiene
// ese caso de humo.
test('conduit: el humo de la API pide con una persona (tokenAs) en keel-dotnet y en keel-nest', () => {
  const dotnet = content(plan(planDotnet, 'conduit'), 'HarnessSmoke.cs');
  assert.ok(dotnet.includes('Bearer(await TokenAs("keel-smoke"))'), 'keel-dotnet');
  const nest = plan(planNest, 'conduit').find((file) => file.path.endsWith('harness-smoke.test.ts'))?.content ?? '';
  assert.match(nest, /\.\.\.bearer\(await tokenAs\('keel-smoke'\)\)/, 'keel-nest');
  assert.match(nest, /import \{[^}]*\btokenAs\b[^}]*\} from '\.\/support\/flow\.js';/, 'keel-nest importa tokenAs');
});
