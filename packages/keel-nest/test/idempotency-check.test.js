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

for (const name of ['product-catalog', 'job-dispatch', 'payout-runs', 'metering-digest', 'stock-reservation-events', 'stock-reservation', 'notification-mailer']) {
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

// ─── Compensación y reconciliación (incremento 11c), sobre stock-reservation ─

const STOCK = {
  reconcile: 'src/application/usecases/reconcile-reservations-command-handler.ts',
  release: 'src/application/usecases/release-reservation-command-handler.ts',
  reservation: 'src/domain/aggregate/reservation.ts'
};
/** El cuerpo de handle() sustituido por lo que escribiría el agente. */
const handleWith = (body) => (source) => source.replace(/async handle\(([^)]*)\): Promise<void> \{[\s\S]*?\n  \}\n\}/, `async handle($1): Promise<void> {\n${body}\n  }\n}`);
const sweepBody = `    for (const reservation of await this.reservationRepository.claimForReconcileReservationsReserveStock()) {
      reservation.release('sin respuesta del almacén');
      await this.reservationRepository.save(reservation);
      await this.inventoryClient.cancelStock(reservation.id);
    }`;
const releaseBody = `    const reservation = await this.reservationRepository.findById(command.id);
    if (reservation === null) return;
    reservation.release(command.reason ?? 'rechazada por el almacén');
    await this.reservationRepository.save(reservation);`;
const withRelease = (source) =>
  source.replace(/\n  private transitionTo\(/, `\n  release(reason: string): void {\n    this.transitionTo(ReservationStatus.RELEASED);\n  }\n\n  private transitionTo(`);

test('stock-reservation: recién generado, compensación y reconciliación salen ROJAS en cada sujeto', (t) => {
  const fresh = runGate('stock-reservation');
  if (fresh === null) return t.skip('sin bash en el PATH');
  const found = verdicts(fresh.out);
  assert.equal(found.compensation, 'KO');
  assert.equal(found.reconciliation, 'KO');
  // La clave saliente la cablea build en el intento: nace verde, como en keel-spring.
  assert.equal(found.outboundIdempotency, 'OK');
  assert.match(fresh.out, /\[compensation\] releaseReservation \(/);
  assert.match(fresh.out, /\[compensation\] releaseReservation · estado de Reservation .*falta 'transitionTo/);
  assert.match(fresh.out, /\[reconciliation\] reconcileReservations · reclamo de inventory\.reserveStock .*falta/);
});

test('stock-reservation: con el uso correcto salen VERDES; barrer con un finder vuelve a poner roja la reconciliación', (t) => {
  const correct = runGate('stock-reservation', {
    [STOCK.reconcile]: handleWith(sweepBody),
    [STOCK.release]: handleWith(releaseBody),
    [STOCK.reservation]: withRelease
  });
  if (correct === null) return t.skip('sin bash en el PATH');
  const found = verdicts(correct.out);
  assert.equal(found.compensation, 'OK', correct.out);
  assert.equal(found.reconciliation, 'OK', correct.out);

  const reading = runGate('stock-reservation', {
    [STOCK.reconcile]: handleWith(sweepBody.replace('claimForReconcileReservationsReserveStock()', 'findByStatus(ReservationStatus.AWAITING_STOCK)')),
    [STOCK.release]: handleWith(releaseBody),
    [STOCK.reservation]: withRelease
  });
  assert.equal(verdicts(reading.out).reconciliation, 'KO');
  assert.equal(verdicts(reading.out).compensation, 'OK');

  // Y el estado sin devolver: la compensación queda a medias aunque el handler esté escrito.
  const halfway = runGate('stock-reservation', { [STOCK.reconcile]: handleWith(sweepBody), [STOCK.release]: handleWith(releaseBody) });
  assert.equal(verdicts(halfway.out).compensation, 'KO');
});

// Corrida stock-reservation (2026-10-08): releer por id un candidato YA reclamado es legítimo (el gate lo vetaba y
// keel-spring lo escondió tras otro nombre), y un catch SIN variable en el barrido se traga cualquier error (lo dejó
// keel-nest, dos veces, y ninguna familia lo miraba).
test('stock-reservation: releer por id pasa; un catch {} en el barrido lo pone rojo', (t) => {
  const reload = sweepBody.replace(
    "      reservation.release('sin respuesta del almacén');",
    "      const current = await this.reservationRepository.findById(reservation.id);\n      if (current === null) continue;\n      reservation.release('sin respuesta del almacén');"
  );
  const reloading = runGate('stock-reservation', { [STOCK.reconcile]: handleWith(reload), [STOCK.release]: handleWith(releaseBody), [STOCK.reservation]: withRelease });
  if (reloading === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(reloading.out).reconciliation, 'OK', reloading.out);

  const swallow = sweepBody.replace(
    '      await this.inventoryClient.cancelStock(reservation.id);',
    '      try {\n        await this.inventoryClient.cancelStock(reservation.id);\n      } catch {\n      }'
  );
  const swallowing = runGate('stock-reservation', { [STOCK.reconcile]: handleWith(swallow), [STOCK.release]: handleWith(releaseBody), [STOCK.reservation]: withRelease });
  assert.equal(verdicts(swallowing.out).reconciliation, 'KO');
  assert.match(swallowing.out, /\[reconciliation\] reconcileReservations \(.*catch/);
});

// La persistencia DOCUMENTAL (incremento 12c): el mismo gate, con las mismas familias y sujetos que keel-spring
// sobre el mismo diseño. notification-mailer-mongo sin su correo, que keel-nest no genera (incremento 13): fuera
// de la frontera se quita, a los dos lados.
const DOCUMENT_SUBJECTS = [
  { name: 'job-dispatch-mongo', withoutLayers: [] },
  { name: 'inspection-reports', withoutLayers: [] },
  { name: 'notification-mailer-mongo', withoutLayers: ['mail'] }
];
for (const { name, withoutLayers } of DOCUMENT_SUBJECTS) {
  test(`${name} [mongodb]: las familias y los sujetos del gate son los de keel-spring`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const stack = { database: 'mongodb', ...(layers.messaging ? { broker: 'rabbitmq' } : {}) };
    for (const layer of withoutLayers) {
      delete manifest.layers[layer];
      delete layers[layer];
    }
    const nest = planFixture(name, { stack, withoutLayers }).files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
    assert.ok(nest, 'keel-nest emite el gate también sobre documentos');
    assert.deepEqual(rows(nest).filter((row) => !isInsertSubject(row)).sort(), rows(spring).filter((row) => !isInsertSubject(row)).sort());
  });
}

test('documental: la escritura de los registros es un insertOne; un upsert la pone roja', (t) => {
  const stack = { database: 'mongodb', broker: 'rabbitmq' };
  const { files } = planFixture('notification-mailer-mongo', { stack, withoutLayers: ['mail'] });
  const run = (edits) => {
    const dir = tmpDir('keel-nest-gate-doc-');
    for (const file of files) {
      const out = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, edits[file.path] ? edits[file.path](file.content) : file.content);
    }
    try {
      return execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return error.stdout;
    }
  };
  // El gate imprime los HALLAZGOS (lo rojo): la escritura de los registros la emite build, así que nace sin
  // ninguno; el resto de familias nace roja por el trabajo del agente, que aquí no se mira.
  const insertFindings = (out) => out.split('\n').filter((line) => /la escritura es un INSERT/.test(line));
  const fresh = run({});
  if (fresh == null) return t.skip('sin bash');
  const guard = 'src/infrastructure/messaging/idempotency/idempotency-guard.ts';
  const store = 'src/infrastructure/persistence/idempotency-store-impl.ts';
  assert.ok(files.some((file) => file.path === guard) && files.some((file) => file.path === store));
  assert.deepEqual(insertFindings(fresh), [], 'recién generado, la guarda y el registro ya insertan');
  const upserted = run({ [guard]: (text) => text.replace(/\.insertOne\(([^)]*)\)/s, '.updateOne($1, { $set: {} }, { upsert: true })') });
  assert.ok(insertFindings(upserted).some((line) => /idempotency-guard/.test(line)), upserted);
  assert.ok(!insertFindings(upserted).some((line) => /idempotency-store-impl/.test(line)), 'y solo la guarda');
});

// ─── mailDelivery (incremento 12e) ───────────────────────────────────────────

const MAIL_HANDLER = 'src/application/usecases/send-accepted-notification-command-handler.ts';
/** El handler de mail.sentBy con el cuerpo que escribiría el agente (devuelve el DTO de la operación). */
const mailHandleWith = (body) => (source) =>
  source.replace(/(async handle\([^)]*\): Promise<[^>]*> \{)[\s\S]*?\n  \}\n\}/, `$1\n${body}\n  }\n}`);
const sendBody = (claim) => `    const notification = ${claim
  ? 'await this.notificationRepository.claimForSendAcceptedNotification(command.id)'
  : 'await this.notificationRepository.findById(command.id)'};
    if (notification === null) throw new Error('ya no está disponible');
    await this.mailSender.send(new MailMessage({ to: [...notification.recipients], subject: 'x', html: 'h', text: 't' }));
    return this.notificationApplicationMapper.toSendAcceptedNotificationResponseDto(notification);`;

test('mailDelivery: recién generado, el envío y su guarda salen los DOS como pendientes', (t) => {
  const fresh = runGate('notification-mailer');
  if (fresh === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(fresh.out).mailDelivery, 'KO', fresh.out);
  assert.match(fresh.out, /\[mailDelivery\] sendAcceptedNotification \(/, fresh.out);
  assert.match(fresh.out, /\[mailDelivery\][^\n]*guarda confirmada antes del envío/, fresh.out);
});

test('mailDelivery: con el envío escrito y la guarda en memoria sigue rojo por la guarda; con el reclamo, verde', (t) => {
  const inMemory = runGate('notification-mailer', { [MAIL_HANDLER]: mailHandleWith(sendBody(false)) });
  if (inMemory === null) return t.skip('sin bash en el PATH');
  assert.ok(!/\[mailDelivery\] sendAcceptedNotification \(/.test(inMemory.out), inMemory.out);
  assert.match(inMemory.out, /\[mailDelivery\][^\n]*guarda confirmada antes del envío/, inMemory.out);
  const claimed = runGate('notification-mailer', { [MAIL_HANDLER]: mailHandleWith(sendBody(true)) });
  assert.equal(verdicts(claimed.out).mailDelivery, 'OK', claimed.out);
  // La nota del stub nombra el reclamo y el envío: si el gate leyera comentarios, saldría verde por su propia prosa.
  const noteOnly = runGate('notification-mailer', { [MAIL_HANDLER]: (source) => source.replace("throw new Error('TODO: sendAcceptedNotification');", "throw new Error('pendiente');") });
  assert.match(noteOnly.out, /\[mailDelivery\] sendAcceptedNotification \(/, noteOnly.out);
});

test('conditionalUniqueness: recién generado sale rojo; con la ocupante buscada y guardada antes, verde', (t) => {
  const fresh = runGate('notification-mailer');
  if (fresh === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(fresh.out).conditionalUniqueness, 'KO', fresh.out);
  const relieved = runGate('notification-mailer', {
    'src/application/usecases/publish-template-command-handler.ts': mailHandleWith(`    const template = await this.templateRepository.findById(command.id);
    if (template === null) throw new Error('no existe');
    const occupant = await this.templateRepository.findByApplicationIdAndKeyAndLocaleAndStatus(template.applicationId, template.key, template.locale, TemplateStatus.ACTIVE);
    if (occupant !== null) {
      occupant.retire();
      await this.templateRepository.save(occupant);
    }
    template.publish();
    return this.templateApplicationMapper.toPublishTemplateResponseDto(await this.templateRepository.save(template));`)
  });
  assert.equal(verdicts(relieved.out).conditionalUniqueness, 'OK', relieved.out);
});
