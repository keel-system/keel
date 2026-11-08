// Los plazos de negocio en keel-nest (DSL 2.26, incremento 4 de PLAN-DSL-226-PLAZOS.md).
//
// Lo que se EJECUTA contra el motor lo miden `db-check` (verification-codes) y `doc-check` (verification-codes-mongo),
// con los casos DL-1 a DL-10 y R1 y los sabotajes dl-*. Aquí, sin red: que el gate de lo que escribe el agente nazca
// ROJO y se ponga VERDE (el bash se ejecuta, no se compara), la paridad con lo que EMITE keel-spring —las sentencias de
// keel-core tal cual, el mismo `timer.yaml` por perfil y las mismas notas— y que la frontera rechace un motor sin
// sentencias medidas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { timerStatements } from '@keel-system/keel-core/gen/timer-store';
import { deadlineHandlerNote } from '@keel-system/keel-core/gen/deadlines';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

function writeTree(files) {
  const dir = tmpDir('keel-nest-deadlines-');
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
  test(`${fixture}: check-deadlines.sh nace rojo y se pone verde con lo que escribe el agente`, () => {
    const { files } = planFixture(fixture, { stack: { database } });
    const dir = writeTree(files);
    const fresh = gate(dir);
    assert.equal(fresh.code, 1, fresh.out);
    assert.match(fresh.out, /sigue siendo el stub/);
    assert.match(fresh.out, /la entidad no aplica la caducidad/);
    assert.match(fresh.out, /verifyCode: no le da al dominio la hora/);

    // Lo que escribiría el agente: el método semántico, el handler de expireCode y la hora en verifyCode.
    patch(dir, '/domain/aggregate/verification-code.ts', '  get id(): string {', '  expire(): void {\n    this.transitionTo(CodeStatus.EXPIRED);\n  }\n\n  get id(): string {');
    patch(dir, '/usecases/expire-code-command-handler.ts', "throw new Error('TODO: expireCode');", 'const found = await this.verificationCodeRepository.findById(command.id);\n    found?.expire();\n    if (found) await this.verificationCodeRepository.save(found);');
    patch(dir, '/usecases/verify-code-command-handler.ts', "throw new Error('TODO: verifyCode');", 'const now = this.clock.now();\n    throw new Error(String(now));');
    const done = gate(dir);
    assert.equal(done.code, 0, done.out);

    // Y la hora de la instancia leída en el sitio vuelve a ponerlo rojo.
    patch(dir, '/usecases/verify-code-command-handler.ts', 'const now = this.clock.now();', 'const now = new Date();');
    const late = gate(dir);
    assert.equal(late.code, 1, late.out);
    assert.match(late.out, /lee la hora de la instancia/);
  });
}

for (const database of ['postgresql', 'mysql']) {
  test(`${database}: el almacén emite las sentencias de keel-core tal cual`, () => {
    const { files } = planFixture('verification-codes', { stack: { database } });
    const store = files.find((file) => file.path === 'src/infrastructure/timer/sql-timer-store.ts').content;
    // `fire` y `age` son del arnés (adelantan y envejecen un temporizador), no del almacén del servidor.
    const serverStatements = Object.entries(timerStatements(database)).filter(([name]) => name !== 'fire' && name !== 'age');
    for (const [name, sql] of serverStatements) {
      // Como literal de comillas simples, con las suyas escapadas.
      assert.ok(store.includes(`'${sql.replaceAll("'", "\\'")}'`), `${database}: falta la sentencia ${name}`);
    }
  });
}

test('el timer.yaml de cada perfil es el mismo que emite keel-spring', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  const spring = planSpring({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-nest-spring-plan-'), stack: { database: 'postgresql' } }).files;
  const { files } = planFixture('verification-codes', { stack: { database: 'postgresql' } });
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const ours = files.find((file) => file.path === `config/parameters/${profile}/timer.yaml`)?.content;
    const theirs = spring.find((file) => file.path === `src/main/resources/parameters/${profile}/timer.yaml`)?.content;
    assert.ok(ours, `${profile}: keel-nest no emite timer.yaml`);
    assert.equal(ours, theirs, `${profile}: timer.yaml distinto del de keel-spring`);
  }
});

test('la nota del handler que caduca es la neutral, la misma que en keel-spring', () => {
  const { files, model } = planFixture('verification-codes', { stack: { database: 'postgresql' } });
  const expire = files.find((file) => file.path.endsWith('/usecases/expire-code-command-handler.ts')).content;
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'expireCode');
  const note = deadlineHandlerNote(model, operation);
  // La nota viaja partida en líneas de comentario: se compara sin los saltos ni los prefijos.
  const flat = expire.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(flat.includes(note), 'la nota del handler de expireCode no es la neutral');
});

test('un motor sin las sentencias del cronómetro medidas se rechaza en planService, con su motivo', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  assert.throws(
    () => planService({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-nest-deadlines-mariadb-'), stack: { database: 'mariadb' } }),
    /mariadb/
  );
});
