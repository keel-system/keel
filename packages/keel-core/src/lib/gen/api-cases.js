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

/** El uuid de muestra de un parámetro de ruta. */
export const SAMPLE_UUID = '0192f1d2-0000-7000-8000-000000000001';

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
  const operations = routed(model);
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
    const served = new Set(operations.filter((op) => op.route.path === operation.route.path).map((op) => op.route.method));
    const other = ['DELETE', 'PUT', 'PATCH', 'POST', 'GET'].find((method) => !served.has(method));
    if (other) {
      cases.wrongMethod = { method: other, url };
      break;
    }
  }
  // La subida: la primera operación multipart con una ruta concreta y campos de los que hay muestra segura.
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? []).filter((op) => op.route && op.multipart)) {
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
    cases.upload = { url, part: file.name, fields: sampled ? fields : null, firstMissing: first.file ? { part: first.name } : { parameter: first.name } };
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
