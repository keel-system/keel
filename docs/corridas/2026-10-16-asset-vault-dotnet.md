# Corrida `asset-vault` — keel-dotnet (incremento 13k)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.2 (DSL 2.21, documental, 9 capas), la misma copia que las gemelas del 2026-10-11 |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 13 entero, hasta `a0736fd`) |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** del diseño (33 en el informe: `FL-AST-001-V`, de validación, lo añadió el agente) |
| Huella del agente | 335 archivos registrados por `build`, 0 adoptados, **21 reescritos**, 0 borrados |
| Huecos del diseño | 0 (`design-gaps.yaml` vacío) |
| Huecos del generador | 5, de keel-dotnet (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 14 TODO · 2 consulta · 5 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas del 2026-10-11 |

La primera de las dos corridas de control del incremento 13 de `PLAN-KEEL-DOTNET.md`: almacenamiento (13g), autoría
(13h), caché (13f) y el `embed` de una página, todos juntos sobre MongoDB y con un agente escribiendo contra ellos.

## Cómo terminó

32/32, pero **no a la primera**: la primera puntuación dio 13 FAILED, todos por el mismo defecto del generador (el 1 de
§ Arreglos). La firma del comando (`CommandSignature`) recorría por reflexión el `ReadOnlyMemory<byte>` de una subida,
llegaba a su `Span` —un tipo por referencia, que la reflexión no puede leer— y lanzaba en cada operación con clave de
idempotencia y fichero. El agente lo arregló en el proyecto y lo reportó. `infra/check-idempotency.sh` en verde (6/6),
sin `harnessPatches` ni falsos negativos.

## Comparación

| | keel-dotnet | keel-nest (v2) | keel-spring (v2) |
|---|---|---|---|
| Matriz | 32/32 (13 FAILED en la primera puntuación) | 32/32 | 32/32 |
| Registrados por build | 335 | 312 | 337 |
| Reescritos | **21** | 18 | 18 |
| Huecos del generador | 5 | 2 | 0 |

Los tres de más son los del generador que keel-spring ya emitía: la lectura por lote del `embed`, el registro del
almacenamiento y la firma de una subida.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los siete handlers de `Application/UseCases/` | TODO legítimo |
| `Domain/Aggregate/{Asset,Owner,AssetRevision}.cs` | TODO legítimo: la creación y las transiciones |
| `Infrastructure/Clients/RenderingHttpAdapter.cs` | TODO legítimo: el resultado degradado |
| `Infrastructure/Messaging/BrokerBindings.cs`, `Infrastructure/Storage/S3FileStorage.cs`, `README.md` | TODO legítimo |
| `Domain/Repository/IAssetRepository.cs` y su adaptador | Consulta: `ListByOwnerIdIn`, el listado acotado por el alcance. Los tres generadores comparten el criterio (`scopedOperation`) |
| `Application/Support/CommandSignature.cs` | **Generador** (arreglo 1) |
| `infra/check-flows.sh` | **Generador** (arreglo 2) |
| `Infrastructure/Storage/StorageRegistration.cs` | **Generador** (arreglo 3): lo pedía la skill, que decía mal dónde aprovisionar |
| `Domain/Repository/IOwnerRepository.cs` y su adaptador | **Generador** (arreglo 4): `FindAllByIdIn` para el `embed` |

**Archivos nuevos del agente**: `MalwareDetectedListener`, `ThumbnailDeliveredListener` y `RabbitOutboxDispatcher` (lo
que pide la skill `keel-dotnet-rabbitmq`), `tests/AssetVault.UnitTests/CommandSignatureFileUploadTests.cs` y los flujos.

## Arreglos

1. **La firma de una subida** (`request-idempotency.js`). `Canonical` firma `ReadOnlyMemory<byte>`/`Memory<byte>` por el
   digest de su contenido, descarta las propiedades de tipo por referencia (`IsByRefLike`), y un fallo de lectura nombra
   el tipo y la propiedad. Lleva la prueba emitida `UnaSubidaEnTransitoSeFirmaPorElDigestDeSuContenido`, falsada en
   `cs-check` con `--sabotage=signature-memory`.
2. **`check-flows.sh` no reconocía un id con dígitos en el prefijo** (`FL-S3-001`): el patrón pasa a `[A-Za-z]+[0-9]+`.
   Una prueba de `integration-harness.test.js` ejecuta el script, y sale roja con el patrón viejo.
3. **El aprovisionamiento de los buckets**: `S3FileStorage` es también `IHostedService` (`StartAsync` con la guarda
   `EnsureBucketsOnStartup`), y `StorageRegistration` lo registra entero. La skill `keel-dotnet-s3` ya no pide tocar el
   registro.
4. **La lectura por lote del `embed`**: `<Raíz>RefResolver` en `Application/Support` y `FindAllById` en el puerto y en
   los dos adaptadores, con la decisión neutral de `keel-core/gen/ref-targets` (la de keel-spring y keel-nest). Lo
   miden `test/ref-resolvers.test.js` y la sonda `FindAllByIdTraeLosQueExistenEnUnaConsulta` de `db-check` y
   `doc-check` (sabotaje `id-batch`).
5. **`UploadOnReplica`** en el arnés, para los escenarios de clúster con subida: el agente tuvo que componer la
   petición multipart a mano contra la réplica.

## designGaps

Ninguno.
