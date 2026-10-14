# Mapeo diseño Keel → código .NET

Qué produce cada construcción del diseño y qué queda para el agente. Se sigue **estrictamente**: lo que aquí se
fija es lo que hace que este servidor sea equivalente a los de keel-spring y keel-nest del mismo diseño. Las capas
que keel-dotnet aún no genera las rechaza `keel-dotnet build`: si estás aquí, el diseño no las declara. Y lo que
acepta con un **aviso** no se escribe a mano: el aviso es la frontera del generador, no una invitación.

## `domain` — domain.keel.yaml

| Diseño | Código | Quién |
|---|---|---|
| `types.T` con `fields` | `Domain/ValueObject/<T>.cs`: clase sellada con sus guardas en el constructor, `IEquatable` | build |
| `types.T` escalar con `pattern` | se aplana a `string` + `Domain/ValueObject/<T>Format.cs` (`<T>Format.Validate`) | build la clase; **la llamada, el agente** |
| `enums.E` | `Domain/Enums/<E>.cs`; el valor del cable es el del diseño (`[JsonStringEnumMemberName]`) | build |
| entidad raíz | `Domain/Aggregate/<Raíz>.cs`: `<Raíz>State`, constructor de rehidratación, `TransitionTo`, propiedades | build; factory y métodos semánticos, el agente |
| entidad interna | `Domain/Entity/<Entidad>.cs` | build |
| `lifecycle` | el mapa `Transitions` y `TransitionTo` | build; un método semántico por transición, el agente |
| `invariants` | un `TODO invariante` por cada uno | **el agente** escribe la guarda |
| `errors` (en `use-cases`) | `Domain/Errors/<PascalCode>Error.cs` con su `code` y status | build |

### Tipos base

| DSL | C# | Cable |
|---|---|---|
| `string`, `text` | `string` | texto |
| `uuid` | `Guid` | texto (UUID en minúsculas) |
| `int` | `int` | número |
| `long` | `long` | número **sin perder dígitos** |
| `decimal` | `decimal` | número **con su escala** (`2.50`, nunca `2.5`) |
| `boolean` | `bool` | booleano |
| `date` | `DateOnly` | texto `YYYY-MM-DD` |
| `timestamp` | `DateTimeOffset` | ISO-8601 UTC con **tres** decimales y `Z` |
| `json` | `JsonElement` | el JSON tal cual |

Las opciones de `WireJson` (`Application/Support`) ya escriben cada tipo así, y ASP.NET Core las usa para todo
cuerpo: no conviertas a `double` ni a `string` "para que salga bien" en un mapper, ni serialices con otras
opciones.

## `use-cases` — use-cases.keel.yaml

| Diseño | Código |
|---|---|
| operación `command` sin `output` | `Application/Commands/<Op>Command.cs` (`ICommand`) + `<Op>CommandHandler : ICommandHandler<…>` |
| operación `command` con `output` | `IReturningCommand<<Op>ResponseDto>` + `IReturningCommandHandler<…, <Op>ResponseDto>` |
| operación `query` | `Application/Queries/<Op>Query.cs` + `<Op>QueryHandler : IQueryHandler<…>` |
| `input` | las propiedades `required` del mensaje, ya convertidas y validadas por el lector de la petición |
| `output` | `Application/Dtos/<Op>ResponseDto.cs` (record) + su método `To<Op>ResponseDto` en `<Raíz>ApplicationMapper` |
| `output` paginado | `PagedResponse<<Op>ResponseDto>`; el mensaje trae `Pageable` |
| `preconditions`, `rules`, `errors`, `transitions` | notas `// TODO (agente)` en el handler, **en el orden del diseño** |

### Cómo se escribe un handler

```csharp
public async Task<CreateProductResponseDto> Handle(CreateProductCommand command, CancellationToken cancellationToken)
{
    // Regla (en orden): el sku no existe antes de crear.
    if (await productRepository.FindBySku(command.Sku, cancellationToken) is not null)
    {
        throw new SkuAlreadyExistsError($"Ya existe un producto con el sku {command.Sku}");
    }
    var product = Product.Create(command.Sku, command.Name, command.Notes, command.Price);
    var saved = await productRepository.Save(product, cancellationToken);
    return productApplicationMapper.ToCreateProductResponseDto(saved);
}
```

- El handler nace como `public Task<…> Handle(…)` que lanza `NotImplementedException`: al escribir la lógica
  pasa a `public async Task<…>`.
- La transacción ya está abierta por el mediator: el handler no abre ni confirma nada.
- Lo que el handler necesita llega por su **constructor primario** (lo deja build con los puertos y el mapper que
  el diseño implica). Una dependencia más (otro puerto, otro mapper) se añade como parámetro del constructor: el
  contenedor la resuelve si está registrada. Un servicio nuevo que no lo esté es una decisión del generador:
  `blockers`.
- Una consulta paginada: `var page = await repo.List(query.Pageable, cancellationToken);` y
  `new PagedResponse<…> { Items = [.. page.Items.Select(mapper.To…)], Page = page.Number, Size = page.Size,
  TotalElements = page.TotalElements, TotalPages = page.TotalPages }`.
- Un `Todo.Value<T>(...)` en un mapper es un campo que build no supo derivar del dominio: complétalo; no lo dejes
  devolviendo un valor inventado.
- Un opcional de PATCH es `Optional<T>`: `IsPresent` dice si vino (y entonces `Value` puede ser `null`, que es vaciar); ausente no toca el campo.

### El formato se valida en la entrada

El `pattern` de un value type se valida **ya en el lector de la petición** (`<Raíz>.Api/Endpoints`), lo herede el
campo de su tipo o lo declare él: un valor mal formado es un 400 `VALIDATION_ERROR` **antes** que cualquier
precondición o error de negocio, igual que en los otros dos servidores del mismo diseño. No lo vuelvas a validar
al principio del handler.

El dominio lo **repite** (`<Tipo>Format.Validate(...)` en el factory o el método de negocio que recibe el valor, o
el constructor del value object compuesto), porque un evento o una operación interna no pasan por el lector. Esa
llamada la exige el gate `check-domain-guards.sh`.

Si el diseño normaliza un campo antes de validarlo y el `pattern` del tipo no admite el valor sin normalizar, la
entrada lo rechaza antes de que la regla se aplique: es un `designGap`, no lo arregles quitando la regla del
lector.

### La idempotencia de petición: el registro ya está, el uso es tuyo

Una operación con `idempotency` (salvo `keySource: payload-field` cuyo campo está en la clave natural: ahí la guarda
es la constraint del agregado) tiene **ya generado** todo el mecanismo, el mismo que el de los servidores de
keel-spring y keel-nest: el puerto `IIdempotencyStore` (`Domain/Idempotency`, inyectado en su handler), su adaptador
con la tabla `idempotency_record`, `CommandSignature` (la firma canónica del comando), `IdempotencyContext` (la
cabecera `Idempotency-Key`, con `client-key`, que abre `IdempotencyKeyMiddleware`), el ámbito ya compuesto en el
comando (`command.IdempotencyScope()`) y los dos errores de conflicto. **No escribas otro registro, otra tabla ni otra
firma, y no toques el mediator ni el endpoint para esto**: un registro propio pasa los escenarios y deja de ser el
servidor de los otros dos (otra tabla, otro algoritmo).

```csharp
public async Task<CreateProductResponseDto> Handle(CreateProductCommand command, CancellationToken cancellationToken)
{
    var key = IdempotencyContext.Get();                       // null = el cliente no mandó la cabecera
    if (key is null) return await Create(command, Guid.CreateVersion7(), cancellationToken);   // sin clave: sin deduplicar
    var scope = command.IdempotencyScope();                   // lo compone build desde el diseño
    var signature = CommandSignature.Of(command);
    var previous = await idempotencyStore.Find(scope, key, cancellationToken);
    if (previous is not null)
    {
        if (previous.Signature != signature) throw new IdempotencyReuseException(scope, key);
        // La MISMA respuesta, reconstruida desde el recurso: sin re-ejecutar nada.
        var product = await productRepository.FindById(Guid.Parse(previous.ResourceId!), cancellationToken);
        return productApplicationMapper.ToCreateProductResponseDto(product!);
    }
    var id = Guid.CreateVersion7();                           // RECLAMA PRIMERO: el id se decide aquí
    await idempotencyStore.Save(scope, key, signature, id.ToString(), 86400, cancellationToken);
    return await Create(command, id, cancellationToken);      // y SOLO DESPUÉS el negocio, con ese id
}
```

- El id lo decide el handler y lo recibe el factory del agregado (un parámetro más de `Create`), para que el recurso
  creado sea el que el registro nombra.
- Con `keySource: payload-hash` la clave es `CommandSignature.Of(command)` y **no hay rama sin clave**: envolver el
  algoritmo en un `if (key is not null)` hace que la operación no deduplique nunca, en silencio.
- El `ttlSeconds` es el del diseño (lo dice la nota del handler).
- `Save` corre dentro de la transacción del comando: si el comando revierte, el registro revierte con él.
- **La carrera** (dos peticiones con la misma clave a la vez) no la ve `Find`: la arbitra la clave primaria del
  registro y el adaptador la traduce a `IdempotencyConflictException` (409 `IDEMPOTENCY_KEY_IN_PROGRESS` o el que
  declare el diseño). **No la captures.** Y por eso se reclama PRIMERO: con `Save` al final, la perdedora choca antes
  contra la primera restricción de negocio (la unicidad del sku) y sale ese `code`, no el de la clave en curso.
- La clave reutilizada con otro contenido es `IdempotencyReuseException` (409 `IDEMPOTENCY_KEY_REUSED` o el del
  diseño): no reutilices el error de la carrera ni inventes un `code`.

### Las operaciones por reloj: el disparo ya está, el trabajo es tuyo

Una operación con `schedule` tiene **ya generado** su disparador: `<Grupo>Scheduler` (`Infrastructure/Scheduling/`) la
registra en el reloj del servicio (`Scheduling`, un `BackgroundService` sobre Cronos) con un cron de **seis** campos
—build añade el segundo de arranque, repartido para que dos barridos con la misma cadencia no salgan a la vez— y la
despacha por el `IUseCaseMediator` en un ámbito de DI propio. Es el mismo segundo y el mismo despacho que el
`@Scheduled` del servidor de keel-spring. **No escribas otro disparador, otro `BackgroundService`, un `PeriodicTimer`
ni un `Timer`, y no cambies el segundo a 0.**

- Corre en **todas las réplicas** a la vez. Lo que actúa sobre lo que encuentra tiene que **reclamarlo** (marcar la
  fila y quedarse con las que esta réplica se llevó), no solo leerlo.
- Cómo se despacha lo dice el diseño, y la nota del handler lo repite: un barrido que reclama su lote (o llama a un
  proveedor en medio) va **sin transacción abarcadora** (`DispatchWithoutTransaction`): cada llamada al adaptador
  confirma la suya, y el orden es reclamar y confirmar, actuar fuera de toda transacción, confirmar el desenlace. Lo
  demás (un cierre diario) va en la transacción del caso de uso.
- Un tick que llega con la pasada anterior en curso **se salta**: el barrido no se solapa consigo mismo. Al apagar, la
  pasada en vuelo no se corta: el host la espera antes de soltar la base.
- El perfil `test` no tiene base de datos y el reloj no corre (`scheduling.enabled: false`); en los demás lo conmuta
  `SCHEDULING_ENABLED`.

Las **purgas** de las tablas del generador (`outbox_event`, `processed_event`, `idempotency_record`) son también de
build (`Infrastructure/Persistence/Purge/`): por lotes, cada lote en su transacción, con la cadencia y la retención de
`config/parameters/<perfil>/` (las mismas claves y variables que keel-spring y keel-nest). No las toques ni escribas
otra.

### El reclamo de un barrido: ya está en el puerto, úsalo

Un barrido que saca filas de un estado (`schedule` + `transitions`) tiene **ya generado** su reclamo en el puerto del
repositorio: `ClaimFor<…>(cancellationToken)`, con su adaptador. Es el mismo mecanismo que el de los servidores de
keel-spring y keel-nest: los candidatos con `FOR UPDATE SKIP LOCKED` (cada réplica recibe filas distintas) y un UPDATE
condicional por fila (`… WHERE id = {id} AND estado IN (…)`: una fila afectada = es tuya), en su propia transacción, con el
lote de `sweep.<barrido>.batch-size`. Devuelve **solo** lo que esta réplica se llevó.

```csharp
public async Task Handle(DispatchJobsCommand command, CancellationToken cancellationToken)
{
    foreach (var job in await jobRepository.ClaimForDispatchJobsRunning(cancellationToken))         // ya en running
    {
        // … el trabajo de cada fila, y su desenlace guardado: un fallo en una no revierte las demás
    }
    foreach (var job in await jobRepository.ClaimForStalledDispatchJobsDone(cancellationToken))     // SIGUE en running
    {
        job.Finish();                                  // la transición la hace el dominio
        await jobRepository.Save(job, cancellationToken);
    }
}
```

- **No escribas otro reclamo**: ni un finder por estado, ni un lock, ni una marca propia. Leer el lote y marcarlo después
  pasa con una réplica y se lo da entero a todas en producción.
- El reclamo confirma en **su propia transacción**: el scheduler despacha la operación con `DispatchWithoutTransaction`,
  y llamarlo con una transacción abierta lanza en vez de unirse a ella.
- El **rescate** (`ClaimForStalled…`) solo se lleva lo ABANDONADO —el reloj del estado más viejo que su plazo— y **no
  cambia el estado: lo arrienda** renovando el reloj. La transición la haces tú con el método del agregado, que fija los
  campos que el estado de destino exige. Su plazo sale de `sweep.<rescate>.stalled-after-seconds` o, si el diseño lo
  enlaza (`stalledAfter`), del parámetro de despliegue.
- Si la cola estampa el reloj que el rescate vigila (`runningSince`), viene **ya estampado**: no lo vuelvas a poner, una
  segunda escritura abre la ventana en la que la fila queda sin reloj para siempre.
- Un barrido que sale de DOS estados en vuelo a la vez no tiene reclamo generado (son dos relojes y «lleva demasiado»
  deja de estar definido para el lote): build lo avisa, y ese reclamo sí lo escribes tú, con las mismas dos capas.

### Los parámetros de despliegue

Los `parameters` del manifiesto llegan en un value object de dominio, `<Servicio>Parameters` (`Domain/Parameters/`), que
valida sus cotas al construirse —un valor fuera de rango no deja arrancar— y que se recibe por inyección, como cualquier
puerto. Lo puebla `ServiceParametersRegistration` (`Infrastructure/Config/`) desde `<artifactId>.<clave>` de
`config/parameters/<perfil>/`, con la misma variable de entorno y el mismo gradiente que keel-spring y keel-nest. **No leas
la configuración desde Application** ni escribas el valor como constante.

### La lista cerrada de `code` que NO nacen en el diseño

Los conflictos de un mecanismo que el diseño no nombra (bloqueo optimista, unicidad sin error declarado, tope de
transacción) salen con los `code` del catálogo de Keel (`{{keel:docs}}/framework-errors.md`: `VALIDATION_ERROR`,
`OPTIMISTIC_LOCK_CONFLICT`, `TRANSACTION_TIMEOUT`…): ya los emite el manejador de errores. No inventes `code`
nuevos: lo que no esté ni en el diseño ni en ese catálogo es un hueco del diseño.

### El sobre de error es contrato del generador

`{timestamp, status, error, code, message, details, correlationId}`, en ese orden, lo escribe `ApiErrorMiddleware`
a partir de la excepción que lances. Un handler **lanza** el `<PascalCode>Error` del diseño; nunca construye una
respuesta de error ni devuelve un `IResult`.

### Ausencia vs. nulo

Lo fijan las Convenciones de determinación de `validation-scenarios.md` (`conventions.nulls`). El DTO generado ya
lo respeta (`[OmitNulls]` cuando el diseño omite): no conviertas un `null` en otra cosa en el mapper.

### `Location`

En una operación `201` cuyo `output` declara `id`, el endpoint generado ya pone `Location` con la ruta que lee el
recurso. No se toca.

### El orden declarado manda sobre la conveniencia técnica

`preconditions` y `rules` se evalúan en el orden del diseño: si dos pueden fallar a la vez, responde la que el
diseño pone primero, y eso es lo que comprueba el escenario.

### Auditoría de consistencia del contrato (antes de cerrar)

Cada nombre de campo que `validation-scenarios.md` menciona en una respuesta existe con ese nombre exacto en el
DTO (su `[JsonPropertyName]`); ningún campo que el `output` excluye aparece en la respuesta; los `exclude` con
dot-path (`price.currency`) recortan el DTO anidado.

## `api` — api.keel.yaml

Entera de build: un `<Grupo>V1Endpoints` por grupo en `<Raíz>.Api/Endpoints/`, con un lector por operación que
convierte y valida la petición con las mismas reglas y mensajes que keel-spring, el status de éxito del diseño,
`Location`, la paginación (`page`, `size`, `sort`, el tope del diseño, desempate por id) y `ApiRoutes`, el único
sitio que registra las rutas. Si el binding, el status o la ruta no casan con `api.keel.yaml`, es un defecto del
scaffolding: **repórtalo**, no lo compenses en el handler.

## `security` — security.keel.yaml

Entera de build, con la misma autorización que los servidores de keel-spring y keel-nest (el plan de acceso lo
decide keel-core): un middleware de la entrada HTTP (`<Raíz>.Api/Rest/HttpSecurityMiddleware.cs`) que evalúa las
reglas de `<Raíz>.Infrastructure/Security/AccessRules.cs` **delante de los endpoints** —sin credencial, un camino que
no existe es 401, no 404—, la validación del JWT (`JwtAuthenticator.cs`, contra el JWKS del proveedor), las claves de
API, CORS, los rechazos 401/403 con su `code` del catálogo (`UNAUTHENTICATED`, `ACCESS_DENIED`) y la configuración
por perfil (`config/parameters/<perfil>/security.yaml`). **No uses `[Authorize]`, políticas de ASP.NET Core ni
`RequireAuthorization`**: la autorización del diseño ya está entera, y una segunda capa diría otra cosa en cuanto el
diseño cambie.

Lo que toca a un handler:

- **La identidad del llamante** (`authentication.callerIdentity`) llega YA resuelta en su campo del mensaje: la
  estampa el lector del endpoint desde la credencial (`CallerIdentity.Resolve()`), nunca del cuerpo. El handler la
  usa como cualquier otro campo; no mira el token.
- **El alcance por recurso** (`authentication.scoping`): el handler de una operación que declara el error del alcance
  recibe `ICallerScope` inyectado. Comprueba `callerScope.Covers(valor)` donde lo digan las reglas y lanza el error
  del diseño si no lo cubre; en un listado, filtra en la consulta con `callerScope.ScopedValues()` (un finder acotado
  en el puerto), nunca cargando todo y filtrando.

```csharp
var application = await applicationRepository.FindByCode(command.ApplicationCode, cancellationToken);
if (!callerScope.Covers(command.ApplicationCode)) throw new ApplicationForbiddenException();
```

Las credenciales de los escenarios salen del arnés (`TokenFor`, `ServiceCredential`, `TokenAs`), que lee
`infra/test-credentials.env`: ver la skill del proveedor (`keel-dotnet-keycloak`, `keel-dotnet-cognito`).

## `persistence` — persistence.keel.yaml

Entera de build: las filas (`Persistence/Rows/<Entidad>Row.cs`) con su mapeo fluente sobre el esquema neutral de
Keel (los mismos nombres de tabla, columna, constraint, índice y FK que los otros dos servidores, todos
explícitos), un adaptador por raíz (`Persistence/Repositories/<Raíz>Repository.cs`) con `ToDomain` y `Apply`
explícitos, el bloqueo optimista (la versión leída es el valor original del token de concurrencia: EF escribe
`UPDATE … WHERE lock_version = @leída`), la auditoría, la unicidad condicionada y la traducción de cada violación
de constraint al error del diseño (`PersistenceErrors`, por el nombre de la constraint).

Lo que el agente hace aquí es **ampliar un puerto**: si un handler necesita una consulta que el puerto no tiene
(un `ExistsBy…`, un contador, un listado sin paginar), la añade al puerto de `Domain/Repository` **y** a su
adaptador, con el `DbContext` del adaptador (`db`). Nunca inyecta el `DbContext`, un `DbSet` ni una fila en un
handler.

```csharp
// Domain/Repository/IProductRepository.cs
Task<long> CountByStatus(ProductStatus status, CancellationToken cancellationToken = default);

// Infrastructure/Persistence/Repositories/ProductRepository.cs
public Task<long> CountByStatus(ProductStatus status, CancellationToken cancellationToken = default) =>
    db.Set<ProductRow>().LongCountAsync(r => r.Status == status, cancellationToken);
```

Una lectura usa `AsNoTracking()` y devuelve el dominio por `ToDomain`; una escritura pasa por `Save`, que ya
sincroniza el grafo y la versión. Una consulta sobre una colección se hace en el motor, no cargando todo y
filtrando en memoria; y nunca una consulta por elemento dentro de un bucle sobre una página (N+1). Detalle en la
skill `keel-dotnet-database`.

El esquema de `develop` y `production` lo crean las migraciones de EF Core; el baseline lo produce el pase de
calidad.

## `messaging` — messaging.keel.yaml

Casi entera de build, con los mismos nombres que los servidores de keel-spring y keel-nest (destinos, colas, DLQ,
variables de entorno y tablas `outbox_event` y `processed_event`):

- **Lo que sale**: los eventos de dominio llegan solos al broker. El agregado hace `Raise(...)`; al guardar, su
  adaptador de repositorio entrega `PullDomainEvents()` al puente (`Messaging/<Raíz>DomainEventBridge.cs`), que con
  `reliability: outbox` escribe la fila del outbox en la MISMA transacción y con `best-effort` publica tras el commit.
  **Nunca publiques desde un handler** ni escribas en `outbox_event`.
- **Lo que entra**: cada suscripción tiene su mensaje (`Messaging/Subscriptions/<Evento>Message.cs`) con `FromWire` y
  `RequireContract`, y su comentario dice el orden del guard (`IdempotencyGuard`) y el mapeo al comando.
- **Lo del broker** —el dispatcher del outbox o los publishers best-effort, y los listeners: uno por COLA con
  RabbitMQ, uno por SUSCRIPCIÓN con Kafka y con SNS/SQS— lo escribe el agente con la skill del broker
  (`keel-dotnet-rabbitmq`, `keel-dotnet-kafka` o `keel-dotnet-snssqs`, la que esté instalada) y lo registra en UN solo
  archivo, `Messaging/BrokerBindings.cs`. La conexión, el reintento y el descarte son de build, y la topología no es
  nunca del agente: la de RabbitMQ la declara build, los topics de Kafka los crea el broker en `infra/` (la plataforma
  fuera) y la de SNS/SQS la siembra `infra/init-messaging.sh`.

El handler de una operación disparada por un mensaje es un handler más: recibe su comando ya mapeado, y la
deduplicación, la reentrega y el descarte no son cosa suya.

## `http-clients` y `dependencies` — las llamadas a otros servidores

Casi enteras de build, con la misma política que los servidores de keel-spring y keel-nest (rutas, cabecera de
idempotencia, reintentos, circuito y fallback):

- **La llamada**: el puerto `I<Cliente>Client` (`Domain/Clients`) llega por el constructor del handler cuando una
  activación del diseño sale por él, y la nota del handler dice el ORDEN de los efectos. Se llama con `await`, sin
  retry, circuito ni try/catch alrededor: ya están en el adaptador (`Infrastructure/Clients/<Cliente>HttpAdapter.cs`).
- **La reconciliación**: el reclamo del barrido ya está en el repositorio de la raíz que espera
  (`ClaimFor<Barrido><Activación>`), con su marca en `reconciliation_claim`; el barrido lo usa y no escribe otro.
- **La compensación**: el estado vuelve con el método semántico del agregado; la guarda contra repetirla es la
  transición.
- Lo que el contrato solo dice en prosa, los rechazos con significado, un fallback `degrade` y los flujos contra el
  proveedor de prueba los enseña la skill `keel-dotnet-httpclient`.

## Cobertura funcional (criterio de «generación terminada»)

`dotnet build` en verde (sin warnings), los gates estáticos en verde y el 100% de los escenarios `FL-*` en OK en
`infra/score-scenarios.sh`.
