# Corrida 2026-09-28 — `notification-mailer` v2.0.2, control de R8

La corrida 0 del plan de validación de R8. Es el **control**: el diseño no se toca respecto al punto
del 27-09 (salvo los arreglos de R9, v2.0.0 → v2.0.2) y el stack es el mismo, así que mide el
residuo del **generador** y no la fase de diseño. No cuenta para el veredicto de H1.

| | |
|---|---|
| Papel | control |
| Diseño | `notification-mailer` v2.0.2 (DSL 2.17, relacional, 7 capas) |
| Stack | mysql · rabbitmq · keycloak (sin caché ni storage, sin telemetría) |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **58/58 OK** (63/63 pruebas de integración) |
| Huella del agente | 312 archivos registrados por `build`, 0 adoptados, **18 reescritos**, 0 borrados |
| Clasificación de la huella | 10 TODO · 2 consulta · 6 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (1 en `design-gaps.yaml`, falso positivo: ver abajo) |
| Huecos del generador | 5 (4 en la huella + 1 latente en `init-keycloak.sh`) |
| Agujeros de la puerta | 0 |
| Convertidos en id | ninguno |

## Lectura

**La hipótesis del control se cumple en el número, y el residuo cambia de sitio.** Bajan de 23 a 18
los reescritos (se esperaban unos 16). Los siete huecos del generador del 27-09 que tocaban archivos
(`TemplateV1Controller`, `ApiExceptionHandler`, `TemplateVariableValue`,
`AcceptNotificationRequestCommand`, `parameters/*/rabbitmq.yaml` ×3) **ya no aparecen**: los arreglos
de DSL 2.16/2.17 quedan confirmados en vivo. Los seis archivos del generador que quedan son huecos
nuevos, que la corrida anterior tapaba o que salen de capacidades que se ejercitaron por primera vez:

- `caller-identity-unresolved` — `AcceptNotificationRequestCommandHandler`. build mete el `client_id`
  en crudo en un campo que el diseño define como la clave de `Application`, y sus propias notas se
  contradicen para la vía por eventos (`identity.resolvedBy` declara la resolución).
- `renderer-escape-per-part` — `SendAcceptedNotificationCommandHandler`. El renderizador generado
  solo escapa en HTML, y el agente lo deshace a mano con `unescapeHtml` para la parte `text`: es un
  arreglo con pérdida, y el asunto sigue saliendo escapado sin que ningún escenario lo vea.
- `renderer-no-compile` — `RegisterTemplateCommandHandler`. El puerto `TemplateRenderer` no tiene
  `compile(source)`, así que el agente valida renderizando con una clave de caché nueva cada vez, y la
  caché crece sin límite.
- `conditional-index-finder` — el trío `TemplateRepository`, `TemplateJpaRepository` y
  `TemplateRepositoryImpl`. build no genera el finder de la fila que ocupa el índice único con `when`,
  aunque sí genera el `flushPendingWrites()` y la nota de ORDEN que lo presuponen.
- Latente: `init-keycloak.sh` promete en su cabecera usuarios de prueba que no crea. No bloqueó nada
  porque todas las reglas de este servicio son `level: service`.

## Arbitraje de la clasificación

La primera clasificación la hizo un agente de contexto limpio con la rúbrica; la acepto sin cambios.
Dos notas que corrigen el informe del agente generador:

- **El `designGap` de `Notification.naturalKey` sin `naturalKeyError` es un falso positivo.** El
  diseño lo decidió por escrito (la regla de `requestNotification`: la violación sería un fallo del
  mecanismo, no un conflicto de negocio), y `framework-errors.md` fija el code canónico, que build
  emitió bien.
- **El `@OrderColumn` de `NotificationJpa`/`TemplateJpa` no es un defecto del scaffolding.** El
  diseño dice que el orden de las colecciones es indiferente (convención de
  `validation-scenarios.md`), y lo correcto era corregir la prueba, como hizo con FL-TPL-001-A. Se
  clasifica como consulta de negocio resuelta en contra del diseño. Candidato de método, que no es
  designGap: la convención de orden de colecciones solo existe en prosa, así que build no puede generar
  aserciones que la respeten.

## designGaps

Ninguno.
