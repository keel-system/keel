// El catálogo de revisión, su aplicabilidad y el veredicto escrito.
//
// La propiedad que más importa está al final y no es sobre el catálogo: es la FRONTERA
// con `checks.js`. Un id de revisión tiene que ser algo que la máquina NO pueda decidir —
// si `keel validate` ya lo pone en rojo, esa comprobación era mecanizable y su sitio es
// `crossrefs.js`, no una pregunta que el agente contesta a mano en cada diseño.

import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEWS, reviewFor, reviewIds, applicableReviews } from '../src/lib/reviews.js';
import { resolveReviews } from '../src/lib/review-state.js';
import { CHECKS } from '../src/lib/checks.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

const entity = (fields = {}, extra = {}) => ({
  fields: { id: { type: 'uuid', id: true, generated: true }, ...fields },
  ...extra
});

test('toda revisión declara lo que /keel-validate necesita para recorrerla', () => {
  for (const [id, entry] of Object.entries(REVIEWS)) {
    assert.match(id, /^REV-[A-Z]+-[A-Z0-9-]+$/, `${id}: el id no sigue REV-<ÁMBITO>-<NOMBRE>`);
    assert.ok(entry.title?.length > 10, `${id}: sin título`);
    // Sin `asks` la fila es una casilla que marcar, no una revisión: el agente no sabría
    // qué contestar y el veredicto no significaría nada.
    assert.ok(entry.asks?.length > 20, `${id}: no dice qué hay que contestar`);
    assert.ok(['error', 'warning', 'strong'].includes(entry.severity), `${id}: severidad desconocida`);
    assert.equal(typeof entry.appliesTo, 'function', `${id}: sin predicado de aplicabilidad`);
    assert.ok(Number.isInteger(entry.gapClass) && entry.gapClass >= 1 && entry.gapClass <= 17, `${id}: gapClass`);
  }
});

test('ningún id se repite entre los dos catálogos', () => {
  // No es paranoia de nombres: un id en los dos sitios significaría que la misma
  // pregunta se contesta dos veces, una por la máquina y otra a mano.
  const solapados = reviewIds().filter((id) => Object.hasOwn(CHECKS, id));
  assert.deepEqual(solapados, []);
});

test('reviewFor solo conoce los ids del catálogo', () => {
  assert.equal(reviewFor('REV-QUE-NO-EXISTE'), undefined);
  assert.equal(reviewIds().length, Object.keys(REVIEWS).length);
});

// ── aplicabilidad ───────────────────────────────────────────────────────────

test('la aplicabilidad la decide el diseño, y quitar una capa retira sus ids', () => {
  // Esto es lo que hace exigible la cobertura: si «no aplica» lo dijera el lector, sería
  // la salida barata de cualquier id incómodo.
  const conMail = {
    domain: { entities: { Message: entity() } },
    'use-cases': {},
    mail: { delivery: {}, sender: {}, sentBy: {} }
  };
  const aplicables = applicableReviews(conMail);
  assert.ok(aplicables.some((id) => id.startsWith('REV-MAIL-')), 'con capa mail deberían aplicar sus ids');

  const sinMail = { ...conMail };
  delete sinMail.mail;
  assert.deepEqual(applicableReviews(sinMail).filter((id) => id.startsWith('REV-MAIL-')), []);
});

test('un diseño a medias no hace lanzar a ningún predicado', () => {
  // Se evalúan también en --wip, cuando la mitad de las capas no existe todavía.
  for (const layers of [{}, { domain: {} }, { domain: { entities: { X: {} } }, 'use-cases': {} }]) {
    assert.doesNotThrow(() => applicableReviews(layers));
  }
});

// ── el veredicto ────────────────────────────────────────────────────────────

const REVISABLE = 'REV-DOMAIN-PROMISED-STATE';

test('un id aplicable sin veredicto es cobertura que falta', () => {
  const { missing, covered } = resolveReviews([REVISABLE], null, '1.0.0');
  assert.equal(covered.length, 0);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, REVISABLE);
  assert.ok(missing[0].title, 'el hueco no dice qué falta por mirar');
});

test('un hallazgo abierto se separa del resto; uno aceptado se lista con su motivo', () => {
  const doc = {
    reviewedAt: '1.0.0',
    findings: [
      { id: REVISABLE, verdict: 'open', note: 'La descripción promete conservar el rastro y no hay campo.' }
    ]
  };
  const abierto = resolveReviews([REVISABLE], doc, '1.0.0');
  assert.equal(abierto.open.length, 1);
  assert.equal(abierto.missing.length, 0);

  doc.findings[0].verdict = 'accepted';
  const aceptado = resolveReviews([REVISABLE], doc, '1.0.0');
  assert.equal(aceptado.open.length, 0);
  assert.equal(aceptado.accepted.length, 1);
  assert.match(aceptado.accepted[0].note, /conservar el rastro/);

  doc.findings[0].verdict = 'ok';
  const limpio = resolveReviews([REVISABLE], doc, '1.0.0');
  assert.equal(limpio.open.length, 0);
  assert.equal(limpio.accepted.length, 0);
  assert.equal(limpio.covered.length, 1);
});

test('la revisión caduca con el minor, no con el patch', () => {
  const doc = { reviewedAt: '1.0.0', findings: [{ id: REVISABLE, verdict: 'ok' }] };
  assert.equal(resolveReviews([REVISABLE], doc, '1.0.3').stale, false, 'un patch no invalida lo que se juzgó');
  assert.equal(resolveReviews([REVISABLE], doc, '1.1.0').stale, true);
  assert.equal(resolveReviews([REVISABLE], doc, '2.0.0').stale, true);
});

test('la revisión caduca ENTERA, no id a id', () => {
  // Se hizo leyendo UN diseño: cuando ese diseño cambia de forma, deja de ser la revisión
  // de nada. Un sello por veredicto invitaría a rehacer solo lo que se tocó, y un cambio
  // en una capa puede invalidar la lectura de otra.
  const doc = {
    reviewedAt: '1.0.0',
    findings: [
      { id: REVISABLE, verdict: 'ok' },
      { id: 'REV-PERSIST-MISSING-INDEX', verdict: 'ok' }
    ]
  };
  const resultado = resolveReviews([REVISABLE, 'REV-PERSIST-MISSING-INDEX'], doc, '1.1.0');
  assert.equal(resultado.stale, true);
  assert.equal(resultado.covered.length, 2, 'la caducidad no es por id: se sigue viendo lo que se miró');
});

test('un id fuera del catálogo es error, y uno repetido también', () => {
  const desconocido = resolveReviews([], { reviewedAt: '1.0.0', findings: [{ id: 'REV-NO-EXISTE', verdict: 'ok' }] }, '1.0.0');
  assert.equal(desconocido.errors.length, 1);
  assert.match(desconocido.errors[0], /no está en el catálogo/);

  const doble = resolveReviews(
    [REVISABLE],
    { reviewedAt: '1.0.0', findings: [{ id: REVISABLE, verdict: 'ok' }, { id: REVISABLE, verdict: 'open', note: 'x'.repeat(25) }] },
    '1.0.0'
  );
  assert.equal(doble.errors.length, 1);
  assert.match(doble.errors[0], /dos veces/);
});

test('un veredicto sobre algo que ya no aplica queda como huérfano', () => {
  const { orphans, missing } = resolveReviews([], { reviewedAt: '1.0.0', findings: [{ id: REVISABLE, verdict: 'ok' }] }, '1.0.0');
  assert.equal(orphans.length, 1);
  assert.equal(missing.length, 0);
});

// ── la frontera con checks.js ───────────────────────────────────────────────

test('lo que la revisión pregunta, la CLI no lo puede contestar', () => {
  // La prueba del principio: se construye un diseño que VIOLA una revisión y se comprueba
  // que `keel validate` sale LIMPIO sobre esa violación. Si saliera en rojo, esa pregunta
  // era mecanizable y su sitio es crossrefs.js.
  //
  // Sujeto: REV-DOMAIN-PROMISED-STATE. La entidad promete en prosa que la retirada
  // «queda marcada» y no hay ningún campo ni transición que lo sostenga — un lector lo ve
  // en una frase, y ningún YAML lo contesta.
  const layers = {
    domain: {
      entities: {
        Product: entity(
          { name: { type: 'string', required: true } },
          {
            description: 'Un producto del catálogo. Al retirarlo no se borra el rastro: queda marcado como retirado.',
            invariants: ['Un producto retirado se conserva para auditoría.']
          }
        )
      }
    },
    'use-cases': {
      operations: {
        retireProduct: {
          kind: 'command',
          errors: [{ code: 'PRODUCT_NOT_FOUND', when: 'No existe.', http: 404 }]
        }
      }
    }
  };

  assert.ok(applicableReviews(layers).includes(REVISABLE), 'la revisión debería aplicar a este diseño');

  const { errors, warnings } = checkCrossRefs({ layers });
  assert.deepEqual(errors, [], 'la CLI no debería poder ver una promesa escrita en prosa');
  assert.deepEqual(
    warnings.filter((warning) => /retirad|rastro|auditor/i.test(warning)),
    [],
    'si la CLI avisara de esto, la revisión sobra y la regla debería estar en crossrefs.js'
  );
});

test('REV-MSG-DEDUPE-WINDOW aplica donde no hay guarda, y NO donde la hay', () => {
  // Hueco 4 de la corrida de `stock-reservation` (2026-09-20). Es revisión y no aviso porque
  // lo que decide si hay hallazgo —si el efecto del handler es ACUMULABLE— no está en ningún
  // YAML: un contador que suma y una bandera que se fija se declaran igual. Avisar de las dos
  // pondría el hallazgo sobre 7 de las 11 fixtures, que es el camino normal y documentado del
  // generador (la rama `tryRecord`), y un aviso que sale casi siempre deja de leerse.
  const ID = 'REV-MSG-DEDUPE-WINDOW';
  const build = (handler) => ({
    messaging: {
      subscriptions: {
        MeterRead: { source: 'meters', triggers: 'recordReading', payload: {}, contract: { envelope: 'keel' } }
      }
    },
    'use-cases': { operations: { recordReading: handler } }
  });

  assert.ok(applicableReviews(build({ kind: 'command' })).includes(ID));

  // Las dos guardas que la retiran, y son las dos que el `asks` ofrece como salida.
  assert.ok(
    !applicableReviews(build({ kind: 'command', transitions: [{ from: 'open', to: 'closed' }] })).includes(ID),
    'con transiciones la guarda es el lifecycle: el generador usa alreadyProcessed+record'
  );
  assert.ok(
    !applicableReviews(build({ kind: 'command', idempotency: { keySource: 'payload-field', keyField: 'readingId' } })).includes(ID),
    'con idempotency declarada la ventana la fija el diseño, que es justo lo que se pedía'
  );

  // Y la frontera con crossrefs.js: el diseño que la viola sale LIMPIO de la CLI. Si saliera
  // en rojo, la pregunta era mecanizable y su sitio no es este catálogo.
  const { errors, warnings } = checkCrossRefs({ layers: build({ kind: 'command' }) });
  assert.deepEqual(
    warnings.filter((warning) => /acumulab|retenci[óo]n|deduplicaci[óo]n/i.test(warning)),
    [],
    'si la CLI avisara de esto, la revisión sobra'
  );
  assert.ok(!errors.some((error) => /recordReading/.test(error) && /idempot/i.test(error)));
});
