# Mapeo diseño Keel → código NestJS

Qué produce cada construcción del diseño y qué queda para el agente. Se sigue **estrictamente**: lo que
aquí se fija es lo que hace que este servidor sea equivalente al de keel-spring del mismo diseño. Las
capas que keel-nest aún no genera (seguridad, mensajería, clientes HTTP, storage, correo, pagos) las
rechaza `keel-nest build`: si estás aquí, el diseño no las declara.

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

## Cobertura funcional (criterio de «generación terminada»)

`npm run build` en verde, `npm run check:architecture` en verde, los gates estáticos en verde y el 100%
de los escenarios `FL-*` en OK en `infra/score-scenarios.sh`.
