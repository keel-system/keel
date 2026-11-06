// Las peticiones con las que la prueba EMITIDA de la API ejercita el contrato, elegidas del DISEÑO: una
// operación que llega a su handler, un cuerpo que no es JSON, uno que incumple lo declarado, un uuid de ruta mal
// formado, un camino que existe con otro método y una subida multipart. Si un caso no tiene operación que lo
// ejercite no se devuelve, en vez de inventar una ruta.
//
// Es la misma elección en todos los generadores (la prueba de keel-nest y la de keel-dotnet piden lo mismo al
// mismo diseño); estaba dentro de keel-nest (incremento 5a de PLAN-KEEL-DOTNET.md). Lo único que depende del
// generador son los COMPONENTES del mensaje de cada operación (con persistencia, keel-nest lee la página como un
// Pageable), y por eso entran por parámetro.

import { requestShape } from './api-contract.js';
import { IDEMPOTENCY_HEADER } from './request-idempotency.js';
import { ETAG_HEADER, IF_MATCH_CASES, conditionalWrite, conditionalWriteErrors, conditionalWritePolicy, conditionalWritesOf, usesConditionalWrites } from './conditional-writes.js';

/** El uuid de muestra de un parámetro de ruta. */
export const SAMPLE_UUID = '0192f1d2-0000-7000-8000-000000000001';

/** La clave de muestra con la que la subida completa llega al handler de una operación con `keySource: client-key`. */
export const SAMPLE_IDEMPOTENCY_KEY = 'keel-muestra-0192f1d2';

const routed = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route && !op.multipart);
const fullPath = (model, path) => `${model.api.routeBase}${path}`;
const hasRule = (field, name) => (field.inputValidation ?? []).some((rule) => rule.rule === name);

/** Un valor de muestra para un parámetro de ruta, o null si no hay uno que seguro pase su regla. */
export function sampleValue(param) {
  if (hasRule(param, 'pattern') || hasRule(param, 'min') || hasRule(param, 'max') || param.list) return null;
  if (param.kind === 'enum') return null;
  return { uuid: SAMPLE_UUID, int: '1', long: '1', string: 'abc', text: 'abc' }[param.base] ?? null;
}

/** La URL de la operación con sus parámetros de ruta rellenos de muestra, o null si alguno no la tiene. */
export function concretePath(model, operation) {
  let path = fullPath(model, operation.route.path);
  for (const param of operation.pathParams ?? []) {
    const value = sampleValue(param);
    if (value == null) return null;
    path = path.replace(`{${param.name}}`, value);
  }
  return path;
}

/**
 * Los casos que el diseño permite ejercitar, cada uno con su petición. `components(operation)` son los
 * componentes del mensaje de la operación en el generador (ruta, cuerpo y paginación).
 */
export function apiCases(model, { components }) {
  // Las peticiones de estos casos no llevan If-Match: una escritura condicional con `required` respondería 428 antes que
  // cualquier 400 (D3 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md), así que no sirve de sujeto. Sí cuenta para el 405, que
  // mira qué métodos sirve un camino.
  const exempt = (operation) => conditionalWritePolicy(model) === 'required' && Boolean(conditionalWrite(model, operation));
  const all = routed(model);
  const operations = all.filter((operation) => !exempt(operation));
  const cases = {};
  // Llega al handler: sin campos obligatorios fuera de la ruta y sin cuerpo.
  for (const operation of operations) {
    const fromPath = new Set((operation.pathParams ?? []).map((p) => p.name));
    const own = components(operation);
    const required = own.filter((c) => !fromPath.has(c.name) && c.required && !['page', 'size'].includes(c.name));
    const url = concretePath(model, operation);
    if (required.length === 0 && url && !requestShape(operation).asBody && !own.some((c) => c.resolvedIdentity)) {
      cases.reachesHandler = { method: operation.route.method, url, operation: operation.name };
      break;
    }
  }
  const bodyOp = operations.find((op) => requestShape(op).asBody && concretePath(model, op));
  if (bodyOp) cases.malformedBody = { method: bodyOp.route.method, url: concretePath(model, bodyOp) };
  for (const operation of operations) {
    const { asBody, bodyRequired } = requestShape(operation);
    // La identidad del llamante no viaja en el cuerpo (la resuelve la seguridad): no sirve de caso.
    if ((operation.bodyFields ?? []).some((f) => f.resolvedIdentity)) continue;
    const field = (operation.bodyFields ?? []).find((f) => hasRule(f, 'notBlank') || hasRule(f, 'notNull'));
    const url = concretePath(model, operation);
    if (asBody && bodyRequired && field && url) {
      cases.invalidBody = { method: operation.route.method, url, field: field.name, message: hasRule(field, 'notBlank') ? 'must not be blank' : 'must not be null' };
      break;
    }
  }
  for (const operation of operations) {
    const param = (operation.pathParams ?? []).find((p) => p.base === 'uuid' && !p.list);
    if (!param) continue;
    let url = fullPath(model, operation.route.path).replace(`{${param.name}}`, 'no-es-un-uuid');
    let ok = true;
    for (const other of (operation.pathParams ?? []).filter((p) => p !== param)) {
      const value = sampleValue(other);
      if (value == null) ok = false;
      else url = url.replace(`{${other.name}}`, value);
    }
    if (ok) {
      cases.malformedPath = { method: operation.route.method, url };
      break;
    }
  }
  // 405: un camino que existe, con un método que ninguna operación sirve en él.
  for (const operation of operations) {
    const url = concretePath(model, operation);
    if (!url) continue;
    const served = new Set(all.filter((op) => op.route.path === operation.route.path).map((op) => op.route.method));
    const other = ['DELETE', 'PUT', 'PATCH', 'POST', 'GET'].find((method) => !served.has(method));
    if (other) {
      cases.wrongMethod = { method: other, url };
      break;
    }
  }
  // La subida: la primera operación multipart con una ruta concreta y campos de los que hay muestra segura.
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route && op.multipart && !exempt(op))) {
    const url = concretePath(model, operation);
    if (!url) continue;
    const fromPath = new Set((operation.pathParams ?? []).map((p) => p.name));
    const own = components(operation).filter((c) => !fromPath.has(c.name) && !c.resolvedIdentity);
    const file = own.find((c) => c.file && c.required);
    if (!file) continue;
    const fields = {};
    let sampled = true;
    for (const component of own.filter((c) => !c.file && c.required)) {
      const value = sampleValue(component);
      if (value == null || hasRule(component, 'minLength') || hasRule(component, 'size')) sampled = false;
      else fields[component.name] = value;
    }
    // El primer obligatorio, en el orden del mensaje: es el que el servidor echa en falta primero.
    const first = own.find((c) => c.required);
    // Con `client-key` el handler rechaza una petición sin la cabecera si el diseño la exige (OBL-IDEM-KEY-REQUIRED). Solo
    // lo usa keel-go, cuya prueba ejecuta el handler sin base: la de keel-nest y keel-dotnet no llega a él, porque su
    // mediator abre antes la transacción, y sale 500 con o sin la cabecera (medido sobre catalog).
    const idempotencyKey = operation.idempotency?.keySource === 'client-key' ? { name: IDEMPOTENCY_HEADER, value: SAMPLE_IDEMPOTENCY_KEY } : null;
    cases.upload = { url, part: file.name, fields: sampled ? fields : null, firstMissing: first.file ? { part: first.name } : { parameter: first.name }, idempotencyKey };
    break;
  }
  return cases;
}

/**
 * Las peticiones con las que la prueba emitida ejercita la SEGURIDAD de la API (`plan`, el de access-plan.js), las
 * mismas en todos los generadores:
 *   · `protectedPath`: un camino que no existe, cuando el cierre de la cadena principal exige credencial. Sin ella es
 *     401 y no 404, porque la seguridad decide antes de enrutar;
 *   · `forbidden`: la PRIMERA regla que exige authorities, sobre una operación de la que hay URL concreta, para pedirla
 *     con una credencial válida sin ninguna (403). null si ninguna regla la tiene.
 */
export function securityCases(model, plan) {
  if (!plan || plan.open) return null;
  const main = plan.chains[plan.chains.length - 1];
  const protectedPath = main.fallback.kind !== 'public' ? fullPath(model, '/keel-ruta-que-no-existe') : null;
  const withRoute = (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route);
  let forbidden = null;
  for (const rule of plan.chains.flatMap((chain) => chain.rules)) {
    if (rule.requirement.kind !== 'anyOf' || !rule.method) continue;
    // Cualquier operación con ruta, multipart incluida: la seguridad decide antes de enrutar, así que la regla responde
    // 403 aunque el endpoint no se sirva.
    const operation = withRoute.find((op) => op.route.method === rule.method && fullPath(model, op.route.path) === rule.path);
    const url = operation ? concretePath(model, operation) : null;
    if (!url) continue;
    forbidden = { method: rule.method, url, authorities: rule.requirement.authorities };
    break;
  }
  return { protectedPath, forbidden, notFound: fullPath(model, '/keel-ruta-que-no-existe') };
}

/**
 * Las peticiones con las que la prueba emitida ejercita la ESCRITURA CONDICIONAL (CW-6 a CW-10, conditional-writes.js),
 * las mismas en los cuatro generadores, o null si el diseño no la declara:
 *   · `write`: la primera escritura condicional con URL concreta, o null si ninguna la tiene. Sin If-Match y con `required` es un 428 que sale en el
 *     borde (D3), así que no hace falta un cuerpo válido (CW-6); y es la que recibe los casos de la cabecera (CW-7);
 *   · `reader`: la primera lectura que da el ETag con URL concreta (CW-10), o null;
 *   · `required`: si la política exige la cabecera;
 *   · `headerCases`: los casos del cable (`wire.js`); `errors`: el code, el status y los textos del 412 y del 428 (CW-8);
 *   · `exposedHeader`: la cabecera que CORS tiene que exponer (CW-9).
 */
export function conditionalWriteCases(model) {
  if (!usesConditionalWrites(model)) return null;
  const operations = (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route);
  const requestOf = (operation) => {
    const url = operation ? concretePath(model, operation) : null;
    return url ? { method: operation.route.method, url, operation: operation.name } : null;
  };
  // Solo CW-6 necesita la URL de una escritura; sin muestra segura de su ruta (un `pattern`), los demás casos siguen.
  const write = conditionalWritesOf(model).writes.map((entry) => requestOf(operations.find((op) => op.name === entry.name))).find(Boolean) ?? null;
  const reader = conditionalWritesOf(model).readers.map((entry) => requestOf(operations.find((op) => op.name === entry.name))).find(Boolean) ?? null;
  return {
    write,
    reader,
    required: conditionalWritePolicy(model) === 'required',
    headerCases: IF_MATCH_CASES,
    errors: conditionalWriteErrors(model),
    exposedHeader: ETAG_HEADER
  };
}
