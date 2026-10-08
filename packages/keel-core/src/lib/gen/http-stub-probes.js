// El vocabulario del PROVEEDOR DE PRUEBA (el WireMock de infra/, `HTTP_STUB` del catálogo): con qué se
// programa una respuesta, cómo se encadena una secuencia y cómo se lee lo que el servidor le mandó. Es el
// mismo para los dos arneses —el AbstractFlowIT de keel-spring y el flow.ts de keel-nest hablan con el mismo
// contenedor—, así que se decide aquí, como `mail-probes.js` para el buzón. Un arnés que escribiera `fault`
// con otro nombre o se olvidara de `Started` programaría mappings que el stub acepta y que no casan nunca:
// el escenario fallaría por el stub, y eso es indistinguible de un defecto del servicio.

import { HTTP_STUB } from './infra-catalog.js';

/** El admin API del stub, visto desde la máquina que corre las pruebas (el puerto publicado por el compose). */
export const HTTP_STUB_ADMIN = `http://localhost:${HTTP_STUB.publishedPort}/__admin`;

/** Los recursos del admin API que usan los arneses. Todos se invocan con POST y un cuerpo JSON. */
export const HTTP_STUB_ENDPOINTS = Object.freeze({
  mappings: '/mappings',
  count: '/requests/count',
  find: '/requests/find',
  reset: '/reset'
});

/** El corte de conexión antes de responder: lo que el servidor ve como fallo del transporte. */
export const HTTP_STUB_FAULT = 'CONNECTION_RESET_BY_PEER';

/** El estado inicial de un escenario de WireMock: el primer mapping de una secuencia lo exige. */
export const HTTP_STUB_INITIAL_STATE = 'Started';

/** Una respuesta normal del stub. `body` viaja como TEXTO: el stub no interpreta el JSON. */
export function stubOkResponse(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body) };
}

/** Una respuesta que tarda más de lo que la llamada tolera: `delayMs` tiene que superar su timeout. */
export function stubSlowResponse(delayMs) {
  return { status: 200, fixedDelayMilliseconds: delayMs, headers: { 'Content-Type': 'application/json' }, body: '{}' };
}

/** El corte de conexión, que no es una respuesta HTTP. */
export function stubFaultResponse() {
  return { fault: HTTP_STUB_FAULT };
}

/**
 * Un mapping: método, ruta (regex sobre el path, sin query) y la respuesta. Con `scenario`, el mapping solo
 * responde en `requiredState` y deja `nextState`, que es lo que encadena una secuencia.
 */
export function stubMapping({ method, pathPattern, response, scenario = null, requiredState = null, nextState = null }) {
  const mapping = {};
  if (scenario != null) {
    mapping.scenarioName = scenario;
    mapping.requiredScenarioState = requiredState;
    if (nextState != null) mapping.newScenarioState = nextState;
  }
  mapping.request = { method, urlPathPattern: pathPattern };
  mapping.response = response;
  return mapping;
}

/**
 * Los mappings de una SECUENCIA: respuestas distintas para llamadas sucesivas a la misma ruta, y la última se
 * queda pegada (una llamada de más vuelve a recibirla en vez de no casar con nada).
 */
export function stubSequenceMappings({ method, pathPattern, responses, scenario }) {
  let state = HTTP_STUB_INITIAL_STATE;
  return responses.map((response, index) => {
    const next = index === responses.length - 1 ? null : `${scenario}-${index + 1}`;
    const mapping = stubMapping({ method, pathPattern, response, scenario, requiredState: state, nextState: next });
    state = next;
    return mapping;
  });
}

/** El criterio con que se cuentan y se buscan las peticiones recibidas: los dos seleccionan las mismas. */
export function stubCriterion(method, pathPattern) {
  return { method, urlPathPattern: pathPattern };
}
