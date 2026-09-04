# SQL Server (`database: "sqlserver"`)

Lo que build dejó: driver `com.microsoft.sqlserver:mssql-jdbc`, contenedor
`mcr.microsoft.com/mssql/server:2022-latest` (usuario `sa`, password
`Str0ng_Passw0rd1`), URL
`jdbc:sqlserver://localhost:1433;databaseName=<servicio_snake>;encrypt=false`.
`encrypt=false` es **solo** para el contenedor local: en develop/production la
URL real va con TLS (`encrypt=true;trustServerCertificate=false`).

## Tipos y mapeos

- **Fechas**: `datetime2` (no `datetime`, que redondea a ~3ms); es lo que
  genera Hibernate 6 — no lo degrades con `columnDefinition`.
- **Texto**: `nvarchar` para Unicode (default de Hibernate); cuidado con
  `varchar(max)` en índices (no indexable). Añade `sendStringParametersAsUnicode=false`
  a la URL **solo** si hay columnas `varchar` indexadas y ves scans por
  conversión implícita.
- **UUID**: `uniqueidentifier` nativo; ojo con PK clusterizada sobre UUID
  aleatorio (fragmentación) — si el diseño usa UUID como id, considera índice
  cluster en otra columna.
- **Collation** case-insensitive por defecto: claves naturales «únicas» chocan
  por mayúsculas; usa collation `_CS_` en la columna si el diseño distingue casing.
- **Locking optimista**: `@Version Long` va bien; el tipo `rowversion` nativo
  no lo gestiona Hibernate — no lo mezcles.

## Identidad, secuencias y paginación

- SQL Server tiene secuencias nativas: `GenerationType.SEQUENCE` habilita el
  batching de inserts; IDENTITY lo rompe (igual que en MySQL).
- Paginación: Hibernate 6 genera `OFFSET ... FETCH` correcto; toda query
  paginada necesita `ORDER BY` estable (el diseño de paginación de
  `api.keel.yaml` lo exige de todos modos).

## Concurrencia

Lectores bloquean escritores por defecto (a diferencia de PG/MySQL InnoDB):
transacciones cortas importan el doble. Si los escenarios muestran bloqueos de
lectura, la opción de BD `READ_COMMITTED_SNAPSHOT ON` es el arreglo estándar
(decisión de esquema: documéntala).

### Reclamo de un barrido

**No existe `SKIP LOCKED`**: el equivalente son hints de tabla, `WITH (UPDLOCK, READPAST, ROWLOCK)`,
y es lo que emite Hibernate para este dialecto desde el hint `lock.timeout = -2`. La semántica no es
idéntica —`READPAST` salta filas bloqueadas a nivel de fila, así que el `ROWLOCK` importa— y conviene
comprobarlo contra la base real antes de fiarse. El `UPDATE` condicional del reclamo no depende de
nada de esto.

## Validación y reset

Desde devtools (`sqlcmd`, instalado por curl):

```bash
sqlcmd -S db -U sa -P 'Str0ng_Passw0rd1' -C -Q 'SELECT 1'
```

`infra/reset-db.sh` usa `sp_MSforeachtable` (NOCHECK → DELETE → CHECK): usa
`DELETE`, no `TRUNCATE`, así que **las columnas IDENTITY no se reinician** —
los escenarios no deben asumir ids concretos.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL` (no SQL Server): collation
(sensible en H2, insensible aquí), `TOP`/`FETCH`, funciones de fecha y el
comportamiento de bloqueos difieren por completo. Queries no triviales →
escenarios `FL-*` contra el SQL Server real.

## Escribir un UUID y una fecha en una sentencia a mano

```sql
-- el id de una fila: uniqueidentifier acepta el texto entrecomillado
SELECT * FROM jobs WHERE id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
-- un instante infinitamente rancio
UPDATE jobs SET running_since = CAST('1970-01-01T00:00:00Z' AS datetimeoffset) WHERE ...;
```

Dos avisos propios de T-SQL, los dos con forma de sorpresa:

- **`TIMESTAMP '…'` no existe aquí.** En T-SQL `TIMESTAMP` es sinónimo de `ROWVERSION` —un
  contador binario, no una fecha— y el dialecto no admite literales tipados ANSI. Copiar la forma
  de PostgreSQL da un error de tipo, en el mejor caso.
- **`CURRENT_TIMESTAMP` devuelve hora LOCAL del servidor**, no UTC, mientras el código compara
  contra un `Instant`. Para «ahora» en UTC: `SYSUTCDATETIME()`.

⚠ Estos dos literales están **declarados y no ejecutados**: el catálogo los razona, pero nadie ha
corrido `claim-check --database=sqlserver`. Si escribes un SQL a mano y no casa, no fallará: dará
vacío. Confírmalo con una lectura antes de fiarte de una precondición fabricada así.
