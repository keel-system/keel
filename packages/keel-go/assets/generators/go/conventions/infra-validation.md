# La infraestructura de prueba (`infra/`)

`infra/` es la **misma** que la de los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño: los
mismos contenedores, con los mismos nombres, sondeados y reseteados del mismo modo (la escribe el núcleo neutral de
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
docker exec <servicio>-devtools sh -c "PGPASSWORD=changeme psql -h db -U <base> -d <base> -c 'SELECT 1'"   # PostgreSQL
docker exec <servicio>-devtools sh -c "mysql -h db -u <base> -pchangeme -e 'SELECT 1' <base>"            # MySQL
```

Si el efecto es correcto y el check falla, el sondeo del generador está desalineado: es un defecto del
**generador** (`validateInfra: FALSO-NEGATIVO`), no se parchea `validate-infra.sh` en el proyecto.

## El proveedor de identidad (con capa `security`)

Con Keycloak, el realm de prueba lo siembra `bash infra/init-keycloak.sh` **después** de `up.sh` y antes de
`validate-infra.sh`: realm, roles, dos usuarios por rol (`<rol>` y `<rol>-2`), `no-role`, los clientes del diseño
y la matriz `test-m2m-*`. Es idempotente y no se edita. Lo que crea lo escribe build en
`infra/test-credentials.env`, y es lo que lee el arnés de los flujos: un solo productor, un solo consumidor. Con
Cognito no hay nada que sembrar: el emulador arranca con su configuración. El detalle, en la skill del proveedor
(`keel-go-keycloak` o `keel-go-cognito`).

## El esquema

Lo crean las migraciones de goose embebidas en el binario (`internal/infrastructure/<motor>/migrations/`), que el
servidor aplica **al arrancar, en todos los perfiles**: no hay un esquema creado desde el código en `local` y otro
por migraciones en `production`. El historial lo lleva la tabla `goose_db_version`. Dos réplicas que arrancan a la
vez no aplican la misma migración dos veces: goose las serializa.

## Reset entre flujos (`infra/reset-db.sh`)

Deja el estado como recién arrancado: **vacía los datos** de la base, preservando el esquema y el historial de
goose (`goose_db_version`). Lo llama `StartFlow` al empezar cada flujo.

```bash
bash infra/reset-db.sh           # datos
bash infra/reset-db.sh --schema  # además, RECREA el esquema (historial incluido)
```

`--schema` es para después de regenerar el esquema: goose solo aplica las migraciones que su historial no tiene, así
que una baseline reescrita no llega nunca a una base que ya la aplicó. Con el esquema recreado, el siguiente
arranque del servidor vuelve a aplicar la baseline.

Vaciar el historial sin el esquema deja una base que el servidor ya no puede arrancar (goose intenta crear tablas
que existen): por eso el reset de datos no lo toca. Lo que no esté en la lista que vacía el script **no** se puede
dar por limpio.

## El servidor de los flujos

La suite compila el servidor (`go build` de `./cmd/server` a `build/keel-scenarios/`) y lo arranca como un proceso
aparte bajo el perfil `local`, en `127.0.0.1` y un puerto libre; su salida va a `build/keel-scenarios/server.log`.
Lo para al terminar la suite. Un `go run ./cmd/server` olvidado de otra sesión escribe en la misma base: si un
escenario ve datos que nadie creó, ciérralo (`validate-infra.sh` avisa si el puerto 8080 está ocupado).

## Inspeccionar durante un escenario

Para **explicar** un fallo se puede mirar la base (con `s.Db(...)` desde una prueba, o con `docker exec` como
arriba). Inspeccionar por dentro sirve para explicar, jamás para definir el criterio de aceptación: el `Then` se
afirma por la API.
