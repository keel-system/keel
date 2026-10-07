# Corrida `stock-reservation-events` — keel-spring (gemela del incremento 9 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation-events` v1.0.0 (DSL 2.19, relacional, 6 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **14/14 OK** |
| Huella del agente | 220 archivos registrados por `build`, 0 adoptados, **8 reescritos**, 0 borrados |
| Huecos del diseño | 1 que no reportó nadie (`late-outcome-after-release`, ver § designGaps) |
| Huecos del generador | 0 |
| Convertidos en id | |
| Clasificación de la huella | 8 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 4→0; barrido 19; revisión 5; 10 aceptadas / 9 cerradas |

El mismo diseño y los mismos escenarios que `2026-10-07-stock-reservation-events-nest.md`, generado con keel-spring
para comparar.

## Cómo terminó

**14/14**, código de salida 0 de `score-scenarios.sh`. Sin `harnessPatches`, sin `designGaps` en el informe, sin
sondeos con falso negativo. `baselineTested: PENDING` (la prueba en vivo del baseline la hace el diseñador).

El informe anota que en el pase de calidad `./gradlew integrationTest` murió una vez con un error nativo de la JVM
(`exit -1073741819`) y pasó al repetirlo. **Coincide en el tiempo con una interferencia de quien medía**: mientras la
suite corría se lanzó `bash infra/score-scenarios.sh --score` sobre el mismo proyecto, que borra `build/keel-failures/`
y trata de terminar los workers de Gradle del directorio. No está probado que fuera la causa (el código es una
violación de acceso, no una terminación), pero no se atribuye al generador ni al entorno.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los seis handlers de `application/usecases/` | TODO legítimo |
| `domain/aggregate/Reservation.java` | TODO legítimo |
| `README.md` | TODO legítimo: la guía de despliegue |

**Archivos nuevos del agente**: `RabbitOutboxDispatcher` (confirmaciones con `CorrelationData`, deadline y
`returned`, según la skill), `RabbitPublishingConfig` (el exchange del servicio y la cola `stockEvents` con su
binding: la topología de publicación, que en keel-nest ya emite build) y `StockEventsListener` (uno para la cola
compartida, que enruta por tipo, con el mismo orden del guard y la misma carrera que el de keel-nest), más
`V1__baseline_schema.sql`.

## designGaps

- `late-outcome-after-release` — el mismo que en la corrida de keel-nest: el listener captura
  `InvalidStateTransitionException | OptimisticLockingFailureException` también en `StockReserved`, así que el aviso
  tardío se confirma sin efecto, contra lo que decía el `gaps.yaml`. Los dos agentes llegaron a lo mismo por sus
  skills; el diseño se corrigió para decir eso.
