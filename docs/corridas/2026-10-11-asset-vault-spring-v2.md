# Corrida `asset-vault` — keel-spring, de control (la v2 de `2026-10-11-asset-vault-spring.md`)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.2 (DSL 2.21, documental, 9 capas): `exemptClients: [rendering-service]` y `reconcileScans.dispatches: [quarantineAsset]` |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-spring@0.1.6` (con los arreglos de la corrida anterior, el reintento del NOT_FOUND, el DSL 2.21 y el puerto de la caché) |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** (los 32 ids leídos del XML JUnit) |
| Huella del agente | 337 archivos registrados por `build`, 0 adoptados, **18 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml (1 real del generador, 1 del arnés, 1 que no lo es) |
| Huecos del generador | 2 en la huella, 1 como designGap (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 12 TODO · 6 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la v1.1.0 más los parches 1.1.1 y 1.1.2 |

Dos puntuaciones: 31 OK + 1 FALLO (FL-CLU-002, `culprit: test`: un `hasSize(11)` global contaba también las
llamadas de FL-CLU-001 al mismo WireMock) → 32/32.

## Lo que midió (frente a la corrida anterior)

De 25 reescritos a 18, y **ninguno es ya del generador**. Lo que la corrida anterior tuvo que escribir y esta no:

- `MongoIdempotencyStore`, `ApiExceptionHandler`, `AssetV1Controller` y `application.yaml` intactos: el WriteConflict
  de la clave de idempotencia, el 400 de `HandlerMethodValidationException`, la cota del `@RequestParam` y
  `max-part-count` aguantaron.
- `CallerScope` y `JwtCallerScope` intactos: `exemptClients` (DSL 2.21) reemplaza al scope `asset:read` que
  inventó el agente.
- **Ningún archivo nuevo de mecanismo**: ni `AfterCommit`, ni `CommandDispatcher` (el handler de `reconcileScans`
  usa el que emite build), ni puerto de caché propio (`GetAssetQueryHandler` usa `OperationCache.getOrLoad` con
  el predicado de la ficha degradada). Los archivos nuevos son solo los adaptadores que son del agente: S3, los
  dos listeners, el dispatcher del outbox y la configuración de RabbitMQ.
- `RETRIES_NOT_FOUND` sale con el destino de `MalwareDetected` (`asset-vault.security-scanner`).

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (12) | `README.md`; los 7 handlers; `Asset`, `Owner`, `AssetRevision`; `RenderingHttpAdapter` (el `degrade` de `getThumbnail`) |
| Consulta de negocio (6) | `AssetRepository`, `AssetMongoRepository`, `AssetRepositoryImpl` (`existsByChecksum`, `listByOwnerIds`); `OwnerRepository`, `OwnerMongoRepository`, `OwnerRepositoryImpl` (`findAllByCodeIn`) |

## Arreglos

1. **La clave saliente `keyFrom: correlation` no distinguía dos peticiones de la misma ejecución** (designGap de
   FL-CLU-002, que el agente atribuyó al diseño). Era `call + correlationId`: el barrido que revalida varios
   archivos en el mismo tick mandaba la MISMA `Idempotency-Key` para todos, y un proveedor que la honra se queda
   con el primero. Ahora es `call + correlationId + payload` en los dos generadores: el reintento repite petición
   y correlación, y por tanto clave; dos archivos del mismo tick, no. El diseño estaba bien: `correlation` dice
   «dos ejecuciones distintas de la misma petición se ejecutan las dos», no «una ejecución, una clave».
2. **El finder de un campo `unique` suelto** (`findByChecksum`): tercera corrida que lo escribe (dos de
   keel-spring, una de keel-nest). `uniqueFieldFinders` en los dos generadores, sobre `uniqueFields` de keel-core.
3. **La resolución del claim del alcance** (`findAllByCodeIn`): tercera corrida también. Es el lote de la clave
   natural con un motivo nuevo, `scope-claim` en `naturalKeyBatchReason`: la clave natural es el `over` del
   alcance y el claim enumera los valores.

Queda en la consulta `listByOwnerIds` (el listado de los archivos de esos propietarios): es la consulta del caso de
uso, no un mecanismo.

## designGaps

- `outbound-key-per-execution` — la `Idempotency-Key` de `scanAsset` (`keyFrom: correlation`) era la misma para
  todos los archivos de un tick. **Real, pero del generador**, no del diseño (arreglo 1).
- `test-realm-claim-values` — los escenarios usan un `vault-reader` con `vaults=["OTRO"]` y el realm de prueba no lo
  siembra. Del arnés, **tercera vez** (las dos corridas de asset-vault de keel-spring y la de keel-nest): `tokenAs`
  solo existe en los diseños que identifican al llamante por `sub`, y en uno con alcance no hay forma de pedir un
  usuario no exento con otro valor del claim. Pendiente: un `tokenWithScope(rol, valores…)` en los dos arneses.
- `response-shape-without-contract` — la forma de la ficha `Asset`. La fijan `mapping.md` y el contrato del cable:
  no es hueco. Lo que pide el agente es un `openapi.yaml` para asertar en STRICT, y lo pide también la de catalog.
