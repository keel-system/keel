// La guarda de una operación que produce un efecto externo IRREVERSIBLE sobre una fila.
//
// El diseño la escribe como un estado intermedio: `A → B` y, en la misma operación, `B → C`.
// Ese `B` no es un estado en el que la fila se quede, es la marca de que ESTA ejecución se
// llevó el trabajo — «la transición de queued a sending es la guarda contra el doble envío»,
// dice el diseño de referencia.
//
// Y hacerla en memoria no la hace cumplir. El handler corre dentro de la transacción que abre
// el mediator, así que la marca no existe para nadie hasta el commit final, que llega DESPUÉS
// del envío: si el proceso cae entre el relay aceptando el correo y ese commit, la transacción
// revierte, la fila vuelve a estar disponible y el ciclo siguiente manda un SEGUNDO correo a
// una persona real. Ocurrió en una corrida real, y no lo detecta ningún escenario FL-*: ningún
// arnés de caja negra puede matar la aplicación en esa ventana.
//
// Por eso el reclamo lo genera build, con transacción propia, y por eso el gate lo exige: sin
// el método delante, el camino de menor resistencia es la transición en memoria.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * El PAR de fixtures que trae la silueta de la guarda en disco: `sendAcceptedNotification`
 * atraviesa `accepted → sending → sent|failed` y es la única en `mail.sentBy`.
 *
 * Son dos y no una por lo mismo que `job-dispatch` / `job-dispatch-mongo`: con el modelo
 * documental la guarda cambia de forma entera —`findAndModify` con su `Criteria` en vez del
 * UPDATE condicional con su JPQL— y eso es otra rama del scaffolding. Mientras el modelo se
 * parcheaba en memoria, esa rama no pasaba por `java-syntax` ni por `compile-check` —los dos
 * iteran el DIRECTORIO de fixtures—, así que se generaba a ciegas. Lo que se sigue parcheando
 * aquí es solo lo que un diseño no puede declarar a la vez que el resto.
 */
const FIXTURES = {
  relational: { dir: 'notification-mailer', java: 'src/main/java/com/platform/notificationmailer' },
  document: { dir: 'notification-mailer-mongo', java: 'src/main/java/com/platform/notificationmailermongo' }
};

const JAVA = FIXTURES.relational.java;

function withGuardedSend({ stamp = true, model = 'relational' } = {}) {
  const fixture = FIXTURES[model];
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture.dir));
  assert.deepEqual(errors, []);
  assert.equal(
    layers.persistence?.default?.model ?? 'relational',
    model,
    `la fixture ${fixture.dir} dejó de declarar el modelo ${model}`
  );

  const patched = structuredClone(layers);
  // El caso «sin reloj» se construye QUITANDO el campo, no dejando de ponerlo: el diseño en
  // disco ya lo declara, porque un reclamo sin instante es una fila que el rescate no
  // encuentra nunca y esa es la forma correcta. Aquí se retira a propósito para comprobar que
  // build degrada —cambia el estado y no estampa— en vez de inventarse un campo.
  if (!stamp) {
    delete patched.domain.entities.Notification.fields.sendingSince;
  }

  const workspace = tmpDir('keel-guardclaim-');
  const stack = model === 'document' ? { database: 'mongodb' } : undefined;
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true, stack });
  const read = (relative) => fs.readFileSync(path.join(workspace, result.outDir, relative), 'utf8');
  return { read, java: fixture.java, warnings: result?.warnings ?? [] };
}

test('el reclamo de la guarda sale en el puerto, y devuelve el agregado o vacío', () => {
  const { read } = withGuardedSend();
  const port = read(`${JAVA}/domain/repository/NotificationRepository.java`);
  assert.ok(
    port.includes('Optional<Notification> claimForSendAcceptedNotification(UUID id);'),
    'el puerto no ofrece el reclamo: sin método, la guarda se hace en memoria'
  );
  // El vacío es la carrera perdida. Devolver el agregado sin más obligaría a comprobar el
  // estado después, que es exactamente la lectura que el reclamo evita.
  assert.match(port, /vac[ií]o si otra ejecución llegó antes/);
});

test('la escritura es condicional y dice cuántas filas se llevó', () => {
  const { read } = withGuardedSend();
  const jpa = read(`${JAVA}/infrastructure/persistence/repositories/NotificationJpaRepository.java`);
  assert.match(jpa, /@Modifying\(clearAutomatically = true, flushAutomatically = true\)/);
  assert.match(
    jpa,
    /update NotificationJpa e set e\.status = :to, e\.sendingSince = :now where e\.id = :id and e\.status in :states/,
    'el UPDATE no es condicional sobre el estado de partida: eso no excluye a nadie'
  );
  assert.match(jpa, /int claimForSendAcceptedNotification\(/, 'no devuelve filas afectadas');
});

test('y confirma en su PROPIA transacción, que es lo que la hace una guarda', () => {
  const { read } = withGuardedSend();
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  const method = adapter.slice(adapter.indexOf('public Optional<Notification> claimForSendAcceptedNotification'));
  assert.ok(
    adapter.includes('@Transactional(propagation = Propagation.REQUIRES_NEW)'),
    'sin REQUIRES_NEW la marca espera al commit del llamante, que llega después del envío'
  );
  assert.match(method, /if \(claimed == 0\) \{\s*return Optional\.empty\(\);/);
});

test('la marca de tiempo del estado en vuelo entra en el mismo UPDATE', () => {
  // El rescate mide sobre ella («lleva más de N minutos en sending»): una fila marcada sin
  // instante es una fila que el rescate no encuentra nunca.
  const { read } = withGuardedSend();
  assert.match(
    read(`${JAVA}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`),
    /NotificationStatus\.SENDING, Instant\.now\(\)\)/,
    'el reclamo no estampa la marca de tiempo del estado en vuelo'
  );
});

test('sin marca de tiempo declarada, el reclamo solo cambia el estado', () => {
  // No se inventa una columna que la entidad no tiene.
  const { read } = withGuardedSend({ stamp: false });
  const jpa = read(`${JAVA}/infrastructure/persistence/repositories/NotificationJpaRepository.java`);
  assert.match(jpa, /update NotificationJpa e set e\.status = :to where e\.id = :id and e\.status in :states/);
  assert.ok(!jpa.includes(':now'), 'se estampa un campo que la entidad no declara');
});

test('la nota del handler manda confirmar ANTES del envío, no «decidir» antes', () => {
  const { read } = withGuardedSend();
  const handler = read(`${JAVA}/application/usecases/SendAcceptedNotificationCommandHandler.java`);
  assert.ok(handler.includes('claimForSendAcceptedNotification'), 'la nota no nombra el reclamo generado');
  assert.match(handler, /CONFIRMADA antes del envío/);
  assert.match(handler, /SEGUNDO correo/);
});

test('y el gate lo exige, porque ningún escenario FL-* puede verlo fallar', () => {
  const { read } = withGuardedSend();
  const gate = read('infra/check-idempotency.sh');
  assert.match(
    gate,
    /unit 'mailDelivery' 'sendAcceptedNotification · guarda confirmada antes del envío'/,
    'el gate no comprueba la guarda: solo que el correo salga'
  );
  assert.ok(
    gate.includes(String.raw`\.?claimForSendAcceptedNotification\s*\(`),
    'el patrón del gate llegó al bash con los escapes comidos'
  );
});

// ─── La misma guarda en el modelo documental ─────────────────────────────────
//
// No es una variante del mismo código: es otra forma entera. Donde el relacional necesita
// un UPDATE condicional y una transacción propia para que la marca sea visible, Mongo lo
// resuelve con findAndModify —filtro y escritura en la MISMA operación atómica sobre el
// documento—, y por eso ahí no hace falta abrir ninguna transacción.
//
// Esta rama existía sin que ningún test la mirara: ninguna fixture combina modelo
// documental con capa `mail`, así que se generaba a ciegas.

test('documental: la guarda es un findAndModify, atómico y sin transacción propia', () => {
  const { read, java } = withGuardedSend({ model: 'document' });
  const adapter = read(`${java}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  const method = adapter.slice(adapter.indexOf('public Optional<Notification> claimForSendAcceptedNotification'));

  assert.match(method, /mongoTemplate\.findAndModify\(/, 'no se reclama con findAndModify');
  // El filtro es la exclusión: la fila se toma SOLO si sigue en su estado de partida.
  assert.match(method, /Criteria\.where\("_id"\)\.is\(id\)/);
  // El estado de partida es `queued`, no `accepted`: entre los dos hay ahora el reclamo de
  // LOTE del barrido, que es otro mecanismo. La guarda empieza donde termina aquel.
  assert.match(method, /\.and\("status"\)\.in\(List\.of\(NotificationStatus\.QUEUED\)\)/);
  assert.match(method, /returnNew\(true\)/, 'sin returnNew se devuelve el documento de ANTES del reclamo');
  // REQUIRES_NEW es la respuesta relacional a un problema que aquí no existe: pedirla
  // obligaría a un replica set solo para esto.
  assert.ok(
    !method.includes('REQUIRES_NEW'),
    'el reclamo documental no necesita transacción: findAndModify ya es atómico'
  );
});

test('documental: el estado en vuelo se estampa en la misma operación', () => {
  const { read, java } = withGuardedSend({ model: 'document' });
  const adapter = read(`${java}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  assert.match(
    adapter,
    /new Update\(\)\.set\("status", NotificationStatus\.SENDING\)\.set\("sendingSince", Instant\.now\(\)\)/,
    'la marca de tiempo no entra en el findAndModify: el rescate no encontraría a sus candidatos'
  );
  // Los nombres son los de la PROPIEDAD, no los del campo BSON: el QueryMapper los resuelve
  // por @Field. Escribirlos ya en snake_case funcionaría por accidente —una ruta que no
  // resuelve se pasa tal cual— y dejaría de funcionar en cuanto cambiara el mapeo.
  assert.ok(!adapter.includes('"sending_since"'), 'se nombró el campo BSON en vez de la propiedad');
});

test('documental: sin marca declarada, el reclamo solo cambia el estado', () => {
  const { read, java } = withGuardedSend({ model: 'document', stamp: false });
  const adapter = read(`${java}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  assert.match(adapter, /new Update\(\)\.set\("status", NotificationStatus\.SENDING\);/);
  assert.ok(!adapter.includes('sendingSince'), 'se estampa un campo que el documento no declara');
});

test('documental: no se cuela nada de la rama relacional', () => {
  // El puerto es el MISMO en las dos ramas, así que un método declarado allí y no
  // implementado aquí no compila. Y al revés: un @Modifying en un proyecto Mongo sería
  // código muerto que nadie ejecuta.
  const { read, java } = withGuardedSend({ model: 'document' });
  const adapter = read(`${java}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  assert.ok(!adapter.includes('@Modifying'), 'se generó la escritura relacional en el adaptador documental');
  assert.ok(
    read(`${java}/domain/repository/NotificationRepository.java`).includes(
      'Optional<Notification> claimForSendAcceptedNotification(UUID id);'
    ),
    'el puerto compartido perdió el reclamo en el modelo documental'
  );
});

test('documental: el gate sigue exigiendo la guarda', () => {
  // El reparto build/agente no cambia con el motor: build genera el reclamo, el uso lo
  // escribe el agente, y sin gate ese tramo no lo verifica nadie.
  const { read, java } = withGuardedSend({ model: 'document' });
  assert.match(
    read('infra/check-idempotency.sh'),
    /unit 'mailDelivery' 'sendAcceptedNotification · guarda confirmada antes del envío'/
  );
});

test('el puerto de despacho entre casos de uso trae las DOS variantes', () => {
  // Se genera porque el diseño tiene una operación interna sin disparador propio: alguien
  // tiene que invocarla, y un handler no puede llamar a otro handler. Cuando no existía, el
  // agente lo escribía con solo la variante transaccional —la que necesitaba para compilar—
  // y con eso el envío se quedaba dentro de la transacción del llamante.
  const { read } = withGuardedSend();
  const port = read(`${JAVA}/application/port/out/CommandDispatcher.java`);
  assert.match(port, /void dispatch\(Command command\);/);
  assert.match(port, /<R> R dispatch\(ReturningCommand<R> command\);/);
  assert.match(port, /void dispatchWithoutTransaction\(Command command\);/);
  assert.match(port, /<R> R dispatchWithoutTransaction\(ReturningCommand<R> command\);/);
  assert.match(port, /sendAcceptedNotification/, 'el javadoc no dice por qué existe el puerto');

  const adapter = read(`${JAVA}/infrastructure/configurations/usecase/CommandDispatcherAdapter.java`);
  assert.match(adapter, /implements CommandDispatcher/);
  assert.match(adapter, /mediator\.dispatchWithoutTransaction\(command\);/);
});

test('las DOS fixtures del par producen la guarda en disco, cada una en su modelo', () => {
  // El hueco que este archivo tenía y que no se veía desde dentro: la silueta se construía en
  // memoria, así que ninguna fixture del directorio la producía. `java-syntax.test.js` y
  // `compile-check` iteran ESE directorio — de los seis mecanismos de repetición y
  // compensación, la guarda era el único cuyo Java no pasaba nunca por el linter estructural
  // ni por javac. Y es además el único que ningún escenario `FL-*` puede ver, porque nadie
  // mata la aplicación entre el envío y el commit.
  //
  // Son DOS porque el modelo de persistencia es otra rama entera del scaffolding, igual que en
  // el par `job-dispatch` / `job-dispatch-mongo` del reclamo del barrido. Si alguien le quita a
  // una el estado en vuelo, o le cambia el modelo, esto cae aquí y no en la corrida — y sin
  // esto los dos comprobadores seguirían en verde compilando un proyecto que ya no la lleva.
  for (const [model, fixture] of Object.entries(FIXTURES)) {
    const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture.dir));
    assert.deepEqual(errors, [], `${fixture.dir} no carga`);
    assert.equal(layers.persistence?.default?.model ?? 'relational', model, `${fixture.dir} cambió de modelo`);

    const database = model === 'document' ? 'mongodb' : 'postgresql';
    const built = buildModel({ manifest, layers, stack: { group: 'com.test', database, broker: 'kafka' } });
    const guarded = (built.services ?? [])
      .flatMap((service) => service.operations ?? [])
      .filter((operation) => operation.guardClaim);

    assert.equal(guarded.length, 1, `${fixture.dir} dejó de producir la guarda`);
    assert.equal(guarded[0].name, 'sendAcceptedNotification');
    assert.equal(guarded[0].guardClaim.method, 'claimForSendAcceptedNotification');
    // Con su reloj: sin él el reclamo no estampa y el rescate no tiene sobre qué medir.
    assert.equal(guarded[0].guardClaim.stampField, 'sendingSince');
    // Y es la ÚNICA que manda correo: registrar por HTTP o por evento ya no envía nada, que es
    // lo que permite que el envío tenga un estado intermedio propio.
    assert.deepEqual(layers.mail.sentBy, ['sendAcceptedNotification']);
  }
});

test('el par no se convierte en dos diseños distintos: solo cambia el modelo', () => {
  // La otra mitad de la vigilancia, y la que se pierde sola: si alguien arregla o amplía el
  // diseño en una sola de las dos, dejan de medir lo mismo y la comparación entre ramas ya no
  // dice nada. Lo único que puede diferir es el manifiesto (el nombre) y la persistencia.
  const capas = ['domain.keel.yaml', 'use-cases.keel.yaml', 'api.keel.yaml', 'security.keel.yaml', 'messaging.keel.yaml', 'mail.keel.yaml'];
  for (const capa of capas) {
    const relacional = fs.readFileSync(path.join(fixturesDir, FIXTURES.relational.dir, capa), 'utf8');
    const documental = fs.readFileSync(path.join(fixturesDir, FIXTURES.document.dir, capa), 'utf8');
    assert.equal(documental, relacional, `${capa} difiere entre las dos mitades del par`);
  }
});
