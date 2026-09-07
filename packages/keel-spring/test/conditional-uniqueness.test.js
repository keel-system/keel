// El contrato de orden que impone un índice único condicionado.
//
// Existe por un defecto que estuvo tapado debajo de otro. El índice parcial de la rama relacional
// llevaba meses con el predicado en minúsculas —`WHERE status = 'active'` contra una columna que
// guarda `'ACTIVE'`—, así que indexaba cero filas: el invariante no lo sostenía nadie y, de paso,
// nadie descubrió que el flujo tampoco podía convivir con él. Al corregir el predicado y ejercitarlo
// (corrida `mail-rabbit`, 2026-09-07), `publishTemplate` empezó a responder 409 en la transición
// LEGÍTIMA y cayeron tres escenarios de plantilla.
//
// La causa: un índice único parcial se comprueba por FILA y no se puede diferir, y la operación que
// RELEVA hace dos escrituras sobre la misma clave que JPA vuelca al commit en el orden que decide
// Hibernate. El reparto que arregla eso es el de siempre —build genera el mecanismo, el agente
// escribe la llamada, el gate la verifica— y estos casos cubren las tres partes.
//
// La rama documental no lo sufre y no debe recibir nada: cada `save` es su propia escritura. Esa
// mitad se afirma explícitamente, porque emitir por analogía es la otra forma de equivocarse.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService, resolveStack } from '../src/scaffold/index.js';
import { relievingOperations, conditionedEntities } from '../src/scaffold/conditional-uniqueness.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function modeloDe(fixture, database) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const stack = resolveStack({ database }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return { model, manifest, layers };
}

const arboles = new Map();
function generar(fixture, database) {
  const clave = `${fixture}/${database}`;
  if (arboles.has(clave)) return arboles.get(clave);
  const { manifest, layers } = modeloDe(fixture, database);
  const workspace = tmpDir('keel-conduniq-');
  const result = scaffoldService({ manifest, layers, workspace, stack: { database }, force: true });
  const root = path.join(workspace, result.outDir);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const api = { read, exists, pkg: fixture.includes('mongo') ? 'notificationmailermongo' : 'notificationmailer' };
  arboles.set(clave, api);
  return api;
}

// ─── La detección: quién releva y quién no ──────────────────────────────────

test('releva la operación que saca una fila del estado condicionado y mete otra', () => {
  const { model } = modeloDe('notification-mailer', 'postgresql');
  assert.deepEqual(conditionedEntities(model).map((e) => e.name), ['Template']);

  const relieving = relievingOperations(model);
  assert.equal(relieving.length, 1, `esperaba una, encontré ${relieving.map((r) => r.operation.name)}`);
  assert.equal(relieving[0].operation.name, 'publishTemplate');
  assert.equal(relieving[0].state, 'active');

});

test('y NO releva quien solo ocupa el estado, ni quien solo lo vacía', () => {
  // Esta mitad necesita un sujeto SINTÉTICO, y la primera versión de este archivo no lo tenía:
  // afirmaba que `sendAcceptedNotification` no relevaba, lo cual es cierto por una razón que no es
  // la que se quiere medir —sus transiciones son sobre Notification, que no tiene índice
  // condicionado—, así que la aserción pasaba igual con la regla rota. Comprobado: cambiando el
  // `&&` de las dos mitades por un `||`, aquel test seguía en verde. Este cae.
  const entity = {
    name: 'Template',
    persisted: true,
    indexes: [{ fields: ['key'], unique: true, when: { field: 'status', equals: 'active' } }]
  };
  const operacion = (name, transitions) => ({ name, transitions });
  const model = {
    persistenceKind: 'relational',
    entities: [entity],
    services: [
      {
        operations: [
          // Releva: saca una fila de `active` y mete otra, en el mismo acto.
          operacion('publish', [
            { entity: 'Template', from: ['draft'], to: 'active' },
            { entity: 'Template', from: ['active'], to: 'retired' }
          ]),
          // Solo OCUPA: una sola escritura sobre esa clave, no hay orden que forzar.
          operacion('activateFirst', [{ entity: 'Template', from: ['draft'], to: 'active' }]),
          // Solo VACÍA: igual.
          operacion('retireCurrent', [{ entity: 'Template', from: ['active'], to: 'retired' }])
        ]
      }
    ]
  };

  assert.deepEqual(
    relievingOperations(model).map((r) => r.operation.name),
    ['publish'],
    'el mecanismo se emitiría en operaciones que no lo necesitan, y la nota del stub sería ruido'
  );
});

test('en el modelo documental no releva nadie: cada save es su propia escritura', () => {
  const { model } = modeloDe('notification-mailer-mongo', 'mongodb');
  assert.deepEqual(conditionedEntities(model), []);
  assert.deepEqual(relievingOperations(model), []);
});

// ─── Las tres superficies del contrato ──────────────────────────────────────

test('build genera el mecanismo en el puerto y su implementación en el adaptador', () => {
  const { read, pkg } = generar('notification-mailer', 'postgresql');
  const port = read(`src/main/java/com/platform/${pkg}/domain/repository/TemplateRepository.java`);
  assert.match(port, /void flushPendingWrites\(\);/);
  // El javadoc del puerto tiene que decir POR QUÉ existe: un método de drenaje sin motivo escrito
  // es lo primero que alguien borra por «no pertenecer al dominio».
  // Dos trozos y no la frase entera: el javadoc va envuelto a 100 columnas, así que afirmar una
  // frase larga ata el test al ancho de línea en vez de a lo que dice.
  assert.match(port, /por FILA/);
  assert.match(port, /diferir/);

  const adapter = read(`src/main/java/com/platform/${pkg}/infrastructure/persistence/repositories/TemplateRepositoryImpl.java`);
  assert.match(adapter, /public void flushPendingWrites\(\)/);
  assert.match(adapter, /\.flush\(\);/);
});

test('y NO lo genera donde no hace falta', () => {
  const { read, pkg } = generar('notification-mailer', 'postgresql');
  // Notification no tiene índice condicionado: su puerto no debe traer el método. Un mecanismo que
  // aparece en todos los agregados deja de significar algo.
  const otro = read(`src/main/java/com/platform/${pkg}/domain/repository/NotificationRepository.java`);
  assert.ok(!otro.includes('flushPendingWrites'), 'el drenaje se coló en un agregado sin índice condicionado');

  const { read: readDoc, pkg: pkgDoc } = generar('notification-mailer-mongo', 'mongodb');
  const doc = readDoc(`src/main/java/com/platform/${pkgDoc}/domain/repository/TemplateRepository.java`);
  assert.ok(!doc.includes('flushPendingWrites'), 'la rama documental no necesita ordenar nada');
});

test('la nota del stub le dice al agente dónde va la llamada', () => {
  const { read, pkg } = generar('notification-mailer', 'postgresql');
  const handler = read(`src/main/java/com/platform/${pkg}/application/usecases/PublishTemplateCommandHandler.java`);
  assert.match(handler, /ORDEN OBLIGATORIO/);
  assert.match(handler, /flushPendingWrites\(\)/);
  // Y le prohíbe la salida fácil, que es la que un agente con prisa toma: quitar el índice hace
  // pasar el escenario y borra el invariante.
  assert.match(handler, /No lo arregles quitando el índice/);
});

test('el .sql que crea el índice lleva el contrato que impone', () => {
  const { read } = generar('notification-mailer', 'postgresql');
  const sql = read('src/main/resources/db/partial-indexes.sql');
  assert.match(sql, /CONTRATO DE ORDEN/);
  assert.match(sql, /publishTemplate/);
  assert.match(sql, /flushPendingWrites\(\)/);
});

// ─── El gate ────────────────────────────────────────────────────────────────

test('el gate exige la llamada, y sale ROJO sobre el árbol recién generado', () => {
  const { read } = generar('notification-mailer', 'postgresql');
  const gate = read('infra/check-idempotency.sh');
  assert.match(gate, /conditionalUniqueness/);
  // El patrón, con clases entre corchetes como el resto: un escape mal puesto no falla, aborta la
  // comprobación, y eso es indistinguible de un verde.
  assert.match(gate, /\[[.]\]\?flushPendingWrites/);
  assert.ok(gate.includes('PublishTemplateCommandHandler'), 'el gate no localiza el handler que releva');
});

test('el gate no aparece en la rama documental', () => {
  const { read } = generar('notification-mailer-mongo', 'mongodb');
  assert.ok(
    !read('infra/check-idempotency.sh').includes('conditionalUniqueness'),
    'la familia se emitió donde no hay nada que ordenar'
  );
});
