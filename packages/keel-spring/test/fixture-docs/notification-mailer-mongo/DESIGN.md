# notification-mailer-mongo — Documento de diseño

> specs/notification-mailer-mongo v2.0.1. Diseño cerrado; el porqué de las decisiones se entrevistó al cerrarlo.

## 1. Propósito y alcance

Envía correo transaccional **por cuenta de los sistemas consumidores** de la plataforma, a partir
de plantillas que viven en la base de datos del propio servicio. Un sistema (pedidos, facturación…)
registra sus plantillas versionadas, publica la que debe usarse y pide envíos, por HTTP o por un
canal de eventos genérico. El servicio congela lo que se va a enviar, lo manda por SMTP y anuncia
cada correo que salió.

Queda fuera, a propósito: los rebotes diferidos (el relay acepta y el destino devuelve el correo
horas después), la lista de supresión, los adjuntos aportados por el llamante, la baja de un sistema
y la retención de los envíos. Cada una tiene su motivo en § 7, «Supuestos y limitaciones».

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Application` | raíz propia | Un sistema consumidor autorizado a mandar correo. `key` es su clave de negocio (única); `credentialKeys` son los `client_id` que resuelven a él (hasta 5); `defaultSender` es su remitente verificado. |
| `Template` | raíz | Una **versión** concreta del contenido de un correo, propiedad de una aplicación. `version` se cuenta por aplicación, clave e idioma. |
| `TemplateVariable` | interna de `Template` | Una variable que esa versión declara aceptar, con si es requerida. Solo se crea con su versión. |
| `Notification` | raíz propia | Un envío pedido, con lo enviado **congelado** dentro: versión de plantilla, asunto ya interpolado, destinatarios y variables. |

Value types: `EmailAddress` (una `@` en medio y la cota del estándar, 254; toda dirección del servicio lo es),
`Locale` (dos letras y región opcional: `es`, `es-ES`), `TemplateVariableDeclaration`
(`name`, `required`, `description`: lo que registra quien escribe la plantilla) y
`TemplateVariableValue` (`name`, `value`: lo que manda quien pide el envío).

Campos generados: los `id` y `Notification.requestedAt`. `Notification.status` nace en `accepted`
(su `default`). Estampados por una transición:
`Template.publishedAt` (al pasar a `active`; no cambia al retirarse), `Notification.sendingSince`
(en el reclamo que pasa a `sending`) y `Notification.sentAt` (al pasar a `sent`; nulo en `failed`).

### Ciclos de vida

- **Template**: `draft → active → retired`. `retired` es terminal: una versión retirada no vuelve;
  se publica otra.
- **Notification**: `accepted → queued → sending → sent | failed`. `sending` no es decoración: es
  la **guarda** de un efecto irreversible, confirmada antes de entregar el correo.

## 3. Invariantes y reglas clave

- Como máximo **una versión activa** por aplicación, clave e idioma. Es unicidad condicionada al
  estado (`indexes` con `when: status = active`), no una regla en prosa.
- Publicar una versión retira la activa en el mismo acto y en la misma transacción.
- La aplicación del llamante **no viaja nunca en la petición**: sale de la credencial
  (`callerIdentity`, resuelta contra `credentialKeys`) y, por evento, de `metadata.source`
  resuelto igual.
- Un sistema no ve ni publica lo de otro: una plantilla o un envío ajeno responde **igual que uno
  que no existe** (404).
- Un `client_id` resuelve a **una sola** aplicación (índice único sobre `credentialKeys`): nadie se
  da de alta con la credencial de otro para ver sus datos.
- La `Idempotency-Key` se acota a la aplicación del llamante. Por evento, `dedupeKey` es
  `event:<eventId>`, que no comparte espacio con las claves HTTP. El `eventId` es el de la envoltura
  del mensaje y llega al comando declarado en el diseño, no por convención del listener.
- Toda variable declarada como requerida llega con valor; las no declaradas se ignoran y no se
  congelan, y dos con el mismo nombre se rechazan. Por HTTP y por evento, igual.
- Los valores se escapan como HTML en la parte html; en la de texto van tal cual.
- El asunto se renderiza al aceptar y el cuerpo al enviar, siempre con la versión y los valores
  congelados.
- Una plantilla que no compila no se registra.
- `NotificationSent` se emite solo al pasar a `sent`. Un relay que rechaza, no se alcanza o no
  contesta a tiempo deja el envío en `failed`, sin reintentar: no se sabe si el correo salió.

## 4. Qué hace

### Superficie servidor-a-servidor (todo el API, `defaultAudience: services`)

| Operación | Endpoint | Qué hace | Scope |
|---|---|---|---|
| `registerApplication` | `POST /v1/applications` → 201 | Da de alta un sistema consumidor. | `application:admin` |
| `registerTemplate` | `PUT /v1/templates/{templateKey}/{locale}` → 201 | Registra una versión nueva, en borrador, con sus variables declaradas. | `template:write` |
| `publishTemplate` | `POST /v1/templates/{templateId}/publish` → 200 | Pone una versión delante de los clientes y retira la anterior. | `template:publish` |
| `getTemplate` | `GET /v1/templates/{templateId}` | Devuelve una versión propia. | `template:write` |
| `requestNotification` | `POST /v1/notifications` → 202 | Acepta y registra un envío; responde antes de enviar. Idempotente con `Idempotency-Key` (opcional). | `notification:send` |
| `getNotification` | `GET /v1/notifications/{notificationId}` | El estado de un envío propio, para quien no escucha eventos. | `notification:read` |

Errores de contrato: `APPLICATION_ALREADY_EXISTS` y `CREDENTIAL_ALREADY_ASSIGNED` (409, cada uno
nombrado en la unicidad que lo produce: la clave y las credenciales),
`APPLICATION_INACTIVE` (403),
`TEMPLATE_NOT_FOUND` (404 si lo nombra la ruta, 422 si lo nombra el cuerpo o el mensaje),
`TEMPLATE_ALREADY_ACTIVE` y `CONCURRENT_MODIFICATION` (409, publicaciones simultáneas),
`TEMPLATE_SYNTAX_INVALID` y `TEMPLATE_VARIABLE_DUPLICATED` (422; el segundo también en la petición de
envío), `TEMPLATE_VERSION_ALREADY_EXISTS`
(409, registros simultáneos), `TEMPLATE_VARIABLE_MISSING` (422), `IDEMPOTENCY_KEY_IN_PROGRESS` e
`IDEMPOTENCY_KEY_REUSED` (409) y `NOTIFICATION_NOT_FOUND` (404).

### Internas

- `acceptNotificationRequest` — la dispara `NotificationRequested`. Hace lo mismo que
  `requestNotification`, copias incluidas, deduplicando por `metadata.eventId`.
- `queueAcceptedNotifications` — **cada minuto**: reclama un lote de envíos aceptados y encarga cada
  uno.
- `sendAcceptedNotification` — la invoca el barrido por fila: reclama el envío (`queued → sending`),
  lo compone, lo entrega y lo cierra en `sent` o `failed`.

## 5. Fronteras e integraciones

- **Mensajería.**
  - Publica `NotificationSent` en `notificationEvents`, con outbox, **sin el destinatario**: el canal
    lo leen todos los inquilinos. Lleva `dedupeKey`, con el que cada sistema reconoce su petición.
    Consume
    `NotificationRequested` de `notificationRequests`, un canal **genérico**: el sistema número doce
    entra sin tocar el diseño.
  - La identidad del emisor sale de `metadata.source`, y su asunción está escrita en
    `trustedPublishers`.
  - Lo que el handler no puede atender va a la cola de descarte: a la primera si es un rechazo de
    negocio, tras cinco reintentos exponenciales si es pasajero. El emisor desconocido se descarta
    sin pasar por ella.
- **Correo.**
  - SMTP con partes html y texto.
  - El remitente es el de la aplicación, con `no-reply@ejemplo.com` como respaldo, y la respuesta va
    a `soporte@ejemplo.com`.
  - Las plantillas son dato del servicio, con variables declaradas por plantilla.
- **Persistencia.**
  - Relacional en `notification-mailer`, documental en su gemela `notification-mailer-mongo`, con
    el mismo contrato.
  - Transacción por operación y bloqueo optimista en todas las raíces.
  - Hay índices sobre la unicidad condicionada, sobre `credentialKeys` (se consulta en cada
    petición) y sobre `[status, requestedAt]` (el barrido).
- **Seguridad.**
  - OIDC con clientes máquina (`client-credentials`) y **la audiencia del token validada**, uno por
    sistema y propósito, con mínimo
    privilegio: el que envía no escribe plantillas, el pipeline no envía y ninguno se da de alta a
    sí mismo (`platform-admin`).

## 6. Decisiones de diseño (qué / por qué)

Del registro estructural (`decisions.yaml` → `structural:`):

| § | Decisión | Descartado | Por qué |
|---|---|---|---|
| 3.1 | `reliability: outbox` | `best-effort` | El consumidor marca su propio estado con `NotificationSent`; si se perdiera, podría volver a pedirlo y salir un segundo correo real. |
| 3.2 | `client-key` en `requestNotification`, acotada a la aplicación; por evento, `metadata.eventId`. Los demás commands sin idempotencia | `payload-hash`; idempotencia en `registerTemplate` | Dos cuerpos iguales pueden ser dos intenciones legítimas (dos restablecimientos de contraseña): solo el llamante sabe si reintenta. `registerApplication` y `publishTemplate` ya los frena su clave o su transición, y un `registerTemplate` repetido deja un borrador más, que nadie usa hasta publicarlo. |
| 3.3 | Sin caché | `cache` con TTL | `getNotification` se sondea para ver el envío avanzar; una respuesta vieja mentiría. Las dos son lecturas por clave primaria. |
| 3.4 | Todo `services`, sin operaciones de usuario | `both` | Todos los consumidores son sistemas; una consola humana tendrá sus operaciones. |
| 3.5 | 5 reintentos exponenciales (1 s → 30 s) y `deadLetter` | fallar a la primera, o descartar | Una petición de correo perdida es un cliente sin su correo y un consumidor que cree haberlo pedido. |
| 3.7 | `per-operation` | `per-aggregate` | Retirar la activa y activar la nueva confirman juntas, o hay una ventana sin versión activa. |
| 3.9 | `optimisticLocking: all` | último gana | Dos publicaciones simultáneas no pueden acabar las dos bien, y el barrido y el envío transicionan la misma fila. |
| 3.9b | `timestamps: all`, `authorship: none` | `declared`; autoría | Las marcas que importan al contrato ya son dominio; todos los autores son sistemas, y su atribución ya es `applicationKey`. |

Otras decisiones notables:

- **Registrar no es enviar.** `sendAcceptedNotification` no tiene puerta propia: separar las dos
  cosas es lo que da a la guarda un estado intermedio, y un endpoint expondría un efecto
  irreversible a quien sepa el id. Su límite en caja negra está aceptado en
  `OBL-GUARD-UNOBSERVABLE`: se verifica estáticamente.
- **`TEMPLATE_NOT_FOUND` con dos status.** 404 cuando la URL nombra algo que no hay (o que es de
  otro), 422 cuando lo nombra el cuerpo. Partirlo en dos codes no le daría al integrador un hecho
  nuevo.
- **Un canal genérico de peticiones**, en vez de un evento por caso de negocio: el alta de un
  consumidor no es una edición del diseño.
- **Los 404 del aislamiento.** Decir «existe pero no es tuyo» le contaría a un inquilino qué
  identificadores tiene otro.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

- **Estable**:
  - los códigos de error de § 4;
  - los endpoints y sus status;
  - `NotificationSent` con su payload y los dos canales;
  - el payload de `NotificationRequested`, que es contrato con **todos** los emisores;
  - los scopes;
  - que la aplicación salga de la credencial.
- **Adaptable sin romper a nadie**:
  - la política de reintentos de la suscripción;
  - las cotas internas;
  - el ritmo del barrido;
  - las reglas de renderizado mientras respeten las variables declaradas.
- **Versionado del spec** según `docs/methodology.md`: un campo opcional nuevo es minor; cambiar un
  status o un code es major.

### Puntos de extensión típicos

- `NotificationFailed` en `notificationEvents`, el día que un consumidor necesite enterarse del
  fallo.
- `deactivateApplication`: el campo `active` y su error ya existen.
- Un canal de rebotes (webhook o buzón de retorno) con su lista de supresión.
- Un barrido de `sending` a `failed` pasado un plazo, si los envíos parados dejan de ser raros.
- Reutilizable en otros servicios:
  - el patrón «registrar, reclamar por lote, guardar por fila» para cualquier efecto irreversible;
  - la unicidad condicionada al estado para «una versión activa».

### Supuestos y limitaciones

- **Todos los emisores son sistemas propios** en la misma malla de confianza. Por evento, la
  identidad la escribe el emisor y nada la comprueba (ver `trustedPublishers`). Con un emisor fuera
  del perímetro, la salida es un destino por emisor.
- **Un envío parado no se rescata.** Si una réplica cae con un envío en `queued` o `sending`, ahí se
  queda, visible por `getNotification`. Rescatar `sending` arriesgaría un segundo correo real.
- **Un fallo de envío no se anuncia**: se consulta con `getNotification`.
- **Sin consulta por clave e idioma ni listado de versiones**: el pipeline guarda el `templateId`.
- **Los envíos no se pueden reenviar** ni una publicación deshacer: se pide otro envío, o se publica otra versión.
- **Los envíos se guardan para siempre**, con variables que pueden llevar datos personales. Hace
  falta una operación de purga antes de producción.
- **Sin baja de sistemas, sin lista de supresión y sin adjuntos del llamante** en esta versión. Los
  adjuntos están habilitados en la capa `mail` para que el generador compile esa rama, y ningún
  correo de esta versión los lleva.
- **La cabecera `Location`** de las altas apunta a rutas que ninguna operación sirve (no hay
  `getApplication`, y la de una plantilla no es la ruta de `getTemplate`). La emite el generador.

### Cómo reutilizarlo

`keel describe notification-mailer-mongo` da el resumen mecánico. Si sirve tal cual —correo
transaccional multi-sistema con plantillas como dato—, se **adopta** copiando
`specs/notification-mailer-mongo/` (o `keel registry get` si está publicado) y se va directo a generar.
Se espera que casi siempre se **derive** (`keel new <nuevo> --from notification-mailer-mongo`): lo
habitual es cambiar lo que § 7 marca como supuestos, como la baja de sistemas, los rebotes o la
retención, y eso pasa por `/keel-design` en modo derivación.
