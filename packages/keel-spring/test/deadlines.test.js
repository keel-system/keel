// Los plazos de negocio en keel-spring (DSL 2.26, incremento 3 de PLAN-DSL-226-PLAZOS.md).
//
// Lo que se EJECUTA contra el motor lo mide `npm run timer-check` (DL-1 a DL-10, falsado). Aquí, sin JDK ni
// contenedores: que el gate de lo que escribe el agente nazca ROJO y se ponga VERDE con lo que el agente escribiría (el
// bash se ejecuta, no se compara), que la frontera rechace un motor sin sentencias medidas, y que la nota y la
// inyección lleguen al handler que sale del estado con plazo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from '@keel-system/keel-core';
import { planService, scaffoldService } from '../src/scaffold/index.js';
import { buildModel } from '../src/lib/model.js';
import { timerProbePatches } from '../src/lib/timer-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { withoutLifecycle } from '../../keel-core/test/helpers/data-lifecycle-designs.js';

function generated(fixture, database) {
  const service = loadService(path.join(FIXTURES_DIR, fixture));
  const workspace = tmpDir('keel-deadlines-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database } });
  const name = fs.readdirSync(path.join(workspace, 'services'))[0];
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack: { database } });
  return { projectDir: path.join(workspace, 'services', name), model };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function patch(projectDir, basename, find, replace) {
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === basename);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(find, replace);
  assert.notEqual(after, before, `el parche no aplica en ${basename}`);
  fs.writeFileSync(file, after);
}

function gate(projectDir) {
  try {
    return { code: 0, out: execFileSync('bash', ['infra/check-deadlines.sh'], { cwd: projectDir, encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}` };
  }
}

for (const [fixture, database] of [['verification-codes', 'postgresql'], ['verification-codes-mongo', 'mongodb']]) {
  test(`${fixture}: check-deadlines.sh nace rojo y se pone verde con lo que escribe el agente`, () => {
    const { projectDir, model } = generated(fixture, database);
    const fresh = gate(projectDir);
    assert.equal(fresh.code, 1, fresh.out);
    assert.match(fresh.out, /sigue siendo el stub/);
    assert.match(fresh.out, /la entidad no aplica la caducidad/);
    assert.match(fresh.out, /verifyCode: no le da al dominio la hora/);

    // Lo que escribiría el agente: el método semántico, el handler de expireCode y la hora en verifyCode.
    for (const { file, find, replace } of timerProbePatches(model)) patch(projectDir, file, find, replace);
    patch(projectDir, 'VerificationCode.java', '    public UUID getId() {', '    public void expire() {\n        transitionTo(CodeStatus.EXPIRED);\n    }\n\n    public UUID getId() {');
    patch(projectDir, 'VerifyCodeCommandHandler.java', '        throw new UnsupportedOperationException("TODO: verifyCode");', '        java.time.Instant now = clock.instant();\n        throw new IllegalStateException(now.toString());');
    const done = gate(projectDir);
    assert.equal(done.code, 0, done.out);

    // Y la hora de la instancia leída en el sitio vuelve a ponerlo rojo.
    patch(projectDir, 'VerifyCodeCommandHandler.java', 'Instant now = clock.instant();', 'Instant now = java.time.Instant.now();');
    const late = gate(projectDir);
    assert.equal(late.code, 1, late.out);
    assert.match(late.out, /lee la hora de la instancia/);
  });
}

test('el handler que sale del estado con plazo recibe el reloj y los plazos, y su nota lo dice', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  const { files } = planService({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-deadlines-plan-'), stack: { database: 'postgresql' } });
  const verify = files.find((file) => file.path.endsWith('VerifyCodeCommandHandler.java')).content;
  assert.match(verify, /private final Clock clock;/);
  assert.match(verify, /private final VerificationCodesDeadlines verificationCodesDeadlines;/);
  assert.match(verify, /pasado el plazo la rechaza el dominio con CODE_EXPIRED/);
  const expire = files.find((file) => file.path.endsWith('ExpireCodeCommandHandler.java')).content;
  assert.match(expire, /La despacha el cronómetro del servicio/);
  // El rechazo tardío, en el dominio: vence EN el instante (since + after <= now).
  const entity = files.find((file) => file.path.endsWith('/VerificationCode.java')).content;
  assert.match(entity, /if \(!issuedAt\.plus\(deadlines\.verificationCodePending\(\)\)\.isAfter\(now\)\) \{/);
  assert.match(entity, /throw new CodeExpiredError\(/);
  // Y la operación `by` no es una huérfana: no hay CommandDispatcher que la despache.
  assert.ok(!files.some((file) => file.path.endsWith('CommandDispatcher.java')), 'expireCode la despacha el cronómetro, no un CommandDispatcher');
});

test('un motor sin las sentencias del cronómetro medidas se rechaza en planService, con su motivo', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  // Sin la retención (DSL 2.28), que se rechaza antes con su propio motivo: lo que se mide aquí es el plazo.
  withoutLifecycle(service.layers);
  assert.throws(
    () => planService({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-deadlines-mariadb-'), stack: { database: 'mariadb' } }),
    /el cronómetro no tiene sentencias medidas para 'mariadb'/
  );
});

test('el perfil test apaga el cronómetro y los demás perfiles lo dejan encendido por variable', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'verification-codes'));
  const { files } = planService({ manifest: service.manifest, layers: service.layers, workspace: tmpDir('keel-deadlines-cfg-'), stack: { database: 'postgresql' } });
  const of = (profile) => files.find((file) => file.path === `src/main/resources/parameters/${profile}/timer.yaml`)?.content ?? '';
  assert.match(of('test'), /enabled: false/);
  assert.match(of('production'), /enabled: \$\{SCHEDULING_ENABLED:true\}/);
  assert.match(of('production'), /lease-ms: \$\{TIMER_LEASE_MS:120000\}/);
});
