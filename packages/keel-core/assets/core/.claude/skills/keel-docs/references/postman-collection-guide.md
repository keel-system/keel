# Guía de colecciones Postman

Formato exacto de los dos archivos que `/keel-docs` escribe en `docs/<service.name>/postman/`.
Todo se deriva de los artefactos (`use-cases`, `api`, `security`) y de
`specs/<servicio>/validation-scenarios.md`; si algo no se puede derivar, es un hueco
del diseño: repórtalo, no lo inventes.

Ambos archivos usan **Postman Collection v2.1.0** y comparten tokens vía globals de
Postman (`pm.globals.set` en la auth, `{{token_<rol>}}` en la de negocio). No generes
archivos de environment: las globals bastan. Verifica que cada JSON emitido es válido.

## Convenciones compartidas

- **`{{baseUrl}}`** — variable de colección, default `http://localhost:8080`; prefijo
  de toda URL de negocio (`{{baseUrl}}` + `basePath` de `api` + ruta del endpoint).
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
  "variable": [{ "key": "baseUrl", "value": "http://localhost:8080" }]
}
```

`item` contiene requests o **carpetas** (objeto con `name` + su propio `item[]`).
Cada request puede llevar `event[]` con un script `test`.

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
- [ ] `{{baseUrl}}` (y las variables de auth) declaradas en `variable[]`.
- [ ] Ambos JSON válidos; reporta rutas y orden de importación (auth primero).
