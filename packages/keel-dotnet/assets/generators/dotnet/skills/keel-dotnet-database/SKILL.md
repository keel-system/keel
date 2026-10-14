---
name: keel-dotnet-database
description: Guía de la base de datos relacional en un proyecto generado por keel-dotnet — ampliar un puerto de repositorio y su adaptador EF Core, el baseline de migraciones (crearlo con dotnet ef, revisarlo y verificarlo en vivo), la configuración por perfiles y los fallos típicos; el código de persistencia (filas, mapeo fluente, adaptadores, transacción, traducción de constraints) ya lo genera build. Usar cuando keel-stack.json declara database "postgresql".
---

# Base de datos relacional (EF Core 10 + PostgreSQL)

El código de persistencia sale entero de build: las filas (`Persistence/Rows/<Entidad>Row.cs`) con su mapeo
fluente (`IEntityTypeConfiguration`) sobre el esquema neutral de Keel —los mismos nombres de tabla, columna,
constraint, índice y FK que los servidores de keel-spring y keel-nest del diseño, todos explícitos—, un adaptador
por raíz (`Persistence/Repositories/<Raíz>Repository.cs`, con `ToDomain`/`Apply` explícitos), el `DbContext` y su
fábrica de tiempo de diseño, la transacción que abre el mediator (`IUseCaseTransactions`), el bloqueo optimista,
la auditoría, la unicidad condicionada y la traducción de cada violación de constraint al error del diseño
(`PersistenceErrors`, por el nombre de la constraint). **No rehagas ese patrón**: extiéndelo.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: mapeo, claves naturales, índices y `consistency`.
- Sigue `{{keel:docs}}/conventions/mapping.md` § persistence.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | ampliar un puerto de `Domain/Repository` **y** su adaptador cuando un handler necesita una consulta que build no derivó | `references/repository-adapters.md` |
| calidad | el **baseline de migraciones**: revisar el DDL del modelo, crear la migración con `dotnet ef` y verificarla en vivo | `references/migrations.md` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |
| cualquiera | qué lee cada perfil | `references/configuration.md` |

## Reglas que no se rompen

- Ningún handler ni endpoint ve el `DbContext`, un `DbSet`, un `IQueryable` ni una fila: Application no referencia
  EF Core, así que no compilaría; no se le añade la referencia.
- El adaptador usa **siempre** el `DbContext` que recibe por constructor (el del ámbito de la petición, el de la
  transacción del mediator): uno creado aparte escribiría fuera de la transacción y un rollback no lo desharía.
- Los nombres de constraint, índice y FK del mapeo son **contrato**: `PersistenceErrors` traduce por ellos al
  `code` del diseño, y los otros dos servidores usan los mismos. No se renombran. Un índice nuevo lleva SIEMPRE su
  nombre (`HasIndex(…, "idx_…")`): EF identifica un índice sin nombre por sus columnas, y dos sobre las mismas
  columnas se funden en uno.
- `EnsureCreated` solo en `local`. En `develop` y `production` el esquema es el de las migraciones.
- Un filtro con `compare: ignore-case` o `ignore-case-accents` (en el campo o solo en la query) va contra la
  columna sombra `<campo>_normalized` que build emite y estampa, con el término plegado por `TextFold`
  (`Persistence/TextFold.cs`). Nunca `ToLower()` en la consulta, `EF.Functions.ILike`, `unaccent()` ni la
  collation: son otra función de plegado, y el mismo diseño servido por keel-spring pliega con `TextFold` — el
  listado devolvería filas distintas en los servidores.
- `LockVersion` no se toca: el adaptador ya fija la versión leída como valor original del token de concurrencia
  y lo traduce a 409.
