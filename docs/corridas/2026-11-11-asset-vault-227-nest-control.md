# Corrida de control de la lectura acotada (DSL 2.27) — `asset-vault` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.3 (DSL 2.27, documental, 9 capas), con `scoping.reads: [getAsset, listAssets]` y `readMiss: forbidden` |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` (telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`51878aab` al refrescar con `build --refresh --prune`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** a la primera (sin arbitrajes) |
| Huella del agente | 353 archivos registrados por `build`, 0 adoptados, **14 reescritos**, 0 borrados |
| Clasificación de la huella | 13 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1, no reportado (el informe dice «Ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\vault-227-nest-mongo-rabbit\services\asset-vault-nest`. Corrida de control del incremento 8
de `PLAN-DSL-227-LECTURA-ACOTADA.md`, gemela de `2026-11-10-asset-vault-227-spring-control.md`: el mismo diseño y el mismo
stack, con keel-nest.

## Lo que medía

- **La carga de la ficha acotada y la fila ajena**: FL-AST-003-D (la ficha de un propietario fuera del alcance, 403) y
  FL-AST-004-B (el listado acotado), en verde.
- **El cliente exento**: FL-AST-003-E (el renderizador lee cualquier ficha), en verde.
- **Los mecanismos del documental con RabbitMQ**: outbox, reclamo del barrido e idempotencia entre dos réplicas
  (FL-CLU-001 a -003), cuarentena, reconciliación y entregas de miniatura, en verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 38 casos, 0 fallos, 32 `FL-*` distintos.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`. Los 13 reescritos de código partían
  de un TODO:
  - Los siete handlers, `asset.ts`, `owner.ts` y `asset-revision.ts`.
  - `rendering-http-adapter.ts`: el fallback `onUnavailable: degrade`, que devuelve la miniatura nula.
  - `broker-bindings.ts`: el dispatcher del outbox y los dos listeners de RabbitMQ, con la skill `keel-nest-rabbitmq`.
  - `s3-file-storage.ts`: el adaptador S3, con la skill `keel-nest-s3`.

  `README.md` solo gana una sección «Despliegue en producción», que no es una decisión.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Contra la gemela de keel-spring

| | keel-spring | keel-nest |
|---|---|---|
| Matriz | 32/32 | 32/32 |
| Reescritos | 13 (con `application.yaml`, por `max-part-count`) | 14 (con los adaptadores de broker y S3, que en keel-nest son TODO) |
| Huecos del generador | 1 (`max-part-count`, arreglado) | 0 |

## designGaps

- `quarantine-last-scanned-at` — `quarantine` no toca `lastScannedAt`, igual que en keel-spring. El agente eligió, pero el
  informe no lo cuenta (no reportado). Es la segunda corrida con este hueco, y la decisión salió igual en los dos generadores.
