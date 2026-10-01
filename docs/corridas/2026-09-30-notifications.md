# Corrida 2026-09-30 — `notifications` v0.1.1 del registry

Primera corrida sobre el `notifications` del registry, el servicio de correo transaccional
multi-aplicación (plantillas como dato, supresiones, rebotes, despacho por barrido con rescate). El
proyecto está en `keel-registry/services/notifications-spring`. **No cerró**: `FL-DSP-021` quedó sin
prueba, porque el relay de pruebas no sabía rechazar a un solo destinatario. Por eso no hay fase de
calidad ni baseline.

| | |
|---|---|
| Diseño | `notifications` v0.1.1 (DSL 2.17, relacional, 8 capas) |
| Stack | postgresql · rabbitmq · keycloak |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **165/166 OK**, 1 NO_EJERC (`FL-DSP-021`); pasadas 129/20/3 → 164/1/1 → 165/0/1 |
| Huella del agente | 401 archivos registrados por `build`, 0 adoptados, **61 reescritos**, 2 borrados |
| Huecos del diseño | 4 en `design-gaps.yaml`: 2 descartados, 1 reatribuido al generador, 1 cerrado con una convención del método; + 1 que no reportó nadie (el plazo del rescate) |
| Huecos del generador | 13 (G1–G13; el informe los vio a medias: G9, G10 y G11 resultaron más graves, y G11 lo atribuía al diseño) |
| Agujeros de la puerta | 0 |
| Convertidos en id | `CHK-USECASES-STALLED-AFTER-INVALID` (DSL 2.18) |

Los 61 reescritos no se han clasificado uno a uno con el agente de contexto limpio, así que falta la
fila `Clasificación de la huella`. Lo que sí se hizo fue contrastar cada hallazgo del informe con el
código del generador. Se usó `planService` renderizado en memoria sobre el mismo `specs/` y el diff
contra el árbol final. Varias conductas se midieron además con las bibliotecas reales: handlebars
4.4.0, jakarta.mail 2.0.3 con spring-context-support 6.2.8, y `axllent/mailpit:v1.31`.

## Hallazgos del generador (arreglados en keel-spring)

- **G1 `kc-user-substring`.** `user_id_of()` de `init-keycloak.sh` buscaba `?username=x`, que en
  Keycloak es búsqueda por subcadena, y se quedaba con la última fila. Así el atributo del claim de
  alcance acababa en `<rol>-2` y el usuario original se quedaba sin él. Era una sola causa con dos
  efectos: 20 escenarios en 403 y 2 clases caídas en `@BeforeAll`. Ahora la búsqueda es `exact=true`
  con filtro local por la columna del username, y el atributo se relee y el script aborta si falta.
  El stub de kcadm del test busca por subcadena como Keycloak; con el stub de antes el defecto era
  invisible.
- **G2 `validate-infra-claim`.** `validate-infra.sh` no comprobaba el claim, y G1 pasó la validación
  de infraestructura en verde. Ahora hay un sondeo por usuario acotado que decodifica el JWT. Sale de
  `realmSpec()`, y el test lo ejecuta con un `curl` falso que devuelve un JWT real.
- **G3 `actuator-credential`.** `queryCount()`/`deadLetteredEvents()` pedían el actuator con el
  primer rol, dando por hecho `anyRequest().authenticated()`. El cierre real es el `access.default`
  del diseño (`admin`). Ahora `actuatorCredential()` elige la credencial que satisface esa regla.
- **G4 `cost-write-measure`.** `FL-NTF-040` medía el coste de una lectura dentro de un comando que
  escribe, y `hibernate.statements` cuenta también los INSERT. Ahora hay `queryExecutions()`, con su
  punto ciego documentado, y la regla 4 en `read-composition.md`.
- **G5 `selective-relay-reject`.** El chaos de Mailpit rechaza a todos los destinatarios. Ahora el
  compose arranca con `MP_SMTP_ALLOWED_RECIPIENTS`, que rechaza el TLD reservado `.invalid`, y el
  arnés tiene `rejectedAddress()`. Lo valida MAIL-12 de `mail-check`, falsado quitando la variable.
- **G6 `inline-op-enums`.** Los enums inline de `input` de operaciones (y de payloads de eventos)
  no se emitían, y el proyecto recién generado **no compilaba**. Ahora `collectEnums` los recorre, y
  un test cruza todo `import …domain.enums.X` contra los archivos emitidos en todas las fixtures.
- **G7 `sweep-yaml-dup-key`.** Un rescate de una sola transición tomaba la misma clave que la cota
  del lote, y `sweep.yaml` salía con esa clave duplicada: **la app no arrancaba**. Ahora se agrupa
  por clave, y un test parsea con claves únicas todo YAML generado.
- **G8 `mail-custom-headers`.** `MailMessage` no admitía cabeceras propias, y el diseño exige
  `X-Notification-Id`. Ahora hay `headers`, saneadas y validadas en el constructor, con un
  constructor de compatibilidad.
- **G9 `mail-partial-send`.** No se emitía `sendpartial`. Además, aun con él, JavaMail entrega a los
  válidos y lanza igual, y el agente tuvo que inventar un puerto para distinguirlo. Ahora
  `MailDeliveryException` lleva `accepted()`/`rejected()`/`detail()`.
- **G10 `hbs-escape-table`.** El escapado por defecto de Handlebars escribe el apóstrofo como
  `&#x27;`, no `&#39;`, y escapa además `` ` `` y `=`. `FL-DSP-030` falla con lo que genera build.
  Ahora la tabla es cerrada, de cinco entidades.
- **G11 `hbs-reserved-names`** (reportado como hueco del diseño). Con `{{name}}`, `else` y `true` no
  compilan; `log`, `if`, `each`, `with` y `unless` salen **vacíos sin error**; y `this`/`lookup`
  vuelcan el mapa de variables. Ahora el renderizador compila los marcadores simples como
  `{{[name]}}`. Respeta `else`/`this` cuando hay bloques.
- **G12 `rescue-lease`.** El UPDATE del rescate dejaba `failed` sin `failureReason`/`failedAt`.
  Ahora el rescate **arrienda**: renueva el reloj y la transición la hace el dominio. Lo comprueban
  `claim.test.js` y los casos del rescate de `claim-check`.
- **G13 `element-collection-order`.** Las `@ElementCollection` de listas no llevaban `@OrderColumn`,
  así que el orden no estaba garantizado. Ahora llevan `@OrderColumn` y `@BatchSize`.
- Deriva de documentación: `mapping.md` decía que el autor de la auditoría es el `principalClaim`, y
  desde 5a9c3ba es el `sub`.

## Del informe, descartado

- `MESSAGE_NOT_QUEUED` sin `http`: `sendQueuedMessage` es interna, y el código nunca llega a HTTP.
- «El valor del centinela no está definido»: lo fija el generador (`system` o
  `system:<correlationId>`) y estaba en `mapping.md`. Ahora también está en `integration-tests.md`,
  que es donde lo busca el agente de pruebas.

## Pendiente de investigar (no reportado)

- **N1.** `GetTemplateVersionResponseDto` corresponde a una nieta (Application → EmailTemplate →
  EmailTemplateVersion) y build le pone solo `templateId`. El diseño proyecta también
  `applicationId`, y el agente reescribió 4 DTOs y el mapper.
- **N2.** build avisa de que la `naturalKey` de `EmailTemplateVersion` nombra `template` «que no es
  campo ni relación del agregado», cuando es una relación declarada. Puede ser un aviso falso o un
  finder roto. Probablemente explica parte de los repositorios reescritos.

## designGaps

- `rescue-deadline-prose` — el plazo del rescate (`sendingTimeoutMinutes`) solo se enlazaba en
  prosa, y build usó el suyo. Se cierra con DSL 2.18: `transitions[].stalledAfter`.
- `selective-relay-reject` — `FL-DSP-021` pedía un rechazo selectivo sobre una dirección corriente.
  Se cierra con una convención del método: el dominio reservado `rejected.invalid`, y el diseño
  pasa a v0.1.2.
