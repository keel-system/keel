# Corrida `product-catalog` — keel-dotnet (primera corrida del generador)

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.1.0 (DSL 2.21, relacional, 4 capas) |
| Stack | `postgresql` |
| Generador | `keel-dotnet@0.0.1` (incremento 7, con la idempotencia de petición adelantada del 10) |
| Diseño listo al generar | no, con --accept-unready (design-doc, flow-review, gaps, review, structural, undecided) |
| Matriz final | **23/23 OK** |
| Huella del agente | 165 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Huecos del diseño | 0 |
| Huecos del generador | 0 |
| Convertidos en id | |

El hito del incremento 7 de `PLAN-KEEL-DOTNET.md`: el mismo diseño y los mismos escenarios que las corridas de
keel-nest y keel-spring del 2026-10-06, completados por `/keel-generate-dotnet` con sus cinco subagentes contra la
`infra/` real.

## Comparación

| | keel-dotnet | keel-nest v2 | keel-nest v1 | keel-spring |
|---|---|---|---|---|
| Matriz | **23/23 a la primera** | 23/23 a la primera | 23/23 (22 en la primera pasada) | 23/23 |
| Reescritos | **7** | 7 | 12 | 6 |
| Archivos de infraestructura de build tocados | **0** | 0 | 5 | 0 |
| Registro de idempotencia | el generado (`idempotency_record`) | el generado | propio (`idempotency_keys`) | `idempotency_record` |

La huella es la de keel-nest v2 archivo por archivo: los cinco handlers, el agregado y el `README.md`.

## Los reescritos, clasificados

| Archivo | Clase | Qué hizo el agente |
|---|---|---|
| `UseCases/CreateProductCommandHandler.cs` | TODO legítimo | el algoritmo de la nota del stub y de `mapping.md`: sin cabecera ejecuta sin deduplicar, firma con `CommandSignature`, reproduce desde `ResourceId`, lanza `IdempotencyReuseException` con otra firma y reclama la clave ANTES del negocio |
| `UseCases/{Activate,Retire,Get,List}…Handler.cs` | TODO legítimo | cargar, delegar en el agregado, guardar y mapear; la página con `PagedResponse` |
| `Aggregate/Product.cs` | TODO legítimo | `Create(id, …)` con el id que decide el handler, `Activate()`, `Retire()` y la guarda del invariante (`RequireActivePrice`) |
| `README.md` | TODO legítimo | la sección `## Despliegue en producción` del paso 5 del orquestador |

Fuera de lo registrado por build, el agente añadió solo lo esperado: seis clases de flujo (23 `[Scenario]`, uno por
escenario del documento), el baseline de migraciones creado con `dotnet ef` y los `packages.lock.json`.

## Lo que midió la corrida

- **El arnés y los gates funcionaron a la primera**: sin `harnessPatches`, sin `culprit: harness`, sin fixes de
  `infra/` ni de la solución. La caja negra (el proyecto de flujos no ve el servicio) no estorbó al agente de
  pruebas.
- **El baseline salió verificado en vivo**: `verify-baseline.sh` con 24 elementos del esquema idénticos en el modelo
  y en las migraciones (`idempotency_record` incluida). Pruebas emitidas 82/82.
- **La idempotencia adelantada cumplió su propósito**: `FL-PRD-002` y `FL-PRD-003` (la carrera de dos altas con la
  misma clave) pasan con el registro generado. Es el punto en el que keel-nest v1 escribió su propio registro.

## Observaciones, sin acción

- El pase de calidad anotó dos informativos que no tocó: `RowValues.Unmapped<T>` queda sin uso en este diseño, y el
  número de páginas se calcula con `Math.Ceiling` sobre `double` (no es un importe).
- `excalidraw.log`, el log de un servidor MCP del entorno de la sesión, quedó en la raíz del proyecto y entró en el
  commit de cierre. No es del pipeline; no cambia nada medido.

## designGaps

(ninguno)
