// El relay del outbox por réplica (DSL 2.26, inc. 9), EJECUTADO contra el motor real por db-check y doc-check: los casos
// RW de keel-core/gen/timer-plan.js (`RELAY_WAKE_CASES`), los mismos que mide `store-check` en keel-spring y db-check en
// keel-nest. El OutboxRelay EMITIDO arranca de verdad (StartAsync) con el sondeo de respaldo a 600 s, el puente EMITIDO
// escribe la fila en la transacción (su Append es privado: se llama por reflexión) y el dispatcher es un doble que apunta
// cada intento: todo lo que salga antes de 600 s lo ha hecho salir un despertar o un reintento.
//
// Son métodos de la clase de sondas del sujeto, no una clase propia: xUnit ejecuta las clases a la vez, y las dos
// compartirían el outbox.

import { RELAY_SABOTAGES, RELAY_WAKE_CASES } from '@keel-system/keel-core/gen/timer-plan';
import { bridgeClass, OUTBOX_WAKE_LINE } from '../../src/scaffold/messaging.js';

export const PROBE_POLL_MS = 600000;
export const PROBE_BACKOFF_MS = 300;
export const PROBE_WAIT_MS = 5000;

/** Los sabotajes, por rama: el puente que ya no despierta al relay (cae RW-1) y el relay que olvida el reintento (RW-3). */
export const RELAY_WAKE_SABOTAGES = Object.freeze({
  'relay-no-wake': {
    // Lee los dos parámetros que el aviso usaba: sin eso, CS9113 (parámetro sin leer) y no compila.
    relational: ['DomainEventBridge.cs', OUTBOX_WAKE_LINE, '_ = (transactions, wakeup);'],
    document: ['DomainEventBridge.cs', OUTBOX_WAKE_LINE, '_ = (transactions, wakeup);'],
    breaks: RELAY_SABOTAGES['relay-no-wake']
  },
  'relay-no-retry': {
    relational: ['OutboxRelay.cs', 'pendingRetryMs = Math.Min(remembered, retryAtMs);', 'pendingRetryMs = long.MaxValue + 0 * Math.Min(remembered, retryAtMs);'],
    document: ['OutboxRelay.cs', 'pendingRetryMs = Math.Min(remembered, retryAtMs);', 'pendingRetryMs = long.MaxValue + 0 * Math.Min(remembered, retryAtMs);'],
    breaks: RELAY_SABOTAGES['relay-no-retry']
  }
});

export const isRelayWakeSabotage = (id) => Boolean(id && RELAY_WAKE_SABOTAGES[id]);

/** El veredicto sobre las líneas de fallo de `dotnet test`: los RW que cayeron, y nada más. */
export function relayWakeSabotageVerdict(failureLines, id) {
  const failed = [...new Set(failureLines.map((line) => {
    const match = /\.RW(\d+)_/.exec(line);
    return match ? `RW-${match[1]}` : line;
  }))].sort();
  const want = [...RELAY_WAKE_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** Los usings que el bloque añade a la clase de sondas. */
export const RELAY_WAKE_USINGS = ['System.Reflection', 'Microsoft.Extensions.Logging.Abstractions'];

/**
 * El bloque C#. `document` elige cómo escribe el puente (Append + SaveChanges en EF; Append + Flush en la sesión de Mongo).
 * `context` es la clase del DbContext en la rama relacional.
 */
export function relayWakeBlock(model, { document, context }) {
  const bridge = bridgeClass(model);
  const [rw1, rw2, rw3] = RELAY_WAKE_CASES;
  const write = document
    ? `            await transactions.InTransaction(async () =>
            {
                Append.Invoke(bridge, ["probe.k", "Probe", "{}"]);
                await (Task)typeof(${bridge}).GetMethod("Flush", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(bridge, [Cancel])!;
                return 0;
            }, readOnly: false, Cancel);`
    : `            await transactions.InTransaction(async () =>
            {
                Append.Invoke(bridge, ["probe.k", "Probe", "{}"]);
                return await services.GetRequiredService<${context}>().SaveChangesAsync(Cancel);
            }, readOnly: false, Cancel);`;
  return `    // ─── El relay por réplica (DSL 2.26, inc. 9): RW-1 a RW-3 con el relay EMITIDO en marcha ───

    /// <summary>El dispatcher de la sonda: apunta cada intento y falla los que le pidan, como un broker caído.</summary>
    private sealed class WakeDispatcher : IOutboxDispatcher
    {
        public readonly System.Collections.Concurrent.ConcurrentQueue<long> Attempts = new();
        public int Failing;

        public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default)
        {
            Attempts.Enqueue(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return Interlocked.Decrement(ref Failing) >= 0 ? throw new InvalidOperationException("el broker no contesta") : Task.CompletedTask;
        }
    }

    private static readonly MethodInfo Append = typeof(${bridge}).GetMethod("Append", BindingFlags.NonPublic | BindingFlags.Instance)
        ?? throw new InvalidOperationException("el puente ya no tiene Append: ¿cambió cómo escribe el outbox?");

    /// <summary>Una fila por el puente, en su transacción, como la escribe un caso de uso.</summary>
    private static async Task WriteThroughBridge()
    {
        await InScope(async services =>
        {
            var transactions = services.GetRequiredService<PersistenceTransactions>();
            var bridge = services.GetRequiredService<${bridge}>();
${write}
        });
    }

    /// <summary>El relay emitido, arrancado con el sondeo de respaldo a ${PROBE_POLL_MS} ms, sobre un outbox sin pendientes.</summary>
    private static async Task<OutboxRelay> StartWakeRelay(WakeDispatcher dispatcher)
    {
        await SeedOutbox(0);
        var settings = MessagingSettings.Defaults with
        {
            OutboxRelay = new OutboxRelaySettings(Enabled: true, PollMs: ${PROBE_POLL_MS}, BatchSize: 3, MaxAttempts: 5, BackoffInitialMs: ${PROBE_BACKOFF_MS}, BackoffMaxMs: ${PROBE_BACKOFF_MS}, ClaimTimeoutMs: 60000)
        };
        var relay = new OutboxRelay(Relay, dispatcher, settings, root.GetRequiredService<DatabaseSettings>(), root.GetRequiredService<OutboxWakeup>(), NullLogger<OutboxRelay>.Instance);
        await relay.StartAsync(Cancel);
        // La pasada del arranque, con la tabla vacía: desde aquí solo un despertar o un reintento la hacen correr.
        await Task.Delay(300, Cancel);
        return relay;
    }

    private static async Task<long[]> AwaitAttempts(WakeDispatcher dispatcher, int count)
    {
        var limit = DateTimeOffset.UtcNow.AddMilliseconds(${PROBE_WAIT_MS});
        while (DateTimeOffset.UtcNow < limit && dispatcher.Attempts.Count < count)
        {
            await Task.Delay(20, Cancel);
        }
        return [.. dispatcher.Attempts];
    }

    /// <summary>${rw1.id}: ${rw1.what}.</summary>
    [Fact]
    public async Task RW1_UnEventoConfirmadoSaleSinEsperarAlSondeo()
    {
        var dispatcher = new WakeDispatcher();
        var relay = await StartWakeRelay(dispatcher);
        try
        {
            await WriteThroughBridge();
            var seen = await AwaitAttempts(dispatcher, 1);
            Assert.True(seen.Length >= 1, "el evento no salió en ${PROBE_WAIT_MS} ms: sin despertar espera al sondeo de respaldo (${PROBE_POLL_MS} ms)");
        }
        finally
        {
            await relay.StopAsync(CancellationToken.None);
            relay.Dispose();
        }
    }

    /// <summary>${rw2.id}: ${rw2.what}.</summary>
    [Fact]
    public async Task RW2_EnReposoNoHayPasadasHastaElSondeo()
    {
        var relay = await StartWakeRelay(new WakeDispatcher());
        try
        {
            await Task.Delay(500, Cancel);
            var before = relay.Passes;
            await Task.Delay(3000, Cancel);
            Assert.Equal(before, relay.Passes);
        }
        finally
        {
            await relay.StopAsync(CancellationToken.None);
            relay.Dispose();
        }
    }

    /// <summary>${rw3.id}: ${rw3.what}.</summary>
    [Fact]
    public async Task RW3_UnFalloSeReintentaASuBackoffYNoAlSondeo()
    {
        var dispatcher = new WakeDispatcher { Failing = 1 };
        var relay = await StartWakeRelay(dispatcher);
        try
        {
            await WriteThroughBridge();
            // El primer intento lo despierta el caso: RW-3 mide el reintento, y así el sabotaje del despertar no lo tumba.
            relay.Wake();
            var seen = await AwaitAttempts(dispatcher, 2);
            Assert.True(seen.Length == 2, $"la fila que falló no se reintentó en ${PROBE_WAIT_MS} ms ({seen.Length} intentos): esperó al sondeo de respaldo y no a su backoff");
            Assert.True(seen[1] - seen[0] >= ${PROBE_BACKOFF_MS - 50}, $"el reintento llegó antes de su backoff: {seen[1] - seen[0]} ms");
        }
        finally
        {
            await relay.StopAsync(CancellationToken.None);
            relay.Dispose();
        }
    }`;
}
