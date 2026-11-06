# Corrida de control `notification-mailer` — keel-spring (inc. 7 del plan de la guarda derivada, DSL 2.24)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.1.2 (DSL 2.24, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-spring@0.3.0` (en `44a868fa`) |
| Modelo del agente | `claude-sonnet-5-5` |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (28 casos) |
| Huella del agente | 321 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Corrida de control del inc. 7 de `completed_plans/PLAN-DSL-224-GUARDA-DERIVADA.md`, en el workspace
`spring-live-test/corrida-notification-mailer-spring-control-1106`. Mide que el par, ya con su guarda declarada
(`acceptNotificationRequest` con `idempotency: { keySource: payload-field, keyField: eventId, storedIn: dedupeKey }`),
lleva al agente a escribir el listener de `NotificationRequested` en el orden correcto, y que el resto no cambia. La
referencia es el control del 2026-11-05 (`2026-11-05-notification-mailer-spring-control.md`): 23/23 y huella 17, con el
listener que reclamaba con `tryRecord` ANTES de despachar.

El proyecto se generó desde el workspace con `keel-spring build`, con el `keel-stack.json` del control del 2026-11-05
copiado antes (build lo reutiliza sin preguntar), para que el stack sea el mismo y la huella comparable.

## Lo que mide: el orden del listener

**Cerrado.** El `NotificationRequestedListener` que escribió el agente comprueba con
`idempotencyGuard.alreadyProcessed(...)`, despacha `AcceptNotificationRequestCommand` y registra con
`idempotencyGuard.record(...)` **después**, con el comentario «la clave natural del agregado es la guarda; el registro va
DESPUÉS de procesar bien». No hay `tryRecord`. El rechazo de negocio sale al descarte sin registrar.

El handler busca por la clave natural con el valor derivado, `"event:" + command.eventId()`
(`findByApplicationKeyAndDedupeKey`), no con el `eventId` tal cual, que es lo que dice la frase de `storedIn` en las dos
notas. `infra/check-idempotency.sh` sale verde en sus ocho familias (`dedupe` incluida), y recién generado salía rojo
pidiendo justo ese orden.

Lo que ningún escenario de caja negra ve sigue igual: el mensaje perdido por un fallo pasajero a mitad del handler. Su
red es ese gate, que el inc. 4 falsó en los dos sentidos.

## La huella

**Idéntica archivo por archivo a la del control del 2026-11-05** (comparadas las dos salidas de `corrida-metrics.js
footprint`; solo cambia la versión del diseño). Son los mismos 17 reescritos: los nueve handlers, los tres agregados y
`TemplateVariable`, `README.md`, y la consulta `findLatestVersion` en `TemplateRepository`, `TemplateJpaRepository` y
`TemplateRepositoryImpl`. El listener no cuenta porque no lo registra `build`: lo escribe el agente entero.

## Cómo terminó, reverificado desde fuera

- `score-scenarios.sh` en 0: 23/23, 28 casos. Es la ejecución de `build/keel-scenarios/run.log` (`BUILD SUCCESSFUL in
  18m 50s`, 09:06 hora local).
- La última edición de código del pipeline (el listener, 13:46:05 UTC) es **anterior** a esa ejecución (lanzada a las
  13:46:55 UTC). Después solo se escribió el informe. El 23/23 cubre el código final.
- `specs.sha256` intacto (13/13).
- `keel-spring build --check` al día con el generador instalado.
- `baselineTested: PENDING`, que en keel-spring le toca al diseñador a propósito.

## Lo que dijo el informe, y lo que no es cierto

- `designGaps`: ninguno. Sin `harnessPatches`, sin falsos negativos de infraestructura.
- Observaciones menores, ya conocidas: `FL-DSP-001` y `FL-OBX-001` usan palancas del arnés, y `infra/up.sh` tarda unos
  3 minutos con `podman-compose`.

**El informe dice que «el pase de calidad repitió `integrationTest` (28 tests, 0 fallos)», y no es cierto.** Lo dice el
transcript:
- el subagente de calidad lanzó `./gradlew integrationTest` a las 14:07 UTC y leyó `build/test-results/` a las 14:13,
  con la suite a medias;
- el orquestador ejecutó `infra/down.sh` a las 14:14:58, con esa suite todavía corriendo;
- desde FL-EVT-001-B, que es Mailpit contestando «sql: database is closed», todo falla en ~0,6 s con «no container
  notification-mailer-devtools».

No afecta al resultado, porque nada cambió después de la ejecución puntuada. Pero el `build/test-results/integrationTest/`
que quedó en disco es el de esa ejecución cortada (24 casos, 18 fallos), y quien lo lea sin saberlo verá rojo una corrida
verde. Es un defecto del pipeline, no del diseño ni del generador de código: el pase de calidad da por terminada una
ejecución que no comprobó, y el orquestador baja la infra sin esperar a sus subagentes.

## designGaps

Ninguno.
