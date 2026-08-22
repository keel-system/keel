// `keySource: payload-field` (DSL 2.12): la clave de idempotencia es un campo del contrato.
//
// De dónde sale la clave no es un detalle de transporte: decide qué mecanismo tiene sentido. Con
// `client-key` la clave llega por la cabecera `Idempotency-Key`, así que solo entra por HTTP; con
// `payload-field` es parte del cuerpo y llega igual desde el broker — que es lo único que cubre una
// operación con dos disparadores.
//
// Y trae una segunda consecuencia, que es la que más código ahorra: si ese campo participa en la
// `naturalKey` del agregado que la operación escribe, la constraint de la base YA es la guarda
// —permanente y común a todas las puertas—, así que un almacén aparte sería un segundo registro de
// lo mismo. En la corrida que destapó esto, `IdempotencyStore`, `IdempotencyContext` y
// `CommandSignature` se generaron enteros y quedaron muertos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OP = 'createReservation';
const KEY = 'requestKey';

/** La fixture con la clave en el cuerpo, guardada por la clave natural (o no). */
function generate({ inNaturalKey }) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  const op = patched['use-cases'].operations[OP];
  op.input.fields[KEY] = { type: 'string', required: true };
  op.idempotency = { keySource: 'payload-field', keyField: KEY };
  patched.domain.entities.Reservation.fields[KEY] = { type: 'string', required: true };
  if (inNaturalKey) patched.persistence.entities.Reservation.naturalKey = ['orderId', KEY];

  const workspace = tmpDir('keel-payloadfield-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, 'services', 'stock-reservation-spring');
  const exists = (relative) => fs.existsSync(path.join(root, relative));
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  return { root, exists, read };
}

const JAVA = 'src/main/java/com/fulfillment/stockreservation';
const HANDLER = `${JAVA}/application/usecases/CreateReservationCommandHandler.java`;

test('con la clave natural como guarda no se genera NINGÚN mecanismo de idempotencia', () => {
  const { exists } = generate({ inNaturalKey: true });

  assert.ok(!exists(`${JAVA}/domain/idempotency/IdempotencyStore.java`), 'el puerto sobra');
  assert.ok(!exists(`${JAVA}/application/support/IdempotencyContext.java`), 'no hay cabecera que transportar');
  assert.ok(!exists(`${JAVA}/infrastructure/web/IdempotencyKeyFilter.java`), 'ni filtro que la lea');
  assert.ok(
    !exists(`${JAVA}/infrastructure/persistence/idempotency/IdempotencyRecordJpa.java`),
    'ni la tabla de claves, que es lo que quedaba muerto'
  );
  // `CommandSignature` NO se comprueba aquí: esta fixture tiene idempotencia SALIENTE
  // (`http-clients.calls.<x>.idempotency`), que es otro de los cinco ejes y la usa por su cuenta.
  // Exigir su ausencia ataría este test a un detalle que no es suyo.
});

test('y el handler recibe el algoritmo que sí corresponde', () => {
  // Sin la nota, el camino de menor resistencia es insertar y dejar que el choque suba como error
  // — y eso rompe el contrato: una repetición devuelve la respuesta original, no un 409.
  const { read } = generate({ inNaturalKey: true });
  const handler = read(HANDLER);

  assert.match(handler, /CLAVE NATURAL/);
  assert.match(handler, /orderId, requestKey/);
  assert.match(handler, /devuelve ese mismo recurso sin re-ejecutar nada/);
  // La nota SÍ nombra el puerto, para prohibirlo; lo que no puede es inyectarlo — sería una clase
  // que build no generó y el handler no compilaría.
  assert.ok(!/private final IdempotencyStore/.test(handler), 'inyecta un puerto que no existe');
  assert.ok(!/import .*IdempotencyStore/.test(handler), 'importa un puerto que no existe');
});

test('sin clave natural sí se genera el almacén, pero nunca el camino de la cabecera', () => {
  // La otra mitad: `payload-field` no significa «sin mecanismo», significa «la clave no viaja por
  // cabecera». Si nada más la guarda, hace falta el registro — tecleado por el campo del command.
  const { exists } = generate({ inNaturalKey: false });

  assert.ok(exists(`${JAVA}/domain/idempotency/IdempotencyStore.java`), 'falta el registro');
  assert.ok(!exists(`${JAVA}/application/support/IdempotencyContext.java`), 'no hay cabecera que transportar');
  assert.ok(!exists(`${JAVA}/infrastructure/web/IdempotencyKeyFilter.java`), 'ni filtro que la lea');
});

test('el gate exige la búsqueda por clave natural, y NO el almacén', () => {
  // Un check que pide una clase que build no generó tiene como camino de menor resistencia
  // escribir un registro paralelo — justo lo que la clave natural hace innecesario.
  const { read } = generate({ inNaturalKey: true });
  const gate = read('infra/check-idempotency.sh');

  assert.match(gate, /findByOrderIdAndRequestKey/, 'no exige la búsqueda por la clave natural');
  assert.match(gate, /commandIdempotency/);
  // El `forbid` sí lo nombra (para prohibirlo); lo que no puede es exigirlo.
  assert.ok(!/require=.*IdempotencyStore/.test(gate), 'exige un puerto que no existe');
});
