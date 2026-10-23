// La base del legacy (y la del regenerado, en la paridad) detrás de una sola interfaz, un adaptador
// por motor. Lo que verify, introspect, probe, characterize y parity le preguntan a la base es lo
// mismo para todos los motores; cómo se pregunta es de cada uno (el shell de Mongo, psql…). Un motor
// sin adaptador es un rechazo con motivo, igual que en `sandbox.schema.json`: hasta medirlo contra un
// legacy real no se sabe si su snapshot devuelve el estado entero ni si su rastro de escritura llega
// a tiempo (en PostgreSQL 9.4 el contador de escrituras llega segundos tarde: docs/recover-bench).
//
// La interfaz de un adaptador. Todas las funciones reciben el runtime, el contenedor de la base y la
// base: `{ name, user?, auth? }` (la sección `database` de sandbox.yaml, o la de target.yaml):
//   fingerprint(rt, c, db)              → { ok, value }   huella que cambia con cualquier escritura
//   takeSnapshot(rt, c, db)             → { ok, where, hash }
//   hasSnapshot(rt, c)                  → boolean          el snapshot sigue en el contenedor
//   noSnapshot(c, sandboxRel)           → string           qué hacer si no está
//   restoreSnapshot(rt, c, db)          → { ok }           la base vuelve al snapshot, entera
//   exportDb(rt, c, db)                 → { ok, value }    el contenido como JSON plano
//   diff(before, after)                 → { <colección|tabla>: { added, removed, changed } }
//   introspect(rt, c, db)               → { ok, value }    la sección `data` de surface.yaml, sin tech ni nombre
//   empty(rt, c, db)                    → { ok, remaining } vacía la base del regenerado (paridad)
//   loadScript(rt, c, db, sql)          → { ok }           carga el infra/fixtures.sql del regenerado, en una transacción
//   snapshotFile                        string             dónde vive el snapshot dentro del contenedor
//   rowNoun                             string             cómo se llaman sus filas en los mensajes

import * as mongodb from './mongodb.js';
import * as postgresql from './postgresql.js';

const ADAPTERS = {
  mongodb: {
    tech: 'mongodb',
    snapshotFile: mongodb.SNAPSHOT_ARCHIVE,
    rowNoun: 'documentos',
    fingerprint: (rt, c, db) => mongodb.dbHash(rt, c, db.name),
    takeSnapshot: (rt, c, db) => mongodb.takeSnapshot(rt, c, db.name),
    hasSnapshot: mongodb.hasSnapshot,
    noSnapshot: mongodb.NO_SNAPSHOT,
    restoreSnapshot: (rt, c, db) => mongodb.restoreSnapshot(rt, c, db.name),
    exportDb: (rt, c, db) => mongodb.exportDb(rt, c, db.name),
    diff: mongodb.dbDiff,
    introspect: (rt, c, db) => {
      const r = mongodb.introspectDb(rt, c, db.name);
      return r.ok ? { ok: true, value: { collections: r.value } } : r;
    },
    empty: (rt, c, db) => mongodb.emptyDatabase(rt, c, db.name, { auth: db.auth ?? null }),
    // Los generadores no emiten fixtures en un diseño documental (keel-core/gen/fixtures.js): no hay script que cargar.
    loadScript: () => ({ ok: false, error: 'el estado de partida (fixtures.yaml) todavía no se carga en MongoDB' }),
  },
  postgresql: {
    tech: 'postgresql',
    snapshotFile: postgresql.SNAPSHOT_FILE,
    rowNoun: 'filas',
    fingerprint: postgresql.fingerprint,
    takeSnapshot: postgresql.takeSnapshot,
    hasSnapshot: postgresql.hasSnapshot,
    noSnapshot: postgresql.NO_SNAPSHOT,
    restoreSnapshot: postgresql.restoreSnapshot,
    exportDb: postgresql.exportDb,
    diff: postgresql.dbDiff,
    introspect: postgresql.introspectDb,
    empty: postgresql.emptyDatabase,
    loadScript: (rt, c, db, sql) => postgresql.psql(rt, c, db, `begin;
${sql}
commit;
`),
  },
};

/** Los motores con adaptador, en el orden en que se nombran en los mensajes. */
export const DATABASE_TECHS = Object.keys(ADAPTERS);

/** Las piezas que todo adaptador tiene que traer (lo comprueba test/db.test.js). */
export const ADAPTER_FUNCTIONS = ['fingerprint', 'takeSnapshot', 'hasSnapshot', 'noSnapshot', 'restoreSnapshot', 'exportDb', 'diff', 'introspect', 'empty', 'loadScript'];

/** El adaptador del motor, o null si keel-recover no sabe leerlo. */
export function databaseAdapter(tech) {
  return Object.hasOwn(ADAPTERS, tech) ? ADAPTERS[tech] : null;
}
