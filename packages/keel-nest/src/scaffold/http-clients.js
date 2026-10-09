// Integraciones HTTP salientes (capa `http-clients`, incremento 11b), con el mismo reparto hexagonal que
// keel-spring: el PUERTO `<Cliente>Client` y los resultados `<Llamada>Result` viven en `domain/clients`
// (en términos del dominio); el adaptador, los DTOs wire (el contrato del tercero tal cual) y el mapper de
// anticorrupción viven en `infrastructure/clients`. Si el tercero cambia su contrato, cambian los DTOs, el
// mapper y el adaptador — nunca el dominio ni los casos de uso.
//
// QUÉ reintenta el retry, qué cuenta el circuito, qué atiende el fallback y con qué números lo decide
// keel-core (`gen/outbound-resilience.js`), igual que para el servidor de keel-spring del mismo diseño. El
// circuito NO es el de una librería: es la máquina de estados de resilience4j, escrita aquí y comparada con
// la referencia ejecutable de keel-core (`circuitBreakerReference`), porque el `CountBreaker` de cockatiel
// no dice lo mismo (PLAN-KEEL-NEST.md, 11b).
//
// `src/infrastructure/http/` es la plataforma de ENTRADA (Fastify): lo saliente va a `infrastructure/clients`.

import { fallbackFailures, resiliencePolicy, RESILIENCE_DEFAULTS } from 'keel-core/gen/outbound-resilience';
import { DIRS, classPath, declType, fieldImports, fileName, tsModule, tsString, tsdoc } from './render.js';
import { DECIMAL_TS, RAW_JSON_TS, WIRE_TS } from './wire.js';
import { COMMAND_SIGNATURE_TS } from './request-idempotency.js';
import { CORRELATION_TS, usesCorrelation } from './rest-support.js';

const CLIENTS_DIR = 'infrastructure/clients';
export const PROVIDER_FAILURES_TS = `src/${CLIENTS_DIR}/provider-failures.ts`;
export const CIRCUIT_BREAKER_TS = `src/${CLIENTS_DIR}/circuit-breaker.ts`;
export const OUTBOUND_RESILIENCE_TS = `src/${CLIENTS_DIR}/outbound-resilience.ts`;
export const HTTP_EXCHANGE_TS = `src/${CLIENTS_DIR}/http-exchange.ts`;
export const RESPONSE_READING_TS = `src/${CLIENTS_DIR}/response-reading.ts`;
export const OUTBOUND_IDEMPOTENCY_TS = `src/${CLIENTS_DIR}/outbound-idempotency.ts`;
export const HTTP_CLIENTS_SETTINGS_TS = `src/${CLIENTS_DIR}/http-clients-settings.ts`;
export const HTTP_CLIENTS_MODULE_TS = `src/${CLIENTS_DIR}/http-clients-module.ts`;
export const LAST_KNOWN_TS = `src/${CLIENTS_DIR}/last-known-values.ts`;
export const OAUTH2_TS = `src/${CLIENTS_DIR}/oauth2-client-credentials.ts`;

/** ¿Algún cliente se autentica con `oauth2-client-credentials`? */
export function usesOAuth2(model) {
  return (model.httpClients ?? []).some((client) => client.auth?.type === 'oauth2-client-credentials');
}

/** Los needs que declaran `onUnavailable: lastKnown`, con la llamada por la que se resuelven (los de keel-spring). */
export function lastKnownNeeds(model) {
  return (model.dependencies ?? []).flatMap((dependency) =>
    (dependency.needs ?? []).filter((need) => need.onUnavailable?.action === 'lastKnown' && need.fetch).map((need) => ({ dependency: dependency.id, need }))
  );
}

/** ¿Alguna llamada de este cliente sirve un need con `lastKnown`? */
function clientRemembers(model, client) {
  return lastKnownNeeds(model).some(({ need }) => need.fetch.clientId === client.id);
}

/** ¿Esta llamada resuelve un need con `lastKnown`? */
function rememberedCall(model, client, call) {
  return lastKnownNeeds(model).some(({ need }) => need.fetch.clientId === client.id && need.fetch.call === call.name);
}

/**
 * La clave del último valor conocido: los MISMOS parámetros de la llamada. Es lo que hace que el fallback sirva el
 * último precio DE ESE sku y no el del último que se consultara.
 */
function lastKnownKey(call) {
  const args = callArgs(call);
  if (args.length === 0) return "'-'";
  if (args.length === 1) return args[0];
  return `[${args.join(', ')}]`;
}
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** La URL del proveedor de prueba en `local`: el WireMock de infra/ (el mismo puerto que keel-spring). */
export const LOCAL_STUB_BASE_URL = 'http://localhost:8090';
/** En `test` nadie llama al proveedor: una dirección que no responde, como en keel-spring. */
const TEST_BASE_URL = 'http://localhost:9';

export function usesHttpClients(model) {
  return Boolean(model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0);
}

/** Las llamadas que mandan clave de idempotencia al proveedor. */
export function outboundIdempotentCalls(model) {
  return (model.httpClients ?? []).flatMap((client) => client.calls.filter((call) => call.idempotency).map((call) => ({ client, call })));
}

export const portPath = (client) => classPath(DIRS.clients, client.clientClass);
const resultPath = (call) => classPath(DIRS.clients, call.resultType);
const infraPath = (className) => `src/${CLIENTS_DIR}/${fileName(className)}.ts`;

export function generate(model) {
  if (!usesHttpClients(model)) return [];
  const files = [
    { path: PROVIDER_FAILURES_TS, content: providerFailuresTs() },
    { path: CIRCUIT_BREAKER_TS, content: circuitBreakerTs() },
    { path: OUTBOUND_RESILIENCE_TS, content: outboundResilienceTs() },
    { path: HTTP_EXCHANGE_TS, content: httpExchangeTs() },
    { path: RESPONSE_READING_TS, content: responseReadingTs() },
    { path: HTTP_CLIENTS_SETTINGS_TS, content: settingsTs(model) },
    { path: HTTP_CLIENTS_MODULE_TS, content: moduleTs(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/http-clients.yaml`, content: httpClientsYaml(model, profile) }))
  ];
  if (outboundIdempotentCalls(model).length > 0) files.push({ path: OUTBOUND_IDEMPOTENCY_TS, content: outboundIdempotencyTs(model) });
  if (lastKnownNeeds(model).length > 0) files.push({ path: LAST_KNOWN_TS, content: lastKnownTs() });
  if (usesOAuth2(model)) files.push({ path: OAUTH2_TS, content: oauth2Ts() });
  for (const client of model.httpClients) {
    files.push({ path: portPath(client), content: portTs(model, client) });
    files.push({ path: infraPath(client.mapperClass), content: mapperTs(model, client) });
    files.push({ path: infraPath(client.adapterClass), content: adapterTs(model, client) });
    for (const call of client.calls) {
      if (!call.bodiless) {
        files.push({ path: resultPath(call), content: resultTs(model, client, call) });
        files.push({ path: infraPath(call.responseType), content: responseTs(model, client, call) });
      }
      if (call.requestType) files.push({ path: infraPath(call.requestType), content: requestTs(model, client, call) });
    }
  }
  return files;
}

// ─── Campos ──────────────────────────────────────────────────────────────────

/** Los parámetros de una llamada, en el orden del puerto: ruta, query, cabeceras y cuerpo. */
function callFields(call) {
  return [...call.pathParams, ...call.queryParams, ...call.headerParams, ...call.bodyFields];
}

const isComposite = (field) => field.kind === 'composite';
const elementType = (field) => field.elementTsType ?? String(field.tsType).replace(/\[\]$/, '');

/** Un parámetro del puerto: lo que el diseño declara, con nulo si no es obligatorio. */
function paramDecl(field) {
  return `${field.name}: ${declType(field)}`;
}

function callParams(call) {
  const params = callFields(call).map(paramDecl);
  // Contrato solo en prosa: el cuerpo sin tipar, como el `Object body` de keel-spring.
  if (call.hasBody && !call.requestType) params.push('body: unknown');
  return params;
}

function callArgs(call) {
  const args = callFields(call).map((field) => field.name);
  if (call.hasBody && !call.requestType) args.push('body');
  return args;
}

function importsOf(model, fields) {
  return fields.flatMap((field) => fieldImports(model, field));
}

/** Un campo de un resultado del dominio: siempre admite su ausencia (el resultado neutro de un fallback). */
function resultDecl(field) {
  return field.list ? `readonly ${elementType(field)}[]` : `${field.tsType} | null`;
}

// ─── Puerto y resultados (domain/clients) ────────────────────────────────────

function portTs(model, client) {
  const file = portPath(client);
  const imports = importsOf(model, client.calls.flatMap(callFields));
  for (const call of client.calls) if (!call.bodiless) imports.push({ symbol: call.resultType, from: resultPath(call) });
  const methods = client.calls.map(
    (call) => `${tsdoc(call.contract, '  ')}  abstract ${call.name}(${callParams(call).join(', ')}): Promise<${call.bodiless ? 'void' : call.resultType}>;`
  );
  const body = `${tsdoc([client.purpose, `Puerto de salida del dominio; el adaptador HTTP (${client.adapterClass}) vive en infrastructure/clients.`])}export abstract class ${client.clientClass} {
${methods.join('\n\n')}
}`;
  return tsModule(file, imports, body);
}

function resultTs(model, client, call) {
  const file = resultPath(call);
  const todo = call.responseFields.length === 0 ? [`TODO (agente): declara los campos según el contract "${call.contract}".`] : [];
  const members = call.responseFields.map((field) => `    readonly ${field.name}: ${resultDecl(field)}`);
  const ctor = members.length > 0 ? `\n  constructor(\n${members.join(',\n')}\n  ) {}\n` : '';
  const body = `${tsdoc([`Resultado de ${client.id}.${call.name} en términos del dominio.`, ...todo])}export class ${call.resultType} {${ctor}}`;
  return tsModule(file, importsOf(model, call.responseFields), body);
}

// ─── DTOs wire (infrastructure/clients) ──────────────────────────────────────

/** El lector de un campo de la respuesta, sobre los conversores del contrato del cable. */
function readerOf(field) {
  let element;
  if (field.kind === 'enum') element = `responseField.enumOf(${elementType(field)})`;
  else if (isComposite(field)) element = 'responseField.unread';
  else {
    const base = { string: 'string', text: 'string', file: 'string', uuid: 'uuid', int: 'int', long: 'long', decimal: 'decimal', boolean: 'boolean', date: 'date', timestamp: 'timestamp', json: 'json' }[field.base] ?? 'string';
    element = `responseField.${base}`;
  }
  return field.list ? `responseField.listOf(${element})` : element;
}

/** El tipo de un campo en el DTO wire: el obligatorio no admite nulo (lo garantiza la guarda). */
function wireDecl(field) {
  if (isComposite(field)) return field.list ? 'readonly unknown[]' : 'unknown';
  if (field.list) return `readonly ${elementType(field)}[]`;
  return field.required ? field.tsType : `${field.tsType} | null`;
}

function responseTs(model, client, call) {
  const file = infraPath(call.responseType);
  const subject = `${client.id}.${call.name}`;
  const imports = [
    { symbol: 'responseField', from: RESPONSE_READING_TS },
    { symbol: 'responseObject', from: RESPONSE_READING_TS },
    ...importsOf(model, call.responseFields.filter((field) => !isComposite(field)))
  ];
  const fields = call.responseFields;
  if (fields.some((field) => field.required && !field.list && !isComposite(field))) imports.push({ symbol: 'requiredField', from: RESPONSE_READING_TS });
  const members = fields.map((field) => `    readonly ${field.name}: ${wireDecl(field)}`);
  const reads = fields.map((field) => {
    const read = `${readerOf(field)}(fields[${tsString(field.name)}], ${tsString(`${subject}.${field.name}`)})`;
    if (field.list) return `      ${read} ?? []`;
    if (isComposite(field)) return `      ${read}`;
    return field.required
      ? `      requiredField(${read}, ${tsString(`${subject}: la respuesta no trae '${field.name}', que el contrato declara obligatorio`)})`
      : `      ${read}`;
  });
  const todo = fields.length === 0 ? [`TODO (agente): declara los campos según el contract "${call.contract}".`] : [];
  const composite = fields.filter(isComposite).map((field) => field.name);
  const compositeNote = composite.length > 0
    ? [`${composite.join(', ')}: value object compuesto, que keel-nest todavía no lee (la frontera lo rechaza en build); llega crudo.`]
    : [];
  const body = `${tsdoc([`Respuesta wire de ${subject} (contrato del sistema externo).`, ...todo, ...compositeNote])}export class ${call.responseType} {
  constructor(${members.length > 0 ? `\n${members.join(',\n')}\n  ` : ''}) {}

  /**
   * Lee el cuerpo del proveedor. Un campo que el contrato declara obligatorio y no llega, o que llega con
   * otro tipo, es un OutboundContractError: NO es «el proveedor no está» (no entra al fallback ni cuenta
   * para el circuito) y sale como 500 con su traza, igual que en keel-spring.
   */
  static read(body: unknown): ${call.responseType} {
    ${fields.length > 0 ? `const fields = responseObject(body, ${tsString(subject)});` : `responseObject(body, ${tsString(subject)});`}
    return new ${call.responseType}(${fields.length > 0 ? `\n${reads.join(',\n')}\n    ` : ''});
  }
}`;
  return tsModule(file, imports, body);
}

function requestTs(model, client, call) {
  const file = infraPath(call.requestType);
  const subject = `${client.id}.${call.name}`;
  const imports = importsOf(model, call.bodyFields);
  const required = call.bodyFields.filter((field) => field.required && !field.list);
  if (required.length > 0) imports.push({ symbol: 'OutboundContractError', from: RESPONSE_READING_TS });
  const members = call.bodyFields.map((field) => `    readonly ${field.name}: ${declType(field)}`);
  // La misma guarda que en keel-spring: aquí el dato es NUESTRO, así que un obligatorio nulo es un bug
  // propio, y saltar antes de mandarlo evita estrenarlo contra un tercero en una escritura con reintentos.
  const guards = required.map(
    (field) => `    if (${field.name} == null) {
      throw new OutboundContractError(${tsString(`${subject}: la petición no lleva '${field.name}', que el contrato declara obligatorio`)});
    }`
  );
  const body = `${tsdoc(`Body wire de ${subject} (contrato del sistema externo).`)}export class ${call.requestType} {
  constructor(
${members.join(',\n')}
  ) {${guards.length > 0 ? `\n${guards.join('\n')}\n  ` : ''}}
}`;
  return tsModule(file, imports, body);
}

// ─── Mapper de anticorrupción ────────────────────────────────────────────────

function mapperTs(model, client) {
  const file = infraPath(client.mapperClass);
  const imports = [{ symbol: 'Injectable', from: '@nestjs/common' }];
  const methods = [];
  for (const call of client.calls) {
    if (!call.bodiless) {
      imports.push({ symbol: call.resultType, from: resultPath(call) }, { symbol: call.responseType, from: infraPath(call.responseType) });
      if (call.responseFields.length > 0) {
        // Un value object compuesto todavía no se lee: el resultado lo lleva ausente y lo dice.
        const args = call.responseFields.map((field) =>
          isComposite(field) ? (field.list ? '[] /* TODO (agente): value object compuesto */' : 'null /* TODO (agente): value object compuesto */') : `response.${field.name}`
        );
        methods.push(`  /** Traduce la respuesta wire de ${call.name} al resultado del dominio. */
  to${call.pascal}Result(response: ${call.responseType}): ${call.resultType} {
    return new ${call.resultType}(${args.join(', ')});
  }`);
      } else {
        methods.push(`  /** Traduce la respuesta wire de ${call.name} al resultado del dominio. */
  to${call.pascal}Result(_response: ${call.responseType}): ${call.resultType} {
    // TODO (agente): mapea la respuesta del contract "${call.contract}" al resultado del dominio.
    return new ${call.resultType}();
  }`);
      }
    }
    if (call.requestType) {
      imports.push({ symbol: call.requestType, from: infraPath(call.requestType) }, ...importsOf(model, call.bodyFields));
      methods.push(`  /** Arma el body wire de ${call.name} desde los valores del dominio. */
  to${call.pascal}Request(${call.bodyFields.map(paramDecl).join(', ')}): ${call.requestType} {
    return new ${call.requestType}(${call.bodyFields.map((field) => field.name).join(', ')});
  }`);
    }
  }
  const body = `${tsdoc([
    `Capa de anticorrupción de ${client.id}: traduce entre el contrato wire del sistema externo y los tipos del`,
    'dominio. Si el tercero cambia su contrato, el cambio se absorbe aquí (y en los DTOs wire), nunca en el dominio.'
  ])}@Injectable()
export class ${client.mapperClass} {
${methods.join('\n\n')}
}`;
  return tsModule(file, imports, body);
}

// ─── Adaptador ───────────────────────────────────────────────────────────────

const policyConst = (call) => `${call.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_POLICY`;

/** ¿Tiene fallback? La misma regla que keel-spring: hace falta una política y algo que lo dispare. */
function hasFallback(call) {
  return Boolean((call.fallback || call.circuitBreaker || (call.needs ?? []).some(({ need }) => need.onUnavailable)) && (call.retry || call.circuitBreaker));
}

/** La política de una llamada como literal TypeScript: la de keel-core, ya resuelta. */
function policyLiteral(call) {
  const policy = resiliencePolicy(call);
  const retry = policy.retry
    ? `{ maxAttempts: ${policy.retry.maxAttempts}, initialDelayMs: ${policy.retry.initialDelayMs}, multiplier: ${policy.retry.multiplier ?? 'null'}, maxDelayMs: ${policy.retry.maxDelayMs ?? 'null'}, retries: [${policy.retry.retries.map(tsString).join(', ')}] }`
    : 'null';
  const cb = policy.circuitBreaker;
  const circuit = cb
    ? `{ failureRateThreshold: ${cb.failureRateThreshold}, slidingWindowSize: ${cb.slidingWindowSize}, minimumNumberOfCalls: ${cb.minimumNumberOfCalls}, waitDurationMs: ${cb.waitDurationMs}, halfOpenCalls: ${cb.halfOpenCalls} }`
    : 'null';
  return `{ instance: ${tsString(policy.instance)}, retry: ${retry}, circuitBreaker: ${circuit} }`;
}

/** Lo que el resultado lleva cuando el proveedor no dijo nada: listas vacías y el resto ausente. */
function neutralResult(call) {
  const args = call.responseFields.map((field) => (field.list ? '[]' : 'null'));
  return `new ${call.resultType}(${args.join(', ')})`;
}

function adapterTs(model, client) {
  const file = infraPath(client.adapterClass);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'Logger', from: '@nestjs/common' },
    { symbol: client.clientClass, from: portPath(client) },
    { symbol: client.mapperClass, from: infraPath(client.mapperClass) },
    { symbol: 'HTTP_CLIENTS_SETTINGS', from: HTTP_CLIENTS_SETTINGS_TS },
    { symbol: 'HttpClientsSettings', from: HTTP_CLIENTS_SETTINGS_TS, type: true },
    { symbol: 'ClientSettings', from: HTTP_EXCHANGE_TS, type: true },
    ...importsOf(model, client.calls.flatMap(callFields))
  ];
  const constants = [];
  const fields = [];
  const methods = client.calls.map((call) => callMethod(model, client, call, imports, constants, fields));
  // Con `onUnavailable: lastKnown`, el almacén del último valor (13j): lo alimenta el camino feliz, lo lee el fallback.
  const remembers = clientRemembers(model, client);
  if (remembers) imports.push({ symbol: 'LastKnownValues', from: LAST_KNOWN_TS });
  const lastKnownParam = remembers ? ',\n    @Inject(LastKnownValues) private readonly lastKnown: LastKnownValues' : '';
  const body = `${constants.join('\n\n')}${constants.length > 0 ? '\n\n' : ''}${tsdoc(`Adaptador HTTP de ${client.id}: implementa ${client.clientClass} sobre fetch, con la resiliencia que declara el diseño.`)}@Injectable()
export class ${client.adapterClass} implements ${client.clientClass} {
  private readonly logger = new Logger(${tsString(client.adapterClass)});
  private readonly client: ClientSettings;${fields.length > 0 ? `\n${fields.join('\n')}` : ''}

  constructor(
    @Inject(HTTP_CLIENTS_SETTINGS) settings: HttpClientsSettings,
    @Inject(${client.mapperClass}) private readonly mapper: ${client.mapperClass}${lastKnownParam}
  ) {
    this.client = settings[${tsString(client.id)}];
  }

${methods.join('\n\n')}
}`;
  return tsModule(file, imports, body);
}

function callMethod(model, client, call, imports, constants, fields) {
  const subject = `${client.id}.${call.name}`;
  const params = callParams(call);
  const args = callArgs(call).join(', ');
  const returns = call.bodiless ? 'void' : call.resultType;
  if (!call.bodiless) imports.push({ symbol: call.resultType, from: resultPath(call) });

  if (!call.method) {
    return `${tsdoc(call.contract, '  ')}  async ${call.name}(${params.join(', ')}): Promise<${returns}> {
    // TODO (agente): completar la llamada; el diseño no declara method/path ni el contract es parseable
    //   ${call.contract}
    throw new Error(${tsString(`TODO: ${call.name}`)});
  }`;
  }

  const once = onceMethod(model, client, call, imports);
  const resilient = Boolean(call.retry || call.circuitBreaker);
  if (!resilient) {
    return `${tsdoc(call.contract, '  ')}  async ${call.name}(${params.join(', ')}): Promise<${returns}> {
    return this.${call.name}Once(${args});
  }

${once}`;
  }

  imports.push({ symbol: 'OutboundPolicy', from: OUTBOUND_RESILIENCE_TS, type: true }, { symbol: 'withResilience', from: OUTBOUND_RESILIENCE_TS });
  constants.push(`/** La política de ${subject} (keel-core/gen/outbound-resilience.js, la misma que keel-spring). */
const ${policyConst(call)}: OutboundPolicy = ${policyLiteral(call)};`);
  // El circuito es POR LLAMADA y vive lo que el adaptador (un singleton): su ventana es la de esta instancia.
  if (call.circuitBreaker) {
    imports.push({ symbol: 'CircuitBreaker', from: CIRCUIT_BREAKER_TS });
    fields.push(`  private readonly ${call.name}Circuit = new CircuitBreaker(${policyConst(call)}.circuitBreaker!);`);
  }
  const circuit = call.circuitBreaker ? `this.${call.name}Circuit` : 'null';
  const guarded = `withResilience(${policyConst(call)}, ${circuit}, () => this.${call.name}Once(${args}))`;
  const ret = call.bodiless ? '' : 'return ';

  if (!hasFallback(call)) {
    return `${tsdoc(call.contract, '  ')}  async ${call.name}(${params.join(', ')}): Promise<${returns}> {
    ${ret}await ${guarded};
  }

${once}`;
  }

  // El fallback NO atiende cualquier error: solo los fallos del proveedor de la tabla neutral. Lo demás —un
  // bug del adaptador, un cuerpo que viola el contrato— se propaga con su traza (keel-core, outbound-resilience).
  const kinds = fallbackFailures({ circuitBreaker: Boolean(call.circuitBreaker), oauth2: client.auth?.type === 'oauth2-client-credentials' }).map((f) => f.kind);
  imports.push({ symbol: 'providerFailureOf', from: PROVIDER_FAILURES_TS }, { symbol: 'OutboundFailure', from: PROVIDER_FAILURES_TS, type: true });
  const unavailable = unavailableBody(model, client, call, imports);
  // Los parámetros de la llamada solo los lee el fallback de lastKnown (son la clave del último valor).
  const usesArgs = /this.lastKnown.recall/.test(unavailable);
  return `${tsdoc(call.contract, '  ')}  async ${call.name}(${params.join(', ')}): Promise<${returns}> {
    try {
      ${ret}await ${guarded};
    } catch (error) {
      // Solo lo que ha hecho el PROVEEDOR (${kinds.join(', ')}); lo demás se propaga.
      const failure = providerFailureOf(error, [${kinds.map(tsString).join(', ')}]);
      if (failure === null) throw error;
      if (failure.kind === 'client-error') {
        // Si el rechazo tiene significado de negocio —un 404 es "no existe", un 409 un conflicto suyo—, la
        // traducción va en ${call.name}Once, mirando failure.status antes de que llegue aquí.
        this.logger.warn(\`${subject} rechazada por el proveedor (\${failure.status ?? '?'})\`);
      }
      ${ret}this.${call.name}Unavailable(${[args, 'failure'].filter(Boolean).join(', ')});
    }
  }

${once}

  /**
   * Política del diseño para cuando ${subject} no sale.
   *
   * Solo llega aquí lo que ha hecho el PROVEEDOR: no responder, responder mal o rechazarnos. Un error de
   * programación de este adaptador no tiene rama que lo enrute y se propaga con su traza. No lo ensanches a
   * cualquier error para "que no se escape nada": lo que se escapa es el bug.
   */
  private ${call.name}Unavailable(${[...params.map((p) => (usesArgs ? p : `_${p}`)), 'failure: OutboundFailure'].join(', ')}): ${returns} {
${unavailable}
  }`;
}

/** Un intento: la petición, su clasificación y la lectura del cuerpo. Lo repite el retry. */
function onceMethod(model, client, call, imports) {
  imports.push({ symbol: 'exchange', from: HTTP_EXCHANGE_TS });
  const subject = `${client.id}.${call.name}`;
  const pathArgs = call.pathParams.map((field) => `${field.name}`).join(', ');
  const pathExpr = call.pathParams.length > 0 ? `path: ${tsString(call.path)},
      params: { ${pathArgs} },` : `path: ${tsString(call.path)},`;
  const query = call.queryParams.length > 0 ? `\n      query: { ${call.queryParams.map((f) => f.name).join(', ')} },` : '';
  const headers = call.headerParams.map((f) => `${tsString(f.name)}: ${f.name}`);
  const lines = [];
  let bodyExpr = null;
  if (call.requestType) {
    lines.push(`    const request = this.mapper.to${call.pascal}Request(${call.bodyFields.map((f) => f.name).join(', ')});`);
    bodyExpr = 'request';
  } else if (call.hasBody) {
    bodyExpr = 'body';
  }
  if (call.idempotency) {
    imports.push({ symbol: 'OutboundIdempotency', from: OUTBOUND_IDEMPOTENCY_TS });
    // La firma es la del MISMO objeto que se envía; sin cuerpo, lo que identifica la petición son sus
    // parámetros (el DELETE de un recurso concreto). Se calcula DENTRO del intento y sale igual en cada uno:
    // una clave que cambiara entre reintentos pediría al proveedor una ejecución nueva.
    const payload = bodyExpr ?? `[${callFields(call).map((f) => f.name).join(', ')}]`;
    const factory = call.idempotency.keyFrom === 'correlation' ? 'correlated' : 'fromPayload';
    headers.push(`${tsString(call.idempotency.header)}: OutboundIdempotency.${factory}(${tsString(call.name)}, ${payload})`);
  }
  const headerLine = headers.length > 0 ? `\n      headers: { ${headers.join(', ')} },` : '';
  const bodyLine = bodyExpr ? `\n      body: ${bodyExpr},` : '';
  const send = `await exchange(this.client, {
      method: ${tsString(call.method)},
      ${pathExpr}${query}${headerLine}${bodyLine}
    })`;
  const todo = call.typed ? '' : `    // TODO (agente): ajusta ${call.responseType ?? 'la llamada'} y el request al contract\n    //   ${call.contract}\n`;
  const params = callParams(call).join(', ');
  if (call.bodiless) {
    return `  private async ${call.name}Once(${params}): Promise<void> {
${todo}${lines.join('\n')}${lines.length > 0 ? '\n' : ''}    ${send};
  }`;
  }
  imports.push({ symbol: call.responseType, from: infraPath(call.responseType) });
  // Cuerpo ausente (un 204): el mismo criterio que keel-spring — valores AUSENTES, no un fallo. Con
  // `awaits: outcome` quien decide qué hacer sin desenlace es el handler; lanzar se lo robaría.
  const emptyGuard = call.responseFields.length > 0
    ? `
    if (response.body === null) {
      this.logger.warn(${tsString(`${subject} respondió sin cuerpo; el contrato declara ${call.responseFields.length} campo(s)`)});
      return ${neutralResult(call)};
    }`
    : '';
  // Con `onUnavailable: lastKnown`, el resultado se recuerda ANTES de devolverlo: lo que sirve cuando el proveedor cae
  // es lo último que contestó cuando no lo estaba.
  const result = rememberedCall(model, client, call)
    ? `
    const result = this.mapper.to${call.pascal}Result(${call.responseType}.read(response.body));
    this.lastKnown.remember(${tsString(call.name)}, ${lastKnownKey(call)}, result);
    return result;`
    : `
    return this.mapper.to${call.pascal}Result(${call.responseType}.read(response.body));`;
  return `  private async ${call.name}Once(${params}): Promise<${call.resultType}> {
${todo}${lines.join('\n')}${lines.length > 0 ? '\n' : ''}    const response = ${send};${emptyGuard}${result}
  }`;
}

/** El cuerpo del fallback: la política que declara la activación que sale por esta llamada (como keel-spring). */
function unavailableBody(model, client, call, imports) {
  const subject = `${client.id}.${call.name}`;
  const activations = call.activations ?? [];
  const needs = (call.needs ?? []).filter(({ need }) => need.onUnavailable);
  const trace = `    this.logger.warn(\`Fallback de ${subject}: \${failure.message}\`);`;
  const prose = call.fallback ? `    // Fallback declarado en el diseño: ${call.fallback}\n` : '';
  const todoThrow = `    throw new Error(${tsString(`TODO: fallback ${call.name}`)});`;
  const distinct = new Set([
    ...activations.map(({ activation }) => `activation:${JSON.stringify(activation.onFailure ?? null)}`),
    ...needs.map(({ need }) => `need:${JSON.stringify(need.onUnavailable)}`)
  ]);
  // Una política, y solo una: con dos distintas el conflicto es del diseño (un método no puede hacer dos cosas).
  if (distinct.size !== 1) {
    const doc = call.fallback ? `    // TODO (agente): ${call.fallback}` : '    // TODO (agente): política de fallback del circuito abierto.';
    const conflicting = [
      ...activations.map(({ dependency, activation }) => `${dependency}.${activation.name} (activación, onFailure: ${activation.onFailure?.action ?? 'sin declarar'})`),
      ...needs.map(({ dependency, need }) => `${dependency}.${need.name} (need, onUnavailable: ${need.onUnavailable.action})`)
    ];
    const listed =
      distinct.size > 1
        ? `\n    // Varias políticas DISTINTAS salen por esta llamada y el diseño no puede darles caminos distintos sobre un\n    // único método: ${conflicting.join('; ')}`
        : '';
    return `${trace}\n${doc}${listed}\n${todoThrow}`;
  }
  // La política del `need` (`onUnavailable`): el dato que se PIDE al proveedor no depende de la prosa del fallback.
  if (needs.length > 0) return needFallbackBody(model, call, needs, trace, prose, todoThrow, imports);
  // (needFallbackBody resuelve también lastKnown, con el almacén que inyecta el adaptador.)
  const { dependency, activation } = activations[0];
  const { onFailure } = activation;
  const origin = `    // Política declarada por la activación ${dependency}.${activation.name} (onFailure: ${onFailure?.action ?? 'sin declarar'}).\n`;
  if (onFailure?.action === 'ignore') {
    // Una sola línea: es el mismo evento que el trace, y esta dice más (que el llamante sigue adelante).
    return `${prose}${origin}    // El llamante sigue adelante: no propagues el error ni inventes datos del proveedor.
    this.logger.warn(\`${subject} no disponible; se continúa sin él: \${failure.message}\`);${call.bodiless ? '' : `\n    return ${neutralResult(call)};`}`;
  }
  if (onFailure?.action === 'fail') {
    if (onFailure.exceptionClass) {
      imports.push({ symbol: onFailure.exceptionClass, from: classPath(DIRS.errors, onFailure.exceptionClass) });
      const message = tsString(`${dependency} no está disponible para ${activation.name}`);
      const args = onFailure.dynamicStatus ? `${message}, ${onFailure.httpStatus}` : message;
      return `${trace}\n${prose}${origin}    throw new ${onFailure.exceptionClass}(${args});`;
    }
    return `${trace}\n${prose}${origin}    // TODO (agente): el diseño declara onFailure.error = ${onFailure.error}, pero ninguna operación de
    // use-cases lo declara todavía, así que su clase no existe.
${todoThrow}`;
  }
  if (onFailure?.action === 'degrade') {
    return `${trace}\n${prose}${origin}    // TODO (agente): el resultado degradado es lógica de negocio y debe ser distinguible por el cliente de
    // una respuesta normal — un dato plausible pero falso es peor que fallar:
    //   ${onFailure.degradedTo}
${todoThrow}`;
  }
  return `${trace}\n${prose}${origin}    // TODO (agente): la activación no declara onFailure.
${todoThrow}`;
}

/**
 * El endpoint de token en `local`: el PATH del diseño sobre el proveedor de prueba (el WireMock de infra/), como
 * keel-spring. Solo en local: fuera, el valor del diseño es el default (develop) o la variable obligatoria.
 */
function tokenUri(client, profile) {
  if (profile !== 'local') return client.auth.tokenUrl;
  try {
    return LOCAL_STUB_BASE_URL + new URL(client.auth.tokenUrl).pathname;
  } catch {
    return client.auth.tokenUrl;
  }
}

/** El fallback cuando la política la declara un `need` (`onUnavailable`): el mismo de keel-spring. */
function needFallbackBody(model, call, needs, trace, prose, todoThrow, imports) {
  const { dependency, need } = needs[0];
  const { onUnavailable } = need;
  const cited = needs.map(({ dependency: dep, need: n }) => `${dep}.${n.name}`).join(', ');
  const origin = `    // Política declarada por ${needs.length > 1 ? `los needs ${cited}, que declaran la misma` : `el need ${cited}`} (onUnavailable: ${onUnavailable.action}).\n`;
  if (onUnavailable.action === 'fail') {
    if (onUnavailable.exceptionClass) {
      imports.push({ symbol: onUnavailable.exceptionClass, from: classPath(DIRS.errors, onUnavailable.exceptionClass) });
      const message = tsString(`${dependency} no está disponible para ${need.name}`);
      const args = onUnavailable.dynamicStatus ? `${message}, ${onUnavailable.httpStatus}` : message;
      return `${trace}\n${prose}${origin}    throw new ${onUnavailable.exceptionClass}(${args});`;
    }
    return `${trace}\n${prose}${origin}    // TODO (agente): el diseño declara onUnavailable.error = ${onUnavailable.error}, pero ninguna operación de
    // use-cases lo declara todavía, así que su clase no existe.
${todoThrow}`;
  }
  if (onUnavailable.action === 'degrade') {
    return `${trace}\n${prose}${origin}    // TODO (agente): el resultado degradado es lógica de negocio y debe ser distinguible por el cliente de
    // una respuesta normal — un dato plausible pero falso es peor que fallar:
    //   ${onUnavailable.degradedTo}
${todoThrow}`;
  }
  // `lastKnown`: el único con mecanismo propio, y por eso build lo escribe entero. Las dos mitades son inseparables
  // —servir el último valor y RENDIRSE cuando ya es demasiado viejo—: sin la segunda, es la caché sin expiración que el
  // diseño acaba de prohibir.
  const recall = `this.lastKnown.recall<${call.resultType}>(${tsString(call.name)}, ${lastKnownKey(call)}, ${onUnavailable.maxAgeSeconds})`;
  const window = `    // Dentro de la ventana declarada se sirve lo último que se leyó; fuera de ella no hay nada que servir: un valor
    // más viejo que ${onUnavailable.maxAgeSeconds} s ya no es ese dato.
    const remembered = ${recall};
    if (remembered !== null) return remembered;`;
  if (onUnavailable.exceptionClass) {
    imports.push({ symbol: onUnavailable.exceptionClass, from: classPath(DIRS.errors, onUnavailable.exceptionClass) });
    const message = tsString(`${dependency} no está disponible y el último ${need.name} conocido supera los ${onUnavailable.maxAgeSeconds}s`);
    const args = onUnavailable.dynamicStatus ? `${message}, ${onUnavailable.httpStatus}` : message;
    return `${trace}\n${prose}${origin}${window}
    throw new ${onUnavailable.exceptionClass}(${args});`;
  }
  return `${trace}\n${prose}${origin}${window}
    // TODO (agente): el diseño declara onUnavailable.error = ${onUnavailable.error}, pero ninguna operación de use-cases lo
    // declara todavía, así que su clase no existe: solo falta con qué rendirse.
${todoThrow}`;
}

// ─── Configuración ───────────────────────────────────────────────────────────

// El gradiente de keel-spring: literal en local y test; `${VAR:default}` en develop y `${VAR}` en production
// para los secretos; y la URL, OBLIGATORIA fuera de local (el DSL no declara URLs: son infraestructura).
function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

/** El mismo `http-clients.yaml` que keel-spring, sin el bloque de resilience4j (aquí va en código). */
export function httpClientsYaml(model, profile) {
  const lines = ['http-clients:'];
  for (const client of model.httpClients) {
    lines.push(`  ${client.id}:`);
    if (profile === 'local') {
      lines.push('    # Proveedor de prueba (WireMock de infra/docker-compose.yaml).', '    # Los mappings los programa cada test; nada que configurar aquí.');
    }
    const baseUrl = profile === 'local' ? LOCAL_STUB_BASE_URL : profile === 'test' ? TEST_BASE_URL : `\${${client.envPrefix}_BASE_URL}`;
    lines.push(`    base-url: ${baseUrl}`);
    if (client.auth?.type === 'api-key') {
      lines.push('    auth:', `      api-key: ${envValue(profile, `${client.envPrefix}_API_KEY`, 'changeme')}`);
    } else if (client.auth?.type === 'bearer-static') {
      lines.push('    auth:', `      token: ${envValue(profile, `${client.envPrefix}_TOKEN`, 'changeme')}`);
    } else if (client.auth?.type === 'basic') {
      lines.push(
        '    auth:',
        `      username: ${envValue(profile, `${client.envPrefix}_USERNAME`, 'changeme')}`,
        `      password: ${envValue(profile, `${client.envPrefix}_PASSWORD`, 'changeme')}`
      );
    } else if (client.auth?.type === 'oauth2-client-credentials') {
      // Las MISMAS variables que la registration de keel-spring (<CLIENTE>_CLIENT_ID, _CLIENT_SECRET, _TOKEN_URL).
      lines.push(
        '    auth:',
        `      client-id: ${profile === 'test' ? 'test' : envValue(profile, `${client.envPrefix}_CLIENT_ID`, 'changeme')}`,
        `      client-secret: ${profile === 'test' ? 'test' : envValue(profile, `${client.envPrefix}_CLIENT_SECRET`, 'changeme')}`,
        `      token-uri: ${profile === 'test' ? 'http://localhost/token' : envValue(profile, `${client.envPrefix}_TOKEN_URL`, tokenUri(client, profile))}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function settingsTs(model) {
  const entries = model.httpClients.map((client) => {
    const auth = client.auth;
    let headers = '{}';
    if (auth?.type === 'api-key') headers = `{ ${tsString(auth.headerName)}: text(configuration, ${tsString(`${auth.propertyPrefix}.api-key`)}) }`;
    else if (auth?.type === 'bearer-static') headers = `{ Authorization: \`Bearer \${text(configuration, ${tsString(`${auth.propertyPrefix}.token`)})}\` }`;
    else if (auth?.type === 'basic') {
      headers = `{ Authorization: basic(text(configuration, ${tsString(`${auth.propertyPrefix}.username`)}), text(configuration, ${tsString(`${auth.propertyPrefix}.password`)})) }`;
    }
    // OAuth2 client-credentials (13j): la concesión, una instancia por arranque —ningún token sobrevive entre arranques—.
    const oauth =
      auth?.type === 'oauth2-client-credentials'
        ? `
      authorization: clientCredentials({
        id: ${tsString(client.id)},
        tokenUri: text(configuration, ${tsString(`${auth.propertyPrefix}.token-uri`)}),
        clientId: text(configuration, ${tsString(`${auth.propertyPrefix}.client-id`)}),
        clientSecret: text(configuration, ${tsString(`${auth.propertyPrefix}.client-secret`)}),
        scopes: [${(auth.scopes ?? []).map(tsString).join(', ')}],
        timeoutMs: ${client.readTimeoutMs}
      }),`
        : '';
    return `    ${tsString(client.id)}: {
      id: ${tsString(client.id)},
      baseUrl: text(configuration, ${tsString(client.baseUrlProperty)}),
      // El timeout de lectura de keel-spring: el MAYOR de las llamadas del cliente (${RESILIENCE_DEFAULTS.timeoutMs} ms si ninguna lo declara).
      timeoutMs: ${client.readTimeoutMs},${oauth}
      headers: ${headers}
    }`;
  });
  const usesBasic = model.httpClients.some((client) => client.auth?.type === 'basic');
  const body = `/** Token de la configuración de los clientes HTTP salientes ya resuelta. */
export const HTTP_CLIENTS_SETTINGS = Symbol('HTTP_CLIENTS_SETTINGS');

export type HttpClientsSettings = Readonly<Record<${model.httpClients.map((client) => tsString(client.id)).join(' | ')}, ClientSettings>>;

/**
 * Lo que cada cliente lee de config/parameters/<perfil>/http-clients.yaml: la URL del proveedor (obligatoria
 * fuera de local) y las credenciales de su autenticación, que nunca vienen del diseño.
 */
export function httpClientsSettings(configuration: Configuration): HttpClientsSettings {
  return {
${entries.join(',\n')}
  };
}

function text(configuration: Configuration, path: string): string {
  const value = configuration.get(path);
  if (value == null || String(value).trim() === '') throw new Error(\`Configuración: falta \${path}\`);
  return String(value);
}${usesBasic ? `

function basic(username: string, password: string): string {
  return \`Basic \${Buffer.from(\`\${username}:\${password}\`, 'utf8').toString('base64')}\`;
}` : ''}`;
  return tsModule(
    HTTP_CLIENTS_SETTINGS_TS,
    [
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'ClientSettings', from: HTTP_EXCHANGE_TS, type: true },
      ...(usesOAuth2(model) ? [{ symbol: 'clientCredentials', from: OAUTH2_TS }] : [])
    ],
    body
  );
}

function moduleTs(model) {
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'HTTP_CLIENTS_SETTINGS', from: HTTP_CLIENTS_SETTINGS_TS },
    { symbol: 'httpClientsSettings', from: HTTP_CLIENTS_SETTINGS_TS }
  ];
  const providers = ['{ provide: HTTP_CLIENTS_SETTINGS, useValue: httpClientsSettings(configuration) }'];
  if (lastKnownNeeds(model).length > 0) {
    imports.push({ symbol: 'LastKnownValues', from: LAST_KNOWN_TS });
    providers.push('LastKnownValues');
  }
  for (const client of model.httpClients) {
    imports.push(
      { symbol: client.clientClass, from: portPath(client) },
      { symbol: client.adapterClass, from: infraPath(client.adapterClass) },
      { symbol: client.mapperClass, from: infraPath(client.mapperClass) }
    );
    providers.push(client.mapperClass, `{ provide: ${client.clientClass}, useClass: ${client.adapterClass} }`);
  }
  const body = `/**
 * Los clientes HTTP salientes: un adaptador por puerto de domain/clients, con su mapper y la configuración
 * del perfil. Global: los handlers de application inyectan los puertos sin importarlo.
 */
@Global()
@Module({})
export class HttpClientsModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: HttpClientsModule,
      providers: [
        ${providers.join(',\n        ')}
      ],
      exports: [${model.httpClients.map((client) => client.clientClass).join(', ')}]
    };
  }
}`;
  return tsModule(HTTP_CLIENTS_MODULE_TS, imports, body);
}

// ─── OAuth2 client-credentials ───────────────────────────────────────────────

function oauth2Ts() {
  const body = `/** Lo que la concesión lee de http-clients.yaml (las variables de keel-spring: <CLIENTE>_CLIENT_ID, …). */
export interface ClientCredentialsSettings {
  readonly id: string;
  readonly tokenUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly timeoutMs: number;
}

/** La concesión del token no se pudo obtener: el emisor no responde o nos rechaza. No cuenta para el circuito. */
export class AuthGrantError extends ProviderFailure {
  constructor(message: string, options?: { cause?: unknown }) {
    super('auth-grant', message, null, options);
    this.name = 'AuthGrantError';
  }
}

/**
 * Margen con el que se renueva el token antes de que caduque: el clockSkew de 60 s del OAuth2AuthorizedClientManager de
 * Spring Security, para que un token no caduque en vuelo.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * La concesión \`client_credentials\` de un cliente, con la semántica del OAuth2AuthorizedClientManager de keel-spring:
 * el secreto por \`client_secret_basic\` (cabecera Basic con los dos valores codificados como formulario), los
 * \`scope\` en el cuerpo, el token REUTILIZADO hasta \`expires_in\` menos el margen —una petición al emisor por
 * concesión, no por llamada— y una sola petición en vuelo aunque lleguen varias llamadas a la vez. Devuelve la
 * cabecera \`Authorization\` ya armada.
 */
export function clientCredentials(settings: ClientCredentialsSettings): () => Promise<string> {
  let current: { header: string; renewAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return () => {
    if (current !== null && Date.now() < current.renewAt) return Promise.resolve(current.header);
    pending ??= request(settings)
      .then((token) => {
        current = token;
        return token.header;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

async function request(settings: ClientCredentialsSettings): Promise<{ header: string; renewAt: number }> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (settings.scopes.length > 0) form.set('scope', settings.scopes.join(' '));
  const credentials = Buffer.from(\`\${formEncode(settings.clientId)}:\${formEncode(settings.clientSecret)}\`, 'utf8').toString('base64');
  let status: number;
  let text: string;
  try {
    const response = await fetch(settings.tokenUri, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Authorization: \`Basic \${credentials}\` },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw new AuthGrantError(\`\${settings.id}: el emisor del token no responde\`, { cause: error });
  }
  if (status < 200 || status > 299) throw new AuthGrantError(\`\${settings.id}: el emisor del token contestó \${status}\`);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AuthGrantError(\`\${settings.id}: la respuesta del emisor del token no es JSON\`);
  }
  const token = body['access_token'];
  if (typeof token !== 'string' || token === '') throw new AuthGrantError(\`\${settings.id}: la respuesta del emisor no trae access_token\`);
  // Spring Security exige token_type Bearer: sin él no hay concesión.
  if (typeof body['token_type'] !== 'string' || body['token_type'].toLowerCase() !== 'bearer') {
    throw new AuthGrantError(\`\${settings.id}: el emisor no devolvió un token Bearer\`);
  }
  // Sin expires_in (o no positivo), Spring lo da por caducado en un segundo: se pide de nuevo en la siguiente llamada.
  const expiresIn = Number(body['expires_in']);
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 1000;
  return { header: \`Bearer \${token}\`, renewAt: Date.now() + lifetimeMs - CLOCK_SKEW_MS };
}

/** Codificación de formulario (RFC 6749 § 2.3.1): la de URLEncoder de Java, con el espacio como «+». */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}`;
  return tsModule(OAUTH2_TS, [{ symbol: 'ProviderFailure', from: PROVIDER_FAILURES_TS }], body);
}

// ─── El último valor conocido (onUnavailable: lastKnown) ─────────────────────

function lastKnownTs() {
  const body = `/** Tope de entradas vivas: la clave la forman los parámetros de la llamada, así que sin tope es una fuga lenta. */
const MAX_ENTRIES = 10_000;

interface Entry {
  readonly value: unknown;
  readonly storedAt: number;
}

/**
 * El último valor conocido de cada llamada saliente, para la política \`onUnavailable: lastKnown\` del diseño: el
 * LastKnownValues de keel-spring.
 *
 * **Acotado por edad y por tamaño, y las dos cotas importan.** La edad la declara el diseño (\`maxAgeSeconds\` del need)
 * y se aplica al LEER: pasado ese tiempo el valor deja de existir para quien pregunta, y el fallback lanza el error
 * declarado en vez de servir algo que ya no significa nada. El tamaño lo pone este almacén.
 *
 * En memoria y por instancia a propósito: lo que promete es «lo último que ESTE proceso llegó a leer». Sobre la caché
 * compartida prometería otra cosa y metería una dependencia más en el camino que se recorre cuando algo ya está caído.
 */
@Injectable()
export class LastKnownValues {
  private readonly entries = new Map<string, Entry>();

  /** Recuerda lo que la llamada acaba de devolver. Se invoca en el camino FELIZ del adaptador. */
  remember(scope: string, key: unknown, value: unknown): void {
    if (value == null) return;
    if (this.entries.size >= MAX_ENTRIES) this.evictOldest();
    const id = entryKey(scope, key);
    // Al final del orden de inserción: el más viejo es siempre el primero.
    this.entries.delete(id);
    this.entries.set(id, { value, storedAt: Date.now() });
  }

  /**
   * El último valor de esa llamada si aún está dentro de \`maxAgeSeconds\`; null si no hay ninguno o si el que hay ya
   * es demasiado viejo. El caducado se borra al detectarlo, para que el tope no expulse valores útiles.
   */
  recall<T>(scope: string, key: unknown, maxAgeSeconds: number): T | null {
    const id = entryKey(scope, key);
    const entry = this.entries.get(id);
    if (entry == null) return null;
    if (Date.now() - entry.storedAt > maxAgeSeconds * 1000) {
      this.entries.delete(id);
      return null;
    }
    return entry.value as T;
  }

  /** Deja sitio tirando las entradas más viejas, que son las que menos van a servir. */
  private evictOldest(): void {
    const excess = Math.max(1, this.entries.size - Math.floor((MAX_ENTRIES * 3) / 4));
    let removed = 0;
    for (const id of this.entries.keys()) {
      if (removed++ >= excess) break;
      this.entries.delete(id);
    }
  }
}

function entryKey(scope: string, key: unknown): string {
  return \`\${scope}|\${Array.isArray(key) ? key.map(String).join(',') : String(key)}\`;
}`;
  return tsModule(LAST_KNOWN_TS, [{ symbol: 'Injectable', from: '@nestjs/common' }], body);
}

// ─── Soporte (uno por servicio) ──────────────────────────────────────────────

function providerFailuresTs() {
  return tsModule(
    PROVIDER_FAILURES_TS,
    [{ symbol: 'CallNotPermittedError', from: CIRCUIT_BREAKER_TS }],
    `/**
 * Qué significa «el proveedor no está», como errores con su \`kind\`: la tabla de keel-core
 * (gen/outbound-resilience.js), la misma que en keel-spring proyecta cada fallo a su excepción de Spring.
 * Lo que NO es uno de estos —un bug del adaptador, un cuerpo que viola el contrato— no tiene rama en el
 * fallback ni cuenta para el circuito: se propaga con su traza.
 */
export type ProviderFailureKind = 'transport' | 'server-error' | 'unknown-status' | 'client-error' | 'circuit-open' | 'auth-grant';

/** Un fallo del proveedor: su \`kind\` neutral y, si contestó, su status. */
export class ProviderFailure extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    readonly status: number | null = null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ProviderFailure';
  }
}

/** Conexión rechazada, timeout, DNS, socket roto: no hay nadie al otro lado. */
export class ProviderTransportError extends ProviderFailure {
  constructor(message: string, options?: { cause?: unknown }) {
    super('transport', message, null, options);
    this.name = 'ProviderTransportError';
  }
}

/**
 * Un status del proveedor que no es 2xx. 4xx: nos RECHAZA (contestó, no está caído); 5xx: está roto;
 * cualquier otro: no es un status del estándar que un contrato pueda declarar.
 */
export class ProviderStatusError extends ProviderFailure {
  constructor(
    status: number,
    readonly body: string
  ) {
    super(status >= 400 && status <= 499 ? 'client-error' : status >= 500 && status <= 599 ? 'server-error' : 'unknown-status', \`El proveedor contestó \${status}\`, status);
    this.name = 'ProviderStatusError';
  }
}

/** Lo que puede llegar al fallback: un fallo del proveedor o el circuito abierto. */
export type OutboundFailure = ProviderFailure | CallNotPermittedError;

/** El fallo neutral de un error, si es uno de los que \`kinds\` atiende; null si no lo es (se propaga). */
export function providerFailureOf(error: unknown, kinds: readonly ProviderFailureKind[]): OutboundFailure | null {
  const failure = error instanceof CallNotPermittedError ? error : error instanceof ProviderFailure ? error : null;
  return failure !== null && kinds.includes(failure.kind) ? failure : null;
}

/** El \`kind\` de un error, o null si no es un fallo del proveedor. */
export function failureKind(error: unknown): ProviderFailureKind | null {
  return error instanceof ProviderFailure || error instanceof CallNotPermittedError ? error.kind : null;
}`
  );
}

function circuitBreakerTs() {
  return tsModule(
    CIRCUIT_BREAKER_TS,
    [],
    `/**
 * El circuito de una llamada saliente, con la semántica de resilience4j por CONTEO (la del servidor de
 * keel-spring del mismo diseño). Es la referencia ejecutable de keel-core (\`circuitBreakerReference\`)
 * escrita en TypeScript, y las pruebas de keel-nest recorren las mismas secuencias contra las dos.
 *
 *   · cerrado: cada llamada que sale cuenta —fallo si su fallo está en los que cuentan, éxito si no (un 4xx
 *     es un ÉXITO para el circuito)—; con al menos \`minimumNumberOfCalls\`, una tasa >= umbral abre;
 *   · abierto: rechaza sin intentar hasta \`waitDurationMs\`; la primera llamada después pasa a semiabierto;
 *   · semiabierto: deja pasar \`halfOpenCalls\` pruebas y decide con TODAS: reabre o cierra con la ventana vacía.
 *
 * No es el CountBreaker de cockatiel a propósito: evalúa solo al registrar un fallo, no cuenta lo que su
 * política no maneja y reabre al primer fallo en semiabierto. Tres diferencias medidas.
 */
export interface CircuitBreakerSpec {
  readonly failureRateThreshold: number;
  readonly slidingWindowSize: number;
  readonly minimumNumberOfCalls: number;
  readonly waitDurationMs: number;
  readonly halfOpenCalls: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** El circuito está abierto: la llamada ni se intentó. */
export class CallNotPermittedError extends Error {
  readonly kind = 'circuit-open';
  readonly status: number | null = null;
  constructor() {
    super('El circuito está abierto: la llamada ni se intentó');
    this.name = 'CallNotPermittedError';
  }
}

export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private window: boolean[] = [];
  private openedAt = 0;
  private permitted = 0;
  private trial: boolean[] = [];

  constructor(
    private readonly spec: CircuitBreakerSpec,
    private readonly now: () => number = () => Date.now()
  ) {}

  get state(): CircuitState {
    return this.current;
  }

  /** ¿Puede salir esta llamada? */
  tryAcquire(): boolean {
    if (this.current === 'open') {
      if (this.now() - this.openedAt < this.spec.waitDurationMs) return false;
      this.current = 'half-open';
      this.permitted = 0;
      this.trial = [];
    }
    if (this.current === 'half-open') {
      if (this.permitted >= this.spec.halfOpenCalls) return false;
      this.permitted++;
    }
    return true;
  }

  /** El desenlace de una llamada que salió: \`failed\` si su fallo cuenta para el circuito. */
  record(failed: boolean): void {
    if (this.current === 'half-open') {
      this.trial.push(failed);
      if (this.trial.length >= this.spec.halfOpenCalls) {
        if (this.tripped(this.trial)) this.open();
        else {
          this.current = 'closed';
          this.window = [];
        }
      }
      return;
    }
    if (this.current !== 'closed') return;
    this.window.push(failed);
    if (this.window.length > this.spec.slidingWindowSize) this.window.shift();
    if (this.window.length >= this.spec.minimumNumberOfCalls && this.tripped(this.window)) this.open();
  }

  private tripped(outcomes: readonly boolean[]): boolean {
    return (outcomes.filter(Boolean).length * 100) / outcomes.length >= this.spec.failureRateThreshold;
  }

  private open(): void {
    this.current = 'open';
    this.openedAt = this.now();
    this.window = [];
  }
}`
  );
}

function outboundResilienceTs() {
  return tsModule(
    OUTBOUND_RESILIENCE_TS,
    [
      { symbol: 'CallNotPermittedError', from: CIRCUIT_BREAKER_TS },
      { symbol: 'CircuitBreaker', from: CIRCUIT_BREAKER_TS, type: true },
      { symbol: 'CircuitBreakerSpec', from: CIRCUIT_BREAKER_TS, type: true },
      { symbol: 'ProviderFailureKind', from: PROVIDER_FAILURES_TS, type: true },
      { symbol: 'failureKind', from: PROVIDER_FAILURES_TS }
    ],
    `/**
 * La política de una llamada: la de keel-core (\`resiliencePolicy\`) ya resuelta, como literal en su adaptador.
 * \`maxAttempts\` son los intentos TOTALES (el de resilience4j), no los reintentos.
 */
export interface OutboundPolicy {
  readonly instance: string;
  readonly retry: {
    readonly maxAttempts: number;
    readonly initialDelayMs: number;
    /** null: backoff fijo. */
    readonly multiplier: number | null;
    /** null: sin techo (exponencial sin cota, como resilience4j sin exponential-max-wait-duration). */
    readonly maxDelayMs: number | null;
    readonly retries: readonly ProviderFailureKind[];
  } | null;
  readonly circuitBreaker: CircuitBreakerSpec | null;
}

/** Lo que llena la ventana del circuito: la tabla neutral (un 4xx, el circuito abierto o el token, no). */
const RECORDED: readonly ProviderFailureKind[] = ['transport', 'server-error', 'unknown-status'];

/**
 * Retry por fuera y circuito por dentro, el orden de resilience4j (Retry(CircuitBreaker(llamada))): cada
 * intento pasa por el circuito, y el circuito abierto NO se reintenta (no está entre los fallos que reintenta).
 */
export async function withResilience<T>(
  policy: OutboundPolicy,
  circuit: CircuitBreaker | null,
  action: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  const attempts = policy.retry?.maxAttempts ?? 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await guarded(circuit, action);
    } catch (error) {
      const kind = failureKind(error);
      if (policy.retry === null || attempt >= attempts || kind === null || !policy.retry.retries.includes(kind)) throw error;
      await sleep(retryWaitMs(attempt, policy.retry));
    }
  }
}

async function guarded<T>(circuit: CircuitBreaker | null, action: () => Promise<T>): Promise<T> {
  if (circuit === null) return action();
  if (!circuit.tryAcquire()) throw new CallNotPermittedError();
  try {
    const result = await action();
    circuit.record(false);
    return result;
  } catch (error) {
    const kind = failureKind(error);
    circuit.record(kind !== null && RECORDED.includes(kind));
    throw error;
  }
}

/** La espera ANTES del intento \`attempt + 1\`: la referencia \`retryWaitMs\` de keel-core. */
export function retryWaitMs(attempt: number, retry: NonNullable<OutboundPolicy['retry']>): number {
  if (retry.multiplier === null) return retry.initialDelayMs;
  const wait = retry.initialDelayMs * retry.multiplier ** Math.max(attempt - 1, 0);
  if (retry.maxDelayMs === null) return wait;
  return Number.isFinite(wait) && wait <= retry.maxDelayMs ? wait : retry.maxDelayMs;
}`
  );
}

function httpExchangeTs() {
  return tsModule(
    HTTP_EXCHANGE_TS,
    [
      { symbol: 'ProviderStatusError', from: PROVIDER_FAILURES_TS },
      { symbol: 'ProviderTransportError', from: PROVIDER_FAILURES_TS },
      { symbol: 'OutboundContractError', from: RESPONSE_READING_TS },
      { symbol: 'parseWireJson', from: WIRE_TS },
      { symbol: 'toWireJson', from: WIRE_TS }
    ],
    `/** Lo que un adaptador sabe de su proveedor: la URL, el timeout y las cabeceras de su autenticación. */
export interface ClientSettings {
  readonly id: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * La credencial que hay que ir a buscar antes de cada llamada (\`oauth2-client-credentials\`): la cabecera
   * \`Authorization\` ya armada. Si no se puede obtener, lanza un fallo \`auth-grant\` y la petición no sale.
   */
  readonly authorization?: () => Promise<string>;
}

export interface OutboundRequest {
  readonly method: string;
  /** La ruta del diseño, con sus variables entre llaves (\`/stock/reservations/{orderId}\`). */
  readonly path: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export interface OutboundResponse {
  readonly status: number;
  /** El cuerpo ya leído con el contrato del cable, o null si no trae. */
  readonly body: unknown;
}

/**
 * Un intento contra el proveedor. Clasifica el desenlace con la tabla neutral: sin respuesta (conexión,
 * timeout, DNS) es \`transport\`; un status que no es 2xx, el suyo; un cuerpo que no es JSON es un
 * OutboundContractError, que no es un fallo del proveedor.
 *
 * El timeout cubre el intento ENTERO (fetch no separa conexión de lectura): es el de lectura de keel-spring,
 * el mayor de las llamadas del cliente. Las redirecciones no se siguen, como el cliente del JDK por defecto.
 */
export async function exchange(client: ClientSettings, request: OutboundRequest): Promise<OutboundResponse> {
  const url = new URL(client.baseUrl.replace(/\\/+$/, '') + expandPath(request.path, request.params ?? {}));
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value == null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, plain(item));
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...client.headers };
  // Sin token no se sale: una llamada sin Authorization sería peor que ninguna (el socio la rechazaría y el
  // diagnóstico apuntaría a él). El fallo de la concesión ya es un \`auth-grant\` y lo atiende el fallback.
  if (client.authorization) headers['Authorization'] = await client.authorization();
  for (const [name, value] of Object.entries(request.headers ?? {})) if (value != null) headers[name] = plain(value);
  let payload: string | undefined;
  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = toWireJson(request.body);
  }
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, { method: request.method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(client.timeoutMs) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw new ProviderTransportError(\`\${client.id}: \${request.method} \${url.pathname} sin respuesta (\${describe(error)})\`, { cause: error });
  }
  if (status < 200 || status > 299) throw new ProviderStatusError(status, text);
  if (text.trim() === '') return { status, body: null };
  try {
    return { status, body: parseWireJson(text) };
  } catch {
    throw new OutboundContractError(\`\${client.id}: \${request.method} \${url.pathname} respondió \${status} con un cuerpo que no es JSON\`);
  }
}

/** La ruta con sus variables sustituidas y codificadas. Una variable sin valor es un bug: se lanza. */
export function expandPath(template: string, params: Readonly<Record<string, unknown>>): string {
  return template.replace(/\\{([^}]+)\\}/g, (_match, name: string) => {
    const value = params[name];
    if (value == null) throw new OutboundContractError(\`La ruta \${template} necesita \${name}\`);
    return encodeURIComponent(plain(value));
  });
}

function plain(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.cause instanceof Error ? \`\${error.name}: \${error.cause.message}\` : \`\${error.name}: \${error.message}\`) : String(error);
}`
  );
}

function responseReadingTs() {
  return tsModule(
    RESPONSE_READING_TS,
    [
      { symbol: 'Decimal', from: DECIMAL_TS, type: true },
      { symbol: 'RawJson', from: RAW_JSON_TS, type: true },
      { symbol: 'toDate', from: WIRE_TS },
      { symbol: 'toDecimal', from: WIRE_TS },
      { symbol: 'toInt', from: WIRE_TS },
      { symbol: 'toJson', from: WIRE_TS },
      { symbol: 'toLong', from: WIRE_TS },
      { symbol: 'toTimestamp', from: WIRE_TS }
    ],
    `/**
 * El proveedor —o nuestra petición— viola el contrato que declara el diseño. NO es «el proveedor no está»:
 * no entra al fallback ni cuenta para el circuito, y sale como 500 con su traza. Si entrara al fallback, el
 * llamante recibiría «proveedor no disponible» por algo que no es una caída, y contaría para cortar llamadas
 * a un proveedor que responde perfectamente. Es el mismo criterio que keel-spring.
 */
export class OutboundContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundContractError';
  }
}

type Reader<T> = (value: unknown, where: string) => T | null;
type EnumLike = Record<string, string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function convert<T>(type: string, conversion: (value: unknown) => T): Reader<T> {
  return (value, where) => {
    if (value == null) return null;
    try {
      return conversion(value);
    } catch {
      throw new OutboundContractError(\`\${where}: se esperaba un \${type}\`);
    }
  };
}

function bad(where: string, type: string): never {
  throw new OutboundContractError(\`\${where}: se esperaba un \${type}\`);
}

/** Los lectores de un campo de la respuesta: el contrato del cable de keel-core, con el error saliente. */
export const responseField = {
  string: ((value, where) => (value == null ? null : typeof value === 'string' ? value : bad(where, 'texto'))) as Reader<string>,
  boolean: ((value, where) => (value == null ? null : typeof value === 'boolean' ? value : bad(where, 'booleano'))) as Reader<boolean>,
  uuid: ((value, where) => (value == null ? null : typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : bad(where, 'uuid'))) as Reader<string>,
  int: convert('entero', toInt),
  long: convert('entero de 64 bits', toLong),
  decimal: convert('decimal', toDecimal) as Reader<Decimal>,
  timestamp: convert('instante ISO-8601 con zona', toTimestamp),
  date: convert('fecha YYYY-MM-DD', toDate),
  json: convert('documento JSON', toJson) as Reader<RawJson>,
  /** Un value object compuesto: keel-nest todavía no lo lee (la frontera lo rechaza en build). */
  unread: ((value) => value ?? null) as Reader<unknown>,
  enumOf<E extends EnumLike>(type: E): Reader<E[keyof E]> {
    const literals = new Set<string>(Object.values(type));
    return (value, where) => (value == null ? null : typeof value === 'string' && literals.has(value) ? (value as E[keyof E]) : bad(where, \`valor de \${Object.values(type).join('|')}\`));
  },
  listOf<T>(element: Reader<T>): Reader<T[]> {
    return (value, where) => (value == null ? null : Array.isArray(value) ? value.map((item, index) => element(item, \`\${where}[\${index}]\`) as T) : bad(where, 'lista'));
  }
};

/** El cuerpo como objeto JSON, o un OutboundContractError. */
export function responseObject(body: unknown, where: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new OutboundContractError(\`\${where}: la respuesta no es un objeto JSON\`);
  return body as Record<string, unknown>;
}

/** Un campo que el contrato declara obligatorio: presente, o un OutboundContractError. */
export function requiredField<T>(value: T | null, message: string): T {
  if (value == null) throw new OutboundContractError(message);
  return value;
}`
  );
}

function outboundIdempotencyTs(model) {
  const correlated = usesCorrelation(model);
  const imports = [{ symbol: 'CommandSignature', from: COMMAND_SIGNATURE_TS }];
  if (correlated) imports.push({ symbol: 'CorrelationContext', from: CORRELATION_TS });
  return tsModule(
    OUTBOUND_IDEMPOTENCY_TS,
    imports,
    `/**
 * La clave de idempotencia que ESTE servicio manda al proveedor, por llamada: la cara simétrica de la de
 * entrada. Un timeout no distingue «no llegó» de «llegó y se hizo», así que sin clave el reintento de una
 * escritura es una segunda ejecución.
 *
 * Lo que la hace útil es que el reintento produzca la MISMA clave: nada aleatorio ni dependiente del instante.
 */
export const OutboundIdempotency = {
  /** Clave por CONTENIDO: dos peticiones idénticas son la misma intención. */
  fromPayload(call: string, payload: unknown): string {
    return CommandSignature.of([call, payload]);
  },

  /**
   * Clave por CORRELACIÓN: el proveedor deduplica por intención de negocio, no por contenido. Sin correlación
   * abierta (un barrido, un arranque) cae a la firma del contenido: lo único estable que queda.
   */
  correlated(call: string, payload: unknown): string {
    ${correlated ? 'const correlationId = CorrelationContext.get();\n    return correlationId === null ? OutboundIdempotency.fromPayload(call, payload) : CommandSignature.of([call, correlationId]);' : '// Este servicio no abre correlación (ni API ni mensajería): solo queda la firma del contenido.\n    return OutboundIdempotency.fromPayload(call, payload);'}
  }
};`
  );
}
