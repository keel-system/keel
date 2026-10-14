# Arquitectura del proyecto

Un único microservicio hexagonal + CQRS, **la misma arquitectura que los servidores de keel-spring y keel-nest
del mismo diseño**, traducida a .NET 10 (C# 14, ASP.NET Core con APIs mínimas, EF Core 10). El sentido de las
dependencias es siempre hacia adentro, y aquí no es una regla escrita que alguien revisa: **cada capa es un
proyecto**, y un proyecto solo ve a los que referencia. Un `using` de ASP.NET Core o de EF Core en el dominio no
compila.

```
<Servicio>.slnx
src/
├── <Raíz>.Domain/            # el negocio — C# puro, SIN paquetes NuGet ni referencias
│   ├── Aggregate/            # raíces de agregado: rehidratación desde <Raíz>State + TransitionTo + invariantes
│   ├── Entity/               # entidades internas de agregado (puras)
│   ├── Enums/                # enums del diseño ([JsonStringEnumMemberName]: el valor del cable es el del diseño)
│   ├── ValueObject/          # value objects con sus guardas en el constructor + <Tipo>Format
│   ├── Events/               # eventos de dominio
│   ├── Errors/               # DomainException + subclases por status + <PascalCode>Error por code
│   ├── Repository/           # PUERTOS: I<Raíz>Repository + Page/Pageable
│   └── Support/              # Decimals (escala explícita), ValueEquality
├── <Raíz>.Application/       # → Domain. Orquesta los casos de uso, SIN ASP.NET Core ni EF Core
│   ├── Abstractions/         # ICommand, IQuery<R>, IReturningCommand<R>, sus handlers, IUseCaseMediator
│   ├── Commands/             # <Op>Command
│   ├── Queries/              # <Op>Query
│   ├── UseCases/             # <Op>CommandHandler / <Op>QueryHandler
│   ├── Dtos/                 # <Op>ResponseDto (records) + PagedResponse<T>
│   ├── Mappers/              # <Raíz>ApplicationMapper (dominio → ResponseDto)
│   └── Support/              # WireJson + conversores: el contrato del cable; Optional<T>; Todo
├── <Raíz>.Infrastructure/    # → Application. Los adaptadores: el único sitio que conoce EF Core y Npgsql
│   ├── UseCase/              # UseCaseMediator (frontera transaccional) + UseCaseRegistration (el cableado)
│   ├── Persistence/          # DbContext, Rows/ (filas + mapeo fluente), Repositories/ (adaptadores),
│   │                         #   PersistenceTransactions, PersistenceErrors (traducción de constraints), RowSync
│   ├── Config/               # ServiceConfiguration: configuración por perfiles, validada al arrancar
│   ├── Correlation/          # X-Correlation-Id en AsyncLocal
│   └── Health/               # /livez /readyz y el drenaje del apagado
└── <Raíz>.Api/               # → Infrastructure. Program.cs, ApiRoutes (un solo mapa de rutas), Endpoints/, Rest/
tests/
├── <Raíz>.UnitTests/         # → Api. Las pruebas que dejó build: bajo el perfil test, sin infraestructura
└── <Raíz>.IntegrationTests/  # los flujos FL-*: caja negra, NO ve ningún proyecto del servicio
```

## Qué hace cada capa

- **Domain**: el negocio en estado puro. Agregados **encapsulados** (propiedades con `private set`, sin
  setters públicos): se rehidratan desde persistencia con un `<Raíz>State` de propiedades `required`, se crean
  con un factory estático que aplica los invariantes, y se mutan por métodos de negocio apoyados en la guarda
  privada `TransitionTo`. Value objects con sus guardas en el constructor, el catálogo de errores
  (`DomainException`) y los **puertos** de repositorio. No referencia nada: ni un paquete NuGet.
- **Application**: orquesta los casos de uso. Cada handler implementa `IQueryHandler<TQuery, TResult>`,
  `ICommandHandler<TCommand>` o `IReturningCommandHandler<TCommand, TResult>`; valida precondiciones, aplica las
  reglas en el orden del diseño y persiste **a través del puerto** de dominio. Sus dependencias llegan por el
  constructor primario y las registra `Infrastructure/UseCase/UseCaseRegistration.cs`, que es GENERADO: un
  handler que no está ahí no se resuelve. No abre transacciones: la abre `UseCaseMediator`.
- **Infrastructure**: implementa los puertos y conecta con el mundo exterior.
  - `UseCase` (`UseCaseMediator`): resuelve el handler de cada mensaje y abre la transacción por
    `IUseCaseTransactions` —de solo lectura para una `IQuery`, de escritura para un comando—; los adaptadores
    se unen a ella porque el `DbContext` es del ámbito (`scope`) de la petición. Un interbloqueo se reintenta
    entero; agotado, sale como 409 de concurrencia.
  - `Persistence`: el **único** lugar donde existe el mapeo dominio ↔ fila (`ToDomain`/`Apply` explícitos en
    `<Raíz>Repository`, sin AutoMapper). Ni los handlers ni los endpoints ven una fila ni el `DbContext`. El
    bloqueo optimista lo comprueba EF: la versión leída es el valor original del token de concurrencia.
- **Api**: `Program.cs` arranca, `ApiRoutes` registra las rutas del diseño y cada `<Grupo>V1Endpoints` **solo
  traduce** —su lector generado convierte y valida la petición, construye el mensaje y lo despacha por el
  mediator—. `ApiErrorMiddleware` traduce la jerarquía de dominio y las violaciones de constraint a
  `ErrorResponse`. Cero lógica. Todo cuerpo JSON pasa por las opciones de `WireJson` (el **contrato del cable**):
  un decimal conserva su escala (`2.50` sale `2.50`), un `long` sus 64 bits, un instante sale con tres
  decimales y `Z`.

## Por qué el mediator es propio

No hay MediatR (licencia comercial desde la 13) ni AutoMapper (desde la 15): el mediator es una clase
generada que cierra los genéricos con un envoltorio por tipo de mensaje, y el registro de handlers es explícito.
Un mensaje sin handler registrado, o con dos, falla al construir el contenedor (`ValidateOnBuild`), no en la
primera petición.

## Equivalencia con keel-spring y keel-nest

Rutas, status, `ErrorResponse`, `code` de error, paginación, forma del JSON, tablas, columnas, nombres de
constraint, índices y FK son los **mismos** que los de los servidores de keel-spring y keel-nest del mismo
diseño: los decide `keel-core/gen` y los tres generadores los realizan. Por eso un escenario `FL-*` tiene que
pasar igual contra los tres, y por eso nada de eso se cambia aquí "porque en .NET se hace de otra forma".

Detalle de stack y comandos: `conventions/project-layout.md`. Mapeo diseño → código capa por capa:
`conventions/mapping.md`. El interior del dominio: `conventions/domain-modeling.md`. Reglas que esta
arquitectura nunca puede romper: `constitution.md`.
