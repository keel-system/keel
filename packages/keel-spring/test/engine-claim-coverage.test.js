// Que ningún motor relacional vuelva a quedarse a medias para el RECLAMO.
//
// Tres campos del catálogo deciden si, sobre un motor, los escenarios del rescate y de la
// reconciliación PUEDEN EXISTIR: `staleTimestamp` (el instante rancio con el que el arnés
// fabrica la precondición), `uuidLiteral` (cómo se nombra una fila en una sentencia a mano) y
// una forma de invocación por CLI. Los tres se leen con la misma regla —«donde no consta, no se
// emite»— y los tres callan: `rescueSection`, `reconciliationAgingSection` y
// `abandonOutboxSection` devuelven cadena vacía y nadie se entera.
//
// Eso dejó a MariaDB, SQL Server y Oracle en un estado que no se veía mirando el verde: sobre
// ellos, un diseño con rescate o con `reconciledBy` no podía tener el escenario `FL-*` que
// `crossrefs.js` le EXIGE —y esa exigencia se emite en keel-core, antes de elegir stack—. Es el
// mismo agujero por el que se retiró H2, con la diferencia de que aquí no había ni aviso.
//
// Este archivo no protege a los cinco de hoy: protege al SIGUIENTE que alguien añada, que según
// CLAUDE.md «no necesita nada más para generar» y es verdad — pero sí para poder probarse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DATABASES } from '../src/lib/stack-catalog.js';

// Cómo se sabe que el valor declarado es el correcto. La distinción importa porque el modo de
// fallo de estos campos es SILENCIOSO: un literal que no casa no da error, deja el UPDATE en
// cero filas y el escenario en verde sin haber atascado nada. Solo ejecutarlo lo distingue.
const MOTIVOS = {
  verificado: 'ejecutado contra el motor real con `node scripts/claim-check.js job-dispatch --database=<motor>`',
  razonado:
    'declarado con su porqué y NO ejecutado: ninguna red lo mira —java-syntax borra los literales antes de ' +
    'tokenizar y compile-check los mete en un javaString() que escapa siempre—, así que si es incorrecto el ' +
    'escenario del rescate pasará en verde sin haber atascado nada. Se cierra ejecutando claim-check con ese motor'
};

// Un motor relacional nuevo no compila esta tabla por accidente: o se ejecuta su claim-check, o
// se escribe aquí por qué se declara sin ejecutar. «Razonado» es una excepción con dueño, nunca
// el estado por defecto.
const ESTADO = {
  postgresql: 'verificado',
  mysql: 'verificado',
  mariadb: 'verificado',
  sqlserver: 'razonado',
  oracle: 'razonado'
};

const relacionales = Object.entries(DATABASES).filter(([, entry]) => entry.kind === 'relational');

test('hay motores relacionales que cubrir', () => {
  assert.ok(relacionales.length >= 5, `esperaba al menos 5, encontré ${relacionales.length}`);
});

for (const [id, entry] of relacionales) {
  test(`${id}: declara con qué fabricar la precondición de un rescate`, () => {
    assert.ok(entry.staleTimestamp, `${id}: sin staleTimestamp el arnés no emite stallInFlight ni ageForReconciliation`);
    assert.ok(entry.uuidLiteral?.prefix !== undefined, `${id}: sin uuidLiteral no hay forma de nombrar la fila`);
    assert.ok(entry.uuidLiteral?.suffix !== undefined, `${id}: uuidLiteral incompleto`);
  });

  test(`${id}: declara una forma de invocación por CLI`, () => {
    // Dos formas válidas: la sentencia como un elemento más del argv, o —cuando el cliente no
    // tiene flag que la tome, como sqlplus— por ARCHIVO. Ninguna es «no declarar nada»: eso
    // apagaba en silencio las cuatro secciones que componen SQL.
    assert.ok(entry.cliQueryArgv, `${id}: sin cliQueryArgv el arnés no puede hablar con la base`);
    if (entry.cliQueryForm === 'scriptFile') {
      assert.equal(typeof entry.cliScript, 'function', `${id}: forma scriptFile sin envoltorio`);
      assert.ok(entry.cliScriptExtension, `${id}: forma scriptFile sin extensión`);
    } else {
      assert.equal(entry.cliQueryForm, undefined, `${id}: forma de invocación desconocida`);
    }
  });

  test(`${id}: dice cómo se sabe que sus literales son correctos`, () => {
    const estado = ESTADO[id];
    assert.ok(estado, `${id}: motor nuevo sin estado declarado. O se ejecuta su claim-check, o se escribe por qué no`);
    assert.ok(MOTIVOS[estado], `${id}: estado '${estado}' desconocido`);
  });
}

test('la tabla de estados no arrastra motores que ya no existen', () => {
  // Sin esto, la tabla se convierte en la lista de lo que hubo alguna vez y deja de decir nada
  // del catálogo de hoy — que es como sobrevivió `h2` en media docena de sitios.
  const ids = new Set(relacionales.map(([id]) => id));
  for (const id of Object.keys(ESTADO)) {
    assert.ok(ids.has(id), `${id} está en la tabla y no en el catálogo`);
  }
});
