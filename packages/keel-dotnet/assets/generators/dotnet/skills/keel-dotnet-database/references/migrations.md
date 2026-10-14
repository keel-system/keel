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

## Qué no se hace

- No se edita la migración generada para «limpiarla». Si algo sobra o falta, el defecto está en el mapeo, y se
  reporta.
- No se usa `EnsureCreated` fuera de `local` para «arreglar» un baseline que no verifica.
- No se reescribe el baseline una vez desplegado: un cambio de esquema posterior es una migración nueva
  (`dotnet ef migrations add <Nombre>`).
