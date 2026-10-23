// La base del legacy (y la del regenerado, en la paridad) detrás de una sola interfaz, un adaptador
// por motor. Lo que verify, introspect, probe, characterize y parity le preguntan a la base es lo
// mismo para todos los motores; cómo se pregunta es de cada uno (el shell de Mongo, psql…). Un motor
// sin adaptador es un rechazo con motivo, igual que en `sandbox.schema.json`: hasta medirlo contra un
// legacy real no se sabe si su snapshot devuelve el estado entero ni si su rastro de escritura llega
// a tiempo (en PostgreSQL 9.4 el contador de escrituras llega segundos tarde: docs/recover-bench).
//
// La interfaz de un adaptador (todas las funciones reciben el runtime y el contenedor de la base):
//   fingerprint(rt, c, name)            → { ok, value }   huella que cambia con cualquier escritura
//   takeSnapshot(rt, c, name)           → { ok, where, hash }
//   hasSnapshot(rt, c)                  → boolean          el snapshot sigue en el contenedor
//   noSnapshot(c, sandboxRel)           → string           qué hacer si no está
//   restoreSnapshot(rt, c, name)        → { ok }           la base vuelve al snapshot, entera
//   exportDb(rt, c, name)               → { ok, value }    el contenido como JSON plano
//   diff(before, after)                 → { <colección|tabla>: { added, removed, changed } }
//   introspect(rt, c, name)             → { ok, value }    la sección `data` de surface.yaml, sin tech ni nombre
//   empty(rt, c, name, { auth })        → { ok, remaining } vacía la base del regenerado (paridad)
//   snapshotFile                        string             dónde vive el snapshot dentro del contenedor
//   rowNoun                             string             cómo se llaman sus filas en los mensajes

import * as mongodb from './mongodb.js';

const ADAPTERS = {
  mongodb: {
    tech: 'mongodb',
    snapshotFile: mongodb.SNAPSHOT_ARCHIVE,
    rowNoun: 'documentos',
    fingerprint: mongodb.dbHash,
    takeSnapshot: mongodb.takeSnapshot,
    hasSnapshot: mongodb.hasSnapshot,
    noSnapshot: mongodb.NO_SNAPSHOT,
    restoreSnapshot: mongodb.restoreSnapshot,
    exportDb: mongodb.exportDb,
    diff: mongodb.dbDiff,
    introspect: (rt, c, name) => {
      const r = mongodb.introspectDb(rt, c, name);
      return r.ok ? { ok: true, value: { collections: r.value } } : r;
    },
    empty: mongodb.emptyDatabase,
  },
};

/** Los motores con adaptador, en el orden en que se nombran en los mensajes. */
export const DATABASE_TECHS = Object.keys(ADAPTERS);

/** Las piezas que todo adaptador tiene que traer (lo comprueba test/db.test.js). */
export const ADAPTER_FUNCTIONS = ['fingerprint', 'takeSnapshot', 'hasSnapshot', 'noSnapshot', 'restoreSnapshot', 'exportDb', 'diff', 'introspect', 'empty'];

/** El adaptador del motor, o null si keel-recover no sabe leerlo. */
export function databaseAdapter(tech) {
  return Object.hasOwn(ADAPTERS, tech) ? ADAPTERS[tech] : null;
}
