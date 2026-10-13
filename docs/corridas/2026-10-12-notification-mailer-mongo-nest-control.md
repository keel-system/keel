# Corrida de control `notification-mailer-mongo` — keel-nest (incremento 16)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-nest@0.0.1` (con el incremento 16: `c382d47`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** |
| Huella del agente | 294 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 1 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La gemela documental de `2026-10-12-notification-mailer-nest-control.md`, donde está la comparación de las cuatro
corridas del control (§ Paridad).

## Cómo terminó

**23/23 a la primera**, sin `keel-nest-validate`, sin `harnessPatches`, sin fixes de `infra/` y con la
infraestructura validada a la primera con podman. El pase de calidad volvió a puntuar 23/23, `npm test` 73 pruebas,
`indexes: OK` e `indexesTested: OK`. La huella es la de su gemela relacional, archivo por archivo: el adaptador
documental, los almacenes del generador sobre MongoDB y el arnés con `mongoEval` no se tocaron. Frente a la corrida
del 12 (`2026-10-08-notification-mailer-mongo-nest.md`) baja de 18 a 17: el que falta es el arreglo del ciclo de
inyección de `CommandDispatcherAdapter`, confirmado.

## designGaps

- `mail-partial-delivery` — el relay acepta a unos destinatarios y rechaza a otros: el diseño solo declara el rechazo
  total (`failed`), y el agente lo resolvió como `sent`, emitiendo `NotificationSent`, porque el correo salió. Las
  skills de correo de los dos generadores lo plantean igual («tratarla siempre como no salió da por fallido un correo
  que ya llegó», con `partial()` para decidir), pero dejan la decisión al agente: lo que falta es que el diseño la
  tome en los desenlaces de `sendAcceptedNotification`, o los dos servidores pueden acabar decidiendo distinto. Del
  diseño, primera vez que se reporta.
