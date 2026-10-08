---
name: keel-nest-mail
description: Guía del correo saliente (capa mail) en un proyecto generado por keel-nest — qué generó build y qué te toca a ti, cómo se compone un mensaje, la guarda contra el doble envío y las dos defensas que no puedes quitar. Usar cuando el diseño declara la capa mail.
---

# Correo saliente (capa `mail`)

**Lee esto antes de escribir la primera línea de un handler que manda correo.** El reparto aquí no es el
habitual del generador: build genera **más** de lo que sueles esperar —también el adaptador SMTP y el
renderizador—, y lo que te queda es más pequeño y más de negocio. Es el mismo servidor que el de keel-spring
del diseño: mismas variables de entorno, mismo escapado, misma guarda.

## Antes de empezar

- Aplica solo si el diseño declara la capa `mail` (mira `specs/mail.keel.yaml`, entero: es corto y cada campo
  cambia el código).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: `src/application`
  no importa Nest ni nodemailer; usa los puertos.

## Qué dejó listo build — y qué NO vas a escribir

| Pieza (build) | Dónde |
|---|---|
| El mensaje (value object de dominio) | `src/domain/mail/mail-message.ts` — `MailMessage`, que **sanea el asunto y las cabeceras** al construirse |
| El fallo de entrega | `src/domain/mail/mail-delivery-exception.ts` — `MailDeliveryException` con `accepted`, `rejected`, `detail` y `partial()` |
| El puerto de salida | `src/application/port/out/mail-sender.ts` — `MailSender.send(message)` |
| **El adaptador SMTP completo** | `src/infrastructure/mail/smtp-mail-sender.ts` (nodemailer: remitente de respaldo, Reply-To, timeouts, envío parcial) |
| El puerto y el adaptador de renderizado | `src/application/port/out/template-renderer.ts` (`TemplateRenderer`, `TemplatePart`) y `src/infrastructure/mail/handlebars-template-renderer.ts` |
| Configuración | `config/parameters/<perfil>/mail.yaml` y `src/infrastructure/mail/mail-settings.ts` (las variables `MAIL_*` de keel-spring) |
| Módulo | `src/infrastructure/mail/mail-module.ts` — global: los handlers inyectan los puertos sin importarlo |
| La guarda del doble envío | `claimFor<Operación>(id)` en el puerto `<Raíz>Repository` y su adaptador, cuando el diseño declara el estado en vuelo |
| Mailpit en `infra/`, su sondeo y su purga | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El arnés del buzón | `test/integration/support/mail.ts`, reexportado por `flow.ts` |

> **No escribas otro adaptador de correo, no toques el que hay, y no cambies el motor de plantillas.** Las dos
> cosas que ese código hace y que nadie recuerda hacer están en `references/security.md`, y quitarlas no rompe
> ninguna prueba: el correo sale igual, y sale mal.

## Lo que sí te toca

Componer el `MailMessage` dentro del handler de las operaciones que `mail.sentBy` declara —build ya les inyectó
`MailSender` (y `TemplateRenderer` si hay plantillas)— y llamar a `this.mailSender.send(...)`. Qué plantilla se
elige, con qué variables, qué pasa si falta una y cuándo sale el correo respecto a la transacción es lógica de
negocio, y por eso es tuya.

```ts
const subject = this.templateRenderer.render(TemplatePart.SUBJECT, cacheKey, template.subject, variables);
const html = this.templateRenderer.render(TemplatePart.HTML, cacheKey, template.bodyHtml, variables);
const text = this.templateRenderer.render(TemplatePart.TEXT, cacheKey, template.bodyText, variables);
await this.mailSender.send(
  new MailMessage({ from: sender, to: [recipient], subject, html, text, headers: { 'X-Notification-Id': id } })
);
```

- **Las cabeceras propias** van en `headers`. El constructor las sanea y **rechaza** las que el mensaje ya
  compone (`From`, `To`, `Bcc`, `Subject`, `Content-*`…): no las añadas en el adaptador.
- **Un fallo puede ser PARCIAL.** Si el relay rechaza a un destinatario y acepta a otro, el correo sale para los
  aceptados y `send` lanza igualmente `MailDeliveryException`. Decide con lo que trae: `partial()` (¿salió para
  alguno?), `accepted`, `rejected` y `detail`. Tratarla siempre como «no salió» da por fallido un correo que llegó.
- **La parte (`TemplatePart`) decide el escapado**: HTML escapa las variables, TEXT y SUBJECT no. No la metas en
  la clave ni deshagas el escapado a mano.
- **La operación que DA DE ALTA una plantilla** la valida con `this.templateRenderer.compile(source)` por cada
  parte —sin cachear— y traduce `TemplateRenderException` al error que declare el diseño. Esa operación no envía
  correo y build no sabe que es la de alta: añade tú `TemplateRenderer` a su `static readonly inject` y a su
  constructor.
- **`cacheKey` identifica contenido, no plantilla**: si el diseño versiona las plantillas, la versión va en la
  clave, o la caché serviría la vieja para siempre.
- **El remitente** sale de donde diga `mail.sender.source`. Con `data`, de un dato del servicio; el respaldo lo
  aplica el adaptador, no tú.

## Lo que más cuesta arreglar después: la guarda del doble envío

Un correo que sale **no lo deshace ningún rollback**. Cuando quien envía es un barrido (la operación de `sentBy`
es `internal` y la despacha el reloj por cada elemento de su tanda) y el diseño declara el estado EN VUELO
—`queued → sending → sent|failed` en la misma operación—, el handler **empieza por** `claimFor<Operación>(id)`:
pasa el agregado al estado en vuelo en una escritura condicional **con su propia transacción** y devuelve
`null` si otra ejecución llegó antes (la carrera perdida: tradúcela al error que el diseño declara para «ya no
está disponible»). Hacer esa transición en memoria no sirve: el handler corre dentro de la transacción del
mediator, la marca no existe para nadie hasta el commit final —que llega DESPUÉS del envío—, y si el proceso
cae en medio el ciclo siguiente manda **un segundo correo a una persona real**.

Ningún escenario `FL-*` lo puede ver fallar. Lo comprueba el gate `mailDelivery` de `infra/check-idempotency.sh`
(el envío y el reclamo), que corre el pase de calidad. Y el argumento del pool sigue en pie: para despachar una
operación que hace I/O externo sin la transacción del llamante, `CommandDispatcher` tiene
`dispatchWithoutTransaction(...)`.

## Qué NO cubre Mailpit

- **Rebotes y quejas.** Mailpit rechaza en el `RCPT TO` cuando el arnés se lo pide (`relayRejectsRecipients()`,
  o una dirección de `rejectedAddress(...)`), pero un rebote DESPUÉS de aceptar no existe.
- **Entregabilidad.** SPF, DKIM, DMARC y la reputación del remitente son trabajo de DNS y de proveedor.
- **Los límites del proveedor.** Tamaño máximo (los adjuntos viajan en base64, que infla un 33 %) y envíos por
  segundo: Mailpit lo acepta todo.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | **Antes de tocar el adaptador SMTP o el renderizador.** Las dos defensas y por qué el motor es el que es. |
| `references/flows.md` | Al escribir los flujos que afirman sobre el correo (el arnés del buzón). |
| `references/troubleshooting.md` | Cuando un escenario de correo falla y no sabes de qué lado está el fallo, o al pasar a un proveedor real. |
