// La idempotencia de PETICIÓN (`use-cases.<op>.idempotency`): qué operaciones la deduplican con un
// REGISTRO de claves y cómo es ese registro. Es la misma tabla en los dos generadores —el servidor de
// keel-spring y el de keel-nest del mismo diseño comparten base y esquema—, así que su forma se
// decide aquí y no en cada emisor. La primera corrida de keel-nest (product-catalog, 2026-10-06)
// enseñó por qué: sin el mecanismo generado, el agente se escribió uno con otra tabla
// (`idempotency_keys`) y SQL de un solo motor; pasaba los escenarios y ya no era el mismo servidor.
//
// No confundir con la deduplicación de MENSAJES (`processed_event`), que es otro mecanismo.

/**
 * Operaciones con `idempotency` que usan el REGISTRO, opcionalmente filtradas por `keySource`.
 *
 * Deja fuera las que se guardan con la clave natural (`guard: 'natural-key'`): ahí la constraint del
 * agregado ya arbitra, permanente y para todas las puertas, y un registro aparte sería un segundo
 * almacén de lo mismo sin nadie que lo poblara.
 */
export function registryOperations(model, keySource = null) {
  return (model.services ?? []).flatMap((group) =>
    (group.operations ?? []).filter(
      (operation) =>
        operation.idempotency &&
        operation.idempotency.guard !== 'natural-key' &&
        (!keySource || operation.idempotency.keySource === keySource)
    )
  );
}

/**
 * ¿Hay registro de claves? Solo con persistencia: lo que distingue a este mecanismo es que la clave
 * se registra en la MISMA transacción que el efecto del comando.
 */
export function usesRequestIdempotency(model) {
  return Boolean(model.layersPresent?.persistence) && registryOperations(model).length > 0;
}

/** ¿La clave llega por la cabecera `Idempotency-Key`? Solo con `keySource: client-key`. */
export function usesIdempotencyHeader(model) {
  return usesRequestIdempotency(model) && registryOperations(model, 'client-key').length > 0;
}

/** La cabecera HTTP de la clave. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** La ventana de deduplicación cuando el diseño no la declara. */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86400;

/**
 * La tabla del registro (modelo relacional), como DATOS: columnas con su tipo del DSL, su cota y su
 * nulabilidad, la clave primaria compuesta y el índice de la purga. Es la que emite keel-spring
 * (`IdempotencyRecordJpa`) y la que tiene que emitir cualquier otro generador:
 *
 *   · clave primaria (operation_scope, idempotency_key): la misma cabecera en dos operaciones no
 *     colisiona, y es la BASE la que arbitra la carrera entre dos peticiones simultáneas — la que
 *     pierde el INSERT revierte entera. La columna no se llama `scope`: lo es en SQL estándar;
 *   · signature: la firma del contenido, para distinguir el reintento de la clave reutilizada;
 *   · resource_id: el id del recurso resultante, para reconstruir la respuesta (255, no 64: un id
 *     de dominio no siempre es un uuid);
 *   · expires_at calculada al escribir: las filas conservan la ventana con la que se registraron
 *     aunque el `ttlSeconds` del diseño cambie entre despliegues; su índice es el de la purga.
 */
export const IDEMPOTENCY_RECORD = Object.freeze({
  table: 'idempotency_record',
  columns: Object.freeze([
    { name: 'operation_scope', base: 'string', length: 128, nullable: false, primary: true },
    { name: 'idempotency_key', base: 'string', length: 255, nullable: false, primary: true },
    { name: 'signature', base: 'string', length: 128, nullable: false },
    { name: 'resource_id', base: 'string', length: 255, nullable: true },
    { name: 'created_at', base: 'timestamp', nullable: false },
    { name: 'expires_at', base: 'timestamp', nullable: false }
  ]),
  indexes: Object.freeze([{ name: 'ix_idempotency_record_expires_at', columns: ['expires_at'] }])
});

/**
 * La purga de las claves caducadas. La retención no se parametriza: cada fila lleva su propia
 * caducidad (`expires_at`), calculada con el `ttlSeconds` que el diseño declara para su operación; la
 * purga solo decide CUÁNDO se borra lo que ya no protege nada.
 */
export const IDEMPOTENCY_RECORD_PURGE = Object.freeze({
  cron: Object.freeze({ key: 'idempotency-record.purge.cron', env: 'IDEMPOTENCY_PURGE_CRON', default: '0 30 4 * * *', cron: true })
});
