# DSL 2.28: el ciclo de vida del dato (R4)

**Estado: en curso.** Incremento 0 (keel-core) hecho el 2026-11-11, incrementos 1 (keel-spring), 2 (keel-nest), 3 (keel-dotnet) y 4 (keel-go) el 2026-11-12. Siguiente: incremento 5 (derivados y documentación).

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
| D8 | La retención es un **recurrente del cronómetro** (`kind: retention:<Raíz>`, la forma de `deadline:<Entidad>.<estado>`), por lotes y fuera de la transacción del sondeador, como los `<Tabla>PurgeTimer` de la 2.26. Una fila con `from` nulo no vence nunca | Reutiliza el reloj único y su medida de dos réplicas |
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
| `CHK-PERSIST-RETENTION-REFERENCED` | `then: delete` sobre una raíz a la que apunta una relación desde otro agregado (`incomingReferences`) |
| `CHK-PERSIST-LIFECYCLE-PARAM-UNKNOWN` | La duración de `keep` o de `restorableFor` cita un parámetro que no existe o no es `int` |
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
  unidades son las raíces persistidas de las que el diseño ya dice algo (un campo `personal` en su agregado, o
  `deletion`/`restorableFor`/`retention`). Aplicada a toda raíz persistida, todas las fixtures listas habrían salido
  en rojo en `--ready`; las preguntas de las demás las abren la obligación y la entrada 3.13.
- **Una revisión nueva.** `REV-PERSONAL-CLASSIFICATION` en `reviews.js` y en `review-checklist.md`: si hay campos
  personales sin marcar (nombre, teléfono, dirección). Lo tiene que juzgar un lector, porque detectarlo por el
  nombre del campo sería una heurística.

**Decidido al escribir el incremento 0 (2026-11-11):**

- **No hay `retention-sql-check` ni `retention-store.js` en keel-core.** Borrar y anonimizar un agregado tiene que pasar
  por el puerto del adaptador, porque así el ORM se lleva las hijas y las tablas de elementos. Escrito como SQL neutral,
  cada generador tendría que repetir su esquema de hijas en otro sitio. Lo único neutral es la selección de lo vencido
  (`from <= corte`, por lotes), y eso se diseña en el incremento 1 junto a su primer consumidor y se mide en el
  `db-check` de cada generador (RT-1 a RT-4).
- **D11. Una marca `anonymized_at`, del generador como `deleted_at`.** Un agregado anonimizado sigue cumpliendo
  `from <= corte`, y sin la marca el barrido lo volvería a tomar en cada pasada.
- **`finder.scope` no se renombra.** El finder gana `live` (`implicit-predicates.js`), y el predicado de vida no crea
  un finder: el listado entero y la carga del puerto ya dejan fuera lo borrado.
- **Las unidades de 3.13** son las raíces persistidas con una operación expuesta que las borra (`deletedRoots`). Si el
  nombre de la operación no dice la entidad (`deleteMyCard`) y hay una sola raíz persistida, la raíz es esa.
- **`REV-PERSONAL-CLASSIFICATION` aplica solo si el diseño ya marca algún campo `personal`**, por el mismo motivo que la
  clase 19.
- **`personal` se marca en el campo, no en el tipo**: un mismo email puede ser de una persona o de un buzón de la
  empresa.
- **Los sujetos** (`test/helpers/data-lifecycle-designs.js`) son seis: `cards-logical` y `cards-logical-mongo`,
  `codes-anonymize` y `codes-anonymize-mongo`, `codes-delete` y `vault-logical-scoped`.

**Decidido y medido al escribir el incremento 1 (2026-11-12):**

- **La selección de lo vencido no es SQL neutral, es la consulta del adaptador** (`dueForRetention`, JPQL o `Criteria`),
  y el borrado y la anonimización van por el repositorio del almacén. Lo neutral es el plan del recurrente
  (`generatorRetentions` en `timer-plan.js`: su `kind`, su cron y su lote, con `retentionParameters` en
  `data-lifecycle.js`). Una retención basta para que haya cronómetro (`usesTimer`).
- **La unicidad entre vivas es `partialIndexSpecs`**, que ahora devuelve también las unicidades sin condición de una raíz
  con borrado lógico (`liveUniqueColumns` en `relational.js`), con el MISMO nombre que en `uniqueConstraints`: el
  traductor de errores las sigue encontrando. En documental, `documentIndexSpecs` les pone `live: { path: 'deletedAt',
  equals: null }`. Las columnas `deleted_at`/`anonymized_at` son `DELETED_AT`/`ANONYMIZED_AT` de `relational.js`.
- **T1, medido en mongo:7**: `partialFilterExpression: { deletedAt: null }` se acepta y casa con el campo ausente y con el
  nulo; `$exists: false` lo rechaza el motor. No hace falta el campo `alive`.
- **T2, medido en MySQL**: la columna generada `CASE WHEN deleted_at IS NULL THEN 1 END` (con `AND` si hay `when`).
- **T4, medido**: en Hibernate 7 el mensaje del motor con el valor de la unicidad lo escribe `org.hibernate.orm.jdbc.error`,
  no `SqlExceptionHelper`. Con datos personales, `logging.yaml` lo apaga y el aspecto `@LogExceptions` no copia el
  mensaje de una `DataAccessException`.
- **T5**: borrar lógicamente o restaurar invalida las cachés de las lecturas de esa raíz (`cacheInvalidations`, neutral),
  y el barrido de retención vacía las suyas (`retentionCaches`), porque no pasa por el mediator.
- **La restauración se busca por la clave natural**: el puerto gana `findDeletedBy<Clave>` (la borrada más reciente) y
  `restore(id)`; `deletedRootOf`, `deletedLookupOf`, `logicalDeletionNote` y `restoreNote` son neutrales. Los handlers que
  borran o restauran reciben el puerto aunque su payload no nombre la raíz.
- **`vault-logical-scoped` borra también `Owner`**, la raíz que el listado embebe: es la única forma de medir LC-9 sin una
  fixture.
- **PD-3 de keel-spring no se mide en el incremento 1**: su `telemetry-check` no tiene colector OTLP falso (los otros
  tres sí) y sus sujetos no marcan nada personal. Lo que PD-3 vigila en los logs ya lo mide PD-2; las trazas quedan para el
  incremento 5, con el inventario.

**Decidido y medido al escribir el incremento 2 (keel-nest, 2026-11-12):**

- **El predicado de vida en TypeORM** es `deletedAt: IsNull()` en el where de cada carga y del listado, y la línea
  `and('deletedAt', IsNull())` en los finders, DETRÁS del alcance. `deleteById` es un `manager.update` condicionado a
  `deletedAt IS NULL`; con bloqueo optimista, marcar, restaurar y anonimizar SUBEN la versión (`lock_version + 1`), como
  el `@Version` de JPA en keel-spring: sin eso, un handler en vuelo reescribía lo que la marca cambió.
- **En el documento**, `deletedAt`/`anonymizedAt` con el nombre del campo, como keel-spring, y el filtro parcial del
  índice suma `deletedAt: null` a la condición del diseño (`partialFilterLiteral`). `save` es un `$set`, así que las
  marcas sobreviven sin arrastrarlas (en keel-spring hace falta `carriedMarks`).
- **La retención** es `<Raíz>Retention` (`infrastructure/persistence/retention`) y `<Raíz>RetentionTimer`, registrados
  en el módulo del sondeador; su cron y su lote salen de `retention.yaml` con las claves y variables de
  `retentionParameters` (keel-spring los lee con `@Value` y su default; aquí hace falta el fragmento).
- **PD-2, medido**: en PostgreSQL el mensaje del driver de una unicidad violada NO lleva el valor (va en `detail`, que
  ningún log copia), así que `pd-log-value` no tiene qué hacer caer allí; en MySQL (`Duplicate entry '…'`) y en MongoDB
  (E11000 `dup key`) sí. Lo copiaban el logger de TypeORM y la rama sin constraint del filtro de la API; con datos
  personales los dos escriben solo la clase. La sonda pasa la violación, con su constraint renombrada, por el filtro.
- **Un defecto destapado, de antes de la 2.28**: en MySQL, con una columna generada (el discriminador de la unicidad
  entre vivas o de la condicionada), TypeORM recarga la fila tras el INSERT y volvía a pasar el id por
  `UUID_BINARY.from`, que trocea el texto otra vez: `save` devolvía `58aa892b--1ac-2-…`. El transformador es idempotente.
- **PD-3 no se mide en el incremento 2**, como en keel-spring: exige arrancar profile-directory con seguridad y
  telemetría y provocar la unicidad por HTTP. Lo que vigila en los logs ya lo mide PD-2; las trazas, en el incremento 5.
- **Sin sujeto documental para LC-1, LC-2, LC-9 y LC-10**: ningún diseño derivado lista, embebe ni acota con borrado
  lógico sobre documentos, así que `lc-no-filter`, `lc-count`, `lc-embed-hidden` y `lc-implicit-replace` solo se
  falsan en la rama relacional. Escrito en la matriz.

**Decidido y medido al escribir el incremento 3 (keel-dotnet, 2026-11-12):**

- **Las lecturas vivas en EF Core van escritas en cada consulta, no como filtro global** (`HasQueryFilter`): `FindAllById`
  tiene que ver lo borrado (D3), y con un filtro global los sabotajes `lc-no-filter` y `lc-get-leak` no podrían caer cada uno
  en sus casos. Cada carga suma `&& r.DeletedAt == null`; el listado y su total, `.Where(r => r.DeletedAt == null)`; el
  finder, su línea detrás del alcance. En documental, `Live(filtro)` y `NotDeleted`.
- **La retención abre un ámbito por agregado** (`IServiceScopeFactory`), con su `DbContext` y su `PersistenceTransactions`,
  como `TablePurges`. `AddYears` ya lleva el 29 de febrero al 28, así que el corte en años no necesita la función de
  keel-nest.
- **PD-2 en .NET es EF, no el manejador de la API.** EF escribe en el log el fallo de cada sentencia (`SaveChangesFailed` y
  `CommandError`) con la excepción del motor, también cuando la constraint es conocida y la traducción sale bien. Con datos
  personales, el `DbContext` los ignora (`ConfigureWarnings`), y el `LogIntegrity` de la API deja de recibir la excepción.
  La sonda captura lo que escribe la persistencia con un `ILoggerProvider` propio. En documental el driver no escribe en el
  log, así que no hay nada que medir: PD-2 queda fuera de los casos de doc-check, y la paridad con keel-spring lo descuenta.
- **Las sondas comparten base con las demás de db-check y doc-check**: no vacían tablas como keel-nest. El total de una
  página se mide como diferencia, y LC-10 siembra dueños con valores propios del motor.

**Decidido y medido al escribir el incremento 4 (keel-go, 2026-11-12):**

- **El predicado de vida en SQL propio** es un sufijo ` AND deleted_at IS NULL` en el `WHERE` de cada `r.load` de una carga
  (por id, por clave, inversa, credencial, lote por clave natural), en el `List` y en su total, y `f.alive()` en el finder,
  DETRÁS de `r.scoped`. `FindAllByID` no lo lleva (D3). En documental, `{Key: "deletedAt", Value: nil}` en el filtro de cada
  carga, `all` en el `List` y una condición más en el finder, detrás del alcance.
- **`Restore` y `FindDeletedBy<Clave>` devuelven `(*E, bool, error)`**, como todo finder de Go: «no hay borrada» es una
  respuesta, no un error. La ventana se compara en el servidor con `time.Now()`, como los otros tres.
- **La retención vive en el paquete del almacén** (`<raíz>_retention.go`): `due` por lotes y `apply` en su transacción, con el
  SQL (o el `UpdateOne`) que escribe build; sin ORM no hay un borrado del puerto que reutilizar, y las hijas caen por el
  `ON DELETE CASCADE` del baseline (T3). Sobre documentos, las hijas se anonimizan con `$[]`, solo donde el array existe
  (MongoDB rechaza `$[]` sobre un campo ausente).
- **RT-3 mide el kind EMITIDO**: la retención da su `Recurring(spec)`, que usan el arranque y la sonda de dos réplicas, y
  `rt-every-replica` rompe ese método. Construir el recurrente en la sonda con la constante reconstruiría lo que mide.
- **T5 sin telemetría**: la retención vacía la caché con la MISMA `operationCache` que los casos de uso, así que el arranque
  la pone en una variable también sin telemetría (una segunda instancia no subiría la generación de la primera).
- **PD-2 se cumple por construcción en Go.** `translate` nunca devuelve el mensaje del motor de una violación de integridad
  (constraint conocida: su error del contrato; desconocida: el 409 sin code), el caso de uso registra solo el `code` y el
  borde solo el catch-all 500. La sonda afirma que ni el error del adaptador ni el logger de la persistencia llevan el valor;
  `pd-log-value` envuelve el error del motor en el de la constraint conocida y cae solo en MySQL (`Duplicate entry '…'`).
- **Medido, y no supuesto**: los sabotajes tienen que conservar la forma también en Go, donde un import o una variable sin
  uso no compila. `rt-anonymize-miss` deja cada campo con su valor (`COALESCE(col, $n)`, la sentencia sigue con sus
  parámetros) y, sobre documentos, descarta el sustituto con `_ = substitute`; `pd-log-value` usa `errors.Join` (sin `fmt`) y
  solo en la rama de `translate`, no en la búsqueda de `constraintIn`.
- **Dos caídas que no son de más**: `lc-implicit-replace` tumba también RS-1, RS-2, RS-6 y RS-8 de vault-logical-scoped
  (miden el mismo alcance del mismo finder), y `lc-unique-all-rows` sobre documentos, la sonda general de los índices vivos
  (que ahora compara también el filtro de vida). Las declara `LIFECYCLE_ALSO`.
- **Nada cambia para quien no declara el ciclo de vida**: lo emitido para todas las fixtures con los tres motores es el mismo
  byte a byte antes y después (13 070 archivos).

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
  ella. Se mide en `db-check`.
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
- Los módulos neutrales con sus tests (`retention-store.js` pasa al incremento 1).
- Docs: `dsl/persistence.md`, `dsl/domain.md`, `dsl/use-cases.md`, el historial de `dsl-reference.md` y
  `validation-scenarios.md`.
- Se mide con la suite de keel-core y con `design-matrix` (todo `falsado`, nada `co-disparado`).

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
- Las corridas de control en verde.

Un generador que no llegue a la puerta rechaza la capacidad con su motivo.

## Verificación

- `npm test`.
- `npm run design-matrix --workspace packages/keel-core`.
- `npm run lifecycle-check --workspace packages/keel-spring -- --sabotage=<id>`.
- `db-check`, `doc-check` y `telemetry-check` de keel-nest, keel-dotnet y keel-go con `--sabotage=lc-*|rt-*|pd-*`.
- `npm run matrix` en los cuatro.
- Los temporales van en `D:`.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. keel-core | hecho (2026-11-11) | suite de keel-core, `design-matrix`, la suite entera |
| 1. keel-spring | hecho (2026-11-12) | `lifecycle-check` en PostgreSQL, MySQL y MongoDB con once sabotajes, `test/data-lifecycle.test.js` (PD-1 con bash), las suites de los cinco paquetes |
| 2. keel-nest | hecho (2026-11-12) | `db-check` (PostgreSQL y MySQL, 4 sujetos) y `doc-check` (2 sujetos) con los once sabotajes, cada uno en exactamente sus casos; `test/data-lifecycle-parity.test.js` (PD-1 con bash, paridad con keel-spring); `ts-check`; la suite de keel-nest |
| 3. keel-dotnet | hecho (2026-11-12) | `db-check` (PostgreSQL y MySQL, 4 sujetos) y `doc-check` (2 sujetos) con los sabotajes que tienen qué romper, cada uno en exactamente sus casos; `test/data-lifecycle-parity.test.js` (PD-1 con bash, paridad con keel-spring); `cs-check --fixtures` de las seis variantes; la suite de keel-dotnet |
| 4. keel-go | hecho (2026-11-12) | `db-check` (PostgreSQL y MySQL, 4 sujetos) y `doc-check` (2 sujetos) con los sabotajes que tienen qué romper, cada uno en exactamente sus casos; `test/data-lifecycle-parity.test.js` (PD-1 con bash, paridad con keel-spring); `go-check --fixtures`; lo emitido para las fixtures, idéntico byte a byte; la suite de keel-go |
| 5. Derivados y documentación | pendiente | |
| 6. Fixtures | pendiente | |
| 7. Corridas de control | pendiente | |

## Para retomar

Los incrementos 0 a 4 están hechos: los cuatro generadores emiten el ciclo de vida del dato, y la fila `data-lifecycle` de
sus cuatro matrices está `verificado` y `falsified: true`. Qué añadió el 4 (keel-go), además de lo de § «Decidido y medido al
escribir el incremento 4»:

- **`src/scaffold/data-lifecycle.js`**: las marcas, el predicado de vida (`liveSuffix`, `f.alive()`, `DOCUMENT_ALIVE`),
  `DeleteByID` que marca, `FindDeletedBy<Clave>` y `Restore` en los dos adaptadores, `<Raíz>Retention` (relacional y
  documental) con su `Recurring`, `RetentionSettings` y `retention.yaml`, los kinds y el cableado del cronómetro
  (`retentionKindRows`, `retentionWiring`) y `lifecycleStackErrors`.
- **Enganchado en** `repositories.js`, `document-repositories.js`, `finders.js`, `persistence.js` (marcas y unicidades entre
  vivas), `document-persistence.js` (`partialFilterEntries`), `claim.js`, `reconciliation-claim.js`, `timer.js`, `cache.js` (la
  caché en una variable cuando la retención la vacía), `services.js` (notas) y `logging-check.js` (PD-1);
  `supported-features.js` ya no lo rechaza.
- **La red**: `scripts/lib/lifecycle-probes.js` en `db-check` y `doc-check` (`lifecycle_probe_test.go`), con `--only` en
  lista; los sujetos son parches de `UNCOVERED_BRANCHES`, así que `go-syntax`, `go-idioms`, `uncovered-branches.test.js` y
  `go-check` los recorren. La sonda de los índices vivos de `doc-check` compara también el filtro de vida.

Siguiente, el incremento 5 (derivados y documentación), con su guion de § Incrementos: `openapi.js` con `x-personal` y sus
tres oráculos, `docs/keel/personal-data.md` en los cuatro, las skills (`/keel-docs`, `/keel-design`, `/keel-recover`), los
agentes de código y de calidad de los cuatro, `capability-coverage` y la fila en `CLAUDE.md` § Dónde se añade cada cosa. PD-3
(trazas y logs con el colector OTLP falso) quedó para ese incremento en los cuatro generadores.
