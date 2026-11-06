// ¿Es la clave natural la guarda de idempotencia de una operación?
//
// Lo preguntan dos sitios que tienen que contestar lo mismo: el modelo (`resolveIdempotency`, que
// decide `guard: 'natural-key'` y con él el orden del listener, el registro de claves y los códigos
// de la carrera y la reutilización) y la validación (`crossrefs.js`, que no abre las obligaciones de
// esos códigos cuando el generador no los va a emitir). Escrito dos veces, el día que uno aprendiera
// `storedIn` y el otro no, `keel validate` pediría declarar unos códigos que nada emite.
//
// La guarda existe con `keySource: payload-field` cuando el campo que GUARDA la clave participa en
// la `naturalKey` de la entidad que la operación escribe. Ese campo es `storedIn` si el diseño lo
// declara (DSL 2.24: la clave del input acaba en un campo que se llama de otra forma, derivada por
// una rule) y `keyField` si no, que es la comparación por nombre del DSL 2.12.

/** El campo de la entidad escrita que guarda la clave: `storedIn`, o el propio `keyField`. */
export function idempotencyStoredField(idempotency) {
  if (idempotency?.keySource !== 'payload-field') return null;
  return idempotency.storedIn ?? idempotency.keyField ?? null;
}

/** ¿La guarda es la clave natural? `naturalKey` es la de la entidad que la operación escribe. */
export function guardedByNaturalKey(idempotency, naturalKey) {
  const field = idempotencyStoredField(idempotency);
  return Boolean(field) && (naturalKey ?? []).includes(field);
}

/**
 * La frase que nombra el campo guardado cuando no es el de la clave (`storedIn` ≠ `keyField`), o '' si
 * son el mismo. La escriben los cuatro generadores, en el `<Evento>Message` del listener y en la nota
 * del handler, con el mismo texto (lo compara `keel-go/test/stored-in-notes.test.js`).
 *
 * Sin ella, las dos notas decían «busca por la clave natural» y nombraban solo el `keyField`: el agente
 * buscaba por un campo que la entidad no tiene (`eventId`), o por el correcto con el valor sin derivar,
 * y en los dos casos la búsqueda no encuentra nada y la repetición inserta. Cómo se deriva no lo dice
 * el DSL a propósito: lo dice la rule de la operación, y el agente la escribe desde ahí.
 */
export function storedInNote(idempotency) {
  const { keyField, storedIn, naturalKey } = idempotency ?? {};
  if (!storedIn || storedIn === keyField) return '';
  return (
    `La clave ${keyField} se guarda en ${storedIn} (storedIn), que es el campo que participa en la clave natural ` +
    `(${(naturalKey ?? []).join(', ')}): busca con el valor de ${storedIn} que la rule de la operación deriva de ${keyField}, ` +
    `no con ${keyField} tal cual, o la búsqueda no encuentra nada y la repetición inserta.`
  );
}
