# Mapeo diseño Keel → código NestJS

Qué produce cada construcción del diseño y qué queda para el agente. Se sigue **estrictamente**: lo que
aquí se fija es lo que hace que este servidor sea equivalente al de keel-spring del mismo diseño. Las
capas que keel-nest aún no genera (clientes HTTP, dependencias, storage, correo, pagos, la persistencia
documental, y la mensajería sobre SNS/SQS) las rechaza `keel-nest build`: si estás
aquí, el diseño no las declara.

## `domain` — domain.keel.yaml

| Diseño | Código | Quién |
|---|---|---|
| `types.T` con `fields` | `domain/valueobject/<t>.ts`: clase con sus guardas en el constructor y `equals` | build |
| `types.T` escalar con `pattern` | se aplana a `string` + `domain/valueobject/<t>-format.ts` (`<T>Format.validate`) | build la clase; **la llamada, el agente** |
| `enums.E` | `domain/enums/<e>.ts`; el valor del cable es el del diseño | build |
| entidad raíz | `domain/aggregate/<raíz>.ts`: `<Raíz>State`, constructor de rehidratación, `transitionTo`, getters | build; factory y métodos semánticos, el agente |
| entidad interna | `domain/entity/<entidad>.ts` | build |
| `lifecycle` | el mapa `#TRANSITIONS` y `transitionTo` | build; un método semántico por transición, el agente |
| `invariants` | un `TODO invariante` por cada uno | **el agente** escribe la guarda |
| `errors` (en `use-cases`) | `domain/errors/<code>-error.ts` (`<PascalCode>Error`) con su `code` y status | build |

### Tipos base

| DSL | TypeScript | Cable |
|---|---|---|
| `string`, `text` | `string` | texto |
| `uuid` | `string` | texto (UUID) |
| `int` | `number` | número |
| `long` | `bigint` | número **sin perder dígitos** (el contrato del cable lo escribe tal cual) |
| `decimal` | `Decimal` | número **con su escala** (`2.50`, nunca `2.5`) |
| `boolean` | `boolean` | booleano |
| `date` | `string` (`YYYY-MM-DD`) | texto |
| `timestamp` | `Date` | ISO-8601 UTC con **tres** decimales y `Z` |
| `json` | `RawJson` | el JSON tal cual, como objeto |

El serializador de Fastify ya escribe cada tipo así: no conviertas a `number` ni a `string` "para que
salga bien" en un mapper.

## `use-cases` — use-cases.keel.yaml

| Diseño | Código |
|---|---|
| operación `command` sin `output` | `application/commands/<op>-command.ts` + `<Op>CommandHandler implements CommandHandler<…>` |
| operación `command` con `output` | `ReturningCommandHandler<…, <Op>ResponseDto>` |
| operación `query` | `application/queries/<op>-query.ts` + `<Op>QueryHandler` |
| `input` | los campos del mensaje, ya convertidos y validados por el lector de la petición |
| `output` | `application/dtos/<op>-response-dto.ts` + su método en `<Raíz>ApplicationMapper` |
| `output` paginado | `PagedResponse<<Op>ResponseDto>`; el mensaje trae `pageable` |
| `preconditions`, `rules`, `errors`, `transitions` | notas `// TODO (agente)` en el handler, **en el orden del diseño** |

### Cómo se escribe un handler

```ts
async handle(command: CreateProductCommand): Promise<CreateProductResponseDto> {
  // Regla (en orden): el sku no existe antes de crear.
  if (await this.productRepository.findBySku(command.sku) != null) {
    throw new SkuAlreadyExistsError(`Ya existe un producto con el sku ${command.sku}`);
  }
  const product = Product.create({ sku: command.sku, name: command.name, notes: command.notes ?? null, price: command.price });
  const saved = await this.productRepository.save(product);
  return this.productApplicationMapper.toCreateProductResponseDto(saved);
}
```

- La transacción ya está abierta por el mediator: el handler no abre ni confirma nada.
- Lo que el handler necesita lo tiene inyectado (`static readonly inject`). Si necesitas una
  dependencia más (otro puerto, otro mapper), añádela **a la lista `inject` y al constructor, en el
  mismo orden**: el contenedor construye el handler con esa lista.
- Una consulta paginada: `this.repo.list(query.pageable)` y `mapPage` (de `domain/repository/page.ts`)
  para pasar a DTO, devolviendo `new PagedResponse(items, page, size, totalElements, totalPages)`.
- Un `todo('…')` en un mapper es un campo que build no supo derivar del dominio: complétalo; no lo dejes
  devolviendo un valor inventado.

### La idempotencia de petición: el registro ya está, el uso es tuyo

Una operación con `idempotency` (salvo `keySource: payload-field` cuyo campo está en la clave natural:
ahí la guarda es la constraint del agregado) tiene **ya generado** todo el mecanismo, el mismo que el del
servidor de keel-spring: el puerto `IdempotencyStore` (inyectado en su handler), su adaptador con la tabla
`idempotency_record`, `CommandSignature` (la firma canónica del comando), `IdempotencyContext` (la
cabecera `Idempotency-Key`, con `client-key`) y los dos errores de conflicto. **No escribas otro registro,
otra tabla ni otra firma, y no toques el mediator ni el controlador para esto**: un registro propio pasa
los escenarios y deja de ser el servidor de keel-spring (otra tabla, otro motor).

```ts
async handle(command: CreateProductCommand): Promise<CreateProductResponseDto> {
  const key = IdempotencyContext.get();               // null = el cliente no mandó la cabecera
  if (key == null) return this.create(command, Uuids.v7());   // sin clave: se ejecuta sin deduplicar
  const scope = command.idempotencyScope();           // lo compone build desde el diseño
  const signature = CommandSignature.of(command);
  const previous = await this.idempotencyStore.find(scope, key);
  if (previous != null) {
    if (previous.signature !== signature) throw new IdempotencyReuseException(scope, key);
    // La MISMA respuesta, reconstruida desde el recurso: sin re-ejecutar nada.
    const product = await this.productRepository.findById(previous.resourceId!);
    return this.productApplicationMapper.toCreateProductResponseDto(product!);
  }
  const id = Uuids.v7();                               // RECLAMA PRIMERO: el id se decide aquí
  await this.idempotencyStore.save(scope, key, signature, id, 86400);
  return this.create(command, id);                     // y SOLO DESPUÉS el negocio, con ese id
}
```

- Con `keySource: payload-hash` la clave es `CommandSignature.of(command)` y **no hay rama sin clave**:
  envolver el algoritmo en un `if (key != null)` hace que la operación no deduplique nunca, en silencio.
- El `ttlSeconds` es el del diseño (lo dice la nota del handler).
- `save` corre dentro de la transacción del comando: si el comando revierte, el registro revierte con él.
- **La carrera** (dos peticiones con la misma clave a la vez) no la ve `find`: la arbitra la clave
  primaria del registro y el adaptador la traduce a `IdempotencyConflictException` (409
  `IDEMPOTENCY_KEY_IN_PROGRESS` o el que declare el diseño). **No la captures.** Y por eso se reclama
  PRIMERO: con `save` al final, la perdedora choca antes contra la primera restricción de negocio (la
  unicidad del sku) y sale ese `code`, no el de la clave en curso.
- La clave reutilizada con otro contenido es `IdempotencyReuseException` (409 `IDEMPOTENCY_KEY_REUSED`
  o el del diseño): no reutilices el error de la carrera ni inventes un `code`.

### Normalización antes que validación de formato

Si una regla del diseño normaliza un campo (mayúsculas, recorte, slug), se normaliza **antes** de
validar su formato y antes de buscar por él: la unicidad y el formato se juzgan sobre el valor
normalizado. Pero la normalización no amplía lo admitido: lo que el lector rechaza con 400 por su
`pattern` propio no llega al dominio.

### La lista cerrada de `code` que NO nacen en el diseño

Los conflictos de un mecanismo que el diseño no nombra (bloqueo optimista, unicidad sin error
declarado, tope de transacción) salen con los `code` del catálogo de Keel (`VALIDATION_ERROR`,
`OPTIMISTIC_LOCK_CONFLICT`, `TRANSACTION_TIMEOUT`…): ya los emite el filtro de errores. No inventes
`code` nuevos: lo que no esté ni en el diseño ni en ese catálogo es un hueco del diseño.

### El sobre de error es contrato del generador

`{timestamp, status, error, code, message, details, correlationId}`, en ese orden, lo escribe
`ApiExceptionFilter` a partir de la excepción que lances. Un handler **lanza** el `<PascalCode>Error`
del diseño; nunca construye una respuesta de error.

### Ausencia vs. nulo

Lo fijan las Convenciones de determinación de `validation-scenarios.md` (`conventions.nulls`). El DTO
generado ya lo respeta (`@OmitNulls()` cuando el diseño omite): no conviertas un `null` en `undefined` ni
al revés en el mapper.

### `Location`

En una operación `201` cuyo `output` declara `id`, el controlador generado ya pone `Location` con la
ruta que lee el recurso. No se toca.

### El orden declarado manda sobre la conveniencia técnica

`preconditions` y `rules` se evalúan en el orden del diseño: si dos pueden fallar a la vez, responde la
que el diseño pone primero, y eso es lo que comprueba el escenario.

### Auditoría de consistencia del contrato (antes de cerrar)

Cada nombre de campo que `validation-scenarios.md` menciona en una respuesta existe con ese nombre exacto
en el DTO; ningún campo que el `output` excluye aparece en la respuesta; los `exclude` con dot-path
(`price.currency`) recortan el DTO anidado.

## `api` — api.keel.yaml

Entera de build: controladores por grupo y versión en `infrastructure/rest/controllers/`, un lector por
operación que convierte y valida la petición con las mismas reglas y mensajes que keel-spring, status de
éxito del diseño, `Location`, paginación (`page`, `size`, `sort`, el tope del diseño, desempate por id) y
`routes.ts`. Si el binding, el status o la ruta no casan con `api.keel.yaml`, es un defecto del
scaffolding: **repórtalo**, no lo compenses en el handler.

## `persistence` — persistence.keel.yaml

Entera de build: las entidades TypeORM sobre el esquema neutral de Keel (los mismos nombres de tabla,
columna, constraint, índice y FK que el servidor de keel-spring), un adaptador por raíz con `toDomain` y
`toOrm` explícitos, el bloqueo optimista (UPDATE condicionado por la versión: TypeORM no la comprueba),
la auditoría, la unicidad condicionada y la traducción de cada violación de constraint al error del
diseño.

Lo que el agente hace aquí es **ampliar un puerto**: si un handler necesita una consulta que el puerto no
tiene (un `existsBy…`, un contador, un `findAll` sin paginar), la añade al puerto de `domain/repository`
**y** a su adaptador, con el `EntityManager` de la transacción (`this.manager`). Nunca inyecta un
`EntityManager`, un `DataSource` ni una entidad ORM en un handler.

```ts
// domain/repository/product-repository.ts
abstract countByStatus(status: ProductStatus): Promise<number>;

// infrastructure/persistence/repositories/product-repository-impl.ts
async countByStatus(status: ProductStatus): Promise<number> {
  return this.manager.count(ProductOrm, { where: { status } });
}
```

Una consulta sobre una colección se hace en el motor, no cargando todo y filtrando en memoria; y nunca
una consulta por elemento dentro de un bucle sobre una página (N+1).

El esquema de `develop` y `production` lo crean las migraciones de `src/migrations/`; el baseline lo
produce el pase de calidad (`src/migrations/README.md`).

## `security` — security.keel.yaml

Entera de build, con la misma autorización que el servidor de keel-spring (el plan de acceso lo decide
keel-core): un hook de la entrada HTTP (`infrastructure/security/http-security.ts`) que evalúa las reglas
de `access-rules.ts` **antes de enrutar** —sin credencial, un camino que no existe es 401, no 404—, la
validación del JWT (`jwt-authenticator.ts`, contra el JWKS del proveedor), las claves de API, CORS, los
rechazos 401/403 con su `code` del catálogo (`UNAUTHENTICATED`, `ACCESS_DENIED`) y la configuración por
perfil (`config/parameters/<perfil>/security.yaml`). **No escribas Guards ni decoradores de rol**: la
autorización del diseño ya está entera, y una segunda capa diría otra cosa en cuanto el diseño cambie.

Lo que toca a un handler:

- **La identidad del llamante** (`authentication.callerIdentity`) llega YA resuelta en su campo del
  mensaje: la estampa el controlador desde la credencial (`CallerIdentity.resolve()`), nunca del cuerpo.
  El handler la usa como cualquier otro campo; no mira el token.
- **El alcance por recurso** (`authentication.scoping`): el handler de una operación que declara el
  error del alcance recibe `CallerScope` inyectado. Comprueba `this.callerScope.covers(valor)` donde lo
  digan las reglas y lanza el error del diseño si no lo cubre; en un listado, filtra en la consulta con
  `this.callerScope.scopedValues()` (un finder acotado en el puerto), nunca cargando todo y filtrando.

```ts
const application = await this.applicationRepository.findByCode(command.applicationCode);
if (!this.callerScope.covers(command.applicationCode)) throw new ApplicationForbiddenError();
```

Las credenciales de los escenarios salen del arnés (`tokenFor`, `serviceCredential`, `tokenAs`), que
lee `infra/test-credentials.env`: ver la skill del proveedor (`keel-nest-keycloak`, `keel-nest-cognito`).

## `messaging` — messaging.keel.yaml

Lo transversal al broker es de build, con la misma forma que el servidor de keel-spring del diseño: la
`EventEnvelope` (`infrastructure/messaging/event-envelope.ts`, con `EventEnvelope.parse` para leer una
entrante), un `<Evento>IntegrationEvent` por evento, el puente `<Servicio>DomainEventBridge` al que los
adaptadores de repositorio ya entregan los eventos al guardar, la clase del mensaje de cada suscripción
(`subscriptions/<evento>-message.ts`, con `fromWire` y `requireContract()`), el **outbox** con su relay
(`outbox/`, la tabla `outbox_event`), el registro de mensajes procesados (`IdempotencyGuard`, la tabla
`processed_event`), la configuración (`config/parameters/<perfil>/messaging.yaml` y la del broker) y la
conexión con el broker de `keel-stack.json`:

- **RabbitMQ** — `rabbitmq/rabbit-connection.ts` y la topología entera (`rabbitmq/rabbit-topology.ts`): la de
  consumo —exchange del canal de origen, cola propia y DLQ— y la de publicación —el exchange del servicio y una
  cola por canal publicado, enlazada con la routing key de cada evento, que es también la que lee el arnés—. El
  dispatcher es una línea: `this.connection.publish(destination, routingKey, payload, eventType)`, que resuelve
  cuando el broker confirma y lanza si no hubo cola (`mandatory`) o no hay conexión.
- **Kafka** — `kafka/kafka-connection.ts` y el consumo (`kafka/kafka-consumption.ts`): un consumer group por
  suscripción (`messaging.subscriptions.<e>.group-id`), el reintento y el descarte en `<topic>.DLT`. Los topics
  no los crea la aplicación. El dispatcher es una línea: `this.connection.publish(destination, routingKey,
  payload)`, con la routing key como clave del registro.

**No declares topología ni escribas otra conexión.** Lo que cambia de un broker a otro está en su skill
(`keel-nest-<broker>`).

| Diseño | Código | Quién |
|---|---|---|
| `publishing.events.E` | `<E>IntegrationEvent` y su rama en el puente | build |
| `reliability: outbox` | la fila en la transacción del cambio, el relay (reclamo con lease, backoff, rendición) y el puerto `OutboxDispatcher` | build; **la implementación del puerto, el agente** (`publish` de la conexión del broker) |
| `reliability: best-effort` | el puerto `<E>Publisher` (dominio), invocado tras el commit, con un stub que solo avisa | build; **la implementación, el agente** |
| `subscriptions.E` | `<E>Message` con su lector y su contrato; la cola (RabbitMQ, `messaging.subscriptions.<e>.queue`) o el consumer group (Kafka, `…<e>.group-id`) | build; **el listener, el agente** (`consume` de la conexión del broker: uno por cola en RabbitMQ, uno por suscripción en Kafka) |
| `onFailure.retry` / `deadLetter` | el reintento del consumo (sin reintentar `DomainException` ni `MessageContractViolation`) y el descarte (la DLQ de la cola, o `<topic>.DLT`) | build |

Lo que escribe el agente se registra en **un solo archivo**, `infrastructure/messaging/broker-bindings.ts`:
los adaptadores en `BROKER_ADAPTERS` (`{ provide: OutboxDispatcher, useClass: … }`, que sustituye al
respaldo de build) y los listeners en `MESSAGE_LISTENERS`. Un listener se registra en la conexión al
arrancar y hace, en este orden, lo que dice la clase del mensaje de su suscripción: leer la envoltura,
descartar SIN lanzar lo que no es suyo, `fromWire` y `requireContract()`, deduplicar con `IdempotencyGuard`
en el orden que esa clase prescribe, y despachar por el `UseCaseMediator` dentro de
`CorrelationContext.runWith(metadata.correlationId, …)`. Lo que lanza se reintenta o va al descarte; lo que
retorna se confirma.

## Cobertura funcional (criterio de «generación terminada»)

`npm run build` en verde, `npm run check:architecture` en verde, los gates estáticos en verde y el 100%
de los escenarios `FL-*` en OK en `infra/score-scenarios.sh`.
