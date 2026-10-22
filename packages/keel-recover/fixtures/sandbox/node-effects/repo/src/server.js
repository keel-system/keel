// Legacy de fixture para la puerta del paso 1 (keel-recover introspect + probe). Un servicio de
// pedidos con los cuatro efectos que el ejecutor de sondas tiene que capturar: escribe en MongoDB,
// cobra a un tercero por HTTP, publica en RabbitMQ y manda un correo. Las rutas van en un router
// montado en /api, para que la introspección tenga que componer el prefijo.
const express = require('express');
const amqp = require('amqplib');
const nodemailer = require('nodemailer');
const { MongoClient, ObjectId } = require('mongodb');

const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
const amqpUrl = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672';
const paymentUrl = process.env.PAYMENT_URL || 'http://localhost:8080';
const port = Number(process.env.PORT || 4100);

const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 2000 });
const orders = () => client.db('shop').collection('orders');
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 1025),
  secure: false,
  ignoreTLS: true,
});

// Una conexión por publicación: lo más simple que sobrevive a un broker que se reinicia. Si el
// broker no está, el evento se pierde (best-effort): es lo que la sonda de broker caído registra.
async function publish(routingKey, event) {
  let conn;
  try {
    conn = await amqp.connect(amqpUrl);
    const ch = await conn.createConfirmChannel();
    await ch.assertExchange('orders', 'topic', { durable: true });
    ch.publish('orders', routingKey, Buffer.from(JSON.stringify(event)), { contentType: 'application/json', persistent: true });
    await ch.waitForConfirms();
  } catch (err) {
    console.error(`evento ${routingKey} perdido: ${err.message}`);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

async function notify(order) {
  try {
    await mailer.sendMail({
      from: 'shop@orders.local',
      to: order.email,
      subject: `Pedido ${order._id} confirmado`,
      text: `Hola ${order.customer}, tu pedido de ${order.amount} está pagado.`,
    });
  } catch (err) {
    console.error(`correo perdido: ${err.message}`);
  }
}

const view = (o) => ({ id: String(o._id), customer: o.customer, email: o.email, amount: o.amount, status: o.status });
const idOf = (raw) => (ObjectId.isValid(raw) ? new ObjectId(raw) : null);

const api = express.Router();

api.get('/orders', async (req, res) => {
  res.json((await orders().find().sort({ _id: 1 }).toArray()).map(view));
});

api.get('/orders/:id', async (req, res) => {
  const id = idOf(req.params.id);
  const order = id && (await orders().findOne({ _id: id }));
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json(view(order));
});

api.post('/orders', async (req, res) => {
  const { customer, email, amount } = req.body || {};
  if (!customer || !email || !(amount > 0)) return res.status(422).json({ error: 'customer, email and a positive amount are required' });
  let payment;
  try {
    const r = await fetch(`${paymentUrl}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return res.status(502).json({ error: `payment rejected (${r.status})` });
    payment = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'payment unavailable' });
  }
  const order = { customer, email, amount, status: 'PAID', paymentId: payment.id, createdAt: new Date() };
  const { insertedId } = await orders().insertOne(order);
  order._id = insertedId;
  await publish('order.created', view(order));
  await notify(order);
  res.status(201).json(view(order));
});

api.post('/orders/:id/cancel', async (req, res) => {
  const id = idOf(req.params.id);
  const order = id && (await orders().findOne({ _id: id }));
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status === 'CANCELLED') return res.status(409).json({ error: 'order already cancelled' });
  await orders().updateOne({ _id: id }, { $set: { status: 'CANCELLED' } });
  await publish('order.cancelled', { id: String(id) });
  res.json({ ...view(order), status: 'CANCELLED' });
});

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'UP' }));
app.use('/api', api);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

app.listen(port, () => console.log(`orders-legacy escuchando en ${port}`));
