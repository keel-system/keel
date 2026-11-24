# Lo que destaparon las corridas de prueba-gelsa: cazarlo en diseño y corregir los generadores

**Estado: ABIERTO (2026-11-20).** Inc. 0 a 6 hechos (2026-11-23); queda la corrida de control. Se ejecuta en varias sesiones, un incremento por sesión
como norma, y cada uno se cierra con «Para retomar» en § Estado y su commit.

## Contexto

En `C:\Users\antonio.suarez\proyectos\asuridev\prueba-gelsa` se generaron tres servicios con keel-spring 0.4.0
(DSL 2.32): `order`, `payment` y `notifications`. **Los tres diseños pasan `keel validate --ready` con los 13 criterios
en verde** (medido el 2026-11-20), y aun así la generación tropezó:

| Servicio | Matriz | Huecos de diseño | Defectos del generador |
|---|---|---|---|
| order v0.1.0 | 38/38 tras 3 pasadas (1.ª: 4 OK · 33 FALLO) | 7 (`design-gaps.yaml`) | 3 del arnés + 6 del scaffolding |
| payment v0.1.4 | 31/31 (24/31 a la primera) | 1, corregido por el diseñador (FL-QRY-001) | 5 |
| notifications v0.3.0 | **38/40, KO** (parada en fase 2b) | 3 (paginación) | 0 |

Fuentes: `services/<s>-spring/INFORME-GENERACION.md` y `design-gaps.yaml` de cada proyecto. Cada hallazgo de abajo se
contrastó contra el YAML de `specs/` y contra `packages/keel-spring/src`; su veredicto va al lado.

Dos objetivos: (A) que la puerta de diseño salga **roja antes de `build`** con todo lo que era del diseño; (B) corregir
los generadores, lo neutral primero en `keel-core/gen` y después los cuatro, por la regla de equivalencia.

## Hallazgos

### Del diseño (pasaron `--ready`)

- **D1. Página vacía o fuera de rango con totales ≠ 0.** Tercera corrida con este hueco (catalog-nest 1013, payment
  FL-QRY-001, notifications FL-TPL-030/FL-SUP-003): **id obligatorio**. En `specs/notifications/validation-scenarios.md`
  la convención (l. 51-53) condiciona los ceros a «si no hay ningún elemento», y las l. 343 y 775 afirman `items: []`
  con `totalElements: 3`. `assets/core/docs/validation-scenarios.md:221` dice «página vacía» pero no «fuera de rango».
- **D2. Dos fuentes para el mismo umbral** (order). `chargeOrder.unansweredAfterSeconds: 1800` y
  `captureOrderPayment`/`cancelOrderPayment: 600` (`dependencies.keel.yaml`) duplican `paymentPendingTimeoutMinutes` y
  `paymentActionRetryMinutes` (`service.parameters`), que el `reconciledBy` (`reconcileStalledOrders`) usa en sus
  `rules` y en `transitions[].stalledAfter`. El agente leyó los parámetros y `reconciliation.*.unanswered-after-seconds`
  quedó como configuración muerta. El DSL no permite enlazar `unansweredAfter` a un parámetro; `stalledAfter` sí, desde
  la 2.18.
- **D3. El contrato y los escenarios con un campo que la entidad no tiene** (order). `docs/order/openapi.yaml` y la
  proyección de `validation-scenarios.md` (l. 27, 66) dan a `OrderLine` un `orderId` que `domain.keel.yaml` no declara.
  `CHK-DOCS-OPENAPI-DRIFT` (`derived-coherence.js` `checkOpenapi`) solo compara rutas y status, no los esquemas.
- **D4. `naturalKey: [id]`** sobre el campo `id: true` (order, `Product`, además con `unique: true`). Es redundante y
  hace que se emita un `findById` duplicado que no compila.
- **D5. `tokenUrl: "${IDP_TOKEN_URL}"`** (order, `http-clients.keel.yaml:9`). Es un placeholder, no una URL. `tokenUri()`
  (`keel-spring/src/scaffold/config.js:1697`) no puede leerla y la deja tal cual en `local`, así que todo
  `POST /orders` daba 500.
- **D6. Givens que no fijan lo que sus Then afirman** (order FL-REC-002/004/005: líneas y total) y un Then incompleto
  (FL-ORD-006: `paymentId`). Es prosa, así que le toca al careo.
- **D7. Guardar un medio de pago sin decir de dónde sale la tarjeta** (payment). `payments.savePaymentMethod` solo
  declara `token`/`exposedAs`, pero `PaymentMethod.card` (`CardDetails`, obligatorio y `personal`) solo lo puede
  informar la pasarela.

### Del generador (keel-spring 0.4.0)

- **G1. `SEQUENCED` sobrevive al reset — confirmado.** `resetState()` (`integration-tests.js` ~l. 2469) corre
  `reset-db.sh`, que reinicia WireMock, pero solo `resetStubs()` (~l. 2355) vacía `SEQUENCED`, y `resetState` no lo
  llama. La segunda clase que programa `stubSequence` sobre la misma ruta revienta en `@BeforeAll`.
- **G2. Falta `stubForDelayed`** (respuesta válida con retardo). `StubResponse.timeout` devuelve el cuerpo vacío.
- **G3. Métricas del arnés con 401** (`deadLetteredEvents`, `queryCount` y `queryExecutions` vía `actuatorMetric`), con
  la regla por defecto `required` y sin roles. **Por reproducir**: `actuatorCredential` debería mandar token. Además,
  `/actuator/prometheus` solo sirve `text/plain` y `exchange()` fija `Accept: application/json`.
- **G4. M2M saliente sin stub de token.** No se emite `infra/http-stubs/mappings/<cliente>-token.json`, y el
  placeholder de D5 no se redirige en `local`.
- **G5. Frontera transaccional — confirmado.** `createOrder` y `cancelOrder` disparan una activación HTTP con
  `awaitingSince` + `degrade`, así que tienen que confirmar la espera **antes** de llamar. Hoy solo se deriva para
  pagos: `callsPaymentGateway` (`keel-core/src/lib/gen/payments-model.js:207`), que consumen `controllers.js:500` y
  `messaging.js:675`. El agente cambió a mano el controller a `dispatchWithoutTransaction`. **No hace falta DSL**: la
  derivación ya está en `awaitingSince` + `reconciledBy` (la propuesta `consistency.transactionalBoundary` del gap se
  descarta).
- **G6. `findById` duplicado** (el lado generador de D4): un finder por `naturalKey` igual al id no debe emitirse.
- **G7. DTO de hija sin el campo del contrato** (`OrderLineDto` sin `orderId`). Es D3: el contrato inventó el campo,
  así que se corrige en el diseño. No es un defecto del generador.
- **G8. `reconciliation.yaml` muerto.** Se resuelve con D2.
- **G9. `PaymentGateway.savePaymentMethod` devuelve `String`** (`payments.js:274`, `payment-gateways/stripe.js:151`,
  `mercadopago.js:137`). Se pierde `card` y no se distingue el rechazo del 3DS.
- **G10. El `HttpClient` del JDK reintenta un GET sin respuesta** (`jdk.httpclient.redirects.retrylimit`, que es el
  `max_attempts` de `MultiExchange`). Duplica la consulta de estado a la pasarela. El agente lo fijó como propiedad
  global del proceso. **Hay que medirlo** antes de arreglarlo.
- **G11. `@Modifying` del agente en un adaptador `@Transactional(readOnly = true)` de clase** (`repositories.js:874`):
  hereda el solo lectura y falla (`claimAwaiting` de payment). Ni la nota ni el gate lo avisan.
- **G12. Faltan primitivas del arnés de pagos**: guardar con datos de tarjeta, rechazo por 3DS al guardar, devolución
  de un importe concreto, anulación con «autenticación fallida» y pasarela que retiene la respuesta hasta que llega el
  aviso (FL-STL-009).
- **G13. `NOT_FOUND` en la reconciliación de un cobro en `capturing`/`refunding`**: no tiene desenlace. Es un caso
  anómalo: va como pregunta de revisión, no como código.
- **Sin acción**: la `claim-timeout-ms` (760 s) mayor que el umbral de prueba (1 min) es el diseño del reclamo
  (`reconciliation-stores.js`). Se documenta en la nota del handler cuando entre D2 (inc. 4).

## Reglas de trabajo

Secuencial desde `main`, sin subagentes en paralelo ni worktrees. Temporales en `D:`. Cada regla de keel-core con su
id en `crossrefs.js`, su entrada en `checks.js` con `nature`, su caso en `test/crossrefs.test.js` y **su mutación** en
`test/design-mutations/catalog.js` (extensión limpia si el base no tiene la forma), y después `npm run design-matrix`.
Lo neutral en `keel-core/gen`, y cada generador con su test de paridad.

**Los diseños de prueba-gelsa no se tocan**: son el sujeto de medida. Toda regla nueva se prueba contra una copia de su
`specs/` en `D:`.

## Incrementos

0. **Registrar las corridas (sesión corta).** `docs/corridas/2026-11-19-{order,payment,notifications}-gelsa.md` con la
   tabla de etiquetas de `docs/corridas/README.md`, la huella (`corrida-metrics.js footprint` sobre cada proyecto) y la
   sección `## designGaps` con clave estable por hueco. Así D1 sale repetido en `corrida-metrics.js series`. **Va
   primero**: los proyectos pueden borrarse.
1. **keel-core: la puerta sin DSL nuevo.**
   - `CHK-SCEN-PAGE-TOTALS` (D1, aviso, `incoherence`). Esbozo ya probado contra los tres diseños: en `crossrefs.js`,
     tras `CHK-SCEN-ORDER-UNDECLARED`, recorre las `sections` cuyo When nombra una operación con `output.paginated`.
     Parte el Then en cláusulas (ítems numerados y `;`) y avisa si una cláusula lleva `items: []` (o `` `items` = [] ``)
     junto a `totalElements`/`totalPages` ≥ 1. Además, `conventionsSection` gana `paginacion` (cabecera
     `/paginaci[oó]n/`) y avisa si menciona «fuera de rango» y condiciona los ceros con «si no hay…». Sobre las copias
     da 3 avisos en notifications (FL-TPL-030, FL-SUP-003 y la convención) y ninguno en payment (ya corregido) ni en
     order. Para la mutación, el base no tiene query paginada: se pone `listTickets` con `paginated` en una extensión y
     se comprueba que no dispare nada más. Se corrige `validation-scenarios.md:221` («vacía **o fuera de rango**») y la
     guía de escenarios de `/keel-design`.
   - `CHK-PERSIST-NATURALKEY-IS-ID` (D4, `incoherence`).
   - `CHK-HTTPCLIENT-TOKENURL-PLACEHOLDER` (D5): `auth.tokenUrl` tiene que ser una URL absoluta. Lo que cambia por
     entorno ya lo pone la variable del generador.
   - `CHK-DOCS-OPENAPI-DRIFT` también sobre los esquemas (D3): propiedades y `required` de `components.schemas`
     contra `gen/openapi.js`. Se sabotea un derivado en `test/derived-coherence.test.js`.
   - `CHK-SCEN-PROJECTION-UNKNOWN-FIELD` (D3, aviso): una proyección «lleva exactamente `a`, `b`…» no puede nombrar
     un campo que la entidad o el output no tengan.
   - Careo (D6): paso explícito en `assets/skills/keel-design/references/flow-walkthrough.md` y
     `assets/agents/keel-flow-review.md`: «cada valor que un Then afirma, o del que depende, está fijado en su Given».
   - `REV-PAYMENTS-RECONCILE-INFLIGHT-NOTFOUND` (G13) en `reviews.js` + `review-checklist.md`.
   - Medido con la suite de keel-core, `design-matrix` (sin `sin-mutacion`) y `keel validate` sobre las copias.
2. **keel-core/gen + keel-spring: los defectos sin DSL nuevo.**
   - G5: `commitsBeforeOutbound(model, op)` en `keel-core/gen`, que generaliza `callsPaymentGateway`. Una operación
     que dispara una activación `via client` con `awaitingSince`, o una de pagos, se despacha `withoutTransaction` y
     lleva la nota neutral del handler. En keel-spring lo consumen `controllers.js`, `messaging.js` y `services.js`.
     Sujeto: una fixture con activación HTTP + `degrade` + `awaitingSince` (comprobar si `stock-reservation` tiene la
     forma; si no, una silueta nueva).
   - G6: suprimir el finder de `naturalKey == [id]` en `gen/model.js`.
   - G4: `tokenUri()` con una ruta fija del stub si la URL no se lee, y el mapping de token emitido desde
     `gen/infra-scripts.js` (neutral). Lo mide `stub-check`.
   - G1 + G2: `resetState()` vacía `SEQUENCED`, y `stubForDelayed` sale del mismo renderizado que `stubSlowBody`
     (`test/stub-sequence.test.js`). Después, `compile-check`.
   - G3: primero se reproduce con la seguridad de order en `test/corrida-fixes.test.js`, y después se arregla
     `actuatorCredential` o el `Accept` de la lectura de prometheus. Lo mide `telemetry-check`.
   - G11: nota en `services.js` y en `keel-spring-database`, y un check en `check-idempotency.sh` (familia
     `sweepClaim`, con una prueba que lo EJECUTE). Antes se valora si build puede generar él mismo el reclamo del
     barrido de pagos, como `reconciliation-claim.js`.
3. **keel-nest, keel-dotnet y keel-go: lo del inc. 2.** Uno tras otro, cada uno con su test de paridad contra keel-spring
   (G5, G6, G4, G1/G2 y G3 donde aplique) y sus redes (`stub-check`, `harness-check`, `ts-check`/`cs-check`/`go-check`).
   Si no cabe en una sesión, se parte en 3a, 3b y 3c.
4. **keel-core: DSL 2.33.** Se sigue «Nueva versión del DSL» de CLAUDE.md:
   - D2: `unansweredAfter: { parameter, unit }`, excluyente con `unansweredAfterSeconds`, en
     `dependencies.schema.json` y `payments.schema.json` (`reconciliation`), calcado de `stalledAfter`. Va con
     `CHK-DEPS-UNANSWERED-DUPLICATES-PARAMETER`: el `reconciledBy` enlaza un parámetro sobre la misma `awaitingSince` y
     la activación fija segundos. En `gen/reconciliation-stores.js`, el umbral sale del parámetro y su clave deja de
     emitirse (como `sweep.yaml` con `stalledAfter`). La relación con `claim-timeout-ms` va en la nota del handler.
   - D7: `payments.savePaymentMethod.cardDetails: <campo>` (opcional) + `CHK-PAYMENTS-SAVED-CARD-UNSOURCED`. Antes se
     lee qué cubre `REV-PAYMENTS-CARD-DATA`: si lo pretendía, se mecaniza.
   - Docs (`dsl/dependencies.md`, `dsl/payments.md`, historial de `dsl-reference.md`), plantilla, fixtures, base del
     corpus y `SUPPORTED_DSL` de los cuatro.
5. **keel-spring: DSL 2.33 y pagos.** D2 en `config.js`/`reconciliation-claim.js` y en el gate `reconciliation` de
   `idempotency-check.js`. G9: el puerto devuelve `SavedPaymentMethod` y una excepción propia para el 3DS, en
   `payments.js` y en los dos adaptadores, con sus formas en `gen/payment-probes.js`. G10: primero un caso de
   `payment-check` («GET sin respuesta = 1 petición»); si cae, el reintento se desactiva solo en el cliente de la
   pasarela. G12: las primitivas del arnés de pagos. Redes: `payment-check` (con sabotaje nuevo), `store-check`,
   `compile-check`.
6. **keel-nest, keel-dotnet y keel-go: DSL 2.33 y pagos.** Paridad contra keel-spring y sus redes (`stub-check`,
   `db-check`/`doc-check`). Se parte en 6a, 6b y 6c si hace falta.
7. **Corrida de control** (la lanza el usuario). Con `/keel-evolve` en el workspace de prueba-gelsa (ya con las reglas
   nuevas en rojo y corregidas), `build --refresh` y `/keel-generate-spring`: 40/40, 38/38 y 31/31 a la primera, sin
   `harnessPatches` ni `designGaps` del generador, con la huella medida y registrada en `docs/corridas/`.

## Puerta de cierre

- Sobre las copias **originales** de los tres diseños, `keel validate --ready` sale en rojo: D1 en notifications,
  D2, D3, D4 y D5 en order, y D7 en payment, cada uno con su id.
- `design-matrix` sin `sin-mutacion`, y la suite de los seis paquetes en verde.
- Cada defecto G con su red en vivo y su sabotaje cayendo en su caso.
- La corrida de control en verde a la primera.

## Verificación

- `npm test` en la raíz y `npm run design-matrix --workspace packages/keel-core`.
- `node packages/keel-core/src/cli.js validate <copia>/specs/<s> --ready`.
- keel-spring: `compile-check`, `stub-check`, `payment-check`, `telemetry-check` y `store-check`. Los equivalentes en
  nest, dotnet y go, y `npm run matrix` en los cuatro.
- Lo emitido para las fixtures que no tienen las formas nuevas, idéntico byte a byte antes y después.

## Decisiones del usuario (2026-11-23)

1. D2 y D7 entran juntas en la DSL 2.33.
2. La corrida de notifications espera a la corrida de control del inc. 7: su diseño no se corrige antes.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. Registro de corridas | hecho (2026-11-23) | `corrida-metrics.js series`: `page-out-of-range-totals` repetido en 3 corridas; H1 sin cambio |
| 1. keel-core: puerta sin DSL | hecho (2026-11-23) | suite de keel-core 1684/1684, `design-matrix` sin `sin-mutacion` (246 falsados), `--ready` sobre las copias |
| 2. keel-core/gen + keel-spring | hecho (2026-11-23) | `npm test` de la raíz en verde (6 paquetes); `compile-check` de catalog-extended en 4 combos; el arnés de la copia de order y el `main` de job-dispatch con `naturalKey: [id]` compilados, y G6 falsado |
| 3. nest, dotnet, go | hecho (2026-11-23) | 3a: suite de keel-nest, `ts-check --only=catalog-gelsa-order` 13/13, `stub-check` 28/28. 3b: suite de keel-dotnet 1076/1076, `cs-check --fixtures --only=catalog-gelsa-order` (falsado), `stub-check` 9/9. 3c: suite de keel-go, `go-check` de la silueta y de stock-reservation (G6 falsado), `stub-check` 12/12 |
| 4. DSL 2.33 en keel-core | hecho (2026-11-23) | `npm test` de la raíz en verde (6 paquetes), `design-matrix` sin `sin-mutacion`, `--ready` en rojo con su id en las tres copias |
| 5. keel-spring 2.33 y pagos | hecho (2026-11-23; G10 aceptado como está) | `payment-check` en las dos pasarelas, sabotaje `saved-card`; `claim-check` del barrido de pagos en PostgreSQL y MySQL, falsado |
| 6. nest, dotnet, go 2.33 y pagos | hecho (2026-11-23) | 6a: suite de keel-nest 1234; `ts-check --only=payment-checkout` 13/13; `stub-check` 37/37; `db-check --subject=payment-checkout` en PostgreSQL y MySQL, con los dos sabotajes del reclamo cayendo en sus casos PS. 6b: suite de keel-dotnet 1087; `cs-check --fixtures` de payment-checkout, -mp, -233 y stock-reservation-233 sin warnings (748 pruebas emitidas), con `payment-saved-card` y `payment-save-3ds` en rojo; `stub-check` 9/9 (17 sondas por pasarela); `db-check --only=payment-checkout` en PostgreSQL y MySQL, con los dos sabotajes en sus casos PS. 6c: `npm test` de la raíz en verde (keel-go 1690); los pasos de `go-check --fixtures` (tidy, gofmt, vet, staticcheck y pruebas) sobre payment-checkout con las dos pasarelas, en MySQL y en MongoDB, payment-checkout-233 y stock-reservation-233; `stub-check` 12/12; `db-check --only=payment-checkout` en PostgreSQL y MySQL, con los dos sabotajes en sus casos PS |
| 7. Corrida de control | pendiente | |

**Para retomar:** inc. 0 y 1 hechos. El inc. 1 dejó en keel-core:
- `CHK-SCEN-PAGE-TOTALS` (D1);
- `CHK-PERSIST-NATURALKEY-IS-ID` (D4);
- `CHK-HTTP-TOKENURL-PLACEHOLDER` (D5; el plan decía `CHK-HTTPCLIENT-…`, pero el prefijo de la capa es `CHK-HTTP-`);
- `CHK-SCEN-PROJECTION-UNKNOWN-FIELD` (D3);
- `CHK-DOCS-OPENAPI-DRIFT` sobre los esquemas (D3). Compara solo lo que SOBRA en un esquema que se llama como una
  entidad, contra el dominio y no contra `gen/openapi.js`, que exige una proyección de lenguaje. Lo que falta suele
  ser un campo excluido a propósito; medido sobre siete openapi.yaml reales, la única desviación es `OrderLine.orderId`;
- el kind `unfixed-given` del careo (D6);
- `REV-PAYMENTS-RECONCILE-INFLIGHT-NOTFOUND` (G13).

Sobre las copias originales (`D:\keel-gelsa`), `--ready` sale en rojo en order (D3, D4, D5) y en notifications (D1),
y payment sigue en verde hasta el inc. 4 (D7). D2 también es del inc. 4. `CHK-DOCS-*` no cuenta en `incoherences`
(`OWNED_ELSEWHERE` de `readiness.js`), así que en order D3 lo pone en rojo la regla de la proyección.

**Inc. 2, lo que quedó:**
- **G6**: `naturalKeyIsIdentity` (`gen/relational.js`). keel-spring no emite el finder de una clave que es la
  identidad. La causa de order no era solo el `naturalKey: [id]` escrito a mano: `resolveReplica` (`gen/model.js`) metía
  en la clave la `keyField` de una réplica aunque fuera el id. Ya no lo hace, y la lectura por lote de esa réplica va
  por `findAllById` (`idBatchReason` → `replica-listing`, `ref-targets.js`). Falsado: sin la guarda, el `main` de
  job-dispatch con `naturalKey: [id]` no compila.
- **G5**: `gen/outbound-boundary.js` (`commitsBeforeOutbound`, `outboundBoundaryNote`). Restringido a las
  activaciones HTTP con `awaitingSince` y `awaits: acknowledgement`: con `outcome` el veredicto decide la transición y
  no hay espera que confirmar (publishAsset y retireProduct no cambian). Ninguna fixture tiene la forma; la silueta es
  la retirada de catalog-extended con `acknowledgement` (`keel-spring/test/outbound-boundary.test.js`).
- **G4**: `localTokenPath`/`tokenStubMappings` en `gen/http-clients-config.js`, con ruta fija por cliente si la URL no
  se lee. El mapping `infra/http-stubs/mappings/<cliente>-token.json` lo emite `infra-scripts.js`, NEUTRAL, así que ya
  lo tienen los cuatro (catalog-extended es la única fixture con oauth2). keel-spring no tiene `stub-check`: su red es
  el test del JSON y el compile-check; la medida en vivo es la corrida de control.
- **G1 + G2**: `resetState()` vacía `SEQUENCED` tras `reset-db.sh`, y `stubForDelayed`/`StubResponse.delayed` salen de
  `stubDelayedBody`, del que derivan también la respuesta normal y la lenta.
- **G3**: `actuatorCredential` cae en una persona sin roles (`tokenAs("actuator-reader", Map.of())`) cuando el diseño no
  tiene roles ni clientes y sí tokens de persona. El `Accept` de `/actuator/prometheus` NO se tocó: el arnés no lee
  ese endpoint; el agente se pasó a él porque `metrics` le daba 401.
- **G11**: solo notas (el javadoc de `PaymentReconciliation` y la skill `keel-spring-database`). El check del gate
  necesitaría una clase de comprobación nueva en el motor neutral (`idempotency-gate.js`: un `@Modifying` sin su
  `@Transactional` en el mismo método), y la solución de raíz es que **build genere el reclamo del barrido de pagos**
  (re-estampar `awaitingSince` con un UPDATE condicional sobre los estados en vuelo, como `reconciliation-claim.js`).
  Se valora y se mueve al **inc. 5** (pagos).
- Sin medir en vivo: `telemetry-check` no aplica a G3 (el helper es del arnés, no del servidor) y la red en vivo de
  G1-G4 es la corrida de control.

**Inc. 3, en curso.** Se parte en 3a (keel-nest), 3b (keel-dotnet) y 3c (keel-go), una sesión cada uno si hace falta.
- **3a (keel-nest) hecho (2026-11-23):**
  - G2: `stubDelayedResponse` neutral en `keel-core/gen/http-stub-probes.js`, y `stubForDelayed`/`StubResponse.delayed`
    desde `delayedBody` (`src/scaffold/http-stub-harness.js`). Medido en vivo: caso nuevo de `stub-check` (28/28).
    G1 ya estaba (`forgetSequences()` en `resetState`).
  - G5: `controllers.js` y `messaging.js` con `commitsBeforeOutbound`, y `outboundBoundaryNote` en `services.js`.
    `test/outbound-boundary.test.js` compara la nota con la de keel-spring, y las tres operaciones de control conservan
    la transacción.
  - G6: el puerto de keel-nest ya no duplicaba `findById` (su finder por clave natural no lo pedía con la clave arreglada
    en keel-core). Lo que faltaba era el lote de la réplica: `replicaBatchFinder` (`projections.js`) usa `findAllById`
    con `replica-listing`, y lo usan el lector y la nota del handler. La silueta `catalog-gelsa-order`
    (`DERIVED_SILHOUETTES`: réplica con `keyField: id` y `recordWithdrawal` con `acknowledgement`) la compilan
    `ts-syntax` y `ts-check`. `ts-check` destapó un defecto más: el snapshot del proyector tipaba la clave `string | null`
    (el id no es `required`) y no compilaba con strict. La clave ya es no nula, y el TODO de `projectionOf` ya no dice
    «genera el id» cuando la clave es el id, tampoco en keel-spring (`dependencies.js`).
    `test/natural-key-identity.test.js` lo mide, falsado quitando el `findAllById` del lector.
  - G3 no aplica: `deadLetteredEvents` y `queryCount` leen en el mismo proceso, sin actuator ni credencial. El humo ya
    cae en una persona vía `closingCredentialOf`.
- **3b (keel-dotnet) hecho (2026-11-23):**
  - G2: `StubForDelayed` y `StubResponse.Delayed`, más `Timeout`, salen de `HttpStubHarness.Response(status, body,
    delayMs)` (`src/scaffold/http-stub-harness.js`). Lo mide una sonda nueva en `scripts/probes/StubProbes` contra
    WireMock real: `stub-check` 9/9, con 11 sondas. G1 ya estaba (`ForgetSequences()` en el reset).
  - G5: `endpoints.js` y `messaging.js` con `commitsBeforeOutbound`, y `outboundBoundaryNote` en `services.js`.
    `test/outbound-boundary.test.js` compara la nota con keel-spring y keel-nest.
  - G6: aquí era peor que en keel-nest. Con `keyField: id`, el proyector y el lector buscaban la copia por la clave
    natural de persistencia pasándole el id (`FindBySku(snapshot.Id)`, Guid contra string: no compila). Además, la copia
    nueva nacía con un id nuevo y no con el del proveedor. Ahora `replicaFinder`/`replicaBatchFinder` (`projections.js`)
    buscan por `FindById`/`FindAllById`, y la copia nueva toma `snapshot.Id`. La silueta `catalog-gelsa-order` está en
    `UNCOVERED_BRANCHES` y `cs-check --fixtures --only=catalog-gelsa-order` la compila sin warnings (260 pruebas
    emitidas). Falsado: sin `replicaFinder` caen el lector y el proyector con CS1503. Lo mide
    `test/natural-key-identity.test.js`.
  - G3 no aplica: `DeadLetteredEvents` y `QueryCount` leen la base o el proceso, sin credencial.
- **3c (keel-go) hecho (2026-11-23):**
  - G2: `StubForDelayed` y `RespondDelayed`, de la que sale también `RespondTimeout` (`src/scaffold/http-stub-harness.js`),
    enseñados en `integration-tests.md` y en la skill `keel-go-httpclient`. Lo mide una sonda nueva de
    `scripts/probes/stub_probe_test.go` contra WireMock real: `stub-check` 12/12, con 11 sondas en stock-reservation. G1
    ya estaba (`stubSequences.forget()` en el reset).
  - G5: `endpoints.js` y `messaging.js` con `commitsBeforeOutbound` (`application.WithoutTransaction`), y
    `outboundBoundaryNote` en `services.js`.
  - G6: como en keel-dotnet, el proyector y el lector buscaban la copia con `FindBySku(snapshot.ID)` (no compilaba) y la
    copia nueva nacía con otro id. Ahora `replicaFinder`/`replicaBatchFinder` (`projections.js`) usan
    `FindByID`/`FindAllByID`, y la copia nueva toma `snapshot.ID`. Falsado: sin la guarda, la silueta no compila.
  - `test/gelsa-order.test.js` mide G5 (la nota, comparada con keel-spring y keel-dotnet, y las tres operaciones de control)
    y G6. La silueta `catalog-gelsa-order` está en `UNCOVERED_BRANCHES`.
  - G3 no aplica: `counter.Wrap` envuelve el servidor entero, por fuera de la seguridad, y `DeadLetteredEvents` lee la base.
  - Medido: suite de keel-go 1676/1676, y los pasos de `go-check --fixtures` (tidy, gofmt, vet, staticcheck y pruebas)
    sobre `catalog-gelsa-order` (PostgreSQL y MySQL) y stock-reservation. El `--fixtures` entero no se terminó: tenía 121
    variantes que comprobar una a una (memoria libre baja, horas), y el cambio solo toca esas formas.

**Inc. 3 cerrado.**

**Inc. 4 hecho (2026-11-23): DSL 2.33 en keel-core.**
- D2: `unansweredAfter: { parameter, unit }` (`$defs/parameterDuration` de `common.schema.json`), excluyente con
  `unansweredAfterSeconds`, en la activación y en `payments.reconciliation` (que pasa a `oneOf`). Lo acompañan
  `CHK-DEPS-UNANSWERED-AFTER-INVALID` (error) y `CHK-DEPS-UNANSWERED-DUPLICATES-PARAMETER` (aviso, `incoherence`): la
  activación fija segundos y una `rule` del `reconciledBy` nombra su `awaitingSince` junto a un parámetro `int`. En
  pagos, un parámetro que falta o no es entero es `CHK-PAYMENTS-FIELD-UNKNOWN`. En el modelo neutral el enlace se
  resuelve como `stalledAfter` (`unansweredParameter`, con `stalledParameter`): el descriptor del reclamo lleva
  `unansweredAfterSeconds: null`, `reconciliationParameters` da `{ key: null, parameter }` y ni
  `reconciliation.yaml` ni `payments.yaml` emiten la clave.
- D7: `payments.savePaymentMethod.cardDetails` y `SAVED_CARD_FIELDS` (`payment-vocabulary.js`: brand, last4,
  expMonth, expYear). `CHK-PAYMENTS-SAVED-CARD-UNSOURCED` (aviso): un value object compuesto obligatorio de la
  entidad que devuelve la operación, que el input no trae y que no es `cardDetails`. `cardDetails` sobre algo que no
  es un compuesto, o con un campo que la pasarela no informa, es `CHK-PAYMENTS-FIELD-UNKNOWN`.
  `REV-PAYMENTS-CARD-DATA` no lo cubría: es la tarjeta que ENTRA por un input (PCI).
- La frontera: `dsl233PendingErrors` (`gen/reconciliation-stores.js`) rechaza las dos formas con el mismo mensaje en
  los cuatro, hasta el inc. 5 en keel-spring y el 6 en los otros tres (fila en `keel-go/README.md` y en
  `EXCEPCIONES` de los cuatro `capability-coverage.test.js`). Quitarla es lo primero del inc. 5/6, y la fixture que
  declare las formas también (candidatas: `stock-reservation` y `payment-checkout`).
- Mutaciones: `M-DEPS-UNANSWERED-AFTER-UNKNOWN-PARAM`, `-NOT-INT`, `M-DEPS-UNANSWERED-DUPLICATES-PARAMETER` (extensión
  `escalation`) y `M-PAYMENTS-SAVED-CARD-UNSOURCED` (extensión `payments`). Lo que no ven, en
  `keel-core/test/dsl-233.test.js`.
- Subida: schema del manifiesto, plantilla, base del corpus, 21 fixtures, `SUPPORTED_DSL` y `keel.dsl` de los cuatro,
  READMEs; docs en `dsl/dependencies.md`, `dsl/payments.md` y la fila 2.33 de `dsl-reference.md`.
- Medido: las copias de `D:\keel-gelsa` declaran 2.32 y ya no validan (una sola versión), así que la puerta se mide
  sobre `D:\keel-gelsa-233`, que solo cambia `keel:`. `--ready` en rojo: order con D2 (×3), D3, D4 y D5; payment con
  D7 (y `review` por `REV-PAYMENTS-RECONCILE-INFLIGHT-NOTFOUND`, de G13); notifications con D1 (×3).

**Siguiente: inc. 5 (keel-spring: 2.33 y pagos).** Quitar `dsl233PendingErrors` de keel-spring y generar D2 (el reclamo
y el gate `reconciliation` leen el parámetro) y D7 (`SavedPaymentMethod` con el resumen), y después G9, G10, G11 y G12.

**Inc. 5, en curso (2026-11-23).**
- D2 en keel-spring: con `unansweredAfter`, el `@Value` del reclamo (`reconciliation-claim.js`) y el del barrido de
  pagos (`payments.js`, `sweepThresholdValue`) leen `#{${propiedad del parámetro} * unitSeconds}`, la forma de
  `stalledAfter`. Ninguno de los dos yaml (`config.js`) emite la clave. El javadoc del reclamo nombra el parámetro.
  La nota del barrido (`services.js`), el `bound` del gate `reconciliation` (`idempotency-check.js`) y
  `parametrosDelBarrido` (`store-probes.js`) también, pero son ramas de un barrido que escribe el agente, y en las
  fixtures todos los reclamos los genera build: **no tienen sujeto**. Lo mide `test/unanswered-parameter.test.js`.
- D7 + G9 en keel-spring: el puerto devuelve `SavedPaymentMethod(reference, SavedCard)`, con
  `PaymentMethodRejectedException` y `PaymentMethodAuthenticationRequiredException` (antes, un `String` y una
  `IllegalArgumentException`). Lo neutral está en keel-core: `savedCard` y `saveAuthenticationCodes` en
  `gen/payment-gateways.js`, contrastados con la documentación de Stripe (attach: `card.*`; 3DS:
  `authentication_required`) y de MercadoPago (`last_four_digits`…; sin 3DS al guardar); `savedCardResponse` y
  `saveAuthenticationRejection` en `gen/payment-probes.js`; y `savedMethodNote` en `gen/rejection-notes.js`, la nota
  del handler que dice dónde va el resumen (`cardDetails`). La Java común de los dos adaptadores sale de
  `savedMethodJava` (`payments.js`).
- G12, solo la parte de guardar: `gatewaySavesCard(...)` y `gatewayRequiresAuthenticationToSave()` en el arnés
  (MercadoPago lanza: no pide 3DS al guardar). Faltan la devolución de un importe concreto, la anulación con
  «autenticación fallida» y la pasarela que retiene la respuesta (FL-STL-009).
- La frontera de keel-spring ya genera las dos formas (`dsl233PendingErrors` con `generates`).
- Medido: `payment-check` en verde en las dos pasarelas, con tres casos nuevos y el sabotaje `saved-card` cayendo en
  exactamente su caso en las dos. El 3DS se falsó a mano una vez (`if (false && asksAuthentication…)`): cae su caso.
- **G10, medido y sin arreglar**: una consulta de estado sin respuesta llega DOS veces a la pasarela, en las dos y con
  un cliente nuevo (sin conexión reutilizada). Es el reintento de peticiones idempotentes de `MultiExchange`, y en el
  JDK solo se apaga con una propiedad GLOBAL del proceso (`jdk.httpclient.redirects.retrylimit`), que es lo que hizo
  el agente. No hay interruptor por cliente, y volver a otro cliente choca con el filtro anti-SSRF, que exige el del
  JDK (`outbound-address.js`). **Decidido por el usuario (2026-11-23): se acepta la consulta repetida** (es un GET: no cobra dos veces), y no se
  toca la propiedad global. El caso
  de `payment-check` se escribió, dio 2 en las dos pasarelas y se retiró para no dejar la red en rojo.
- `compile-check` de payment-checkout en verde con las dos pasarelas (el arnés nuevo y el main).
- **G11 hecho (estático)**: build genera el reclamo del barrido de pagos (`src/scaffold/payment-sweep-claim.js`):
  `<Registro>Repository.claimForPaymentSweep(staleBefore, batchSize)` en el puerto, el SELECT de candidatos (con la
  selección de `claim-sql.js`) y el UPDATE condicional que renueva `awaitingSince` sin mover el estado en la interfaz
  JPA, y el adaptador con su `@Transactional(REQUIRES_NEW)` de método, o un `findAndModify` por candidato en
  documental. Con cronómetro avisa él mismo del lote lleno (`SweepPass.claimed`). Va fuera de `operation.claim` del
  modelo neutral a propósito: los otros tres lo emitirían como un rescate con las claves de `sweep.yaml`. La nota del
  handler del barrido, el javadoc de `PaymentReconciliation` y la skill `keel-spring-payments` dicen que ya está
  generado. Lo mide `test/payment-sweep-claim.test.js` (las dos ramas) y compila en `compile-check` de
  payment-checkout. **Ejecutado contra el motor**: `node scripts/claim-check.js payment-checkout
  --database=postgresql|mysql`, 6/6 en los dos (lo rancio de cada estado en espera entra sin mover el estado y con el
  reloj renovado, la segunda pasada no lo vuelve a tomar, lo reciente y lo de otro estado no, el lote va acotado y
  una fila sin reloj no la recoge nadie). Falsado en PostgreSQL: `--sabotage=payment-sweep-no-lease` cae en el caso del
  reloj y `--sabotage=payment-sweep-cutoff` en sus cuatro casos, exactamente. El primer intento de `no-lease` dejaba
  el reloj en el corte y no caía: PostgreSQL redondea a microsegundos y el reloj podía quedar por encima. **La rama
  documental no se ha ejecutado**: ninguna fixture tiene pagos sobre MongoDB.
- **El resto de G12 hecho**: `gatewayReportsRefunded(referencia, total)` (la consulta da el cobro devuelto por ese
  total; `gatewayReports(…, "REFUNDED")` la usa con 10.00), `gatewayCancelFails(referencia, motivo)` (la anulación
  vuelve como cobro fallido con el motivo neutro, que los dos adaptadores leen con `outcomeOf`) y
  `gatewayAnswersLate(llamada, referencia, estado, ms)` (la respuesta retenida de FL-STL-009, para CHARGE, CAPTURE y
  CANCEL, con `fixedDelayMilliseconds`). Van en la parte común del arnés: las dos pasarelas tienen `gatewayObject` y
  `GATEWAY_DECLINES`. La skill `keel-spring-payments` las enseña. Medido: `test/saved-card.test.js` en las dos pasarelas y
  `compile-check` de payment-checkout con las dos. **Sin red en vivo propia**: el arnés solo se ejecuta dentro de una
  corrida; las formas son las de `gatewayObject`, que ya usaban las primitivas medidas en corridas anteriores.

**Inc. 5 cerrado (2026-11-23).** Siguiente: inc. 6, lo mismo en keel-nest, keel-dotnet y keel-go (partido en 6a, 6b y
6c): quitar `dsl233PendingErrors`, D2, D7+G9 (con lo neutral de keel-core ya hecho: `savedCard`,
`saveAuthenticationCodes`, `savedCardResponse`, `saveAuthenticationRejection`, `savedMethodNote`), G11 (su reclamo del
barrido de pagos y la red que lo ejecute contra el motor) y las primitivas de G12, con su paridad contra keel-spring.
Cuando los cuatro lo generen, una fixture que declare `unansweredAfter` y `cardDetails` sustituye a las siluetas.
  y el resto de G12.

**Inc. 6, en curso.** Se parte en 6a (keel-nest), 6b (keel-dotnet) y 6c (keel-go).
- **6a (keel-nest) hecho (2026-11-23):**
  - La frontera abre las dos formas (`dsl233PendingErrors` con `generates`); `capability-coverage` las anota `soloCadenas`,
    con su rama en `uncovered-branches.test.js` (árbol entero parseado, imports que llegan).
  - D2: `reconciliation-settings.ts` (`reconciliation-claim.js`) y `payment-gateway-settings.ts` (`payments.js`) leen el
    parámetro enlazado en segundos con `linked(configuration, propiedad, unitSeconds)`, SIN default propio (falta = no
    arranca). Los yaml ya eran los neutrales de keel-core, sin la clave. La nota del barrido escrito por el agente y el
    `why` del gate nombran el parámetro. `test/dsl-233.test.js` EJECUTA los dos lectores.
  - D7 + G9: el puerto devuelve `SavedPaymentMethod` (`{ reference, card: SavedCard | null }`, interfaces en
    `domain/payment/saved-payment-method.ts`) y el 3DS al guardar es `PaymentMethodAuthenticationRequiredException`; el
    rechazo conserva su nombre de keel-nest, `GatewayRejectedPaymentMethodException`. Lo común de los dos adaptadores sale
    de `savedMethodTsHelpers` (`payments.js`, el gemelo de `savedMethodJava`), que se arma DENTRO de `adapterTs`: payments.js
    importa los módulos de las pasarelas y sus constantes no existen al cargarlos. `savedMethodNote` en `services.js`.
    `test/payments.test.js` EJECUTA el adaptador contra la pasarela falsa (resumen y 3DS), falsado.
  - G12: `gatewaySavesCard`, `gatewayRequiresAuthenticationToSave`, `gatewayReportsRefunded`, `gatewayCancelFails` y
    `gatewayAnswersLate` en `payment-harness.js`, exportados por `flow.ts`, y en la skill `keel-nest-payments`. Los ejecutan
    `test/payment-harness.test.js` (WireMock falso, que ahora honra `fixedDelayMilliseconds`) y `stub-check` (real).
  - G11: `src/scaffold/payment-sweep-claim.js` emite `claimForPaymentSweep(staleBefore, batchSize)` en el puerto, el
    adaptador TypeORM (SKIP LOCKED + UPDATE condicional por fila en `inNewTransaction`, READ COMMITTED en MySQL) y el
    documental (`findOneAndUpdate` por candidato), con la señal de lote lleno si lo dispara el cronómetro. La nota del
    handler, el doc de `PaymentReconciliation` y la skill (`references/reconciliation.md`) dicen que ya está generado.
    `db-check` gana el sujeto `payment-checkout` (con pasarela) y el bloque `paymentSweepBlock` (PS-1 a PS-7, la carrera de
    dos réplicas incluida), con los sabotajes `payment-sweep-no-lease` (cae PS-1) y `payment-sweep-cutoff` (PS-1 y PS-2).
    La rama documental no se ha ejecutado (ninguna fixture con pagos sobre MongoDB); la mide `test/payment-sweep-claim.test.js`.

- **6b (keel-dotnet) hecho (2026-11-23):**
  - Frontera abierta. Dos parches nuevos en `UNCOVERED_BRANCHES`, que compilan `cs-syntax` y `cs-check`:
    `stock-reservation-233` (el umbral de la activación enlazado a un parámetro) y `payment-checkout-233` (el del barrido de
    pagos y `cardDetails`); `capability-coverage` anota las tres formas `soloCadenas` con ellos.
  - D2: `ReconciliationSettings` y `PaymentGatewaySettings` leen el parámetro con `Linked(...)` en segundos y sin default
    propio. `ReconciliationSettings.Defaults` (sin configuración: las pruebas de build) usa el valor de prueba del parámetro,
    como `ServiceParameters` (`testValueOf`, `reconciliation-claim.js`).
  - D7 + G9: `SavedPaymentMethod`/`SavedCard` (records) y `PaymentMethodAuthenticationRequiredException` en Domain/Payment.
    Lo común de los dos adaptadores sale de `savedMethodCs` (`payments.js`). Las pruebas emitidas `PaymentGatewayTests` leen
    el resumen de `savedCardResponse` y el 3DS de `saveAuthenticationRejection`. Lo falsan los sabotajes de `cs-check`
    `payment-saved-card` y `payment-save-3ds`. La nota del handler es `savedMethodNote`.
  - G12: `GatewaySavesCard`, `GatewayRequiresAuthenticationToSave` (con MercadoPago lanza `NotSupportedException`),
    `GatewayReportsRefunded`, `GatewayCancelFails` y `GatewayAnswersLate` en `Support/PaymentGateway.cs` y en la skill. Lo
    mide `stub-check` con tres sondas nuevas por pasarela.
  - G11: `src/scaffold/payment-sweep-claim.js` emite `ClaimForPaymentSweep(staleBefore, batchSize, ct)`. En EF Core, SQL
    crudo con SKIP LOCKED + UPDATE por fila, en `ClaimIsolation`; en documental, `FindOneAndUpdate` por candidato. Los dos
    con `RequireOwnTransaction` (el ayudante se emite una sola vez). Lo ejecuta `db-check` (PS1 a PS7, con
    `paymentSweepProbes` en `scripts/lib/db-probes.js`), con dos sabotajes. Aquí `no-lease` y `cutoff` también tiran PS7:
    la carrera remata con una pasada más (por el filesort de MySQL), y esa pasada depende de que se renueve el reloj.
    `test/payment-sweep-claim.test.js` mide la forma de las tres ramas. La documental no se ha ejecutado.

- **6c (keel-go) hecho (2026-11-23):**
  - D2: `ReconciliationSettingsFrom` lee el parámetro enlazado (`reconciliationLinks`, obligatorio; sin configuración vale
    su valor de prueba) y `payment.SettingsFrom` lo mismo para el barrido de pagos.
  - D7 + G9: el puerto devuelve `domain.GatewaySavedMethod` con `GatewaySavedCard`, y el 3DS al guardar es
    `*domain.PaymentMethodAuthenticationRequiredError`. **No se llaman `SavedPaymentMethod`/`SavedCard`**: Go tiene un solo
    paquete `domain`, y payment-checkout ya tiene una entidad `SavedPaymentMethod` (lo destapó `stub-check`, que no
    compilaba). Lo común de los dos adaptadores sale de `savedMethodGo` (`payments.js`). Las pruebas emitidas
    `stripe_test.go` y `mercadopago_test.go` leen el resumen de `savedCardResponse` y el 3DS de `saveAuthenticationRejection`.
  - G12: `GatewaySavesCard`, `GatewayRequiresAuthenticationToSave` (con MercadoPago, `s.Fatal`), `GatewayReportsRefunded`,
    `GatewayCancelFails` y `GatewayAnswersLate` (con un `time.Duration`) en `payment_gateway_test.go` y en la skill. Lo
    mide `stub-check` con tres sondas nuevas en `scripts/probes/payment_probe_test.go`.
  - G11: `src/scaffold/payment-sweep-claim.js` emite `ClaimForPaymentSweep(ctx, staleBefore, batchSize)` con las sentencias
    del rescate (`claimStatements`): SQL con SKIP LOCKED en una transacción nueva (los ayudantes de `claims.go` se emiten
    también solo por él), o `FindOneAndUpdate` en documental. El reclamo ya no es del agente en los `<raíz>_queries.go`, y
    la skill lo dice. Lo ejecuta `db-check` (PS1 a PS7 en `scripts/lib/payment-sweep-probes.js`), con dos sabotajes en
    `test/helpers/db-sabotages.js`. Como en keel-dotnet, `no-lease` y `cutoff` también tiran PS7.
  - Los parches `stock-reservation-233` y `payment-checkout-233` en `UNCOVERED_BRANCHES`. El de stock-reservation destapó, al
    compilarlo, que la prueba emitida `reconciliation_test.go` daba por hecho el default del umbral (`null` con el enlace)
    y un perfil sin el parámetro: ahora lo carga y espera su valor en segundos. Ni `go-syntax` ni los tests de cadenas lo
    veían.
- **La frontera de 2.33 desaparece**: los cuatro generan las dos formas, así que `dsl233PendingErrors` ya no rechazaba nada.
  Se quitan la función de keel-core (con su prueba), la llamada de los cuatro y la fila de `keel-go/README.md`.

**Inc. 6 cerrado.** Pendiente fuera del plan: una fixture que declare `unansweredAfter` y `cardDetails` (sustituiría a los
parches `-233` de los cuatro), y la rama documental del reclamo de pagos, que ninguna red ejecuta porque ninguna fixture
lleva pagos sobre MongoDB.

**Siguiente: inc. 7, la corrida de control** (la lanza el usuario).

