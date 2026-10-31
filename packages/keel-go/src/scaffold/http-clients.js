// Integraciones HTTP salientes (capa `http-clients`, incremento 11b), con el reparto hexagonal de los otros tres
// generadores: el PUERTO de cada cliente y los resultados de sus llamadas viven en `internal/domain` (en términos del
// dominio: `domain.InventoryClient`, `domain.CancelStockResult`); el adaptador, los tipos del cable del tercero y el
// mapeo de anticorrupción, en `internal/infrastructure/clients`. Si el tercero cambia su contrato, cambia el adaptador —
// nunca el dominio ni los casos de uso.
//
// QUÉ reintenta el retry, qué cuenta el circuito, qué atiende el fallback y con qué números lo decide keel-core
// (`gen/outbound-resilience.js`), igual que para los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño.
// El circuito no es el de una biblioteca: es la máquina de estados de resilience4j escrita en Go, y la prueba emitida la
// recorre paso a paso contra la referencia ejecutable de keel-core (`circuitBreakerReference`, con la secuencia de
// `circuitScript`). La misma decisión que keel-nest tomó con cockatiel y keel-dotnet con Polly: otra semántica haría que
// los cuatro servidores cortaran por cosas distintas. Ningún módulo nuevo: net/http es de la biblioteca estándar.
//
// Lo que en Go toma otra forma:
//   · **Un fallo del proveedor es un valor `*clients.ProviderFailure`** con su `Kind` (la tabla neutral) y, si contestó,
//     su status. El fallback lo atiende con `AsProviderFailure` y la lista de su llamada: lo demás —un error del
//     adaptador, un cuerpo que viola el contrato (`*clients.ContractError`), la cancelación de quien llama— se devuelve
//     tal cual, sin que nadie lo convierta en «el proveedor no está».
//   · **La política del fallback es del agente**: `<cliente>_fallback.go`, sin la cabecera de código generado, porque
//     cuando el diseño no la decide entera lleva un TODO, y build no deja un TODO en un archivo con ella. Cuando la decide
//     (`onFailure: ignore`, o `fail` con su error) nace ya escrita.
//   · **Sin keep-alive**: net/http reenvía por su cuenta una petición idempotente cuya conexión REUTILIZADA se corta antes
//     de la respuesta —un retry por debajo del del diseño—, lo mismo que keel-dotnet midió con SocketsHttpHandler (su
//     11d). Con una conexión por petición no hay conexión reutilizada que reintentar.
//
// El cuerpo y la respuesta los escribe y lee el contrato del cable (`internal/platform/wire`), el mismo que la API.

import { fallbackFailures, hasCallFallback, recordedFailures, resiliencePolicy, retryWaitMs, circuitScript, PROVIDER_FAILURES } from '@keel-system/keel-core/gen/outbound-resilience';
import { httpClientsYaml } from '@keel-system/keel-core/gen/http-clients-config';
import { LOCAL_STUB_BASE_URL } from '@keel-system/keel-core/gen/infra-catalog';
import { repositoryRoots, usesHttpClients, usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported, goUnexported } from '../lib/go-projection.js';
import { alignRows, commentLines, goString, keyedLiteral } from '../lib/go-source.js';
import { sentinelOf } from './errors.js';
import { docComment, domainPath, goFileName, goTypeName, layout, localName, packageFile } from './render.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export const CLIENTS_IMPORT = 'internal/infrastructure/clients';

/**
 * ¿Genera keel-go los clientes salientes de este diseño? Con la persistencia relacional (el cableado de los casos de uso
 * vive en sus Dependencies) y sin nada de lo que la frontera todavía rechaza: go-check genera TODAS las fixtures
 * saltándose la frontera, y lo que se emitiera para un diseño rechazado tendría que compilar igual.
 */
export function usesGoHttpClients(model) {
  return usesHttpClients(model) && usesRelational(model) && repositoryRoots(model).length > 0 && unsupportedOutbound(model).length === 0;
}

/**
 * Lo que keel-go todavía no genera de los clientes, leído del MODELO (la frontera lo dice con su motivo, leyendo las
 * capas). Sirve para que build no emita nada a medias.
 */
function unsupportedOutbound(model) {
  const out = [];
  for (const client of model.httpClients ?? []) {
    if (client.auth?.type === 'oauth2-client-credentials') out.push(`${client.id}: oauth2`);
    for (const call of client.calls) {
      if (!call.method || !call.typed) out.push(`${client.id}.${call.name}: sin method/path o sin contrato tipado`);
      if (!call.bodiless && call.responseFields.length === 0) out.push(`${client.id}.${call.name}: respuesta sin campos`);
      if ((call.needs ?? []).length > 0) out.push(`${client.id}.${call.name}: needs`);
      for (const field of callFields(call).concat(call.responseFields)) {
        if (field.kind === 'composite' || field.base === 'json') out.push(`${client.id}.${call.name}.${field.name}: ${field.kind === 'composite' ? 'compuesto' : 'json'}`);
      }
    }
  }
  for (const dependency of model.dependencies ?? []) {
    if ((dependency.needs ?? []).length > 0) out.push(`${dependency.id}: needs`);
  }
  return out;
}

/** El puerto de un cliente, en el dominio: `InventoryClient`. */
export function clientPort(client) {
  return goTypeName(client.clientClass);
}

/** El campo de Dependencies y el parámetro del handler que lo llevan. */
export function clientField(client) {
  return clientPort(client);
}

export function clientParam(client) {
  return goUnexported(clientPort(client));
}

/** El adaptador HTTP de un cliente: `InventoryHTTPAdapter`. */
export function adapterType(client) {
  return goTypeName(client.adapterClass);
}

/** El método Go de una llamada (`cancelStock` → `CancelStock`). */
export function callMethod(call) {
  return goExported(call.name);
}

/**
 * Los clientes cuyas activaciones dispara esta operación (`dependencies.activations`, por `triggeredBy`) por el canal
 * SÍNCRONO: su puerto se inyecta en el handler, o el camino de menor resistencia sería no llamarlo. `via.publishes` lo
 * emite el agregado y no necesita nada.
 */
export function activationClients(model, operation) {
  if (!usesGoHttpClients(model)) return [];
  const clients = [];
  for (const { activation } of operation.dependencyActivations ?? []) {
    const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === activation.http?.clientClass);
    if (client && !clients.includes(client)) clients.push(client);
  }
  return clients;
}

export function generate(model) {
  if (!usesGoHttpClients(model)) return [];
  const { clients } = layout(model);
  const file = (name, body, imports, options = {}) => ({ path: `${clients.dir}/${name}.go`, content: packageFile(model, clients, { imports, body, ...options }) });
  const files = [
    file('failures', failuresGo(), ['errors', 'fmt'], { doc: PACKAGE_DOC }),
    file('circuit', CIRCUIT_GO, ['sync', 'time']),
    file('resilience', RESILIENCE_GO, ['context', 'math', 'slices', 'time']),
    file('exchange', EXCHANGE_GO, ['bytes', 'context', 'encoding/json/jsontext', 'errors', 'fmt', 'io', 'net', 'net/http', 'net/url', 'regexp', 'strings', 'time', 'internal/platform/wire']),
    file('reading', READING_GO, ['encoding/json/v2', 'encoding/json/jsontext', 'internal/platform/wire']),
    file('settings', settingsGo(model), ['encoding/base64', 'fmt', 'net/url', 'strings', 'time', 'internal/platform/config']),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/http-clients.yaml`, content: httpClientsYaml(model, profile) })),
    emittedTests(model)
  ];
  if (usesOutboundIdempotency(model)) files.push(file('idempotency', idempotencyGo(model), ['context', 'crypto/sha256', 'encoding/hex', 'internal/platform/correlation', 'internal/platform/wire']));
  for (const client of model.httpClients) {
    files.push(port(model, client));
    files.push(file(`${goFileName(client.id)}_adapter`, adapterGo(model, client), adapterImports(client)));
    if (client.calls.some((call) => hasCallFallback(call))) {
      files.push(file(`${goFileName(client.id)}_fallback`, fallbackGo(model, client), adapterImports(client), { generated: false }));
    }
  }
  return files;
}

const PACKAGE_DOC = `Package clients son los clientes HTTP salientes del servicio (http-clients del diseño): el adaptador de cada puerto
de internal/domain sobre net/http, con la resiliencia que declara el diseño (retry, circuito y fallback, con la semántica
de keel-core/gen/outbound-resilience.js), los tipos del cable del tercero y su mapeo al dominio.`;

function adapterImports(client) {
  const fieldImports = client.calls.flatMap((call) => [...callFields(call), ...call.responseFields]).flatMap((field) => field.goImports ?? []);
  return ['context', 'errors', 'fmt', 'log/slog', 'slices', 'strconv', 'time', 'encoding/json/jsontext', 'internal/domain', 'internal/platform/wire', ...fieldImports];
}

/** ¿Alguna llamada manda clave de idempotencia al proveedor? */
function usesOutboundIdempotency(model) {
  return model.httpClients.some((client) => client.calls.some((call) => call.idempotency));
}

// ─── Campos ──────────────────────────────────────────────────────────────────────────────────────

/** Los parámetros de una llamada, en el orden del puerto: ruta, consulta, cabeceras y cuerpo. */
function callFields(call) {
  return [...call.pathParams, ...call.queryParams, ...call.headerParams, ...call.bodyFields];
}

/** Un identificador local Go para un parámetro (una cabecera puede llamarse `X-Request-Id`). */
function paramName(field) {
  return localName(String(field.name).replace(/[^A-Za-z0-9_]+(.)?/g, (_, next) => (next ? next.toUpperCase() : '')));
}

/** ¿Puede faltar el parámetro? Lo opcional que no es lista va como puntero. */
function optionalParam(field) {
  return !field.required && !field.list;
}

/** El tipo con el que se declara un campo; fuera del dominio, un enum por su paquete. */
function fieldType(field, { qualify = false, pointer = optionalParam(field) } = {}) {
  let type = field.goType;
  if (qualify && field.kind === 'enum') type = field.list ? `[]domain.${type.slice(2)}` : `domain.${type}`;
  return pointer && !field.list ? `*${type}` : type;
}

function callParams(call, qualify) {
  return callFields(call).map((field) => `${paramName(field)} ${fieldType(field, { qualify })}`);
}

function callArgs(call) {
  return callFields(call).map(paramName);
}

/** El texto de un valor escalar en la URL o en una cabecera, con la forma del contrato del cable. */
function textOf(field, expr) {
  if (field.kind === 'enum') return `string(${expr})`;
  switch (field.base) {
    case 'string':
    case 'text':
    case 'file':
      return expr;
    case 'uuid':
    case 'decimal':
    case 'date':
      return `${expr}.String()`;
    case 'boolean':
      return `strconv.FormatBool(${expr})`;
    case 'int':
      return `strconv.FormatInt(int64(${expr}), 10)`;
    case 'long':
      return `strconv.FormatInt(${expr}, 10)`;
    case 'timestamp':
      return `wire.FormatTimestamp(${expr})`;
    default:
      throw new Error(`keel-go no sabe escribir ${field.name} (${field.base}) en la URL ni en una cabecera`);
  }
}

/** Lo que se esperaba, para el mensaje de un campo que viola el contrato (las frases de keel-dotnet). */
function expected(model, field) {
  const element = (() => {
    if (field.kind === 'enum') {
      const name = field.list ? field.goType.slice(2) : field.goType;
      const values = model.enums?.find((e) => goTypeName(e.name) === name || e.name === name)?.values ?? [];
      return values.length > 0 ? `un valor de ${values.map((v) => v.literal).join('|')}` : 'un valor del enum';
    }
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
        date: 'una fecha YYYY-MM-DD'
      }[field.base] ?? 'un texto'
    );
  })();
  return field.list ? `una lista de ${element.replace(/^una? /, '')}` : element;
}

// Los nombres que el adaptador declara por llamada llevan el cliente delante: dos clientes pueden tener una llamada que
// se llame igual, y todo vive en el mismo paquete.
const scoped = (client, call, suffix) => `${goUnexported(client.id)}${call.pascal}${suffix}`;
const policyVar = (client, call) => scoped(client, call, 'Policy');
const fallbackVar = (client, call) => scoped(client, call, 'Fallback');
const responseType = (client, call) => scoped(client, call, 'Response');
const requestType = (client, call) => scoped(client, call, 'Request');
const readFunc = (client, call) => `read${goExported(client.id)}${call.pascal}Response`;
const mapFunc = (client, call) => `to${goExported(client.id)}${call.pascal}Result`;
const circuitField = (call) => `${goUnexported(call.name)}Circuit`;
const onceMethod = (call) => `${goUnexported(call.name)}Once`;
const unavailableMethod = (call) => `${goUnexported(call.name)}Unavailable`;
const resultType = (call) => goTypeName(call.resultType);

// ─── El puerto y los resultados (internal/domain) ────────────────────────────────────────────────

function port(model, client) {
  const { domain } = layout(model);
  const name = clientPort(client);
  const methods = client.calls.map((call) => {
    const returns = call.bodiless ? 'error' : `(${resultType(call)}, error)`;
    const doc = call.contract ? `${commentLines(`${callMethod(call)}: ${call.contract}`, '\t').join('\n')}\n` : '';
    return `${doc}\t${callMethod(call)}(${['ctx context.Context', ...callParams(call, false)].join(', ')}) ${returns}`;
  });
  const results = client.calls
    .filter((call) => !call.bodiless)
    .map((call) => {
      const rows = alignRows(call.responseFields.map((field) => ({ indent: '\t', cells: [goExported(field.name), field.list ? field.goType : `*${field.goType}`] })));
      return `// ${resultType(call)} es el resultado de ${client.id}.${call.name} en términos del dominio. Cada campo admite su
// ausencia: es lo que devuelve el fallback cuando el proveedor no dijo nada.
type ${resultType(call)} struct {
${rows.join('\n')}
}`;
    });
  const purpose = client.purpose ? docComment(name, client.purpose) : '';
  const body = `
${purpose}${commentLines(`Es un puerto de salida del dominio: su adaptador HTTP (${adapterType(client)}) vive en internal/infrastructure/clients.`).join('\n')}
type ${name} interface {
${methods.join('\n\n')}
}
${results.length > 0 ? `\n${results.join('\n\n')}\n` : ''}`;
  const imports = ['context', ...client.calls.flatMap((call) => [...callFields(call), ...call.responseFields]).flatMap((field) => field.goImports ?? [])];
  return { path: domainPath(model, client.clientClass), content: packageFile(model, domain, { imports, body }) };
}

// ─── El adaptador (internal/infrastructure/clients) ──────────────────────────────────────────────

const KIND = (kind) => `Kind${goExported(kind)}`;

/** La política de una llamada como literal Go: la de keel-core, ya resuelta. */
function policyLiteral(client, call) {
  const policy = resiliencePolicy(call);
  const pairs = [['Instance', goString(policy.instance)]];
  if (policy.retry) {
    const retry = [
      `MaxAttempts: ${policy.retry.maxAttempts}`,
      `InitialDelay: ${policy.retry.initialDelayMs} * time.Millisecond`,
      ...(policy.retry.multiplier != null ? [`Multiplier: ${policy.retry.multiplier}`] : []),
      ...(policy.retry.maxDelayMs != null ? [`MaxDelay: ${policy.retry.maxDelayMs} * time.Millisecond`] : []),
      `Retries: []FailureKind{${policy.retry.retries.map(KIND).join(', ')}}`
    ];
    pairs.push(['Retry', `&RetrySpec{${retry.join(', ')}}`]);
  }
  if (policy.circuitBreaker) pairs.push(['Circuit', `&${circuitSpec(policy.circuitBreaker)}`]);
  return `// ${policyVar(client, call)} es la política de ${client.id}.${call.name}: la de keel-core (gen/outbound-resilience.js), la misma
// que la de los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño.
var ${policyVar(client, call)} = Policy{
${keyedLiteral(pairs).join('\n')}
}`;
}

function circuitSpec(cb) {
  return `CircuitSpec{FailureRateThreshold: ${cb.failureRateThreshold}, SlidingWindowSize: ${cb.slidingWindowSize}, MinimumNumberOfCalls: ${cb.minimumNumberOfCalls}, WaitDuration: ${cb.waitDurationMs} * time.Millisecond, HalfOpenCalls: ${cb.halfOpenCalls}}`;
}

const resilient = (call) => Boolean(call.retry || call.circuitBreaker);

function adapterGo(model, client) {
  const type = adapterType(client);
  const circuits = client.calls.filter((call) => call.circuitBreaker);
  const fields = alignRows([
    { indent: '\t', cells: ['client', 'ClientSettings'] },
    { indent: '\t', cells: ['exchange', '*Exchange'] },
    { indent: '\t', cells: ['logger', '*slog.Logger'] },
    { indent: '\t', cells: ['wait', 'Wait'] },
    ...circuits.map((call) => ({ indent: '\t', cells: [circuitField(call), '*Circuit'] }))
  ]);
  const init = keyedLiteral(
    [
      ['client', 'client'],
      ['exchange', 'exchange'],
      ['logger', 'logger'],
      ['wait', 'Sleep'],
      ...circuits.map((call) => [circuitField(call), `NewCircuit(*${policyVar(client, call)}.Circuit, nil)`])
    ],
    '\t\t'
  );
  const parts = [
    `// ${type} es el adaptador HTTP de ${client.id}: implementa domain.${clientPort(client)} sobre net/http, con la
// resiliencia que declara el diseño. El circuito de cada llamada vive lo que el adaptador: uno por proceso, construido
// en el arranque.
type ${type} struct {
${fields.join('\n')}
}

// El compilador comprueba que el adaptador cumple el puerto.
var _ domain.${clientPort(client)} = (*${type})(nil)

// New${type} construye el adaptador de ${client.id} con su configuración del perfil. Sin ella no arranca.
func New${type}(settings Settings, exchange *Exchange, logger *slog.Logger) (*${type}, error) {
	client, ok := settings[${goString(client.id)}]
	if !ok {
		return nil, errors.New(${goString(`http-clients: no hay configuración para ${client.id}`)})
	}
	return &${type}{
${init.join('\n')}
	}, nil
}`
  ];
  for (const call of client.calls) {
    if (resilient(call)) parts.push(policyLiteral(client, call));
    if (hasCallFallback(call)) {
      const kinds = fallbackFailures({ circuitBreaker: Boolean(call.circuitBreaker) }).map((failure) => KIND(failure.kind));
      parts.push(`// ${fallbackVar(client, call)} es lo que atiende el fallback de ${client.id}.${call.name}: solo lo que ha hecho el PROVEEDOR.
var ${fallbackVar(client, call)} = []FailureKind{${kinds.join(', ')}}`);
    }
    parts.push(adapterMethod(model, client, call), onceGo(model, client, call));
    if (call.requestType) parts.push(requestGo(model, client, call));
    if (!call.bodiless) parts.push(responseGo(model, client, call), mapperGo(client, call));
  }
  return `\n${parts.join('\n\n')}\n`;
}

function adapterMethod(model, client, call) {
  const type = adapterType(client);
  const subject = `${client.id}.${call.name}`;
  const method = callMethod(call);
  const params = ['ctx context.Context', ...callParams(call, true)].join(', ');
  const args = ['ctx', ...callArgs(call)].join(', ');
  const result = `domain.${resultType(call)}`;
  const returns = call.bodiless ? 'error' : `(${result}, error)`;
  const doc = commentLines(`${method}: ${call.contract || subject}`).join('\n');
  if (!resilient(call)) {
    return `${doc}
func (a *${type}) ${method}(${params}) ${returns} {
	return a.${onceMethod(call)}(${args})
}`;
  }
  const circuit = call.circuitBreaker ? `a.${circuitField(call)}` : 'nil';
  const valueType = call.bodiless ? 'struct{}' : result;
  const attempt = call.bodiless
    ? `func(ctx context.Context) (struct{}, error) {
		return struct{}{}, a.${onceMethod(call)}(${args})
	}`
    : `func(ctx context.Context) (${valueType}, error) {
		return a.${onceMethod(call)}(${args})
	}`;
  const run = `Run(ctx, ${policyVar(client, call)}, ${circuit}, a.wait, ${attempt})`;
  if (!hasCallFallback(call)) {
    return call.bodiless
      ? `${doc}
func (a *${type}) ${method}(${params}) error {
	_, err := ${run}
	return err
}`
      : `${doc}
func (a *${type}) ${method}(${params}) (${result}, error) {
	return ${run}
}`;
  }
  // El fallback NO atiende cualquier error: solo los fallos del proveedor de su lista. Lo demás —un error del adaptador,
  // un cuerpo que viola el contrato, la cancelación de quien llama— se devuelve tal cual (keel-core, outbound-resilience).
  const fallbackArgs = ['ctx', ...callArgs(call), 'failure'].join(', ');
  return `${doc}
func (a *${type}) ${method}(${params}) ${returns} {
	${call.bodiless ? '_, err' : 'result, err'} := ${run}
	if failure, ok := AsProviderFailure(err); ok && slices.Contains(${fallbackVar(client, call)}, failure.Kind) {
		if failure.Kind == KindClientError {
			// Si el rechazo tiene significado de negocio —un 404 es «no existe», un 409 un conflicto suyo—, la traducción
			// va en ${onceMethod(call)}, mirando failure.Status antes de que llegue aquí.
			a.logger.WarnContext(ctx, "llamada rechazada por el proveedor", "call", ${goString(subject)}, "status", failure.Status)
		}
		return a.${unavailableMethod(call)}(${fallbackArgs})
	}
	return ${call.bodiless ? 'err' : 'result, err'}
}`;
}

/** Un intento: la petición, su clasificación y la lectura del cuerpo. Lo repite el retry. */
function onceGo(model, client, call) {
  const type = adapterType(client);
  const subject = `${client.id}.${call.name}`;
  const params = ['ctx context.Context', ...callParams(call, true)].join(', ');
  const zero = call.bodiless ? '' : `domain.${resultType(call)}{}, `;
  const returns = call.bodiless ? 'error' : `(domain.${resultType(call)}, error)`;
  const lines = [];
  if (call.idempotency) {
    // La firma es la del MISMO contenido que se envía; sin cuerpo, lo que identifica la petición son sus parámetros (el
    // DELETE de un recurso concreto). Se calcula DENTRO del intento y sale igual en cada uno.
    const payload = call.requestType ? ['body'] : callArgs(call);
    const factory = call.idempotency.keyFrom === 'correlation' ? `correlatedKey(ctx, ${goString(call.name)}` : `outboundKey(${goString(call.name)}`;
    if (call.requestType) lines.push(...requestBodyLines(client, call));
    lines.push(`\tkey, err := ${factory}${payload.length > 0 ? `, ${payload.join(', ')}` : ''})`, '\tif err != nil {', `\t\treturn ${zero}err`, '\t}');
  } else if (call.requestType) {
    lines.push(...requestBodyLines(client, call));
  }
  const required = (field) => !optionalParam(field) && !field.list;
  const pairs = [
    ['Method', goString(call.method)],
    ['Path', goString(call.path)]
  ];
  if (call.pathParams.length > 0) {
    pairs.push(['PathParams', `map[string]string{${call.pathParams.map((field) => `${goString(field.name)}: ${textOf(field, paramName(field))}`).join(', ')}}`]);
  }
  const fixedQuery = call.queryParams.filter(required);
  if (fixedQuery.length > 0) {
    pairs.push(['Query', `[]QueryParam{${fixedQuery.map((field) => `{Name: ${goString(field.name)}, Values: []string{${textOf(field, paramName(field))}}}`).join(', ')}}`]);
  }
  const headerEntries = call.headerParams.filter(required).map((field) => `${goString(field.name)}: ${textOf(field, paramName(field))}`);
  if (call.idempotency) headerEntries.push(`${goString(call.idempotency.header)}: key`);
  if (headerEntries.length > 0 || call.headerParams.length > 0) pairs.push(['Headers', `map[string]string{${headerEntries.join(', ')}}`]);
  if (call.requestType) pairs.push(['Body', 'body']);
  lines.push('\trequest := Request{', ...keyedLiteral(pairs, '\t\t'), '\t}');
  for (const field of call.queryParams.filter((f) => !required(f))) {
    const name = paramName(field);
    if (field.list) {
      lines.push(
        `\t${name}Values := make([]string, 0, len(${name}))`,
        `\tfor _, value := range ${name} {`,
        `\t\t${name}Values = append(${name}Values, ${textOf(field, 'value')})`,
        '\t}',
        `\trequest.Query = append(request.Query, QueryParam{Name: ${goString(field.name)}, Values: ${name}Values})`
      );
    } else {
      lines.push(`\tif ${name} != nil {`, `\t\trequest.Query = append(request.Query, QueryParam{Name: ${goString(field.name)}, Values: []string{${textOf(field, `*${name}`)}}})`, '\t}');
    }
  }
  for (const field of call.headerParams.filter((f) => !required(f))) {
    const name = paramName(field);
    if (field.list) {
      lines.push(`\tfor _, value := range ${name} {`, `\t\trequest.Headers[${goString(field.name)}] = ${textOf(field, 'value')}`, '\t}');
    } else {
      lines.push(`\tif ${name} != nil {`, `\t\trequest.Headers[${goString(field.name)}] = ${textOf(field, `*${name}`)}`, '\t}');
    }
  }
  // Sin cuerpo no hay variable nueva que declarar si la clave ya declaró err.
  const declare = call.idempotency ? '=' : ':=';
  if (call.bodiless) {
    lines.push(`\t_, err ${declare} a.exchange.Send(ctx, a.client, request)`, '\treturn err');
  } else {
    lines.push(
      `\tresponse, err := a.exchange.Send(ctx, a.client, request)`,
      '\tif err != nil {',
      `\t\treturn ${zero}err`,
      '\t}',
      // Cuerpo ausente (un 204): el mismo criterio que los otros tres — valores AUSENTES, no un fallo. Con
      // awaits: outcome quien decide qué hacer sin desenlace es el handler; fallar se lo robaría.
      '\tif response.Body == nil {',
      `\t\ta.logger.WarnContext(ctx, "el proveedor respondió sin cuerpo", "call", ${goString(subject)}, "fields", ${call.responseFields.length})`,
      `\t\treturn domain.${resultType(call)}{}, nil`,
      '\t}',
      `\tread, err := ${readFunc(client, call)}(response.Body)`,
      '\tif err != nil {',
      `\t\treturn ${zero}err`,
      '\t}',
      `\treturn ${mapFunc(client, call)}(read), nil`
    );
  }
  return `// ${onceMethod(call)} es UN intento de ${subject}: la petición, su clasificación y la lectura del cuerpo. Lo repite el
// retry.
func (a *${type}) ${onceMethod(call)}(${params}) ${returns} {
${lines.join('\n')}
}`;
}

/** El cuerpo del cable, armado desde los valores del dominio: el mapeo de anticorrupción de la petición. */
function requestBodyLines(client, call) {
  const pairs = call.bodyFields.map((field) => [goExported(field.name), paramName(field)]);
  return [`\tbody := ${requestType(client, call)}{`, ...keyedLiteral(pairs, '\t\t'), '\t}'];
}

function requestGo(model, client, call) {
  const rows = alignRows(call.bodyFields.map((field) => ({ indent: '\t', cells: [goExported(field.name), fieldType(field, { qualify: true }), `\`json:"${field.name}${optionalParam(field) ? ',omitzero' : ''}"\``] })));
  return `// ${requestType(client, call)} es el cuerpo del cable de ${client.id}.${call.name} (contrato del sistema externo): lo escribe el
// contrato del cable (wire).
type ${requestType(client, call)} struct {
${rows.join('\n')}
}`;
}

function responseGo(model, client, call) {
  const subject = `${client.id}.${call.name}`;
  const rows = alignRows(call.responseFields.map((field) => ({ indent: '\t', cells: [goExported(field.name), fieldType(field, { qualify: true, pointer: !field.required })] })));
  const reads = call.responseFields.map((field) => {
    const where = goString(`${subject}.${field.name}`);
    const what = goString(expected(model, field));
    const target = `&response.${goExported(field.name)}`;
    if (field.list) return `list(fields, ${goString(field.name)}, ${where}, ${what}, ${target})`;
    if (field.required) {
      const missing = goString(`${subject}: la respuesta no trae '${field.name}', que el contrato declara obligatorio`);
      return `required(fields, ${goString(field.name)}, ${where}, ${what}, ${missing}, ${target})`;
    }
    return `optional(fields, ${goString(field.name)}, ${where}, ${what}, ${target})`;
  });
  return `// ${responseType(client, call)} es la respuesta del cable de ${subject} (contrato del sistema externo).
type ${responseType(client, call)} struct {
${rows.join('\n')}
}

// ${readFunc(client, call)} lee el cuerpo del proveedor. Un campo que el contrato declara obligatorio y no llega, o que
// llega con otro tipo, es un *ContractError: NO es «el proveedor no está» (no entra al fallback ni cuenta para el
// circuito) y sale como un 500, igual que en los otros tres servidores.
func ${readFunc(client, call)}(body jsontext.Value) (${responseType(client, call)}, error) {
	var response ${responseType(client, call)}
	fields, err := object(body, ${goString(subject)})
	if err != nil {
		return response, err
	}
${reads
  .map(
    (read) => `	if err := ${read}; err != nil {
		return response, err
	}`
  )
  .join('\n')}
	return response, nil
}`;
}

function mapperGo(client, call) {
  const pairs = call.responseFields.map((field) => [goExported(field.name), field.required && !field.list ? `&response.${goExported(field.name)}` : `response.${goExported(field.name)}`]);
  return `// ${mapFunc(client, call)} traduce la respuesta del cable de ${client.id}.${call.name} al resultado del dominio: la capa de
// anticorrupción. Si el tercero cambia su contrato, el cambio se absorbe aquí, nunca en el dominio.
func ${mapFunc(client, call)}(response ${responseType(client, call)}) domain.${resultType(call)} {
	return domain.${resultType(call)}{
${keyedLiteral(pairs, '\t\t').join('\n')}
	}
}`;
}

// ─── La política del fallback (del agente) ───────────────────────────────────────────────────────

function fallbackGo(model, client) {
  const parts = client.calls.filter((call) => hasCallFallback(call)).map((call) => unavailableGo(model, client, call));
  return `\n${parts.join('\n\n')}\n`;
}

function unavailableGo(model, client, call) {
  const subject = `${client.id}.${call.name}`;
  const params = ['ctx context.Context', ...callParams(call, true), 'failure *ProviderFailure'].join(', ');
  const returns = call.bodiless ? 'error' : `(domain.${resultType(call)}, error)`;
  const body = unavailableBody(model, client, call);
  return `// ${unavailableMethod(call)} es la política del diseño para cuando ${subject} no sale.
//
// Solo llega aquí lo que ha hecho el PROVEEDOR: no responder, responder mal o rechazarnos. Un error de este adaptador no
// tiene rama que lo traiga y se devuelve tal cual. No lo ensanches a cualquier error para «que no se escape nada»: lo
// que se escapa es el error.
func (a *${adapterType(client)}) ${unavailableMethod(call)}(${params}) ${returns} {
${body}
}`;
}

/** El cuerpo del fallback: la política que declara la activación que sale por esta llamada (como los otros tres). */
function unavailableBody(model, client, call) {
  const subject = `${client.id}.${call.name}`;
  const activations = call.activations ?? [];
  const zero = call.bodiless ? '' : `domain.${resultType(call)}{}, `;
  const trace = `\ta.logger.WarnContext(ctx, "fallback", "call", ${goString(subject)}, "reason", failure.Error())`;
  const prose = call.fallback ? `${commentLines(`Fallback declarado en el diseño: ${call.fallback}`, '\t').join('\n')}\n` : '';
  const todoReturn = `\treturn ${zero}fmt.Errorf(${goString(`fallback de ${subject} sin implementar: %w`)}, failure)`;
  const distinct = new Set(activations.map(({ activation }) => JSON.stringify(activation.onFailure ?? null)));
  // Una política, y solo una: con dos distintas el conflicto es del diseño (un método no puede hacer dos cosas).
  if (distinct.size !== 1) {
    const doc = call.fallback ? `\t// TODO (agente): ${call.fallback}` : '\t// TODO (agente): la política del fallback del circuito abierto.';
    const listed =
      distinct.size > 1
        ? `\n${commentLines(
            `Varias políticas DISTINTAS salen por esta llamada y el diseño no puede darles caminos distintos sobre un único método: ${activations
              .map(({ dependency, activation }) => `${dependency}.${activation.name} (onFailure: ${activation.onFailure?.action ?? 'sin declarar'})`)
              .join('; ')}`,
            '\t'
          ).join('\n')}`
        : '';
    return `${trace}\n${doc}${listed}\n${todoReturn}`;
  }
  const { dependency, activation } = activations[0];
  const decl = activation.onFailure;
  const origin = `\t// Política declarada por la activación ${dependency}.${activation.name} (onFailure: ${decl?.action ?? 'sin declarar'}).\n`;
  if (decl?.action === 'ignore') {
    // Una sola línea: es el mismo evento que el trace, y esta dice más (que el llamante sigue adelante).
    return `${prose}${origin}\t// El llamante sigue adelante: no propagues el error ni inventes datos del proveedor.
\ta.logger.WarnContext(ctx, "proveedor no disponible; se continúa sin él", "call", ${goString(subject)}, "reason", failure.Error())
\treturn ${call.bodiless ? 'nil' : `domain.${resultType(call)}{}, nil`}`;
  }
  if (decl?.action === 'fail' && decl.exceptionClass && decl.error) {
    const message = goString(`${dependency} no está disponible para ${activation.name}`);
    const error = decl.dynamicStatus ? `domain.StatusErrorf(domain.${sentinelOf(decl.error)}, ${decl.httpStatus}, ${message})` : `domain.Errorf(domain.${sentinelOf(decl.error)}, ${message})`;
    return `${trace}\n${prose}${origin}\treturn ${zero}${error}`;
  }
  if (decl?.action === 'fail') {
    return `${trace}\n${prose}${origin}\t// TODO (agente): el diseño declara el error ${decl.error}, pero ninguna operación de use-cases lo declara todavía,
\t// así que su centinela no existe.
${todoReturn}`;
  }
  if (decl?.action === 'degrade') {
    return `${trace}\n${prose}${origin}\t// TODO (agente): el resultado degradado es lógica de negocio y tiene que poder distinguirlo el cliente de una
\t// respuesta normal — un dato plausible pero falso es peor que fallar:
${commentLines(decl.degradedTo ?? '', '\t//  ').join('\n')}
${todoReturn}`;
  }
  return `${trace}\n${prose}${origin}\t// TODO (agente): la activación no declara onFailure.
${todoReturn}`;
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

function settingsGo(model) {
  const reads = model.httpClients.map((client) => {
    const variable = `${goUnexported(client.id)}Client`;
    const lines = [
      `	${variable}, err := clientOf(value, ${goString(client.id)}, ${client.readTimeoutMs}*time.Millisecond)`,
      '	if err != nil {',
      '		return nil, err',
      '	}'
    ];
    const key = (leaf) => goString(`${client.auth.propertyPrefix}.${leaf}`);
    const read = (name, leaf) => [`	${name}, err := text(value, ${key(leaf)})`, '	if err != nil {', '		return nil, err', '	}'];
    if (client.auth?.type === 'api-key') {
      lines.push(...read(`${variable}Key`, 'api-key'), `	${variable}.Headers[${goString(client.auth.headerName)}] = ${variable}Key`);
    } else if (client.auth?.type === 'bearer-static') {
      lines.push(...read(`${variable}Token`, 'token'), `	${variable}.Headers["Authorization"] = "Bearer " + ${variable}Token`);
    } else if (client.auth?.type === 'basic') {
      lines.push(
        ...read(`${variable}Username`, 'username'),
        ...read(`${variable}Password`, 'password'),
        `	${variable}.Headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(${variable}Username+":"+${variable}Password))`
      );
    }
    lines.push(`	settings[${goString(client.id)}] = ${variable}`);
    return lines.join('\n');
  });
  return `
// ClientSettings es lo que un adaptador sabe de su proveedor: la URL, el plazo de cada intento y las cabeceras de su
// autenticación.
type ClientSettings struct {
	ID      string
	BaseURL *url.URL
	// Timeout es el plazo de UN intento, lectura del cuerpo incluida: el de lectura de keel-spring, el mayor de las
	// llamadas del cliente.
	Timeout time.Duration
	Headers map[string]string
}

// Settings son las de todos los clientes del diseño, por su id.
type Settings map[string]ClientSettings

// SettingsFrom lee de config/parameters/<perfil>/http-clients.yaml (las MISMAS claves y variables que los servidores de
// keel-spring, keel-nest y keel-dotnet) la URL de cada proveedor, obligatoria fuera de local, y las credenciales de su
// autenticación, que nunca vienen del diseño. Se lee al ARRANCAR: lo que falta no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	return read(cfg.Value)
}

func read(value func(string) (string, bool)) (Settings, error) {
	settings := Settings{}
${reads.join('\n')}
	return settings, nil
}

// clientOf son las de un cliente sin su autenticación: la URL, absoluta, y el plazo de cada intento.
func clientOf(value func(string) (string, bool), id string, timeout time.Duration) (ClientSettings, error) {
	key := "http-clients." + id + ".base-url"
	raw, err := text(value, key)
	if err != nil {
		return ClientSettings{}, err
	}
	base, err := url.Parse(raw)
	if err != nil || !base.IsAbs() {
		return ClientSettings{}, fmt.Errorf("configuración: %s no es una URL absoluta", key)
	}
	return ClientSettings{ID: id, BaseURL: base, Timeout: timeout, Headers: map[string]string{}}, nil
}

// text es el valor de key sin espacios a los lados, o un error si falta.
func text(value func(string) (string, bool), key string) (string, error) {
	raw, ok := value(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("configuración: falta %s", key)
	}
	return strings.TrimSpace(raw), nil
}
`;
}

// ─── La clave de idempotencia saliente ───────────────────────────────────────────────────────────

function idempotencyGo(model) {
  const correlated = model.httpClients.some((client) => client.calls.some((call) => call.idempotency?.keyFrom === 'correlation'));
  const byContent = model.httpClients.some((client) => client.calls.some((call) => call.idempotency));
  const parts = [];
  if (byContent) {
    parts.push(`// outboundKey es la clave de idempotencia que ESTE servicio manda al proveedor por una llamada, por CONTENIDO: dos
// peticiones idénticas son la misma intención. Es la cara simétrica de la de entrada: un timeout no distingue «no llegó»
// de «llegó y se hizo», así que sin clave el reintento de una escritura es una segunda ejecución. Lo que la hace útil es
// que el reintento produzca la MISMA clave: nada aleatorio ni dependiente del instante.
func outboundKey(call string, payload ...any) (string, error) {
	encoded, err := wire.Marshal(append([]any{call}, payload...))
	if err != nil {
		return "", contractErrorf(err, "%s: la clave de idempotencia no se puede calcular", call)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}`);
  }
  if (correlated) {
    parts.push(`// correlatedKey es la clave por CORRELACIÓN: el proveedor deduplica por intención de negocio, no por contenido. Sin
// correlación abierta (un barrido, un arranque) cae a la del contenido. La petición entra también en la clave: una
// ejecución puede hacer varias llamadas distintas al mismo método, y con solo la correlación el proveedor absorbería todas
// menos la primera.
func correlatedKey(ctx context.Context, call string, payload ...any) (string, error) {
	if id, ok := correlation.ID(ctx); ok {
		return outboundKey(call, append([]any{id}, payload...)...)
	}
	return outboundKey(call, payload...)
}`);
  }
  return `\n${parts.join('\n\n')}\n`;
}

// ─── El soporte (uno por servicio) ───────────────────────────────────────────────────────────────

function failuresGo() {
  const kinds = alignRows(
    Object.values(PROVIDER_FAILURES).flatMap((failure) => [
      ...commentLines(`${KIND(failure.kind)}: ${failure.reason[0].toLowerCase()}${failure.reason.slice(1)}`, '\t').map((text) => ({ text })),
      { indent: '\t', cells: [KIND(failure.kind), 'FailureKind', `= ${goString(failure.kind)}`] }
    ])
  );
  const recorded = recordedFailures().map((failure) => KIND(failure.kind));
  return `
// FailureKind es QUÉ hizo el proveedor: la tabla de keel-core (gen/outbound-resilience.js), la misma que en keel-spring
// proyecta cada fallo a su excepción de Spring, en keel-nest a su error de fetch y en keel-dotnet a su ProviderFailureKind.
type FailureKind string

const (
${kinds.join('\n')}
)

// ProviderFailure es un fallo del PROVEEDOR: su Kind y, si contestó, su status y su cuerpo. Lo que no es uno de estos —un
// error del adaptador, un cuerpo que viola el contrato, la cancelación de quien llama— no entra al fallback ni cuenta
// para el circuito: se devuelve tal cual.
type ProviderFailure struct {
	Kind FailureKind
	// Status es el que contestó el proveedor, o 0 si no contestó.
	Status int
	// Body es el cuerpo de su respuesta: para que el adaptador traduzca un rechazo con significado de negocio.
	Body    string
	message string
	cause   error
}

// Error dice qué hizo el proveedor, con la llamada delante.
func (f *ProviderFailure) Error() string {
	return f.message
}

// Unwrap es el error de net/http que lo causó, si lo hay.
func (f *ProviderFailure) Unwrap() error {
	return f.cause
}

// AsProviderFailure dice si err es, o envuelve, un fallo del proveedor.
func AsProviderFailure(err error) (*ProviderFailure, bool) {
	var failure *ProviderFailure
	if errors.As(err, &failure) {
		return failure, true
	}
	return nil, false
}

// transportFailure es una conexión rechazada, un plazo vencido, un DNS o un socket roto: no hay nadie al otro lado.
func transportFailure(message string, cause error) *ProviderFailure {
	return &ProviderFailure{Kind: KindTransport, message: message, cause: cause}
}

// statusFailure clasifica un status que no es 2xx. 4xx: nos RECHAZA (contestó, no está caído); 5xx: está roto; cualquier
// otro: no es un status que un contrato pueda declarar.
func statusFailure(status int, body string) *ProviderFailure {
	kind := KindUnknownStatus
	switch {
	case status >= 400 && status <= 499:
		kind = KindClientError
	case status >= 500 && status <= 599:
		kind = KindServerError
	}
	return &ProviderFailure{Kind: kind, Status: status, Body: body, message: fmt.Sprintf("el proveedor contestó %d", status)}
}

// circuitOpenFailure es el circuito abierto: la llamada ni se intentó.
func circuitOpenFailure() *ProviderFailure {
	return &ProviderFailure{Kind: KindCircuitOpen, message: "el circuito está abierto: la llamada ni se intentó"}
}

// counts dice si el desenlace de una llamada que salió cuenta como fallo para el circuito: la lista CERRADA de la tabla
// neutral. Un 4xx, un contrato roto o un error nuestro cuentan como éxito: contestar no es estar caído.
func counts(err error) bool {
	failure, ok := AsProviderFailure(err)
	return ok && (${recorded.map((kind) => `failure.Kind == ${kind}`).join(' || ')})
}

// ContractError es el proveedor —o nuestra petición— violando el contrato que declara el diseño. NO es «el proveedor no
// está»: no entra al fallback ni cuenta para el circuito, y sale como un 500. Si entrara al fallback, el llamante
// recibiría «proveedor no disponible» por algo que no es una caída, y contaría para cortar llamadas a un proveedor que
// responde perfectamente.
type ContractError struct {
	message string
	cause   error
}

// Error dice qué parte del contrato se rompió y dónde.
func (e *ContractError) Error() string {
	return e.message
}

// Unwrap es el error del lector o del constructor que lo rechazó, si lo hay.
func (e *ContractError) Unwrap() error {
	return e.cause
}

func contractErrorf(cause error, format string, args ...any) *ContractError {
	return &ContractError{message: fmt.Sprintf(format, args...), cause: cause}
}
`;
}

const CIRCUIT_GO = `
// CircuitSpec son los números de un circuito: los de keel-core (resiliencePolicy), ya resueltos.
type CircuitSpec struct {
	FailureRateThreshold float64
	SlidingWindowSize    int
	MinimumNumberOfCalls int
	WaitDuration         time.Duration
	HalfOpenCalls        int
}

// CircuitState es el estado de un circuito.
type CircuitState int

const (
	// CircuitClosed deja pasar las llamadas y cuenta sus desenlaces.
	CircuitClosed CircuitState = iota
	// CircuitOpen rechaza sin intentar hasta que pasa WaitDuration.
	CircuitOpen
	// CircuitHalfOpen deja pasar las llamadas de prueba.
	CircuitHalfOpen
)

// Circuit es el circuito de una llamada saliente, con la semántica de resilience4j por CONTEO (la del servidor de
// keel-spring del mismo diseño). Es la referencia ejecutable de keel-core (circuitBreakerReference) escrita en Go, y la
// prueba emitida recorre las mismas secuencias contra las dos:
//
//   - cerrado: cada llamada que sale cuenta —fallo si su fallo está entre los que cuentan, éxito si no (un 4xx es un
//     ÉXITO para el circuito)—; con al menos MinimumNumberOfCalls, una tasa >= umbral abre;
//   - abierto: rechaza sin intentar hasta WaitDuration; la primera llamada después pasa a semiabierto (el reloj solo se
//     mira cuando alguien llama);
//   - semiabierto: deja pasar HalfOpenCalls pruebas y decide con TODAS: reabre o cierra con la ventana vacía.
type Circuit struct {
	spec      CircuitSpec
	now       func() time.Time
	mu        sync.Mutex
	state     CircuitState
	window    []bool
	trial     []bool
	openedAt  time.Time
	permitted int
}

// NewCircuit construye un circuito cerrado. now es el reloj; nil, el de verdad.
func NewCircuit(spec CircuitSpec, now func() time.Time) *Circuit {
	if now == nil {
		now = time.Now
	}
	return &Circuit{spec: spec, now: now}
}

// State es el estado del circuito.
func (c *Circuit) State() CircuitState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// TryAcquire dice si puede salir una llamada. Si no, quien llama ve el circuito abierto.
func (c *Circuit) TryAcquire() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == CircuitOpen {
		if c.now().Sub(c.openedAt) < c.spec.WaitDuration {
			return false
		}
		c.state = CircuitHalfOpen
		c.permitted = 0
		c.trial = c.trial[:0]
	}
	if c.state == CircuitHalfOpen {
		if c.permitted >= c.spec.HalfOpenCalls {
			return false
		}
		c.permitted++
	}
	return true
}

// Record cuenta el desenlace de una llamada que salió: failed si su fallo cuenta para el circuito.
func (c *Circuit) Record(failed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == CircuitHalfOpen {
		c.trial = append(c.trial, failed)
		if len(c.trial) >= c.spec.HalfOpenCalls {
			if c.tripped(c.trial) {
				c.open()
			} else {
				c.state = CircuitClosed
				c.window = c.window[:0]
			}
		}
		return
	}
	if c.state != CircuitClosed {
		return
	}
	c.window = append(c.window, failed)
	if len(c.window) > c.spec.SlidingWindowSize {
		c.window = c.window[1:]
	}
	if len(c.window) >= c.spec.MinimumNumberOfCalls && c.tripped(c.window) {
		c.open()
	}
}

func (c *Circuit) tripped(outcomes []bool) bool {
	failed := 0
	for _, outcome := range outcomes {
		if outcome {
			failed++
		}
	}
	return float64(failed)*100/float64(len(outcomes)) >= c.spec.FailureRateThreshold
}

func (c *Circuit) open() {
	c.state = CircuitOpen
	c.openedAt = c.now()
	c.window = c.window[:0]
}
`;

const RESILIENCE_GO = `
// RetrySpec es el reintento de una llamada. MaxAttempts son los intentos TOTALES (los de resilience4j), no los
// reintentos. Multiplier 0 es espera fija; MaxDelay 0, sin techo.
type RetrySpec struct {
	MaxAttempts  int
	InitialDelay time.Duration
	Multiplier   float64
	MaxDelay     time.Duration
	Retries      []FailureKind
}

// Policy es la política de una llamada: la de keel-core (resiliencePolicy) ya resuelta, como literal en su adaptador.
type Policy struct {
	Instance string
	Retry    *RetrySpec
	Circuit  *CircuitSpec
}

// Wait espera d, o hasta que ctx se cancele: la espera entre reintentos. Las pruebas la sustituyen.
type Wait func(ctx context.Context, d time.Duration) error

// Sleep es la espera de verdad.
func Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Run ejecuta attempt con la política: retry por fuera y circuito por dentro, el orden de resilience4j
// (Retry(CircuitBreaker(llamada))). Cada intento pasa por el circuito, y el circuito abierto NO se reintenta: no está
// entre los fallos que reintenta ninguna política.
func Run[T any](ctx context.Context, policy Policy, circuit *Circuit, wait Wait, attempt func(context.Context) (T, error)) (T, error) {
	attempts := 1
	if policy.Retry != nil {
		attempts = policy.Retry.MaxAttempts
	}
	for n := 1; ; n++ {
		result, err := guarded(ctx, circuit, attempt)
		if err == nil || n >= attempts || !retried(policy.Retry, err) {
			return result, err
		}
		if err := wait(ctx, RetryWait(n, *policy.Retry)); err != nil {
			var zero T
			return zero, err
		}
	}
}

// retried dice si la política reintenta el fallo: solo un fallo del proveedor de su lista.
func retried(retry *RetrySpec, err error) bool {
	failure, ok := AsProviderFailure(err)
	return retry != nil && ok && slices.Contains(retry.Retries, failure.Kind)
}

// RetryWait es la espera ANTES del intento attempt + 1: la referencia retryWaitMs de keel-core.
func RetryWait(attempt int, retry RetrySpec) time.Duration {
	if retry.Multiplier == 0 {
		return retry.InitialDelay
	}
	wait := float64(retry.InitialDelay) * math.Pow(retry.Multiplier, float64(max(attempt-1, 0)))
	if retry.MaxDelay > 0 && (math.IsInf(wait, 0) || wait > float64(retry.MaxDelay)) {
		return retry.MaxDelay
	}
	if math.IsInf(wait, 0) || wait >= math.MaxInt64 {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(wait)
}

// guarded es un intento a través del circuito: si está abierto ni sale, y si sale cuenta su desenlace.
func guarded[T any](ctx context.Context, circuit *Circuit, attempt func(context.Context) (T, error)) (T, error) {
	if circuit == nil {
		return attempt(ctx)
	}
	if !circuit.TryAcquire() {
		var zero T
		return zero, circuitOpenFailure()
	}
	result, err := attempt(ctx)
	circuit.Record(counts(err))
	return result, err
}
`;

const EXCHANGE_GO = String.raw`
// Request es una petición a un proveedor: la ruta del diseño con sus variables entre llaves (/stock/{orderId}).
type Request struct {
	Method     string
	Path       string
	PathParams map[string]string
	Query      []QueryParam
	Headers    map[string]string
	// Body es el cuerpo, que escribe el contrato del cable (wire); nil si no lleva.
	Body any
}

// QueryParam es un parámetro de la consulta: una lista se repite (?sku=a&sku=b).
type QueryParam struct {
	Name   string
	Values []string
}

// Response es lo que contestó el proveedor: el status y el cuerpo JSON, o nil si no trae.
type Response struct {
	Status int
	Body   jsontext.Value
}

// Exchange hace los intentos contra los proveedores, sobre un solo http.Client para todos.
type Exchange struct {
	client *http.Client
}

// NewExchange construye el Exchange sobre transport; nil, el del servidor (DefaultTransport). Las redirecciones no se
// siguen, como el cliente del JDK por defecto: un 3xx es un status que ningún contrato declara.
func NewExchange(transport http.RoundTripper) *Exchange {
	if transport == nil {
		transport = DefaultTransport()
	}
	return &Exchange{client: &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

// DefaultTransport es el transporte del servidor: 5 s para conectar (fijos, como keel-spring) y SIN keep-alive. net/http
// reenvía por su cuenta una petición idempotente —un GET, un DELETE, o cualquiera con Idempotency-Key— cuya conexión
// REUTILIZADA se corta antes de la respuesta: un retry por debajo del del diseño, que repetiría una escritura que el
// diseño no reintenta. Con una conexión por petición no hay conexión reutilizada que reintentar; el precio es no
// reutilizar conexiones entre llamadas.
func DefaultTransport() *http.Transport {
	return &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		DisableKeepAlives:   true,
	}
}

// Send hace UN intento contra el proveedor y clasifica su desenlace con la tabla de keel-core: sin respuesta (conexión,
// plazo, DNS) es KindTransport; un status que no es 2xx, el suyo; un cuerpo que no es JSON, un *ContractError. El plazo
// (client.Timeout) cubre el intento ENTERO, lectura del cuerpo incluida. La cancelación de quien llama NO es un plazo
// vencido del proveedor: se devuelve tal cual.
func (e *Exchange) Send(ctx context.Context, client ClientSettings, request Request) (Response, error) {
	target, err := Target(client.BaseURL, request)
	if err != nil {
		return Response{}, err
	}
	where := client.ID + ": " + request.Method + " " + request.Path
	var body io.Reader
	if request.Body != nil {
		encoded, err := wire.Marshal(request.Body)
		if err != nil {
			return Response{}, contractErrorf(err, "%s: el cuerpo no se puede escribir", where)
		}
		body = bytes.NewReader(encoded)
	}
	attemptCtx, cancel := context.WithTimeout(ctx, client.Timeout)
	defer cancel()
	outgoing, err := http.NewRequestWithContext(attemptCtx, request.Method, target.String(), body)
	if err != nil {
		return Response{}, contractErrorf(err, "%s: la petición no se puede armar", where)
	}
	outgoing.Header.Set("Accept", "application/json")
	if body != nil {
		outgoing.Header.Set("Content-Type", "application/json")
	}
	for name, value := range client.Headers {
		outgoing.Header.Set(name, value)
	}
	for name, value := range request.Headers {
		outgoing.Header.Set(name, value)
	}
	response, err := e.client.Do(outgoing)
	if err != nil {
		return Response{}, unanswered(ctx, client, where, err)
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return Response{}, unanswered(ctx, client, where, err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return Response{}, statusFailure(response.StatusCode, string(text))
	}
	if len(bytes.TrimSpace(text)) == 0 {
		return Response{Status: response.StatusCode}, nil
	}
	value := jsontext.Value(text)
	if !value.IsValid() {
		return Response{}, contractErrorf(nil, "%s respondió %d con un cuerpo que no es JSON", where, response.StatusCode)
	}
	return Response{Status: response.StatusCode, Body: value}, nil
}

// unanswered clasifica una petición sin respuesta: si quien llama canceló, su cancelación; si no, un fallo de transporte.
func unanswered(ctx context.Context, client ClientSettings, where string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return transportFailure(fmt.Sprintf("%s sin respuesta en %d ms", where, client.Timeout.Milliseconds()), err)
	}
	return transportFailure(fmt.Sprintf("%s sin respuesta (%v)", where, err), err)
}

// placeholder es una variable de la ruta del diseño: {orderId}.
var placeholder = regexp.MustCompile("\\{([^}]+)\\}")

// Target es la URL de la petición: la base, la ruta con sus variables sustituidas y codificadas, y la consulta en el
// orden del diseño. Una variable sin valor es un error nuestro: no se manda una ruta incompleta.
func Target(base *url.URL, request Request) (*url.URL, error) {
	var missing error
	path := placeholder.ReplaceAllStringFunc(request.Path, func(match string) string {
		name := match[1 : len(match)-1]
		value, ok := request.PathParams[name]
		if !ok {
			missing = contractErrorf(nil, "la ruta %s necesita %s", request.Path, name)
			return match
		}
		return url.PathEscape(value)
	})
	if missing != nil {
		return nil, missing
	}
	var query []string
	for _, param := range request.Query {
		for _, value := range param.Values {
			query = append(query, escapeQuery(param.Name)+"="+escapeQuery(value))
		}
	}
	raw := strings.TrimSuffix(base.String(), "/") + path
	if len(query) > 0 {
		raw += "?" + strings.Join(query, "&")
	}
	return url.Parse(raw)
}

// escapeQuery codifica un texto de la consulta con %20 para el espacio, como la ruta.
func escapeQuery(text string) string {
	return strings.ReplaceAll(url.QueryEscape(text), "+", "%20")
}
`;

const READING_GO = `
// La lectura de una respuesta del proveedor con el contrato del cable (wire). Un campo que el contrato declara obligatorio
// y no llega, o que llega con otro tipo, es un *ContractError.

// object es el cuerpo como objeto JSON, campo a campo. Sin las opciones del cable: su lector de jsontext.Value convierte
// también una cadena, y aquí cada miembro tiene que llegar tal cual; con nombres repetidos gana el último, como Jackson.
func object(body jsontext.Value, where string) (map[string]jsontext.Value, error) {
	var fields map[string]jsontext.Value
	if body.Kind() != '{' || json.Unmarshal(body, &fields, jsontext.AllowDuplicateNames(true)) != nil {
		return nil, contractErrorf(nil, "%s: la respuesta no es un objeto JSON", where)
	}
	return fields, nil
}

// required lee un campo que el contrato declara obligatorio: presente y de su tipo.
func required[T any](fields map[string]jsontext.Value, name, where, expected, missing string, out *T) error {
	value, ok := present(fields, name)
	if !ok {
		return contractErrorf(nil, "%s", missing)
	}
	return convert(value, where, expected, out)
}

// optional lee un campo opcional: su ausencia, o un null, deja out en nil.
func optional[T any](fields map[string]jsontext.Value, name, where, expected string, out **T) error {
	value, ok := present(fields, name)
	if !ok {
		return nil
	}
	var read T
	if err := convert(value, where, expected, &read); err != nil {
		return err
	}
	*out = &read
	return nil
}

// list lee una lista: ausente o null es una lista vacía (list-never-null).
func list[T any](fields map[string]jsontext.Value, name, where, expected string, out *[]T) error {
	*out = []T{}
	value, ok := present(fields, name)
	if !ok {
		return nil
	}
	if value.Kind() != '[' {
		return contractErrorf(nil, "%s: se esperaba %s", where, expected)
	}
	return convert(value, where, expected, out)
}

func present(fields map[string]jsontext.Value, name string) (jsontext.Value, bool) {
	value, ok := fields[name]
	if !ok || value.Kind() == 'n' {
		return nil, false
	}
	return value, true
}

// convert lee un valor con el contrato del cable. Lo que el lector o el constructor de un tipo rechazan viola el
// contrato del PROVEEDOR: no es una petición malformada nuestra.
func convert[T any](value jsontext.Value, where, expected string, out *T) error {
	if err := wire.Unmarshal(value, out); err != nil {
		return contractErrorf(err, "%s: se esperaba %s", where, expected)
	}
	return nil
}
`;

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

/** Los circuitos distintos del diseño (por sus números), y los reintentos distintos. */
function distinctPolicies(model, key) {
  const specs = new Map();
  for (const client of model.httpClients) {
    for (const call of client.calls) {
      const spec = resiliencePolicy(call)[key];
      if (spec) specs.set(JSON.stringify(spec), spec);
    }
  }
  return [...specs.values()];
}

/** Un valor de muestra para un parámetro de una llamada (Go), o null si su tipo no tiene uno sencillo. */
function sampleValue(model, field) {
  if (field.list || optionalParam(field)) return 'nil';
  if (field.kind === 'enum') {
    const enumeration = model.enums?.find((e) => goTypeName(e.name) === field.goType || e.name === field.goType);
    const first = enumeration?.values?.[0]?.literal;
    return first != null ? `domain.${field.goType}(${goString(first)})` : null;
  }
  return (
    {
      string: '"x"',
      text: '"x"',
      file: '"x"',
      int: '1',
      long: '1',
      decimal: 'wire.MustDecimal("1.50")',
      boolean: 'true',
      uuid: 'uuid.New()',
      date: 'wire.MustDate("2026-01-01")',
      timestamp: 'time.Unix(0, 0).UTC()'
    }[field.base] ?? null
  );
}

/** Las llamadas que la prueba emitida ejecuta contra un proveedor falso: con resiliencia y argumentos de muestra. */
function probedCalls(model) {
  return model.httpClients.flatMap((client) =>
    client.calls
      .filter((call) => resilient(call))
      .map((call) => ({ client, call, args: callFields(call).map((field) => sampleValue(model, field)) }))
      .filter(({ args }) => args.every((arg) => arg != null))
  );
}

function emittedTests(model) {
  const { clients } = layout(model);
  const circuits = distinctPolicies(model, 'circuitBreaker').map((cb, index) => `\t\t{${circuitSpec(cb)}, ${goString(circuitScript(cb, 7 + index))}},`);
  const retries = [
    ...new Set(
      distinctPolicies(model, 'retry').flatMap((retry) =>
        Array.from({ length: retry.maxAttempts }, (_, index) => index + 1).map(
          (attempt) =>
            `\t\t{RetrySpec{InitialDelay: ${retry.initialDelayMs} * time.Millisecond${retry.multiplier != null ? `, Multiplier: ${retry.multiplier}` : ''}${retry.maxDelayMs != null ? `, MaxDelay: ${retry.maxDelayMs} * time.Millisecond` : ''}}, ${attempt}, ${retryWaitMs(attempt, retry)}},`
        )
      )
    )
  ];
  const probed = probedCalls(model);
  const builders = [...new Set(probed.map(({ client }) => client))].map((client) => adapterBuilder(client));
  const probes = probed.map(({ client, call, args }) => adapterProbe(client, call, args));
  const firstClient = model.httpClients[0];
  const circuitTest = circuits.length > 0
    ? `

// El circuito de Go recorre la MISMA secuencia que la referencia de keel-core (circuitBreakerReference), paso a paso: lo
// que contesta cada petición de paso y el estado tras cada paso. La secuencia la generó build con la referencia.
func TestElCircuitoDiceLoMismoQueLaReferencia(t *testing.T) {
	states := map[string]CircuitState{"C": CircuitClosed, "O": CircuitOpen, "H": CircuitHalfOpen}
	tests := []struct {
		spec   CircuitSpec
		script string
	}{
${circuits.join('\n')}
	}
	for i, tt := range tests {
		clock := time.Unix(0, 0)
		circuit := NewCircuit(tt.spec, func() time.Time { return clock })
		for n, step := range strings.Fields(tt.script) {
			action, state, _ := strings.Cut(step, ":")
			switch action[0] {
			case 't':
				ms, err := strconv.Atoi(action[1:])
				if err != nil {
					t.Fatalf("paso %d (%s): %v", n+1, step, err)
				}
				clock = clock.Add(time.Duration(ms) * time.Millisecond)
			case 'a':
				if got := circuit.TryAcquire(); got != (action[1] == '1') {
					t.Fatalf("circuito %d, paso %d (%s): TryAcquire = %v, no lo que dice la referencia", i, n+1, step, got)
				}
			default:
				circuit.Record(action[0] == 'f')
			}
			if got := circuit.State(); got != states[state] {
				t.Fatalf("circuito %d, paso %d (%s): estado %d, quiero %d", i, n+1, step, got, states[state])
			}
		}
	}
}`
    : '';
  const retryTest = retries.length > 0
    ? `

// La espera antes de cada reintento, contra la referencia retryWaitMs de keel-core.
func TestLaEsperaEsLaDeLaReferencia(t *testing.T) {
	tests := []struct {
		retry   RetrySpec
		attempt int
		wantMs  int64
	}{
${retries.join('\n')}
	}
	for _, tt := range tests {
		if got := RetryWait(tt.attempt, tt.retry); got != time.Duration(tt.wantMs)*time.Millisecond {
			t.Errorf("RetryWait(%d, %+v) = %v, quiero %d ms", tt.attempt, tt.retry, got, tt.wantMs)
		}
	}
}`
    : '';
  const settingsTest = `

func TestSettingsFromLeeCadaCliente(t *testing.T) {
	settings, err := SettingsFrom(load(t, ${goString(httpClientsYaml(model, 'local'))}))
	if err != nil {
		t.Fatalf("SettingsFrom = %v, quiero la configuración de local leída", err)
	}
${model.httpClients
  .map(
    (client) => `	if got := settings[${goString(client.id)}]; got.BaseURL.String() != ${goString(LOCAL_STUB_BASE_URL)} || got.Timeout != ${client.readTimeoutMs}*time.Millisecond {
		t.Errorf("${client.id} = %s y %v, quiero ${LOCAL_STUB_BASE_URL} y ${client.readTimeoutMs} ms", got.BaseURL, got.Timeout)
	}`
  )
  .join('\n')}
}

func TestSettingsFromNoArrancaSinLaURL(t *testing.T) {
	_, err := SettingsFrom(load(t, ${goString(`http-clients:\n  ${firstClient.id}:\n    other: 1\n`)}))
	if err == nil || !strings.Contains(err.Error(), ${goString(`http-clients.${firstClient.id}.base-url`)}) {
		t.Errorf("SettingsFrom = %v, quiero el error de la URL que falta", err)
	}
}`;
  const body = String.raw`
// Los clientes salientes EJECUTADOS sin red: el circuito y la espera contra las referencias de keel-core, la
// clasificación de cada desenlace del proveedor, la lectura del contrato y el adaptador de cada llamada resiliente contra
// un proveedor falso. Lo que dice un proveedor DE VERDAD (WireMock) lo mide la red del generador.

// fakeProvider es un proveedor falso: contesta lo que diga answer y guarda cada petición.
type fakeProvider struct {
	mu       sync.Mutex
	requests []*http.Request
	answer   func(*http.Request) (*http.Response, error)
}

func (p *fakeProvider) RoundTrip(request *http.Request) (*http.Response, error) {
	p.mu.Lock()
	p.requests = append(p.requests, request)
	p.mu.Unlock()
	return p.answer(request)
}

// sent son las peticiones que le llegaron.
func (p *fakeProvider) sent() []*http.Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.requests)
}

func answering(status int, body string) *fakeProvider {
	return &fakeProvider{answer: func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	}}
}

func unreachable() *fakeProvider {
	return &fakeProvider{answer: func(*http.Request) (*http.Response, error) {
		return nil, errors.New("conexión rechazada")
	}}
}

// testClient es un proveedor con un plazo corto y una cabecera de autenticación.
func testClient(id string) ClientSettings {
	base := &url.URL{Scheme: "http", Host: "proveedor.test", Path: "/base/"}
	return ClientSettings{ID: id, BaseURL: base, Timeout: 300 * time.Millisecond, Headers: map[string]string{"X-Api-Key": "k"}}
}

func send(ctx context.Context, provider *fakeProvider, request Request) (Response, error) {
	return NewExchange(provider).Send(ctx, testClient("proveedor"), request)
}

func stockRequest() Request {
	return Request{Method: "GET", Path: "/stock/{sku}", PathParams: map[string]string{"sku": "a b/1"}}
}

// load es la configuración con application.yaml y un fragmento del perfil por defecto con fragment dentro.
func load(t *testing.T, fragment string) *config.Config {
	t.Helper()
	fsys := fstest.MapFS{
		"application.yaml":                   {Data: []byte("server:\n  port: 8080\n")},
		"parameters/local/http-clients.yaml": {Data: []byte(fragment)},
	}
	cfg, err := config.Load(fsys, func(string) string { return "" })
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func TestUnaRespuestaJSONSeLeeYLaRutaVaCodificada(t *testing.T) {
	provider := answering(200, "{\"ok\":true}")
	response, err := send(t.Context(), provider, stockRequest())
	if err != nil || response.Status != 200 || string(response.Body) != "{\"ok\":true}" {
		t.Fatalf("Send = %d %s, %v; quiero 200 {\"ok\":true}", response.Status, response.Body, err)
	}
	sent := provider.sent()
	if len(sent) != 1 {
		t.Fatalf("%d peticiones, quiero 1", len(sent))
	}
	if got := sent[0].URL.String(); got != "http://proveedor.test/base/stock/a%20b%2F1" {
		t.Errorf("URL = %s, quiero la ruta con su variable codificada", got)
	}
	if sent[0].Header.Get("X-Api-Key") != "k" || sent[0].Header.Get("Accept") != "application/json" {
		t.Errorf("cabeceras = %v, quiero la autenticación y Accept: application/json", sent[0].Header)
	}
}

func TestSinCuerpoNoEsUnFallo(t *testing.T) {
	response, err := send(t.Context(), answering(204, ""), stockRequest())
	if err != nil || response.Body != nil {
		t.Fatalf("Send = %s, %v; quiero un 204 sin cuerpo y sin error", response.Body, err)
	}
}

func TestCadaStatusQueNoEs2xxEsSuFallo(t *testing.T) {
	for status, kind := range map[int]FailureKind{503: KindServerError, 500: KindServerError, 404: KindClientError, 409: KindClientError, 302: KindUnknownStatus, 600: KindUnknownStatus} {
		_, err := send(t.Context(), answering(status, "detalle"), stockRequest())
		failure, ok := AsProviderFailure(err)
		if !ok || failure.Kind != kind || failure.Status != status || failure.Body != "detalle" {
			t.Errorf("%d: %v, quiero %s con su status y su cuerpo", status, err, kind)
		}
	}
}

func TestSinConexionEsTransporte(t *testing.T) {
	_, err := send(t.Context(), unreachable(), stockRequest())
	if failure, ok := AsProviderFailure(err); !ok || failure.Kind != KindTransport {
		t.Fatalf("Send = %v, quiero un fallo de transporte", err)
	}
}

func TestUnProveedorQueNoContestaATiempoEsTransporte(t *testing.T) {
	silent := &fakeProvider{answer: func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	}}
	_, err := send(t.Context(), silent, stockRequest())
	failure, ok := AsProviderFailure(err)
	if !ok || failure.Kind != KindTransport || !strings.Contains(err.Error(), "sin respuesta en 300 ms") {
		t.Fatalf("Send = %v, quiero un fallo de transporte por el plazo", err)
	}
}

func TestLaCancelacionDeQuienLlamaNoEsUnTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	silent := &fakeProvider{answer: func(request *http.Request) (*http.Response, error) {
		cancel()
		<-request.Context().Done()
		return nil, request.Context().Err()
	}}
	_, err := send(ctx, silent, stockRequest())
	if _, ok := AsProviderFailure(err); ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("Send = %v, quiero la cancelación de quien llama, no un fallo del proveedor", err)
	}
}

func TestUnCuerpoQueNoEsJSONViolaElContratoYNoEsUnFalloDelProveedor(t *testing.T) {
	_, err := send(t.Context(), answering(200, "<html>"), stockRequest())
	var contract *ContractError
	if !errors.As(err, &contract) || !strings.Contains(err.Error(), "no es JSON") {
		t.Fatalf("Send = %v, quiero un *ContractError", err)
	}
	if _, ok := AsProviderFailure(err); ok {
		t.Fatalf("un contrato roto no es un fallo del proveedor: %v", err)
	}
}

func TestUnaRutaSinSuVariableNoSeManda(t *testing.T) {
	provider := answering(200, "{}")
	_, err := send(t.Context(), provider, Request{Method: "GET", Path: "/stock/{sku}"})
	var contract *ContractError
	if !errors.As(err, &contract) || len(provider.sent()) != 0 {
		t.Fatalf("Send = %v con %d peticiones, quiero un *ContractError sin salir", err, len(provider.sent()))
	}
}

func TestLaConsultaRepiteLasListasEnSuOrden(t *testing.T) {
	target, err := Target(testClient("p").BaseURL, Request{Method: "GET", Path: "/stock", Query: []QueryParam{{Name: "sku", Values: []string{"a", "b c"}}, {Name: "page", Values: []string{"2"}}}})
	if err != nil || target.String() != "http://proveedor.test/base/stock?sku=a&sku=b%20c&page=2" {
		t.Fatalf("Target = %v, %v", target, err)
	}
}

func TestLaLecturaDelContratoDistingueAusenteDeMalTipado(t *testing.T) {
	fields, err := object(jsontext.Value("{\"name\":\"x\",\"count\":\"no\",\"tags\":null}"), "p.c")
	if err != nil {
		t.Fatalf("object = %v", err)
	}
	var name string
	if err := required(fields, "name", "p.c.name", "un texto", "falta", &name); err != nil || name != "x" {
		t.Errorf("required(name) = %q, %v", name, err)
	}
	var absent *int32
	if err := optional(fields, "absent", "p.c.absent", "un entero", &absent); err != nil || absent != nil {
		t.Errorf("optional(absent) = %v, %v; quiero nil", absent, err)
	}
	var tags []string
	if err := list(fields, "tags", "p.c.tags", "una lista de texto", &tags); err != nil || tags == nil || len(tags) != 0 {
		t.Errorf("list(tags) = %#v, %v; quiero una lista vacía", tags, err)
	}
	if err := required(fields, "absent", "p.c.absent", "un texto", "falta", &name); err == nil || err.Error() != "falta" {
		t.Errorf("required(absent) = %v, quiero «falta»", err)
	}
	var count *bool
	if err := optional(fields, "count", "p.c.count", "un booleano", &count); err == nil || err.Error() != "p.c.count: se esperaba un booleano" {
		t.Errorf("optional(count) = %v, quiero el contrato roto", err)
	}
	if _, err := object(jsontext.Value("[]"), "p.c"); err == nil {
		t.Error("una lista no es un objeto JSON")
	}
}

func TestElRetryReintentaSoloLoQueSuPoliticaDiceYNuncaElCircuitoAbierto(t *testing.T) {
	policy := Policy{Instance: "p", Retry: &RetrySpec{MaxAttempts: 3, InitialDelay: 10 * time.Millisecond, Multiplier: 2, Retries: []FailureKind{KindTransport}}}
	var waits []time.Duration
	wait := func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	attempts := 0
	_, err := Run(t.Context(), policy, nil, wait, func(context.Context) (int, error) {
		attempts++
		return 0, transportFailure("x", nil)
	})
	if failure, ok := AsProviderFailure(err); !ok || failure.Kind != KindTransport || attempts != 3 {
		t.Fatalf("transporte: %v tras %d intentos, quiero 3", err, attempts)
	}
	if !slices.Equal(waits, []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}) {
		t.Errorf("esperas %v, quiero 10ms y 20ms", waits)
	}

	attempts = 0
	_, err = Run(t.Context(), policy, nil, wait, func(context.Context) (int, error) {
		attempts++
		return 0, statusFailure(503, "")
	})
	if failure, ok := AsProviderFailure(err); !ok || failure.Kind != KindServerError || attempts != 1 {
		t.Fatalf("5xx que la política no reintenta: %v tras %d intentos, quiero 1", err, attempts)
	}

	open := NewCircuit(CircuitSpec{FailureRateThreshold: 50, SlidingWindowSize: 2, MinimumNumberOfCalls: 2, WaitDuration: time.Minute, HalfOpenCalls: 1}, nil)
	open.Record(true)
	open.Record(true)
	attempts = 0
	_, err = Run(t.Context(), policy, open, wait, func(context.Context) (int, error) {
		attempts++
		return 1, nil
	})
	if failure, ok := AsProviderFailure(err); !ok || failure.Kind != KindCircuitOpen || attempts != 0 {
		t.Fatalf("circuito abierto: %v tras %d intentos, quiero ninguno", err, attempts)
	}
}

func TestParaElCircuitoUn4xxEsUnExitoYUnContratoRotoNoCuenta(t *testing.T) {
	circuit := NewCircuit(CircuitSpec{FailureRateThreshold: 50, SlidingWindowSize: 4, MinimumNumberOfCalls: 4, WaitDuration: time.Minute, HalfOpenCalls: 1}, nil)
	call := func(err error) {
		_, _ = Run(t.Context(), Policy{Instance: "p"}, circuit, Sleep, func(context.Context) (int, error) {
			return 0, err
		})
	}
	for range 4 {
		call(statusFailure(404, ""))
	}
	if circuit.State() != CircuitClosed {
		t.Fatal("cuatro 404 abrieron el circuito: un rechazo no es una caída")
	}
	for range 4 {
		call(contractErrorf(nil, "roto"))
	}
	if circuit.State() != CircuitClosed {
		t.Fatal("cuatro contratos rotos abrieron el circuito: no son una caída del proveedor")
	}
	for range 2 {
		call(statusFailure(503, ""))
	}
	if circuit.State() != CircuitOpen {
		t.Fatal("dos 503 en una ventana de cuatro no abrieron el circuito")
	}
}`;
  const imports = [
    'context', 'errors', 'io', 'log/slog', 'net/http', 'net/url', 'slices', 'strconv', 'strings', 'sync', 'testing', 'testing/fstest', 'time',
    'encoding/json/jsontext', 'github.com/google/uuid', 'internal/domain', 'internal/platform/config', 'internal/platform/wire'
  ];
  return {
    path: `${clients.dir}/clients_test.go`,
    content: packageFile(model, clients, { imports, body: `${body}${settingsTest}${circuitTest}${retryTest}${builders.join('')}${probes.join('')}\n` })
  };
}

/** El adaptador de un cliente sobre el proveedor falso, sin esperas entre reintentos. */
function adapterBuilder(client) {
  const name = `${goUnexported(client.id)}Over`;
  return `

// ${name} construye el adaptador de ${client.id} sobre el proveedor falso, sin esperas entre reintentos.
func ${name}(t *testing.T, provider *fakeProvider) *${adapterType(client)} {
	t.Helper()
	adapter, err := New${adapterType(client)}(Settings{${goString(client.id)}: testClient(${goString(client.id)})}, NewExchange(provider), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	adapter.wait = func(context.Context, time.Duration) error { return nil }
	return adapter
}`;
}

/**
 * La llamada resiliente EJECUTADA contra un proveedor falso: con el proveedor inalcanzable, cuántos intentos salen (los de
 * su política si reintenta el transporte, uno si no) y, con clave de idempotencia, que es la MISMA en todos; con un cuerpo
 * que no es JSON, que el contrato roto se devuelve y no es una caída; y con el proveedor en 5xx, que el circuito se abre y
 * la llamada siguiente ni sale.
 */
function adapterProbe(client, call, args) {
  const policy = resiliencePolicy(call);
  const transportAttempts = policy.retry && policy.retry.retries.includes('transport') ? policy.retry.maxAttempts : 1;
  const name = `Test${adapterType(client)}${callMethod(call)}`;
  const build = `${goUnexported(client.id)}Over(t, provider)`;
  const invoke = `adapter.${callMethod(call)}(${['t.Context()', ...args].join(', ')})`;
  const swallow = call.bodiless ? `_ = ${invoke}` : `_, _ = ${invoke}`;
  const capture = call.bodiless ? `err := ${invoke}` : `_, err := ${invoke}`;
  const key = call.idempotency
    ? `
	keys := map[string]bool{}
	for _, request := range provider.sent() {
		keys[request.Header.Get(${goString(call.idempotency.header)})] = true
	}
	if len(keys) != 1 || keys[""] {
		t.Errorf("claves de idempotencia %v, quiero la MISMA en cada intento", keys)
	}`
    : '';
  const circuit = policy.circuitBreaker
    ? `

// ${client.id}.${call.name}: con el proveedor en 5xx el circuito se abre, y la llamada siguiente ni sale.
func ${name}AbreElCircuitoYLaSiguienteNiSale(t *testing.T) {
	provider := answering(503, "")
	adapter := ${build}
	for len(provider.sent()) < ${policy.circuitBreaker.minimumNumberOfCalls} {
		${swallow}
	}
	before := len(provider.sent())
	${swallow}
	if after := len(provider.sent()); after != before {
		t.Fatalf("con el circuito abierto salieron %d peticiones más", after-before)
	}
}`
    : '';
  return `

// ${client.id}.${call.name}: con el proveedor inalcanzable salen ${transportAttempts} intento(s)${call.idempotency ? ', todos con la MISMA clave' : ''}.
func ${name}ReintentaElTransporteComoDiceSuPolitica(t *testing.T) {
	provider := unreachable()
	adapter := ${build}
	${swallow}
	if got := len(provider.sent()); got != ${transportAttempts} {
		t.Fatalf("%d intentos, quiero ${transportAttempts}", got)
	}${key}
}

// ${client.id}.${call.name}: un cuerpo que no es JSON viola el contrato y se DEVUELVE; no es «el proveedor no está».
func ${name}NoDisfrazaUnContratoRotoDeCaida(t *testing.T) {
	provider := answering(200, "<html>")
	adapter := ${build}
	${capture}
	var contract *ContractError
	if !errors.As(err, &contract) || len(provider.sent()) != 1 {
		t.Fatalf("%v con %d peticiones, quiero el *ContractError de un solo intento", err, len(provider.sent()))
	}
}${circuit}`;
}
