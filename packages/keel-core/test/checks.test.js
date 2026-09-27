// El catálogo de comprobaciones mecánicas y su acoplamiento con `crossrefs.js`.
//
// Tres propiedades, y las tres existen por un fallo concreto:
//
//   - Integridad del catálogo: una entrada sin `closes` es un hallazgo que nombra un
//     problema y deja al lector igual de parado que el mensaje genérico que sustituye.
//   - Coherencia hallazgo ↔ catálogo: la severidad la decide el catálogo, no el sitio
//     donde se emite. Con dos fuentes, la que se lee al inventariar y la que bloquea la
//     generación acaban diciendo cosas distintas.
//   - El RATCHET: `crossrefs.js` llegó a tener 216 hallazgos heredados sin id. Los avisos
//     migraron en una tanda dedicada (R5 de recomendaciones-diseno.md) y ya no queda ninguno;
//     los 134 errores migran por oportunidad, porque ya bloquean — y lo único que impide que
//     los dos números vuelvan a subir es este test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, checkFor, checkIds } from '../src/lib/checks.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

const crossrefsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'crossrefs.js'
);

test('toda comprobación declara lo que la CLI necesita para reportarla', () => {
  for (const [id, entry] of Object.entries(CHECKS)) {
    assert.match(id, /^CHK-[A-Z]+-[A-Z0-9-]+$/, `${id}: el id no sigue CHK-<ÁMBITO>-<NOMBRE>`);
    assert.ok(entry.title?.length > 10, `${id}: sin título`);
    // Sin `closes`, el hallazgo nombra el problema y no dice cómo se cierra, que es
    // exactamente el mensaje genérico contra el que existe todo esto.
    assert.ok(entry.closes?.length > 10, `${id}: no dice cómo se cierra`);
    assert.ok(['error', 'warning'].includes(entry.severity), `${id}: severidad desconocida`);
    assert.ok(entry.layer?.length > 2, `${id}: sin capa`);
  }
});

test('checkFor solo conoce los ids del catálogo', () => {
  assert.equal(checkFor('CHK-QUE-NO-EXISTE'), undefined);
  assert.equal(checkIds().length, Object.keys(CHECKS).length);
});

test('crossrefs no puede emitir un id que el catálogo no tenga', () => {
  // La garantía se comprueba desde fuera: `record` lanza, y eso es lo que impide que
  // aparezca un hallazgo que nadie puede citar ni contar. Se ejercita a través de una
  // comprobación real cuyo id se retira del catálogo en caliente.
  const entry = CHECKS['CHK-HTTP-NO-TIMEOUT'];
  delete CHECKS['CHK-HTTP-NO-TIMEOUT'];
  try {
    assert.throws(
      () =>
        checkCrossRefs({
          layers: {
            domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true } } } } },
            'use-cases': {},
            'http-clients': { clients: { pricing: { purpose: 'x', calls: { getPrice: { contract: 'GET /p' } } } } }
          }
        }),
      /no está en el catálogo de checks/
    );
  } finally {
    CHECKS['CHK-HTTP-NO-TIMEOUT'] = entry;
  }
});

test('cada hallazgo con id viaja también por errors/warnings, sin duplicarse', () => {
  const layers = {
    domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true } } } } },
    'use-cases': {},
    'http-clients': { clients: { pricing: { purpose: 'x', calls: { getPrice: { contract: 'GET /p' } } } } }
  };
  const { warnings, findings } = checkCrossRefs({ layers });

  const timeout = findings.find((finding) => finding.id === 'CHK-HTTP-NO-TIMEOUT');
  assert.ok(timeout, 'el hallazgo no llegó con su id');
  assert.equal(timeout.severity, CHECKS['CHK-HTTP-NO-TIMEOUT'].severity);
  // La lista de cadenas es la que imprime la CLI y la que consumen los generadores: si
  // el hallazgo con id no apareciera ahí, darle id lo habría hecho invisible.
  assert.ok(warnings.includes(timeout.message));
  assert.equal(warnings.filter((warning) => warning === timeout.message).length, 1);
});

test('la severidad la decide el catálogo, no el sitio donde se emite', () => {
  const entry = CHECKS['CHK-HTTP-NO-TIMEOUT'];
  CHECKS['CHK-HTTP-NO-TIMEOUT'] = { ...entry, severity: 'error' };
  try {
    assert.throws(
      () =>
        checkCrossRefs({
          layers: {
            domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true } } } } },
            'use-cases': {},
            'http-clients': { clients: { pricing: { purpose: 'x', calls: { getPrice: { contract: 'GET /p' } } } } }
          }
        }),
      /lo declara error/
    );
  } finally {
    CHECKS['CHK-HTTP-NO-TIMEOUT'] = entry;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// El ratchet.
//
// El número de abajo es deuda medida, no un objetivo: son los hallazgos heredados que
// siguen emitiéndose como cadena suelta. Puede BAJAR cuando alguien migre alguno al
// pasar por ahí; que SUBA significa que se añadió una comprobación nueva sin id, y
// entonces no se puede citar desde la skill, ni contar, ni falsar por mutación.
//
// Si has migrado reglas y el test falla por lo bajo, baja el número: es el ratchet
// haciendo su trabajo. Los avisos están a cero: un `warnings.push` nuevo pone esto en rojo.
const ANONIMOS_MAXIMOS = { errors: 134, warnings: 0 };

test('ninguna comprobación nueva se añade sin id (ratchet)', () => {
  const source = fs.readFileSync(crossrefsPath, 'utf8');
  const cuenta = (needle) => source.split(needle).length - 1;
  const actual = { errors: cuenta('errors.push('), warnings: cuenta('warnings.push(') };

  for (const canal of ['errors', 'warnings']) {
    assert.ok(
      actual[canal] <= ANONIMOS_MAXIMOS[canal],
      `${canal}.push sin id: ${actual[canal]}, y el tope es ${ANONIMOS_MAXIMOS[canal]}. ` +
        `Una comprobación nueva se emite con error(id, …) o warn(id, …) y su entrada en checks.js`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// La naturaleza: incoherencia (se corrige) o decisión no tomada (se contesta).
//
// La distinción existe porque las dos llegaban igual al generador —un aviso que nadie
// cerraba—, y la segunda la acaba decidiendo él, con un default que cambia de stack a stack.

test('toda comprobación declara su naturaleza, y lo que bloquea nunca es una decisión aceptable', () => {
  for (const [id, entry] of Object.entries(CHECKS)) {
    assert.ok(['incoherence', 'undecided'].includes(entry.nature), `${id}: sin nature válida`);
    // Un error bloquea: si fuera `undecided` se podría aceptar por escrito y dejaría de
    // bloquear, y entonces no era un error.
    if (entry.severity === 'error') assert.equal(entry.nature, 'incoherence', `${id}: un error no se acepta`);
    // `waivable` solo tiene sentido en lo que se acepta, y solo para negarlo.
    if ('waivable' in entry) {
      assert.equal(entry.nature, 'undecided', `${id}: waivable en una incoherencia`);
      assert.equal(entry.waivable, false, `${id}: waivable solo se escribe para decir false`);
    }
  }
});

test('el catálogo dice lo mismo que la doctrina sobre lo que no admite «aceptado»', () => {
  // gap-analysis.md § severidades: el orden de las colecciones (clase 5) y la autorización
  // (clase 9) no admiten aceptado. Si el catálogo los dejara aceptar, decisions.yaml sería
  // la puerta para dejárselos al generador.
  for (const id of ['CHK-USECASES-COLLECTION-NO-SORT', 'CHK-API-NO-SECURITY']) {
    assert.equal(CHECKS[id].nature, 'undecided', id);
    assert.equal(CHECKS[id].waivable, false, id);
  }
  // Y lo que el generador decidiría con una heurística sobre un nombre, o con el default
  // del broker: tampoco hay default seguro.
  for (const id of ['CHK-API-POST-NO-STATUS', 'CHK-MSG-SUB-NO-ONFAILURE']) assert.equal(CHECKS[id].waivable, false, id);
});

test('toda decisión no tomada llega con su scope, y dos unidades dan dos scopes', () => {
  const layers = {
    domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true } } } } },
    'use-cases': {
      operations: {
        createProduct: { description: 'Alta.', kind: 'command', input: { entity: 'Product' }, output: { entity: 'Product' } },
        importProduct: { description: 'Importa.', kind: 'command', input: { entity: 'Product' }, output: { entity: 'Product' } }
      }
    },
    api: {
      endpoints: {
        createProduct: { method: 'POST', path: '/products' },
        importProduct: { method: 'POST', path: '/products/import' }
      }
    }
  };
  const { findings } = checkCrossRefs({ layers });
  for (const finding of findings) {
    if (CHECKS[finding.id].nature === 'undecided') assert.ok(finding.scope, `${finding.id} sin scope`);
    else assert.equal(finding.scope, undefined, `${finding.id}: una incoherencia no se acepta, no lleva scope`);
  }
  const posts = findings.filter((finding) => finding.id === 'CHK-API-POST-NO-STATUS').map((finding) => finding.scope);
  assert.deepEqual(posts.sort(), ['api.endpoints.createProduct', 'api.endpoints.importProduct']);
  assert.deepEqual(
    findings.filter((finding) => finding.id === 'CHK-API-NO-SECURITY').map((finding) => finding.scope),
    ['api']
  );
});

test('emitir una decisión no tomada sin scope lanza', () => {
  // La garantía, desde fuera: se reclasifica en caliente una incoherencia (que se emite sin
  // scope) como `undecided`, y `record` tiene que negarse a emitirla.
  const entry = CHECKS['CHK-SEC-UNUSED-ROLE'];
  CHECKS['CHK-SEC-UNUSED-ROLE'] = { ...entry, nature: 'undecided' };
  try {
    assert.throws(
      () =>
        checkCrossRefs({
          layers: {
            domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true } } } } },
            'use-cases': {},
            security: { roles: { admin: { description: 'Administra.' } } }
          }
        }),
      /sin scope/
    );
  } finally {
    CHECKS['CHK-SEC-UNUSED-ROLE'] = entry;
  }
});
