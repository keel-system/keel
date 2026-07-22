---
name: keel-docs
description: Genera la documentación de integración (INTEGRATION.md + openapi.yaml + colecciones Postman) de un servicio a partir de sus artefactos Keel validados. Usar cuando otro equipo o sistema necesite integrarse con el servicio.
argument-hint: "<specs/servicio>"
---

# /keel-docs — documentación de integración desde el diseño

Produce documentación para que otro sistema se integre con el servicio **sin leer su código ni hablar con el equipo**. Todo se deriva de los artefactos de `specs/<servicio>/`; si algo no se puede derivar, es un hueco del diseño: repórtalo, no lo inventes.

Antes de generar, ejecuta las comprobaciones de `/keel-validate`; no documentes un diseño inválido.

## Fuentes por sección

Cada parte de la documentación se deriva de capas concretas:

| Contenido | Capas fuente |
|-----------|--------------|
| Resumen y conceptos | `service.keel.yaml`, `domain` |
| Operaciones, request/response, errores | `use-cases`, `api` |
| Auth por endpoint, roles y permisos | `security` |
| Eventos publicados y consumidos | `messaging` |
| Paginación, idempotencia | `api`, `use-cases` |
| Colecciones Postman | `use-cases`, `api`, `security`, `validation-scenarios.md` |

Si una capa opcional no existe, su sección se omite (no se documenta lo que el servicio no tiene).

## Salidas

Genera en `docs/<service.name>/` dentro del workspace:

### 1. `INTEGRATION.md`

1. **Resumen** — qué hace el servicio y su `domain`, en un párrafo (desde `service.description`).
2. **Conceptos** — cada entidad con sus campos visibles (omite `generated` internos irrelevantes), estados e invariantes que el integrador debe conocer.
3. **Autenticación** — protocolo (`security: authentication`), dónde va el token, y la tabla de roles/permisos con lo que permite cada uno.
4. **Operaciones** — por cada operación expuesta en `api`: endpoint (método + `basePath` + path), regla de acceso (nivel, roles/permisos desde `security: access`), request y response con ejemplo JSON realista, la **tabla de errores** (code, HTTP, cuándo), y si acepta clave de idempotencia. Ejemplos coherentes entre sí a lo largo del documento.
5. **Eventos** — de `messaging`: los publicados (payload de ejemplo, qué operaciones los emiten y la garantía de entrega si `reliability: outbox`) y las suscripciones (qué espera recibir y de quién).
6. **Convenciones** — paginación (parámetros y forma de respuesta), idempotencia (qué header enviar y en qué operaciones), formato de errores común `{ code, message }`.
7. **Escenarios de integración** — 2 o 3 flujos típicos de punta a punta narrados con las llamadas en orden.

### 2. `openapi.yaml`

OpenAPI 3.1 derivado mecánicamente:

- Un path por endpoint de `api` (o derivado de `auto`), con verbo, `successStatus` y parámetros de path/query según el input de la operación.
- Schemas de componentes desde `domain` (`entities` y `types`; constraints → `pattern`, `maxLength`, `minimum`…; enums → `enum`).
- `components.securitySchemes` y `security` por operación desde `security` (protocolo → scheme; permisos → scopes cuando el protocolo los soporte).
- Cada error declarado en `use-cases` como respuesta con su status y el schema común `{ code, message }`.
- `info.version` = `service.version`; `info.description` referencia INTEGRATION.md.

Valida el resultado con `npx --yes @redocly/cli@latest lint docs/<service.name>/openapi.yaml` y corrige hasta que pase.

### 3. `postman/` — colecciones listas para importar

Formato exacto, plantillas y checklist en `references/postman-collection-guide.md` (léela antes de escribirlas). Dos archivos:

- **`postman/<service.name>-collection.json`** — **se regenera siempre**. Una carpeta por flujo `FL-*` de `specs/<servicio>/validation-scenarios.md` con una request por escenario (felices y de error; nombre `FL-XXX · <letra> — <título> (<status>)`) cuyo script `test` asserta el status del Then; más una carpeta «Operaciones» con una request por endpoint de `api` no cubierto por los flujos (body de ejemplo desde el input de la operación, coherente con los ejemplos de INTEGRATION.md). `{{baseUrl}}` como variable de colección; con capa `security`, header `Authorization: Bearer {{token_<rol-kebab>}}` según `access`.
- **`postman/auth-collection.json`** — **idempotente: si ya existe, no lo toques** (puede tener ajustes manuales del equipo); solo repórtalo. Una request de token por rol usado (`security.roles` / roles de los flujos), cada una con `pm.globals.set('token_<rol-kebab>', ...)`. El endpoint de token y las credenciales van como **variables de colección** (`{{tokenUrl}}`, `{{clientId}}`…): el diseño es agnóstico de proveedor; quien importa la colección las rellena según su stack (la guía documenta los valores típicos).

## Coherencia

INTEGRATION.md, openapi.yaml y las colecciones Postman deben contar exactamente la misma historia: mismos paths, mismos códigos de error, mismos campos, misma seguridad. Ante regeneración, sobrescribe todo por completo (no edites incrementalmente) — con la única excepción de `postman/auth-collection.json`, que no se pisa si existe.
