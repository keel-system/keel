// De dónde salen los nombres con los que `claim-check` ejercita el reclamo.
//
// El runner no puede correr en `npm test` —necesita contenedores y JDK— pero sí se puede
// comprobar aquí lo único que lo hace fiel: que todo lo que el Java nombra salga del MODELO. Un
// runner con sus propios nombres de método pasaría en verde contra un generador que emite otros,
// y estaría comprobando que Postgres responde en vez de que el reclamo es correcto. Es la misma
// regla que ata `mongo-probes.js` a su arnés, y aquí pesa más: el reclamo es una CADENA (el JPQL
// de un `@Query`) que javac da por buena diga lo que diga.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { claimScenarios, claimTestClass, harnessProbes, BATCH_SIZE, CLASS_NAME } from '../src/lib/claim-probes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const PACKAGES = {
  enums: 'com.test.domain.enums',
  port: 'com.test.domain.repository',
  entities: 'com.test.infrastructure.persistence.entities',
  repositories: 'com.test.infrastructure.persistence.repositories'
};

function scenariosOf(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const model = buildModel({ manifest, layers, stack: { database: 'postgresql' } });
  return { model, scenarios: claimScenarios(model) };
}

function render(fixture = 'job-dispatch') {
  const { model, scenarios } = scenariosOf(fixture);
  return {
    model,
    scenarios,
    java: claimTestClass(model, scenarios, {
      datasource: { url: 'jdbc:postgresql://localhost:5432/x', username: 'u', password: 'p' },
      packages: PACKAGES,
      database: 'postgresql'
    })
  };
}

test('las dos clases de reclamo salen del modelo, no de una lista', () => {
  const { scenarios } = render();
  assert.equal(scenarios.entity.name, 'Job');
  assert.equal(scenarios.enumType, 'JobStatus');
  assert.equal(scenarios.statusField, 'status');
  // La de COLA estampa el reloj; la de RESCATE lleva cota temporal. Confundirlas es el error
  // que este módulo existe para no cometer.
  assert.equal(scenarios.queue.method, 'claimForDispatchJobsRunning');
  assert.equal(scenarios.queue.stamps.field, 'runningSince');
  assert.equal(scenarios.rescue.method, 'claimForStalledDispatchJobsDone');
  assert.equal(scenarios.rescue.stalled.stampField, 'runningSince');
});

test('un diseño sin reclamo no produce escenarios: el runner lo dice en vez de mirar nada', () => {
  const { scenarios } = scenariosOf('product-catalog');
  assert.deepEqual(scenarios.claims, []);
  assert.equal(scenarios.queue, undefined, 'sin reclamos no hay cola que ejercitar');
});

test('el Java llama a los métodos que build emitió, con las constantes del lifecycle', () => {
  const { java } = render();
  assert.match(java, /adaptador\.claimForDispatchJobsRunning\(\)/);
  assert.match(java, /adaptador\.claimForStalledDispatchJobsDone\(\)/);
  assert.match(java, /JobStatus\.QUEUED/);
  assert.match(java, /JobStatus\.RUNNING/);
  assert.match(java, /JobStatus\.DONE/);
});

test('las claves de parameters/ son las del barrido, no inventadas', () => {
  // Si el test fijara otra clave, el adaptador leería su default y la cota medida no sería la
  // que el escenario cree estar midiendo — un verde que no significa nada.
  const { java, scenarios } = render();
  assert.match(java, new RegExp(`sweep\\.${scenarios.queue.sweepKey}\\.batch-size=${BATCH_SIZE}`));
  assert.match(java, new RegExp(`sweep\\.${scenarios.rescue.stalled.configKey}\\.stalled-after-seconds=`));
});

test('la fila se siembra con TODOS los campos obligatorios de la entidad', () => {
  // Uno de menos y el INSERT lo rechaza el motor; el síntoma sería «el reclamo no se llevó
  // nada», indistinguible del defecto que se persigue.
  const { java, scenarios } = render();
  for (const field of scenarios.entity.fields) {
    if (!field.required || field.isId || field.name === scenarios.statusField) continue;
    const setter = `set${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`;
    assert.ok(java.includes(`row.${setter}(`), `falta sembrar el campo obligatorio ${field.name}`);
  }
});

test('el reloj se siembra y se afirma: sin él no hay rescate que medir', () => {
  const { java } = render();
  assert.match(java, /row\.setRunningSince\(reloj\)/);
  assert.match(java, /assertNotNull\(despues\.getRunningSince\(\)/);
});

test('el enum de un campo obligatorio se importa: sin el import el Java no compila', () => {
  const { java } = render();
  assert.ok(java.includes(`import ${PACKAGES.enums}.JobPriority;`));
  assert.ok(java.includes(`import ${PACKAGES.enums}.JobStatus;`));
});

test('el test no se envuelve en una transacción de prueba', () => {
  // El adaptador reclama con REQUIRES_NEW: una transacción de test alrededor dejaría las filas
  // sembradas sin commitear e invisibles para la del reclamo, y TODOS los casos saldrían en
  // «no se llevó nada» sin que hubiera nada roto.
  const { java } = render();
  assert.match(java, /@Transactional\(propagation = Propagation\.NOT_SUPPORTED\)/);
  assert.match(java, /@AutoConfigureTestDatabase\(replace = AutoConfigureTestDatabase\.Replace\.NONE\)/);
});

test('el runner no escribe a mano ningún nombre del reclamo: los renderiza de este módulo', () => {
  // La misma vigilancia que test/mongo-probes.test.js hace sobre integration-tests.js. Un
  // literal suelto en el script vuelve a partir la fuente en dos.
  const runner = fs.readFileSync(path.join(here, '..', 'scripts', 'claim-check.js'), 'utf8');
  // `pg_isready` está en la lista por lo mismo, y no es hipotético: el runner lo tuvo cableado y
  // eso lo ató a PostgreSQL — con cualquier otro motor moría a los 90 s en «no aceptó conexiones
  // a tiempo» sin haber ejecutado una sola aserción. El sondeo sale ahora de `databaseHealthProbe`.
  for (const literal of ['claimFor', '@DataJpaTest', 'JobStatus', 'saveAndFlush', 'stalled-after-seconds', 'UPDATE ', 'pg_isready']) {
    assert.ok(!runner.includes(literal), `scripts/claim-check.js cita '${literal}': tiene que salir de claim-probes.js`);
  }
  assert.ok(runner.includes(CLASS_NAME) === false || runner.includes('CLASS_NAME'), 'el nombre de la clase se importa');
});

test('el SQL del ARNÉS entra en la suite, con las columnas y el reloj del motor', () => {
  // El bloque que mide arnés y reclamo JUNTOS. Se emitía a partir de `model.stack.database`,
  // que `buildModel` no deja en el modelo: salía `undefined`, el bloque no se emitía y la suite
  // pasaba en verde con tres casos menos. Nadie lo habría notado — es la forma exacta de perder
  // cobertura sin que nada se ponga rojo, y por eso se afirma aquí y no solo allí.
  const { java, scenarios } = render();
  assert.match(java, /void elArnesAtascaLaFilaYElRescateSeLaLleva\(\)/);
  assert.match(java, /void elArnesPoneEnVueloYAhiElRescateNoToca\(\)/);
  assert.match(java, /void elContadorDeSinRelojDelArnesDiscrimina\(\)/);

  // Y con el SQL LITERAL del arnés: la tabla real, la columna del reloj y el reloj rancio del
  // motor. Si el arnés cambiara su forma y esto no, dejarían de medir lo mismo.
  const probes = harnessProbes(scenarios, 'postgresql');
  assert.ok(java.includes(probes.stall), 'el UPDATE que se ejecuta no es el que emite el arnés');
  assert.ok(java.includes(probes.missingClock), 'el contador que se ejecuta no es el del arnés');
  assert.match(probes.stall, /UPDATE jobs SET status = 'RUNNING', running_since = TIMESTAMP/);
});

test('sin rescate no hay SQL de arnés que medir, y no se inventa', () => {
  const { scenarios } = scenariosOf('product-catalog');
  assert.equal(harnessProbes(scenarios, 'postgresql'), null);
});

test('un motor que no declara su forma no emite el bloque en vez de inventarla', () => {
  // Mismo criterio que el arnés: donde no consta el reloj rancio o el literal de uuid, no se
  // emite el helper. Un UPDATE que no casa deja el escenario verde sin haber atascado nada.
  //
  // El sujeto era sqlserver, un motor REAL al que le faltaban los dos campos. Ya no: los cinco
  // relacionales los declaran, y `engine-claim-coverage.test.js` es lo que lo mantiene así. Así
  // que la rama se prueba con un motor sintético —el nivel correcto, igual que la rama sin
  // reparto de `claim.test.js`—: protege al SIGUIENTE que alguien añada, no a uno del catálogo.
  const { scenarios } = scenariosOf('job-dispatch');
  assert.equal(harnessProbes(scenarios, 'motor-que-alguien-anadira'), null);
  // Y la comprobación afirmativa, sin la cual la de arriba no distingue «no lo emite» de «este
  // diseño no tiene rescate»: con un motor del catálogo, el bloque sí sale.
  assert.ok(harnessProbes(scenarios, 'sqlserver'));
});

test('el arnés y el check comparten la DERIVACIÓN, no solo la plantilla', () => {
  // La lección más cara del paso: extraer solo las plantillas de SQL no bastó. `claim-check`
  // seguía calculando `snakeCase(campo)` por su cuenta, así que romper el arnés lo dejaba en
  // verde — medía una copia. Lo que tiene que salir de un sitio es la FORMA entera.
  const harness = fs.readFileSync(path.join(here, '..', 'src', 'scaffold', 'integration-tests.js'), 'utf8');
  assert.ok(harness.includes('rescueShape(entity, claim)'), 'el arnés dejó de compartir la forma del rescate');
  assert.ok(harness.includes('stallSql('), 'el arnés dejó de renderizar su UPDATE del módulo');
  assert.ok(harness.includes('missingClockCountSql('), 'el arnés dejó de renderizar su contador del módulo');
});

// ── La guarda de un efecto externo irreversible ──────────────────────────────

test('la guarda entra como sujeto aunque no viva en operation.claim', () => {
  // Vive en `operation.guardClaim`, que es otro campo y otro mecanismo: uno reclama el LOTE que
  // un barrido elige, la otra UNA fila cuyo id ya le dieron. Mirar solo `claim` la dejaba fuera,
  // y es la que peor se puede permitir estarlo: al otro lado hay un correo que sale.
  const { scenarios } = scenariosOf('notification-mailer');
  assert.ok(scenarios.guard, 'la guarda dejó de ser sujeto de claim-check');
  assert.equal(scenarios.guard.method, 'claimForSendAcceptedNotification');
  assert.equal(scenarios.guard.entity, scenarios.entity.name, 'la guarda es de otro agregado que el barrido');
  assert.equal(scenarios.guard.stampField, 'sendingSince');
});

test('y sus casos afirman lo que la guarda promete: que la SEGUNDA no se la lleve', () => {
  const { java } = render('notification-mailer');
  assert.match(java, /void laSegundaEjecucionDeLaMismaFilaNoSeLaLleva\(\)/);
  // Las dos llamadas con el mismo id, que es lo único que mide la exclusión.
  assert.match(java, /var primera = adaptador\.claimForSendAcceptedNotification\(id\);/);
  assert.match(java, /var segunda = adaptador\.claimForSendAcceptedNotification\(id\);/);
  assert.match(java, /assertFalse\(segunda\.isPresent\(\)/);
});

test('la marca de la guarda se afirma aparte de la del barrido', () => {
  // Son campos distintos. Colar el de la guarda en el reloj de la cola haría que el caso del
  // barrido afirmara un estampado que ese reclamo no hace, y saldría rojo sobre código correcto.
  const { java } = render('notification-mailer');
  assert.match(java, /assertNotNull\(jpa\.findById\(id\)\.orElseThrow\(\)\.getSendingSince\(\)/);
  // El reclamo de la cola de esta fixture no estampa nada, así que su caso no lo exige.
  const cola = java.slice(java.indexOf('void elReclamoDeLaColaSeLlevaLaFilaYEstampaElReloj'), java.indexOf('void elReclamoNoTocaFilasEnOtroEstado'));
  assert.ok(!cola.includes('getSendingSince'), 'el caso de la cola afirma un estampado que ese reclamo no hace');
});

test('la rama documental ejercita la MISMA guarda con su findAndModify', () => {
  const { manifest, layers } = (() => {
    const service = loadService(path.join(fixturesDir, 'notification-mailer-mongo'));
    assert.deepEqual(service.errors, []);
    return service;
  })();
  const model = buildModel({ manifest, layers, stack: { database: 'mongodb' } });
  const scenarios = claimScenarios(model);
  assert.ok(scenarios.guard, 'la mitad documental del par perdió la guarda');

  const java = claimTestClass(model, scenarios, {
    datasource: { uri: 'mongodb://x/y' },
    packages: { ...PACKAGES, entities: 'com.test.infrastructure.persistence.documents' },
    database: 'mongodb'
  });
  assert.match(java, /void laSegundaEjecucionDeLaMismaFilaNoSeLaLleva\(\)/);
  // Se relee por el template, no por un repositorio JPA que aquí no existe.
  assert.match(java, /mongo\.findById\(id, NotificationDocument\.class\)/);
  assert.ok(!java.includes('jpa.findById'), 'la rama documental cita el repositorio relacional');
});
