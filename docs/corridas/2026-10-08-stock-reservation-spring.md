# Corrida `stock-reservation` — keel-spring (gemela del incremento 11 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.1.0 (DSL 2.19, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **21/21 OK** |
| Huella del agente | 252 archivos registrados por `build`, 0 adoptados, **10 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el contraste con el proyecto no encontró ninguno) |
| Huecos del generador | 1: el gate vetaba releer por id un candidato ya reclamado (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 8 TODO · 0 consulta · 2 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 1→0; barrido 29; revisión 11; 11 aceptadas / 18 cerradas |

La misma fixture que `2026-10-08-stock-reservation-nest.md`, generada con keel-spring sobre el mismo stack: la
gemela que dice si los dos servidores del diseño se comportan igual. Las dos matrices salen al 100% sobre los 21
escenarios del documento.

## Cómo terminó

**21/21** sin arbitraje. Sin `harnessPatches`, sin `culprit: harness`. Una ejecución de `integrationTest` del pase de
calidad murió por fallo de la JVM en Windows antes de correr escenarios; la repetición fue limpia. Queda
`baselineTested: PENDING` (probar `V1__baseline_schema.sql` sobre una base vacía), del diseñador.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los siete handlers de `application/usecases/` | TODO legítimo |
| `domain/aggregate/Reservation.java` | TODO legítimo: los métodos semánticos |
| `domain/repository/ReservationRepository.java` y `ReservationRepositoryImpl.java` | hueco del generador: `reloadClaimed(UUID)`, ver abajo |

## Lo que dijo el informe y lo que resultó ser

El informe lo dice bien: el gate `reconciliation` vetaba `.findById(` en el handler del barrido, y el agente lo
resolvió con un método de puerto nuevo, `reloadClaimed(UUID)`, que es la MISMA lectura por id con otro nombre.
Contrastado con el código: la relectura es legítima —relee el candidato ya reclamado justo antes de resolverlo, y si
ganó el camino feliz (`StockReserved` llegó entre el reclamo y la transición), la transición lo rechaza y no cancela
nada—. Lo que estaba mal era el gate: vetaba cualquier finder, cuando lo que el reclamo evita es leer **por estado**.
Y empujó al agente al camino de menor resistencia: callar el gate cambiando un nombre, que es exactamente lo que un
gate no debe pedir.

## Arreglos

- **El finder vetado** en el barrido (familias `reconciliation` y `sweepClaim`, `src/scaffold/idempotency-check.js`)
  pasa a ser el que lee por el campo del lifecycle de la entidad reclamada (`findByStatus…`, `findAllByStatus…`) o
  `findAll`. Medido sobre una copia del proyecto terminado con el gate regenerado: tal cual (`reloadClaimed`) VERDE,
  con la recarga como `findById` VERDE, leyendo por estado ROJO. Fijado en `test/idempotency-check.test.js` y falsado
  (con el veto viejo, la prueba cae). El mismo arreglo en keel-nest.
- **La otra mitad, de la corrida de keel-nest**: el handler del barrido no puede capturar `Exception`,
  `RuntimeException` ni `Throwable`. El de esta corrida captura `InvalidStateTransitionException` (lo correcto) y
  sale VERDE; cambiado a `Exception`, ROJO. También falsado.

## designGaps

Ninguno.
