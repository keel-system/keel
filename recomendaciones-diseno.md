# Evaluación del proceso de diseño y recomendaciones

> Análisis del 2026-09-27 sobre `main` (`0c6b228`). Complementa `recomendaciones-mvp.md`, que trata el lado del generador. Fuentes:
> - `keel-core/src/lib/` (`validate-service.js`, `crossrefs.js`, `checks.js`, `obligations.js`, `reviews.js`, `flow-review.js`);
> - las skills de diseño (`keel-design`, `keel-validate`, `keel-evolve`) y sus `references/`;
> - `keel-spring/src/commands/build.js`, que es la puerta de entrada a la generación;
> - una **medición nueva**: `validateService()` ejecutado sobre las 11 fixtures.

## 0. La tesis

El diseño es la piedra angular: cada decisión que no se toma en el diseño la toma el agente al generar. Además, la toma distinta en cada corrida y en cada stack. Eso es reproceso, y es divergencia entre implementaciones. Las corridas lo han medido varias veces:

- `catalog` (2026-09-21): el informe contó 4 huecos, pero el diff de una regeneración limpia contó **85 archivos reescritos**, casi todos por convenciones que el diseño había decidido *en prosa*.
- `catalog` 2: el parámetro de despliegue (la moneda) estaba en una `rule` del dominio, y el agente se inventó las cuatro cosas que cuelgan de él. De ahí salió DSL 2.15.
- `stock-reservation` (1.ª corrida): 10 huecos de diseño, de los que salieron `OBL-IDEM-KEY-REQUIRED` y `CHK-DEPS-CLOCK-NOT-OBSERVABLE`.
- El test `design-generation-delta`: el generador avisaba **15 veces sobre las 11 fixtures, y 12 de esos avisos se podían decidir mirando solo el YAML**.

Por tanto, la pregunta no es si el método de diseño es bueno (lo es, y mucho). La pregunta es **cuánto de lo que el método exige lo comprueba una máquina antes de `build`**, y cuánto depende de que el agente de diseño lo haya hecho en la conversación.

## 1. Lo que ya está muy bien

| Pieza | Por qué funciona |
|---|---|
| Validación en tres capas (plantilla → JSON Schema → referencias cruzadas) | Determinista, rápida y con `--wip` para el trabajo a medias |
| Catálogo `CHK-*` con id estable, severidad decidida por las «cuatro preguntas» y el ratchet de anónimos | Es la infraestructura correcta para contar, citar y falsar |
| Obligaciones `OBL-*` + `decisions.yaml` | Convierte «el diseño no lo decidió» en algo que **se cierra o se acepta por escrito**, y `build` se niega mientras siga abierta |
| Revisión `REV-*` + `review.yaml` con aplicabilidad decidida por la máquina | El lector da el veredicto, pero no puede declarar «no aplica» para esquivar un id |
| Careo de flujos (`keel-flow-review`) en un contexto limpio, sellado por flujo y con presupuesto de 3 pasadas | Resuelve el problema de que el autor lee sus escenarios como quiso escribirlos, y no entra en bucle |
| Catálogo de decisiones estructurales (§3.1–3.12) con «nunca un default tácito» | Ataca de frente los campos que el schema rellena solo |
| `design-generation-delta.test.js` con `anticipa` / `soloGenerador` | Ata cada aviso del generador a una comprobación del diseño, o a un motivo escrito |
| `design-gaps.yaml` → `keel-spring check` → `/keel-evolve` | El ciclo de retorno de la corrida al diseño existe |

## 2. Diagnóstico: dónde se escapa la consistencia

### Medición sobre las 11 fixtures (`validateService(dir, { wip: false })`)

| fixture | `ok` (build acepta) | avisos | revisiones sin veredicto | escenarios | careo | review.yaml |
|---|---|---|---|---|---|---|
| asset-vault | ✔ | 18 | 17 | ✔ | ✘ | ✔ |
| catalog-extended | ✔ | **28** | 18 | ✔ | ✘ | ✘ |
| inspection-reports | ✔ | 10 | 6 | ✘ | ✘ | ✘ |
| job-dispatch / -mongo | ✔ | 1 / 1 | 6 / 6 | ✘ | ✘ | ✘ |
| metering-digest | ✔ | 0 | 11 | ✘ | ✘ | ✘ |
| notification-mailer / -mongo | ✔ | 4 / 5 | 12 / 12 | ✘ | ✘ | ✘ |
| payout-runs | ✔ | 4 | 6 | ✘ | ✘ | ✘ |
| product-catalog | ✔ | 6 | 6 | ✘ | ✘ | ✔ |
| stock-reservation | ✔ | 8 | 10 | ✔ | ✘ | ✔ |

Las fixtures son sujetos de prueba del generador, no diseños de producción, así que no se les exige estar cerradas. Lo que la tabla demuestra es la **puerta**: `build` acepta un diseño con 28 avisos, sin escenarios, sin careo y con 18 revisiones sin veredicto. Entre los 28 avisos de `catalog-extended` hay decisiones de contrato público:

- `POST` sin `successStatus`;
- colecciones sin `sort`;
- una suscripción sin `onFailure`;
- una necesidad sin `onUnavailable`;
- el mismo `code` con 422 en una operación y 404 en otra;
- API sin capa `security`;
- errores declarados que ningún escenario provoca.

Todas son decisiones que **el generador tomará por su cuenta**.

### Los siete huecos del proceso

| # | Hueco | Evidencia | Consecuencia en la generación |
|---|---|---|---|
| **D1** | **La «definition of done» del diseño es prosa, no puerta.** `/keel-design` § Cierre de sesión exige 4 cosas: validación en verde, huecos cerrados, escenarios con matriz completa y `DESIGN.md`. `build` solo exige la primera más obligaciones y revisiones *abiertas* | `build.js:145-211`; `validate-service.js:213-225` dice expresamente que `missing` y `stale` de la revisión «no bloquean — todavía» | Un diseño a medio cerrar entra a generación y el agente rellena lo que falta |
| **D2** | **Los avisos mezclan dos naturalezas.** Hay *incoherencias probables* (que se corrigen) y *decisiones no tomadas* (que alguien tiene que tomar). Las dos son `warning`, ninguna bloquea y ninguna se puede aceptar por escrito | 41 `CHK-*` de 47 son `warning`; `decisions.yaml` solo admite `OBL-*` | Las decisiones no tomadas llegan al generador como default. El caso del `POST` sin `successStatus` (6 de 11 fixtures, con el status elegido por la heurística del nombre de la operación) es el ejemplo canónico |
| **D3** | **El análisis de huecos no deja artefacto.** 17 clases, inventario por unidad y dos tablas… presentadas en el chat. `gap-analysis.md` dice del inventario: «no va a ningún artefacto» | `references/gap-analysis.md:23` | No es auditable ni retomable tras un `/clear`, no caduca con la versión y ninguna puerta sabe si se hizo |
| **D4** | **El registro de decisiones estructurales vive en la conversación.** Se emite como bloque por capa y solo llega al disco reconstruido en `DESIGN.md` por `/keel-handoff` | `/keel-design` paso 3, «Registro de decisiones estructurales» | Los campos con default en el schema (`reliability`, `optimisticLocking`, `transactionalBoundary`, `audit.*`, `visibility`) no dejan rastro de si alguien preguntó. Un default tácito y una decisión tomada se escriben igual en el YAML |
| **D5** | **214 comprobaciones sin id** (134 errores y 80 avisos) | ratchet `ANONIMOS_MAXIMOS` en `test/checks.test.js` | No se pueden citar, contar, aceptar ni falsar. Los 80 avisos anónimos son justo los que ve el diseñador |
| **D6** | **La puerta de diseño no está medida por mutación.** keel-spring tiene esa disciplina (32 celdas falsadas) y keel-core no | Solo `checks.test.js` sabotea el catálogo para probar el propio test | No se sabe qué reglas de `crossrefs.js` detectan de verdad lo que dicen detectar (la de la barra única en el regex salía sobre todo) |
| **D7** | **Los escenarios son el contrato de equivalencia y, por política, todas sus comprobaciones son aviso.** Es razonable para la *prosa*, pero la **matriz de cobertura** (toda operación con fila, todo `code` provocado) es estructura que `parseCoverageMatrix` ya lee | `CHK-SCEN-*` en `crossrefs.js`; aviso «una matriz incompleta significa diseño sin cerrar» | Un `code` declarado que ningún escenario provoca llega al generador sin prueba, y el agente de pruebas lo inventa o lo salta |

## 3. Recomendaciones

### R1. Una puerta de «diseño listo» única y mecánica · cierra D1 · prioridad máxima

Hoy el cierre se define en tres sitios que no dicen lo mismo: la skill `/keel-design`, `validateService().ok` y `build.js`. La propuesta es convertirlo en **un único veredicto calculado**.

- `src/lib/readiness.js` → `assessReadiness(dir)`: función pura que compone lo que ya existe y devuelve una lista de criterios, cada uno con `ok`, el porqué y el comando que lo cierra.

  | Criterio | Fuente existente |
  |---|---|
  | validación estricta en verde | `validateService({ wip: false })` |
  | obligaciones cerradas o aceptadas y vigentes | `resolveObligations` |
  | decisiones no tomadas cerradas o aceptadas | R2 |
  | revisión **completa** y **vigente** (`missing = 0`, `stale = false`, `open = 0`) | `resolveReviews` |
  | escenarios presentes, de esta versión, con matriz completa | `derivatives.js` + `parseCoverageMatrix` |
  | careo fresco (`flow-review` sin hallazgos sin `resolution`) | `flowReviewPlan` |
  | análisis de huecos cerrado y de esta versión | R3 (nuevo) |
  | `DESIGN.md` fresco | `listDerivatives` |

- CLI: `keel validate --ready specs/<servicio>` imprime la checklist (✔/✘ por criterio). Sirve al diseñador para **retomar una sesión** sin depender de la memoria del agente.
- `keel-spring build` y `keel-spring check` usan `assessReadiness`. **Despliegue gradual**, como ya propone el comentario de `validate-service.js`:
  1. Fase 1: `build` avisa y **estampa** en `keel-generated.json` qué criterios faltaban. Así una corrida sobre un diseño no listo queda marcada como tal, y sus `designGaps` no se confunden con huecos del método.
  2. Fase 2: `build` se niega, con `--accept-unready` como escape explícito que también queda estampado.
- La skill `/keel-design` § Cierre deja de enumerar criterios y **cita el comando**. Un test (como `keel-validate-skill.test.js`) prohíbe que vuelva a enumerarlos en prosa.

**Por qué primero:** es el cambio que más reproceso evita por unidad de esfuerzo. Casi todo ya está calculado y solo falta componerlo y ponerlo en la puerta.

> **Estado de la fase 2 (2026-09-27): hecha**, tras R9. `keel-spring build` se niega sobre un diseño no listo **antes de escribir nada** y dice los ids que faltan y la salida. `--accept-unready` genera igualmente y lo estampa (`design.acceptedUnready` en `keel-generated.json`). Tres precisiones sobre lo escrito arriba:
> - **La puerta cubre todo lo que escribe**, `--refresh` incluido: el snapshot que refresca es el del diseño de ahora. `--check` no escribe y solo informa.
> - **`keel-spring check` predice el veredicto**: un diseño no listo sale en rojo con o sin `--strict`, porque decir «factible» sobre algo que build no generará sería mentir. No se suma a los bloqueos, así que la traducción a código se sigue intentando.
> - **`/keel-evolve` cierra con `--ready`**, no con `keel validate` a secas. Si no, el `build --refresh` al que manda tras una evolución se negaría.
>
> Las nueve fixtures parciales las generan sus tests con `acceptUnready: true`, y la frontera es `READY_FIXTURES`. Los cinco casos de la puerta en `test/build.test.js` están falsados: anulando la negación, salen en rojo los dos que la miden.

---

### R2. Separar «incoherencia» de «decisión no tomada» en los avisos · cierra D2

- Añadir a cada entrada de `CHECKS` un campo `nature: 'incoherence' | 'undecided'`. La prueba para decidirlo: «¿el diseño se arregla *corrigiendo* algo, o *respondiendo* a una pregunta?».
- Un `undecided` se trata como una obligación **en el nivel `--ready`**: se cierra en el DSL o se acepta en `decisions.yaml` con su motivo. Los que no admiten default seguro llevan `waivable: false`, que ya existe para `OBL-RESOURCE-SCOPE`.
- Candidatos inmediatos, sacados de la medición y de `design-generation-delta`:

  | Aviso | Qué decide el generador si nadie lo decide |
  |---|---|
  | `POST` sin `successStatus` | 201 o 200 según el nombre de la operación |
  | colección sin `sort` | el orden por id, que es contrato público |
  | suscripción sin `onFailure` | el default del broker |
  | necesidad sin `onUnavailable` | qué ve el cliente con el proveedor caído |
  | mismo `code` con dos `http` | un `code` que significa dos cosas |
  | `api` sin `security` | endpoints sin regla de acceso |
  | `command` que publica sin idempotencia ni transición irrepetible | un reenvío publica dos veces |
  | `transactionalBoundary: per-operation` que abarca agregados | la frontera real de la consistencia |

- Prioridad de migración: las familias de `FAMILIAS` en `keel-spring/test/design-generation-delta.test.js` que ya tienen `anticipa`. Son las que el generador **demostradamente** decide.

---

### R3. El análisis de huecos como artefacto: `gaps.yaml` · cierra D3

- Schema nuevo `assets/core/schema/gaps.schema.json` y una fila en `SPEC_SIDE_FILES` (`spec-files.js`). Lo razonable es que viaje al publicar y no al derivar, porque `gap-analysis.md` dice que el análisis no se hereda.
- Contenido:
  - `reviewedAt`: el sello de la versión, que caduca con el minor igual que `review.yaml`;
  - el **inventario de unidades**;
  - la **tabla de cobertura** (clase × unidad: `recorrida` / `no-aplica` con motivo);
  - los **hallazgos**, cada uno `decidido` / `aceptado` (motivo) / `abierto`.
- La **aplicabilidad de cada clase la decide la máquina**, igual que `reviews.js` con `appliesTo(layers)`. Por ejemplo, la clase 10 (archivos) aplica si hay campos `file`. Así «no-aplica» deja de ser la salida barata.
- Las clases que hoy no admiten `aceptado` (autorización a nivel de dato, `http` de los errores, orden de las colecciones, equivalencia) pasan a ser un error de formato si se aceptan.
- `assessReadiness` exige cobertura completa y ningún hallazgo `abierto`.
- Efecto lateral valioso: los hallazgos de `gaps.yaml` de varios diseños son **el corpus** para detectar qué clases se repiten y deberían mecanizarse en `CHK-*`/`OBL-*`. Es el mismo movimiento que ya se hace con los `designGaps` de las corridas, pero en la fase de diseño, que es donde sale más barato.

> **Estado (2026-09-27): hecho.** Piezas nuevas en keel-core:
> - `src/lib/gap-classes.js`: las 17 clases, con su aplicabilidad y sus **unidades derivadas** de las capas.
> - `gaps.schema.json` y `src/lib/gaps-state.js`: el archivo y su lector, espejo de `review-state.js`.
> - Una fila en `SPEC_SIDE_FILES`: se publica y no se deriva.
> - Criterio `gaps` en `keel validate --ready`, que imprime **entero** el inventario de lo que queda sin recorrer. Es lo que permite retomar tras un `/clear`.
>
> No toca `ok` ni `build`. Tres desviaciones sobre lo escrito arriba:
> - **El inventario no se guarda**: se deriva. Guardado caducaría con cada cambio del diseño, y derivado le da a `/keel-evolve` su alcance gratis, porque una operación nueva aparece sola como unidad sin recorrer.
> - **Solo las clases 9 y 12 vetan `accepted` enteras.** El `http` de los errores (clase 2) y el orden (clase 5) son una pregunta dentro de su clase. El orden ya lo vigila `CHK-USECASES-COLLECTION-NO-SORT`. El error sin `http` **no lo vigila ningún CHK**, y queda como seguimiento.
> - **La tabla de cobertura ya existía**, en `review.yaml`, y antes en `decisions.yaml`. Era el **tercer intento** de persistirla, y los dos anteriores murieron por la misma causa: nadie la leía. Las tres fixtures que la usaban cubrían una clase de diecisiete, y la de `stock-reservation` citaba una operación que ya no existía. Se sacó de `review.yaml` (con un error que dice a dónde moverla) y se migró a `gaps.yaml`. La lección que ordena R3: **el artefacto no vale nada sin el criterio que lo exige**.

---

### R4. Hacer visible el default tácito · cierra D4

Dos piezas, de menor a mayor:

1. **Un `CHK-MODEL-IMPLICIT-DEFAULT` de naturaleza `undecided` (R2).** Salta cuando un campo del catálogo estructural con default en el schema está **ausente** del YAML (`reliability`, `consistency.optimisticLocking`, `transactionalBoundary`, `audit.timestamps`, `audit.authorship`, `visibility`, `onFailure`…). Se cierra escribiéndolo explícitamente, aunque sea con el mismo valor que el default. El YAML pasa a distinguir «lo decidí» de «nadie preguntó». La lista de campos sale de una tabla única (un `STRUCTURAL_DEFAULTS` junto a `checks.js`) enlazada con las entradas §3.x de `structural-decisions.md`, con un test que ate las dos piezas.
2. **Persistir el registro de decisiones estructurales**: una sección `structural:` en `decisions.yaml` (id §3.x, ámbito, valor elegido, descartado, porqué). `/keel-handoff` pasa a **leerla** en vez de reconstruir el porqué de memoria. Cuando se derive, viaja con el resto de `decisions.yaml`.

> **Estado de R4.1 (2026-09-27): hecho.** La tabla `STRUCTURAL_DEFAULTS` vive en `keel-core/src/lib/structural-defaults.js` y tiene cinco filas: `publishing.reliability` (solo si hay eventos publicados), `consistency.optimisticLocking`, `audit.timestamps`, `audit.authorship` y la `visibility` de cada bucket. El aviso es `undecided` y aceptable, y su scope es por campo. `test/structural-defaults.test.js` ata la tabla a las entradas §3.x de `structural-decisions.md` y al `default` de cada schema. Además obliga a clasificar toda entrada del catálogo: vigilada aquí, cubierta por otra regla, descartada o sin default. Cinco mutaciones, una por fila: `design-matrix` da 138 ids, 132 falsados, 0 co-disparados nuevos.
>
> Al verificar la recomendación salieron cuatro matices:
> - **`transactionalBoundary` no tiene default en el schema**, y ya lo vigila `CHK-PERSIST-BOUNDARY-DEFAULT` (su mutación consiste justo en borrar el campo). Si el check nuevo lo incluyera, saltarían los dos a la vez, así que queda en `COVERED_ELSEWHERE`.
> - **`onFailure` ya es `CHK-MSG-SUB-NO-ONFAILURE`**, y ese check no admite aceptación.
> - **La plantilla de messaging traía `reliability: outbox` sin comentar**: cualquier diseño sembrado lo llevaba «decidido» sin que nadie lo hubiera preguntado. Ahora va comentada, igual que `audit` y `consistency`.
> - **El resultado prometido estaba exagerado.** El aviso obliga a que el campo *esté escrito*, no a que alguien lo haya preguntado, así que cierra «ningún default estructural **por omisión**». El porqué sigue siendo R4.2.
>
> Una interacción que conviene saber: escribir `optimisticLocking: all` o `declared` abre `OBL-CONCURRENCY-CODE`, que bloquea build. Esa obligación solo se exige cuando el diseño se ha pronunciado, así que cerrar este aviso con el valor por defecto no sale gratis. Es coherente: decidido el bloqueo, el `code` del 409 es la pregunta siguiente. Por eso `metering-digest`, la fixture sin avisos que usa `check.test.js`, escribe los dos campos y acepta el código canónico en su `decisions.yaml`.
>
> Medición sobre las 11 fixtures: **17 decisiones abiertas nuevas en `--ready`**. `authorship` falta en 9, `optimisticLocking` en 5 y `timestamps` en 3. Antes de cerrar `metering-digest` eran 19, con `authorship` en 10 de 11: es el default que más se queda sin preguntar. `ok` no cambia en ninguna.
>
> **Estado de R4.2 (2026-09-27): hecho**, con un lector mecánico que la recomendación no pedía. `decisions.yaml` admite una sección `structural:`: por cada entrada, `section` (§3.x), `scope` opcional, `chosen`, `discarded`, `reason` y `since`. `/keel-design` la escribe al cerrar cada capa, en lugar del bloque del chat, y `/keel-handoff` la lee: solo pregunta por lo que falta y confirma lo caducado. La auditoría de la clase 16 se hace contra ella y no contra la memoria de la sesión. El lector es el criterio nuevo `structural` de `--ready` (`src/lib/structural-register.js`). Exige una entrada vigente por cada sección que aplica, con el mismo inventario que la clase 16, y cuando `scope` nombra un campo del catálogo compara `chosen` con el YAML; si el campo no está escrito, lo compara con el default del schema. Sin ese lector, el registro corría el riesgo de acabar como la cobertura del análisis de huecos, que se persistió dos veces sin que nadie la leyera. El grano es por sección §3.x (6–9 entradas en un diseño típico), no por unidad, para que cerrar el criterio no cueste más que tomar la decisión. Verificado de punta a punta: sobre una copia de `stock-reservation`, el criterio sale en rojo con 0/9 secciones, en verde con el registro y otra vez en rojo al contradecir `reliability: outbox`; un `keel new --from` deja las 9 entradas caducadas.
>
> Al verificar la recomendación salieron dos matices:
> - **El inventario de la clase 16 no incluía §3.9b (auditoría) ni §3.11 (compensación)**, aunque los dos están en el catálogo. Se añadieron a `gap-classes.js` y a la tabla de `gap-analysis.md`. Ninguna fixture tenía la clase 16 en `gaps.yaml`, así que el cambio no deja barridos huérfanos.
> - **`decisions.yaml` cambia de naturaleza**: hasta ahora era «lo que se decidió **no** declarar» y ahora guarda también el porqué de lo que **sí** se declaró. Lo recoge la `description` del schema. Viaja al derivar y llega caducado, que es lo correcto: el derivado reafirma, pero parte del porqué del origen.

---

### R5. Acelerar el ratchet por donde duele · cierra D5

- El ratchet va bien, pero migrar «por oportunidad» no tiene fecha. Propuesta: una tanda dedicada a los **80 avisos anónimos**, porque son los que el diseñador ve y los que necesitan `nature` para R2. Los 134 errores anónimos pueden seguir por oportunidad, porque ya bloquean.
- Criterio de «hecho» por aviso migrado: id + entrada en `CHECKS` con `nature` y `closes` + caso en `crossrefs.test.js` que dispare **ese id y solo ese**.
- Meta medible: `ANONIMOS_MAXIMOS.warnings` a 0.

> **Estado (2026-09-27): hecho.** Eran 77, no 80 (R2 había migrado tres). Migrados en cinco tandas por capa, **sin cambiar el texto de ningún mensaje** (comprobado ejecutando el `crossrefs.js` anterior y el nuevo sobre las 11 fixtures: listas idénticas). 34 son `undecided` (3 con `waivable: false`: el `DELETE` sin status, el canal compartido sin discriminador y el canal externo sin `contract`) y 43 `incoherence`. El criterio de hecho cambió respecto a lo escrito arriba: en vez de un caso en `crossrefs.test.js`, **cada id tiene su mutación** en el corpus de R6, que exige la lista exacta. `npm run design-matrix`: 137 ids, 131 falsados, 1 co-disparado (`CHK-DEPS-REPLICA-UNPERSISTED`, inseparable de `CHK-PERSIST-ROOT-UNMAPPED`), 5 fuera de alcance, **0 avisos anónimos**. Efecto sobre R1: las fixtures pasan de 42 a 46 decisiones no tomadas visibles para `--ready`; las cuatro nuevas ya existían y se escapaban. Hallazgo colateral: el escenario del outbox que agota los reintentos, escrito de forma natural, calla por sí solo el aviso del canal indisponible.

---

### R6. Medir la puerta de diseño por mutación · cierra D6

La misma disciplina que ya funciona en keel-spring, aplicada al diseño:

- `keel-core/test/design-mutations/`: un **diseño base limpio** (que pasa `--ready`) y un catálogo de mutaciones pequeñas (quitar un `sort`, dejar un estado sin operación, un `code` sin escenario, una transición sin guarda…). Cada mutación afirma **el conjunto exacto de ids** que dispara.
- `test/design-mutations.test.js` recorre el catálogo. Una regla que no detecta su mutación, o que detecta la de otra, queda en rojo.
- `npm run design-matrix`, hermano de `npm run matrix`: por id, si está **falsado** (hay una mutación que lo dispara solo) o no. Así hay inventario de la cobertura real de la puerta.
- Es la precondición para migrar con confianza en R5 y para cambiar severidades en R2.

> **Estado (2026-09-27): hecho.** El base no pasa `--ready` —ninguna fixture lo hace todavía (R9)— ni lo necesita: lo que exige el corpus es **silencio mecánico**, y el base es propio de keel-core (`test/design-mutations/base/`, el servicio sintético `ticket-desk`, las diez capas más escenarios con matriz) para no depender de las fixtures de keel-spring. 57 mutaciones; `npm run design-matrix` da **55 de 60 ids falsados** (cada uno por una mutación que lo dispara solo), **0 co-disparados**, **0 sin mutación** y **5 fuera de alcance** (los tres `CHK-DOCS-*` y los dos del careo, que emite `validateService` fuera de `crossrefs.js` y falsan sus propios tests). El test prohíbe que entre un id sin mutación. Hallazgo colateral: la regla de `CHK-SERVICE-PARAM-UNBACKED` lee `entity.rules`, que el schema de `domain` no admite; esa rama es inalcanzable. Los 211 hallazgos anónimos (134 + 77) siguen sin poder falsarse por id: son R5.

---

### R7. La matriz de cobertura de escenarios pasa a ser criterio de «listo» · cierra D7

- Se mantiene la política de que todas las comprobaciones `CHK-SCEN-*` son aviso: el sujeto es prosa.
- Pero `assessReadiness` exige lo **estructural**: toda operación con fila en la matriz y todo `code` declarado provocado por algún escenario. Sale de `parseCoverageMatrix` y del troceador de `scenario-blocks.js`, que ya son la fuente única.
- Lo que se valida es la matriz, no la prosa, así que no viola la regla de «no subir a error lo que lee prosa»: la matriz es la parte que la regla ya reconoce como markdown estructurado. Y como `--ready` es un nivel nuevo, no rompe nada existente.

> **Estado (2026-09-27): hecho.** El criterio `coverage-matrix` ya había entrado con R1, así que lo que hizo R7 fue que **midiera lo que dice medir**. Dos mutaciones sobre el base del corpus salían en silencio: (1) una fila con la operación y **sin ningún `FL-`** (`| listTickets | todos |`) pasaba por `MISSING-OP` —la fila existe— y por `DANGLING-FL` —no hay flujo que pueda colgar—; y (2) `CHK-SCEN-ERROR-UNCOVERED` buscaba el code con `includes` en **todo** el documento, así que lo daba por provocado si aparecía en una nota de pendientes, en la matriz o dentro de otro code más largo. Ahora hay un id nuevo, `CHK-SCEN-MATRIX-EMPTY-ROW`, que entra en el criterio, y el code se busca como token entero en el cuerpo de los escenarios (`scenarioBody`, que no arrastra la prosa de la sección siguiente). Los dos siguen siendo aviso. Cada uno tiene su mutación (`M-SCEN-MATRIX-EMPTY-ROW`, `M-SCEN-ERROR-ONLY-IN-NOTE`) y `design-matrix` da 133 falsados, 1 co-disparado (el de siempre) y 5 fuera de alcance. En las fixtures destapó un hueco real: la fila `getReservation | todos` de `stock-reservation`, operación que no nombra ningún flujo. Queda fuera, a propósito, comprobar que el `FL-` citado ejercita de verdad su operación: eso es prosa y le toca al careo.

---

### R8. Cerrar el ciclo corrida → diseño con una métrica · transversal

- Métrica de **reproceso por corrida**, registrada en `docs/corridas/`:
  - `designGaps` devueltos;
  - huella del agente contra `keel-generated.json` en archivos que build había escrito;
  - criterios de `--ready` que faltaban al hacer el `build` (el estampado de R1).
- Con dos corridas de la serie ya se ve si R1–R4 bajan el reproceso. Es la única prueba de que la inversión en el diseño se amortiza en la generación.
- La regla que ya existe («un `designGap` que aparece en dos corridas es candidato obligatorio a id») se mecaniza: un script que lea `docs/corridas/*` y liste las repeticiones.

> **Estado (2026-09-27): herramienta hecha, primer punto de datos pendiente.** `keel-spring/scripts/corrida-metrics.js` mide la huella de un proyecto (`footprint`: registrados, adoptados, intactos, reescritos y borrados, más el estampado de «diseño listo») y la serie (`series`: una fila por corrida, cuántas con `--accept-unready` y los `designGap` que se repiten, por la clave de la sección `## designGaps`). El formato fijo está en `docs/corridas/README.md`. Las cuatro corridas registradas son anteriores a la puerta y solo `catalog 2` midió la huella (53 reescritos). El primer punto de datos sobre un diseño listo es la corrida `notification-mailer` v2.0.0 sobre MySQL + RabbitMQ.
>
> **Primer punto de datos (2026-09-27, `docs/corridas/2026-09-27-notification-mailer-mysql.md`):**
> - Resultado: 56/57 escenarios OK, **0 huecos del diseño** y 23 reescritos de 312.
> - La corrida anterior del mismo servicio, sin la puerta, reescribió **casi los mismos archivos** (21 de 293), así que el número no baja. Lo que cambia es el origen: 16 de los 23 son TODO legítimos o consultas de negocio, y los 7 restantes son huecos del **generador**, con el diseño declarando lo necesario.
> - Tres de esos huecos se repiten entre las dos corridas: el mapeo de constraints únicas a los codes declarados, el `eventId` que no llega al comando y los TODO de siempre.
> - Conclusión provisional: el diseño cerrado elimina los huecos del diseño, y el reproceso que queda en este servicio es del generador. Con un solo punto no hay serie: hace falta repetirlo con otro servicio.
>
> **Plan de validación (fijado el 2026-09-28, antes de correr).** La pregunta es si un diseño que cruza `--ready` deja decisiones al agente generador. **H1**: no le deja ninguna. Los criterios los fija `verdict()` (`keel-spring/src/lib/corrida-metrics.js`), `corrida-metrics.js series` imprime el veredicto, y la rúbrica de atribución está en `docs/corridas/README.md` § Clasificar un reescrito.
> - **Robusta** si se cumplen todas estas condiciones:
>   - al menos tres corridas de medición (`-r8`, sin papel `control`);
>   - como mucho un hueco del diseño en toda la serie, convertido en id antes de la siguiente;
>   - ningún `designGap` repetido;
>   - ninguna corrida con `--accept-unready`;
>   - un careo que cierra en tres pasadas o menos, con hallazgos que no crecen.
> - **No robusta** si aparece cualquier agujero de la puerta, es decir, un hueco que `--ready` o `gap-analysis.md` debía haber cazado.
> - **Secuencia**:
>   0. `notification-mailer` v2.0.2 como **control** del generador, con el mismo stack que la del 27-09.
>   1. `stock-reservation`, con línea base de 10 huecos sin la puerta.
>   2. `asset-vault`, documental, con storage y caché.
>   3. Un **diseño nuevo desde un brief**: reservas de salas con solapes (recomendado), facturación prorrateada o incidencias con SLA.
>
>   Cada diseño se lleva a `--ready` en un workspace fresco. La generación va en otra sesión, y la clasificación la hace un agente de contexto limpio.
>
> **Resultado (2026-09-28): `corrida-metrics.js series` → «Veredicto H1: NO-ROBUSTA — 3 corrida(s) de medición».** Motivos, literales:
> - `2026-09-28-asset-vault-r8: 2 agujero(s) de la puerta`
> - `huecos del diseño en 2026-09-28-asset-vault-r8 (2): el criterio admite uno solo, en una sola corrida`
>
> | Corrida | Matriz | Reescritos | Diseño | Generador | Puerta | Careo |
> |---|---|---|---|---|---|---|
> | 0 · control `notification-mailer` | 58/58 | 18 (antes 23) | 0 | 5 | 0 | — |
> | 1 · `stock-reservation` | 27/27 | 14 | **0** (antes 10) | 4 | 0 | 11→1 |
> | 2 · `asset-vault` | 27/29 | 27 | **2** | 9 | **2** | 23→9→2 |
> | 3 · `room-booking` (nuevo) | 44/44 | 27 | 0 | 6 | 0 | 5 |
>
> Lectura:
> - **La puerta funciona en tres de tres dimensiones medibles y falla en una forma concreta.**
>   - `stock-reservation` pasa de 10 huecos del diseño a 0.
>   - El diseño nuevo converge antes (careo en una pasada) y genera sin dejar decisiones.
>   - El control confirma los arreglos del generador: los siete archivos que el 27-09 eran huecos del generador ya no aparecen.
> - **El agujero es uno, visto dos veces**: un `Then` que afirma en el cuerpo de la respuesta un campo que el YAML no pone en el `output`.
>   - Con `audit: all`, `createdAt`/`createdBy`.
>   - Con un `need` sin `exposedAs`, la miniatura.
>   - El agente eligió al revés en cada caso, y la corrida quedó en rojo por el primero.
>   - Ni el careo (tiene `event-payload`, pero ningún kind para las respuestas) ni las clases 8 y 14 del análisis de huecos lo preguntan.
> - **El residuo del generador es ahora la fuente principal del reproceso**: 24 huecos distintos entre las cuatro corridas, ninguno repetido.
>   - El más grave es el barrido de `room-booking`: sus reclamos sin predicado habrían caducado ofertas vigentes.
>   - Ahí asoma un límite del DSL: no hay dónde declarar el predicado de selección de un barrido.
>
> Por la regla de parada temprana: se arregla el método (un `CHK-SCEN-*` para campos de respuesta fuera del `output`, un kind `response-shape` en el careo y las preguntas de las clases 8 y 14), y `asset-vault` se repite sobre una versión nueva del diseño. H1 se vuelve a evaluar con esa corrida.
>
> **Método arreglado (2026-09-28).**
> - Dos ids nuevos, avisos de naturaleza `incoherence`, cada uno con su mutación: `CHK-SCEN-AUDIT-NOT-EXPOSED` y `CHK-SCEN-NEED-NOT-EXPOSED`. La matriz de la puerta sube a 142 ids falsados.
> - La operación de un `When` se resuelve también por método y ruta.
> - El careo gana el kind `response-shape` y lee `docs/dsl/` para la semántica de los campos (hallazgo del método 4).
> - Las clases 8 y 14 cruzan su pregunta con los escenarios.
> - Sobre el diseño de la corrida, las dos comprobaciones cazan los tres sitios. Sobre las otras fixtures y los diseños r8 no hay falsos positivos. La fixture `asset-vault` de keel-spring tenía la misma contradicción de auditoría y se corrigió.

>
> **La puerta tenía un tercer agujero (2026-09-28).** Los avisos de naturaleza `incoherence` (69 ids) no contaban en ningún criterio de `--ready`: asset-vault v1.1.0 cruzó en 10/10 con sus tres contradicciones a la vista.
> - Entra el criterio `incoherences`, y `--ready` pasa a tener 11 criterios.
> - El escape es `falsePositives` en `decisions.yaml`, con id, fragmento, motivo y caducidad por minor. Se cuenta como deuda de los detectores.
> - Queda arreglado el falso positivo de `CHK-SEC-UNUSED-ROLE` con reglas por permiso (hallazgo del método 1).
> - `CHK-USECASES-MULTI-AGGREGATE` no se toca, por doctrina: **room-booking v1.0.0 sale ahora en rojo** por 6 de esos avisos.
>
> **Y un punto muerto en el careo**: tras la pasada 3, corregir un escenario (`resolution: scenario`) rompía su sello, sin salida. Entra el **resello acotado** (`sealAfter`): sin presupuesto, solo el flujo exacto del hallazgo y solo con ese texto.
>
> **asset-vault v1.2.0, listo en 11/11.** El coste fue alto:
> - Revisión: `7→1`.
> - Barrido: `12→7→4`.
> - Careo: `6→4→4`.
>
> Casi todo estaba en partes que la v1.2.0 no tocó y que en la v1.1.0 habían salido limpias. Varios hallazgos eran serios: un veredicto `infected` síncrono que nunca ponía en cuarentena, la clave de `scanAsset` compartida en el tick, y la ficha cacheada que sobrevivía a la cuarentena. **El veredicto de los agentes de contexto limpio no es estable entre pasadas, y un 10/10 depende de qué encontró cada una.** Eso cuestiona H1 por un lado que la serie no mide: la puerta es sólida en lo mecánico, pero en lo que juzga un lector depende de su recall.
>
> Quedan dos huecos del DSL aceptados como prosa, para el método:
> - un campo `file` privado que la respuesta entrega como URL firmada;
> - la exención de alcance de un cliente máquina (hallazgo 2).
>
> Y uno de documentación: qué cuenta como fallo del circuito y desde cuántas llamadas se evalúa. Falta repetir la corrida de asset-vault sobre la v1.2.0.
---

### R9. Llevar el par del MVP a «listo» · validación del propio método

- Las fixtures no tienen por qué estar cerradas, pero **el método nunca se ha ejercido entero sobre sus propios sujetos**: 0 de 11 tienen careo y 3 de 11 tienen escenarios.
- Propuesta: llevar `notification-mailer` / `notification-mailer-mongo` (el par del MVP, sobre los tres motores) a `--ready` completo: escenarios, careo, revisión, `gaps.yaml` y `decisions.yaml` con el registro estructural.
- Sirve de ejemplo canónico en `docs/` y de diseño base para las mutaciones de R6. Además, pone a prueba R1–R4 antes de exigírselas a nadie.
- Las demás fixtures se marcan como sujetos parciales (un campo en `design.yaml` o una lista en el test) para que `--ready` no las evalúe.

> **Estado (2026-09-27): hecho.** El par sale en verde en los diez criterios de `--ready`, y lo fija `keel-spring/test/mvp-ready.test.js`. Tres desviaciones sobre lo escrito arriba:
> - **No sirve de base de R6.** R6 ya tenía su propio base (`ticket-desk`), desacoplado a propósito de las fixtures de keel-spring.
> - **Los sujetos parciales se marcan con una lista**, `READY_FIXTURES` en el test, y no con un campo de `design.yaml`, que es metadato de registry. Es la lista que leerá el paso 10.
> - **`design-doc` no se puede cumplir donde vive una fixture.** El criterio busca `docs/<n>/DESIGN.md` desde la raíz que deduce de `specs/<n>`. El documento vive en `test/fixture-docs/<n>/` (fuera de `fixtures/`, porque todo lo que hay en la carpeta de un diseño viaja al snapshot del proyecto generado) y el test monta el workspace. El test también afirma que, sin montarlo, **solo** falla `design-doc`.
>
> **Lo que el ejercicio encontró, que es su razón de ser.** Pasar por el método entero cambió el diseño bastante más de lo que cerró las casillas:
> - **Huecos del diseño**, cerrados en el YAML:
>   - las variables del correo no llegaban por ningún sitio: `TemplateRenderer` interpolaba «las del envío», y ni la petición ni el evento las traían;
>   - `registerTemplate` no dejaba declarar las `TemplateVariable`;
>   - `publishTemplate`, `getTemplate` y `getNotification` no estaban acotados al inquilino. Era clase 9, que no admite `accepted`;
>   - `dedupeKey` no tenía origen sin `Idempotency-Key`;
>   - una plantilla que no compila se registraba;
>   - `sendAcceptedNotification` declaraba un error inalcanzable;
>   - faltaban dos índices que se consultan en cada petición y cada minuto;
>   - los dos eventos no tenían canal;
>   - la suscripción no tenía `onFailure`, y ahora lleva DLQ;
>   - el orden de `errors` no casaba con la precedencia que afirmaban los escenarios.
> - **Aceptados con motivo**, en `gaps.yaml` y `review.yaml`:
>   - un envío parado en `queued` o `sending` no se rescata, porque rescatar `sending` arriesga un segundo correo real;
>   - un fallo de envío no se anuncia por evento;
>   - no hay retención;
>   - no hay baja de sistemas.
> - **El careo** necesitó las tres pasadas del presupuesto: 13 hallazgos en la primera, 6 en la segunda y ninguno en la tercera. La gemela mongo tuvo su propio careo.
>
> **Hallazgos del método**, anotados para su propio seguimiento y no resueltos aquí:
> 1. La identidad por evento (`messaging.subscriptions.<E>.identity`) no tiene `resolvedBy`, aunque la de HTTP sí. Que `metadata.source` se resuelva contra `credentialKeys` queda en una `rule` en prosa. **Cerrado (DSL 2.17, 2026-09-28)**: `identity.resolvedBy`, con las mismas comprobaciones que el lado HTTP (ahora un solo helper para las dos puertas) y `CHK-MSG-IDENTITY-RESOLVEDBY-UNDECIDED` cuando HTTP resuelve 1:N y el broker no dice contra qué. build emite el finder si lo pide cualquiera de las dos puertas (uno solo si coinciden), y la nota del listener nombra la entidad y el finder en vez de «resuélvelo». Las gemelas pasaron la `rule` a YAML.
> 2. La regla de proyección de `scenario-authoring.md` («campos de la entidad − exclude + embed») no dice lo que hace el generador con las relaciones sin `embed` (`<relación>Id` y las hijas anidadas). El careo lo marcó y se aceptó. **Cerrado (2026-09-28), con el diagnóstico corregido**: el DSL sí lo decía (`docs/dsl/use-cases.md`); lo que faltaba era la guía de escenarios. La regla de proyección enumera ahora las relaciones sin `embed`, las hijas con su `<raíz>Id` y los `sensitive`, y las dos piezas documentan que una colección vacía viaja como `[]` (salvo `conventions.nulls: omit`). Se corrigió el motivo aceptado en los dos `flow-review.yaml`, que decía que era un hueco del DSL.
> 3. La cabecera `Location` de un `201` apunta a rutas que ninguna operación sirve cuando no hay GET por id (`registerApplication`) o cuando el GET no comparte ruta con el alta (`registerTemplate`). **Cerrado (2026-09-28)**: la `Location` se construye con la ruta de la operación que **lee** el recurso por id (`readingPath` en `controllers.js`), y sin lectura no se emite. `CHK-API-CREATED-NO-READ` (`undecided`) lo pregunta en el diseño con la misma regla; las gemelas lo aceptan para `registerApplication`, y `registerTemplate` apunta ya a `getTemplate`. Destapó que `catalog-extended` tampoco lee productos por id: sus altas salen ahora sin `Location`.
> 4. El `channel` de una **suscripción** no cambia de dónde se consume, que se deriva del `source`. Pasa en todas las fixtures. **Cerrado (2026-09-28), con el diagnóstico invertido**: el generador hacía lo correcto —el emisor publica en `<servicio>.events` sea cual sea su canal, así que un consumidor que leyera de su `channel` dejaría de casar con él—. Lo que mentía era el schema («canal lógico del que se consume»), `docs/dsl/messaging.md` y la plantilla, que ahora dicen que el canal es lógico y el destino sale del `source`. Además, no pasaba en todas: 5 de las 7 fixtures con suscripciones.
> 5. El arnés no tiene primitiva para que el relay SMTP de prueba rechace un destinatario, así que el estado `failed` no se alcanza en caja negra (FL-DSP-001 queda `uncovered` con ese motivo). **Cerrado (2026-09-28)**: Mailpit sube a v1.31 con *chaos* habilitado, y el arnés gana `relayRejectsRecipients()`/`relayAccepts()` (550 permanente en el `RCPT`, global mientras está activo); la purga de `reset-db.sh` lo apaga siempre. La forma del cuerpo está verificada contra la imagen, y `mail-check` tiene MAIL-10/11, falsados quitando `MP_ENABLE_CHAOS`. FL-DSP-001 deja de ser `uncovered` en las dos gemelas.
> 6. `build` imprime como avisos los `undecided` que `decisions.yaml` ya acepta; `keel validate` los oculta. **Cerrado (2026-09-28)**: `classifyWarnings()` en `keel-core/src/lib/decisions.js` es la vara única para `keel validate`, `build` y `check`; `build` dice cuántas aceptadas no repite. Falsado en `test/build.test.js`.
> 7. **Modelo documental**: dentro de una transacción, dos escrituras concurrentes sobre el mismo documento hacen que el perdedor reciba un *write conflict* transitorio de MongoDB (error 112). Ningún handler de keel-spring lo traduce al 409 declarado ni reintenta la transacción, así que sale un 500. Lo encontró el careo de la gemela mongo en FL-TPL-003 y FL-TPL-011. Es el hallazgo con más consecuencias de los ocho. **Cerrado (bloque B de «cerrar la brecha»)**: el `UseCaseMediator` documental reintenta la transacción hasta 3 veces cuando la cadena de causas trae la etiqueta `TransientTransactionError`, y agotado lo relanza como conflicto optimista (409). La premisa está medida contra un mongod real (MONGO-10 en `mongo-check`, falsado), y el Java lo compila `compile-check`; ejecutarlo es de una corrida sobre Mongo (celda `razonado` en la matriz de paridad).
> 8. **`flowReviewPlan` caduca el careo por el sello del documento entero, pero el alcance lo calcula por flujo.** Un cambio fuera de los bloques `FL-` (las convenciones) deja el careo `stale` con **alcance vacío**. Con presupuesto no hay nada que recarear; sin él (`exhausted`) el diseño no vuelve a verde en esa versión. Las convenciones afectan a todos los flujos, así que lo coherente es probablemente una pasada completa. En R9 se deshizo la edición y lo que pedía se aceptó en el careo. **Cerrado (bloque A)**: un sello propio de la sección de convenciones (`conventionsSha256`). Si cambian, la pasada es completa; el resto de la prosa ya no caduca el careo. Y apareció su hermano, también cerrado: el careo **no caducaba con la versión**. Un careo de la v1 valía para la v2, y si la v1 había gastado su presupuesto, la v2 nacía agotada. Ahora caduca con el minor o el major, como `review.yaml`, y la versión nueva empieza con presupuesto entero.
> 9. **El DSL no puede declarar el ámbito de una clave de idempotencia.** Que la `Idempotency-Key` se acote a la aplicación del llamante (y no sea global entre inquilinos) queda en una regla en prosa. Lo encontró `keel-design-review` al revisar el orden de guardas de `requestNotification`. **Cerrado (DSL 2.17, 2026-09-28)**, y la verificación destapó que era peor que prosa: la PK del almacén era `(operación, clave)`, así que dos inquilinos con la misma clave chocaban, y como la firma incluye el `applicationKey` estampado, el segundo recibía `IDEMPOTENCY_KEY_REUSED` (409) en vez de su envío. Ahora `idempotency.partitionBy` (con `client-key` y `payload-hash`); build genera `idempotencyScope()` en el comando, la nota del handler y `check-idempotency.sh` lo exigen, y `CHK-USECASES-IDEM-SCOPE-UNDECIDED` pregunta por el ámbito cuando el servicio distingue llamantes. Las gemelas declaran `partitionBy: [applicationKey]`.
> 10. **La revisión y el barrido del autor se quedaban muy cortos.** Rehechos por agentes de contexto limpio (`keel-design-review`, `keel-gap-sweep`), abrieron 5 hallazgos en la revisión y 24–28 en el barrido de cada gemela. Dos eran de seguridad: un alta podía apropiarse del `client_id` de otro sistema, y `NotificationSent` repartía los destinatarios de cada inquilino a todos los demás. Se corrigieron 13 en el diseño (v2.0.0) y el resto se aceptó con motivo. `--ready` exige ya esa autoría (`reviewedBy`).
>
> Las dos cosas que el DSL no puede decir y el careo pidió, que una colección vacía viaja como `[]` y la proyección de las relaciones sin `embed`, están aceptadas en `flow-review.yaml` con su motivo.
>
> Tres tests de keel-spring usaban este par como el caso «sin canal» o «sin descarte» y se movieron a `inspection-reports`, que lo sigue siendo, con las mismas aserciones. `compile-check` en verde sobre el par en SNS/SQS, Kafka con otel, RabbitMQ con MySQL y Mongo.

## 4. Orden sugerido y dependencias

| Paso | Qué | Cierra | Esfuerzo | Depende de | Resultado medible |
|---|---|---|---|---|---|
| 1 | R1 fase 1: `assessReadiness` + `keel validate --ready` + estampado en build | D1 | días | — | checklist por diseño; `keel-generated.json` dice qué faltaba |
| 2 | R2: campo `nature` + aceptación de `undecided` en `decisions.yaml` | D2 | días | 1 | avisos `undecided` cerrados o aceptados como criterio de «listo» |
| 3 | R6: corpus de mutaciones sobre el diseño base — **hecho** | D6 | 1 semana | — (mejor con 9) | `design-matrix` con ids falsados: 55/60, 5 fuera de alcance |
| 4 | R5: migrar los 80 avisos anónimos — **hecho** (eran 77) | D5 | 1–2 semanas | 2, 3 | `ANONIMOS_MAXIMOS.warnings = 0` |
| 5 | R4.1: `CHK-MODEL-IMPLICIT-DEFAULT` — **hecho** | D4 | días | 2 | ningún default estructural por omisión (17 abiertos en las fixtures) |
| 6 | R3: `gaps.yaml` — **hecho** | D3 | 1–2 semanas | 1 | análisis auditable, retomable y con caducidad: criterio `gaps` de `--ready` |
| 7 | R7: matriz de escenarios en `--ready` — **hecho** (el criterio nació con R1; R7 cerró su fidelidad) | D7 | días | 1 | ningún `code` sin escenario llega a build **sin quedar estampado**; el veto es el paso 10 |
| 8 | R4.2: `structural:` en `decisions.yaml` + `/keel-handoff` que lo lee — **hecho** (más el criterio `structural` de `--ready`) | D4 | días | 5 | `DESIGN.md` sin reconstrucción de memoria; el registro se exige en `--ready` |
| 9 | R9: par del MVP en `--ready` — **hecho** | validación | días | 1–7 | 10/10 en los dos, fijado por `mvp-ready.test.js`; 8 hallazgos del método |
| 10 | R1 fase 2: `build` se niega sin `--accept-unready` — **hecho** | D1 | horas | 9 | la puerta aprieta: también con `--refresh`, `check` en rojo |
| — | R8: métrica de reproceso | transversal | continuo | 1 | tendencia medible entre corridas |

**La idea que ordena todo:** hoy el método *sabe* qué es un diseño terminado, pero lo sabe en prosa. Los pasos 1 y 2 hacen que la máquina lo sepa. Los pasos 3 y 4 garantizan que lo que la máquina dice es verdad. Del 5 al 8 persisten lo que hoy muere con la conversación, el 9 lo demuestra sobre un caso real y el 10 cierra la puerta.

## 5. Riesgos a vigilar

- **Una puerta que nace roja se aprende a ignorar.** El propio código ya lo dice (`validate-service.js:213`), y por eso R1 va en dos fases y R9 va antes de la fase 2.
- **Burocracia frente a decisión.** Cada criterio nuevo tiene que poder cerrarse con una línea de YAML o una aceptación con motivo. Si cerrarlo exige más que tomar la decisión, el diseñador lo rodeará.
- **Mover el trabajo de sitio en vez de quitarlo.** `gaps.yaml` y el registro estructural solo valen si **sustituyen** a las tablas del chat, no si las duplican. La skill tiene que escribir el artefacto y mostrar su resumen, no las dos cosas por separado.
- **No mecanizar lo que es de lector.** La frontera de las cuatro preguntas de `checks.js` sigue mandando: R2 y R7 no suben prosa a error, solo estructura y decisiones explícitas.
