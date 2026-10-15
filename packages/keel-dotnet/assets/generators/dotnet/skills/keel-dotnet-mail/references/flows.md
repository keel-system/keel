# Flujos que afirman sobre el correo

Los helpers del buzón son de `FlowTest` (`tests/<Raíz>.IntegrationTests/Support/Mail.cs`): un flujo los llama
como a `Post` o `Get`, sin importar nada. Hablan con el Mailpit de `infra/`, igual que los arneses de keel-spring y
keel-nest.

| Helper | Para qué |
|---|---|
| `AwaitMailTo(address, count)` | **Empieza por aquí cualquier Then sobre correo.** Espera hasta `MailHarness.AwaitSeconds` a que haya `count` correos y devuelve sus ids. La operación responde aceptando el encargo; el correo sale después. |
| `LastMailTo(address)` | El más reciente, completo (asunto, partes, remitente), como `JsonElement`. |
| `MailSubject(m)`, `MailHtml(m)`, `MailText(m)`, `MailFrom(m)` | Las partes de un mensaje. Afirma sobre las DOS partes si el servicio envía las dos. |
| `MailCount(address)` | Cuántos hay AHORA, sin esperar. Solo después de un `AwaitMailTo`: contar antes mide el estado de antes. |
| `AssertNoMailTo(address)` | Que NO salió. Espera el mismo techo a propósito: sin él, «no ha llegado» y «todavía no ha llegado» son lo mismo. |
| `RelayRejectsRecipients()` / `RelayAccepts()` | El relay rechaza a TODOS con un 550 (el envío que acaba fallido), hasta que se le diga o hasta el siguiente reset. |
| `RejectedAddress(localPart)` | Una dirección que el relay rechaza ella sola (`@rejected.invalid`): el rechazo SELECTIVO. El correo de los demás la sigue NOMBRANDO en `To`: que no le llegó se afirma por el desenlace del envío, no con `AssertNoMailTo`. |

```csharp
[Scenario("FL-DSP-001-A: el correo sale con su asunto y sus dos partes")]
public async Task ElCorreoSaleConSuAsuntoYSusDosPartes()
{
    var accepted = await Post($"{RouteBase}/notifications", body, headers);
    Assert.Equal(202, accepted.Status);
    var message = await LastMailTo("ana@ejemplo.com");
    Assert.Equal("Bienvenida, Ana", MailSubject(message));
    Assert.Contains("O&#39;Hara", MailHtml(message));
    Assert.Contains("O'Hara", MailText(message));
}
```

- El reset de cada flujo vacía el buzón y quita el rechazo: no limpies a mano.
- Si el correo lo empuja un barrido, `MailHarness.AwaitSeconds` ya sale de su periodo; no lo acortes.
- El humo (`SMOKE-7`) comprueba que el buzón responde y arranca vacío.
