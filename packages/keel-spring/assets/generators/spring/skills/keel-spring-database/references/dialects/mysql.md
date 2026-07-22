# MySQL (`database: "mysql"`)

Lo que build dejó: driver `com.mysql:mysql-connector-j`, contenedor `mysql:8.0`
(usuario = nombre de la BD, password `changeme`), URL
`jdbc:mysql://localhost:3306/<servicio_snake>`.

## Tipos y mapeos

- **Charset**: asegúrate de que tablas nuevas queden en `utf8mb4` (default en
  8.0, pero verifica si defines `columnDefinition`): `utf8` de MySQL son 3
  bytes y rompe con emojis.
- **UUID**: no hay tipo nativo; Hibernate 6 lo mapea a `binary(16)` por
  defecto. Si necesitas legibilidad en SQL, `@JdbcTypeCode(SqlTypes.CHAR)` →
  `char(36)` (más grande y lento en índices; decide y sé consistente).
- **JSON**: tipo `json` nativo con `@JdbcTypeCode(SqlTypes.JSON)`; sin índices
  sobre el documento (solo columnas generadas).
- **Fechas**: usa `TIMESTAMP` solo hasta 2038; para `Instant`/fechas futuras
  Hibernate usa `datetime(6)` — correcto, no lo fuerces a timestamp.
- Comparaciones de texto **case-insensitive** por collation default
  (`utf8mb4_0900_ai_ci`): una clave natural «única» puede chocar por mayúsculas;
  si el diseño distingue casing, usa una collation `_bin` en esa columna.

## Identidad e inserts masivos

- Sin secuencias: Hibernate usa `GenerationType.IDENTITY` (auto_increment).
  **El batching de inserts de Hibernate no funciona con IDENTITY** — no añadas
  `jdbc.batch_size` esperando lotes de insert (updates sí agrupan).
- `rewriteBatchedStatements=true` en la URL JDBC agrupa a nivel driver y sí
  mejora los inserts masivos.

## Concurrencia

- InnoDB bloquea por índice: updates sin índice sobre la condición escalan a
  bloqueos amplios; respeta los índices de `persistence.keel.yaml`.
- Deadlocks frecuentes con inserts concurrentes + uniques (gap locks): ordena
  las escrituras y reintenta la transacción si el diseño lo permite.

## Validación y reset

Desde devtools (`mysql`, ya instalado):

```bash
mysql -h db -u <db> -p'changeme' -e 'SELECT 1' <db>
```

`infra/reset-db.sh` trunca todas las tablas del esquema desactivando
`FOREIGN_KEY_CHECKS`; los `auto_increment` se reinician — los escenarios no
deben asumir ids de ejecuciones previas.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL` (no MySQL): collations,
`GROUP BY` estricto, funciones de fecha y el comportamiento de IDENTITY
difieren. Toda query no trivial se confirma con escenarios `FL-*` contra el
MySQL real.
