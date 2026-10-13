# Corrida de control `notification-mailer` — keel-spring (incremento 16 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.0.2 (DSL 2.21, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-spring@0.1.6` (en `c382d47`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (59 casos: el agente de pruebas desdobló los bordes en ids `-E*`) |
| Huella del agente | 320 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 4 en `design-gaps.yaml`: 1 era del generador, 1 de la convención de pruebas (ver § designGaps) |
| Huecos del generador | 1, el OpenAPI derivado (neutral; ver `2026-10-12-notification-mailer-nest-control.md` § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La gemela de keel-spring de `2026-10-12-notification-mailer-nest-control.md`, donde está la comparación de las cuatro
corridas del control (§ Paridad).

## Cómo terminó

La primera puntuación salió con tres rojos de 59: `FL-TPL-002` y `FL-NTF-001-B` con `culprit: code` (la precedencia
entre compilar la plantilla y rechazar variables duplicadas, y un replay idempotente que recomponía el estado vivo en
vez de devolver la respuesta guardada) y `FL-DSP-001` con `culprit: test` (el agente de pruebas copió
`templateVersion = 2` del Given de `FL-NTF-001`, cuyo Given publica dos veces, a uno que publica una). Un ciclo de
arreglo y 59/59. El pase de calidad, 64 pruebas sin fallos y `contextLoads()` en verde; `baselineTested: PENDING`,
que en keel-spring es del diseñador a propósito.

## La huella, clasificada

Los nueve handlers, los tres agregados y `TemplateVariable`, el README (TODO legítimo) y la consulta de la versión
siguiente: `TemplateRepository.findLatestVersion`, su `TemplateJpaRepository` y su adaptador (consulta de negocio). La
misma huella que keel-nest salvo el archivo de la consulta en Spring Data, que en keel-nest es el `broker-bindings.ts`.

## designGaps

- `openapi-status-per-operation` — `TEMPLATE_NOT_FOUND` como 404 en `requestNotification` en el OpenAPI derivado.
  **Era del generador**, y ya está arreglado (ver la corrida de keel-nest, § Arreglos). También lo reportó la
  corrida documental de keel-spring.
- `request-dedupe-guard` — el consumo de `NotificationRequested` registra con `tryRecord` antes de despachar, y un
  fallo del handler pierde el mensaje; pasada la retención, una reentrega se procesa como nueva. **Es del diseño, y
  bien visto**: la clave natural de `Notification` (`applicationKey, dedupeKey`) ya es la guarda que lo resolvería
  (`dedupeKey` es el `metadata.eventId`, lo dice `review.yaml`), pero `acceptNotificationRequest` no declara la
  idempotencia que la enlaza (`keySource: payload-field` con `keyField: dedupeKey`), así que el generador no la ve y
  la nota del mensaje, en los dos generadores, manda reclamar antes. El agente de keel-nest hizo lo mismo y no lo
  reportó. Candidato para la próxima minor del par.
- `frozen-template-version-missing` — si la versión congelada de la plantilla ya no existe al enviar, sale un 500
  genérico. Del diseño, menor: las plantillas no se borran, y basta una `rule` que lo diga o un code interno.
- `outbox-recovery-window` — `FL-OBX-001` pide la entrega «en ≤ 10 s» tras recuperarse el canal y la convención de
  pruebas de keel-spring pide un mínimo de 60 s con los defaults del cliente del broker. El escenario pasó; la
  contradicción es entre el escenario y la convención, no un fallo. keel-nest lo cumple con 10 s.
