# PostgreSQL (`database: "postgresql"`)

Lo que build dejó: driver `org.postgresql:postgresql`, contenedor
`postgres:16-alpine` (usuario = nombre de la BD, password `changeme`), URL
`jdbc:postgresql://localhost:5432/<servicio_snake>`.

## Tipos y mapeos

- **UUID**: nativo; `private UUID id` mapea a `uuid` sin anotaciones extra.
- **JSON**: usa `jsonb` (no `json`): en la entidad Jpa,
  `@JdbcTypeCode(SqlTypes.JSON)` sobre un campo record/Map (Hibernate 6, sin
  librerías externas). `jsonb` permite índices GIN si el diseño consulta por
  dentro del documento.
- **Texto largo**: `columnDefinition = "text"` en vez de `@Lob` (evita el
  manejo de large objects de PG, que exige transacción y `oid`).
- **Enums**: build los mapea `@Enumerated(EnumType.STRING)`; déjalo así (el
  tipo enum nativo de PG complica las migraciones).
- Identificadores en snake_case minúscula (naming strategy default de Boot).

## Secuencias e inserts masivos

- `GenerationType.SEQUENCE` funciona nativamente: compatible con el batching
  de Hibernate (`jdbc.batch_size`).
- Para lotes grandes añade `reWriteBatchedInserts=true` a la URL JDBC: el
  driver reescribe N inserts en un multi-values (mejora real de 2-3x).

## Concurrencia

- MVCC: los lectores no bloquean escritores; el locking optimista `@Version`
  encaja bien. `SELECT ... FOR UPDATE` solo si el diseño exige serialización.
- Deadlocks: PG los detecta y mata una transacción (`deadlock detected`);
  ordena los updates multi-fila de forma consistente.

## Validación y reset

Desde devtools (`psql`, ya instalado):

```bash
PGPASSWORD='changeme' psql -h db -U <db> -d <db> -c 'SELECT 1' -q -t
```

`infra/reset-db.sh` trunca todas las tablas de `public` con
`TRUNCATE ... RESTART IDENTITY CASCADE`: los ids vuelven a empezar — los
escenarios no deben asumir ids concretos de ejecuciones previas.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL`, que imita mucho pero no todo:
sin `jsonb` real (ni operadores `->`/`@>`), sin GIN, `text` limitado, otras
funciones de fecha. Si una query usa algo de esta lista, cúbrela con un
escenario `FL-*` contra el PG real, no solo con el test.
