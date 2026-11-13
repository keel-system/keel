# DSL 2.28: el ciclo de vida del dato (R4)

**Estado: en curso.** Incremento 0 (keel-core) hecho el 2026-11-11, incrementos 1 (keel-spring), 2 (keel-nest), 3 (keel-dotnet), 4 (keel-go), 5 (derivados y documentación) y 6 (fixtures) el 2026-11-12. Siguiente: incremento 7 (corridas de control, las lanza el usuario).

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

**Decidido y medido al escribir el incremento 5 (derivados y documentación, 2026-11-12):**

- **El contrato.** Cada propiedad o parámetro de un campo `personal` lleva `x-personal: true` (junto a un `$ref` si lo hay,
  que OpenAPI 3.1 admite), y la respuesta de éxito del borrado lógico y de la restauración cuenta lo que el cliente no
  deduce de la forma (`lifecycleContractClause`, neutral en `data-lifecycle.js`). Lo mide `keel-nest/test/openapi.test.js`
  sobre los seis sujetos: el mismo documento en los cuatro, toda marca es de un campo personal y sin deriva para
  `CHK-DOCS-OPENAPI-DRIFT`; `redocly lint` los da por válidos (el único aviso, `info-license`, es el de siempre).
- **El inventario** `docs/keel/personal-data.md` lo coloca el `generator-docs.js` de cada generador, como
  `identity-contract.md`; `keel-go/test/data-lifecycle-parity.test.js` afirma que es el mismo byte a byte en los cuatro y que
  no existe sin campos personales.
- **PD-3 es la app ARRANCADA**: el `telemetry-check` de keel-nest, keel-dotnet y keel-go gana la variante
  `codes-personal@mysql` (`PERSONAL_TELEMETRY_DESIGN` en `data-lifecycle-designs.js`: verification-codes con el email
  personal y ÚNICO, sin seguridad). La sonda escribe el handler de `issueCode` (es código del agente), manda dos altas con el
  mismo valor por HTTP contra MySQL —cuyo driver copia el valor en el mensaje de la unicidad violada; el de PostgreSQL no— y
  busca ese valor en todo lo que recibe el colector OTLP falso (en los bytes crudos del protobuf) y en la consola.
  `--only=PD-3` corre solo esa app.
- **Un defecto destapado, en keel-nest**: el span del caso de uso registraba la `QueryFailedError` cruda (`exception.message`
  y la pila con `Duplicate entry 'pd3-…'`), porque la traducción a `EMAIL_ALREADY_EXISTS` la hace el filtro de la API, FUERA
  del span. Con datos personales, el span registra solo la clase (`exceptionOf`, también en el cliente saliente). keel-dotnet
  y keel-go ya salían verdes (medido, no supuesto).
- **Los sabotajes de PD-3**, cada uno tumba PD-3 por la fuga y no por otra cosa: en keel-nest, el span vuelve a registrar la
  excepción entera; en keel-dotnet, el `pd-log-value` de `db-check` (EF vuelve a escribir el fallo de la sentencia en el
  log); en keel-go, la constraint conocida sale sin traducir (el mensaje del driver acaba en `exception.message` del span y
  en el catch-all del borde, y el alta responde 500).
- **keel-spring tenía el mismo patrón** que keel-nest: el mediator pasa a `observation.error(ex)` la
  `DataIntegrityViolationException` cruda, que traduce el `@ControllerAdvice` después. Con datos personales y telemetría pasa
  solo la clase de una `DataAccessException`. **Su red en vivo queda pendiente**: su `telemetry-check` ejercita los puertos y
  el mediator con JUnit, sin HTTP ni colector, y el handler es el stub del agente; lo mide solo
  `test/data-lifecycle.test.js` (cadenas).

**Decidido al escribir el incremento 6 (fixtures, 2026-11-12):**

- **profile-directory pasa a la v1.1.0, no a un patch.** Gana un campo y dos operaciones, y con `nulls: include` el
  `email` aparece en todos los cuerpos exactos: casi todos los flujos cambian, y las convenciones también. Un patch
  habría dejado el careo agotado sin resello posible (un cambio de convenciones es pasada completa), así que la versión
  es nueva y todo se rehace sobre ella: revisión entera (con `REV-PERSONAL-CLASSIFICATION` y `REV-API-DELETE-BODY`),
  barrido de huecos (clase 19 y § 3.13), registro estructural reafirmado y careo de la v1.1.0. El careo de la pasada 1 lo
  hice a mano en el contexto principal, flujo a flujo, como las migraciones de la 2.27; tres hallazgos, los tres
  aceptados con su motivo. 13/13 en `--ready` dentro de un workspace.
- **El diseño de la ficha es el del sujeto `cards-logical`, más tres cosas**: `subject` también es `personal` (el `sub`
  es un identificador seudónimo de la persona), `naturalKeyError: CARD_ALREADY_EXISTS` (con dos unicidades,
  `CHK-PERSIST-UNIQUE-ERROR-UNDECLARED` lo exige, y es el 409 de restaurar con el titular en otra ficha viva) y las
  `rules` de las operaciones nuevas. El sujeto `cards-logical` ya solo fija el modelo de persistencia.
- **Siete familias de flujos**: las tres de la v1.0.0 con el correo y las operaciones nuevas en las credenciales, y
  FL-CRD-004 (borrar, 404, borrar otra vez, restaurar), 005 (el `subject` libre y el 409 `CARD_ALREADY_EXISTS`), 006 (el
  correo libre y el 409 `EMAIL_ALREADY_EXISTS`) y 007 (la ventana vencida y la purga, cuyo único rastro observable es que
  `restoreMyCard` pase del 409 `CARD_NOT_RESTORABLE` al 404).
- **Riesgo para el incremento 7**: el arnés no tiene un helper que envejezca la marca de borrado, como `ageForDeadline`
  para un plazo. FL-CRD-007 la envejece con `dbSql`/`mongoEval` sobre `deleted_at`/`deletedAt` (Convenciones: edad de un
  borrado) y adelanta la purga con `fireTimer("retention:ContactCard")`. Hallazgo del careo aceptado: si la corrida lo
  tropieza, el helper entra en los cuatro arneses.
- **verification-codes no estaba en `--ready`, y no se lleva ahí.** El guion decía «siguen en `--ready`», pero las dos
  gemelas nunca lo estuvieron (8 de 13 criterios en rojo: sin escenarios, revisión, huecos ni careo; sus corridas de la
  2.26 iban con `--accept-unready`). Cerrar su diseño es otro trabajo. Pasan a la v1.1.0 con el `email` personal y la
  retención `from: issuedAt`, 30 días, `anonymize`, y siguen con los mismos 8 criterios que antes y ninguno nuevo.
- **Fuera las filas de la 2.28 en las cuatro `capability-coverage`.**

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

Desde el incremento 6 los declaran profile-directory y verification-codes[-mongo]; los sujetos miden lo que ellas no tienen.

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

- `profile-directory` en los cuatro generadores (verification-codes queda fuera: ver abajo).
- Una corrida con MySQL, para la columna generada (T2).
- Se registran en `docs/corridas/`.

Preparadas el 2026-11-12. En cada workspace se hizo `keel init`, se copió el diseño a `specs/`, su DESIGN.md a `docs/`, se
sembró `keel-stack.json` y se ejecutó `build`. profile-directory v1.1.0 está 13/13 en `--ready`, y el build no da avisos.
Cada corrida se lanza con `cd D:\keel-example\<workspace>\services\profile-directory-<generador>` y después
`/keel-generate-<generador>`. En keel-nest hay que hacer `npm install` antes.

| Workspace (`D:\keel-example\`) | Generador | Stack | Lo que añade |
|---|---|---|---|
| `cards-228-spring-postgre` | keel-spring | PostgreSQL · Keycloak | hecha (24/24, 2026-11-12, a la primera; huella 5, todo TODO; FL-CRD-007 envejecido con `db(...)`) |
| `cards-228-nest-postgre` | keel-nest | PostgreSQL · Keycloak | hecha (24/24, 2026-11-12, a la primera; huella 6: 5 TODO y el README; FL-CRD-007 con `db(...)`) |
| `cards-228-dotnet-postgre` | keel-dotnet | PostgreSQL · Keycloak | hecha (24/24, 2026-11-12, en la segunda puntuación: el Given de FL-CRD-007 nombraba mal la tabla; huella 6: 5 TODO y el README) |
| `cards-228-go-postgre` | keel-go | PostgreSQL · Keycloak | hecha (24/24, 2026-11-12, en la segunda puntuación: el mismo `contact_card` que keel-dotnet; huella 6: 5 TODO y el README) |
| `cards-228-dotnet-mysql` | keel-dotnet | MySQL · Keycloak | T2: las columnas generadas `uk_contact_cards_{natural,email}_flag` (`CASE WHEN deleted_at IS NULL THEN 1 END`) |

verification-codes no tiene `validation-scenarios.md`: una corrida suya no tendría flujos que puntuar, así que su retención
con `anonymize` no la vería ningún escenario. Por eso no se preparó, y el usuario decidió dejarla fuera (2026-11-12): las corridas de profile-directory cubren el
borrado lógico, la restauración y la purga, y `anonymize` ya está medido en vivo con los sujetos `codes-anonymize[-mongo]`. Para FL-CRD-007 los
cuatro arneses traen ya con qué ejecutar SQL contra la base (`dbSql` en keel-spring, `Db` en keel-dotnet y la consulta por
`psql` de keel-nest y keel-go). El helper `ageDeletion` solo hará falta si el agente no se las arregla con eso.

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
| 5. Derivados y documentación | hecho (2026-11-12) | `keel-nest/test/openapi.test.js` (seis sujetos, cuatro generadores) y `redocly lint`; el inventario igual en los cuatro; PD-3 en el `telemetry-check` de keel-nest, keel-dotnet y keel-go, en verde y cada uno falsado con `--sabotage=pd-log-value`; la suite entera |
| 6. Fixtures | hecho (2026-11-12) | profile-directory 13/13 en `--ready` dentro de un workspace; verification-codes[-mongo] sin criterios nuevos; las cuatro `capability-coverage` sin filas de la 2.28; la suite entera; en vivo, con los sujetos derivados que cambiaron (cards-logical[-mongo], codes-*): `db-check`/`doc-check` de keel-nest, keel-dotnet y keel-go (PostgreSQL y MySQL), `timer-check` de keel-spring sobre el par, los cuatro `security-check` y el `telemetry-check` de keel-nest, keel-dotnet y keel-go, todo en verde (el de keel-dotnet arrancaba profile-directory sobre la base de job-dispatch y chocaba en `keel_timer`: ahora lleva la suya) |
| 7. Corridas de control | pendiente | |

## Para retomar

Los incrementos 0 a 6 están hechos. Lo del 6 está en § «Decidido al escribir el incremento 6».

Siguiente, el incremento 7: las corridas de control, que lanza el usuario (dos a la vez como mucho). Están preparadas en
`D:\keel-example\cards-228-*`, con la tabla en el § 7. profile-directory
v1.1.0 genera sin `--accept-unready`; verification-codes lo sigue necesitando. Lo que hay que mirar en ellas: si el
agente de pruebas se las arregla con `dbSql`/`mongoEval` para envejecer el borrado de FL-CRD-007 (si no, el helper
`ageDeletion` en los cuatro arneses), la columna generada de MySQL (T2) en una corrida con ese motor, y los designGaps,
copiados a `docs/corridas/` antes de tirar el proyecto. Abierto aparte: la red en vivo de PD-3 en keel-spring.
