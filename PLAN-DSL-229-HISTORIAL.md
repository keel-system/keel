# DSL 2.29: el historial de cambios consultable (R12)

**Estado: en curso.** Los incrementos 0 (keel-core), 1 (keel-spring), 2 (keel-nest), 3 (keel-dotnet), 4 (keel-go) y 5 (derivados) están
hechos: los cuatro generadores emiten el historial y su contrato. El siguiente es el 6 (fixtures). Ver § Estado y § Para
retomar.

Origen: R12 de `docs/evaluacion-dsl-2.24.md`. Este plan la lleva al DSL y a los cuatro generadores con la regla de
siempre: **el mismo diseño genera servidores equivalentes**, y cada pieza nueva tiene una red que la ejecuta y un
sabotaje que demuestra que esa red la ve. Al cerrarlo pasa a `completed_plans/`, como
`completed_plans/PLAN-DSL-228-CICLO-DE-VIDA.md`.

## Contexto

En banca, salud o seguros hay que responder **qué valía un campo en una fecha, quién lo cambió y desde qué valor**.
Hoy es inexpresable: `persistence.audit` (`timestamps`/`authorship`, `gen/model.js:699-725`, `auditPolicies`/
`auditsEntity`) solo guarda la **última** escritura. R1-R4 ya entraron (2.25-2.28); R12 es la siguiente que la
evaluación liga a R4 («los campos `personal` quedan sujetos a su retención también en el historial»).

Lo que se reutiliza:

- **El actor** de `authorship` (claim `sub`, centinela fuera de una petición): `audit-actor.js` de keel-nest y keel-go, el
  `AuditorAware` de keel-spring y su equivalente en keel-dotnet (`persistence-runtime.js`).
- **El predicado implícito** (`gen/implicit-predicates.js`, `gen/read-scope.js`): leer el historial exige poder ver la
  raíz.
- **El ciclo de vida del dato** (`gen/data-lifecycle.js`, `gen/personal-data.js`): anonimizar y purgar alcanzan al
  historial.
- **Las tablas del generador como datos** (`gen/messaging-stores.js`, `gen/schema-steps.js` para bases desplegadas).
- **La página** del contrato del cable (`gen/wire.js`, `PagedResponse.from`/`pageOf`/`Page<T>.Of`/`NewPage`).

**Decisiones del usuario (2026-11-13):**

1. Diseño de contraste: `profile-directory` (pasa a v1.2.0). Mide la interacción con R4 (personal, borrado lógico,
   retención).
2. Grano: **una entrada por escritura confirmada**, con la lista de campos que cambiaron.
3. Consulta: **lista paginada con filtros** (campo y rango de fechas), orden por instante descendente. Sin
   reconstrucción `asOf`.
4. Los campos `personal` del historial siguen **el régimen de su raíz**: `anonymize` sustituye `before`/`after`;
   `delete` (y la purga de lo borrado) se lleva el historial. Sin retención propia.

## El DSL

```yaml
# persistence.keel.yaml
audit:
  timestamps: none
  authorship: none
  history: [ContactCard]            # raíces persistidas con historial (DSL 2.29)

# use-cases.keel.yaml
getMyCardHistory:
  kind: query
  input:
    fields:
      field: { type: string, filter: { historyField: true } }   # forma exacta: inc. 0
      from:  { type: timestamp }
      to:    { type: timestamp }
  output: { history: ContactCard, paginated: true }
```

La forma de cada entrada en el cable la fija `wire-contract.md` § Historial, no el diseño:

```json
{ "at": "2026-11-13T10:02:00Z", "author": "sub-123", "change": "updated",
  "changes": [ { "field": "email", "before": "a@x.com", "after": "b@x.com" } ] }
```

## Decisiones (D1-D10)

| # | Decisión | Por qué |
|---|---|---|
| D1 | El historial se escribe **en el adaptador**, en el `save`/`deleteById`/`restore` del puerto y en la misma transacción que la escritura. El handler no cambia | Defensa por construcción: el agente no puede olvidar una escritura, como el borrado lógico (D1 de 2.28) |
| D2 | Una entrada por escritura confirmada sobre el **agregado** (raíz + hijas). `change`: `created`, `updated`, `deleted`, `restored`, `anonymized`. Un `save` sin diferencias no escribe entrada | Una confirmación es un hecho atómico; una entrada vacía es ruido que un auditor tendría que filtrar |
| D3 | `field` es un dot-path del contrato (`price.amount`, `lines[<id>].quantity` para hijas por id, la lista entera para `list: true` de escalares). Los valores viajan con las reglas de `wire.js` | El auditor lee los nombres del contrato, no los de las columnas |
| D4 | Campos **`sensitive` y `generated`** (versión, auditoría) **no** entran en el historial | Minimización: un hash o un secreto no debe sobrevivir en otra tabla |
| D5 | `author` es el actor de `authorship` (mismo claim, mismo centinela). `history` **exige la capa `security`**, como `authorship` distinto de `none`, pero no exige `authorship` | Un historial sin autor no responde «quién»; reutiliza un solo actor en los cuatro generadores |
| D6 | Almacén **del generador**: una tabla/colección `change_history` por servicio (tipo de raíz, id, instante, autor, cambio, `changes` como JSON), con índice `(root_type, root_id, at desc, id)`. Fuera del contrato, como `outbox_event` | Neutral como datos en `gen/history-store.js`; un solo esquema que medir en los cuatro |
| D7 | Leer el historial pasa por la **carga acotada** de la raíz (`loadScoped`, `readMiss` de 2.27) y por el predicado de vida: raíz ajena o borrada → el 404/403 que ya daría su lectura por id | El historial no puede filtrar lo que la ficha esconde |
| D8 | `then: anonymize` reescribe `before`/`after` de los campos `personal` en todas las entradas de la raíz (null u `anon-<id>`, el mismo sustituto) y añade una entrada `anonymized`. `then: delete` y la purga de lo borrado borran sus entradas en la misma transacción | Decisión 4 del usuario; sin esto, el historial es una copia de lo que la retención borró |
| D9 | El valor de un campo `personal` en el historial nunca va a un log ni a un span (`personal-data.js`) | Misma regla que D10 de 2.28 |
| D10 | Página con el sobre canónico de `wire.js`; orden fijo `at desc` con el id de la entrada como desempate. Los filtros `field`/`from`/`to` son opcionales y se combinan con AND | El cliente no elige orden (R8 sigue abierta) |

Fuera de la 2.29: reconstrucción `asOf`, historial de entidades sueltas que no son raíz, historial de las tablas del
generador, *event sourcing*, firma o encadenado criptográfico del historial (inmutabilidad probatoria) y su retención
propia.

## Reglas mecánicas (keel-core)

Cada una con id, entrada en `checks.js`/`obligations.js` con su `nature`, mutación en una extensión `history` de
`test/design-mutations/catalog.js` y fila en `design-matrix`.

| Id | Qué detecta |
|---|---|
| `CHK-PERSIST-HISTORY-NOT-ROOT` | `history` nombra algo que no es raíz persistida |
| `CHK-PERSIST-HISTORY-NO-SECURITY` | `history` sin capa `security` (D5) |
| `CHK-USECASES-HISTORY-UNKNOWN` | `output.history` sobre una raíz que no está en `audit.history` |
| `CHK-USECASES-HISTORY-SHAPE` | `output.history` en un command, sin `paginated`, o con `exclude`/`embed`/`sort` |
| `CHK-USECASES-HISTORY-FILTER` | Un input de la query de historial que no es `field`, `from`/`to` o el id/clave de la raíz |
| `CHK-SECURITY-HISTORY-UNSCOPED` | La raíz tiene `ownership`/`scoping` con `reads` y la query de historial no está en `reads` (D7) |
| `OBL-HISTORY-UNREAD` | Raíz con `history` sin ninguna query que lo lea: se escribe pero nadie lo puede consultar (aceptable en `decisions.yaml` con motivo, p. ej. «lo lee el DBA») |
| `CHK-SCEN-HISTORY-UNCOVERED` (aviso) | Una query de historial sin escenario |

Además: `history` en `STRUCTURAL_DEFAULTS` no (es opt-in, no hay default que decidir); una pregunta nueva en la clase
de huecos «Ciclo de vida del dato» de `gap-classes.js`/`gap-analysis.md` (unidades: raíces con campos `personal` o con
`history`); `REV-HISTORY-SCOPE` en `reviews.js` («¿falta historial en una raíz con dinero, estado regulado o datos
personales?»), solo si el diseño ya declara algún `history`.

**Decidido al escribir el incremento 0 (2026-11-13):**

- **La forma exacta del filtro** es `historyFilter: field | from | to` en un campo del input (`common.schema.json`), cada
  uno a lo sumo una vez, `field` de tipo string y `from`/`to` timestamp. Los demás campos del input **localizan la
  raíz**, como en su lectura por id (en profile-directory, `callerSubject`); un `filter` de 2.22 en una query de
  historial es error, porque restringe campos de una entidad de salida y aquí las salidas son entradas.
- **D11. Dos tablas en el relacional, no una columna JSON filtrable** (T2): `change_history` (la entrada, con `changes`
  como texto) y `change_history_field` (`entry_id`, `path`, `top`, con `ON DELETE CASCADE`). El filtro por campo es una
  igualdad sobre `path` o sobre `top` (el campo de la raíz que contiene la ruta: `price` casa `price.amount`), sin
  operadores JSON ni `LIKE`. En documental, un documento por entrada con `field` y `top` en cada cambio
  (`gen/history-store.js`).
- **Sin sentencias SQL ni `timer-sql-check` en el incremento 0**, por la lección de la 2.28: la lectura paginada y el
  borrado y la reescritura por raíz se diseñan en el incremento 1, junto a su primer consumidor; `history-store.js`
  trae las tablas como datos y la entrada en `GENERATOR_TABLES` de `schema-steps.js` llega con ellas.
- **D7 en el código**: `readShapeOf` (`gen/read-scope.js`) trata una query de historial como una lectura de UNA de su
  raíz, así que puede ir en `reads` y su `readMiss` exige el 404/403 de la ficha. `CHK-SECURITY-HISTORY-UNSCOPED` salta
  cuando un bloque acota la lectura por id de la raíz y no su historial.
- **`CHK-PERSIST-HISTORY-NO-SECURITY` sale co-disparada** con `CHK-API-NO-SECURITY`, como `CHK-DEPS-REPLICA-UNPERSISTED`:
  la query que lee el historial es de la API, y sin api se queda huérfana. Escrito en la mutación.
- **La entrada `anonymized`** lleva el valor anonimizado en `before` y en `after`: el anterior ya no existe en ninguna
  parte (`wire-contract.md` § Historial). `deleted` y `restored` llevan `changes: []`.
- **El modelo**: `audit.history`, `entity.history` (solo raíz persistida), `operation.historyOf` y
  `operation.historyFilters`; la query de historial es `messageKind: 'query'` sin `responseDto` (la página la construye
  cada generador) y su `targetEntity` es la raíz.
- **Los sujetos cambian**: catalog-extended y verification-codes no tienen capa security, y el historial la exige. Son
  cinco: `cards-history`, `cards-history-mongo`, `cards-history-anonymize` (la retención de la ficha con
  `then: anonymize`, HI-8) y `vault-history-scoped[-mongo]` (asset-vault: el archivo con sus revisiones como hijas, HI-3,
  y su lectura acotada por el alcance, HI-7).
- **HI-3, HI-10 y HI-11 no tienen sabotaje propio**: son el camino feliz del diff y de la restauración, que
  `hi-full-snapshot` e `hi-outside-tx` ya rompen, y la fuga que derriba el `pd-log-value` de la 2.28.

**Decidido al escribir el incremento 1 (2026-11-13):**

- **La columna es `change_kind`, no `change`**: CHANGE es palabra reservada en MySQL. En el cable sigue siendo `change`.
- **Las sentencias** están en `history-store.js` (`historyStatements(engine)`, PostgreSQL y MySQL): la entrada, sus campos,
  la página por piezas (`pageHead` + los filtros presentes en el orden field, from, to + `pageTail`, compuesta con
  `historyPageSql`: un filtro ausente no se escribe, porque PostgreSQL no tipa un parámetro que solo sale en `:x IS NULL`),
  el total, la reescritura al anonimizar y el borrado por raíz (campos y entradas, sin depender de la cascada). La hora es
  la del MOTOR y a igual hora desempata el id, un UUID v7. Las mide `timer-sql-check` (`historial-orden`,
  `historial-filtro`, `historial-borrado`, `historial-cascada`), falsado con `history-order` e `history-filter`.
- **Las dos tablas entran en `GENERATOR_TABLES`**, con la FK (`fk_change_history_field_entry`, ON DELETE CASCADE) en
  `schemaStepSql`. El documental guarda `changes` como TEXTO, igual que el relacional (un decimal del cable no sobrevive a
  BSON y vuelta), y `fields: [{ path, top }]` en vez de la segunda tabla; su hora es la del servidor de la aplicación.
- **El modelo lleva `entity.historyShape`** (`historyShape` de las capas) y la forma gana `personal` (rutas personales con
  `required`); `historyPersonalPatterns` las da como expresiones ANCLADAS que valen en JS, Java, C# y Go, y
  `anonymizeHistoryChanges`/`anonymizedEntryChanges` son la referencia de D8. La entrada `anonymized` lleva una ruta por
  campo personal que aparece en el historial de la raíz. Medido al compilar: la hija ya no registra su vuelta a la raíz
  (`assetId`), que no es una referencia a otro agregado.
- **D7 en el puerto**: la lectura es `historyOf(id[, scope], HistoryFilter, Pageable)` en el puerto de la RAÍZ (o
  `historyOfBy<Clave>` si la carga acotada es por clave), y devuelve `Optional<Page<HistoryEntry>>`: carga la raíz con su
  lectura de ficha (viva y, si va en `reads`, acotada) antes de leer el almacén. El handler no tiene otra puerta al
  almacén. La nota neutral es `historyNote` (history.js).
- **T1 en keel-spring**: la instantánea «antes» se toma de la fila cargada ANTES de que el cuerpo de `save` vuelque el
  agregado sobre ella (la instancia gestionada, la misma que reutiliza el cuerpo); el cuerpo de antes queda en
  `saveUnrecorded`. El actor es el `AuditorAware` de la autoría, que se emite también con `authorship: none` (D5).
- **Lo que queda fuera del incremento 1**: T6 (la caché de una query de historial) no tiene sujeto, porque ningún diseño
  la declara; la invalidación con cualquier escritura de la raíz se decide cuando uno la pida. HI-11 es de
  `telemetry-check` (inc. 2-4 y la corrida de control).

**Decidido al escribir el incremento 4 (keel-go, 2026-11-13):**

- **El almacén son funciones, no un tipo inyectado**: `recordHistory`, `recordSave`, `historyPage`, `anonymizeHistory` y
  `purgeHistory` en `history.go` del paquete del almacén, que reciben la transacción en curso (`q DBTX` en relacional, `tx
  *Transactions` con la sesión en ctx en documental). Ningún constructor de adaptador cambia, y no hay forma de escribir una
  entrada fuera de la transacción de la escritura salvo saboteándolo.
- **El diff vive en el paquete del almacén**, no en el dominio: hay uno solo por proyecto, la instantánea lee los getters del
  agregado y compara el texto de `wire.Marshal`. El dominio solo lleva la entrada, el cambio y el filtro.
- **El id de la entrada es `uuid.NewV7()`**: medido que el de google/uuid crece también dentro del mismo milisegundo (la prueba
  emitida pide diez mil seguidos), así que no hace falta el `NextId()` monótono de keel-dotnet.
- **`hi-full-snapshot` cae también en la prueba emitida del diff** (`TestHistoryDiff*`), que vive en el mismo paquete que la
  sonda: declarado en `HISTORY_ALSO`, como `LIFECYCLE_ALSO`.
- **La sonda de los índices vivos de doc-check** compara ahora `clave:dirección`, y el índice de `change_history` lo pide
  keel-core (`CHANGE_HISTORY_COLLECTION`), no lo emitido.

**Decidido al escribir el incremento 5 (derivados y documentación, 2026-11-13):**

- **El contrato**: la query de historial responde `Paged<Raíz>HistoryEntry`, con `<Raíz>HistoryEntry` (`at`, `author`,
  `change` como enum, `changes`) y un `HistoryChange` compartido (`field`, y `before`/`after` sin `type`: llevan el valor
  del campo que nombra `field`). Las rutas personales de la raíz van en `x-personal-fields` de `changes`, legibles
  (`revisions[<id>].note`) desde `historyPersonalPaths`, no como `x-personal` en `before`/`after`, que sería falso para
  las demás rutas. La respuesta de éxito lleva `historyContractClause` (orden fijo, qué casa con cada filtro, los dos
  extremos inclusivos, y el error de la ficha en vez de una página vacía).
- **Sin `sort`** en el contrato ni en la tabla `ROUTES` de keel-nest (D10): los servidores lo aceptan y lo ignoran, así que
  anunciarlo sería contrato falso. keel-spring, keel-dotnet y keel-go no tienen tabla de rutas que cambiar.
- **`personal-data.md`** gana § En el historial de cambios: qué rutas personales guarda cada raíz con historial y qué
  hace con ellas su retención. Una baja deja la entrada `deleted` y conserva las anteriores: solo la retención se las
  lleva o las reescribe.
- **`historyPendingErrors` se queda**, como `conditionalWritesPendingErrors` y `dataLifecyclePendingErrors`: es la frontera
  para un generador nuevo, con su test.
- **HI-11 no entra en `telemetry-check`**: la PD-3 de la 2.28 ya mide el único camino por el que el motor copia un valor a
  una excepción (una unicidad violada), y `change_history` no tiene ninguna unicidad sobre valores. Se mira en la corrida
  de control, que arranca la app con telemetría.
- **El helper de arnés `historyOf`** se decide tras las corridas, como `ageDeletion`: el arnés ya puede leer el historial
  por HTTP con la query del diseño, y no hay evidencia de que haga falta.

## Núcleo neutral (`keel-core/src/lib/gen`)

- **`history.js`**: qué raíces llevan historial, el **diff** de dos instantáneas del agregado como referencia ejecutable
  (`historyDiff(model, before, after)` → `changes`, aplicando D3/D4), el `change` de cada mutación, la nota del handler
  de la query, los casos `HI-*` y sus sabotajes, y la frontera `historyPendingErrors(model, generator)` con el mismo
  mensaje en los cuatro `supported-features.js` hasta que cada uno lo emita.
- **`history-store.js`**: la tabla `change_history` como datos (columnas, índice, nombres), las sentencias por motor
  para leer por página con filtros y para borrar/anonimizar por raíz, y su entrada en `GENERATOR_TABLES` de
  `schema-steps.js` (para llegar a una base ya desplegada). Se miden en el `timer-sql-check` de keel-core (sabotajes
  `history-order`, `history-filter`).
- **`model.js`**: `persistence.audit.history`, `entity.history`, `operation.historyOf` (con el `readScope` de la raíz).
- **`openapi.js`**: el esquema `ChangeEntry` y la página, con `x-personal` en lo que corresponda.
- **`personal-data.js`**: el inventario dice que el historial guarda campos personales y qué régimen siguen.
- **`data-lifecycle.js`**: la retención y la anonimización llaman también al almacén del historial.

**Casos:**

| Caso | Qué afirma |
|---|---|
| HI-1 | Crear, modificar y borrar dejan una entrada cada uno, con su `change`, en la misma transacción (un rollback no deja entrada) |
| HI-2 | `changes` lleva solo los campos que cambiaron, con `before`/`after` correctos; un `save` sin cambios no escribe |
| HI-3 | Hijas y value objects aparecen con su dot-path (sujeto con hijas) |
| HI-4 | `sensitive` y `generated` no aparecen nunca |
| HI-5 | `author` es el `sub` del token; desde el relay o un barrido, el centinela |
| HI-6 | Página `at desc`, desempate estable, filtros `field`/`from`/`to` |
| HI-7 | Raíz ajena o borrada: el error de su lectura por id (compuesto con `readScope` y vida) |
| HI-8 | `anonymize` reescribe los personales del historial y añade la entrada `anonymized` |
| HI-9 | `delete`/purga de lo borrado se llevan las entradas |
| HI-10 | Restaurar deja una entrada `restored` |
| HI-11 | Ningún log ni span lleva un valor personal del historial (extiende PD-2/PD-3) |

**Sabotajes** (cada uno cae exactamente en sus casos): `hi-outside-tx` (HI-1), `hi-full-snapshot` (HI-2),
`hi-sensitive` (HI-4), `hi-author` (HI-5), `hi-order` (HI-6), `hi-unscoped` (HI-7), `hi-anonymize-miss` (HI-8),
`hi-purge-miss` (HI-9).

## Trampas que medir antes de suponerlas

- **T1 · el diff en el adaptador.** keel-spring (JPA) y keel-dotnet (EF) cargan entidades gestionadas: la instantánea
  «antes» hay que tomarla al cargar, no al guardar. keel-nest (`$set`) y keel-go (SQL propio) necesitan la carga previa.
- **T2 · JSON por motor.** `changes` como `jsonb` en PostgreSQL, `JSON` en MySQL, subdocumento en MongoDB; el filtro por
  `field` no puede depender de un operador JSON propio del motor (o se guarda una columna `fields` aparte).
- **T3 · reescritura al anonimizar.** Reescribir JSON de muchas entradas por lotes, fuera de la transacción del
  sondeador (como D8 de 2.28).
- **T4 · el centinela del autor** en el relay y en el cronómetro: el mismo valor en los cuatro.
- **T5 · escritura condicional (2.25).** Un 412 no deja entrada; un 409 de concurrencia tampoco.
- **T6 · caché.** La query de historial se invalida con cualquier escritura de la raíz (`cache-plan.js`).

## Sujetos y fixtures

Sujetos en `keel-core/test/helpers/history-designs.js` (decididos en el incremento 0): `cards-history` y
`cards-history-mongo` (profile-directory con historial: personal, borrado lógico, restauración, purga),
`cards-history-anonymize[-mongo]` (la misma ficha con `then: anonymize`, HI-8; la variante documental se añadió en el
incremento 2, cuando `hi-anonymize-miss` no tenía en qué caer en MongoDB en ninguno de los dos generadores) y `vault-history-scoped[-mongo]` (asset-vault
con sus revisiones como hijas y su lectura acotada, HI-3 y HI-7).

Fixture: `profile-directory` v1.2.0 con `history: [ContactCard]`, `authorship` sin cambiar, la query
`getMyCardHistory` en `ownership.reads`, sus escenarios (crear-editar-consultar, filtro por campo y fechas, borrado →
404, restaurar → entrada `restored`, purga → sin historial) y su careo; sigue en `--ready`.

## Incrementos

Secuenciales desde `main`, sin subagentes, un generador cerrado antes del siguiente; cada uno con «Para retomar» y commit.

0. **keel-core.** Versión 2.29 en todos los sitios de «Nueva versión del DSL» (schema, `SUPPORTED_DSL`, `package.json`
   y README de los cuatro, plantilla, fixtures, base del corpus). Schemas: `audit.history` en `persistence`,
   `history` en `payload` de `common`, y la forma exacta del filtro por campo. Reglas con mutaciones, clase de huecos,
   `REV-*`. `history.js` y `history-store.js` con sus tests; `wire-contract.md` § Historial; docs `dsl/persistence.md`,
   `dsl/use-cases.md`, historial de `dsl-reference.md`, `validation-scenarios.md`. Medido con la suite de keel-core,
   `design-matrix` (todo falsado) y `timer-sql-check`.
1. **keel-spring.** Almacén `change_history` (Flyway y Mongo), diff en los adaptadores (`repositories.js`,
   `document-repositories.js`), la query (finder y DTO en `dtos.js`/`controllers.js`), la retención/anonimización, caché,
   y la red nueva `npm run history-check` calcada de `lifecycle-check` (PostgreSQL, MySQL y MongoDB, `--sabotage=hi-*`).
   Fila `history` en `engine-support.js`, `compile-check`.
2. **keel-nest**, 3. **keel-dotnet**, 4. **keel-go.** Lo mismo con TypeORM, EF Core y SQL propio más la rama documental;
   sondas en `scripts/lib/history-probes.js` dentro de `db-check`/`doc-check`; HI-11 en `telemetry-check`;
   `test/history-parity.test.js` contra keel-spring; filas de la matriz a `verificado` y `falsified: true`.
5. **Derivados y documentación.** `openapi.js` (tres oráculos de `keel-nest/test/openapi.test.js`, `redocly lint`),
   `personal-data.md`, skills (`/keel-docs`, preguntas de `/keel-design`, evidencia de `/keel-recover`), agentes de
   código y calidad de los cuatro, `capability-coverage` y la fila en `CLAUDE.md` § Dónde se añade cada cosa. Un helper
   de arnés si hace falta (p. ej. `historyOf(<Entidad>, id)`), decidido tras el careo como `ageDeletion`.
6. **Fixtures.** profile-directory v1.2.0 en `--ready` con revisión, huecos, careo y `DESIGN.md`.
7. **Corridas de control** (las lanza el usuario, dos a la vez como mucho): profile-directory en los cuatro sobre
   PostgreSQL y una con MySQL (T2), registradas en `docs/corridas/`.

## Puerta de cierre

Suites de todos los paquetes en verde; `design-matrix` sin `sin-mutacion`; fila `history` de las cuatro matrices
`verificado` y falsada en sus dos ramas; cada sabotaje en exactamente sus casos; corridas de control en verde. Un
generador que no llegue rechaza la capacidad con su motivo en `supported-features.js`.

## Verificación

- `npm test` en la raíz.
- `npm run design-matrix --workspace packages/keel-core` y `npm run timer-sql-check --workspace packages/keel-core -- --sabotage=history-*`.
- `npm run history-check --workspace packages/keel-spring -- --sabotage=hi-*` (y `--database=mysql`).
- `db-check`, `doc-check` y `telemetry-check` de keel-nest, keel-dotnet y keel-go con `--sabotage=hi-*`.
- `npm run matrix` en los cuatro; `node packages/keel-core/src/cli.js validate --ready` sobre profile-directory en un workspace.
- Lo emitido para las fixtures sin `history`, idéntico byte a byte antes y después.
- Temporales en `D:`.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. keel-core | hecho (2026-11-13) | la suite de keel-core (1570), `design-matrix` (224 falsados, 4 co-disparados entre ellos `CHK-PERSIST-HISTORY-NO-SECURITY`, ninguno sin mutación), `test/history.test.js` sobre los cinco sujetos y la suite entera de los seis paquetes |
| 1. keel-spring | hecho (2026-11-13) | `timer-sql-check` (36 pasos, `history-order` e `history-filter` cada uno en su caso); `compile-check` de los cinco sujetos; `npm run history-check` en verde en los cinco (cards-history en PostgreSQL y MySQL, cards-history-mongo, cards-history-anonymize, vault-history-scoped[-mongo]); los 19 sabotajes `hi-*` cada uno en exactamente su caso, también en MySQL y MongoDB; `test/history.test.js` y fila `history` de la matriz, verificada y falsada en sus dos ramas |
| 2. keel-nest | hecho (2026-11-13) | la suite de keel-nest (1108) y la de la raíz; `test/history-parity.test.js` (11: casos, sentencias, tablas, patrones personales y nota contra keel-spring, y el diff y la anonimización emitidos EJECUTADOS contra keel-core); `db-check` en PostgreSQL (92, 107, 237) y MySQL (94, 109, 237) sobre cards-history, cards-history-anonymize y vault-history-scoped; `doc-check` (61, 75, 141) sobre las tres variantes `-mongo`; los 8 sabotajes `hi-*` cada uno en exactamente sus casos en los tres almacenes; fila `history` de la matriz verificada y falsada en sus dos ramas. `cards-history-anonymize-mongo`, nuevo, también medido con `history-check` de keel-spring (8/8 y `hi-anonymize-miss` en HI-8) |
| 3. keel-dotnet | hecho (2026-11-13) | la suite de keel-dotnet (982) y `test/history-parity.test.js` (10: casos, sentencias, tablas, patrones personales y nota contra keel-spring y keel-nest); `cs-check --fixtures` sobre los seis sujetos (36 ensamblados sin warnings, 855 pruebas) con la prueba emitida `HistorySupportTests` (diff, anonimización e id contra keel-core), falsada con `history-diff` e `history-next-id`; `db-check` en PostgreSQL y MySQL sobre cards-history, cards-history-anonymize y vault-history-scoped, y `doc-check` sobre las tres variantes `-mongo`, catálogo e índices vivos incluidos; los 8 sabotajes `hi-*` cada uno en exactamente sus casos en los tres almacenes; fila `history` de la matriz verificada y falsada en sus dos ramas |
| 4. keel-go | hecho (2026-11-13) | la suite de keel-go (1572) y `test/history-parity.test.js` (12: casos, sentencias, tablas, patrones personales y nota contra los otros tres, y que cada sabotaje se siga aplicando); `go-check --history` (la prueba emitida `history_test.go`, falsada con `history-diff` e `history-next-id`); los seis sujetos con gofmt, vet, staticcheck y pruebas en PostgreSQL, MySQL y MongoDB; `db-check` en PostgreSQL y MySQL y `doc-check` sobre los tres sujetos de cada almacén, índices vivos incluidos; los 8 sabotajes `hi-*` cada uno en exactamente sus casos en los tres almacenes; lo emitido para las fixtures sin historial, idéntico byte a byte (7618 archivos); fila `history` de la matriz verificada y falsada en sus dos ramas |
| 5. Derivados y documentación | hecho (2026-11-13) | `keel-nest/test/openapi.test.js` sobre los seis sujetos (el mismo documento en los cuatro, la página y la entrada con la forma del cable, sin `sort` en el contrato ni en `ROUTES`, `x-personal-fields` contra `historyPersonalPaths`, sin deriva para `CHK-DOCS-OPENAPI-DRIFT`); `redocly lint` de los seis documentos (solo el aviso `info-license` de siempre); `test/history.test.js` de keel-core (rutas legibles contra los patrones de la anonimización, cláusula, inventario); `data-lifecycle-parity` de keel-go (el inventario igual en los cuatro); la suite de los seis paquetes (keel-core 1574, keel-spring 1999, keel-nest 1115, keel-dotnet 982, keel-go 1572, keel-recover 190) |
| 6. Fixtures | pendiente | |
| 7. Corridas de control | pendiente | |

## Para retomar

- **Siguiente: incremento 6, fixtures.** profile-directory pasa a v1.2.0 con `audit.history: [ContactCard]`, la query
  `getMyCardHistory` (en `ownership.reads`, con `historyFilter` en `field`/`from`/`to`) y sus escenarios
  (crear-editar-consultar, filtro por campo y fechas, borrado → 404, restaurar → entrada `restored`, purga → sin
  historial), con su revisión, sus huecos, su careo y `DESIGN.md`; tiene que seguir en `--ready`. Después se borran las
  filas `persistence.audit.history` de los cuatro `capability-coverage`, y se pasan las redes que la tienen de sujeto.
- Lo que queda abierto para la corrida de control (inc. 7): HI-11 con la app arrancada y el helper `historyOf` del arnés
  (ver «Decidido al escribir el incremento 5»).
