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
│   ├── events/          # DomainEvent + EventMetadata + records de evento (+ PUERTOS <Evento>Publisher si best-effort)
│   ├── errors/          # DomainException + subclases por status + <PascalCode>Error por code
│   ├── repository/      # PUERTOS: <Entidad>Repository (interfaces)
│   ├── clients/         # (solo con capa http-clients) PUERTOS <Cliente>Client + records <Llamada>Result
│   └── storage/         # (solo con capa storage) PUERTO FileStorage
└── infrastructure/      # adaptadores — habla con el mundo exterior
    ├── configurations/usecase/  # UseCaseMediator (frontera transaccional) + Container + AutoRegister
    ├── scheduling/      # <X>Scheduler (@Scheduled), despacha vía mediator
    ├── configurations/logging/  # LogExceptionsAspect
    ├── messaging/       # EventEnvelope + <Servicio>DomainEventBridge (domain → integración)
    │   ├── events/      # <Evento>IntegrationEvent (gemelos de wire)
    │   └── outbox/      # (solo reliability: outbox) OutboxEventJpa + relay + PUERTO OutboxDispatcher
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

- **`domain`**: el negocio en estado puro. Agregados y entidades **encapsulados** (sin setters: se crean por un factory que aplica los invariantes, se rehidratan desde persistencia con el constructor completo y se mutan por métodos de negocio apoyados en el guard privado `transitionTo`), value objects, enums, eventos de dominio (records `implements DomainEvent`, que los agregados acumulan y sueltan por `pullDomainEvents()`) y sus **puertos** de publicación, catálogo de errores (`DomainException`), y **puertos** de repositorio, clientes HTTP salientes (`<Cliente>Client` + `<Llamada>Result`) y storage. No importa Spring, JPA ni ningún detalle de infraestructura: se podría testear y compilar sin el resto del proyecto.
- **`application`**: orquesta los casos de uso. Cada handler (`@ApplicationComponent`, sin `@Transactional`) valida precondiciones, aplica reglas en el orden del diseño, y persiste **a través del puerto** de dominio (nunca una clase `Jpa`). **No publica eventos**: los emite el agregado con `raise(...)` y el adaptador de repositorio los drena al persistir. Tampoco importa Spring: la frontera transaccional la abre `UseCaseMediator` desde infraestructura.
- **`infrastructure`**: implementa los puertos y conecta con el mundo exterior — persistencia (JPA), mensajería (broker), HTTP saliente, storage de archivos, seguridad y la capa REST entrante. Es la única capa que conoce el framework y las tecnologías concretas del stack.
  - `configurations/usecase` (`UseCaseMediator`): abre la transacción (readOnly para `Query`, de escritura para `Command`/`ReturningCommand`) y despacha al handler correspondiente; es el único punto por el que pasa una operación.
  - `persistence`: el único lugar donde existe el mapeo domain↔JPA (`toDomain`/`toJpa` explícitos en `XxxRepositoryImpl`); ni los handlers ni los controllers ven una clase `Jpa`.
  - `messaging`: el `<Servicio>DomainEventBridge` traduce cada evento de dominio a su `<Evento>IntegrationEvent` y lo entrega según la `reliability` del diseño (fila de `outbox` en la misma transacción, o publicación tras el commit). Lo único acoplado al broker es el envío —`OutboxDispatcher` o `<Evento>Publisher`— y los listeners: los escribe el agente siguiendo la skill `keel-spring-<broker>`.
  - `storage`: adaptador del puerto `FileStorage` (S3/MinIO) — lo escribe el agente siguiendo `keel-spring-s3`.
  - `http`: adaptadores `<Cliente>HttpAdapter` de los puertos `domain/clients`, con los DTOs wire del contrato del tercero y el mapper de **anticorrupción** `<Cliente>Mapper` (wire ↔ dominio): si el sistema externo cambia su contrato, el cambio se absorbe aquí, nunca en dominio ni application.
  - `rest`: controllers que **solo traducen** (construyen/fusionan el mensaje desde los parámetros HTTP, despachan vía mediator) y `ApiExceptionHandler` que traduce la jerarquía de dominio a `ErrorResponse`. Cero lógica de negocio.
  - `configurations/security`: `SecurityFilterChain` y conversión de claims a authorities, derivado enteramente de `security.keel.yaml`.

## Forma del mensaje publicado

Lo que sale al broker no es el evento de dominio ni el payload a secas: es la **envoltura estándar de Keel**, `EventEnvelope<T>` (`infrastructure/messaging`), con dos claves de primer nivel. La `metadata` es transversal —idéntica para todos los eventos, no se declara en el diseño— y el payload del evento va en `data`:

```json
{
  "metadata": {
    "eventId": "9f1c3b6e-2d4a-4a91-b0f2-5c7d8e0a1b23",
    "eventType": "ProductCreated",
    "eventVersion": 1,
    "occurredAt": "2026-03-14T09:21:07.482Z",
    "source": "product-service",
    "correlationId": "1f7b0a52-33c9-4a1e-9a44-6c0f2b8d55e1"
  },
  "data": {
    "productId": "3d2e1f00-8a44-4c9b-9f01-77b6c2d4e5a9",
    "sku": "SKU-10493"
  }
}
```

| Campo | Tipo Java | Origen | Descripción |
|---|---|---|---|
| `metadata.eventId` | `String` (UUID) | `EventMetadata.now(...)`, en el `raise` del agregado | Id único de esta ocurrencia. Es la **clave de idempotencia** del consumidor: se estampa una vez y no se regenera aguas abajo, así que una reentrega repite el mismo valor. |
| `metadata.eventType` | `String` | `EventMetadata.now("<Evento>")` — nombre del evento en el diseño | Tipo lógico del evento. Discriminador cuando un canal transporta varios tipos. |
| `metadata.eventVersion` | `int` | `EventMetadata.now(...)`, fijo a `1` | Versión del contrato de `data`. Se sube a mano al romper compatibilidad del payload. |
| `metadata.occurredAt` | `Instant` | `Instant.now()` en el `raise` | Instante en que **ocurrió el hecho** en el dominio, no el del envío: con `reliability: outbox` el relay entrega después y los dos instantes difieren. |
| `metadata.source` | `String` | `service.name` del diseño, horneado en `EventMetadata.now(...)` | Servicio emisor. |
| `metadata.correlationId` | `String` (nullable) | `CorrelationContext.get()` en el `<Servicio>DomainEventBridge`, vía `EventEnvelope.of(...)` | Correlación del request que originó el hecho — la misma que estampa `CorrelationFilter` (`X-Correlation-Id`), el `ErrorResponse` y cada línea de log. `null` si el hecho no nació de una petición (un `@Scheduled`, por ejemplo). |
| `data` | `<Evento>IntegrationEvent` | El bridge, desde el evento de dominio | Gemelo de wire del evento: los campos del `payload` declarado en `messaging.keel.yaml`. Su componente `metadata` es `@JsonIgnore` — la metadata autoritativa es la del envelope y no se duplica en el cable. |

La metadata **no se regenera** en ningún punto de la cadena: nace en el `raise` dentro del agregado y el bridge solo le añade el `correlationId`, que el dominio no puede conocer (regla en `constitution.md`). Por eso el `eventId` sirve de clave de deduplicación extremo a extremo, y por eso el `IdempotencyGuard` del lado consumidor cae por defecto en `envelope.metadata().eventId()`.

Fuera del cuerpo del mensaje viajan los **atributos de transporte**, que no forman parte del contrato de datos: el destino y la routing key (`@Value` sobre `parameters/<perfil>/messaging.yaml`, nunca hardcodeados) y el header de tipo que cada broker añade al publicar. Cómo se materializan depende del stack: `.claude/skills/keel-spring-<broker>/`.

Esta envoltura es **contrato del DSL, no del generador**: la definición canónica está en `docs/dsl/messaging.md § La envoltura Keel` del workspace, y es lo que asume `contract.envelope: keel` de una suscripción. Aquí solo se documenta su realización en Java; un generador de otra tecnología debe emitir exactamente la misma forma.

Detalle completo de stack, dependencias y configuración por perfiles: `conventions/project-layout.md`. Mapeo diseño → código capa por capa: `conventions/mapping.md`. Cómo se modela el interior del dominio (agregados ricos, invariantes, value objects y reparto de la validación): `conventions/domain-modeling.md`. Reglas que esta arquitectura nunca puede romper: `constitution.md`.
