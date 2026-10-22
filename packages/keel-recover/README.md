# keel-recover

Ingeniería inversa de un servicio existente hacia un diseño [Keel](https://github.com/keel-system/keel). La
única entrada es el **repo** del legacy, con su historial de git; la herramienta lo lee y **nunca lo
modifica**. Plan completo y estado, incremento a incremento: [`PLAN-KEEL-RECOVER.md`](../../PLAN-KEEL-RECOVER.md).

Hoy (incremento 3) trae el paso 0 entero: los dos pasos deterministas, la preparación del workspace, la skill
que monta el sandbox y el juez:

```bash
keel-recover fingerprint <legacy> [-o runtime.yaml]       # paso 0a: huella del runtime
keel-recover env-deps    <legacy> [-o environment.yaml]   # paso 0b: dependencias del entorno
keel-recover init <legacy> --name <servicio>              # en el workspace de diseño: prepara legacy/<servicio>/
/keel-recover-sandbox legacy/<servicio>                   # el agente: Dockerfile, compose y bucles (0c-0e)
keel-recover verify legacy/<servicio>/sandbox             # paso 0f: el juez
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
- `npm run bench-verify` (podman o docker, las imágenes del inc. 1): el juez contra los tres sandboxes del banco
  en `../keel-recover-lab`, desde copias. Ejercita JaCoCo (sockshop) y nyc en Node 8 (RealWorld).
- `npm run bench-check`: las dos órdenes sobre los tres legacys del banco en `../keel-recover-lab`, contra los
  `runtime.yaml`/`environment.yaml` escritos a mano en el incremento 1 y las filas ENV/ASSET de las hojas de
  `docs/recover-bench/`. Lista aparte lo que en esas referencias es trabajo del agente.
