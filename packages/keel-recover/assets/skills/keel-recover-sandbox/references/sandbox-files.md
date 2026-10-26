# Los archivos del sandbox (paso 0c)

Todo vive en `legacy/<servicio>/sandbox/`. El repo del legacy es el contexto del build y no se escribe nada en él.

## `Dockerfile` (multi-etapa)

```dockerfile
# Paso 0c: build de <servicio> con la cadena de su época; el código entra por COPY, nunca se modifica
FROM docker.io/library/maven:3.6.3-jdk-8@sha256:… AS build
WORKDIR /src
COPY . .
RUN mvn -B -q package

FROM docker.io/library/eclipse-temurin:8-jre@sha256:… AS run
# instrumentación de cobertura: no es el legacy
ADD https://repo1.maven.org/maven2/org/jacoco/org.jacoco.agent/0.8.12/org.jacoco.agent-0.8.12-runtime.jar /opt/jacoco/jacocoagent.jar
ADD https://repo1.maven.org/maven2/org/jacoco/org.jacoco.cli/0.8.12/org.jacoco.cli-0.8.12-nodeps.jar /opt/jacoco/jacococli.jar
COPY --from=build /src/target/<finalName>.jar /opt/app/app.jar
COPY --from=build /src/target/classes /opt/app/classes
ENTRYPOINT ["java","-javaagent:/opt/jacoco/jacocoagent.jar=output=tcpserver,address=*,port=6300,includes=<paquete raíz>.*","-jar","/opt/app/app.jar"]
```

- La etapa de build usa la cadena de `runtime.yaml`: `language.version`, `build.tool` y `build.version` (o el wrapper del repo, si lo trae), o la `package_manager` con su lockfile (`yarn install --frozen-lockfile`, `npm ci`). Si `language.consistent` es `false`, la versión que compila el código es la de `language.version`; la otra se queda como nota en el diario.
- **No uses el Dockerfile del repo** (`runtime.yaml#dockerfiles`) si su base no está fijada o es de una organización abandonada: puede no existir o traer otra cosa. Sí puedes copiar de él cómo arranca (`ENTRYPOINT`, argumentos).
- Si el build resuelve una dependencia o un padre `-SNAPSHOT` (o `BUILD-SNAPSHOT`) de un repositorio de snapshots, el sandbox depende de algo que puede desaparecer: escribe en `LOG.md` la versión exacta que se resolvió (el timestamp del artefacto) y dilo en el reporte como riesgo de reproducibilidad. Medido en shop-api: el padre `2.2.0.BUILD-SNAPSHOT` desde `repo.spring.io/snapshot`.
- El nombre del artefacto sale de `runtime.yaml#packaging` y el arranque, de `runtime.yaml#entrypoint` en Node.

### Cobertura por runtime

| Runtime | Medidor | `sandbox.yaml#coverage` |
|---|---|---|
| Java | agente JaCoCo en `tcpserver`: se vuelca sin reiniciar | `kind: jacoco`, `cli`, `classes`, `port` |
| Node ≥ 10.12 | `NODE_V8_COVERAGE=/coverage` en un volumen + `NODE_OPTIONS=--require /recover/v8-coverage-exit.cjs` (montando `sandbox/instrument` en `/recover`): sin él, Node muere con la señal de `stop` sin escribir nada | `kind: v8`, `dir: /coverage`, `include: <ruta del código en la imagen>` |
| Node < 10.12 | `nyc --temp-dir /coverage` envolviendo el arranque (nyc 14.1.1 es la última que soporta Node 8). Escribe al salir: una ronda = un arranque | `kind: nyc`, `dir: /coverage` |

## `build.sh`

```bash
#!/usr/bin/env bash
# Paso 0d: build del legacy con red (solo para dependencias); el runtime corre en la red interna del compose
set -euo pipefail
cd "$(dirname "$0")/.."
podman build -f sandbox/Dockerfile -t localhost/recover/<servicio>:sandbox <ruta del repo, la de legacy.yaml>
```

## `compose.yaml`

```yaml
name: rec-<servicio>
services:
  app:
    container_name: rec-<servicio>-app
    image: localhost/recover/<servicio>:sandbox        # la construye build.sh; aquí solo se ejecuta
    environment: { … }                                 # cada una, también en environment.yaml#adaptations si no es del repo
    networks: { sandbox: { aliases: [<alias de la app>] } }
  <alias de la base>:
    # <motor> <versión>: la de su CI (<archivo:línea>) — o la adaptación y su motivo
    container_name: rec-<servicio>-db
    image: docker.io/library/<motor>:<versión>@sha256:…
    networks: { sandbox: { aliases: [<el host que espera el legacy>] } }
  stubs:                                               # terceros HTTP: un WireMock con un alias por host
    container_name: rec-<servicio>-stubs
    image: docker.io/wiremock/wiremock:3.9.1@sha256:…
    networks: { sandbox: { aliases: [payment, shipping] } }
  tool:                                                # por él pasan las sondas: el host no alcanza una red interna
    container_name: rec-<servicio>-tool
    image: docker.io/curlimages/curl:8.10.1@sha256:…
    command: ["sleep", "infinity"]
    networks: [sandbox]
networks:
  sandbox: { internal: true }
```

- Una dependencia `provision.via: container` es un servicio con su motor; `wiremock`, un alias más del WireMock común, con los stubs **derivados de los activos del repo** (`environment.yaml#assets` de tipo `stub`, los DTO de cliente) y nunca inventados; `mailpit`, un Mailpit; `none`, nada; `ask`, una pregunta al humano antes de seguir.
- Un tercero cuyo destino compone el código (`environment.yaml#outbound_http.call_sites`) se resuelve leyendo esas líneas, y la respuesta que finjas es una **asunción**: va a `unobserved.yaml` en el paso 1.

## `sandbox.yaml`

El contrato con el juez (schema `sandbox.schema.json` de keel-recover). Las dos sondas son una **lectura y una escritura reales del dominio**, nunca el endpoint de salud del legacy, y declaran qué estados son acierto. La escritura lleva `{{nonce}}` donde haga falta un valor nuevo en cada ejecución (un registro repetido daría 422 con razón).

```yaml
kind: sandbox
schema: 1
compose: compose.yaml
app: { service: app, base: "http://<alias>:<listen.port>" }
tool: { service: tool }
database: { service: <servicio de la base>, tech: mongodb | postgresql | mysql, name: <base que usa la app> }   # postgresql y mysql admiten user (ver abajo)
coverage: { kind: v8, dir: /coverage, include: /app/src/ }
judge:
  read:  { method: GET,  path: /items, expect: [200] }
  write: { method: POST, path: /items, body: { sku: "verify-{{nonce}}" }, expect: [201] }
```

Si el legacy no tiene ninguna ruta de salud (RealWorld), mejor: el juez nunca la usa.

### La base

La herramienta entra en la base **dentro de su contenedor**, con el cliente de la imagen (`mongosh`/`mongo`, `psql`,
`mysql`/`mysqldump`), así que la imagen tiene que ser la oficial del motor o traer su cliente.

- **PostgreSQL**: `user` (por defecto `postgres`) entra por el socket local sin contraseña, como en la imagen oficial.
- **MySQL** (8.0 o posterior: 5.7 y anteriores son rechazo con motivo). Sin `user`, la herramienta entra como root con el
  `MYSQL_ROOT_PASSWORD` del contenedor; con `user`, con el `MYSQL_PASSWORD` del contenedor (el del `MYSQL_USER` de la
  imagen oficial). Entra como root si el esquema tiene triggers o rutinas: su `DEFINER` suele ser root, y el usuario
  de la app no puede volcarlos ni recrearlos al restaurar. El usuario de la app, en cambio, basta para el resto: el
  volcado va con `--no-tablespaces` porque no tiene `PROCESS` (M-13).
- **MySQL, el servidor como el de producción.** La zona (`--default-time-zone`) y el `sql_mode` (`--sql-mode`) son
  comportamiento: un `sql_mode` no estricto trunca en vez de rechazar, y uno viejo admite las fechas cero que el
  esquema pueda tener. Fíjalos en `command:` del servicio de la base con lo que diga la evidencia (la CI, el compose del
  repo, la configuración de producción) y escríbelos como adaptación si no salen del repo. El esquema y los datos de
  partida que la app no crea van por `/docker-entrypoint-initdb.d/`.
- **MySQL, el driver viejo (M-12).** El plugin de autenticación por defecto de 8.0 es `caching_sha2_password`, que
  Connector/J anterior a 8.0 y el paquete `mysql` 2.x de Node no hablan: la app no conecta y verify lo ve como base
  caída. La adaptación es `command: ["--default-authentication-plugin=mysql_native_password"]` en el servicio de la base
  (junto a la zona y el `sql_mode`), con su motivo en `environment.yaml#adaptations`. Connector/J 8.0 y `mysql2` lo
  hablan y no la necesitan (medido: show-ticketing con Connector/J 8.0.22, y la fixture `node-mysql` con `mysql2` 3.11).
  La adaptación con un driver viejo, sin medir en el banco.
- **MySQL, una transacción abierta.** La restauración del snapshot espera el *metadata lock* de cada tabla 20 s
  (`lock_wait_timeout`) y sale en rojo con la sesión que la retiene (M-01). Un pool sin transacciones abiertas no la
  bloquea.

### Los canales del paso 1

El paso 1 (`keel-recover introspect` y `probe`) lee en el sandbox **cada efecto** del legacy, y `sandbox.yaml` dice dónde. Cada dependencia de `environment.yaml` que produce un efecto necesita su sección, o `probe` se niega (`PRB-CHANNELS`): sin ella grabaría silencio donde el legacy sí hace algo.

```yaml
broker:                                    # dependencia kind: broker (hoy solo RabbitMQ)
  service: <servicio del broker>
  tech: rabbitmq
  api: http://<alias>:15672/api            # la imagen, en su variante -management (misma versión)
  # user/password/vhost: los de desarrollo del repo, por defecto guest/guest y /
stubs:                                     # dependencias provision.via: wiremock
  service: <servicio del WireMock>
  admin: http://<alias>:<puerto>/__admin
  hosts: [http://payment:<puerto>]         # las bases con las que LLAMA el legacy, una por alias
mail:                                      # dependencia kind: smtp
  service: <servicio del Mailpit>
  api: http://<alias>:8025/api/v1
  smtp: <host>:<puerto>                    # con el que ENVÍA el legacy
introspection:
  routes: { kind: express, file: /coverage/keel-recover-routes.json }   # o spring-log, o actuator con path
```

- `hosts` y `smtp` son las direcciones **del legacy**, no las del espía: el canario de cada sonda viaja por ellas, y si no acaban en el WireMock o el Mailpit que se lee, la sonda sale en rojo.
- RabbitMQ se espía con su firehose (`rabbitmqctl trace_on`), que necesita la API de gestión: por eso la variante `-management` de la **misma** versión que pide la evidencia, con una adaptación que lo diga.
- Rutas de Express: monta también la precarga `express-routes.cjs` de `sandbox/instrument` (`NODE_OPTIONS=--require /recover/v8-coverage-exit.cjs --require /recover/express-routes.cjs`) y dale con `RECOVER_ROUTES_OUT` un archivo dentro del volumen de la cobertura. Spring 4 / Boot 1.x: `spring-log` (las líneas `Mapped "{[...]}"` del arranque, que listan también Spring Data REST). Boot 2+: también `spring-log`, encendiendo el log de las rutas en el servicio de la app del compose con `SPRING_APPLICATION_JSON: '{"logging.level.org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping":"TRACE"}'` — no con `LOGGING_LEVEL_…`: la variable de entorno se pasa a minúsculas y no alcanza un logger con nombre de clase (medido en shop-api, Boot 2.2). El context path (`server.servlet.context-path`) lo antepone la herramienta desde la línea de arranque del contenedor web. `actuator` con `path: /actuator/mappings` solo si el legacy ya lo trae: añadirlo es tocar su build. Sin `introspection.routes`, `FIDELITY.md` no puede decir qué rutas se quedan sin operación: no la dejes fuera.
