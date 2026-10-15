# Corrida `notification-mailer-mongo` — keel-dotnet (incremento 12e)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 12: 12b–12e-b, `735641f`…`d1bf1f7`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** |
| Huella del agente | 298 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 (1 en `design-gaps.yaml`, ya aceptado en `gaps.yaml`) |
| Huecos del generador | 1, de los tres generadores: la skill no decía que un hueco ya aceptado no se reporta (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas del 2026-10-12 |

La corrida del incremento 12 de `PLAN-KEEL-DOTNET.md`, sobre el MISMO diseño y el mismo stack que sus gemelas de
control (`2026-10-12-notification-mailer-mongo-{nest,spring}-control.md`). Mide lo que ninguna red mide de una vez: la
persistencia documental (12b), los almacenes del generador sobre MongoDB (12c), el arnés con `MongoEval` (12d), la
identidad resuelta contra varias credenciales (`resolvedBy`, 12e-a) y el correo con su guarda contra el doble envío
(12e-b), todos juntos y con un agente escribiendo contra ellos.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0: sin `harnessPatches`, sin fixes de `infra/` ni de la solución,
sin `culprit: harness` ni falsos negativos. `infra/check-idempotency.sh` en verde sobre el proyecto terminado. El
handler del correo usa la guarda emitida tal cual (`ClaimForSendAcceptedNotification`, confirmada antes de mandar nada,
y quien pierde la carrera termina sin error) y los puertos `IMailSender`/`ITemplateRenderer` inyectados; nada del
adaptador SMTP, del renderizador, del arnés del buzón ni de los almacenes documentales se tocó.

El envío parcial (`MailDeliveryException.Partial()`) lo resolvió como `sent`, igual que el agente de keel-nest en su
control, y esta vez sin reportarlo: la skill `keel-dotnet-mail` plantea la pregunta igual que las de los otros dos.
Es el `mail-partial-delivery` del control de keel-nest, que sigue sin estar en el diseño; los dos servidores han
decidido lo mismo, pero lo deciden las skills, no el diseño.

## Comparación

| | keel-dotnet | keel-nest (control) | keel-spring (control) |
|---|---|---|---|
| Matriz | **23/23 a la primera** | 23/23 a la primera | 23/23 a la primera |
| Registrados por build | 298 | 294 | 305 |
| Reescritos | **17** | 17 | 17 |
| Huecos del diseño reales | 0 | 1 (`mail-partial-delivery`) | 0 (los 2 reportados no lo eran) |

**La huella es la de las gemelas, archivo por archivo**: los nueve handlers, los tres agregados y la entidad hija, el
`README.md`, `BrokerBindings.cs` (como `broker-bindings.ts` en keel-nest) y la MISMA consulta de negocio sobre
plantillas, en el puerto y en su adaptador.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `Application/UseCases/` | TODO legítimo: la lógica de cada caso de uso, el barrido y el envío |
| `Domain/Aggregate/{Application,Notification,Template}.cs`, `Domain/Entity/TemplateVariable.cs` | TODO legítimo: la creación y las transiciones |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo: registrar el dispatcher del outbox y el listener de RabbitMQ |
| `README.md` | TODO legítimo: la guía de despliegue |
| `Domain/Repository/ITemplateRepository.cs` y `Persistence/Repositories/TemplateRepository.cs` | Consulta de negocio: `FindLatestVersion(applicationId, key, locale)`, para «la versión es la siguiente de esa aplicación, clave e idioma» (la de las gemelas) |

**Archivos nuevos del agente**: `UseCases/NotificationIntake.cs` (el registro común a la vía HTTP y a la de eventos,
«lo mismo que por HTTP»), `Messaging/RabbitMq/{RabbitOutboxDispatcher,NotificationRequestedListener}.cs` (lo que la
skill `keel-dotnet-rabbitmq` le pide escribir) y los diecinueve flujos de `tests/NotificationMailerMongo.IntegrationTests/`.

## Arreglos

- **Un hueco ya aceptado volvía como `designGap`** (de los tres generadores). El agente reportó que una notificación
  que se queda en `queued` porque el ciclo cae antes del envío no la rescata ningún barrido; `specs/gaps.yaml` lo trae
  aceptado (clase 13, `queueAcceptedNotifications`, con su motivo y el disparador que lo reabriría). Es la segunda
  vez: `2026-10-07-profile-directory-nest.md` cuenta lo mismo. Ninguna skill ni ninguna `orchestration.md` decía que
  antes de reportar un hueco hay que buscarlo en `specs/gaps.yaml` y `specs/decisions.yaml`. Ahora lo dicen las tres
  (el paso del informe de la skill orquestadora y `orchestration.md` § cierre), y lo fijan
  `keel-dotnet/test/generator-docs.test.js`, `keel-nest/test/generator-docs.test.js` y `keel-spring/test/scaffold.test.js`.

## designGaps

Ninguno. El único reportado (el `queued` sin rescate) ya estaba aceptado en `gaps.yaml`; se cuenta en § Arreglos
como hueco del generador y no lleva clave, para que `series` no lo agrupe como hueco del diseño.
