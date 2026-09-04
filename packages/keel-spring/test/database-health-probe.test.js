// El sondeo de «esta base ya acepta conexiones», y sus DOS caras.
//
// El dato existía —`HEALTHCHECKS` y los healthcheck inline de `composeService`— pero la regla
// que los combina vivía suelta dentro de `deploy.js`, en forma de comentario. El segundo
// consumidor, `scripts/claim-check.js`, no tenía de dónde leerla y acabó con `pg_isready`
// cableado: el runner solo servía para PostgreSQL, y con cualquier otro motor moría a los 90 s
// en «el motor no aceptó conexiones a tiempo» sin haber ejecutado una sola aserción. Ese rojo no
// distingue «el motor no arrancó» de «este runner no sabe preguntárselo».
//
// Lo que este archivo vigila es lo que un `includes(...)` no ve: que el comando que sale para
// ejecutarse a mano NO es el mismo texto que va al compose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DATABASES, HEALTHCHECKS, databaseHealthProbe } from '../src/lib/stack-catalog.js';

const DB = 'job_dispatch';

test('todo motor del catálogo declara un sondeo, sea propio o genérico', () => {
  for (const [id, entry] of Object.entries(DATABASES)) {
    const probe = databaseHealthProbe(id, DB);
    assert.ok(probe, `${id}: sin sondeo, nadie puede esperar a que arranque`);
    assert.ok(probe.argv.length > 0, `${id}: sondeo vacío`);
    assert.ok(probe.budgetSeconds > 0, `${id}: sin presupuesto de espera`);
  }
});

test('el healthcheck del propio servicio manda sobre el genérico', () => {
  // Y no es una preferencia de estilo: el de Mongo INICIA el replica set (rs.initiate), sin el
  // cual `findAndModify` transaccional no existe. Sustituirlo por un ping dejaría la base
  // respondiendo y el reclamo documental sin poder ejecutarse.
  const mongo = databaseHealthProbe('mongodb', DB);
  assert.match(mongo.argv.join(' '), /rs\.initiate/);

  // sqlserver es el otro con healthcheck propio, y NO tiene entrada en HEALTHCHECKS.
  assert.equal(HEALTHCHECKS.sqlserver, undefined);
  assert.match(databaseHealthProbe('sqlserver', DB).argv.join(' '), /sqlcmd/);
});

test('el argv des-escapa el $$ de compose; el healthcheck lo conserva', () => {
  // Las dos proyecciones del mismo dato, como el par realmSpec/realmExport. `$$` es el escape
  // de compose para un `$` literal: fuera de compose, el sondeo de sqlserver buscaría una
  // variable llamada `$MSSQL_SA_PASSWORD` que no existe, fallaría SIEMPRE, y el bucle de espera
  // agotaría su plazo contra un motor sano.
  const probe = databaseHealthProbe('sqlserver', DB);
  const ejecutable = probe.argv.join(' ');
  assert.ok(ejecutable.includes('$MSSQL_SA_PASSWORD'), ejecutable);
  assert.ok(!ejecutable.includes('$$'), 'el argv arrastra el escape de compose');

  // Y la cara que va al compose sigue llevándolo: si se des-escapara ahí, compose lo expandiría
  // como variable suya y el healthcheck se quedaría sin contraseña.
  assert.ok(probe.healthcheck.test.join(' ').includes('$$MSSQL_SA_PASSWORD'));

  for (const id of Object.keys(DATABASES)) {
    assert.ok(!databaseHealthProbe(id, DB).argv.join(' ').includes('$$'), `${id}: $$ en el argv`);
  }
});

test('el presupuesto de espera sale del propio healthcheck, no de una constante', () => {
  // Oracle es el motivo: declara un minuto de gracia más 30 intentos de 10 s porque tarda
  // MINUTOS en su primera pasada. Con el plazo fijo de 90 s que había antes, el sondeo se
  // rendía siempre y el mensaje culpaba al motor de la impaciencia de quien preguntaba.
  const oracle = databaseHealthProbe('oracle', DB);
  assert.equal(oracle.intervalSeconds, 10);
  assert.equal(oracle.budgetSeconds, 60 + 10 * 30);

  const postgres = databaseHealthProbe('postgresql', DB);
  assert.equal(postgres.intervalSeconds, 5);
  assert.equal(postgres.budgetSeconds, 5 * 20);
});

test('un motor que no está en el catálogo no inventa sondeo', () => {
  assert.equal(databaseHealthProbe('motor-que-alguien-anadira', DB), null);
});
