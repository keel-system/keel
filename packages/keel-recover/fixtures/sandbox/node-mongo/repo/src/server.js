// Legacy de fixture para la puerta del juez (keel-recover verify). Lo justo para medir los
// criterios: una lectura y una escritura del dominio contra MongoDB y un /health que, como el de
// orders, dice que todo va bien aunque la base no conteste.
const http = require('http');
const { MongoClient } = require('mongodb');

const url = process.env.MONGO_URL || 'mongodb://localhost:27017';
const port = Number(process.env.PORT || 4000);
const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
const items = () => client.db('stock').collection('items');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { status: 'UP' });
    if (req.method === 'GET' && req.url === '/items') {
      return send(res, 200, await items().find({}, { projection: { _id: 0 } }).toArray());
    }
    if (req.method === 'POST' && req.url === '/items') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.sku) return send(res, 422, { error: 'sku is required' });
      await items().insertOne({ sku: body.sku, quantity: body.quantity || 0 });
      return send(res, 201, { sku: body.sku });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(port, () => console.log(`stock-legacy escuchando en ${port}`));
