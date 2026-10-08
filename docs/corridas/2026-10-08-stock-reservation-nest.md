# Corrida `stock-reservation` — keel-nest (incremento 11: lo saliente y la reconciliación)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.1.0 (DSL 2.19, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-nest@0.0.1` (con el incremento 11: 11a–11d y la segunda réplica del arnés) |
| Diseño listo al generar | sí |
| Matriz final | **24/24 OK** (los 21 del documento más `FL-RES-001-V1…V3`, que añadió el agente de pruebas) |
| Huella del agente | 223 archivos registrados por `build`, 0 adoptados, **10 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el contraste con el proyecto no encontró ninguno) |
| Huecos del generador | 1: el gate no veía que el barrido se tragara los errores (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 10 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 1→0; barrido 29; revisión 11; 11 aceptadas / 18 cerradas |

La corrida que mide el incremento 11 de `PLAN-KEEL-NEST.md`: la llamada saliente `inventory.cancelStock` (adaptador
sobre `fetch`, retry solo ante timeout y conexión, circuito con la semántica de resilience4j, fallback `ignore`,
clave de idempotencia saliente), el barrido de reconciliación que se rinde y cancela (`reconciliation_claim`), la
compensación por evento y los escenarios de clúster con la segunda réplica del arnés. Su gemela de keel-spring es
`2026-10-08-stock-reservation-spring.md`. La fixture pasó a v1.1.0 y a 11/11 en `--ready` para esta corrida.

## Cómo terminó

**24/24**, con una ronda de arbitraje: `FL-REC-002` falló en la primera pasada con `culprit: test` (la prueba leía
el registro del stub antes de que saliera el reintento de `cancelStock`), corregido en la prueba. Sin
`harnessPatches`, sin fixes de `infra/` ni `culprit: harness`; `npm test` 67/67; baseline de migraciones exportado y
probado en vivo; `check-idempotency.sh` en verde con el gate de entonces. Los escenarios de clúster (`FL-CLU-001…003`)
pasaron con `startReplica`/`onReplica`, estrenados en esta corrida, y los de reconciliación con `ageForReconciliation`
y los helpers del stub (`stubSequence`, `stubRequests`, `stubRequestHeader`), sin SQL ni mappings a mano.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los siete handlers de `src/application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `src/domain/aggregate/reservation.ts` | TODO legítimo: los métodos semánticos (`releaseUnanswered`, `release`, …) |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el dispatcher del outbox y el listener |
| `README.md` | TODO legítimo: la guía de despliegue, paso del pase de calidad |

Ningún archivo de lo saliente, del reclamo, de la persistencia ni del arnés tocado: el barrido usa el reclamo
generado y el handler llama al puerto del cliente sin repetir su resiliencia.

## Lo que dijo el informe y lo que resultó ser

El informe no reporta huecos ni del diseño ni del generador. Contrastado con el proyecto, uno que no vio:

1. **El barrido se traga los errores.** El handler de `reconcileReservations` envuelve el `save` en un `catch {}` sin
   variable —que esconde, además del conflicto de la carrera con el camino feliz, cualquier bug propio— y la llamada
   `cancelStock` en otro `catch {}` vacío, cuando la llamada ya no lanza por fallos del proveedor (su fallback es
   `ignore`): lo único que ese catch puede tragarse es un `OutboundContractError` o un bug. Va contra la skill
   `keel-nest-httpclient` («sin try/catch alrededor»), y el gate no lo miraba. Ver § Arreglos.
2. **`FL-RES-001-V1…V3`** no están en el documento: el agente de pruebas escribió una prueba por restricción de
   entrada y la puntuación las cuenta como escenarios. No esconden nada, pero la matriz dice 24 donde el contrato
   tiene 21. Ver § Pendientes.

## Arreglos

- **La familia `reconciliation` del gate** prohíbe en el handler del barrido un `catch` sin variable
  (`src/scaffold/idempotency-check.js`): la carrera se captura por su excepción concreta y lo demás se relanza.
  Medido sobre una copia del proyecto terminado: el gate regenerado lo pone ROJO, y con las dos capturas
  discriminando sale VERDE. Fijado en `test/idempotency-check.test.js` y falsado (sin la prohibición, la prueba cae).
- **El finder vetado en el barrido** pasa a ser el que lee por el campo del lifecycle (o `findAll`), no cualquiera:
  ver la ficha de keel-spring, donde se destapó. Mismo arreglo aquí, también falsado.

## Pendientes

- La puntuación (`score-scenarios.sh`, común a los dos generadores) cuenta cualquier `FL-*` del XML aunque no esté en
  el documento, y da por cubierto `FL-X` si existe cualquier `FL-X-…`. Candidato: señalar los ids fuera del
  documento.

## designGaps

Ninguno.
