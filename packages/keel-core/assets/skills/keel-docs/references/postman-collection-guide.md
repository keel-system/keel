# Guía de colecciones Postman

Formato exacto de los dos archivos que `/keel-docs` escribe en `docs/<service.name>/postman/`.
Todo se deriva de los artefactos (`use-cases`, `api`, `security`) y de
`specs/<servicio>/validation-scenarios.md`; si algo no se puede derivar, es un hueco
del diseño: repórtalo, no lo inventes.

Ambos archivos usan **Postman Collection v2.1.0** y comparten tokens vía globals de
Postman (`pm.globals.set` en la auth, `{{token_<rol>}}` en la de negocio). No generes
archivos de environment: los valores de un environment (URL del token, clientes,
secretos) dependen del proveedor de identidad que elige el **generador**, y es él quien
lo emite junto a su infraestructura de prueba (keel-spring lo deja en
`deploy/postman/<servicio>-local.postman_environment.json`). Por eso los nombres de
variable de la tabla de abajo son contrato: el generador los rellena tal cual. Verifica
que cada JSON emitido es válido.

## Convenciones compartidas

- **`{{baseUrl}}`** — variable de colección, default `http://localhost:8080`; prefijo
  de toda URL de negocio (`{{baseUrl}}` + `basePath` de `api` + ruta del endpoint).
- **`keelVersion`** — variable de colección de la colección de negocio con el
  `service.version` del manifiesto (sin `v` delante). No se usa en ninguna request:
  es el **sello de frescura** con el que `keel describe` detecta que la colección
  nació de una versión anterior del diseño y `/keel-evolve` decide qué regenerar.
- **`token_<rol-kebab>`** — global donde la auth guarda cada token. El rol sale de
  `security.roles` y del Given de los escenarios, en kebab-case y sin prefijo
  `ROLE_`: `ADMIN → token_admin`, `CATALOG_MANAGER → token_catalog-manager`.
- Las requests autenticadas llevan `Authorization: Bearer {{token_<rol>}}` con el rol
  que la regla de `security.access` exige para esa operación.

## Esqueleto v2.1.0

```json
{
  "info": {
    "name": "<nombre>",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [],
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:8080" },
    { "key": "keelVersion", "value": "<service.version>" }
  ]
}
```

`item` contiene requests o **carpetas** (objeto con `name` + su propio `item[]`).
Cada request puede llevar `event[]` con un script `test`. `keelVersion` va solo en la
colección de negocio: la de auth es idempotente y no se regenera, así que sellarla
mentiría sobre su frescura.

## `auth-collection.json`

**Idempotente**: si `postman/auth-collection.json` ya existe, no lo toques (puede
tener ajustes manuales); repórtalo y sigue con la colección de negocio.

El diseño Keel es agnóstico del proveedor de identidad, así que **todo lo
stack-específico va en variables de colección** que quien importa rellena:

| Variable | Qué es | Valor típico (infra de prueba de un generador) |
|---|---|---|
| `tokenUrl` | Endpoint de token OAuth2/OIDC | Keycloak: `http://localhost:8180/realms/<realm>/protocol/openid-connect/token` |
| `clientId` / `clientSecret` | Credenciales del client | según el realm/pool de prueba |
| `username_<rol>` / `password_<rol>` | Usuario de prueba por rol (solo password grant) | según los usuarios sembrados |
| `clientId_<cliente>` / `clientSecret_<cliente>` / `scope_<cliente>` | Cliente máquina de `serviceClients` (client_credentials), en kebab-case | según el realm/pool de prueba |
| `clientId_other-audience` / `clientSecret_other-audience` | Cliente con **audiencia ajena**, para el caso de rechazo cuando `serviceAuth.validateAudience` | el cliente de prueba con audiencia equivocada |
| `apiKey` / `apiKey_<cliente>` | Clave de API (`protocol: api-key`) del servicio o de cada cliente máquina | la clave local del generador |
| `webOrigin` | Origen de un front permitido por CORS | primer origen local |

Una request por rol usado por los flujos. Plantilla (password grant):

```json
{
  "name": "Token — admin",
  "request": {
    "method": "POST",
    "header": [{ "key": "Content-Type", "value": "application/x-www-form-urlencoded" }],
    "url": "{{tokenUrl}}",
    "body": {
      "mode": "urlencoded",
      "urlencoded": [
        { "key": "grant_type", "value": "password" },
        { "key": "client_id", "value": "{{clientId}}" },
        { "key": "client_secret", "value": "{{clientSecret}}" },
        { "key": "username", "value": "{{username_admin}}" },
        { "key": "password", "value": "{{password_admin}}" }
      ]
    }
  },
  "event": [{
    "listen": "test",
    "script": {
      "type": "text/javascript",
      "exec": [
        "pm.test('token 200', () => pm.response.to.have.status(200));",
        "pm.globals.set('token_admin', pm.response.json().access_token);"
      ]
    }
  }]
}
```

Variante **client-credentials** (sin usuario): `grant_type=client_credentials`, sin
`username`/`password`. Si un solo client emite todos los roles, genera igualmente una
entrada por rol apuntando al mismo token: la colección de negocio referencia siempre
`token_<rol>`.

Declara las variables usadas en `variable[]` de la colección (valor vacío o de
ejemplo) para que Postman las muestre al importar.

## `<service.name>-collection.json`

**Se regenera siempre.** Una carpeta por flujo `FL-*` de `validation-scenarios.md`,
una request por escenario, más una carpeta «Operaciones» para los endpoints no
cubiertos por los flujos.

### Mapeo escenario → request

| Sección del escenario | Qué produce |
|---|---|
| Given (rol) | header `Authorization: Bearer {{token_<rol>}}` |
| Given (estado previo) | nota en `description`; si necesita datos previos, ordena la request tras la que los crea (dentro del mismo flujo) |
| When | `method`, `url` (`{{baseUrl}}` + `basePath` + ruta), `body` JSON del input |
| Then | script `test` con el status esperado (y forma de la respuesta si el Then la fija) |

Nombre de la request: `FL-XXX · <letra> — <título> (<status>)`.

Plantilla de escenario feliz:

```json
{
  "name": "FL-001 · A — Creación exitosa (201)",
  "request": {
    "method": "POST",
    "header": [
      { "key": "Content-Type", "value": "application/json" },
      { "key": "Authorization", "value": "Bearer {{token_admin}}" }
    ],
    "url": "{{baseUrl}}/api/catalogo/v1/categorias",
    "body": { "mode": "raw", "raw": "{\n  \"name\": \"Lácteos\"\n}" }
  },
  "event": [{
    "listen": "test",
    "script": {
      "type": "text/javascript",
      "exec": ["pm.test('status 201', () => pm.response.to.have.status(201));"]
    }
  }]
}
```

Escenario de error: misma forma, con el status del error. El status sale del flujo o
del `http` del `errors[].code` correspondiente en `use-cases` (duplicado → 409,
inexistente → 404, permiso insuficiente → 403, validación → 400…): usa siempre el
declarado en el diseño, nunca uno supuesto.

### Escritura condicional (`api.concurrency`)

Si el diseño declara `api.concurrency`, las escrituras listadas comparan la versión que el cliente leyó:

- La **lectura** que da el `ETag` (la query con endpoint que devuelve la raíz entera) lo **captura** en una variable de
  colección, en su script `test`:
  `pm.collectionVariables.set('etag_<raíz>', pm.response.headers.get('ETag'));`
- Cada **escritura listada** lo manda tal cual en `If-Match: {{etag_<raíz>}}`, y si su respuesta devuelve la raíz, vuelve
  a capturar el `ETag` nuevo: así dos ediciones encadenadas no necesitan releer.
- El `ETag` es **opaco**: no lo construyas a mano ni le quites las comillas.
- Con `conditionalWrites: required`, una escritura sin `If-Match` responde **428**. Solo la request del escenario que afirma
  ese 428 va sin la cabecera; `keel validate` avisa (`CHK-DOCS-POSTMAN-DRIFT`) de cualquier otra.
- El escenario del **412** manda un `ETag` viejo a propósito: guárdalo en otra variable antes de la escritura que lo deja
  obsoleto.

### Lectura acotada e identidad opcional (`reads`, `level: optional`)

- Una operación con **`level: optional`** se pide **sin** cabecera `Authorization` salvo que el Given del escenario nombre
  un llamante: entonces lleva su `token_<rol>`. Nunca la cabecera con un global vacío: `Bearer ` sin token es una
  credencial inválida, y el servidor responde **401** donde el escenario esperaba la respuesta anónima.
- Una lectura en **`reads`** responde según quién la pide. El escenario que lee una fila **ajena** necesita dos llamantes
  —el dueño, que la crea, y otro, que la lee—: si son del mismo rol, el segundo usa `token_<rol>-other`, y si la
  `auth-collection.json` no lo trae, repórtalo en vez de reutilizar el token del dueño (la request pasaría sin probar
  nada). El status lo decide `readMiss`: con `not-found`, **404** con el `code` de no encontrado, igual que una fila que no
  existe; con `forbidden`, **403** con el error del bloque.
- Un **listado** acotado devuelve solo las filas del llamante: su test asserta lo que diga el Then (las filas propias, el
  total), nunca un recuento que dependa de lo que crearon otros flujos.

### Carpeta «Operaciones»

Una request por endpoint de `api` (explícito o derivado de `auto`) que ningún
escenario cubre:

- `method` y ruta desde `api`; body de ejemplo desde el input de la operación
  (campos requeridos con valores realistas, coherentes con el `openapi.yaml`).
- `Authorization` según la regla de `security.access` de la operación.
- Test mínimo: el `successStatus` del contrato.

## Checklist de cierre

- [ ] `auth-collection.json` existe (creado ahora **o** preexistente y no tocado).
- [ ] Cada rol usado por flujos u operaciones tiene su request de token y su global `token_<rol>`.
- [ ] Una carpeta por `FL-*` con una request por escenario (felices y de error).
- [ ] Carpeta «Operaciones» con los endpoints no cubiertos.
- [ ] Con `api.concurrency`: la lectura captura `ETag` y cada escritura listada lo manda en `If-Match` (salvo la del 428).
- [ ] `{{baseUrl}}` (y las variables de auth) declaradas en `variable[]`.
- [ ] Ambos JSON válidos; reporta rutas y orden de importación (auth primero).
