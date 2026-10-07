// El gate de idempotencia y compensación de keel-nest (incremento 10d), EJECUTADO con bash.
//
//   · las familias y los sujetos son los del gate de keel-spring para el mismo diseño (salvo la escritura de
//     los registros, que es la misma promesa con otra forma);
//   · recién generado sale ROJO en cada familia que tiene trabajo del agente (un gate que nace verde no
//     distingue «correcto» de «no mira»);
//   · con el uso correcto sale VERDE, y un uso roto conservando la forma lo vuelve a poner rojo;
//   · el barrido que build no puede reclamar sigue rojo aunque su adaptador tenga el reclamo de OTRO barrido.
// Medido además a mano contra las corridas reales de keel-nest (PLAN-KEEL-NEST.md § 10d).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { CHECK_IDEMPOTENCY_SH } from '../src/scaffold/idempotency-check.js';

const rows = (script) => [...(script ?? '').matchAll(/^(unit|impl|claim) '([^']*)' '([^']*)'/gm)].map((match) => `${match[2]} | ${match[3]}`);
// La escritura de los registros: en JPA, Persistable; en TypeORM, insert y no save. Sujetos distintos a propósito.
const isInsertSubject = (row) => /: la (escritura es un INSERT|clave asignada fuerza INSERT)/.test(row);

for (const name of ['product-catalog', 'job-dispatch', 'payout-runs', 'metering-digest', 'stock-reservation-events']) {
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) {
    test(`${name} [${broker}]: las familias y los sujetos del gate son los de keel-spring`, () => {
      const stack = { database: 'postgresql', broker };
      const nest = planFixture(name, { stack }).files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
      assert.deepEqual(rows(nest).filter((row) => !isInsertSubject(row)).sort(), rows(spring).filter((row) => !isInsertSubject(row)).sort());
    });
  }
}

/** Escribe el árbol emitido (con cambios del «agente») y ejecuta el gate. null sin bash. */
function runGate(name, edits = {}) {
  const { files } = planFixture(name, { stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const dir = tmpDir('keel-nest-gate-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  for (const [file, edit] of Object.entries(edits)) {
    const target = path.join(dir, file);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const after = edit(before);
    assert.notEqual(after, before, `el cambio de ${file} no se aplicó`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, after);
  }
  try {
    return { code: 0, out: execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8' }) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: error.status, out: error.stdout };
  }
}

const verdicts = (out) => Object.fromEntries([...out.matchAll(/^\s+(\w+)\s+(OK|KO)$/gm)].map((match) => [match[1], match[2]]));

test('recién generado, el gate sale ROJO en cada familia con trabajo del agente', (t) => {
  const events = runGate('stock-reservation-events');
  if (events === null) return t.skip('sin bash en el PATH');
  assert.equal(events.code, 1);
  assert.deepEqual(verdicts(events.out), {
    dedupe: 'KO',
    payloadContract: 'KO',
    commandIdempotency: 'KO',
    domainEvent: 'KO',
    outboxDelivery: 'KO'
  });
  const payouts = runGate('payout-runs');
  assert.equal(payouts.code, 1);
  assert.match(payouts.out, /\[sweepClaim\] sendPayouts .*claimForSendPayouts/);
  // El barrido que build NO puede reclamar: el reclamo generado para sendPayouts, en el mismo adaptador, no lo satisface.
  assert.match(payouts.out, /\[sweepClaim\] closePayoutRuns: /);
});

// El uso correcto de payout-runs: el barrido de cola llama al reclamo generado, y el de los dos estados en
// vuelo tiene su escritura condicional (con su cota) en el adaptador de Payout, junto al reclamo de build.
const SEND = 'src/application/usecases/send-payouts-command-handler.ts';
const ADAPTER = 'src/infrastructure/persistence/repositories/payout-repository-impl.ts';
const sendClaims = (source) =>
  source.replace(/throw new Error\('TODO: sendPayouts'\);/, 'for (const payout of await this.payoutRepository.claimForSendPayouts()) await this.payoutRepository.save(payout);');
const closeClaims = (source) =>
  source.replace(
    /\n}\n\n\/\/ ─── Mapeo dominio/,
    `

  async claimStalledForClose(staleBefore: Date): Promise<string[]> {
    const result = await this.manager.createQueryBuilder().update(PayoutOrm).set({ status: PayoutStatus.FAILED }).where({ status: PayoutStatus.SENDING }).execute();
    return result.affected ? [] : [];
  }
}

// ─── Mapeo dominio`
  );

test('con el uso correcto sale VERDE; leer el lote con un finder lo vuelve a poner rojo', (t) => {
  const correct = runGate('payout-runs', { [SEND]: sendClaims, [ADAPTER]: closeClaims });
  if (correct === null) return t.skip('sin bash en el PATH');
  assert.equal(correct.code, 0, correct.out);
  assert.deepEqual(verdicts(correct.out), { sweepClaim: 'OK' });

  const reading = runGate('payout-runs', {
    [SEND]: (source) => sendClaims(source).replace('await this.payoutRepository.claimForSendPayouts()', 'await this.payoutRepository.findByStatus(PayoutStatus.REQUESTED)'),
    [ADAPTER]: closeClaims
  });
  assert.equal(reading.code, 1);
  assert.match(reading.out, /\[sweepClaim\] sendPayouts .*falta/);
});
