# Cuando un escenario de correo falla

| Síntoma | De qué lado suele estar |
|---|---|
| `awaitMailTo` agota la espera y el buzón está vacío | El handler no llama a `this.mailSender.send(...)` (lo vigila el gate `mailDelivery`), el barrido que lo despacha no ha corrido aún, o el envío lanzó y el handler se lo tragó. Mira el log: `Correo entregado al proveedor` sale en cada envío aceptado. |
| `No se pudo hablar con el buzón de prueba` | Mailpit no está arriba: `bash infra/validate-infra.sh`. |
| El correo sale DOS veces | La guarda en memoria: el handler hace la transición sin `claimFor<Operación>(id)`. Ver `SKILL.md` § la guarda. |
| El cuerpo HTML trae `&#x27;` en vez de `&#39;` | Alguien reemplazó el renderizador o lo compila con otro entorno. El escapado es contrato. |
| Una variable sale vacía o el correo trae el mapa entero | El marcador no pasa por `literalMarkers` (se compiló la fuente a mano). Usa `TemplateRenderer`. |
| `MailDeliveryException` con `partial()` verdadero | El correo SALIÓ para `accepted`; trata el desenlace del envío con lo que trae, no como «no salió». |
| `El mensaje no tiene remitente…` | Con `sender.source: data` el dato no resolvió y el diseño no declara respaldo: es la decisión del diseño, no un fallo del adaptador. |

## Pasar a un proveedor real

Solo cambian variables de entorno (las mismas que el servidor de keel-spring del diseño): `MAIL_HOST`,
`MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_SMTP_AUTH`, `MAIL_SMTP_STARTTLS` y los tres plazos
`MAIL_CONNECT_TIMEOUT_MS`, `MAIL_READ_TIMEOUT_MS`, `MAIL_WRITE_TIMEOUT_MS`. En `production` las que no tienen
default son obligatorias: el servicio no arranca sin ellas, que es mejor que arrancar contra el relay equivocado.
Con STARTTLS el adaptador lo EXIGE (`requireTLS`): un relay que no lo ofrezca falla la conexión en vez de mandar
en claro.
