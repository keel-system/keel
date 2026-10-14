# Plan de construcción de `keel-dotnet`

## Context

Keel ya tiene dos generadores: `keel-spring` y `keel-nest`. keel-nest se cerró en 16 incrementos medidos
(`PLAN-KEEL-NEST.md`) con la regla de que **el mismo diseño genera servidores equivalentes**. Para eso
toda la interpretación del diseño se sacó a `keel-core/gen`: modelo, contrato del cable, acceso,
`infra/`, arnés JUnit, evolución, matriz de paridad y vocabularios de sondas. El tercer generador,
`keel-dotnet`, sale casi entero de ese núcleo. Lo único nuevo es la **proyección C#**
(`cs-projection.js`), su tabla de stack (`dotnet-stack.js`) y los renderizadores de `src/scaffold/`.

El usuario no es experto en .NET. Por eso el plan lleva una **guía de entorno local** (§6). Y pone
una restricción dura: **ninguna librería con licencia comercial**, ni en el proyecto generado ni en
sus pruebas. Esa restricción va en código (§1.6), no solo en prosa.

El primer paso de la implementación es copiar este plan al repo como `PLAN-KEEL-DOTNET.md`. Así su
estado se lleva incremento a incremento, como el de keel-nest.

Flujo normativo, idéntico a los otros dos:

```bash
keel-dotnet check specs/<servicio>
keel-dotnet build specs/<servicio>
cd services/<servicio>-dotnet
/keel-generate-dotnet
```

## 0. Regla de equivalencia

Se mide con la misma tabla del §0 de `PLAN-KEEL-NEST.md`. Cubre contrato HTTP, cable, mensajería,
fiabilidad, persistencia, operación y telemetría. Cada eje se mide contra lo que **emite** keel-spring,
y también contra keel-nest donde ya existe un `*-parity.test.js`. El oráculo es siempre el texto
emitido por los otros, nunca un recuerdo.

## 1. Principios

1. **La frontera avanza en código.** `src/lib/supported-features.js` nace rechazando todas las capas
   salvo `domain`, `use-cases` y `api`, cada una con el incremento que la trae, y cada incremento
   borra entradas.
2. **Nada neutral se copia.** Si una decisión hace falta y no está en `keel-core/gen`, primero se
   extrae ahí, con keel-spring y keel-nest sin cambiar un byte. Puerta: `npm run golden -- --check`
   de keel-spring y las paridades de keel-nest.
3. **Cada incremento cierra con una puerta medible**: rasgos sobre el texto, sintaxis C#, compilación
   real, check en vivo cuando aplique y corrida en los hitos.
4. **Fixtures compartidas** (`fixtures/designs/`). La vara final es el par del MVP
   (`notification-mailer` / `-mongo`).
5. **Matriz de paridad propia** (`src/lib/engine-support.js`) sobre el catálogo neutral
   `keel-core/gen/mechanisms.js`.
6. **Licencias permisivas, en código.** `src/lib/dotnet-stack.js` declara cada paquete NuGet con
   versión exacta y su SPDX. `test/licenses.test.js` hace dos cosas:
   - Exige que todo paquete emitido esté en una lista blanca: MIT, Apache-2.0, BSD-2/3, PostgreSQL y
     MS-PL.
   - Prohíbe por nombre y rango lo que pasó a licencia comercial: MediatR ≥13, AutoMapper ≥15,
     MassTransit ≥9, FluentAssertions ≥8, Duende IdentityServer, Six Labors ImageSharp, QuestPDF,
     EPPlus e iText.

   El proyecto generado lleva además `infra/check-licenses.sh` (`dotnet list package --include-transitive`
   contra la misma lista) para el agente de calidad.
7. **Versiones verificadas al abrir cada incremento** con `find-docs`/ctx7, nunca de memoria. La
   base prevista es .NET 10 LTS, C# 14 y EF Core 10. Se confirma en el inc. 2 y queda fijada en
   `global.json`.

## 2. Arquitectura del proyecto generado (`services/<servicio>-dotnet/`)

Hexagonal + CQRS, la misma forma que `architecture.md` de keel-spring. La frontera la hace cumplir
**el compilador**, porque cada capa es un proyecto y las referencias entre proyectos son las únicas
flechas permitidas. Es mejor red que el dependency-cruiser de keel-nest.

```
<Service>.sln
global.json                    # SDK fijado (rollForward: latestFeature)
Directory.Build.props          # net10.0, Nullable, TreatWarningsAsErrors, AnalysisLevel latest, Deterministic
Directory.Packages.props       # gestión central de versiones (de dotnet-stack.js)
src/
  <Service>.Domain/            # C# puro, sin paquetes: Aggregate/ Entity/ ValueObject/ Enums/ Events/ Errors/ Repository/(puertos)
  <Service>.Application/       # → Domain. Commands/ Queries/ UseCases/ Dtos/ Mappers/ Interfaces/; mediator propio, sin MediatR
  <Service>.Infrastructure/    # → Application. Persistence/ Messaging/ Security/ Clients/ Storage/ Mail/ Scheduling/ Telemetry/
  <Service>.Api/               # → Infrastructure. Program.cs, Minimal APIs con un solo mapa de rutas, ApiExceptionHandler
tests/
  <Service>.UnitTests/         # xUnit v3
  <Service>.IntegrationTests/  # flujos FL-* de caja negra con WebApplicationFactory sobre la infra/ real, JUnit XML
infra/                         # la NEUTRAL de keel-core/gen/infra-scripts.js con DOTNET_INFRA
deploy/                        # Dockerfile multi-etapa sobre mcr.microsoft.com/dotnet/aspnet:10.0
```

Equivalencias de stack. Todas tienen licencia permisiva; la versión exacta se fija al abrir su
incremento.

| Spring / Nest | .NET |
|---|---|
| Gradle wrapper / npm lock | `global.json` + `Directory.Packages.props` + `packages.lock.json` (`RestorePackagesWithLockFile`), NuGet Audit activo |
| Spring MVC / Fastify | ASP.NET Core **Minimal APIs**. Un solo punto de lectura y escritura JSON |
| Jackson / `wire.ts` | `System.Text.Json` con conversores generados: `decimal` conserva la escala de forma nativa (`2.50m` → `2.50`), `DateTimeOffset` con 3 decimales y `Z`, enums por valor, `JsonElement` para el `json` embebido. Lector propio por operación, sin FluentValidation, igual que keel-nest |
| JPA + Flyway / TypeORM | **EF Core 10** + migraciones EF (`dotnet ef` como herramienta local en `.config/dotnet-tools.json`). Npgsql para PostgreSQL. MySQL más tarde y medido (riesgo §5) |
| `@Version` | `IsConcurrencyToken()` sobre `version`. EF sí comprueba la versión, a diferencia de TypeORM, y se mide con `db-check` |
| UUIDv7 | `Guid.CreateVersion7()`, del BCL desde .NET 9 |
| Bean Validation | lectores generados con las reglas de `inputRules` |
| Spring Security JWT | `Microsoft.AspNetCore.Authentication.JwtBearer` + políticas de `keel-core/gen/access-plan.js`. Política de reserva para que una ruta inexistente sin credencial dé 401 y no 404 (se mide en el inc. 8) |
| resilience4j / circuito propio | Polly v8 para retry y timeout. El **circuito**, máquina propia comparada con `circuitBreakerReference`, como keel-nest: el de Polly muestrea por ventana de tiempo y no dice lo mismo |
| `@Scheduled` / `cron` | `BackgroundService` + **Cronos** (cron de 6 campos con segundos) |
| RabbitMQ / Kafka / SNS-SQS | `RabbitMQ.Client` 7, `Confluent.Kafka`, `AWSSDK.SimpleNotificationService/SQS`. **No MassTransit** |
| MongoDB | `MongoDB.Driver` oficial, `GuidRepresentation.Standard`, `Decimal128` |
| Redis | `StackExchange.Redis` |
| S3 | `AWSSDK.S3` |
| SMTP + plantillas | **MailKit** + **Handlebars.Net** con escapado estricto |
| Logback / pino | `Microsoft.Extensions.Logging`: consola JSON, scopes para la correlación y exportación OTLP |
| Micrometer + OTel | OpenTelemetry .NET (trazas y logs por OTLP) + métricas por scrape con **los nombres del vocabulario neutral** (riesgo §5) |
| Actuator | Health checks nativos en `/livez` `/readyz` + puerto de gestión con `RequireHost("*:<MANAGEMENT_PORT>")` |
| JUnit / Vitest | xUnit v3 + reporte JUnit. `score-scenarios.sh` lo lee con `keel-core/gen/junit-scoring.js`, al que se añade el orden de atributos de .NET |
| Testcontainers | No hace falta: el arnés usa la `infra/` compartida |

## 3. Anatomía del paquete `packages/keel-dotnet/`

Calcada de keel-nest. Se reutiliza de `keel-core/gen`:

- `gateDesign`, `resolveStack`, `materialize`, `project-writer`, `generated-manifest`,
  `specs-seal`, `evolution`.
- `buildModel` (con la nueva proyección), `wire`, `api-contract`, `access-plan`, `openapi`,
  `relational`, `document`, `messaging-stores`, `reconciliation-stores`, `outbound-resilience`,
  `cache-plan`, `scheduling`, `dispatch`, `infra-scripts`, `messaging-provisioning`,
  `identity-provisioning`, `junit-scoring`, `idempotency-gate`, `deploy-probes`,
  `telemetry-vocabulary` y los `*-probes`.

Lo propio del paquete:

- `src/cli.js` y `src/commands/{build,check}.js`.
- `src/lib/assets.js` (`SUPPORTED_DSL` = 2.21).
- `src/lib/cs-projection.js`, que implementa todo `PROJECTION_MEMBERS`/`PROJECTION_MESSAGES` de
  `keel-core/src/lib/gen/projection.js`.
- `src/lib/dotnet-stack.js` (paquetes, cadenas de conexión y SPDX), `supported-features.js` y
  `engine-support.js`.
- `src/scaffold/*.js`, un módulo por artefacto con un solo mapa de rutas en `render.js`.
- `assets/agents/` y `assets/generators/dotnet/`: `architecture.md`, `constitution.md`,
  `orchestration.md`, `conventions/mapping.md` y `skills/keel-dotnet-<tech>/`.

Registro en `KNOWN_GENERATORS` (`keel-core/src/lib/assets.js`).

### Las redes del paquete

**Sin SDK:**

- `test/*.test.js` sobre el texto emitido, con paridad contra keel-spring y keel-nest.
- `test/cs-syntax.test.js`: un parser de C# en WebAssembly (`web-tree-sitter` + `tree-sitter-c-sharp`,
  MIT) sobre todas las fixtures y siluetas. Comprueba la sintaxis y que todo `using` del propio
  servicio apunte a un namespace emitido. Es el equivalente de `ts-syntax.test.js`.

**Con SDK** (`npm run cs-check`): genera, `dotnet restore --locked-mode`,
`dotnet build -warnaserror`, `dotnet test`, arranca y pide `/livez` contra PostgreSQL en podman.
Después vienen los checks en vivo por mecanismo, igual que en keel-nest.

## 4. Incrementos

El orden y los contenidos son los de keel-nest. Lo que cambia es dónde está el riesgo propio de .NET.

| Inc. | Objetivo | Puerta |
|---|---|---|
| 0 | Línea base: `golden` de keel-spring y paridades de keel-nest en verde antes de tocar `keel-core` | digests idénticos |
| 1 | Hueco neutral: auditar qué decisiones siguen dentro de keel-nest o keel-spring y extraerlas. Primero el orden de atributos JUnit de xUnit en `junit-scoring.js`, y los casos de `wire.js` ejecutables desde C# | golden idéntico; `gen-neutral.test.js` |
| 2 | Esqueleto: CLI, puerta, `cs-projection`, solución de 4 proyectos que compila y arranca, perfiles `local/develop/production/test` con el gradiente de variables, `/livez` `/readyz`, apagado ordenado, `licenses.test.js`, harness con `emitHarnessFiles()` | `build`/`check`/`tmp-hygiene`/`licenses`; `cs-check` 7/7 |
| 3 | Contrato del cable: conversores STJ y prueba emitida con **todos** los casos de `wire.js` | la prueba emitida en `cs-check`; falsada quitando la escala o el formato del timestamp |
| 4 | Dominio y aplicación: value objects con guardas, agregados con lifecycle, mediator propio, errores declarados | paridad de nombres y errores con keel-spring; `cs-syntax` |
| 5 | API REST: Minimal APIs, lectores, `ErrorResponse`, paginación, `Location`, OpenAPI derivado byte a byte | `contract-parity` contra keel-spring; `openapi.test.js` |
| 6 | Persistencia relacional: EF Core + Npgsql, esquema de `relational.js`, FKs, índices únicos condicionados, versión, transacción del caso de uso por *scope* de DI, `SKIP LOCKED` en SQL crudo | `schema-parity`; `db-check` (PostgreSQL) |
| 7 | Arnés de integración + agentes (`keel-dotnet-code/infra/validate/quality`) + `score-scenarios.sh` | `harness-check`; **primera corrida** sobre `notification-mailer` |
| 8 | Seguridad (Keycloak, Cognito) | `security-parity`; `security-check` |
| 9 | Mensajería: los tres brokers, outbox, `processed_event`, DLT con las cabeceras de Spring Kafka | `broker-check` |
| 10 | Idempotencia, reclamos, rescate, purgas por lotes, scheduling, gate de idempotencia | `idempotency-check.test`; `db-check` |
| 11 | Clientes HTTP salientes, circuito propio, reconciliación, arnés WireMock | `http-clients.test`; `stub-check` |
| 12 | Persistencia documental (MongoDB, replica set) | `doc-check`, `doc-harness-check`; corrida `-mongo` |
| 13 | Caché, storage, correo y pagos (Stripe y MercadoPago, sin SDK de pasarela) | `cache/mail/stub-check` |
| 14 | Telemetría y despliegue: mismas series del panel, exemplars, `deploy/` | `telemetry-check`, `deploy-check` |
| 15 | Evolución (`keel-core/gen/evolution.js` + `DOTNET_EVOLUTION`) | `design-evolution.test` con paridad del delta |
| 16 | Cierre: frontera sin rechazos sin motivo, matriz sin `sin ejecutar`, `capability-coverage`, corrida de control del par MVP en los **tres** generadores | 4×23/23 y huella comparable |

### Estado

- **Inc. 0 — hecho (2026-10-13).** La línea base del golden de keel-spring estaba desfasada: se
  regeneró por última vez en `e6f5e6a`, y `f9d8a02`, `1b8d927` y `85d0386` cambiaron después lo
  emitido. `--check` dio 193 huellas cambiadas en 6 familias, y cada una casa con uno de esos
  commits:
  - `wire-contract.md`, `IdempotencyKeyFilter`/`IdempotencyContext` y `UpdateProductCommand`:
    `85d0386`, el PATCH con null.
  - `keel-spring-quality.md` y `ListProductsQueryHandler`: `1b8d927`, el LIKE.
  - `openapi.yaml`: `f9d8a02`.

  Ningún archivo queda sin explicar, así que la línea base se regeneró: 44 combinaciones y 11 137
  archivos, idéntica en el `--check` siguiente. Suites: keel-core 1186/1186, keel-spring
  1658/1658 y keel-nest 794/794 (paridades incluidas).
  - **Lección para los incrementos siguientes**: los cambios de lo emitido en keel-spring no
    regeneraban el golden en el mismo commit. A partir del inc. 1, todo cambio en `keel-core/gen`
    pasa `golden -- --check` antes de dar el commit por bueno.
- **Inc. 1 — en curso.**
  - **1a, el reporte de xUnit (hecho).** XML capturado de una ejecución real de xUnit v3 3.2.2
    (`-jUnit`, SDK 8, que ya ejecuta xUnit v3). La matriz lo lee bien tal cual: los atributos van
    como en Gradle, todo en una línea y las clases anidadas con `+`. Lo que no leía bien era el
    mensaje de una prueba en rojo que no es escenario: xUnit escribe el salto como `&#xA;` y escapa
    la comilla con barra (`\&quot;`), y el awk solo conocía `&#10;`. Arreglado en
    `junit-scoring.js`. El caso lleva el XML real en `test/junit-scoring.test.js`, en rojo antes del
    arreglo. Cambio intencional de lo emitido: solo `infra/score-scenarios.sh` en las 44
    combinaciones de keel-spring; línea base regenerada. Una `[Theory]` da una fila por dato, igual
    que `@ParameterizedTest` o `it.each`: no es un hueco de .NET, y la skill pedirá un `[Fact]` por
    flujo.
  - **1b, línea base de keel-nest (hecho).** La mecánica del golden pasa a
    `keel-core/gen/golden-digest.js` (huella, comparación y `runGolden`). keel-spring la usa con sus
    combinaciones y sale idéntica (44 / 11 137). keel-nest gana `npm run golden` con las mismas
    combinaciones menos Oracle (41 / 10 050), determinista y falsada: un espacio en una plantilla
    las pone rojas las 41.
  - **1c, el gradiente por perfil.** Inventario: 24 definiciones (3 en keel-spring y 21 en
    keel-nest: 12 `envWithDefault`, 10 `envValue` y 1 `envRequired`).
    1. **Hecho.** `keel-core/gen/profile-values.js` con la semántica de keel-spring; la usa
       todo lo que ya la tenía (keel-spring y once copias de keel-nest). Las dos líneas base
       salen idénticas.
    2. **Hecho; `ts-check` 13/13.** Las siete copias de `envWithDefault` que escribían el
       literal en `test` (claim, kafka, logging, messaging, rabbitmq, snssqs y telemetry) pasan a
       la de keel-spring, `${VAR:default}`. Solo cambian 113 archivos `config/parameters/test/*.yaml`
       de keel-nest, y lo que los lee ya convierte el texto (`positive()`, `!== 'false'`), porque
       en develop y production siempre fue texto.
       - **Lo que destapó: la de keel-spring no era la buena en `envRequired`.** Su
         `envRequired` pedía `${VAR}` sin default en `test`, contra su propia regla («`test` es
         un perfil cerrado que arranca sin que nadie exporte nada»). No se notaba porque ningún
         fragmento de keel-spring con un valor obligatorio llega al perfil `test`. En keel-nest
         sí llega (la seguridad configura ahí la clave de prueba), y su copia ya lo tenía bien.
         El neutral toma `test` como literal y keel-spring sigue idéntico, que es la prueba de
         que nunca lo llamaba con `test`.
       - Queda una excepción con motivo: el `envValue` de mail en keel-nest entrecomilla el vacío,
         por cómo lee YAML su cargador, no por el contrato.
       - `test/profile-values-source.test.js` prohíbe una copia nueva; falsado plantando una.
    3. **Hecho.** `keel-core/gen/runtime-env.js`: el catálogo de las variables de entorno del
       servidor que no dependen del lenguaje.
       - Inventario: 93 variables con gradiente en los dos generadores, 72 compartidas. De esas,
         las de los parámetros del outbox, del barrido y de la pasarela ya venían de su propio
         catálogo neutral. Las demás se escribían a mano en cada emisor, con su nombre, su
         gradiente y su default.
       - El catálogo tiene 51 entradas de dos clases. Con `default` (35), el valor lo fija el
         catálogo y `envFor` lanza si un emisor intenta poner otro. Sin `default` (la URL de la
         base de datos, la audiencia, el issuer), el valor sale del diseño y el catálogo fija
         nombre y gradiente.
       - Lo que es de una plataforma se queda en su generador (`FLYWAY_ENABLED`, `MANAGEMENT_*`
         de Spring; los intervalos de reconexión del cliente en Nest).
       - 107 llamadas reescritas a `envFor` (55 en keel-spring y 52 en keel-nest). Ninguna
         contradecía el gradiente del catálogo.
       - Las constantes copiadas (`LOCAL_API_KEY`, `LOCAL_CORS_ORIGINS`,
         `DB_TRANSACTION_TIMEOUT`, `DB_POOL_CONNECTION_TIMEOUT_MS`, `MANAGEMENT_PORT`,
         `RABBIT_RECOVERY_INTERVAL_MS`) conservan su nombre exportado, pero salen del catálogo.
       - El `envValue` de mail en keel-nest desaparece: el vacío entrecomillado pasa a ser un
         `yamlScalar()` sobre el valor del catálogo. Era cómo lee YAML esa plataforma, no otro
         gradiente.
       - Las dos líneas base salen idénticas.
       - `test/runtime-env.test.js` ata cada valor local a lo que publica la `infra/` de prueba
         (puertos del compose, credenciales de LocalStack y RabbitMQ, el SMTP de Mailpit).
         Falsado con el puerto de RabbitMQ a 5673.
       - `test/profile-values-source.test.js`, en los dos generadores, prohíbe definir el
         gradiente y escribir a mano una variable del catálogo. Falsado plantando una llamada.
       - **Fuera de este paso, para el README de keel-dotnet:** la descripción de cada variable.
         keel-spring documenta 21 en su README con un formato distinto del de keel-nest, y el
         catálogo no lleva descripciones todavía.
  - **1d, decisiones y datos que keel-nest reimplementó (hecho).**
    - **Método.** keel-nest anota cada copia («la misma que keel-spring»): 96 anotaciones.
      Descontadas las que citan un módulo de keel-core y las que son forma o comportamiento
      traducidos al idioma de cada plataforma, que keel-dotnet escribirá en C#, quedan las
      decisiones y los datos. Cada uno pasa a keel-core con la versión de keel-spring y las dos
      líneas base hacen de oráculo: si keel-nest decidía distinto en alguna fixture, su línea
      base cambia.
    - **Lote 1, decisiones del modelo:**
      - `hasCallFallback` (`outbound-resilience.js`);
      - `occurredAtField` (`replica.js`);
      - `usesClusterScenarios` (`cluster-scenarios.js`).
    - **Lote 2, datos:**
      - la jerarquía de errores por status, que estaba escrita **cuatro** veces (`error-bases.js`);
      - `WRITE_CONFLICT_ATTEMPTS` (`transactions.js`);
      - las defensas del correo: cabeceras reservadas, nombre de cabecera, tabla de escapado y
        caché de plantillas (`mail-message.js`);
      - la regla y los tres números de la espera del buzón (`mail-probes.js`);
      - el tope del último valor conocido (`last-known.js`);
      - la ruta de la sonda (`broker-probes.js`);
      - las URLs del proveedor de prueba en `local` y `test`, y qué motores fijan
        `READ COMMITTED` en el reclamo (`infra-catalog.js`). keel-nest lo decidía en tres
        emisores y tenía el puerto `8090` escrito a mano;
      - el autor `system` (`relational.js`);
      - los niveles de log por perfil (`runtime-env.js` gana `byProfile`).
    - **Sin cambio de salida en ningún lote:** keel-spring 44 / 11 137, keel-nest 41 / 10 050.
      Son 18 piezas. Las reglas (clase base, escenarios de clúster, fallback, instante del
      hecho, aislamiento, espera del buzón y defensas del correo) las fija además
      `test/shared-decisions.test.js`, también en ramas que ninguna fixture recorre. Las
      constantes no llevan test propio: su valor lo vigila la línea base.
    - **Una divergencia latente.** El `usesReplica` de keel-nest contaba como «barrido por
      reloj» las purgas de las tablas del generador, y la de `processed_event` existe con
      cualquier suscripción y persistencia. Un diseño con solo eso tenía escenarios de clúster
      en keel-nest y no en keel-spring. Ninguna fixture tiene esa forma; manda la de keel-spring,
      porque una purga es limpieza y no una garantía del diseño.
    - **Lo que no se extrae, con motivo:** reconocer un conflicto transitorio (el driver de cada
      plataforma da excepciones o códigos distintos); las notas para el agente, que nombran
      símbolos de cada proyecto; y `HANDLEBARS_VERSION`, que es la versión de dos librerías
      distintas.
- **Inc. 1 — cerrado (2026-10-13)** con 1a, 1b, 1c (tres pasos) y 1d (dos lotes).
- **Inc. 2 — hecho (2026-10-13).** El paquete `packages/keel-dotnet`, calcado del incremento 2 de
  keel-nest (commit `f6dcb86`).
  - **El paquete**:
    - CLI con `build` y `check` sobre el tronco neutral (`gateDesign`, `evolveStack`,
      `reportGeneratorDrift`, `materializeProject`);
    - `cs-projection.js` con el contrato entero;
    - la frontera: dominio, casos de uso y API aceptados con aviso, el resto rechazado con su
      incremento;
    - `dotnet-stack.js` con versión exacta y SPDX de cada paquete;
    - registro en `KNOWN_GENERATORS`.
  - **El proyecto emitido**: `global.json`, `Directory.Build.props` (net10.0, nulabilidad,
    warnings como errores, lockfile, NuGet Audit en aviso), `Directory.Packages.props`, `.slnx`,
    un proyecto por capa y uno de pruebas.
    - `config/application.yaml`, con las mismas líneas que el de keel-nest (un test lo compara),
      y su cargador C# (`ServiceConfiguration`), traducción del de keel-nest.
    - `/livez` y `/readyz` con el drenaje sobre el ciclo de vida del host.
    - `Program.cs`, que valida la configuración antes de crear la aplicación.
    - Las pruebas: el gradiente, las sondas en memoria y el drenaje sin señal.
  - **Medido**:
    - `npm test` 60/60: build, check, frontera, la proyección en las 15 fixtures (mismas
      entidades, rutas, status y avisos que con Java y TypeScript), licencias y rasgos del
      scaffold;
    - `npm run cs-check` 10/10: SDK, generación, restore, restore `--locked-mode`, licencias de
      los 49 paquetes resueltos contra nuget.org, build sin warnings, 12 pruebas, `/livez`,
      `/readyz` y 404. El apagado tras SIGTERM no se mide en Windows, y se dice.
    - Falsado dos veces: `/readyz` saboteado a `DOWN` pone roja exactamente su prueba emitida, y
      MediatR 13 añadido al proyecto pone rojo el paso de licencias, por dos motivos (regla
      comercial y sin SPDX).
  - **Decisiones medidas, no supuestas:**
    - **xUnit v3 4.x con el SDK 10 ya no corre por VSTest.** Se opta por Microsoft.Testing.Platform
      en `global.json`, y sobran `xunit.runner.visualstudio` y `Microsoft.NET.Test.Sdk`. Su reporte
      JUnit (`--report-xunit-junit`) pone `time` entre `name` y `classname`. Los awk neutrales lo
      leen, pero el incremento 7 debe fijarlo en `junit-scoring.test.js` con un XML capturado de
      esta versión.
    - **`.slnx`**, el formato que crea hoy `dotnet new sln`.
  - **Trampas que costaron un ciclo cada una:**
    - Un comentario XML con `--` hace que MSBuild descarte el `.props` entero **sin decir nada**:
      el `TargetFramework` llegaba vacío y la restauración fallaba con «devolvió false, pero no
      registró un error». Lo caza ahora `scaffold.test.js`, que exige XML bien formado.
    - En una plantilla de JS, incluso con `String.raw`, un `${` literal del C# se evalúa.
    - Los heredocs de la terminal se comen las barras dobles: los archivos se escriben con el
      editor.
- **Inc. 3 — hecho (2026-10-13).** El contrato del cable (`src/scaffold/wire.js`).
  - **Dónde vive**: en el proyecto Application (`Support/`), porque System.Text.Json es de la
    biblioteca base y no arrastra ASP.NET Core. `WireJson.Configure` lo aplica a cualquier
    `JsonSerializerOptions`, y `Program.cs` lo instala con `ConfigureHttpJsonOptions`: un solo punto
    de lectura y escritura, como Fastify en keel-nest. `WireJson.Options` es la copia de solo lectura
    para quien serializa fuera de la API.
  - **Lo que .NET ya hacía bien** y solo se fija por escrito: la escala del `decimal`, sin notación
    exponencial; el `long` entero; el `Guid` en minúsculas; ignorar lo desconocido.
  - **Lo que necesitaba conversor o ajuste:**
    - `DateTimeOffset` salía con `+00:00` y siete decimales. Ahora sale en UTC, con `Z` y tres
      decimales truncados, y se lee solo con zona.
    - `JsonElement` no se leía desde una cadena.
    - El codificador por defecto escapaba lo no ASCII y la comilla (`"`); ahora va
      `UnsafeRelaxedJsonEscaping`.
    - El enum va por `[JsonStringEnumMemberName]` (.NET 9+), con `allowIntegerValues: false`.
    - Omitir nulos es por tipo, con `[OmitNulls]` y un modificador del contrato.
    - Las opciones de ASP.NET Core parten de las de la web, que comparan nombres sin mayúsculas. Se
      fija la comparación exacta, como Jackson y keel-nest.
  - **Una divergencia medida y cerrada**: el `decimal` de .NET tiene 28-29 dígitos. Por encima del
    máximo lanza (400), pero con más de 28 decimales **redondea en silencio**: `1E-40` se leía 0. El
    conversor compara la escala leída con la escrita y lo rechaza. Ningún caso de `wire.js` llega ahí,
    así que va en pruebas propias, no en el contrato neutral. Lo que queda es un límite con motivo:
    Spring acepta lo que aquí es un 400. Se cierra en el diseño, con las cotas del `decimal`.
  - **Medido**:
    - `npm test` 62/62. La prueba emitida lleva los 31 casos de `wire.js`, en su orden y sin uno
      de más, y el texto no ASCII va escapado en el fuente (`csString`).
    - `cs-check` 10/10, con 54 pruebas emitidas.
  - **Falsado** con `cs-check --sabotage=<id>` (nuevo, calcado de `mail-check`). Cada sabotaje
    tumba las pruebas de su regla y solo esas:
    - `decimal-scale`: 4 de 54;
    - `decimal-exact`: 2;
    - `timestamp-format`: 1, `timestamp-pads`;
    - `utf8`: 1.
  - **Pendiente para el inc. 16**: `wire-contract.md` nombra solo a keel-spring y keel-nest. Cambiarlo
    ahora movería las dos líneas base por una mención a un generador sin publicar.
  - **Para el inc. 4-5**: la red de `PropertyNamingPolicy` en camelCase solo cubre lo que no se nombra.
    Los DTO llevarán `[JsonPropertyName]` con el nombre del diseño, porque la política convierte mal
    los acrónimos.
- **Inc. 4 — hecho (2026-10-13)**, en dos tramos. La red sin SDK (`cs-syntax` con tree-sitter) queda
  para después (ver «Pendiente»).
  - **4a, el dominio.**
    - **Lo neutral, primero**: el script del gate del formato (`infra/check-domain-guards.sh`) pasa a
      `keel-core/gen/domain-guards.js` (`domainGuardsScript`). Lo que cambia de un lenguaje a otro va
      como parámetro: archivo de la clase, extensión, línea de import y nombre del método. keel-nest
      sale idéntico (41 / 10 050). keel-spring conserva el suyo con motivo escrito: busca la clase por
      nombre con `find`, y unificarlo movería su línea base sin cambiar lo que mide.
    - **Los emisores**: `enums`, `exceptions`, `value-types`, `entities`, `events` y
      `domain-guards-check`, sobre un `render.js` que es el único mapa de tipo → namespace y archivo.
    - **Lo que en C# toma otra forma**:
      - **Enums**: el miembro es el valor del diseño en PascalCase y lleva
        `[JsonStringEnumMemberName]`. Las constantes de Java del modelo (`DRAFT`) se traducen por su
        valor.
      - **Value objects**: clases selladas con `IEquatable`. La igualdad (`ValueEquality`) compara
        la escala del decimal, como `BigDecimal.equals`.
      - **`Decimals.SetScale`**: `decimal.Round` no sube la escala (2.5 a dos decimales sigue
        siendo 2.5). `SetScale` la sube sumando un cero con la escala pedida.
      - **Expresiones regulares**: van ancladas con `\z`, porque el `$` de .NET casa también antes
        de un salto de línea final.
      - **Entidades**: el estado de rehidratación es una clase con propiedades `required`. El
        compilador exige que esté completo, sin argumentos posicionales que se desordenen.
      - **`Raise`**: una sobrecarga por evento del diseño, así que el agregado solo acumula los
        suyos.
      - **UUIDv7**: es `Guid.CreateVersion7()` del BCL, así que no hace falta la clase `Uuids`.
  - **4b, la aplicación.**
    - **Los emisores**: `services` (mensajes y handlers), `dtos`, `mappers` y `mediator`.
    - **Contratos**: C# conserva los genéricos al compilar, así que no hace falta el `@Handles` de
      keel-nest. Cada handler implementa `IQueryHandler<TQuery, TResult>` (o sus hermanos) y
      `UseCaseRegistration` lo registra en el contenedor: es generado y explícito.
    - **El mediator**: es propio, sin MediatR. Cierra los genéricos con un envoltorio por tipo de
      mensaje y lleva el log de frontera con `[LoggerMessage]`.
    - **El dispatcher**: `ICommandDispatcher` se emite solo si el diseño lo pide (`dispatches`,
      operaciones internas huérfanas, pagos).
    - **Los mensajes** son clases (no records: el `ToString` de un record imprime los datos de quien
      llama) con propiedades `required`.
      - Un opcional de PATCH es `Optional<T>`: tres estados, como el `JsonNullable` de keel-spring.
      - `scalePolicy: round` en un decimal escalar se redondea en el propio mensaje
        (`init => field = …`, C# 14).
    - **Los DTOs** son records con `[JsonPropertyName]` en el orden del diseño.
    - **Los mappers** asignan campo a campo. Lo que no sale tal cual de la entidad es un
      `Todo.Value<T>(...)`, que compila y falla nombrando el campo: el tipo no casa, o la entidad
      admite null y el DTO no.
    - **La frontera**: dominio y casos de uso ya no avisan. Avisa de `idempotency` y `schedule`
      (inc. 10) y de `cache` (inc. 13) por operación, como keel-nest en su incremento 4.
  - **Dos defectos que destapó compilar TODAS las fixtures, no solo la de referencia:**
    - Una entidad que se llama como un segmento del namespace raíz (`Application` en
      notification-mailer) resolvía al namespace `NotificationMailer.Application` y no compilaba.
      Los `using` van ahora **dentro** del namespace, en todos los archivos (`csFile`), y así se
      consultan antes que los namespaces exteriores.
    - `Decimals` solo se emitía con value objects. Un diseño sin ellos que redondea un decimal de
      entrada no compilaba. Lo destapó la variante derivada `payment-checkout-round`: ninguna fixture
      ejercía esa rama.
  - **Una corrección del inc. 3**: `csString` escapaba los acentos (`más`). El fuente se
    escribe en UTF-8 y los comentarios ya los llevaban tal cual, así que aquella precaución no
    protegía nada y sí estorbaba la lectura. Ahora solo escapa los caracteres de control.
  - **Medido**:
    - `npm test` 152/152, que incluye:
      - paridad de errores (clase, `code`, status) con lo que EMITEN keel-spring y keel-nest, en
        las 15 fixtures;
      - las mismas filas del gate del formato que los otros dos, y el gate EJECUTADO con bash (rojo
        recién generado, rojo con la llamada en un comentario, verde con una real, y avisa si falta
        la clase);
      - mensajes con la misma clase, y DTOs con las mismas claves en el mismo orden que keel-nest;
      - el registro y la fila de cableado de cada operación.
    - keel-core 1 206/1 206 y keel-nest 798/798.
    - **`cs-check` 12/12**. Gana un paso que compila, en UNA solución, todo lo que se emite para las
      15 fixtures y dos variantes derivadas (85 ensamblados, sin un warning). Después ejecuta sus
      pruebas emitidas y las sondas del dominio: 1 072 pruebas.
      - Entre ellas, `UseCasesTests` de cada fixture: el contenedor se construye entero
        (`ValidateOnBuild`), cada mensaje llega a su handler, y el mediator despacha las tres clases
        de mensaje y deja pasar el rechazo del dominio.
      - Las sondas (`scripts/probes/DomainProbes`) son C# de verdad, no plantillas. Calcan los casos
        de `keel-nest/test/domain.test.js`: escala normalizada, rechazos con 400 `VALIDATION_ERROR`,
        `scalePolicy: reject` y `round`, el `\z`, la transición negada con 409, colecciones de solo
        lectura y el orden del cable de la metadata.
      - `--fixtures` corre solo ese paso.
  - **Falsado**:
    - **Sin la subida de escala de `SetScale`**: caen las dos sondas de escala.
    - **Con la guarda del lifecycle rota**: cae la sonda de la transición.
    - **Con otro status en la transición**: caen 13 pruebas de paridad.
    - **Con el orden de los DTOs invertido**: caen las 15 de paridad del cable.
    - **`cs-check --sabotage=wiring`** (sin el registro de un handler): cae exactamente la fila de
      `GetProductQuery` (1 de 61).
  - **Pendiente**:
    - **4c, `cs-syntax`**: la red sin SDK con `web-tree-sitter` + `tree-sitter-c-sharp`. Añade dos
      dependencias de desarrollo, y la duda del §5 (si el parser entiende C# 14: `field`,
      constructores primarios) sigue abierta.
    - **Las notas de los handlers que cuelgan de otras capas** (persistencia, idempotencia, correo,
      caché, embeds, subidas, alcance) llegan con su incremento, igual que en keel-nest.

- **Inc. 5 — hecho (2026-10-13)**, en dos tramos.
  - **5a, lo neutral primero.** Sin cambio de salida: keel-spring 44 / 11 137 y keel-nest 41 / 10 050.
    - `keel-core/gen/api-errors.js`: el `error` y el `message` de cada clase base de la jerarquía y de cada fallo
      del framework (malformada, validación del cuerpo y de los parámetros, parámetro ausente, 404, 405,
      catch-all). Estaban escritos a mano en el `ApiExceptionHandler` de keel-spring y copiados en el filtro, la
      seguridad y la prueba emitida de keel-nest. `test/api-errors.test.js` prohíbe el literal en el `src/` de
      cualquier generador; su primera ejecución encontró las cinco copias de la prueba emitida de keel-nest.
    - `keel-core/gen/api-cases.js`: qué peticiones elige del diseño la prueba emitida de la API. Los componentes
      del mensaje entran por parámetro (con persistencia keel-nest lee un Pageable).
    - El lector de la tabla de rutas de keel-spring pasa de la paridad de keel-nest a
      `keel-spring/test/helpers/contract-table.js`, oráculo de las dos paridades.
  - **5b, la API en keel-dotnet.**
    - `rest-support.js`: `CorrelationContext` (en Infrastructure, sobre `AsyncLocal`: la mensajería lo usará) y
      su middleware, `ErrorResponse` en el orden del cable, los lectores (`JsonBodyReader` con el contrato del
      cable, `TextValues` con las conversiones de Spring), `InputRule`/`InputViolations` con los mensajes de
      Hibernate Validator, `HttpReply` y `ApiErrorMiddleware`, que también pone cuerpo al 404 y al 405 que el
      enrutado de ASP.NET Core devuelve vacíos.
    - `endpoints.js`: un `<Grupo>V1Endpoints` por grupo, con un lector GENERADO por operación en el orden del
      binding de Spring, y `ApiRoutes`: la tabla de rutas como datos y el único sitio que las registra
      (`MapMethods` con un `RequestDelegate`, sin el enlace de parámetros de las APIs mínimas).
    - El `openapi.yaml` derivado neutral, byte a byte el de los otros dos.
    - La frontera ya no avisa de la capa `api`.
  - **Decisiones medidas, no supuestas:**
    - `Exception.Message` nunca es null en .NET (sin mensaje inventa uno en inglés): `DomainException` guarda
      `GivenMessage` y el manejador responde con el de la clase base cuando falta, como keel-spring.
    - El enum se lee del cuerpo por su literal EXACTO con un mapa propio, no con `JsonStringEnumConverter`.
    - En la query, el enum se compara como Spring Boot (sin mayúsculas ni separadores), que admite `IN_PROGRESS`
      e `in-progress`: un poco más que keel-nest, lo mismo que keel-spring.
    - Los conversores del cable exponen `Parse(string)`: la ruta y la query convierten decimal, instante y fecha
      con las MISMAS reglas que el cuerpo (un `1E-40` en la query es 400, no 0).
  - **Dos trampas que costaron un ciclo:** una propiedad `Source` en una excepción oculta `Exception.Source`
    (CS0114 con warnings como errores); y un diseño cuyas rutas son todas de una capa que aún no se sirve
    (`profile-directory`) dejaba `ApiRoutes` importando un namespace de endpoints vacío.
  - **Fuera, con su incremento:** las subidas multipart (13) y las operaciones con la identidad del llamante
    (8). Son 14 de las 56 operaciones con ruta; entre ellas, cinco del par del MVP.
  - **Medido:**
    - `npm test` 204/204, que incluye:
      - `contract-parity.test.js`: las 42 operaciones servidas contra lo que EMITE keel-spring (método, ruta,
        status, `Location`, query, cuerpo y campos de cada DTO). Falsado: un 201 escrito como 200 tumba 12
        fixtures;
      - `openapi.test.js`: el documento idéntico al de los otros dos, con cada ruta de `ApiRoutes` descrita;
      - `api.test.js`: la prueba emitida pide las mismas peticiones que la de keel-nest.
    - **`cs-check` 13/13**: el servidor arrancado responde 404 y 400 «Petición malformada» con el
      `ErrorResponse` del contrato; la solución de las 15 fixtures y 2 variantes compila sin warnings y pasan
      1 183 pruebas, entre ellas las `ApiTests.cs` emitidas y las sondas `scripts/probes/RestProbes` (los casos
      de `keel-nest/test/rest.test.js`, ejecutados en C#).
    - Falsado con `cs-check --sabotage=`, cada uno contra sus pruebas y solo esas:
      - `correlation` (el middleware no abre el contexto): las 5 pruebas que comparan el `correlationId` del
        cuerpo con el de la cabecera;
      - `method-405`: la del 405, 1 de 68;
      - `not-blank`: la de la validación, 1 de 68. **El primer intento no lo cazó**: la prueba emitida mandaba
        `{}`, y un ausente lo rechaza también la rama del null. Ahora manda el campo en blanco, que es más de lo
        que pide la de keel-nest.
    - keel-core 1 209/1 209, keel-spring 1 661/1 661 y keel-nest 798/798.
  - **Asimetrías conocidas, sin cubrir** (las de keel-nest siguen en pie, y dos más):
    - el `Content-Type` del cuerpo no se comprueba: Spring respondería 415, aquí se lee igual;
    - un `null` DENTRO de una lista del cuerpo es petición malformada; en keel-spring llega como elemento nulo.

- **Inc. 6 — hecho (2026-10-14)**, en tres tramos: 6a, 6b y 6c.
  - **6a, lo neutral primero.** Los defaults del Pageable (10 y el tope 2000 de Spring Data) y el orden por defecto
    que se puede traducir (`translatableSort`) estaban en keel-spring (el orden) y copiados en keel-nest (todo): pasan
    a `keel-core/gen/pagination.js`. Las dos líneas base, idénticas (44 / 11 137 y 41 / 10 050).
  - **6b, la persistencia relacional con EF Core 10 sobre PostgreSQL.**
    - **Los emisores:**
      - `persistence.js`: una fila (`<Entidad>Row`) por entidad persistida y por lista, con su mapeo fluente
        (`IEntityTypeConfiguration`), los enums por su CONSTANTE con un `ValueConverter` por enum, `TextFold`,
        `RowSync` (la fusión del grafo) y el `DbContext`;
      - `repositories.js`: la página y el puerto `I<Raíz>Repository` en `Domain/Repository`, y el adaptador con el
        mapeo explícito fila ↔ dominio (sin AutoMapper), los finders de clave natural, ocupante y campo único, y
        `List(pageable)` con el desempate por id;
      - `persistence-runtime.js`: `db.yaml` por perfil, `DatabaseSettings` (la URL JDBC de keel-spring vale tal
        cual), `PersistenceTransactions`, `PersistenceErrors`, el registro y la fábrica de tiempo de diseño.
    - **La transacción** la abre el mediator por `IUseCaseTransactions`: las consultas con `SET TRANSACTION READ
      ONLY`, el tope con `SET LOCAL statement_timeout`, y el interbloqueo repetido hasta tres veces y luego 409. Los
      adaptadores se unen a la abierta (el DbContext es del ámbito). Sin persistencia, un paso directo.
    - **Los errores del motor** salen ya traducidos de la transacción: la constraint por su NOMBRE
      (`PostgresException.ConstraintName`) al error de `keel-core/gen/constraint-errors.js`, la versión a 409, y el
      tope a 503 con `Retry-After`.
    - **El esquema**: en `local`, `EnsureCreated`; fuera, las migraciones (`ef_migrations_history`). El baseline lo
      crea `dotnet ef` (herramienta local fijada en `.config/dotnet-tools.json`) desde la fábrica de diseño, sin
      arrancar el servidor. El perfil `test` no tiene base: el contexto se construye y falla al conectar, diciéndolo.
    - **La frontera**: la persistencia relacional entra; la documental se rechaza con el incremento 12, y el motor
      solo puede ser PostgreSQL (`SUPPORTED_DATABASES`).
  - **Decisiones medidas, no supuestas:**
    - **Todo índice es NOMBRADO en EF** (`HasIndex(…, "nombre")`). EF identifica un índice sin nombre por sus
      columnas, así que dos sobre las mismas se funden. En `metering-digest` la clave natural y un índice declarado
      comparten columnas, y `uk_meter_readings_natural` DESAPARECÍA del esquema. No lo vio ni el compilador ni la
      paridad de texto: lo vio la prueba emitida del modelo.
    - **`Microsoft.EntityFrameworkCore.Relational` fijado a mano.** El proveedor de Npgsql lo pide como
      `[10.0.4, 11)`, NuGet resuelve la mínima y el paquete de diseño trae la 10.0.13: el proyecto mezclaba las dos
      (MSB3277).
    - **La unicidad es un índice único, no una clave alternativa**: EF no deja modificar una clave alternativa.
    - **La PK con el nombre de PostgreSQL** (`<tabla>_pkey`, el que deja Hibernate) y las FK entre agregados en el
      modelo, con `NO ACTION` como el baseline de keel-spring: en EF el esquema SALE del modelo.
    - **Guardar es fusionar**: se carga el grafo y se le lleva el agregado (RowSync), con la versión leída como valor
      ORIGINAL del token de concurrencia. EF escribe `WHERE lock_version = @leída`; a diferencia de TypeORM, sí
      comprueba la versión.
  - **Medido:**
    - `npm test`: keel-dotnet 234/234, keel-core 1 212/1 212, keel-spring 1 662/1 662 y keel-nest 798/798.
    - `schema-parity.test.js` (nuevo): tablas, columnas (nulabilidad, cota, escala), nombres y predicados contra lo
      que EMITE keel-spring, en las 11 fixtures relacionales más la derivación del value object opcional. El lector
      de keel-spring pasa a `keel-spring/test/helpers/schema-table.js` y lo usa también la paridad de keel-nest.
      Falsado con tres sabotajes aislados: la cota +1 tumba 10 fixtures, un índice de FK de menos tumba 2, y la
      nulabilidad del value object opcional tumba la derivación.
    - `persistence.test.js` (nuevo): `db.yaml` con las mismas variables, gradiente y defaults que keel-nest; puertos,
      adaptadores y handlers; el traductor con una fila por constraint; la frontera transaccional.
    - **`cs-check` 15/15**, contra un PostgreSQL en podman:
      - licencias de 76 paquetes resueltos;
      - `dotnet ef` genera el baseline y compila con él;
      - el servidor arranca en `develop` con `DB_URL` del entorno, aplica la migración y responde con el contrato;
      - la solución de las 15 fixtures y 2 variantes compila, y pasan 1 291 pruebas. Entre ellas, la nueva
        `PersistenceModelTests` de cada fixture: EF construye el modelo y genera el DDL sin base, el DDL lleva cada
        nombre del diseño y ninguno puesto por EF (`PK_`, `FK_`, `IX_`, `AK_`). Falsada quitando el nombre de la PK:
        cae esa prueba en las cinco fixtures afectadas.
  - **6c, `db-check` (hecho, 2026-10-14).** `npm run db-check --workspace packages/keel-dotnet` ejecuta los
    adaptadores generados contra un PostgreSQL real, en las 11 fixtures relacionales.
    - **Las sondas** son un proyecto xUnit por sujeto, escrito desde el modelo (`scripts/lib/db-probes.js`) y compilado
      contra lo emitido. Las muestras respetan cotas y patrones del diseño (el texto de un patrón lo da `sampleFor`, el
      de keel-nest). Toda referencia a otra raíz apunta a una guardada de verdad: su FK existe.
    - **Por raíz**: ida y vuelta del agregado entero, comparado con el contrato del cable; la fila en crudo (el enum
      por su constante); la lectura obsoleta → el 409 de concurrencia; la clave natural repetida → su error declarado
      con su mensaje; la unicidad CONDICIONADA → el suyo; un texto por encima de su cota lo rechaza el motor (22001);
      la página con su total y el borrado del grafo.
    - **El esquema**: el catálogo del motor (`information_schema`, `pg_indexes`, `pg_constraint`) contra el mapeo
      emitido (columnas, cotas, escalas, nulabilidad, nombres y predicados), sin ningún nombre puesto por EF.
    - **Medido: 26/26, 74 sondas.** Falsado con cuatro sabotajes que compilan, cada uno cazado por su comprobación:
      `version` (la versión leída no es el valor original del token) tumba solo las sondas de versión; `constraint`
      (el traductor no reconoce ninguna) solo las de unicidad; `enum` (se guarda el miembro de C#) la fila en crudo y
      todo lo que relee; `index` (los únicos salen con otro nombre) el catálogo y las sondas de unicidad.
    - **Lo que destapó, todo de las sondas y nada del generador:** una referencia OPCIONAL dentro de la clave natural
      (`Template.application`) a null no choca nunca, porque en PostgreSQL dos NULL no son iguales en un índice
      único; el choque de la clave natural de `Template` violaba además la unicidad condicionada (las dos muestras
      estaban activas); y los sujetos creando su base a la vez chocan copiando `template1` (55006).
    - **Dos fallos del propio check, arreglados antes de darlo por bueno:** `Catalog.DbProbes.` es subcadena de
      `ProductCatalog.DbProbes.`, así que un sujeto se llevaba los fallos de otro; y el primer sabotaje `index` no
      rompía nada, porque un índice NOMBRADO en EF usa ese nombre aunque falte `HasDatabaseName`.
  - **Fuera, con su incremento**: el outbox, `processed_event`, la idempotencia y la reconciliación (9-11), con sus
    tablas; los finders de credencial, de lote y `FindAllById` (8, 11 y 13); la relación a-uno dentro del agregado y
    el value object anidado salen como TODO que compila y falla nombrándose, como en keel-nest.

- **Inc. 7 — en curso.** Tramos como los de keel-nest: 7a (la `infra/` neutral) ya estaba hecho en keel-core.
  - **7b, el arnés (hecho, 2026-10-14).**
    - **`infra/`**: la neutral de `keel-core/gen/infra-scripts.js` con la plataforma `DOTNET_INFRA`
      (`src/scaffold/infra.js`): el historial es `ef_migrations_history`, el que declara el contexto de EF.
    - **El proyecto de flujos** (`tests/<Raíz>.IntegrationTests`, `src/scaffold/integration-tests.js`):
      - **Caja negra por construcción**, como el source set de keel-spring: el proyecto NO ve ningún tipo del
        servicio. Solo ordena la compilación del Api (`ReferenceOutputAssembly="false"`) y el arnés lo arranca como
        PROCESO aparte, el mismo ejecutable que se despliega, en un puerto libre bajo `local`. Un flujo que nombra
        un tipo del servicio no compila.
      - `FlowTest`: verbos HTTP, `Db()`, `ResetState()`, `Eventually()`, `AssertJson()` (estricto, números por
        su texto, comodines `<uuid>`/`<instant>`/`<any>`) y `GivenAsync()`, el Given común del flujo.
      - `FailureCapture`: la evidencia con el formato de los otros dos.
      - `[Scenario("FL-…: …")]`: el título es el `name` del XML. Los escenarios corren en el orden escrito, con
        un `ITestMethodOrderer`.
      - Un flujo que no arranca sale OMITIDO (`Assert.Skip`) y deja `<Flujo>-init.json`, como el `beforeAll` de
        keel-nest.
    - **`infra/score-scenarios.sh`**: compila, ejecuta el humo y luego la suite, con los programas de
      `junit-scoring.js` y los mismos códigos 0/1/2 (y 2 si la solución no compila). `--score` no exige el SDK.
    - **`infra/check-flows.sh`**: compila el proyecto de flujos sin construir sus referencias (un `src/` a medio
      escribir no lo pone en rojo) y rechaza una referencia que deje ver los tipos del servicio.
  - **Decisiones medidas, no supuestas:**
    - **Fuera de `dotnet test`**: con `IsTestProject=false` lo seguía ejecutando (y en rojo sin infraestructura).
      Lo que mira Microsoft.Testing.Platform es `IsTestingPlatformApplication`. Con ella a `false`, el ejecutable
      usa el runner propio de xUnit v3 (`-class`, `-result-junit`), cuyo XML ya leía la matriz.
    - **El orden**: en xUnit v3 el `ITestCaseOrderer` ordena casos DENTRO de un método. El de los métodos es un
      `ITestMethodOrderer`. El primero se ejecutaba y no cambiaba nada.
    - **xUnit 4.0.2** ya no admite `CollectionBehavior(DisableTestParallelization)` (es error con
      warnings-as-errors): `[assembly: Parallelization(Mode = ParallelMode.None)]`. Y `FactAttribute` tiene
      constructor con la información de fuente: el analizador exige que la subclase la pase.
    - **El XML de xUnit 4.x**, capturado y fijado en `keel-core/test/junit-scoring.test.js`: `time` entre `name` y
      `classname`, el salto `&#xD;&#xA;` y el motivo del omitido como texto de `<skipped>`. La matriz lo leía sin
      cambios.
  - **Una trampa de entorno**: generado bajo una ruta larga (el scratchpad, unos 150 caracteres), Roslyn compila
    Application sin dejar la DLL ni decir por qué (MSB3030 al copiarla). Es el límite de 260 caracteres de
    Windows. Va al README del proyecto generado en 7c.
  - **Medido:**
    - `npm test` 270/270; keel-core 1 214/1 214.
    - `test/integration-harness.test.js` (nuevo):
      - la `infra/` de las 15 fixtures es la de keel-spring salvo los textos de la plataforma;
      - el reset respeta el historial y el proyecto de flujos es caja negra en todas;
      - `score-scenarios.sh --score` EJECUTADO sobre XML con OK, FALLO, OMITIDO, NO_EJERC, AJENO y lo que no es
        escenario.
      - Falsado: con otra tabla de historial caen 16 pruebas, y con la referencia visible, 15.
    - **`harness-check` 27/27** (nuevo, `npm run harness-check`): `dotnet test` en la raíz sin los flujos;
      `check-flows` en sus cuatro desenlaces; la infra levantada con sus scripts; y flujos SONDA puntuados, cada
      desenlace con su código:
      - uno en verde que mide el reset contra la base y el `AssertJson` del 404;
      - uno en rojo con su evidencia;
      - uno que no arranca;
      - uno de orden;
      - un id ajeno y un flujo sin prueba;
      - la solución sin compilar y el sello roto;
      - además, que el servidor no sobrevive a la suite.
      - Falsado dos veces: con otra tabla de historial cae la sonda del reset, y sin el `TestMethodOrderer`, la
        del orden.
    - `cs-check` 15/15: compila los proyectos de flujos de las 15 fixtures y 2 variantes (102 ensamblados) en
      Release.
  - **7c, agentes, convenciones, skill y baseline (hecho, 2026-10-14).**
    - **Los assets** (`assets/`), calcados de los de keel-nest y escritos contra lo que emite keel-dotnet:
      - los cinco agentes `keel-dotnet-{code,infra,tests,validate,quality}`, hojas;
      - `architecture`, `constitution` (con la regla de licencias y la asincronía) y `orchestration`, sin modo
        evolución (llega en el inc. 15);
      - seis convenciones: `mapping`, `project-layout`, `domain-modeling`, `flow-fidelity`, `integration-tests` e
        `infra-validation`;
      - la skill `keel-dotnet-database`, con cuatro referencias.
    - **`generator-docs.js`**: la skill `/keel-generate-dotnet` con el pipeline entero (los mismos códigos y cupos
      que los otros dos) y el contexto del repo. `keel-dotnet check` imprime `design-gaps.yaml`, con la lectura
      neutral de keel-core.
    - **El baseline** (`src/scaffold/schema-baseline.js`): la migración la crea `dotnet ef migrations add` (no se
      exporta a mano, como en keel-nest).
      - `infra/export-schema.sh` deja el DDL del modelo para revisarlo.
      - `infra/verify-baseline.sh` exige migraciones y cero cambios pendientes del modelo
        (`has-pending-model-changes`). Después las aplica a una base VACÍA y aparte y compara su catálogo
        (columnas, índices, constraints) con el del DDL del modelo, aplicado a otra.
      - Esa comparación es la que caza una migración editada a mano: el snapshot del modelo no cambia con ella.
      - Falsado en vivo: sin un `CreateIndex` sale `-index … idx_products_status`; con una cota cambiada sin
        migración sale el cambio pendiente.
    - **`test/generator-docs.test.js`** (nuevo), que comprueba:
      - que las listas instalan todo `assets/`;
      - que no queda ningún token y las docs no citan un harness;
      - que **toda ruta `src/`, `tests/` e `infra/` que citan los assets existe en lo emitido**;
      - que los miembros que enseñan las convenciones son los del código emitido (`Decimals.SetScale`, `Page`,
        `FlowTest`, `Optional.IsPresent`…).
      - Falsado citando un archivo inventado. Ya cazó un `HasValue` que no existe (es `IsPresent`) y una ruta de
        keel-spring.
    - **El README** del proyecto generado dice cómo se completa y avisa de la ruta corta.
    - **Medido:**
      - `npm test` 280/280.
      - **`harness-check` 32/32**: gana el baseline. Exporta el DDL; sin migraciones sale 1 diciendo cómo
        crearlas; con la de `dotnet ef`, `baseline: OK`. Falsado en sus dos ramas: una migración sin un índice, y
        una cota cambiada sin migración.
      - **La sonda de la migración editada no se aplicaba al principio**: `dotnet ef` escribe con CRLF en Windows.
        Lo delató su propia guarda (`sabotaged !== original`), no un verde falso.
      - `cs-check` 15/15 (102 ensamblados, 1 291 pruebas).
  - **7d, la corrida — con una decisión previa (tomada el 2026-10-14).** La única fixture que la frontera admite
    entera es `product-catalog`, y `createProduct` declara `idempotency` (`client-key`): `FL-PRD-002` y `FL-PRD-003`
    la exigen. Era el mismo punto en el que estaba keel-nest en su 7d. Allí el agente escribió el registro a mano
    (otra tabla y SQL de un solo motor), y por eso se adelantó su 10a. Aquí se adelanta ANTES de la corrida (lo
    decidió el usuario): la primera corrida mide un servidor equivalente.
  - **7e, la idempotencia de petición adelantada del incremento 10 (hecha, 2026-10-14).**
    - **Lo neutral ya estaba** en `keel-core/gen/request-idempotency.js`: qué operaciones usan el registro y la
      tabla `idempotency_record` como datos.
    - **En keel-dotnet**, `src/scaffold/request-idempotency.js`:
      - en Domain, el puerto `IIdempotencyStore` (`Domain/Idempotency`) y los dos conflictos, con el `code` de SU
        operación (`idempotencyOutcomeCodes`);
      - en Application, `CommandSignature` (firma canónica por reflexión: propiedades ordenadas, prefijo de
        longitud, decimal sin ceros finales, binario por su digest) e `IdempotencyContext` (`AsyncLocal`);
      - en Infrastructure, la fila con su mapeo (PK compuesta `idempotency_record_pkey`, índice de la purga) y el
        adaptador EF;
      - en Api, `IdempotencyKeyMiddleware`, detrás de la correlación y de los errores.
    - **El comando** gana `IdempotencyScope()` (método, no propiedad: la firma recorre propiedades). El handler recibe
      el puerto y la nota con el algoritmo: reclamar PRIMERO y no capturar la carrera. `mapping.md` lo enseña con
      código, y la frontera ya solo avisa si no hay persistencia.
    - **La carrera**: la perdedora espera a que la ganadora confirme y choca en la PK (23505). El adaptador la
      traduce SIN la causa del motor detrás: si no, el traductor de la transacción la volvía a leer y la convertía en
      un 409 sin code.
    - **Medido:**
      - `npm test` 286/286. `schema-parity` ya compara `idempotency_record` con la de keel-spring (salía de
        `PENDING_TABLES`). `test/request-idempotency.test.js` (nuevo): lo emitido, el cableado, la nota y el code por
        operación de catalog-extended.
      - **Prueba emitida `IdempotencyTests`**: la firma canónica y el contexto, ejecutados. Falsada quitando el orden
        de las propiedades: cae su prueba.
      - **`db-check` 26/26, 99 sondas** (25 nuevas: cinco por cada una de las cinco fixtures con registro): guardar y
        encontrar, el ámbito en la clave, la clave repetida, la CARRERA de dos transacciones, la caducada sustituible
        y el rollback con el comando. Falsado con `--sabotage=idempotency`: caen exactamente las dos del conflicto.
      - `cs-check` 15/15 (1 337 pruebas; el arranque en `develop` crea `idempotency_record` con el baseline) y
        `harness-check` 32/32.
    - **Sin cubrir todavía**, como en el 10a de keel-nest: la purga de las claves caducadas (necesita el reloj del
      incremento 10; `Find` ya las ignora y `Save` las sustituye) y el gate `check-idempotency.sh`.
  - **7d, la corrida (hecha, 2026-10-14): primer servidor .NET equivalente demostrado.** `product-catalog` v1.1.0 con
    `/keel-generate-dotnet`: **23/23 a la primera** y huella de **7 reescritos**, los mismos 7 archivos que keel-nest v2
    (keel-spring, 6): los cinco handlers, el agregado y la guía de despliegue del README. Ningún archivo de
    infraestructura de build tocado. Sin `harnessPatches`, sin `culprit: harness` y sin huecos. El baseline salió
    verificado en vivo (24 elementos), y `FL-PRD-002`/`003` pasan con el registro generado
    (`docs/corridas/2026-10-14-product-catalog-dotnet.md`).
- **Inc. 7 — cerrado (2026-10-14).** Siguiente: el 8 (seguridad).

- **Inc. 8 — en curso.** Tramos como los de keel-nest; lo neutral (`access-plan.js`, `identity-provisioning.js`) ya
  estaba en keel-core desde su 8a.
  - **8a, la autorización de la entrada HTTP (hecho, 2026-10-14).**
    - **Lo neutral que faltaba, sacado antes de escribir C#** (keel-spring 44/11 137 y keel-nest 41/10 050, idénticos):
      los textos del 401 y del 403 (`FRAMEWORK_RESPONSES.unauthenticated/accessDenied` en `api-errors.js`, que estaban
      copiados en los dos), los claims del token de acceso total de las pruebas emitidas (`fullAccessClaims` en
      `access-plan.js`, antes en keel-nest) y las peticiones de los casos de seguridad de la prueba de la API
      (`securityCases` en `api-cases.js`). El lector de la `SecurityConfig` de keel-spring pasa a
      `keel-spring/test/helpers/security-chains.js`, que comparten las dos paridades.
    - **`src/scaffold/security.js`**: un MIDDLEWARE propio (`HttpSecurityMiddleware`, en Api/Rest), no la autorización
      de ASP.NET Core ni el handler JwtBearer: va detrás de la correlación y del de errores y delante de los endpoints,
      así que decide también sobre un camino que no existe (401 y no 404, como Spring Security). Compara la FORMA de la
      plantilla de la ruta que casó (`RoutePattern.RawText`), y si no casó ninguna, el camino.
      - Las reglas como DATOS (`AccessRules.cs`), del plan neutral.
      - El JWT con `Microsoft.IdentityModel.JsonWebTokens` 8.23.0 (MIT): discovery del issuer, `jwk-set-uri` o el JWKS en
        línea del perfil test; perezoso (arranca sin el proveedor); un fallo del proveedor sigue hasta el 500 del
        contrato, nunca un 401; 60 s de margen y `exp` no obligatorio, como Spring; relee el JWKS ante una clave
        desconocida como mucho cada 30 s. El payload se lee como `JsonElement`, sin el mapeo de claims de .NET.
      - Clave de API en tiempo constante, CORS con la semántica del `DefaultCorsProcessor`, `CallerIdentity` y el puerto
        `ICallerScope` (Application/Support) con `JwtCallerScope`.
      - Configuración: los `security.yaml` de cada perfil son BYTE A BYTE los de keel-nest (lo comprueba
        `security.test.js` en las 8 fixtures con seguridad × Keycloak y Cognito).
    - **Los endpoints sirven ya las operaciones con identidad del llamante**: el campo lo estampa el lector con
      `CallerIdentity.Resolve()`, nunca de la petición, y no aparece en la query de `ApiRoutes`. Los handlers que
      declaran el error del alcance reciben `ICallerScope` con su nota.
    - **La frontera** acepta la capa. Rechaza con motivo `callerIdentity.from.resolvedBy` (el finder de credenciales
      llega en el 13, como en keel-nest) y un campo de identidad que no sea `string`/`text` (sale de un claim, que es
      texto; en C# el mensaje es tipado).
    - **Las pruebas emitidas**: `TestCredential.cs` genera su clave RSA y `InMemoryServer` publica el JWKS en
      `SECURITY_TEST_JWKS`; ninguna clave en el repo. `ApiTests` manda la credencial de acceso total por defecto y gana
      el 401 sin credencial (exista o no la ruta), el bearer malformado en `/livez`, el caducado, el firmado con otra
      clave y el 403 de una regla. `UseCasesTests` registra el alcance con el registro real (`AddCallerScope`).
  - **Medido:**
    - `npm test`: keel-dotnet 327/327, keel-core 1 214, keel-spring 1 662 y keel-nest 798.
    - `security-parity.test.js` (nuevo) 17/17 contra la `SecurityConfig` de keel-spring; falsado quitando una
      authority: caen 10, como en keel-nest.
    - `cs-check`: el proyecto de referencia entero, y la solución de las 15 fixtures y 2 variantes compila (102/102)
      con sus 1 371 pruebas en verde. Falsado dos veces sobre lo emitido: sin las ramas de rechazo del middleware caen
      los 401 y 403 de las fixtures que los emiten; sin comprobar la caducidad cae exactamente `UnTokenCaducadoEs401`
      en las seis fixtures con token.
  - **8b, el arnés de identidad (hecho, 2026-10-14).**
    - **Neutral**: qué credencial satisface la regla de cierre (la del humo) pasa a keel-core (`closingCredentialOf` en
      `access-plan.js`, como dato); keel-nest la renderiza igual que antes (41/10 050, idéntico).
    - **`src/scaffold/identity-harness.js`** → `tests/<Raíz>.IntegrationTests/Support/Credentials.cs`: lee
      `infra/test-credentials.env` (entorno → archivo → convencional), caché de tokens que renueva a 30 s del `exp`, y
      `TokenFor`, `ServiceCredential` (token o clave), `TokenAs` (personas por `partialImport`, atributos `kp_<claim>`
      y un mapper por claim), `ScopedResource`, `TokenWithScope` (usuario `scoped-<rol>-<String.hashCode de Java>`, el
      mismo nombre que keel-spring y keel-nest) y `ApiKey`, cada uno solo si el diseño lo hace posible. `FlowTest` gana
      los atajos y `Bearer(token)`; el humo llama con la credencial de cierre (SMOKE-4) y gana SMOKE-5.
    - **`infra/`**: `identityProvisioningFiles` neutral con `DOTNET_INFRA.identity` (el realm y `test-credentials.env`
      con Keycloak, el emulador con Cognito).
    - **Skills** `keel-dotnet-keycloak` (con `test-clients.md` y `troubleshooting.md`) y `keel-dotnet-cognito`, que
      se instalan con su stack; la sección `security` de `mapping.md`, la tabla del arnés de `integration-tests.md`,
      el proveedor de identidad en `infra-validation.md` y el paso de `init-keycloak.sh` del agente de infraestructura.
    - `generator-docs.test.js` mide las rutas de las skills de identidad contra lo que emiten `profile-directory` y
      `asset-vault` con su proveedor (falsado citando un archivo inventado).
  - **8c, `security-check` (hecho, 2026-10-14): 34/34.** `npm run security-check --workspace packages/keel-dotnet`, el
    gemelo del de keel-nest:
    - `profile-directory` con PostgreSQL y Keycloak reales: `init-keycloak.sh` siembra y es idempotente; nueve flujos
      sonda puntuados por `score-scenarios.sh` (401 sin credencial y con token inválido, 403 sin el permiso, el `sub`
      del token llega al handler, `TokenAs` con su `sub` y sus claims, la identidad no se acepta del cuerpo, 401/404 de
      un camino inexistente, 401 con el token de otro emisor) y el humo con SMOKE-5. Falsado rebajando la regla de
      `GET /me/card` en `AccessRules.cs`: sale FALLO `FL-SEC-001-C` y solo él.
    - `asset-vault` (que la frontera aún rechaza entero): su `infra/` y su `Credentials.cs` emitidos, compilados en un
      programa de consola contra su realm: `TokenWithScope` lleva el claim al token firmado, con el mismo usuario
      determinista que los otros dos generadores. Falsado quitando el atributo del alta: muere nombrando al usuario.
    - **Lo que destapó, del propio check**: con los `FL-SEC-*` fuera del documento de escenarios, la matriz los marca
      AJENO y un FALLO suyo deja el script con 2 (arnés roto), no con 1, así que el falsado no se podía leer. La sonda
      sustituye el documento por el suyo y retira su línea del sello, como `harness-check`.
  - **Lo siguiente**: 8d, la corrida sobre `profile-directory` (la lanza el usuario con `/keel-generate-dotnet`).

## 5. Riesgos conocidos

- **MySQL con EF Core 10.** Pomelo (MIT) suele ir detrás de la versión de EF. Además, el `Guid` de
  .NET serializa con orden de bytes mixto, y el `binary(16)` de keel-spring es big-endian. En el
  inc. 6 entra solo PostgreSQL. MySQL va rechazado con motivo en `supported-features.js` hasta que
  `db-check` lo mida.
- **Nombres de métricas.** OTel .NET emite `http.server.request.duration` y el panel espera las
  series de Micrometer. Se necesitan *views* que renombren contra `telemetry-vocabulary.js`. Además,
  el exportador Prometheus de OTel .NET sigue en prerelease, así que se evalúa en el inc. 14 frente
  a la alternativa MIT, y se elige el que conserve los exemplars.
- **El circuito de Polly** no tiene la semántica de resilience4j, así que va máquina propia.
- **401 frente a 404** antes de enrutar: depende de la política de reserva. Se mide en el inc. 8.
- **Sintaxis sin SDK.** Si `tree-sitter-c-sharp` se queda corto en C# 14, la red estricta pasa a
  `cs-check`.
- **SIGTERM en Windows** no ejecuta los hooks, igual que en keel-nest. Lo cubre la prueba emitida
  del drenaje.

## 6. Guía de entorno local (paso a paso, para quien no conoce .NET)

**Estado actual de tu máquina:** tienes el SDK 6.0.428 y el 8.0.425. **Falta el SDK 10.**

1. **Instalar el SDK 10.** Puede convivir con los otros:
   ```powershell
   winget install Microsoft.DotNet.SDK.10
   dotnet --list-sdks      # debe aparecer 10.0.x
   dotnet --info
   ```
   Opcional: `setx DOTNET_CLI_TELEMETRY_OPTOUT 1`.
2. **Editor.** VS Code con la extensión **C#** (`ms-dotnettools.csharp`, MIT). La extensión C# Dev
   Kit tiene licencia de Visual Studio, así que se evita por tu regla. Rider es otra opción, gratis
   solo para uso no comercial.
3. **Prueba de humo**, en el scratchpad, para aprender el ciclo:
   ```powershell
   dotnet new webapi -n Hola --use-minimal-apis
   cd Hola
   dotnet build
   dotnet run          # abre http://localhost:<puerto>/weatherforecast
   dotnet watch        # recarga al guardar
   ```
4. **Tests:**
   ```powershell
   dotnet new xunit3 -n Hola.Tests   # si la plantilla no existe: dotnet new install xunit.v3.templates
   dotnet test
   ```
5. **NuGet detrás del proxy corporativo**, si `dotnet restore` falla: `dotnet nuget list source` y un
   `nuget.config` con la fuente interna. No se toca el proyecto generado.
6. **Contenedores.** Se usa el podman que ya tienes para los otros checks. La `infra/` es la misma.
7. **Un proyecto generado**, en cuanto exista el inc. 2:
   ```powershell
   npm link --workspace packages/keel-dotnet
   keel-dotnet build specs/<servicio>        # desde un workspace de diseño
   cd services/<servicio>-dotnet
   dotnet tool restore                       # dotnet-ef y compañía, versión fijada
   dotnet build
   bash infra/up.sh
   dotnet run --project src/<Service>.Api
   dotnet test
   ```
8. **Lo que hace cada pieza:**
   - `global.json` fija el SDK, igual que el wrapper de Gradle.
   - `.sln` agrupa los proyectos.
   - `.csproj` es el `package.json` de un proyecto.
   - `Directory.Packages.props` fija las versiones de todos los proyectos.
   - `dotnet restore` es el `npm ci`.

## 7. Archivos críticos

- Nuevos: `packages/keel-dotnet/**` y `PLAN-KEEL-DOTNET.md`.
- Tocados en keel-core: `src/lib/assets.js` (`KNOWN_GENERATORS`) y `src/lib/gen/junit-scoring.js`
  (orden xUnit). En el inc. 1, lo neutral que aparezca. En el inc. 16, el `README.md` raíz,
  `CLAUDE.md` y `.claude/rules/dotnet-generador.md`.
- Referencias a calcar:
  - `packages/keel-nest/src/{cli.js,commands/,lib/ts-projection.js,lib/supported-features.js,scaffold/render.js}`
  - `packages/keel-nest/scripts/ts-check.js`
  - `packages/keel-nest/test/helpers/workspace.js`

## 8. Verificación

- Por incremento, la puerta de su fila del §4 y `npm test` de los tres paquetes en verde (keel-spring
  `golden --check` sin cambios).
- `npm run cs-check --workspace packages/keel-dotnet` necesita el SDK 10 y podman. Debe salir en
  verde en todas las fixtures que la frontera admite.
- Hito end-to-end en el inc. 7, y control final en el 16: `/keel-generate-dotnet` sobre el par del
  MVP con 100 % de `FL-*`, registrado en `docs/corridas/` con `corrida-metrics.js footprint`.
- `licenses.test.js` y `infra/check-licenses.sh` en verde siempre. Un paquete comercial añadido a
  `dotnet-stack.js` debe ponerlos en rojo (se falsa en el inc. 2).
