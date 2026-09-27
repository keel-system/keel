# notification-mailer-mongo — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/notification-mailer-mongo v1.0.0. Contrato de validación para la fase de generación.

> **El par del MVP, cerrado de punta a punta.** Es la fixture sobre la que el método se ejerce
> entero —escenarios, careo, revisión, análisis de huecos y registro estructural— y la que fija
> `keel-spring/test/mvp-ready.test.js`. Las dos gemelas del par (relacional y documental) tienen el mismo
> contrato: estos escenarios valen para los dos modelos de persistencia sin cambiar una línea.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). `requestedAt`, `sentAt`, `sendingSince`, `publishedAt` y el
  `occurredAt` de los eventos se verifican **por forma**, nunca por valor.
- **Identificadores**: `uuid` v4 canónico, verificados por forma y por reutilización simbólica
  dentro del flujo (`<t1>`, `<n1>`…): el id que devuelve un escenario es el que usa el siguiente.
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo**, en las respuestas y en los
  payloads de evento; nunca se omite (`conventions.nulls: include`). `publishedAt` es nulo
  mientras la plantilla está en borrador; `sentAt` y `sendingSince`, mientras el envío no ha
  salido.
- **Colecciones**: el orden de `credentialKeys`, `copyRecipients` y las `variables` (de una
  plantilla o de un envío) es **indiferente**: ninguna relación ni campo de lista del diseño
  declara posición. Se afirman como conjunto: los mismos elementos, en cualquier orden.
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios fijan
  solo el `code` y el status HTTP.
- **Identidades**: las credenciales son las de `security.serviceClients`. `platform-admin` da de
  alta sistemas; `orders-service` y `billing-service` piden envíos; `orders-service-ci` y
  `billing-service-ci` escriben plantillas. La aplicación del llamante **no viaja nunca en la
  petición**: la resuelve el servidor desde la credencial, buscando el `client_id` entre los
  `credentialKeys` de las aplicaciones registradas.
- **Aplicaciones de prueba**: salvo que el `Given` diga otra cosa, `orders` es
  `{key: "orders", name: "Pedidos", credentialKeys: ["orders-service", "orders-service-ci"],
  defaultSender: "pedidos@tienda.example", defaultLocale: "es"}` y `billing` es
  `{key: "billing", name: "Facturación", credentialKeys: ["billing-service", "billing-service-ci"],
  defaultSender: "facturas@tienda.example", defaultLocale: "es"}`, dadas de alta con
  `registerApplication` y la credencial de máquina del cliente `platform-admin`.
- **Plantilla de prueba `order-shipped`**: asunto `"Pedido {{orderNumber}} enviado"`, cuerpo
  html `"<p>Hola {{customerName}}, tu pedido {{orderNumber}} va de camino.</p>"`, cuerpo de
  texto `"Hola {{customerName}}, tu pedido {{orderNumber}} va de camino."` y dos variables
  declaradas, las dos requeridas: `orderNumber` y `customerName`.
- **Petición de prueba**: cuando un escenario dice «la petición de prueba para `<dirección>`», es
  `requestNotification` — `POST /v1/notifications` con la credencial de máquina del cliente
  `orders-service`, un `Idempotency-Key` nuevo y `{templateKey: "order-shipped", locale: "es",
  recipient: "<dirección>", variables: [{name: "orderNumber", value: "A-1001"},
  {name: "customerName", value: "Ana"}]}`.
- **Idempotencia de petición**: `requestNotification` admite la cabecera `Idempotency-Key`,
  opcional. Cada petición lleva una clave **nueva**, salvo en los escenarios que prueban la
  deduplicación, que repiten la anterior a propósito.
- **El correo se afirma sobre el buzón de prueba, no sobre la respuesta**: el `202` acepta el
  encargo, no lo cumple. Un correo «llega» cuando el buzón lo tiene; que **no** llegue se afirma
  pasado el ciclo del barrido en el que habría salido.
- **Ritmo del barrido**: `queueAcceptedNotifications` corre cada minuto. «En ≤ 70 s» es un
  ciclo más el margen de entrega; ningún escenario acorta el cron.
- **Canales**: `notificationEvents` es por donde sale `NotificationSent`; `notificationRequests`,
  por donde los sistemas piden envíos con la envoltura Keel. Su `metadata.source` nombra al
  servicio que publica, que es uno de los `credentialKeys` de su aplicación.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| registerApplication | FL-APP-001, FL-APP-001-B | **servidores (M2M)** |
| registerTemplate | FL-TPL-001, FL-TPL-002, **FL-TPL-003** | **servidores (M2M)** |
| publishTemplate | FL-TPL-010, FL-TPL-010-B, **FL-TPL-011**, FL-TPL-012 | **servidores (M2M)** |
| getTemplate | FL-TPL-001, FL-TPL-010, FL-TPL-012 | **servidores (M2M)** |
| requestNotification | FL-NTF-001, FL-NTF-001-B, **FL-NTF-002**, FL-NTF-001-C, FL-NTF-003, FL-NTF-004 | **servidores (M2M)** |
| getNotification | FL-NTF-001, FL-NTF-004 | **servidores (M2M)** |
| acceptNotificationRequest | FL-EVT-001, **FL-EVT-001-B**, FL-EVT-002, FL-EVT-003 | suscripción (interna) |
| queueAcceptedNotifications | FL-NTF-001, FL-EVT-001, **FL-CLU-001** | programada; efecto observable en el buzón |
| sendAcceptedNotification | FL-NTF-001, FL-DSP-001, **FL-CLU-001** | interna; la invoca el barrido |
| **outbox (canal indisponible y relay rendido)** | **FL-OBX-001**, **FL-OBX-002** | el evento de `sendAcceptedNotification` |

La misma matriz leída por **mecanismo**, que es como se decide si falta algo:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Idempotencia de petición | FL-NTF-001-B (reintento secuencial) | **FL-NTF-002** (carrera) · FL-NTF-001-C (misma clave, otro cuerpo) |
| Deduplicación de consumo (`metadata.eventId`) | FL-EVT-001 | **FL-EVT-001-B** (reentrega del mismo mensaje) |
| Descarte (`onFailure.deadLetter`) | — | FL-EVT-002 (rechazo de negocio) · FL-EVT-003 (emisor desconocido: se descarta **sin** pasar por la cola de descarte) |
| Outbox | FL-NTF-001 (el evento sale) | **FL-OBX-001** (canal indisponible) · **FL-OBX-002** (el relay se rinde) |
| Reclamo del barrido y guarda del envío | FL-NTF-001 | **FL-CLU-001** (dos réplicas, varias filas) |
| Unicidad condicionada (una versión activa) | FL-TPL-010 | **FL-TPL-011** (dos publicaciones a la vez) |
| Aislamiento entre inquilinos | — | FL-TPL-012 · FL-NTF-004 |

## Aplicaciones

### FL-APP-001: se da de alta un sistema consumidor

**When**: `registerApplication` — `POST /v1/applications` con la credencial de máquina del
cliente `platform-admin`:
```json
{ "key": "orders", "name": "Pedidos", "credentialKeys": ["orders-service", "orders-service-ci"],
  "defaultSender": "pedidos@tienda.example", "defaultLocale": "es" }
```
**Then**:
1. Status `201`.
2. Cabecera `Location` con la ruta de la petición seguida del `id` devuelto
   (`/v1/applications/<a1>`).
3. El cuerpo es exactamente `{id: <a1>, key: "orders", name: "Pedidos",
   credentialKeys: ["orders-service", "orders-service-ci"],
   defaultSender: "pedidos@tienda.example", defaultLocale: "es", active: true}` — `active`
   nace a `true` aunque la petición no lo mande, y el cuerpo no trae ningún campo adicional.
4. La aplicación ya resuelve la identidad: `registerTemplate` —
   `PUT /v1/templates/order-shipped/es` con la plantilla de prueba— con la credencial de máquina
   del cliente `orders-service-ci` responde `201` con `applicationId: <a1>`.

**Orden de evaluación**:
1. La clave no está dada de alta → `APPLICATION_ALREADY_EXISTS` (`409`).

**Casos borde**:
- Sin `name` → `400`.
- `credentialKeys` con seis elementos → `400` (`maxItems: 5`).
- `key` de 65 caracteres → `400`.

#### FL-APP-001-B: la misma clave no se da de alta dos veces, ni la da de alta cualquiera

**Given**: `orders` dada de alta como en FL-APP-001.

**When**: se repite el mismo `POST /v1/applications` con `key: "orders"` y otro `name`.

**Then**:
1. Status `409` con code `APPLICATION_ALREADY_EXISTS`.
2. No hay una segunda `orders`: `registerTemplate` con la credencial de máquina del cliente
   `orders-service-ci` sigue resolviendo a la aplicación de FL-APP-001 (su `applicationId` es
   `<a1>`).

**Casos borde**:
- Sin credencial → `401`.
- Con la credencial de máquina del cliente `orders-service`, que no tiene `application:admin` →
  `403`. Quien manda correo no puede darse de alta a sí mismo.

## Plantillas

### FL-TPL-001: se registra una versión de plantilla, en borrador

**Given**: `orders` dada de alta.

**When**: `registerTemplate` — `PUT /v1/templates/order-shipped/es` con la credencial de máquina
del cliente `orders-service-ci` y el cuerpo de la plantilla de prueba:
```json
{ "subject": "Pedido {{orderNumber}} enviado",
  "bodyHtml": "<p>Hola {{customerName}}, tu pedido {{orderNumber}} va de camino.</p>",
  "bodyText": "Hola {{customerName}}, tu pedido {{orderNumber}} va de camino.",
  "variables": [
    { "name": "orderNumber", "required": true, "description": "Número visible del pedido." },
    { "name": "customerName", "required": true, "description": null } ] }
```
**Then**:
1. Status `201`, con cabecera `Location` con la ruta de la petición seguida del `id` devuelto
   (`/v1/templates/order-shipped/es/<t1>`).
2. El cuerpo es exactamente `{id: <t1>, key: "order-shipped", locale: "es", status: "draft",
   version: 1, subject: "Pedido {{orderNumber}} enviado", bodyHtml: <el enviado>,
   bodyText: <el enviado>, publishedAt: null, applicationId: <a1>, variables: [...]}`, con
   `variables` de dos elementos, en cualquier orden: `{id: <uuid>, name: "orderNumber",
   required: true, description: "Número visible del pedido."}` y `{id: <uuid>,
   name: "customerName", required: true, description: null}`. El asunto y los cuerpos vuelven
   **sin interpolar**.
3. `getTemplate` — `GET /v1/templates/<t1>` con la misma credencial responde `200` con el
   mismo cuerpo.
4. Un segundo `PUT /v1/templates/order-shipped/es` con el mismo cuerpo responde `201` con otro
   id `<t2>`, `version: 2` y `status: "draft"`: registrar nunca pisa, siempre versiona.
5. Un `PUT /v1/templates/order-shipped/en` responde `201` con `version: 1`: la versión se cuenta
   por aplicación, clave **e idioma**.

**Orden de evaluación**:
1. La aplicación del token está registrada y activa → `APPLICATION_INACTIVE` (`403`).
2. El asunto y los dos cuerpos compilan → `TEMPLATE_SYNTAX_INVALID` (`422`).
3. Ningún nombre de variable se repite → `TEMPLATE_VARIABLE_DUPLICATED` (`422`).
4. Nadie registró esa misma versión a la vez → `TEMPLATE_VERSION_ALREADY_EXISTS` (`409`),
   ver FL-TPL-003.

**Casos borde**:
- Sin `variables` → `201` con `variables: []`: una plantilla puede no tener ninguna.
- Con 51 variables → `400` (`maxItems: 50`).
- `subject` de 201 caracteres → `400`. `bodyHtml` de 100 001 caracteres → `400`.
- Sin credencial → `401`. Con la credencial de máquina del cliente `orders-service`, que no
  tiene `template:write` → `403`.

### FL-TPL-002: lo que la plantilla no puede registrar

**Given**: `orders` dada de alta y `billing` **sin** dar de alta.

**When**: `PUT /v1/templates/order-shipped/es` con la credencial de máquina del cliente
`orders-service-ci` y dos variables llamadas `orderNumber`.

**Then**:
1. Status `422` con code `TEMPLATE_VARIABLE_DUPLICATED`.

**When**: el mismo `PUT` con variables correctas y el asunto `"Pedido {{#if orderNumber}}"`,
un bloque que no se cierra.

**Then**:
2. Status `422` con code `TEMPLATE_SYNTAX_INVALID`.

**When**: el asunto sin cerrar **y** las dos variables llamadas `orderNumber`.

**Then**:
3. Status `422` con code `TEMPLATE_SYNTAX_INVALID` — la precedencia: la plantilla se compila
   antes de mirar sus variables.
4. No se registró nada: un `PUT` válido a continuación responde `201` con `version: 1`.

**When**: `PUT /v1/templates/invoice-issued/es` con la credencial de máquina del cliente
`billing-service-ci`, cuya aplicación no existe todavía, y el cuerpo con dos variables
duplicadas.

**Then**:
5. Status `403` con code `APPLICATION_INACTIVE` — la precedencia: la aplicación se resuelve
   antes de mirar el contenido, porque la variable duplicada es de una plantilla que nadie puede
   registrar.

**Notas de determinación**: una aplicación dada de baja responde igual que una que no existe
(el `when` del error dice «dada de baja o no existe»). Ninguna operación de este diseño da de
baja una aplicación, así que el escenario la alcanza por la segunda vía.

### FL-TPL-003: dos registros de la misma clave e idioma, a la vez

Lo que FL-TPL-001 **no** prueba: el paso 4 llega con la versión 1 ya confirmada y lo resuelve
una lectura. La ventana es la de dos pipelines que despliegan a la vez.

**Given**: `orders` dada de alta y ninguna versión de `order-shipped` en `es`.

**When**: se lanzan **simultáneamente** dos `PUT /v1/templates/order-shipped/es` con la
credencial de máquina del cliente `orders-service-ci` y el cuerpo de la plantilla de prueba.

**Then**:
1. Los desenlaces admisibles son exactamente dos, y el escenario no afirma cuál ocurre: las dos
   responden `201` con `version` 1 y 2 (en cualquier orden), **o** una responde `201` con
   `version: 1` y la otra `409` con code `TEMPLATE_VERSION_ALREADY_EXISTS`.
2. Sea cual sea el desenlace, no hay dos plantillas con la misma versión: un `PUT` más a
   continuación responde `201` con la versión siguiente a la mayor devuelta (3 o 2).

### FL-TPL-010: publicar una versión la pone delante de los clientes y retira la anterior

**Given**: `orders` dada de alta y `order-shipped` en `es` registrada dos veces (`<t1>` en
versión 1 y `<t2>` en versión 2), las dos en borrador.

**When**: `publishTemplate` — `POST /v1/templates/<t1>/publish` con la credencial de máquina del
cliente `orders-service-ci`, sin cuerpo.

**Then**:
1. Status `200`, sin cabecera `Location`: publicar es una transición, no un alta.
2. El cuerpo es la plantilla `<t1>` entera, como en FL-TPL-001, con `status: "active"` y
   `publishedAt` con forma de instante.

**When**: `POST /v1/templates/<t2>/publish`.

**Then**:
3. Status `200` con `status: "active"` para `<t2>`.
4. `getTemplate` sobre `<t1>` responde `200` con `status: "retired"` y su `publishedAt` intacto:
   la versión que estaba activa se retira en el mismo acto.
5. Hay exactamente una versión activa, y es la 2: un `requestNotification` con la credencial de
   máquina del cliente `orders-service`, `templateKey: "order-shipped"`, `locale: "es"`,
   `recipient: "ana@cliente.example"` y las dos variables responde `202`, y `getNotification`
   sobre el envío devuelto da `templateVersion: 2`.

**Orden de evaluación**:
1. La plantilla existe y es de la aplicación del llamante → `TEMPLATE_NOT_FOUND` (`404`).
2. Está en borrador → `INVALID_STATE_TRANSITION` (`409`).
3. Nadie la publicó ni retiró a la vez → `CONCURRENT_MODIFICATION` o
   `TEMPLATE_ALREADY_ACTIVE` (`409`), ver FL-TPL-011.

#### FL-TPL-010-B: lo que no se puede publicar

**Given**: el estado final de FL-TPL-010 (`<t1>` retirada, `<t2>` activa).

**When**: `POST /v1/templates/<t2>/publish` otra vez.
**Then**:
1. Status `409` con code `INVALID_STATE_TRANSITION`: de `active` no se vuelve a `active`.

**When**: `POST /v1/templates/<t1>/publish`.
**Then**:
2. Status `409` con code `INVALID_STATE_TRANSITION`: `retired` es terminal, una versión retirada
   no vuelve.

**When**: `POST /v1/templates/<id que no existe>/publish`.
**Then**:
3. Status `404` con code `TEMPLATE_NOT_FOUND`.
4. `<t2>` sigue activa y `<t1>` retirada: ningún rechazo tocó nada.

**Casos borde**:
- Sin credencial → `401`. Con la credencial de máquina del cliente `orders-service`, que no
  tiene `template:publish` → `403`.
- `templateId` que no es un uuid → `400`.

### FL-TPL-011: dos versiones publicadas a la vez

La regla «como máximo una activa por aplicación, clave e idioma» es una **unicidad condicionada
al estado**, y su camino caro es este: dos pipelines publican dos borradores distintos al mismo
tiempo, y los dos quieren retirar la misma versión activa.

**Given**: `orders` dada de alta; `order-shipped` en `es` con `<t1>` activa y dos borradores,
`<t2>` y `<t3>`.

**When**: se lanzan **simultáneamente** `POST /v1/templates/<t2>/publish` y
`POST /v1/templates/<t3>/publish`, con la credencial de máquina del cliente `orders-service-ci`.

**Then**:
1. Los desenlaces admisibles son exactamente dos, y el escenario no fija cuál ocurre:
   **(a)** se solapan: una responde `200` con `status: "active"` y la otra `409` con code
   `CONCURRENT_MODIFICATION` o `TEMPLATE_ALREADY_ACTIVE` —cuál de los dos depende de qué
   escritura del perdedor llegue antes a la base—, y la perdedora sigue en `draft`;
   **(b)** se serializan: las dos responden `200`, y la que llegó segunda retiró a la primera,
   así que una queda en `active` y la otra en `retired`.
2. Sea cual sea el desenlace, hay **exactamente una** versión activa entre `<t1>`, `<t2>` y
   `<t3>`, leídas con `getTemplate`: nunca dos, nunca ninguna.
3. `<t1>` está en `retired`.

### FL-TPL-012: un sistema no ve ni publica las plantillas de otro

**Given**: `orders` y `billing` dadas de alta; `orders` registró `order-shipped` en `es` (`<t1>`,
en borrador).

**When**: `getTemplate` — `GET /v1/templates/<t1>` con la credencial de máquina del cliente
`billing-service-ci`.
**Then**:
1. Status `404` con code `TEMPLATE_NOT_FOUND` — lo mismo que un id que no existe: decir «existe
   pero no es tuya» le cuenta a un inquilino qué identificadores tiene otro.

**When**: `POST /v1/templates/<t1>/publish` con la misma credencial.
**Then**:
2. Status `404` con code `TEMPLATE_NOT_FOUND`.
3. `<t1>` sigue en `draft`, leída con la credencial de máquina del cliente `orders-service-ci`.

**Casos borde**:
- Sin credencial, `GET /v1/templates/<t1>` → `401`. Con la credencial de máquina del cliente
  `orders-service`, que no tiene `template:write` → `403`.

## Envíos por HTTP

### FL-NTF-001: se pide un envío, sale el correo y se anuncia

**Given**: `orders` dada de alta y `order-shipped` en `es` registrada y publicada en su versión
2 (la 1 retirada). El buzón de prueba está vacío.

**When**: `requestNotification` — `POST /v1/notifications` con la credencial de máquina del
cliente `orders-service` y un `Idempotency-Key` propio `<k1>`:
```json
{ "templateKey": "order-shipped", "locale": "es", "recipient": "ana@cliente.example",
  "copyRecipients": ["almacen@tienda.example"],
  "variables": [ { "name": "orderNumber", "value": "A-1001" },
                 { "name": "customerName", "value": "Ana" },
                 { "name": "coupon", "value": "NO-DECLARADA" } ] }
```
**Then**:
1. Status `202`, sin cabecera `Location`.
2. El cuerpo es exactamente `{notificationId: <n1>, status: "accepted"}`.
3. `getNotification` — `GET /v1/notifications/<n1>` con la misma credencial responde `200` con
   `{id: <n1>, applicationKey: "orders", templateKey: "order-shipped", status: "accepted",
   sendingSince: null, templateVersion: 2, locale: "es", recipient: "ana@cliente.example",
   renderedSubject: "Pedido A-1001 enviado", copyRecipients: ["almacen@tienda.example"],
   variables: [{name: "orderNumber", value: "A-1001"}, {name: "customerName", value: "Ana"}],
   dedupeKey: "<k1>", requestedAt: <instante>, sentAt: null}` — o más avanzado si el barrido
   pasó entre medias, y entonces coherente con su estado: en `"queued"` igual; en `"sending"`
   con `sendingSince` con forma de instante; en `"sent"` con `sendingSince` y `sentAt` con
   forma de instante. `coupon` **no** está: las variables
   que la plantilla no declara se ignoran y no se congelan.

**When**: pasa un ciclo de `queueAcceptedNotifications`, que invoca `sendAcceptedNotification`
por cada envío que reclama.

**Then**:
4. En ≤ 70 s el buzón de prueba recibe **exactamente un** correo para `ana@cliente.example`,
   con copia a `almacen@tienda.example`, remitente `pedidos@tienda.example` (el `defaultSender`
   de `orders`), respuesta a `soporte@ejemplo.com`, asunto `"Pedido A-1001 enviado"`, parte html
   `"<p>Hola Ana, tu pedido A-1001 va de camino.</p>"` y parte de texto
   `"Hola Ana, tu pedido A-1001 va de camino."`.
5. `getNotification` sobre `<n1>` responde con `status: "sent"`, `sentAt` y `sendingSince` con
   forma de instante y el resto del cuerpo igual que en el paso 3.
6. El canal `notificationEvents` recibe **exactamente un** `NotificationSent` con
   `{notificationId: <n1>, applicationKey: "orders", templateKey: "order-shipped",
   recipient: "ana@cliente.example", occurredAt: <instante>}`, y nada más.

**Orden de evaluación**:
1. La misma clave no se está atendiendo ya → `IDEMPOTENCY_KEY_IN_PROGRESS` (`409`); ni llega
   con otro contenido → `IDEMPOTENCY_KEY_REUSED` (`409`). Ver FL-NTF-002 y FL-NTF-001-C.
2. La aplicación está registrada y activa → `APPLICATION_INACTIVE` (`403`).
3. Hay plantilla activa con esa clave e idioma para esa aplicación → `TEMPLATE_NOT_FOUND`
   (`422`).
4. Toda variable requerida llega con valor → `TEMPLATE_VARIABLE_MISSING` (`422`).

**Ramas condicionales**:
- Sin `locale`, el envío usa el `defaultLocale` de la aplicación: la misma petición sin `locale`
  congela `locale: "es"` y el mismo asunto.
- Sin `Idempotency-Key`, la petición se acepta (`202`) y su `dedupeKey` es su propio
  `notificationId`: dos peticiones sin clave son dos envíos, y salen dos correos.

**Casos borde**:
- Sin `recipient` → `400`. `copyRecipients` con 11 direcciones → `400` (`maxItems: 10`).
- `variables` con 51 elementos → `400`. Un valor de 1001 caracteres → `400`.
- Sin credencial → `401`. Con la credencial de máquina del cliente `orders-service-ci`, que no
  tiene `notification:send` → `403`.

#### FL-NTF-001-B: el cliente reintenta con la misma clave

**Given**: lo que deja FL-NTF-001: el envío `<n1>` pedido con la clave `<k1>` y su correo en el
buzón.

**When**: se repite **exactamente** el mismo `POST /v1/notifications` con el **mismo**
`Idempotency-Key` `<k1>`.

**Then**:
1. La respuesta es la **misma** que la primera vez: `202` y `{notificationId: <n1>,
   status: "accepted"}` — el mismo id y el mismo `status`, aunque el envío ya haya avanzado.
   La repetición reproduce el resultado, no ejecuta de nuevo.
2. Pasado un ciclo del barrido, el buzón tiene **un solo** correo para `ana@cliente.example`.
3. El mismo cuerpo con **otra** clave `<k2>` sí es otro envío: `202` con otro `notificationId`,
   y un segundo correo en el buzón.

#### FL-NTF-001-C: la misma clave con otro contenido

**Given**: lo que deja FL-NTF-001-B: la clave `<k1>` ya usada para `ana@cliente.example`.

**When**: `POST /v1/notifications` con el mismo `Idempotency-Key` `<k1>` y
`recipient: "otra@cliente.example"`.

**Then**:
1. Status `409` con code `IDEMPOTENCY_KEY_REUSED`.
2. Pasado un ciclo del barrido, el buzón **no** tiene ningún correo para `otra@cliente.example`.

### FL-NTF-002: dos peticiones con la misma clave, a la vez

**Given**: `orders` y `order-shipped` publicada; una clave `<k3>` sin usar.

**When**: se lanzan **simultáneamente** dos `POST /v1/notifications` idénticos (el cuerpo de
FL-NTF-001 con `recipient: "luis@cliente.example"`) con el **mismo** `Idempotency-Key` `<k3>`.

**Then**:
1. Los desenlaces admisibles son exactamente dos: las dos responden `202` con el **mismo**
   `notificationId`, **o** una responde `202` y la otra `409` con code
   `IDEMPOTENCY_KEY_IN_PROGRESS`.
2. Sea cual sea el desenlace, existe **exactamente un** envío: pasado un ciclo del barrido, el
   buzón tiene **un solo** correo para `luis@cliente.example`.

### FL-NTF-003: las peticiones que se rechazan no mandan nada

**Given**: `orders` dada de alta; `order-shipped` en `es` **registrada pero sin publicar**;
`welcome` en `es` publicada con una variable requerida `customerName`; `billing` **sin** dar de
alta.

**When**: `POST /v1/notifications` con la credencial de máquina del cliente `orders-service`,
`templateKey: "order-shipped"` y `recipient: "a1@cliente.example"`.
**Then**:
1. Status `422` con code `TEMPLATE_NOT_FOUND`: un borrador no es una plantilla activa.

**When**: `POST /v1/notifications` con `templateKey: "welcome"`, `recipient:
"a2@cliente.example"` y `variables: []`.
**Then**:
2. Status `422` con code `TEMPLATE_VARIABLE_MISSING`.

**When**: `POST /v1/notifications` con la credencial de máquina del cliente `billing-service`,
`templateKey: "no-existe"` y `recipient: "a3@cliente.example"`.
**Then**:
3. Status `403` con code `APPLICATION_INACTIVE` — la precedencia: la aplicación se comprueba
   antes que la plantilla, y un sistema sin dar de alta no llega a saber qué plantillas hay.

**Then**:
4. Pasado un ciclo del barrido, el buzón **no** tiene ningún correo para `a1@cliente.example`,
   `a2@cliente.example` ni `a3@cliente.example`: el rechazo llegó antes del envío.

### FL-NTF-004: un sistema no ve los envíos de otro

**Given**: `orders` y `billing` dadas de alta, `order-shipped` publicada por `orders`, y un envío
`<n1>` pedido con la credencial de máquina del cliente `orders-service` (la petición de FL-NTF-001).

**When**: `getNotification` — `GET /v1/notifications/<n1>` con la credencial de máquina del
cliente `billing-service`.

**Then**:
1. Status `404` con code `NOTIFICATION_NOT_FOUND`: igual que un id que no existe.
2. Con la credencial de máquina del cliente `orders-service`, el mismo `GET` responde `200`.
3. `GET /v1/notifications/<id que no existe>` con la credencial de `orders-service` responde
   `404` con code `NOTIFICATION_NOT_FOUND`.

**Casos borde**:
- Sin credencial → `401`. Con la credencial de máquina del cliente `orders-service-ci`, que no
  tiene `notification:read` → `403`.

## Envíos por evento

### FL-EVT-001: un sistema pide un envío por el canal genérico

**Given**: `orders` dada de alta y `order-shipped` en `es` publicada.

**When**: llega a `notificationRequests` un `NotificationRequested` con la envoltura Keel,
`metadata.source: "orders-service"`, `metadata.eventId: <e1>` y el payload
```json
{ "templateKey": "order-shipped", "locale": "es", "recipient": "eva@cliente.example",
  "variables": [ { "name": "orderNumber", "value": "A-2002" },
                 { "name": "customerName", "value": "Eva" } ] }
```
y se ejecuta `acceptNotificationRequest`.

**Then**:
1. En ≤ 70 s el buzón de prueba recibe **exactamente un** correo para `eva@cliente.example`, con
   remitente `pedidos@tienda.example` y asunto `"Pedido A-2002 enviado"`: la aplicación salió de
   la envoltura, resuelta por los `credentialKeys` igual que por HTTP.
2. El canal `notificationEvents` recibe **exactamente un** `NotificationSent` con
   `{notificationId: <uuid>, applicationKey: "orders", templateKey: "order-shipped",
   recipient: "eva@cliente.example", occurredAt: <instante>}`.
3. La cola de descarte de la suscripción sigue vacía.

**Orden de evaluación**:
1. La aplicación que publicó el mensaje está registrada y activa → se descarta sin reintentar
   (FL-EVT-003).
2. Hay plantilla activa → `TEMPLATE_NOT_FOUND`, a la cola de descarte (FL-EVT-002).
3. Toda variable requerida llega con valor → `TEMPLATE_VARIABLE_MISSING`, a la cola de descarte
   (FL-EVT-002).

#### FL-EVT-001-B: la reentrega del mismo mensaje no manda un segundo correo

El canal es at-least-once: el broker puede entregar otra vez un mensaje que ya se procesó.

**Given**: lo que deja FL-EVT-001: el correo de `eva@cliente.example` ya en el buzón.

**When**: se reentrega a `notificationRequests` **el mismo** mensaje, con el mismo
`metadata.eventId` `<e1>`.

**Then**:
1. Pasado un ciclo del barrido, el buzón sigue teniendo **un solo** correo para
   `eva@cliente.example`.
2. `notificationEvents` no recibe un segundo `NotificationSent` para ese destinatario.
3. La cola de descarte sigue vacía: una reentrega no es un fallo.

**Casos borde**:
- El mismo payload con **otro** `metadata.eventId` es otra petición: sale un segundo correo.

### FL-EVT-002: un mensaje que no se puede atender va a la cola de descarte

**Given**: `orders` dada de alta; `welcome` en `es` publicada con la variable requerida
`customerName`; ninguna plantilla `no-existe`.

**When**: llega a `notificationRequests` un `NotificationRequested` de `metadata.source:
"orders-service"` con `templateKey: "no-existe"` y `recipient: "b1@cliente.example"`.
**Then**:
1. El mensaje llega a la cola de descarte de la suscripción **exactamente una vez**, intacto:
   es un `TEMPLATE_NOT_FOUND` y un rechazo de negocio no se reintenta.
2. Pasado un ciclo del barrido, el buzón no tiene ningún correo para `b1@cliente.example`.

**When**: llega otro con `templateKey: "welcome"`, `recipient: "b2@cliente.example"` y
`variables: []`.
**Then**:
3. Llega a la cola de descarte **exactamente una vez**: es un `TEMPLATE_VARIABLE_MISSING`.
4. Pasado un ciclo del barrido, el buzón no tiene ningún correo para `b2@cliente.example`.

**Notas de determinación**: el fallo **pasajero** (la base que no responde) se reintenta con
backoff exponencial, hasta 5 intentos, antes de llegar a la misma cola. No tiene escenario
propio: provocarlo exige tirar el almacén a mitad de un consumo, y la política la verifica el
gate estático del generador. Lo que sí se afirma aquí es la otra mitad, que es observable: el
rechazo de negocio llega a la cola a la primera.

### FL-EVT-003: un emisor desconocido se descarta sin reintentar

**Given**: `orders` dada de alta y `order-shipped` publicada.

**When**: llega a `notificationRequests` un `NotificationRequested` válido con
`metadata.source: "desconocido"`, que no es ningún `credentialKey`, y
`recipient: "c1@cliente.example"`.

**Then**:
1. Pasado un ciclo del barrido, el buzón no tiene ningún correo para `c1@cliente.example`.
2. La cola de descarte **sigue vacía**: un emisor desconocido es un fallo permanente que se
   confirma y se traza, no un mensaje que alguien tenga que mirar.

## Despacho

### FL-DSP-001: el relay rechaza el mensaje y el envío queda fallido

**Given**: `orders` dada de alta, `order-shipped` publicada y el relay de salida de prueba
configurado para **rechazar** el destinatario `rebota@cliente.example`.

**When**: la petición de prueba para `rebota@cliente.example` (responde `202`), y pasa un ciclo
de `queueAcceptedNotifications`.

**Then**:
1. En ≤ 70 s `getNotification` sobre el envío responde con `status: "failed"`, `sentAt: null` y
   `sendingSince` con forma de instante.
2. `notificationEvents` no recibe ningún `NotificationSent` para ese envío.
3. Un segundo ciclo del barrido no lo vuelve a intentar: `failed` es terminal.

**Notas de determinación**: es el único fallo de entrega que este servicio puede observar. Un
rebote posterior —el relay acepta y el destino lo devuelve horas después— queda fuera del
diseño. El `Given` necesita que el relay de prueba sepa rechazar un destinatario; si el
generador no ofrece esa primitiva, el flujo se puntúa `uncovered` con ese motivo, nunca se
fabrica el `failed` escribiendo en el almacén.

### FL-CLU-001: con dos réplicas, cada envío sale una vez

`queueAcceptedNotifications` corre en **todas** las réplicas, y su efecto —el correo, por
`sendAcceptedNotification`— sale de la transacción: una llamada al relay ya está en el cable
cuando la transacción del perdedor hace rollback. Es el escenario que ninguna prueba de una sola
instancia puede sustituir.

**Given**: dos réplicas del servicio vivas contra el mismo almacén. `orders` dada de alta,
`order-shipped` publicada, y un envío de control a `control@cliente.example` que ya salió
(`status: "sent"`) antes de arrancar la segunda réplica.

**When**: la petición de prueba para cada uno de `r1@cliente.example` … `r5@cliente.example`
(cinco `202`), y se deja correr el barrido en las dos réplicas durante 3 minutos: tiempo de sobra
para que cada envío complete su desenlace, sea cual sea el tamaño de lote.

**Then**:
1. El buzón recibe **exactamente un** correo para cada uno de `r1` … `r5`: cinco en total, ni
   uno más.
2. Los cinco envíos están en `sent`, leídos con `getNotification`.
3. `notificationEvents` recibe **exactamente cinco** `NotificationSent`, uno por envío.
4. El envío de control no vuelve a salir: el buzón sigue teniendo un solo correo para
   `control@cliente.example`.

## Outbox

### FL-OBX-001: el evento sobrevive a un canal indisponible

**Given**: `orders` dada de alta, `order-shipped` publicada, el canal `notificationEvents` sin
mensajes y el canal de eventos **indisponible**.

**When**: la petición de prueba para `obx@cliente.example`, y pasa un ciclo del barrido.

**Then**:
1. Status `202`: la indisponibilidad del canal no llega al cliente.
2. En ≤ 70 s el buzón recibe el correo para `obx@cliente.example` y `getNotification` lo da en
   `sent`: el correo no depende del canal.
3. `notificationEvents` no ha recibido **ningún** mensaje todavía.

**When**: el canal vuelve a estar disponible.

**Then**:
4. En ≤ 10 s `notificationEvents` recibe **exactamente un** `NotificationSent` para ese envío,
   con `{notificationId, applicationKey: "orders", templateKey: "order-shipped",
   recipient: "obx@cliente.example", occurredAt}`.
5. El servidor no se ha rendido con ningún evento: ningún evento abandonado.

### FL-OBX-002: el evento que el relay abandona no se pierde en silencio

**Given**: el canal indisponible y un envío ya salido (su correo en el buzón), con su
`NotificationSent` pendiente de salir.

**When**: se agota el presupuesto de reintentos de ese evento.

**Then**:
1. El servidor lo dice: informa de **un** evento abandonado.
2. Restablecido el canal, ese evento **no** se publica: el relay respeta que se rindió.
3. Y `notificationEvents` no recibe ninguna otra cosa.

## Lo que no tiene escenario, y por qué

- **La ventana entre el correo aceptado por el relay y la confirmación de la transición a
  `sent`** (`OBL-GUARD-UNOBSERVABLE`, aceptada en `decisions.yaml`). Una caída justo ahí es lo que
  la guarda de `sendAcceptedNotification` sostiene, y ningún arnés de caja negra la provoca. Se
  midió rompiendo el mecanismo: con la guarda rota la suite sigue en verde, porque en caja negra
  quien impide el segundo envío es el reclamo de lote de `queueAcceptedNotifications`
  (FL-CLU-001). La verificación de la guarda es **estática**: el gate del generador exige la
  llamada al reclamo antes del envío. Este documento no promete medir lo que no mide.
- **El reintento del fallo pasajero de la suscripción**: ver la nota de FL-EVT-002.
