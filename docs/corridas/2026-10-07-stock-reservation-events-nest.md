# Corrida `stock-reservation-events` — keel-nest (incremento 9: mensajería con RabbitMQ)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation-events` v1.0.0 (DSL 2.19, relacional, 6 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-nest@0.0.1` (con el incremento 9: 9a–9d) |
| Diseño listo al generar | sí |
| Matriz final | **18/18 OK** (14 del documento + `FL-RES-001-E`…`H`, ver § Pruebas) |
| Huella del agente | 176 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Huecos del diseño | 1 que no reportó nadie (`late-outcome-after-release`, ver § designGaps) |
| Huecos del generador | 1 (el comentario que nombraba un listener por suscripción, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 9 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 4→0; barrido 19; revisión 5; 10 aceptadas / 9 cerradas |

La corrida que mide el incremento 9 de `PLAN-KEEL-NEST.md`: la primera de keel-nest con capa `messaging`. Su gemela
de keel-spring es `2026-10-07-stock-reservation-events-spring.md`. La fixture es la variante de `stock-reservation`
sin cliente HTTP saliente ni reconciliación, preparada para esta corrida (11/11 en `--ready`).

## Cómo terminó

**18/18 a la primera**, sin ciclos de arbitraje. Sin `harnessPatches`, sin fixes de `infra/` ni `culprit: harness`;
`npm test` 66 pruebas, baseline de migraciones exportado y verificado en vivo. Los escenarios de mensajería
—`FL-OBX-001` con el broker parado y vuelto, la doble entrega simultánea de `FL-CMP-001-C`, la reentrega sin guarda
de dominio de `FL-CNT-001-B` y el descarte de `FL-RES-004`— salieron con los helpers del arnés del 9c, sin ninguno
escrito a mano.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los seis handlers de `src/application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `src/domain/aggregate/reservation.ts` | TODO legítimo: `create`, las transiciones y `noteStockCount` |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el registro del dispatcher y del listener, el sitio previsto |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

**Archivos nuevos del agente**: `rabbitmq/rabbit-outbox-dispatcher.ts` (la línea sobre `RabbitConnection.publish`
que enseña la skill) y `rabbitmq/inventory-events-listener.ts` (UN listener para la cola compartida, que enruta por
`metadata.eventType`, con el orden del guard de cada mensaje y la carrera resuelta), más el baseline de
migraciones del pase de calidad. Ningún archivo de mensajería de build tocado: la conexión, la topología, el puente,
el relay y el registro de procesados funcionaron tal cual.

Frente a keel-spring (8 reescritos), el único reescrito de más es `broker-bindings.ts`, que es donde keel-nest
registra lo que en Spring recoge el component-scan. Y keel-spring escribió además la topología de publicación
(`RabbitPublishingConfig`), que en keel-nest ya la emite build desde el 9c.

## Arreglos

- **El comentario de `broker-bindings.ts` y el del mensaje de cada suscripción nombraban un listener por
  suscripción** (`StockReservedListener`, `StockCountAdjustedListener`, `StockRejectedListener`), y las tres comparten
  cola: tres consumidores competirían por cada mensaje. El agente acertó por la skill, pese al texto. Ahora los dos
  comentarios nombran el listener de la COLA y las suscripciones que la comparten (`consumerQueues`), con su test
  falsado.

## Pruebas

`FL-RES-001-E` a `H` (400 `VALIDATION_ERROR` por cada restricción de entrada) los añadió el agente de pruebas por la
checklist de `integration-tests.md`; no están en `validation-scenarios.md`. El informe señala también un caso límite
sin escenario: una clave de idempotencia con registro previo de la misma firma cuyo recurso ya no existe; en este
diseño no se borran reservas, así que no se alcanza.

## designGaps

- `late-outcome-after-release` — un `StockReserved` que llega con la reserva ya liberada: el `gaps.yaml` de la fixture
  decía que iba al descarte, y los dos agentes lo confirmaron sin efecto aplicando la regla de la carrera resuelta de
  sus skills. Los dos servidores son equivalentes; el que estaba mal era el diseño, que lo decidía en prosa contra lo
  que hacen los generadores y sin escenario que lo fijara. Corregido en el `gaps.yaml` (confirmar sin efecto, la
  misma carrera que `FL-CMP-001-C`); candidato a escenario en la próxima minor. No lo reportó nadie: salió
  comparando los dos listeners.
