# DSL 2.28: el ciclo de vida del dato (R4)

**Estado: aprobado (2026-11-11), sin empezar.** Siguiente: incremento 0 (keel-core).

Origen: R4 de `docs/evaluacion-dsl-2.24.md`. Este plan la lleva al DSL y a los cuatro generadores con la regla de
siempre: **el mismo diseño genera servidores equivalentes**. Cada pieza nueva tiene una red que la ejecuta y un sabotaje
que demuestra que esa red la ve. Las tres capacidades son `personal`, el borrado lógico con restauración y la
retención.

## Contexto

R4 es la última recomendación de prioridad alta que queda abierta en `docs/evaluacion-dsl-2.24.md`: R1 entró en la
2.25, R2 en la 2.26 y R3 en la 2.27. Hoy el diseño no puede decir tres cosas:

- **Borrar no es lo mismo que eliminar.** El puerto solo tiene `deleteById` y el borrado es físico
  (`keel-spring/src/scaffold/repositories.js:424`).
- **Cuánto vive un dato.** Las purgas que hay (`BatchedPurge` y la retención de `processed_event`) son de tablas del
  generador, nunca de datos de negocio. keel-recover se topó con esto en shop-api (5.9 del informe de control): el
  diseñador dejó la retención en un comentario de `decisions.yaml`.
- **Qué campos son datos personales.** `sensitive` (`common.schema.json:134`, aplicado en
  `gen/model.js:3178`) solo decide qué sale en un output.

Además, R4 encaja con dos cosas que ya existen:

- **El predicado implícito.** La 2.27 diseñó `gen/read-scope.js` como el predicado implícito, y su decisión D9
  aplazó el borrado lógico «para componerse después» (evaluación § 8).
- **El reloj.** La retención es el mismo reloj que los plazos de la 2.26: un campo timestamp, una duración y un
  barrido. El cronómetro (`gen/timer-plan.js`) ya la puede alojar.

**Decisiones del usuario (2026-11-11):**

1. R4 entra entera en la versión 2.28, por fases: `personal`, después el borrado lógico y después la retención. La
   operación de supresión del interesado (RGPD art. 17) queda fuera.
2. Los diseños de contraste son `profile-directory` y `verification-codes`. `shop-api` no se toca, para conservar su
   paridad con el legacy y la decisión de retención que el humano aceptó el 2026-10-23.
3. Al anonimizar, un campo `personal` que es `required` recibe un valor sustituto derivado del id (`anon-<id>`), que
   respeta el tipo y la unicidad.
4. Una raíz borrada lógicamente sigue siendo visible por referencia, porque es historia: la ven `embed` y
   `findAllById`. Lo que no la ven son las queries directas.

## El DSL

```yaml
# domain.keel.yaml
fields:
  email: { type: string, required: true, personal: true, constraints: { maxLength: 254 } }

# persistence.keel.yaml
entities:
  ContactCard:
    deletion: logical                     # physical (default del catálogo estructural) | logical
    restorableFor: { days: 30, error: CARD_NOT_RESTORABLE }   # opcional; exige una operación con `restores`
  VerificationCode:
    retention:
      from: issuedAt                      # campo timestamp de la raíz, o `deleted` con deletion: logical
      keep: { days: 30 }                  # o { parameter: codeRetentionDays, unit: days }, como deadlines
      then: delete                        # delete | anonymize

# use-cases.keel.yaml
restoreMyCard: { kind: command, restores: ContactCard, ... }
```

## Decisiones (D1-D10)

| # | Decisión | Por qué |
|---|---|---|
| D1 | Con `deletion: logical`, `deleteById` del puerto **marca la fila** (columna o campo `deletedAt`, que pone el generador y no está en el contrato). El handler no cambia | Defensa por construcción: el agente no puede olvidar que el borrado es lógico |
| D2 | El predicado «viva» se compone con el de `read-scope` y con los `criteria`/`where` de `queryFinder` en un solo sitio neutral, `gen/implicit-predicates.js`. Se aplica a listados, conteo de página, `load`/`loadScoped` y carga por clave natural | La evaluación (§ 8) pide un concepto y no tres emisores. El conteo, para que el total no revele filas borradas |
| D3 | `embed` y `findAllById` **ven** las raíces borradas (decisión 4 del usuario) | Es el sentido del borrado lógico: la factura conserva a su cliente |
| D4 | Toda unicidad de la raíz (`naturalKey`, `unique`, `indexes` sin y con `when`) se evalúa **solo entre filas vivas**: un índice parcial `deleted_at IS NULL`, en MySQL con la columna generada que ya usa `partialIndexSpecs` (`relational.js:586`) y en Mongo con `partialFilterExpression` | El email de quien se fue puede volver a registrarse |
| D5 | Una fila borrada responde 404 con el error de no encontrado del diseño, nunca 410. Borrar una ya borrada también es 404 | No revela que existió, y es el mismo orden que `READ_MISS_ORDER` |
| D6 | `restorableFor` exige una operación con `restores: <Raíz>`, y al revés. El puerto gana `restore(id)`: fuera de la ventana devuelve el `error` declarado, y si una fila viva ya ocupa la clave, el 409 de la unicidad que ya existe (`naturalKeyError`/`indexes[].error`) | Cada desenlace tiene un `code` alcanzable |
| D7 | `retention.from: deleted` cuenta desde el borrado lógico, y es la forma de «borrar de verdad a los 30 días». Sin `retention`, lo borrado se conserva oculto indefinidamente | Un solo mecanismo de reloj para los dos casos |
| D8 | La retención es un **recurrente del cronómetro** (`kind: retention.<Raíz>`), por lotes y fuera de la transacción del sondeador, como los `<Tabla>PurgeTimer` de la 2.26. Una fila con `from` nulo no vence nunca | Reutiliza el reloj único y su medida de dos réplicas |
| D9 | `then: anonymize` deja a null los campos `personal` opcionales y escribe `anon-<id>` en los `required` de texto, en la raíz y en sus hijas. Un `required` personal que no sea texto, o cuyo `pattern`/`format`/`maxLength` no admita el sustituto, es un CHK en rojo | Decisión 3 del usuario; el sustituto conserva la unicidad |
| D10 | `personal` es una clasificación ortogonal a `sensitive`. De ella se derivan: el gate de logs del agente (prohíbe loguear el accesor de un campo personal), que ningún log ni span generado lleve el valor (incluido el mensaje del driver al violar una unicidad, el `Key (email)=(…)` de PostgreSQL), el alcance de `anonymize` y el inventario `docs/keel/personal-data.md` | Que un auditor sepa qué campos personales acaban en un log sin leer el código de cuatro generadores |

Fuera de la 2.28: la operación de supresión del interesado, el cifrado en reposo, la base legal y el consentimiento
(evaluación, «Qué no entra»), el borrado lógico de entidades internas sueltas y la retención de las tablas del
generador, que ya tienen la suya.

## Reglas mecánicas (keel-core)

Cada regla lleva su id, su entrada en `checks.js` o en `obligations.js` con su `nature`, su mutación en una extensión
`dataLifecycle` de `test/design-mutations/catalog.js` y su fila en `design-matrix`.

| Id | Qué detecta |
|---|---|
| `CHK-PERSIST-DELETION-NOT-ROOT` | `deletion` o `retention` sobre algo que no es la raíz persistida de un agregado |
| `CHK-PERSIST-RESTORE-UNPAIRED` | `restorableFor` sin operación `restores`, o al revés, o `restores` sobre una raíz sin `deletion: logical` |
| `CHK-PERSIST-RESTORE-ERROR` | El `error` de `restorableFor` no está declarado en la operación que restaura |
| `CHK-PERSIST-RETENTION-FROM` | `from` no es un timestamp de la raíz, o es `deleted` sin `deletion: logical` |
| `CHK-PERSIST-RETENTION-REFERENCED` | `then: delete` sobre una raíz que referencia otra raíz por FK (`crossAggregateForeignKeys`) |
| `CHK-PERSIST-ANONYMIZE-NOTHING` | `anonymize` en un agregado sin campos `personal` |
| `CHK-PERSIST-ANONYMIZE-SUBSTITUTE` | Un `required` personal que el sustituto no puede satisfacer (D9) |
| `OBL-PERSONAL-RETENTION-UNDECIDED` | Una raíz con campos `personal` sin `retention`. Se acepta en `decisions.yaml` por raíz con su motivo, igual que la de shop-api |
| `CHK-SCEN-DELETION-UNCOVERED` (aviso) | Un borrado lógico sin escenario que lea lo borrado o que vuelva a registrar la clave |
| `CHK-SCEN-RETENTION-UNCOVERED` (aviso) | Una retención sin escenario |

Lo que se añade a piezas que ya existen:

- **El catálogo estructural.** `deletion` entra en `STRUCTURAL_DEFAULTS` (`structural-defaults.js`) para toda raíz
  que tenga una operación DELETE, con la sección nueva en `structural-decisions.md`. Así un borrado físico pasa a
  estar decidido y no se queda en tácito.
- **Una clase de huecos nueva.** «Ciclo de vida del dato» entra en `gap-classes.js` y en `gap-analysis.md`. Sus
  unidades son las raíces persistidas.
- **Una revisión nueva.** `REV-PERSONAL-CLASSIFICATION` en `reviews.js` y en `review-checklist.md`: si hay campos
  personales sin marcar (nombre, teléfono, dirección). Lo tiene que juzgar un lector, porque detectarlo por el
  nombre del campo sería una heurística.

## Núcleo neutral (keel-core/src/lib/gen)

- **`personal-data.js`**:
  - los campos personales por entidad y su alcance (raíz e hijas);
  - la lista que veta el gate de logs;
  - el inventario `docs/keel/personal-data.md`, hecho como `identity-contract.md`;
  - `x-personal: true` en `gen/openapi.js`.
- **`data-lifecycle.js`**:
  - qué raíces tienen borrado lógico, restauración y retención;
  - la columna y el campo `deletedAt` (con `relational.js`);
  - las unicidades «entre vivas» (`liveUniqueSpecs`, que extiende `partialIndexSpecs`);
  - el plan de cada retención para el cronómetro (`timerRetentions` en `timer-plan.js`);
  - el sustituto de `anonymize` (`anonymousSubstitute`, como referencia ejecutable);
  - las notas del handler y de la operación que restaura;
  - los casos y los sabotajes;
  - la frontera `dataLifecyclePendingErrors(model, generator)`, con el mismo mensaje en los cuatro
    `supported-features.js` hasta que cada generador lo emita.
- **`implicit-predicates.js`** (D2): compone el `readScope` y el predicado «viva». `query-filters.js` (`queryFinder`)
  y `read-scope.js` lo consumen, y `finder.scope` pasa a `finder.implicit`. Un listado sobre una raíz con borrado
  lógico tiene finder aunque no tenga inputs.
- **Las sentencias de retención y anonimización por motor**, en `retention-store.js`, porque son contrato de los
  cuatro, igual que `timer-store.js`. Las mide un `npm run retention-sql-check --workspace packages/keel-core`
  calcado de `timer-sql-check`, contra PostgreSQL y MySQL reales.
- **`model.js`**: `entity.deletion`, `entity.retention`, `field.personal` y `operation.restores`.

**Casos**:

| Caso | Qué afirma |
|---|---|
| LC-1 | Un listado o un finder no devuelve filas borradas |
| LC-2 | El total de la página no las cuenta |
| LC-3 | Un `load` o `loadScoped` por id de una fila borrada: no encontrado (D5) |
| LC-4 | La carga por clave natural ignora las borradas |
| LC-5 | La clave de una fila borrada se puede volver a usar (D4), también con `when` |
| LC-6 | Restaurar dentro de la ventana deja la fila viva |
| LC-7 | Restaurar fuera de la ventana da el error declarado |
| LC-8 | Restaurar con la clave ocupada por una fila viva da el 409 de su unicidad |
| LC-9 | `embed` y `findAllById` ven la raíz borrada (D3) |
| LC-10 | Se compone con `readScope` y con el `where`: ninguno de los tres se cae |
| RT-1 | El barrido borra solo lo vencido, y una fila con `from` nulo nunca vence |
| RT-2 | `anonymize` deja a null los opcionales y pone el sustituto en los `required`, en la raíz y en sus hijas, y la unicidad sobrevive |
| RT-3 | Con dos réplicas, un solo barrido (el R1 de la 2.26) |
| RT-4 | `from: deleted` purga lo borrado pasada la ventana |
| PD-1 | El gate de logs sale rojo con `log.info("…", command.email())` |
| PD-2 | Al violar una unicidad sobre un campo personal, ningún log generado lleva el valor |
| PD-3 | Con la app arrancada, ni las trazas ni los logs que recoge el colector OTLP falso llevan un valor personal sembrado |

**Sabotajes**: cada uno tiene que caer exactamente en sus casos.

| Sabotaje | Debe caer |
|---|---|
| `lc-no-filter` | LC-1, LC-2 |
| `lc-count` | LC-2 |
| `lc-get-leak` | LC-3, LC-4 |
| `lc-unique-all-rows` | LC-5 |
| `lc-restore-window` | LC-7 |
| `lc-embed-hidden` | LC-9 |
| `lc-implicit-replace` | LC-10 |
| `rt-early` | RT-1 |
| `rt-anonymize-miss` | RT-2 |
| `rt-every-replica` | RT-3 |
| `pd-log-value` | PD-2, PD-3 |

## Trampas que hay que medir antes de suponerlas

- **T1 · la unicidad entre vivas en MongoDB.** `partialFilterExpression` no admite `$exists: false` ni todas las
  formas de null. Si no sirve, la alternativa es un campo `alive` que pone el generador. Se mide en `doc-check`.
- **T2 · la unicidad entre vivas con `when` en MySQL.** La columna generada tiene que combinar el estado y la vida.
- **T3 · `ON DELETE` de las hijas.** Al purgar la raíz, sus tablas de elementos y sus hijas se tienen que ir con
  ella. Se mide en `db-check`/`retention-sql-check`.
- **T4 · el mensaje del driver.** `DataIntegrityViolationException` lleva el valor en su `getMessage()`. Hay que
  revisar los `log.warn` de `controllers.js:537` y sus equivalentes en los otros tres.
- **T5 · la caché.** Borrar o restaurar invalida la caché de las lecturas de esa raíz (`cache-plan.js`).
- **T6 · la escritura condicional.** El orden de `restore` frente a `loadExpecting` sigue siendo 404 → 403 → 412.
- **T7 · el sustituto y la colación.** `anon-<id>` en un campo plegado (`foldedShadow`) tiene que escribir también
  su sombra.

## Sujetos y fixtures

Los sujetos van en `keel-core/test/helpers/data-lifecycle-designs.js`:

- `cards-logical`: `profile-directory` con email, borrado lógico y restauración, en sus ramas relacional y
  documental.
- `codes-retention`: `verification-codes` con retención, en las variantes `delete`, `anonymize` y
  `from: deleted`.
- `vault-logical-scoped`: `asset-vault` con `reads` y borrado lógico, para LC-10.

Ninguna fixture los declara hasta el incremento 6.

## Incrementos

Se hacen secuenciales desde `main`, sin subagentes y cerrando un generador antes de empezar el siguiente. Cada
incremento termina con su «Para retomar» y un commit.

**0. keel-core.**

- La versión 2.28 en todos los sitios de la regla «Nueva versión del DSL»: schema, `SUPPORTED_DSL`, `package.json`
  y README de los cuatro generadores, plantilla, fixtures y base del corpus.
- Los schemas: `personal` en `common`; `deletion`, `restorableFor` y `retention` en `persistence`; `restores` en
  `use-cases`.
- Las reglas con sus mutaciones, `STRUCTURAL_DEFAULTS`, la clase de huecos y el `REV-*`.
- Los tres módulos neutrales con sus tests y `retention-store.js` con `retention-sql-check`.
- Docs: `dsl/persistence.md`, `dsl/domain.md`, `dsl/use-cases.md`, el historial de `dsl-reference.md` y
  `validation-scenarios.md`.
- Se mide con la suite de keel-core, con `design-matrix` (todo `falsado`, nada `co-disparado`) y con
  `retention-sql-check`.

**1. keel-spring.**

- `personal` en `logging-check.js` (PD-1) y la revisión de los logs de `controllers.js` (PD-2).
- `deletedAt` en `persistence-entities.js` y `document.js`.
- `deleteById`, `restore` y el predicado en `repositories.js`, `document-repositories.js` y `finders.js`.
- Las unicidades parciales en `migrations.js` y `document-indexes.js`.
- La retención como `RetentionTimer` en `timer.js`.
- La invalidación en `cache.js`.
- La red nueva `npm run lifecycle-check`, calcada de `read-scope-check`, que ejecuta LC-* y RT-* contra PostgreSQL,
  MySQL y MongoDB con `--sabotage=lc-*|rt-*`. RT-3 va en `store-check` y PD-3 en `telemetry-check`.
- `compile-check` y la fila `data-lifecycle` en `engine-support.js`.

**2. keel-nest, 3. keel-dotnet, 4. keel-go.**

- Lo mismo con TypeORM, EF Core y SQL propio, más su rama documental.
- Las redes son `db-check`/`doc-check`, con las sondas en `scripts/lib/lifecycle-probes.js`, y `telemetry-check`
  (PD-3).
- Un `test/data-lifecycle-parity.test.js` compara con keel-spring.
- Las filas de las matrices pasan a `verificado` y `falsified: true`.

**5. Derivados y documentación.**

- `openapi.js` con sus tres oráculos y `redocly lint`.
- `docs/keel/personal-data.md` en los cuatro.
- Las skills: la guía de `/keel-docs`, las preguntas de `/keel-design` (borrado, ventana, retención, qué es
  personal) y la tabla de evidencia de `/keel-recover`.
- Los agentes de código y de calidad de los cuatro.
- `capability-coverage` y la fila en `CLAUDE.md` § Dónde se añade cada cosa.

**6. Fixtures.**

- `profile-directory`: email personal y único, `deleteMyCard` lógico y `restoreMyCard`.
- `verification-codes` y su gemela `-mongo`: retención con `anonymize`.
- Las dos siguen en `--ready`, con su careo, sus escenarios y su `DESIGN.md`.

**7. Corridas de control.** Las lanza el usuario, dos a la vez como mucho:

- `profile-directory` y `verification-codes` en los cuatro generadores.
- Una corrida con MySQL, para la columna generada (T2).
- Se registran en `docs/corridas/`.

## Puerta de cierre

- Las suites de los cinco paquetes en verde.
- `design-matrix` sin ningún `sin-mutacion`.
- La fila `data-lifecycle` de las cuatro matrices `verificado` y `falsified: true`.
- Cada sabotaje cae solo en sus casos.
- `retention-sql-check` en verde.
- Las corridas de control en verde.

Un generador que no llegue a la puerta rechaza la capacidad con su motivo.

## Verificación

- `npm test`.
- `npm run design-matrix --workspace packages/keel-core`.
- `npm run retention-sql-check --workspace packages/keel-core`.
- `npm run lifecycle-check --workspace packages/keel-spring -- --sabotage=<id>`.
- `db-check`, `doc-check` y `telemetry-check` de keel-nest, keel-dotnet y keel-go con `--sabotage=lc-*|rt-*|pd-*`.
- `npm run matrix` en los cuatro.
- Los temporales van en `D:`.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. keel-core | pendiente | |
| 1. keel-spring | pendiente | |
| 2. keel-nest | pendiente | |
| 3. keel-dotnet | pendiente | |
| 4. keel-go | pendiente | |
| 5. Derivados y documentación | pendiente | |
| 6. Fixtures | pendiente | |
| 7. Corridas de control | pendiente | |
