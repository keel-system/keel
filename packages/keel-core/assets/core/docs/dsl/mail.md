# Capa `mail` — el correo que el servicio emite (opcional)

Archivo: `specs/<servicio>/mail.keel.yaml` · Schema: [`schema/mail.schema.json`](../../schema/mail.schema.json)

Que este servicio **manda correo electrónico**, con qué forma sale y de dónde salen el remitente y el cuerpo. Agnóstica del proveedor: Mailpit en local y SES, Brevo o cualquier relay en producción se deciden al desplegar, nunca aquí. Un servicio que no manda correo no declara esta capa.

```yaml
description: Correo transaccional que este servicio emite en nombre de sus aplicaciones consumidoras.

delivery:
  transport: smtp
  parts: [html, text]          # las dos ⇒ multipart/alternative

sentBy:
  - requestNotification        # las operaciones que mandan correo

sender:
  source: data                 # sale de un dato del servicio (el remitente verificado de cada aplicación)
  fallback: no-reply@tutienda.com

replyTo:
  source: fixed
  address: soporte@tutienda.com

templating:
  source: data                 # el cuerpo es dato del servicio, no un recurso del repositorio
  declaredVariables: true      # cada plantilla declara sus variables y el envío se valida antes de renderizar
```

## Por qué es una capa y no una dependencia

Hay tres formas de que algo salga de un servicio, y confundirlas declara acoplamientos que no existen:

| Capa | Qué hay al otro lado |
|---|---|
| `http-clients` | Un proveedor que publica contrato y al que se le llama por HTTP. |
| `dependencies` | Otro **servidor** del que este depende: se le lee un dato o se le encarga trabajo. Aquí es donde va «llamo al servicio de notificación». |
| `mail` | Un relay SMTP. No publica contrato, no es un servicio Keel y no se le encarga trabajo: es la **salida propia** de este servicio. |

Si tu servicio *pide* correos a otro, eso es una `activation` de `dependencies` y esta capa no aplica. Esta capa la declara el servicio que **manda el correo de verdad**.

## `sentBy`: el enlace con los casos de uso

Obligatorio, y es el único enlace del DSL entre un caso de uso y la salida por correo — mismo papel que `usedBy` en un `need` de `dependencies`. Sin él la capa diría que el servicio manda correo sin decir desde dónde: el generador no sabría en qué handler inyectar el envío, y el camino de menor resistencia sería no mandarlo.

`keel validate` avisa además si una operación de `sentBy` no declara `idempotency` ni ninguna transición: **un correo que sale no lo deshace ninguna transacción**. Si esa operación se repite —y con varios sistemas reintentando, o con un consumidor de eventos que es *at-least-once* por definición, se repite— el destinatario recibe el mensaje dos veces.

## `sender` y `replyTo`

Las dos tienen la misma forma y las dos son decisiones de reputación, no de configuración: la dirección tiene que estar **verificada ante el proveedor**.

- `source: fixed` + `address` — una sola dirección para todo el servicio.
- `source: data` — la dirección sale de un dato del servicio (típicamente el remitente registrado de cada aplicación consumidora), y admite `fallback`.

`fallback` es opcional **y no tiene default**, porque las dos opciones son decisiones legítimas y opuestas: declararlo es decir «preferimos enviar desde la genérica antes que no enviar»; omitirlo es decir «antes que enviar desde una dirección que nadie verificó, no enviamos». `keel validate` avisa cuando falta, para que la ausencia sea deliberada y no un olvido.

## `delivery.parts` y la alternativa textual

Con `[html, text]` el mensaje sale como `multipart/alternative` con las dos partes. No es por los clientes de correo de texto —quedan pocos— sino porque **los filtros antispam desconfían de un HTML sin alternativa textual**, y eso no falla en ninguna prueba: se ve en la carpeta de spam de quien lo recibe. De ahí el aviso de `keel validate` cuando se declara `html` sin `text`.

`html` exige `templating`: un cuerpo HTML sin plantilla es HTML compilado dentro del servicio, y eso convierte cada alta de correo en un despliegue.

## `templating.source`: la decisión que más arrastra

| Valor | Dónde está el original | Quién lo cambia |
|---|---|---|
| `data` | En la base de datos del servicio, y en ningún otro sitio | Una persona, por API o back-office, sin desplegar |
| `bundled` | En el repositorio, versionado con el código | Un desarrollador, en un commit |

La diferencia no es de mecanismo: **en los dos casos la plantilla se ejecuta desde la base de datos del servicio**. `data` significa que el contenido lo posee negocio y cambia por razones que no tienen nada que ver con el código, y que quien lo escribe puede ser ajeno al equipo.

De ahí sale una consecuencia que el DSL **no** declara pero que el generador deriva: con `source: data`, el cuerpo es **entrada de origen externo**, así que no puede renderizarse con un motor que evalúe expresiones arbitrarias (Thymeleaf con SpEL sería ejecución remota de código). El motor concreto es mecánica y no va en el diseño; que sea sin lógica arbitraria es doctrina del generador, no una capacidad que el DSL pueda comprobar.

`declaredVariables: true` declara que existe un contrato de variables por plantilla y que el envío se valida contra él antes de renderizar. Es lo que evita el fallo más caro: mandar un correo que dice «Tu pedido por  € está confirmado», que sin la validación se descubre por la reclamación del cliente. Qué entidad declara esas variables es `domain`; cómo se validan, `use-cases`. Aquí solo se declara que ese contrato existe.

## Qué NO va aquí

- El servidor SMTP, el puerto, las credenciales y el proveedor → se deciden al **desplegar** (variables de entorno por ambiente), nunca en el spec.
- Las plantillas, sus variables y su ciclo de vida cuando son dato → capas `domain`, `use-cases` y `persistence`, como cualquier otra entidad del servicio.
- El motor de renderizado y el escapado → mecánica del generador.
- Los errores que expone una operación al no encontrar plantilla o faltar una variable → capa `use-cases` (`errors`).
