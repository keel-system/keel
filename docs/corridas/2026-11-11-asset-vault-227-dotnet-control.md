# Corrida de control de la lectura acotada (DSL 2.27) — `asset-vault` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.3 (DSL 2.27, documental, 9 capas), con `scoping.reads: [getAsset, listAssets]` y `readMiss: forbidden` |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` (telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`4da2c080` al refrescar con `build --refresh --prune`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** (primera puntuación con código 2, por una siembra de las pruebas; sin arbitrajes) |
| Huella del agente | 385 archivos registrados por `build`, 0 adoptados, **14 reescritos**, 0 borrados |
| Clasificación de la huella | 13 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1, no reportado (el informe dice «Ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\vault-227-dotnet-mongo-rabbit\services\asset-vault-dotnet`. Corrida de control del
incremento 8 de `PLAN-DSL-227-LECTURA-ACOTADA.md`, gemela de `2026-11-10-asset-vault-227-spring-control.md` y de
`2026-11-11-asset-vault-227-nest-control.md`: el mismo diseño y el mismo stack, con keel-dotnet.

## Lo que medía

Lo mismo que sus gemelas: la ficha acotada y la fila ajena (FL-AST-003-D, FL-AST-004-B), el cliente exento (FL-AST-003-E)
y los mecanismos del documental con RabbitMQ (FL-CLU-001 a -003, cuarentena, reconciliación, entregas). Todo en verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 39 casos, 0 fallos, 32 `FL-*` distintos.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`. Los 13 reescritos de código partían
  de un TODO:
  - Los siete handlers, `Asset.cs`, `Owner.cs` y `AssetRevision.cs`.
  - `RenderingHttpAdapter.cs`: el fallback `onUnavailable: degrade`.
  - `BrokerBindings.cs`: el dispatcher del outbox y los listeners de RabbitMQ.
  - `S3FileStorage.cs`: el adaptador S3.

  `README.md` solo gana una sección «Despliegue en producción», como en keel-nest.
- La primera puntuación (código 2): los 11 flujos que siembran propietarios no arrancaban. `AssetFlowBase.cs`, escrito por
  el agente de pruebas, sembraba `lock_version` con `NumberLong(0)`, y mongosh imprimía su aviso de deprecación en vez de
  `true`. Lo corrigió el propio agente con `NumberLong("0")`. Ni el generador ni sus docs enseñan esa forma (no aparece en
  `keel-dotnet` ni en `keel-core/gen`), así que no es un hueco del generador.
- `keel-dotnet-quality`: 199/199 pruebas unitarias e índices vivos en verde.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Contra las gemelas

| | keel-spring | keel-nest | keel-dotnet |
|---|---|---|---|
| Matriz | 32/32 | 32/32 | 32/32 |
| Reescritos | 13 | 14 | 14 |
| Huecos del generador | 1 (`max-part-count`, arreglado) | 0 | 0 |

## designGaps

- `quarantine-last-scanned-at` — `Quarantine` no toca `LastScannedAt`: solo lo renuevan `publishAsset` y
  `reconcileScans` (`RecordScan`). Es la misma decisión que en keel-spring y en keel-nest, y aquí tampoco se reporta (no
  reportado). Van tres corridas con este hueco.
