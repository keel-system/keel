// Las medidas de MySQL que show-ticketing no cubre (PLAN-KEEL-RECOVER-MYSQL.md, M2), contra el sandbox de
// fixtures/sandbox/node-mysql ya verificado: verify-check las pasa tras el escenario `base`, con el snapshot del
// juez tomado. Cada una comprueba también que no es vacía (que el sandbox tiene de verdad lo que mide: otra zona,
// una fecha cero, una transacción que retiene la tabla), así que una fixture que perdiera la forma sale en rojo.
//
//   catalog         ENUM con sus valores, CHECK, collation _ci y motor por tabla; la FK declarada sobre MyISAM
//                   no existe en el catálogo (M-10)
//   check           el CHECK se aplica (desde 8.0.16; antes se ignoraba)
//   zero-date       las fechas cero salen como texto literal en la exportación (M-06)
//   timestamp-zone  una TIMESTAMP sale en UTC con el servidor en otra zona, y la huella no cambia si alguien
//                   cambia la zona global (M-06)
//   on-update       ON UPDATE CURRENT_TIMESTAMP cambia updated_at sin que el flujo lo toque (M-09), y el trigger
//                   escribe en la tabla MyISAM (M-11)
//   restore         con el pool de la app conectado, la restauración vuelve a la huella del snapshot: fechas cero,
//                   TIMESTAMP, MyISAM y AUTO_INCREMENT incluidos, y el trigger sigue vivo (M-04, M-10, M-11)
//   open-tx         con una transacción abierta, la restauración sale en rojo a su tope con quién la retiene;
//                   sin el tope se queda esperando el metadata lock hasta que la transacción se cierra (M-01)
import { clientArgs, mysql, restoreSnapshot, RESTORE_LOCK_WAIT_SECONDS, SESSION, SNAPSHOT_FILE } from '../src/lib/db/mysql.js';
import { rows } from '../src/lib/db/relational.js';
import { probe } from '../src/lib/verify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (id, ok, detail) => ({ id, ok: Boolean(ok), detail });

/** `{ rt, db, tool, base, database, adapter, snapshotHash }` → `[{ id, ok, detail }]`, en orden. */
export async function mysqlMeasures(ctx) {
  const out = [];
  for (const [id, fn] of Object.entries(MEASURES)) {
    let r;
    try {
      r = await fn(ctx);
    } catch (err) {
      r = { ok: false, detail: `falló: ${err.message}` };
    }
    out.push(result(id, r.ok, r.detail));
  }
  return out;
}

const q = (ctx, sql) => {
  const r = mysql(ctx.rt, ctx.db, ctx.database, sql);
  if (!r.ok) throw new Error(r.error);
  return rows(r.out);
};
// Una sesión como la de la app: sin la zona de la herramienta (la del servidor).
const raw = (ctx, sql) => {
  const r = ctx.rt.exec(ctx.db, clientArgs(ctx.database, 'mysql', ['-N', '-B', '-r', ctx.database.name]), { input: sql });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return rows(r.stdout);
};
const http = (ctx, method, path, body, expect) => {
  const r = probe(ctx.rt, ctx.tool, ctx.base, { method, path, body, expect }, 'm2');
  if (!r.ok) throw new Error(r.detail);
  return r;
};
const exported = (ctx) => {
  const e = ctx.adapter.exportDb(ctx.rt, ctx.db, ctx.database);
  if (!e.ok) throw new Error(e.error);
  return e.value;
};
const hash = (ctx) => {
  const h = ctx.adapter.fingerprint(ctx.rt, ctx.db, ctx.database);
  if (!h.ok) throw new Error(h.error);
  return h.value;
};
const item = (doc, sku) => doc.items.find((i) => i.sku === sku);

const MEASURES = {
  catalog(ctx) {
    const r = ctx.adapter.introspect(ctx.rt, ctx.db, ctx.database);
    if (!r.ok) return { ok: false, detail: r.error };
    const t = Object.fromEntries(r.value.tables.map((x) => [x.name, x]));
    const col = (table, name) => t[table]?.columns.find((c) => c.name === name);
    const facts = {
      'items InnoDB': t.items?.engine === 'InnoDB',
      'status ENUM(AVAILABLE, SOLD)': JSON.stringify(col('items', 'status')?.values) === '["AVAILABLE","SOLD"]',
      'sku _ci y única': /_ci$/.test(col('items', 'sku')?.collation ?? '') && JSON.stringify(t.items?.unique) === '[["sku"]]',
      'CHECK de delta': (t.movements?.checks ?? []).some((c) => /delta/.test(c)),
      'FK en cascada': t.movements?.foreignKeys?.[0]?.onDelete === 'cascade',
      'movement_log MyISAM': t.movement_log?.engine === 'MyISAM',
      'sin su FK declarada': !t.movement_log?.foreignKeys,
    };
    const missing = Object.entries(facts).filter(([, ok]) => !ok).map(([k]) => k);
    return { ok: !missing.length, detail: missing.length ? `no se ve: ${missing.join(', ')}` : Object.keys(facts).join(', ') };
  },

  check(ctx) {
    const r = mysql(ctx.rt, ctx.db, ctx.database, 'insert into movements (item_id, delta) values (1, 0);');
    return { ok: !r.ok && /ERROR 3819\b/.test(r.error), detail: r.ok ? 'un movimiento con delta 0 entró: el CHECK no se aplica' : r.error };
  },

  'zero-date'(ctx) {
    const [[datetime, date]] = raw(ctx, "select cast(last_sold_at as char), cast(restock_on as char) from items where sku = 'seed-1';");
    if (datetime !== '0000-00-00 00:00:00' || date !== '0000-00-00') return { ok: false, detail: `seed-1 no tiene fechas cero (${datetime}, ${date}): la medida sería vacía` };
    const s = item(exported(ctx), 'seed-1');
    const ok = s?.last_sold_at === '0000-00-00T00:00:00' && s?.restock_on === '0000-00-00';
    return { ok, detail: `exportadas como ${JSON.stringify({ last_sold_at: s?.last_sold_at, restock_on: s?.restock_on })}` };
  },

  'timestamp-zone'(ctx) {
    const [[zone, local, epoch]] = raw(ctx, "select @@session.time_zone, cast(updated_at as char), unix_timestamp(updated_at) from items where sku = 'seed-2';");
    const utc = new Date(Number(epoch) * 1000).toISOString().slice(0, 19);
    if (zone === '+00:00' || zone === 'UTC' || local.replace(' ', 'T') === utc) return { ok: false, detail: `el servidor corre en ${zone}: la medida sería vacía` };
    const exportedAt = item(exported(ctx), 'seed-2')?.updated_at;
    if (exportedAt !== utc) return { ok: false, detail: `updated_at exportada como ${exportedAt}, y en UTC es ${utc} (la sesión de la app lee ${local} en ${zone})` };
    // La huella no depende de la zona global: la herramienta fija la suya en cada sesión.
    const before = hash(ctx);
    try {
      q(ctx, "set global time_zone = '+09:00';");
      const [[moved]] = raw(ctx, "select cast(updated_at as char) from items where sku = 'seed-2';");
      const after = hash(ctx);
      if (moved === local) return { ok: false, detail: 'cambiar la zona global no cambió la lectura de la app: la medida sería vacía' };
      return { ok: before === after, detail: `${utc} en UTC (la app lee ${local} en ${zone} y ${moved} en +09:00); huella ${before === after ? 'igual' : 'DISTINTA'} con la zona global cambiada` };
    } finally {
      q(ctx, `set global time_zone = '${zone}';`);
    }
  },

  async 'on-update'(ctx) {
    http(ctx, 'POST', '/items', { sku: 'm09', quantity: 2 }, [201]);
    const before = exported(ctx);
    await sleep(1100); // TIMESTAMP tiene segundos: en el mismo segundo, ON UPDATE no cambia nada visible
    http(ctx, 'POST', '/items/m09/take', { n: 1 }, [200]);
    const after = exported(ctx);
    const diff = ctx.adapter.diff(before, after);
    const changed = diff.items?.changed.find((c) => c.after.sku === 'm09');
    const logged = (diff.movement_log?.added ?? []).filter((r) => r.delta === -1).length;
    const ok = changed && changed.before.updated_at !== changed.after.updated_at && logged === 1;
    return { ok, detail: changed ? `updated_at ${changed.before.updated_at} → ${changed.after.updated_at} sin que /take la nombre; movement_log +${logged} por el trigger` : 'el take no cambió la fila' };
  },

  restore(ctx) {
    const r = restoreSnapshot(ctx.rt, ctx.db, ctx.database);
    if (!r.ok) return { ok: false, detail: r.error };
    const back = hash(ctx);
    const [[triggers]] = q(ctx, 'select count(*) from information_schema.triggers where trigger_schema = database();');
    http(ctx, 'POST', '/items', { sku: 'after-restore', quantity: 4 }, [201]);
    const logged = exported(ctx).movement_log.some((m) => m.delta === 4);
    const again = restoreSnapshot(ctx.rt, ctx.db, ctx.database);
    const ok = back === ctx.snapshotHash && triggers === '1' && logged && again.ok;
    return { ok, detail: `huella ${back === ctx.snapshotHash ? 'la del snapshot' : `${back}, y la del snapshot es ${ctx.snapshotHash}`}; ${triggers} trigger, ${logged ? 'que sigue escribiendo' : 'que YA NO escribe'} en movement_log` };
  },

  async 'open-tx'(ctx) {
    // processlist.info no conserva los comentarios: la sesión se reconoce por su sleep, que nada más usa
    const marker = 'select sleep(297)';
    // Una escritura antes: la base deja de estar en el snapshot, así que «intacta» y «restaurada» se distinguen.
    http(ctx, 'POST', '/items', { sku: 'm01', quantity: 1 }, [201]);
    const dirty = hash(ctx);
    if (dirty === ctx.snapshotHash) return { ok: false, detail: 'la escritura no cambió la huella: la medida sería vacía' };
    // Una sesión que lee items dentro de una transacción y no la cierra: retiene su metadata lock.
    const holder = ctx.rt.execAsync(ctx.db, clientArgs(ctx.database, 'mysql', ['-N', ctx.database.name]), { input: `start transaction;\nselect count(*) from items;\n${marker};\ncommit;\n`, timeoutMs: 400_000 });
    const kill = async () => {
      const ids = q(ctx, `select id from information_schema.processlist where info = '${marker}';`).map(([id]) => id);
      for (const id of ids) mysql(ctx.rt, ctx.db, ctx.database, `kill ${id};`);
      await holder;
      return ids.length > 0;
    };
    try {
      let held = [];
      for (let i = 0; i < 20 && !held.length; i++) {
        await sleep(500);
        held = q(ctx, "select lock_type from performance_schema.metadata_locks where object_schema = database() and object_name = 'items' and lock_status = 'GRANTED';");
      }
      if (!held.length) return { ok: false, detail: 'la sesión no retiene el metadata lock de items: la medida sería vacía' };

      // Con el tope: rojo con su motivo, y la base intacta (el volcado empieza por items).
      const t0 = Date.now();
      const r = restoreSnapshot(ctx.rt, ctx.db, ctx.database);
      const took = (Date.now() - t0) / 1000;
      const redWithReason = !r.ok && /metadata lock/.test(r.error) && /sesión \d+ de root@/.test(r.error) && hash(ctx) === dirty;
      const inTime = took >= RESTORE_LOCK_WAIT_SECONDS - 1 && took < RESTORE_LOCK_WAIT_SECONDS + 15;
      http(ctx, 'GET', '/items', undefined, [200]);
      if (!redWithReason || !inTime) return { ok: false, detail: `con el tope: ${r.ok ? 'restauró' : r.error} en ${took.toFixed(1)} s, la base ${hash(ctx) === dirty ? 'intacta' : 'TOCADA'}` };

      // Sin el tope (el de MySQL, un año): sigue esperando pasado el nuestro, y termina al cerrarse la transacción.
      const untimed = ctx.rt.execAsync(ctx.db, clientArgs(ctx.database, 'mysql', ['-N', '-B', ctx.database.name]), { input: `${SESSION}source ${SNAPSHOT_FILE}\n`, timeoutMs: 120_000 });
      await sleep((RESTORE_LOCK_WAIT_SECONDS + 5) * 1000);
      const waiting = q(ctx, "select count(*) from information_schema.processlist where state = 'Waiting for table metadata lock';")[0][0];
      const killed = await kill();
      const done = await untimed;
      const back = hash(ctx);
      const ok = waiting !== '0' && killed && done.status === 0 && back === ctx.snapshotHash;
      return {
        ok,
        detail: `con el tope, rojo a los ${took.toFixed(1)} s nombrando la sesión y la base intacta; sin él, ${waiting} sesión(es) esperando el metadata lock a los ${RESTORE_LOCK_WAIT_SECONDS + 5} s, que restauró ${done.status === 0 ? 'al cerrarse la transacción' : `con error: ${done.stderr}`}; huella ${back === ctx.snapshotHash ? 'la del snapshot' : 'DISTINTA'}`,
      };
    } finally {
      await kill();
    }
  },
};
