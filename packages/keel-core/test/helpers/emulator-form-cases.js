// Los casos de la PETICIÓN que el arnés de cada generador manda al emulador del proveedor (incremento 4.3 de
// PLAN-PROVEEDOR-IDENTIDAD.md). `emulator-check` mide que el emulador da el token pedido con la petición de referencia
// (`emulatorPersonaForm`, `emulatorScopedForm`); esto mide la otra mitad: que el `tokenAs` y el `tokenWithScope` EMITIDOS,
// ejecutados en su lenguaje con el transporte sustituido por uno que devuelve el formulario, mandan esa misma petición.
// Un parámetro que no casa no falla en el emulador: da un token válido sin los claims (T1), así que esta es la red.
//
// Fuera de `test/*.test.js` a propósito: lo importan las redes de los cuatro generadores.

import { credentialClientId } from '../../src/lib/gen/identity-providers.js';
import {
  EMULATOR_MAX_SCOPE_VALUES,
  EMULATOR_PERSONA_CLAIM_UNKNOWN,
  EMULATOR_SCOPE_VALUES_EXCEEDED,
  emulatorPersonaClaims,
  emulatorPersonaForm,
  emulatorScopedForm,
  TEST_USER_PASSWORD,
  userTestClient
} from '../../src/lib/gen/identity-realm.js';

/** El `Integer.toHexString(String.hashCode())` de Java: la huella del titular, la misma en los cuatro arneses. */
export function javaStringHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

/** El nombre determinista del titular de `tokenWithScope(role, ...values)`. */
export function scopedHolder(role, values) {
  return `scoped-${role}-${javaStringHash([...new Set(values)].sort().join('\n'))}`;
}

/** Lo que el arnés añade siempre al formulario: el password grant del cliente de usuario. */
function base(model, username) {
  return {
    grant_type: 'password',
    client_id: credentialClientId(model.stack.auth, userTestClient(model)),
    username,
    password: TEST_USER_PASSWORD
  };
}

/** El formulario esperado, o el motivo con el que la referencia lo rechaza (el mismo que tiene que dar el arnés). */
function expectation(run, reason) {
  try {
    return { form: run() };
  } catch (error) {
    if (!error.message.endsWith(reason)) throw error;
    return { error: reason };
  }
}

/**
 * Los casos para un diseño: `{ id, kind: 'persona', sub, role, claims }` o `{ id, kind: 'scoped', role, values }`, cada uno
 * con `form` (el formulario esperado, como objeto) o `error` (el motivo del rechazo, sin el prefijo con el nombre).
 * Solo los de la capacidad que el diseño usa: personas con `personaTokenMechanism`, titulares con `scopedTokenMechanism`.
 */
export function emulatorFormCases(model, { persona, scoped }) {
  const cases = [];
  if (persona) {
    const [claim] = emulatorPersonaClaims(model);
    const shapes = [
      ['EMU-F-1', 'ana', null, {}],
      ['EMU-F-2', 'ops-1', 'operator', {}],
      ['EMU-F-3', 'bob & co=1+ñ', null, {}],
      ...(claim
        ? [
            ['EMU-F-4', 'ana', null, { [claim]: 'Bob@x.io' }],
            ['EMU-F-5', 'ana', 'operator', { [claim]: 'a b&c=d' }],
            // Un claim QUITADO: el token de la forma sin él, igual que no nombrarlo.
            ['EMU-F-6', 'ana', null, { [claim]: null }]
          ]
        : []),
      ['EMU-F-7', 'ana', null, { 'not-a-design-claim': 'x' }]
    ];
    for (const [id, sub, role, claims] of shapes) {
      const outcome = expectation(() => ({ ...base(model, sub), ...emulatorPersonaForm(model, sub, claims, role) }), EMULATOR_PERSONA_CLAIM_UNKNOWN);
      cases.push({ id, kind: 'persona', sub, role, claims, ...outcome });
    }
  }
  if (scoped) {
    const role = scoped.role;
    const arities = [
      ['EMU-F-8', []],
      ['EMU-F-9', ['MAIN']],
      // Repetidos y desordenados: el arnés los deja distintos y en orden, como la referencia.
      ['EMU-F-10', ['ZETA', 'ALPHA', 'ZETA']],
      ['EMU-F-11', Array.from({ length: EMULATOR_MAX_SCOPE_VALUES }, (_, i) => `V${i}`)],
      ['EMU-F-12', Array.from({ length: EMULATOR_MAX_SCOPE_VALUES + 1 }, (_, i) => `V${i}`)]
    ];
    for (const [id, values] of arities) {
      const user = scopedHolder(role, values);
      const outcome = expectation(() => ({ ...base(model, user), ...emulatorScopedForm(user, role, values) }), EMULATOR_SCOPE_VALUES_EXCEEDED);
      cases.push({ id, kind: 'scoped', role, values, ...outcome });
    }
  }
  return cases;
}

/**
 * Compara lo que devolvió el arnés para un caso (`{ form: '<x-www-form-urlencoded>' }` o `{ error: '<mensaje>' }`) con lo
 * esperado. Devuelve null si casa, o el motivo.
 */
export function compareEmulatorForm(expected, actual) {
  if (expected.error) {
    if (actual.form !== undefined) return `esperaba el rechazo «${expected.error}» y mandó ${actual.form}`;
    return actual.error.includes(expected.error) ? null : `rechazo distinto: ${actual.error}`;
  }
  if (actual.form === undefined) return `rechazó: ${actual.error}`;
  const got = {};
  for (const [name, value] of new URLSearchParams(actual.form)) {
    if (name in got) return `parámetro repetido: ${name}`;
    got[name] = value;
  }
  const want = Object.fromEntries(Object.entries(expected.form).map(([name, value]) => [name, String(value)]));
  const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].sort();
  const diff = keys.filter((key) => got[key] !== want[key]).map((key) => `${key}: ${JSON.stringify(got[key])} ≠ ${JSON.stringify(want[key])}`);
  return diff.length > 0 ? diff.join('; ') : null;
}

/**
 * Los sabotajes de la red, los mismos en los cuatro generadores (cada uno rompe su arnés a su manera, conservando la
 * forma): verde significa que caen en EXACTAMENTE estos casos, de los que el diseño tenga.
 *   · persona-shape: la forma de una persona sin rol se escribe con otro nombre; el emulador no encuentra su mapping.
 *   · scope-unsorted: los valores del alcance viajan en el orden en que llegan; otro titular y otro orden.
 */
export const EMULATOR_FORM_SABOTAGES = {
  'persona-shape': ['EMU-F-1', 'EMU-F-3', 'EMU-F-4', 'EMU-F-6'],
  'scope-unsorted': ['EMU-F-10']
};

/**
 * El veredicto de una pasada: `results` es `{ [id]: { form } | { error } }`. Sin sabotaje, verde si casan todos; con él,
 * verde si fallan exactamente sus casos. Devuelve `{ ok, lines }`.
 */
export function judgeEmulatorForms(label, cases, results, sabotage = null) {
  const lines = [];
  const failed = [];
  for (const expected of cases) {
    const actual = results[expected.id];
    const problem = actual ? compareEmulatorForm(expected, actual) : 'el arnés no devolvió nada';
    if (problem) failed.push(expected.id);
    lines.push(`  ${problem ? '✗' : '✓'} ${expected.id} ${expected.kind}${problem ? `: ${problem}` : ''}`);
  }
  const ids = new Set(cases.map((c) => c.id));
  const wanted = sabotage ? EMULATOR_FORM_SABOTAGES[sabotage].filter((id) => ids.has(id)) : [];
  const ok = wanted.length === failed.length && wanted.every((id) => failed.includes(id));
  lines.unshift(`${label}: ${sabotage ? `sabotaje ${sabotage}, esperaba ${wanted.join(', ') || '(ninguno: el diseño no lo cubre)'} y cayeron ${failed.join(', ') || 'ninguno'}` : `${cases.length - failed.length}/${cases.length}`}`);
  return { ok, lines };
}
