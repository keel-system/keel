# Validación de infraestructura vía `devtools`

Guía para el agente: cómo comprobar mecánicamente que la infraestructura de prueba
(la de `infra/docker-compose.yaml` generado) responde, usando el contenedor `devtools`.
Es el trabajo del agente `keel-spring-infra` (fase de infraestructura de la
orquestación de `/keel-generate-spring`), **después** de levantar el compose y
**antes** de que se ejerciten los escenarios: si la infra no está lista, un
escenario que falle no distingue bug de dependencia caída.

## Camino rápido

Desde la raíz del proyecto (con podman, exporta `CONTAINER_RUNTIME=podman` y usa
`podman compose`):

```bash
docker compose -f infra/docker-compose.yaml up -d   # levanta BD/broker/cache/storage/auth + devtools
bash infra/validate-infra.sh                        # un check por tecnología del stack; sale != 0 si algo falla
```

`infra/validate-infra.sh` ejecuta, por cada tecnología elegida en `keel-stack.json`, su
comando de sondeo dentro del contenedor que corresponde. Si todo responde, imprime
`Infraestructura OK.`; si no, lista los `FALLO` y sale con `1`.

## Patrón manual

El contenedor `<servicio>-devtools` trae solo las CLIs del stack y alcanza a los
servicios por su nombre de red. Para sondear a mano o inspeccionar datos:

```bash
docker exec <servicio>-devtools <cli> <args>
```

| Tecnología | Servicio (red) | Comando de sondeo (desde devtools salvo nota) |
|---|---|---|
| PostgreSQL | `db` | `PGPASSWORD=<pass> psql -h db -U <user> -d <db> -c 'SELECT 1'` |
| MySQL | `db` | `mysql -h db -u <user> -p<pass> -e 'SELECT 1' <db>` |
| MariaDB | `db` | `mariadb -h db -u <user> -p<pass> -e 'SELECT 1' <db>` |
| SQL Server | `db` | `sqlcmd -S db -U sa -P '<pass>' -C -Q 'SELECT 1'` |
| Oracle | `db` | `echo 'SELECT 1 FROM dual;' \| sqlplus -s <user>/<pass>@//localhost:1521/FREEPDB1` **(dentro de `<servicio>-db`, no en devtools)** |
| Kafka | `kafka` | `kcat -b kafka:29092 -L` (listener interno; el host usa `localhost:9092`) |
| RabbitMQ | `rabbitmq` | `curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node` |
| SNS/SQS (LocalStack) | `localstack` | `aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` |
| Redis | `redis` | `redis-cli -h redis PING` |
| Valkey | `valkey` | `redis-cli -h valkey PING` |
| MinIO | `minio` | `mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local` |
| Keycloak | `keycloak` | `curl -sf http://keycloak:8080/realms/master` |
| Cognito | `cognito` | `curl -sf http://cognito:9229/health` |

Las credenciales concretas son las de `infra/docker-compose.yaml` (usuario = nombre del
servicio con guiones bajos, password `changeme` para las BD abiertas; `sa` /
`Str0ng_Passw0rd1` para SQL Server; `minioadmin`/`guest` en storage/broker).

## Inspeccionar estado durante los escenarios

`devtools` sirve además para verificar el **Then** de un escenario sin depender solo
de la API:

- **BD**: `docker exec <servicio>-devtools psql -h db -U <user> -d <db> -c 'SELECT ...'`
  (o el cliente que corresponda) para comprobar filas escritas/estados.
- **Kafka**: `kcat -b kafka:29092 -t <servicio>.events -o -1 -e -q` lee los últimos
  eventos publicados.
- **RabbitMQ**: la management API (`curl -u guest:guest http://rabbitmq:15672/api/queues`).
- **SNS/SQS**: `aws --endpoint-url http://localstack:4566 sqs receive-message
  --queue-url <url> --visibility-timeout 0`.
- **MinIO**: `mc ls local/<bucket>` para confirmar objetos subidos.

## Reset de datos entre flujos (`infra/reset-db.sh`)

Los `Given` de los flujos `FL-*` de `specs/validation-scenarios.md` asumen **BD
limpia**: cada flujo es auto-contenido (su primer escenario crea los datos que los
siguientes verifican). Sin reset, re-ejecutar un flujo de creación devuelve `409` en
vez de `201`, las claves únicas colisionan y el ciclo de corrección
código→validación no converge.

Por eso el agente de validación funcional ejecuta los flujos **secuencialmente** y,
**antes de cada flujo** (también al re-validar tras un fix):

```bash
bash infra/reset-db.sh    # respeta CONTAINER_RUNTIME; datos fuera, esquema intacto
```

El script vacía los datos vía el CLI de la BD del stack (mismo mecanismo devtools
que `validate-infra.sh`) **preservando el esquema** (lo crea Hibernate); las tablas
de outbox/idempotencia, si existen, son tablas del mismo esquema y quedan incluidas.
El reset es **por flujo, no entre escenarios**: dentro de un flujo el escenario A
crea el estado que el escenario B necesita (p. ej. el duplicado que B verifica).

- Si el `Given` de un flujo depende de datos creados por **otro** flujo, tras el
  reset no se sostiene: es un hueco del diseño → repórtalo, no siembres datos a mano.
- Con **H2** (en memoria, sin contenedor) no hay script: reiniciar la aplicación
  entre flujos recrea el esquema vacío.

## Obtener un token para llamadas autenticadas

Con capa `security`, los escenarios necesitan un Bearer token:

- **Keycloak**: tras crear el realm/cliente, `curl` al endpoint
  `http://localhost:8180/realms/<realm>/protocol/openid-connect/token`
  (`grant_type=password` o `client_credentials`) y usa el `access_token`.
- **Cognito** (cognito-local): crea el user pool + client con la AWS CLI apuntando a
  `http://localhost:9229` y obtén el token con `InitiateAuth`.

Si el diseño declara endpoints M2M (`audience: services`/`both` + `serviceAuth`),
los escenarios `level: service` usan **credencial de máquina**, no token de
usuario: `grant_type=client_credentials` con el cliente del `serviceClient`
(receta en la skill del proveedor), o el header `X-API-Key` con la clave de
`security.api-keys.<cliente>` si `serviceAuth` es `api-key`. Ejercita también el
403 (cliente sin el scope) y, con `validateAudience`, el 401 por audiencia ajena.

Las claves de API **ya vienen configuradas** en `src/main/resources/parameters/local/security.yaml`
(`security.api-key: local-dev-api-key` y `security.api-keys.<cliente>: local-<cliente>-key`): úsalas
tal cual en los escenarios, no las inventes ni edites el YAML. Cambiarlas solo tiene sentido para
ejercitar el 401 con clave inválida.

La app corre en el **host** (`./gradlew bootRun`), así que las llamadas HTTP a los
endpoints van a `http://localhost:8080/...` desde el host (no desde devtools);
`devtools` es para la **infraestructura**, no para la app.
