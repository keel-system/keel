# La infraestructura de prueba (`infra/`)

`infra/` es la **misma** que la del servidor de keel-spring del mismo diseño: los mismos contenedores,
con los mismos nombres, sondeados y reseteados del mismo modo (la escribe el núcleo neutral de Keel).
Contra ella corren los escenarios `FL-*`.

## Camino rápido

```bash
bash infra/up.sh             # levanta (resuelve docker o podman, y el frontend de compose)
bash infra/validate-infra.sh # sondea cada tecnología; reintenta, porque 'Up' no es 'listo'
bash infra/down.sh           # para (conserva volúmenes); --volumes los borra
```

Con podman, `export CONTAINER_RUNTIME=podman`. `up.sh` no se sustituye por un `compose up -d` a mano:
resuelve además el frontend de compose, y en Windows con podman eso no es adivinable.

## Cómo se sondea

`validate-infra.sh` ejecuta la CLI de cada tecnología dentro del contenedor `devtools` (una caja Alpine con
solo las CLIs del stack) o del propio contenedor de la base. Un `FALLO` que persiste se contrasta con el
**efecto** antes de darlo por bueno o por malo: una sentencia contra la base, por ejemplo:

```bash
docker exec <servicio>-devtools sh -c "PGPASSWORD=changeme psql -h db -U <base> -d <base> -c 'SELECT 1'"
```

Si el efecto es correcto y el check falla, el sondeo del generador está desalineado: es un defecto del
**generador** (`validateInfra: FALSO-NEGATIVO`), no se parchea `validate-infra.sh` en el proyecto.

## El proveedor de identidad (capa `security` con Keycloak)

`infra/init-keycloak.sh` siembra el realm de prueba con los valores de `infra/test-credentials.env` —el
mismo archivo del que el arnés lee cliente, contraseña y secretos—: un solo productor y un solo
consumidor. Se ejecuta tras `up.sh` y antes de los flujos; es idempotente. Con Cognito no hay nada que
sembrar: el emulador arranca con `infra/cognito/mock-oauth2-config.json`. Detalle en la skill del
proveedor (`keel-nest-keycloak`, `keel-nest-cognito`).

```bash
bash infra/init-keycloak.sh
curl -s -d 'grant_type=password&client_id=<servicio>-nest-test&username=<rol>&password=password' \
  http://localhost:8180/realms/<servicio>/protocol/openid-connect/token
```

## Reset entre flujos (`infra/reset-db.sh`)

Deja el estado como recién arrancado: **vacía los datos** de la base, preservando el esquema y la tabla
de historial de migraciones (`typeorm_migrations`). Lo llama `useFlow()` al empezar cada flujo.

```bash
bash infra/reset-db.sh           # datos
bash infra/reset-db.sh --schema  # además, RECREA el esquema
```

`--schema` es para después de regenerar entidades: el `synchronize` de TypeORM no sabe renombrar y falla
al añadir un `NOT NULL` sobre una tabla con filas. En `local` el siguiente arranque recrea el esquema
desde las entidades.

Lo que no esté en la lista que imprime el script **no** se puede dar por limpio.

## El baseline de migraciones

```bash
bash infra/export-schema.sh      # DDL de las entidades → build/schema/ (vacía el esquema local)
bash infra/verify-baseline.sh    # aplica src/migrations/ sobre un esquema vacío y exige cero diferencias
```

Los dos vacían el esquema de la base local antes de trabajar: es inocuo (lo recrea `synchronize` en el
siguiente arranque y los flujos parten de datos limpios). Detalle en la skill `keel-nest-database`.

## Inspeccionar durante un escenario

Para **explicar** un fallo se puede mirar la base (con `db(...)` desde una prueba, o con `docker exec`
como arriba). Inspeccionar por dentro sirve para explicar, jamás para definir el criterio de aceptación:
el `Then` se afirma por la API.
