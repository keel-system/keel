# Validación de infraestructura vía `devtools`

Guía para el agente: cómo comprobar mecánicamente que la infraestructura de prueba
(la de `infra/docker-compose.yaml` generado) responde, usando el contenedor `devtools`.

> El proyecto tiene **dos** composes y este documento habla solo del primero.
> `infra/` es la infraestructura de la generación, con la app corriendo fuera.
> `deploy/` es el servicio ya empaquetado en su imagen, para que una persona lo
> pruebe a mano; no lleva `devtools` ni scripts de sondeo, se levanta con
> `bash deploy/up.sh` y **ninguna fase de la generación lo enciende**: es del
> diseñador. La comparación completa está en `conventions/project-layout.md`.
> No los levantes a la vez: publican los mismos puertos.
Es el trabajo del agente `keel-spring-infra` (fase de infraestructura de la
orquestación de `/keel-generate-spring`), **después** de levantar el compose y
**antes** de que se ejerciten los escenarios: si la infra no está lista, un
escenario que falle no distingue bug de dependencia caída.

## Camino rápido

Desde la raíz del proyecto (con podman, exporta `CONTAINER_RUNTIME=podman`):

```bash
bash infra/up.sh              # levanta BD/broker/cache/storage/auth + devtools
bash infra/validate-infra.sh  # un check por tecnología del stack; sale != 0 si algo falla
```

Son **dos** pasos porque levantar no es estar listo: Kafka, Keycloak y LocalStack
publican su listener bastante después de que el contenedor esté `Up`, y quien reintenta
es el segundo script.

`infra/up.sh` no es un alias de `compose up -d`: además del runtime resuelve el
**frontend** de compose. `podman compose` no implementa compose, delega en el binario de
Docker Compose que encuentre en el PATH — que puede responder `version` perfectamente y
aun así no alcanzar el motor de podman (en Windows es lo habitual: busca el named pipe de
Docker Desktop). El síntoma de saltarse el script es un error de socket sin una sola
mención a compose. El sondeo correcto es `compose ls`, que para contestar tiene que
llegar al motor, y el fallback es `podman-compose`. Para pararlo, `bash infra/down.sh`
(con `--volumes` si además quieres que la base vuelva a nacer vacía).

`infra/validate-infra.sh` ejecuta, por cada tecnología elegida en `keel-stack.json`, su
comando de sondeo dentro del contenedor que corresponde. Si todo responde, imprime
`Infraestructura OK.`; si no, lista los `FALLO` y sale con `1`.

Cada check reintenta antes de darse por vencido (5 intentos separados 5s,
ajustables con `KEEL_CHECK_RETRIES` / `KEEL_CHECK_DELAY`), porque que el contenedor
reporte `Up` no significa que su listener acepte conexiones: Keycloak en `start-dev`,
Kafka y LocalStack tardan un margen en publicarlo, y un sondeo inmediato tras
`up -d` daría un `FALLO` que a la segunda pasada es verde. Un `FALLO` del script es
por tanto una dependencia realmente caída, no un arranque lento: no lo repitas a
mano esperando que cambie, diagnostica el contenedor.

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
| MongoDB | `db` | `mongosh '<uri>' --quiet --eval 'rs.status().ok'` **(dentro de `<servicio>-db`, no en devtools)** — ver la nota de abajo |
| Kafka | `kafka` | `kcat -b kafka:29092 -L` (listener interno; el host usa `localhost:9092`) |
| RabbitMQ | `rabbitmq` | `curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node` |
| SNS/SQS (LocalStack) | `localstack` | `aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` |
| Redis | `redis` | `redis-cli -h redis PING` |
| Valkey | `valkey` | `redis-cli -h valkey PING` |

**MongoDB no se sondea con un ping, y es deliberado.** El servicio arranca como
replica set de un miembro porque las transacciones multi-documento lo exigen (el
agregado y su `outbox_event` tienen que entrar en el mismo commit). Una base que
responde al ping pero cuyo replica set no ha arrancado **pasaría el check** y
fallaría en la primera escritura con «Transaction numbers are only allowed on a
replica set member» — un falso positivo de manual, tres fases más tarde. `rs.status()`
lanza mientras el conjunto no exista, así que el fallo sale aquí. Igual que Oracle, se
ejecuta dentro del propio contenedor: `mongosh` viene en su imagen.
| MinIO | `minio` | `mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local` |
| Keycloak | `keycloak` | `curl -sf http://keycloak:8080/realms/master` |
| Cognito | `cognito-mock` | `curl -sf http://cognito-mock:8080/isalive` |

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

## Reset de estado entre flujos (`infra/reset-db.sh`)

Los `Given` de los flujos `FL-*` de `specs/validation-scenarios.md` asumen **estado
limpio**: cada flujo es auto-contenido (su primer escenario crea los datos que los
siguientes verifican). Sin reset, re-ejecutar un flujo de creación devuelve `409` en
vez de `201`, las claves únicas colisionan y el ciclo de corrección
código→validación no converge.

Por eso cada clase de flujo (`<Flow>FlowIT`, ver [integration-tests](integration-tests.md))
llama a `resetState()` desde su `@BeforeAll`, y ese método ejecuta:

```bash
bash infra/reset-db.sh    # respeta CONTAINER_RUNTIME; datos, caché, canales y buckets fuera, esquema intacto
```

### Qué recursos cubre el reset — y qué no

El script enumera en su cabecera exactamente lo que deja limpio, según el stack elegido:

| Recurso | Qué hace |
|---|---|
| Base de datos | vacía los datos preservando el esquema (y `flyway_schema_history`, ver abajo) |
| Caché | borra las claves `<servicio>:*` (cachés e idempotencia comparten prefijo) |
| Destinos de mensajería | purga cada canal declarado en `messaging.keel.yaml § channels` |
| Buckets | vacía el **contenido** de cada bucket declarado en `storage.keel.yaml`, no el bucket: recrearlo es del sidecar `minio-init`, que solo corre al levantar la infraestructura, y con él se iría la policy pública |
| Stub de proveedores | reinicia mappings y log de peticiones de WireMock |
| Buzón de correo | vacía el buzón de Mailpit. Un correo del flujo anterior sigue ahí y el primer `awaitMailTo` del siguiente devolvería el mensaje equivocado — el mismo fallo que la purga de los canales evita en el broker |

En Kafka no hay purga posible (kcat no borra registros), así que su equivalente lo aplica
`AbstractFlowIT.resetState()`: una **marca de offset** por destino, tras la cual
`publishedMessages(...)` solo ve lo publicado después. El efecto observable es el mismo.

**Un recurso que no esté en esa tabla no se da por limpio.** Suponerlo por analogía con la
base de datos es un error caro: no falla en la primera corrida —todo está vacío— sino
varias sesiones de trabajo después, cuando el recurso lleva cientos de mensajes acumulados
y media suite empieza a leer lo que publicó otra corrida. Si un escenario depende de un
recurso que el reset no cubre, o lo limpia el propio test o va a `assumptions` del reporte.

El script y su exclusión de `flyway_schema_history` no cambian: lo que cambia es quién lo
invoca — antes el agente entre tanda y tanda de `curl`, ahora el hook `@BeforeAll` de la
clase. También se puede ejecutar a mano para diagnosticar.

El script vacía los datos vía el CLI de la BD del stack (mismo mecanismo devtools
que `validate-infra.sh`) **preservando el esquema**; las tablas de
outbox/idempotencia, si existen, son tablas del mismo esquema y quedan incluidas.
Con una base **relacional**, una tabla queda fuera a propósito:
`flyway_schema_history`, el historial de migraciones. No son datos del servicio, y
truncarlo haría que el siguiente arranque con migraciones activas intentase reaplicar
el baseline sobre tablas existentes y fallara. No quites esa exclusión del script.

Con una base **documental** no hay historial que excluir (no hay migraciones), pero
sí un equivalente: el reset vacía los documentos y **preserva las colecciones y sus
índices**. Los índices son el esquema aquí, y recrearlos en cada flujo sería el mismo
error con otro nombre.
El reset es **por flujo, no entre escenarios**: dentro de un flujo el escenario A
crea el estado que el escenario B necesita (p. ej. el duplicado que B verifica).

- Si el `Given` de un flujo depende de datos creados por **otro** flujo, tras el
  reset no se sostiene: es un hueco del diseño → repórtalo, no siembres datos a mano.
- Con **H2** (en memoria, sin contenedor) no hay script de BD: `AbstractFlowIT` lleva
  `@DirtiesContext(BEFORE_CLASS)` y recrear el contexto antes de cada clase de flujo
  recrea el esquema vacío.

### Cuando el esquema queda a medio camino: `reset-db.sh --schema`

En `local` el esquema lo pone Hibernate con `ddl-auto: update`, y `update` **solo añade**:
nunca elimina una columna que ya no mapea ninguna entidad ni afloja un `NOT NULL`
preexistente. Regenerar el proyecto después de cambiar el diseño (quitar un campo, dejar de
usar bloqueo optimista, renombrar) deja por tanto columnas huérfanas en las tablas — y una
columna huérfana `NOT NULL` hace fallar **todo** `INSERT` sobre esa tabla con un 409 de
violación de integridad que no menciona la causa. El síntoma es inconfundible: la suite
entera cae de golpe en las operaciones de escritura de un agregado, con el mismo error.

`update` tampoco **altera** una constraint que ya existe, y el caso que más despista es la
`CHECK` de un enum: Hibernate la crea una sola vez con los valores del momento, así que si el
diseño renombra o añade un valor (`RETIRED` → `DISCONTINUED`) entre dos generaciones sobre la
misma BD, la tabla conserva la lista vieja. Toda escritura del valor nuevo cae con
`violates check constraint "<tabla>_<campo>_check"` **para un valor que el enum del código sí
declara** — y no hay migración que lo corrija, porque en `local` no hay Flyway hasta el
baseline del cierre. Misma salida: recrear el esquema.

La salida es recrear el esquema, sin tocar el volumen ni los contenedores:

```bash
bash infra/reset-db.sh --schema   # borra las tablas; Hibernate las recrea al arrancar
```

Con una base **documental** este modo existe por un motivo distinto pero simétrico:
no hay `ddl-auto` que deje columnas huérfanas —un documento sin un campo simplemente
no lo tiene—, pero sí índices. Mongo **rechaza** recrear un índice con el mismo nombre
y otras claves, así que regenerar el proyecto tras cambiar `naturalKey` o `indexes`
deja el índice viejo en pie y `MongoIndexConfig` fallando al arrancar. `--schema` hace
`dropDatabase()` y los índices se recrean en el siguiente arranque.

Ejecútalo tras cualquier `keel-spring build --force` que haya cambiado entidades, y ante ese
409 sin explicación antes de buscar el bug en el código. Sin argumento, el script sigue
haciendo lo de siempre (vaciar datos, esquema intacto), que es lo que cada flujo necesita.

Con caché en el stack, el script borra además las claves `<servicio>:*` (cachés y
claves de idempotencia comparten ese prefijo por convención). Es imprescindible:
una entrada cacheada o una clave de idempotencia sobrevive al vaciado de la BD
durante todo su TTL —a menudo horas— y el flujo siguiente recibe la respuesta del
anterior, con toda la pinta de un bug del código que no existe.

### `Idempotency-Key` en los escenarios

En las operaciones con `idempotency` el header es obligatorio. Va un valor
**único por request** (un uuid nuevo cada vez); lo pone `AbstractFlowIT` en toda
mutación. Se repite solo dentro del escenario
que prueba explícitamente la deduplicación, que es donde la respuesta repetida es
el `Then` esperado. Reutilizar la misma clave entre flujos o entre la validación
y la re-validación tras un fix devuelve la respuesta antigua mientras dure el
`ttlSeconds` del diseño.

## Obtener un token para llamadas autenticadas

Con capa `security`, los escenarios necesitan un Bearer token. Quien lo pide ya no es el
agente con `curl`: es `AbstractFlowIT.tokenFor("<rol>")`, que lo cachea por rol. Eso
convierte lo que antes era prosa en un **contrato entre el agente de infraestructura y las
pruebas**, y el agente de infraestructura debe dejar el proveedor así:

Ese contrato **no vive en prosa**: `keel-spring build` lo materializa en dos archivos que se
regeneran con el proyecto, y los dos lados leen los mismos valores.

| Archivo | Quién lo usa |
|---|---|
| `infra/init-keycloak.sh` (solo `auth: keycloak`) | el agente de infraestructura lo **ejecuta y verifica** (no lo escribe): realm, roles, un usuario por rol, los clientes máquina del diseño y la matriz `test-m2m-*` |
| `infra/cognito/mock-oauth2-config.json` (solo `auth: cognito`) | **no hay nada que ejecutar**: el emulador lo lee al arrancar. Trae lo mismo que el script de Keycloak —usuarios por rol, uno sin roles, clientes máquina y la matriz `test-m2m-*`— pero como config declarativa. Lo que el agente verifica es el TOKEN: `cognito:groups`, el `scope` prefijado por el resource server y la ausencia de `aud` |
| `infra/test-credentials.env` | `AbstractFlowIT` lo lee para resolver cliente, contraseña, URL de token y secretos M2M |
| `infra/init-messaging.sh` (solo `broker: snssqs`) | mismo trato: el agente de infraestructura lo **ejecuta y verifica**, no lo escribe. Siembra topics, colas, sus DLQ (`maxReceiveCount` del `onFailure` del diseño) y las suscripciones SNS→SQS con *raw message delivery* y filtro por `eventType`. Sin él la app arranca publicando contra un topic que no existe, y `validate-infra.sh` lo caza porque comprueba que cada topic y cada cola **existan**, no solo que LocalStack responda |

| Pieza | Convención | Sobreescribible con |
|---|---|---|
| Realm / user pool | el **nombre del servicio** (`issuer-uri` que ya generó build) | `AUTH_TOKEN_URL` |
| Cliente de prueba | `<artifactId>-test` (el artifact del proyecto Gradle: `<servicio>-spring`), público, con *direct access grants* | `AUTH_TEST_CLIENT` |
| Usuarios | **uno por rol** del diseño, con el nombre del rol como username, más `no-role` | — |
| Contraseña | `password` para todos | `AUTH_TEST_PASSWORD` |
| Secreto de un cliente máquina del diseño | `<cliente>-secret` | `AUTH_CLIENT_SECRET_<CLIENTE>` |
| Secreto de los clientes `test-m2m-*` | `test-secret` | `AUTH_CLIENT_SECRET` |

Ningún literal de esta tabla se reescribe en el código de las pruebas: si hace falta cambiar
uno, cambia en `infra/test-credentials.env` y se reejecuta el aprovisionamiento. Dos
escritores independientes adivinando el mismo secreto es exactamente el fallo que este
contrato elimina.

- **Keycloak**: el endpoint es
  `http://localhost:8180/realms/<servicio>/protocol/openid-connect/token`
  (`grant_type=password` o `client_credentials`).
- **Cognito** (cognito-local): crea el user pool + client con la AWS CLI apuntando a
  `http://localhost:9229`.

Si el proveedor no puede quedar con esa forma, hay que decirlo en `authHint` con la URL y
las credenciales reales para que se pasen por entorno; lo que no vale es dejar la clase base
apuntando a algo que no existe.

Si el diseño declara endpoints M2M (`audience: services`/`both` + `serviceAuth`),
los escenarios `level: service` usan **credencial de máquina**, no token de
usuario: `grant_type=client_credentials` con el cliente del `serviceClient`
(receta en la skill del proveedor), o el header `X-API-Key` con la clave de
`security.api-keys.<cliente>` si `serviceAuth` es `api-key`. Ejercita también el
403 (cliente sin el scope) y, con `validateAudience`, el 401 por audiencia ajena.

Las claves de API **ya vienen configuradas** en `src/main/resources/parameters/local/security.yaml`
(`security.api-key: local-dev-api-key` y `security.api-keys.<cliente>: local-<cliente>-key`): las
expone `AbstractFlowIT` (`apiKey()`, `serviceCredential(...)`) tal cual, no se inventan ni se edita
el YAML. Cambiarlas solo tiene sentido para ejercitar el 401 con clave inválida.

La app la arranca **JUnit** (`@SpringBootTest(webEnvironment = RANDOM_PORT)`) en el mismo
proceso de las pruebas, contra los contenedores de este compose: no hay `bootRun` en
background ni puerto fijo que sondear. `devtools` es para la **infraestructura**, no para la
app: las llamadas HTTP a los endpoints las hace el `TestRestTemplate` de la clase base.
