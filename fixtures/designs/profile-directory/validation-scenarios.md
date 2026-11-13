# profile-directory — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/profile-directory v1.2.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la silueta más simple con capa `security`: la identidad del
> llamante sale de un **claim** del token (`sub`) y no del cuerpo, y el permiso de la regla lo otorga un
> rol (`roleGrants`). Es el diseño de la corrida del incremento 8 de keel-nest, y el mismo documento
> tiene que pasar al 100% contra el servidor de keel-spring.
>
> **v1.1.0** (DSL 2.28): la ficha gana un `email` único y los dos campos que escribe el titular son datos
> personales. Borrarla es lógico: se oculta, se puede restaurar durante 30 días y se purga a los 30 del
> borrado; mientras está borrada, su `subject` y su `email` quedan libres para una ficha viva.
>
> **v1.2.0** (DSL 2.29): cada escritura confirmada de la ficha deja una entrada en su historial (quién, cuándo y
> qué campos, desde qué valor), y el titular lo consulta con `getMyCardHistory`, filtrado por campo y por fechas.
> El historial sigue a la ficha: borrada no se lee, restaurada vuelve con sus entradas y la purga se lo lleva.

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
- **Historial**: `getMyCardHistory` devuelve la página de siempre (`items`, `page`, `size`, `totalElements`,
  `totalPages`, con `size` 20 por defecto) de entradas `{at, author, change, changes}` (`wire-contract.md`
  § Historial), la más reciente primero. `author` es el `sub` del token que escribió. `changes` lleva solo los
  campos que cambiaron, ordenados por `field`, cada uno con `before` y `after` (`null` cuando no había o ya no
  hay); `deleted` y `restored` llevan `changes: []`. El `id` de la ficha no aparece nunca en `changes`: lo pone el
  servidor. Los escenarios fijan cada entrada exacta salvo `at`, que se verifica por forma (ISO-8601 en UTC con tres
  decimales) y por orden, y se reutiliza simbólicamente (`<t1>`, `<t2>`…) como extremo de los filtros `from` y
  `to`, que incluyen el suyo. Cuando un flujo filtra por fechas, deja al menos 10 ms entre una escritura y la
  siguiente, para que sus `at` sean distintos.
- **Historial de una ficha purgada**: la API no lo puede leer, porque la ficha ya no existe para ninguna operación.
  El escenario lo comprueba en el almacén del historial del generador: la tabla `change_history`, con
  `root_type = 'ContactCard'` y `root_id` el texto del `id` de la ficha.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details, correlationId}`.
  Los escenarios fijan el `code` y el status; el resto se verifica por presencia.
- **Credenciales**: sin cabecera `Authorization` la respuesta es `401` `UNAUTHENTICATED`; con un token
  válido que no trae el permiso `card:self` (un usuario autenticado sin ningún rol), `403`
  `ACCESS_DENIED`. Los dos `code` son del catálogo del generador (`framework-errors.md`).

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| getMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007 | usuarios |
| saveMyCard | FL-CRD-001, FL-CRD-002, FL-CRD-003, FL-CRD-005, FL-CRD-006, FL-CRD-008, FL-CRD-009, FL-CRD-010 | usuarios |
| deleteMyCard | FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007, FL-CRD-010 | usuarios |
| restoreMyCard | FL-CRD-003, FL-CRD-004, FL-CRD-005, FL-CRD-006, FL-CRD-007, FL-CRD-010 | usuarios |
| getMyCardHistory | FL-CRD-003, FL-CRD-007, FL-CRD-008, FL-CRD-009, FL-CRD-010 | usuarios |

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
**When**: `getMyCard` — `GET /api/v1/me/card` — y `getMyCardHistory` — `GET /api/v1/me/card/history` —, los
dos **sin** cabecera `Authorization`.
**Then**:
1. Las dos responden `401` con `code: UNAUTHENTICATED`.

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

**When**: `getMyCard`, `saveMyCard` (`{"displayName": "Sin rol"}`), `deleteMyCard`, `restoreMyCard` y
`getMyCardHistory`, cada uno con el token de un usuario autenticado **sin ningún rol**.
**Then**:
1. Las cinco responden `403` con `code: ACCESS_DENIED`.
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
`{"displayName": "Ana", "email": "ana@example.com"}` (`id` `<card-ana>`), guardada en este flujo con
`saveMyCard` y borrada después con `deleteMyCard`, **hace 31 días** (Convenciones: edad de un borrado). La persona
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

#### FL-CRD-007-C: la purga se lleva también el historial de la ficha purgada

**When**: tras el barrido de FL-CRD-007-B, se consulta el almacén del historial (Convenciones: historial de una
ficha purgada), y `getMyCardHistory` con el token de `sub-bea-002`.
**Then**:
1. En `change_history` no queda ninguna entrada de `<card-ana>`: ni la de su alta ni la de su borrado.
2. El historial de `<card-bea>`, que no venció, sigue entero: `getMyCardHistory` responde `200` con
   `totalElements: 3` y, en este orden, una entrada `restored` y una `deleted`, las dos con `changes: []`, y la
   `created` de su alta, con
   `changes: [{field: "displayName", before: null, after: "Bea"}, {field: "subject", before: null, after: "sub-bea-002"}]`.
   Las tres con `author: "sub-bea-002"`.

## El historial de la ficha

### FL-CRD-008: cada escritura confirmada de la ficha deja una entrada

**Given**: la persona `sub-ana-001` con el rol `card-holder`, sin ficha, y la persona `sub-bea-002` con el
rol `card-holder` y su ficha `{"displayName": "Bea", "email": "bea@example.com"}`, guardada en este flujo con
`saveMyCard`.
**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana", "email": "ana@example.com"}`, y
después `getMyCardHistory` — `GET /api/v1/me/card/history` con el mismo token.
**Then**:
1. `saveMyCard` responde `200`; `getMyCardHistory`, `200` con `page: 0`, `size: 20`, `totalElements: 1` y
   `totalPages: 1`.
2. `items[0]` es exactamente
   `{at: <t1>, author: "sub-ana-001", change: "created", changes: [{field: "displayName", before: null, after: "Ana"}, {field: "email", before: null, after: "ana@example.com"}, {field: "subject", before: null, after: "sub-ana-001"}]}`,
   con `<t1>` un instante con forma ISO-8601 en UTC con tres decimales. El historial de `sub-ana-001` no trae
   nada de la ficha de `sub-bea-002`.

#### FL-CRD-008-B: guardar lo mismo no deja entrada

**When**: `saveMyCard` con el token de `sub-ana-001` y el mismo `{"displayName": "Ana", "email": "ana@example.com"}`,
y después `getMyCardHistory`.
**Then**:
1. `saveMyCard` responde `200` con la misma ficha.
2. `getMyCardHistory` responde `200` con `totalElements: 1`: la única entrada sigue siendo la `created` de `<t1>`.

#### FL-CRD-008-C: cambiar el correo deja una entrada con ese campo y solo ese

**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana", "email": "ana.r@example.com"}`, y
después `getMyCardHistory`.
**Then**:
1. `getMyCardHistory` responde `200` con `totalElements: 2`.
2. `items[0]` es exactamente
   `{at: <t2>, author: "sub-ana-001", change: "updated", changes: [{field: "email", before: "ana@example.com", after: "ana.r@example.com"}]}`,
   con `<t2>` no anterior a `<t1>`.
3. `items[1]` es la entrada `created` de `<t1>`, igual que en FL-CRD-008.

#### FL-CRD-008-D: una escritura rechazada no deja entrada

**When**: `saveMyCard` con el token de `sub-ana-001` y `{"displayName": "Ana", "email": "bea@example.com"}`, el
correo de la ficha viva de `sub-bea-002`; después `getMyCardHistory` con el token de `sub-ana-001`.
**Then**:
1. `saveMyCard` responde `409` con `code: EMAIL_ALREADY_EXISTS`.
2. `getMyCardHistory` responde `200` con `totalElements: 2` y las mismas dos entradas de FL-CRD-008-C: la
   escritura que no se confirmó no dejó entrada.

#### FL-CRD-008-E: la página sigue el orden de las entradas

**When**: `getMyCardHistory` con el token de `sub-ana-001` y `?page=0&size=1`, y después con `?page=1&size=1`.
**Then**:
1. La primera responde `200` con `page: 0`, `size: 1`, `totalElements: 2`, `totalPages: 2` y, en `items`, solo
   la entrada `updated` de `<t2>`.
2. La segunda responde `200` con `page: 1`, `size: 1` y, en `items`, solo la entrada `created` de `<t1>`.

### FL-CRD-009: el historial se filtra por campo y por fechas

**Given**: la persona `sub-ana-001` con el rol `card-holder` y tres guardados de su ficha en este flujo con
`saveMyCard`, en este orden y con al menos 10 ms entre uno y otro (Convenciones: historial):
`{"displayName": "Ana", "email": "ana@example.com"}`, `{"displayName": "Ana María", "email": "ana@example.com"}` y
`{"displayName": "Ana María", "email": "ana.r@example.com"}`.
**When**: `getMyCardHistory` con el token de `sub-ana-001`, sin filtros.
**Then**:
1. Status `200` con `totalElements: 3`.
2. En este orden: la entrada `updated` de `<t3>` con
   `changes: [{field: "email", before: "ana@example.com", after: "ana.r@example.com"}]`; la `updated` de `<t2>`
   con `changes: [{field: "displayName", before: "Ana", after: "Ana María"}]`; y la `created` de `<t1>`, con los
   tres campos de FL-CRD-008. `<t1>`, `<t2>` y `<t3>` son distintos y van de más reciente a más antiguo.

#### FL-CRD-009-B: el filtro por campo deja las entradas que lo cambiaron

**When**: `getMyCardHistory` con el token de `sub-ana-001` y, por separado, `?field=email`,
`?field=displayName`, `?field=subject` y `?field=phone`.
**Then**:
1. `?field=email` → `totalElements: 2`: las entradas de `<t3>` y `<t1>`, en ese orden.
2. `?field=displayName` → `totalElements: 2`: las de `<t2>` y `<t1>`.
3. `?field=subject` → `totalElements: 1`: la de `<t1>`.
4. `?field=phone` → `200` con la página vacía: `items: []`, `totalElements: 0` y `totalPages: 0`. Un campo
   que ninguna entrada cambió no es un error.

#### FL-CRD-009-C: el filtro por fechas incluye sus extremos

**When**: `getMyCardHistory` con el token de `sub-ana-001` y, por separado, `?from=<t2>`, `?to=<t2>` y
`?from=<t2>&to=<t2>`.
**Then**:
1. `?from=<t2>` → las entradas de `<t3>` y `<t2>`, en ese orden.
2. `?to=<t2>` → las de `<t2>` y `<t1>`, en ese orden.
3. `?from=<t2>&to=<t2>` → solo la de `<t2>`.

#### FL-CRD-009-D: los filtros se combinan

**When**: `getMyCardHistory` con el token de `sub-ana-001` y, por separado, `?field=email&from=<t2>` y
`?field=displayName&from=<t3>`.
**Then**:
1. `?field=email&from=<t2>` → solo la entrada de `<t3>`.
2. `?field=displayName&from=<t3>` → la página vacía, con `totalElements: 0`.

### FL-CRD-010: el historial sigue a la ficha viva

**Given**: la persona `sub-ana-001` con el rol `card-holder` y su ficha
`{"displayName": "Ana", "email": "ana@example.com"}`, guardada en este flujo con `saveMyCard`; y la persona
`sub-bea-002` con el rol `card-holder`, sin ficha.
**When**: `deleteMyCard` con el token de `sub-ana-001` y después `getMyCardHistory` con el mismo token.
**Then**:
1. `deleteMyCard` responde `204`.
2. `getMyCardHistory` responde `404` con `code: CARD_NOT_FOUND`: el historial de una ficha borrada no se lee,
   igual que la ficha, y el cuerpo no dice que estuvo.

#### FL-CRD-010-B: restaurar deja una entrada restored y conserva las anteriores

**When**: `restoreMyCard` con el token de `sub-ana-001` y después `getMyCardHistory` con el mismo token.
**Then**:
1. `restoreMyCard` responde `204`; `getMyCardHistory`, `200` con `totalElements: 3`.
2. En este orden: `{at: <t3>, author: "sub-ana-001", change: "restored", changes: []}`,
   `{at: <t2>, author: "sub-ana-001", change: "deleted", changes: []}` y la entrada `created` de `<t1>`, con
   los tres campos de FL-CRD-008: borrar no se llevó las entradas anteriores.

#### FL-CRD-010-C: el historial de otra persona no se alcanza

**When**: `getMyCardHistory` con el token de `sub-bea-002`, primero sin parámetros y después con
`?callerSubject=sub-ana-001`.
**Then**:
1. Las dos responden `404` con `code: CARD_NOT_FOUND`: `sub-bea-002` no tiene ficha, y el titular sale del
   token, nunca de la petición.
