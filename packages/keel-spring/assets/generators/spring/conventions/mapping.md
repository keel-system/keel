# Mapeo diseño Keel → código Spring

Tabla normativa, organizada por capa del diseño (`specs/<servicio>/<capa>.keel.yaml`). Ante ambigüedad, el orden de autoridad es: diseño > esta tabla > golden > criterio del agente (documentando la decisión en el README generado). Las capas opcionales solo se generan si están declaradas en `layers` del manifiesto.

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
| `relations` | Asociación JPA según `cardinality`; `required: false` → `optional = true`. Casos que build no genera (bidireccionalidad/`mappedBy`, fetch, to-many entre agregados) los completa el agente vía skill `keel-spring-database` (`references/jpa-mapping.md`) |
| `lifecycle` | Guardas mecánicas de transición en la entidad: un método de dominio por transición válida sobre el guard privado `transitionTo`; cambio de estado no declarado → excepción de negocio; estado con `[]` es terminal (`domain-modeling.md`) |
| `aggregates` | Repository de Spring Data **solo por raíz**; las entidades internas se acceden a través de su raíz, sin repository propio |
| relación interna a un agregado | Asociación con `cascade = CascadeType.ALL, orphanRemoval = true` desde la raíz, con `@JoinColumn` (FK en la tabla hija para `@OneToMany`; columna `<relación>_id` para `@ManyToOne`/`@OneToOne`), sin join table |
| relación hacia otro agregado (`many-to-one`/`one-to-one`) | Columna `UUID <relación>Id` a la raíz ajena, sin asociación navegable. La `to-many` entre agregados build no la genera (warning): la modela el agente sin cruzar la frontera de agregado |
| `invariants` | Guarda en el dominio que las protege — en el factory de creación y en cada método mutador afectado —, lanzando el error declarado del diseño (`domain-modeling.md`). Un invariante sin guarda es generación incompleta |

### Tipos base

| Diseño | Código |
|--------|--------|
| `decimal` con `scale` | `BigDecimal` con esa escala |
| `uuid` / `timestamp` / `date` | `UUID` / `Instant` / `LocalDate` |
| `text` | `String` con `@Column(columnDefinition = "text")` |
| `json` | `String` o `JsonNode` mapeado a jsonb, según prefiera el usuario |
| `file` (con `bucket`) | `String` con la clave/referencia del objeto en su bucket; el binario vive en el object storage (capa `storage`), no en la BD. El campo persiste solo la key; subida/descarga vía el puerto `FileStorage` |

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

## `use-cases` — use-cases.keel.yaml

| Diseño | Código |
|--------|--------|
| `operations.op` | Record mensaje (`application/commands` o `application/queries`) + handler (`application/usecases`): `kind: query` con output → `XxxQuery implements Query<R>` + `XxxQueryHandler`; command con output → `XxxCommand implements ReturningCommand<R>`; command sin output → `XxxCommand implements Command`. El controller despacha vía mediator; commands con body llegan como `@Valid @RequestBody XxxCommand` y el id del path se fusiona reconstruyendo el record |
| `kind: query` | Sin efectos; el `UseCaseMediator` la despacha en transacción `readOnly` (el handler no lleva `@Transactional`) |
| `input`/`output` `{ entity: X }` | DTOs derivados de la entidad; en input quedan fuera `generated`/`computed`; en output quedan fuera `sensitive` y los campos de `exclude`. Un `exclude` con **dot-path** (`lines.costPrice`, `address.zip`) omite el campo del DTO **anidado** de la hija/value object, no solo del DTO raíz: build **no** lo aplica (su DTO es plano) y lo señala con un warning por cada ruta — ese warning es la señal de trabajo del agente. Sin dot-path, la hija sale íntegra salvo sus propios `sensitive`. El diseño manda qué campos anidados salen: no es criterio del agente |
| `preconditions` / `rules` | Lógica del `handle(...)` del handler, en el mismo orden del diseño, comentadas con la frase del diseño cuando no sea obvia |
| `errors[].code` | `<PascalCode>Error` en `domain/errors` con el `code` exacto, extendiendo la subclase base de su `http` (404→`NotFoundException`, 409→`ConflictException`…; status sin subclase → `DomainException` con el `httpStatus` en la metadata); `ApiExceptionHandler` la traduce a `ErrorResponse` (`timestamp`, `status`, `error`, `code`, `message`, `details`) |
| `emits` | `raise(<E>Event.of(...))` **dentro del método de negocio del agregado** que provoca el cambio (`domain-modeling.md`); el handler no publica ni inyecta publishers. El adaptador de repositorio drena el buffer al persistir y el bridge lo entrega según `messaging.publishing.reliability` |
| `idempotency: { keySource: client-key }` | Header `Idempotency-Key` requerido en esas operaciones; registro de claves procesadas con el `ttlSeconds` del diseño |
| `idempotency: { keySource: payload-hash }` | Hash del payload como clave de deduplicación; mismo registro con TTL |
| `cache` (solo queries) | Spring Cache (`@Cacheable` con clave de `keyFields`, TTL del diseño); `invalidatedBy` → evicción al recibir/emitir esos eventos |
| `schedule: { cron }` | `@Scheduled(cron = ...)` que despacha el mensaje de la operación vía `UseCaseMediator`; sin endpoint |
| `internal: true` | Solo mensaje + handler en application; sin endpoint ni listener |

## `api` — api.keel.yaml

| Diseño | Código |
|--------|--------|
| `basePath` | Prefijo común de rutas (`server.servlet.context-path` o `@RequestMapping` base) |
| `endpoints.op` | `@GetMapping`/`@PostMapping`… con `method`, `path` y `successStatus` del diseño |
| `auto: true` | Rutas por convención CRUD (`createX → POST /xs`, `getX → GET /xs/{id}`, `listXs → GET /xs`, `updateX → PUT /xs/{id}`, `deleteX → DELETE /xs/{id}`); los `endpoints` explícitos tienen prioridad |
| `pagination` | `Pageable` con `defaultSize`/`maxSize` del diseño; respuesta con `content` + metadatos, aplicada a outputs `paginated: true` |

## `security` — security.keel.yaml

Sin esta capa, no se incluye Spring Security. **Esta capa la materializa entera el scaffolding determinista**: `SecurityConfig` + `SecurityFilterChain` (matchers por ruta reutilizando los endpoints de los controllers), resource server JWT (`oidc`/`jwt`) o `ApiKeyAuthFilter` (`api-key`), y `JwtAuthConverter` del proveedor del stack cuando se usan roles/permisos. El agente solo interviene si el diseño exige autorización que el mapeo de claims no cubre (`roleGrants` resueltos en el servicio, *ownership*). La tabla siguiente documenta el mapeo aplicado.

| Diseño | Código |
|--------|--------|
| `authentication.protocol` | `oidc`/`jwt` → Spring Security resource server (JWT); `api-key` → filtro de API key; `none` → sin autenticación |
| `access.default` | Regla base del `SecurityFilterChain` para toda operación sin regla explícita |
| `access.rules.op` | Regla por operación (vía su ruta): `public` → permitAll, `required` → authenticated (+ `hasAuthority` por `permissions`), `admin` → rol elevado (+ `hasRole` por `roles`), `service` → autenticación de cliente máquina |
| `roles` / `permissions` / `roleGrants` | Catálogo de authorities; los grants se resuelven al validar el token o vía mapeo de claims |
| `access.rules.op.scopes` (y `level: service`) | Matcher `hasAnyAuthority("SCOPE_<scope>", ...)` — el `JwtAuthConverter` ya emite los scopes del claim `scope` con prefijo `SCOPE_`; `service` sin scopes → `authenticated()` (cualquier token válido, incluidos de usuario: por eso el diseño lo marca con warning) |
| `audience` de un endpoint (capa api) | Sin efecto directo en código; gobierna qué reglas son válidas (lo valida `keel validate`) y qué escenarios M2M se ejercitan en la validación funcional |
| `authentication.serviceAuth.protocol: client-credentials` | Mismo resource server JWT: los tokens `client_credentials` entran por la misma cadena; los clientes se provisionan en el proveedor (skill `keel-spring-keycloak`/`-cognito`) |
| `authentication.serviceAuth.protocol: api-key` (con protocolo principal `oidc`/`jwt`) | `ServiceApiKeyAuthFilter`: header `X-API-Key` contra `security.api-keys.<cliente>` (fragmento `parameters/<perfil>/security.yaml`); autentica como el `serviceClient` con sus scopes como authorities `SCOPE_*` |
| `authentication.serviceAuth.validateAudience: true` | `AudienceValidator` (`OAuth2TokenValidator<Jwt>` sobre el claim `aud`) + bean `JwtDecoder` (`SupplierJwtDecoder` → Nimbus desde el issuer + validador delegante), audiencia en `security.audience` (default: nombre del servicio) |
| `serviceClients` | Catálogo de clientes máquina: provisión en el proveedor de auth como clientes `client_credentials` con sus scopes (skill del proveedor), o fuente de las claves `security.api-keys.*` si `serviceAuth` es `api-key` |

## `messaging` — messaging.keel.yaml

La publicación va **entera generada** salvo el envío físico. La cadena es: el agregado hace `raise(...)` → `XxxRepositoryImpl.save()` drena `pullDomainEvents()` dentro de la transacción → `<Servicio>DomainEventBridge` traduce cada evento de dominio a su `<E>IntegrationEvent` y lo entrega según la `reliability`. El agente solo implementa el puerto de salida (`OutboxDispatcher` con outbox, `<E>Publisher` con best-effort), la config del broker si aplica y el `<E>Listener` de cada suscripción (binding al canal + política `onFailure` + apertura de la correlación + deduplicación con el `IdempotencyGuard` generado + dispatch de `triggers` vía mediator), siguiendo la skill `keel-spring-<broker>` (`.claude/skills/keel-spring-<broker>/SKILL.md`).

| Diseño | Código |
|--------|--------|
| `publishing.events.E` | Record `EEvent implements DomainEvent` en `domain/events` (primer componente `EventMetadata`, fábrica `of(...)` que la estampa) + gemelo de wire `EIntegrationEvent` en `infrastructure/messaging/events` + método del bridge que traduce uno en otro. Nombre del evento exacto (contrato público); destino `<servicio>.events` y routing `<servicio>.<e-kebab>`, ambos parametrizados en `parameters/<perfil>/messaging.yaml` (el código solo lee `@Value`) |
| `publishing.reliability: outbox` | Generado: `OutboxEventJpa` + `OutboxEventJpaRepository` + `OutboxRelay` (`@Scheduled`, lote, reintentos con `attempts`/`lastError`, purga por cron) + `@EnableScheduling`. El bridge escribe la fila con `@EventListener` **síncrono**, en la misma transacción que el cambio (comparte la frontera de `persistence.consistency`); el relay entrega después vía el puerto `OutboxDispatcher`. Sin capa `persistence` no aplica: no hay transacción que compartir |
| `publishing.reliability: best-effort` | El bridge publica con `@TransactionalEventListener(AFTER_COMMIT)` vía el puerto `EPublisher` (`domain/events`), que build genera con un stub que solo traza (el contexto arranca sin broker) |
| `EventEnvelope` | Envoltura de wire: reutiliza la `EventMetadata` que estampó el agregado y solo le añade el `correlationId` del request. **Nunca** se regenera la metadata: el `eventId` es la clave de idempotencia del consumidor |
| `subscriptions.E` | Record `<E>Message` (scaffolding) + listener del broker elegido (agente: `@KafkaListener`/`@RabbitListener`/`@SqsListener`) que deserializa el payload y despacha la operación de `triggers` vía mediator |
| `subscriptions.E.contract.envelope` | `keel` → deserializa `EventEnvelope<EMessage>` y usa `data()`; `none` → el mensaje es el payload; `wrapped` → record `<E>Envelope` (scaffolding) con el payload colgando de `payloadPath` |
| `subscriptions.E.contract.discriminator` | Filtro del listener: header (`@Header`) o campo del cuerpo; lo que no coincide con `value` se **descarta sin excepción** (una excepción dispararía reintentos y DLQ) |
| `subscriptions.E.contract.messageId` | Clave de deduplicación leída antes de despachar (header o campo): la entrega es at-least-once. Se pasa a `IdempotencyGuard.tryRecord("<Listener>", <messageId>)`; sin `messageId` declarado, se usa `envelope.metadata().eventId()` |
| Cualquier `subscriptions` (con capa `persistence`) | Generado: `ProcessedEventJpa` (tabla `processed_event`, PK compuesta handler+evento) + `ProcessedEventJpaRepository` + `IdempotencyGuard` (`tryRecord` en transacción propia, purga por cron) + `@EnableScheduling`, en `infrastructure/messaging/idempotency`. Es el mecanismo de deduplicación del servicio: el agente lo **usa** desde el listener, no escribe otro |
| `EventEnvelope.metadata.correlationId` | Sale de `CorrelationContext` (`infrastructure/correlation`), que puebla `CorrelationFilter` en cada request HTTP (header `X-Correlation-Id`, generado si no viene, devuelto en la respuesta) y el listener en cada mensaje con `CorrelationContext.runWith(...)`. También llega al `ErrorResponse` y a cada línea de log (`logging.pattern.correlation`) |
| `subscriptions.E.contract.format` / `schemaRef` | Deserializador del formato (JSON por defecto; avro/protobuf → schema registry de la fuente) |
| `subscriptions.E.contract.unknownFields` | `ignore` → `@JsonIgnoreProperties(ignoreUnknown = true)` en el record; `fail` → sin la anotación (scaffolding) |
| `payload.<campo>.wireName` | `@JsonProperty("<wireName>")` en el componente del record (scaffolding); el nombre del DSL se mantiene en Java |
| `subscriptions.E.input` | Argumentos del command/query de `triggers` al despachar: componente ← campo del payload (identidad por nombre si no se declara); el javadoc del record generado lo lleva escrito |
| `channels.<c>.external: true` | El nombre físico del topic/cola lo pone su dueño: propiedad en `parameters/<perfil>`, nunca hardcodeado ni declarado en la topología local |
| `subscriptions.E.onFailure.retry` | Reintentos con backoff según `maxAttempts`/`backoff`/`initialDelayMs` (ej. `DefaultErrorHandler` con `ExponentialBackOff`) |
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
| `calls.x.retry` | resilience4j `@Retry` con `maxAttempts`/`backoff`/`initialDelayMs`, solo para `retryOn` (`timeout`, `5xx`, `connection`); nunca 4xx |
| `calls.x.circuitBreaker` | resilience4j `@CircuitBreaker` con `failureRateThreshold`/`slidingWindowSize`/`waitDurationMs` |
| `calls.x.fallback` | Método de fallback que implementa la frase del diseño; si dispara un error de negocio, usa el `code` declarado en use-cases |

## `persistence` — persistence.keel.yaml

Sin esta capa (servicio sin estado propio), no se incluye JPA ni base de datos.

| Diseño | Código |
|--------|--------|
| `default.model: relational` | Spring Data JPA (stack por defecto: ver project-layout.md); `document`/`key-value` → Spring Data del almacén elegido con el usuario |
| `entities.X.naturalKey` | Constraint única compuesta + método de búsqueda por clave natural en el repository |
| `entities.X.indexes` | `@Index` en la entidad (o migración) por cada lista de campos |
| `consistency.transactionalBoundary: per-operation` | La transacción por mensaje que abre `UseCaseMediator` ya lo cumple: la operación completa es la transacción |
| `consistency.transactionalBoundary: per-aggregate` | El command debe tocar una sola raíz de agregado dentro de la transacción del mediator; nunca dos agregados en la misma transacción (si necesitas semántica especial, anota el handler con `@Transactional` y documenta la excepción) |
| auditoría `createdAt`/`updatedAt` | Automática: `AuditableEntity` (`@MappedSuperclass` + JPA auditing). Si la entidad declara sus propios timestamps, build no hereda pero anota esos campos con `@CreatedDate`/`@LastModifiedDate` + `@EntityListeners` (se auto-pueblan igual) |
| autoría (`createdBy`/`updatedBy`), `@Version` (locking), soft-delete, `json`→jsonb, converters, ids numéricos generados | No los genera build (dependen del diseño avanzado): los añade el agente siguiendo `keel-spring-database`/`references/jpa-mapping.md`, cubiertos por escenarios `FL-*` |

## `storage` — storage.keel.yaml

Sin esta capa (servicio que no maneja archivos), no se incluye SDK de object storage ni adaptador. El scaffolding determinista genera la dependencia Gradle (`software.amazon.awssdk:s3`), el servicio MinIO en el `infra/docker-compose.yaml` (con MinIO), el fragmento de configuración `parameters/<perfil>/storage.yaml` (clave `storage`: `provider`, `bucket`, `endpoint`, `region`, `access-key`, `secret-key`, `path-style-access`) , el **puerto `FileStorage`** y el value object `StoredObject(storageKey, url, contentType, sizeBytes)` que devuelve `upload` (lo que el agregado guarda; `url` llega null en buckets de URL firmada, que se pide al leer). El agente escribe el adaptador completo siguiendo la skill `keel-spring-s3` (`.claude/skills/keel-spring-s3/SKILL.md`; bean `S3Client` + `S3FileStorage`, incluida `signedUrl`) más la política de negocio: validación de content-type/tamaño según los `buckets`.

| Diseño | Código |
|--------|--------|
| capa `storage` presente | Puerto `domain/storage/FileStorage` (interface: `upload`, `download`, `delete`, `signedUrl`) — scaffolding. Adaptador `infrastructure/storage/S3FileStorage` + `infrastructure/configurations/storage/S3Config` (bean `S3Client`, AWS SDK v2, sirve para MinIO y S3, configurado desde la clave `storage` de los perfiles) — agente, según la skill `keel-spring-s3` |
| `buckets.B` | Un bucket físico por bucket lógico (nombre derivado de `B`, prefijado por servicio/entorno para evitar colisiones); el adaptador lo crea/valida al arrancar en local |
| `buckets.B.allowedContentTypes` | Validación de content-type en la subida antes de tocar el storage → error `UNSUPPORTED_CONTENT_TYPE` (declararlo en use-cases) |
| `buckets.B.maxSizeMb` | Límite de tamaño en la subida (multipart) → error `FILE_TOO_LARGE`; refuerza también `spring.servlet.multipart.max-file-size` |
| `buckets.B.visibility: private` | El objeto no es de lectura pública; la descarga se sirve mediada por el servicio o vía **URL firmada** temporal (`signedUrl`) |
| `buckets.B.visibility: public` | Lectura directa permitida; la URL pública puede exponerse en el ResponseDto |
| campo `file` de una entidad | La entidad persiste la **key** del objeto (String); el controller recibe el binario como `multipart/form-data` (`MultipartFile`), el handler valida contra el bucket y delega en `FileStorage`, y guarda la key devuelta |

## Cobertura funcional (criterio de "generación terminada")

La generación **no** está terminada si falta alguna de estas dos condiciones:

- `./gradlew build -x test` en verde (compila y empaqueta).
- El **100%** de los flujos `FL-*` de `specs/<servicio>/validation-scenarios.md` ejecutados en vivo contra el servidor arrancado, verificando el Then completo (status, headers y efectos observables). Ver el paso "Verificar" de la skill y `orchestration.md`.

Cada operación, error declarado, invariante y transición de `lifecycle` debe quedar ejercitado por algún escenario: si un caso relevante no está cubierto por ningún `FL-*`, es un hueco del **diseño** (proponer el escenario en `validation-scenarios.md`), no algo que se tape con código.

**Pruebas unitarias**: fuera de este flujo. La suite (camino feliz y cada error por operación, tests de API con MockMvc, invariantes, `lifecycle`, integración por flujo) es un proceso independiente y posterior, que arranca cuando el diseñador ha validado el funcionamiento del servidor. Durante la generación ningún agente escribe tests ni ejecuta `./gradlew test`; el andamiaje que deja `build` (deps de test, perfil `test` con H2, `<Nombre>ApplicationTests`) queda intacto para esa fase.
