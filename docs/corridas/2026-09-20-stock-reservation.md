# Corrida 2026-09-20 — `stock-reservation`

Primera corrida hecha para **medir huecos de diseño**, no para validar el generador.

| | |
|---|---|
| Diseño | `stock-reservation` v1.0.0 (relacional, 7 capas) |
| Matriz final | **17/17 OK** |
| Huecos reportados | 10 (4 del agente de código, 7 del de pruebas; uno repetido entre ambos) |
| Convertidos en id | 4 (`OBL-IDEM-KEY-REQUIRED`, `CHK-DEPS-CLOCK-NOT-OBSERVABLE`, `OBL-OUTCOME-NEGATIVE-UNDECIDED`, `REV-MSG-DEDUPE-WINDOW`) |

> **Los huecos de esta corrida estuvieron perdidos.** El proyecto generado se borró con su
> `design-gaps.yaml` dentro y no quedó copia en ningún sitio: se recuperaron del transcript de
> la sesión, a un `/clear` de desaparecer. Ese es el motivo de que este archivo exista y de la
> regla que lo acompaña — el `design-gaps.yaml` se copia aquí **antes** de tirar el proyecto.

## Lección transferible

**Los huecos de diseño salen en la FASE 1**, cuando alguien tiene que escribir código o
pruebas contra el contrato. El pase de calidad no encontró ninguno. Los dos agentes que los
producen son `keel-spring-code` y `keel-spring-tests`, y no ven lo mismo: el de código tropieza
con lo que el diseño no decidió, y el de pruebas con lo que el `Then` afirma y nadie puede
observar desde fuera.

## Los diez huecos

### 1 — `releaseReason` no tiene valor para la rendición del barrido
*Capa*: `use-cases` / `domain` · *Unidad*: `reconcileReservations` · `Reservation.releaseReason`

El barrido mueve la reserva a `released`, pero `releaseReason` está documentado como «lo
escribe la compensación». No hay valor declarado para la rendición del barrido, así que una
reserva liberada por reconciliación queda con `releaseReason: null` e **indistinguible en la
API** de una liberada sin motivo. El agente lo implementó dejándolo a `null` —no inventar prosa
que ningún escenario afirma—.

*Cambio propuesto*: declarar en `use-cases.reconcileReservations` el motivo con el que se
rinde, o en `domain.Reservation.releaseReason` el valor que escribe el barrido.

*Destino*: candidato a **`CHK-*`** — una transición de barrido que deja sin escribir un campo
que otra transición sí escribe es derivable del YAML.

### 2 — `awaits: outcome` sin desenlace declarado para la respuesta negativa
*Capa*: `dependencies` / `http-clients` · *Unidad*: `inventory.cancelStock`

La nota de build dice «usa el cuerpo de la respuesta, no basta con que la llamada no falle»,
pero el diseño **no declara qué desenlace corresponde a `cancelled: false`**. El `fallback` solo
cubre que la llamada no salga. El agente implementó liberar igualmente y registrar `WARN`, por
analogía con el fallback — decisión del agente, no del diseño.

*Cambio propuesto*: declarar el desenlace de `cancelled: false` en
`dependencies.inventory.activations.cancelStock`, o un `error` con su `code` en
`http-clients.inventory.calls.cancelStock.response`.

*Destino*: **cerrado como `OBL-OUTCOME-NEGATIVE-UNDECIDED`**. Se clasificó primero como
`CHK-*` y al implementarlo falló la **cuarta pregunta** de `checks.js` —«¿puede el mensaje
nombrar el campo concreto que lo cierra?»—: el DSL **no tiene dónde** declarar el desenlace de
una respuesta negativa (`httpCall.response` solo admite `fields`, y `fallback` gobierna que la
llamada falle, no que el proveedor conteste que no). Eso es exactamente la frontera con
`obligations.js`: el diseño no lo decidió y no hay default seguro —tratarlo como éxito da por
hecho un efecto que el proveedor niega, y como fallo bloquea un flujo que debía seguir—.

El disparador se acota al **booleano** a propósito: ahí el campo es el desenlace por
construcción. Un `recordId` de vuelta es un valor, no un desenlace. Queda fuera el caso del
`verdict` de `asset-vault` —un `string` libre—, que es la misma forma con otro tipo: si la
segunda corrida lo vuelve a levantar, ahí estará la evidencia para ensanchar el disparador en
vez de adivinarlo desde un solo ejemplo.

### 3 — la cabecera de idempotencia es opcional y nada la exige ✔
*Capa*: `use-cases` · *Unidad*: `createReservation` · `idempotency.keySource: client-key`

`Idempotency-Key` es opcional y el diseño no declara ningún `code` para exigirla, así que una
petición sin cabecera **se ejecuta SIN deduplicar** y eso no lo observa ningún `Then`.

*Destino*: **cerrado como `OBL-IDEM-KEY-REQUIRED`** (catálogo + emisor + test).

### 4 — la ventana de deduplicación la fija un parámetro operativo, no el diseño
*Capa*: `use-cases` / `messaging` · *Unidad*: `noteStockCount` · suscripción `StockCountAdjusted`

Al no declarar `transitions` ni ninguna guarda de dominio, la única protección contra la
reentrega es `processed_event`, cuya ventana la fija `processed-event.purge.retention-days`
(14, en `parameters/`). Pasada esa retención, una reentrega **vuelve a incrementar**
`adjustmentCount` — un efecto de negocio cuya garantía acota un parámetro operativo.

*Cambio propuesto*: darle guarda de dominio (un `idempotency` con `keySource: payload-field`
sobre un identificador del recuento) o declarar la ventana de deduplicación en el diseño.

*Destino*: **cerrado como `REV-MSG-DEDUPE-WINDOW`**, y no como `CHK-*`. El disparador
mecánico —suscripción cuyo handler no declara ni `transitions` ni `idempotency`— alcanza a
**7 de las 11 fixtures**, porque es el camino normal y documentado del generador (la rama
`tryRecord`). Lo que decide si hay hallazgo es si el efecto del handler es **acumulable**, y
eso no está en ningún YAML: un contador que suma y una bandera que se fija se declaran igual.
Un aviso que sale casi siempre deja de leerse; la pregunta la contesta un lector.

### 5 — la marca que el barrido lee no es observable ✔
*Escenario*: `FL-RES-002` (y `FL-REC-001` solo la toca vía `ageForReconciliation`)

`reserveStockAwaitingSince` está en el `output.exclude` de las tres operaciones, así que
ningún escenario de caja negra puede afirmar que se estampó. El único gate que quedaba era
estático.

*Destino*: **cerrado como `CHK-DEPS-CLOCK-NOT-OBSERVABLE`**.

### 6 — el `Then` afirma una llamada de vuelta que el diseño no declara
*Escenario*: `FL-CMP-001-C`

El `Then` 2 habla de «ninguna llamada de vuelta duplicada» al proveedor, pero en este diseño
`releaseReservation` **no llama** a `inventory`: `cancelStock` solo lo dispara
`reconcileReservations`. La aserción quedó como conteo `== 0`. Si el diseño quería una
cancelación de vuelta en la compensación, falta declararla en `dependencies`.

*Destino*: **`CHK-SCEN-*`** (familia ya existente sobre `validation-scenarios.md`) o `REV-*`.

### 7 — media aserción no es traducible: «ni DLQ ni reintentos»
*Escenarios*: `FL-RES-003-B`, `FL-CMP-001-B`, `FL-CNT-001-B`

Los reintentos del listener **no son observables desde fuera** (nada los expone); solo se puede
afirmar la ausencia de descarte. La mitad «sin reintentos» no es traducible como está escrita.

*Destino*: **`CHK-SCEN-*`** o `REV-*`.

### 8 — «la misma respuesta» no dice qué incluye
*Escenario*: `FL-RES-001-B`

«La respuesta es la MISMA que la primera vez» no dice si la reproducción repite también
`Location` y el 201. Se asumió 201 + cuerpo idéntico, con `Location` afirmado solo en la
primera.

*Destino*: **`REV-*`** — exige leer prosa.

### 9 — no hay `code` para violar una constraint, y las conventions se contradicen
*Transversal*

`conventions/mapping.md` dice **422 `VALIDATION_ERROR`** en § Normalización y **400** en § sobre
de error, y el diseño no declara `code` para violar `quantity.min` o `sku.maxLength`. Los tres
casos borde asumieron 400.

*Destino*: **dos cosas distintas**. La contradicción interna es un defecto del generador y
**queda arreglada**: el canónico es 400 (`FRAMEWORK_ERRORS.validation`), y el 422 estaba en
`mapping.md` § Normalización y copiado en un comentario de `type-mapper.js`. Lo impide ahora
`conventions-status-coverage.test.js`, que cruza toda atribución explícita de status a un
`code` canónico en los documentos del generador contra el catálogo. El `code` ausente para
violar una constraint sigue abierto como candidato a `OBL-*`/`CHK-*`.

### 10 — no existían los contratos formales
*Transversal*

No había `docs/openapi.yaml` ni `docs/asyncapi.yaml` (faltaba ejecutar `/keel-docs`), así que
toda la forma del cable se derivó de `specs` + `mapping.md`. Al arbitrar un `culprit: test` de
forma de cuerpo, eso **pesa menos** que si viniera del contrato formal.

*Destino*: **no es un hueco de diseño**: es una precondición del protocolo de corrida. Se
ejecuta `/keel-docs` antes de generar.

## Lo que volvió al generador (no son huecos de diseño)

1. **`infra/score-scenarios.sh` dejaba huérfano su Gradle Test Executor** al abortar,
   bloqueando `build/test-results/integrationTest/binary/output.bin` y envenenando toda corrida
   posterior; y el remedio que imprimía (`jps`) no encuentra esos workers. *Arreglado*: `trap`
   sobre EXIT + modo `--kill-workers`, con su test ejecutado y falsado.
2. **El script mandaba a arbitrar la nada**: dos caminos salían con `1` sin ningún `FL-*` en
   rojo. *Arreglado*: el `1` exige que la matriz tenga algo.
3. **`mapping.md` se contradecía con el catálogo de errores** (422 frente a 400 para
   `VALIDATION_ERROR`). *Arreglado*, con test que lo impide.
4. **`AbstractFlowIT` no tiene `holdsFor(Duration, BooleanSupplier)`** — la ventana de
   asentamiento para una aserción **negativa** sobre un efecto asíncrono (la reentrega que no
   debe producir un segundo efecto, el «exactamente uno» tras recuperar el canal). El agente lo
   resolvió con un helper privado duplicado **en seis clases**. Sin él, cada clase reinventa la
   espera negativa o la escribe como lectura seca, que sale verde siempre. *Arreglado*:
   `holdsFor(Duration, BooleanSupplier)` vive en `AbstractFlowIT` y las conventions del agente
   de pruebas mandan usarlo en vez de reimplementarlo.
5. Los casos borde de constraints llevan id `BORDE-RES-001-*` y **no** `FL-*` a propósito, así
   que el script los trata como «rojo que no es escenario» — que es exactamente lo que son.
