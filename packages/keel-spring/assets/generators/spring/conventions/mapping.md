# Mapeo diseño Keel → código Spring

Tabla normativa, organizada por capa del diseño (`specs/<servicio>/<capa>.keel.yaml`). Ante ambigüedad, el orden de autoridad es: diseño > esta tabla > golden > criterio del agente (documentando la decisión en el README generado). Las capas opcionales solo se generan si están declaradas en `layers` del manifiesto.

Buena parte de esta tabla la materializa ya el **scaffolding determinista** de `keel-springboot build` (ver `project-layout.md`, sección "Qué genera el scaffolding"). Decisiones fijas del scaffolding que el agente debe conocer:

- Value types **escalares** (`base` + `constraints`) se aplanan a su tipo base Java; sus constraints van como Bean Validation al DTO y a la columna. El agente puede promoverlos a record/`@Embeddable` si el dominio lo justifica.
- `lifecycle` se protege con un guard genérico `transitionTo(target)` (mapa de transiciones + `InvalidStateTransitionException`, code `INVALID_STATE_TRANSITION` → HTTP 409); los métodos semánticos por transición los añade el agente.
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
| campo `unique: true` | constraint única en JPA + verificación explícita en application (para producir el error del diseño, no una excepción de BD) |
| campo `required: true` | `nullable = false` + validación en el DTO de entrada |
| campo `generated` / `computed` | Lo asigna el servidor (infraestructura / regla de dominio); nunca aparece en DTOs de entrada |
| campo `sensitive` | Excluido de DTOs de salida y payloads de evento por defecto; solo se expone si un payload lo declara explícitamente |
| `types.T` escalar (`base` + `constraints`) | Value type (record o `@Embeddable`) con sus constraints como validación en el constructor |
| `types.T` enum nominal (`values`) | Enum Java en domain, reutilizado por nombre |
| `types.T` compuesto (`fields`) | Record/`@Embeddable` con los campos; cómo se persiste lo decide la capa persistence |
| campo `enum` inline | Enum Java en domain; `default` aplicado al crear |
| `constraints` | Bean Validation en DTOs (`@Pattern`, `@Size`, `@DecimalMin`…) y/o validación del value type |
| `relations` | Asociación JPA según `cardinality`; `required: false` → `optional = true` |
| `lifecycle` | Guardas mecánicas de transición en la entidad: un método de dominio por transición válida; cambio de estado no declarado → excepción de negocio; estado con `[]` es terminal |
| `aggregates` | Repository de Spring Data **solo por raíz**; las entidades internas se acceden a través de su raíz, sin repository propio |
| relación interna a un agregado | Asociación con `cascade = CascadeType.ALL, orphanRemoval = true` desde la raíz |
| relación hacia otro agregado | Columna id/FK a la raíz ajena, sin asociación navegable profunda |
| `invariants` | Métodos de dominio que las protegen (ej. transición de estado que lanza excepción) + test que intenta violarlas |

### Tipos base

| Diseño | Código |
|--------|--------|
| `decimal` con `scale` | `BigDecimal` con esa escala |
| `uuid` / `timestamp` / `date` | `UUID` / `Instant` / `LocalDate` |
| `text` | `String` con `@Column(columnDefinition = "text")` |
| `json` | `String` o `JsonNode` mapeado a jsonb, según prefiera el usuario |
| `file` (con `bucket`) | `String` con la clave/referencia del objeto en su bucket; el binario vive en el object storage (capa `storage`), no en la BD. El campo persiste solo la key; subida/descarga vía el puerto `FileStorage` |

## `use-cases` — use-cases.keel.yaml

| Diseño | Código |
|--------|--------|
| `operations.op` | Record mensaje (`application/commands` o `application/queries`) + handler (`application/usecases`): `kind: query` con output → `XxxQuery implements Query<R>` + `XxxQueryHandler`; command con output → `XxxCommand implements ReturningCommand<R>`; command sin output → `XxxCommand implements Command`. El controller despacha vía mediator; commands con body llegan como `@Valid @RequestBody XxxCommand` y el id del path se fusiona reconstruyendo el record |
| `kind: query` | Sin efectos; el `UseCaseMediator` la despacha en transacción `readOnly` (el handler no lleva `@Transactional`) |
| `input`/`output` `{ entity: X }` | DTOs derivados de la entidad; en input quedan fuera `generated`/`computed`; en output quedan fuera `sensitive` y los campos de `exclude` |
| `preconditions` / `rules` | Lógica del `handle(...)` del handler, en el mismo orden del diseño, comentadas con la frase del diseño cuando no sea obvia |
| `errors[].code` | `<PascalCode>Error` en `domain/errors` con el `code` exacto, extendiendo la subclase base de su `http` (404→`NotFoundException`, 409→`ConflictException`…; status sin subclase → `DomainException` con el `httpStatus` en la metadata); `ApiExceptionHandler` la traduce a `ErrorResponse` (`timestamp`, `status`, `error`, `code`, `message`, `details`) |
| `emits` | Publicación del evento (declarado en messaging) tras confirmar la transacción (`@TransactionalEventListener` u outbox según `messaging.publishing.reliability`) |
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
| `access.rules.op` | Regla por operación (vía su ruta): `public` → permitAll, `required` → authenticated (+ `hasAuthority` por `permissions`), `admin` → rol elevado (+ `hasRole` por `roles`) |
| `roles` / `permissions` / `roleGrants` | Catálogo de authorities; los grants se resuelven al validar el token o vía mapeo de claims |

## `messaging` — messaging.keel.yaml

Los publishers y —por cada `subscriptions`— el record `<E>Message` + el `<E>Listener` (binding al canal + política `onFailure`: en Kafka `@RetryableTopic` con retry+DLT determinista; en Rabbit/SQS el listener con la política como `// TODO`) **los genera el scaffolding**. El agente completa el mapeo `<E>Message` → operación `triggers` (dispatch vía mediator) y la `reliability` de publicación (outbox/after-commit).

| Diseño | Código |
|--------|--------|
| `publishing.events.E` | Record `EEvent` en `domain/events` + `EPublisher` en `infrastructure/messaging` que publica `EventEnvelope.of("E", event, correlationId)` (metadata: eventId, timestamp UTC, source=servicio) al exchange/topic `<servicio>.events` con routing `<servicio>.<e-kebab>`; nombre del evento exacto (contrato público). El agente añade la `reliability` declarada |
| `publishing.reliability: outbox` | Patrón outbox: el evento se escribe en la misma transacción que el cambio (tabla outbox + relay); comparte la frontera de `persistence.consistency` |
| `publishing.reliability: best-effort` | Publicación directa tras confirmar transacción (`@TransactionalEventListener(AFTER_COMMIT)`) |
| `subscriptions.E` | `@KafkaListener` (o equivalente del broker elegido) que deserializa el payload y llama a la operación de `triggers` |
| `subscriptions.E.onFailure.retry` | Reintentos con backoff según `maxAttempts`/`backoff`/`initialDelayMs` (ej. `DefaultErrorHandler` con `ExponentialBackOff`) |
| `subscriptions.E.onFailure.deadLetter: true` | DLQ tras agotar reintentos (`DeadLetterPublishingRecoverer` o equivalente) |

## `http-clients` — http-clients.keel.yaml

**El scaffolding determinista genera el esqueleto resiliente** en `infrastructure/http` (config `RestClient` con base-url + timeouts, interfaz + `Impl` con las llamadas parseadas del `contract` y sus anotaciones resilience4j cableadas al fragmento `parameters/<perfil>/http-clients.yaml`, y un record de respuesta por llamada). El agente solo tipa cada `<Llamada>Response` (record vacío) y completa el cuerpo del `*Fallback`.

| Diseño | Código |
|--------|--------|
| `clients.C` | Cliente (interface + implementación RestClient) en `infrastructure/http`, mockeable en tests |
| `calls.x.contract` | Firma del método y DTO de respuesta derivados del contrato |
| `calls.x.timeoutMs` | Timeout de la llamada en la configuración del cliente |
| `calls.x.retry` | spring-retry (o retry del cliente) con `maxAttempts`/`backoff`/`initialDelayMs`, solo para `retryOn` (`timeout`, `5xx`, `connection`); nunca 4xx |
| `calls.x.circuitBreaker` | resilience4j con `failureRateThreshold`/`slidingWindowSize`/`waitDurationMs` |
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

## `storage` — storage.keel.yaml

Sin esta capa (servicio que no maneja archivos), no se incluye SDK de object storage ni adaptador. El scaffolding determinista genera la dependencia Gradle (`software.amazon.awssdk:s3`), el servicio MinIO en el `docker-compose.yaml` (con MinIO), el fragmento de configuración `parameters/<perfil>/storage.yaml` (clave `storage`: `provider`, `bucket`, `endpoint`, `region`, `access-key`, `secret-key`, `path-style-access`) y el **puerto `FileStorage` + adaptador `S3FileStorage` + `S3Config`**. El agente completa solo la política de negocio: validación de content-type/tamaño según los `buckets` y la generación de `signedUrl`.

| Diseño | Código |
|--------|--------|
| capa `storage` presente | Puerto `domain/storage/FileStorage` (interface: `upload`, `download`, `delete`, `signedUrl`) + `infrastructure/configurations/storage/S3Config` (bean `S3Client`) + adaptador `infrastructure/storage/S3FileStorage` (AWS SDK v2, sirve para MinIO y S3), configurado desde la clave `storage` de los perfiles. `upload`/`download`/`delete` deterministas; `signedUrl` sale como `// TODO (agente)` |
| `buckets.B` | Un bucket físico por bucket lógico (nombre derivado de `B`, prefijado por servicio/entorno para evitar colisiones); el adaptador lo crea/valida al arrancar en local |
| `buckets.B.allowedContentTypes` | Validación de content-type en la subida antes de tocar el storage → error `UNSUPPORTED_CONTENT_TYPE` (declararlo en use-cases) |
| `buckets.B.maxSizeMb` | Límite de tamaño en la subida (multipart) → error `FILE_TOO_LARGE`; refuerza también `spring.servlet.multipart.max-file-size` |
| `buckets.B.visibility: private` | El objeto no es de lectura pública; la descarga se sirve mediada por el servicio o vía **URL firmada** temporal (`signedUrl`) |
| `buckets.B.visibility: public` | Lectura directa permitida; la URL pública puede exponerse en el ResponseDto |
| campo `file` de una entidad | La entidad persiste la **key** del objeto (String); el controller recibe el binario como `multipart/form-data` (`MultipartFile`), el handler valida contra el bucket y delega en `FileStorage`, y guarda la key devuelta |

## Tests (obligatorios en cada generación)

- Por operación: test del camino feliz + un test por cada `error` declarado, verificando el `code`.
- Tests de API (MockMvc) que verifican status HTTP del contrato (`successStatus`, `errors[].http`).
- Por invariante de entidad: al menos un test que intenta violarla y espera fallo.
- Por `lifecycle`: tests de transiciones válidas y al menos una transición no declarada que debe fallar.
- Por cada flujo `FL-*` de `specs/<servicio>/validation-scenarios.md`: un test de integración que reproduce su Given/When/Then (incluidos orden de evaluación y casos borde).
- La generación no está terminada si `./gradlew test` no pasa, ni sin la validación funcional final: los escenarios de `validation-scenarios.md` ejecutados en vivo contra el servidor arrancado (ver paso "Verificar" de la skill).
