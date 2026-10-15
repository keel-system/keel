# Lo que suele fallar

| Síntoma | Causa | Arreglo |
|---|---|---|
| Todo aviso responde 401 | El secreto de firma de la configuración no es el del endpoint; o algo cambió cómo se lee el cuerpo | Revisa `payments.gateway.webhook-secret`; `PaymentNoticeEndpoint` lee el cuerpo como texto, sin tocarlo |
| Un aviso responde 400 | Alguien hizo pasar el aviso por el contrato del cable | Vuelve a `PaymentNoticeEndpoint` tal como lo generó build |
| Un escenario de reintento cobra dos veces en la pasarela de prueba | La clave no sale de la referencia, o el cobro no se guardó antes de llamar | `ChargeRequest.Reference` = `charge.reference`; `Save` antes de `Authorize` |
| `Unable to resolve service for type 'IPaymentGateway'` (o el aplicador) | Falta `AddPayments` en `Program.cs`, o lo quitaste | Lo registra build: no lo borres |
| El barrido consulta el mismo cobro desde las dos réplicas | Falta el reclamo condicional de `AwaitingSince` | `references/reconciliation.md` |
| Un desenlace tardío lanza un error de transición | El handler del desenlace no es idempotente | `references/outcomes.md` |
| `TODO(keel): '<componente>' no lo nombra la capa payments` | Llegó un desenlace cuyo dato el diseño dejó por decidir | Complétalo en el aplicador (`references/outcomes.md`) |
| `El importe tiene más decimales de los que admite` | El importe llega con más escala que la moneda | Es correcto que falle: el diseño declara la escala; responde 400 antes de llegar aquí |
| Cae `PaymentGatewayTests` o `PaymentNoticeEndpointTests` | Se tocó una defensa del adaptador, del verificador o del aviso | Vuelve a lo que generó build: esas pruebas no se adaptan al código |
