# El baseline de migraciones

En `local` el esquema lo crea EF Core desde el modelo (`EnsureCreated`, sobre una base vacía). En `develop` y
`production` lo crean **solo** las migraciones, que el arranque aplica (`database.schema: migrate`) y registra en
`ef_migrations_history`. Sin ninguna, el servicio arranca contra una base vacía y falla en la primera petición: no
es desplegable aunque todos los escenarios estén en verde (corren en `local`).

El baseline es la primera migración, y solo se puede escribir con el modelo ya definitivo: es del pase de calidad.
Build deja el mecanismo; la migración la crea `dotnet ef` (herramienta local, versión fijada en
`.config/dotnet-tools.json`) desde el modelo, a través de la fábrica de tiempo de diseño: no se escribe a mano.

## Paso a paso (con la infraestructura arriba y la solución compilando)

```bash
bash infra/export-schema.sh
```

Deja `build/schema/model.sql`: el DDL **completo** que el modelo crearía, sin tocar ninguna base. Revísalo con esta
lista:

- una tabla por raíz, por entidad interna y por cada lista de un campo;
- la PK como `<tabla>_pkey` y los nombres `uk_*`, `idx_*`, `fk_*` e `ix_*` (índice de cada FK) intactos: el
  traductor de errores traduce por ellos. Ninguno puesto por EF (`PK_`, `FK_`, `IX_`, `AK_`);
- `NOT NULL` en cada campo `required`;
- las cotas (`character varying(N)`, `numeric(p,s)`);
- los índices únicos condicionados con su `WHERE …`.

Si todo está, crea el baseline y verifícalo:

```bash
dotnet ef migrations add Baseline --project src/<Raíz>.Infrastructure --output-dir Persistence/Migrations
bash infra/verify-baseline.sh
```

`verify-baseline.sh` comprueba tres cosas y sale con `baseline: OK` (código 0) o con `baseline: KO` y la
diferencia (código 1):

1. que hay migraciones en `Persistence/Migrations/`;
2. que el modelo no tiene cambios que ninguna recoja (`dotnet ef migrations has-pending-model-changes`);
3. que, aplicadas a una base **vacía**, dejan el mismo catálogo (columnas, índices y constraints) que el DDL del
   modelo. Es el que caza una migración editada a mano: el snapshot del modelo no cambia con ella, así que el paso
   2 no la ve.

Trabaja sobre dos bases aparte que crea y borra en el contenedor de la base de prueba: la de los flujos no se
toca, y la no-regresión sigue funcionando después.

## Las migraciones `<marca>_Keel*.cs` las escribe build

Cuando una tabla del generador (`outbox_event`, `processed_event`, `idempotency_record`, `reconciliation_claim`,
`keel_timer`) aparece en un proyecto que ya tiene migraciones —el diseño ganó un outbox o una idempotencia después
del baseline—, `keel-dotnet build` escribe en `Persistence/Migrations/` la migración que la crea: una clase
`Migration` con `migrationBuilder.Sql(...)` y `CREATE TABLE IF NOT EXISTS`, con la marca siguiente a la última que
hay en disco, y `EVOLUTION.md` la nombra. Es el mismo SQL que dejan los otros tres generadores.

- **No la edites, no la renumeres y no la borres**: una base que ya la aplicó no la vuelve a leer, y build la vuelve a
  emitir tal cual en cada pasada. No lleva `.Designer.cs`, y es a propósito.
- **No repitas sus tablas** en una migración tuya. Las tuyas van después, con `dotnet ef migrations add`, que ya
  pone una marca posterior.
- **Lo que build no puede hacer es el snapshot** (`<Contexto>ModelSnapshot.cs`), que solo escribe `dotnet ef`. Mientras
  no nombre la tabla, EF ve el modelo por delante (`PendingModelChangesWarning`), `verify-baseline.sh` sale en `KO`
  (paso 2) y el siguiente `migrations add` volvería a crear la tabla, que en la base desplegada ya existe. Que el
  arranque se niegue a migrar depende del proveedor: medido con `dotnet ef database update`, en PostgreSQL sale en
  rojo con ese aviso y en MySQL avisa y aplica igual. No cuentes con ninguna de las dos. `EVOLUTION.md` lo pide hasta que esté hecho, y `keel-dotnet build --check` sale en rojo. Se
  cierra con una migración que **solo** sincroniza el snapshot:

  ```bash
  dotnet ef migrations add Sync<Tabla>Snapshot --project src/<Raíz>.Infrastructure --output-dir Persistence/Migrations
  ```

  y en la migración que crea **vacías los cuerpos de `Up` y `Down`** (la tabla ya la crea el paso de build): el
  `.Designer.cs` y el snapshot se quedan como los deja `dotnet ef`. Es la única migración generada que se edita, y
  solo así. Después, `bash infra/verify-baseline.sh` tiene que dar `baseline: OK`: el paso 3 compara lo que crea el SQL
  de build con el DDL del modelo, columna a columna.
- **Nunca `dotnet ef migrations remove`** con una migración de build entre las dos últimas: reconstruye el snapshot
  desde el modelo de destino de la anterior, y la de build no tiene.
- Lo que build no hace es cambiar la forma de una tabla suya que la base ya tiene; si eso pasa, lo dice
  `EVOLUTION.md` y la migración es tuya.

## Qué no se hace

- No se edita la migración generada para «limpiarla». Si algo sobra o falta, el defecto está en el mapeo, y se
  reporta.
- No se usa `EnsureCreated` fuera de `local` para «arreglar» un baseline que no verifica.
- No se reescribe el baseline una vez desplegado: un cambio de esquema posterior es una migración nueva
  (`dotnet ef migrations add <Nombre>`).
