// El gate de idempotencia y compensación de keel-dotnet (incremento 10d), EJECUTADO con bash.
//
//   · las familias y los sujetos son los del gate de keel-nest para el mismo diseño (que son los de keel-spring), salvo
//     la escritura de los registros, que es la misma promesa con otra forma, y lo que keel-dotnet todavía no genera;
//   · recién generado sale ROJO en cada familia que tiene trabajo del agente (un gate que nace verde no distingue
//     «correcto» de «no mira»);
//   · con el uso correcto sale VERDE, y un uso roto conservando la forma lo vuelve a poner rojo;
//   · el barrido que build no puede reclamar sigue rojo aunque su adaptador tenga el reclamo de OTRO barrido.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { relievingOperations } from 'keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { CHECK_IDEMPOTENCY_SH } from '../src/scaffold/idempotency-check.js';
import { occupantFinders, repositoryRoots } from '../src/scaffold/repositories.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const gateOf = (files) => files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
const rows = (script) => [...(script ?? '').matchAll(/^(unit|impl|claim) '([^']*)' '([^']*)'/gm)].map((match) => `${match[2]} | ${match[3]}`);
// La escritura de los registros: en TypeORM, insert y no save; en EF Core, Add y no Update. Sujetos con el nombre del archivo.
const isInsertSubject = (row) => /: la escritura es un INSERT/.test(row);
// Lo que keel-dotnet todavía no genera (correo: incremento 13) no tiene familia aquí.
const PENDING_FAMILIES = new Set(['mailDelivery']);

for (const name of ['product-catalog', 'job-dispatch', 'job-dispatch-cycles', 'payout-runs', 'metering-digest', 'stock-reservation-events', 'notification-mailer']) {
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) {
    test(`${name} [${broker}]: las familias y los sujetos del gate son los de keel-nest`, () => {
      const stack = { database: 'postgresql', broker };
      const ours = rows(gateOf(planService({ ...design(name), workspace: FIXTURES_DIR, stack }).files));
      const theirs = rows(gateOf(planNest({ ...design(name), workspace: FIXTURES_DIR, stack }).files)).filter((row) => !PENDING_FAMILIES.has(row.split(' | ')[0]));
      assert.ok(ours.length > 0);
      assert.deepEqual(ours.filter((row) => !isInsertSubject(row)).sort(), theirs.filter((row) => !isInsertSubject(row)).sort());
      // La escritura de los registros: los mismos registros vigilados, con el nombre de archivo de cada lenguaje.
      assert.deepEqual(ours.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort(), theirs.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort());
    });
  }
}

/** Escribe el árbol emitido (con cambios del «agente») y ejecuta el gate. null sin bash. */
function runGate(name, edits = {}) {
  const { files } = planService({ ...design(name), workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const dir = tmpDir('keel-dotnet-gate-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  for (const [suffix, edit] of Object.entries(edits)) {
    const file = files.find((candidate) => candidate.path.endsWith(suffix));
    assert.ok(file, `no hay ${suffix}`);
    const target = path.join(dir, file.path);
    const before = fs.readFileSync(target, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, `el cambio de ${suffix} no se aplicó`);
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
  // La escritura de los registros la emite build: nace sin hallazgos.
  assert.doesNotMatch(events.out, /la escritura es un INSERT/);
  const payouts = runGate('payout-runs');
  assert.equal(payouts.code, 1);
  assert.match(payouts.out, /\[sweepClaim\] sendPayouts .*ClaimForSendPayouts/);
  // El barrido que build NO puede reclamar: el reclamo generado para sendPayouts, en el mismo adaptador, no lo satisface.
  assert.match(payouts.out, /\[sweepClaim\] closePayoutRuns: /);
});

// El uso correcto de payout-runs: el barrido de cola llama al reclamo generado, y el de los dos estados en vuelo tiene
// su escritura condicional (con su cota) en el adaptador de Payout, junto al reclamo de build.
const SEND = 'UseCases/SendPayoutsCommandHandler.cs';
const ADAPTER = 'Repositories/PayoutRepository.cs';
const sendClaims = (source) =>
  source.replace(
    'throw new NotImplementedException("TODO: sendPayouts");',
    'foreach (var payout in await payoutRepository.ClaimForSendPayouts(cancellationToken)) { await payoutRepository.Save(payout, cancellationToken); }'
  );
const closeClaims = (source) =>
  source.replace(
    '\n    // ─── Mapeo dominio',
    `
    public async Task<int> ClaimStalledForClose(DateTimeOffset staleBefore, CancellationToken cancellationToken = default)
    {
        return await db.Set<PayoutRow>().Where(r => r.Status == "SENDING" && r.SendingSince < staleBefore).ExecuteUpdateAsync(set => set.SetProperty(r => r.Status, "FAILED"), cancellationToken);
    }

    // ─── Mapeo dominio`
  );

test('con el uso correcto sale VERDE; leer el lote con un finder lo vuelve a poner rojo', (t) => {
  const correct = runGate('payout-runs', { [SEND]: sendClaims, [ADAPTER]: closeClaims });
  if (correct === null) return t.skip('sin bash en el PATH');
  assert.equal(correct.code, 0, correct.out);
  assert.deepEqual(verdicts(correct.out), { sweepClaim: 'OK' });

  const reading = runGate('payout-runs', {
    [SEND]: (source) => sendClaims(source).replace('await payoutRepository.ClaimForSendPayouts(cancellationToken)', 'await payoutRepository.FindByStatus(PayoutStatus.Requested, cancellationToken)'),
    [ADAPTER]: closeClaims
  });
  assert.equal(reading.code, 1);
  assert.match(reading.out, /\[sweepClaim\] sendPayouts .*NO debe aparecer/);
  // La nota del stub nombra el reclamo: si el gate leyera comentarios, saldría verde por su propia prosa.
  const noteOnly = runGate('payout-runs', { [SEND]: (source) => source.replace('throw new NotImplementedException("TODO: sendPayouts");', 'throw new InvalidOperationException("pendiente");'), [ADAPTER]: closeClaims });
  assert.match(noteOnly.out, /\[sweepClaim\] sendPayouts .*falta/);
});

test('stock-reservation-events: con el uso correcto del listener, la guarda y el dispatcher, esas familias salen VERDES', (t) => {
  const listener = `namespace StockReservationEvents.Infrastructure.Messaging;

public sealed class InventoryEventsListener(IdempotencyGuard guard)
{
    public async Task Consume(StockReservedMessage reserved, StockCountAdjustedMessage adjusted, StockRejectedMessage rejected, CancellationToken cancellationToken)
    {
        reserved.RequireContract();
        if (await guard.AlreadyProcessed("InventoryEventsListener", "id", cancellationToken)) return;
        await guard.Record("InventoryEventsListener", "id", cancellationToken);
        if (!await guard.TryRecord("InventoryEventsListener", "id", cancellationToken)) return;
    }
}
`;
  if (runGate('stock-reservation-events') === null) return t.skip('sin bash en el PATH');
  // El listener del agente vive en un archivo suyo: se escribe aparte.
  const dir = tmpDir('keel-dotnet-gate-listener-');
  const { files } = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'rabbitmq' } });
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.path.endsWith('Messaging/BrokerBindings.cs') ? file.content.replace('// TODO (agente): una implementación por puerto, con la skill keel-dotnet-<broker>.', 'services.AddSingleton<IOutboxDispatcher, RabbitOutboxDispatcher>();') : file.content);
  }
  fs.writeFileSync(path.join(dir, 'src/StockReservationEvents.Infrastructure/Messaging/InventoryEventsListener.cs'), listener);
  let out;
  try {
    out = execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8' });
  } catch (error) {
    out = error.stdout;
  }
  const found = verdicts(out);
  assert.equal(found.dedupe, 'OK', out);
  assert.equal(found.payloadContract, 'OK', out);
  assert.equal(found.outboxDelivery, 'OK', out);
  // Una clave inventada en el listener lo pone rojo.
  fs.writeFileSync(path.join(dir, 'src/StockReservationEvents.Infrastructure/Messaging/InventoryEventsListener.cs'), listener.replace('"id"', 'Guid.NewGuid().ToString()'));
  try {
    out = execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8' });
  } catch (error) {
    out = error.stdout;
  }
  assert.equal(verdicts(out).dedupe, 'KO', out);
});

test('conditionalUniqueness: recién generado sale rojo; con la ocupante buscada antes, verde', (t) => {
  const fresh = runGate('notification-mailer');
  if (fresh === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(fresh.out).conditionalUniqueness, 'KO', fresh.out);
  const { model } = planService({ ...design('notification-mailer'), workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const [relief] = relievingOperations(model);
  const root = repositoryRoots(model).find((candidate) => candidate.name === relief.entity.rootEntity) ?? relief.entity;
  const finder = occupantFinders(model, root).find((candidate) => candidate.state === relief.state);
  const relieved = runGate('notification-mailer', {
    [`UseCases/${relief.operation.handlerClass}.cs`]: (source) =>
      source.replace(`throw new NotImplementedException("TODO: ${relief.operation.name}");`, `var occupant = await ${root.name[0].toLowerCase()}${root.name.slice(1)}Repository.${finder.name}(default!, cancellationToken); return default!;`)
  });
  assert.equal(verdicts(relieved.out).conditionalUniqueness, 'OK', relieved.out);
});

// Corrida stock-reservation-events con SNS/SQS (9h): tres listeners, uno por suscripción, en UN Listeners.cs, y en una
// carpeta de compilación (bin/obj) la DLL que nombra los mismos mensajes. El gate elegía la DLL, y con el archivo
// fuente miraba el archivo entero: cada listener «prohibía» el orden del vecino. Correcto y en rojo, medido sobre el
// proyecto real; ahora se poda bin/obj y el archivo localizado por contenido se recorta a su tipo.
test('snssqs: tres listeners en un archivo, con su DLL al lado, salen VERDES; uno con el orden cruzado, ROJO solo él', () => {
  const stack = { database: 'postgresql', broker: 'snssqs' };
  const { files } = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack });
  const listener = (name, message, order) => `public sealed class ${name}(IdempotencyGuard guard) : IHostedService
{
    public async Task Handle(${message} payload, string eventId, CancellationToken cancellationToken)
    {
        payload.RequireContract();
${order}
    }
}
`;
  const guarded = (name) => `        if (await guard.AlreadyProcessed(nameof(${name}), eventId, cancellationToken)) return;
        await guard.Record(nameof(${name}), eventId, cancellationToken);`;
  const unguarded = (name) => `        if (!await guard.TryRecord(nameof(${name}), eventId, cancellationToken)) return;`;
  const write = (reservedOrder) => {
    const dir = tmpDir('keel-dotnet-gate-snssqs-');
    for (const file of files) {
      const out = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        file.path.endsWith('Messaging/BrokerBindings.cs')
          ? file.content.replace('// TODO (agente): una implementación por puerto, con la skill keel-dotnet-<broker>.', 'services.AddSingleton<IOutboxDispatcher, SnsSqsOutboxDispatcher>();')
          : file.content
      );
    }
    const messaging = path.join(dir, 'src/StockReservationEvents.Infrastructure/Messaging');
    fs.mkdirSync(path.join(messaging, 'SnsSqs'), { recursive: true });
    fs.writeFileSync(
      path.join(messaging, 'SnsSqs/Listeners.cs'),
      'namespace StockReservationEvents.Infrastructure.Messaging.SnsSqs;\n\n' +
        listener('StockReservedListener', 'StockReservedMessage', reservedOrder) +
        '\n' +
        listener('StockRejectedListener', 'StockRejectedMessage', guarded('StockRejectedListener')) +
        '\n' +
        listener('StockCountAdjustedListener', 'StockCountAdjustedMessage', unguarded('StockCountAdjustedListener'))
    );
    // La DLL compilada nombra los tres mensajes y la guarda, como la de un proyecto que se compiló.
    const bin = path.join(dir, 'src/StockReservationEvents.Infrastructure/bin/Debug/net10.0');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'StockReservationEvents.Infrastructure.dll'), Buffer.from('MZ\0\0StockReservedMessage StockRejectedMessage StockCountAdjustedMessage IdempotencyGuard\0'));
    try {
      return execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return error.stdout;
    }
  };
  const correct = write(guarded('StockReservedListener'));
  if (correct === null) return;
  assert.equal(verdicts(correct).dedupe, 'OK', correct);
  assert.equal(verdicts(correct).payloadContract, 'OK', correct);
  const crossed = write(unguarded('StockReservedListener'));
  assert.equal(verdicts(crossed).dedupe, 'KO', crossed);
  const findings = crossed.split('\n').filter((line) => line.includes('[dedupe]'));
  assert.ok(findings.length > 0 && findings.every((line) => line.includes('StockReserved (')), crossed);
});
