// Que las dos ramas del reclamo de RECONCILIACIÓN sigan teniendo quien las mida.
//
// `store-check` ejercita ese reclamo contra el motor real, y sus sujetos son dos fixtures
// DISTINTAS: `stock-reservation` en la rama relacional y `asset-vault` en la documental. No son
// un par byte a byte como `job-dispatch`/`-mongo` o `notification-mailer`/`-mongo`, y esa
// diferencia tiene una consecuencia que hay que cerrar aquí: la propiedad que en aquellos
// garantiza el par —que las dos ramas vean el MISMO diseño— aquí no la garantiza nadie.
//
// El fallo que eso permite es el de siempre en este repo, y es silencioso: si alguien «arregla»
// el diseño de una de las dos —le quita el `reconciledBy`, le cambia el `awaitingSince`, le mueve
// el estado de espera— esa rama deja de generar reclamo, `store-check` deja de emitir su clase de
// prueba, y **la pasada sigue saliendo en verde** midiendo un mecanismo menos. Nadie lo ve
// mirando el resultado: pasa de 16/16 a 11/11 y las dos cifras son verdes.
//
// Es el mismo papel que hace `rescue-shape-coverage.test.js` con su par, por el mismo motivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { reconciliationClaims } from '../src/scaffold/reconciliation-claim.js';
import { storeSubjects, storeTestClasses, CLASS_RECONCILIATION } from '../src/lib/store-probes.js';
import { mainCompilable } from '../src/lib/main-compilable.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Los paquetes no importan en estos dos casos: lo que se mira es el texto de la clase, no dónde
// cae. Que caiga donde debe ya lo cubre store-probes.test.js contra el árbol generado de verdad.
const PAQUETES_FICTICIOS = {
  outbox: 'x', dedupe: 'x', commandStore: 'x', storePort: 'x', conflict: 'x', mongoTx: 'x',
  reconciliation: 'x', enums: 'x', entities: 'x', port: 'x', adapters: 'x', jpaRepositories: 'x'
};

// Los sujetos, uno por rama. Si esta tabla cambia, cambia lo que `store-check` mide — y por eso
// el nombre del motor va aquí y no solo en el `package.json`: son la misma decisión.
const SUJETOS = [
  { fixture: 'stock-reservation', engine: 'postgresql', document: false },
  { fixture: 'asset-vault', engine: 'mongodb', document: true }
];

function modeloDe({ fixture, engine }) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `${fixture} no carga`);
  return { model: buildModel({ manifest, layers, stack: { database: engine } }), layers };
}

for (const sujeto of SUJETOS) {
  test(`${sujeto.fixture}: sigue produciendo un reclamo de reconciliación`, () => {
    const { model } = modeloDe(sujeto);
    const claims = reconciliationClaims(model);

    // `reconciliationClaims` devuelve solo los que build PUDO generar sin inventar nada: sin
    // `awaitingSince`, sin lifecycle o con varias entidades esperando, devuelve vacío y deja un
    // designGap. Un diseño así no es un error, pero deja a esta rama sin nada que ejercitar.
    assert.equal(
      claims.length > 0,
      true,
      `${sujeto.fixture} dejó de generar reclamo de reconciliación: store-check deja de medir esa rama y sigue en verde`
    );

    const claim = claims[0];
    // Las cuatro piezas de las que cuelgan los casos. Sin cualquiera de ellas el JUnit no
    // compila, y el runner reportaría «la suite no llegó a ejecutarse» — un rojo que no
    // distingue un generador roto de un check desincronizado.
    assert.ok(claim.activation, 'el reclamo no nombra su activación');
    assert.ok(claim.awaitingField, 'el reclamo no nombra la marca de espera');
    assert.ok(claim.states?.length > 0, 'el reclamo no nombra ningún estado de espera');
    assert.ok(claim.configKey, 'el reclamo no nombra su clave de parameters/');
  });

  test(`${sujeto.fixture}: es la rama ${sujeto.document ? 'documental' : 'relacional'}`, () => {
    const { model } = modeloDe(sujeto);
    assert.equal(
      storeSubjects(model).document,
      sujeto.document,
      `${sujeto.fixture} cambió de modelo de persistencia: las dos ramas del reclamo dejan de estar cubiertas`
    );
  });

  test(`${sujeto.fixture}: su main compila, que es lo que store-check necesita`, () => {
    const { layers } = modeloDe(sujeto);
    const { compilable, motivo } = mainCompilable(layers);
    // `store-check` corre `gradlew test`, que compila el proyecto ENTERO. Una fixture cuyo main
    // no compile no puede ser sujeto: la pasada moriría antes de ninguna aserción.
    assert.equal(compilable, true, `${sujeto.fixture} dejó de compilar su main: ${motivo}`);
  });

  test(`${sujeto.fixture}: el lifecycle tiene un estado FUERA de la espera`, () => {
    // El caso que afirma que el barrido discrimina por estado necesita una constante de enum que
    // no sea de espera. Si el lifecycle se quedara solo con estados de espera, ese caso no se
    // podría escribir — y `store-probes.js` lo dice en voz alta en vez de emitir un Java que no
    // compila, así que esto es lo que lo avisa antes de llegar al motor.
    const { model } = modeloDe(sujeto);
    const claim = reconciliationClaims(model)[0];
    const entity = model.entities.find((candidate) => candidate.name === claim.entity);
    const estados = new Set();
    for (const transition of entity.lifecycle.transitions ?? []) {
      estados.add(transition.from);
      for (const to of transition.to ?? []) estados.add(to);
    }
    const espera = new Set(claim.states.map((state) => state.toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2')));
    assert.ok(
      [...estados].some((estado) => !espera.has(estado)),
      `${entity.name} se quedó sin ningún estado fuera de la espera`
    );
  });
}

test('en MySQL el reclamo se llama con el aislamiento que el barrido le da', () => {
  // Esto no es un detalle del check: es lo que hace que el reclamo FUNCIONE en MySQL.
  //
  // El reclamo son dos pasos —UPDATE condicional y, si no casó, INSERT en una transacción
  // REQUIRES_NEW, o sea en otra conexión—. Con la marca aún sin existir el UPDATE no casa nada,
  // pero bajo REPEATABLE READ InnoDB toma igualmente los gap locks del rango que escaneó, y el
  // INSERT se queda esperando un hueco que bloquea su propia transacción padre: muere en lock-wait
  // timeout, `claim()` lo lee como «otra réplica lo tiene» y el barrido no reclama NADA.
  //
  // En producción lo evita el @Transactional del barrido, que en MySQL/MariaDB lleva
  // READ_COMMITTED explícito (lib/claim-sql.js). El check tiene que llamar con lo mismo o mide
  // una configuración que no existe — y la primera versión lo hizo: cinco casos en rojo.
  //
  // Se vigila porque el interruptor se apagó SOLO una vez: el motor se leía de `model.stack`,
  // que `buildModel` no expone, así que valía `undefined`, `needsReadCommitted` daba false y la
  // línea dejaba de emitirse sin que nada lo dijera. Se vio porque el check se puso rojo; con un
  // motor donde no hiciera falta, no se habría visto.
  const { model } = modeloDe({ fixture: 'stock-reservation', engine: 'mysql' });
  const subjects = storeSubjects(model);
  const clase = storeTestClasses(model, subjects, {
    datasource: { url: 'jdbc:x', username: 'u', password: 'p' },
    packages: PAQUETES_FICTICIOS,
    database: 'mysql'
  }).find((candidata) => candidata.className === CLASS_RECONCILIATION);

  assert.ok(
    clase.content.includes('setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED)'),
    'el check llamaría al reclamo con el aislamiento por defecto: en MySQL eso no lo mide, lo rompe'
  );
  assert.ok(
    clase.content.includes('import org.springframework.transaction.TransactionDefinition;'),
    'se pide el aislamiento sin importar el tipo: no compilaría'
  );
});

test('y en PostgreSQL no se pide, porque ahí ya es el defecto', () => {
  // Anotar READ_COMMITTED donde el motor ya arranca en él sugiere una decisión donde no la hay.
  // Es el mismo criterio que aplica claim-sql.js al generar.
  const { model } = modeloDe({ fixture: 'stock-reservation', engine: 'postgresql' });
  const clase = storeTestClasses(model, storeSubjects(model), {
    datasource: { url: 'jdbc:x', username: 'u', password: 'p' },
    packages: PAQUETES_FICTICIOS,
    database: 'postgresql'
  }).find((candidata) => candidata.className === CLASS_RECONCILIATION);

  assert.ok(!clase.content.includes('setIsolationLevel'), 'se pide un aislamiento que este motor ya trae');
});

test('las dos ramas del reclamo de reconciliación siguen cubiertas', () => {
  // La afirmación de conjunto, que es la que de verdad importa: una de cada. Con las dos en la
  // misma rama, la otra deja de ejecutarse y no lo dice nadie.
  const ramas = SUJETOS.map((sujeto) => storeSubjects(modeloDe(sujeto).model).document);
  assert.deepEqual([...ramas].sort(), [false, true], 'store-check dejó de cubrir una de las dos ramas');
});
