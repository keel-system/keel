---
name: keel-integrate
description: Genera INTEGRATION.md, el contrato de integración servidor-a-servidor de un servicio (endpoints expuestos a otros servidores + eventos publicados/consumidos) a partir de sus artefactos Keel validados. Usar cuando otro servidor deba consumir este servicio.
argument-hint: "<specs/servicio>"
---

# /keel-integrate — contrato servidor-a-servidor desde el diseño

Produce `INTEGRATION.md`: cómo **otro servidor** se integra con este, sin leer su código ni hablar
con el equipo. Integración aquí significa **servidor consumiendo servidor**, por dos superficies y
solo esas:

1. **Endpoints expuestos a otros servidores** — operaciones de `api` con `audience: services` o `both`.
2. **Eventos** — lo que este servicio publica (y otros consumen) y a lo que se suscribe (lo que otros
   deben publicar para activarlo).

La API de cara al usuario (endpoints `audience: users`, sus flujos, su `openapi.yaml` y Postman) **no**
es cómo un servidor se integra: es responsabilidad de `/keel-docs`, no de esta skill. No la documentes aquí.

Todo se deriva de los artefactos de `specs/<servicio>/`; si algo no se puede derivar, es un hueco del
diseño: repórtalo, no lo inventes. Antes de generar, ejecuta las comprobaciones de `/keel-validate`;
no documentes un diseño inválido.

## Cuándo no hay nada que generar

Si el servicio **no** tiene endpoints M2M (`audience: services`/`both`) **ni** capa `messaging`, no
expone superficie servidor-a-servidor: repórtalo y **no escribas el archivo**.

## Fuentes por sección

| Contenido | Capas fuente |
|-----------|--------------|
| Resumen (qué ofrece a otros servidores) | `service.keel.yaml`, `domain` |
| Endpoints M2M (método, ruta, request/response) | `api` (`audience: services`/`both`), `use-cases` |
| Obtención del token M2M, scopes, clientes máquina | `security` (`serviceAuth`, `serviceClients`) |
| Errores e idempotencia por endpoint | `use-cases` |
| Formas de payload (campos que viajan) | `domain`, `use-cases` |
| Eventos publicados y suscripciones | `messaging`, `use-cases` (`emits`) |

Una capa opcional ausente ⇒ su sección se omite (sin `messaging`, no hay §Eventos; sin endpoints M2M,
no hay §Endpoints).

## Salida: `INTEGRATION.md`

Genera `docs/<service.name>/INTEGRATION.md`. Es **agent-first**: un agente que integra este servicio
en otro sistema debe leerlo de forma determinista sin dejar de ser legible por una persona. **Formato
exacto, esqueleto y plantillas de cada tabla en `references/integration-md-guide.md` — léela antes de
escribir el documento.** Reglas transversales que la guía detalla:

- **Determinismo** — emite exactamente las secciones de abajo, en este orden, con estos encabezados
  literales; nada de secciones ad-hoc. Omite §Endpoints si no hay M2M y §Eventos si no hay `messaging`.
- **Anchors estables** — el encabezado de cada operación y evento es su nombre del DSL en inglés tal
  cual (`### getProductPrice`, `### ProductCreated`), para que el anchor sea predecible y enlazable.
- **Un hecho por fila** — en las tablas de metadatos, cada atributo es su propia fila.
- **Payloads inline** — documenta solo las formas que viajan por M2M o por eventos, donde se usan; sin
  sección de conceptos completa ni lifecycle de cara a usuarios.
- **Derivado o hueco** — si un dato no sale del diseño, es hueco: repórtalo, no lo inventes.
- **Coherencia interna** — el front-matter es un índice derivado 1:1 del cuerpo.
- **Sin OpenAPI ni flujos de usuario** en este documento.

El documento tiene, en orden:

0. **Front-matter YAML** (entre `---`, al inicio) — índice machine-readable **derivado, nunca
   inventado**: `service`, `version`, `domain`, `basePath`, `m2mAuth` (`protocol`, `audience`,
   `validateAudience`), `endpoints[]` (solo `services`/`both`: `name`, `method`, `path`, `access` con
   scopes), `events` (`published[]`/`consumed[]` con canal y `source`) y `errors[]` (catálogo
   deduplicado de las operaciones M2M `{ code, http }`). Coincide 1:1 con el cuerpo.
1. **`## Resumen`** — qué ofrece este servicio a otros servidores, en un párrafo (desde
   `service.description` + su `domain`).
2. **`## Endpoints expuestos a otros servidores`** — abre explicando **cómo obtener el token M2M**:
   con `serviceAuth.protocol: client-credentials`, pedir `clientId`/`clientSecret` y el `tokenUrl` al
   dueño del servicio (agnóstico del proveedor, parámetro de despliegue), solicitar el token con los
   scopes concedidos y la audiencia a validar (`aud`), y enviarlo como `Authorization: Bearer`; con
   `api-key`, recibir la key y enviarla en el header acordado. Nunca secretos: solo el mecanismo.
   Luego una subsección `### <operationName>` por endpoint M2M con: tabla de metadatos de un hecho por
   fila (Endpoint = método + `basePath` + path; Acceso = `level: service` + scopes; Idempotencia),
   bloques **Request**/**Response** con la forma del payload inline (campos + tipos) y ejemplo JSON
   realista, y la **tabla de errores** (`code | HTTP | cuándo | acción recomendada`). La *acción
   recomendada* clasifica cada error: `5xx`/timeout → reintentable; `4xx` de validación → corregir
   input; `409`/`403`/`404` → no reintentar. Ejemplos coherentes a lo largo del documento.
3. **`## Eventos`** — de `messaging`: `### Publicados` (canal lógico, garantía de entrega si
   `reliability: outbox`, qué operaciones los emiten, payload de ejemplo) y `### Suscripciones` (lo que
   **debe publicar** quien quiera activar una operación: origen `source`, canal, **contrato de
   recepción** — envelope, discriminador, `messageId`/clave de dedupe —, payload esperado y política
   `onFailure`).

## Coherencia

Este `INTEGRATION.md` y los derivados de `/keel-docs` (`openapi.yaml`, Postman) salen del mismo
diseño y no pueden contradecirse: mismos endpoints M2M, mismos códigos de error, mismos campos, misma
seguridad. Ante regeneración, sobrescribe el archivo por completo (no edites incrementalmente).
