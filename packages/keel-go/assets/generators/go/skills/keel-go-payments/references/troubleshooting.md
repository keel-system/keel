# Lo que suele fallar

| Síntoma | Causa | Arreglo |
|---|---|---|
| Todo aviso responde 401 | El secreto de firma de la configuración no es el del verificador; o algo cambió cómo se lee el cuerpo | Revisa `payments.gateway.webhook-secret`; `internal/httpapi/payment_notice.go` lee el cuerpo como texto, sin tocarlo |
| Un aviso responde 400 | Alguien hizo pasar el aviso por el contrato del cable | Vuelve a `internal/httpapi/payment_notice.go` tal como lo generó build (`build --refresh`) |
| Un escenario de reintento cobra dos veces en la pasarela de prueba | La clave no sale de la referencia, o el cobro no se guardó antes de llamar | La referencia de `domain.NewChargeRequest` es `charge.reference`; `Save` antes de `Authorize` |
| El barrido consulta el mismo cobro desde las dos réplicas | Falta el reclamo condicional de `AwaitingSince` | `references/reconciliation.md` |
| Un desenlace tardío devuelve un error de transición | El handler del desenlace no es idempotente | `references/outcomes.md` |
| `sin implementar: <componente> del desenlace <x>` | Llegó un desenlace cuyo dato el diseño dejó por decidir | Complétalo en `internal/application/payment_outcome_choices.go` (`references/outcomes.md`) |
| `tiene más decimales de los que admite` | El importe llega con más escala que la moneda | Es correcto que falle: el diseño declara la escala; responde 400 antes de llegar aquí |
| Un cobro de un escenario sale `FAILED` sin que el Given lo pidiera | La pasarela de prueba no tiene respuesta por defecto: contestó 404 | Programa su referencia con `s.GatewayAuthorizes` o `s.GatewayCharges` (`references/flows.md`) |
| Cae `<pasarela>_test.go` | Se tocó una defensa del adaptador o del verificador | Vuelve a lo que generó build: esas pruebas no se adaptan al código |
