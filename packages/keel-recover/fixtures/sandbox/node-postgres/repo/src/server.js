// Legacy de fixture con base relacional, gemelo de node-mongo: el mismo servicio de stock por HTTP
// (una lectura y una escritura del dominio y un /health que miente), así que el diseño de juguete de
// test/helpers/stock-design.js se caracteriza igual contra los dos. Lo que añade es lo que solo
// tiene una base relacional y keel-recover tiene que leer: ids de secuencia, una UNIQUE, una clave
// ajena con borrado en cascada, un CHECK que declara el ciclo de vida (AVAILABLE → SOLD) y el esquema
// creado por la propia app al arrancar, como un ddl-auto. La cantidad va en jsonb porque el legacy
// guarda lo que le llegue (FL-ITM-004).
//
// POST /items/:sku/take lee la cantidad, la comprueba y escribe la nueva sin bloqueo: dos a la vez
// pierden una (la carrera que probe-check tiene que ver).
const express = require('express');
const { Pool } = require('pg');

const port = Number(process.env.PORT || 4000);
// El pool, caliente y sin cerrar las ociosas, como el de un servicio en producción: con el de por
// defecto (abre bajo demanda y cierra a los 10 s) la segunda de dos peticiones simultáneas espera a
// abrir su conexión, llega tarde y la carrera de /take no se ve (medido con probe-check).
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/stock', connectionTimeoutMillis: 2000, idleTimeoutMillis: 0, max: 10 });
const WARM = 4;

const SCHEMA = `
create table if not exists items (
  id serial primary key,
  sku text not null unique,
  quantity jsonb not null default '0',
  status varchar(20) not null default 'AVAILABLE' check (status in ('AVAILABLE', 'SOLD'))
);
create table if not exists movements (
  id serial primary key,
  item_id integer not null references items(id) on delete cascade,
  delta integer not null check (delta <> 0)
);`;

// El esquema, cuando la base conteste. La app empieza a escuchar con el esquema creado o, si la base
// no aparece en 20 s, sin él (y su /health dice UP igualmente, como el de orders): así un juez que
// mire la salud no ve nada raro y uno que lea el dominio recibe 500.
async function ensureSchema(onReady) {
  const giveUp = Date.now() + 20000;
  let ready = false;
  for (;;) {
    try {
      await pool.query(SCHEMA);
      await Promise.all(Array.from({ length: WARM }, () => pool.query('select 1')));
      if (!ready) onReady();
      return;
    } catch (err) {
      console.error(`esquema pendiente: ${err.message}`);
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
  const r = await pool.query('select sku, quantity from items order by id');
  res.json(r.rows);
}));

app.get('/items/:sku', h(async (req, res) => {
  const r = await pool.query('select sku, quantity, status from items where sku = $1', [req.params.sku]);
  if (!r.rows.length) return res.status(404).json({ error: 'item not found' });
  res.json(r.rows[0]);
}));

app.post('/items', h(async (req, res) => {
  const body = req.body || {};
  if (!body.sku) return res.status(422).json({ error: 'sku is required' });
  const quantity = body.quantity || 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await client.query('insert into items (sku, quantity) values ($1, $2::jsonb) returning id', [body.sku, JSON.stringify(quantity)]);
    if (typeof quantity === 'number' && quantity !== 0) await client.query('insert into movements (item_id, delta) values ($1, $2)', [r.rows[0].id, quantity]);
    await client.query('commit');
    res.status(201).json({ sku: body.sku });
  } catch (err) {
    await client.query('rollback');
    if (err.code === '23505') return res.status(409).json({ error: 'sku already exists' });
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/items/:sku/take', h(async (req, res) => {
  const n = Number((req.body || {}).n || 1);
  const r = await pool.query('select id, quantity from items where sku = $1', [req.params.sku]);
  if (!r.rows.length) return res.status(404).json({ error: 'item not found' });
  const left = Number(r.rows[0].quantity) - n;
  if (!(left >= 0)) return res.status(409).json({ error: 'not enough stock' });
  await pool.query("update items set quantity = $1::jsonb, status = case when $1::jsonb = '0' then 'SOLD' else status end where id = $2", [JSON.stringify(left), r.rows[0].id]);
  await pool.query('insert into movements (item_id, delta) values ($1, $2)', [r.rows[0].id, -n]);
  res.json({ sku: req.params.sku, quantity: left });
}));

app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

ensureSchema(() => app.listen(port, () => console.log(`stock-legacy-pg escuchando en ${port}`)));
