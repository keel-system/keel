# DSL 2.22 — los filtros de una búsqueda, declarados (y su finder, emitido)

## Por qué

En la corrida catalog-dotnet del registry (2026-10-19), 6 de los 44 archivos de build reescritos por el agente fueron los
puertos y adaptadores de repositorio: `Search(ProductSearch, Pageable)` y `ListActive()`, escritos a mano. Es el mismo
«candidato a que lo emita build» de la corrida catalog-nest (2026-10-13, `docs/corridas/2026-10-13-catalog-nest.md`):
el segundo generador con el mismo hueco.

Build no podía emitirlos porque el diseño los decía a medias. En `searchPublishedProducts` del catalog:

| Input | Hoy | Por qué no basta |
|---|---|---|
| `categoryId`, `brandId` | casan por nombre con la relación | implícito: nada lo declara |
| `name` (`match: contains`, `compare: ignore-case-accents`) | estructurado (DSL 2.14) | — |
| `minPrice`, `maxPrice` | **prosa**: «el rango se aplica sobre price.amount, extremos incluidos» | ningún campo se llama así |
| — | **prosa**: «solo devuelve productos en estado active» | no es un input |

Barrido del corpus (fixtures + registry): los rangos (`minPrice/maxPrice`, `requestedFrom/To`) y los filtros fijos
(«solo las activas») se repiten; la búsqueda libre sobre varios campos (`search`) aparece una vez.

## El DSL

```yaml
searchPublishedProducts:
  kind: query
  input:
    fields:
      categoryId: { type: uuid }                       # implícito: la relación category
      name: { type: string, match: contains, compare: ignore-case-accents }   # implícito: el campo name
      minPrice: { type: decimal, filter: { field: price.amount, op: gte } }
      maxPrice: { type: decimal, filter: { field: price.amount, op: lte } }
  where: { status: active }                            # filtro fijo de la query
  output: { entity: Product, paginated: true, sort: [name:asc, id:asc] }
```

- **`filter`** en un campo del input de una query: `field` es una ruta sobre la entidad de la salida (un campo, un
  subcampo de value object `price.amount`, o una relación a otra raíz por su nombre) y `op` es `eq | gt | gte | lt | lte`.
- **El enlace implícito pasa a ser contrato**: un input que se llama como un campo de la entidad (o `<relación>Id`) es
  su filtro `eq`, con su `match`/`compare`. Ya lo usaban la sombra plegada (`deriveFilterFolds`) y las notas de
  `text-filters.js`; ahora lo usa el finder.
- **`where`** en la operación: igualdades fijas sobre campos escalares (`status: active`, `active: true`).
- Fuera de 2.22: búsqueda sobre varios campos, `in`, `ne`, `where` sobre rutas.

## Cuándo emite build el finder

Una query con salida `paginated` o `list` sobre una raíz persistida, cuyos inputs son TODOS filtros (implícitos o
declarados). Si alguno no lo es, no hay finder y la nota del handler nombra los que faltan — nunca un finder a medias,
que el agente tendría que reescribir igual. Lo decide `keel-core/src/lib/gen/query-filters.js`, neutral.

El handler sigue siendo del agente (validaciones en prosa, embebidos, mapeo): su nota dice que el finder aplica
EXACTAMENTE los filtros del diseño, y que una `rule` que restrinja algo más es un designGap.

## Estado (2026-10-19)

| Incremento | Estado | Medido con |
|---|---|---|
| 1. keel-core | hecho | suite 1240/1240; corpus de mutaciones (6 nuevas, cada una solo su id); `test/query-filters.test.js` |
| 2. keel-dotnet | hecho | `db-check` 32/32 y `doc-check` 18/18 (todos los sujetos), `cs-check --fixtures` 228/228; falsado con `--sabotage=finder-where/range/fold` (db) y `finder-literal/where` (doc) |
| 3. keel-nest | hecho | `db-check` en PostgreSQL y MySQL y `doc-check`, sobre catalog-extended, product-catalog-finder y jobs-mongo-finder; falsado con `--sabotage=finder-*` (el de plegado solo cae en PostgreSQL: la collation de MySQL ya ignora mayúsculas y acentos) |
| 4. keel-spring | hecho | `compile-check` de product-catalog-finder (PostgreSQL y MySQL) y jobs-mongo-finder, `main` incluido; `npm run finder-check` (nuevo) en PostgreSQL, MySQL y MongoDB; falsado con `--sabotage=finder-where/finder-literal` en las dos ramas |
| 5. notas y convenciones | hecho en los tres (nota del handler neutral, guías de base de datos, convención de pruebas de keel-dotnet) | — |

Sin medir todavía: el `contains`/`prefix` con `compare: exact` sobre MySQL en keel-nest (la collation `_ci` lo haría insensible a mayúsculas; ningún sujeto lo declara).

Los diseños derivados de las sondas son uno solo para todos: `keel-core/test/helpers/finder-designs.js`.

## Incrementos

1. **keel-core**: schema (`filter` en el campo, `where` en la operación), versión 2.22 (enum, plantilla, fixtures,
   base del corpus, `SUPPORTED_DSL` de los tres generadores con su `package.json` y README), `crossrefs.js` con sus
   `CHK-USECASES-FILTER-*` y sus mutaciones, docs (`dsl/use-cases.md`, historial de `dsl-reference.md`) y el núcleo
   neutral `gen/query-filters.js` con su test. Una fixture que lo declare (`catalog-extended`).
2. **keel-dotnet**: relacional (LINQ sobre EF Core) y documental (`BsonDocument`), con su sonda en `db-check` y en
   `doc-check` (cada filtro, cada operador, el texto literal con `%` y `_`, el filtro fijo) y su sabotaje.
3. **keel-nest**: relacional (QueryBuilder de TypeORM) y documental, medido con su `db-check` y `doc-check`; paridad
   de la firma con keel-dotnet.
4. **keel-spring**: relacional (JPA Criteria) y documental (`Criteria` de Spring Data), con `compile-check` y una
   sonda que lo ejecute.
5. Notas del handler y convenciones de los tres; `capability-coverage` de los tres; CLAUDE.md.
