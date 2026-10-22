# keel-recover

Ingeniería inversa de un servicio existente hacia un diseño [Keel](https://github.com/keel-system/keel). La
única entrada es el **repo** del legacy, con su historial de git; la herramienta lo lee y **nunca lo
modifica**. Plan completo y estado, incremento a incremento: [`PLAN-KEEL-RECOVER.md`](../../PLAN-KEEL-RECOVER.md).

Hoy (incremento 6) trae el paso 0 entero, la observación del paso 1, la recuperación del diseño (pasos 3 y 4) y
la medida de su fidelidad (paso 5): los dos pasos deterministas, la preparación del workspace, la skill que monta
el sandbox, el juez, la introspección, el ejecutor de sondas, la skill que escribe el diseño con su procedencia y
el ejecutor de los escenarios de caracterización contra el legacy:

```bash
keel-recover fingerprint <legacy> [-o runtime.yaml]       # paso 0a: huella del runtime
keel-recover env-deps    <legacy> [-o environment.yaml]   # paso 0b: dependencias del entorno
keel-recover init <legacy> --name <servicio>              # en el workspace de diseño: prepara legacy/<servicio>/
/keel-recover-sandbox legacy/<servicio>                   # el agente: Dockerfile, compose y bucles (0c-0e)
keel-recover verify legacy/<servicio>/sandbox             # paso 0f: el juez
keel-recover introspect legacy/<servicio>/sandbox         # paso 1a: la superficie, preguntada al runtime
keel-recover probe legacy/<servicio>/probes/round-1.yaml  # paso 1b: una ronda de sondas con sus efectos
/keel-recover specs/<servicio>                            # el agente: el diseño, su procedencia y la caracterización
keel-recover characterize legacy/<servicio>               # paso 5: los escenarios contra el legacy, sello y FIDELITY.md
keel validate --ready specs/<servicio>                    # criterios provenance y characterized
```

`-o` se niega a escribir dentro del legacy. `--check <archivo>` no escribe y sale en rojo si el archivo no es lo
que la herramienta escribe hoy (sirve de puerta). `--json` cambia el formato. Si ningún adaptador reconoce el
repo, sale con código 2 y el motivo en `unsupported`.

## Qué escribe

**`runtime.yaml`** (schema `assets/schema/runtime.schema.json`, fuera del DSL): lenguaje y su versión, build
(herramienta, wrapper y versión), framework, empaquetado y servidor, repositorios de artefactos con sus riesgos
conocidos (`insecure-http`, `sunset`, `requires-auth`), lockfiles y registros (marcando el privado), Dockerfiles,
CI y los **motores con los que el repo se probaba** (CI, compose y los `docker run` de sus scripts). Una versión
rara vez la dice un solo sitio: se recogen todas las declaraciones y se elige con una regla fija (la fuente más
fuerte fija la versión mayor y, dentro de ella, gana la más específica); si discrepan, `consistent: false`. La
fecha de `source.build_changed` es la del último cambio del build, no la del último commit (un repo archivado
acaba en un «Add deprecation notice» años después).

**`environment.yaml`** (schema `assets/schema/environment.schema.json`): el puerto en el que escucha, cada
punto de variación que el código lee (placeholders de Spring, `@Value`, `@ConfigurationProperties`, `getenv`,
`process.env` con su default y los valores con los que se compara, `.env.example`), las dependencias externas
por clase con su **provisión** (`container` con los alias que el legacy ya espera, `wiremock`, `mailpit`, `none`
o `ask`), las credenciales fijas, las llamadas HTTP salientes y el inventario de **activos** del repo (pruebas,
specs con cuántas operaciones documentan, colecciones con cuántas peticiones traen, stubs, seeds, migraciones,
compose y scripts).

Lo que se decide al montar el sandbox **no** lo escribe la herramienta: la imagen y su versión en cada
`provision`, y la lista `adaptations` con el motivo de cada una. Tampoco adivina: un destino que el código
compone en tiempo de ejecución queda como llamada sin resolver en `outbound_http`, una URL http literal del
código es candidata (no dependencia), y una variable con pinta de destino que no casa con nada sale como
dependencia `unknown` con `provision: ask`.

## El sandbox y el juez

`init` deja en `legacy/<servicio>/` el `legacy.yaml` (dónde está el repo), `runtime.yaml`, `environment.yaml`
(al repetirlo conserva lo que puso el agente: `adaptations` y la imagen de cada `provision`), la instrumentación
(`sandbox/instrument/v8-coverage-exit.cjs`) y la skill `/keel-recover-sandbox`, proyectada para cada harness.
La skill escribe `sandbox/` (Dockerfile multi-etapa, `build.sh` con red, `compose.yaml` en red interna y
`sandbox.yaml`, el contrato con el juez: schema `assets/schema/sandbox.schema.json`).

`verify` decide si lo que se grabe en el sandbox será comportamiento del legacy. Escribe `verify.json` y, en
verde, toma el snapshot de la base:

| Id | Qué exige |
|---|---|
| `VER-COMPOSE` | la app, la herramienta y la base existen y tienen `container_name` |
| `VER-NET-INTERNAL` | toda red `internal: true`: si falla (o `VER-COMPOSE`), el sandbox no se arranca |
| `VER-DIGEST`, `VER-NO-BUILD` | imágenes por digest; el compose solo ejecuta |
| `VER-ENGINE` | cada motor en la versión de la CI, o con una adaptación que lo nombre |
| `VER-UP`, `VER-EGRESS` | la app responde; desde sus redes no se llega a internet |
| `VER-READ`, `VER-WRITE` | una lectura y una escritura del dominio con el estado esperado: no basta «sin 5xx» |
| `VER-DB-TRACE` | la escritura deja rastro en la base (MongoDB, por su `dbHash`); la salud del legacy no cuenta |
| `VER-COVERAGE` | la cobertura (JaCoCo, nyc o V8) graba código de la app |

## La observación (paso 1)

`introspect` pregunta la superficie al **runtime**, no al código: la tabla de rutas del framework (Express por
la precarga `express-routes.cjs`, que la lee del proceso; Spring 4 / Boot 1.x por las líneas `Mapped "{[...]}"`
del arranque; Boot 2+ por `/actuator/mappings`), las colecciones con sus índices y sus columnas de estado (texto
con pocos valores) y la topología del broker. La funde en `legacy/<servicio>/surface.yaml`, y cada ronda la vuelve
a preguntar: la superficie se declara de forma perezosa (una colección nace con su primer documento, un exchange
con la primera publicación), así que cada elemento guarda en qué pasada apareció (`seen`) y en cuál dejó de verse
(`absent`).

`probe` ejecuta una ronda (`probes/round-N.yaml`, schema `assets/schema/probes.schema.json`: pasos HTTP o
publicaciones en el broker, capturas, `setup` por clase —stubs, broker caído, base caída—, pasos paralelos y
`repeat` para las carreras) contra el sandbox en verde. Cada sonda parte del snapshot de verify y graba en
`recordings/<ronda>/<id>.json` la respuesta de cada paso y sus **efectos**: el diff de la base, las llamadas que
recibió WireMock, lo que se publicó en el broker (por el firehose de RabbitMQ en una cola espía propia: no consume
de las del legacy y ve también el exchange por defecto) y el correo de Mailpit, normalizados (JWT por sus claims,
ids por orden de aparición, fechas fuera, más las reglas del legacy en `sandbox.yaml#probe.normalize`). Al final
vuelca la cobertura de la ronda (`recordings/coverage.json` lleva la serie y dice si se estanca) y lo que queda sin
cubrir, por archivo, para la ronda siguiente.

Un canal que no captura graba **silencio**, y el silencio se lee como «el legacy no hace eso». Por eso cada canal
lleva un canario en cada sonda, por el mismo camino que el efecto del legacy (las bases con las que llama, el
`host:puerto` con el que envía), al abrir la ventana y al cerrarla. Si falta, la grabación sale marcada
(`untrusted`) y la ronda en rojo:

| Id | Qué exige |
|---|---|
| `PRB-VERIFY` | `verify.json` en verde y con snapshot: si no, no se sondea |
| `PRB-CHANNELS` | cada dependencia de `environment.yaml` que produce un efecto tiene su sección en `sandbox.yaml` (`database`, `broker`, `stubs`, `mail`) |
| `PRB-RESTORE` | tras cada restauración, la base tiene la huella del snapshot |
| `PRB-BROKER`, `PRB-STUBS`, `PRB-MAIL` | los dos canarios de cada sonda llegaron a la cola espía, al diario de WireMock y al buzón |
| `PRB-COVERAGE` | la ronda grabó código de la app **ella sola**: el acumulado de antes no cuenta |

Límites de hoy, con su motivo: la base es solo MongoDB y el broker solo RabbitMQ (los del banco); los demás son un
rechazo de `sandbox.schema.json` hasta medirlos. JaCoCo y nyc se vuelcan por ronda, pero la red en vivo del paso 1
solo ejercita V8.

## El diseño recuperado (pasos 3 y 4)

La skill `/keel-recover` (sembrada por `init` junto a la del sandbox) escribe `specs/<servicio>/` capa a capa
desde las grabaciones, con la **procedencia** de cada elemento en `specs/<servicio>/provenance.yaml` (schema
`provenance.schema.json` de keel-core): `measured` (una grabación), `read` (`archivo:línea` del legacy) o
`asked` (lo decidió el humano). `inferred` no se admite en el diseño final. Las decisiones estructurales de
`decisions.yaml` llevan `origin` (`observed`, `omitted` o `contradicted`) y su `evidence`, y las `omitted` se
preguntan. Cada flujo de `validation-scenarios.md` lleva su marca `keep`, `fix`, `frontier` o `new`; los `fix`
(el backlog de un refactor) y la frontera del DSL viven en `provenance.yaml`, que no viaja al publicar ni al
derivar porque cita un código privado.

La puerta es de keel-core: el criterio `provenance` de `keel validate --ready`, que solo aplica a un diseño
recuperado (el que trae `provenance.yaml`, o cuyo registro estructural habla de `origin`). Deriva de las capas el
**inventario** de elementos —entidades y sus campos, agregados, operaciones y sus errores, endpoints, roles,
permisos, reglas de acceso, eventos…— y sale en rojo con cualquiera sin fila, aunque ninguna fila escrita mienta:
en el inc. 1 se coló un rol copiado de una fixture que una puerta sobre las filas no habría visto.

## La fidelidad (paso 5)

Cada flujo `keep`, `fix` o `frontier` de `validation-scenarios.md` lleva sus pasos en un bloque ```` ```keel-flow ````
(schema `assets/schema/flow.schema.json`), en operaciones del **diseño**; `legacy/<servicio>/contract-map.yaml`
(schema `contract-map.schema.json`) dice cómo se pide cada una al legacy: ruta, envoltura, dónde están los datos,
qué significa cada clase de status y cómo obtiene su credencial cada clase de actor (la propia API, un JWT firmado
con el secreto de desarrollo del repo, o ninguna). `keel-recover characterize legacy/<servicio>` ejecuta cada flujo
desde el snapshot de verify (comprobando su huella tras restaurar): un `keep` y un `frontier` comprueban lo que el
escenario afirma; un `fix`, lo que hace el legacy hoy (`legacy:`), porque un fix describe un cambio real solo si el
defecto sigue ahí. Un paso sin expectativa sale en rojo con un 5xx.

Escribe el sello `specs/<servicio>/characterized.yaml` (schema de keel-core, no viaja), las grabaciones de cada
flujo en `recordings/characterization/` y `FIDELITY.md`: corrección por marca, cobertura acumulada, rutas del
legacy que ninguna operación del mapa recoge, lo no observado, procedencia, `fix` y frontera. El bloque vive
**dentro** del flujo para que el sello del flujo —el mismo del careo— cubra lo ejecutado: tocar un paso o su prosa
después de ejecutarlo lo deja sin ejecutar, y el criterio `characterized` de `keel validate --ready` sale en rojo.

## Adaptadores

Java/Maven (`pom.xml`, `.mvn/wrapper`), Java/Gradle (`build.gradle[.kts]`, `gradle.properties`, `settings`,
wrapper) y Node (`package.json`, `.nvmrc`, `.node-version`, `.tool-versions`, todos los lockfiles, `.npmrc`,
`.yarnrc`). La CI se lee de Travis, CircleCI, GitHub Actions (con la matriz), GitLab CI y Bitbucket.

## Redes

- `npm test`: las fixtures de legacy mínimas de `fixtures/legacy/` (`java8-maven`, `java8-gradle`, `node14`)
  salen **byte a byte** como `fixtures/expected/`, dos ejecuciones dan los mismos bytes y nada depende de la ruta
  ni de lo que un build dejó en el árbol. Las fixtures viven fuera de `test/` a propósito: `node --test` ejecuta
  todo `.js` bajo un directorio `test`. Un cambio deliberado se acepta con `npm run golden` y se revisa en el diff.
- `npm run verify-check` (podman o docker, red para el build, ~5 min): el juez contra el sandbox real de
  `fixtures/sandbox/node-mongo` (Node + MongoDB, cobertura V8), tal cual en verde y con cuatro sabotajes que
  conservan la forma, cada uno en rojo con exactamente su criterio: red no interna (`VER-NET-INTERNAL`, sin
  arrancar), sin cobertura (`VER-COVERAGE`), base inalcanzable con el `/health` del legacy en 200 (`VER-READ`,
  `VER-WRITE`, `VER-DB-TRACE`) y escritura que no deja rastro donde el sandbox cree (`VER-DB-TRACE`). La sonda de
  egreso no se puede falsar en vivo (con la red abierta no se arranca): la falsa `test/verify.test.js` con un
  doble del runtime.
- `npm run probe-check` (podman o docker, red para el build, ~15 min): `introspect` y `probe` contra el sandbox
  real de `fixtures/sandbox/node-effects` (Express + MongoDB + RabbitMQ + un tercero en WireMock + Mailpit). En
  verde, la superficie trae las rutas del router montado y, tras la ronda, el exchange que el legacy declara al
  publicar; la ronda graba cada efecto donde la fixture lo produce (36 comprobaciones) y dos ejecuciones de las
  mismas sondas graban lo mismo. Cinco sabotajes que conservan la forma, cada uno en rojo con exactamente su
  criterio: la cola espía sin enlace (`PRB-BROKER`), WireMock sin diario (`PRB-STUBS`), un Mailpit que no es al
  que envía el legacy (`PRB-MAIL`), el snapshot borrado (`PRB-RESTORE`) y la app reiniciada sin la precarga que
  escribe la cobertura al parar, con el acumulado de antes intacto (`PRB-COVERAGE`).
- `npm run characterize-check` (podman o docker, red para el build, minutos): `characterize` contra el sandbox real de
  `fixtures/sandbox/node-mongo` con el diseño de juguete de `test/helpers/stock-design.js` (el mismo que usa
  `test/characterize.test.js` contra un legacy falso en memoria). En verde, dos `keep`, un `fix` y un `frontier`,
  con el sello leído por keel-core sin nada pendiente y `FIDELITY.md`. Cuatro sabotajes, cada uno en rojo con
  exactamente sus flujos: un `keep` que afirma otro status, un `fix` cuyo defecto no existiría, el snapshot borrado
  y una base restaurada con otra huella.
- `npm run bench-verify` (podman o docker, las imágenes del inc. 1): el juez contra los tres sandboxes del banco
  en `../keel-recover-lab`, desde copias. Ejercita JaCoCo (sockshop) y nyc en Node 8 (RealWorld).
- `npm run bench-check`: las dos órdenes sobre los tres legacys del banco en `../keel-recover-lab`, contra los
  `runtime.yaml`/`environment.yaml` escritos a mano en el incremento 1 y las filas ENV/ASSET de las hojas de
  `docs/recover-bench/`. Lista aparte lo que en esas referencias es trabajo del agente.
