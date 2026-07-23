# Arquitectura del proyecto

Un único microservicio hexagonal + CQRS (arquitectura del prototipo de referencia): sin paquete `shared/` (lo transversal se absorbe en el propio árbol) y sin Spring Modulith (los límites entre módulos no aplican a un servicio solo). El sentido de las dependencias es siempre hacia adentro: `infrastructure` depende de `application` y `domain`; `application` depende de `domain`; `domain` no depende de nada del proyecto.

```
src/main/java/<base>/
├── application/         # orquesta casos de uso — SIN imports de Spring
│   ├── interfaces/      # contratos CQRS: Command, Query<R>, ReturningCommand<R>, *Handler
│   ├── annotations/     # @ApplicationComponent + @LogExceptions + LogLevel (anotaciones propias)
│   ├── commands/        # XxxCommand records (Bean Validation: son el body HTTP)
│   ├── queries/         # XxxQuery records
│   ├── usecases/        # XxxCommandHandler / XxxQueryHandler (@ApplicationComponent)
│   ├── dtos/            # XxxResponseDto + PagedResponse<T>
│   └── mappers/         # <Entidad>ApplicationMapper (dominio → ResponseDto)
├── domain/              # el negocio — puro, sin JPA ni ningún framework
│   ├── aggregate/       # raíces de agregado: ctor completo + transitionTo + invariantes
│   ├── entity/          # entidades internas de agregado (puras)
│   ├── annotations/     # @DomainComponent (para servicios de dominio del agente)
│   ├── enums/            # enums del diseño (@JsonValue)
│   ├── valueobject/     # records VO puros
│   ├── events/          # records de evento + PUERTOS <Evento>Publisher
│   ├── errors/          # DomainException + subclases por status + <PascalCode>Error por code
│   ├── repository/      # PUERTOS: <Entidad>Repository (interfaces)
│   ├── clients/         # (solo con capa http-clients) PUERTOS <Cliente>Client + records <Llamada>Result
│   └── storage/         # (solo con capa storage) PUERTO FileStorage
└── infrastructure/      # adaptadores — habla con el mundo exterior
    ├── configurations/usecase/  # UseCaseMediator (frontera transaccional) + Container + AutoRegister
    ├── scheduling/      # <X>Scheduler (@Scheduled), despacha vía mediator
    ├── configurations/logging/  # LogExceptionsAspect
    ├── messaging/       # EventEnvelope + EventMetadata + <Evento>PublisherStub (+ Listener del broker)
    ├── persistence/
    │   ├── entities/    # AuditableEntity + XxxJpa (@Entity; VOs aplanados a columnas con prefijo)
    │   └── repositories/ # XxxJpaRepository (Spring Data) + XxxRepositoryImpl (adaptador toDomain/toJpa)
    ├── storage/         # (solo con capa storage) adaptador FileStorage (S3/MinIO)
    ├── http/            # (solo con capa http-clients) adaptadores RestClient + resilience4j + auth saliente + DTOs wire + mapper ACL
    ├── configurations/security/ # (solo con capa security) SecurityFilterChain + JwtAuthConverter
    └── rest/
        ├── controllers/<agregado>/v1/  # <Agregado>V1Controller
        ├── ApiExceptionHandler          # @RestControllerAdvice central
        └── ErrorResponse                # contrato de error de la API
```

## Qué hace cada paquete

- **`domain`**: el negocio en estado puro. Agregados y entidades con constructor completo y guardas de invariante/transición (`transitionTo`), value objects, enums, eventos de dominio (records) y sus **puertos** de publicación, catálogo de errores (`DomainException`), y **puertos** de repositorio, clientes HTTP salientes (`<Cliente>Client` + `<Llamada>Result`) y storage. No importa Spring, JPA ni ningún detalle de infraestructura: se podría testear y compilar sin el resto del proyecto.
- **`application`**: orquesta los casos de uso. Cada handler (`@ApplicationComponent`, sin `@Transactional`) valida precondiciones, aplica reglas en el orden del diseño, persiste **a través del puerto** de dominio (nunca una clase `Jpa`) y publica eventos vía el puerto `<Evento>Publisher` tras confirmar la transacción. Tampoco importa Spring: la frontera transaccional la abre `UseCaseMediator` desde infraestructura.
- **`infrastructure`**: implementa los puertos y conecta con el mundo exterior — persistencia (JPA), mensajería (broker), HTTP saliente, storage de archivos, seguridad y la capa REST entrante. Es la única capa que conoce el framework y las tecnologías concretas del stack.
  - `configurations/usecase` (`UseCaseMediator`): abre la transacción (readOnly para `Query`, de escritura para `Command`/`ReturningCommand`) y despacha al handler correspondiente; es el único punto por el que pasa una operación.
  - `persistence`: el único lugar donde existe el mapeo domain↔JPA (`toDomain`/`toJpa` explícitos en `XxxRepositoryImpl`); ni los handlers ni los controllers ven una clase `Jpa`.
  - `messaging`: publishers/listeners del broker elegido — la implementación concreta la escribe el agente siguiendo la skill `keel-spring-<broker>`.
  - `storage`: adaptador del puerto `FileStorage` (S3/MinIO) — lo escribe el agente siguiendo `keel-spring-s3`.
  - `http`: adaptadores `<Cliente>HttpAdapter` de los puertos `domain/clients`, con los DTOs wire del contrato del tercero y el mapper de **anticorrupción** `<Cliente>Mapper` (wire ↔ dominio): si el sistema externo cambia su contrato, el cambio se absorbe aquí, nunca en dominio ni application.
  - `rest`: controllers que **solo traducen** (construyen/fusionan el mensaje desde los parámetros HTTP, despachan vía mediator) y `ApiExceptionHandler` que traduce la jerarquía de dominio a `ErrorResponse`. Cero lógica de negocio.
  - `configurations/security`: `SecurityFilterChain` y conversión de claims a authorities, derivado enteramente de `security.keel.yaml`.

Detalle completo de stack, dependencias y configuración por perfiles: `conventions/project-layout.md`. Mapeo diseño → código capa por capa: `conventions/mapping.md`. Reglas que esta arquitectura nunca puede romper: `constitution.md`.
