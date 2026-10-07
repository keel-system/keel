# profile-directory — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/profile-directory v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la silueta más simple con capa `security`: la identidad del
> llamante sale de un **claim** del token (`sub`) y no del cuerpo, y el permiso de la regla lo otorga un
> rol (`roleGrants`). Es el diseño de la corrida del incremento 8 de keel-nest, y el mismo documento
> tiene que pasar al 100% contra el servidor de keel-spring.

## Convenciones de determinación

- **Identidad del llamante**: el titular es el claim `sub` del token. Los escenarios hablan de
  **personas** con un `sub` elegido (`sub-ana-001`, `sub-bea-002`), cada una con el rol `card-holder`;
  el arnés las da de alta con ese `sub` exacto. Nada en el cuerpo ni en la ruta identifica al titular:
  un `callerSubject` en el cuerpo se ignora.
- **Identificadores**: el `id` de la ficha es un uuid generado por el servidor. Se verifica por forma y
  por reutilización simbólica dentro del flujo (`<card-ana>` es el `id` que devolvió el alta de Ana).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** (`conventions.nulls: include` en el
  manifiesto). Una ficha sin nombre trae `displayName: null`, nunca sin la clave.
- **Reemplazo**: `saveMyCard` reemplaza la ficha **entera**. Un `displayName` que no llega deja la ficha
  con `displayName: null`; no conserva el anterior.
- **Texto**: `displayName` admite hasta 100 caracteres y se guarda tal cual llega (sin recortar
  espacios ni cambiar mayúsculas).
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details, correlationId}`.
  Los escenarios fijan el `code` y el status; el resto se verifica por presencia.
- **Credenciales**: sin cabecera `Authorization` la respuesta es `401` `UNAUTHENTICATED`; con un token
  válido que no trae el permiso `card:self` (un usuario autenticado sin ningún rol), `403`
  `ACCESS_DENIED`. Los dos `code` son del catálogo del generador (`framework-errors.md`).

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| getMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003 | usuarios |
| saveMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003 | usuarios |

## La ficha del titular

### FL-CRD-001: el titular crea, consulta y reemplaza su ficha

**Given**: la persona `sub-ana-001` con el rol `card-holder`, sin ficha.
**When**: `getMyCard` — `GET /api/v1/me/card` con el token de `sub-ana-001`.
**Then**:
1. Status `404` con `code: CARD_NOT_FOUND`.

#### FL-CRD-001-B: el primer guardado crea la ficha

**When**: `saveMyCard` — `PUT /api/v1/me/card` con el token de `sub-ana-001` y `{"displayName": "Ana"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana"}`, con
   `<card-ana>` con forma de uuid.

#### FL-CRD-001-C: la ficha se lee tal como se guardó

**When**: `getMyCard` — `GET /api/v1/me/card` con el token de `sub-ana-001`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana"}`: el mismo
   `id` del alta.

#### FL-CRD-001-D: guardar otra vez reemplaza la misma ficha

**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana María"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana María"}`: el
   **mismo** `id`, no una ficha nueva.
3. `getMyCard` con el mismo token devuelve ese mismo cuerpo.

#### FL-CRD-001-E: un guardado sin nombre deja la ficha sin nombre

**When**: `saveMyCard` con el token de `sub-ana-001` y `{}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-ana>, subject: "sub-ana-001", displayName: null}`: el reemplazo
   es entero y no conserva `"Ana María"`.
3. `getMyCard` con el mismo token devuelve `displayName: null` y el mismo `id`.

#### FL-CRD-001-F: un nombre de más de 100 caracteres se rechaza

**When**: `saveMyCard` con el token de `sub-ana-001` y un `displayName` de **101** caracteres.
**Then**:
1. Status `400` con `code: VALIDATION_ERROR`.
2. La ficha no cambia: `getMyCard` con el mismo token devuelve
   `{id: <card-ana>, subject: "sub-ana-001", displayName: null}`.

**Casos borde**:
- `displayName` de exactamente 100 caracteres → `200`, y se guarda entero.

## Cada titular, su ficha

### FL-CRD-002: dos titulares no se ven ni se pisan

**Given**: la persona `sub-ana-001` con el rol `card-holder`, sin ficha, y la persona `sub-bea-002` con
el rol `card-holder`, sin ficha.
**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana"}`.
**Then**:
1. Status `200` con `subject: "sub-ana-001"` y un `id` `<card-ana>`.

#### FL-CRD-002-B: la otra titular no ve la ficha ajena

**When**: `getMyCard` con el token de `sub-bea-002`.
**Then**:
1. Status `404` con `code: CARD_NOT_FOUND`: la ficha de `sub-ana-001` no es la suya.

#### FL-CRD-002-C: la identidad no se acepta del cuerpo

**When**: `saveMyCard` con el token de `sub-bea-002` y
`{"callerSubject": "sub-ana-001", "displayName": "Intrusa"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-bea>, subject: "sub-bea-002", displayName: "Intrusa"}`, con
   `<card-bea>` con forma de uuid y **distinto** de `<card-ana>`: el `callerSubject` del cuerpo se
   ignora y la ficha creada es la de `sub-bea-002`.
3. `getMyCard` con el token de `sub-ana-001` sigue devolviendo exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana"}`.

## Credenciales

### FL-CRD-003: sin credencial válida, o sin el permiso, no hay ficha

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha `{"displayName": "Ana"}`,
guardada en este flujo con `saveMyCard`.
**When**: `getMyCard` — `GET /api/v1/me/card` **sin** cabecera `Authorization`.
**Then**:
1. Status `401` con `code: UNAUTHENTICATED`.

#### FL-CRD-003-B: guardar sin credencial no escribe nada

**When**: `saveMyCard` — `PUT /api/v1/me/card` **sin** cabecera `Authorization` y
`{"displayName": "Anónimo"}`.
**Then**:
1. Status `401` con `code: UNAUTHENTICATED`.
2. `getMyCard` con el token de `sub-ana-001` sigue devolviendo `displayName: "Ana"`.

#### FL-CRD-003-C: un token que no es válido es 401

**When**: `getMyCard` con la cabecera `Authorization: Bearer no-es-un-token`.
**Then**:
1. Status `401` con `code: UNAUTHENTICATED`.

#### FL-CRD-003-D: autenticado sin el permiso card:self es 403

**When**: `getMyCard` y `saveMyCard` (`{"displayName": "Sin rol"}`), cada uno con el token de un
usuario autenticado **sin ningún rol**.
**Then**:
1. Las dos responden `403` con `code: ACCESS_DENIED`.
2. `getMyCard` con el token de `sub-ana-001` sigue devolviendo `displayName: "Ana"`.
