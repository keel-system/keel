# Corrida de control `notification-mailer-mongo` — keel-spring (inc. 7 del plan de la guarda derivada, DSL 2.24)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.1.2 (DSL 2.24, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-spring@0.3.0` (en `44a868fa`) |
| Modelo del agente | `claude-sonnet-5-5` |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (28 casos) |
| Huella del agente | 306 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Gemela documental de `2026-11-06-notification-mailer-spring-control.md`, en el workspace
`spring-live-test/corrida-notification-mailer-mongo-spring-control-1106`, desde el mismo commit y con el mismo
procedimiento (el `keel-stack.json` del control del 2026-11-05 copiado antes del `build`). La referencia es
`2026-11-05-notification-mailer-mongo-spring-control.md`: 23/23 y huella 17. Esa corrida fue la que **reportó** el
hueco del listener que reclamaba con `tryRecord` antes de despachar, y del que salió este plan.

## Lo que mide: el orden del listener

**Cerrado, igual que en la gemela relacional.** El `NotificationRequestedListener` comprueba con
`idempotencyGuard.alreadyProcessed(...)`, despacha `AcceptNotificationRequestCommand` y registra con
`idempotencyGuard.record(...)` después, y su javadoc cita el contrato del mensaje («`alreadyProcessed` antes y…»). No hay
`tryRecord`. El handler busca con `findByApplicationKeyAndDedupeKey` y el valor derivado (`DEDUPE_PREFIX = "event:"`).
`infra/check-idempotency.sh` sale verde en sus siete familias (`dedupe` incluida).

## La huella

**Idéntica archivo por archivo a la del control del 2026-11-05** (comparadas las dos salidas de `footprint`; solo cambia
la versión del diseño): los mismos 17 reescritos.

## Cómo terminó, reverificado desde fuera

- `score-scenarios.sh` en 0: 23/23, 28 casos, `BUILD SUCCESSFUL in 23m 6s`. Los XML de
  `build/test-results/integrationTest/` son de esa ejecución (de 14:31 a 14:54 UTC): 28 casos y 0 fallos.
- La última edición de código (el listener, 14:29:20 UTC) es anterior a la ejecución puntuada, que se lanzó a las
  14:30:53. Después solo cambió `README.md`.
- La repetición del pase de calidad (14:55) no reescribió los resultados, porque Gradle dio la tarea por al día al no
  haber cambios. Aquí nadie bajó la infra a mitad de una ejecución, a diferencia de la gemela relacional.
- `specs.sha256` intacto (13/13).
- `keel-spring build --check` al día con el generador instalado.

## Lo que dijo el informe

- `designGaps`: ninguno. Sin `harnessPatches` ni falsos negativos de infraestructura.
- Una nota de técnica de prueba: `FL-CLU-001` («se deja correr 3 minutos») se resolvió esperando a que los cinco envíos
  estén en `sent` (hasta 240 s) y vigilando 75 s más que ningún conteo suba de uno.

## designGaps

Ninguno.
