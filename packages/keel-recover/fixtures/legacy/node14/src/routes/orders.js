const express = require('express');
const axios = require('axios');
const amqp = require('amqplib');
const nodemailer = require('nodemailer');
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL });

const { CATALOG_URL, SMTP_HOST = 'mailpit' } = process.env;
const amqpUrl = process.env['AMQP_URL'] ?? 'amqp://guest:guest@rabbitmq:5672';

const router = express.Router();

router.post('/', async (req, res) => {
  const item = await axios.get(`${CATALOG_URL}/items/${req.body.sku}`);
  const [id] = await knex('orders').insert({ sku: req.body.sku, price: item.data.price }).returning('id');
  const conn = await amqp.connect(amqpUrl);
  const channel = await conn.createChannel();
  channel.publish('orders', 'order.created', Buffer.from(JSON.stringify({ id })));
  await nodemailer.createTransport({ host: SMTP_HOST, port: 1025 }).sendMail({ to: req.body.email, subject: 'Pedido recibido' });
  res.status(201).json({ id, avatar: 'https://cdn.example.invalid/default.png' });
});

module.exports = router;
