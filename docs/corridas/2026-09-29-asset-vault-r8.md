# Corrida 2026-09-29 — `asset-vault` v1.2.0, la repetición tras arreglar el método

Repite la corrida 2 de R8 (`2026-09-28-asset-vault-r8.md`), que dejó dos agujeros de la puerta y
detuvo la serie por la regla de parada temprana. Entre las dos se arregló el método. El diseño se
llevó a v1.2.0 con el método corregido y cruzó `--ready` 11/11. El stack es el mismo, para que la
única variable sea el diseño.

| | |
|---|---|
| Diseño | `asset-vault` v1.2.0 (DSL 2.17, documental) |
| Stack | mongodb · snssqs · keycloak · redis · minio |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **31/31 OK**, a la primera, sin arbitrajes de diseño |
| Huella del agente | 335 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Clasificación de la huella | 19 TODO · 1 consulta · 10 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (3 en `design-gaps.yaml`: dos del generador y un falso positivo) |
| Huecos del generador | 11 (6 repetidos de la v1.1.0) |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 6→4→4; barrido 12→7→4; revisión 7→1 |
| Convertidos en id | ninguno (los de la v1.1.0 ya estaban convertidos) |

## Lectura

**Los dos agujeros de la v1.1.0 no reaparecen, y el agente no tuvo que elegir nada.**
- `need-exposed-without-exposedas` queda cerrado por `exposedAs: thumbnail`.
- `audit-all-asserted-in-contract` queda cerrado por la convención de auditoría.
- De la v1.1.0 a la v1.2.0 la matriz pasa de 27/29 a **31/31**.
- La huella casi no cambia (27 → 30 reescritos), pero su naturaleza sí: 0 del diseño frente a 2.

**Lo que costó.** Llegar a 11/11 exigió tres pasadas de revisión, barrido y careo sobre un diseño
que en la v1.1.0 ya estaba en 10/10. De ellas salieron fallos serios que la v1.1.0 no vio: un
veredicto `infected` síncrono que nunca ponía el archivo en cuarentena, una clave de idempotencia
compartida en el tick y una ficha cacheada que sobrevivía a la cuarentena. El detalle está en
`recomendaciones-diseno.md` § R8.

**El residuo es del generador, y ya pesa más que el diseño.** La mayoría se repite de la v1.1.0:
- `publish-order-note-awaits-outcome` (nuevo): la nota de orden de `services.js` manda aplicar la
  transición antes de llamar al escáner. Contradice la regla del diseño cuando el veredicto decide la
  transición (`awaits: outcome`), y el agente siguió al diseño.
- `reconcile-claim-states-from-triggers` (nuevo): `reconciliationClaim` toma los estados de los `to`
  de `triggeredBy` en vez del `from` del barrido, y reclama `QUARANTINED`, que es terminal.
- `sqs-default-max-receive` (**repetido**): `maxReceiveCount` = 5 sin `retry` declarado. El agente lo
  reportó como contradicción del diseño, y no lo es.
- `audience-filter-single-chain` (**repetido**): el filtro de audiencia se aplica a los tokens de
  usuario.
- `client-no-response-todo` (**repetido**): cuatro archivos con TODO para una llamada sin `response`.
  Además, `.body(...)` sobre un DELETE sin cuerpo.
- `test-profile-broker-params` (**repetido**): no hay `parameters/test/snssqs.yaml`.
- `readme-relational-db-vars` (nuevo): el README de un proyecto Mongo pide `DB_USERNAME` y una URL JDBC.
- `multipart-list-field` y `storage-probe` (**repetidos**): el helper multipart es `Map<String,String>`,
  y el arnés no puede parar ni levantar el storage, que FL-AST-001-H necesita.
- `claim-timeout-equals-cadence` (nuevo, severidad baja).
- `scoping-not-translated` (**repetido**, discutible): si se arbitra como del generador, la cuenta
  queda en 14 TODO · 1 consulta · 15 generador.

**Tema de método, no designGap**: `private-binary-signed-url`, en su segunda corrida. El diseño
afirma que la respuesta entrega una URL firmada; el DSL dice que un `file` de bucket privado viaja
como key. build siguió al DSL y el agente al diseño. Hoy está aceptado como prosa en el careo, pero
dos corridas seguidas lo convierten en candidato obligatorio a una forma estructurada en el DSL.

## Arbitraje

Acepto la clasificación del agente de contexto limpio sin cambios. Dejo `scoping-not-translated`
como TODO, igual que en la v1.1.0, para que las dos corridas sean comparables.

## designGaps

Ninguno.
