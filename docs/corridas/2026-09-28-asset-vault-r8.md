# Corrida 2026-09-28 — `asset-vault` v1.1.0, dos agujeros de la puerta

Corrida 2 de R8, la de forma distinta: modelo documental, storage, caché, reconciliación y cola SQS.
El diseño cruzó `--ready` 10/10 y la generación **no pasó el gate**: 2 escenarios en FALLO, ambos
atribuidos a `culprit: design`.

| | |
|---|---|
| Diseño | `asset-vault` v1.1.0 (DSL 2.17, documental) |
| Stack | mongodb · snssqs · keycloak · redis · minio |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **27/29 OK**, 2 FALLO (FL-AST-001, FL-AST-003), exit 1 |
| Huella del agente | 334 archivos registrados por `build`, 0 adoptados, **27 reescritos**, 0 borrados |
| Clasificación de la huella | 12 TODO · 0 consulta · 13 generador · 2 diseño · 2 puerta |
| Huecos del diseño | 2 (1 en `design-gaps.yaml` + 1 que no reportó nadie) |
| Huecos del generador | 9 (ver abajo) |
| Agujeros de la puerta | 2 |
| Coste del diseño | careo 23→9→2; barrido 55→11; revisión 10→6 |
| Convertidos en id | `CHK-SCEN-AUDIT-NOT-EXPOSED`, `CHK-SCEN-NEED-NOT-EXPOSED`; kind `response-shape` en el careo; preguntas en las clases 8 y 14 |

## Lectura

**El mismo defecto dos veces, resuelto al revés cada vez.** En los dos casos, un `Then` afirma en el
cuerpo de la respuesta un campo que el YAML no pone en la salida de la operación:

1. **`audit-all-asserted-in-contract`** (FL-AST-001 Then 2, y la convención «Autoría» de
   `validation-scenarios.md`). Afirman `createdAt`/`createdBy` en la respuesta de `uploadAsset`, pero
   `persistence` declara `audit.timestamps: all` y `audit.authorship: all`, que por
   `docs/dsl/persistence.md` no proyectan la auditoría a ningún contrato. El agente siguió al YAML y
   el escenario falló. Es lo que dejó la corrida en rojo.
2. **`need-exposed-without-exposedas`** (FL-AST-003 Then 1 y el `degradedTo` «thumbnail nulo»).
   Afirman la miniatura en la ficha de `getAsset`, pero el `need` `thumbnail` no declara `exposedAs`,
   y sin él «el dato solo sirve para decidir y no sale del servicio» (`docs/dsl/dependencies.md`). El
   agente siguió al escenario: añadió `thumbnail` a `GetAssetResponseDto` y a su mapper, y nadie lo
   reportó.

Que el agente eligiera en direcciones opuestas ante la misma contradicción es la prueba de que tuvo
que elegir. Los dos son **agujeros de la puerta**:

- La clase 14 del análisis de huecos hace exactamente la pregunta del primero («si el rastro lo lee
  alguien de fuera, la política es `declared`»), y `gaps.yaml` la dio por cerrada sin plantearla.
- La clase 8 no pregunta si el dato de un `need` sale en la respuesta.
- Y el careo tiene el kind `event-payload` para los eventos, pero ninguno equivalente para el cuerpo
  de una respuesta. Pasó FL-AST-001 y FL-AST-003 sin hallazgo en sus tres pasadas.

La raíz común es mecánica en parte: **un `Then` que nombra campos de respuesta fuera del `output`**.

## Huecos del generador

Los reportó el agente como huecos del diseño o no los reportó nadie:

- `audience-filter-single-chain` — sin ninguna ruta `audience: services`, `security.js` no parte la
  cadena y cuelga `AudienceAuthorizationFilter` sobre las rutas de usuario, así que todo token de
  usuario (`aud: account`) daría 403. Contradice `mapping.md` («`audience: both` va a la cadena 2, sin
  comprobación de audiencia»).
- `sqs-default-max-receive` — el agente lo reportó como hueco del diseño y no lo es. La suscripción
  `ThumbnailDelivered` no declara reintento y la decisión §3.5 dice «sin reintento y con DLQ», pero
  `messaging-provisioning.js` pone `maxReceiveCount` = 5 por defecto.
- `multipart-list-field` — el agente reportó `labels` como hueco del diseño y no lo es: la forma de
  una lista en multipart es del generador. El controller acepta las dos formas; el helper del arnés
  (`Map<String,String>`) y `mapping.md` no tienen regla.
- `security-chain-error-code` — el 401/403 de la cadena de seguridad sale sin `code`, y
  `framework-errors.md` no lo cubre. El agente lo reportó como hueco del diseño; la severidad es baja
  porque el escenario solo pide el status.
- `test-profile-broker-params` — build no emite `parameters/test/snssqs.yaml`, y el comentario de
  `application-test.yaml` habla de H2 en un proyecto Mongo.
- `replica-orphan-cleanup` — `AbstractFlowIT` no ve réplicas huérfanas (`REPLICA` es estático) y usa
  `ProcessHandle.descendants()` en Windows. Probable, aunque sin probar, causa del `0xC0000005`.
- `client-no-response-todo` — `PurgeThumbnailResult`, `PurgeThumbnailResponse` y `RenderingMapper`
  llevan un TODO innecesario para una llamada sin `response`.
- `scoping-not-translated` (discutible) — build no traduce `authentication.scoping` a Java, así que el
  agente escribe `CallerScope`, `JwtCallerScope` y los finders acotados: seis archivos de la huella.
- `storage-probe` — el arnés no tiene sonda de storage, así que FL-AST-001-D Then 4 queda sin
  afirmar.

## Arbitraje

Acepto la clasificación. Verifiqué contra `specs/` los dos huecos del diseño antes de registrarlos:
la convención «Autoría» y FL-AST-001 afirman la autoría en la respuesta con `audit: all`, y el
`need` `thumbnail` no tiene `exposedAs`. Queda abierto para el diseñador si `scoping-not-translated`
es del generador (hoy: 13 generador) o trabajo del agente (sería 18 TODO · 7 generador); no cambia
ninguna cuenta de H1.

Anoto dos candidatos de método que no son designGaps, porque el diseño sí lo decide en prosa:

- `private-binary-signed-url`: la regla de `getAsset` choca con `storage.md` y `mapping.md`.
- `scoping-exempt-service-client`: la exención del cliente máquina solo cabe en prosa. Es el
  hallazgo del método 2, que ya estaba abierto.

## Qué hacer

Por la regla de parada temprana, esto detiene la serie: se arregla el método y la corrida se repite
sobre una versión nueva del diseño.

- **Id mecánico.** Un `CHK-SCEN-*` (aviso) para un `Then` que nombra en el cuerpo de la respuesta un
  campo que no está en el `output` de la operación; `audit: all` y un `need` sin `exposedAs` son sus
  dos casos. Lleva su mutación.
- **Careo.** Un kind `response-shape` en `flow-walkthrough.md`, gemelo de `event-payload`.
- **Clases 8 y 14.** Preguntas explícitas: la 8 si el dato del `need` sale en la respuesta, y la 14
  si algún escenario lee la auditoría.

## designGaps

- `audit-all-asserted-in-contract` — un escenario afirma `createdAt`/`createdBy` en la respuesta con `audit: all`, que no los proyecta a ningún contrato
- `need-exposed-without-exposedas` — un escenario afirma en la respuesta el dato de un `need` que no declara `exposedAs`
