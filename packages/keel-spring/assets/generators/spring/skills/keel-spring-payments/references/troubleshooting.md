# Lo que suele fallar

| Síntoma | Causa | Arreglo |
|---|---|---|
| Todo aviso responde 401 | El secreto de firma de la configuración no es el del endpoint; o algo re-serializa el cuerpo antes del controller | Revisa `payments.gateway.webhook-secret`; que ningún filtro consuma el cuerpo |
| Un escenario de reintento cobra dos veces en la pasarela de prueba | La clave de idempotencia no sale de la referencia, o el cobro no se registró antes de llamar | `ChargeRequest.reference` = `charge.reference`; registro en su propia transacción |
| El barrido consulta el mismo cobro desde las dos réplicas | Falta el reclamo condicional de `awaitingSince` | `references/reconciliation.md` |
| Un desenlace tardío lanza `InvalidStateTransitionException` | El handler del desenlace no es idempotente | `references/outcomes.md` |
| `IllegalArgumentException: tiene más decimales de los que admite` | El importe llega con más escala que la moneda | Es correcto que falle: el diseño declara `scalePolicy: reject`; responde 400 antes de llegar aquí |
