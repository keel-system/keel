# Configuración del correo, de local a producción

Todo lo del transporte vive en `parameters/<perfil>/mail.yaml` y sigue el mismo
gradiente que el resto del proyecto: **literal en local, variable obligatoria en
producción**. Cambiar de proveedor es cambiar cuatro variables y reiniciar — mismo
binario, sin recompilar.

## Los cuatro parámetros que importan

| Variable | local | production |
|---|---|---|
| `MAIL_HOST` | `localhost` (Mailpit) | el del proveedor contratado |
| `MAIL_PORT` | `1025` | `587` con STARTTLS en casi todos |
| `MAIL_USERNAME` | vacío | obligatorio |
| `MAIL_PASSWORD` | vacío | obligatorio |

En producción esas variables **no se escriben a mano**: las inyecta un Secret de
Kubernetes, Vault o el gestor de secretos que uses. Pero el consumo sigue siendo por
variable de entorno, así que el patrón no cambia y el binario tampoco.

## Autenticación y cifrado

En `local` y `test` van a `false` los dos: Mailpit no los exige, y pedirlos haría
fallar el envío contra la propia infraestructura de prueba. En `develop` y
`production` van a `true` por defecto, con override por `MAIL_SMTP_AUTH` y
`MAIL_SMTP_STARTTLS` para el proveedor que se salga de lo normal.

## Los timeouts, que no son opcionales

```yaml
connectiontimeout: 5000
timeout: 5000
writetimeout: 5000
```

Los defaults de JavaMail son **sin timeout**: un envío contra un proveedor caído deja
el hilo esperando para siempre. Con virtual threads eso ya no agota el pool, pero
sigue dejando la operación colgada sin desenlace. Están parametrizados
(`MAIL_CONNECT_TIMEOUT_MS`, `MAIL_READ_TIMEOUT_MS`, `MAIL_WRITE_TIMEOUT_MS`) porque
el margen razonable depende del proveedor.

## Lo que sale del DISEÑO, aparte del transporte

Bajo la clave `mail:` (no `spring.mail:`), porque no es configuración del
transporte sino lo que el diseño decidió:

```yaml
mail:
  multipart: true            # de delivery.parts
  attachments: false         # de delivery.attachments
  sender-fallback: …         # de sender.fallback, solo con sender.source: data
  reply-to: …                # de replyTo, solo con source: fixed
```

**No las re-derives ni las hardcodees en el código.** Entran al adaptador por su
constructor, que build ya cableó.

## Mailpit: dónde mirar

- **Interfaz web**: `http://localhost:8025`. Enseña el correo tal cual llegaría, con
  sus cabeceras, sus dos partes y sus adjuntos. Es donde se itera una plantilla.
- **API REST**: la misma base, bajo `/api/v1`. Es lo que consume el arnés de
  integración, y lo que convierte «se envía el correo correcto» en una aserción.
- **Puntuación de spam y enlaces**: la interfaz avisa si el HTML tiene pinta de
  acabar en la carpeta gris y detecta enlaces rotos. No es un gate, pero mirarlo una
  vez ahorra un descubrimiento tardío.

En `deploy/` (las pruebas manuales del diseñador) hay otro Mailpit, con sus puertos
publicados por variable (`MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`) porque el diseñador
casi siempre tiene ya algo escuchando en 8025.
