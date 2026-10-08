// Los almacenes del generador sobre MongoDB (incremento 12c), lo que mide doc-check: el gemelo documental de
// los bloques de mensajería, idempotencia, reclamos y purgas de db-check, y lo que en keel-spring mide
// store-check sobre la rama documental. Cada bloque devuelve el código que va DENTRO de la sonda; la sonda
// declara `check`, `tx`, `database`, `client`, `settings`, `UUID`, `randomUUID` y los ayudantes de samples.js.
//
//   documento   el documento de cada almacén contra keel-core/gen/document.js: el `_id` (uuid binario,
//               subdocumento en su ORDEN o la clave aplanada) y sus campos, ni uno de más;
//   outbox      el puente escribe el documento en la transacción del cambio (y nada si aborta); el reclamo
//               del relay en orden, con su lote, la marca `claimed_at` que retira de la pasada siguiente y que
//               CADUCA, dos réplicas a la vez sin duplicar, el backoff, la rendición y su cuenta;
//   consumo     la guarda de procesados: el `_id` arbitra la repetición y la carrera, el registro sobrevive al
//               fallo del handler y dos consumidores no se pisan;
//   petición    el registro de idempotencia: lo guardado se encuentra, la repetición es su conflicto (también
//               en la carrera), revierte con el comando y la clave caducada se puede reusar;
//   barridos    la cola (orden, lote, destino y reloj en la misma operación, carrera de réplicas) y el rescate
//               (solo lo abandonado, sin mover el estado, renovando el reloj);
//   reconciliación la tienda (la inserción es el reclamo, la marca viva lo niega, la caducada se renueva, de tres
//               a la vez gana una) y el reclamo del adaptador (umbral, orden, lote, estado intacto, caducidad);
//   purgas      lo caducado sale por lotes con tope, la pasada siguiente sigue, y lo vigente y lo PENDIENTE
//               del outbox no se tocan.

import { claimsForEntity, claimOrderField, screamingSnake } from 'keel-core/gen';
import { storeDocumentKey, storeDocumentFields, documentShape } from 'keel-core/gen/document';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { RECONCILIATION_CLAIM, reconciliationClaims } from 'keel-core/gen/reconciliation-stores';
import { classPath, DIRS } from '../../src/scaffold/render.js';
import { repositoryRoots, adapterClass, emitsDomainEvents } from '../../src/scaffold/repositories.js';
import { usesNestOutbox, usesProcessedEvents, bridgeClass, bridgePath, MESSAGING_SETTINGS_TS, OUTBOX_RELAY_STORE_TS, IDEMPOTENCY_GUARD_TS } from '../../src/scaffold/messaging.js';
import { usesRequestIdempotency, IDEMPOTENCY_STORE_IMPL_TS, IDEMPOTENCY_CONFLICT_TS } from '../../src/scaffold/request-idempotency.js';
import { RECONCILIATION_CLAIM_STORE_TS } from '../../src/scaffold/reconciliation-claim.js';
import { TABLE_PURGES_TS, tablePurges } from '../../src/scaffold/purge.js';
import { sampleEntity, sampleValue } from './samples.js';

const distOf = (file) => `./${file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')}`;

/** El constante GUARDADA de un estado del ciclo de vida. */
function stored(model, entity, state) {
  const enumDef = model.enums.find((candidate) => candidate.name === entity.lifecycle.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/** La clave del documento de un miembro de la raíz. */
function keyOf(model, entity, member) {
  return documentShape(model, entity).find((entry) => entry.member === member)?.name ?? member;
}

/**
 * Los argumentos del constructor del adaptador de una raíz, en el orden de repositories.js (constructorOf): la
 * transacción, el puente si la raíz emite, la configuración de los barridos (y los parámetros si un rescate lee
 * de ellos su plazo), y la tienda y los números de la reconciliación.
 */
export function adapterArgs(model, root, { batch = 10, transactions = 'tx', reconciliation = 'reconciliationWindow()' } = {}) {
  const args = [transactions];
  if (emitsDomainEvents(model, root)) args.push('eventSink');
  const claims = claimsForEntity(model, root.name);
  if (claims.length > 0) {
    args.push(`sweeps(${batch})`);
    const parameters = claims.filter((claim) => claim.stalled?.parameter).map((claim) => claim.stalled.parameter.name);
    if (parameters.length > 0) args.push(`{ ${parameters.map((name) => `${name}: 1`).join(', ')} }`);
  }
  if (reconciliationClaims(model).some((claim) => claim.entity === root.name)) args.push('reconciliationStore', reconciliation);
  return args.join(', ');
}

/** Lo que la sonda declara antes de los bloques: el sumidero de eventos y la configuración de los reclamos. */
export function storePreamble(model) {
  const claims = repositoryRoots(model).flatMap((root) => claimsForEntity(model, root.name));
  const batchKeys = [...new Set(claims.map((claim) => claim.sweepKey))];
  const stalled = claims.filter((claim) => claim.stalled && !claim.stalled.parameter).map((claim) => `${JSON.stringify(claim.stalled.configKey)}: 60`);
  const activations = [...new Set(reconciliationClaims(model).map((claim) => claim.activation))];
  const reconciliation = activations.length > 0;
  return `
// Los adaptadores de una raíz que emite eventos los entregan al puente: aquí se miden la persistencia y sus
// almacenes, así que reciben un sumidero; el puente de verdad lo mide el bloque del outbox.
const eventSink = { publish: async () => {} };
const sweeps = (batch) => ({ batchSize: { ${batchKeys.map((key) => `${JSON.stringify(key)}: batch`).join(', ')} }, stalledAfterSeconds: { ${stalled.join(', ')} } });
${reconciliation ? `const { ReconciliationClaimStore } = await import('${distOf(RECONCILIATION_CLAIM_STORE_TS)}');
const reconciliationStore = new ReconciliationClaimStore(tx);
const reconciliationWindow = (batchSize = 10, unansweredAfterSeconds = 60, claimTimeoutMs = 60_000) => ({ ${activations.map((name) => `${JSON.stringify(name)}: { batchSize, unansweredAfterSeconds, claimTimeoutMs }`).join(', ')} });` : 'const reconciliationWindow = () => ({});'}
/** Las claves de un documento, en su orden. */
const keysOf = (document) => (document == null ? null : Object.keys(document));
const same = (got, want) => got.length === want.length && [...got].sort().join() === [...want].sort().join();`;
}

/** El documento de un almacén contra keel-core: el `_id` y los campos, en su orden y ni uno de más. */
function shapeCheck(table, documentExpr) {
  const key = storeDocumentKey(table);
  const fields = storeDocumentFields(table).map((field) => field.name);
  const idCheck =
    key.kind === 'subdocument'
      ? `JSON.stringify(keysOf(${documentExpr}?._id)) === ${JSON.stringify(JSON.stringify(key.columns))}`
      : key.kind === 'value'
        ? `${documentExpr}?._id instanceof Binary && ${documentExpr}._id.sub_type === 4`
        : `typeof ${documentExpr}?._id === 'string' && ${documentExpr}._id.includes(${JSON.stringify(key.separator)})`;
  // La marca de la reconciliación la crea un upsert, y en un upsert es el SERVIDOR el que ordena los campos
  // (igual para keel-spring, que usa el mismo): ahí se comparan como conjunto. El resto, en su orden.
  const expected = ['_id', ...fields];
  const keys = key.kind === 'flattened' ? `[...keysOf(${documentExpr})].sort()` : `keysOf(${documentExpr})`;
  const want = key.kind === 'flattened' ? [...expected].sort() : expected;
  return `  check('${table.table}: el documento es el de keel-core/gen/document.js (_id ${key.kind} y sus campos${key.kind === 'flattened' ? '' : ', en orden'})', ${idCheck} && JSON.stringify(${keys}) === ${JSON.stringify(JSON.stringify(want))}, JSON.stringify(${documentExpr}));`;
}

// ─── Outbox ──────────────────────────────────────────────────────────────────

function outboxBlock(model, ctx) {
  if (!usesNestOutbox(model)) return '';
  const event = model.events[0];
  const args = event.fields.map((field) => (field.list ? '[]' : sampleValue(model, field, ctx, 'ev') ?? 'null'));
  return `
// ═══ Outbox: el puente y el relay ═══
try {
  const outbox = database.collection('${OUTBOX_EVENT.table}');
  const { ${bridgeClass(model)}: Bridge } = await import('${distOf(bridgePath(model))}');
  const { ${event.className}: DomainEventClass } = await import('${distOf(classPath(DIRS.events, event.className))}');
  const { messagingSettings } = await import('${distOf(MESSAGING_SETTINGS_TS)}');
  const messaging = messagingSettings({ get: () => undefined });
  const bridge = new Bridge(tx, messaging);
  const kept = DomainEventClass.of(${args.join(', ')});
  await tx.inTransaction(() => bridge.publish([kept]));
  const written = (await outbox.find({}).toArray()).find((candidate) => JSON.parse(candidate.payload).metadata.eventId === kept.metadata.eventId);
  check('outbox: el puente escribe el documento del evento', written != null);
${shapeCheck(OUTBOX_EVENT, 'written')}
  check('outbox: con el destino, la routing key y el NOMBRE del evento', written?.destination === messaging.destination && written?.routing_key === messaging.routingKeys[${JSON.stringify(event.name)}] && written?.event_type === ${JSON.stringify(event.name)}, JSON.stringify(written && { d: written.destination, k: written.routing_key, t: written.event_type }));
  const lost = DomainEventClass.of(${args.join(', ')});
  await tx.inTransaction(async () => { await bridge.publish([lost]); throw new Error('el cambio aborta'); }).catch(() => null);
  check('outbox: si el cambio aborta, el documento tampoco queda', !(await outbox.find({}).toArray()).some((candidate) => JSON.parse(candidate.payload).metadata.eventId === lost.metadata.eventId));

  // ── El reclamo del relay.
  const { OutboxRelayStore } = await import('${distOf(OUTBOX_RELAY_STORE_TS)}');
  const store = new OutboxRelayStore(tx);
  await outbox.deleteMany({});
  const base = Date.now() - 60_000;
  // Un documento pendiente con la forma del contrato, llegado en el instante base + i segundos.
  const pending = (id, i) => ({ _id: new UUID(id), destination: 'd', routing_key: 'k', event_type: 'E', payload: '{}', created_at: new Date(base + i * 1000), published_at: null, attempts: 0, next_attempt_at: null, claimed_at: null, last_error: null });
  const ids = Array.from({ length: 4 }, () => randomUUID());
  // Insertados al revés de su llegada: el orden del reclamo tiene que salir de created_at, no del disco.
  for (let i = 3; i >= 0; i--) await outbox.insertOne(pending(ids[i], i));
  // Sin el índice de pendientes: con él el plan recorre ya en orden de llegada y la sonda no distinguiría un
  // reclamo que pide el orden de uno que lo recibe gratis del plan (medido: sin sort salía en verde).
  await outbox.dropIndex('ix_outbox_event_pending');
  const first = await store.claimBatch(10, 2, 60_000);
  check('relay: reclama en orden de llegada y con su tamaño de lote', JSON.stringify(first.map((r) => r.id)) === JSON.stringify(ids.slice(0, 2)), JSON.stringify(first.map((r) => r.id)));
  const marked = await outbox.findOne({ _id: new UUID(ids[0]) });
  check('relay: el reclamo estampa claimed_at en la MISMA operación', marked?.claimed_at instanceof Date, marked?.claimed_at);
  const second = await store.claimBatch(10, 10, 60_000);
  check('relay: la marca viva retira las reclamadas de la pasada siguiente', JSON.stringify(second.map((r) => r.id)) === JSON.stringify(ids.slice(2)), JSON.stringify(second.map((r) => r.id)));
  check('relay: con todo reclamado no queda nada', (await store.claimBatch(10, 10, 60_000)).length === 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expired = await store.claimBatch(10, 10, 10);
  check('relay: la marca CADUCA: pasado claim-timeout la fila vuelve a ser elegible', same(expired.map((r) => r.id), ids), JSON.stringify(expired.map((r) => r.id)));
  await ensureDocumentIndexes(database);

  // La carrera: dos réplicas a la vez se reparten las filas sin llevarse ninguna dos veces.
  await outbox.deleteMany({});
  const raced = Array.from({ length: 8 }, () => randomUUID());
  for (const [i, id] of raced.entries()) await outbox.insertOne(pending(id, i));
  const [a, b] = await Promise.all([store.claimBatch(10, 8, 60_000), new OutboxRelayStore(new TransactionContext(client, settings)).claimBatch(10, 8, 60_000)]);
  const both = [...a, ...b].map((r) => r.id);
  check('relay: dos réplicas a la vez no se llevan la misma fila', new Set(both).size === both.length && same(both, raced), \`\${a.length} + \${b.length}\`);

  // El desenlace.
  await outbox.deleteMany({});
  for (let i = 0; i < 4; i++) await outbox.insertOne(pending(ids[i], i));
  await store.claimBatch(10, 10, 60_000);
  await store.markPublished(ids[0]);
  const published = await outbox.findOne({ _id: new UUID(ids[0]) });
  check('relay: publicar estampa published_at y suelta la marca', published?.published_at instanceof Date && published.claimed_at == null, JSON.stringify(published));
  const failedOnce = await store.markFailed(ids[1], '$broker caído', 3, 1000, 60_000);
  const delayed = await outbox.findOne({ _id: new UUID(ids[1]) });
  const delay = delayed.next_attempt_at.getTime() - Date.now();
  check('relay: un fallo cuenta el intento, guarda el error tal cual y aplaza según el backoff', failedOnce.attempts === 1 && !failedOnce.deadLettered && delay > 500 && delay <= 1_000 && delayed.last_error === '$broker caído' && delayed.claimed_at == null, \`\${JSON.stringify(failedOnce)} \${delay} ms \${delayed.last_error}\`);
  await store.markFailed(ids[2], 'x', 2, 1000, 60_000);
  const surrendered = await store.markFailed(ids[2], 'x', 2, 1000, 60_000);
  check('relay: al alcanzar el máximo la fila se rinde', surrendered.deadLettered && surrendered.attempts === 2, JSON.stringify(surrendered));
  check('relay: countDeadLettered la cuenta', (await store.countDeadLettered(2)) === 1);
  await outbox.updateMany({}, { $set: { claimed_at: null } });
  await outbox.updateOne({ _id: new UUID(ids[1]) }, { $set: { next_attempt_at: null } });
  const remaining = await store.claimBatch(2, 10, 60_000);
  check('relay: ni la publicada ni la rendida vuelven a reclamarse', same(remaining.map((r) => r.id), [ids[1], ids[3]]), JSON.stringify(remaining.map((r) => r.id)));
} catch (error) {
  check('outbox: el bloque corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`;
}

// ─── Consumo ─────────────────────────────────────────────────────────────────

function guardBlock(model) {
  if (!usesProcessedEvents(model)) return '';
  return `
// ═══ Consumo: el registro de mensajes procesados ═══
try {
  const { IdempotencyGuard } = await import('${distOf(IDEMPOTENCY_GUARD_TS)}');
  const guard = new IdempotencyGuard(tx);
  const processed = database.collection('${PROCESSED_EVENT.table}');
  const eventId = randomUUID();
  check('consumo: un mensaje nuevo no está procesado', !(await guard.alreadyProcessed('ListenerA', eventId)));
  check('consumo: record lo registra', await guard.record('ListenerA', eventId));
  const recorded = await processed.findOne({ 'processed_at': { $exists: true } });
${shapeCheck(PROCESSED_EVENT, 'recorded')}
  check('consumo: la repetición la arbitra el _id (record da false)', !(await guard.record('ListenerA', eventId)));
  check('consumo: alreadyProcessed lo ve', await guard.alreadyProcessed('ListenerA', eventId));
  check('consumo: otro consumidor del mismo mensaje no se pisa', await guard.tryRecord('ListenerB', eventId));
  const survivor = randomUUID();
  await tx.inTransaction(async () => { await guard.record('ListenerA', survivor); throw new Error('el handler falla'); }).catch(() => null);
  check('consumo: el registro sobrevive al fallo del handler (su transacción es propia)', await guard.alreadyProcessed('ListenerA', survivor));
  const contested = randomUUID();
  const outcomes = await Promise.all([guard.record('ListenerC', contested), new IdempotencyGuard(new TransactionContext(client, settings)).record('ListenerC', contested)]);
  check('consumo: en una carrera registra UNA entrega', outcomes.filter(Boolean).length === 1, JSON.stringify(outcomes));
} catch (error) {
  check('consumo: el bloque corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`;
}

// ─── Petición ────────────────────────────────────────────────────────────────

function requestBlock(model) {
  if (!usesRequestIdempotency(model)) return '';
  return `
// ═══ Petición: el registro de idempotencia ═══
try {
  const { IdempotencyStoreImpl } = await import('${distOf(IDEMPOTENCY_STORE_IMPL_TS)}');
  const { IdempotencyConflictException } = await import('${distOf(IDEMPOTENCY_CONFLICT_TS)}');
  const store = new IdempotencyStoreImpl(tx);
  const records = database.collection('${IDEMPOTENCY_RECORD.table}');
  const key = randomUUID();
  await tx.inTransaction(() => store.save('createThing', key, 'firma', 'res-1', 60));
  const found = await tx.inTransaction(() => store.find('createThing', key), { readOnly: true });
  check('petición: lo guardado se encuentra con su firma y su recurso', found?.signature === 'firma' && found?.resourceId === 'res-1', JSON.stringify(found));
  const recorded = await records.findOne({});
${shapeCheck(IDEMPOTENCY_RECORD, 'recorded')}
  check('petición: el ámbito forma parte de la clave', (await tx.inTransaction(() => store.find('otherThing', key), { readOnly: true })) == null);
  const repeated = await tx.inTransaction(() => store.save('createThing', key, 'firma', 'res-1', 60)).catch((error) => error);
  check('petición: la misma clave otra vez es su conflicto', repeated instanceof IdempotencyConflictException, repeated?.message ?? repeated);
  const raced = randomUUID();
  // Cada una en su transacción y retenida un momento: la segunda escribe la misma clave con la primera abierta.
  const slow = (context) => context.inTransaction(async () => { await new IdempotencyStoreImpl(context).save('createThing', raced, 'f', null, 60); await new Promise((resolve) => setTimeout(resolve, 200)); });
  const outcomes = await Promise.allSettled([slow(tx), slow(new TransactionContext(client, settings))]);
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  check('petición: de dos peticiones a la vez con la misma clave, una es el conflicto', rejected.length === 1 && rejected[0].reason instanceof IdempotencyConflictException, outcomes.map((o) => o.status + ':' + (o.reason?.constructor?.name ?? '')).join(', '));
  const reverted = randomUUID();
  await tx.inTransaction(async () => { await store.save('createThing', reverted, 'f', null, 60); throw new Error('el comando falla'); }).catch(() => null);
  check('petición: el registro aborta con su comando', (await tx.inTransaction(() => store.find('createThing', reverted), { readOnly: true })) == null);
  const expiring = randomUUID();
  await tx.inTransaction(() => store.save('createThing', expiring, 'f', null, 0));
  check('petición: una clave caducada no se encuentra', (await tx.inTransaction(() => store.find('createThing', expiring), { readOnly: true })) == null);
  const reused = await tx.inTransaction(() => store.save('createThing', expiring, 'f2', null, 60)).then(() => true, (error) => error);
  check('petición: y se puede volver a usar', reused === true, reused?.message ?? reused);
} catch (error) {
  check('petición: el bloque corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`;
}

// ─── Barridos ────────────────────────────────────────────────────────────────

function sweepBlock(model, ctx) {
  const blocks = [];
  for (const root of repositoryRoots(model)) {
    const claims = claimsForEntity(model, root.name);
    if (claims.length === 0) continue;
    const { enumType, field } = root.lifecycle;
    const enumDef = model.enums.find((candidate) => candidate.name === enumType);
    const read = new Set(claims.flatMap((claim) => claim.from));
    const parked = enumDef.values.find((value) => !read.has(value.literal));
    if (!parked) continue;
    ctx.imports.add(`${enumType}|${classPath(DIRS.enums, enumType)}`);
    const fieldKey = keyOf(model, root, field);
    const samples = Array.from({ length: 24 }, (_, i) => `() => ${sampleEntity(model, root, ctx, `claim${i}`)}`);
    const cases = claims.map((claim) => {
      const label = `${root.name}.${claim.method}`;
      if (claim.stalled) {
        const stampKey = keyOf(model, root, claim.stalled.stampField);
        const state = stored(model, root, claim.stalled.state);
        return `
    {
      await park();
      const stale = await seed(3, ${JSON.stringify(state)}, (i) => ({ ${JSON.stringify(stampKey)}: new Date(Date.now() - 7_200_000 - i * 1000) }));
      const fresh = await seed(2, ${JSON.stringify(state)}, () => ({ ${JSON.stringify(stampKey)}: new Date(Date.now() - 5_000) }));
      const before = new Date(Date.now() - 1_000);
      const rescued = await adapter(10).${claim.method}();
      check('${label}: el rescate se lleva SOLO lo abandonado', same(rescued.map((e) => e.id), stale), JSON.stringify(rescued.map((e) => e.id)));
      check('${label}: no cambia el estado: lo arrienda', rescued.every((e) => e.${field} === ${enumType}.${screamingSnake(claim.stalled.state)}), rescued.map((e) => e.${field}).join(','));
      check('${label}: y renueva el reloj en la misma operación', rescued.every((e) => e.${claim.stalled.stampField} != null && e.${claim.stalled.stampField}.getTime() >= before.getTime()), rescued.map((e) => e.${claim.stalled.stampField}?.toISOString()).join(','));
      check('${label}: la pasada siguiente ya no lo ve', (await adapter(10).${claim.method}()).length === 0);
      const untouched = await collection.find({ _id: { $in: fresh.map((id) => new UUID(id)) } }).toArray();
      check('${label}: lo recién entrado en vuelo no se toca', untouched.length === 2 && untouched.every((row) => Date.now() - row[${JSON.stringify(stampKey)}].getTime() >= 4_000), untouched.map((row) => row[${JSON.stringify(stampKey)}]?.toISOString()).join(','));
    }`;
      }
      const order = claimOrderField(root, claim);
      const orderKey = keyOf(model, root, order);
      const ordered = order !== 'id';
      const from = stored(model, root, claim.from[0]);
      return `
    {
      await park();
      // Instantes al revés del orden de inserción: el más antiguo es el último insertado.
      const ids = await seed(5, ${JSON.stringify(from)}, (i) => (${ordered ? `{ ${JSON.stringify(orderKey)}: new Date(Date.now() - 60_000 - i * 1000) }` : '{}'}));
      const before = new Date(Date.now() - 1_000);
      const first = await adapter(2).${claim.method}();
      ${ordered ? `check('${label}: el lote sale del más antiguo al más nuevo, con su tamaño', JSON.stringify(first.map((e) => e.id)) === JSON.stringify([ids[4], ids[3]]), JSON.stringify({ got: first.map((e) => e.id), ids }));` : `check('${label}: el lote tiene su tamaño', first.length === 2, first.length);`}
      check('${label}: lo reclamado sale ya en ${claim.to}', first.every((e) => e.${field} === ${enumType}.${screamingSnake(claim.to)}), first.map((e) => e.${field}).join(','));${claim.stamps ? `
      check('${label}: con ${claim.stamps.field} estampado en la misma operación', first.every((e) => e.${claim.stamps.field} != null && e.${claim.stamps.field}.getTime() >= before.getTime()), first.map((e) => e.${claim.stamps.field}?.toISOString()).join(','));` : ''}
      const rest = await adapter(10).${claim.method}();
      check('${label}: la pasada siguiente se lleva el resto', same(rest.map((e) => e.id), ids.slice(0, 3)), JSON.stringify(rest.map((e) => e.id)));
      check('${label}: y la tercera, nada', (await adapter(10).${claim.method}()).length === 0);
      // La CARRERA: dos réplicas reclaman a la vez; ninguna fila sale dos veces y ninguna se queda.
      await park();
      const raced = await seed(6, ${JSON.stringify(from)}, () => ({}));
      const replica = () => new ${adapterClass(root)}(${adapterArgs(model, root, { batch: 6, transactions: 'new TransactionContext(client, settings)' })});
      const [a, b] = await Promise.all([replica().${claim.method}(), replica().${claim.method}()]);
      const both = [...a, ...b].map((e) => e.id);
      check('${label}: dos réplicas a la vez no se llevan la misma fila', new Set(both).size === both.length && same(both, raced), \`\${a.length} + \${b.length}\`);
    }`;
    });
    blocks.push(`
// ═══ Reclamos de barrido: ${root.name} ═══
try {
  const collection = database.collection('${root.collectionName}');
  const SAMPLES = [
    ${samples.join(',\n    ')}
  ];
  let next = 0;
  const adapter = (batch) => new ${adapterClass(root)}(${adapterArgs(model, root, { batch: 'batch' })});
  // Aparca todo documento en un estado que ningún reclamo lee: cada caso empieza sin candidatos.
  const park = () => collection.updateMany({}, { $set: { ${JSON.stringify(fieldKey)}: ${JSON.stringify(parked.constant)} } });
  // Crea documentos por el adaptador (como un caso de uso) y los pone en el estado y con los instantes del caso,
  // escritos en crudo. Cada muestra se usa una sola vez: la clave natural es única.
  const seed = async (count, state, at) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const saved = await adapter(10).save(SAMPLES[next++]());
      await collection.updateOne({ _id: new UUID(saved.id) }, { $set: { ${JSON.stringify(fieldKey)}: state, ...at(i) } });
      ids.push(saved.id);
    }
    return ids;
  };${cases.join('')}
} catch (error) {
  check('${root.name}: los reclamos de barrido corren sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`);
  }
  return blocks.join('\n');
}

// ─── Reconciliación ──────────────────────────────────────────────────────────

function reconciliationBlock(model, ctx) {
  const blocks = [];
  for (const root of repositoryRoots(model)) {
    const claims = reconciliationClaims(model).filter((claim) => claim.entity === root.name);
    if (claims.length === 0) continue;
    const { enumType, field } = root.lifecycle;
    const enumDef = model.enums.find((candidate) => candidate.name === enumType);
    const waiting = new Set(claims.flatMap((claim) => claim.states));
    const parked = enumDef.values.find((value) => !waiting.has(value.literal));
    if (!parked) continue;
    ctx.imports.add(`${enumType}|${classPath(DIRS.enums, enumType)}`);
    const fieldKey = keyOf(model, root, field);
    const samples = Array.from({ length: 12 }, (_, i) => `() => ${sampleEntity(model, root, ctx, `rec${i}`)}`);
    const cases = claims.map((claim) => {
      const label = `${root.name}.${claim.method}`;
      const awaitingKey = keyOf(model, root, claim.awaitingField);
      const state = stored(model, root, claim.states[0]);
      return `
    {
      await park();
      await database.collection('${RECONCILIATION_CLAIM.table}').deleteMany({});
      const stale = await seed(3, ${JSON.stringify(state)}, (i) => ({ ${JSON.stringify(awaitingKey)}: new Date(Date.now() - 7_200_000 + i * 1000) }));
      await seed(1, ${JSON.stringify(state)}, () => ({ ${JSON.stringify(awaitingKey)}: new Date(Date.now() - 5_000) }));
      const first = await adapter(reconciliationWindow(2)).${claim.method}();
      check('${label}: solo lo que lleva más que el umbral, el que más lleva primero y con su lote', JSON.stringify(first.map((e) => e.id)) === JSON.stringify(stale.slice(0, 2)), JSON.stringify({ got: first.map((e) => e.id), stale }));
      check('${label}: el estado de espera NO se toca', first.every((e) => e.${field} === ${enumType}.${screamingSnake(claim.states[0])}), first.map((e) => e.${field}).join(','));
      const marks = await database.collection('${RECONCILIATION_CLAIM.table}').find({}).toArray();
      check('${label}: deja la marca de cada uno en ${RECONCILIATION_CLAIM.table}', marks.length === 2 && marks.every((mark) => mark._id === \`${claim.activation}|\${mark.entity_id.toUUID().toHexString()}\`), JSON.stringify(marks.map((mark) => mark._id)));
      const second = await adapter(reconciliationWindow(10)).${claim.method}();
      check('${label}: la pasada siguiente se lleva SOLO el que quedaba (las marcas vivas lo niegan)', JSON.stringify(second.map((e) => e.id)) === JSON.stringify([stale[2]]), JSON.stringify(second.map((e) => e.id)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const again = await adapter(reconciliationWindow(10, 60, 10)).${claim.method}();
      check('${label}: con las marcas caducadas, vuelven a reclamarse', same(again.map((e) => e.id), stale), JSON.stringify(again.map((e) => e.id)));
    }`;
    });
    blocks.push(`
// ═══ Reconciliación: ${root.name} ═══
try {
  const marks = database.collection('${RECONCILIATION_CLAIM.table}');
  const store = reconciliationStore;
  const id = randomUUID();
  const now = new Date();
  check('reconciliación: si no hay marca, insertarla es el reclamo', await store.claim('probe', id, now, new Date(now.getTime() - 60_000)));
  const written = await marks.findOne({ _id: \`probe|\${id}\` });
${shapeCheck(RECONCILIATION_CLAIM, 'written')}
  check('reconciliación: con las dos columnas de la clave también como campos', written?.activation === 'probe' && written?.entity_id instanceof Binary && written.entity_id.toUUID().toHexString() === id, JSON.stringify(written));
  check('reconciliación: la marca VIVA lo niega', !(await store.claim('probe', id, new Date(), new Date(Date.now() - 60_000))));
  check('reconciliación: la marca CADUCADA se renueva', await store.claim('probe', id, new Date(), new Date(Date.now() + 1_000)));
  const contested = randomUUID();
  const race = await Promise.all([1, 2, 3].map(() => new ReconciliationClaimStore(new TransactionContext(client, settings)).claim('probe', contested, new Date(), new Date(Date.now() - 60_000))));
  check('reconciliación: de tres réplicas a la vez gana UNA', race.filter(Boolean).length === 1, JSON.stringify(race));

  const collection = database.collection('${root.collectionName}');
  const SAMPLES = [
    ${samples.join(',\n    ')}
  ];
  let next = 0;
  const adapter = (window) => new ${adapterClass(root)}(${adapterArgs(model, root, { reconciliation: 'window' })});
  const park = () => collection.updateMany({}, { $set: { ${JSON.stringify(fieldKey)}: ${JSON.stringify(parked.constant)} } });
  const seed = async (count, state, at) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const saved = await adapter(reconciliationWindow()).save(SAMPLES[next++]());
      await collection.updateOne({ _id: new UUID(saved.id) }, { $set: { ${JSON.stringify(fieldKey)}: state, ...at(i) } });
      ids.push(saved.id);
    }
    return ids;
  };${cases.join('')}
} catch (error) {
  check('${root.name}: la reconciliación corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`);
  }
  return blocks.join('\n');
}

// ─── Purgas ──────────────────────────────────────────────────────────────────

function purgeBlock(model) {
  const purges = tablePurges(model);
  if (purges.length === 0) return '';
  const DAY = 86_400_000;
  const cases = purges.map((purge) => {
    const old = purge.retentionDays ? `Date.now() - (${purge.retentionDays.default} + 2) * ${DAY}` : 'Date.now() - 60_000';
    const recent = purge.retentionDays ? 'Date.now() - 60_000' : `Date.now() + ${DAY}`;
    const extra = purge.table === OUTBOX_EVENT.table;
    // Un documento con lo mínimo para la purga: su campo de corte, y en el outbox, si está pendiente o no.
    const doc = (at, published = true) =>
      extra
        ? `{ _id: new UUID(randomUUID()), created_at: new Date(${at}), published_at: ${published ? `new Date(${at})` : 'null'}, attempts: 0 }`
        : `{ _id: randomUUID(), ${purge.column}: new Date(${at}) }`;
    return `
  {
    const documents = database.collection('${purge.table}');
    await documents.deleteMany({});
    for (let i = 0; i < 5; i++) await documents.insertOne(${doc(`${old} - i * 1000`)});
    await documents.insertOne(${doc(recent)});${extra ? `
    for (let i = 0; i < 2; i++) await documents.insertOne(${doc(`${old} - i * 1000`, false)});` : ''}
    const firstPass = await purges.${purge.method}();
    check('${purge.what}: la purga va por lotes y para en su tope (2 de 2)', firstPass === 4, firstPass);
    const secondPass = await purges.${purge.method}();
    check('${purge.what}: la pasada siguiente sigue con lo que quedaba', secondPass === 1, secondPass);
    check('${purge.what}: lo vigente${extra ? ' y lo PENDIENTE' : ''} no se tocan', (await documents.countDocuments({})) === ${extra ? 3 : 1}, await documents.countDocuments({}));
  }`;
  });
  return `
// ═══ Purgas por lotes ═══
try {
  const { TablePurges, purgeSettings } = await import('${distOf(TABLE_PURGES_TS)}');
  // Lotes de 2 y tope de 2 lotes por pasada: 5 caducados son 4 en la primera pasada y 1 en la segunda.
  const purgeConfig = purgeSettings({ get: (key) => (key.endsWith('batch-size') || key.endsWith('max-batches') ? 2 : undefined) });
  const purges = new TablePurges({ register() {} }, purgeConfig, client, tx);${cases.join('')}
} catch (error) {
  check('purgas: el bloque corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`;
}

/** Todos los bloques de los almacenes de un sujeto. */
export function storeBlocks(model, ctx) {
  return [outboxBlock(model, ctx), guardBlock(model), requestBlock(model), sweepBlock(model, ctx), reconciliationBlock(model, ctx), purgeBlock(model)].join('\n');
}
