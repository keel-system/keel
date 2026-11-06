# Corrida de control `notification-mailer-mongo` — keel-spring (incremento 7 del plan Boot 4.1)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.1.1 (DSL 2.23, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-spring@0.3.0` (en `174a8bad`: Boot 4.1.2, Java 25, Gradle 9.8.2) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (28 casos) |
| Huella del agente | 306 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 5 en el informe: 1 real (el orden de la guarda del listener) y 4 que no son defecto |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Gemela documental de `2026-11-05-notification-mailer-spring-control.md`, en el workspace
`spring-live-test/corrida-notification-mailer-mongo-spring-control-1105`, desde el mismo commit. La referencia es el
control del 2026-10-18 (`2026-10-18-notification-mailer-mongo-spring-control.md`): 23/23 y huella 17.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0, sin `harnessPatches`. El pase de calidad pasó `integrationTest
--rerun-tasks` (23 `FL-*` + 5 de humo), `./gradlew test`, `indexes`/`indexesTested` en OK y los gates `dedupe`,
`commandIdempotency`, `outboxDelivery`, `mailDelivery`, `valueTypeFormat` y `logging`.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integrationTest/`: 28 casos, 0 fallos, 0 errores, 0 omitidos, en 1233 s.
- `specs.sha256` intacto.
- `keel-spring build --check` al día con el generador instalado.

Ningún tropiezo con Java 25 ni con Gradle 9.

## La huella

**Idéntica archivo por archivo a la del control del 2026-10-18**: los nueve handlers, los tres agregados y
`TemplateVariable`, `README.md`, y la consulta `findLatestVersion` en `TemplateRepository`, `TemplateMongoRepository` y
`TemplateRepositoryImpl`. Build registra uno más (306 frente a 305): `application-aot-training.yaml`, el perfil del
inc. 4, que el agente no tocó.

## Lo que dijo el informe, contrastado con el generador

| Hallazgo del informe | Veredicto |
|---|---|
| Falta `AUTH_TEST_CLIENT` en `infra/test-credentials.env` | **No es defecto.** El cliente de usuario solo se emite si el diseño tiene personas (`usesUserClient`, `identity-realm.js`); este servicio solo tiene clientes máquina, y el propio informe dice que no le afecta |
| `check-idempotency.sh` no imprime `compensation` ni `reconciliation` | **No es defecto.** El diseño no declara ninguna de las dos; el script solo emite las familias que aplican |
| No existe `infra/check-telemetry.sh` | **No es defecto.** `telemetry: none` |
| `OutboxDispatcherFallbackConfig` conserva su `TODO (agente)` | **No es defecto.** Es el respaldo que solo se crea sin dispatcher real y que falla al arrancar fuera de los perfiles tolerados; con `RabbitOutboxDispatcher` presente no se instancia |
| El listener reclama con `tryRecord` antes de despachar | **Hueco real del generador.** Ver abajo |

### Hueco del generador: el orden de la guarda del listener

El javadoc de `NotificationRequestedMessage` prescribe `IdempotencyGuard.tryRecord(...)` **antes** de despachar
`acceptNotificationRequest`, y el gate `dedupe` lo exige. La consecuencia, que el agente señala bien: un fallo
transitorio del handler deja el mensaje marcado y el reintento lo confirma sin efecto. El mensaje se pierde.

Eso contradice el diseño por dos lados:
- la suscripción declara `onFailure.retry` (5 intentos con backoff) precisamente para el fallo PASAJERO, y con el
  reclamo delante esos reintentos no hacen nada;
- la operación **sí tiene guarda de dominio**: `Notification` lleva `naturalKey [applicationKey, dedupeKey]`, y por
  evento `dedupeKey` es `event:<eventId>` (lo dice `review.yaml` y el comentario de `messaging.keel.yaml`: «Reintentar no
  duplica: la clave es metadata.eventId»).

La causa: `triggerHasDomainGuard` (`keel-core/src/lib/gen/model.js`) solo reconoce transiciones, `idempotency.guard:
natural-key` o el cobro de `payments`. Aquí la clave natural se forma con un campo que una **regla** deriva del
`eventId` del input, y esa derivación es prosa, así que el modelo no la ve y elige el orden que pierde mensajes.

No es nuevo: los cuatro listeners de keel-spring del par (controles del 2026-10-18 y del 2026-11-05) reclaman antes. Es
la primera corrida que lo reporta. Y la frase del javadoc es la misma en keel-nest, keel-dotnet y keel-go, porque la
decisión es neutral. **Queda fuera del plan Boot 4.1**: no lo causa Java 25 ni Boot 4.1. Pide una decisión: declarar la
derivación en el DSL para que el modelo la vea, o una regla que avise cuando una suscripción con `onFailure.retry` cae en
el orden que reclama antes.

## Decisiones de implementación sin respaldo en el diseño

- Entrega parcial del correo: cuenta como `sent` solo si el destinatario principal no fue rechazado.
- `findLatestVersion` en el puerto `TemplateRepository` para la versión siguiente (es la consulta de la huella).

## designGaps

Ninguno. `rendered-subject-bound` y `required-value-blank`, repetidos en los controles anteriores, no se reportaron
esta vez.
