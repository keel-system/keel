# El buzón desde una prueba de flujo

El correo de los flujos llega al Mailpit de `infra/` (SMTP en el 1025, API en el 8025). El escenario lo afirma con los
ayudantes del arnés (`tests/integration/mail_test.go`), los mismos que los otros tres servidores:

| Ayudante | Qué hace |
|---|---|
| `s.AwaitMailTo(address, n)` | espera a que haya `n` correos para `address` y devuelve sus ids |
| `s.LastMailTo(address)` | el último correo para `address`, entero (`.Subject()`, `.HTML()`, `.Text()`, `.From()`) |
| `s.MailCount(address)` | cuántos hay, sin esperar |
| `s.AssertNoMailTo(address)` | espera el techo entero y falla si salió alguno |
| `s.RelayRejectsRecipients()` / `s.RelayAccepts()` | el relay rechaza a todos los destinatarios, y vuelve a aceptar |
| `RejectedAddress(localPart)` | una dirección que el relay rechaza SIEMPRE: el envío parcial |

- El reset de cada flujo vacía el buzón (`infra/reset-db.sh`): el SMOKE-7 lo comprueba.
- Un correo que lo empuja un barrido llega con la cadencia de su `schedule`: el techo de la espera ya la cuenta.
- El HTML del buzón lleva la tabla cerrada del contrato (`O&#39;Hara`), y el asunto y el texto, el valor tal cual.
