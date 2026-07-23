---
name: keel-docs
description: Genera la documentación de la API de usuarios de un servicio (openapi.yaml + colecciones Postman) a partir de sus artefactos Keel validados. Usar cuando un cliente de usuario (web/mobile) consuma la API. Para el contrato servidor-a-servidor, ver /keel-integrate.
argument-hint: "<specs/servicio>"
---

# /keel-docs — documentación de la API desde el diseño

Produce la documentación de la **API REST** del servicio (contrato HTTP + colecciones para probarla)
para que un cliente la consuma **sin leer su código ni hablar con el equipo**. Todo se deriva de los
artefactos de `specs/<servicio>/`; si algo no se puede derivar, es un hueco del diseño: repórtalo, no
lo inventes.

El contrato **servidor-a-servidor** (endpoints M2M expuestos a otros servidores + eventos publicados
y consumidos) no se documenta aquí: lo genera `/keel-integrate` en `INTEGRATION.md`. Esta skill cubre
el contrato HTTP formal (`openapi.yaml`, que incluye todos los endpoints de `api`) y las colecciones
Postman para ejercitarlo.

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

Si una capa opcional no existe, su sección se omite (no se documenta lo que el servicio no tiene).

## Salidas

Genera en `docs/<service.name>/` dentro del workspace:

### 1. `openapi.yaml`

OpenAPI 3.1 derivado mecánicamente:

- Un path por endpoint de `api` (o derivado de `auto`), con verbo, `successStatus` y parámetros de path/query según el input de la operación.
- Schemas de componentes desde `domain` (`entities` y `types`; constraints → `pattern`, `maxLength`, `minimum`…; enums → `enum`).
- `components.securitySchemes` y `security` por operación desde `security` (protocolo → scheme; permisos → scopes cuando el protocolo los soporte). Con `serviceAuth: client-credentials`, un scheme `oauth2` con flow `clientCredentials` cuyos scopes salen de los exigidos por las reglas `level: service`; las operaciones `audience: services` referencian ese scheme (y las `both`, ambos).
- Cada error declarado en `use-cases` como respuesta con su status y el schema común `{ code, message }`.
- `info.version` = `service.version`; `info.description` resume el servicio.

Valida el resultado con `npx --yes @redocly/cli@latest lint docs/<service.name>/openapi.yaml` y corrige hasta que pase.

### 2. `postman/` — colecciones listas para importar

Formato exacto, plantillas y checklist en `references/postman-collection-guide.md` (léela antes de escribirlas). Dos archivos:

- **`postman/<service.name>-collection.json`** — **se regenera siempre**. Una carpeta por flujo `FL-*` de `specs/<servicio>/validation-scenarios.md` con una request por escenario (felices y de error; nombre `FL-XXX · <letra> — <título> (<status>)`) cuyo script `test` asserta el status del Then; más una carpeta «Operaciones» con una request por endpoint de `api` no cubierto por los flujos (body de ejemplo desde el input de la operación). `{{baseUrl}}` como variable de colección; con capa `security`, header `Authorization: Bearer {{token_<rol-kebab>}}` según `access`.
- **`postman/auth-collection.json`** — **idempotente: si ya existe, no lo toques** (puede tener ajustes manuales del equipo); solo repórtalo. Una request de token por rol usado (`security.roles` / roles de los flujos), cada una con `pm.globals.set('token_<rol-kebab>', ...)`; si hay `serviceClients`, además una request `client_credentials` por cliente máquina (`pm.globals.set('token_<cliente-kebab>', ...)`) con sus scopes como variable. El endpoint de token y las credenciales van como **variables de colección** (`{{tokenUrl}}`, `{{clientId}}`…): el diseño es agnóstico de proveedor; quien importa la colección las rellena según su stack (la guía documenta los valores típicos).

## Coherencia

`openapi.yaml` y las colecciones Postman salen del mismo diseño y deben contar exactamente la misma historia: mismos paths, mismos códigos de error, mismos campos, misma seguridad. No pueden contradecir el `INTEGRATION.md` que genera `/keel-integrate` (misma fuente de verdad: el spec). Ante regeneración, sobrescribe todo por completo (no edites incrementalmente) — con la única excepción de `postman/auth-collection.json`, que no se pisa si existe.
