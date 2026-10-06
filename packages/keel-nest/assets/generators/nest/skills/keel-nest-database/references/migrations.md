# El baseline de migraciones

En `local` el esquema lo crea TypeORM desde las entidades (`synchronize`). En `develop` y `production` lo
crean **solo** las migraciones de `src/migrations/`, que el arranque aplica (`database.migrations-run`) y
registra en `typeorm_migrations`. Sin ninguna, el servicio arranca contra una base vacía y falla en la
primera petición: no es desplegable aunque todos los escenarios estén en verde (corren en `local`).

El baseline es la primera migración, y solo se puede escribir con las entidades ya definitivas: es del
pase de calidad. build deja el mecanismo; el archivo lo produce el agente.

## Paso a paso (con la infraestructura arriba)

```bash
bash infra/export-schema.sh
```

Vacía el esquema de la base local (`reset-db.sh --schema`), compila y le pide a TypeORM el DDL **completo**
de las entidades. Deja:

- `build/schema/baseline.sql` — las sentencias, para revisarlas;
- `build/schema/1000000000000-baseline-schema.ts` — la migración candidata (`BaselineSchema1000000000000`,
  con su `up` y su `down`).

Revisa `baseline.sql` con esta lista:

- una tabla por raíz, por entidad interna y por cada lista de un campo;
- los nombres `uk_*`, `idx_*`, `fk_*` e `ix_*` (índice de cada FK) intactos: el filtro de errores traduce por ellos;
- `NOT NULL` en cada campo `required`;
- las cotas (`varchar(N)`, `numeric(p,s)`) y la collation forzada de las columnas únicas en MySQL
  (`utf8mb4_bin`);
- los índices únicos condicionados (`WHERE …` en PostgreSQL; la columna `<índice>_flag` en MySQL).

Si todo está, cópiala:

```bash
cp build/schema/1000000000000-baseline-schema.ts src/migrations/
bash infra/verify-baseline.sh
```

`verify-baseline.sh` vacía el esquema, aplica las migraciones —lo mismo que hace el arranque en `develop`
y `production`— y le pide a TypeORM la diferencia con las entidades: tiene que ser **ninguna**. Sale con
`baseline: OK` (código 0) o con `baseline: KO` y la lista de lo que el ORM todavía tendría que cambiar
(código 1).

## Por qué aquí la prueba en vivo SÍ cabe

En keel-spring el baseline se entrega verificado en estático y su prueba en vivo queda para el
diseñador (`baselineTested: PENDING`): probarlo exigiría borrar el volumen sobre el que corre la
no-regresión. Aquí no: en `local` el esquema lo recrea `synchronize` en el siguiente arranque y cada flujo
parte de datos limpios, así que vaciarlo no destruye nada. Por eso `baselineTested` sale `OK` o `KO`,
nunca `PENDING`.

Después de `verify-baseline.sh` la base queda con el esquema de las migraciones y su historial: la
re-ejecución de la suite funciona igual sobre ella.

## Qué no se hace

- No se edita el DDL a mano para «limpiarlo». Si algo sobra o falta, el defecto está en una entidad, y
  se reporta.
- No se activa `synchronize` fuera de `local` para «arreglar» un baseline que no verifica.
- No se reescribe el baseline una vez desplegado: un cambio de esquema posterior es una migración nueva,
  con una marca de tiempo mayor.
