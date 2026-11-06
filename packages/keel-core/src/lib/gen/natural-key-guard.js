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
