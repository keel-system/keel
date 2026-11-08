// Los plazos de negocio en keel-dotnet (DSL 2.26, incremento 5 de PLAN-DSL-226-PLAZOS.md).
//
// Lo que se EJECUTA contra el motor lo miden `db-check` (verification-codes) y `doc-check` (verification-codes-mongo),
// con los casos DL-1 a DL-10 y R1 y los sabotajes dl-*. Aquí, sin red ni SDK: que el gate de lo que escribe el agente
// nazca ROJO y se ponga VERDE (el bash se ejecuta, no se compara), la paridad con lo que EMITE keel-spring —las sentencias
// de keel-core tal cual, el mismo `timer.yaml` por perfil y las mismas notas— y que un motor sin sentencias medidas se
// rechace con su motivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { timerStatements } from '@keel-system/keel-core/gen/timer-store';
import { deadlineHandlerNote } from '@keel-system/keel-core/gen/deadlines';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { csString } from '../src/scaffold/render.js';
import { timerStackErrors } from '../src/scaffold/timer.js';
import { planFixture, FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

function writeTree(files) {
  const dir = tmpDir('keel-dotnet-deadlines-');
  for (const file of files) {
    if (typeof file.content !== 'string') continue;
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

function patch(dir, suffix, from, to) {
  const walk = (root) =>
    fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]));
  const file = walk(path.join(dir, 'src')).find((candidate) => candidate.replaceAll('\\', '/').endsWith(suffix));
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `el parche no aplica en ${suffix}`);
  fs.writeFileSync(file, after);
}

function gate(dir) {
  try {
    return { code: 0, out: execFileSync('bash', ['infra/check-deadlines.sh'], { cwd: dir, encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}` };
  }
}

for (const [fixture, database] of [['verification-codes', 'postgresql'], ['verification-codes-mongo', 'mongodb']]) {
  test(`${fixture}: check-deadlines.sh nace rojo y se pone verde con lo que escribe el agente`, async () => {
    const { files } = await planFixture(fixture, { stack: { database } });
    const dir = writeTree(files);
    const fresh = gate(dir);
    assert.equal(fresh.code, 1, fresh.out);
    assert.match(fresh.out, /sigue siendo el stub/);
    assert.match(fresh.out, /la entidad no aplica la caducidad/);
    assert.match(fresh.out, /verifyCode: no le da al dominio la hora/);

    // Lo que escribiría el agente: el método semántico, el handler de expireCode y la hora en verifyCode.
    patch(dir, '/Aggregate/VerificationCode.cs', '    public Guid Id { get; private set; }', '    public void Expire() => TransitionTo(CodeStatus.Expired);\n\n    public Guid Id { get; private set; }');
    patch(dir, '/ExpireCodeCommandHandler.cs', 'throw new NotImplementedException("TODO: expireCode");', 'return verificationCodeRepository.Save(null!, cancellationToken);');
    patch(dir, '/VerifyCodeCommandHandler.cs', 'throw new NotImplementedException("TODO: verifyCode");', 'var now = timeProvider.GetUtcNow();\n        throw new InvalidOperationException(now.ToString());');
    const done = gate(dir);
    assert.equal(done.code, 0, done.out);

    // Y la hora de la instancia leída en el sitio vuelve a ponerlo rojo.
    patch(dir, '/VerifyCodeCommandHandler.cs', 'var now = timeProvider.GetUtcNow();', 'var now = DateTimeOffset.UtcNow;');
    const late = gate(dir);
    assert.equal(late.code, 1, late.out);
    assert.match(late.out, /lee la hora de la instancia/);
  });
}

for (const database of ['postgresql', 'mysql']) {
  test(`${database}: el almacén emite las sentencias de keel-core tal cual`, async () => {
    const { files } = await planFixture('verification-codes', { stack: { database } });
    const store = files.find((file) => file.path.endsWith('/Timers/TimerStore.cs')).content;
    // `fire` y `age` son del arnés (adelantan y envejecen un temporizador), no del almacén del servidor.
    const serverStatements = Object.entries(timerStatements(database)).filter(([name]) => name !== 'fire' && name !== 'age');
    for (const [name, sql] of serverStatements) assert.ok(store.includes(csString(sql)), `${database}: falta la sentencia ${name}`);
  });
}

test('el timer.yaml de cada perfil es el mismo que emite keel-spring', async () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  const spring = planSpring({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-dotnet-spring-plan-'), stack: { database: 'postgresql' } }).files;
  const { files } = await planFixture('verification-codes', { stack: { database: 'postgresql' } });
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const ours = files.find((file) => file.path === `config/parameters/${profile}/timer.yaml`)?.content;
    const theirs = spring.find((file) => file.path === `src/main/resources/parameters/${profile}/timer.yaml`)?.content;
    assert.ok(ours, `${profile}: keel-dotnet no emite timer.yaml`);
    assert.equal(ours, theirs, `${profile}: timer.yaml distinto del de keel-spring`);
  }
});

test('la nota del handler que caduca es la neutral, la misma que en keel-spring', async () => {
  const { files, model } = await planFixture('verification-codes', { stack: { database: 'postgresql' } });
  const expire = files.find((file) => file.path.endsWith('/ExpireCodeCommandHandler.cs')).content;
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'expireCode');
  const note = deadlineHandlerNote(model, operation);
  // La nota viaja partida en líneas de comentario: se compara sin los saltos ni los prefijos.
  const flat = expire.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(flat.includes(note), 'la nota del handler de expireCode no es la neutral');
});

test('un motor sin las sentencias del cronómetro medidas se rechaza, con su motivo', async () => {
  const { model } = await planFixture('verification-codes', { stack: { database: 'postgresql' } });
  assert.deepEqual(timerStackErrors(model), []);
  const [error] = timerStackErrors({ ...model, stack: { ...model.stack, database: 'mariadb' } });
  assert.match(error, /no tiene sentencias medidas para 'mariadb'/);
});
