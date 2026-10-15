// Las sondas de los ALMACENES DEL GENERADOR sobre documentos (incremento 12c), para `doc-check`: el gemelo de los bloques
// de db-probes.js con lo que en SQL era una sentencia escrito sobre la colección. Las del registro de idempotencia y de la
// guarda de procesados son las MISMAS que las relacionales (solo usan la API del almacén); aquí va lo demás:
//   · el outbox: orden de llegada, lote, la marca `claimed_at` que retira lo reclamado de la pasada siguiente y que,
//     caducada, lo devuelve; dos réplicas a la vez sin repetir; el fallo con su backoff y la rendición; lo publicado;
//   · el `_id` subdocumento de processed_event e idempotency_record, en su orden (MongoDB compara en orden);
//   · los reclamos de barrido (cola y rescate) y de reconciliación del adaptador de cada raíz: orden, lote, destino,
//     arriendo, la cota temporal del rescate, la marca viva y la caducada, la carrera de dos réplicas, y que no corren
//     dentro de otra transacción;
//   · la tienda de la marca de reconciliación y las purgas por lotes.
// Lo que en relacional mide SKIP LOCKED (otra réplica reteniendo una fila) no tiene gemelo: aquí no hay lock de fila, y el
// reparto lo hace la operación atómica sobre el documento, que mide la carrera.

import { claimOrderField, claimsForEntity, screamingSnake, snakeCase } from 'keel-core/gen';
import { reconciliationClaims } from 'keel-core/gen/reconciliation-stores';
import { documentShape, storeDocumentKey, storeDocumentFields } from 'keel-core/gen/document';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { csMember, csString } from '../../src/scaffold/render.js';
import { usesReconciliationClaims } from '../../src/scaffold/reconciliation-claim.js';
import { purgeSettings } from './db-probes.js';

/** La clave del documento de un campo del dominio de la raíz. */
const keyOf = (model, entity, member) => documentShape(model, entity).find((entry) => entry.member === member)?.name ?? snakeCase(member);

/** La constante guardada de un estado del ciclo de vida. */
function constantOf(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/** Lo común: la colección cruda y el instante a segundos enteros. */
export function documentProbeSupport() {
  return `    /// <summary>Una colección de la base del sujeto, cruda: lo que en relacional era una sentencia SQL.</summary>
    private static IMongoCollection<BsonDocument> Raw(string name) => root.GetRequiredService<DocumentDatabase>().Collection(name);

    /// <summary>Ahora, a segundos enteros: la fecha BSON guarda milisegundos y la comparación de instantes tiene que ser exacta.</summary>
    private static DateTimeOffset TruncatedNow()
    {
        var now = DateTimeOffset.UtcNow;
        return new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, now.Minute, now.Second, TimeSpan.Zero);
    }`;
}

// ─── Las claves subdocumento ─────────────────────────────────────────────────────────────────────

/** El `_id` subdocumento de un almacén, en su orden: lo que arbitra la carrera. */
export function storeKeyBlock({ guard, idempotency }) {
  const tests = [];
  if (guard) {
    const columns = storeDocumentKey(PROCESSED_EVENT).columns;
    tests.push(`    [Fact]
    public async Task Procesados_ElIdEsElSubdocumentoDeSuClaveEnSuOrden()
    {
        var eventId = Guid.NewGuid().ToString();
        Assert.True(await Guard.Record("KeyListener", eventId, Cancel));
        var stored = await Raw(${csString(PROCESSED_EVENT.table)}).Find(new BsonDocument("_id.event_id", eventId)).SingleAsync(Cancel);
        Assert.Equal([${columns.map(csString).join(', ')}], stored["_id"].AsBsonDocument.Names);
        Assert.Equal(["_id", "processed_at"], stored.Names);
        Assert.IsType<BsonDateTime>(stored["processed_at"]);
    }`);
  }
  if (idempotency) {
    const columns = storeDocumentKey(IDEMPOTENCY_RECORD).columns;
    tests.push(`    [Fact]
    public async Task Idempotencia_ElIdEsElSubdocumentoDeSuClaveEnSuOrden()
    {
        var key = Guid.NewGuid().ToString();
        await InScope(other => other.GetRequiredService<IIdempotencyStore>().Save("ambito-de-la-sonda", key, "firma", null, 3600, Cancel));
        var stored = await Raw(${csString(IDEMPOTENCY_RECORD.table)}).Find(new BsonDocument("_id.${columns[1]}", key)).SingleAsync(Cancel);
        Assert.Equal([${columns.map(csString).join(', ')}], stored["_id"].AsBsonDocument.Names);
        Assert.Equal(["_id", "signature", "resource_id", "created_at", "expires_at"], stored.Names);
    }`);
  }
  return tests.length > 0 ? `    // ─── Las claves de los registros ───\n\n${tests.join('\n\n')}` : '';
}

// ─── El outbox ───────────────────────────────────────────────────────────────────────────────────

export function documentOutboxBlock() {
  return `    // ─── El outbox ───

    /// <summary>
    /// Deja el outbox sin pendientes ajenos y mete los suyos, con los campos del contrato: el reclamo es por orden de llegada
    /// sobre TODA la colección.
    /// </summary>
    private static async Task<List<Guid>> SeedOutbox(int count)
    {
        var outbox = Raw("outbox_event");
        await outbox.UpdateManyAsync(new BsonDocument("published_at", BsonNull.Value), new BsonDocument("$set", new BsonDocument("published_at", BsonValues.Of(DateTimeOffset.UtcNow))), cancellationToken: Cancel);
        var ids = new List<Guid>();
        for (var i = 0; i < count; i++)
        {
            var id = Guid.CreateVersion7();
            ids.Add(id);
            await outbox.InsertOneAsync(
                new BsonDocument
                {
                    { "_id", BsonValues.Of(id) },
                    { "destination", "probe.events" },
                    { "routing_key", "probe.k" },
                    { "event_type", "Probe" },
                    { "payload", "{}" },
                    // Al revés del orden de inserción (y del _id, que es UUIDv7): sin el orden por created_at, el reclamo
                    // devolvería otro orden y la sonda lo vería.
                    { "created_at", BsonValues.Of(DateTimeOffset.UtcNow.AddSeconds(-60 - i)) },
                    { "published_at", BsonNull.Value },
                    { "attempts", 0 },
                    { "next_attempt_at", BsonNull.Value },
                    { "claimed_at", BsonNull.Value },
                    { "last_error", BsonNull.Value }
                },
                cancellationToken: Cancel);
        }
        // El orden de llegada: el más viejo primero, que es el último insertado.
        ids.Reverse();
        return ids;
    }

    private static OutboxRelayStore Relay => root.GetRequiredService<OutboxRelayStore>();

    private static Task<BsonDocument> OutboxRow(Guid id) => Raw("outbox_event").Find(new BsonDocument("_id", BsonValues.Of(id))).SingleAsync(Cancel);

    [Fact]
    public async Task Outbox_ElReclamoEsPorOrdenDeLlegadaYLaMarcaLasRetiraDeLaPasadaSiguiente()
    {
        var ids = await SeedOutbox(3);
        var first = await Relay.ClaimBatch(maxAttempts: 10, batchSize: 2, claimTimeoutMs: 60000, Cancel);
        Assert.Equal(ids.Take(2), first.Select(row => row.Id));
        Assert.IsType<BsonDateTime>((await OutboxRow(ids[0]))["claimed_at"]);
        // Las dos reclamadas llevan la marca viva: la pasada siguiente solo ve la tercera.
        var second = await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel);
        Assert.Equal([ids[2]], second.Select(row => row.Id));
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel));
        // La réplica que se las llevó murió: con la marca caducada vuelven, en su orden.
        await Task.Delay(20, Cancel);
        Assert.Equal(ids, (await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 1, Cancel)).Select(row => row.Id));
    }

    [Fact]
    public async Task Outbox_ElOrdenDeLlegadaLoPoneElReclamoNoElIndice()
    {
        // El índice de pendientes (published_at, created_at) REGALA el orden: con él, un reclamo sin orden explícito devuelve
        // igual lo más viejo primero y nadie lo ve (medido: el sabotaje que quitaba el orden salía en verde). Se mide sin él.
        var outbox = Raw("outbox_event");
        await outbox.Indexes.DropOneAsync("ix_outbox_event_pending", Cancel);
        try
        {
            var ids = await SeedOutbox(4);
            Assert.Equal(ids, (await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel)).Select(row => row.Id));
        }
        finally
        {
            await DocumentIndexes.Ensure(root.GetRequiredService<DocumentDatabase>().Database, Cancel);
        }
    }

    [Fact]
    public async Task Outbox_DosReplicasALaVezSeRepartenElLoteSinRepetir()
    {
        var ids = await SeedOutbox(6);
        var replicas = await Task.WhenAll(
            Task.Run(() => Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel)),
            Task.Run(() => Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel)));
        var taken = replicas.SelectMany(batch => batch.Select(row => row.Id)).ToList();
        Assert.Equal(taken.Count, taken.Distinct().Count());
        Assert.Equal(ids.OrderBy(id => id), taken.OrderBy(id => id));
    }

    [Fact]
    public async Task Outbox_UnFalloCuentaElIntentoConSuBackoffYAlAgotarseLaFilaSeRinde()
    {
        var ids = await SeedOutbox(1);
        await Relay.ClaimBatch(maxAttempts: 2, batchSize: 1, claimTimeoutMs: 60000, Cancel);
        var before = DateTimeOffset.UtcNow;
        var first = await Relay.MarkFailed(ids[0], "$broker caído", maxAttempts: 2, backoffInitialMs: 60000, backoffMaxMs: 120000, Cancel);
        Assert.Equal(new MarkFailedOutcome(1, false), first);
        var row = await OutboxRow(ids[0]);
        // Un texto que empieza por $ se guarda como texto: no se lee como un campo.
        Assert.Equal("$broker caído", row["last_error"].AsString);
        Assert.True(row["claimed_at"].IsBsonNull, "el fallo suelta la marca");
        Assert.True(BsonValues.Instant(row["next_attempt_at"], "next_attempt_at") >= before.AddMilliseconds(59000), "el backoff del primer fallo es el inicial");
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 2, batchSize: 10, claimTimeoutMs: 60000, Cancel));
        Assert.Equal(0, await Relay.CountDeadLettered(maxAttempts: 2, Cancel));
        Assert.Equal(new MarkFailedOutcome(2, true), await Relay.MarkFailed(ids[0], "otra vez", maxAttempts: 2, backoffInitialMs: 60000, backoffMaxMs: 120000, Cancel));
        Assert.Equal(1, await Relay.CountDeadLettered(maxAttempts: 2, Cancel));
        // Rendida: no se reclama nunca más, ni con el backoff vencido.
        await Raw("outbox_event").UpdateManyAsync(new BsonDocument("_id", BsonValues.Of(ids[0])), new BsonDocument("$set", new BsonDocument("next_attempt_at", BsonNull.Value)), cancellationToken: Cancel);
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 2, batchSize: 10, claimTimeoutMs: 60000, Cancel));
        await Raw("outbox_event").UpdateManyAsync(new BsonDocument("published_at", BsonNull.Value), new BsonDocument("$set", new BsonDocument("published_at", BsonValues.Of(DateTimeOffset.UtcNow))), cancellationToken: Cancel);
    }

    [Fact]
    public async Task Outbox_LaPublicadaNoSeVuelveAReclamar()
    {
        var ids = await SeedOutbox(1);
        await Relay.ClaimBatch(maxAttempts: 10, batchSize: 1, claimTimeoutMs: 0, Cancel);
        await Relay.MarkPublished(ids[0], Cancel);
        var row = await OutboxRow(ids[0]);
        Assert.IsType<BsonDateTime>(row["published_at"]);
        Assert.True(row["claimed_at"].IsBsonNull, "publicar suelta la marca");
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 1, Cancel));
    }`;
}

/**
 * El PUENTE con outbox: el documento del evento se escribe en la sesión de la transacción del cambio, así que confirma con
 * ella y aborta con ella; fuera de una transacción no hay cambio al que atarlo. Con el evento de verdad del diseño (su
 * `Of(...)`, con las muestras de sus campos) y el puente registrado.
 */
export function documentBridgeBlock(model, { bridge, sample }) {
  const event = (model.events ?? []).find((candidate) => candidate.fields.every((field) => field.kind !== 'enum' && field.kind !== 'composite' && !field.list));
  if (!event) return '';
  const args = event.fields.map((field) => sample(field)).join(', ');
  const fields = storeDocumentFields(OUTBOX_EVENT).map((field) => field.name);
  return `    // ─── El puente de eventos ───

    private static async Task<string> PublishThrough(bool commit)
    {
        var domainEvent = ${event.className}.Of(${args});
        var eventId = domainEvent.Metadata.EventId;
        try
        {
            await InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction(async () =>
            {
                await other.GetRequiredService<${bridge}>().Publish([domainEvent], Cancel);
                return commit ? true : throw new InvalidOperationException("el cambio aborta después de publicar");
            }, readOnly: false, Cancel));
        }
        catch (InvalidOperationException) when (!commit)
        {
        }
        return eventId;
    }

    private static Task<List<BsonDocument>> OutboxRowsOf(string eventId) =>
        Raw("outbox_event").Find(new BsonDocument("payload", new BsonRegularExpression(System.Text.RegularExpressions.Regex.Escape(eventId)))).ToListAsync(Cancel);

    [Fact]
    public async Task Puente_LaFilaDelOutboxConfirmaConElCambioYAbortaConEl()
    {
        var confirmed = await PublishThrough(commit: true);
        var rows = await OutboxRowsOf(confirmed);
        Assert.Single(rows);
        // El documento del outbox del contrato (keel-core/gen/document.js): sus claves, en su orden, con su tipo.
        Assert.Equal(["_id", ${fields.map(csString).join(', ')}], rows[0].Names);
        Assert.IsType<BsonBinaryData>(rows[0]["_id"]);
        Assert.Equal(${csString(event.name)}, rows[0]["event_type"].AsString);
        Assert.True(rows[0]["published_at"].IsBsonNull);
        Assert.Equal(0, rows[0]["attempts"].AsInt32);
        Assert.IsType<BsonDateTime>(rows[0]["created_at"]);
        // El cambio aborta: la fila no existe.
        Assert.Empty(await OutboxRowsOf(await PublishThrough(commit: false)));
    }

    [Fact]
    public async Task Puente_FueraDeUnaTransaccionNoHayCambioAlQueAtarLaFila()
    {
        var domainEvent = ${event.className}.Of(${args});
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => InScope(other => other.GetRequiredService<${bridge}>().Publish([domainEvent], Cancel)));
        Assert.Contains("transacción", error.Message, StringComparison.Ordinal);
    }`;
}

// ─── La tienda de la marca de reconciliación ─────────────────────────────────────────────────────

export function documentReconciliationStoreBlock() {
  return `    // ─── La tienda del reclamo de reconciliación ───

    private static Task<bool> ClaimMark(string activation, Guid entity, DateTimeOffset now, DateTimeOffset expiredBefore) =>
        root.GetRequiredService<ReconciliationClaimStore>().Claim(activation, entity, now, expiredBefore, Cancel);

    [Fact]
    public async Task Reconciliacion_LaMarcaSeInsertaRespetaLaVivaYRenuevaLaCaducada()
    {
        var activation = "probe-" + Guid.NewGuid().ToString("N")[..12];
        var entity = Guid.NewGuid();
        var now = TruncatedNow();
        Assert.True(await ClaimMark(activation, entity, now, now.AddMinutes(-5)), "sin marca, la inserción es el reclamo");
        Assert.False(await ClaimMark(activation, entity, now.AddSeconds(1), now.AddMinutes(-5)), "con la marca viva, no");
        // Caducada justo en el límite: claimed_at <= la caducidad.
        Assert.True(await ClaimMark(activation, entity, now.AddSeconds(2), now), "la marca en el límite de la caducidad ya caducó");
        var mark = await Raw("reconciliation_claim").Find(new BsonDocument("_id", activation + "|" + entity.ToString().ToLowerInvariant())).SingleAsync(Cancel);
        Assert.Equal(now.AddSeconds(2), BsonValues.Instant(mark["claimed_at"], "claimed_at"));
        Assert.Equal(activation, mark["activation"].AsString);
        Assert.Equal(entity, BsonValues.Uuid(mark["entity_id"], "entity_id"));
        // Por activación: la misma entidad esperando otro desenlace tiene su propia marca.
        Assert.True(await ClaimMark(activation + "-otra", entity, now, now.AddMinutes(-5)));
        // Lo que la lectura de candidatos excluye: solo la marca viva de ESA activación.
        Assert.Equal([BsonValues.Of(entity)], await root.GetRequiredService<ReconciliationClaimStore>().Held(activation, now, Cancel));
        Assert.Empty(await root.GetRequiredService<ReconciliationClaimStore>().Held(activation, now.AddSeconds(2), Cancel));
    }

    [Fact]
    public async Task Reconciliacion_TresReplicasALaVezSobreElMismoCandidatoGanaUna()
    {
        var activation = "probe-" + Guid.NewGuid().ToString("N")[..12];
        var entity = Guid.NewGuid();
        var now = TruncatedNow();
        var won = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => Task.Run(() => ClaimMark(activation, entity, now, now.AddMinutes(-5)))));
        Assert.Single(won, value => value);
    }`;
}

// ─── Los reclamos del adaptador de una raíz ──────────────────────────────────────────────────────

/** Una actualización cruda de la colección de la raíz, como sentencia C#. */
const updateOne = (collection, id, set) =>
  `await Raw(${csString(collection)}).UpdateOneAsync(new BsonDocument("_id", BsonValues.Of(${id})), new BsonDocument("$set", ${set}), cancellationToken: Cancel);`;

export function documentClaimProbes(model, root, { state, first, port }) {
  const claims = claimsForEntity(model, root.name);
  if (claims.length === 0) return [];
  const collection = root.collectionName;
  const stateField = keyOf(model, root, root.lifecycle.field);
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const id = csMember(root.idField?.name ?? 'id');
  const constant = (state) => constantOf(model, root, state);
  const touched = new Set(claims.flatMap((claim) => [...claim.from, ...(claim.stalled ? [claim.stalled.state] : [])]));
  const park = enumDef.values.map((value) => value.literal).find((literal) => !touched.has(literal));
  let next = first;
  const take = (count) => Array.from({ length: count }, () => next++);
  const tests = [];
  // Aparca lo que otras sondas dejaron en los estados que el reclamo mira.
  const parkAll = (states) =>
    `            await Raw(${csString(collection)}).UpdateManyAsync(new BsonDocument(${csString(stateField)}, new BsonDocument("$in", new BsonArray { ${states.map((s) => csString(constant(s))).join(', ')} })), new BsonDocument("$set", new BsonDocument(${csString(stateField)}, ${csString(constant(park))})), cancellationToken: Cancel);`;
  const seed = (samples, stateName, field, at) => `            var ids = new List<Guid>();
${samples
  .map(
    (n, i) => `            var sample${i} = new ${root.name}(${state(n)});
            await InScope(other => other.GetRequiredService<${port}>().Save(sample${i}, Cancel));
            ids.Add(sample${i}.${id});
            ${updateOne(collection, `sample${i}.${id}`, `new BsonDocument { { ${csString(stateField)}, ${csString(constant(stateName))} }${field ? `, { ${csString(field)}, BsonValues.Of(${at(i)}) }` : ''} }`)}`
  )
  .join('\n')}`;
  const rawOf = `            async Task<BsonDocument> RawOf(Guid row) => await Raw(${csString(collection)}).Find(new BsonDocument("_id", BsonValues.Of(row))).SingleAsync(Cancel);`;
  const claimVia = (method) => `InScope(other => other.GetRequiredService<${port}>().${method}(Cancel))`;

  for (const claim of claims) {
    const method = csMember(claim.method);
    if (claim.stalled) {
      const clock = keyOf(model, root, claim.stalled.stampField);
      const [stale1, stale2, fresh] = take(3);
      tests.push(`    [Fact]
    public async Task Rescate_${method}_SoloLoAbandonadoYLoArriendaSinCambiarElEstado() =>
        await InScope(async services =>
        {
${parkAll([claim.stalled.state])}
            var now = TruncatedNow();
${seed([stale1, stale2, fresh], claim.stalled.state, clock, (i) => (i < 2 ? `now.AddDays(-10).AddSeconds(${1 - i})` : 'now'))}
${rawOf}
            var rescued = await ${claimVia(method)};
            // Solo los abandonados, el más atascado primero; el recién entrado en vuelo no se toca.
            // Al revés de como se insertaron: el orden lo pone el reloj, no el _id.
            Assert.Equal([ids[1], ids[0]], rescued.Select(r => r.${id}));
            foreach (var row in ids)
            {
                Assert.Equal(${csString(constant(claim.stalled.state))}, (await RawOf(row))[${csString(stateField)}].AsString);
            }
            Assert.Equal(now, BsonValues.Instant((await RawOf(ids[2]))[${csString(clock)}], "reloj"));
            Assert.True(BsonValues.Instant((await RawOf(ids[0]))[${csString(clock)}], "reloj") >= now.AddSeconds(-1), "el rescatado lleva el reloj renovado: está arrendado");
            // Arrendado: la pasada siguiente no vuelve a llevárselo.
            Assert.Empty(await ${claimVia(method)});
        });`);
      continue;
    }
    const order = keyOf(model, root, claimOrderField(root, claim));
    const [a, b, c] = take(3);
    const stamp = claim.stamps
      ? `
            // El reloj que vigila el rescate, estampado en la MISMA operación que el cambio de estado.
            Assert.IsType<BsonDateTime>((await RawOf(ids[0]))[${csString(keyOf(model, root, claim.stamps.field))}]);
            Assert.IsType<BsonDateTime>((await RawOf(ids[1]))[${csString(keyOf(model, root, claim.stamps.field))}]);`
      : '';
    tests.push(`    [Fact]
    public async Task Reclamo_${method}_SeLlevaElLoteEnOrdenAlDestinoYLaPasadaSiguienteSigue() =>
        await InScope(async services =>
        {
${parkAll(claim.from)}
            var origin = TruncatedNow().AddHours(-1);
${seed([a, b, c], claim.from[0], order === '_id' ? null : order, (i) => `origin.AddSeconds(-${i})`)}${order === '_id' ? '' : `
            // El orden de llegada es el del campo, al revés del de inserción (y del _id, UUIDv7).
            ids.Reverse();`}
${rawOf}
            var first = await ${claimVia(method)};
            Assert.Equal(ids.Take(2), first.Select(r => r.${id}));
            Assert.Equal(${csString(constant(claim.to))}, (await RawOf(ids[0]))[${csString(stateField)}].AsString);
            Assert.Equal(${csString(constant(claim.from[0]))}, (await RawOf(ids[2]))[${csString(stateField)}].AsString);${stamp}
            Assert.Equal([ids[2]], (await ${claimVia(method)}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia(method)});
        });`);
    const race = take(4);
    tests.push(`    [Fact]
    public async Task Reclamo_${method}_DosReplicasALaVezSeRepartenElLoteSinRepetir() =>
        await InScope(async services =>
        {
${parkAll(claim.from)}
            var origin = TruncatedNow().AddHours(-1);
${seed(race, claim.from[0], order === '_id' ? null : order, (i) => `origin.AddSeconds(${i})`)}
            var replicas = await Task.WhenAll(Task.Run(() => ${claimVia(method)}), Task.Run(() => ${claimVia(method)}));
            var taken = replicas.SelectMany(batch => batch.Select(r => r.${id})).ToList();
            Assert.Equal(taken.Count, taken.Distinct().Count());
            Assert.Equal(ids.OrderBy(row => row), taken.OrderBy(row => row));
        });`);
  }
  tests.push(`    [Fact]
    public async Task Reclamo_${root.name}_NoCorreDentroDeOtraTransaccion() =>
        await InScope(async services =>
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => services.GetRequiredService<PersistenceTransactions>().InTransaction(
                async () => await services.GetRequiredService<${port}>().${csMember(claims[0].method)}(Cancel),
                readOnly: false,
                Cancel));
            Assert.Contains("DispatchWithoutTransaction", error.Message, StringComparison.Ordinal);
        });`);
  return tests;
}

export function documentReconciliationProbes(model, root, { state, first, port }) {
  const claims = usesReconciliationClaims(model) ? reconciliationClaims(model).filter((claim) => claim.entity === root.name) : [];
  if (claims.length === 0) return [];
  const collection = root.collectionName;
  const stateField = keyOf(model, root, root.lifecycle.field);
  const id = csMember(root.idField?.name ?? 'id');
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const waiting = new Set(claims.flatMap((claim) => claim.states));
  const park = enumDef.values.map((value) => value.literal).find((literal) => !waiting.has(literal));
  let next = first;
  const take = (count) => Array.from({ length: count }, () => next++);
  const tests = [];
  for (const claim of claims) {
    const method = csMember(claim.method);
    const awaiting = keyOf(model, root, claim.awaitingField);
    const waitState = constantOf(model, root, claim.states[0]);
    const claimVia = `InScope(other => other.GetRequiredService<${port}>().${method}(Cancel))`;
    const parkAll = `            await Raw(${csString(collection)}).UpdateManyAsync(new BsonDocument(${csString(stateField)}, new BsonDocument("$in", new BsonArray { ${claim.states.map((s) => csString(constantOf(model, root, s))).join(', ')} })), new BsonDocument("$set", new BsonDocument(${csString(stateField)}, ${csString(constantOf(model, root, park))})), cancellationToken: Cancel);`;
    const seed = (samples, at) => `            var ids = new List<Guid>();
${samples
  .map(
    (n, i) => `            var sample${i} = new ${root.name}(${state(n)});
            await InScope(other => other.GetRequiredService<${port}>().Save(sample${i}, Cancel));
            ids.Add(sample${i}.${id});
            ${updateOne(collection, `sample${i}.${id}`, `new BsonDocument { { ${csString(stateField)}, ${csString(waitState)} }, { ${csString(awaiting)}, BsonValues.Of(${at(i)}) } }`)}`
  )
  .join('\n')}`;
    const pass = take(4);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_SoloLoQueSuperaElUmbralEnOrdenPorLotesYSinTocarElEstado() =>
        await InScope(async services =>
        {
${parkAll}
            var now = DateTimeOffset.UtcNow;
            // Tres que llevan horas sin desenlace (el umbral de los defaults es de ${claim.unansweredAfterSeconds} s) y uno recién encargado.
${seed(pass, (i) => (i < 3 ? `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 - ${i})` : 'now'))}
            var first = await ${claimVia};
            // El que más lleva primero: al revés de como se insertaron.
            Assert.Equal([ids[2], ids[1]], first.Select(r => r.${id}));
            // El reclamo marca, no mueve: siguen esperando el desenlace.
            foreach (var row in ids)
            {
                var stored = await Raw(${csString(collection)}).Find(new BsonDocument("_id", BsonValues.Of(row))).SingleAsync(Cancel);
                Assert.Equal(${csString(waitState)}, stored[${csString(stateField)}].AsString);
            }
            Assert.Equal(2L, await Raw("reconciliation_claim").CountDocumentsAsync(
                new BsonDocument { { "activation", ${csString(claim.activation)} }, { "entity_id", new BsonDocument("$in", new BsonArray(ids.Skip(1).Take(2).Select(row => BsonValues.Of(row)))) } },
                cancellationToken: Cancel));
            // La pasada siguiente: el tercero; los marcados no vuelven y el recién encargado no ha superado el umbral.
            Assert.Equal([ids[0]], (await ${claimVia}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia});
        });`);
    const [old1, old2] = take(2);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_LaMarcaCaducadaDevuelveElCandidato() =>
        await InScope(async services =>
        {
${parkAll}
            var now = DateTimeOffset.UtcNow;
${seed([old1, old2], (i) => `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 - ${i})`)}
            Assert.Equal([ids[1], ids[0]], (await ${claimVia}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia});
            // La réplica que se los llevó murió: su marca envejece más que la caducidad (${claim.claimTimeoutMs} ms).
            var expired = DateTimeOffset.UtcNow.AddMilliseconds(-${claim.claimTimeoutMs}).AddSeconds(-1);
            await Raw("reconciliation_claim").UpdateOneAsync(new BsonDocument("entity_id", BsonValues.Of(ids[0])), new BsonDocument("$set", new BsonDocument("claimed_at", BsonValues.Of(expired))), cancellationToken: Cancel);
            Assert.Equal([ids[0]], (await ${claimVia}).Select(r => r.${id}));
        });`);
    const race = take(4);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_DosReplicasALaVezNoRepitenCandidato() =>
        await InScope(async services =>
        {
${parkAll}
            var now = DateTimeOffset.UtcNow;
${seed(race, (i) => `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 + ${i})`)}
            var replicas = await Task.WhenAll(Task.Run(() => ${claimVia}), Task.Run(() => ${claimVia}));
            var taken = replicas.SelectMany(batch => batch.Select(r => r.${id})).ToList();
            Assert.NotEmpty(taken);
            Assert.Equal(taken.Count, taken.Distinct().Count());
            Assert.All(taken, row => Assert.Contains(row, ids));
        });`);
  }
  if (claimsForEntity(model, root.name).length === 0) {
    tests.push(`    [Fact]
    public async Task Reconciliacion_${root.name}_NoCorreDentroDeOtraTransaccion() =>
        await InScope(async services =>
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => services.GetRequiredService<PersistenceTransactions>().InTransaction(
                async () => await services.GetRequiredService<${port}>().${csMember(claims[0].method)}(Cancel),
                readOnly: false,
                Cancel));
            Assert.Contains("DispatchWithoutTransaction", error.Message, StringComparison.Ordinal);
        });`);
  }
  return tests;
}

// ─── Las purgas ──────────────────────────────────────────────────────────────────────────────────

/** Cómo se siembra cada colección para su purga: un documento por instante con la marca de la sonda. */
const PURGE_SEEDS = {
  Outbox: {
    collection: 'outbox_event',
    row: (at, published = true) =>
      `new BsonDocument { { "_id", BsonValues.Of(Guid.CreateVersion7()) }, { "destination", "probe.events" }, { "routing_key", "probe.k" }, { "event_type", marker }, { "payload", "{}" }, { "created_at", BsonValues.Of(now.AddDays(-30)) }, { "published_at", ${published ? `BsonValues.Of(${at})` : 'BsonNull.Value'} }, { "attempts", 1 }, { "next_attempt_at", BsonNull.Value }, { "claimed_at", BsonNull.Value }, { "last_error", BsonNull.Value } }`,
    expired: (i) => `now.AddDays(-20).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    marker: 'event_type'
  },
  ProcessedEvent: {
    collection: 'processed_event',
    row: (at) => `new BsonDocument { { "_id", new BsonDocument { { "handler_id", marker }, { "event_id", Guid.NewGuid().ToString() } } }, { "processed_at", BsonValues.Of(${at}) } }`,
    expired: (i) => `now.AddDays(-30).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    marker: '_id.handler_id'
  },
  ReconciliationClaim: {
    collection: 'reconciliation_claim',
    row: (at) => `new BsonDocument { { "_id", marker + "|" + Guid.NewGuid() }, { "activation", marker }, { "entity_id", BsonValues.Of(Guid.NewGuid()) }, { "claimed_at", BsonValues.Of(${at}) } }`,
    expired: (i) => `now.AddDays(-30).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    marker: 'activation'
  },
  IdempotencyRecord: {
    collection: 'idempotency_record',
    row: (at) =>
      `new BsonDocument { { "_id", new BsonDocument { { "operation_scope", marker }, { "idempotency_key", Guid.NewGuid().ToString() } } }, { "signature", "probe" }, { "resource_id", BsonNull.Value }, { "created_at", BsonValues.Of(now.AddDays(-2)) }, { "expires_at", BsonValues.Of(${at}) } }`,
    expired: (i) => `now.AddDays(-1).AddSeconds(${i})`,
    live: 'now.AddDays(1)',
    marker: '_id.operation_scope'
  }
};

export function documentPurgeBlock(purges) {
  const count = (seed) => `Raw(${csString(seed.collection)}).CountDocumentsAsync(new BsonDocument(${csString(seed.marker)}, marker), cancellationToken: Cancel)`;
  const tests = purges.map((purge) => {
    const seed = PURGE_SEEDS[purge.key];
    // Cinco caducados, dos con el MISMO instante (caen en el mismo lote), y uno vigente.
    const rows = [0, 0, 1, 2, 3].map((i) => seed.row(seed.expired(i)));
    rows.push(seed.row(seed.live));
    // Pendiente desde hace 30 días: no se purga nunca, por vieja que sea.
    if (purge.key === 'Outbox') rows.push(seed.row(null, false));
    const survivors = purge.key === 'Outbox' ? 2 : 1;
    return `    [Fact]
    public async Task Purga_${purge.key}_PorLotesSeLlevaLoCaducadoConInstantesRepetidosYDejaLoVigente()
    {
        var marker = "purge-" + Guid.NewGuid().ToString("N")[..12];
        var now = TruncatedNow();
        await Raw(${csString(seed.collection)}).InsertManyAsync(
            [
${rows.map((row) => `                ${row}`).join(',\n')}
            ],
            cancellationToken: Cancel);
        var deleted = await root.GetRequiredService<TablePurges>().${purge.method}(now, Cancel);
        Assert.Equal(5, deleted);
        Assert.Equal(${survivors}L, await ${count(seed)});
        // La pasada siguiente no encuentra nada más que purgar.
        Assert.Equal(0, await root.GetRequiredService<TablePurges>().${purge.method}(now, Cancel));
    }`;
  });
  const first = purges[0];
  const seed = PURGE_SEEDS[first.key];
  tests.push(`    [Fact]
    public async Task Purga_AlLlegarAlTopeAvisaYLaPasadaSiguienteSigue()
    {
        var marker = "purge-" + Guid.NewGuid().ToString("N")[..12];
        var now = TruncatedNow();
        await Raw(${csString(seed.collection)}).InsertManyAsync(
            [
${[0, 1, 2, 3, 4].map((i) => `                ${seed.row(seed.expired(i))}`).join(',\n')}
            ],
            cancellationToken: Cancel);
        var capped = new TablePurges(root.GetRequiredService<DocumentDatabase>(), ${purgeSettings(purges, 2, 1)}, root.GetRequiredService<DatabaseSettings>(), NullLogger<TablePurges>.Instance);
        Assert.Equal(2, await capped.${first.method}(now, Cancel));
        Assert.Equal(3L, await ${count(seed)});
        Assert.Equal(3, await root.GetRequiredService<TablePurges>().${first.method}(now, Cancel));
        Assert.Equal(0L, await ${count(seed)});
    }`);
  return `    // ─── Las purgas por lotes ───

${tests.join('\n\n')}`;
}
