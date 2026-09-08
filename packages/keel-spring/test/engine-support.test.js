// Que la matriz de paridad siga diciendo la verdad, y que no se pueda ampliar el generador sin
// pasar por ella.
//
// La matriz vale exactamente lo que valga su honestidad: una tabla que se rellena a ojo es peor
// que no tenerla, porque apaga la sospecha. De ahí que estos casos no comprueben «hay filas» sino
// las tres cosas que la hacen fallable:
//
//   1. que nombre redes que EXISTEN (una red inventada es una promesa);
//   2. que un `razonado` traiga dueño escrito — es una excepción, nunca el estado por defecto;
//   3. que un motor nuevo del catálogo NO pueda colarse sin fila, que es exactamente el agujero
//      por el que MariaDB, SQL Server y Oracle se quedaron sin poder tener escenarios.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MECHANISMS, MODELS, STATES, NETS, cells, unverified, unfalsified, degraded } from '../src/lib/engine-support.js';
import { DATABASES } from '../src/lib/stack-catalog.js';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

test('la matriz cubre algo', () => {
  assert.ok(Object.keys(MECHANISMS).length >= 10, 'una matriz con cuatro filas no es una matriz');
  assert.ok(cells().length >= 25);
});

// ─── Cada fila apunta a algo real ────────────────────────────────────────────

for (const [id, mechanism] of Object.entries(MECHANISMS)) {
  test(`${id}: su emisor existe y su porqué está escrito`, () => {
    for (const file of mechanism.emitter.split(' · ')) {
      assert.ok(fs.existsSync(path.join(pkgRoot, file)), `${id}: ${file} no existe`);
    }
    // El `why` de la fila dice cuál es el modo de fallo. Sin él, quien la lea dentro de un año no
    // sabrá si sigue habiendo algo que medir.
    assert.ok((mechanism.why ?? '').length >= 40, `${id}: sin porqué, la fila no dice qué se perdería`);
    assert.ok(['model', 'engine'].includes(mechanism.axis), `${id}: eje desconocido '${mechanism.axis}'`);
  });
}

// ─── Los ejes: nadie se queda fuera por olvido ───────────────────────────────

const engineIds = Object.keys(DATABASES);

for (const [id, mechanism] of Object.entries(MECHANISMS)) {
  if (mechanism.axis === 'model') {
    test(`${id}: cubre los DOS modelos`, () => {
      assert.deepEqual(Object.keys(mechanism.coverage).sort(), [...MODELS].sort());
    });
  } else {
    test(`${id}: cubre TODOS los motores del catálogo`, () => {
      // Esta es la que protege al SIGUIENTE motor que alguien añada. `CLAUDE.md` dice que uno de
      // un `kind` que ya existe «no necesita nada más para generar», y es verdad — pero sí para
      // poder probarse, y esa mitad es la que se olvidaba.
      assert.deepEqual(
        Object.keys(mechanism.coverage).sort(),
        [...engineIds].sort(),
        `${id}: la fila y el catálogo de motores han dejado de decir lo mismo`
      );
    });
  }
}

// ─── Las celdas ──────────────────────────────────────────────────────────────

for (const { id, key, cell } of cells()) {
  test(`${id}/${key}: estado y red declarados y conocidos`, () => {
    assert.ok(STATES[cell.state], `${id}/${key}: estado '${cell.state}' desconocido`);
    assert.ok(NETS[cell.net], `${id}/${key}: red '${cell.net}' desconocida`);
    assert.equal(typeof cell.falsified, 'boolean', `${id}/${key}: falsified tiene que ser explícito`);
  });

  test(`${id}/${key}: lo que no está ejecutado dice por qué`, () => {
    if (cell.state === 'razonado' || cell.state === 'degradado') {
      assert.ok(
        (cell.why ?? '').length >= 40,
        `${id}/${key}: '${cell.state}' sin dueño escrito. Es una excepción, no el estado por defecto`
      );
      assert.equal(cell.falsified, false, `${id}/${key}: no se puede haber falsado lo que no se ejecuta`);
    }
  });

  test(`${id}/${key}: lo verificado nombra quién lo ejecuta`, () => {
    if (cell.state !== 'verificado') return;
    assert.notEqual(cell.net, 'ninguna', `${id}/${key}: verificado sin red que lo ejecute`);
    // Una red mecánica tiene que ser un script de verdad; `corrida` es la escotilla honesta para
    // lo que solo mide una corrida en vivo, y no se puede automatizar.
    if (cell.net !== 'corrida') {
      assert.ok(pkg.scripts?.[cell.net], `${id}/${key}: '${cell.net}' no es un script de package.json`);
    }
  });

  test(`${id}/${key}: una red sin falsar se declara como lo que es`, () => {
    if (cell.state === 'verificado' && cell.falsified !== true) {
      assert.ok(
        (cell.why ?? '').length >= 40,
        `${id}/${key}: red sin falsar y sin explicación. Una red que nunca se ha roto a propósito no ` +
          'distingue «no hay errores» de «no mira» — pasó con mongo-check, verde durante meses midiendo ' +
          'una copia de sí misma'
      );
    }
  });
}

// ─── Coherencia con el catálogo de motores ───────────────────────────────────

test('los motores que cita una fila por modelo existen y son de ese modelo', () => {
  for (const { id, key, cell } of cells()) {
    for (const engine of cell.engines ?? []) {
      const entry = DATABASES[engine];
      assert.ok(entry, `${id}/${key}: el motor '${engine}' no está en el catálogo`);
      assert.equal(
        entry.kind,
        key === 'document' ? 'document' : 'relational',
        `${id}/${key}: '${engine}' no es de ese modelo`
      );
    }
  }
});

test('una celda de MODELO verificada por una red mecánica nombra sobre qué motores corrió', () => {
  // Solo el eje de modelo: en el de motor la clave ES el motor, y repetirlo dentro sería una
  // segunda copia del mismo dato — justo lo que esta matriz existe para evitar.
  for (const { id, mechanism, key, cell } of cells()) {
    if (mechanism.axis !== 'model') continue;
    if (cell.state !== 'verificado' || cell.net === 'corrida') continue;
    assert.ok((cell.engines ?? []).length > 0, `${id}/${key}: verificado por ${cell.net} y sin motores`);
  }
});

// ─── Las tres listas con las que se decide qué hacer después ─────────────────

test('lo no ejecutado, lo no falsado y lo degradado salen ordenados y con su porqué', () => {
  for (const lista of [unverified(), unfalsified(), degraded()]) {
    const ids = lista.map((row) => `${row.id}/${row.key}`);
    assert.deepEqual(ids, [...ids].sort(), 'la lista no es determinista: no sirve para comparar entre ejecuciones');
    for (const row of lista) assert.ok(row.why, `${row.id}/${row.key} sin porqué`);
  }
});

test('la matriz reconoce que todavía queda trabajo', () => {
  // Si esto llegara a fallar por vacío sería una gran noticia — y habría que comprobar que no es
  // que alguien haya puesto todo en 'verificado' para callarla.
  assert.ok(
    unverified().length + unfalsified().length > 0,
    'la matriz dice que no queda nada sin ejecutar ni sin falsar: compruébalo antes de celebrarlo'
  );
});

test('la lista de degradadas trae las tres piezas que la hacen una decisión', () => {
  // Sin la garantía y la consecuencia es una mala noticia; sin las salidas, ni siquiera eso.
  // Y son las salidas las que hay que releer al volver por aquí: la de MySQL enumeró durante
  // meses la salida cara (una columna generada declarada) mientras existía una barata —una parte
  // funcional de índice— que nadie había buscado, y esa lectura mantuvo la celda degradada.
  const esperadas = cells().filter(({ cell }) => cell.state === 'degradado').map(({ id, key }) => `${id}/${key}`);
  assert.deepEqual(degraded().map((row) => `${row.id}/${row.key}`), esperadas.sort());
  for (const row of degraded()) {
    assert.ok(row.guarantee, `${row.id}/${row.key}: no dice qué garantía se pierde`);
    assert.ok(row.consequence, `${row.id}/${row.key}: no dice qué pasa en su lugar`);
    assert.ok(row.ways.length > 0, `${row.id}/${row.key}: sin salidas es una mala noticia, no una decisión`);
  }
});

test('los cuatro estados PARTICIONAN las celdas: ninguna puede quedarse sin contar', () => {
  // Este es el caso que faltaba, y el que explica por qué las degradadas pasaron desapercibidas:
  // `unverified` filtra por 'razonado' y `unfalsified' por 'verificado', así que una celda
  // 'degradado' no salía en ninguna lista NI se contaba en el RESUMEN —que sumaba verificadas,
  // falsadas y sin ejecutar, tres cifras que no particionan nada—. El resultado es que
  // `npm run matrix` podía cerrar con «SIN FALSAR: (ninguna)» y parecer terminado teniendo una
  // garantía del diseño que nada sostiene en un motor que el catálogo ofrece.
  //
  // Se afirma sobre `STATES` y no sobre una lista escrita a mano: así, un estado NUEVO rompe este
  // caso en vez de abrir el mismo agujero otra vez.
  const porEstado = Object.fromEntries(
    Object.keys(STATES).map((state) => [state, cells().filter(({ cell }) => cell.state === state).length])
  );
  const suma = Object.values(porEstado).reduce((a, b) => a + b, 0);
  assert.equal(suma, cells().length, `los estados no particionan las celdas: ${JSON.stringify(porEstado)}`);

  // Y las dos listas que proyectan un estado tienen que coincidir con su recuento: si divergen,
  // el RESUMEN cuenta una cosa y la lista enseña otra.
  assert.equal(unverified().length, porEstado.razonado);
  assert.equal(degraded().length, porEstado.degradado);
});

test('mover una celda de estado la cambia de lista, y ninguna se evapora por el camino', () => {
  // La falsación del caso de arriba: sin ella, «los estados particionan» podría ser cierto por
  // casualidad sobre la tabla de hoy. Se toca una celda de verdad y se devuelve en el finally.
  const [muestra] = cells().filter(({ cell }) => cell.state === 'degradado');
  assert.ok(muestra, 'sin ninguna celda degradada este caso no mide nada');

  const antes = { razonado: unverified().length, degradado: degraded().length };
  const original = MECHANISMS[muestra.id].coverage[muestra.key].state;
  MECHANISMS[muestra.id].coverage[muestra.key].state = 'razonado';
  try {
    assert.equal(degraded().length, antes.degradado - 1, 'la celda no salió de las degradadas');
    assert.equal(unverified().length, antes.razonado + 1, 'la celda no apareció en las sin ejecutar');
    assert.equal(
      degraded().length + unverified().length,
      antes.degradado + antes.razonado,
      'la celda se evaporó: es el modo de fallo que este caso existe para cazar'
    );
  } finally {
    MECHANISMS[muestra.id].coverage[muestra.key].state = original;
  }
});
