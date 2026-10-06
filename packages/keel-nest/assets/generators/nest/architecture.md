# Arquitectura del proyecto

Un único microservicio hexagonal + CQRS, **la misma arquitectura que el servidor de keel-spring del
mismo diseño**, traducida a NestJS 12 sobre Fastify, TypeScript `strict` en ESM y TypeORM 1.x. El
sentido de las dependencias es siempre hacia adentro: `infrastructure` depende de `application` y
`domain`; `application` depende de `domain`; `domain` no depende de nada del proyecto. Y no es solo una
regla escrita: `npm run check:architecture` (dependency-cruiser) la comprueba sobre los imports.

```
src/
├── domain/              # el negocio — TypeScript puro: SIN @nestjs/*, typeorm ni ningún paquete
│   ├── aggregate/       # raíces de agregado: rehidratación desde <Raíz>State + transitionTo + invariantes
│   ├── entity/          # entidades internas de agregado (puras)
│   ├── enums/           # enums del diseño (el valor del cable es el del diseño)
│   ├── valueobject/     # value objects con sus guardas en el constructor + <Tipo>Format
│   ├── events/          # eventos de dominio y EventMetadata
│   ├── errors/          # DomainException + subclases por status + <PascalCode>Error por code
│   ├── repository/      # PUERTOS: <Raíz>Repository (clases abstractas: sirven de token de DI) + Page
│   ├── identity/        # Uuids.v7(): los ids de una raíz
│   └── support/         # Decimal (escala de BigDecimal), RawJson, valueEquals
├── application/         # orquesta casos de uso — SIN imports de Nest
│   ├── interfaces/      # Command, Query<R>, ReturningCommand<R> y sus handlers
│   ├── annotations/     # @ApplicationComponent + @Handles(<Mensaje>) (solo metadatos propios)
│   ├── commands/        # <Op>Command
│   ├── queries/         # <Op>Query
│   ├── usecases/        # <Op>CommandHandler / <Op>QueryHandler
│   ├── dtos/            # <Op>ResponseDto + PagedResponse<T>
│   ├── mappers/         # <Raíz>ApplicationMapper (dominio → ResponseDto)
│   └── support/         # wire.ts (el contrato del cable) + todo()
├── migrations/          # migraciones de TypeORM (el baseline lo exporta el pase de calidad)
└── infrastructure/      # adaptadores — el único sitio que conoce Nest, Fastify y TypeORM
    ├── usecase/         # UseCaseMediator (frontera transaccional) + UseCaseContainer + UseCaseModule
    ├── persistence/     # entidades TypeORM, <Raíz>RepositoryImpl (toDomain/toOrm), DataSource,
    │                    #   TransactionContext (AsyncLocalStorage), traducción de errores del motor
    ├── rest/            # controladores por grupo y versión, lector de cada petición, ErrorResponse,
    │                    #   ApiExceptionFilter, routes.ts
    ├── config/          # configuración por perfiles, validada al arrancar
    ├── correlation/     # X-Correlation-Id en AsyncLocalStorage
    ├── health/          # /livez /readyz y el drenaje del apagado
    └── http/            # la plataforma Fastify: lector y serializador JSON del contrato del cable
```

## Qué hace cada capa

- **`domain`**: el negocio en estado puro. Agregados **encapsulados** (campos `#privados`, sin
  setters): se rehidratan desde persistencia con un objeto `<Raíz>State`, se crean con un factory
  estático que aplica los invariantes, y se mutan por métodos de negocio apoyados en el guard privado
  `transitionTo`. Value objects con sus guardas en el constructor, el catálogo de errores
  (`DomainException`) y los **puertos** de repositorio. Solo puede importar `decimal.js`, que sostiene
  el `Decimal` con escala, y módulos `node:`.
- **`application`**: orquesta los casos de uso. Cada handler (`@ApplicationComponent()` +
  `@Handles(<Mensaje>)`) valida precondiciones, aplica reglas en el orden del diseño y persiste **a
  través del puerto** de dominio. No importa Nest: sus dependencias se declaran en `static readonly
  inject = [...]` y las cablea `infrastructure/usecase/use-case-module.ts`. No abre transacciones:
  la abre `UseCaseMediator`.
- **`infrastructure`**: implementa los puertos y conecta con el mundo exterior.
  - `usecase` (`UseCaseMediator`): resuelve el handler de cada mensaje y abre la transacción —de solo
    lectura para una `Query`, de escritura para un `Command`/`ReturningCommand`—; los repositorios se
    unen a ella por `TransactionContext` (AsyncLocalStorage) sin que el handler la vea. Una escritura
    que pierde un interbloqueo se reintenta entera; agotada, sale como 409 de concurrencia.
  - `persistence`: el **único** lugar donde existe el mapeo dominio ↔ TypeORM (`toDomain`/`toOrm`
    explícitos en `<Raíz>RepositoryImpl`); ni los handlers ni los controladores ven una entidad ORM.
    El bloqueo optimista es un UPDATE condicionado por la versión (TypeORM no la comprueba).
  - `rest`: controladores que **solo traducen** —el lector generado convierte y valida la petición,
    el controlador construye el mensaje y lo despacha por el mediator— y `ApiExceptionFilter`, que
    traduce la jerarquía de dominio y las violaciones de constraint a `ErrorResponse`. Cero lógica.
  - `http`: Fastify lee y escribe JSON con el **contrato del cable** (`application/support/wire.ts`):
    un decimal conserva su escala (`2.50` sale `2.50`), un `long` sus 64 bits, un instante sale con
    tres decimales y `Z`.

## Por qué la inyección es explícita

Todo lo de `infrastructure` inyecta con `@Inject(<token>)` y la capa `application` declara sus
dependencias en `static readonly inject`: el arranque no depende de `emitDecoratorMetadata`, que
depende de qué herramienta transforme el TypeScript (tsc al compilar, Vitest en las pruebas). Un
handler sin `@Handles`, o dos handlers para el mismo mensaje, hacen que el contenedor **se niegue a
arrancar**.

## Equivalencia con keel-spring

Rutas, status, `ErrorResponse`, `code` de error, paginación, forma del JSON, tablas, columnas,
nombres de constraint, índices y FK son los **mismos** que los del servidor de keel-spring del mismo
diseño: los decide `keel-core/gen` y los dos generadores los realizan. Por eso un escenario `FL-*`
tiene que pasar igual contra los dos servidores, y por eso nada de eso se cambia aquí "porque en Node
se hace de otra forma".

Detalle de stack y configuración: `conventions/project-layout.md`. Mapeo diseño → código capa por
capa: `conventions/mapping.md`. El interior del dominio: `conventions/domain-modeling.md`. Reglas que
esta arquitectura nunca puede romper: `constitution.md`.
