// El finder por lote de la clave natural.
//
// El caso simétrico al del `embed`, y el que no estaba cubierto: un command cuya ENTRADA
// trae una lista acotada y cuyo handler tiene que consultar algo una vez por elemento. Los
// resolvers por lote salen de un `embed` en la SALIDA, así que aquí el puerto solo traía el
// finder de un elemento y el camino de menor resistencia era el bucle — hasta 20 consultas
// por petición comprobando la lista de supresión, una por destinatario. Añadir el método
// era territorio del agente de código, y el pase de calidad, que tiene prohibido cambiar
// firmas, solo pudo reportarlo cuando ya estaba escrito.
//
// El enlace que lo hace generable es el value type DECLARADO: el último componente de la
// clave natural y los elementos de la lista son el mismo `EmailAddress`. Dos `string` no se
// atarían, y por eso el primitivo no cuenta.

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
 * La fixture con la silueta del incidente: una raíz cuya clave natural termina en un value
 * type con nombre, y una operación que recibe una lista acotada de ESE mismo tipo.
 */
function withListedInput({ namedType = true, listedInput = true } = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);

  patched.domain.entities.Notification.fields.recipient = {
    type: namedType ? 'EmailAddress' : 'string',
    required: true,
    constraints: namedType ? undefined : { maxLength: 320 }
  };
  patched.persistence.entities.Notification.naturalKey = ['applicationKey', 'recipient'];

  if (listedInput) {
    patched['use-cases'].operations.acceptNotificationRequest.input.fields.copyRecipients = {
      type: namedType ? 'EmailAddress' : 'string',
      list: true,
      constraints: { maxItems: 10 },
      description: 'Direcciones en copia, comprobadas contra la lista de supresión.'
    };
  }

  const workspace = tmpDir('keel-batchfinder-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const read = (relative) => fs.readFileSync(path.join(workspace, result.outDir, relative), 'utf8');
  return { read };
}

test('el puerto gana la variante por lote de su clave natural', () => {
  const { read } = withListedInput();
  const port = read(`${JAVA}/domain/repository/NotificationRepository.java`);
  assert.ok(
    port.includes('Optional<Notification> findByApplicationKeyAndRecipient(String applicationKey, String recipient);'),
    'se perdió el finder unitario'
  );
  assert.ok(
    port.includes(
      'List<Notification> findAllByApplicationKeyAndRecipientIn(String applicationKey, Collection<String> recipients)'
    ),
    'el puerto no ofrece la variante por lote: el handler no tiene con qué evitar el bucle'
  );
});

test('el plural del parámetro es el del idioma, no name + s', () => {
  // `address` → `addresses`. Se lee en el handler, y un plural mal formado es la clase de
  // detalle que se copia de una operación a la siguiente.
  const { read } = withListedInput();
  const port = read(`${JAVA}/domain/repository/NotificationRepository.java`);
  assert.ok(!port.includes('recipients s'), 'plural mal formado');
  assert.match(port, /Collection<String> recipients\)/);
});

test('el adaptador lo resuelve en UNA consulta derivada', () => {
  const { read } = withListedInput();
  const jpa = read(`${JAVA}/infrastructure/persistence/repositories/NotificationJpaRepository.java`);
  assert.match(jpa, /List<NotificationJpa> findAllByApplicationKeyAndRecipientIn\(/);
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/NotificationRepositoryImpl.java`);
  assert.match(
    adapter,
    /findAllByApplicationKeyAndRecipientIn\(applicationKey, recipients\)\.stream\(\)\.map\(this::toDomain\)\.toList\(\)/
  );
});

test('sin lista en ninguna entrada, el puerto NO se ensancha', () => {
  // Un puerto no gana métodos que nadie llama: el criterio es el mismo que el de findAllById.
  const { read } = withListedInput({ listedInput: false });
  const port = read(`${JAVA}/domain/repository/NotificationRepository.java`);
  assert.ok(!port.includes('findAllByApplicationKeyAndRecipientIn'), 'se generó un método que nadie usa');
});

test('un primitivo no ata nada: dos `string` no hablan del mismo dato', () => {
  // Es lo que separa una derivación mecánica de una corazonada. El diseño le pone nombre al
  // tipo justamente para decir que estos dos sitios hablan de lo mismo.
  const { read } = withListedInput({ namedType: false });
  const port = read(`${JAVA}/domain/repository/NotificationRepository.java`);
  assert.ok(!port.includes('findAllByApplicationKeyAndRecipientIn'), 'se ató una lista de string con un string');
});
