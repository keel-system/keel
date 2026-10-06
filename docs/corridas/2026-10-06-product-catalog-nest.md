# Corrida `product-catalog` — keel-nest (primera corrida del generador NestJS)

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.1.0 (DSL 2.19, relacional, 4 capas) |
| Stack | `postgresql` |
| Generador | `keel-nest@0.0.1` |
| Diseño listo al generar | no, con --accept-unready (design-doc, flow-review, gaps, review, structural, undecided) |
| Matriz final | **23/23 OK** |
| Huella del agente | 143 archivos registrados por `build`, 0 adoptados, **12 reescritos**, 0 borrados |
| Huecos del diseño | 2 en design-gaps.yaml |
| Huecos del generador | 1 (la idempotencia de petición, ver § Arreglos) |
| Convertidos en id | |

Es el hito del incremento 7 de `PLAN-KEEL-NEST.md`: el primer servidor de keel-nest completado por su
pipeline de agentes, contra el mismo diseño y los mismos escenarios que la corrida gemela de keel-spring
(`2026-10-06-product-catalog-spring.md`, también 23/23).

## Cómo terminó

Primera puntuación 22/23 (FL-PRD-002-B, `culprit: code`), cerrada en un ciclo. `keel-nest-quality`:
`npm test` 65 pruebas en verde, `baseline: OK`, `baselineTested: OK` (verificado en vivo, que en
keel-spring queda `PENDING`). Infraestructura con podman. Sin `harnessPatches`, sin `culprit: harness`,
sin fixes de `infra/`: el arnés de 7b y los gates de 7c funcionaron a la primera.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| 5 handlers + `product.ts` | TODO legítimo (lo mismo que reescribió keel-spring) |
| `README.md` | TODO legítimo (la guía de despliegue, paso 5 del orquestador) |
| `create-product-command.ts`, `product-v1-controller.ts`, `use-case-mediator.ts`, `persistence-module.ts`, `data-source-options.ts` | **hueco del generador**: la idempotencia |

Y cuatro archivos nuevos fuera de `test/`: `idempotency-store.ts`, `idempotency-key-orm.ts` y los dos
errores `IDEMPOTENCY_KEY_*`. Más el baseline (`src/migrations/1000000000000-baseline-schema.ts`), que es
del pase de calidad.

## Arreglos

### La idempotencia de petición: el aviso de la frontera no frenó al agente

`createProduct` declara `idempotency` (client-key, 24 h). keel-nest la genera en el incremento 10, y
`build` lo avisaba. El pipeline siguió, FL-PRD-002/003 la exigían, y el agente de código la **escribió a
mano** tocando cinco archivos que escribe build. Funciona —los escenarios la ejercitan de verdad, y el
informe reconoce que antes del arreglo FL-PRD-002-C y FL-PRD-003 pasaban porque chocaba el sku, no por
deduplicar— pero **no es el servidor de keel-spring**:

- otra tabla: `idempotency_keys (scope, idem_key, request_hash, response, …)` frente a `idempotency_record`
  del esquema neutral;
- SQL a mano solo de PostgreSQL (`$1`, `ON CONFLICT … DO NOTHING`): con `--database=mysql` no funcionaría;
- la clave y la firma inventadas (sha256 del contenido serializado), no la `CommandSignature` de Keel.

Es exactamente lo que la regla de oro del plan pretende evitar: algo que el generador no sabe mapear,
improvisado. Dos lecciones:

1. **Un aviso de frontera no basta cuando un escenario exige el mecanismo**: el agente lo resolverá, y lo
   resolverá distinto. O la frontera rechaza (no se genera), o el mecanismo existe.
2. **La regla «lo que build escribió entero no se reescribe» no aguantó**: el agente la rompió en cinco
   archivos para cumplir un escenario. Ni lo dijo en `blockers` —sí en el informe, a posteriori—.

Arreglo: adelantar del incremento 10 la idempotencia de petición (`idempotency_record`, `CommandSignature`,
el almacén y su uso en el mediator, neutral desde `keel-core/gen` y con su paridad de esquema contra
keel-spring). Mientras no esté, una operación con `idempotency` y escenarios que la ejerciten no debería
pasar el `build` de keel-nest sin `--accept-unready`.

## designGaps

- `invalid-case-bodies` — FL-PRD-001-E no fija el resto del cuerpo de cada petición rechazada: la prueba
  tiene que inventar un cuerpo válido para aislar cada restricción.
- `sensitive-input-type` — qué responde `createProduct` cuando `apiToken` llega con otro tipo; y si
  `Idempotency-Key` es opcional (aceptado en `decisions.yaml` como `OBL-IDEM-KEY-REQUIRED`).
