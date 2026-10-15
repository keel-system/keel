// El arnés de flujos sobre MongoDB (incremento 12d): lo que en la rama relacional hace `Db` con una sentencia SQL, aquí lo
// hace `MongoEval` con un script de mongosh, y con él los ayudantes que fabrican las precondiciones que ninguna operación
// del diseño produce —la fila atascada de un rescate, la marca de espera envejecida de una reconciliación—. Los mismos
// nombres que el AbstractFlowIT de keel-spring y el flow.ts de keel-nest, y los MISMOS scripts: salen de
// keel-core/gen/mongo-probes.js, la fuente que comparten los tres.
//
// Dos trampas que esa fuente documenta y que aquí se respetan tal cual (Harness.MongoEval, en integration-tests.js):
//   · el script viaja por ARCHIVO dentro del contenedor, no por `--eval`: en Windows el cliente de contenedores se come las
//     comillas de un argumento;
//   · ejecutado por archivo, mongosh NO imprime el valor de la última expresión: sin el envoltorio `print(...)` un
//     countDocuments devuelve cadena vacía, y la cadena vacía se parece a un cero.

import { CLOCK, setStateScript, ageClockScript, holdClockScript, missingClockCountScript } from 'keel-core/gen/mongo-probes';
import { rescueProbes } from 'keel-core/gen';
import { documentShape } from 'keel-core/gen/document';
import { csString } from './render.js';

/** Las marcas de espera que envejece `AgeForReconciliation`, por activación, con su colección y su clave del documento. */
function agingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        const entity = (model.entities ?? []).find((candidate) => candidate.name === target.entity);
        if (!entity?.collectionName || !target.awaitingField) continue;
        const clockField = documentShape(model, entity).find((entry) => entry.member === target.awaitingField)?.name;
        if (!clockField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push({ collection: entity.collectionName, clockField });
      }
    }
  }
  return targets;
}

/** Un par [prefijo, sufijo] de un script partido, como tupla C#. */
const pair = (script) => `(${csString(script.prefix)}, ${csString(script.suffix)})`;

/** Los miembros de FlowTest sobre documentos: `MongoEval`, el rescate, la reconciliación y el id de un documento. */
export function documentFlowMembers(model, probe) {
  const members = [
    String.raw`    /// <summary>
    /// Ejecuta un script de mongosh contra la base de prueba (${probe.label}) y devuelve su salida en crudo. Es para lo que no
    /// se ve por HTTP: que una escritura llegó de verdad al almacén, o la precondición de un escenario que ninguna operación
    /// del diseño puede fabricar. Si el servicio lo expone por su API, se comprueba por ahí. Los nombres son los del
    /// DOCUMENTO (snake_case, <c>_id</c>), y un id va como <c>UUID("…")</c>: un literal que no case deja el script en cero
    /// modificados SIN fallar.
    /// </summary>
    /// <example><c>MongoEval("db.getCollection(\"jobs\").countDocuments({ status: \"QUEUED\" })")</c></example>
    protected static string MongoEval(string script) => Harness.MongoEval(script);`
  ];
  const rescue = rescueMembers(model);
  const aging = agingMembers(model);
  members.push(...rescue, ...aging);
  if (rescue.length > 0 || aging.length > 0) {
    members.push(`    /// <summary>Un id de documento para un script: valida la forma antes de meterlo dentro de <c>UUID("…")</c>.</summary>
    private static string DocumentId(string id) =>
        Guid.TryParseExact(id, "D", out _) ? id : throw new ArgumentException($"No es un id: '{id}'", nameof(id));`);
  }
  return members;
}

/**
 * El rescate de cada barrido que lo tiene, sobre documentos: los mismos tres ayudantes que la rama relacional, con los
 * scripts de setStateScript y missingClockCountScript. El reloj «rancio» es la época y el de «ahora», el instante de la
 * escritura: la diferencia es lo que separa rescatar de robarle el trabajo a quien lo está haciendo.
 */
function rescueMembers(model) {
  const probes = rescueProbes(model);
  if (probes.length === 0) return [];
  const rows = probes.map((probe) => {
    const shape = { collection: probe.table, stateField: probe.stateColumn, state: probe.state, clockField: probe.clockColumn };
    const stall = setStateScript({ ...shape, clock: CLOCK.stale });
    const put = setStateScript({ ...shape, clock: CLOCK.now });
    return `        [${csString(probe.operation)}] = (${pair(stall)}, ${pair(put)}, ${csString(missingClockCountScript(shape))}),`;
  });
  const known = probes.map((probe) => probe.operation).join(', ');
  return [
    `    /// <summary>Los scripts del rescate de cada barrido que lo tiene: ${known}.</summary>
    private static readonly Dictionary<string, ((string Prefix, string Suffix) Stall, (string Prefix, string Suffix) Put, string Missing)> Rescues = new(StringComparer.Ordinal)
    {
${rows.join('\n')}
    };`,
    `    /// <summary>
    /// Deja el documento <paramref name="id"/> EN VUELO con el reloj infinitamente rancio: el estado exacto en el que queda
    /// una réplica que murió con él en la mano, que es lo que el rescate busca. No dispara el barrido —lo dispara su cron,
    /// como en producción— y no siembra el documento: mueve uno creado por la API.
    /// </summary>
    protected static void StallInFlight(string operation, string id)
    {
        var (prefix, suffix) = RescueOf(operation).Stall;
        MongoEval(prefix + DocumentId(id) + suffix);
    }`,
    `    /// <summary>
    /// Lo mismo con el reloj a AHORA: acaba de entrar en vuelo y hay alguien trabajando en él. Un rescate sin cota temporal
    /// pasa el escenario del rescate y falla aquí.
    /// </summary>
    protected static void PutInFlight(string operation, string id)
    {
        var (prefix, suffix) = RescueOf(operation).Put;
        MongoEval(prefix + DocumentId(id) + suffix);
    }`,
    `    /// <summary>
    /// Cuántos documentos quedaron EN VUELO sin reloj. Tiene que valer cero siempre. Vacío NO es cero: es un fallo del
    /// transporte, y se dice.
    /// </summary>
    protected static int InFlightWithoutClock(string operation)
    {
        var output = MongoEval(RescueOf(operation).Missing).Trim();
        var last = output.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        return int.TryParse(last, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var count)
            ? count
            : throw new InvalidOperationException($"La cuenta de documentos sin reloj no es un número: '{output}'");
    }`,
    `    private static ((string Prefix, string Suffix) Stall, (string Prefix, string Suffix) Put, string Missing) RescueOf(string operation) =>
        Rescues.TryGetValue(operation, out var rescue)
            ? rescue
            : throw new ArgumentException($"No hay rescate para el barrido '{operation}'. Los que lo tienen: ${known}", nameof(operation));`
  ];
}

/** `AgeForReconciliation` y `HoldFromReconciliation` sobre documentos: mueven SOLO la marca de espera de ese documento. */
function agingMembers(model) {
  const targets = agingTargets(model);
  if (targets.size === 0) return [];
  const known = [...targets.keys()].join(', ');
  const first = [...targets.keys()][0];
  const table = (script) =>
    [...targets].map(([name, list]) => `        [${csString(name)}] = [${list.map((target) => pair(script(target))).join(', ')}],`).join('\n');
  return [
    `    /// <summary>Las marcas de espera que envejece AgeForReconciliation, por activación: ${known}.</summary>
    private static readonly Dictionary<string, (string Prefix, string Suffix)[]> ReconciliationAging = new(StringComparer.Ordinal)
    {
${table(ageClockScript)}
    };`,
    `    /// <summary>
    /// Deja la marca de espera de <paramref name="activation"/> infinitamente rancia para el documento <paramref name="id"/>, de
    /// modo que el barrido lo tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron—, y no toca el estado: el
    /// documento ya está donde el barrido lo busca. Bajar el umbral por configuración sería global.
    /// </summary>
    /// <example>
    /// <code>
    /// AgeForReconciliation(${csString(first)}, id);
    /// await Eventually(async () => …, TimeSpan.FromSeconds(90));
    /// </code>
    /// </example>
    protected static void AgeForReconciliation(string activation, string id)
    {
        if (!ReconciliationAging.TryGetValue(activation, out var scripts))
        {
            throw new ArgumentException($"No hay barrido para la activación '{activation}'. Las que lo tienen: ${known}", nameof(activation));
        }
        foreach (var (prefix, suffix) in scripts)
        {
            MongoEval(prefix + DocumentId(id) + suffix);
        }
    }`,
    `    /// <summary>Las marcas de espera que retiene HoldFromReconciliation, por activación.</summary>
    private static readonly Dictionary<string, (string Prefix, string Suffix)[]> ReconciliationHolding = new(StringComparer.Ordinal)
    {
${table(holdClockScript)}
    };`,
    `    /// <summary>
    /// El inverso de AgeForReconciliation: deja la marca de espera de <paramref name="activation"/> en el FUTURO para el
    /// documento <paramref name="id"/>, de modo que el barrido NO lo tome aunque pasen sus ciclos. Es la palanca de un
    /// escenario que pide «lo que acaba de encargarse no se toca».
    /// </summary>
    protected static void HoldFromReconciliation(string activation, string id)
    {
        if (!ReconciliationHolding.TryGetValue(activation, out var scripts))
        {
            throw new ArgumentException($"No hay barrido para la activación '{activation}'. Las que lo tienen: ${known}", nameof(activation));
        }
        foreach (var (prefix, suffix) in scripts)
        {
            MongoEval(prefix + DocumentId(id) + suffix);
        }
    }`
  ];
}

/** SMOKE-3 sobre documentos: la base responde a un script, por archivo e impreso. */
export function documentSmokeCase() {
  return String.raw`    [Scenario("SMOKE-3: la base de prueba responde a un script")]
    public void LaBaseResponde() =>
        // Es la vía de los Then que miran el almacén y de las precondiciones del rescate y la reconciliación: el script
        // viaja por ARCHIVO e impreso. Si esto no devuelve 1, devolverían vacío, que parece un cero.
        Assert.Equal("1", MongoEval("db.runCommand({ ping: 1 }).ok").Trim());`;
}
