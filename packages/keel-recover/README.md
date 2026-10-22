# keel-recover

Ingeniería inversa de un servicio existente hacia un diseño [Keel](https://github.com/keel-system/keel). La
única entrada es el **repo** del legacy, con su historial de git; la herramienta lo lee y **nunca lo
modifica**. Plan completo y estado, incremento a incremento: [`PLAN-KEEL-RECOVER.md`](../../PLAN-KEEL-RECOVER.md).

Hoy (incremento 2) trae los dos pasos deterministas del sandbox:

```bash
keel-recover fingerprint <legacy> [-o runtime.yaml]       # paso 0a: huella del runtime
keel-recover env-deps    <legacy> [-o environment.yaml]   # paso 0b: dependencias del entorno
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

## Adaptadores

Java/Maven (`pom.xml`, `.mvn/wrapper`), Java/Gradle (`build.gradle[.kts]`, `gradle.properties`, `settings`,
wrapper) y Node (`package.json`, `.nvmrc`, `.node-version`, `.tool-versions`, todos los lockfiles, `.npmrc`,
`.yarnrc`). La CI se lee de Travis, CircleCI, GitHub Actions (con la matriz), GitLab CI y Bitbucket.

## Redes

- `npm test`: las fixtures de legacy mínimas de `fixtures/legacy/` (`java8-maven`, `java8-gradle`, `node14`)
  salen **byte a byte** como `fixtures/expected/`, dos ejecuciones dan los mismos bytes y nada depende de la ruta
  ni de lo que un build dejó en el árbol. Las fixtures viven fuera de `test/` a propósito: `node --test` ejecuta
  todo `.js` bajo un directorio `test`. Un cambio deliberado se acepta con `npm run golden` y se revisa en el diff.
- `npm run bench-check`: las dos órdenes sobre los tres legacys del banco en `../keel-recover-lab`, contra los
  `runtime.yaml`/`environment.yaml` escritos a mano en el incremento 1 y las filas ENV/ASSET de las hojas de
  `docs/recover-bench/`. Lista aparte lo que en esas referencias es trabajo del agente.
