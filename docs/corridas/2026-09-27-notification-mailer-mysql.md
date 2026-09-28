# Corrida 2026-09-27 — `notification-mailer` v2.0.0, la primera sobre un diseño listo

Primer punto de datos de R8: la primera corrida sobre un diseño que pasa `keel validate --ready`
(10/10). El diseño es el par del MVP tras R9 y tras la revisión y el barrido de contexto limpio.
`build` generó **sin** `--accept-unready`.

| | |
|---|---|
| Diseño | `notification-mailer` v2.0.0 (DSL 2.15, relacional, 7 capas) |
| Stack | mysql · rabbitmq · keycloak (sin caché ni storage, sin telemetría) |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **56/57 OK**; 1 no ejercitado (FL-DSP-001), 0 fallos |
| `keel validate` antes de generar | `--ready` 10/10; `check` factible con 5 avisos, 2 de ellos ya aceptados en `decisions.yaml` |
| Huella del agente | 312 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` (el orquestador no escribió el archivo) y 0 que no reportara nadie |
| Huecos del generador | 5 (ver abajo), 3 repetidos de la corrida anterior del mismo servicio |
| Convertidos en id | `CHK-PERSIST-UNIQUE-ERROR-UNDECLARED`, `CHK-PERSIST-UNIQUE-ERROR-UNKNOWN`, `CHK-MSG-INPUT-ENVELOPE-FIELD` (DSL 2.16, ver § Arreglos) |

## Lectura: lo que midió esta corrida

**El diseño dejó de ser la fuente del reproceso; el generador no.** Ninguno de los 23 reescritos es una
decisión que el diseño no tomara. Se reparten así:

| Clase | Archivos | Veredicto |
|---|---|---|
| TODO legítimo: handlers, agregados y la entidad hija | 9 handlers, `Application`, `Notification`, `Template`, `TemplateVariable` (13) | trabajo del agente, no corrección |
| Consultas de negocio que ninguna regla estructurada nombra | `TemplateRepository`, `TemplateJpaRepository`, `TemplateRepositoryImpl` (3) | legítimo: «la plantilla activa» y «la versión siguiente» son reglas en prosa |
| **Hueco del generador** | `TemplateV1Controller`, `ApiExceptionHandler`, `TemplateVariableValue`, `AcceptNotificationRequestCommand`, `parameters/*/rabbitmq.yaml` ×3 (7) | build dejó algo mal o sin hacer, con el diseño declarándolo |

La comparación directa es `corrida-mail-mysql`: mismo servicio y stack, diseño v1 anterior a la
puerta, generador 0.1.2, **21 reescritos de 293**. **Son casi los mismos archivos**: aquellos 21 son un
subconjunto de estos 23, y los dos que se añaden (`TemplateVariableValue`, `TemplateV1Controller`)
existen por capacidades que la v2 estrena. El número no bajó, y era lo esperable: la huella de este
servicio es casi toda TODO legítimo, y la parte que no lo es la pone el generador. Lo que cambió es la
naturaleza de lo que queda. Ahora el diseño no aporta ningún hueco, y lo que sobra se puede atribuir
entero a `build` y convertir en arreglos concretos.

Contra `catalog 2` (53 de 413, 4 + 2 huecos del diseño), esta corrida no deja ningún hueco de diseño.
No son comparables en tamaño; sí en origen.

## Huecos del generador

Ninguno está en `design-gaps.yaml`, porque no son del diseño. Tres ya estaban en la corrida anterior,
y por la regla de R8 son candidatos obligatorios a arreglo:

- `publish-body-less` — `TemplateV1Controller.publishTemplate` declara `@Valid @RequestBody` para un POST
  cuya operación no tiene cuerpo. Tumbó 3 escenarios y dejó 14 sin ejercitar hasta que el agente lo
  quitó. **Bloqueante**: es el único rojo sistémico de la corrida.
- `constraint-to-declared-code` (**repetido**) — el `ApiExceptionHandler` generado deja como TODO las
  constraints únicas cuyo code declarado no sigue la forma `<ENTIDAD>_<CAMPOS>_ALREADY_EXISTS`
  (`APPLICATION_ALREADY_EXISTS`, `CREDENTIAL_ALREADY_ASSIGNED`, `TEMPLATE_VERSION_ALREADY_EXISTS`). Las
  dos corridas las mapean a mano. Lo que falta es estructural: el DSL no dice qué error cubre cada
  índice único.
- `event-id-to-command` (**repetido**) — la regla `dedupeKey = event:<eventId>` necesita el
  `metadata.eventId` dentro del comando, y el comando generado solo lleva los inputs declarados. Las
  dos corridas añaden el campo a mano. Es el mismo hueco que el hallazgo 1 del método (la identidad
  por evento no tiene forma estructurada).
- `vo-list-constraints` — un value object compuesto usado en una lista de entrada
  (`List<TemplateVariableValue>`) no lleva las `@Size`/`@NotNull` de sus campos: un valor de 1001
  caracteres llegaba a la base y respondía 409 en vez de 400.
- `rabbit-listener-retry` — `onFailure.retry` no se materializa en la configuración del listener de
  RabbitMQ. El agente la escribió y, la primera vez, reintentaba también los rechazos de negocio: la
  reentrega chocaba con su propio registro de deduplicación y el mensaje no llegaba nunca a la cola de
  descarte (FL-EVT-002).

Y uno de cobertura, ya conocido: `smtp-reject-primitive` — FL-DSP-001 no se ejercita porque el relay
de prueba no sabe rechazar un destinatario (hallazgo 5 del método). El escenario ya lo preveía.

## designGaps

Ninguno. Es el primer registro con la sección vacía a propósito: el informe del orquestador dice que
nada requirió tocar `specs/`, y la lectura de los 23 reescritos lo confirma.

## Incidencias de proceso

- El orquestador **no escribió `design-gaps.yaml`** al no tener huecos que declarar. Un archivo ausente
  no distingue «no hubo huecos» de «nadie lo escribió»; debería escribirse vacío.
- El informe atribuye bien el defecto del controller al generador. Los otros cuatro huecos del
  generador los presenta como «trabajo propio de completar el scaffolding»: solo se ven como lo que son
  comparando contra la salida de `build`.

## Arreglos (2026-09-27, tras la corrida)

Los cinco huecos del generador, cerrados con un test cada uno y falsados volviendo atrás el arreglo.
Dos necesitaban DSL, que sube a **2.16**; el par pasa a **v2.0.1** (patch: el contrato con los
integradores no cambia, solo se nombra lo que la prosa ya decía) y sigue en 10/10.

| Hueco | Arreglo | Dónde |
|---|---|---|
| `publish-body-less` | El cuerpo solo existe si queda algún campo que no sea la identidad resuelta | `controllers.js` (`asBody`), `test/caller-identity.test.js` |
| `constraint-to-declared-code` | DSL 2.16: `naturalKeyError` e `indexes[].error` nombran el 409 de cada unicidad; aviso `undecided` si hay dos o más y una no se deja deducir | schema de `persistence`, `crossrefs.js`, `declared-errors.js` (`namedUniquenessError`), `controllers.js` |
| `event-id-to-command` | DSL 2.16: `subscriptions.<E>.input` admite `metadata.eventId`/`occurredAt`/`source` con envoltura Keel; el javadoc del mensaje dicta `envelope.metadata().eventId()` | schema de `messaging`, `crossrefs.js`, `model.js` (`triggerArguments`), `messaging.js` |
| `vo-list-constraints` | El constructor compacto del value object guarda también la longitud (`@Size`) de sus campos de texto | `value-types.js` (`lengthBounds`) |
| `rabbit-listener-retry` | `spring.rabbitmq.listener.simple.retry` con los números de `onFailure.retry` y `default-requeue-rejected: false` en `parameters/`; un `RabbitRetryTemplateCustomizer` que no reintenta `DomainException` ni `AmqpRejectAndDontRequeueException` | `dead-letter-config.js` (`rabbitListenerRetry`), `config.js`, skill `keel-spring-rabbitmq` |

Regenerado el par sobre MySQL + RabbitMQ, el mapa de constraints del `ApiExceptionHandler` coincide
entrada a entrada con el que el agente escribió a mano. El único TODO que queda es el de
`uk_notifications_natural`, que el diseño deja sin code a propósito. La hipótesis se mide con otra
corrida: la huella tendría que bajar de 23 a unos 16 reescritos, los de TODO legítimo.

