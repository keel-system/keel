// Cómo selecciona candidatos un barrido, motor a motor.
//
// El reclamo tiene DOS capas y solo una depende del dialecto, que es justo lo que se
// confunde con facilidad:
//
//  1. Llevarse la fila es una escritura condicional: `UPDATE … SET estado = :to WHERE
//     id = :id AND estado = :from` en el barrido de una cola, `UPDATE … SET claimed_at`
//     sobre la marca en la reconciliación, `findAndModify` en Mongo. Una fila afectada =
//     es mía; cero = se la llevó otra réplica. Eso es atómico en los seis motores sin
//     ayuda de nadie, y la marca —el propio estado de destino que el diseño declara, o
//     el `claimed_at` de la tabla de reclamos— sobrevive al commit, que es lo que hace
//     falta cuando entre reclamar y actuar hay una llamada externa
//     (conventions/dependencies.md § La regla: reclamar, no leer). Esa capa NO se toca
//     aquí.
//
//  2. ELEGIR a qué filas tirarle es lo que sí cambia: sin ayuda del motor, las N réplicas
//     leen la misma página de candidatos y N-1 pierden todos los UPDATE. Sigue siendo
//     correcto —nadie procesa dos veces— pero es trabajo tirado, y con muchas réplicas
//     el barrido deja de avanzar. `SKIP LOCKED` (y su primo `READPAST`) hacen que cada
//     réplica vea un conjunto distinto.
//
// Por eso lo de aquí es una OPTIMIZACIÓN, no la garantía: un motor que no esté en la
// tabla genera un barrido correcto y contencioso, y `build` lo dice en voz alta en vez
// de callarlo. Mismo trato que los índices parciales de migrations.js.
//
// Y es la fuente ÚNICA de esa decisión: la consumen los tres mecanismos que leen
// candidatos desde varias réplicas a la vez (el barrido de una cola, el relay del outbox
// y el barrido de reconciliación). Un `@Lock` escrito a mano en cualquiera de ellos
// vuelve a partir la decisión en dos, que es de donde venía el bug del relay.

/**
 * Sufijo que se añade al SELECT de candidatos para que dos réplicas no se lleven la
 * misma página. Recibe ya resuelto lo que el motor necesita saber.
 *
 * Las versiones importan y por eso están escritas: MySQL lo tiene desde 8.0, MariaDB
 * desde 10.6 y Oracle desde 12c. Por debajo de eso el motor da error de sintaxis en vez
 * de degradar, que al menos falla en voz alta.
 */
export const CLAIM_DIALECTS = {
  postgresql: { hint: 'FOR UPDATE SKIP LOCKED', since: null },
  mysql: { hint: 'FOR UPDATE SKIP LOCKED', since: '8.0' },
  mariadb: { hint: 'FOR UPDATE SKIP LOCKED', since: '10.6' },
  oracle: { hint: 'FOR UPDATE SKIP LOCKED', since: '12c' },
  // SQL Server no tiene SKIP LOCKED: lo suyo son hints de tabla, y van pegados al FROM,
  // no al final de la consulta. De ahí que el sitio donde se inserta sea distinto.
  sqlserver: { tableHint: 'WITH (UPDLOCK, READPAST, ROWLOCK)', since: null }
  // h2 no aparece a propósito: acepta la sintaxis y la IGNORA, que es el peor modo de
  // fallar. Es el motor del perfil `test`, donde no hay réplicas, así que la ausencia
  // no cuesta nada — pero validar la concurrencia contra H2 no demuestra nada, y eso
  // hay que decirlo donde se lea.
};

/** ¿Sabe este motor repartir los candidatos entre réplicas? */
export function supportsSkipLocked(database) {
  return Object.prototype.hasOwnProperty.call(CLAIM_DIALECTS, database);
}

/** Los imports que arrastra el lock pesimista, y solo cuando se emite. */
const LOCK_IMPORTS = [
  'jakarta.persistence.LockModeType',
  'jakarta.persistence.QueryHint',
  'org.springframework.data.jpa.repository.Lock',
  'org.springframework.data.jpa.repository.QueryHints'
];

/**
 * Las anotaciones que preceden al SELECT de candidatos de un reclamo, con su comentario.
 * Devuelve también los imports que hacen falta, que son condicionales: pedirlos siempre
 * dejaría imports sin usar en el motor que no reparte.
 *
 * `indent` existe porque el mismo bloque se emite dentro de una interfaz (cuatro
 * espacios) y el comentario tiene que quedar alineado con la consulta que anota.
 */
export function claimSelectionSnippet({ database, subject, indent = '    ' }) {
  if (supportsSkipLocked(database)) {
    return {
      annotations: [
        `${indent}// SKIP LOCKED, dicho como JPA lo dice: el hint -2 es el código de Hibernate para`,
        `${indent}// «no esperes por las filas que otro tiene tomadas, sáltalas». Es lo que hace que cada`,
        `${indent}// réplica reciba candidatos DISTINTOS en vez de pelearse por la misma página. El lock`,
        `${indent}// dura lo que la transacción del reclamo, que termina en cuanto reclama: ninguna`,
        `${indent}// llamada externa ocurre dentro.`,
        `${indent}@Lock(LockModeType.PESSIMISTIC_WRITE)`,
        `${indent}@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))`
      ].join('\n'),
      imports: LOCK_IMPORTS
    };
  }
  return {
    annotations: [
      `${indent}// ${database} no tiene SKIP LOCKED, así que todas las réplicas ven la misma página de`,
      `${indent}// candidatos. ${subject} sigue siendo correcto —lo garantiza la escritura condicional`,
      `${indent}// del reclamo, no esta consulta—, pero N-1 réplicas pierden su intento.`
    ].join('\n'),
    imports: []
  };
}

/**
 * El aviso de `build` cuando el motor elegido no reparte. No es un error: lo que se
 * genera sigue sin procesar nada dos veces. Lo que se pierde es rendimiento, y lo que
 * no se tolera es no saberlo.
 *
 * `mechanisms` son los sitios afectados del diseño concreto —barridos, relay del outbox,
 * reconciliaciones—, y se enumeran juntos porque el aviso es uno solo por build: repetir
 * el mismo párrafo tres veces lo convierte en ruido que se salta.
 */
export function unsupportedClaimWarning(database, mechanisms) {
  return (
    `persistence: ${database} no tiene SKIP LOCKED (ni un equivalente), así que el SELECT de candidatos de ` +
    `${mechanisms.join(', ')} devuelve la MISMA página en todas las réplicas. El reclamo sigue siendo correcto —lo ` +
    `garantiza la escritura condicional, y nadie procesa una fila dos veces—, pero N-1 réplicas tiran su ciclo ` +
    `perdiendo todos los intentos. Con muchas réplicas o lotes grandes, el barrido deja de avanzar a su ritmo. ` +
    `PostgreSQL, MySQL 8.0+, MariaDB 10.6+, Oracle 12c+ y SQL Server sí lo reparten.`
  );
}
