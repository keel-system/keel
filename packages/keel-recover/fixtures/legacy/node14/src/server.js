// Servidor de pedidos: http://docs.example.invalid (un comentario no es una dependencia)
const express = require('express');
const routes = require('./routes/orders');

const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use('/orders', routes);

if (!isProduction) {
  app.use((err, req, res, next) => res.status(500).json({ error: err.stack }));
}

app.listen(port, () => console.log(`escuchando en ${port}`));
