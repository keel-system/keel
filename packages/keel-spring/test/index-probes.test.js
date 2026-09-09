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
import fs from 'node:fs';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { resolveStack } from '../src/scaffold/index.js';
import { generate } from '../src/scaffold/migrations.js';
import {
  indexSubject,
  substrateSql,
  assertions,
  statementsOf,
  outsideValue,
  opacityOf,
  documentIndexSubject,
  documentAssertions
} from '../src/lib/index-probes.js';
import { documentIndexTestClass, LITERAL_CASE } from '../src/lib/document-index-probes.js';
import { generate as generateDocumentIndexes } from '../src/scaffold/document-indexes.js';
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

// ─── La rama DOCUMENTAL ──────────────────────────────────────────────────────
//
// El mismo mecanismo con otro artefacto: en Mongo el índice condicionado no vive en un `.sql`
// sino en `MongoIndexConfig.java`, así que la rama en vivo ejecuta la CLASE generada. Lo que se
// puede comprobar sin contenedores es lo de siempre: que el sujeto salga del emisor, que las
// aserciones discriminen, y —lo que aquí es propio— que el rechazo esperado NOMBRE su índice.

const configDe = (model) =>
  generateDocumentIndexes(model).find((file) => file.path.endsWith('MongoIndexConfig.java')).content;

const claseDe = (model, spec) =>
  documentIndexTestClass(model, spec, {
    datasource: { uri: 'mongodb://keel/test' },
    packages: { config: 'x.config', entities: 'x.entities', enums: 'x.enums' }
  }).content;

test('documental: el sujeto sale del emisor, con el valor ALMACENADO y no el del diseño', () => {
  const spec = documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'));
  assert.equal(spec.name, 'uk_templates_application_key_locale');
  assert.equal(spec.collection, 'templates');
  assert.equal(spec.documentClass, 'TemplateDocument');
  // `active` en el diseño, `ACTIVE` en el almacén. Medir con el literal del diseño daría verde
  // sobre un índice que no casa con ningún documento: el defecto que estuvo meses en pie en la
  // rama relacional, aquí igual de invisible.
  assert.equal(spec.partialFilter.equals, 'ACTIVE');
  assert.notEqual(spec.partialFilter.equals, spec.when.equals);
});

test('documental: un diseño sin unicidad condicionada no tiene nada que medir', () => {
  assert.equal(documentIndexSubject(modeloDe('asset-vault', 'mongodb')), null);
  assert.equal(documentIndexSubject(modeloDe('job-dispatch-mongo', 'mongodb')), null);
});

test('documental: las rutas del sujeto son las que el emisor puso en MongoIndexConfig', () => {
  // El cruce anti-copia, el mismo que hace `substrateSql` en la rama relacional: si el spec
  // nombrara una ruta que el config no crea, el check mediría un índice que en el servicio de
  // verdad no existe, y saldría verde.
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const spec = documentIndexSubject(model);
  const config = configDe(model);
  for (const ruta of spec.paths) assert.ok(config.includes(`.on("${ruta}"`), `MongoIndexConfig no indexa ${ruta}`);
  assert.ok(config.includes(`.named("${spec.name}")`));
  assert.ok(config.includes(`Criteria.where("${spec.partialFilter.path}").is("${spec.partialFilter.equals}")`));
});

test('documental: las aserciones son las mismas TRES que la relacional, con los mismos ids', () => {
  // Una asimetría entre ramas es la forma exacta que tenían los ocho defectos que motivaron la
  // matriz de paridad: un id que exista en una y no en la otra deja media garantía sin medir.
  const relacional = assertions(indexSubject(modeloDe('notification-mailer', 'postgresql'))).map((a) => a.id);
  const documental = documentAssertions(documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'))).map(
    (a) => a.id
  );
  assert.deepEqual(documental, relacional);
  assert.deepEqual(documental, ['exclusividad', 'historia', 'independencia']);
});

test('documental: exclusividad repite la clave del índice y CAMBIA la de la natural', () => {
  const spec = documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'));
  const [primero, segundo] = documentAssertions(spec).find((a) => a.id === 'exclusividad').steps;
  const valorDe = (paso, ruta) => paso.doc.find(([path]) => path === ruta)?.[1];

  assert.equal(primero.expect, 'ok');
  assert.equal(segundo.expect, 'reject');
  // Las claves del índice condicionado, iguales; el estado, dentro de la condición en los dos.
  for (const ruta of spec.paths) assert.equal(valorDe(segundo, ruta), valorDe(primero, ruta));
  assert.equal(valorDe(primero, spec.partialFilter.path), spec.partialFilter.equals);
  assert.equal(valorDe(segundo, spec.partialFilter.path), spec.partialFilter.equals);

  // Y la parte que hace fallable el caso: con la MISMA clave natural quien rechazaría es el
  // índice natural, y el condicionado no se habría medido. Aquí tienen que diferir.
  const propiaDeLaNatural = spec.naturalKeyPaths.filter((ruta) => !spec.paths.includes(ruta));
  assert.ok(propiaDeLaNatural.length > 0, 'sin campo propio de la clave natural el caso no discrimina');
  for (const ruta of propiaDeLaNatural) assert.notEqual(valorDe(segundo, ruta), valorDe(primero, ruta));
});

test('documental: historia son TRES documentos fuera de la condición y difiere de exclusividad solo en eso', () => {
  const spec = documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'));
  const historia = documentAssertions(spec).find((a) => a.id === 'historia');
  assert.equal(historia.steps.length, 3);
  assert.ok(historia.steps.every((paso) => paso.expect === 'ok'));
  for (const paso of historia.steps) {
    const estado = paso.doc.find(([path]) => path === spec.partialFilter.path)[1];
    assert.equal(estado, outsideValue(spec.partialFilter.equals));
    assert.notEqual(estado, spec.partialFilter.equals);
  }
  // Las claves del índice, las mismas que en exclusividad: lo único que cambia es el estado. Con
  // otra clave, el caso mediría que dos claves distintas conviven, que es `independencia`.
  const exclusividad = documentAssertions(spec).find((a) => a.id === 'exclusividad');
  const clave = (paso) => spec.paths.map((ruta) => paso.doc.find(([path]) => path === ruta)[1]);
  assert.deepEqual(clave(historia.steps[0]), clave(exclusividad.steps[0]));
});

test('documental: independencia mide las DOS mitades, y cada rechazo nombra su índice', () => {
  const spec = documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'));
  const pasos = documentAssertions(spec).find((a) => a.id === 'independencia').steps;

  // Otra clave puede tener la suya dentro de la condición.
  assert.equal(pasos[0].expect, 'ok');
  assert.equal(pasos[0].doc.find(([path]) => path === spec.partialFilter.path)[1], spec.partialFilter.equals);

  // Y la clave natural sigue restringiendo: un condicionado que la hubiera DESPLAZADO pasaría
  // todo lo demás. Esa mitad se perdería sola, y por eso tiene su paso.
  const rechazo = pasos.at(-1);
  assert.equal(rechazo.expect, 'reject');
  assert.equal(rechazo.index, spec.naturalKeyName);
  assert.deepEqual(rechazo.doc, pasos.at(-2).doc, 'el rechazo tiene que repetir el documento anterior byte a byte');
});

test('documental: TODO paso de rechazo nombra el índice que tiene que producirlo', () => {
  // Con la clave natural viva sobre la misma colección, un E11000 a secas no distingue al
  // condicionado del natural. Un paso sin `index` haría que el caso pasara por el motivo
  // equivocado, que es un verde sin medición.
  const spec = documentIndexSubject(modeloDe('notification-mailer-mongo', 'mongodb'));
  const rechazos = documentAssertions(spec).flatMap((a) => a.steps.filter((paso) => paso.expect === 'reject'));
  assert.ok(rechazos.length > 0);
  for (const paso of rechazos) assert.ok(paso.index, 'un paso de rechazo sin índice no discrimina quién rechazó');
  assert.deepEqual(
    [...new Set(rechazos.map((paso) => paso.index))].sort(),
    [spec.name, spec.naturalKeyName].sort(),
    'los rechazos tienen que repartirse entre el condicionado y el natural'
  );
});

// ─── El JUnit que se escribe en el proyecto generado ─────────────────────────

test('documental: el JUnit ejecuta la clase GENERADA, no una redacción suya', () => {
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const java = claseDe(model, documentIndexSubject(model));
  // Lo que separa esta rama de medir una copia de sí misma: se importa e invoca el bean que
  // build escribió. Si esto se sustituyera por unos createIndex propios, el check comprobaría
  // que Mongo sabe crear índices parciales y no que el generador acierta.
  assert.ok(java.includes('import x.config.MongoIndexConfig;'));
  assert.ok(java.includes('@Import(MongoIndexConfig.class)'));
  assert.ok(java.includes('ensureMongoIndexes.run(null)'));
  assert.equal(java.includes('createIndex'), true);
});

test('documental: el JUnit desactiva flapdoodle Y lo AFIRMA', () => {
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const java = claseDe(model, documentIndexSubject(model));
  // Las dos desactivaciones. Sin ellas la suite mediría un mongod embebido y standalone y
  // saldría verde sin tocar el contenedor.
  assert.ok(java.includes('"spring.profiles.active="'));
  assert.ok(java.includes('@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)'));
  // Y la aserción, que es lo único que hace fallable la decisión: desactivarlas sin comprobarlo
  // deja el mismo verde que no desactivarlas.
  assert.ok(java.includes('void seMideLaBaseDelContenedorYNoUnMongodEmbebido()'));
  assert.ok(java.includes('notification_mailer_mongo'));
  assert.ok(java.includes('getString("setName")'));
});

test('documental: el caso del literal lee el documento CRUDO, no por el mapeo', () => {
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const spec = documentIndexSubject(model);
  const java = claseDe(model, spec);
  assert.ok(java.includes(`void ${LITERAL_CASE}()`));
  // Escribe por el mapeo…
  assert.ok(java.includes('mongo.save(row)'));
  assert.ok(java.includes('row.setStatus(TemplateStatus.ACTIVE)'));
  // …y lee por la colección. Leerlo por el mapeo no serviría: Spring Data usa la misma anotación
  // para escribir y para leer, así que un valor equivocado pero consistente daría la vuelta
  // entera sin que se note.
  assert.ok(java.includes('getCollection(COLECCION).find(new Document()).first()'));
  assert.ok(java.includes(`assertEquals("${spec.partialFilter.equals}", crudo.get(RUTA_CONDICION)`));
});

test('documental: cada caso rehace la colección, porque JUnit no garantiza el orden', () => {
  // Los casos de idempotencia dejan la colección sin índices. Si un caso de efecto corriera
  // después y solo vaciara, mediría una colección SIN índice y saldría verde por ausencia de
  // garantía — el desenlace exacto que este check existe para cazar.
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const java = claseDe(model, documentIndexSubject(model));
  const cuerpos = java.split('@Test').slice(1);
  const efectos = cuerpos.filter((cuerpo) => /void (exclusividad|historia|independencia)\(/.test(cuerpo));
  assert.equal(efectos.length, 3);
  for (const cuerpo of efectos) assert.ok(cuerpo.includes('reset();'), 'un caso de efecto sin reset() mide lo que le dejaron');
  assert.ok(java.includes('private void reset() {'));
  assert.ok(/private void reset\(\) \{\s*mongo\.getDb\(\)\.getCollection\(COLECCION\)\.drop\(\);\s*creaIndices\(\);/.test(java));
});

test('documental: una ruta con punto se ANIDA en vez de escribirse como nombre de campo', () => {
  // `new Document("a.b", v)` crea un campo LLAMADO "a.b", que no es lo que indexa un
  // partialFilterExpression sobre `a.b`. Con el sujeto de hoy las rutas son planas, así que el
  // caso usa un spec fabricado: sin él, el día que una fixture indexe dentro de un value object
  // el índice no casaría con nada y el rojo acusaría al generador.
  const model = modeloDe('notification-mailer-mongo', 'mongodb');
  const spec = documentIndexSubject(model);
  const anidado = {
    ...spec,
    paths: ['price.amount', 'price.currency'],
    naturalKeyPaths: ['price.amount'],
    partialFilter: { ...spec.partialFilter, path: 'audit.state' }
  };
  const java = claseDe(model, anidado);
  assert.ok(java.includes('new Document("price", new Document("amount"'), 'la ruta con punto no se anidó');
  assert.ok(!java.includes('new Document("price.amount"'), 'la ruta con punto se escribió como nombre de campo');
});

// ─── Las pasadas declaradas ──────────────────────────────────────────────────

test('cada pasada que declara `npm run index-check` tiene un sujeto que medir', () => {
  // La cola más barata de romper sin que se note: quitarle el `when` a una fixture, o cambiarle
  // el modelo de persistencia. El runner moriría con exit 2 —que es correcto— pero solo cuando
  // alguien lo ejecutara con contenedores delante, o sea meses después. Aquí falla en `npm test`.
  //
  // Y cubre la otra mitad: que las TRES pasadas sigan declaradas. Borrar la documental dejaría
  // esta suite en verde con la rama entera sin ejecutar por nadie.
  const script = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts[
    'index-check'
  ];
  const pasadas = script
    .split('&&')
    .map((tramo) => tramo.trim().split(/\s+/).slice(1))
    .map((argv) => ({
      fixture: argv.find((arg) => !arg.startsWith('--') && !arg.endsWith('.js')),
      database: argv.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql'
    }));

  assert.ok(pasadas.length >= 3, `index-check declara ${pasadas.length} pasada(s): faltan ramas`);

  const ramas = new Set();
  for (const { fixture, database } of pasadas) {
    const { layers, manifest, errors } = loadService(path.join(fixturesDir, fixture));
    assert.deepEqual(errors, [], `${fixture} no valida`);
    const documental = (layers.persistence?.default?.model ?? 'relational') === 'document';
    // El motor lo declara el DISEÑO en la rama documental: un `--database=` ahí no significa nada.
    const model = modeloDe(fixture, documental ? 'mongodb' : database);
    const spec = documental ? documentIndexSubject(model) : indexSubject(model);
    assert.ok(spec, `la pasada '${fixture}' (${database}) no tiene índice condicionado que medir`);
    assert.ok(spec.partialFilter?.equals ?? spec.stored, `${fixture}: el sujeto no trae el valor almacenado`);
    ramas.add(documental ? 'document' : 'relational');
    assert.ok(manifest);
  }
  assert.deepEqual([...ramas].sort(), ['document', 'relational'], 'index-check dejó de cubrir las dos ramas');
});
