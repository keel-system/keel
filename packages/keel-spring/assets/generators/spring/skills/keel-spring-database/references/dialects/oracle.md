# Oracle (`database: "oracle"`)

Lo que build dejó: driver `com.oracle.database.jdbc:ojdbc11`, contenedor
`gvenzl/oracle-free:23-slim` (usuario = nombre de la BD, password `changeme`,
service `FREEPDB1`), URL `jdbc:oracle:thin:@//localhost:1521/FREEPDB1`.

## Tipos y mapeos

- **Cadena vacía = NULL**: la trampa clásica de Oracle. Un `String` vacío se
  guarda como NULL: una columna `NOT NULL` rechaza `""`, y `campo = ''` nunca
  matchea. Si el diseño distingue vacío de ausente, modélalo (p. ej. normaliza
  a NULL en el dominio) y cúbrelo con un escenario.
- **Números**: todo es `NUMBER`; Hibernate mapea bien `Long`/`BigDecimal` —
  revisa precisión/escala en importes (`@Column(precision, scale)` según el
  diseño).
- **Texto**: `varchar2(n)` limitado (4000 bytes estándar); texto largo →
  `clob` (`@Lob`). Ojo: los `CLOB` no entran en `DISTINCT`/`GROUP BY`.
- **UUID**: sin tipo nativo; Hibernate usa `raw(16)`. Legible → `varchar2(36)`
  con `@JdbcTypeCode(SqlTypes.CHAR)` (más grande en índices).
- **Booleanos**: Oracle 23 ya tiene `boolean` nativo y Hibernate 6 lo usa;
  en DDL heredado verás `number(1,0)` — ambos funcionan.
- Identificadores en MAYÚSCULAS por defecto: no cites (`"nombre"`) columnas en
  `columnDefinition` salvo que quieras casing exacto para siempre.

## Secuencias

Territorio natural de Oracle: `GenerationType.SEQUENCE` (batching de inserts
funciona). Hibernate crea `<tabla>_seq` con `ddl-auto: update`; el esquema
definitivo debe fijar `CACHE` razonable (20+) para evitar contención.

## Concurrencia

MVCC como PG: lectores no bloquean escritores; `@Version` encaja. `SELECT FOR
UPDATE` solo si el diseño lo exige. `ORA-00060` (deadlock) → ordena updates.

## Validación y reset

`sqlplus` vive **dentro del contenedor de Oracle** (no en devtools — el
Instant Client es demasiado pesado):

```bash
docker compose -f infra/docker-compose.yaml exec db \
  bash -c "echo 'SELECT 1 FROM dual;' | sqlplus -s <user>/changeme@//localhost:1521/FREEPDB1"
```

`infra/reset-db.sh` trunca todas las tablas del usuario (`user_tables`) con
`TRUNCATE ... CASCADE`; las secuencias **no** se reinician — los escenarios no
deben asumir ids concretos. El contenedor tarda en arrancar la primera vez
(crea la PDB): espera el healthy antes de validar.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL` (no Oracle): la semántica
`'' = NULL`, `NUMBER`, `dual`, funciones y secuencias difieren. Todo lo que
toque esas áreas se confirma con escenarios `FL-*` contra el Oracle real.
