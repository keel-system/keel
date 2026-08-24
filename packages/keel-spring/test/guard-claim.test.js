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
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notification-mailer');
const JAVA = 'src/main/java/com/platform/notificationmailer';

/**
 * La fixture de correo con la silueta que la suya no tiene: un estado EN VUELO entre la
 * aceptación y el desenlace, y una operación interna que lo atraviesa mandando el correo.
 */
function withGuardedSend({ stamp = true } = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);

  patched.domain.types.NotificationStatus.values = ['accepted', 'sending', 'sent', 'failed'];
  patched.domain.entities.Notification.lifecycle.transitions = {
    accepted: ['sending'],
    sending: ['sent', 'failed'],
    sent: [],
    failed: []
  };
  if (stamp) {
    patched.domain.entities.Notification.fields.sendingSince = {
      type: 'timestamp',
      description: 'Instante en que esta ejecución se llevó el envío.'
    };
  }

  patched['use-cases'].operations.sendAcceptedNotification = {
    description: 'Compone y entrega al relay una notificación aceptada.',
    kind: 'command',
    internal: true,
    input: { fields: { notificationId: { type: 'uuid', required: true } } },
    output: { entity: 'Notification' },
    transitions: [
      { entity: 'Notification', from: ['accepted'], to: 'sending' },
      { entity: 'Notification', from: ['sending'], to: 'sent' },
      { entity: 'Notification', from: ['sending'], to: 'failed' }
    ],
    rules: ['La transición de accepted a sending es la guarda contra el doble envío.'],
    errors: [{ code: 'NOTIFICATION_NOT_FOUND', when: 'No existe un envío con ese identificador.', http: 404 }]
  };
  patched.mail.sentBy = ['sendAcceptedNotification'];

  const workspace = tmpDir('keel-guardclaim-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const read = (relative) => fs.readFileSync(path.join(workspace, result.outDir, relative), 'utf8');
  return { read, warnings: result?.warnings ?? [] };
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
