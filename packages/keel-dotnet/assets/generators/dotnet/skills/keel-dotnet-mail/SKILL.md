---
name: keel-dotnet-mail
description: Guía del correo saliente (capa mail) en un proyecto generado por keel-dotnet — qué generó build y qué te toca a ti, cómo se compone un mensaje, la guarda contra el doble envío y las dos defensas que no puedes quitar. Usar cuando el diseño declara la capa mail.
---

# Correo saliente (capa `mail`)

**Lee esto antes de escribir la primera línea de un handler que manda correo.** El reparto aquí no es el
habitual del generador: build genera **más** de lo que sueles esperar —también el adaptador SMTP y el
renderizador—, y lo que te queda es más pequeño y más de negocio. Es el mismo servidor que el de keel-spring y
keel-nest del diseño: mismas variables de entorno, mismo escapado, misma guarda.

## Antes de empezar

- Aplica solo si el diseño declara la capa `mail` (mira `specs/mail.keel.yaml`, entero: es corto y cada campo
  cambia el código).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el proyecto
  Application no conoce MailKit ni Handlebars (el compilador lo impide: no los referencia); usa los puertos.

## Qué dejó listo build — y qué NO vas a escribir

`<Raíz>` es el nombre de la solución (`NotificationMailer`, por ejemplo).

| Pieza (build) | Dónde |
|---|---|
| El mensaje (value object de dominio) | `src/<Raíz>.Domain/Mail/MailMessage.cs` — `MailMessage`, que **sanea el asunto y las cabeceras** al construirse |
| El fallo de entrega | `src/<Raíz>.Domain/Mail/MailDeliveryException.cs` — con `Accepted`, `Rejected`, `Detail` y `Partial()` |
| El puerto de salida | `src/<Raíz>.Application/Ports/IMailSender.cs` — `Send(message, cancellationToken)` |
| **El adaptador SMTP completo** | `src/<Raíz>.Infrastructure/Mail/SmtpMailSender.cs` (MailKit: remitente de respaldo, Reply-To, plazos, envío parcial) |
| El puerto y el adaptador de renderizado | `src/<Raíz>.Application/Ports/ITemplateRenderer.cs` (`ITemplateRenderer`, `TemplatePart`) y `src/<Raíz>.Infrastructure/Mail/HandlebarsTemplateRenderer.cs` |
| Configuración | `config/parameters/<perfil>/mail.yaml` y `Infrastructure/Mail/MailSettings.cs` (las variables `MAIL_*` de keel-spring) |
| Registro | `Infrastructure/Mail/MailRegistration.cs` (`AddMail`, llamado desde `Program.cs`) |
| La guarda del doble envío | `ClaimFor<Operación>(id)` en el puerto `I<Raíz del agregado>Repository` y su adaptador, cuando el diseño declara el estado en vuelo |
| Mailpit en `infra/`, su sondeo y su purga | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El arnés del buzón | `tests/<Raíz>.IntegrationTests/Support/Mail.cs`, parte de `FlowTest` |

> **No escribas otro adaptador de correo, no toques el que hay, y no cambies el motor de plantillas.** Las dos
> cosas que ese código hace y que nadie recuerda hacer están en `references/security.md`, y quitarlas no rompe
> ninguna prueba: el correo sale igual, y sale mal.

## Lo que sí te toca

Componer el `MailMessage` dentro del handler de las operaciones que `mail.sentBy` declara —build ya les inyectó
`IMailSender` (y `ITemplateRenderer` si hay plantillas) en el constructor— y llamar a `mailSender.Send(...)`. Qué
plantilla se elige, con qué variables, qué pasa si falta una y cuándo sale el correo respecto a la transacción es
lógica de negocio, y por eso es tuya.

```csharp
var subject = templateRenderer.Render(TemplatePart.Subject, cacheKey, template.Subject, variables);
var html = templateRenderer.Render(TemplatePart.Html, cacheKey, template.BodyHtml, variables);
var text = templateRenderer.Render(TemplatePart.Text, cacheKey, template.BodyText, variables);
await mailSender.Send(
    new MailMessage([recipient], subject, html, text, from: sender, headers: new Dictionary<string, string?> { ["X-Notification-Id"] = id.ToString() }),
    cancellationToken);
```

- **Las cabeceras propias** van en `headers`. El constructor las sanea y **rechaza** las que el mensaje ya
  compone (`From`, `To`, `Bcc`, `Subject`, `Content-*`…): no las añadas en el adaptador.
- **Un fallo puede ser PARCIAL.** Si el relay rechaza a un destinatario y acepta a otro, el correo sale para los
  aceptados y `Send` lanza igualmente `MailDeliveryException`. Decide con lo que trae: `Partial()` (¿salió para
  alguno?), `Accepted`, `Rejected` y `Detail`. Tratarla siempre como «no salió» da por fallido un correo que llegó.
- **La parte (`TemplatePart`) decide el escapado**: `Html` escapa las variables, `Text` y `Subject` no. No la
  metas en la clave ni deshagas el escapado a mano.
- **Las variables** son un `IReadOnlyDictionary<string, object?>` con las claves TAL CUAL las nombra la plantilla
  (sin cambiar mayúsculas: `{{ firstName }}` busca `firstName`).
- **La operación que DA DE ALTA una plantilla** la valida con `templateRenderer.Compile(source)` por cada parte
  —sin cachear— y traduce `TemplateRenderException` al error que declare el diseño. Esa operación no envía correo
  y build no sabe que es la de alta: añade tú `ITemplateRenderer` a su constructor (está registrado en el
  contenedor).
- **`cacheKey` identifica contenido, no plantilla**: si el diseño versiona las plantillas, la versión va en la
  clave, o la caché serviría la vieja para siempre.
- **El remitente** sale de donde diga `mail.sender.source`. Con `data`, de un dato del servicio (`from:`); el
  respaldo lo aplica el adaptador, no tú.

## Lo que más cuesta arreglar después: la guarda del doble envío

Un correo que sale **no lo deshace ningún rollback**. Cuando quien envía es un barrido (la operación de `sentBy`
es `internal` y la despacha el reloj por cada elemento de su tanda) y el diseño declara el estado EN VUELO
—`queued → sending → sent|failed` en la misma operación—, el handler **empieza por** `ClaimFor<Operación>(id)`:
pasa el agregado al estado en vuelo en una escritura condicional **con su propia transacción** y devuelve `null`
si otra ejecución llegó antes (la carrera perdida: no envíes, y termina como digan las reglas). Hacer esa
transición en memoria no sirve: el handler corre dentro de la transacción del mediator, la marca no existe para
nadie hasta el commit final —que llega DESPUÉS del envío—, y si el proceso cae en medio el ciclo siguiente manda
**un segundo correo a una persona real**.

Lo que devuelve `ClaimFor…` es el agregado YA en el estado en vuelo: sobre él aplicas después el método de negocio
que lo lleva a `sent` o `failed` y lo guardas con `Save` como cualquier otro cambio.

Ningún escenario `FL-*` lo puede ver fallar. Lo comprueba el gate `mailDelivery` de `infra/check-idempotency.sh`
(el envío y el reclamo), que corre el pase de calidad. Y si el envío lo despacha otro caso de uso, el puerto
`ICommandDispatcher` tiene `DispatchWithoutTransaction(...)`: una operación que hace I/O externo no tiene por qué
retener una transacción abierta del llamante.

## Qué NO cubre Mailpit

- **Rebotes y quejas.** Mailpit rechaza en el `RCPT TO` cuando el arnés se lo pide (`RelayRejectsRecipients()`,
  o una dirección de `RejectedAddress(...)`), pero un rebote DESPUÉS de aceptar no existe.
- **Entregabilidad.** SPF, DKIM, DMARC y la reputación del remitente son trabajo de DNS y de proveedor.
- **Los límites del proveedor.** Tamaño máximo (los adjuntos viajan en base64, que infla un 33 %) y envíos por
  segundo: Mailpit lo acepta todo.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | **Antes de tocar el adaptador SMTP o el renderizador.** Las dos defensas y por qué el motor es el que es. |
| `references/flows.md` | Al escribir los flujos que afirman sobre el correo (el arnés del buzón). |
| `references/troubleshooting.md` | Cuando un escenario de correo falla y no sabes de qué lado está el fallo, o al pasar a un proveedor real. |
