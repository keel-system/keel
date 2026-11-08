// Los plazos de negocio en keel-go (DSL 2.26, incremento 6 de PLAN-DSL-226-PLAZOS.md).
//
// Lo que se EJECUTA contra el motor lo miden `db-check` (verification-codes) y `doc-check` (verification-codes-mongo),
// con los casos DL-1 a DL-10 y R1 y los sabotajes dl-* (scripts/lib/timer-probes.js). Aquí, sin red ni Go: que el gate de
// lo que escribe el agente nazca ROJO y se ponga VERDE (el bash se ejecuta, no se compara), la paridad con lo que EMITE
// keel-spring —las sentencias de keel-core tal cual, el mismo `timer.yaml` por perfil y las mismas notas—, que los
// sabotajes de la sonda se sigan aplicando y que un motor sin sentencias medidas se rechace con su motivo.

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
import { goString } from '../src/lib/go-source.js';
import { timerStackErrors } from '../src/scaffold/timer.js';
import { TIMER_SABOTAGES, timerProbeFile, timerProbePatch } from '../scripts/lib/timer-probes.js';
import { applyDbSabotage } from './helpers/db-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

function plan(fixture, database) {
  return planService({ ...loadService(path.join(FIXTURES_DIR, fixture)), workspace: FIXTURES_DIR, stack: { database } });
}

function writeTree(files) {
  const dir = tmpDir('keel-go-deadlines-');
  for (const file of files) {
    if (typeof file.content !== 'string') continue;
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

function patch(dir, relative, from, to) {
  const file = path.join(dir, relative);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `el parche no aplica en ${relative}`);
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
    const dir = writeTree(plan(fixture, database).files);
    const fresh = gate(dir);
    assert.equal(fresh.code, 1, fresh.out);
    assert.match(fresh.out, /sigue siendo el stub/);
    assert.match(fresh.out, /la entidad no aplica la caducidad/);
    assert.match(fresh.out, /verifyCode: no le da al dominio la hora/);

    // Lo que escribiría el agente: el método semántico, el handler de expireCode y la hora en verifyCode.
    patch(dir, 'internal/domain/verification_code_behavior.go', /$/, '\nfunc (v *VerificationCode) Expire() error {\n\treturn v.transitionTo(CodeStatusExpired)\n}\n');
    patch(dir, 'internal/application/expire_code_command_handler.go', 'return fmt.Errorf("%w: %s", ErrNotImplemented, "expireCode")', '_, err := h.verificationCodeRepository.Save(ctx, nil)\n\treturn err');
    patch(dir, 'internal/application/verify_code_command_handler.go', 'return VerifyCodeResponseDto{}, fmt.Errorf("%w: %s", ErrNotImplemented, "verifyCode")', 'now := h.clock()\n\treturn VerifyCodeResponseDto{}, fmt.Errorf("%v", now)');
    const done = gate(dir);
    assert.equal(done.code, 0, done.out);

    // Y la hora de la instancia leída en el sitio vuelve a ponerlo rojo.
    patch(dir, 'internal/application/verify_code_command_handler.go', 'now := h.clock()', 'now := time.Now()');
    const late = gate(dir);
    assert.equal(late.code, 1, late.out);
    assert.match(late.out, /lee la hora de la instancia/);
  });
}

for (const database of ['postgresql', 'mysql']) {
  test(`${database}: el almacén emite las sentencias de keel-core tal cual`, () => {
    const store = plan('verification-codes', database).files.find((file) => /^internal\/infrastructure\/\w+\/timers\.go$/.test(file.path)).content;
    // `fire` y `age` son del arnés (adelantan y envejecen un temporizador), no del almacén del servidor.
    const serverStatements = Object.entries(timerStatements(database)).filter(([name]) => name !== 'fire' && name !== 'age');
    for (const [name, sql] of serverStatements) assert.ok(store.includes(goString(sql)), `${database}: falta la sentencia ${name}`);
  });
}

// keel-go lleva el interruptor, scheduling.enabled, en su scheduling.yaml (su lector de configuración no admite una clave en
// dos archivos), y en local con su variable: lo que se compara es la mecánica y el valor efectivo de cada clave.
const effective = (yaml) =>
  yaml
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => line.replace(/\$\{[A-Z_]+:([^}]*)\}/, '$1'));

test('el timer.yaml de cada perfil dice lo mismo que el de keel-spring', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  const spring = planSpring({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-go-spring-plan-'), stack: { database: 'postgresql' } }).files;
  const ours = plan('verification-codes', 'postgresql').files;
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const mine = ours.find((file) => file.path === `config/parameters/${profile}/timer.yaml`)?.content;
    const switchYaml = ours.find((file) => file.path === `config/parameters/${profile}/scheduling.yaml`)?.content;
    const theirs = spring.find((file) => file.path === `src/main/resources/parameters/${profile}/timer.yaml`)?.content;
    assert.ok(mine && switchYaml, `${profile}: keel-go no emite timer.yaml o scheduling.yaml`);
    assert.deepEqual([...effective(mine), ...effective(switchYaml)], effective(theirs), `${profile}: el cronómetro no dice lo mismo que el de keel-spring`);
  }
});

test('la nota del handler que caduca es la neutral, la misma que en keel-spring', () => {
  const { files, model } = plan('verification-codes', 'postgresql');
  const expire = files.find((file) => file.path === 'internal/application/expire_code_command_handler.go').content;
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'expireCode');
  const note = deadlineHandlerNote(model, operation);
  // La nota viaja partida en líneas de comentario: se compara sin los saltos ni los prefijos.
  const flat = expire.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(flat.includes(note), 'la nota del handler de expireCode no es la neutral');
});

for (const [fixture, database] of [['verification-codes', 'postgresql'], ['verification-codes', 'mysql'], ['verification-codes-mongo', 'mongodb']]) {
  test(`${fixture} (${database}): los sabotajes del cronómetro se aplican, y la sonda y su parche existen`, () => {
    const { files, model } = plan(fixture, database);
    const patched = files.map((file) => timerProbePatch(model, file));
    assert.match(patched.find((file) => file.path === 'internal/domain/verification_code_behavior.go').content, /func \(e \*VerificationCode\) ProbeTransitionAt\(/);
    assert.match(timerProbeFile(model).content, /func TestTimer_DL10_AgotadosLosIntentosSeAparca\(/);
    for (const [id, sabotage] of Object.entries(TIMER_SABOTAGES)) assert.equal(applyDbSabotage(sabotage, patched, database).changed, 1, `${id} no se aplica`);
  });
}

test('un motor sin las sentencias del cronómetro medidas se rechaza, con su motivo', () => {
  const { model } = plan('verification-codes', 'postgresql');
  assert.deepEqual(timerStackErrors(model), []);
  const errors = timerStackErrors({ ...model, stack: { ...model.stack, database: 'mariadb' } });
  assert.ok(errors.some((error) => /mariadb/.test(error)), errors.join('\n'));
});
