# El sandbox de MercadoPago

Con credenciales de prueba (usuarios de test del panel), en el perfil `develop`:
`MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_WEBHOOK_SECRET`.

## Qué verificar, en este orden

Cada punto que se confirme convierte su celda de la matriz en `supported` (se edita
`gateway-support.js` en keel-spring, no el proyecto). Lo que no se confirme se reporta como
`designGap` del generador; no se arregla a mano en el adaptador.

1. **Cobro con token** (cliente presente), autorizado y capturado: `capture_mode: manual`, captura
   con `/capture`, estados `processed` + `waiting_capture` y después `accredited`.
2. **Rechazos**: las tarjetas de prueba con el nombre de titular que fuerza cada `status_detail`
   acaban en el motivo neutro que dice el adaptador.
3. **Medio guardado y cobro sin cliente**: alta de customer y tarjeta, primer cobro con
   `stored_credential` y uno posterior sin CVV ni token. Anota los nombres EXACTOS de los campos
   que acepta la order: el adaptador los escribe con la lectura más probable de la documentación.
4. **3DS**: qué devuelve una order `action_required` y dónde está la acción para el navegador.
5. **Búsqueda por referencia**: que `/v1/orders/search?external_reference=` encuentra la order.
6. **Aviso**: que la firma del manifiesto verifica con el secreto del panel, y que uno alterado
   da 401.
