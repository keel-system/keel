# Flujos que afirman sobre el correo

Los helpers del buzón viven en `test/integration/support/mail.ts` y se importan **de `flow.ts`** (regla
`flujos-caja-negra`): hablan con el Mailpit de `infra/`, igual que el `AbstractFlowIT` de keel-spring.

| Helper | Para qué |
|---|---|
| `awaitMailTo(address, count)` | **Empieza por aquí cualquier Then sobre correo.** Espera hasta `MAIL_AWAIT_SECONDS` a que haya `count` correos y devuelve sus ids. La operación responde aceptando el encargo; el correo sale después. |
| `lastMailTo(address)` | El más reciente, completo (asunto, partes, remitente). |
| `mailSubject(m)`, `mailHtml(m)`, `mailText(m)`, `mailFrom(m)` | Las partes de un mensaje. Afirma sobre las DOS partes si el servicio envía las dos. |
| `mailCount(address)` | Cuántos hay AHORA, sin esperar. Solo después de un `awaitMailTo`: contar antes mide el estado de antes. |
| `assertNoMailTo(address)` | Que NO salió. Espera el mismo techo a propósito: sin él, «no ha llegado» y «todavía no ha llegado» son lo mismo. |
| `relayRejectsRecipients()` / `relayAccepts()` | El relay rechaza a TODOS con un 550 (el envío que acaba fallido), hasta que se le diga o hasta el siguiente reset. |
| `rejectedAddress(localPart)` | Una dirección que el relay rechaza ella sola (`@rejected.invalid`): el rechazo SELECTIVO. El correo de los demás la sigue NOMBRANDO en `To`: que no le llegó se afirma por el desenlace del envío, no con `assertNoMailTo`. |

```ts
it('FL-DSP-001-A: el correo sale con su asunto y sus dos partes', async () => {
  const accepted = await flow.post(`${ROUTE_BASE}/notifications`, body, headers);
  expect(accepted.status, accepted.body).toBe(202);
  const message = await lastMailTo('ana@ejemplo.com');
  expect(mailSubject(message)).toBe('Bienvenida, Ana');
  expect(mailHtml(message)).toContain('O&#39;Hara');
  expect(mailText(message)).toContain("O'Hara");
});
```

- El reset de cada flujo (`resetState()`) vacía el buzón y quita el rechazo: no limpies a mano.
- Si el correo lo empuja un barrido, `MAIL_AWAIT_SECONDS` ya sale de su periodo; no lo acortes.
- El humo (`SMOKE-7`) comprueba que el buzón responde y arranca vacío.
