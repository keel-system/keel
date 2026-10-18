// Integraciones HTTP salientes (capa `http-clients`, incremento 11b), con el reparto hexagonal de keel-spring y
// keel-nest: el PUERTO `I<Cliente>Client` y los resultados `<Llamada>Result` viven en Domain/Clients (en términos del
// dominio); el adaptador, los DTOs del cable del tercero y el mapper de anticorrupción, en Infrastructure/Clients. Si el
// tercero cambia su contrato, cambian los DTOs, el mapper y el adaptador — nunca el dominio ni los casos de uso.
//
// QUÉ reintenta el retry, qué cuenta el circuito, qué atiende el fallback y con qué números lo decide keel-core
// (`gen/outbound-resilience.js`), igual que para los servidores de keel-spring y keel-nest del mismo diseño. El
// circuito NO es el de una librería (Polly): es la máquina de estados de resilience4j, escrita aquí y comparada con la
// referencia ejecutable de keel-core (`circuitBreakerReference`) en la prueba emitida. La misma decisión que keel-nest
// tomó con cockatiel (PLAN-KEEL-NEST.md, 11b): una librería con otra semántica haría que los tres servidores cortaran
// por cosas distintas, y no hace falta ningún paquete: HttpClient es de la biblioteca base.
//
// El fallback no atiende cualquier error: un filtro de excepción (`catch … when`) deja pasar solo los fallos del
// proveedor de la tabla neutral; lo demás —un bug del adaptador, un cuerpo que viola el contrato— se propaga con su
// traza sin que nadie lo capture.

import { fallbackFailures, hasCallFallback, recordedFailures, resiliencePolicy, retryWaitMs, circuitBreakerReference, PROVIDER_FAILURES } from 'keel-core/gen/outbound-resilience';
import { httpClientsYaml } from 'keel-core/gen/http-clients-config';
import { LAST_KNOWN_MAX_ENTRIES, lastKnownNeeds, servesLastKnown } from 'keel-core/gen/last-known';
import { UNREACHABLE_BASE_URL } from 'keel-core/gen/infra-catalog';
import { pascalCase } from 'keel-core/gen';
import { csFile, csLocal, csMember, csString, declType, fieldUsings, located, namespaceOf, solution, xmlDoc } from './render.js';
import { configNamespace } from './config.js';
import { wireNamespace } from './wire.js';
import { usesCorrelation } from './rest-support.js';
import { telemetryNamespace, usesTelemetry } from './telemetry.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Genera este diseño clientes salientes? */
export function usesHttpClients(model) {
  return Boolean(model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0);
}

/** ¿Alguna llamada manda clave de idempotencia al proveedor? Entonces hace falta CommandSignature aunque no haya registro. */
export function usesOutboundIdempotency(model) {
  return usesHttpClients(model) && model.httpClients.some((client) => client.calls.some((call) => call.idempotency));
}

/** El puerto de un cliente: una interfaz, como el repositorio (`IInventoryClient`). */
export function clientPort(client) {
  return `I${client.clientClass}`;
}

export function clientsNamespace(model) {
  return namespaceOf(model, 'clients');
}

export function clientAdaptersNamespace(model) {
  return namespaceOf(model, 'clientAdapters');
}

/** El método C# de una llamada (`cancelStock` → `CancelStock`). */
export function callMethod(call) {
  return csMember(call.name);
}

export function generate(model) {
  if (!usesHttpClients(model)) return [];
  const infra = (name) => located(model, 'clientAdapters', name);
  const support = (name, body, usings = []) => ({ path: infra(name).path, content: csFile({ namespace: clientAdaptersNamespace(model), usings, body }) });
  const files = [
    support('ProviderFailures', providerFailuresCs()),
    support('CircuitBreaker', circuitBreakerCs()),
    support('OutboundResilience', outboundResilienceCs()),
    support(
      'HttpExchange',
      httpExchangeCs(model),
      [
        'System.Globalization',
        'System.Net.Http.Headers',
        'System.Net.Sockets',
        'System.Runtime.CompilerServices',
        'System.Text.Json',
        'System.Text.RegularExpressions',
        wireNamespace(model),
        ...(usesTelemetry(model) ? ['System.Diagnostics', telemetryNamespace(model)] : [])
      ]
    ),
    support('ResponseReading', responseReadingCs(model), ['System.Text.Json', wireNamespace(model)]),
    support('HttpClientsSettings', settingsCs(model), ['System.Text', configNamespace(model)]),
    registration(model),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/http-clients.yaml`, content: httpClientsYaml(model, profile) })),
    emittedTests(model)
  ];
  if (usesOutboundIdempotency(model)) files.push(outboundIdempotency(model));
  if (usesLastKnown(model)) files.push(lastKnownValues(model));
  if (usesOAuth2(model)) files.push(clientCredentials(model));
  for (const client of model.httpClients) {
    files.push(port(model, client), mapper(model, client), adapter(model, client));
    for (const call of client.calls) {
      if (!call.bodiless) files.push(result(model, client, call), response(model, client, call));
      if (call.requestType) files.push(request(model, client, call));
    }
  }
  return files;
}

// ─── Campos ──────────────────────────────────────────────────────────────────────────────────────

/** Los parámetros de una llamada, en el orden del puerto: ruta, query, cabeceras y cuerpo. */
function callFields(call) {
  return [...call.pathParams, ...call.queryParams, ...call.headerParams, ...call.bodyFields];
}

/** Un identificador local C# para un parámetro (una cabecera puede llamarse `X-Request-Id`). */
function paramName(field) {
  return csLocal(String(field.name).replace(/[^A-Za-z0-9_]+(.)?/g, (_, next) => (next ? next.toUpperCase() : '')));
}

function callParams(call) {
  const params = callFields(call).map((field) => `${declType(field)} ${paramName(field)}`);
  // Contrato solo en prosa: el cuerpo sin tipar, como el `Object body` de keel-spring.
  if (call.hasBody && !call.requestType) params.push('object body');
  return params;
}

function callArgs(call) {
  const args = callFields(call).map(paramName);
  if (call.hasBody && !call.requestType) args.push('body');
  return args;
}

function usingsOf(model, fields) {
  return fields.flatMap((field) => fieldUsings(model, field));
}

const VALUE_TYPES = new Set(['int', 'long', 'decimal', 'bool', 'Guid', 'DateOnly', 'DateTimeOffset', 'JsonElement']);

/** ¿Es un tipo por valor? Su nulo no existe y una guarda de presencia no compilaría limpia. */
function isValueType(field) {
  return !field.list && (field.kind === 'enum' || VALUE_TYPES.has(field.csType));
}

/** Un campo de un resultado del dominio: siempre admite su ausencia (el resultado neutro de un fallback), y una lista vacía. */
function resultDecl(field) {
  return field.list ? field.csType : `${field.csType}?`;
}

/** El tipo de un campo en el DTO del cable: el obligatorio no admite nulo (lo garantiza la lectura). */
function wireDecl(field) {
  if (field.list) return field.csType;
  return field.required ? field.csType : `${field.csType}?`;
}

/** Lo que se esperaba, para el mensaje de un campo que viola el contrato. */
function expected(model, field) {
  const element = (() => {
    if (field.kind === 'enum') {
      const values = model.enums?.find((e) => e.name === (field.elementCsType ?? field.csType))?.values ?? [];
      return values.length > 0 ? `un valor de ${values.map((v) => v.literal).join('|')}` : 'un valor del enum';
    }
    if (field.kind === 'composite') return `un ${field.elementCsType ?? field.csType}`;
    return (
      {
        string: 'un texto',
        text: 'un texto',
        file: 'un texto',
        boolean: 'un booleano',
        uuid: 'un uuid',
        int: 'un entero',
        long: 'un entero de 64 bits',
        decimal: 'un decimal',
        timestamp: 'un instante ISO-8601 con zona',
        date: 'una fecha YYYY-MM-DD',
        json: 'un documento JSON'
      }[field.base] ?? 'un texto'
    );
  })();
  return field.list ? `una lista de ${element.replace(/^una? /, '')}` : element;
}

const elementType = (field) => field.elementCsType ?? String(field.csType).replace(/^IReadOnlyList<(.+)>$/, '$1');

// ─── Puerto y resultados (Domain/Clients) ────────────────────────────────────────────────────────

function port(model, client) {
  const { namespace, path } = located(model, 'clients', clientPort(client));
  const usings = usingsOf(model, client.calls.flatMap(callFields));
  const methods = client.calls.map((call) => {
    const returns = call.bodiless ? 'Task' : `Task<${call.resultType}>`;
    return `${xmlDoc(call.contract, '    ')}    ${returns} ${callMethod(call)}(${[...callParams(call), 'CancellationToken cancellationToken = default'].join(', ')});`;
  });
  const body = `${xmlDoc([client.purpose, `Puerto de salida del dominio; el adaptador HTTP (${client.adapterClass}) vive en Infrastructure/Clients.`])}public interface ${clientPort(client)}
{
${methods.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function result(model, client, call) {
  const { namespace, path } = located(model, 'clients', call.resultType);
  const todo = call.responseFields.length === 0 ? [`TODO (agente): declara los campos según el contract "${call.contract}".`] : [];
  // Con `lastKnown`, el valor rescatado se marca: se sirve, pero quien lo exponga no lo cachea (keel-core/gen/last-known.js).
  const stale = call.responseFields.length > 0 && servesLastKnown(model, client.id, call.name);
  const members = [...call.responseFields.map((field) => `${resultDecl(field)} ${csMember(field.name)}`), ...(stale ? ['bool Stale = false'] : [])];
  const notes = stale ? ['Stale es true cuando el valor es el último conocido (onUnavailable: lastKnown) y no uno recién leído: se sirve, pero una respuesta que lo lleve no se cachea.'] : [];
  const asStale = stale
    ? `
{
    /// <summary>El mismo valor, rescatado como ÚLTIMO CONOCIDO: puede tener hasta la edad máxima que declara el diseño.</summary>
    public ${call.resultType} AsStale() => this with { Stale = true };
}`
    : ';';
  const body = `${xmlDoc([`Resultado de ${client.id}.${call.name} en términos del dominio. Cada campo admite su ausencia: es lo que`, 'devuelve el fallback cuando el proveedor no dijo nada.', ...todo, ...notes])}public sealed record ${call.resultType}(${members.join(', ')})${asStale}`;
  return { path, content: csFile({ namespace, usings: usingsOf(model, call.responseFields), body }) };
}

// ─── DTOs del cable (Infrastructure/Clients) ─────────────────────────────────────────────────────

function response(model, client, call) {
  const { namespace, path } = located(model, 'clientAdapters', call.responseType);
  const subject = `${client.id}.${call.name}`;
  const fields = call.responseFields;
  const members = fields.map((field) => `${wireDecl(field)} ${csMember(field.name)}`);
  const reads = fields.map((field) => {
    const where = csString(`${subject}.${field.name}`);
    const what = csString(expected(model, field));
    if (isComposite(field)) {
      // El compuesto se lee con el MISMO lector que la entrada (ValueReaders.Read<Tipo>, las guardas de su constructor), como
      // keel-nest: lo que rechaza viola el contrato del PROVEEDOR, no es un 400 nuestro.
      const reader = `ValueReaders.Read${elementType(field)}`;
      if (field.list) return `            ResponseReading.CompositeList(fields, ${csString(field.name)}, ${where}, ${what}, ${reader})`;
      if (field.required) {
        const missing = csString(`${subject}: la respuesta no trae '${field.name}', que el contrato declara obligatorio`);
        return `            ResponseReading.RequiredComposite(fields, ${csString(field.name)}, ${where}, ${what}, ${missing}, ${reader})`;
      }
      return `            ResponseReading.Composite(fields, ${csString(field.name)}, ${where}, ${what}, ${reader})`;
    }
    if (field.list) return `            ResponseReading.List<${elementType(field)}>(fields, ${csString(field.name)}, ${where}, ${what})`;
    if (field.required) {
      const missing = csString(`${subject}: la respuesta no trae '${field.name}', que el contrato declara obligatorio`);
      return `            ResponseReading.Required<${field.csType}>(fields, ${csString(field.name)}, ${where}, ${what}, ${missing})`;
    }
    return `            ResponseReading.Optional<${field.csType}?>(fields, ${csString(field.name)}, ${where}, ${what})`;
  });
  const todo = fields.length === 0 ? [`TODO (agente): declara los campos según el contract "${call.contract}".`] : [];
  const read =
    fields.length > 0
      ? `        var fields = ResponseReading.Object(body, ${csString(subject)});
        return new ${call.responseType}(
${reads.join(',\n')});`
      : `        ResponseReading.Object(body, ${csString(subject)});
        return new ${call.responseType}();`;
  const body = `${xmlDoc([`Respuesta del cable de ${subject} (contrato del sistema externo).`, ...todo])}public sealed record ${call.responseType}(${members.join(', ')})
{
    /// <summary>
    /// Lee el cuerpo del proveedor. Un campo que el contrato declara obligatorio y no llega, o que llega con otro tipo,
    /// es un OutboundContractException: NO es «el proveedor no está» (no entra al fallback ni cuenta para el circuito) y
    /// sale como 500 con su traza, igual que en keel-spring y keel-nest.
    /// </summary>
    public static ${call.responseType} Read(JsonElement body)
    {
${read}
    }
}`;
  const readers = fields.some(isComposite) ? [namespaceOf(model, 'appSupport')] : [];
  return { path, content: csFile({ namespace, usings: ['System.Text.Json', ...readers, ...usingsOf(model, fields)], body }) };
}

const isComposite = (field) => field.kind === 'composite';

/** ¿Alguna respuesta trae un value object compuesto? Se lee con su ValueReaders.Read<Tipo>, que emite rest-support.js. */
export function readsCompositeResponses(model) {
  return (model.httpClients ?? []).some((client) => client.calls.some((call) => !call.bodiless && call.responseFields.some(isComposite)));
}

function request(model, client, call) {
  const { namespace, path } = located(model, 'clientAdapters', call.requestType);
  const subject = `${client.id}.${call.name}`;
  const params = call.bodyFields.map((field) => `${declType(field)} ${paramName(field)}`);
  // La misma guarda que keel-spring y keel-nest: aquí el dato es NUESTRO, así que un obligatorio nulo es un bug propio,
  // y saltar antes de mandarlo evita estrenarlo contra un tercero en una escritura con reintentos.
  const guards = call.bodyFields
    .filter((field) => (field.required || field.list) && !isValueType(field))
    .map(
      (field) => `        if (${paramName(field)} is null)
        {
            throw new OutboundContractException(${csString(`${subject}: la petición no lleva '${field.name}', que el contrato declara obligatorio`)});
        }`
    );
  const assigns = call.bodyFields.map((field) => `        ${csMember(field.name)} = ${paramName(field)};`);
  const props = call.bodyFields.map((field) => `    [JsonPropertyName(${csString(field.name)})]
    public ${declType(field)} ${csMember(field.name)} { get; }`);
  const body = `${xmlDoc(`Cuerpo del cable de ${subject} (contrato del sistema externo): lo escribe el contrato del cable (WireJson).`)}public sealed class ${call.requestType}
{
    public ${call.requestType}(${params.join(', ')})
    {
${[...guards, ...assigns].join('\n')}
    }

${props.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings: ['System.Text.Json.Serialization', ...usingsOf(model, call.bodyFields)], body }) };
}

// ─── Mapper de anticorrupción ────────────────────────────────────────────────────────────────────

function mapper(model, client) {
  const { namespace, path } = located(model, 'clientAdapters', client.mapperClass);
  const methods = [];
  for (const call of client.calls) {
    if (!call.bodiless) {
      if (call.responseFields.length > 0) {
        methods.push(`    /// <summary>Traduce la respuesta del cable de ${call.name} al resultado del dominio.</summary>
    public ${call.resultType} To${call.pascal}Result(${call.responseType} response)
    {
        ArgumentNullException.ThrowIfNull(response);
        return new ${call.resultType}(${call.responseFields.map((field) => `response.${csMember(field.name)}`).join(', ')});
    }`);
      } else {
        methods.push(`    /// <summary>Traduce la respuesta del cable de ${call.name} al resultado del dominio.</summary>
    public ${call.resultType} To${call.pascal}Result(${call.responseType} response)
    {
        // TODO (agente): mapea la respuesta del contract "${call.contract}" al resultado del dominio.
        ArgumentNullException.ThrowIfNull(response);
        return new ${call.resultType}();
    }`);
      }
    }
    if (call.requestType) {
      methods.push(`    /// <summary>Arma el cuerpo del cable de ${call.name} desde los valores del dominio.</summary>
    public ${call.requestType} To${call.pascal}Request(${call.bodyFields.map((field) => `${declType(field)} ${paramName(field)}`).join(', ')}) =>
        new(${call.bodyFields.map(paramName).join(', ')});`);
    }
  }
  const body = `${xmlDoc([
    `Capa de anticorrupción de ${client.id}: traduce entre el contrato del cable del sistema externo y los tipos del`,
    'dominio. Si el tercero cambia su contrato, el cambio se absorbe aquí (y en los DTOs del cable), nunca en el dominio.'
  ])}public sealed class ${client.mapperClass}
{
${methods.join('\n\n')}
}`;
  const usings = [clientsNamespace(model), ...usingsOf(model, client.calls.flatMap((call) => [...call.bodyFields, ...call.responseFields]))];
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Adaptador ───────────────────────────────────────────────────────────────────────────────────

const KIND = (kind) => `ProviderFailureKind.${pascalCase(kind)}`;
const policyField = (call) => `${call.pascal}Policy`;
const circuitField = (call) => `${csLocal(call.name)}Circuit`;

/** La política de una llamada como literal C#: la de keel-core, ya resuelta. */
function policyLiteral(call) {
  const policy = resiliencePolicy(call);
  const retry = policy.retry
    ? `new RetrySpec(${policy.retry.maxAttempts}, ${policy.retry.initialDelayMs}, ${policy.retry.multiplier ?? 'null'}, ${policy.retry.maxDelayMs ?? 'null'}, [${policy.retry.retries.map(KIND).join(', ')}])`
    : 'null';
  return `new OutboundPolicy(${csString(policy.instance)}, ${retry}, ${circuitSpec(policy.circuitBreaker)})`;
}

function circuitSpec(cb) {
  return cb ? `new CircuitBreakerSpec(${cb.failureRateThreshold}, ${cb.slidingWindowSize}, ${cb.minimumNumberOfCalls}, ${cb.waitDurationMs}, ${cb.halfOpenCalls})` : 'null';
}

/** Lo que el resultado lleva cuando el proveedor no dijo nada: listas vacías y el resto ausente. */
function neutralResult(call) {
  return `new ${call.resultType}(${call.responseFields.map((field) => (field.list ? '[]' : 'null')).join(', ')})`;
}

function adapter(model, client) {
  const { namespace, path } = located(model, 'clientAdapters', client.adapterClass);
  const usings = ['Microsoft.Extensions.Logging', clientsNamespace(model), ...usingsOf(model, client.calls.flatMap(callFields))];
  const members = [];
  const methods = client.calls.map((call) => adapterMethod(model, client, call, usings, members));
  // Solo lo que los métodos usan: un parámetro del constructor primario que nadie lee es un warning, y aquí un error.
  const dependencies = adapterDependencies(client, methods.join('\n')).map(({ type, name }) => `    ${type} ${name}`);
  const body = `${xmlDoc(`Adaptador HTTP de ${client.id}: implementa ${clientPort(client)} sobre HttpClient, con la resiliencia que declara el diseño.`)}public sealed class ${client.adapterClass}(
${dependencies.join(',\n')}) : ${clientPort(client)}
{
    private readonly ClientSettings client = settings[${csString(client.id)}];
${members.length > 0 ? `\n${members.join('\n\n')}\n` : ''}
${methods.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** Las dependencias del adaptador que de verdad usan sus métodos, en el orden de su constructor. */
function adapterDependencies(client, methods) {
  return [
    { type: 'HttpClientsSettings', name: 'settings', used: true, sample: 'HttpClientsSettings.Unreachable' },
    { type: client.mapperClass, name: 'mapper', used: /\bmapper\./.test(methods), sample: `new ${client.mapperClass}()` },
    { type: 'HttpExchange', name: 'http', used: /\bhttp\.Send\(/.test(methods), sample: 'new HttpExchange(provider)' },
    { type: `ILogger<${client.adapterClass}>`, name: 'logger', used: /\blogger\.Log/.test(methods), sample: `NullLogger<${client.adapterClass}>.Instance` },
    // Con `onUnavailable: lastKnown`, el almacén del último valor (13j): lo alimenta el camino feliz, lo lee el fallback.
    { type: 'LastKnownValues', name: 'lastKnown', used: /\blastKnown\.(Remember|Recall)/.test(methods), sample: 'lastKnown ?? new LastKnownValues()' }
  ].filter((dependency) => dependency.used);
}

/** ¿Esta llamada resuelve un need con `onUnavailable: lastKnown`? Entonces el camino feliz recuerda su resultado. */
function remembersCall(model, client, call) {
  return servesLastKnown(model, client.id, call.name) && call.responseFields.length > 0;
}

/**
 * La clave del último valor conocido: los MISMOS parámetros de la llamada. Es lo que hace que el fallback sirva el último
 * precio DE ESE sku y no el del último que se consultara.
 */
function lastKnownKey(call) {
  const args = callArgs(call);
  return args.length === 0 ? 'LastKnownValues.Key()' : `LastKnownValues.Key(${args.join(', ')})`;
}

/** ¿Hay algún need con `lastKnown`? Entonces se emite el almacén y se registra. */
export function usesLastKnown(model) {
  return lastKnownNeeds(model).length > 0;
}

/**
 * El último valor conocido de cada llamada saliente: el LastKnownValues de keel-spring y keel-nest, acotado por edad (la que
 * declara el diseño, al LEER) y por tamaño (el tope de keel-core).
 */
function lastKnownValues(model) {
  const { namespace, path } = located(model, 'clientAdapters', 'LastKnownValues');
  const body = `/// <summary>
/// El último valor conocido de cada llamada saliente, para la política <c>onUnavailable: lastKnown</c> del diseño: el
/// LastKnownValues de keel-spring y keel-nest.
/// </summary>
/// <remarks>
/// <b>Acotado por edad y por tamaño, y las dos cotas importan.</b> La edad la declara el diseño (<c>maxAgeSeconds</c> del
/// need) y se aplica al LEER: pasado ese tiempo el valor deja de existir para quien pregunta, y el fallback lanza el error
/// declarado en vez de servir algo que ya no significa nada. El tamaño lo pone este almacén.
/// En memoria y por instancia a propósito: lo que promete es «lo último que ESTE proceso llegó a leer». Sobre la caché
/// compartida prometería otra cosa y metería una dependencia más en el camino que se recorre cuando algo ya está caído.
/// </remarks>
public sealed class LastKnownValues(TimeProvider? clock = null)
{
    /// <summary>Tope de entradas vivas: la clave la forman los parámetros de la llamada, así que sin tope es una fuga lenta.</summary>
    public const int MaxEntries = ${LAST_KNOWN_MAX_ENTRIES};

    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);

    private sealed record Entry(object Value, DateTimeOffset StoredAt);

    /// <summary>La clave de los parámetros de una llamada, en su orden y con su texto invariante.</summary>
    public static string Key(params object?[] parts) =>
        string.Join("\\u001f", parts.Select(part => Convert.ToString(part, CultureInfo.InvariantCulture) ?? "\\u0000"));

    /// <summary>Recuerda lo que la llamada acaba de devolver. Se invoca en el camino FELIZ del adaptador.</summary>
    public void Remember(string scope, string key, object? value)
    {
        if (value is null)
        {
            return;
        }
        if (entries.Count >= MaxEntries)
        {
            EvictOldest();
        }
        entries[scope + "|" + key] = new Entry(value, clock.GetUtcNow());
    }

    /// <summary>
    /// El último valor de esa llamada si aún está dentro de <paramref name="maxAgeSeconds"/>; null si no hay ninguno o si el
    /// que hay ya es demasiado viejo. El caducado se borra al detectarlo, para que el tope no expulse valores útiles.
    /// </summary>
    public T? Recall<T>(string scope, string key, int maxAgeSeconds)
        where T : class
    {
        var id = scope + "|" + key;
        if (!entries.TryGetValue(id, out var entry))
        {
            return null;
        }
        if (clock.GetUtcNow() - entry.StoredAt > TimeSpan.FromSeconds(maxAgeSeconds))
        {
            entries.TryRemove(id, out _);
            return null;
        }
        return entry.Value as T;
    }

    /// <summary>Deja sitio tirando las entradas más viejas, que son las que menos van a servir.</summary>
    private void EvictOldest()
    {
        var excess = Math.Max(1, entries.Count - (MaxEntries * 3 / 4));
        foreach (var old in entries.OrderBy(pair => pair.Value.StoredAt).Take(excess).ToList())
        {
            entries.TryRemove(old.Key, out _);
        }
    }
}`;
  return { path, content: csFile({ namespace, usings: ['System.Collections.Concurrent', 'System.Globalization'], body }) };
}

/** Las dependencias de un adaptador ya renderizado (las lee la prueba emitida para construirlo). */
function renderedAdapterDependencies(model, client) {
  const members = [];
  const methods = client.calls.map((call) => adapterMethod(model, client, call, [], members));
  return adapterDependencies(client, methods.join('\n'));
}

function adapterMethod(model, client, call, usings, members) {
  const subject = `${client.id}.${call.name}`;
  const method = callMethod(call);
  const params = [...callParams(call), 'CancellationToken cancellationToken = default'];
  const args = [...callArgs(call), 'cancellationToken'].join(', ');
  const returns = call.bodiless ? 'Task' : `Task<${call.resultType}>`;
  const doc = xmlDoc(call.contract, '    ');

  if (!call.method) {
    return `${doc}    public ${returns} ${method}(${params.join(', ')})
    {
        // TODO (agente): completar la llamada; el diseño no declara method/path ni el contract es parseable
        //   ${call.contract}
        throw new NotImplementedException(${csString(`TODO: ${call.name}`)});
    }`;
  }

  const once = onceMethod(model, client, call, usings);
  const resilient = Boolean(call.retry || call.circuitBreaker);
  if (!resilient) {
    return `${doc}    public ${returns} ${method}(${params.join(', ')}) => ${method}Once(${args});

${once}`;
  }

  members.push(`    /// <summary>La política de ${subject} (keel-core/gen/outbound-resilience.js, la misma que keel-spring y keel-nest).</summary>
    private static readonly OutboundPolicy ${policyField(call)} = ${policyLiteral(call)};`);
  // El circuito es POR LLAMADA y vive lo que el adaptador (un singleton): su ventana es la de esta instancia.
  if (call.circuitBreaker) {
    members.push(`    private readonly CircuitBreaker ${circuitField(call)} = new(${policyField(call)}.CircuitBreaker!);`);
  }
  const circuit = call.circuitBreaker ? circuitField(call) : 'null';
  const guarded = `OutboundResilience.Run(${policyField(call)}, ${circuit}, () => ${method}Once(${args}), cancellationToken)`;
  const ret = call.bodiless ? '' : 'return ';

  if (!hasCallFallback(call)) {
    return `${doc}    public ${returns} ${method}(${params.join(', ')}) => ${guarded};

${once}`;
  }

  // El fallback NO atiende cualquier error: solo los fallos del proveedor de la tabla neutral. Lo demás —un bug del
  // adaptador, un cuerpo que viola el contrato— se propaga con su traza (keel-core, outbound-resilience).
  const kinds = fallbackFailures({ circuitBreaker: Boolean(call.circuitBreaker), oauth2: client.auth?.type === 'oauth2-client-credentials' }).map((f) => f.kind);
  members.push(`    /// <summary>Lo que atiende el fallback de ${subject}: solo lo que ha hecho el PROVEEDOR.</summary>
    private static readonly ProviderFailureKind[] ${call.pascal}Fallback = [${kinds.map(KIND).join(', ')}];`);
  const unavailable = unavailableBody(model, client, call, usings);
  const unavailableParams = [...callParams(call), 'ProviderFailureException failure'];
  return `${doc}    public async ${returns} ${method}(${params.join(', ')})
    {
        try
        {
            ${ret}await ${guarded};
        }
        catch (ProviderFailureException failure) when (${call.pascal}Fallback.Contains(failure.Kind))
        {
            if (failure.Kind == ProviderFailureKind.ClientError)
            {
                // Si el rechazo tiene significado de negocio —un 404 es "no existe", un 409 un conflicto suyo—, la
                // traducción va en ${method}Once, mirando failure.Status antes de que llegue aquí.
                logger.LogWarning("{Call} rechazada por el proveedor ({Status})", ${csString(subject)}, failure.Status);
            }
            ${ret}${method}Unavailable(${[...callArgs(call), 'failure'].join(', ')});
        }
    }

${once}

    /// <summary>
    /// Política del diseño para cuando ${subject} no sale.
    /// </summary>
    /// <remarks>
    /// Solo llega aquí lo que ha hecho el PROVEEDOR: no responder, responder mal o rechazarnos. Un error de programación de
    /// este adaptador no tiene rama que lo enrute y se propaga con su traza. No lo ensanches a cualquier error para "que no
    /// se escape nada": lo que se escapa es el bug.
    /// </remarks>
    private ${call.bodiless ? 'void' : call.resultType} ${method}Unavailable(${unavailableParams.join(', ')})
    {
${unavailable}
    }`;
}

/** Un intento: la petición, su clasificación y la lectura del cuerpo. Lo repite el retry. */
function onceMethod(model, client, call, usings) {
  const subject = `${client.id}.${call.name}`;
  const method = callMethod(call);
  const params = [...callParams(call), 'CancellationToken cancellationToken'];
  const lines = [];
  let bodyExpr = null;
  if (call.requestType) {
    lines.push(`        var request = mapper.To${call.pascal}Request(${call.bodyFields.map(paramName).join(', ')});`);
    bodyExpr = 'request';
  } else if (call.hasBody) {
    bodyExpr = 'body';
  }
  const map = (fields) => `new Dictionary<string, object?>(StringComparer.Ordinal) { ${fields.map((field) => `[${csString(field.name)}] = ${paramName(field)}`).join(', ')} }`;
  const headers = call.headerParams.map((field) => `[${csString(field.name)}] = ${paramName(field)}`);
  if (call.idempotency) {
    // La firma es la del MISMO objeto que se envía; sin cuerpo, lo que identifica la petición son sus parámetros (el
    // DELETE de un recurso concreto). Se calcula DENTRO del intento y sale igual en cada uno: una clave que cambiara entre
    // reintentos pediría al proveedor una ejecución nueva.
    const payload = bodyExpr ?? `new object?[] { ${callFields(call).map(paramName).join(', ')} }`;
    const factory = call.idempotency.keyFrom === 'correlation' ? 'Correlated' : 'FromPayload';
    headers.push(`[${csString(call.idempotency.header)}] = OutboundIdempotency.${factory}(${csString(call.name)}, ${payload})`);
  }
  const init = [];
  if (call.pathParams.length > 0) init.push(`            PathParams = ${map(call.pathParams)},`);
  if (call.queryParams.length > 0) init.push(`            Query = [${call.queryParams.map((field) => `new(${csString(field.name)}, ${paramName(field)})`).join(', ')}],`);
  if (headers.length > 0) init.push(`            Headers = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase) { ${headers.join(', ')} },`);
  if (bodyExpr) init.push(`            Body = ${bodyExpr},`);
  const outbound = `new OutboundRequest(${csString(call.method)}, ${csString(call.path)})${init.length > 0 ? `\n        {\n${init.join('\n')}\n        }` : ''}`;
  const todo = call.typed ? '' : `        // TODO (agente): ajusta ${call.responseType ?? 'la llamada'} y el request al contract\n        //   ${call.contract}\n`;
  const prelude = `${todo}${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
  if (call.bodiless) {
    return `    private async Task ${method}Once(${params.join(', ')})
    {
${prelude}        await http.Send(client, ${outbound}, cancellationToken);
    }`;
  }
  // Cuerpo ausente (un 204): el mismo criterio que keel-spring y keel-nest — valores AUSENTES, no un fallo. Con
  // `awaits: outcome` quien decide qué hacer sin desenlace es el handler; lanzar se lo robaría.
  // Con `onUnavailable: lastKnown`, el resultado se recuerda ANTES de devolverlo: lo que se sirve cuando el proveedor cae es
  // lo último que contestó cuando no lo estaba.
  const read = (source) =>
    remembersCall(model, client, call)
      ? `        var result = mapper.To${call.pascal}Result(${call.responseType}.Read(${source}));
        lastKnown.Remember(${csString(call.name)}, ${lastKnownKey(call)}, result);
        return result;`
      : `        return mapper.To${call.pascal}Result(${call.responseType}.Read(${source}));`;
  const empty =
    call.responseFields.length > 0
      ? `        if (response.Body is not { } body)
        {
            logger.LogWarning("{Call} respondió sin cuerpo; el contrato declara {Fields} campo(s)", ${csString(subject)}, ${call.responseFields.length});
            return ${neutralResult(call)};
        }
${read('body')}`
      : read('response.Body ?? default');
  return `    private async Task<${call.resultType}> ${method}Once(${params.join(', ')})
    {
${prelude}        var response = await http.Send(client, ${outbound}, cancellationToken);
${empty}
    }`;
}

/**
 * El error que el fallback de esta llamada LANZA por política del diseño (`onUnavailable: fail` de un need u `onFailure:
 * fail` de una activación), o null: sin fallback, con otra política, con varias distintas o sin clase del error.
 */
export function declaredFailure(call) {
  const decl = fallbackPolicy(call);
  return decl?.action === 'fail' && decl.exceptionClass ? decl : null;
}

/**
 * LA política del fallback de esta llamada (`onUnavailable` de un need u `onFailure` de una activación), o null: sin
 * fallback, o con varias DISTINTAS por la misma llamada, que el adaptador enumera como conflicto del diseño con un TODO
 * (keel-spring y keel-nest igual). La prueba emitida solo afirma lo que el fallback de verdad hace.
 */
export function fallbackPolicy(call) {
  if (!hasCallFallback(call)) return null;
  const activations = call.activations ?? [];
  const needs = (call.needs ?? []).filter(({ need }) => need.onUnavailable);
  const distinct = new Set([
    ...activations.map(({ activation }) => `activation:${JSON.stringify(activation.onFailure ?? null)}`),
    ...needs.map(({ need }) => `need:${JSON.stringify(need.onUnavailable)}`)
  ]);
  if (distinct.size !== 1) return null;
  return needs.length > 0 ? needs[0].need.onUnavailable : activations[0]?.activation.onFailure ?? null;
}

/** El cuerpo del fallback: la política que declara la activación que sale por esta llamada (como keel-spring y keel-nest). */
function unavailableBody(model, client, call, usings) {
  const subject = `${client.id}.${call.name}`;
  const activations = call.activations ?? [];
  const needs = (call.needs ?? []).filter(({ need }) => need.onUnavailable);
  const trace = `        logger.LogWarning("Fallback de {Call}: {Reason}", ${csString(subject)}, failure.Message);`;
  const prose = call.fallback ? `        // Fallback declarado en el diseño: ${call.fallback}\n` : '';
  const todoThrow = `        throw new NotImplementedException(${csString(`TODO: fallback ${call.name}`)});`;
  const distinct = new Set([
    ...activations.map(({ activation }) => `activation:${JSON.stringify(activation.onFailure ?? null)}`),
    ...needs.map(({ need }) => `need:${JSON.stringify(need.onUnavailable)}`)
  ]);
  // Una política, y solo una: con dos distintas el conflicto es del diseño (un método no puede hacer dos cosas).
  if (distinct.size !== 1) {
    const doc = call.fallback ? `        // TODO (agente): ${call.fallback}` : '        // TODO (agente): política de fallback del circuito abierto.';
    const conflicting = [
      ...activations.map(({ dependency, activation }) => `${dependency}.${activation.name} (activación, onFailure: ${activation.onFailure?.action ?? 'sin declarar'})`),
      ...needs.map(({ dependency, need }) => `${dependency}.${need.name} (need, onUnavailable: ${need.onUnavailable.action})`)
    ];
    const listed =
      distinct.size > 1
        ? `\n        // Varias políticas DISTINTAS salen por esta llamada y el diseño no puede darles caminos distintos sobre un\n        // único método: ${conflicting.join('; ')}`
        : '';
    return `${trace}\n${doc}${listed}\n${todoThrow}`;
  }
  const policy = needs.length > 0 ? { origin: needs[0], action: needs[0].need.onUnavailable, what: needs[0].need.name, kind: 'need' } : null;
  const { dependency, activation } = activations[0] ?? {};
  const decl = policy ? policy.action : activation.onFailure;
  const name = policy ? policy.what : activation.name;
  const dep = policy ? policy.origin.dependency : dependency;
  const origin = policy
    ? `        // Política declarada por el need ${dep}.${name} (onUnavailable: ${decl.action}).\n`
    : `        // Política declarada por la activación ${dep}.${name} (onFailure: ${decl?.action ?? 'sin declarar'}).\n`;
  if (!policy && decl?.action === 'ignore') {
    // Una sola línea: es el mismo evento que el trace, y esta dice más (que el llamante sigue adelante).
    return `${prose}${origin}        // El llamante sigue adelante: no propagues el error ni inventes datos del proveedor.
        logger.LogWarning("{Call} no disponible; se continúa sin él: {Reason}", ${csString(subject)}, failure.Message);${call.bodiless ? '' : `\n        return ${neutralResult(call)};`}`;
  }
  if (decl?.action === 'fail') {
    if (decl.exceptionClass) {
      usings.push(namespaceOf(model, 'errors'));
      const message = csString(`${dep} no está disponible para ${name}`);
      const args = decl.dynamicStatus ? `${message}, ${decl.httpStatus}` : message;
      return `${trace}\n${prose}${origin}        throw new ${decl.exceptionClass}(${args});`;
    }
    return `${trace}\n${prose}${origin}        // TODO (agente): el diseño declara el error ${decl.error}, pero ninguna operación de use-cases lo declara
        // todavía, así que su clase no existe.
${todoThrow}`;
  }
  if (decl?.action === 'degrade') {
    return `${trace}\n${prose}${origin}        // TODO (agente): el resultado degradado es lógica de negocio y debe ser distinguible por el cliente de una
        // respuesta normal — un dato plausible pero falso es peor que fallar:
        //   ${decl.degradedTo}
${todoThrow}`;
  }
  if (decl?.action === 'lastKnown') {
    // El único con mecanismo propio, y por eso build lo escribe entero (13j, como keel-spring y keel-nest). Las dos mitades
    // son inseparables —servir el último valor y RENDIRSE cuando ya es demasiado viejo—: sin la segunda, es la caché sin
    // expiración que el diseño acaba de prohibir.
    const window = `        // Dentro de la ventana declarada se sirve lo último que se leyó; fuera de ella no hay nada que servir: un valor
        // más viejo que ${decl.maxAgeSeconds} s ya no es ese dato.
        if (lastKnown.Recall<${call.resultType}>(${csString(call.name)}, ${lastKnownKey(call)}, ${decl.maxAgeSeconds}) is { } remembered)
        {
            return remembered.AsStale();
        }`;
    if (decl.exceptionClass) {
      usings.push(namespaceOf(model, 'errors'));
      const message = csString(`${dep} no está disponible y el último ${name} conocido supera los ${decl.maxAgeSeconds}s`);
      const args = decl.dynamicStatus ? `${message}, ${decl.httpStatus}` : message;
      return `${trace}\n${prose}${origin}${window}
        throw new ${decl.exceptionClass}(${args});`;
    }
    return `${trace}\n${prose}${origin}${window}
        // TODO (agente): el diseño declara onUnavailable.error = ${decl.error}, pero ninguna operación de use-cases lo
        // declara todavía, así que su clase no existe: solo falta con qué rendirse.
${todoThrow}`;
  }
  return `${trace}\n${prose}${origin}        // TODO (agente): la activación no declara onFailure.
${todoThrow}`;
}

// ─── Configuración y registro ────────────────────────────────────────────────────────────────────

/** Las cabeceras de la autenticación de un cliente, leídas de la configuración al arrancar. */
function authHeaders(client) {
  const auth = client.auth;
  const key = (leaf) => csString(`${auth.propertyPrefix}.${leaf}`.replaceAll('.', ':'));
  if (auth?.type === 'api-key') return `[${csString(auth.headerName)}] = Text(get, ${key('api-key')})`;
  if (auth?.type === 'bearer-static') return `["Authorization"] = "Bearer " + Text(get, ${key('token')})`;
  if (auth?.type === 'basic') return `["Authorization"] = Basic(Text(get, ${key('username')}), Text(get, ${key('password')}))`;
  return null;
}

function settingsCs(model) {
  const entries = model.httpClients.map((client) => {
    const header = authHeaders(client);
    // OAuth2 client-credentials (13j): la concesión, una instancia por arranque —ningún token sobrevive entre arranques—.
    const prefix = (leaf) => csString(`${client.auth?.propertyPrefix}.${leaf}`.replaceAll('.', ':'));
    const oauth =
      client.auth?.type === 'oauth2-client-credentials'
        ? `,
                Authorization: new ClientCredentials(new ClientCredentialsSettings(
                    ${csString(client.id)},
                    BaseUrl(get, ${prefix('token-uri')}),
                    Text(get, ${prefix('client-id')}),
                    Text(get, ${prefix('client-secret')}),
                    [${(client.auth.scopes ?? []).map(csString).join(', ')}],
                    TimeSpan.FromMilliseconds(${client.readTimeoutMs}))).Authorization`
        : '';
    return `            [${csString(client.id)}] = new(
                ${csString(client.id)},
                BaseUrl(get, ${csString(client.baseUrlProperty.replaceAll('.', ':'))}),
                // El timeout de lectura de keel-spring: el MAYOR de las llamadas del cliente, por intento.
                TimeSpan.FromMilliseconds(${client.readTimeoutMs}),
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)${header ? ` { ${header} }` : ''}${oauth}),`;
  });
  const basic = model.httpClients.some((client) => client.auth?.type === 'basic');
  return `/// <summary>Lo que un adaptador sabe de su proveedor: la URL, el timeout de cada intento y las cabeceras de su autenticación.</summary>
/// <param name="Authorization">
/// La credencial que hay que ir a buscar antes de cada intento (oauth2-client-credentials): la cabecera Authorization ya
/// armada. Si no se puede obtener, lanza un fallo AuthGrant y la petición no sale.
/// </param>
public sealed record ClientSettings(string Id, Uri BaseUrl, TimeSpan Timeout, IReadOnlyDictionary<string, string> Headers, Func<CancellationToken, Task<string>>? Authorization = null);

/// <summary>
/// Lo que cada cliente lee de config/parameters/&lt;perfil&gt;/http-clients.yaml (las MISMAS claves y variables que los
/// servidores de keel-spring y keel-nest): la URL del proveedor, obligatoria fuera de local, y las credenciales de su
/// autenticación, que nunca vienen del diseño. Se lee al ARRANCAR: lo que falta no deja arrancar.
/// </summary>
public sealed class HttpClientsSettings
{
    private readonly IReadOnlyDictionary<string, ClientSettings> clients;

    private HttpClientsSettings(IReadOnlyDictionary<string, ClientSettings> clients) => this.clients = clients;

    /// <summary>Las de un cliente, por su id del diseño.</summary>
    public ClientSettings this[string id] =>
        clients.TryGetValue(id, out var client) ? client : throw new InvalidOperationException($"http-clients: no hay configuración para {id}");

    /// <summary>Las del perfil activo.</summary>
    public static HttpClientsSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return Read(configuration.Get);
    }

    /// <summary>
    /// Las del perfil test sin configuración (las pruebas de build): un proveedor que no responde y credenciales de prueba.
    /// Ninguna prueba del perfil sale a la red.
    /// </summary>
    public static HttpClientsSettings Unreachable { get; } = Read(key => key.EndsWith(":base-url", StringComparison.Ordinal) || key.EndsWith(":token-uri", StringComparison.Ordinal) ? ${csString(UNREACHABLE_BASE_URL)} : "test");

    private static HttpClientsSettings Read(Func<string, string?> get) =>
        new(new Dictionary<string, ClientSettings>(StringComparer.Ordinal)
        {
${entries.join('\n')}
        });

    private static string Text(Func<string, string?> get, string key)
    {
        var value = get(key);
        return string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"Configuración: falta {key.Replace(':', '.')}") : value;
    }

    private static Uri BaseUrl(Func<string, string?> get, string key) =>
        Uri.TryCreate(Text(get, key), UriKind.Absolute, out var url) ? url : throw new InvalidOperationException($"Configuración: {key.Replace(':', '.')} no es una URL absoluta");${basic ? `

    private static string Basic(string username, string password) =>
        "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username}:{password}"));` : ''}
}`;
}

function registration(model) {
  const { namespace, path } = located(model, 'clientAdapters', 'HttpClientsRegistration');
  const lines = [
    // El último valor conocido (onUnavailable: lastKnown): uno por proceso, lo comparten los adaptadores que lo sirven.
    ...(usesLastKnown(model) ? ['        services.AddSingleton(_ => new LastKnownValues());'] : []),
    ...model.httpClients.flatMap((client) => [
    `        services.AddSingleton<${client.mapperClass}>();`,
    `        services.AddSingleton<${clientPort(client)}, ${client.adapterClass}>();`
    ])
  ];
  const body = `/// <summary>
/// Los clientes HTTP salientes: un adaptador por puerto de Domain/Clients, con su mapper y la configuración del perfil.
/// Singletons: el circuito de cada llamada vive lo que su adaptador, y su ventana es la de este proceso.
/// </summary>
public static class HttpClientsRegistration
{
    public static IServiceCollection AddOutboundClients(this IServiceCollection services, HttpClientsSettings settings)
    {
        services.AddSingleton(settings);
        // Un solo HttpClient para todos los proveedores, sobre un manejador que no sigue redirecciones y renueva sus
        // conexiones (los cambios de DNS de un proveedor se ven sin reiniciar).
        services.AddSingleton(_ => new HttpExchange(HttpExchange.DefaultHandler()));
${lines.join('\n')}
        return services;
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.Extensions.DependencyInjection', clientsNamespace(model)], body }) };
}

function outboundIdempotency(model) {
  const { namespace, path } = located(model, 'clientAdapters', 'OutboundIdempotency');
  const correlated = usesCorrelation(model);
  const correlatedBody = correlated
    ? `        var correlationId = CorrelationContext.Get();
        return correlationId is null ? FromPayload(call, payload) : CommandSignature.Of(new object?[] { call, correlationId, payload });`
    : `        // Este servicio no abre correlación (ni API ni mensajería): solo queda la firma del contenido.
        return FromPayload(call, payload);`;
  const body = `/// <summary>
/// La clave de idempotencia que ESTE servicio manda al proveedor, por llamada: la cara simétrica de la de entrada. Un
/// timeout no distingue «no llegó» de «llegó y se hizo», así que sin clave el reintento de una escritura es una segunda
/// ejecución.
/// </summary>
/// <remarks>Lo que la hace útil es que el reintento produzca la MISMA clave: nada aleatorio ni dependiente del instante.</remarks>
public static class OutboundIdempotency
{
    /// <summary>Clave por CONTENIDO: dos peticiones idénticas son la misma intención.</summary>
    public static string FromPayload(string call, object? payload) => CommandSignature.Of(new object?[] { call, payload });

    /// <summary>
    /// Clave por CORRELACIÓN: el proveedor deduplica por intención de negocio, no por contenido. Sin correlación abierta
    /// (un barrido, un arranque) cae a la firma del contenido. La petición entra también en la clave: una ejecución puede
    /// hacer varias llamadas distintas al mismo método, y con solo la correlación el proveedor absorbería todas menos la primera.
    /// </summary>
    public static string Correlated(string call, object? payload)
    {
${correlatedBody}
    }
}`;
  const usings = [namespaceOf(model, 'appSupport'), ...(correlated ? [namespaceOf(model, 'correlation')] : [])];
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Soporte (uno por servicio) ──────────────────────────────────────────────────────────────────

function providerFailuresCs() {
  const kinds = Object.values(PROVIDER_FAILURES).map((failure) => `    /// <summary>${failure.reason.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</summary>
    ${pascalCase(failure.kind)},`);
  const recorded = recordedFailures().map((failure) => KIND(failure.kind));
  return `/// <summary>
/// Qué significa «el proveedor no está», como excepciones con su Kind: la tabla de keel-core (gen/outbound-resilience.js),
/// la misma que en keel-spring proyecta cada fallo a su excepción de Spring y en keel-nest a su error de fetch.
/// </summary>
public enum ProviderFailureKind
{
${kinds.join('\n')}
}

/// <summary>
/// Un fallo del PROVEEDOR: su Kind neutral y, si contestó, su status. Lo que no es uno de estos —un bug del adaptador, un
/// cuerpo que viola el contrato— no tiene rama en el fallback ni cuenta para el circuito: se propaga con su traza.
/// </summary>
public class ProviderFailureException(ProviderFailureKind kind, string message, int? status = null, Exception? cause = null)
    : Exception(message, cause)
{
    public ProviderFailureKind Kind { get; } = kind;

    public int? Status { get; } = status;
}

/// <summary>Conexión rechazada, timeout, DNS, socket roto: no hay nadie al otro lado.</summary>
public sealed class ProviderTransportException(string message, Exception? cause = null)
    : ProviderFailureException(ProviderFailureKind.Transport, message, null, cause);

/// <summary>
/// Un status del proveedor que no es 2xx. 4xx: nos RECHAZA (contestó, no está caído); 5xx: está roto; cualquier otro: no es
/// un status que un contrato pueda declarar.
/// </summary>
public sealed class ProviderStatusException(int status, string body)
    : ProviderFailureException(KindOf(status), $"El proveedor contestó {status}", status)
{
    /// <summary>El cuerpo de la respuesta, para que el adaptador traduzca un rechazo con significado de negocio.</summary>
    public string Body { get; } = body;

    private static ProviderFailureKind KindOf(int status) => status switch
    {
        >= 400 and <= 499 => ProviderFailureKind.ClientError,
        >= 500 and <= 599 => ProviderFailureKind.ServerError,
        _ => ProviderFailureKind.UnknownStatus
    };
}

/// <summary>El circuito está abierto: la llamada ni se intentó.</summary>
public sealed class CallNotPermittedException()
    : ProviderFailureException(ProviderFailureKind.CircuitOpen, "El circuito está abierto: la llamada ni se intentó");

/// <summary>Lo que cuenta para el circuito (la tabla neutral: un 4xx, el circuito abierto o el token, no).</summary>
public static class ProviderFailures
{
    public static IReadOnlySet<ProviderFailureKind> Recorded { get; } = new HashSet<ProviderFailureKind> { ${recorded.join(', ')} };
}`;
}

function circuitBreakerCs() {
  return `/// <summary>Los números de un circuito: los de keel-core (resiliencePolicy), ya resueltos.</summary>
public sealed record CircuitBreakerSpec(double FailureRateThreshold, int SlidingWindowSize, int MinimumNumberOfCalls, long WaitDurationMs, int HalfOpenCalls);

public enum CircuitState
{
    Closed,
    Open,
    HalfOpen
}

/// <summary>
/// El circuito de una llamada saliente, con la semántica de resilience4j por CONTEO (la del servidor de keel-spring del
/// mismo diseño). Es la referencia ejecutable de keel-core (circuitBreakerReference) escrita en C#, y la prueba emitida
/// recorre las mismas secuencias contra las dos.
/// </summary>
/// <remarks>
/// · cerrado: cada llamada que sale cuenta —fallo si su fallo está entre los que cuentan, éxito si no (un 4xx es un ÉXITO
///   para el circuito)—; con al menos MinimumNumberOfCalls, una tasa &gt;= umbral abre;
/// · abierto: rechaza sin intentar hasta WaitDurationMs; la primera llamada después pasa a semiabierto;
/// · semiabierto: deja pasar HalfOpenCalls pruebas y decide con TODAS: reabre o cierra con la ventana vacía.
/// No es el de Polly a propósito: su ventana es por tiempo y su semiabierto deja pasar una sola prueba.
/// </remarks>
public sealed class CircuitBreaker(CircuitBreakerSpec spec, Func<long>? now = null)
{
    private readonly Func<long> now = now ?? (() => Environment.TickCount64);
    private readonly Lock gate = new();
    private readonly Queue<bool> window = new();
    private readonly List<bool> trial = [];
    private CircuitState current = CircuitState.Closed;
    private long openedAt;
    private int permitted;

    public CircuitState State
    {
        get
        {
            lock (gate)
            {
                return current;
            }
        }
    }

    /// <summary>¿Puede salir esta llamada?</summary>
    public bool TryAcquire()
    {
        lock (gate)
        {
            if (current == CircuitState.Open)
            {
                if (now() - openedAt < spec.WaitDurationMs)
                {
                    return false;
                }
                current = CircuitState.HalfOpen;
                permitted = 0;
                trial.Clear();
            }
            if (current == CircuitState.HalfOpen)
            {
                if (permitted >= spec.HalfOpenCalls)
                {
                    return false;
                }
                permitted++;
            }
            return true;
        }
    }

    /// <summary>El desenlace de una llamada que salió: <paramref name="failed"/> si su fallo cuenta para el circuito.</summary>
    public void Record(bool failed)
    {
        lock (gate)
        {
            if (current == CircuitState.HalfOpen)
            {
                trial.Add(failed);
                if (trial.Count >= spec.HalfOpenCalls)
                {
                    if (Tripped(trial))
                    {
                        Open();
                    }
                    else
                    {
                        current = CircuitState.Closed;
                        window.Clear();
                    }
                }
                return;
            }
            if (current != CircuitState.Closed)
            {
                return;
            }
            window.Enqueue(failed);
            if (window.Count > spec.SlidingWindowSize)
            {
                window.Dequeue();
            }
            if (window.Count >= spec.MinimumNumberOfCalls && Tripped(window))
            {
                Open();
            }
        }
    }

    private bool Tripped(IReadOnlyCollection<bool> outcomes) => outcomes.Count(failed => failed) * 100.0 / outcomes.Count >= spec.FailureRateThreshold;

    private void Open()
    {
        current = CircuitState.Open;
        openedAt = now();
        window.Clear();
    }
}`;
}

function outboundResilienceCs() {
  return `/// <summary>
/// El reintento de una llamada: <paramref name="MaxAttempts"/> son los intentos TOTALES (los de resilience4j), no los
/// reintentos. <paramref name="Multiplier"/> null: espera fija; <paramref name="MaxDelayMs"/> null: sin techo.
/// </summary>
public sealed record RetrySpec(int MaxAttempts, long InitialDelayMs, double? Multiplier, long? MaxDelayMs, IReadOnlyList<ProviderFailureKind> Retries);

/// <summary>La política de una llamada: la de keel-core (resiliencePolicy) ya resuelta, como literal en su adaptador.</summary>
public sealed record OutboundPolicy(string Instance, RetrySpec? Retry, CircuitBreakerSpec? CircuitBreaker);

/// <summary>
/// Retry por fuera y circuito por dentro, el orden de resilience4j (Retry(CircuitBreaker(llamada))): cada intento pasa por
/// el circuito, y el circuito abierto NO se reintenta (no está entre los fallos que reintenta ninguna política).
/// </summary>
public static class OutboundResilience
{
    public static async Task<T> Run<T>(
        OutboundPolicy policy,
        CircuitBreaker? circuit,
        Func<Task<T>> action,
        CancellationToken cancellationToken,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(action);
        delay ??= Task.Delay;
        var attempts = policy.Retry?.MaxAttempts ?? 1;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await Guarded(circuit, action);
            }
            catch (ProviderFailureException failure) when (policy.Retry is { } retry && attempt < attempts && retry.Retries.Contains(failure.Kind))
            {
                await delay(TimeSpan.FromMilliseconds(RetryWaitMs(attempt, retry)), cancellationToken);
            }
        }
    }

    public static Task Run(
        OutboundPolicy policy,
        CircuitBreaker? circuit,
        Func<Task> action,
        CancellationToken cancellationToken,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        ArgumentNullException.ThrowIfNull(action);
        return Run(policy, circuit, async () =>
        {
            await action();
            return true;
        }, cancellationToken, delay);
    }

    /// <summary>La espera ANTES del intento <paramref name="attempt"/> + 1: la referencia retryWaitMs de keel-core.</summary>
    public static long RetryWaitMs(int attempt, RetrySpec retry)
    {
        ArgumentNullException.ThrowIfNull(retry);
        if (retry.Multiplier is not { } multiplier)
        {
            return retry.InitialDelayMs;
        }
        var wait = retry.InitialDelayMs * Math.Pow(multiplier, Math.Max(attempt - 1, 0));
        if (retry.MaxDelayMs is { } max)
        {
            return double.IsFinite(wait) && wait <= max ? (long)wait : max;
        }
        return double.IsFinite(wait) && wait < long.MaxValue ? (long)wait : long.MaxValue;
    }

    private static async Task<T> Guarded<T>(CircuitBreaker? circuit, Func<Task<T>> action)
    {
        if (circuit is null)
        {
            return await action();
        }
        if (!circuit.TryAcquire())
        {
            throw new CallNotPermittedException();
        }
        try
        {
            var result = await action();
            circuit.Record(false);
            return result;
        }
        catch (Exception error)
        {
            circuit.Record(error is ProviderFailureException failure && ProviderFailures.Recorded.Contains(failure.Kind));
            throw;
        }
    }
}`;
}

function httpExchangeCs(model) {
  const telemetry = usesTelemetry(model);
  return String.raw`/// <summary>Una petición a un proveedor: la ruta del diseño con sus variables entre llaves (/stock/{orderId}).</summary>
public sealed record OutboundRequest(string Method, string Path)
{
    private static readonly IReadOnlyDictionary<string, object?> None = new Dictionary<string, object?>();

    public IReadOnlyDictionary<string, object?> PathParams { get; init; } = None;

    public IReadOnlyList<KeyValuePair<string, object?>> Query { get; init; } = [];

    public IReadOnlyDictionary<string, object?> Headers { get; init; } = None;

    /// <summary>El cuerpo, que escribe el contrato del cable; null si no lleva.</summary>
    public object? Body { get; init; }
}

/// <summary>Lo que contestó el proveedor: el status y el cuerpo como JSON, o null si no trae.</summary>
public sealed record OutboundResponse(int Status, JsonElement? Body);

/// <summary>
/// Un intento contra el proveedor. Clasifica el desenlace con la tabla neutral: sin respuesta (conexión, timeout, DNS) es
/// Transport; un status que no es 2xx, el suyo; un cuerpo que no es JSON es un OutboundContractException, que no es un fallo
/// del proveedor.
/// </summary>
/// <remarks>
/// El timeout cubre el intento ENTERO, con la lectura del cuerpo: es el de lectura de keel-spring, el mayor de las llamadas
/// del cliente. Las redirecciones no se siguen, como el cliente del JDK por defecto. La cancelación de quien llama NO es un
/// timeout: se propaga como tal.
/// </remarks>
public sealed partial class HttpExchange(HttpMessageHandler handler) : IDisposable
{
    private readonly HttpClient http = new(handler, disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    /// <summary>Cuántas conexiones abrió el transporte para UNA petición: la guarda de <see cref="DefaultHandler"/>.</summary>
    private static readonly HttpRequestOptionsKey<StrongBox<int>> OpenedConnections = new("keel.opened-connections");

    /// <summary>
    /// El manejador del servidor: sin redirecciones, 5 s para conectar (fijos, como keel-spring) y SIN reintentos propios.
    /// </summary>
    /// <remarks>
    /// SocketsHttpHandler reenvía por su cuenta, hasta tres veces, una petición cuya conexión se corta antes de la
    /// respuesta (medido contra WireMock: un DELETE con el corte de conexión llegaba CUATRO veces). Eso es un retry por
    /// debajo del que declara el diseño: repetiría una escritura que el diseño no reintenta ante <c>connection</c>, y
    /// multiplicaría las que sí. Cada intento va en su propia conexión (<c>Connection: close</c>) y esta guarda no deja
    /// abrir una segunda para la misma petición: el corte llega al retry del diseño como el fallo de transporte que es.
    /// El precio es no reutilizar conexiones entre llamadas.
    /// </remarks>
    public static SocketsHttpHandler DefaultHandler() => new()
    {
        AllowAutoRedirect = false,
        // El traceparent no lo pone el transporte: con telemetría lo escribe el span CLIENT de la llamada; sin ella no
        // viaja (el de la petición de entrada que abre ASP.NET Core no lo exporta nadie).
        ActivityHeadersPropagator = null,
        ConnectTimeout = TimeSpan.FromMilliseconds(5000),
        ConnectCallback = async (context, cancellationToken) =>
        {
            if (context.InitialRequestMessage.Options.TryGetValue(OpenedConnections, out var opened) && Interlocked.Increment(ref opened.Value) > 1)
            {
                throw new IOException("el transporte no reintenta por su cuenta: lo decide la política de la llamada");
            }
            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(context.DnsEndPoint, cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
    };

    public async Task<OutboundResponse> Send(ClientSettings client, OutboundRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(request);
        var target = Target(client.BaseUrl, request);
        using var message = new HttpRequestMessage(new HttpMethod(request.Method), target);
        // Una conexión por intento, y la guarda de DefaultHandler contando las que se abren para él.
        message.Headers.ConnectionClose = true;
        message.Options.Set(OpenedConnections, new StrongBox<int>(0));
        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        foreach (var (name, value) in client.Headers)
        {
            message.Headers.TryAddWithoutValidation(name, value);
        }
        if (client.Authorization is { } authorize)
        {
            // Sin token no se sale: una llamada sin Authorization sería peor que ninguna (el socio la rechazaría y el
            // diagnóstico apuntaría a él). El fallo de la concesión ya es un AuthGrant y lo atiende el fallback.
            message.Headers.TryAddWithoutValidation("Authorization", await authorize(cancellationToken));
        }
        foreach (var (name, value) in request.Headers)
        {
            if (value is not null)
            {
                message.Headers.Remove(name);
                message.Headers.TryAddWithoutValidation(name, Plain(value));
            }
        }
        if (request.Body is not null)
        {
            message.Content = new StringContent(
                JsonSerializer.Serialize(request.Body, request.Body.GetType(), WireJson.Options),
                new MediaTypeHeaderValue("application/json"));
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(client.Timeout);
        int status;
        string text;${telemetry ? `
        // La llamada observada: el span CLIENT escribe la traza en las cabeceras, y la métrica lleva la plantilla de la ruta.
        var telemetry = KeelTelemetry.Current;
        var started = Stopwatch.GetTimestamp();
        var span = telemetry?.StartClient(client.Id, request.Method, request.Path, message.Headers);
        int? observed = null;` : ''}
        try
        {
            using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            status = (int)response.StatusCode;${telemetry ? '\n            observed = status;' : ''}
            text = await response.Content.ReadAsStringAsync(timeout.Token);
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ProviderTransportException(
                string.Create(CultureInfo.InvariantCulture, $"{client.Id}: {request.Method} {target.AbsolutePath} sin respuesta en {client.Timeout.TotalMilliseconds} ms"),
                error);
        }
        catch (Exception error) when (error is HttpRequestException or IOException)
        {
            throw new ProviderTransportException($"{client.Id}: {request.Method} {target.AbsolutePath} sin respuesta ({error.Message})", error);
        }${telemetry ? `
        finally
        {
            telemetry?.FinishClient(span, started, client.Id, request.Method, request.Path, observed);
        }` : ''}
        if (status is < 200 or > 299)
        {
            throw new ProviderStatusException(status, text);
        }
        if (string.IsNullOrWhiteSpace(text))
        {
            return new OutboundResponse(status, null);
        }
        try
        {
            using var document = JsonDocument.Parse(text);
            return new OutboundResponse(status, document.RootElement.Clone());
        }
        catch (JsonException error)
        {
            throw new OutboundContractException(
                string.Create(CultureInfo.InvariantCulture, $"{client.Id}: {request.Method} {target.AbsolutePath} respondió {status} con un cuerpo que no es JSON"),
                error);
        }
    }

    /// <summary>La URL de la petición: la base, la ruta con sus variables sustituidas y codificadas, y la query.</summary>
    public static Uri Target(Uri baseUrl, OutboundRequest request)
    {
        ArgumentNullException.ThrowIfNull(baseUrl);
        ArgumentNullException.ThrowIfNull(request);
        var path = Placeholder().Replace(request.Path, match =>
        {
            var name = match.Groups[1].Value;
            // Una variable sin valor es un bug nuestro: no se manda una ruta incompleta.
            return request.PathParams.TryGetValue(name, out var value) && value is not null
                ? Uri.EscapeDataString(Plain(value))
                : throw new OutboundContractException($"La ruta {request.Path} necesita {name}");
        });
        var query = string.Join('&', request.Query
            .Where(pair => pair.Value is not null)
            .SelectMany(pair => Items(pair.Value!).Select(item => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(Plain(item))}")));
        return new Uri(baseUrl.ToString().TrimEnd('/') + path + (query.Length > 0 ? "?" + query : string.Empty));
    }

    /// <summary>Un valor en la URL o en una cabecera, con la forma del contrato del cable.</summary>
    public static string Plain(object value) => value switch
    {
        string text => text,
        Guid id => id.ToString("D"),
        bool flag => flag ? "true" : "false",
        DateTimeOffset instant => instant.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        // Un enum viaja por el VALOR del diseño, el mismo que en el cuerpo.
        Enum => JsonSerializer.Serialize(value, value.GetType(), WireJson.Options).Trim('"'),
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? string.Empty
    };

    public void Dispose() => http.Dispose();

    private static IEnumerable<object> Items(object value) =>
        value is System.Collections.IEnumerable items and not string ? items.Cast<object?>().Where(item => item is not null).Cast<object>() : [value];

    [GeneratedRegex(@"\{([^}]+)\}", RegexOptions.CultureInvariant)]
    private static partial Regex Placeholder();
}`;
}

function responseReadingCs(model) {
  const composite = readsCompositeResponses(model) ? compositeReadingCs() : '';
  return `/// <summary>
/// El proveedor —o nuestra petición— viola el contrato que declara el diseño. NO es «el proveedor no está»: no entra al
/// fallback ni cuenta para el circuito, y sale como 500 con su traza. Si entrara al fallback, el llamante recibiría
/// «proveedor no disponible» por algo que no es una caída, y contaría para cortar llamadas a un proveedor que responde
/// perfectamente. Es el mismo criterio que keel-spring y keel-nest.
/// </summary>
public sealed class OutboundContractException : Exception
{
    public OutboundContractException(string message)
        : base(message)
    {
    }

    public OutboundContractException(string message, Exception cause)
        : base(message, cause)
    {
    }
}

/// <summary>La lectura de una respuesta del proveedor con el contrato del cable (WireJson), y el error saliente.</summary>
public static class ResponseReading
{
    /// <summary>El cuerpo como objeto JSON, o un OutboundContractException.</summary>
    public static JsonElement Object(JsonElement body, string where) =>
        body.ValueKind == JsonValueKind.Object ? body : throw new OutboundContractException($"{where}: la respuesta no es un objeto JSON");

    /// <summary>Un campo que el contrato declara obligatorio: presente y de su tipo, o un OutboundContractException.</summary>
    public static T Required<T>(JsonElement fields, string name, string where, string expected, string missing) =>
        TryGet(fields, name, out var value) ? Convert<T>(value, where, expected) : throw new OutboundContractException(missing);

    /// <summary>Un campo opcional: <typeparamref name="T"/> es el tipo ANULABLE (<c>bool?</c>), y su ausencia, null.</summary>
    public static T Optional<T>(JsonElement fields, string name, string where, string expected) =>
        TryGet(fields, name, out var value) ? Convert<T>(value, where, expected) : default!;

    /// <summary>Una lista: ausente o null es una lista vacía (list-never-null).</summary>
    public static IReadOnlyList<T> List<T>(JsonElement fields, string name, string where, string expected)
    {
        if (!TryGet(fields, name, out var value))
        {
            return [];
        }
        return value.ValueKind == JsonValueKind.Array
            ? Convert<List<T>>(value, where, expected)
            : throw new OutboundContractException($"{where}: se esperaba {expected}");
    }

    private static bool TryGet(JsonElement fields, string name, out JsonElement value) =>
        fields.TryGetProperty(name, out value) && value.ValueKind != JsonValueKind.Null;

    private static T Convert<T>(JsonElement value, string where, string expected)
    {
        try
        {
            return value.Deserialize<T>(WireJson.Options)!;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // Lo que el conversor o el constructor de un value object rechazan viola el contrato del PROVEEDOR: no es una
            // petición malformada nuestra.
            throw new OutboundContractException($"{where}: se esperaba {expected}", error);
        }
    }${composite}
}`;
}

/**
 * La lectura de un value object COMPUESTO de la respuesta, con el lector de la entrada (ValueReaders.Read<Tipo>): lo que su
 * constructor rechaza, o lo que no es un objeto, es un OutboundContractException —el contrato roto es del proveedor—.
 */
function compositeReadingCs() {
  return `

    /// <summary>Un value object compuesto opcional: su ausencia, null.</summary>
    public static T? Composite<T>(JsonElement fields, string name, string where, string expected, Func<JsonElement?, T?> read)
        where T : class =>
        TryGet(fields, name, out var value) ? Construct(value, where, expected, read) : null;

    /// <summary>Un value object compuesto que el contrato declara obligatorio.</summary>
    public static T RequiredComposite<T>(JsonElement fields, string name, string where, string expected, string missing, Func<JsonElement?, T?> read)
        where T : class =>
        TryGet(fields, name, out var value) ? Construct(value, where, expected, read) : throw new OutboundContractException(missing);

    /// <summary>Una lista de value objects compuestos: ausente o null es una lista vacía; un null DENTRO, contrato roto.</summary>
    public static IReadOnlyList<T> CompositeList<T>(JsonElement fields, string name, string where, string expected, Func<JsonElement?, T?> read)
        where T : class
    {
        if (!TryGet(fields, name, out var value))
        {
            return [];
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            throw new OutboundContractException($"{where}: se esperaba {expected}");
        }
        return value.EnumerateArray()
            .Select(element => element.ValueKind == JsonValueKind.Null ? throw new OutboundContractException($"{where}: se esperaba {expected}") : Construct(element, where, expected, read))
            .ToList();
    }

    private static T Construct<T>(JsonElement value, string where, string expected, Func<JsonElement?, T?> read)
        where T : class
    {
        try
        {
            return read(value) ?? throw new OutboundContractException($"{where}: se esperaba {expected}");
        }
        catch (Exception error) when (error is not OperationCanceledException and not OutboundContractException)
        {
            throw new OutboundContractException($"{where}: se esperaba {expected}", error);
        }
    }`;
}

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

// Secuencias del circuito contra la REFERENCIA de keel-core: pasos al azar con semilla fija (el mismo texto en cada build).
const CIRCUIT_STEPS = 600;

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Una secuencia de pasos (`a` pedir paso, `f`/`s` registrar fallo/éxito, `t<ms>` avanzar el reloj) con el estado que la
 * referencia de keel-core deja tras cada uno y lo que contesta cada `a`. Lo recorre la prueba emitida con el circuito de C#.
 */
export function circuitScript(spec, seed = 7) {
  const random = seeded(seed);
  let clock = 0;
  const reference = circuitBreakerReference(spec, () => clock);
  const steps = [];
  for (let i = 0; i < CIRCUIT_STEPS; i++) {
    const roll = random();
    if (roll < 0.05) {
      const ms = Math.floor(random() * spec.waitDurationMs * 1.5);
      clock += ms;
      steps.push(`t${ms}`);
    } else if (roll < 0.45) {
      steps.push(`a${reference.tryAcquire() ? 1 : 0}`);
    } else {
      // Más fallos que éxitos al principio, y al revés después: la secuencia tiene que abrir y volver a cerrar.
      const failed = random() < (i < CIRCUIT_STEPS / 2 ? 0.7 : 0.3);
      reference.record(failed);
      steps.push(failed ? 'f' : 's');
    }
    steps[steps.length - 1] += `:${{ closed: 'C', open: 'O', 'half-open': 'H' }[reference.state]}`;
  }
  return steps.join(' ');
}

/** Los circuitos distintos del diseño (por sus números): cada uno con su secuencia. */
function circuitSpecs(model) {
  const specs = new Map();
  for (const client of model.httpClients) {
    for (const call of client.calls) {
      const cb = resiliencePolicy(call).circuitBreaker;
      if (cb) specs.set(JSON.stringify(cb), cb);
    }
  }
  return [...specs.values()];
}

/** Los reintentos distintos del diseño: cada uno con las esperas de la referencia. */
function retrySpecs(model) {
  const specs = new Map();
  for (const client of model.httpClients) {
    for (const call of client.calls) {
      const retry = resiliencePolicy(call).retry;
      if (retry) specs.set(JSON.stringify(retry), retry);
    }
  }
  return [...specs.values()];
}

/** Un valor de muestra para un parámetro de una llamada, o null si su tipo no tiene uno sencillo (compuesto, json). */
function sampleValue(model, field) {
  if (field.list) return '[]';
  if (field.kind === 'enum') {
    const first = model.enums?.find((e) => e.name === field.csType)?.values?.[0];
    return first != null ? `default(${field.csType})` : null;
  }
  if (field.kind === 'composite') return compositeLiteral(model, field);
  return (
    {
      string: '"x"',
      text: '"x"',
      file: '"x"',
      int: '1',
      long: '1L',
      decimal: '1.50m',
      boolean: 'true',
      uuid: 'Guid.CreateVersion7()',
      date: 'new DateOnly(2026, 1, 1)',
      timestamp: 'DateTimeOffset.UnixEpoch'
    }[field.base] ?? null
  );
}

/** Las llamadas que la prueba emitida ejecuta contra un proveedor falso: con método, con resiliencia y argumentos de muestra. */
function probedCalls(model, which = (call) => call.retry || call.circuitBreaker) {
  return model.httpClients.flatMap((client) =>
    client.calls
      .filter((call) => call.method && which(call) && client.auth?.type !== 'oauth2-client-credentials')
      .map((call) => ({ client, call, args: [...callFields(call).map((field) => sampleValue(model, field)), ...(call.hasBody && !call.requestType ? ['new { }'] : [])] }))
      .filter(({ args }) => args.every((arg) => arg != null))
  );
}

/** Un literal double de C# (`2` → `2.0`): InlineData no convierte un int a un parámetro double?. */
function csDouble(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function emittedTests(model) {
  const sln = solution(model);
  const circuits = circuitSpecs(model).map((cb, index) => `    [InlineData(${csString(JSON.stringify(cb))}, ${csString(circuitScript(cb, 7 + index))})]`);
  // Sin repetir filas: dos reintentos que solo difieren en lo que reintentan esperan lo mismo (xUnit rechaza el duplicado).
  const retries = [
    ...new Set(
      retrySpecs(model).flatMap((retry) =>
        Array.from({ length: retry.maxAttempts }, (_, index) => index + 1).map(
          (attempt) =>
            `    [InlineData(${retry.initialDelayMs}L, ${retry.multiplier == null ? 'null' : csDouble(retry.multiplier)}, ${retry.maxDelayMs == null ? 'null' : `${retry.maxDelayMs}L`}, ${attempt}, ${retryWaitMs(attempt, retry)}L)]`
        )
      )
    )
  ];
  const probed = probedCalls(model);
  const probes = probed.map(({ client, call, args }) => adapterProbe(model, client, call, args));
  // El value object compuesto de una respuesta (incremento 16), en toda llamada que lo traiga, con resiliencia o sin ella.
  const composite = probedCalls(model, (call) => (!call.bodiless && call.responseFields.some(isComposite)) || call.bodyFields.some(isComposite));
  for (const { client, call, args } of composite) {
    const name = `${client.adapterClass}${callMethod(call)}`;
    const invoke = `adapter.${callMethod(call)}(${[...args, 'TestContext.Current.CancellationToken'].join(', ')})`;
    probes.push(compositeResponseProbe(model, client, call, name, invoke), compositeBodyProbe(model, client, call, name, invoke));
  }
  const helped = [...new Set([...probed, ...composite].map(({ client }) => client))];
  if (helped.length > 0) probes.unshift(probeHelpers(model, helped));
  const usings = ['System.Net', 'System.Net.Http.Headers', 'System.Text', 'System.Text.Json', 'Microsoft.Extensions.Logging.Abstractions', 'Xunit', clientAdaptersNamespace(model), clientsNamespace(model)];
  // El compuesto de muestra (un argumento o el valor esperado de una respuesta) se construye con su constructor.
  if ([...probed, ...composite].some(({ call }) => callFields(call).some(isComposite) || call.responseFields.some(isComposite))) usings.push(namespaceOf(model, 'valueObjects'));
  const circuitTheory = circuits.length > 0
    ? `
    /// <summary>
    /// El circuito de C# recorre la MISMA secuencia que la referencia de keel-core (circuitBreakerReference), paso a paso:
    /// lo que contesta cada petición de paso y el estado tras cada paso. La secuencia la generó build con la referencia.
    /// </summary>
    [Theory]
${circuits.join('\n')}
    public void ElCircuitoDiceLoMismoQueLaReferencia(string specJson, string script)
    {
        using var spec = JsonDocument.Parse(specJson);
        var root = spec.RootElement;
        long clock = 0;
        var circuit = new CircuitBreaker(
            new CircuitBreakerSpec(
                root.GetProperty("failureRateThreshold").GetDouble(),
                root.GetProperty("slidingWindowSize").GetInt32(),
                root.GetProperty("minimumNumberOfCalls").GetInt32(),
                root.GetProperty("waitDurationMs").GetInt64(),
                root.GetProperty("halfOpenCalls").GetInt32()),
            () => clock);
        var index = 0;
        foreach (var step in script.Split(' '))
        {
            index++;
            var (action, state) = (step[..step.IndexOf(':', StringComparison.Ordinal)], step[^1]);
            switch (action[0])
            {
                case 't':
                    clock += long.Parse(action[1..], System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case 'a':
                    Assert.True(circuit.TryAcquire() == (action[1] == '1'), $"paso {index} ({step}): TryAcquire no dice lo que la referencia");
                    break;
                default:
                    circuit.Record(action[0] == 'f');
                    break;
            }
            var expected = state switch { 'C' => CircuitState.Closed, 'O' => CircuitState.Open, _ => CircuitState.HalfOpen };
            Assert.True(expected == circuit.State, $"paso {index} ({step}): {circuit.State} en vez de {expected}");
        }
    }
`
    : '';
  const retryTheory = retries.length > 0
    ? `
    /// <summary>La espera antes de cada reintento, contra la referencia retryWaitMs de keel-core.</summary>
    [Theory]
${retries.join('\n')}
    public void LaEsperaEsLaDeLaReferencia(long initialDelayMs, double? multiplier, long? maxDelayMs, int attempt, long expected)
    {
        var retry = new RetrySpec(attempt + 1, initialDelayMs, multiplier, maxDelayMs, [ProviderFailureKind.Transport]);
        Assert.Equal(expected, OutboundResilience.RetryWaitMs(attempt, retry));
    }
`
    : '';
  const body = String.raw`/// <summary>
/// Los clientes salientes EJECUTADOS sin red: el circuito y la espera contra las referencias de keel-core, la
/// clasificación de cada desenlace del proveedor, la lectura del contrato y el adaptador de cada llamada resiliente contra
/// un proveedor falso. Lo que dice un proveedor DE VERDAD (WireMock) lo mide la red del generador.
/// </summary>
public sealed class OutboundClientsTests
{
    private static readonly ClientSettings Provider = new("proveedor", new Uri("http://proveedor.test/base/"), TimeSpan.FromMilliseconds(300), new Dictionary<string, string> { ["X-Api-Key"] = "k" });

    /// <summary>Un proveedor falso: contesta lo que diga <c>answer</c> y guarda cada petición.</summary>
    private sealed class FakeProvider(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return answer(request, cancellationToken);
        }

        public static FakeProvider Status(HttpStatusCode status, string body = "") =>
            new((_, _) => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) }));

        public static FakeProvider Unreachable() => new((_, _) => throw new HttpRequestException("conexión rechazada"));
    }

    private static async Task<OutboundResponse> Send(FakeProvider provider, OutboundRequest? request = null, CancellationToken? cancellationToken = null)
    {
        using var exchange = new HttpExchange(provider);
        return await exchange.Send(
            Provider,
            request ?? new OutboundRequest("GET", "/stock/{sku}") { PathParams = new Dictionary<string, object?> { ["sku"] = "a b/1" } },
            cancellationToken ?? TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task UnaRespuestaJsonSeLeeYLaRutaVaCodificada()
    {
        var provider = FakeProvider.Status(HttpStatusCode.OK, """{"ok":true}""");
        var response = await Send(provider);
        Assert.Equal(200, response.Status);
        Assert.True(response.Body!.Value.GetProperty("ok").GetBoolean());
        var sent = Assert.Single(provider.Requests);
        Assert.Equal("http://proveedor.test/base/stock/a%20b%2F1", sent.RequestUri!.AbsoluteUri);
        Assert.Equal("k", sent.Headers.GetValues("X-Api-Key").Single());
        Assert.Equal("application/json", sent.Headers.Accept.Single().MediaType);
    }

    [Fact]
    public async Task SinCuerpoNoEsUnFallo()
    {
        Assert.Null((await Send(FakeProvider.Status(HttpStatusCode.NoContent))).Body);
    }

    [Theory]
    [InlineData(503, ProviderFailureKind.ServerError)]
    [InlineData(500, ProviderFailureKind.ServerError)]
    [InlineData(404, ProviderFailureKind.ClientError)]
    [InlineData(409, ProviderFailureKind.ClientError)]
    [InlineData(302, ProviderFailureKind.UnknownStatus)]
    [InlineData(600, ProviderFailureKind.UnknownStatus)]
    public async Task CadaStatusQueNoEs2xxEsSuFallo(int status, ProviderFailureKind kind)
    {
        var failure = await Assert.ThrowsAsync<ProviderStatusException>(() => Send(FakeProvider.Status((HttpStatusCode)status, "detalle")));
        Assert.Equal(kind, failure.Kind);
        Assert.Equal(status, failure.Status);
        Assert.Equal("detalle", failure.Body);
    }

    [Fact]
    public async Task SinConexionEsTransporte()
    {
        var failure = await Assert.ThrowsAsync<ProviderTransportException>(() => Send(FakeProvider.Unreachable()));
        Assert.Equal(ProviderFailureKind.Transport, failure.Kind);
    }

    [Fact]
    public async Task UnProveedorQueNoContestaATiempoEsTransporte()
    {
        var silent = new FakeProvider(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var failure = await Assert.ThrowsAsync<ProviderTransportException>(() => Send(silent));
        Assert.Contains("sin respuesta en 300 ms", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LaCancelacionDeQuienLlamaNoEsUnTimeout()
    {
        using var cancellation = new CancellationTokenSource();
        var silent = new FakeProvider(async (_, token) =>
        {
            await cancellation.CancelAsync();
            await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Send(silent, cancellationToken: cancellation.Token));
    }

    [Fact]
    public async Task UnCuerpoQueNoEsJsonViolaElContratoYNoEsUnFalloDelProveedor()
    {
        var error = await Assert.ThrowsAsync<OutboundContractException>(() => Send(FakeProvider.Status(HttpStatusCode.OK, "<html>")));
        Assert.Contains("no es JSON", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnaRutaSinSuVariableNoSeManda()
    {
        Assert.Throws<OutboundContractException>(() => HttpExchange.Target(Provider.BaseUrl, new OutboundRequest("GET", "/stock/{sku}")));
    }

    [Fact]
    public void LaQueryRepiteLasListasYOmiteLosNulos()
    {
        var target = HttpExchange.Target(Provider.BaseUrl, new OutboundRequest("GET", "/stock") { Query = [new("sku", new[] { "a", "b" }), new("page", 2), new("vacío", null)] });
        Assert.Equal("http://proveedor.test/base/stock?sku=a&sku=b&page=2", target.AbsoluteUri);
    }

    [Fact]
    public void LaLecturaDelContratoDistingueAusenteDeMalTipado()
    {
        using var document = JsonDocument.Parse("""{"name":"x","count":"no","tags":null}""");
        var fields = ResponseReading.Object(document.RootElement, "p.c");
        Assert.Equal("x", ResponseReading.Required<string>(fields, "name", "p.c.name", "un texto", "falta"));
        Assert.Null(ResponseReading.Optional<int?>(fields, "absent", "p.c.absent", "un entero"));
        Assert.Empty(ResponseReading.List<string>(fields, "tags", "p.c.tags", "una lista de texto"));
        Assert.Equal("falta", Assert.Throws<OutboundContractException>(() => ResponseReading.Required<string>(fields, "absent", "p.c.absent", "un texto", "falta")).Message);
        Assert.Equal("p.c.count: se esperaba un booleano", Assert.Throws<OutboundContractException>(() => ResponseReading.Optional<bool?>(fields, "count", "p.c.count", "un booleano")).Message);
        Assert.Throws<OutboundContractException>(() => ResponseReading.Object(JsonDocument.Parse("[]").RootElement, "p.c"));
    }

    [Fact]
    public async Task ElRetryReintentaSoloLoQueSuPoliticaDiceYNuncaElCircuitoAbierto()
    {
        var policy = new OutboundPolicy("p", new RetrySpec(3, 10, 2, null, [ProviderFailureKind.Transport]), null);
        var waits = new List<TimeSpan>();
        Task Wait(TimeSpan wait, CancellationToken token)
        {
            waits.Add(wait);
            return Task.CompletedTask;
        }
        var attempts = 0;
        await Assert.ThrowsAsync<ProviderTransportException>(() => OutboundResilience.Run(policy, null, () => { attempts++; throw new ProviderTransportException("x"); }, TestContext.Current.CancellationToken, Wait));
        Assert.Equal(3, attempts);
        Assert.Equal(new[] { TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(20) }, waits);

        attempts = 0;
        await Assert.ThrowsAsync<ProviderStatusException>(() => OutboundResilience.Run(policy, null, () => { attempts++; throw new ProviderStatusException(503, ""); }, TestContext.Current.CancellationToken, Wait));
        Assert.Equal(1, attempts);

        var open = new CircuitBreaker(new CircuitBreakerSpec(50, 2, 2, 60_000, 1));
        open.Record(true);
        open.Record(true);
        attempts = 0;
        await Assert.ThrowsAsync<CallNotPermittedException>(() => OutboundResilience.Run(policy with { CircuitBreaker = null }, open, () => { attempts++; return Task.FromResult(1); }, TestContext.Current.CancellationToken, Wait));
        Assert.Equal(0, attempts);
    }

    [Fact]
    public async Task ParaElCircuitoUn4xxEsUnExitoYUnContratoRotoNoCuenta()
    {
        var circuit = new CircuitBreaker(new CircuitBreakerSpec(50, 4, 4, 60_000, 1));
        var policy = new OutboundPolicy("p", null, null);
        for (var i = 0; i < 4; i++)
        {
            await Assert.ThrowsAsync<ProviderStatusException>(() => OutboundResilience.Run(policy, circuit, () => Task.FromException<int>(new ProviderStatusException(404, "")), TestContext.Current.CancellationToken));
        }
        Assert.Equal(CircuitState.Closed, circuit.State);
        for (var i = 0; i < 4; i++)
        {
            await Assert.ThrowsAsync<OutboundContractException>(() => OutboundResilience.Run(policy, circuit, () => Task.FromException<int>(new OutboundContractException("roto")), TestContext.Current.CancellationToken));
        }
        Assert.Equal(CircuitState.Closed, circuit.State);
        for (var i = 0; i < 2; i++)
        {
            await Assert.ThrowsAsync<ProviderStatusException>(() => OutboundResilience.Run(policy, circuit, () => Task.FromException<int>(new ProviderStatusException(503, "")), TestContext.Current.CancellationToken));
        }
        Assert.Equal(CircuitState.Open, circuit.State);
    }
${circuitTheory}${retryTheory}${probes.join('')}${manualClock(model)}${lastKnownStoreTests(model)}${clientCredentialsTests(model)}}`;
  return { path: `${sln.unitTests.dir}/OutboundClientsTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

/** Los ayudantes de las sondas de adaptador: uno para construir cada adaptador sobre el proveedor falso, y el que traga el desenlace. */
function probeHelpers(model, clients) {
  const builders = clients.map((client) => {
    const dependencies = renderedAdapterDependencies(model, client);
    const deps = dependencies.map((dependency) => dependency.sample);
    // Con lastKnown, el almacén se puede pasar: dos adaptadores (proveedor vivo y caído) que comparten lo recordado.
    const store = dependencies.some((dependency) => dependency.name === 'lastKnown') ? ', LastKnownValues? lastKnown = null' : '';
    return `
    private static ${client.adapterClass} ${client.adapterClass}Over(FakeProvider provider${store}) =>
        new(${deps.join(', ')});`;
  });
  return `${builders.join('\n')}

    private static async Task Swallow(Func<Task> call)
    {
        try
        {
            await call();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // El desenlace de la llamada no es lo que se mide aquí: lo que salió hacia el proveedor, sí.
        }
    }
`;
}

/**
 * La llamada resiliente EJECUTADA contra un proveedor falso: con el proveedor inalcanzable, cuántos intentos salen (los de
 * su política si reintenta el transporte, uno si no) y, con clave de idempotencia, que es la MISMA en todos; y con el
 * proveedor devolviendo 5xx, que el circuito se abre y la llamada siguiente ni sale.
 */
function adapterProbe(model, client, call, args) {
  const policy = resiliencePolicy(call);
  const transportAttempts = policy.retry && policy.retry.retries.includes('transport') ? policy.retry.maxAttempts : 1;
  const method = callMethod(call);
  const name = `${client.adapterClass}${method}`;
  const invoke = `adapter.${method}(${[...args, 'TestContext.Current.CancellationToken'].join(', ')})`;
  const key = call.idempotency
    ? `
        var keys = provider.Requests.Select(request => request.Headers.GetValues(${csString(call.idempotency.header)}).Single()).Distinct().ToList();
        Assert.Single(keys);
        Assert.False(string.IsNullOrWhiteSpace(keys[0]));`
    : '';
  const circuit = policy.circuitBreaker
    ? `

    [Fact]
    public async Task ${name}AbreElCircuitoYLaSiguienteNiSale()
    {
        var provider = FakeProvider.Status(HttpStatusCode.ServiceUnavailable);
        var adapter = ${client.adapterClass}Over(provider);
        while (provider.Requests.Count < ${policy.circuitBreaker.minimumNumberOfCalls})
        {
            await Swallow(() => ${invoke});
        }
        var before = provider.Requests.Count;
        await Swallow(() => ${invoke});
        Assert.Equal(before, provider.Requests.Count);
    }`
    : '';
  return `
    /// <summary>${client.id}.${call.name}: con el proveedor inalcanzable salen ${transportAttempts} intento(s)${call.idempotency ? ', todos con la MISMA clave' : ''}.</summary>
    [Fact]
    public async Task ${name}ReintentaElTransporteComoDiceSuPolitica()
    {
        var provider = FakeProvider.Unreachable();
        var adapter = ${client.adapterClass}Over(provider);
        await Swallow(() => ${invoke});
        ${transportAttempts === 1 ? 'Assert.Single(provider.Requests);' : `Assert.Equal(${transportAttempts}, provider.Requests.Count);`}${key}
    }

    /// <summary>${client.id}.${call.name}: un cuerpo que no es JSON viola el contrato y se PROPAGA; no es «el proveedor no está».</summary>
    [Fact]
    public async Task ${name}NoDisfrazaUnContratoRotoDeCaida()
    {
        var provider = FakeProvider.Status(HttpStatusCode.OK, "<html>");
        var adapter = ${client.adapterClass}Over(provider);
        await Assert.ThrowsAsync<OutboundContractException>(() => ${invoke});
        Assert.Single(provider.Requests);
    }${circuit}${declaredFailureProbe(model, call, name, client, invoke)}${lastKnownProbe(model, client, call, name, args)}
`;
}

/**
 * El value object compuesto de un campo, si se puede construir con valores de muestra sin tropezar con sus guardas: solo
 * campos escalares sencillos y sin más regla que la presencia (o el texto no vacío). Si no, null (la prueba que lo necesite no se emite).
 */
function sampleComposite(model, field) {
  const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === elementType(field));
  if (!vo || vo.fields.length === 0) return null;
  const plain = vo.fields.every(
    (member) =>
      !member.list &&
      member.kind === 'base' &&
      COMPOSITE_SAMPLES[member.base] &&
      // Presencia y texto no vacío: los cumple cualquier muestra; una cota o un patrón podrían rechazarla.
      (member.validation ?? []).every((rule) => rule.rule === 'notNull' || rule.rule === 'notBlank') &&
      !member.numeric?.scale
  );
  return plain ? vo : null;
}

const COMPOSITE_SAMPLES = {
  string: { json: 'x', cs: '"x"' },
  text: { json: 'x', cs: '"x"' },
  int: { json: 7, cs: '7' },
  long: { json: 7, cs: '7L' },
  decimal: { json: 12.5, cs: '12.5m' },
  boolean: { json: true, cs: 'true' }
};

function compositeJson(model, field) {
  const vo = sampleComposite(model, field);
  return vo ? Object.fromEntries(vo.fields.map((member) => [member.name, COMPOSITE_SAMPLES[member.base].json])) : null;
}

/** El MISMO valor que compositeJson, construido en C#: lo que el adaptador tiene que devolver al leer ese JSON. */
function compositeLiteral(model, field) {
  const vo = sampleComposite(model, field);
  return vo ? `new ${vo.name}(${vo.fields.map((member) => COMPOSITE_SAMPLES[member.base].cs).join(', ')})` : null;
}

/**
 * Un value object compuesto en la respuesta (incremento 16): llega al resultado como su value object, igual al que se
 * construye con los mismos valores; y lo que no es un objeto, o lo que su constructor rechaza, viola el contrato del
 * proveedor —un OutboundContractException, no un 400 nuestro ni «el proveedor no está»—.
 */
/**
 * Un value object compuesto en el CUERPO (incremento 16): viaja como objeto JSON con los nombres del diseño y el contrato
 * del cable (el decimal con su escala), que es lo que escribe WireJson sobre sus propiedades.
 */
function compositeBodyProbe(model, client, call, name, invoke) {
  const composites = call.bodyFields.filter((field) => isComposite(field) && !field.list && compositeJson(model, field));
  if (composites.length === 0) return '';
  const answer = {};
  for (const field of call.responseFields) {
    const value = sampleJson(model, field);
    if (value == null) return '';
    answer[field.wireName ?? field.name] = value;
  }
  const checks = composites.map(
    (field) => `        Assert.Equal(${csString(JSON.stringify(compositeJson(model, field)))}, sent.RootElement.GetProperty(${csString(field.wireName ?? field.name)}).GetRawText());`
  );
  return `
    /// <summary>${client.id}.${call.name}: el compuesto del cuerpo viaja como objeto JSON, con los nombres del diseño.</summary>
    [Fact]
    public async Task ${name}EscribeElCompuestoDelCuerpoComoObjeto()
    {
        string? body = null;
        var provider = new FakeProvider(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(${csString(JSON.stringify(answer))}) };
        });
        var adapter = ${client.adapterClass}Over(provider);
        await ${invoke};
        using var sent = JsonDocument.Parse(body!);
${checks.join('\n')}
    }
`;
}

const BROKEN = '<compuesto roto>';

function compositeResponseProbe(model, client, call, name, invoke) {
  const composites = call.responseFields.filter((field) => isComposite(field) && !field.list);
  if (composites.length === 0 || call.bodiless) return '';
  const body = {};
  for (const field of call.responseFields) {
    const value = sampleJson(model, field);
    if (value == null) return '';
    body[field.wireName ?? field.name] = value;
  }
  return composites
    .map((field) => {
      const key = field.wireName ?? field.name;
      const member = csMember(field.name);
      // Lo que no es un objeto; el objeto vacío; y el que solo pierde UN obligatorio con los demás bien, que es el que
      // distingue el lector de la entrada de un Deserialize genérico (que le pasaría un 0 o un null al constructor).
      const vo = sampleComposite(model, field);
      const required = vo.fields.filter((m) => m.required);
      const sample = compositeJson(model, field);
      const missingOne = required.length > 0 && vo.fields.length > 1 ? [JSON.stringify(Object.fromEntries(Object.entries(sample).filter(([k]) => k !== required[0].name)))] : [];
      const broken = ['"doce"', ...(required.length > 0 ? ['{}'] : []), ...missingOne];
      const bodies = broken.map((value) => csString(JSON.stringify({ ...body, [key]: BROKEN }).replace(JSON.stringify(BROKEN), value)));
      return `
    /// <summary>${client.id}.${call.name}.${field.name}: el compuesto llega como su value object, con las guardas de su constructor.</summary>
    [Fact]
    public async Task ${name}Lee${member}ComoSuValueObject()
    {
        var adapter = ${client.adapterClass}Over(FakeProvider.Status(HttpStatusCode.OK, ${csString(JSON.stringify(body))}));
        var result = await ${invoke};
        Assert.Equal(${compositeLiteral(model, field)}, result.${member});
    }

    /// <summary>${client.id}.${call.name}.${field.name}: lo que no se construye viola el contrato del PROVEEDOR.</summary>
    [Theory]
${bodies.map((value) => `    [InlineData(${value})]`).join('\n')}
    public async Task ${name}Un${member}QueNoSeConstruyeViolaElContrato(string body)
    {
        var provider = FakeProvider.Status(HttpStatusCode.OK, body);
        var adapter = ${client.adapterClass}Over(provider);
        var error = await Assert.ThrowsAsync<OutboundContractException>(() => ${invoke});
        Assert.Contains(${csString(`${client.id}.${call.name}.${field.name}`)}, error.Message);
        Assert.Single(provider.Requests);
    }
`;
    })
    .join('');
}

/** Un valor JSON de muestra para un campo de la respuesta, o null si no tiene uno sencillo. */
function sampleJson(model, field) {
  if (field.list) return [];
  if (field.kind === 'enum') return model.enums?.find((e) => e.name === field.csType)?.values?.[0] ?? null;
  if (field.kind === 'composite') return compositeJson(model, field);
  return (
    {
      string: 'x',
      text: 'x',
      file: 'x',
      int: 7,
      long: 7,
      decimal: 12.5,
      boolean: true,
      uuid: '0192f1d2-0000-7000-8000-000000000001',
      date: '2026-01-01',
      timestamp: '2026-01-01T00:00:00.000Z'
    }[field.base] ?? null
  );
}

/**
 * Con `onUnavailable: lastKnown` y su error: el proveedor contesta y el adaptador lo recuerda; el proveedor cae y, dentro de
 * la ventana del diseño, sirve ESE valor marcado como último conocido; pasada la ventana, se rinde con el error declarado.
 */
function lastKnownProbe(model, client, call, name, args) {
  const need = (call.needs ?? []).find(({ need: candidate }) => candidate.onUnavailable?.action === 'lastKnown')?.need;
  // Solo si lastKnown es LA política de la llamada: con otra distinta por la misma llamada, el fallback es un TODO.
  if (!need || fallbackPolicy(call)?.action !== 'lastKnown' || !remembersCall(model, client, call) || !need.onUnavailable.exceptionClass) return '';
  const body = {};
  for (const field of call.responseFields) {
    const value = sampleJson(model, field);
    if (value == null) return '';
    body[field.wireName ?? field.name] = value;
  }
  const locals = args.map((arg, index) => `        var arg${index} = ${arg};`).join('\n');
  const invoke = (adapter) => `${adapter}.${callMethod(call)}(${[...args.map((_, index) => `arg${index}`), 'TestContext.Current.CancellationToken'].join(', ')})`;
  return `

    /// <summary>${client.id}.${call.name} (need ${need.name}, onUnavailable: lastKnown): el último valor, dentro de su ventana; después, el error del diseño.</summary>
    [Fact]
    public async Task ${name}SirveElUltimoValorConocidoDentroDeSuVentanaYDespuesSeRinde()
    {
        var clock = new ManualClock();
        var store = new LastKnownValues(clock);
${locals}
        var fresh = await ${invoke(`${client.adapterClass}Over(FakeProvider.Status(HttpStatusCode.OK, ${csString(JSON.stringify(body))}), store)`)};
        Assert.False(fresh.Stale);
        var down = ${client.adapterClass}Over(FakeProvider.Unreachable(), store);
        clock.Advance(TimeSpan.FromSeconds(${need.onUnavailable.maxAgeSeconds}));
        var served = await ${invoke('down')};
        Assert.Equal(fresh with { Stale = true }, served);
        clock.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<${namespaceOf(model, 'errors')}.${need.onUnavailable.exceptionClass}>(() => ${invoke('down')});
    }`;
}

/** ¿Algún cliente se autentica con `oauth2-client-credentials`? */
export function usesOAuth2(model) {
  return (model.httpClients ?? []).some((client) => client.auth?.type === 'oauth2-client-credentials');
}

/**
 * La concesión `client_credentials` (13j), con la semántica del OAuth2AuthorizedClientManager de keel-spring y la de
 * keel-nest: el secreto por `client_secret_basic` con la codificación de formulario de URLEncoder, los `scope` en el cuerpo,
 * el token REUTILIZADO hasta `expires_in` menos 60 s, una sola petición en vuelo, `token_type` Bearer obligatorio y, sin
 * `expires_in`, caducado en 1 s.
 */
function clientCredentials(model) {
  const { namespace, path } = located(model, 'clientAdapters', 'ClientCredentials');
  const body = `/// <summary>Lo que la concesión lee de http-clients.yaml (las variables de keel-spring: &lt;CLIENTE&gt;_CLIENT_ID, …).</summary>
public sealed record ClientCredentialsSettings(string Id, Uri TokenUri, string ClientId, string ClientSecret, IReadOnlyList<string> Scopes, TimeSpan Timeout);

/// <summary>La concesión del token no se pudo obtener: el emisor no responde o nos rechaza. No cuenta para el circuito.</summary>
public sealed class AuthGrantException(string message, Exception? cause = null)
    : ProviderFailureException(ProviderFailureKind.AuthGrant, message, null, cause);

/// <summary>
/// La concesión <c>client_credentials</c> de un cliente, con la semántica del OAuth2AuthorizedClientManager de keel-spring:
/// el secreto por <c>client_secret_basic</c> (cabecera Basic con los dos valores codificados como formulario), los
/// <c>scope</c> en el cuerpo, el token REUTILIZADO hasta <c>expires_in</c> menos el margen —una petición al emisor por
/// concesión, no por llamada— y una sola petición en vuelo aunque lleguen varias llamadas a la vez.
/// </summary>
public sealed class ClientCredentials(ClientCredentialsSettings settings, HttpMessageHandler? handler = null, TimeProvider? clock = null)
{
    /// <summary>El clockSkew de Spring Security: el token se renueva antes de caducar, para que no caduque en vuelo.</summary>
    public static readonly TimeSpan ClockSkew = TimeSpan.FromSeconds(60);

    private readonly ClientCredentialsSettings settings = settings;
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    // Sin redirecciones, como el cliente del JDK por defecto; el timeout lo pone cada petición.
    private readonly HttpClient http = new(handler ?? new SocketsHttpHandler { AllowAutoRedirect = false }) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    private readonly SemaphoreSlim gate = new(1, 1);
    private Token? current;

    private sealed record Token(string Header, DateTimeOffset RenewAt);

    /// <summary>La cabecera Authorization (<c>Bearer …</c>): la vigente, o una nueva si ya toca renovarla.</summary>
    /// <exception cref="AuthGrantException">Si el emisor no responde, nos rechaza o no devuelve un token Bearer.</exception>
    public async Task<string> Authorization(CancellationToken cancellationToken)
    {
        if (current is { } token && clock.GetUtcNow() < token.RenewAt)
        {
            return token.Header;
        }
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Quien esperaba en la puerta usa el que acaba de pedir otro.
            if (current is { } renewed && clock.GetUtcNow() < renewed.RenewAt)
            {
                return renewed.Header;
            }
            current = await Request(cancellationToken);
            return current.Header;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<Token> Request(CancellationToken cancellationToken)
    {
        var form = new List<KeyValuePair<string, string>> { new("grant_type", "client_credentials") };
        if (settings.Scopes.Count > 0)
        {
            form.Add(new("scope", string.Join(' ', settings.Scopes)));
        }
        using var message = new HttpRequestMessage(HttpMethod.Post, settings.TokenUri) { Content = new FormUrlEncodedContent(form) };
        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        var credentials = Convert.ToBase64String(Encoding.UTF8.GetBytes(FormEncode(settings.ClientId) + ":" + FormEncode(settings.ClientSecret)));
        message.Headers.Authorization = new AuthenticationHeaderValue("Basic", credentials);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(settings.Timeout);
        int status;
        string text;
        try
        {
            using var response = await http.SendAsync(message, timeout.Token);
            status = (int)response.StatusCode;
            text = await response.Content.ReadAsStringAsync(timeout.Token);
        }
        catch (Exception error) when (error is HttpRequestException or IOException || (error is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            throw new AuthGrantException($"{settings.Id}: el emisor del token no responde", error);
        }
        if (status is < 200 or > 299)
        {
            throw new AuthGrantException(string.Create(CultureInfo.InvariantCulture, $"{settings.Id}: el emisor del token contestó {status}"));
        }
        JsonElement body;
        try
        {
            using var document = JsonDocument.Parse(text);
            body = document.RootElement.Clone();
        }
        catch (JsonException error)
        {
            throw new AuthGrantException($"{settings.Id}: la respuesta del emisor del token no es JSON", error);
        }
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("access_token", out var accessToken) || accessToken.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(accessToken.GetString()))
        {
            throw new AuthGrantException($"{settings.Id}: la respuesta del emisor no trae access_token");
        }
        // Spring Security exige token_type Bearer: sin él no hay concesión.
        if (!body.TryGetProperty("token_type", out var tokenType) || tokenType.ValueKind != JsonValueKind.String || !string.Equals(tokenType.GetString(), "bearer", StringComparison.OrdinalIgnoreCase))
        {
            throw new AuthGrantException($"{settings.Id}: el emisor no devolvió un token Bearer");
        }
        // Sin expires_in (o no positivo), Spring lo da por caducado en un segundo: se pide de nuevo en la siguiente llamada.
        var lifetime = body.TryGetProperty("expires_in", out var expiresIn) && expiresIn.ValueKind == JsonValueKind.Number && expiresIn.TryGetDouble(out var seconds) && seconds > 0
            ? TimeSpan.FromSeconds(seconds)
            : TimeSpan.FromSeconds(1);
        return new Token("Bearer " + accessToken.GetString(), clock.GetUtcNow() + lifetime - ClockSkew);
    }

    /// <summary>La codificación de formulario de URLEncoder de Java (RFC 6749 § 2.3.1): se queda lo alfanumérico y <c>.-*_</c>; el espacio, «+».</summary>
    public static string FormEncode(string value)
    {
        var encoded = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '*' or '_')
            {
                encoded.Append(c);
            }
            else if (c == ' ')
            {
                encoded.Append('+');
            }
            else
            {
                encoded.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }
        return encoded.ToString();
    }
}`;
  return { path, content: csFile({ namespace, usings: ['System.Globalization', 'System.Net.Http.Headers', 'System.Text', 'System.Text.Json'], body }) };
}

/**
 * Las pruebas de la concesión (con OAuth2 en el diseño), contra un emisor falso: una petición por token aunque se pida tres
 * veces y dos a la vez; la cabecera Basic y el formulario exactos; la renovación; el emisor caído y el token sin token_type,
 * los dos como AuthGrant; y la llamada de negocio que no sale sin token.
 */
function manualClock(model) {
  if (!usesLastKnown(model) && !usesOAuth2(model)) return '';
  return `

    /// <summary>Un reloj que solo avanza cuando la prueba lo dice.</summary>
    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan by) => now += by;
    }`;
}

function clientCredentialsTests(model) {
  if (!usesOAuth2(model)) return '';
  return `

    /// <summary>Un emisor de tokens falso: contesta lo que diga <c>answer</c>, guarda cada petición con su cuerpo y puede hacerse esperar.</summary>
    private sealed class FakeIssuer(Func<int, (HttpStatusCode Status, string Body)> answer, TimeSpan? delay = null) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            int index;
            lock (Requests)
            {
                Requests.Add((request, body));
                index = Requests.Count;
            }
            if (delay is { } wait)
            {
                await Task.Delay(wait, cancellationToken);
            }
            var (status, text) = answer(index);
            return new HttpResponseMessage(status) { Content = new StringContent(text) };
        }

        public static FakeIssuer Bearer(int expiresIn = 300, TimeSpan? delay = null) =>
            new(index => (HttpStatusCode.OK, $$"""{"access_token":"token-{{index}}","token_type":"Bearer","expires_in":{{expiresIn}}}"""), delay);
    }

    private static readonly ClientCredentialsSettings Grant = new("socio", new Uri("http://emisor.test/token"), "cliente id", "secreto+&", ["catalog.read", "catalog.write"], TimeSpan.FromSeconds(2));

    [Fact]
    public async Task LaConcesionPideUnTokenYLoReutilizaConLaCabeceraBasicYElFormularioDeSpring()
    {
        var issuer = FakeIssuer.Bearer();
        var grant = new ClientCredentials(Grant, issuer);
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal("Bearer token-1", await grant.Authorization(TestContext.Current.CancellationToken));
        }
        var (request, body) = Assert.Single(issuer.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("Basic", request.Headers.Authorization!.Scheme);
        Assert.Equal("cliente+id:secreto%2B%26", Encoding.UTF8.GetString(Convert.FromBase64String(request.Headers.Authorization.Parameter!)));
        Assert.Equal("grant_type=client_credentials&scope=catalog.read+catalog.write", body);
    }

    [Fact]
    public async Task DosLlamadasALaVezSonUnaSolaPeticionAlEmisor()
    {
        var issuer = FakeIssuer.Bearer(delay: TimeSpan.FromMilliseconds(100));
        var grant = new ClientCredentials(Grant, issuer);
        var headers = await Task.WhenAll(grant.Authorization(TestContext.Current.CancellationToken), grant.Authorization(TestContext.Current.CancellationToken));
        Assert.Equal(new[] { "Bearer token-1", "Bearer token-1" }, headers);
        Assert.Single(issuer.Requests);
    }

    [Fact]
    public async Task ElTokenSeRenuevaSesentaSegundosAntesDeCaducarYSinExpiresInDuraUnSegundo()
    {
        var clock = new ManualClock();
        var issuer = FakeIssuer.Bearer(expiresIn: 300);
        var grant = new ClientCredentials(Grant, issuer, clock);
        Assert.Equal("Bearer token-1", await grant.Authorization(TestContext.Current.CancellationToken));
        clock.Advance(TimeSpan.FromSeconds(239));
        Assert.Equal("Bearer token-1", await grant.Authorization(TestContext.Current.CancellationToken));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal("Bearer token-2", await grant.Authorization(TestContext.Current.CancellationToken));
        var brief = new FakeIssuer(index => (HttpStatusCode.OK, $$"""{"access_token":"t{{index}}","token_type":"bearer"}"""));
        var once = new ClientCredentials(Grant, brief, clock);
        await once.Authorization(TestContext.Current.CancellationToken);
        await once.Authorization(TestContext.Current.CancellationToken);
        Assert.Equal(2, brief.Requests.Count);
    }

    [Fact]
    public async Task UnEmisorCaidoORechazandoOSinTokenBearerEsUnAuthGrant()
    {
        foreach (var issuer in new[]
        {
            new FakeIssuer(_ => throw new HttpRequestException("conexión rechazada")),
            new FakeIssuer(_ => (HttpStatusCode.Unauthorized, "{}")),
            new FakeIssuer(_ => (HttpStatusCode.OK, """{"access_token":"t","expires_in":300}""")),
            new FakeIssuer(_ => (HttpStatusCode.OK, """{"access_token":"t","token_type":"mac","expires_in":300}""")),
            new FakeIssuer(_ => (HttpStatusCode.OK, "<html>"))
        })
        {
            var failure = await Assert.ThrowsAsync<AuthGrantException>(() => new ClientCredentials(Grant, issuer).Authorization(TestContext.Current.CancellationToken));
            Assert.Equal(ProviderFailureKind.AuthGrant, failure.Kind);
        }
    }

    [Fact]
    public async Task ConTokenLaPeticionLlevaElBearerYSinElNoSale()
    {
        var provider = FakeProvider.Status(HttpStatusCode.OK, """{"ok":true}""");
        var granted = Provider with { Authorization = new ClientCredentials(Grant, FakeIssuer.Bearer()).Authorization };
        using (var exchange = new HttpExchange(provider))
        {
            await exchange.Send(granted, new OutboundRequest("GET", "/stock/{sku}") { PathParams = new Dictionary<string, object?> { ["sku"] = "a" } }, TestContext.Current.CancellationToken);
        }
        Assert.Equal("Bearer token-1", Assert.Single(provider.Requests).Headers.Authorization!.ToString());
        var denied = Provider with { Authorization = new ClientCredentials(Grant, new FakeIssuer(_ => (HttpStatusCode.Unauthorized, "{}"))).Authorization };
        var blocked = FakeProvider.Status(HttpStatusCode.OK, "{}");
        using (var exchange = new HttpExchange(blocked))
        {
            var failure = await Assert.ThrowsAsync<AuthGrantException>(() => exchange.Send(denied, new OutboundRequest("GET", "/stock/{sku}") { PathParams = new Dictionary<string, object?> { ["sku"] = "a" } }, TestContext.Current.CancellationToken));
            Assert.Equal(ProviderFailureKind.AuthGrant, failure.Kind);
        }
        Assert.Empty(blocked.Requests);
    }`;
}

/** Las pruebas del almacén del último valor conocido (con lastKnown en el diseño): ventana, clave, nulos y tope. */
function lastKnownStoreTests(model) {
  if (!usesLastKnown(model)) return '';
  return `

    private sealed record Remembered(string Value);

    [Fact]
    public void ElUltimoValorConocidoValeSuVentanaYNiUnSegundoMas()
    {
        var clock = new ManualClock();
        var store = new LastKnownValues(clock);
        store.Remember("llamada", LastKnownValues.Key("sku-1"), new Remembered("a"));
        clock.Advance(TimeSpan.FromSeconds(60));
        Assert.Equal(new Remembered("a"), store.Recall<Remembered>("llamada", LastKnownValues.Key("sku-1"), 60));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Null(store.Recall<Remembered>("llamada", LastKnownValues.Key("sku-1"), 60));
    }

    [Fact]
    public void ElUltimoValorEsDeEsaClaveYDeEsaLlamadaYUnNuloNoSeRecuerda()
    {
        var store = new LastKnownValues();
        store.Remember("llamada", LastKnownValues.Key("sku-1"), new Remembered("a"));
        store.Remember("llamada", LastKnownValues.Key("sku-2"), null);
        Assert.Null(store.Recall<Remembered>("llamada", LastKnownValues.Key("sku-2"), 60));
        Assert.Null(store.Recall<Remembered>("otra", LastKnownValues.Key("sku-1"), 60));
        Assert.NotEqual(LastKnownValues.Key("a", "b"), LastKnownValues.Key("a,b"));
    }

    [Fact]
    public void ElTopeExpulsaLoMasViejoYConservaLoUltimo()
    {
        var clock = new ManualClock();
        var store = new LastKnownValues(clock);
        for (var i = 0; i <= LastKnownValues.MaxEntries; i++)
        {
            store.Remember("llamada", LastKnownValues.Key(i), new Remembered(i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            clock.Advance(TimeSpan.FromMilliseconds(1));
        }
        Assert.Null(store.Recall<Remembered>("llamada", LastKnownValues.Key(0), 3600));
        Assert.NotNull(store.Recall<Remembered>("llamada", LastKnownValues.Key(LastKnownValues.MaxEntries), 3600));
    }`;
}

/**
 * Con `fail` en la política (de un need o de una activación), el proveedor caído es EL ERROR DEL DISEÑO, con su code: es lo
 * que el handler deja pasar sin capturarlo (la nota lo dice), y lo que ve el cliente.
 */
function declaredFailureProbe(model, call, name, client, invoke) {
  const failure = declaredFailure(call);
  if (!failure) return '';
  return `

    /// <summary>${client.id}.${call.name}: con el proveedor caído, el fallback lanza el error que declara el diseño (${failure.error}).</summary>
    [Fact]
    public async Task ${name}ConElProveedorCaidoLanzaElErrorDelDiseno()
    {
        var adapter = ${client.adapterClass}Over(FakeProvider.Unreachable());
        var error = await Assert.ThrowsAsync<${namespaceOf(model, 'errors')}.${failure.exceptionClass}>(() => ${invoke});
        Assert.Equal(${csString(failure.error)}, error.Code);
    }`;
}
