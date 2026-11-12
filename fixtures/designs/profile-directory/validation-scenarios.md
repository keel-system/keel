# profile-directory — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/profile-directory v1.1.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la silueta más simple con capa `security`: la identidad del
> llamante sale de un **claim** del token (`sub`) y no del cuerpo, y el permiso de la regla lo otorga un
> rol (`roleGrants`). Es el diseño de la corrida del incremento 8 de keel-nest, y el mismo documento
> tiene que pasar al 100% contra el servidor de keel-spring.
>
> **v1.1.0** (DSL 2.28): la ficha gana un `email` único y los dos campos que escribe el titular son datos
> personales. Borrarla es lógico: se oculta, se puede restaurar durante 30 días y se purga a los 30 del
> borrado; mientras está borrada, su `subject` y su `email` quedan libres para una ficha viva.

## Convenciones de determinación

- **Identidad del llamante**: el titular es el claim `sub` del token. Los escenarios hablan de
  **personas** con un `sub` elegido (`sub-ana-001`, `sub-bea-002`), cada una con el rol `card-holder`;
  el arnés las da de alta con ese `sub` exacto. Nada en el cuerpo ni en la ruta identifica al titular:
  un `callerSubject` en el cuerpo se ignora.
- **Identificadores**: el `id` de la ficha es un uuid generado por el servidor. Se verifica por forma y
  por reutilización simbólica dentro del flujo (`<card-ana>` es el `id` que devolvió el alta de Ana).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** (`conventions.nulls: include` en el
  manifiesto). Una ficha sin nombre trae `displayName: null`, y una sin correo `email: null`, nunca sin
  la clave.
- **Reemplazo**: `saveMyCard` reemplaza la ficha **entera**. Un `displayName` o un `email` que no llega
  deja ese campo a `null`; no conserva el anterior.
- **Texto**: `displayName` admite hasta 100 caracteres y `email` hasta 254; los dos se guardan tal cual
  llegan (sin recortar espacios ni cambiar mayúsculas), y la unicidad del `email` compara exacto:
  `ana@example.com` y `Ana@example.com` son correos distintos.
- **Borrado**: `deleteMyCard` responde `204` sin cuerpo. Una ficha borrada no existe para ninguna
  operación de la API salvo `restoreMyCard`: `getMyCard`, `deleteMyCard` y `saveMyCard` se comportan
  como si el titular no tuviera ficha (404, o una ficha **nueva** con otro `id`). El cuerpo nunca dice
  que una ficha estuvo borrada: no hay `410`.
- **Edad de un borrado**: los escenarios que necesitan una ficha borrada hace más de 30 días lo dicen
  en el Given («borrada hace 31 días»). No se espera: el arnés retrasa la marca de borrado de esa fila
  directamente en la base, y la ventana de `restoreMyCard` y la retención la leen igual que en
  producción.
- **Retención**: el barrido que purga las fichas borradas hace más de 30 días no lo dispara ninguna
  operación, sino su cron. Los escenarios lo adelantan en el cronómetro (el recurrente
  `retention:ContactCard`) y esperan a que una réplica lo ejecute, como en producción.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details, correlationId}`.
  Los escenarios fijan el `code` y el status; el resto se verifica por presencia.
- **Credenciales**: sin cabecera `Authorization` la respuesta es `401` `UNAUTHENTICATED`; con un token
  válido que no trae el permiso `card:self` (un usuario autenticado sin ningún rol), `403`
  `ACCESS_DENIED`. Los dos `code` son del catálogo del generador (`framework-errors.md`).

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| getMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007 | usuarios |
| saveMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003, FL-CRD-005, FL-CRD-006 | usuarios |
| deleteMyCard | FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007 | usuarios |
| restoreMyCard | FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007 | usuarios |

## La ficha del titular

### FL-CRD-001: el titular crea, consulta y reemplaza su ficha

**Given**: la persona `sub-ana-001` con el rol `card-holder`, sin ficha.
**When**: `getMyCard` — `GET /api/v1/me/card` con el token de `sub-ana-001`.
**Then**:
1. Status `404` con `code: CARD_NOT_FOUND`.

#### FL-CRD-001-B: el primer guardado crea la ficha

**When**: `saveMyCard` — `PUT /api/v1/me/card` con el token de `sub-ana-001` y
`{"displayName": "Ana", "email": "ana@example.com"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana", email: "ana@example.com"}`, con
   `<card-ana>` con forma de uuid.

#### FL-CRD-001-C: la ficha se lee tal como se guardó

**When**: `getMyCard` — `GET /api/v1/me/card` con el token de `sub-ana-001`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana", email: "ana@example.com"}`: el mismo
   `id` del alta.

#### FL-CRD-001-D: guardar otra vez reemplaza la misma ficha

**When**: `saveMyCard` con el token de `sub-ana-001` y
`{"displayName": "Ana María", "email": "ana@example.com"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana María", email: "ana@example.com"}`: el
   **mismo** `id`, no una ficha nueva, y su propio correo no choca consigo mismo.
3. `getMyCard` con el mismo token devuelve ese mismo cuerpo.

#### FL-CRD-001-E: un guardado vacío deja la ficha sin nombre y sin correo

**When**: `saveMyCard` con el token de `sub-ana-001` y `{}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente `{id: <card-ana>, subject: "sub-ana-001", displayName: null, email: null}`:
   el reemplazo es entero y no conserva `"Ana María"` ni el correo.
3. `getMyCard` con el mismo token devuelve `displayName: null`, `email: null` y el mismo `id`.

#### FL-CRD-001-F: un nombre de más de 100 caracteres se rechaza

**When**: `saveMyCard` con el token de `sub-ana-001` y un `displayName` de **101** caracteres.
**Then**:
1. Status `400` con `code: VALIDATION_ERROR`.
2. La ficha no cambia: `getMyCard` con el mismo token devuelve
   `{id: <card-ana>, subject: "sub-ana-001", displayName: null, email: null}`.

**Casos borde**:
- `displayName` de exactamente 100 caracteres → `200`, y se guarda entero.
- `email` de 255 caracteres → `400` `VALIDATION_ERROR`; de exactamente 254 → `200`, y se guarda entero.

## Cada titular, su ficha

### FL-CRD-002: dos titulares no se ven ni se pisan

**Given**: la persona `sub-ana-001` con el rol `card-holder`, sin ficha, y la persona `sub-bea-002` con
el rol `card-holder`, sin ficha.
**When**: `saveMyCard` con el token de `sub-ana-001` y
`{"displayName": "Ana", "email": "ana@example.com"}`.
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
2. El cuerpo es exactamente
   `{id: <card-bea>, subject: "sub-bea-002", displayName: "Intrusa", email: null}`, con `<card-bea>`
   con forma de uuid y **distinto** de `<card-ana>`: el `callerSubject` del cuerpo se ignora y la ficha
   creada es la de `sub-bea-002`.
3. `getMyCard` con el token de `sub-ana-001` sigue devolviendo exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana", email: "ana@example.com"}`.

#### FL-CRD-002-D: dos fichas vivas no comparten correo

**When**: `saveMyCard` con el token de `sub-bea-002` y
`{"displayName": "Bea", "email": "ana@example.com"}`.
**Then**:
1. Status `409` con `code: EMAIL_ALREADY_EXISTS`.
2. La ficha de `sub-bea-002` no cambia: `getMyCard` con su token devuelve exactamente
   `{id: <card-bea>, subject: "sub-bea-002", displayName: "Intrusa", email: null}`.

**Casos borde**:
- `{"displayName": "Bea", "email": "Ana@example.com"}` → `200`: la unicidad compara exacto, y es otro
  correo.

## Credenciales

### FL-CRD-003: sin credencial válida, o sin el permiso, no hay ficha

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha `{"displayName": "Ana"}`,
guardada en este flujo con `saveMyCard`.
**When**: `getMyCard` — `GET /api/v1/me/card` **sin** cabecera `Authorization`.
**Then**:
1. Status `401` con `code: UNAUTHENTICATED`.

#### FL-CRD-003-B: guardar, borrar o restaurar sin credencial no escribe nada

**When**: `saveMyCard` — `PUT /api/v1/me/card` **sin** cabecera `Authorization` y
`{"displayName": "Anónimo"}`; después `deleteMyCard` — `DELETE /api/v1/me/card` — y `restoreMyCard` —
`POST /api/v1/me/card/restore` —, los dos también **sin** cabecera `Authorization`.
**Then**:
1. Las tres responden `401` con `code: UNAUTHENTICATED`.
2. `getMyCard` con el token de `sub-ana-001` sigue devolviendo `displayName: "Ana"`: ni se reemplazó ni
   se borró.

#### FL-CRD-003-C: un token que no es válido es 401

**When**: `getMyCard` con la cabecera `Authorization: Bearer no-es-un-token`.
**Then**:
1. Status `401` con `code: UNAUTHENTICATED`.

#### FL-CRD-003-D: autenticado sin el permiso card:self es 403

**When**: `getMyCard`, `saveMyCard` (`{"displayName": "Sin rol"}`), `deleteMyCard` y `restoreMyCard`,
cada uno con el token de un usuario autenticado **sin ningún rol**.
**Then**:
1. Las cuatro responden `403` con `code: ACCESS_DENIED`.
2. `getMyCard` con el token de `sub-ana-001` sigue devolviendo `displayName: "Ana"`.

## Borrar y restaurar

### FL-CRD-004: la ficha borrada desaparece y se puede restaurar

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha (`ContactCard`)
`{"displayName": "Ana", "email": "ana@example.com"}`, guardada en este flujo con `saveMyCard`, con `id`
`<card-ana>`.
**When**: `deleteMyCard` — `DELETE /api/v1/me/card` con el token de `sub-ana-001`.
**Then**:
1. Status `204`, sin cuerpo.
2. `getMyCard` con el mismo token responde `404` con `code: CARD_NOT_FOUND`: la `ContactCard` borrada ya
   no está para la API, y el cuerpo no dice que estuvo.

#### FL-CRD-004-B: borrar una ficha ya borrada es 404

**When**: `deleteMyCard` otra vez con el token de `sub-ana-001`.
**Then**:
1. Status `404` con `code: CARD_NOT_FOUND`, el mismo que si nunca hubiera tenido ficha.

#### FL-CRD-004-C: restaurarla dentro de los 30 días la devuelve tal como estaba

**When**: `restoreMyCard` — `POST /api/v1/me/card/restore` con el token de `sub-ana-001`.
**Then**:
1. Status `204`, sin cuerpo.
2. `getMyCard` con el mismo token devuelve exactamente
   `{id: <card-ana>, subject: "sub-ana-001", displayName: "Ana", email: "ana@example.com"}`: la
   **misma** ficha, con su `id` y sus datos, no una nueva.

#### FL-CRD-004-D: sin ficha borrada no hay nada que restaurar

**When**: `restoreMyCard` otra vez con el token de `sub-ana-001`, con la ficha ya viva.
**Then**:
1. Status `404` con `code: CARD_NOT_FOUND`.
2. `getMyCard` con el mismo token sigue devolviendo la ficha `<card-ana>` sin cambios.

## La clave de una ficha borrada

### FL-CRD-005: el titular puede volver a crear su ficha, y entonces la borrada no vuelve

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha (`ContactCard`)
`{"displayName": "Ana", "email": "ana@example.com"}`, guardada en este flujo con `saveMyCard` (`id`
`<card-ana>`) y borrada después con `deleteMyCard`.
**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana otra vez"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente
   `{id: <card-ana-2>, subject: "sub-ana-001", displayName: "Ana otra vez", email: null}`, con
   `<card-ana-2>` con forma de uuid y **distinto** de `<card-ana>`: el `subject` de la ficha borrada se
   puede volver a usar, y lo que se crea es una ficha nueva.

#### FL-CRD-005-B: restaurar con el titular ya en otra ficha viva es 409

**When**: `restoreMyCard` con el token de `sub-ana-001`.
**Then**:
1. Status `409` con `code: CARD_ALREADY_EXISTS`: la ficha borrada `<card-ana>` está dentro de su
   ventana, pero su `subject` lo ocupa `<card-ana-2>`.
2. `getMyCard` con el mismo token sigue devolviendo exactamente
   `{id: <card-ana-2>, subject: "sub-ana-001", displayName: "Ana otra vez", email: null}`.

### FL-CRD-006: el correo de una ficha borrada queda libre

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha (`ContactCard`)
`{"displayName": "Ana", "email": "ana@example.com"}`, guardada en este flujo con `saveMyCard` (`id`
`<card-ana>`) y borrada después con `deleteMyCard`; y la persona `sub-bea-002` con el rol
`card-holder`, sin ficha.
**When**: `saveMyCard` con el token de `sub-bea-002` y
`{"displayName": "Bea", "email": "ana@example.com"}`.
**Then**:
1. Status `200`.
2. El cuerpo es exactamente
   `{id: <card-bea>, subject: "sub-bea-002", displayName: "Bea", email: "ana@example.com"}`: el correo
   de la ficha borrada se puede volver a usar.

#### FL-CRD-006-B: restaurar con el correo ocupado por otra ficha viva es 409

**When**: `restoreMyCard` con el token de `sub-ana-001`.
**Then**:
1. Status `409` con `code: EMAIL_ALREADY_EXISTS`: la ficha `<card-ana>` está dentro de su ventana y su
   `subject` está libre, pero su correo lo ocupa la ficha de `sub-bea-002`.
2. `getMyCard` con el token de `sub-ana-001` sigue respondiendo `404` con `code: CARD_NOT_FOUND`: la
   restauración no se hizo a medias.
3. `getMyCard` con el token de `sub-bea-002` sigue devolviendo `<card-bea>` con
   `email: "ana@example.com"`.

## La ventana y la retención

### FL-CRD-007: pasados 30 días, la ficha borrada ya no se restaura

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha (`ContactCard`)
`{"displayName": "Ana", "email": "ana@example.com"}`, guardada en este flujo con `saveMyCard` y borrada
después con `deleteMyCard`, **hace 31 días** (Convenciones: edad de un borrado). La persona
`sub-bea-002` con el rol `card-holder` y su ficha `{"displayName": "Bea"}` (`id` `<card-bea>`),
guardada y borrada en este flujo, **hoy**.
**When**: `restoreMyCard` con el token de `sub-ana-001`.
**Then**:
1. Status `409` con `code: CARD_NOT_RESTORABLE`.
2. `getMyCard` con el mismo token sigue respondiendo `404` con `code: CARD_NOT_FOUND`.

#### FL-CRD-007-B: la retención purga la ficha borrada hace más de 30 días, y solo esa

**When**: se ejecuta el barrido de retención de `ContactCard` (adelantado en el cronómetro,
Convenciones: retención), y después `restoreMyCard` con el token de `sub-ana-001`.
**Then**:
1. La ficha borrada de `sub-ana-001` se purga: `restoreMyCard` responde ahora `404` con
   `code: CARD_NOT_FOUND`, y no `409` `CARD_NOT_RESTORABLE`, porque ya no le queda ninguna ficha
   borrada que restaurar.
2. La de `sub-bea-002`, borrada hoy, no ha vencido y sigue: `restoreMyCard` con su token responde
   `204`, y `getMyCard` devuelve exactamente
   `{id: <card-bea>, subject: "sub-bea-002", displayName: "Bea", email: null}`.
