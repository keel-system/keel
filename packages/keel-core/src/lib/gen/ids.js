// Los ids `long` que genera la APLICACIÓN (`type: long, id: true, generated: true`): neutral, la misma forma en los tres
// generadores.
//
// Un id uuid lo crea el dominio al nacer la raíz (`Uuids.v7()`, `Guid.CreateVersion7()`); un id `long` no lo creaba
// nadie. Salió con el diseño recuperado de shop-api (2026-10-23), cuyos pedidos y líneas son de secuencia en el legacy:
// la raíz nacía con 0 o null, el INSERT moría y el agente escribió su propio generador. Lo decidió el humano: lo genera
// la aplicación y no la base, para que el agregado siga naciendo CON su id (lo necesitan sus eventos, el Location y la
// idempotencia, igual que con un uuid).
//
// La forma: 41 bits de milisegundos desde EPOCH y 12 aleatorios. Son 53 bits: el id cabe en un `number` de JavaScript,
// así que ningún cliente del JSON lo trunca, y 41 bits de milisegundos dan para 69 años. Ordenado por tiempo, como el
// UUID versión 7: cada alta va al final del índice de la PK. Sin coordinación entre réplicas, dos altas del mismo
// milisegundo chocan con probabilidad 1/4096: es raro, pero no imposible, y la clave primaria lo convierte en un
// conflicto de unicidad en vez de en una fila pisada.

/** El origen de los milisegundos: 2020-01-01T00:00:00Z. */
export const LONG_ID_EPOCH_MS = Date.UTC(2020, 0, 1);
export const LONG_ID_RANDOM_BITS = 12;
export const LONG_ID_TIME_BITS = 41;

/** ¿Es un id `long` que genera la aplicación? Se mira el campo del diseño (`id`, `generated`) y su base resuelta. */
export function isGeneratedLongId(field, base) {
  return Boolean(field?.id && field?.generated && base === 'long');
}

/** ¿Lo genera alguna entidad del modelo? Es lo que decide que build emita la clase del generador. */
export function usesGeneratedLongIds(model) {
  return (model.entities ?? []).some((entity) => entity.idField?.generated && entity.idField?.base === 'long');
}

/** Un id con la forma de arriba: la referencia contra la que se comprueban los tres generadores. */
export function longIdReference(nowMs, random) {
  return (BigInt(nowMs - LONG_ID_EPOCH_MS) << BigInt(LONG_ID_RANDOM_BITS)) | BigInt(random & ((1 << LONG_ID_RANDOM_BITS) - 1));
}
