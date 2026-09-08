// Que las sondas de `index-check` midan lo que dicen medir.
//
// El check en vivo necesita podman y no corre en `npm test`, así que lo que queda aquí es su
// mitad determinista: que las aserciones sean las cuatro que hacen falta, que discriminen —una
// que no distinga dentro de fuera de la condición mediría dos veces la misma cosa— y que el
// sustrato salga del MISMO spec del que sale el índice, que es lo que impide que el check acabe
// midiendo una copia de sí mismo.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { resolveStack } from '../src/scaffold/index.js';
import { generate } from '../src/scaffold/migrations.js';
import { indexSubject, substrateSql, assertions, statementsOf, outsideValue, opacityOf } from '../src/lib/index-probes.js';
import { enginesWithPartialIndex } from '../src/scaffold/migrations.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function modeloDe(fixture, database) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `${fixture} no valida`);
  const stack = resolveStack({ database }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return model;
}

const appendixDe = (model) => generate(model).find((file) => file.path.endsWith('partial-indexes.sql')).content;

// ─── El sujeto ───────────────────────────────────────────────────────────────

test('el sujeto es el índice condicionado del diseño, no uno inventado', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'mysql'));
  assert.equal(spec.name, 'uk_templates_application_key_locale');
  assert.equal(spec.tableName, 'templates');
  // El valor ALMACENADO, no el literal del diseño: el enum se persiste por su constante. Medir
  // con `active` daría verde sobre un índice que no casa con ninguna fila, que es exactamente el
  // defecto que estuvo meses en pie.
  assert.equal(spec.stored, 'ACTIVE');
});

test('un diseño sin unicidad condicionada no tiene nada que medir', () => {
  assert.equal(indexSubject(modeloDe('stock-reservation', 'postgresql')), null);
});

// ─── El sustrato ─────────────────────────────────────────────────────────────

test('la tabla del sustrato trae exactamente las columnas que el índice nombra', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'mysql'));
  const [drop, create] = substrateSql(spec);
  assert.match(drop, /^DROP TABLE IF EXISTS/);
  for (const column of [...spec.columnList, spec.whenColumn]) {
    assert.ok(create.includes(column), `el sustrato no tiene la columna ${column} que el índice usa`);
  }
  // Derivarlas por su cuenta sería medir una copia de sí mismo: un spec que nombrara una columna
  // que la entidad no tiene seguiría casando con un sustrato construido aparte.
  assert.equal(create.match(/VARCHAR\(64\)/g).length, spec.columnList.length + 1);
});

// ─── Las aserciones ──────────────────────────────────────────────────────────

test('las tres aserciones cubren las tres formas de estar mal', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'postgresql'));
  const ids = assertions(spec).map((a) => a.id);
  assert.deepEqual(ids, ['exclusividad', 'historia', 'independencia']);
});

test('`exclusividad` mete DOS veces la misma fila y espera que la segunda muera', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'postgresql'));
  const [exclusividad] = assertions(spec);
  const [primera, segunda] = exclusividad.steps;
  assert.equal(primera.sql, segunda.sql, 'si no son la misma fila no se mide la unicidad');
  assert.equal(primera.expect, 'ok');
  // `reject` es la única forma que tiene un índice de decir que sostiene algo: sin este paso, la
  // aserción pasaría igual sin índice ninguno.
  assert.equal(segunda.expect, 'reject');
  assert.ok(primera.sql.includes("'ACTIVE'"), 'la fila tiene que caer DENTRO de la condición');
});

test('`historia` usa la misma clave pero FUERA de la condición, y mete tres', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'postgresql'));
  const historia = assertions(spec).find((a) => a.id === 'historia');
  assert.equal(historia.steps.length, 3, 'con dos, un índice que restringiera de dos en dos pasaría');
  assert.ok(historia.steps.every((step) => step.expect === 'ok'));
  // La MISMA clave que exclusividad y SOLO el valor de la condición distinto: si cambiara de
  // clave, el caso no distinguiría el índice condicionado de la constraint única normal, que es
  // justo lo que existe para separar.
  const [exclusividad] = assertions(spec);
  assert.equal(
    historia.steps[0].sql.replace("'ACTIVE_KEEL_OFF'", "'ACTIVE'"),
    exclusividad.steps[0].sql,
    'entre los dos casos solo puede cambiar el valor de la columna de la condición'
  );
  assert.ok(!historia.steps[0].sql.includes("'ACTIVE'"), 'la fila tiene que caer FUERA de la condición');
});

test('`independencia` cambia de clave y vuelve dentro de la condición', () => {
  const spec = indexSubject(modeloDe('notification-mailer', 'postgresql'));
  const independencia = assertions(spec).find((a) => a.id === 'independencia');
  assert.ok(independencia.steps[0].sql.includes('keel_b0'));
  assert.ok(independencia.steps[0].sql.includes("'ACTIVE'"));
});

test('el valor de fuera de la condición es del mismo tipo y distinto del de dentro', () => {
  // Del mismo tipo porque la columna es una sola; distinto porque es lo único que hace fallable
  // el caso de las versiones históricas — con el mismo valor mediría otra vez la exclusividad.
  assert.notEqual(outsideValue('ACTIVE'), 'ACTIVE');
  assert.equal(typeof outsideValue('ACTIVE'), 'string');
  assert.equal(outsideValue(true), false);
  assert.equal(typeof outsideValue(1), 'number');
  assert.notEqual(outsideValue(1), 1);
});

// ─── El appendix, tal como lo va a ejecutar el servicio ──────────────────────

test('el appendix de PostgreSQL es una sola sentencia; el de MySQL, dos guardas planas', () => {
  assert.equal(statementsOf(appendixDe(modeloDe('notification-mailer', 'postgresql'))).length, 1);
  // Diez «sentencias» según el separador de spring.sql.init: DOS guardas (la columna generada y
  // el índice) de cinco cada una —los dos SET, PREPARE, EXECUTE y DEALLOCATE—. Ninguna puede
  // llevar un `;` dentro, o el script se ejecutaría a trozos.
  const mysql = statementsOf(appendixDe(modeloDe('notification-mailer', 'mysql')));
  assert.equal(mysql.length, 10);
  for (const statement of mysql) {
    assert.ok(!statement.includes(';'), `un ; dentro de una sentencia parte el script: ${statement}`);
  }
});

test('el splitter salta los comentarios, que es casi todo el archivo', () => {
  const appendix = appendixDe(modeloDe('notification-mailer', 'postgresql'));
  assert.ok(appendix.split('\n').filter((l) => l.startsWith('--')).length > 5, 'la cabecera es prosa');
  assert.ok(statementsOf(appendix).every((s) => !s.startsWith('--')));
});

test('sobre un motor que no lo sostiene el appendix no trae ninguna sentencia', () => {
  // Es lo que hace que el runner pueda decir «esto es una degradación anunciada, no un fallo» en
  // vez de morir con un error del motor que nadie sabría leer.
  assert.equal(statementsOf(appendixDe(modeloDe('notification-mailer', 'mariadb'))).length, 0);
});

// ─── La opacidad a la introspección JDBC ─────────────────────────────────────

test('cada motor que PUEDE ser opaco sabe preguntárselo, en su propio idioma', () => {
  // No hay forma portable de hacerlo, y componerla a ojo daría siempre cero — que es
  // indistinguible de «no es opaco» y por tanto un verde que no mide nada.
  const spec = indexSubject(modeloDe('notification-mailer', 'mysql'));
  const mysql = opacityOf('mysql', spec).query;
  assert.match(mysql, /information_schema\.STATISTICS/);
  assert.match(mysql, /COLUMN_NAME IS NULL/);
  assert.ok(mysql.includes("INDEX_NAME = 'uk_templates_application_key_locale'"), 'pregunta por SU índice');

  // En PostgreSQL lo que haría opaco al índice sería una key part por EXPRESIÓN (`indexprs`), no
  // el predicado (`indpred`): preguntar por el predicado daría siempre «opaco» y obligaría a una
  // mitigación que ahí no hace falta.
  const postgres = opacityOf('postgresql', indexSubject(modeloDe('notification-mailer', 'postgresql'))).query;
  assert.match(postgres, /pg_index/);
  assert.match(postgres, /indexprs IS NOT NULL/);
  assert.ok(!postgres.includes('indpred'), 'el predicado no es lo que hace opaco a un índice');
});

test('SQL Server no puede ser opaco, y se DECLARA en vez de fingir una consulta', () => {
  // Sus índices son siempre sobre columnas: no admite key parts por expresión, así que la
  // respuesta sería cero POR CONSTRUCCIÓN. Una consulta ahí no podría ponerse roja nunca, y una
  // red que no puede ponerse roja no mide nada.
  const spec = indexSubject(modeloDe('notification-mailer', 'sqlserver'));
  const opacidad = opacityOf('sqlserver', spec);
  assert.ok(!opacidad.query, 'no se emite consulta: su respuesta no podría ser distinta de cero');
  assert.ok(opacidad.cannotBeOpaque, 'una afirmación sobre el motor exige su porqué escrito');
  assert.match(opacidad.cannotBeOpaque, /expresión/);
});

test('un motor que no lo declara devuelve nada, para que el runner lo ponga en KO', () => {
  // Es la tercera situación, y la que impide que un motor nuevo se cuele sin decidir. MariaDB no
  // se declara a propósito: hoy es degradación anunciada y el runner aborta antes de llegar, pero
  // el día que alguien le escriba un dialecto tendrá que decidir. No saberlo no es estar bien.
  const spec = indexSubject(modeloDe('notification-mailer', 'mysql'));
  assert.equal(opacityOf('mariadb', spec), null);
  assert.equal(opacityOf('un-motor-que-no-existe', spec), null);
});

test('todo motor que emite índice condicionado declara su opacidad', () => {
  // El cruce que hace portante lo anterior: quien tiene dialecto llega a tener un índice que
  // INTROSPECCIONAR, así que tiene que haber decidido si esa forma puede quedarse sin nombre de
  // columna. Falla el día que alguien añada un dialecto sin decidirlo — que es justo el hueco que
  // este archivo tenía con SQL Server.
  const spec = indexSubject(modeloDe('notification-mailer', 'mysql'));
  for (const engine of enginesWithPartialIndex()) {
    const opacidad = opacityOf(engine, spec);
    assert.ok(opacidad, `${engine} emite índice condicionado y no declara su opacidad`);
    assert.ok(
      opacidad.query || opacidad.cannotBeOpaque,
      `${engine}: una declaración vacía no es una decisión`
    );
  }
});
