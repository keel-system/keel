# Lo que suele fallar

| Síntoma | Causa | Arreglo |
|---|---|---|
| Todo aviso responde 401 | El secreto de firma de la configuración no es el del endpoint; o algo lee el cuerpo antes del controlador | Revisa `payments.gateway.webhook-secret`; la excepción de `/webhooks/payments` en `http-platform.ts` sigue ahí |
| Un aviso responde 400 «no es JSON válido» | El lector JSON leyó el cuerpo del aviso | Alguien quitó la excepción de la ruta del aviso en `http-platform.ts`: vuelve a dejarla |
| Un escenario de reintento cobra dos veces en la pasarela de prueba | La clave no sale de la referencia, o el cobro no se guardó antes de llamar | `ChargeRequest.reference` = `charge.reference`; `save` antes de `authorize` |
| `Nest can't resolve dependencies of <X>CommandHandler` | El handler usa un puerto de pagos que no declaró | Añádelo a su `static readonly inject`, en el orden del constructor |
| El barrido consulta el mismo cobro desde las dos réplicas | Falta el reclamo condicional de `awaitingSince` | `references/reconciliation.md` |
| Un desenlace tardío lanza un error de transición | El handler del desenlace no es idempotente | `references/outcomes.md` |
| `TODO(keel): '<componente>' no lo nombra la capa payments` | Llegó un desenlace cuyo dato el diseño dejó por decidir | Complétalo en el aplicador (`references/outcomes.md`) |
| `tiene más decimales de los que admite` | El importe llega con más escala que la moneda | Es correcto que falle: el diseño declara la escala; responde 400 antes de llegar aquí |
