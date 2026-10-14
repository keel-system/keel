// La prueba EMITIDA del reloj (incremento 10b): lo que se puede ejecutar sin base ni reloj real.
//   · cada tarea de cada scheduler, con el nombre y el cron de seis campos que decide keel-core (scheduleCron), parsea
//     con Cronos y dispara en SU segundo repartido;
//   · las purgas: sus tareas con el cron de los defaults, y el bucle por lotes contra los casos de la referencia de
//     keel-core (PURGE_CASES, que test/scheduling.test.js vuelve a calcular con batchedPurgeReference).
// Lo que habla con la base (las purgas de verdad) lo juzga `db-check`.

import { BATCHED_PURGE, batchedPurgeParameters, scheduleCron } from 'keel-core/gen';
import { csFile, csString, namespaceOf, solution } from './render.js';
import { scheduledServices, schedulerClass, usesScheduling } from './scheduling.js';
import { PURGE_CASES, PURGE_CASES_CUTOFF, purgeNamespace, tablePurges } from './purge.js';

export function generate(model) {
  if (!usesScheduling(model)) return [];
  const sln = solution(model);
  const usings = ['Xunit', namespaceOf(model, 'scheduling')];
  const members = [];
  const services = scheduledServices(model);
  if (services.length > 0) members.push(schedulerTests(model, services));
  const purges = tablePurges(model);
  if (purges.length > 0) {
    usings.push(purgeNamespace(model));
    members.push(purgeTaskTests(purges), batchedPurgeTests());
  }
  const body = `public sealed class SchedulingTests
{
${members.join('\n\n')}
}`;
  return [{ path: `${sln.unitTests.dir}/SchedulingTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) }];
}

function schedulerTests(model, services) {
  const rows = services.flatMap(({ service, operations }) =>
    operations.map((operation) => {
      const cron = scheduleCron(model, operation);
      return `        [${csString(operation.name)}] = (${schedulerClass(service)}.Tasks(), ${csString(cron)}),`;
    })
  );
  return `    /// <summary>Cada operación por reloj: el cron de seis campos que decide keel-core (el segundo repartido + los cinco del diseño).</summary>
    private static readonly Dictionary<string, (IReadOnlyList<ScheduledTask> Tasks, string Cron)> Expected = new(StringComparer.Ordinal)
    {
${rows.join('\n')}
    };

    [Fact]
    public void CadaOperacionPorRelojLlevaElCronDeKeelCoreYDisparaEnSuSegundo()
    {
        foreach (var (name, (tasks, cron)) in Expected)
        {
            var task = Assert.Single(tasks, candidate => candidate.Name == name);
            Assert.Equal(cron, task.Cron);
            var second = int.Parse(cron.Split(' ')[0], System.Globalization.CultureInfo.InvariantCulture);
            // Desde el inicio de un minuto en punto, la primera ocurrencia cae en su segundo (o en el minuto siguiente si es 0).
            var from = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
            var next = task.NextAfter(from, TimeZoneInfo.Utc);
            Assert.NotNull(next);
            Assert.Equal(second, next.Value.Second);
        }
    }

    [Fact]
    public void UnCronInvalidoNoDejaArrancar()
    {
        var error = Assert.Throws<InvalidOperationException>(() => new ScheduledTask("roto", "0 0 3 * *", (_, _) => Task.CompletedTask));
        Assert.Contains("roto", error.Message, StringComparison.Ordinal);
    }`;
}

function purgeTaskTests(purges) {
  const schedules = purges.map((purge) => {
    const batch = batchedPurgeParameters(purge.prefix);
    return `new PurgeSchedule(${csString(purge.cron.default)}, ${purge.retentionDays ? purge.retentionDays.default : 'null'}, ${batch.batchSize.default}, ${batch.maxBatches.default})`;
  });
  return `    [Fact]
    public void CadaTablaDelGeneradorTieneSuPurgaConElCronDeKeelSpring()
    {
        var settings = new PurgeSettings(${schedules.join(', ')});
        var tasks = TablePurges.Tasks(settings);
        Assert.Equal(new[] { ${purges.map((purge) => csString(`purge:${purge.what}`)).join(', ')} }, tasks.Select(task => task.Name));
        Assert.Equal(new[] { ${purges.map((purge) => csString(purge.cron.default)).join(', ')} }, tasks.Select(task => task.Cron));
        Assert.Equal(${BATCHED_PURGE.batchSize}, BatchedPurge.DefaultBatchSize);
        Assert.Equal(${BATCHED_PURGE.maxBatches}, BatchedPurge.DefaultMaxBatches);
    }`;
}

function batchedPurgeTests() {
  const cases = PURGE_CASES.map(
    (c) => `    [InlineData(new long[] { ${c.instants.join(', ')} }, ${c.batchSize}, ${c.maxBatches}, ${c.deleted}, ${c.deletes}, ${c.exhausted}, new long[] { ${c.remaining.join(', ')} })]`
  );
  return `    /// <summary>
    /// El bucle por lotes contra los casos de la referencia de keel-core, sobre una tabla en memoria: instantes en ms (con
    /// repetidos en la frontera y con tope) y el corte en ${PURGE_CASES_CUTOFF}.
    /// </summary>
    [Theory]
${cases.join('\n')}
    public async Task LaPurgaPorLotesBorraLoMismoYEnLosMismosLotesQueLaReferencia(long[] instants, int batchSize, int maxBatches, long deleted, int deletes, bool exhausted, long[] remaining)
    {
        var rows = instants.OrderBy(at => at).ToList();
        var cutoff = DateTimeOffset.FromUnixTimeMilliseconds(${PURGE_CASES_CUTOFF});
        var calls = 0;
        var warnings = new List<string>();
        Task<DateTimeOffset?> Boundary(int position)
        {
            var eligible = rows.Where(at => at < cutoff.ToUnixTimeMilliseconds()).ToList();
            return Task.FromResult<DateTimeOffset?>(position < eligible.Count ? DateTimeOffset.FromUnixTimeMilliseconds(eligible[position]) : null);
        }
        Task<int> DeleteUpTo(DateTimeOffset upTo)
        {
            calls += 1;
            return Task.FromResult(rows.RemoveAll(at => at < cutoff.ToUnixTimeMilliseconds() && at <= upTo.ToUnixTimeMilliseconds()));
        }

        var total = await BatchedPurge.Run("tabla", batchSize, maxBatches, cutoff, Boundary, DeleteUpTo, warnings.Add);

        Assert.Equal(deleted, total);
        Assert.Equal(deletes, calls);
        Assert.Equal(exhausted ? 1 : 0, warnings.Count);
        Assert.Equal(remaining, rows);
    }

    [Fact]
    public async Task UnLoteQueNoEsUnEnteroPositivoNoCorre()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            BatchedPurge.Run("tabla", 0, 1, DateTimeOffset.UnixEpoch, _ => Task.FromResult<DateTimeOffset?>(null), _ => Task.FromResult(0), _ => { }));
    }`;
}
