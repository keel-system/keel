// Legacy de fixture con MySQL, gemelo de node-postgres: el mismo servicio de stock por HTTP (una lectura y
// una escritura del dominio y un /health que miente), así que el diseño de juguete de
// test/helpers/stock-design.js se caracteriza igual contra los tres. Lo que añade lo trae su esquema
// (db/schema.sql, cargado por la base y no por la app): ENUM, CHECK, collation _ci, ON UPDATE
// CURRENT_TIMESTAMP, fechas cero, una tabla MyISAM y un trigger. La cantidad va en JSON porque el legacy
// guarda lo que le llegue (FL-ITM-004).
//
// POST /items/:sku/take lee la cantidad, la comprueba y escribe la nueva sin bloqueo: dos a la vez
// pierden una (la carrera que probe-check tiene que ver).
const express = require('express');
const mysql = require('mysql2/promise');

const port = Number(process.env.PORT || 4000);
// El pool, caliente y sin cerrar las ociosas, como el de un servicio en producción (el mismo motivo que
// en node-postgres: con conexiones bajo demanda la carrera de /take no se ve).
const pool = mysql.createPool({ uri: process.env.DATABASE_URL || 'mysql://stock:stock@localhost:3306/stock', connectTimeout: 2000, connectionLimit: 10, maxIdle: 10, idleTimeout: 86400000 });
const WARM = 4;

// La base, cuando conteste. La app empieza a escuchar con el pool caliente o, si la base no aparece en
// 20 s, sin él (y su /health dice UP igualmente, como el de orders): así un juez que mire la salud no
// ve nada raro y uno que lea el dominio recibe 500.
async function warmUp(onReady) {
  const giveUp = Date.now() + 20000;
  let ready = false;
  for (;;) {
    try {
      const held = await Promise.all(Array.from({ length: WARM }, () => pool.getConnection()));
      await Promise.all(held.map((c) => c.query('select 1')));
      held.forEach((c) => c.release());
      if (!ready) onReady();
      return;
    } catch (err) {
      console.error(`base pendiente: ${err.message}`);
      if (!ready && Date.now() > giveUp) {
        ready = true;
        onReady();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const app = express();
app.use(express.json());
// Express 4 no recoge el error de un manejador asíncrono: sin esto, una base caída cuelga la petición.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/health', (req, res) => res.json({ status: 'UP' }));

app.get('/items', h(async (req, res) => {
  const [rows] = await pool.query('select sku, quantity from items order by id');
  res.json(rows);
}));

app.get('/items/:sku', h(async (req, res) => {
  const [rows] = await pool.query('select sku, quantity, status from items where sku = ?', [req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: 'item not found' });
  res.json(rows[0]);
}));

app.post('/items', h(async (req, res) => {
  const body = req.body || {};
  if (!body.sku) return res.status(422).json({ error: 'sku is required' });
  const quantity = body.quantity || 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('insert into items (sku, quantity) values (?, cast(? as json))', [body.sku, JSON.stringify(quantity)]);
    if (typeof quantity === 'number' && quantity !== 0) await conn.query('insert into movements (item_id, delta) values (?, ?)', [r.insertId, quantity]);
    await conn.commit();
    res.status(201).json({ sku: body.sku });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'sku already exists' });
    throw err;
  } finally {
    conn.release();
  }
}));

app.post('/items/:sku/take', h(async (req, res) => {
  const n = Number((req.body || {}).n || 1);
  const [rows] = await pool.query('select id, quantity from items where sku = ?', [req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: 'item not found' });
  const left = Number(rows[0].quantity) - n;
  if (!(left >= 0)) return res.status(409).json({ error: 'not enough stock' });
  await pool.query("update items set quantity = cast(? as json), status = if(? = 0, 'SOLD', status), last_sold_at = if(? = 0, now(), last_sold_at) where id = ?", [JSON.stringify(left), left, left, rows[0].id]);
  await pool.query('insert into movements (item_id, delta) values (?, ?)', [rows[0].id, -n]);
  res.json({ sku: req.params.sku, quantity: left });
}));

app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

warmUp(() => app.listen(port, () => console.log(`stock-legacy-mysql escuchando en ${port}`)));
