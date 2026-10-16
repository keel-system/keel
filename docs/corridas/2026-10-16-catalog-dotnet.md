# Corrida `catalog` — keel-dotnet (incremento 13k)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.21, relacional, 9 capas), la copia de `2026-10-11-catalog-nest-v2.md` |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-dotnet@0.0.1` (incremento 13 entero y los arreglos de la corrida asset-vault, regenerado con `build --refresh --prune`) |
| Diseño listo al generar | sí |
| Matriz final | **56/56 OK** (los 56 escenarios hoja; los 15 `FL-VAL-001-*` no puntúan) |
| Huella del agente | 400 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Huecos del diseño | 0 (2 en `design-gaps.yaml`, ninguno real: ver § designGaps) |
| Huecos del generador | 4, de keel-dotnet (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 21 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas del 2026-10-11 |

La segunda corrida de control del incremento 13: relacional sobre PostgreSQL con Kafka, caché, almacenamiento, réplica
de un `need`, `lastKnown`, OAuth2 saliente y los filtros de texto plegados, el diseño más ancho de las fixtures.

## Cómo terminó

56/56, con un arbitraje: tres escenarios del circuito (`FL-RTY-001-B`, `FL-CMP-002` y `FL-CBR-001`) fallaron en la
primera puntuación, todos con `culprit: test`. La causa es del arnés (el arreglo 3): la ventana del circuito vivía de un
flujo al siguiente. El agente los arregló con aserciones tolerantes a la ventana. Sin `harnessPatches`.

La corrida se paró una vez antes de la fase 2: `removeProductImage` tenía que borrar el binario «tras confirmar» y en
Application no había con qué (el arreglo 1). Siguió borrándolo dentro de la transacción, y lo reportó.

## Comparación

| | keel-dotnet | keel-nest (v2) | keel-spring (v2) |
|---|---|---|---|
| Matriz | 56/56 (3 FAILED en la primera puntuación) | 56/56 | 56/56 |
| Registrados por build | 400 | 372 | 407 |
| Reescritos | **23** | 25 | 28 |
| Huecos del generador | 4 (ninguno en la huella) | 1 | 6 |

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los doce handlers de `Application/UseCases/` | TODO legítimo |
| `Domain/Aggregate/{Category,Product,SupplierPrice}.cs`, `Domain/Entity/ProductImage.cs` | TODO legítimo: la creación y las transiciones |
| `Infrastructure/Clients/PricingHttpAdapter.cs` | TODO legítimo: `getPrice` sirve dos políticas distintas (`lastKnown` y `degrade`), y build lo dice en el TODO |
| `Infrastructure/Clients/LegacyErpHttpAdapter.cs` | TODO legítimo: el resultado degradado |
| `Infrastructure/Messaging/BrokerBindings.cs`, `Infrastructure/Storage/S3FileStorage.cs`, `README.md` | TODO legítimo |
| `Domain/Repository/IProductRepository.cs` y `ProductRepository.cs` | Consulta: el listado por nombre contra la sombra plegada y `FindLatestByCategoryId`, las de las gemelas |

Ninguno de los cuatro huecos del generador está en la huella: estaban en archivos que el agente escribe de todos modos
(un handler, un flujo) o en uno que no tocó (`RowValues.cs`).

## Arreglos

1. **El puerto `IAfterCommit`** (`src/scaffold/after-commit.js`), el gemelo del `AfterCommit` de keel-spring y keel-nest:
   en `Application/Ports`, con su adaptador sobre `PersistenceTransactions.AfterCommitOrNow` y registrado en
   `AddPersistence` en las dos ramas. La constitución lo nombra. `test/after-commit.test.js`.
2. **`RowValues.Unmapped<T>` solo si algún adaptador lo llama**: emitido siempre, era un `NotImplementedException` sin
   uso que el agente de calidad señaló como resto de andamiaje. `test/persistence.test.js` comprueba las dos ramas.
3. **`RestartServerAsync()` en `FlowTest`**, cuando el servidor guarda estado en memoria (un circuito, un token OAuth2
   o el último valor conocido). keel-spring vacía los circuitos en su propio proceso antes de cada escenario; aquí el
   servidor es otro proceso, y reiniciarlo es la única forma de vaciar la ventana sin abrirle un endpoint de pruebas.
   El log del servidor sigue tras el reinicio. La referencia `flows.md` de la skill `keel-dotnet-httpclient` ya no dice
   solo que los flujos comparten el circuito: dice cómo empezar con la ventana vacía.
4. **La nota del filtro plegado nombraba símbolos con la grafía de Java** (`TextFold.foldCaseAndAccents`,
   `Product.nameNormalized`). `textFilterNotes` (`keel-core/gen/text-filters.js`) acepta la grafía de la plataforma, y
   keel-dotnet escribe `FoldCaseAndAccents` y `NameNormalized`.

## designGaps

Ninguno real. Los dos de `design-gaps.yaml` estaban escritos en otra parte:

- **`retireProduct` / FL-CMP-003, el `code` del 500**: el 500 genérico no lleva `code` por contrato, y es el mismo en los
  tres servidores (`keel-core/src/lib/gen/api-errors.js`, `internal`). El escenario lo dice: «sube sin traducir».
- **`getProductBySlug` / FL-IMG-001-C, plazo de la invalidación**: no es asíncrona. El `UseCaseMediator` vacía la caché
  tras el commit y ANTES de responder. La referencia de la skill `keel-dotnet-redis` lo decía a medias («espera al
  COMMIT») y ahora lo dice entero.
