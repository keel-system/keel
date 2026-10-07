# Corrida `product-catalog` — keel-nest, v2 (con la idempotencia de petición generada)

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.1.0 (DSL 2.19, relacional, 4 capas) |
| Stack | `postgresql` |
| Generador | `keel-nest@0.0.1` (con el incremento 10a) |
| Diseño listo al generar | no, con --accept-unready (design-doc, flow-review, gaps, review, structural, undecided) |
| Matriz final | **23/23 OK** |
| Huella del agente | 150 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Huecos del diseño | 0 |
| Huecos del generador | 0 |
| Convertidos en id | |

La corrida que mide el incremento 10a contra la primera (`2026-10-06-product-catalog-nest.md`): mismo
diseño, mismos escenarios, el generador con la idempotencia de petición ya emitida.

## Lo que cambió

| | v1 | v2 | keel-spring |
|---|---|---|---|
| Matriz | 23/23 (22 en la primera pasada) | **23/23 a la primera** | 23/23 |
| Reescritos | 12 | **7** | 6 |
| Archivos de build de infraestructura tocados | 5 (mediator, controlador, módulo, DataSource, comando) | **0** | 0 |
| Registro de idempotencia | propio (`idempotency_keys`, SQL de PostgreSQL) | **el generado** (`idempotency_record`) | `idempotency_record` |

Los 7 reescritos: los 5 handlers y el agregado (lo mismo que keel-spring) más el `README.md`, que es la
guía de despliegue del paso 5 del orquestador. Ningún archivo nuevo en `src/` salvo el baseline de
migraciones. El handler de `createProduct` es exactamente el algoritmo de la nota del stub: sin
cabecera ejecuta sin deduplicar, firma con `CommandSignature`, reproduce desde `resourceId`, lanza
`IdempotencyReuseException` con otra firma y reclama la clave ANTES del negocio.

Sin `harnessPatches`, sin `culprit: harness`, sin huecos del diseño. `npm test` 65 pruebas y el baseline
verificado en vivo.

## designGaps

(ninguno)
