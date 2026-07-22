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

## Obtener un token para llamadas autenticadas

Con capa `security`, los escenarios necesitan un Bearer token:

- **Keycloak**: tras crear el realm/cliente, `curl` al endpoint
  `http://localhost:8180/realms/<realm>/protocol/openid-connect/token`
  (`grant_type=password` o `client_credentials`) y usa el `access_token`.
- **Cognito** (cognito-local): crea el user pool + client con la AWS CLI apuntando a
  `http://localhost:9229` y obtén el token con `InitiateAuth`.

La app corre en el **host** (`./gradlew bootRun`), así que las llamadas HTTP a los
endpoints van a `http://localhost:8080/...` desde el host (no desde devtools);
`devtools` es para la **infraestructura**, no para la app.
