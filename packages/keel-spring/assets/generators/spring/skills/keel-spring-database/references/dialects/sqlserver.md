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
