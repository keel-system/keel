# Los flujos contra la pasarela de prueba

En el perfil `local`, `payments.gateway.base-url` apunta al WireMock de `infra/docker-compose.yaml`, y los flujos lo
programan con los métodos del escenario de `tests/integration/payment_gateway_test.go` (los mismos nombres que los
arneses de keel-spring, keel-nest y keel-dotnet). La API es **neutra**: no nombra la pasarela, y el mismo flujo vale
con cualquiera. El reset de cada flujo vacía el stub: lo que necesita un escenario se programa en su Given.

## Programar el desenlace de un cobro

```go
s.GatewayAuthorizes("order-1")                    // el cobro de esa referencia queda autorizado
s.GatewayCharges("order-2")                       // cobrado en el acto
s.GatewayRequiresAction("order-3")                // exige 3DS: ACTION_REQUIRED con su acción
s.GatewayDeclines("order-4", "insufficientFunds") // rechazado, con un motivo del vocabulario neutro
s.GatewayDoesNotAnswer(CallCharge)                // corta la conexión: el cobro queda EN DUDA
```

Cada helper de cobro casa **solo** con la petición que lleva esa referencia: varios cobros conviven en el mismo flujo.
`s.GatewayIDFor(referencia)` es el id que la pasarela de prueba le asigna, determinista, para nombrarlo antes de pedir
el cobro. Las llamadas son las constantes `CallCharge`, `CallCapture`, `CallCancel`, `CallRefund`, `CallStatus`,
`CallSearch`, `CallSaveMethod` y `CallAttachMethod`.

## Lo que pasa después

- `s.GatewayReports(referencia, "CAPTURED")` (o `"NOT_FOUND"`, `"AUTHORIZED"`…): lo que contesta cuando se le
  pregunta (por id y por referencia) — lo que leen el aviso y el barrido.
- `s.GatewayCaptures`, `s.GatewayCancels`, `s.GatewayRefunds(referencia, "5.00")`: las acciones de seguimiento.
- `s.GatewayExpiresAuthorization(referencia)`: la autorización caducó antes de capturarse — la captura se rechaza y el
  cobro queda anulado. Ningún escenario puede esperar los días reales.
- `s.GatewayRejects(CallRefund)`: la pasarela rechaza esa llamada (4xx). **Tras rechazar una captura, una anulación o
  una devolución, el servidor le pregunta el estado real del cobro** (el rechazo no lo dice; lo hacen los adaptadores
  de los cuatro generadores), así que el Given programa las dos cosas:

  ```go
  s.GatewayRejects(CallCapture)
  s.GatewayReports("ch-022", "AUTHORIZED") // sigue autorizado: el rechazo no movió nada
  ```

  Sin el `GatewayReports`, la consulta no encuentra el cobro (`NOT_FOUND`) y el handler no puede distinguir el rechazo
  de un cobro que la pasarela no conoce. **No lo arregles en el adaptador**: la pasarela real sí conoce el cobro, y el
  adaptador es el mismo servidor que el de los otros tres.
- `s.GatewaySavesPaymentMethod()`: guardar un medio de pago funciona.
- `s.GatewayCallCount(CallCharge)` y `s.GatewayRequests(CallCharge)`: cuántas veces y qué se le mandó (la clave de
  idempotencia viaja en la cabecera de la pasarela: `request.Header("Idempotency-Key")` en una,
  `request.Header("X-Idempotency-Key")` en otra; su skill dice cuál).

## El aviso

```go
s.GatewayReports("order-1", "CAPTURED")
if got := s.SendGatewayNotice("order-1"); got.Status != 200 { // firmado como lo firma la pasarela
	s.Errorf("el aviso firmado: %s", got)
}
if got := s.SendForgedGatewayNotice("order-1"); got.Status != 401 { // firma alterada: no se consulta nada
	s.Errorf("el aviso falsificado: %s", got)
}
```

## El barrido

El barrido lo dispara su cron, como en producción. Para que tome un cobro concreto sin esperar el umbral real:
`s.AgeForReconciliation("<barrido>", id)` deja rancia su `AwaitingSince` (el nombre es el de
`payments.reconciliation.sweep`), y después se espera con `s.Eventually` a que el estado cambie. No escribas un UPDATE
a mano para eso.

Para lo contrario —un cobro que acaba de entrar en vuelo y que el barrido NO tiene que tocar—,
`s.HoldFromReconciliation("<barrido>", id)` deja su `AwaitingSince` en el futuro. Con el umbral local en segundos y el
cron en minutos, sin él ese cobro también estaría rancio cuando llegue el ciclo:

```go
s.AgeForReconciliation("sweepPendingPayments", stuck)    // el que el barrido tiene que rescatar
s.HoldFromReconciliation("sweepPendingPayments", fresh)  // el que tiene que dejar en paz
s.Eventually(func() bool { return len(s.GatewayRequests(CallStatus)) >= 1 }, 6*time.Minute, "el barrido no preguntó")
```

## Lo que el arnés no programa solo

La pasarela de prueba **no tiene respuesta por defecto**: lo que un escenario no programa, el WireMock lo contesta con un
404, que el adaptador lee como un cobro `FAILED` (o como `NOT_FOUND` si es una consulta). Cada Given programa la
respuesta de su referencia; «un token válido de la pasarela de prueba» en un escenario es `s.GatewayAuthorizes` (o
`s.GatewayCharges`) sobre esa referencia.
