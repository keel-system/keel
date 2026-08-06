# Mapeo diseño Keel → código Spring

Tabla normativa, organizada por capa del diseño (`specs/<servicio>/<capa>.keel.yaml`). Ante ambigüedad, el orden de autoridad es: diseño > esta tabla > criterio del agente (documentando la decisión en el README generado). Las capas opcionales solo se generan si están declaradas en `layers` del manifiesto.

Buena parte de esta tabla la materializa ya el **scaffolding determinista** de `keel-spring build` (ver `project-layout.md`, sección "Qué genera el scaffolding"). Decisiones fijas del scaffolding que el agente debe conocer:

- Value types **escalares** (`base` + `constraints`) se aplanan a su tipo base Java; sus constraints van como Bean Validation al DTO y a la columna. El agente puede promoverlos a record/`@Embeddable` si el dominio lo justifica.
- Las entidades de dominio salen **encapsuladas**: getters (colecciones como vista inmutable), constructor completo solo para rehidratar desde persistencia y **sin setters ni constructor vacío**. El factory de creación, los métodos semánticos y las guardas de invariante los escribe el agente siguiendo `domain-modeling.md`, que además fija el reparto de la validación entre capas.
- `lifecycle` se protege con un guard **privado** `transitionTo(target)` (mapa de transiciones + `InvalidStateTransitionException`, code `INVALID_STATE_TRANSITION` → HTTP 409); los métodos semánticos por transición los añade el agente (build deja un TODO por transición declarada) y son la única vía para llamar al guard.
- Sin `XxxRequest`: el body HTTP es el propio `XxxCommand` (Bean Validation en sus componentes); las respuestas son `<PascalOperación>ResponseDto` en `application/dtos/`; outputs `paginated` usan `PagedResponse<T>`.
- Operación expuesta sin endpoint explícito ni patrón CRUD → fallback `POST /<operación-en-kebab>` marcado con `// TODO: revisar ruta`.
- `basePath` de api (o `/api/<servicio>` si falta) + `/v1` → `@RequestMapping` del `<Agregado>V1Controller`; las rutas del diseño son relativas a esa base. No se usa `server.servlet.context-path`.
- Entidades: dominio puro en `domain/aggregate|entity` + espejo `XxxJpa` en `infrastructure/persistence/entities`; el puerto `domain/repository/<E>Repository` lo implementa `<E>RepositoryImpl` con mapeo `toDomain`/`toJpa` explícito (value objects aplanados a columnas con prefijo).
- Configuración por perfiles (`local`/`develop`/`production`/`test`): `application-<perfil>.yaml` importa fragmentos `parameters/<perfil>/*.yaml` con gradiente de env vars (literal → `${VAR:default}` → `${VAR}`); ver project-layout.md. El agente añade configuración nueva en el fragmento del perfil correspondiente, nunca hardcodeada en un solo yaml.
- Cron del DSL (5 campos) → `@Scheduled` de Spring (6 campos) prefijando el campo de segundos: `"0 <cron>"`.

## `domain` — domain.keel.yaml

| Diseño | Código |
|--------|--------|
| `entities.X` | Dominio puro `domain/aggregate/X.java` (o `domain/entity/` si es interna) + espejo JPA `infrastructure/persistence/entities/XJpa.java` + puerto `domain/repository/XRepository` con adaptador `XRepositoryImpl` (solo por raíz de agregado, ver abajo) |
| campo `id: true` | `@Id`; con `generated: true` → generación en el servidor (`UUID.randomUUID()` o equivalente) |
| campo `unique: true` | `@UniqueConstraint(name = "uk_<tabla>_<campo>")` en la entidad JPA (lo genera build) + verificación explícita en application. La verificación produce el error del diseño en el caso normal; la constraint es la garantía real cuando dos peticiones simultáneas compiten, y su violación la traduce al mismo error el mapa `CONSTRAINT_TO_ERROR` del `ApiExceptionHandler` — completa ahí el `// TODO (agente)` con el error declarado |
| campo `required: true` | `nullable = false` + validación en el DTO de entrada |
| campo `generated` / `computed` | Lo asigna el servidor (infraestructura / regla de dominio); nunca aparece en DTOs de entrada |
| campo `sensitive` | Excluido de DTOs de salida y payloads de evento por defecto; solo se expone si un payload lo declara explícitamente |
| `types.T` escalar (`base` + `constraints`) | Value type (record o `@Embeddable`) con sus constraints validadas en el compact constructor (`domain-modeling.md`) |
| `types.T` enum nominal (`values`) | Enum Java en domain, reutilizado por nombre |
| `types.T` compuesto (`fields`) | Record puro en `domain/valueobject`; en la Jpa se **aplana a columnas con prefijo** (`<campo>_<sub>`) si es de un nivel escalar. VO anidado o colección de VOs → build deja `// TODO (agente)`: se resuelve con `@Embeddable`/`@Embedded`/`@ElementCollection` vía skill `keel-spring-database` |
| campo `enum` inline | Enum Java en domain; `default` aplicado al crear |
| `constraints` | Bean Validation en DTOs (`@Pattern`, `@Size`, `@DecimalMin`…) y/o validación del value type |
| `relations` | Asociación JPA según `cardinality`; `required: false` → `optional = true`. Casos que build no genera (fetch, to-many entre agregados) los completa el agente vía skill `keel-spring-database` (`references/jpa-mapping.md`) |
| `lifecycle` | Guardas mecánicas de transición en la entidad: un método de dominio por transición válida sobre el guard privado `transitionTo`; cambio de estado no declarado → excepción de negocio; estado con `[]` es terminal (`domain-modeling.md`) |
| `aggregates` | Repository de Spring Data **solo por raíz**; las entidades internas se acceden a través de su raíz, sin repository propio |
| `aggregates.A.entities` | Si ninguna `relations` ata la entidad interna a su raíz, build **deriva** la relación `one-to-many` (colección en el agregado + `@OneToMany` en la Jpa) y lo avisa con un warning |
| relación interna a un agregado | Asociación con `cascade = CascadeType.ALL, orphanRemoval = true` desde la raíz, con `@JoinColumn` (FK en la tabla hija para `@OneToMany`; columna `<relación>_id` para `@ManyToOne`/`@OneToOne`), sin join table |
| **back-reference** de la hija hacia su raíz (`ProductImage.product: many-to-one`) | Bidireccional: la hija es dueña de la FK (`@ManyToOne @JoinColumn`) y el `@OneToMany` de la raíz pasa a `mappedBy`. En el **dominio** la hija **no** lleva la referencia al padre (dentro del agregado el contexto ya es la raíz) y el mapeo `toDomain`/`toJpa` de la hija **nunca** llama al mapper del padre: el vínculo lo estampa la raíz al mapear su colección. Un mapper de hija que invoque el del padre es recursión infinita |
| relación hacia otro agregado (`many-to-one`/`one-to-one`) | Columna `UUID <relación>Id` a la raíz ajena, sin asociación navegable. La `to-many` entre agregados build no la genera (warning): la modela el agente sin cruzar la frontera de agregado |
| `invariants` | Guarda en el dominio que las protege — en el factory de creación y en cada método mutador afectado —, lanzando el error declarado del diseño (`domain-modeling.md`). Un invariante sin guarda es generación incompleta |

### Tipos base

| Diseño | Código |
|--------|--------|
| `decimal` con `scale` | `BigDecimal` con esa escala |
| `uuid` / `timestamp` / `date` | `UUID` / `Instant` / `LocalDate` |
| `text` | `String` con `@Column(columnDefinition = "text")` |
| `json` | `String` o `JsonNode` mapeado a jsonb, según prefiera el usuario |
| `file` (con `bucket`) | `String` con la clave/referencia del objeto en su bucket; el binario vive en el object storage (capa `storage`), no en la BD. El campo persiste solo la key; subida/descarga vía el puerto `FileStorage`. Lo que ese campo expone **en el cable** no es siempre la key: ver [§ `storage`](#storage--storagekeelyaml) |

### Cardinalidad (`list`, DSL 2.1)

Un campo con `list: true` mapea a `List<T>` del tipo del elemento. Vale en payloads y contratos (`use-cases`, `messaging`, `http-clients`) y en campos de entidad para colecciones de valores sin identidad (`tags`, `discounts`); dentro de un value object y en `pathParams` no es válido.

| Diseño | Código |
|--------|--------|
| `{ type: uuid, list: true }` | `List<UUID>` |
| `list: true` + `required: true` | `@NotEmpty` sobre el parámetro (contenedor), no `@NotNull` |
| `constraints: { minItems, maxItems }` | `@Size(min = …, max = …)` sobre el contenedor |
| Constraints del **elemento** (`pattern`, `maxLength`, `min`/`max`) | **Las aplica el agente**, inline en el genérico (`List<@Pattern(regexp = "…") String>`), añadiendo el import de `jakarta.validation.constraints`. Build solo genera las del contenedor |
| Campo `list` en un endpoint `GET` | `@RequestParam List<T> <nombre>` (parámetro repetido o separado por comas); nunca `@PathVariable` |

Las anotaciones solo se emiten en **commands**: los records de query no llevan Bean Validation. Si una query recibe un lote acotado y el diseño declara un error para la cota (`BATCH_SIZE_EXCEEDED`), hacerla cumplir es trabajo del handler, lanzando el error declarado — así el cliente recibe el `code` del contrato y no un `ConstraintViolation` genérico.

Una lista sin `maxItems` en una entrada por lotes es un hueco de diseño, no una licencia: si el diseño no la acota, repórtalo en lugar de aceptar lotes ilimitados.

#### Colección en un campo de entidad → tabla de elementos

Un `list` sobre un campo de entidad (colección de valores sin identidad) es una **tabla de elementos**, no una entidad hija. Build ya la genera; el agente solo la respeta:

| Elemento | Jpa generada |
|----------|--------------|
| Escalar / value type | `@ElementCollection` + `@CollectionTable(name = "<entidad>_<campo>", joinColumns = @JoinColumn(name = "<entidad>_id"))` + `@Column(name = "<campo>")` |
| Enum | igual, más `@Enumerated(EnumType.STRING)` |
| Value object compuesto | `List<<VO>Jpa>` sobre un `@Embeddable <VO>Jpa` (espejo del VO, mismo paquete que las entidades Jpa) |
| Value object con VO anidado | El `<VO>Jpa` deja un `TODO (agente)` en el subcampo anidado; complétalo con `@Embedded` o columnas |

En el **dominio** la colección es una lista mutable interna con getter inmutable (`List.copyOf`): el alta/baja de elementos va por métodos de negocio de la raíz, nunca por el getter. El adaptador de repositorio reconstruye el VO en ambos sentidos (`toDomain`/`toJpa`); no toques ese mapeo salvo para cerrar los TODO de VO anidado.

### Cuando el diseño llama «restricción de integridad» a una referencia entre agregados

Entre agregados solo hay una columna `UUID <relación>Id` (fila `relations` de la tabla): sin
asociación navegable, y por tanto sin nada que impida borrar la raíz referenciada. Con eso, un
`deleteBrand` que exija «no se borra mientras exista algún producto que la referencie» solo
puede implementarse como **check-then-act** —contar productos, borrar—, y entre las dos
sentencias cabe una escritura concurrente que cree el producto que acaba de comprobarse que
no existía: la marca se borra y queda un producto apuntando a nada.

Cuando el diseño llama a esa referencia «restricción de integridad» (o declara un error del
tipo `<X>_IN_USE`), la comprobación en el handler **no basta**: es el mensaje de error amable,
no la garantía. La garantía es una **FK real en el esquema, sin asociación JPA**: la columna sigue siendo un
`UUID` plano en el dominio y en la entidad, y solo la BD sabe que apunta a otra tabla.

No se declara con anotaciones: el atributo `foreignKey` vive en `@JoinColumn`, que exige una
asociación, y sobre un `UUID` básico Hibernate no emite ninguna FK. Va en el **baseline de
migraciones**, escrito a mano tras exportarlo (`infra/export-schema.sh` parte de las entidades,
así que tampoco la incluye):

```sql
ALTER TABLE product ADD CONSTRAINT fk_product_brand
    FOREIGN KEY (brand_id) REFERENCES brand (id);
```

El borrado concurrente falla entonces en la BD, y su violación se traduce por
`CONSTRAINT_TO_ERROR` (`ApiExceptionHandler`) al error declarado: el cliente ve el mismo 409
que en el camino no concurrente, con el mismo `code` — registra ahí el nombre de la constraint.

Consecuencia a asumir: en `local` (esquema por `ddl-auto`, sin Flyway hasta el cierre) la FK
no existe, así que un escenario `FL-*` que ejercite la carrera no la verá cerrada hasta que se
ejecute contra el baseline. No es motivo para omitirla, sí para decirlo en el reporte.

Mantén la comprobación previa: da el error sin gastar una transacción abortada en el caso
normal. Lo que cambia es que deja de ser la única defensa.

Si el diseño **acepta** la ventana (lo dice su `rule`), no añadas la FK: documentar el
comportamiento y contradecirlo en el esquema es peor que cualquiera de las dos opciones.

## `use-cases` — use-cases.keel.yaml

| Diseño | Código |
|--------|--------|
| `operations.op` | Record mensaje (`application/commands` o `application/queries`) + handler (`application/usecases`): `kind: query` con output → `XxxQuery implements Query<R>` + `XxxQueryHandler`; command con output → `XxxCommand implements ReturningCommand<R>`; command sin output → `XxxCommand implements Command`. El controller despacha vía mediator; commands con body llegan como `@Valid @RequestBody XxxCommand` y el id del path se fusiona reconstruyendo el record. Los componentes que vienen de la ruta van **sin** Bean Validation (el cliente no los manda en el cuerpo) y, si ningún campo del cuerpo es obligatorio, el `@RequestBody` es `required = false`: una petición sin cuerpo es válida |
| `operations.op` con `input`/`output.entity` **interna** a un agregado (p. ej. `AddOrderLine` sobre `OrderLine`) | El handler igual inyecta el repositorio de la **raíz** (`OrderRepository`) — nunca uno de la hija, que no existe. El agente carga la raíz por id, invoca su método de negocio (`order.addLine(...)`, ver `domain-modeling.md § Colecciones y entidades hijas`) y persiste la raíz |
| `kind: query` | Sin efectos; el `UseCaseMediator` la despacha en transacción `readOnly` (el handler no lleva `@Transactional`) |
| `input`/`output` `{ entity: X }` | DTOs derivados de la entidad; en input quedan fuera `generated`/`computed`; en output quedan fuera `sensitive` y los campos de `exclude`. Las **relaciones entran por defecto**: una referencia a otro agregado como `<relación>Id` (UUID) —salvo que el output la marque con `embed`, en cuyo caso el DTO lleva el `<Raíz>RefDto` que **produce el `<Raíz>RefResolver` que build inyecta en el handler**, siempre por lote: cómo usarlo, en [read-composition](read-composition.md)— y una entidad hija como su propio `<Hija>Dto` (`List<…>` si es `one-to-many`), que build genera. Un `exclude` con **dot-path** (`lines.costPrice`, `address.zip`) recorta el DTO **anidado**: build genera la hija completa y señala cada ruta con un warning — ese warning es la señal de trabajo del agente. En el **input** las hijas no entran (se gestionan por sus propias operaciones); si un flujo las recibe anidadas, build lo avisa y lo modela el agente |
| `output` con `sort` | **Generado entero, no tocar salvo por lo de abajo.** El orden declarado va como constante `<OPERACION>_ORDER` en el controller, aplicada solo si el cliente no manda `?sort=` (`withDefaultOrder`). Y el adaptador del agregado añade **siempre** el id como desempate (`TIE_BREAKER` + `withStableOrder`), venga el orden de donde venga: sin él, dos páginas consecutivas pueden repetir una fila y omitir otra. Un listado paginado **sin** `sort` declarado queda ordenado por id, no sin orden |
| `sort` con **dot-path** (`brand.name`, sobre una relación en `embed`) | build **no** lo traduce y emite un warning, en los dos modelos: de un agregado ajeno solo se guarda su id —una columna `UUID` o un campo `UUID`—, no una referencia navegable, así que no hay property path que dar a Spring Data. Lo implementa el agente con un adaptador de **lectura** (JPQL proyectado o `$lookup`, según el modelo) — [read-composition](read-composition.md) y el `references/read-queries.md` de la skill de tu base de datos. El stub del handler lleva la nota |
| `sort` con **dot-path** sobre un value object (`price.amount`) | Sí se traduce, y a cosas distintas: en relacional a la columna aplanada (`priceAmount`), en documental a la ruta literal del subdocumento (`price.amount`) |
| `input` con un campo `type: file` | Endpoint `multipart/form-data`: el binario llega como `@RequestPart MultipartFile` y viaja al mensaje como `FileUpload(content, filename, contentType, size)`; el resto de campos, como `@RequestParam`. El handler sube el contenido por el puerto `FileStorage` y guarda en el dominio la **clave** del objeto (String). Lo que el `output` expone se deriva de la visibilidad del bucket y **lo resuelve el mapper que genera build**, no el handler: ver [§ `storage`](#storage--storagekeelyaml) |
| `preconditions` / `rules` | Lógica del `handle(...)` del handler, en el mismo orden del diseño, comentadas con la frase del diseño cuando no sea obvia |
| `rules` con **normalización previa** (upper/lower/trim antes de validar formato o unicidad) | El campo **no** lleva `@Pattern`/`@Size` de Bean Validation en el DTO de entrada — ver el aviso de abajo |
| `errors[].code` | `<PascalCode>Error` en `domain/errors` con el `code` exacto, extendiendo la subclase base de su `http` (404→`NotFoundException`, 409→`ConflictException`…; status sin subclase → `DomainException` con el `httpStatus` en la metadata); `ApiExceptionHandler` la traduce a `ErrorResponse` (`timestamp`, `status`, `error`, `code`, `message`, `details`) |
| El mismo `code` con `http` **distinto** en dos operaciones | Una sola clase, pero con el status como **parámetro** del constructor (`new XxxError(mensaje, 422)`): extiende `DomainException` y `ApiExceptionHandler` resuelve el status desde la metadata. Cada handler pasa el `http` que su operación declara — pasarlo mal es un error de contrato invisible a la compilación |
| `emits` | `raise(<E>Event.of(...))` **dentro del método de negocio del agregado** que provoca el cambio (`domain-modeling.md`); el handler no publica ni inyecta publishers. El adaptador de repositorio drena el buffer al persistir y el bridge lo entrega según `messaging.publishing.reliability` |
| `idempotency: { keySource: client-key }` | **Build genera el mecanismo entero**: el puerto `IdempotencyStore` (`domain/idempotency`), su adaptador y la tabla `idempotency_record` (`infrastructure/persistence/idempotency`), el `IdempotencyContext` (`application/support`) y el filtro que le lleva la cabecera `Idempotency-Key`. Tú solo lo **usas** en el handler — ver abajo. No escribas otro registro: ni tabla propia, ni `SET NX` en la caché |
| `idempotency: { keySource: payload-hash }` | Mismo mecanismo; lo que cambia es de dónde sale la clave: el hash determinista del payload en vez de la cabecera |
| `cache` (solo queries) | Build genera `CacheConfig` (`@EnableCaching`, `CacheManager`, una constante y un TTL por operación cacheada, serializador JSON con `JavaTimeModule`, degradación a miss). El agente solo anota el adaptador: `@Cacheable(cacheNames = CacheConfig.<OPERACION>_CACHE, key = …, sync = true)` con la clave de `keyFields`, y `@CacheEvict` para `invalidatedBy` |
| `schedule: { cron }` | `@Scheduled(cron = ...)` que despacha el mensaje de la operación vía `UseCaseMediator`; sin endpoint |
| `internal: true` | Solo mensaje + handler en application; sin endpoint ni listener |

### Cómo se usa el `IdempotencyStore` en el handler

El orden importa, y es el mismo para `client-key` y `payload-hash` (solo cambia de dónde sale la
clave):

```java
Optional<String> key = IdempotencyContext.get();   // vacío = el cliente no mandó la cabecera
if (key.isPresent()) {
    String signature = /* hash determinista del contenido del command */;
    Optional<StoredRequest> previa = idempotencyStore.find("<nombreOperacion>", key.get());
    if (previa.isPresent()) {
        if (!previa.get().signature().equals(signature)) {
            throw new /* el error que el diseño declare para la clave reutilizada */;
        }
        return /* la MISMA respuesta, reconstruida desde previa.get().resourceId() */;
    }
    // … ejecuta el caso de uso …
    idempotencyStore.save("<nombreOperacion>", key.get(), signature, id.toString(), <ttlSeconds>);
}
```

- El `scope` es el **nombre de la operación** del diseño: la misma cabecera en dos operaciones
  distintas no debe colisionar.
- La repetición **no re-ejecuta nada**: ni escrituras, ni eventos. Si el escenario dice que
  `listProducts` sigue devolviendo `totalElements: 1` y que no se publica un segundo evento, eso es
  lo que se está comprobando.
- `save(...)` corre **dentro de la transacción del comando**, a propósito: si el comando revierte,
  el registro revierte con él. No lo saques a una transacción propia — una clave marcada sin recurso
  detrás haría que el reintento devolviese una respuesta que nunca existió.
- Dos peticiones simultáneas con la misma clave chocan en la clave primaria y una revierte. Es el
  desenlace correcto: de dos peticiones idénticas, exactamente una se ejecutó.
- El `code` del conflicto por firma distinta sale **del diseño** (`errors[]` de la operación). Si el
  diseño no declara ninguno, es `designGap`: repórtalo, no inventes un `code` — no estaría en el
  OpenAPI y ningún escenario lo cubre.

### `Idempotency-Key` ausente: se ejecuta, no se rechaza

`keySource: client-key` dice **de dónde sale la clave**, no que la cabecera sea obligatoria:
el DSL no tiene dónde declarar esa exigencia, y un rechazo necesita un `code` público que
solo puede nacer en `use-cases.keel.yaml § errors`. Así que la regla, cuando el diseño no
declara nada:

- **Sin cabecera, la operación se ejecuta con normalidad, simplemente sin deduplicar.** No se
  inventa un `IDEMPOTENCY_KEY_REQUIRED` ni se devuelve 400: un `code` que no está en el
  diseño no es contrato, no aparece en el OpenAPI generado y ningún escenario lo cubre.
- **Con cabecera**, el comportamiento completo: primera vez se ejecuta y se registra la
  clave; repetición dentro del `ttlSeconds` devuelve la respuesta original sin re-ejecutar.

Si el diseñador quiere que sea obligatoria, la vía es declarar el error en los `errors` de esa
operación (`{ code: IDEMPOTENCY_KEY_REQUIRED, when: …, http: 400 }`), y entonces el mapeo es
el de cualquier otro `errors[].code`. Que la operación se ejecute sin deduplicar es una
decisión **silenciosa** —no hay `Then` que la observe—, así que va al reporte como
`designGaps` aunque no bloquee ningún escenario.

### Normalización antes que validación de formato

Replicar el tipo del dominio como `@Pattern` en el DTO de entrada es el reflejo
natural, y es **incorrecto** cuando el diseño declara una regla de normalización
antes de la validación de ese campo: Bean Validation corre sobre el DTO **antes**
de que el handler llegue a normalizar nada.

> `sku` es de tipo `SKU` (`^[A-Z0-9][A-Z0-9-]{2,31}$`) y `use-cases` declara
> "normalizar el sku a mayúsculas" antes de "validar que no exista otro producto
> con ese sku". Con `@Pattern` en el DTO, un `sku` en minúsculas se rechaza con
> `422 VALIDATION_ERROR` y nunca llega a la regla de negocio, que debía devolver
> `409 SKU_ALREADY_EXISTS`. El escenario falla por el error equivocado.

Regla: si el orden de `rules` pone una normalización por delante de la validación
de formato o de unicidad de un campo, ese campo va **sin** `@Pattern`/`@Size` en
el DTO de entrada. La validación de formato vive después de normalizar, en el
handler o en el constructor del value object del dominio (que es donde el modelo
rico la quiere de todos modos, ver `domain-modeling.md`). `@NotNull`/`@NotBlank`
sí pueden quedarse: no compiten con ninguna normalización.

**Lo que ya hace `build`**: el `pattern` que un campo **hereda de su value type**
no se emite en los mensajes de entrada (commands y queries) — el formato del tipo
describe el valor ya normalizado. El `pattern` que el **campo declara por su
cuenta** sí se emite: es una restricción de esa entrada concreta, no la forma del
tipo. Si aun así una entrada llega con una anotación que compite con una
normalización declarada, es un caso que el diseño no expresa: repórtalo como
`designGap`, no lo arregles quitando la anotación a mano.

**Con qué error falla entonces el formato.** Al sacar la validación del DTO, el fallo de formato
deja de ser un `VALIDATION_ERROR` automático y pasa a ser tuyo. Si el diseño **no** declara un
`code` para ese caso (el DSL no permite colgar un `code` de una `constraints`, así que casi nunca
lo hará), lanza la `VALIDATION_ERROR` genérica del `ApiExceptionHandler` y **repórtalo como
`designGap`** — nunca inventes un `code` nuevo: no aparece en el OpenAPI generado, ningún escenario
lo espera y el cliente no puede programar contra él. Si el escenario exige un status distinto del
que da la validación genérica, eso también es `designGap`, y entonces la vía es que el diseño lo
declare en `errors[]`.

### Ordenar por un campo con columna normalizada

Cuando el diseño dice que un texto se compara o se ordena **ignorando mayúsculas y
acentos**, la columna normalizada del campo (`nameNormalized`) y el repositorio que la
consulta **los escribes tú** — es el fallback portable de
`skills/keel-spring-database/references/jpa-mapping.md` § Búsqueda que ignora mayúsculas y
acentos; build no la deriva porque el DSL no declara esa normalización como tal. El `Sort`
del listado tiene que usar **esa misma columna**, no la cruda:

```java
// mal: ordena por bytes, y 'Ácme' cae después de 'Zeta'
Sort.by(Sort.Order.asc("name"), Sort.Order.asc("id"))
// bien: misma fuente de verdad que el filtro
Sort.by(Sort.Order.asc("nameNormalized"), Sort.Order.asc("id"))
```

La regla es "existe columna normalizada del campo por el que ordeno ⇒ ordeno por
ella". Tratarlas como independientes hace que el filtro y el orden del mismo
listado discrepen, y el escenario falla en un elemento del medio de la página —
el fallo más caro de diagnosticar de todos.

**Al introducir la columna normalizada, actualiza la constante `<OPERACION>_ORDER` que
build generó en el controller**: apunta al campo crudo, que es el único que el diseño
nombra. Es el mismo cambio, y olvidarlo deja el orden por defecto discrepando del filtro.

**Alcance de la normalización**: la columna normalizada se genera para campos
escalares. Una colección (`list: true`, que se persiste como `@ElementCollection`)
**no** tiene columna equivalente, así que sobre ella solo puedes plegar mayúsculas.
Si un filtro cubre a la vez un campo escalar y una colección, los dos no se
comportan igual ante los acentos, y eso es una asimetría observable: decláralo como
`designGap` en vez de fingir paridad, porque cerrarla de verdad exige que el diseño
declare la estrategia de normalización de la colección.

### Colecciones hijas ordenadas por posición

Cuando una entidad hija lleva un campo de posición (`position`, `sortOrder`…) y ese
campo entra en la `naturalKey` —`(productId, position)`— la constraint resultante es
**UNIQUE**, y en la base de datos es **inmediata**, no diferida: se comprueba fila a
fila durante el flush, no al hacer commit.

Eso rompe la forma natural de escribir un reordenamiento o una recompactación tras
un borrado, porque el reparto pasa por estados intermedios en los que dos filas
comparten posición aunque el estado final sea perfectamente válido:

```java
// mal: al bajar la imagen 3 a la posición 2, durante un instante hay dos filas
// con position=2, y el índice único aborta el flush. Sin concurrencia ninguna.
images.forEach(image -> image.setPosition(newPositions.get(image.getId())));
repository.saveAndFlush(product);
```

El patrón que funciona es desplazar toda la colección fuera del rango en uso, hacer
flush, y solo entonces asignar las posiciones definitivas:

```java
// 1. saca las posiciones del rango válido (el offset supera cualquier posición real)
int offset = images.size() + 1;
images.forEach(image -> image.setPosition(image.getPosition() + offset));
repository.saveAndFlush(product);
// 2. ahora ninguna asignación puede chocar con una fila que aún no se ha movido
images.forEach(image -> image.setPosition(newPositions.get(image.getId())));
repository.saveAndFlush(product);
```

Aplica a las tres operaciones que tocan el reparto: reordenar, borrar (que
recompacta las siguientes) e insertar en medio. **Un fallo por cada fila afectada
parece un fallo por escenario y es uno solo**: si ves varios escenarios de la misma
colección cayendo con violación de constraint única, no los diagnostiques por
separado.

Si el rango final y el inicial no se solapan (añadir siempre al final, por ejemplo),
el offset sobra: el coste es un flush extra y solo se paga donde hay reparto.

### El sobre de error es contrato del generador

A diferencia de "ausencia vs. nulo", la **forma** del cuerpo de error no es negociable por el
diseño: keel-spring emite un único `ErrorResponse` y no tiene punto de extensión.

```json
{ "timestamp": "…", "status": 404, "error": "Not Found", "code": "PRODUCT_NOT_FOUND",
  "message": "…", "details": null, "correlationId": "…" }
```

`correlationId` solo existe como campo si el servicio tiene capa `api` o `messaging` (es entonces
cuando build genera `CorrelationContext`). `details` lleva la lista de campos que fallaron en las
validaciones `400` y viaja como `null` en el resto — presente siempre, para que un consumidor no
tenga que distinguir ausente de nulo en el contrato de error.

Si las convenciones del diseño describen otro sobre (RFC 7807, o solo `{code, message, details}`),
**no se acomoda el código**: es una divergencia entre el diseño y lo que este generador sabe
producir, y se reporta como tal. Los escenarios normalmente solo verifican `code` y status, así que
los campos extra no los rompen; lo que no vale es cambiar `ErrorResponse` a mano para que
coincidan.

### Ausencia vs. nulo: la fija el diseño, no la plantilla

Un campo sin valor, ¿se omite del JSON o viaja como `null`? Es una **convención de determinación**
del servicio: la declara `specs/validation-scenarios.md` en su sección de convenciones, vale por
igual para respuestas HTTP y para payloads de evento, y es contrato observable.

Build **no la decide**. El `application.yaml` generado no fija `default-property-inclusion`, así
que rige el default de Jackson: los nulos viajan. Es deliberado — el default global es único para
todo el proceso (respuestas REST y `MessageConverter` del broker comparten el `ObjectMapper`
autoconfigurado), y prejuzgarlo en la plantilla decidía el contrato de todos los servicios en
sentido único.

Lo que le toca al agente:

- Si el diseño dice **"un campo sin valor aparece como `null`"**: no hacer nada. Es lo que sale.
- Si el diseño dice **"un campo sin valor se omite"**: `@JsonInclude(JsonInclude.Include.NON_NULL)`
  en las clases del contrato afectadas (DTOs de respuesta y payloads de evento), a nivel de clase.
  Nunca reintroduciéndolo como default global en `application.yaml`: eso arrastra al broker y a
  cualquier otro serializador que use el mapper de la aplicación.
- Si un **campo concreto** declara lo contrario que la convención global —típicamente en su
  `description` de `messaging.keel.yaml` o de `domain.keel.yaml`: *"ausente mientras no tenga
  ninguna"*, *"se omite si…"*—, **gana el campo**: la convención global fija el default del
  servicio, no una regla sin excepciones. Y entonces la anotación va **en el componente**, no
  en la clase:

  ```java
  public record ProductCreatedIntegrationEvent(@JsonIgnore EventMetadata metadata, UUID productId,
          String description, @JsonInclude(JsonInclude.Include.NON_NULL) String primaryImage) {
  }
  ```

  Anotar la clase sería un fallo de contrato en el otro sentido: arrastraría a `description`,
  que sigue la convención global y **sí** tiene que viajar como `null`. Un `NON_NULL` de clase
  solo es correcto cuando la convención global ya dice "se omite".

En ambos casos, un value object compuesto sin ningún valor se mapea a `null` — eso lo decide el
mapeo, no Jackson (ver `domain-modeling.md`).

**Colecciones: `NON_NULL` no basta.** Un dominio sano representa "sin elementos" con `List.of()`,
no con `null`, así que un campo `list` opcional sigue viajando como `[]` bajo `NON_NULL` — que es
justo lo que "un campo sin valor se omite" dice que no debe pasar. Para las clases con campos de
colección opcionales, `@JsonInclude(JsonInclude.Include.NON_EMPTY)`: cubre nulos y vacíos con una
sola anotación. Si el diseño distingue "lista vacía" de "sin lista" (raro, pero es contrato si lo
dice), entonces `NON_NULL` y que el mapper produzca `null`; decidirlo por su cuenta es inventar
contrato.

### `Location`: la ruta del recurso que la respuesta describe

La regla general de un `201` es "URI de la petición + el `id` del `output`", y `build` la emite ya
resuelta. Tiene una excepción que **también genera `build`**, y conviene conocerla para no
"corregirla": cuando la operación añade algo a la colección de un agregado y devuelve **el
agregado** (`POST /products/{productId}/images` con `output: { entity: Product }`), el `id` de la
respuesta es el del **padre**, no el del sub-recurso creado. Aplicar la regla general daría
`/products/{productId}/images/{productId}`, que no es la ruta de nada. En ese caso `Location`
apunta al agregado devuelto: `/api/v1/products/{productId}`.

Es genérico de cualquier "añadir X a la colección de Y devolviendo Y". Si un escenario espera otra
cosa, es discrepancia de diseño (`designGap`), no algo que se ajuste en el controller.

### Formato de los instantes

Build genera `infrastructure/serialization/TimestampModule` (registrado en el `ObjectMapper` de la
aplicación por `JacksonConfig`, y en el de la caché por `CacheConfig`): todo `Instant` sale en
ISO-8601 UTC con **exactamente tres dígitos** de fracción y sufijo `Z`. Sin él la precisión la
decidía el origen del valor —`Instant.now()` da microsegundos en JDK 9+, una columna `TIMESTAMP`
otra cosa— y el formato temporal dejaba de ser contrato. Si el diseño declara otra precisión, se
cambia el `appendInstant(3)` de esa clase y de ningún otro sitio.

### Actualización parcial (`PATCH`): ausente ≠ nulo explícito

Cuando el diseño declara la regla *"un campo ausente de la entrada conserva su
valor; un campo presente con valor nulo vacía el campo"*, un tipo plano no vale:
Jackson deja `null` en los dos casos y el handler no puede distinguirlos.

Build ya resuelve el mecanismo: en toda operación cuyo endpoint es `PATCH`, los
campos **no requeridos** del cuerpo se generan como `JsonNullable<T>` (con su
dependencia, su `JsonNullableModule` y el value extractor que mantiene vivas las
constraints). Lo que le toca al agente es **consumirlo bien** en el handler:

```java
// Ausente → no se toca. Presente (con valor o con null) → se aplica.
if (command.name().isPresent()) product.rename(command.name().get());
if (command.categoryId().isPresent()) product.moveTo(command.categoryId().get());
```

Nunca `command.name().orElse(null)` sobre el estado actual: eso vuelve a
colapsar los dos casos y borra el campo en cada petición que no lo mande.

### El orden declarado manda sobre la conveniencia técnica

`preconditions`/`rules` se traducen **en el orden del diseño**, incluidas las
guardas que técnicamente sería más cómodo evaluar antes. El caso típico es el
tamaño de un archivo: comprobarlo al recibir el multipart es lo natural, pero si
el diseño pone antes otra guarda (p. ej. "la galería no llega a 10 imágenes"),
esa es la que debe responder primero.

> Por eso build fija el límite multipart del servlet **con holgura** sobre el
> `maxSizeMb` del diseño: si cortase justo en el límite de negocio, el 413 lo
> emitiría Tomcat antes de ejecutar el caso de uso y ninguna guarda anterior
> podría precederlo. El límite de negocio se comprueba en el handler, en su
> sitio; `MaxUploadSizeExceededException` queda solo como red de seguridad.

### Auditoría de consistencia del contrato (antes de cerrar la capa `api`)

Los DTOs se escriben operación a operación, y una decisión tomada bien en un
agregado se olvida en el siguiente. Antes de dar la capa por cerrada:

1. Contrastar **cada nombre de campo** que aparece en `validation-scenarios.md`
   contra los DTOs de respuesta reales. Si el escenario pide `category` y el DTO
   expone `categoryId`, uno de los dos está mal — y si el diseño quiere el objeto,
   lo que falta es `embed` en el `output` (es un `designGap`, no un parche en el DTO).
2. Verificar que "ausencia vs. nulo" llega también a los **value objects
   compuestos**: un VO sin ningún valor se mapea a `null`, no a un objeto con
   todos los campos nulos (`"dimensions": {}` es un fallo de contrato).
3. Verificar que ningún value object proyectado expone métodos derivados
   (`isZero()`, `isPositive()`): Jackson los serializa como propiedades extra
   (`"zero": true`) y filtran detalle de implementación al contrato público
   (ver `domain-modeling.md`).
4. Recorrer los campos de `publishing.events.*.payload` de `messaging.keel.yaml`
   —el contrato de evento no lo cubre `validation-scenarios.md`, que habla de
   respuestas HTTP— y, por cada uno cuya `description` diga que se omite mientras
   no tenga valor ("ausente mientras…", "se omite si…"), confirmar el
   `@JsonInclude(NON_NULL)` **en el componente** del record de integración
   (§ Ausencia vs. nulo). Es el punto ciego típico: la excepción vive en una
   `description` de una capa que esta auditoría no miraba, así que se descubre en
   la validación funcional y cuesta un ciclo entero.

## `api` — api.keel.yaml

| Diseño | Código |
|--------|--------|
| `basePath` | Prefijo común de rutas en el `@RequestMapping` base de cada controller (no `server.servlet.context-path`). Si el diseño **no** versiona el basePath (`/api`), build añade `/v1`; si ya lo versiona (`/api/v1`), lo respeta tal cual. Ese mismo valor alimenta los matchers de `SecurityConfig`: no reescribas la ruta en un sitio sin el otro |
| `defaultAudience` / `endpoints.op.audience` | Público del endpoint. Con `serviceAuth.validateAudience`, decide en qué `SecurityFilterChain` cae la ruta (ver `security`) |
| `endpoints.op` | `@GetMapping`/`@PostMapping`… con `method`, `path` y `successStatus` del diseño |
| `path` con `{segmento}` | Un `@PathVariable` por segmento, con **su nombre exacto** y el tipo del campo homónimo del `input` (si el input no lo declara, `UUID` y warning de build). El binding sale de la ruta, no del nombre del campo: `{slug}` es `@PathVariable String slug`, nunca un query param |
| Campos del `input` que **no** están en la ruta | En `POST`/`PUT`/`PATCH`, cuerpo (`@Valid @RequestBody XxxCommand`, o partes del formulario si hay un campo `file`); en `GET`/`DELETE`, `@RequestParam`. Lo decide el verbo del endpoint, no el `kind` de la operación: un `POST` de consulta en lote lleva su lote en el body . En `PATCH`, los no requeridos van envueltos en `JsonNullable<T>` (ver § Actualización parcial) |
| `successStatus` ausente | 200, salvo `DELETE` (204) y las operaciones `create*` (201). Un `POST` que no crea un recurso —transición de estado, consulta en lote— responde 200; build avisa del status asumido para que el diseño lo fije |
| `auto: true` | Rutas por convención CRUD (`createX → POST /xs`, `getX → GET /xs/{id}`, `listXs → GET /xs`, `updateX → PUT /xs/{id}`, `deleteX → DELETE /xs/{id}`); los `endpoints` explícitos tienen prioridad |
| `pagination` | Build escribe `spring.data.web.pageable.default-page-size`/`max-page-size` desde el diseño (el tope se aplica solo, no lo comprueba el handler). La respuesta de un output `paginated: true` es `PagedResponse<XxxResponseDto>` con la forma canónica de `docs/dsl/api.md § Paginación` — `items`, `page`, `size`, `totalElements`, `totalPages` — y **nunca** `PagedResponse<List<…>>`: la envoltura ya es la lista |

## `security` — security.keel.yaml

Sin esta capa, no se incluye Spring Security. **Esta capa la materializa entera el scaffolding determinista**: `SecurityConfig` + `SecurityFilterChain` (matchers por ruta reutilizando los endpoints de los controllers), resource server JWT (`oidc`/`jwt`) o `ApiKeyAuthFilter` (`api-key`), y `JwtAuthConverter` del proveedor del stack cuando se usan roles/permisos, incluida la expansión de `roleGrants`. El agente solo interviene si el diseño exige autorización que no es derivable de los claims (p. ej. *ownership*: "solo el autor puede editarlo", que se resuelve en el handler con el principal). La tabla siguiente documenta el mapeo aplicado.

| Diseño | Código |
|--------|--------|
| `authentication.protocol` | `oidc`/`jwt` → Spring Security resource server (JWT); `api-key` → filtro de API key; `none` → sin autenticación |
| `authentication.tokenLocation` | Solo `header`: el token se lee de `Authorization`. `cookie` **no se genera** — `keel-spring build` lo avisa y sigue; completarlo a mano exige otro converter y protección CSRF |
| `access.default` | Regla base del `SecurityFilterChain` para toda operación sin regla explícita |
| `access.rules.op` | Regla por operación (vía su ruta): `public` → permitAll, `required` → authenticated (+ `hasAuthority` por `permissions`), `admin` → rol elevado (+ `hasRole` por `roles`), `service` → autenticación de cliente máquina |
| `roles` / `permissions` | Catálogo de authorities: roles como `ROLE_<rol>`, permisos como authority sin prefijo |
| `roleGrants` | Mapa estático `ROLE_GRANTS` en el `JwtAuthConverter`: cada rol del token se expande a las authorities de permiso que otorga. Es información **del diseño**, no del token — ningún IdP la emite por defecto (Keycloak solo manda `realm_access.roles`), así que sin esta expansión los matchers `hasAnyAuthority("<recurso>:<accion>")` no se satisfarían ni con el rol correcto. El claim `permissions`, si el IdP lo emite, se suma a lo anterior |
| `access.rules.op.scopes` (y `level: service`) | Matcher `hasAnyAuthority("SCOPE_<scope>", ...)` — el `JwtAuthConverter` ya emite los scopes del claim `scope` con prefijo `SCOPE_`; `service` sin scopes → `authenticated()` (cualquier token válido, incluidos de usuario: por eso el diseño lo marca con warning) |
| `audience` de un endpoint (capa api) | Sin efecto directo en código; gobierna qué reglas son válidas (lo valida `keel validate`) y qué escenarios M2M se ejercitan en la validación funcional |
| `authentication.serviceAuth.protocol: client-credentials` | Mismo resource server JWT: los tokens `client_credentials` entran por la misma cadena; los clientes se provisionan en el proveedor (skill `keel-spring-keycloak`/`-cognito`) |
| `authentication.serviceAuth.protocol: api-key` (con protocolo principal `oidc`/`jwt`) | `ServiceApiKeyAuthFilter`: header `X-API-Key` contra `security.api-keys.<cliente>` (fragmento `parameters/<perfil>/security.yaml`); autentica como el `serviceClient` con sus scopes como authorities `SCOPE_*` |
| `authentication.serviceAuth.validateAudience: true` | `AudienceAuthorizationFilter` (comprueba el claim `aud` del `JwtAuthenticationToken` ya autenticado y lanza `AccessDeniedException`), registrado antes del `AuthorizationFilter`; audiencia en `security.audience` (default: nombre del servicio). Es una regla de **autorización**, no de autenticación: validarla en el `JwtDecoder` convertiría un token legítimo de otro público en `401` (token inválido) cuando lo correcto es `403` (autenticado, sin permiso) — la distinción que exige el diseño. Por eso tampoco hay bean `JwtDecoder` propio: basta el que autoconfigura Boot desde el `issuer-uri`. **Solo se aplica a las rutas M2M**: si el servicio expone además endpoints de usuario, build emite **dos** `SecurityFilterChain` — `@Order(1)` con `securityMatcher` sobre las rutas `audience: services` y el filtro de audiencia, `@Order(2)` para el resto sin él. Un token de usuario lleva la audiencia que emite el IdP (`aud: "account"` en Keycloak), nunca la del servicio. Las rutas `audience: both` van a la cadena 2, sin comprobación de audiencia. Los 401/403 de la cadena salen con el `ErrorResponse` del contrato vía `SecurityErrorHandlers` (`AuthenticationEntryPoint` + `AccessDeniedHandler`).<br><br>**Dos límites declarados de este generador** (build los avisa al generar; si un escenario espera otra cosa, es un hueco del **diseño**, no algo que se parchee aquí): (1) el fallo de audiencia es **403**, nunca 401; (2) no hay distinción entre credencial humana y credencial de máquina más allá de las authorities de scope — un token de usuario que llevase el scope requerido pasaría el filtro de una operación `level: service`. Si hace falta cerrar el segundo, se hace con una regla explícita sobre un claim **verificado contra un token real** (ver `flow-fidelity.md § Claims y credenciales externas`), no de memoria |
| `cors` | `CorsConfig` (bean `CorsConfigurationSource` sobre `/**`) + `.cors(Customizer.withDefaults())` en **todas** las cadenas. Métodos derivados de los endpoints declarados más `OPTIONS`; `allowedHeaders`/`exposedHeaders`/`maxAgeSeconds`/`allowCredentials` del diseño como constantes. Los **orígenes no salen del diseño** (son dato de despliegue): `security.cors.allowed-origins` en `parameters/<perfil>/security.yaml`, literal en local y `${SECURITY_CORS_ALLOWED_ORIGINS}` obligatoria fuera. Se usa `setAllowedOriginPatterns` (admite comodines y es lo único válido con credenciales). Sin bloque `cors`, no se genera nada: el servicio rechaza toda petición cross-origin |
| `serviceClients` | Catálogo de clientes máquina: provisión en el proveedor de auth como clientes `client_credentials` con sus scopes (skill del proveedor), o fuente de las claves `security.api-keys.*` si `serviceAuth` es `api-key` |

## `messaging` — messaging.keel.yaml

La publicación va **entera generada** salvo el envío físico. La cadena es: el agregado hace `raise(...)` → `XxxRepositoryImpl.save()` drena `pullDomainEvents()` dentro de la transacción → `<Servicio>DomainEventBridge` traduce cada evento de dominio a su `<E>IntegrationEvent` y lo entrega según la `reliability`. El agente solo implementa el puerto de salida (`OutboxDispatcher` con outbox, `<E>Publisher` con best-effort), la config del broker si aplica y el `<E>Listener` de cada suscripción (binding al canal + política `onFailure` + apertura de la correlación + deduplicación con el `IdempotencyGuard` generado + dispatch de `triggers` vía mediator), siguiendo la skill `keel-spring-<broker>` del proyecto.

| Diseño | Código |
|--------|--------|
| `publishing.events.E.payload` | Un componente del record por cada campo declarado, con su tipo, tanto en el evento de dominio como en el de integración. Un evento que solo lleve `metadata` es generación incompleta: el consumidor no recibe datos |
| `publishing.events.E` | Record `EEvent implements DomainEvent` en `domain/events` (primer componente `EventMetadata`, fábrica `of(...)` que la estampa) + gemelo de wire `EIntegrationEvent` en `infrastructure/messaging/events` + método del bridge que traduce uno en otro. Nombre del evento exacto (contrato público); destino `<servicio>.events` y routing `<servicio>.<e-kebab>`, ambos parametrizados en `parameters/<perfil>/messaging.yaml` (el código solo lee `@Value`) |
| `publishing.reliability: outbox` | Generado: `OutboxEventJpa` + `OutboxEventJpaRepository` + `OutboxRelay` (`@Scheduled`, lote, reintentos con `attempts`/`lastError`, purga por cron) + `@EnableScheduling`. El bridge escribe la fila con `@EventListener` **síncrono**, en la misma transacción que el cambio (comparte la frontera de `persistence.consistency`); el relay entrega después vía el puerto `OutboxDispatcher`. Sin capa `persistence` no aplica: no hay transacción que compartir |
| `publishing.reliability: best-effort` | El bridge publica con `@TransactionalEventListener(AFTER_COMMIT)` vía el puerto `EPublisher` (`domain/events`), que build genera con un stub que solo traza (el contexto arranca sin broker) |
| `EventEnvelope` | Envoltura de wire: reutiliza la `EventMetadata` que estampó el agregado y solo le añade el `correlationId` del request. **Nunca** se regenera la metadata: el `eventId` es la clave de idempotencia del consumidor. Forma exacta del JSON publicado y descripción campo a campo: `architecture.md § Forma del mensaje publicado` |
| `subscriptions.E` | Record `<E>Message` (scaffolding) + listener del broker elegido (agente: `@KafkaListener`/`@RabbitListener`/`@SqsListener`) que deserializa el payload y despacha la operación de `triggers` vía mediator |
| `subscriptions.E.contract.envelope` | `keel` → deserializa `EventEnvelope<EMessage>` y usa `data()`; `none` → el mensaje es el payload; `wrapped` → record `<E>Envelope` (scaffolding) con el payload colgando de `payloadPath` |
| `subscriptions.E.contract.discriminator` | Filtro del listener: header (`@Header`) o campo del cuerpo; lo que no coincide con `value` se **descarta sin excepción** (una excepción dispararía reintentos y DLQ) |
| `subscriptions.E.contract.messageId` | Clave de deduplicación leída antes de despachar (header o campo): la entrega es at-least-once. Se pasa a `IdempotencyGuard.tryRecord("<Listener>", <messageId>)`; sin `messageId` declarado, se usa `envelope.metadata().eventId()` |
| Cualquier `subscriptions` (con capa `persistence`) | Generado: `ProcessedEventJpa` (tabla `processed_event`, PK compuesta handler+evento) + `ProcessedEventJpaRepository` + `IdempotencyGuard` (`tryRecord` en transacción propia, purga por cron) + `@EnableScheduling`, en `infrastructure/messaging/idempotency`. Es el mecanismo de deduplicación del servicio: el agente lo **usa** desde el listener, no escribe otro |
| `EventEnvelope.metadata.correlationId` | Sale de `CorrelationContext` (`infrastructure/correlation`), que puebla `CorrelationFilter` en cada request HTTP (header `X-Correlation-Id`, generado si no viene, devuelto en la respuesta) y el listener en cada mensaje con `CorrelationContext.runWith(...)`. También llega al `ErrorResponse` y a cada línea de log (`logging.pattern.correlation`) |
| `subscriptions.E.contract.format` / `schemaRef` | Deserializador del formato (JSON por defecto; avro/protobuf → schema registry de la fuente) |
| `subscriptions.E.contract.unknownFields` | `ignore` → `@JsonIgnoreProperties(ignoreUnknown = true)` en el record; `fail` → sin la anotación (scaffolding) |
| `payload.<campo>.wireName` | `@JsonProperty("<wireName>")` en el componente del record (scaffolding); el nombre del DSL se mantiene en Java |
| campo `file` en un `payload` | La **key** del objeto, tal cual la guarda el dominio. El wire de `messaging` **nunca** resuelve una URL de storage: resolver la key a URL es exclusivo del `ResponseDto` de la capa `api`, y ahí lo hace el mapper que genera build (ver [§ `storage`](#storage--storagekeelyaml)). Un consumidor recibe una referencia estable al objeto; una URL caducaría, ataría el evento al proveedor de storage y se rompería al cambiar de bucket. Que el DSL describa el campo con la misma frase en `api` y en `messaging` («referencia al objeto, no el binario») no los iguala: el destino es lo que decide. La asimetría sale gratis porque los payloads los genera otro módulo (`events.js`) y ahí no hay nada que resolver |
| `subscriptions.E.input` | Argumentos del command/query de `triggers` al despachar: componente ← campo del payload (identidad por nombre si no se declara); el javadoc del record generado lo lleva escrito |
| `channels.<c>.external: true` | El nombre físico del topic/cola lo pone su dueño: propiedad en `parameters/<perfil>`, nunca hardcodeado ni declarado en la topología local |
| `subscriptions.E.onFailure.retry` | Reintentos con backoff según `maxAttempts`/`backoff`/`initialDelayMs` y el techo `maxDelayMs` si está declarado (ej. `DefaultErrorHandler` con `ExponentialBackOff` y su `maxInterval`) |
| `subscriptions.E.onFailure.deadLetter: true` | DLQ tras agotar reintentos (`DeadLetterPublishingRecoverer` o equivalente) |

## `http-clients` — http-clients.keel.yaml

**El scaffolding determinista genera el patrón puerto + adaptador + anticorrupción completo**: el PUERTO `<Cliente>Client` y los records `<Llamada>Result` (resultado en términos del dominio) en `domain/clients`; y en `infrastructure/http` el adaptador `<Cliente>HttpAdapter` (RestClient + resilience4j cableado al fragmento `parameters/<perfil>/http-clients.yaml`), los DTOs wire `<Llamada>Request`/`<Llamada>Response` (contrato del tercero tal cual) y el mapper ACL `<Cliente>Mapper` que traduce wire ↔ dominio. Los use cases inyectan **solo el puerto**. Con `method`/`path`/`request`/`response` estructurados en el diseño todo sale tipado y el mapper completo: el agente solo implementa los `*Fallback`. Con `contract` solo-prosa, los records quedan vacíos y el mapper como stub: el agente además los tipa y mapea.

| Diseño | Código |
|--------|--------|
| `clients.C` | Puerto `CClient` en `domain/clients` + adaptador `CHttpAdapter` + mapper `CMapper` en `infrastructure/http`, mockeable en tests por el puerto |
| `clients.C.auth.type: api-key` | Header (`headerName`, default `X-Api-Key`) en el bean RestClient; credencial por property `http-clients.<c>.auth.api-key` (env var `<C>_API_KEY`), nunca del diseño |
| `clients.C.auth.type: bearer-static` / `basic` | `Authorization: Bearer` / `setBasicAuth` en el bean; credenciales por properties `http-clients.<c>.auth.*` (`<C>_TOKEN` / `<C>_USERNAME`+`<C>_PASSWORD`) |
| `clients.C.auth.type: oauth2-client-credentials` | `OAuth2ClientHttpRequestInterceptor` + `HttpClientsOAuth2Config` (manager client_credentials compartido); registration estándar `spring.security.oauth2.client.*` con `<C>_CLIENT_ID`/`<C>_CLIENT_SECRET`/`<C>_TOKEN_URL` |
| `calls.x.contract` | Prosa: Javadoc del método del puerto; si no hay `method`/`path`, se parsea como legacy `"MÉTODO /ruta"` |
| `calls.x.method` + `calls.x.path` | Verbo y URI de la llamada RestClient (las variables `{v}` de path → parámetros del método) |
| `calls.x.request` | `pathParams`/`queryParams`/`headers` → parámetros tipados del puerto; `body` → record wire `<X>Request` + `to<X>Request(...)` en el mapper |
| `calls.x.response.fields` | Record wire `<X>Response` + record de dominio `<X>Result` + `to<X>Result(...)` en el mapper (mapeo campo a campo generado) |
| `calls.x.timeoutMs` | Timeout de la llamada en la configuración del cliente |
| `calls.x.retry` | resilience4j `@Retry` con `maxAttempts`/`backoff`/`initialDelayMs` y, si el diseño declara el techo, `maxDelayMs` → `exponential-max-wait-duration`; solo para `retryOn` (`timeout`, `5xx`, `connection`); nunca 4xx |
| `calls.x.circuitBreaker` | resilience4j `@CircuitBreaker` con `failureRateThreshold`/`slidingWindowSize`/`waitDurationMs` |
| `calls.x.fallback` | Método de fallback que implementa la frase del diseño; si dispara un error de negocio, usa el `code` declarado en use-cases |

## `dependencies` — dependencies.keel.yaml

Capa de **síntesis**: casi todo lo que referencia ya está generado por otras capas (el puerto del cliente por `http-clients`, el listener y el guard por `messaging`, la entidad y su repositorio por `domain`/`persistence`). **No generes un segundo cliente ni un segundo listener.** Lo único que exige código propio es una réplica (`strategy: replicated`): la copia local y su política de lectura. Reglas completas y antipatrones en [`dependencies.md`](dependencies.md); el cableado es **listener → IdempotencyGuard → UseCaseMediator → handler de la operación de proyección → Projector → puerto**, y el listener nunca llama al Projector.

| Diseño | Código |
|--------|--------|
| `dependencies.D` | Nada propio: documenta en el README y en el archivo de contexto del repo de quién depende el servicio y a qué versión de contrato |
| `needs.n.strategy: on-demand` | **Nada nuevo**: el handler de cada operación de `usedBy` invoca el puerto `<C>Client` ya generado |
| `needs.n.usedBy` | Javadoc del Reader y de los handlers implicados; es la trazabilidad caso de uso ↔ integración |
| `needs.n.fetchedFrom` | Referencia al método `<call>` del puerto `<C>Client`; la resiliencia ya está en su adaptador, no la repitas |
| `needs.n.replica.entity` | Entidad de dominio + `<E>Jpa` + `<E>Repository` (ya salen de domain/persistence), con javadoc que la marca como proyección de `D` |
| `needs.n.replica.keyField` | Clave natural de la copia → finder `findBy<KeyField>` del repositorio; es la clave del upsert |
| `needs.n.replica` | `application/projection/<E>Projector` (`@ApplicationComponent`, sin Spring; `apply(...)` hace el upsert por `keyField` dentro de la transacción del mediator). El dominio no tiene setters: el agente añade `<E>.projectionOf(...)` y `<E>.applySnapshot(...)` con la firma que indica el TODO del Projector |
| `needs.n.replica.fedBy` | Las suscripciones ya generadas; su handler de proyección invoca al `<E>Projector` |
| `needs.n.replica.freshness` | Javadoc del `<E>Reader`. **No** se traduce a TTL, cron ni umbral: es prosa de negocio |
| instante del hecho en el payload | Comparación en el Projector que impide que un evento viejo pise a uno nuevo. Si el payload no lo trae, `// TODO` explícito |
| `onMiss.action: fetch` | `<E>Reader.byKey()` = repositorio `.or(() -> hydrate(...))`; `hydrate` invoca el puerto (ojo: el mediator ya abrió transacción — ver `dependencies.md` regla 6) |
| `onMiss.action: fail` | `.orElseThrow(new <Code>Error(...))` — la excepción ya existe del catálogo de `use-cases` (con status por constructor si el `code` es de status dinámico) |
| `onMiss.action: degrade` | `byKey()` devuelve `Optional<E>`; el resultado degradado lo escribe el agente siguiendo la prosa de `degradedTo`, y debe ser distinguible de una respuesta normal |
| `compensations[].onEvent` | Nada nuevo: es una suscripción normal, solo etiquetada como compensación en la documentación del proyecto |

## `persistence` — persistence.keel.yaml

Sin esta capa (servicio sin estado propio), no se incluye persistencia ni base de datos.

**El modelo lo elige el diseño, no el stack.** `default.model` decide qué rama de
persistencia genera build, y el cuestionario solo ofrece los motores de ese modelo:
un diseño `document` no puede acabar sobre PostgreSQL por descuido, ni al revés.

| Diseño | Código |
|--------|--------|
| `default.model: relational` | Spring Data JPA sobre uno de los seis dialectos del catálogo (ver project-layout.md): espejo `XxxJpa`, `JpaRepository`, adaptador, y el esquema gobernado por migraciones Flyway |
| `default.model: document` | Spring Data MongoDB: espejo `XxxDocument`, `MongoRepository`, adaptador, y los índices en `MongoIndexConfig`. Ver *El agregado es un documento*, abajo |
| `default.model: key-value` | **No soportado**: `keel-spring build` falla con un error explícito en vez de emitir algo por defecto. Ese diseño necesita otro generador |
| `entities.X.naturalKey` | Constraint/índice único compuesto (`uk_<colección>_natural`) + método de búsqueda por clave natural en el repository |
| `entities.X.indexes` | Un índice por cada lista de campos (`idx_<tabla|colección>_<campos>`). En relacional es un `@Index` de la entidad, que pasa al baseline al exportarlo; en documental lo crea `MongoIndexConfig` |
| `consistency.transactionalBoundary: per-operation` | La transacción por mensaje que abre `UseCaseMediator` ya lo cumple: la operación completa es la transacción |
| `consistency.transactionalBoundary: per-aggregate` | El command debe tocar una sola raíz de agregado dentro de la transacción del mediator; nunca dos agregados en la misma transacción (si necesitas semántica especial, anota el handler con `@Transactional` y documenta la excepción) |
| `audit.timestamps` / `audit.authorship` | **Lo gobierna el diseño** (`all` \| `declared` \| `none`) y build lo aplica entero. Con `all`: las columnas viven en `AuditableEntity` (`@MappedSuperclass` + `@EntityListeners`), el dominio no las nombra y no salen en ningún contrato. Con `declared`: los campos son del **dominio** (el diseño los declara con `generated: true` para poder proyectarlos en un `output`) y build los anota en su `XxxJpa` con `@CreatedDate`/`@LastModifiedDate`/`@CreatedBy`/`@LastModifiedBy` + `@EntityListeners` en la clase. Con `none`: no se genera nada, ni `@EnableJpaAuditing`. **No lo reintroduzcas por criterio propio**: una columna de auditoría que el diseño no pidió acaba en el baseline de migraciones |
| autoría: de dónde sale el actor | `AuditorAwareConfig` (`infrastructure/configurations/audit/`), generado por build siempre que `audit.authorship` no sea `none`. Lee el principal del `SecurityContext` — con protocolo de token, el claim que `JwtAuthConverter` fijó como `principalClaim` (`preferred_username` en Keycloak, `username` en Cognito, `sub` en el genérico). **Es total**: en una escritura sin petición detrás (relay del outbox, listener del broker, `@Scheduled`) devuelve el centinela `system` o `system:<correlationId>`, nunca `Optional.empty()` — por eso las columnas pueden ser `NOT NULL`. Spring Data autodetecta el bean: `auditorAwareRef` no hace falta. **No escribas otro `AuditorAware`** |
| bloqueo optimista en la raíz de agregado | **Lo gobierna el diseño**, en `persistence.consistency.optimisticLocking` (`all` por defecto \| `declared` \| `none`), y build lo aplica: con `all`/`declared` genera el campo `@Version @Column(name = "lock_version") private Long lockVersion` en la `XxxJpa`, `lockVersion` en el constructor de rehidratación del dominio (último parámetro) + `getLockVersion()`, propagación en `toDomain`/`toJpa`, y el handler que traduce `ObjectOptimisticLockingFailureException` a **409 `OPTIMISTIC_LOCK_CONFLICT`**. No lo reañadas ni dupliques el handler. Con `none` **no se genera nada de esto**: el diseño ha declarado "último escritor gana" y una escritura concurrente no debe fallar — no lo reintroduzcas por criterio propio, ni siquiera "por seguridad": convertiría en `409` un escenario que espera dos `200`. Solo si el diseño exige detectar updates concurrentes que tocan **solo entidades hijas** distintas sin modificar la raíz, refuérzalo con `LockModeType.OPTIMISTIC_FORCE_INCREMENT` (`references/configuration.md`) |
| campo `version` declarado en una entidad del DSL | Campo escalar corriente, **no** el `@Version` de JPA (que es `lockVersion`, aparte): es un contador de **dominio** que viaja en la API y en los payloads de eventos. Lo incrementa el agregado en cada método mutador que el diseño describe como cambio observable, y es el contador contra el que se compara un `expectedVersion` de la entrada — ver `conventions/flow-fidelity.md` |
| soft-delete, `json`→jsonb, converters, ids numéricos generados | No los genera build (dependen del diseño avanzado): los añade el agente siguiendo `keel-spring-database`/`references/jpa-mapping.md`, cubiertos por escenarios `FL-*` |
| entidad que proyecta auditoría al dominio (`audit.*: declared`) | Su adaptador guarda con **`saveAndFlush(...)`**, no `save(...)` — lo genera build; ver el aviso de abajo |

### `saveAndFlush` cuando la auditoría llega al dominio

`@LastModifiedDate`/`@LastModifiedBy` corren en el **flush** de Hibernate. Con el
`UseCaseMediator` abriendo la transacción y haciendo commit al final, ese flush
ocurre *después* de que el handler ya mapeó el objeto devuelto por `save(...)` a
DTO: la respuesta sale con el `updatedAt` viejo.

Es un fallo fácil de pasar por alto porque **un `GET` posterior muestra el valor
correcto** y enmascara el síntoma: lo único que está mal es la respuesta de la
propia operación de escritura.

Build ya lo resuelve: si la entidad proyecta campos de auditoría al dominio
(política `declared`, que es la única en la que esos campos pueden acabar en una
respuesta), su `XxxRepositoryImpl.save(...)` usa `saveAndFlush(...)`. Con la
política `all` las columnas no llegan al dominio y no hay nada que adelantar. Lo
que sí sigue siendo tuyo: si escribes un adaptador o una query a mano y la
respuesta debe llevar un valor que el ORM gestiona, fuerza el flush igual.

Esto es específico de JPA. En el modelo documental no hay flush diferido: la
auditoría corre en un callback **antes** de convertir el documento, así que el objeto
que devuelve `save(...)` ya trae los valores nuevos — y `saveAndFlush` ni siquiera
existe en `MongoRepository`.

### El agregado es un documento (`default.model: document`)

Con este modelo la raíz de agregado **es** una colección y sus entidades internas van
anidadas dentro de su documento. No tienen colección propia ni se consultan por
separado: cargar el informe es cargar sus secciones y sus puntos.

| Diseño | Documento |
|--------|-----------|
| campo escalar | `@Field(name = "<snake>")`; un `decimal` **siempre** con `targetType = FieldType.DECIMAL128` |
| campo `list: true` | array del propio documento (no hay tabla de elementos) |
| value object | subdocumento anidado (`XxxDocument`), no columnas con prefijo |
| value object **dentro** de otro | otro subdocumento. Es el caso que en JPA deja un `// TODO (agente)`: aquí sale generado |
| entidad hija del agregado | objeto o `List<HijaDocument>` anidados. Sin `mappedBy`, sin `cascade`, sin `orphanRemoval` |
| back-reference de la hija a la raíz | **no se genera**: era un artefacto de la clave ajena y aquí no apunta a nada |
| relación a **otro** agregado | `UUID <rel>Id`. **Nunca `@DBRef`**: parece un join y es una consulta por referencia, además de romper la frontera del agregado |
| `optimisticLocking` | `@Version` de `org.springframework.data.annotation`; el conflicto llega como `OptimisticLockingFailureException` |
| `audit` | las mismas anotaciones de `org.springframework.data.annotation`, activadas con `@EnableMongoAuditing`. Con `all`, solo las **raíces**: el callback actúa sobre el objeto que se guarda, no sobre lo anidado |

Tres consecuencias que no son de mapeo y hay que tener presentes:

- **La base ya no hace cumplir `required` ni `maxLength`.** Sin esquema, la única
  defensa es la Bean Validation del borde. Recuperarlo es un validador `$jsonSchema`,
  que es tuning del agente y no generación (skill `keel-spring-mongodb`).
- **El límite de 16 MB por documento cae sobre la frontera del agregado.** Una
  colección hija que crece sin cota es olor de diseño, no un problema de mapeo.
- **El orden de una colección hija lo aplica el mapeo, no la base.** Donde JPA ponía
  `@OrderBy`, aquí build emite un `Comparator` explícito en `toDomain`: un array de
  Mongo conserva el orden de inserción, que tras un reorder ya no es el del diseño.

### Ordenar por un id `UUID`: nunca en memoria con `Comparator.comparing`

`UUID.compareTo()` compara los dos `long` internos **con signo**. Postgres ordena
el tipo `uuid` **byte a byte, sin signo**. Los dos órdenes divergen en cuanto el
bit más alto está a 1 — es decir, en aproximadamente la mitad de los UUIDv4.

Si un escenario dice "ordenado por id ascendente" y el handler ordena con
`Comparator.comparing(Entidad::getId)`, el resultado no coincide con lo que
devuelve un `ORDER BY id` de la base. Falla de forma intermitente y dependiente de
los datos, que es la peor manera de fallar: pasa en local con tres filas
sembradas y revienta con otras.

- **Regla**: el orden lo fija la **consulta** (`ORDER BY id` en el repository, o
  `Sort.by("id")`), no el código Java. Así el escenario compara contra la misma
  semántica que la base.
- Si de verdad tienes que ordenar en memoria (una lista ya materializada, un
  batch que se reordena tras un `findAllById`), compara sin signo:

```java
Comparator<UUID> BY_UUID = Comparator
        .comparingLong(UUID::getMostSignificantBits)
        .thenComparingLong(UUID::getLeastSignificantBits);   // ❌ con signo

Comparator<UUID> BY_UUID = (a, b) -> {
    int hi = Long.compareUnsigned(a.getMostSignificantBits(), b.getMostSignificantBits());
    return hi != 0 ? hi : Long.compareUnsigned(a.getLeastSignificantBits(), b.getLeastSignificantBits());
};                                                            // ✅ orden de Postgres
```

Lo mismo aplica a un `findAllById` que se reordena para respetar el orden de
entrada: ahí el orden lo fija la petición, no el id — no lo "arregles" ordenando.

## `storage` — storage.keel.yaml

Sin esta capa (servicio que no maneja archivos), no se incluye SDK de object storage ni adaptador. El scaffolding determinista genera la dependencia Gradle (`software.amazon.awssdk:s3`), el servicio MinIO en el `infra/docker-compose.yaml` (con MinIO), el fragmento de configuración `parameters/<perfil>/storage.yaml` (clave `storage`: `provider`, `endpoint`, `region`, `access-key`, `secret-key`, `path-style-access`, `public-base-url` si hay algún bucket público, y la política de cada bucket del diseño bajo `storage.buckets.<b>`: `bucket`, `visibility`, `max-size-mb`, `allowed-content-types` — **no hay clave `bucket` global**: los buckets son los que declara el diseño), el límite `spring.servlet.multipart.max-file-size`/`max-request-size` con holgura sobre el mayor `maxSizeMb` declarado (el límite de negocio lo comprueba el caso de uso, en el orden del diseño), los `@ExceptionHandler` de multipart en el `ApiExceptionHandler`, el **puerto `FileStorage`** y el value object `StoredObject(storageKey, url, contentType, sizeBytes)` que devuelve `upload` (lo que el agregado guarda; `url` llega null en buckets privados, cuya URL se pide al leer porque caduca), el **puerto `StoragePolicies`** + `BucketPolicy` con su adaptador `StorageProperties` (binding de `storage.buckets.*`), que es como la política declarada llega a la capa `application` sin `@Value`, y **la resolución de la key a URL en el mapper de salida** (ver más abajo). El agente escribe el adaptador completo siguiendo la skill `keel-spring-s3` del proyecto (bean `S3Client` + `S3FileStorage`) más la política de negocio: validación de content-type/tamaño según los `buckets`.

### Qué expone un campo `file` en el cable

Lo decide la **visibilidad de su bucket**, y es determinista — no es una elección del
agente ni algo que el diseño tenga que declarar aparte:

| Destino | Bucket `public` | Bucket `private` |
|---|---|---|
| `ResponseDto` (capa `api`) | **URL absoluta**, resuelta por el `<Entidad>ApplicationMapper` con `fileStorage.publicUrl(...)` — **lo genera build** | La **key** |
| `payload` (capa `messaging`) | La **key** | La **key** |

En un bucket privado el DTO **nunca** lleva una URL firmada: caduca, y una respuesta
que caduca no se puede cachear ni reemitir por idempotencia. La lectura de un objeto
privado la sirve la operación que el diseño declare para eso.

El mapper recibe `FileStorage` por constructor solo si alguno de sus DTOs proyecta un
campo `file` de bucket público, y nombra el bucket por la constante de `StoragePolicies`,
nunca como literal. **No lo reescribas a mano**: si un campo sale mal, lo que está mal es
la visibilidad del diseño o el adaptador, no el mapper.

| Diseño | Código |
|--------|--------|
| capa `storage` presente | Puerto `domain/storage/FileStorage` — scaffolding. Cada método toma el **bucket lógico** además de la key (`upload(bucket, key, …)`), porque con dos buckets declarados la key sola no dice a cuál se sube ni cómo se resuelve una lectura. Adaptador `infrastructure/storage/S3FileStorage` + `infrastructure/configurations/storage/S3Config` (bean `S3Client`, AWS SDK v2, sirve para MinIO y S3, configurado desde la clave `storage` de los perfiles) — agente, según la skill `keel-spring-s3` |
| Métodos del puerto | `upload` y `delete` siempre. `download` y `signedUrl` **solo con algún bucket `private`**; `publicUrl` **solo con algún bucket `public`**. Un método que el diseño no puede necesitar no se declara: obligaría a implementar un `@Override` inalcanzable, y en el caso de la URL empujaba a sobrecargar `signedUrl` para que compusiera URLs públicas — semántica que la firma no dice y que el agente termina supliendo con un método inventado |
| `buckets.B` | Un bucket físico por bucket lógico (nombre derivado de `B`, prefijado por servicio/entorno para evitar colisiones); el adaptador lo crea/valida al arrancar en local. Su nombre y su política se leen con `StoragePolicies.forBucket(StoragePolicies.B)`, nunca como literal ni por `@Value` — scaffolding |
| `buckets.B.allowedContentTypes` | Validación de content-type en la subida antes de tocar el storage, con `BucketPolicy.allowsContentType(...)` → error `UNSUPPORTED_CONTENT_TYPE` (declararlo en use-cases) |
| `buckets.B.maxSizeMb` | Validación de tamaño **en el caso de uso**, con `BucketPolicy.allowsSize(...)` y en el orden que fija el diseño → error `FILE_TOO_LARGE` (agente). Build fija el límite del servlet (`spring.servlet.multipart.max-file-size`) al **doble** del mayor `maxSizeMb` declarado, deliberadamente: si cortase justo en el límite de negocio, Tomcat emitiría el 413 antes del handler y ninguna guarda que el diseño ponga antes podría precederlo. El handler de `MaxUploadSizeExceededException` → `413 FILE_TOO_LARGE` queda como red de seguridad |
| `buckets.B.visibility: private` | El objeto no es de lectura pública; la descarga se sirve mediada por el servicio o vía **URL firmada** temporal (`signedUrl`), pedida al leer y nunca incrustada en un `ResponseDto` |
| `buckets.B.visibility: public` | Lectura directa permitida: el adaptador **debe aplicar la bucket policy de lectura anónima** (idempotente, en cada arranque; S3 y MinIO crean los buckets privados). Sin ella la subida responde `201` y el `GET` directo `403`. El `ResponseDto` expone la **URL absoluta**, compuesta desde `storage.public-base-url` — la que alcanza el consumidor (CDN o borde; `localhost` en local), **no** el `endpoint` con el que el servicio habla con el almacén, que en compose es un nombre de red que fuera no resuelve |
| campo `file` de una entidad | La entidad persiste la **key** del objeto (String); el controller recibe el binario como `multipart/form-data` (`MultipartFile`), el handler valida contra el bucket y delega en `FileStorage`, y guarda la key devuelta. La traducción al cable la hace el mapper, no el handler |

## Cobertura funcional (criterio de "generación terminada")

La generación **no** está terminada si falta alguna de estas dos condiciones:

- `./gradlew build -x test` en verde (compila y empaqueta).
- El **100%** de los flujos `FL-*` de `specs/<servicio>/validation-scenarios.md` ejecutados en vivo contra el servidor arrancado, verificando el Then completo (status, headers y efectos observables). Ver el paso "Verificar" de la skill y `orchestration.md`.

Cada operación, error declarado, invariante y transición de `lifecycle` debe quedar ejercitado por algún escenario: si un caso relevante no está cubierto por ningún `FL-*`, es un hueco del **diseño** (proponer el escenario en `validation-scenarios.md`), no algo que se tape con código.

**Pruebas unitarias**: fuera de este flujo. La suite (camino feliz y cada error por operación, tests de API con MockMvc, invariantes, `lifecycle`, integración por flujo) es un proceso independiente y posterior, que arranca cuando el diseñador ha validado el funcionamiento del servidor. Durante la generación ningún agente escribe tests ni ejecuta `./gradlew test`; el andamiaje que deja `build` (deps de test, perfil `test` con H2, `<Nombre>ApplicationTests`) queda intacto para esa fase.
