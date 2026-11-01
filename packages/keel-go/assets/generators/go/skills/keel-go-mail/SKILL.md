---
name: keel-go-mail
description: Guía del correo saliente en un proyecto generado por keel-go — qué genera build (el mensaje que se sanea al construirse, el adaptador SMTP sobre go-mail que dice el envío parcial, el renderizador Handlebars con la tabla cerrada de escapes, la guarda contra el doble envío), qué le toca al agente (componer el mensaje y llamar a Send desde el handler de mail.sentBy, en el orden de la guarda) y los fallos típicos. Usar cuando el diseño declara la capa mail.
---

# Correo saliente (SMTP + plantillas Handlebars)

Build genera **también** el adaptador y el renderizador, con la cabecera de código generado: lo que llevan dentro son
dos defensas cuya ausencia no rompe ninguna prueba.

- `internal/domain/mail.go`: `domain.NewMailMessage(domain.MailParts{...})` sanea el asunto y el valor de las cabeceras
  (un salto de línea abriría otra cabecera SMTP) y rechaza el nombre de una cabecera reservada; `*domain.MailDeliveryError`
  con `Accepted`, `Rejected`, `Detail` y `Partial()`; los puertos `domain.MailSender` y `domain.TemplateRenderer`.
- `internal/infrastructure/smtp`: `Sender` (SMTP destinatario a destinatario: un rechazado se apunta y el correo sale
  para los demás) y `Renderer` (Handlebars; en la parte HTML las variables se escapan con la tabla cerrada
  `& < > " '` → `&amp; &lt; &gt; &quot; &#39;`, en el asunto y el texto no; una variable que se llama como una palabra del
  motor —`if`, `each`, `this`— es una variable).
- `config/parameters/<perfil>/mail.yaml`: las variables `MAIL_*` de keel-spring.
- La guarda contra el doble envío: `ClaimFor<Operación>(ctx, id)` en el puerto de la raíz, con transacción PROPIA.

**El agente no escribe el adaptador ni el renderizador.** Lo suyo es el handler de la operación de `mail.sentBy`.

## El handler que manda correo

```go
claimed, found, err := h.notificationRepository.ClaimForSendAcceptedNotification(ctx, cmd.NotificationID)
if err != nil {
	return err
}
if !found {
	return nil // otra ejecución llegó antes: la carrera perdida, NO se envía
}
subject, err := h.templateRenderer.Render(domain.TemplateSubject, cacheKey, template.Subject(), variables)
// … lo mismo con domain.TemplateText y domain.TemplateHTML
message, err := domain.NewMailMessage(domain.MailParts{To: []string{to}, Subject: subject, HTML: &html, Text: &text, From: from})
if err != nil {
	return err
}
err = h.mailSender.Send(ctx, message)
var delivery *domain.MailDeliveryError
if errors.As(err, &delivery) && delivery.Partial() {
	// SALIÓ para alguien: no es «no salió»
}
```

- **La guarda primero, y confirmada.** Un correo que sale no lo deshace ningún rollback. La transición a «enviando» hecha
  solo en memoria no existe para nadie hasta el commit final, que llega DESPUÉS del envío: si el proceso cae en medio,
  el siguiente ciclo manda un SEGUNDO correo a una persona real. `ClaimFor…` confirma en su propia transacción.
- **`cacheKey` con la versión de la plantilla dentro** (`clave:versión`): dos contenidos con la misma clave servirían el
  viejo para siempre.
- `infra/check-idempotency.sh` (familia `mailDelivery`) comprueba que el handler llame a `h.mailSender.Send(` y a la guarda.

Los escenarios del buzón: `references/flows.md`. Los fallos típicos: `references/troubleshooting.md`.
