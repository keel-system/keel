---
name: keel-spring-mail
description: Guía del correo saliente (capa mail) en un proyecto generado por keel-spring — qué generó build y qué te toca a ti, cómo se compone un mensaje, y las dos defensas que no puedes quitar. Usar cuando el diseño declara la capa mail.
---

# Correo saliente (capa `mail`)

**Lee esto antes de escribir la primera línea de un handler que manda correo.** El
reparto aquí no es el habitual del generador: build genera **más** de lo que sueles
esperar, y lo que te queda es más pequeño y más de negocio.

## Antes de empezar

- Aplica solo si el diseño declara la capa `mail` (mira `specs/mail.keel.yaml`).
- Lee ese artefacto entero: es corto y cada campo cambia el código.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.

## Qué dejó listo build — y qué NO vas a escribir

| Ya está | Dónde |
|---|---|
| Dependencias (`spring-boot-starter-mail`, Handlebars) | `build.gradle` |
| Configuración SMTP por perfil, con timeouts | `parameters/<perfil>/mail.yaml` |
| Mailpit en la infraestructura de prueba, con su sondeo y su purga | `infra/` |
| El value object del mensaje | `domain/mail/MailMessage` |
| El puerto de salida | `application/port/out/MailSender` |
| **El adaptador SMTP completo** | `infrastructure/mail/SmtpMailSender` |
| El puerto y el adaptador de renderizado | `TemplateRenderer`, `infrastructure/mail/HandlebarsTemplateRenderer` |

> **No escribas otro adaptador de correo, no toques el que hay, y no cambies el
> motor de plantillas.** No es una regla de estilo: las dos cosas que ese código
> hace y que nadie recuerda hacer están explicadas en `references/security.md`, y
> quitarlas no rompe ninguna prueba — el correo sale igual, y sale mal.

## Lo que sí te toca

Componer el `MailMessage` dentro del handler de las operaciones que
`mail.sentBy` declara, y llamar a `mailSender.send(...)`. Eso es lógica de negocio
y por eso es tuya: qué plantilla se elige, con qué variables se rellena, qué pasa
si falta una, y cuándo exactamente sale el correo respecto a la transacción.

```java
String subject = templateRenderer.render(cacheKey, template.subject(), variables);
String html = templateRenderer.render(cacheKey + ":html", template.bodyHtml(), variables);
String text = templateRenderer.render(cacheKey + ":text", template.bodyText(), variables);
mailSender.send(new MailMessage(sender, null, List.of(recipient), subject, html, text));
```

Tres decisiones que el diseño ya tomó y que tienes que respetar:

1. **`cacheKey` identifica contenido, no plantilla.** Dos contenidos distintos no
   pueden compartir clave: la caché serviría el viejo para siempre. Si el diseño
   versiona las plantillas, la versión va en la clave.
2. **El remitente sale de donde diga `mail.sender.source`.** Con `data`, de un dato
   del servicio; el respaldo lo aplica el adaptador, tú no.
3. **Dónde va el `send` respecto a la transacción.** Ver abajo.

## Lo que más cuesta arreglar después: dónde sale el correo

Un correo que sale **no lo deshace ningún rollback**. Si el `send` va dentro de la
transacción y algo falla después, el destinatario ya lo ha recibido y la fila no
existe. Si va fuera y el proceso muere en medio, la fila existe y el correo no salió
nunca.

Mira qué dice el diseño antes de elegir:

- Si la operación responde **aceptando el encargo** (un `202`, o cualquier salida
  que no prometa que el correo ya salió), el envío va **después** de confirmar la
  transacción, y el estado de la entidad es lo que registra el desenlace. Es lo que
  impide que la disponibilidad del proveedor entre en la transacción de quien llama.
- Si la operación promete el correo en su respuesta, no hay salida buena: díselo al
  orquestador como `designGap` en vez de elegir por tu cuenta.

Y en cualquiera de los dos casos: la operación tiene su guarda de repetición
(`idempotency` o una transición) porque **un reintento manda un segundo correo**.
Respétala; no la sustituyas por una comprobación previa, que no cierra la ventana
entre dos peticiones simultáneas.

## Qué NO cubre Mailpit

Tres cosas que solo se prueban contra un proveedor real, y conviene no descubrirlas
tarde:

- **Rebotes y quejas.** Mailpit no rebota nada. Si el diseño tiene lista de
  supresión alimentada por un webhook del proveedor, ese camino se ejercita
  invocando el endpoint con un payload de ejemplo, nunca provocando un rebote.
- **Entregabilidad.** Que el correo salga no es que llegue a la bandeja de entrada.
  SPF, DKIM, DMARC y la reputación del remitente son trabajo de DNS y de proveedor.
- **Los límites del proveedor.** Tamaño máximo del mensaje (10–25 MB según cuál, y
  los adjuntos viajan en base64, que infla un 33 %) y envíos por segundo. Mailpit lo
  acepta todo.

## Validación

Desde devtools: `curl -sf http://mailpit:8025/api/v1/info`. Desde el host, la
interfaz está en `http://localhost:8025` y la API bajo `/api/v1` — es la misma que
usa el arnés (`awaitMailTo`, `lastMailTo`, `mailSubject`…), así que lo que veas ahí a
mano es exactamente lo que puede afirmar un escenario.

`bash infra/reset-db.sh` vacía el buzón junto al resto del estado. Recetas completas
en `{{keel:docs}}/conventions/infra-validation.md`.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | **Antes de tocar `SmtpMailSender` o el renderizador.** Las dos defensas y por qué el motor es el que es. |
| `references/configuration.md` | Al pasar de local a un proveedor real, o al depurar la conexión SMTP. |
| `references/troubleshooting.md` | Cuando un escenario de correo falla y no sabes de qué lado está el fallo. |
