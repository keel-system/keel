# Stack y estructura del proyecto generado

## Stack por defecto

El stack lo elige el diseñador en el **cuestionario de `keel-spring build`** (solo pregunta por las categorías que el diseño necesita) y queda persistido en `services/<servicio>-spring/keel-stack.json`; las siguientes ejecuciones lo reutilizan sin repreguntar (bórralo para reelegir). Con `--defaults` o sin terminal interactiva se usan los defaults.

- Java 21, Spring Boot 3.x, **Gradle** (Groovy DSL) **con wrapper incluido** (estilo Spring Initializr: `./gradlew` funciona de inmediato). Las versiones concretas las fijan las constantes del paquete.
- Persistencia (solo con capa `persistence`): Spring Data JPA + **PostgreSQL (default) / MySQL / MariaDB / SQL Server / Oracle / H2**; H2 para tests.
- Eventos (solo con capa `messaging`): **Kafka (default) / RabbitMQ / SNS+SQS** (SNS/SQS con LocalStack de prueba).
- Auth (solo con capa `security` oidc/jwt): Spring Security resource server; opcionalmente **Keycloak (default) / Cognito** de prueba en el compose.
- Caché (solo si alguna operación declara `cache`): **Redis (default) / Valkey** (cachés distribuidas).
- Object storage (solo con capa `storage`): **MinIO (default, contenedor de prueba compatible S3) / Amazon S3**, ambos vía AWS SDK v2 (`software.amazon.awssdk:s3`); MinIO habla protocolo S3, así que el mismo adaptador sirve para dev y prod.
- Mapeo DTO↔entidad: manual (sin MapStruct salvo petición).

El catálogo único de tecnologías (dependencias Gradle, imagen, servicio de compose y receta de validación por CLI) vive en `src/lib/stack-catalog.js` del generador.

El scaffolding genera además, agrupado en el directorio `infra/` del proyecto, `infra/docker-compose.yaml` con la infraestructura de prueba elegida (BD, broker, auth, cache, storage) — solo si hay al menos un contenedor — más un contenedor **`devtools`** (`infra/docker/Dockerfile.devtools`), un script `infra/validate-infra.sh` para sondearla (ver "Validación de infraestructura") y, si la BD lo permite, `infra/reset-db.sh` para vaciar los datos entre flujos de validación (ver `infra-validation.md`).

## Estructura (hexagonal + CQRS, arquitectura del prototipo de referencia)

Un único microservicio independiente: sin paquete `shared/` (lo transversal se absorbe en el propio árbol) y sin Spring Modulith (los límites entre módulos no aplican a un servicio solo).

```
services/<servicio>-spring/
├── README.md                    # cómo ejecutar + "Generado desde <spec> v<version>" + decisiones
├── build.gradle                 # dependencias condicionales según capas declaradas y keel-stack.json
├── settings.gradle
├── gradlew / gradlew.bat        # wrapper de Gradle incluido
├── gradle/wrapper/              # jar + properties del wrapper
├── keel-stack.json              # stack elegido en el cuestionario (BD, broker, auth, cache)
├── infra/                       # todo lo relativo a levantar la infraestructura de prueba
│   ├── docker-compose.yaml      # infraestructura de prueba + contenedor devtools (si el stack la necesita)
│   ├── docker/Dockerfile.devtools  # toolbox Alpine con solo las CLIs del stack (psql, redis-cli, kcat, mc, aws…)
│   ├── validate-infra.sh        # un check por tecnología: docker exec <svc>-devtools <cli>
│   └── reset-db.sh              # vacía los datos de la BD (esquema intacto); se ejecuta antes de cada flujo FL-* (si la BD lo permite; H2 no lo necesita)
└── src/
    ├── main/java/<base>/
    │   ├── application/         # SIN imports de Spring (desacoplada del framework)
    │   │   ├── interfaces/      # contratos CQRS: Command, Query<R>, ReturningCommand<R>, *Handler
    │   │   ├── annotations/     # @ApplicationComponent + @LogExceptions + LogLevel (anotaciones propias)
    │   │   ├── commands/        # XxxCommand records (Bean Validation: son el body HTTP)
    │   │   ├── queries/         # XxxQuery records
    │   │   ├── usecases/        # XxxCommandHandler / XxxQueryHandler (@ApplicationComponent, stub TODO)
    │   │   ├── dtos/            # XxxResponseDto + PagedResponse<T>
    │   │   └── mappers/         # <Entidad>ApplicationMapper (dominio → ResponseDto)
    │   ├── domain/
    │   │   ├── aggregate/       # raíces de agregado PURAS (sin JPA): ctor de rehidratación + getters + guard privado transitionTo (sin setters)
    │   │   ├── entity/          # entidades internas de agregado (puras)
    │   │   ├── annotations/     # @DomainComponent (para servicios de dominio del agente)
    │   │   ├── enums/           # enums del diseño (@JsonValue)
    │   │   ├── valueobject/     # records VO puros
    │   │   ├── events/          # DomainEvent + EventMetadata + records de evento (+ PUERTOS <Evento>Publisher si best-effort)
    │   │   ├── errors/          # DomainException + subclases por status + <PascalCode>Error por code
    │   │   ├── repository/      # PUERTOS: <Entidad>Repository (interfaces)
    │   │   └── storage/         # (solo con capa storage) PUERTO FileStorage (upload/download/delete/signedUrl) + VO StoredObject
    │   └── infrastructure/
    │       ├── configurations/usecase/  # UseCaseMediator (frontera transaccional) + Container + AutoRegister + UseCaseConfig
    │       ├── scheduling/      # <X>Scheduler (@Scheduled, adaptador timer que despacha vía mediator)
    │       ├── configurations/logging/  # LogExceptionsAspect (implementa @LogExceptions)
    │       ├── correlation/     # (con capa api o messaging) CorrelationContext (ThreadLocal + MDC)
    │       ├── web/             # (con capa api) CorrelationFilter (header X-Correlation-Id)
    │       ├── messaging/       # EventEnvelope + <Servicio>DomainEventBridge (+ stub del puerto de salida)
│       │   ├── events/      # <Evento>IntegrationEvent (gemelos de wire)
│       │   ├── outbox/      # (solo reliability: outbox) OutboxEventJpa + OutboxRelay + PUERTO OutboxDispatcher
│       │   └── idempotency/ # (solo con subscriptions) ProcessedEventJpa + IdempotencyGuard
    │       ├── persistence/
    │       │   ├── entities/    # AuditableEntity + XxxJpa (@Entity; VOs aplanados a columnas con prefijo)
    │       │   └── repositories/ # XxxJpaRepository (Spring Data) + XxxRepositoryImpl (adaptador toDomain/toJpa)
    │       ├── storage/         # (solo con capa storage) adaptador del agente implementando FileStorage (skill keel-spring-s3)
    │       └── rest/
    │           ├── controllers/<agregado>/v1/  # <Agregado>V1Controller (@RequestMapping("<basePath>/v1"))
    │           ├── ApiExceptionHandler          # @RestControllerAdvice central
    │           └── ErrorResponse                # contrato de error de la API
    ├── main/resources/          # application.yaml + application-<perfil>.yaml + parameters/<perfil>/*.yaml
    └── test/java/<base>/        # solo <Nombre>ApplicationTests (contextLoads) que deja build;
                                 # reservado para la suite unitaria del proceso posterior
```

Paquete base: `<group>.<serviceNameSinGuiones>` (ej. `com.example.productcatalog`). El `group` (groupId) lo introduce el usuario en el cuestionario de `keel-spring build` (default `com.<domain>`) y queda persistido en `keel-stack.json`; en regeneraciones se reutiliza sin repreguntar.

## Qué genera el scaffolding y qué completa el agente

**Criterio de frontera**: build genera todo lo derivable mecánicamente del diseño + `keel-stack.json` cuyo código es idéntico sea cual sea la opción de infraestructura elegida (más las dependencias, la config y el compose, que sí se derivan del catálogo). El agente escribe el código cuya implementación cambia según la infraestructura (publishers/listeners del broker, adaptador de storage), guiado por las skills por tecnología `keel-spring-<tech>` (instaladas en `.claude/skills/` del proyecto según el stack), además de la lógica de negocio. Las pruebas unitarias **no** forman parte de la generación: son un proceso independiente posterior a la validación funcional (ver `mapping.md`, «Cobertura funcional»).

`keel-spring build` genera de forma determinista (re-ejecutable: solo añade archivos nuevos, `--force` sobrescribe):

- `build.gradle` (incluye springdoc) / `settings.gradle` / wrapper de Gradle / `.gitignore` / `.gitattributes` / configuración multi-ambiente (ver abajo) / infraestructura de prueba en `infra/` / test de contexto `<Nombre>ApplicationTests`.
- `application/`: contratos CQRS, por operación su record mensaje (`XxxCommand` con Bean Validation — es el body HTTP — o `XxxQuery`) y su handler stub `@ApplicationComponent` en `usecases/` con `// TODO (agente)` citando reglas, errores y políticas (inyecta el **puerto** de dominio y el mapper, nunca JPA); `XxxResponseDto` + `PagedResponse`; `<Entidad>ApplicationMapper` con mapeo campo a campo.
- `domain/`: agregados y entidades internas PUROS (sin JPA; **encapsulados**: constructor completo solo para rehidratar desde persistencia, getters con las colecciones como vista inmutable, guard **privado** `transitionTo` y TODOs guiados de factory de creación, método semántico por transición y guarda por invariante — sin setters ni constructor vacío, ver `domain-modeling.md`), enums con literal del diseño (`@JsonValue`), value objects record, eventos de dominio (`DomainEvent` + `EventMetadata` + un record por evento, y el buffer `raise`/`pullDomainEvents` en la raíz que los emite), catálogo de errores (`DomainException` con metadata `code/httpStatus/args/details`, subclases por status 400/401/403/404/409/422 y un `<PascalCode>Error` por `code` del diseño) y los puertos de repositorio.
- `infrastructure/`: mediator (`UseCaseMediator` + `UseCaseContainer` + `UseCaseAutoRegister`, auto-registro por reflexión), `LogExceptionsAspect` (implementa `@LogExceptions`, que los handlers llevan sobre `handle(...)`), entidades `XxxJpa` (extienden `AuditableEntity` — `createdAt`/`updatedAt` automáticos vía `@EnableJpaAuditing` — salvo que el diseño declare sus propios timestamps; VOs aplanados a columnas con prefijo, `naturalKey`/`indexes` en `@Table`), `XxxJpaRepository` + adaptador `XxxRepositoryImpl` con `toDomain`/`toJpa` explícitos, mensajería (`EventEnvelope` + `<Evento>IntegrationEvent` + `<Servicio>DomainEventBridge` que traduce domain→integración y entrega según la `reliability`; con `outbox`, además `OutboxEventJpa`/`OutboxRelay` y el puerto `OutboxDispatcher`; con `best-effort`, el puerto `<Evento>Publisher` — en ambos casos con un stub que solo traza para que el contexto arranque sin broker), controllers `<Agregado>V1Controller` (@Tag/@Operation de springdoc, despachan vía mediator, fusionan el id del path reconstruyendo el Command) y `ApiExceptionHandler` (validación, framework, jerarquía `DomainException`, traducción de violaciones de constraint única al error de negocio vía `CONSTRAINT_TO_ERROR` y catch-all 500).
- `infrastructure/configurations/security/` (solo con capa `security`): `SecurityConfig` con su `SecurityFilterChain` (CSRF off, sesión stateless, `authorizeHttpRequests` con un matcher por operación derivado de `access.default`/`access.rules` reutilizando las rutas de los controllers), el resource server JWT para `oidc`/`jwt` (o `ApiKeyAuthFilter` para `api-key`; `permitAll` para `none`) y, cuando el diseño usa roles/permisos, un `JwtAuthConverter` que mapea los claims del proveedor del stack (Keycloak anidado / Cognito plano) a authorities (`ROLE_`/`SCOPE_`/permiso). Autorización enteramente derivada del diseño, sin stubs.
- `domain/clients/` + `infrastructure/http/` (solo con capa `http-clients`): por cliente, el PUERTO `<Cliente>Client` con records `<Llamada>Result` en `domain/clients` (resultado en términos del dominio), y en `infrastructure/http` el `<Cliente>ClientConfig` (`RestClient` con base-url de config + timeouts + auth saliente declarada: api-key/bearer/basic como headers del bean, oauth2-client-credentials vía `OAuth2ClientHttpRequestInterceptor` + `HttpClientsOAuth2Config`; credenciales siempre por `parameters/<perfil>/http-clients.yaml`), el adaptador `<Cliente>HttpAdapter` con una llamada por call anotada con resilience4j (`@Retry`/`@CircuitBreaker` cableados al fragmento), los DTOs wire `<Llamada>Request`/`<Llamada>Response` y el mapper de anticorrupción `<Cliente>Mapper`. Con `method`/`path`/`request`/`response` estructurados en el diseño todo sale tipado y mapeado (solo los `*Fallback` quedan como `// TODO (agente)`); con `contract` solo-prosa, los records salen vacíos y el mapper como stub para que el agente los tipa. La resiliencia (timeouts/retry/circuit breaker, con 4xx nunca reintentado) es determinista siempre.
- `infrastructure/messaging/subscriptions/` (solo con capa `messaging` que declare `subscriptions`): por suscripción, el record `<Evento>Message` (payload, contrato de la fuente). El `<Evento>Listener` (binding al canal + política `onFailure` + apertura de la correlación + deduplicación + dispatch de `triggers` vía mediator) depende del broker: lo escribe el agente siguiendo la skill `keel-spring-<broker>`.
- `infrastructure/messaging/idempotency/` (con `subscriptions` + capa `persistence`): `ProcessedEventJpa` (tabla `processed_event`, PK compuesta handler+evento), su repositorio e `IdempotencyGuard` (`tryRecord` en transacción propia, purga por cron parametrizada). Es la cara simétrica del outbox: este garantiza que un evento no se pierde, aquel que reentregarlo no lo procese dos veces. El listener del agente lo **usa**; no escribe otro mecanismo.
- `infrastructure/correlation/` + `infrastructure/web/`: `CorrelationContext` (ThreadLocal + MDC, con `runWith` para los listeners) y, con capa `api`, `CorrelationFilter` (header `X-Correlation-Id`, generado si no viene y devuelto en la respuesta). De ahí salen el `correlationId` de cada `EventEnvelope`, el del `ErrorResponse` y el de cada línea de log.
- `domain/storage/` (solo con capa `storage`): puerto `FileStorage` (dominio, upload/download/delete/signedUrl) y el VO `StoredObject(storageKey, url, contentType, sizeBytes)` que devuelve `upload` — lo que el agregado guarda. El bean del cliente y el adaptador (`S3Config` + `S3FileStorage`, parametrizados por `parameters/<perfil>/storage.yaml`) los escribe el agente siguiendo la skill `keel-spring-s3`; un único adaptador sirve MinIO y S3 (mismo protocolo).

### Desacople de la capa application (mejora sobre el prototipo)

Los componentes de application NO importan Spring: se marcan con `@ApplicationComponent` (anotación propia, registrada por el `@ComponentScan` filtrado de `UseCaseConfig`) y **no llevan `@Transactional`** — la frontera transaccional la abre `UseCaseMediator` (`Query` → readOnly, `Command`/`ReturningCommand` → escritura, vía `TransactionTemplate`, solo con persistence). El prototipo dejó este desacople a medias (anotación propia pero `@Transactional` en los handlers). `@DomainComponent` queda disponible para servicios de dominio que cree el agente. Excepción pragmática documentada: `Pageable`/`Page` (Spring Data) en operaciones paginadas y puertos.

### Qué se descartó del prototipo de referencia (y por qué)

- **Paquete `shared/` y Spring Modulith**: keel genera un microservicio independiente; sus piezas transversales (mediator, errores, auditoría, envelope, logging) viven como funcionalidad del propio servicio y no hay módulos que aislar.
- **Soft-delete (`FullAuditableEntity` + `@SQLRestriction`)**: el DSL Keel no lo declara; por defecto el borrado es físico y el soft-delete es decisión del agente si el diseño lo pide. La auditoría `createdAt`/`updatedAt` SÍ se genera (global, vía `AuditableEntity`).

Nota: `@LogExceptions` en el prototipo era decorativa (sin `@Aspect`); aquí se porta **implementada** con `LogExceptionsAspect` + `spring-boot-starter-aop`.

### Configuración multi-ambiente

Cuatro perfiles Spring: `local` (default), `develop`, `production` y `test`. El perfil activo se elige con la env var `PROFILE` (`application.yaml` base declara `spring.profiles.active: ${PROFILE:local}`). Cada `application-<perfil>.yaml` solo importa fragmentos `parameters/<perfil>/*.yaml` (uno por preocupación: `logging`, `db`, broker, `redis`, `oauth2`, `storage` — solo los que el stack necesita), con gradiente de externalización:

- **local**: valores literales que coinciden con el `infra/docker-compose.yaml` de prueba; `ddl-auto: update`, `show-sql: true`.
- **develop**: env vars con default (`${DB_USERNAME:...}`); `show-sql: false`.
- **production**: env vars obligatorias sin default (`${DB_USERNAME}`); `ddl-auto: validate`, `logging root: WARN`.
- **test**: H2 en memoria; `src/test/resources/application.yaml` lo activa para los tests.

Regla general: **nada de valores quemados** salvo lo que es decisión de arquitectura y no de ambiente (`ddl-auto`, `show-sql`, `open-in-view`, serializers del broker, instancias `resilience4j` derivadas del diseño). El resto sale por env var, incluidos `server.port` (`${SERVER_PORT:8080}` en el `application.yaml` base) y los niveles de log (`LOG_LEVEL_ROOT` / `LOG_LEVEL_APP`). Tres excepciones al gradiente:

- **Valores operativos no sensibles** (niveles de log, `KAFKA_GROUP_ID`): env var **con default en todos los perfiles**, porque su ausencia no debe impedir el arranque.
- **Claves de API** (`security.api-key`, `security.api-keys.<cliente>`): literal solo en local; en develop y production son env vars **obligatorias** (fail-closed: sin la variable la app no arranca, en vez de quedar con la clave de desarrollo).
- **`base-url` de http-clients**: el DSL no declara URLs (son infraestructura), así que en local va un literal con TODO y fuera de local la env var es obligatoria — un default tipo `localhost:8080` haría que el servicio se llamase a sí mismo en silencio.

Las credenciales del perfil `local` son deliberadamente de juguete y coinciden con la infra de prueba (`local-dev-api-key`, `local-<cliente>-key`, `minioadmin`…): existen para que los escenarios de validación autentiquen sin editar YAML a mano y nunca salen de local.

### Validación de infraestructura (contenedor `devtools`)

Cuando el compose levanta contenedores sondeables, el scaffolding añade el servicio `devtools`: una caja de herramientas Alpine (`infra/docker/Dockerfile.devtools`) que instala **solo** las CLIs del stack elegido (`psql`/`mysql`/`mariadb`/`sqlcmd`, `kcat`, `redis-cli`, `mc`, `aws`, más `curl`/`jq`). Queda viva con `sleep infinity` y sin puertos: es un objetivo interno de `docker exec`, alcanza a los servicios de respaldo por su nombre de red (`db`, `kafka`/`localstack`, `redis`/`valkey`, `minio`, `keycloak`/`cognito`).

El script generado `infra/validate-infra.sh` corre un check por tecnología (`docker exec <servicio>-devtools <cliValidateCmd>`, o dentro del propio contenedor para Oracle) y sale con código `!= 0` si alguno falla. Lo usa el agente `keel-spring-infra` de la orquestación, tras `docker compose -f infra/docker-compose.yaml up -d` (o `podman compose`, respetando `CONTAINER_RUNTIME`) y antes de que se ejerciten los escenarios, para confirmar que la infraestructura responde. Detalle por tecnología en `conventions/infra-validation.md`.

El agente de código de la orquestación (`keel-spring-code`, lanzado por `/keel-generate-spring`) completa, guiado por las skills `keel-spring-<tech>` instaladas según `keel-stack.json`: lógica de negocio de los stubs, invariantes y campos `computed`; de `messaging`, el `raise(...)` de cada evento en el método de negocio del agregado, la implementación del puerto de salida (`OutboxDispatcher` con outbox, `<Evento>Publisher` con best-effort — sustituyendo su stub), la config del broker si aplica y los `<Evento>Listener` (binding, retry/DLQ, dispatch de `triggers`); de `storage`, el bean del cliente y el adaptador completo de `FileStorage` (incluida la validación de content-type/tamaño según los `buckets` y las URLs prefirmadas); los `fallback` de http-clients (y el tipado de records/mapper solo si el diseño va en prosa sin `request`/`response` estructurados); las políticas `cache`/`idempotency` sobre Redis/Valkey, y migraciones/esquema definitivo (sin pruebas unitarias: su gate es `./gradlew build -x test` y el 100% de los escenarios `FL-*`). Las capas `security` y `http-clients` (puerto + adaptador + ACL + auth saliente) ya salen generadas (ver arriba).

## Reglas de la estructura

- `domain` no depende de JPA ni de infraestructura: POJOs, records y errores puros (`Page`/`Pageable` en los puertos se acepta como pragmatismo, igual que el prototipo).
- `application` orquesta: cada handler valida precondiciones, aplica rules en el orden del spec, persiste **a través del puerto**. No publica eventos: los emite el agregado con `raise(...)` y el adaptador los drena al persistir (`domain-modeling.md`). Un handler no invoca a otro handler directamente; si necesita otro caso de uso, despacha su mensaje vía `UseCaseMediator`.
- `infrastructure/rest` solo traduce: construye/fusiona el mensaje desde los parámetros HTTP, lo despacha vía `UseCaseMediator` y deja los errores al `ApiExceptionHandler`. Sin lógica de negocio.
- El mapeo domain↔JPA vive únicamente en los `XxxRepositoryImpl`; ni los handlers ni los controllers ven una clase `Jpa`.
- Lo operativo que el scaffolding no produce (Dockerfile de la app, CI) puede añadirse a mano al repo generado y sobrevive regeneraciones.
