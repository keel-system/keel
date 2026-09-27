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

---

### R9. Llevar el par del MVP a «listo» · validación del propio método

- Las fixtures no tienen por qué estar cerradas, pero **el método nunca se ha ejercido entero sobre sus propios sujetos**: 0 de 11 tienen careo y 3 de 11 tienen escenarios.
- Propuesta: llevar `notification-mailer` / `notification-mailer-mongo` (el par del MVP, sobre los tres motores) a `--ready` completo: escenarios, careo, revisión, `gaps.yaml` y `decisions.yaml` con el registro estructural.
- Sirve de ejemplo canónico en `docs/` y de diseño base para las mutaciones de R6. Además, pone a prueba R1–R4 antes de exigírselas a nadie.
- Las demás fixtures se marcan como sujetos parciales (un campo en `design.yaml` o una lista en el test) para que `--ready` no las evalúe.

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
| 9 | R9: par del MVP en `--ready` | validación | días | 1–7 | ejemplo canónico cerrado de punta a punta |
| 10 | R1 fase 2: `build` se niega sin `--accept-unready` | D1 | horas | 9 | la puerta aprieta |
| — | R8: métrica de reproceso | transversal | continuo | 1 | tendencia medible entre corridas |

**La idea que ordena todo:** hoy el método *sabe* qué es un diseño terminado, pero lo sabe en prosa. Los pasos 1 y 2 hacen que la máquina lo sepa. Los pasos 3 y 4 garantizan que lo que la máquina dice es verdad. Del 5 al 8 persisten lo que hoy muere con la conversación, el 9 lo demuestra sobre un caso real y el 10 cierra la puerta.

## 5. Riesgos a vigilar

- **Una puerta que nace roja se aprende a ignorar.** El propio código ya lo dice (`validate-service.js:213`), y por eso R1 va en dos fases y R9 va antes de la fase 2.
- **Burocracia frente a decisión.** Cada criterio nuevo tiene que poder cerrarse con una línea de YAML o una aceptación con motivo. Si cerrarlo exige más que tomar la decisión, el diseñador lo rodeará.
- **Mover el trabajo de sitio en vez de quitarlo.** `gaps.yaml` y el registro estructural solo valen si **sustituyen** a las tablas del chat, no si las duplican. La skill tiene que escribir el artefacto y mostrar su resumen, no las dos cosas por separado.
- **No mecanizar lo que es de lector.** La frontera de las cuatro preguntas de `checks.js` sigue mandando: R2 y R7 no suben prosa a error, solo estructura y decisiones explícitas.
