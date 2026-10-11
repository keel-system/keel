# Corrida `asset-vault` — keel-spring (la gemela de la corrida de keel-nest del incremento 13)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.1 (DSL 2.20, documental, 9 capas) |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** |
| Huella del agente | 330 archivos registrados por `build`, 0 adoptados, **25 reescritos**, 0 borrados |
| Huecos del diseño | 6 en design-gaps.yaml (ninguno nuevo y real; ver § designGaps) |
| Huecos del generador | 4, más 1 que escribió como archivo nuevo (ver § Arreglos) |
| Convertidos en id | — (se repite el candidato `exemptClients`) |
| Clasificación de la huella | 13 TODO · 8 consulta · 4 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la v1.1.0 (careo 11→6→6; barrido 32; revisión 18) más el parche 1.1.1 |

Mismo diseño y mismo stack que `2026-10-10-asset-vault-nest.md`, con el único hueco real de aquella cerrado
(v1.1.1: `quarantineAsset` trunca el motivo a 500 en vez de rechazar el hallazgo; sin flujo propio porque el
careo de la 1.1.x estaba agotado). Dos ciclos de código, los dos `culprit: code`, y los dos por la misma carrera
(FL-AST-001-D).

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (13) | `README.md`; los 7 handlers; `Asset.java`, `Owner.java`, `AssetRevision.java`; `RenderingHttpAdapter.java` (el `degrade` de `getThumbnail`) y su puerto `RenderingClient.java` (solo el javadoc del `null` degradado) |
| Consulta de negocio (8) | `CallerScope.java` y `JwtCallerScope.java` (la exención de `rendering-service`); `AssetRepository`, `AssetMongoRepository`, `AssetRepositoryImpl` (`findByChecksum`, el alcance del listado); `OwnerRepository`, `OwnerMongoRepository`, `OwnerRepositoryImpl` (la resolución del claim `vaults`) |
| Hueco del generador (4) | `MongoIdempotencyStore.java`, `ApiExceptionHandler.java`, `AssetV1Controller.java`, `application.yaml` |

Son las mismas clases que en keel-nest (15 · 6 · 2 allí); la consulta cuenta más porque en Spring cada puerto
lleva su interfaz de Spring Data.

**Archivos nuevos del agente** (no cuentan en la huella): el `AfterCommit` con su adaptador —el mismo que
escribió la corrida de catalog, y el mismo que escribieron las dos de keel-nest— y el `CommandDispatcher` con
`MediatorCommandDispatcher`, porque `reconcileScans` despacha `quarantineAsset` por una regla. Además, la caché de
`getAsset` como puerto propio (`GetAssetCache` + adaptador), no con `@Cacheable`: la ficha degradada no se cachea
y el alcance se comprueba también en el acierto, y la anotación no expresa ninguna de las dos cosas.

## Arreglos

1. **La carrera de la clave de idempotencia en Mongo** salía `CONCURRENT_MODIFICATION` y no
   `IDEMPOTENCY_KEY_IN_PROGRESS`. Mientras la petición ganadora no confirma, Mongo no da DuplicateKey sino un
   WriteConflict (112) que el catch generado no veía; el `UseCaseMediator` lo encontraba en la cadena de causas,
   reintentaba el caso de uso y se rendía. Ahora `MongoIdempotencyStore` lo traduce al conflicto de idempotencia
   **sin la causa**. En la rama relacional no ocurre: el INSERT espera al otro y choca con la clave.
2. **`HandlerMethodValidationException` respondía 500.** Desde Spring 6.1 la validación de los parámetros la
   hace MVC y no el proxy de `@Validated`; ahora es 400 `VALIDATION_ERROR`.
3. **La cota de cada etiqueta no llegaba al `@RequestParam`** del multipart: el arreglo de a5bb34d la ponía en el
   record del comando, que en el camino HTTP no valida nadie. El controller usa ahora `elementAnnotatedType`.
4. **`server.tomcat.max-part-count`**: el defecto de Tomcat (10 partes) rechazaba con 500 una subida válida
   de 20 etiquetas antes de validar nada. Build lo calcula de la mayor petición multipart (24 aquí).
5. **`AfterCommit`** lo emite build (`src/scaffold/after-commit.js`), con la nota en `constitution.md`.

## Lo que vuelve al método

- **`exemptClients`**, segunda corrida: el agente lo implementó como scope `asset:read` sin rol `vault-*`, distinto
  de keel-nest (`isMachineClient()`). Dos servidores, dos contratos para la misma regla.
- **El despacho de una operación desde otra**, segunda corrida: `CommandDispatcher` escrito a mano otra vez.
- **La caché del agente**: el puerto que keel-nest emite desde build (`OperationCache`) aquí lo escribió el agente,
  porque la skill `keel-spring-redis` enseña `@Cacheable` y el diseño no cabe en él.
- **Un rechazo de negocio en una suscripción no se reintenta** en ningún generador, y el diseño dice que
  `ASSET_NOT_FOUND` «acaba en la DLQ tras los reintentos». Ver la corrida de catalog, donde sí importa.

## designGaps

- `rendering-service` sin mecanismo propio (`exemptRoles` solo admite roles) — es `exemptClients`, ya candidato.
- `Idempotency-Key` opcional en `uploadAsset` — está decidido (`OBL-IDEM-KEY-REQUIRED` aceptada en `decisions.yaml`). No es hueco.
- `owner` y `ownerId` en la ficha — lo fija `mapping.md`, como aplicó el agente. No es hueco.
- El `storageKey` del Then de FL-AST-002 — el escenario lo afirma sobre la llamada a `/scans`, que el proveedor de prueba registra. No es hueco del diseño.
- `vaults=["OTRO"]` frente al realm de prueba — del arnés, el mismo que en keel-nest (`test-realm-claim-values`).
- El umbral de la reconciliación opaco para la caja negra — está resuelto con `holdFromReconciliation`, la palanca del arnés que existe para eso.
