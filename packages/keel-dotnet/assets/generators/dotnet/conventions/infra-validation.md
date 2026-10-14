# La infraestructura de prueba (`infra/`)

`infra/` es la **misma** que la de los servidores de keel-spring y keel-nest del mismo diseño: los mismos
contenedores, con los mismos nombres, sondeados y reseteados del mismo modo (la escribe el núcleo neutral de
Keel). Contra ella corren los escenarios `FL-*`.

## Camino rápido

```bash
bash infra/up.sh             # levanta (resuelve docker o podman, y el frontend de compose)
bash infra/validate-infra.sh # sondea cada tecnología; reintenta, porque 'Up' no es 'listo'
bash infra/down.sh           # para (conserva volúmenes); --volumes los borra
```

Con podman, `export CONTAINER_RUNTIME=podman`. `up.sh` no se sustituye por un `compose up -d` a mano: resuelve
además el frontend de compose, y en Windows con podman eso no es adivinable.

## Cómo se sondea

`validate-infra.sh` ejecuta la CLI de cada tecnología dentro del contenedor `devtools` (una caja Alpine con solo
las CLIs del stack) o del propio contenedor de la base. Un `FALLO` que persiste se contrasta con el **efecto**
antes de darlo por bueno o por malo: una sentencia contra la base, por ejemplo:

```bash
docker exec <servicio>-devtools sh -c "PGPASSWORD=changeme psql -h db -U <base> -d <base> -c 'SELECT 1'"
```

Si el efecto es correcto y el check falla, el sondeo del generador está desalineado: es un defecto del
**generador** (`validateInfra: FALSO-NEGATIVO`), no se parchea `validate-infra.sh` en el proyecto.

## Reset entre flujos (`infra/reset-db.sh`)

Deja el estado como recién arrancado: **vacía los datos** de la base, preservando el esquema y la tabla de
historial de migraciones de EF Core (`ef_migrations_history`). Lo llama la base de los flujos (`FlowTest`) al
empezar cada flujo.

```bash
bash infra/reset-db.sh           # datos
bash infra/reset-db.sh --schema  # además, RECREA el esquema
```

`--schema` es para después de regenerar el mapeo: el `EnsureCreated` del perfil `local` solo crea el esquema
cuando la base no tiene ninguna tabla, así que una columna nueva no llega nunca a una base que ya existe. Con el
esquema recreado, el siguiente arranque lo vuelve a crear desde el modelo.

Lo que no esté en la lista que imprime el script **no** se puede dar por limpio.

## El baseline de migraciones

```bash
bash infra/export-schema.sh      # el DDL que el modelo de EF crearía → build/schema/model.sql (sin base)
bash infra/verify-baseline.sh    # las migraciones, sin cambios pendientes y aplicadas a una base vacía = el modelo
```

`verify-baseline.sh` trabaja sobre una base APARTE, que crea y borra en el mismo contenedor: la de los flujos no
se toca. Detalle en la skill `keel-dotnet-database`.

## El servidor de los flujos

La suite arranca el servidor como un proceso aparte (el `dll` del Api compilado), y su salida va a
`build/keel-scenarios/server.log`. Un `dotnet run` olvidado de otra sesión escribe en la misma base: si un
escenario ve datos que nadie creó, ciérralo (`validate-infra.sh` avisa si el puerto 8080 está ocupado).

## Inspeccionar durante un escenario

Para **explicar** un fallo se puede mirar la base (con `Db(...)` desde una prueba, o con `docker exec` como
arriba). Inspeccionar por dentro sirve para explicar, jamás para definir el criterio de aceptación: el `Then` se
afirma por la API.
