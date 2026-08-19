---
name: keel-docs
description: Genera la documentación derivada de un servicio (openapi.yaml, asyncapi.yaml, colecciones Postman y el panel visual overview.html) a partir de sus artefactos Keel validados. Usar cuando un cliente consuma la API, cuando haga falta el contrato formal de eventos, o cuando el diseñador quiera revisar el servicio de un vistazo. Para el contrato servidor-a-servidor en prosa, ver /keel-integrate.
argument-hint: "<specs/servicio>"
---

# /keel-docs — documentación derivada del diseño

Produce los **contratos formales** del servicio (HTTP y asíncrono), las colecciones para probarlos y
un **panel visual** del servicio, para que un cliente lo consuma y el diseñador lo revise **sin leer
el código ni hablar con el equipo**. Todo se deriva de los artefactos de `specs/<servicio>/`; si algo
no se puede derivar, es un hueco del diseño: repórtalo, no lo inventes.

El contrato servidor-a-servidor **en prosa** (cómo integrarse: obtener el token M2M, qué reintentar,
qué publicar para activar una operación) no se escribe aquí: lo genera `/keel-integrate` en
`INTEGRATION.md`. Esta skill produce los artefactos **formales y machine-readable** de las dos
superficies —`openapi.yaml` para HTTP, `asyncapi.yaml` para eventos—, las colecciones Postman para
ejercitar la API y el panel `overview.html` que resume el servicio entero.

Antes de generar, ejecuta las comprobaciones de `/keel-validate`; no documentes un diseño inválido.

## Fuentes por sección

Cada parte de la documentación se deriva de capas concretas:

| Contenido | Capas fuente |
|-----------|--------------|
| Paths, verbos, parámetros | `api`, `use-cases` |
| Schemas de componentes | `domain` (`entities`, `types`) |
| securitySchemes y security por operación | `security` |
| Respuestas de error | `use-cases` |
| Colecciones Postman | `use-cases`, `api`, `security`, `validation-scenarios.md` |
| Canales, mensajes y operaciones AsyncAPI | `messaging`, `domain` (`types`), `use-cases` (`emits`) |
| Panel del servicio | todas las capas declaradas |

Si una capa opcional no existe, su sección se omite (no se documenta lo que el servicio no tiene).

## Salidas

Genera en `docs/<service.name>/` dentro del workspace:

### 1. `openapi.yaml`

OpenAPI 3.1 derivado mecánicamente:

- Un path por endpoint de `api` (o derivado de `auto`), con verbo, `successStatus` y parámetros de path/query según el input de la operación.
- Schemas de componentes desde `domain` (`entities` y `types`; constraints → `pattern`, `maxLength`, `minimum`…; enums → `enum`).
- Las `relations` de una entidad **no son todas propiedades**, y aquí es donde un OpenAPI derivado a ojo se separa del contrato real. Los `aggregates` del diseño mandan:
  - relación a una entidad **del mismo agregado** → schema anidado (`$ref`, o `array` de `$ref` si la cardinalidad es `one-to-many`);
  - relación a **otro agregado** (`many-to-one`/`one-to-one`) → una sola propiedad `<relación>Id` de tipo `uuid`: entre agregados solo viaja el id;
  - **back-reference** de una entidad hija hacia la raíz de su propio agregado → **se omite**, ni en `properties` ni en `required`. El schema hijo solo aparece anidado bajo su raíz, así que el vínculo ya está en la estructura: declararlo otra vez inventa un campo (`ProductImage.productId`) que ni el servidor devuelve ni los escenarios esperan, y el primero que se lo crea es quien integra contra el contrato.
- `components.securitySchemes` y `security` por operación desde `security` (protocolo → scheme; permisos → scopes cuando el protocolo los soporte). Con `serviceAuth: client-credentials`, un scheme `oauth2` con flow `clientCredentials` cuyos scopes salen de los exigidos por las reglas `level: service`; las operaciones `audience: services` referencian ese scheme (y las `both`, ambos).
- Cada error declarado en `use-cases` como respuesta con su status y el schema común `{ code, message }`.
- Un campo `type: file` **no siempre publica lo mismo**, y lo decide la `visibility` de su bucket en `storage`:
  - bucket `public` → en una **respuesta**, `type: string` + **`format: uri`**, descrito como URL absoluta del objeto. Es lo que el servidor devuelve de verdad: la key se resuelve a URL antes de serializar, porque un objeto de lectura anónima sin URL en el contrato obliga a cada cliente a componerla por su cuenta;
  - bucket `private` → `type: string` sin `format`, descrito como referencia al objeto en su bucket lógico. Publicar aquí una URL sería mentir: la de un objeto privado caduca y no cabe en un contrato estable;
  - en un **request** multipart, siempre `type: string, format: binary` — ahí sube el binario, no una referencia.
  (En `asyncapi.yaml` la regla es otra y no tiene excepción: un payload lleva siempre la key. Ver `references/asyncapi-guide.md`.)
- `info.version` = `service.version`; `info.description` resume el servicio.

**Todo lo que generas lleva sello de versión.** `info.version` en `openapi.yaml` y `asyncapi.yaml`, la variable de colección `keelVersion` en la colección de negocio y el comentario `<!-- keel:version <service.version> -->` en la segunda línea de `overview.html`, `openapi.html` y `asyncapi.html`. Es lo que hace mecánicamente detectable que un derivado quedó atrás cuando el diseño cambia: `keel describe <servicio>` compara cada sello con el manifiesto y `/keel-evolve` decide con eso qué regenerar. Un derivado sin sello se reporta como desactualizado.

Valida el resultado con `npx --yes @redocly/cli@latest lint docs/<service.name>/openapi.yaml` y corrige hasta que pase.

### 2. `postman/` — colecciones listas para importar

Formato exacto, plantillas y checklist en `references/postman-collection-guide.md` (léela antes de escribirlas). Dos archivos:

- **`postman/<service.name>-collection.json`** — **se regenera siempre**. Una carpeta por flujo `FL-*` de `specs/<servicio>/validation-scenarios.md` con una request por escenario (felices y de error; nombre `FL-XXX · <letra> — <título> (<status>)`) cuyo script `test` asserta el status del Then; más una carpeta «Operaciones» con una request por endpoint de `api` no cubierto por los flujos (body de ejemplo desde el input de la operación). `{{baseUrl}}` como variable de colección; con capa `security`, header `Authorization: Bearer {{token_<rol-kebab>}}` según `access`.
- **`postman/auth-collection.json`** — **idempotente: si ya existe, no lo toques** (puede tener ajustes manuales del equipo); solo repórtalo. Una request de token por rol usado (`security.roles` / roles de los flujos), cada una con `pm.globals.set('token_<rol-kebab>', ...)`; si hay `serviceClients`, además una request `client_credentials` por cliente máquina (`pm.globals.set('token_<cliente-kebab>', ...)`) con sus scopes como variable. El endpoint de token y las credenciales van como **variables de colección** (`{{tokenUrl}}`, `{{clientId}}`…): el diseño es agnóstico de proveedor; quien importa la colección las rellena según su stack (la guía documenta los valores típicos).

### 3. `asyncapi.yaml` — el contrato de los eventos

El análogo de OpenAPI para lo que no viaja por HTTP: **AsyncAPI 3.0.0** derivado de `messaging`
(+ `domain` para los tipos, `service` para la identidad). Formato exacto, mapeo capa→documento y
plantillas en `references/asyncapi-guide.md` (léela antes de escribirlo). En resumen:

- Un canal por entrada de `messaging.channels` (`address` = el nombre lógico; el topic/cola físico es
  parámetro de despliegue, nunca dato de diseño), con `x-keel-external` en los ajenos.
- Una operación `publish<Evento>` (`action: send`) por evento de `publishing.events` y una
  `consume<Evento>` (`action: receive`) por suscripción, con `x-keel-triggers`, `x-keel-source` y
  `x-keel-on-failure`.
- Los mensajes publicados llevan **la envoltura Keel completa** (`metadata` + `data`): es lo que hace
  consumible el servicio desde otro escrito en otra tecnología, así que forma parte del contrato. Los
  consumidos siguen su `contract` (`envelope`, `payloadPath`, `discriminator`, `messageId`,
  `wireName`).

**Sin capa `messaging` no se genera** (ni `asyncapi.yaml` ni `asyncapi.html`): repórtalo. Valida el
resultado con `npx --yes @asyncapi/cli@latest validate docs/<service.name>/asyncapi.yaml` y corrige
hasta que pase.

### 4. `overview.html` — panel del servicio (+ visores)

Una página autocontenida que responde de un vistazo qué hace el servicio y qué infraestructura exige:
capacidades (persistencia, broker, outbox, caché, storage, correo, clientes HTTP, seguridad, jobs), los casos
de uso como acordeones agrupados por audiencia (con entrada, salida, errores, idempotencia, caché y
seguridad de cada uno), los eventos, los clientes HTTP y el modelo de dominio. Enlaza los contratos y
los visores.

**No escribes el HTML.** El markup, el CSS y el JS son assets fijos en `references/templates/`: se
copian verbatim y solo se sustituyen sus placeholders — así el panel sale con la misma forma en cada
ejecución. Tu trabajo es derivar el objeto de datos.

- `templates/overview.html` → `overview.html`, sustituyendo `/*__KEEL_DATA__*/ null` por el objeto
  `KEEL` derivado del diseño.
- `templates/spec-viewer.html` → `openapi.html` (renderer `redoc`) y, con capa `messaging`,
  `asyncapi.html` (renderer `asyncapi`), con el spec embebido inline para que abran desde `file://`.

**Contrato campo a campo del objeto `KEEL`, orden de las tarjetas y procedimiento de sustitución en
`references/overview-html-guide.md` — léela antes de generar.**

## Índice del repositorio (`README.md`)

Tras escribir los derivados, **actualiza el índice de servicios del `README.md`** de la raíz del
workspace: hasta que no se regenera, la portada no enlaza el panel ni los visores que acabas de
generar. No lo escribas a mano: ejecuta desde la raíz del workspace

```bash
keel index
```

**El índice tiene un único escritor, y es `keel index`.** Nunca edites la región entre
`<!-- keel:servicios:start -->` y `<!-- keel:servicios:end -->` a mano ni con Edit: se pisa en la
siguiente ejecución. Si el comando avisa de que falta el `README.md` o los marcadores, créalo con la
estructura mínima —título, introducción breve, sección `## Servicios diseñados` y las dos líneas de
marcadores— y vuelve a ejecutarlo.

**Enlaces navegables.** GitHub muestra un `.html` enlazado en relativo como código fuente, así que
`overview.html`, `openapi.html` y `asyncapi.html` solo se abren de verdad desde la portada si el
workspace declara dónde está publicado, en un `publish.yaml` en la raíz:

```yaml
repo: <org>/<repo>     # obligatorio
branch: main           # opcional, por defecto main
```

Con él, `keel index` enruta esos tres enlaces por htmlpreview; sin él los deja en relativo (correcto
en local, inservible en GitHub). Si el workspace se publica en GitHub y no existe el archivo,
**sugiérelo**; no lo crees por iniciativa propia: es configuración del equipo, no un derivado del
diseño, y adivinar el repo mal deja enlaces rotos en la portada.

## Los errores del framework también son contrato

En las respuestas de error de `openapi.yaml` no van solo los `errors[]` de la operación: van
también los códigos que pone el **framework** por haber encendido un mecanismo (`docs/framework-errors.md`).
Una operación con `idempotency` puede devolver `409 IDEMPOTENCY_KEY_IN_PROGRESS` y
`409 IDEMPOTENCY_KEY_REUSED`; con `optimisticLocking` distinto de `none`, sus mutaciones pueden
devolver `409 CONCURRENT_MODIFICATION`; con un bucket que acota el tamaño, la subida puede devolver
`413 FILE_TOO_LARGE`. Si el diseño declara un `code` de la familia de alguno, documenta **ese** —es
el que sale por el cable— y no el canónico.

No es exhaustividad por gusto: el cliente va a recibirlos, y un error que no está en el contrato
publicado es un error contra el que nadie puede programar. Lo mismo vale para el `INTEGRATION.md`
de `/keel-integrate`.

## Coherencia

`openapi.yaml`, `asyncapi.yaml`, las colecciones Postman y el panel salen del mismo diseño y deben
contar exactamente la misma historia: mismos paths, mismos eventos, mismos códigos de error, mismos
campos, misma seguridad. No pueden contradecir el `INTEGRATION.md` que genera `/keel-integrate` ni el
`DESIGN.md` de `/keel-handoff` (misma fuente de verdad: el spec) — en particular, los eventos y
payloads de `asyncapi.yaml` coinciden 1:1 con la §Eventos de `INTEGRATION.md`. Ante regeneración,
sobrescribe todo por completo (no edites incrementalmente) — con la única excepción de
`postman/auth-collection.json`, que no se pisa si existe.
