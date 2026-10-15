// La identidad del llamante resuelta contra VARIAS credenciales del recurso (resolvedBy, adelantado al 12e), sin red: el
// finder por credencial con el nombre de keel-spring en el puerto y en los dos adaptadores, el resolutor registrado, el
// endpoint que resuelve ANTES de leer y el mensaje que admite null (la credencial puede no ser de nadie). Que el finder
// encuentre por una credencial que no es la primera lo miden db-check y doc-check contra el motor.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';
import { credentialFinders } from '../src/scaffold/repositories.js';

for (const name of ['notification-mailer', 'notification-mailer-mongo']) {
  const { files } = await planFixture(name);
  const find = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

  test(`${name}: el finder por credencial tiene el nombre de keel-spring, en el puerto y en el adaptador`, async () => {
    const spring = planSpring({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR }).files;
    const springNames = new Set(spring.flatMap((file) => (typeof file.content === 'string' ? file.content : '').match(/\bfind\w+Containing(?=\()/g) ?? []));
    const { model } = await planFixture(name);
    const application = model.entities.find((entity) => entity.name === 'Application');
    const ourNames = credentialFinders(model, application).map((finder) => finder.name);
    assert.ok(ourNames.length > 0, 'el diseño declara resolvedBy sobre Application');
    for (const ours of ourNames) {
      // El de keel-spring es el mismo nombre en camelCase.
      assert.ok(springNames.has(ours[0].toLowerCase() + ours.slice(1)), `keel-spring emite ${ours}`);
      assert.match(find('/Repository/IApplicationRepository.cs'), new RegExp(`Task<Application\\?> ${ours}\\(string `), `puerto: ${ours}`);
      assert.match(find('/Repositories/ApplicationRepository.cs'), new RegExp(`public async Task<Application\\?> ${ours}\\(`), `adaptador: ${ours}`);
    }
  });

  test(`${name}: el resolutor se registra y el endpoint resuelve la credencial DESPUÉS de validar la entrada (como keel-nest)`, () => {
    assert.match(find('/Security/CallerIdentityResolver.cs'), /FindByCredentialKeysContaining\(credential, cancellationToken\)/);
    assert.match(find('/Security/SecurityRegistration.cs'), /AddScoped<CallerIdentityResolver>\(\)/);
    const endpoints = files.filter((file) => /\/Endpoints\/\w+\.cs$/.test(file.path) && file.content.includes('resolvedCaller'));
    assert.ok(endpoints.length > 0, 'algún endpoint resuelve la identidad');
    for (const { content } of endpoints) {
      assert.match(content, /await Read\w+\(http\.Request, \(\) => http\.RequestServices\.GetRequiredService<CallerIdentityResolver>\(\)\.Resolve\(CallerIdentity\.Resolve\(\), http\.RequestAborted\)\)/);
      // Un uuid malformado es 400 sin tocar la base: la resolución va DESPUÉS de las comprobaciones de la entrada.
      for (const reader of content.split('private static async Task<').slice(1).filter((text) => text.includes('Func<Task<string?>> resolveCaller'))) {
        const body = reader.slice(0, reader.indexOf('\n    }'));
        const resolveAt = body.indexOf('await resolveCaller()');
        assert.ok(resolveAt > 0);
        assert.ok(!/ThrowIfAny\(\)/.test(body.slice(resolveAt)), 'ninguna comprobación después de resolver');
      }
      assert.doesNotMatch(content, /ApplicationKey = CallerIdentity\.Resolve\(\)/);
    }
  });

  test(`${name}: el campo de identidad del mensaje admite null y su nota nombra el finder`, () => {
    const messages = files.filter((file) => /\/(Commands|Queries)\/\w+\.cs$/.test(file.path) && /ApplicationKey \{ get; init; \}/.test(file.content));
    assert.ok(messages.length > 0);
    for (const { path: file, content } of messages) {
      if (!/Lo resuelve el servidor desde la credencial/.test(content)) continue;
      assert.match(content, /public required string\? ApplicationKey \{ get; init; \}/, file);
      assert.match(content, /IApplicationRepository\.FindByCredentialKeysContaining/, file);
    }
  });
}
