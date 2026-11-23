# Lo que destaparon las corridas de prueba-gelsa: cazarlo en diseño y corregir los generadores

**Estado: ABIERTO (2026-11-20).** Inc. 0 hecho (2026-11-23). Se ejecuta en varias sesiones, un incremento por sesión
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

## Decisiones pendientes del usuario

1. ¿Entran D2 y D7 en una misma DSL 2.33, o D7 se queda en `REV-*` sin cambiar el DSL?
2. ¿Se cierra la corrida de notifications ahora, corrigiendo su diseño con `/keel-evolve` (patch), o se espera a la
   corrida de control del inc. 7?

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. Registro de corridas | hecho (2026-11-23) | `corrida-metrics.js series`: `page-out-of-range-totals` repetido en 3 corridas; H1 sin cambio |
| 1. keel-core: puerta sin DSL | pendiente | |
| 2. keel-core/gen + keel-spring | pendiente | |
| 3. nest, dotnet, go | pendiente | |
| 4. DSL 2.33 en keel-core | pendiente | |
| 5. keel-spring 2.33 y pagos | pendiente | |
| 6. nest, dotnet, go 2.33 y pagos | pendiente | |
| 7. Corrida de control | pendiente | |

**Para retomar:** el inc. 0 está hecho: `docs/corridas/2026-11-19-{order,payment,notifications}-gelsa.md`, con la
huella de cada proyecto y sus `designGaps` (claves `dual-threshold-source`, `contract-phantom-field`,
`naturalkey-is-id`, `tokenurl-placeholder`, `given-unfixed-values`, `then-incomplete`, `saved-card-unsourced` y
`page-out-of-range-totals`, esta reutilizada de catalog-nest-v2). La huella no se clasificó archivo a archivo; los
proyectos ya pueden borrarse. Seguir con el inc. 1, cuyo primer punto (`CHK-SCEN-PAGE-TOTALS`) tiene el esbozo probado
más arriba. Las dos decisiones pendientes del usuario no bloquean el inc. 1.
