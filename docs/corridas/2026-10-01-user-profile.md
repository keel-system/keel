# Corrida 2026-10-01 — `user-profile` v0.1.0 del registry

Primera corrida sobre el `user-profile` del registry: el perfil de negocio de cada persona
autenticada, aprovisionado just-in-time desde el token, con lápida, back-office y una superficie
servidor-a-servidor con caché. El proyecto está en `keel-registry/services/user-profile-spring`.
Cerró 146/146, pero con `commandIdempotency` en KO en `check-idempotency.sh`.

| | |
|---|---|
| Diseño | `user-profile` v0.1.0 (DSL 2.18, relacional, 6 capas) |
| Stack | postgresql · rabbitmq · keycloak · redis |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **146/146 OK**; pasadas: arnés KO (índice parcial sobre una tabla residual) → 0/146 (38 `NO_EJERCITADO`, personas sin `sub` fijo) → 146/146 |
| Huella del agente | 344 archivos registrados por `build`, 0 adoptados, **36 reescritos**, 0 borrados |
| Huecos del diseño | 1 en `design-gaps.yaml`, mal diagnosticado (era del método y del generador, no una contradicción del diseño); + 1 que no reportó nadie (las sombras plegadas de la búsqueda) |
| Huecos del generador | 3 (G1–G3), más uno que el informe no recogía (G2) |
| Agujeros de la puerta | 0 |
| Convertidos en id | `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` |

Los 36 reescritos no se han clasificado uno a uno con el agente de contexto limpio, así que falta la
fila `Clasificación de la huella`. Cada afirmación del informe se contrastó con el diseño, con el
código del generador y con el diff entre `planService()` en memoria y el árbol final.

## El informe, afirmación por afirmación

| Afirmación | Veredicto |
|---|---|
| `AbstractFlowIT` no da tokens de persona con `sub` y claims propios | cierta → G3 |
| Keycloak 26 ignora el `id` de `POST /users` | cierta, pero era código del agente (`ProfileFlowSupport`), consecuencia de G3 |
| `DeletedSubject*` salían con `UUID`/`getId()` y su id es `subject: String` | cierta → G1 |
| El gate exige `IdempotencyStore` aunque `keyField` participe en la `naturalKey` | falsa tal como está escrita: `keyField: callerSubject` no participa en `naturalKey: [subject]`, y la guarda se resuelve por nombre → `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL` |
| designGap: «declara `keySource: client-key`» | falsa en el hecho: el diseño declaraba `payload-field`. El agente copió la etiqueta del gate → G2 |
| El índice parcial falló por un `addresses.profile_id` residual de `ddl-auto: update` | plausible: entorno, sin cambio (`reset-db.sh --schema` existe para esto) |
| Riesgo: la caché Redis degrada si no admite `Instant` | infundado: `CacheConfig` ya registra `JavaTimeModule` |

## Hallazgos del generador (arreglados en keel-spring)

- **G1 `root-id-uuid`.** El puerto, Spring Data, los dos adaptadores y el resolver de referencias
  escribían `UUID id` y `getId()` a mano, y una raíz con identidad natural de texto no compilaba
  contra su propio espejo. Ahora los cinco leen `rootId()` de `repositories.js`. El sujeto es
  `MeterDecommission`, en `metering-digest`, que ya está en la cadena de `compile-check`. Falsado:
  con `UUID` forzado caen 3 de los 4 casos de `natural-root-id.test.js` y el control sigue verde.
- **G2 `payload-field-as-client-key`.** Con `payload-field` y guarda de almacén, la nota del stub
  (`services.js`) y el `why` del gate (`idempotency-check.js`) decían `keySource: client-key` y
  mandaban a `IdempotencyContext.get()`, una clase que build no genera con esa guarda. El informe no
  lo recogía, pero es de donde el agente sacó la etiqueta equivocada de su designGap.
- **G3 `persona-tokens`.** Con la identidad del llamante en el claim `sub` y Keycloak, `AbstractFlowIT`
  ofrece ahora `tokenAs(sub, claims)` y `tokenAs(sub, rol, claims)`: alta por `partialImport` con el
  id pedido (y comprobado), mapper `kp_<claim>` por claim, User Profile sin email ni nombre
  obligatorios y credenciales de administración en `test-credentials.env`. Con Cognito no se emite:
  mock-oauth2-server fija los claims con plantillas de valores conocidos, no por petición. El sujeto
  es la fixture nueva `profile-directory`, en `java-syntax` y en `compile-check`, que además cierra la
  excepción de `capability-coverage` para `callerIdentity.from.name`.

## Lo que cambió en el diseño (`user-profile` v0.1.1)

- `provisionProfileFromIdentity` deja de declarar `idempotency`. La guarda es la `naturalKey [subject]`,
  como siempre quiso el diseño, y el registro estructural de `decisions.yaml` dice ahora por qué.
- `UserProfile.contactEmail` y `displayName` declaran `compare: ignore-case-accents`, con lo que build
  emite las sombras que el agente había escrito a mano para la búsqueda de `listProfiles`.

## designGaps

- `idem-keyfield-name-mismatch` — `payload-field` con un `keyField` que solo una `rule` en prosa iguala al campo de la `naturalKey`; la guarda cayó en silencio a un almacén de claves
- `search-compare-on-entity` — el filtro `search` declara `compare`, pero los campos de la entidad sobre los que busca no, y el agente escribió a mano las sombras plegadas
