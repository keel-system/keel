// El arnés del PROVEEDOR DE PRUEBA (incremento 11d): los helpers con los que un flujo programa qué responde el
// WireMock de infra/ y lee lo que el servidor le mandó, y `ageForReconciliation`, que fabrica la precondición
// de un barrido de reconciliación. Los mismos que el AbstractFlowIT de keel-spring (`stubFor`, `stubFailure`,
// `stubConnectionFault`, `stubTimeout`, `stubSequence`, `stubCallCount`, `stubRequests`, …), con el vocabulario
// del stub de keel-core (`gen/http-stub-probes.js`): hablan con el mismo contenedor.
//
// `test/integration/support/http-stub.ts` no importa Nest ni vitest: solo `fetch`. Es lo que permite ejecutarlo
// en las pruebas de keel-nest contra un admin falso; `flow.ts` lo reexporta, y los flujos siguen importando
// solo de `flow.ts` (regla `flujos-caja-negra`).

import {
  HTTP_STUB_ADMIN,
  HTTP_STUB_ENDPOINTS,
  HTTP_STUB_FAULT,
  HTTP_STUB_INITIAL_STATE
} from 'keel-core/gen/http-stub-probes';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { snakeCase } from 'keel-core/gen';
import { tsString } from './render.js';
import { engineOf, usesRelational } from './persistence-entities.js';

export const HTTP_STUB_TS = 'test/integration/support/http-stub.ts';

/**
 * ¿Hay proveedor de prueba? Con clientes HTTP salientes y con la capa payments, cuya pasarela de prueba es el mismo
 * WireMock hablando el protocolo de la elegida. Como en keel-spring.
 */
export function usesHttpStub(model) {
  return Boolean((model.layersPresent?.httpClients && (model.httpClients ?? []).length > 0) || model.payments);
}

export function generate(model) {
  return usesHttpStub(model) ? [{ path: HTTP_STUB_TS, content: httpStubTs(model) }] : [];
}

/** Los nombres que flow.ts reexporta. */
export const HTTP_STUB_EXPORTS = [
  'StubResponse',
  'stubFor',
  'stubFailure',
  'stubConnectionFault',
  'stubTimeout',
  'stubSequence',
  'stubCallCount',
  'stubRequests',
  'stubRequestBody',
  'stubRequestHeader',
  'resetStubs'
];

function httpStubTs(model) {
  const clients = [...(model.httpClients ?? []).map((client) => client.id), ...(model.payments ? ['la pasarela de pago'] : [])].join(', ');
  return `/**
 * El proveedor de prueba: el WireMock de infra/docker-compose.yaml, al que apuntan las \`base-url\` de los
 * clientes salientes en el perfil \`local\` (${clients}). Cada flujo programa en su Given lo que responde, y el
 * reset de estado (\`resetState()\`, al empezar cada flujo) lo deja como recién arrancado: un mapping que
 * sobrevive a su escenario es estado global, y el orden de ejecución decidiría el resultado.
 *
 * Los mismos helpers que el arnés de keel-spring, con el vocabulario del stub de keel-core. Se importan de
 * flow.ts, nunca de aquí.
 */

/** El admin API del stub (o \`HTTP_STUB_ADMIN\` del entorno). */
const STUB_ADMIN = process.env.HTTP_STUB_ADMIN ?? ${tsString(HTTP_STUB_ADMIN)};

/** Una respuesta programada, para \`stubSequence\`. Las cuatro formas son las de los helpers de un disparo. */
export const StubResponse = {
  /** Respuesta normal, con su cuerpo (un objeto se serializa; un texto viaja tal cual). */
  ok: (status: number, body?: unknown): object => okBody(status, body),
  /** Fallo sin cuerpo útil: un 5xx es reintentable si el diseño lo dice; un 4xx nunca. */
  failure: (status: number): object => okBody(status, {}),
  /** No contesta a tiempo: \`delayMs\` tiene que superar el \`timeoutMs\` de la llamada. */
  timeout: (delayMs: number): object => ({ status: 200, fixedDelayMilliseconds: delayMs, headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  /** Corta la conexión antes de responder: el servidor lo ve como fallo del transporte. */
  connectionFault: (): object => ({ fault: ${tsString(HTTP_STUB_FAULT)} })
};

/**
 * Programa qué responde el proveedor en ESTE escenario: método, ruta (regex sobre el path, sin query) y la
 * respuesta que verá el servidor.
 */
export async function stubFor(method: string, pathPattern: string, status: number, body?: unknown): Promise<void> {
  await stubMapping(method, pathPattern, okBody(status, body));
}

/** Fallo del proveedor sin cuerpo útil: lo que ejercita el fallback declarado y el circuito. */
export async function stubFailure(method: string, pathPattern: string, status: number): Promise<void> {
  await stubMapping(method, pathPattern, StubResponse.failure(status));
}

/**
 * El proveedor NO contesta: corta la conexión. No es un 5xx, y la diferencia la declara el diseño: una llamada
 * con \`retryOn: [timeout, connection]\` no reintenta un 500 y sí reintenta esto.
 */
export async function stubConnectionFault(method: string, pathPattern: string): Promise<void> {
  await stubMapping(method, pathPattern, StubResponse.connectionFault());
}

/** El proveedor tarda más de lo tolerado (\`retryOn: [timeout]\`): \`delayMs\` por encima del \`timeoutMs\` de la llamada. */
export async function stubTimeout(method: string, pathPattern: string, delayMs: number): Promise<void> {
  await stubMapping(method, pathPattern, StubResponse.timeout(delayMs));
}

/** Las rutas con secuencia ya programada en este flujo. \`resetStubs()\` lo vacía. */
const SEQUENCED = new Set<string>();

/**
 * Respuestas DISTINTAS para llamadas sucesivas a la misma ruta: lo que hace escribible un escenario de
 * REINTENTO («falla la primera, responde la segunda, y las dos llevan la misma clave de idempotencia»). La
 * última se queda pegada. Una ruta admite UNA secuencia por flujo: la segunda encadenaría desde un estado que
 * la primera dejó atrás.
 *
 *   await stubSequence('DELETE', '/stock/reservations/.*', StubResponse.connectionFault(), StubResponse.ok(200, { cancelled: true }));
 *   // …la acción que dispara la llamada…
 *   const requests = await stubRequests('DELETE', '/stock/reservations/.*');
 *   expect(requests).toHaveLength(2);
 *   expect(stubRequestHeader(requests[0], 'Idempotency-Key')).toBe(stubRequestHeader(requests[1], 'Idempotency-Key'));
 */
export async function stubSequence(method: string, pathPattern: string, ...responses: object[]): Promise<void> {
  if (responses.length < 2) {
    throw new Error('stubSequence con menos de dos respuestas no es una secuencia: para una sola usa stubFor, stubFailure, stubTimeout o stubConnectionFault');
  }
  const key = \`\${method} \${pathPattern}\`;
  if (SEQUENCED.has(key)) {
    throw new Error(\`ya hay una secuencia programada para \${key} en este flujo: la segunda encadenaría desde un estado que la primera dejó atrás. Programa una sola.\`);
  }
  SEQUENCED.add(key);
  const scenario = \`seq-\${hash(key)}\`;
  let state: string | null = ${tsString(HTTP_STUB_INITIAL_STATE)};
  for (let index = 0; index < responses.length; index++) {
    const next = index === responses.length - 1 ? null : \`\${scenario}-\${index + 1}\`;
    await stubMapping(method, pathPattern, responses[index]!, { scenario, requiredState: state!, nextState: next });
    state = next;
  }
}

/** Cuántas veces llamó el servidor al proveedor a esa ruta. */
export async function stubCallCount(method: string, pathPattern: string): Promise<number> {
  const response = (await stubAdmin(${tsString(HTTP_STUB_ENDPOINTS.count)}, criterion(method, pathPattern))) as { count: number };
  return response.count;
}

/** Una petición que recibió el proveedor, tal como la registra. */
export interface StubRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** Las peticiones que recibió el proveedor a esa ruta: QUÉ se le mandó, no solo cuántas veces. */
export async function stubRequests(method: string, pathPattern: string): Promise<StubRequest[]> {
  const response = (await stubAdmin(${tsString(HTTP_STUB_ENDPOINTS.find)}, criterion(method, pathPattern))) as { requests: StubRequest[] };
  return response.requests;
}

/** El cuerpo que viajó en esa petición, como JSON. */
export function stubRequestBody(request: StubRequest): any {
  return request.body === '' ? null : JSON.parse(request.body);
}

/** Una cabecera de esa petición, sin distinguir mayúsculas (el caso lo decide el cliente HTTP). null si no la llevaba. */
export function stubRequestHeader(request: StubRequest, name: string): string | null {
  const found = Object.entries(request.headers).find(([header]) => header.toLowerCase() === name.toLowerCase());
  return found === undefined ? null : String(found[1]);
}

/**
 * Un mapping con el criterio y la respuesta ya escritos en el vocabulario del stub (cuerpo o query que tienen
 * que contener algo). No se reexporta a los flujos: lo usa el arnés de la pasarela de pago (payment-gateway.ts).
 */
export async function stubRawMapping(request: object, response: object): Promise<void> {
  await stubAdmin(${tsString(HTTP_STUB_ENDPOINTS.mappings)}, { request, response });
}

/** Borra los mappings, el log de peticiones y las secuencias. Lo hace el reset de cada flujo. */
export async function resetStubs(): Promise<void> {
  SEQUENCED.clear();
  await stubAdmin(${tsString(HTTP_STUB_ENDPOINTS.reset)}, {});
}

/** Olvida las secuencias del flujo anterior (el stub ya lo vació \`infra/reset-db.sh\`). */
export function forgetSequences(): void {
  SEQUENCED.clear();
}

function okBody(status: number, body: unknown): object {
  return { status, headers: { 'Content-Type': 'application/json' }, body: body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body) };
}

function criterion(method: string, pathPattern: string): object {
  return { method, urlPathPattern: pathPattern };
}

async function stubMapping(
  method: string,
  pathPattern: string,
  response: object,
  sequence?: { scenario: string; requiredState: string; nextState: string | null }
): Promise<void> {
  const mapping: Record<string, unknown> = {};
  if (sequence) {
    mapping.scenarioName = sequence.scenario;
    mapping.requiredScenarioState = sequence.requiredState;
    if (sequence.nextState != null) mapping.newScenarioState = sequence.nextState;
  }
  mapping.request = { method, urlPathPattern: pathPattern };
  mapping.response = response;
  await stubAdmin(${tsString(HTTP_STUB_ENDPOINTS.mappings)}, mapping);
}

async function stubAdmin(path: string, body: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(STUB_ADMIN + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(\`No se pudo hablar con el proveedor de prueba en \${STUB_ADMIN}. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh) — \${String(error)}\`);
  }
  const text = await response.text();
  if (response.status >= 300) throw new Error(\`El proveedor de prueba rechazó \${path} (HTTP \${response.status}): \${text}\`);
  return text === '' ? {} : JSON.parse(text);
}

function hash(text: string): string {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return (value >>> 0).toString(16);
}
`;
}

// ─── ageForReconciliation, en flow.ts (usa db()) ─────────────────────────────

/** Las tablas y marcas de espera de cada activación con barrido. */
function agingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        if (!target.table || !target.awaitingField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push(target);
      }
    }
  }
  // El barrido de la capa payments no es un `reconciledBy` de activations, pero su condición de entrada es la
  // misma —la marca de espera del cobro, rancia— y tampoco se alcanza de otra forma. La clave es el nombre del
  // barrido, como en keel-spring.
  const payments = model.payments;
  if (payments?.reconciliation?.sweep && payments.record?.awaitingSince) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === payments.record.entity);
    if (entity?.tableName) {
      if (!targets.has(payments.reconciliation.sweep)) targets.set(payments.reconciliation.sweep, []);
      targets.get(payments.reconciliation.sweep).push({ table: entity.tableName, awaitingField: payments.record.awaitingSince });
    }
  }
  return targets;
}

/**
 * La sección de flow.ts con `ageForReconciliation`. Mismo criterio que keel-spring: sin los literales del
 * motor (`staleTimestamp`, `uuidLiteral`) no se emite — un UPDATE que no casa dejaría el escenario verde sin
 * haber envejecido nada—. Necesita `db()` e `idLiteral()`, que flow.ts ya tiene con base relacional.
 */
export function reconciliationAgingSection(model, { idLiteralDeclared }) {
  if (!usesRelational(model)) return '';
  const entry = DATABASES[engineOf(model)];
  if (!entry?.staleTimestamp || !entry?.uuidLiteral || !entry?.cliQueryArgv) return '';
  const targets = agingTargets(model);
  if (targets.size === 0) return '';
  const known = [...targets.keys()].join(', ');
  const rows = [...targets]
    .map(([name, list]) => `  ${tsString(name)}: [${list.map((target) => tsString(`UPDATE ${target.table} SET ${snakeCase(target.awaitingField)} = ${entry.staleTimestamp} WHERE id = `)).join(', ')}]`)
    .join(',\n');
  const idLiteral = idLiteralDeclared
    ? ''
    : `
function idLiteral(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(\`No es un id: '\${id}'\`);
  return ${tsString(entry.uuidLiteral.prefix)} + id + ${tsString(entry.uuidLiteral.suffix)};
}
`;
  return `
/** Las marcas de espera que envejece \`ageForReconciliation\`, por activación: ${known}. */
const RECONCILIATION_AGING: Readonly<Record<string, readonly string[]>> = {
${rows}
};
${idLiteral}
/**
 * Deja la marca de espera de \`activation\` infinitamente rancia para la fila \`id\`, de modo que el barrido la
 * tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron, como en producción—: crea la condición
 * que busca («lleva esperando más de lo tolerado») sin esperar el plazo real, y solo para esta fila. Bajar el
 * umbral por configuración sería global y se llevaría las filas de los demás escenarios.
 *
 *   ageForReconciliation(${tsString([...targets.keys()][0])}, id);
 *   await eventually(async () => (await flow.get(\`\${ROUTE_BASE}/…/\${id}\`)).json().status === '…', 90_000);
 *
 * Deja margen para un tick del cron.
 */
export function ageForReconciliation(activation: string, id: string): void {
  const statements = RECONCILIATION_AGING[activation];
  if (statements == null) throw new Error(\`No hay barrido para la activación '\${activation}'. Las que lo tienen: ${known}\`);
  for (const statement of statements) db(statement + idLiteral(id));
}
${
    entry.heldTimestamp
      ? `
/** Las marcas de espera que retiene \`holdFromReconciliation\`, por activación. */
const RECONCILIATION_HOLDING: Readonly<Record<string, readonly string[]>> = {
${[...targets]
  .map(([name, list]) => `  ${tsString(name)}: [${list.map((target) => tsString(`UPDATE ${target.table} SET ${snakeCase(target.awaitingField)} = ${entry.heldTimestamp} WHERE id = `)).join(', ')}]`)
  .join(',\n')}
};

/**
 * El inverso de \`ageForReconciliation\`: deja la marca de espera de \`activation\` en el FUTURO para la fila \`id\`, de
 * modo que el barrido NO la tome aunque pasen sus ciclos. Es la palanca de un escenario que pide «lo que acaba de
 * entrar en vuelo no se toca»: con el umbral de prueba en segundos y el cron en minutos, sin ella esa fila también
 * estaría rancia cuando llegue el ciclo, y el escenario no sería determinista.
 *
 *   ageForReconciliation(${tsString([...targets.keys()][0])}, atascado);
 *   holdFromReconciliation(${tsString([...targets.keys()][0])}, recienEnVuelo);
 */
export function holdFromReconciliation(activation: string, id: string): void {
  const statements = RECONCILIATION_HOLDING[activation];
  if (statements == null) throw new Error(\`No hay barrido para la activación '\${activation}'. Las que lo tienen: ${known}\`);
  for (const statement of statements) db(statement + idLiteral(id));
}
`
      : ''
  }`;
}
