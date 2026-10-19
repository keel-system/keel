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
  - **8d, la corrida (hecha, 2026-10-14): 13/13 a la primera y huella 4**, la misma que keel-nest y keel-spring
    (`docs/corridas/2026-10-14-profile-directory-dotnet.md`). Diseño listo, sin `--accept-unready`. Los cuatro
    reescritos son TODOs (los dos handlers, el agregado y el README); ningún archivo de seguridad tocado, ninguna
    credencial escrita a mano (los flujos usan `TokenFor` y `TokenAs` del arnés), sin `design-gaps.yaml`, sin
    `harnessPatches` y sin ningún rojo intermedio.
- **Inc. 8 — cerrado (2026-10-14).** Siguiente: el 9 (mensajería).

- **Inc. 9 — en curso.** Tramos como los de keel-nest (su § Inc. 9): lo neutral primero, después RabbitMQ entero con su
  corrida, y Kafka y SNS/SQS al final. La frontera rechaza `kafka` y `snssqs` en el stack, la mensajería sin persistencia y
  la identidad del emisor con `resolvedBy` (llega con el finder del 13).
  - **9a, lo neutral que faltaba (hecho, 2026-10-14).** `keel-core/gen/messaging-plan.js`: `consumerUnits` (un listener
    por cola en RabbitMQ, por suscripción en Kafka), la topología RabbitMQ de consumo y de publicación, los números de la
    conexión (prefetch 250, recuperación, confirmación 10 s) y los fragmentos `messaging.yaml` y `rabbitmq.yaml`. Vivían
    en keel-nest; keel-nest los consume de ahí con su línea base idéntica salvo un comentario de `rabbitmq.yaml` que
    nombraba a keel-spring en el texto emitido (12 archivos; `gen-neutral.test.js` lo cazó). keel-spring sin cambios.
  - **9b-1, la lectura del cable compartida (hecho).** `JsonBodyReader`, `EnumLiterals`, los errores de lectura,
    `InputValidation` y `ValueReaders` pasan de Api/Rest a Application/Support: los mensajes de las suscripciones
    (Infrastructure) leen su payload con las mismas conversiones y reglas que la API, como `request-reading.ts` en
    keel-nest. En Api quedan `HttpJsonBody` y `TextValues`. `cs-check` 15/15.
  - **9b-2, la mensajería sobre RabbitMQ y PostgreSQL (hecho).**
    - `src/scaffold/messaging.js`: `EventEnvelope` (`Of`, `ToWire`, `Parse`), un `<Evento>IntegrationEvent` por evento con
      la metadata `[JsonIgnore]`, el puente `<Raíz>DomainEventBridge` (outbox: la fila en el MISMO `SaveChanges` del
      cambio; best-effort: `PersistenceTransactions.AfterCommit`, nuevo, con el puerto `I<Evento>Publisher` y su respaldo
      que avisa), el mensaje de cada suscripción (`FromWire` con los nombres de la fuente y `RequireContract` con las
      frases de keel-spring) y la envoltura propia de una fuente `wrapped`, `MessagingSettings`, `InboundContext` (la
      correlación de origen), `BrokerBindings.cs` (lo del agente, registrado ANTES que los respaldos de build, que entran
      con `TryAdd`) y `MessagingRegistration`. El adaptador de repositorio entrega `PullDomainEvents()` al puente ANTES de
      `SaveChanges`.
    - `src/scaffold/messaging-stores.js`: las filas de `outbox_event` y `processed_event` (datos de keel-core), el relay
      en tres pasos (`OutboxRelayStore` con `FOR UPDATE SKIP LOCKED` y el lease, cada transacción corta en su propio
      ámbito de DI; `OutboxRelay` como `BackgroundService` con retardo fijo, `Pause`/`Resume` para el arnés), el respaldo
      del dispatcher que no deja arrancar fuera de local/test, y `IdempotencyGuard` (`AlreadyProcessed`/`Record`/
      `TryRecord`, la carrera resuelta en la clave).
    - `src/scaffold/rabbitmq.js`: `RabbitTopology` (las colas, los canales publicados y el reintento como datos, y su
      declaración) y `RabbitConnection` sobre **RabbitMQ.Client 7.2.2** (Apache-2.0 OR MPL-2.0): arranca sin broker y
      conecta en segundo plano, recuperación automática, publicación con confirmación y `mandatory` (la `PublishException`
      de un mensaje sin cola es un `BrokerUnavailableException`), consumo con ack al terminar, reintento en memoria con la
      curva del diseño salvo `DomainException` y `MessageContractViolation`, y nack sin reencolar → DLQ.
    - **La prueba emitida `MessagingTests`** (`src/scaffold/messaging-tests.js`): la envoltura en el cable (orden de
      `WIRE_SHAPES`, nulos), su lectura y rechazos, el contrato de cada suscripción, el backoff del relay contra
      `outboxBackoffMs` y la curva del listener. Falsada rompiendo la fórmula del backoff y la correlación de la
      envoltura: caen exactamente sus tres pruebas.
    - **Medido:** `npm test` 353/353; `test/messaging.test.js` (nuevo): `messaging.yaml` y `rabbitmq.yaml` byte a byte los
      de keel-nest en seis fixtures y cuatro perfiles, la topología contra la `RabbitTopologyConfig` que EMITE keel-spring,
      toda clave que leen `MessagingSettings` y `RabbitMqSettings` existe en su YAML, y el puente en el repositorio.
      `schema-parity` ya compara `outbox_event` y `processed_event` con keel-spring (salen de `PENDING_TABLES`).
      `cs-check` 15/15: las fixtures con mensajería compilan sobre RabbitMQ (102 ensamblados, 1 595 pruebas).
    - **`db-check` 131 sondas** (32 nuevas): el reclamo por orden de llegada con su lease, el reclamo que se salta la fila
      que otra transacción retiene (SKIP LOCKED, con un tope de 5 s), el fallo que cuenta con su backoff y la rendición,
      la publicada que no se vuelve a reclamar, y la guarda (duplicado, consumidor como parte de la clave y cuatro
      entregas a la vez que gana una). Falsado con `--sabotage=lease` (el lease en el pasado), `skip-locked` y `guard`:
      cada uno cae en su sonda y solo en ella.
    - **Humo en vivo** sobre la `infra/` generada de `stock-reservation-events`: el servidor arranca en `local`, conecta,
      declara la topología (la cola propia con su DLQ por argumentos y la cola del canal publicado con su routing key), el
      relay corre con el respaldo que avisa, y tras parar y levantar RabbitMQ la conexión se recupera sola.
    - **Lo que destapó:**
      - `IConnection.CloseAsync(TimeSpan, CancellationToken)` no existe en RabbitMQ.Client 7 (solo la firma completa de
        la interfaz); lo cazó la compilación de las fixtures, no la de referencia.
      - EF registraba CADA sentencia SQL a nivel Information: con el relay sondeando cada segundo, dos líneas por segundo
        sin que pase nada. `Program.cs` filtra `Microsoft.EntityFrameworkCore.Database.Command` a Warning, como Hibernate
        sin `show-sql` y TypeORM sin `logging`.
      - `db-check` dejaba vivo su contenedor cuando salía a mitad (un sabotaje que no compilaba): el `process.exit` dentro
        del `try` se saltaba el `finally`. Ahora aborta por excepción y para la base (comprobado con un sabotaje que no
        existe). Y el primer sabotaje del lease no compilaba: un sabotaje así no falsa nada.
  - **9c, el arnés de mensajería y `broker-check` (hecho, 2026-10-14).**
    - `src/scaffold/messaging-harness.js` → `tests/<Raíz>.IntegrationTests/Support/Messaging.cs`: los helpers de keel-spring
      y keel-nest en PascalCase (`Deliver<Sub>` con la envoltura de su contrato, `DeliverMessage`, `PublishedMessages`,
      `DeadLetterMessages`, `PurgeMessages`, `StopBroker`/`StartBroker` y, con outbox, `DeadLetteredEvents`,
      `AbandonOutboxEvent` y `ClearAbandonedOutboxEvents`). Los comandos salen de `keel-core/gen/broker-probes.js` y viajan
      por el contenedor devtools; los cuerpos, por la entrada estándar (`Harness.Run` gana `input`).
    - **El servidor es otro proceso**, así que el modelo es keel-spring y no keel-nest: lo rendido y el abandono del
      outbox van por SQL (`attempts` a 1 000 000, el mismo número que keel-spring), el drenaje antes de leer un canal
      también, y la espera a que el servidor vuelva a estar conectado se le pregunta al BROKER: la conexión emitida se
      presenta con el nombre del servicio (`ClientProvidedName`) y el arnés la busca en `/api/connections`. Cada flujo abre
      con el broker arriba y el servidor conectado, y el humo gana SMOKE-6.
    - **`npm run broker-check` 19/19** sobre `stock-reservation-events` generado por `build`: el dispatcher y el listener
      del agente como SONDAS registradas en `BrokerBindings.cs` (el listener decide por el `eventId` y anota cada intento
      en `build/broker-probe/attempts.log`, porque el servidor es otro proceso), y once flujos sonda puntuados por
      `score-scenarios.sh` que usan solo los helpers del arnés: entrega procesada una vez, reentrega absorbida, el fallo
      transitorio reintentado 5 veces hasta la DLQ, el rechazo de negocio y el contrato incumplido a la DLQ sin reintento,
      el evento ajeno ignorado; la fila del outbox publicada con su routing key y su tipo, lo que no tiene cola
      (`mandatory`) sin dar por publicado, la fila que espera con el broker caído y sale al volver sin rendirse, el
      abandono contado como rendido y la purga. Falsado: con el rechazo de negocio reintentable sale FALLO
      `FL-BRK-001-D` y solo él. A la primera, sin un rojo intermedio.
  - **9d, la skill y las convenciones (hecho, 2026-10-14).** `skills/keel-dotnet-rabbitmq` (SKILL.md, `listeners.md` y
    `troubleshooting.md`), portada de la de keel-nest con lo propio de .NET: el listener es un `IHostedService` que abre
    un ámbito de DI por mensaje para el `IUseCaseMediator`, el registro en `BrokerBindings.cs` va antes de los respaldos
    (`TryAdd`), y nada de MassTransit. Se instala con `broker: rabbitmq` (`stackSkills`). `mapping.md` gana la sección
    `messaging` e `integration-tests.md` los helpers del arnés. `generator-docs.test.js` mide las rutas de la skill
    contra lo que emiten `stock-reservation-events` (outbox) y `metering-digest` (best-effort), y las firmas que enseña
    (`Publish`, `Consume`, `Header`, `Dispatch`, `InboundContext.Run`, la guarda, el publisher y el comando). Falsado
    citando un archivo inventado. `npm test` 356/356; `cs-check` 15/15.
  - **9e, la corrida (hecha, 2026-10-14): 15/15 y huella 9**, los MISMOS nueve archivos que keel-nest (18/18, huella 9;
    keel-spring 14/14, huella 8) (`docs/corridas/2026-10-14-stock-reservation-events-dotnet.md`). Diseño listo, sin
    `--accept-unready`, sin `harnessPatches`, sin `design-gaps.yaml` y sin rojos en la ejecución final. El listener del
    agente es el de la skill casi literal (cola compartida, ámbito por mensaje, el orden del guard de cada mensaje, la
    carrera resuelta). Un hueco del generador, propuesto por el propio agente de pruebas: el arnés escribía el cuerpo de
    cada entrega en un archivo FIJO de devtools, y dos entregas a la vez (`FL-CMP-001-C`) se lo pisaban; no falló porque
    los cuerpos eran iguales. Arreglado (un archivo por llamada) y medido: `broker-check` gana `FL-BRK-001-G` con su
    falsado, **22/22**. keel-spring tiene el mismo defecto latente (anotado, sin tocar).
- **Inc. 9 — RabbitMQ cerrado (2026-10-14).** Siguiente: 9f (Kafka) y 9g (SNS/SQS), como en keel-nest.
  - **9f, Kafka (hecho, 2026-10-14).**
    - **9f-a, lo neutral** (`1bffff7`): `kafkaConsumption`, los plazos de la conexión y `kafka.yaml` pasan de keel-nest a
      `keel-core/gen/messaging-plan.js`; keel-nest idéntico salvo un comentario de `kafka.yaml` que nombraba a keel-spring
      (72 archivos).
    - **La conexión** (`src/scaffold/kafka.js`) sobre **Confluent.Kafka 2.15.1** (Apache-2.0): `KafkaConsumption` (un
      grupo por suscripción, el descarte por topic, la curva de `kafkaListenerRetry`), `KafkaSettings` y
      `KafkaConnection`: productor con acks de todas las réplicas e idempotencia, un consumidor por suscripción en su
      propio hilo con el offset guardado DESPUÉS del desenlace (`EnableAutoOffsetStore = false`), reintento en memoria y
      descarte en `<topic>.DLT` con los headers de Spring Kafka (partición y offset big-endian). Arranca sin broker.
    - **La licencia del nativo**: `librdkafka.redist` no declara SPDX, solo una URL. Se leyó su `LICENSES.txt`
      (BSD-2-Clause, MIT, Zlib, BSD-3-Clause, ISC, Apache-2.0 y dominio público) y queda en `VERIFIED_LICENSES`
      (`dotnet-stack.js`) con su versión EXACTA y su fuente; `cs-check` la acepta solo para esa versión, y
      `licenses.test.js` ata su versión a la de Confluent.Kafka. Zlib e ISC entran en la lista de admitidas. Se fijó la
      2.15.1 y no la 2.16.0, que salió hace una semana.
    - **El arnés** (`messaging-harness.js`, reestructurado): la misma API con los dos brokers sobre un `BrokerHarness`
      propio de cada uno. Con Kafka, marca de offset por canal y por descarte en vez de purga, lectura con kcat filtrada
      por el tipo dentro del topic único del servicio, entrega con kcat, y la espera a los consumidores por la API de
      administración de Confluent.Kafka desde el proyecto de flujos (lo que hace el `AbstractFlowIT` de keel-spring), que
      ahora NOMBRA los grupos que no llegan («¿falta el listener de su suscripción?»).
    - **La skill** `keel-dotnet-kafka` (con listeners y diagnóstico), atada a lo emitido por `generator-docs.test.js`.
    - **`broker-check` corre con los dos brokers** (`--broker=rabbitmq,kafka`). Con Kafka, once flujos: los de RabbitMQ
      menos `mandatory`, más `FL-BRK-001-H` (el descarte conserva la clave y lleva los headers de Spring Kafka).
    - **Lo que destapó**:
      - El arnés exigía los TRES grupos del topic y la sonda solo registraba un listener: en un proyecto completo están
        todos, así que la sonda registra ahora las tres suscripciones, cada consumidor filtrando la suya (con el mismo
        manejador para las tres, cada grupo recibe el topic entero y `StockReserved` se habría procesado tres veces).
      - `FL-BRK-002-D` (el abandono) salía rojo: el envío que el relay tenía EN VUELO seguía en el buffer de librdkafka
        y, al levantar el broker, el evento «abandonado» salía. Es la K2 de las corridas `payment-checkout` de
        keel-spring; `AbandonOutboxEvent` espera ahora, con Kafka, el `delivery.timeout.ms` del perfil local más un margen.
      - `--keep` había quedado fuera de la función por broker al convertir el script.
    - **Medido:** `npm test` 360/360; `broker-check` **44/44** (22 por broker, los dos falsados); `cs-check` 15/15 con dos
      variantes con Kafka (`stock-reservation-events-kafka` y `metering-digest-kafka`): 114 ensamblados.
  - **9g, SNS/SQS (hecho, 2026-10-14).**
    - **9g-a, lo neutral** (`aabb112`): `snsSqsConsumption`, los plazos de la conexión y `snssqs.yaml` pasan de keel-nest a
      `keel-core/gen/messaging-plan.js`; keel-nest idéntico byte a byte.
    - **La conexión** (`src/scaffold/snssqs.js`) sobre el **SDK oficial de AWS v4** (`AWSSDK.SimpleNotificationService`
      4.0.100.15 y `AWSSDK.SQS` 4.0.100.14, Apache-2.0; `AWSSDK.Core` lo resuelve NuGet): `SnsSqsConsumption` (por
      suscripción, su cola, su DLQ y su `maxReceiveCount`, los mismos que siembra `init-messaging.sh`), `SnsSqsSettings`
      (las claves `aws:*` de keel-spring) y `SnsSqsConnection`: publica con el tipo como message attribute `eventType` y
      resuelve el ARN LISTANDO y exigiendo un suscriptor confirmado —nunca crea el topic—; un sondeo largo por
      suscripción que borra al terminar bien, alarga la VISIBILIDAD con la curva del diseño lo transitorio y lleva a la
      DLQ lo no reintentable. Arranca sin broker. `infra/init-messaging.sh` es el neutral de
      `keel-core/gen/messaging-provisioning.js`, con los textos de keel-dotnet.
    - **El arnés**: un `BrokerHarness` más, con la API de los otros dos: lectura en barrido que suelta lo leído, purga,
      entrega al TOPIC con el `eventType` como atributo (archivo de cuerpo y de atributos por llamada), y al levantar el
      broker resiembra con `init-messaging.sh` y espera a que una sonda atraviese la suscripción. El abandono aparca el
      outbox por SQL mientras dura (LocalStack no tiene un envío en vuelo que esperar, pero el relay sí reintenta).
    - **La skill** `keel-dotnet-snssqs` (con listeners y diagnóstico), atada a lo emitido por `generator-docs.test.js`;
      `mapping.md` § messaging nombra las tres.
    - **`broker-check` corre con los tres brokers.** Con SNS/SQS, doce flujos: los de RabbitMQ con `FL-BRK-002-B`
      cambiado por «una fila cuyo topic no existe no se da por publicada», y los dos falsados. **23/23** a la primera.
    - **Medido:** `npm test` 363/363 (keel-core 1214, keel-nest 798); `broker-check` **67/67** con los tres brokers (22 RabbitMQ, 22 Kafka, 23 SNS/SQS); `cs-check` 15/15 (126 ensamblados, 2018 pruebas) con
      dos variantes más (`stock-reservation-events-snssqs` y `metering-digest-snssqs`).
- **Inc. 9 — mensajería cerrada (2026-10-14)**: RabbitMQ con corrida, Kafka y SNS/SQS medidos con `broker-check`.
  Siguiente: el incremento 10.
  - **9h, corrida de control con SNS/SQS — preparada (2026-10-14).** Workspace
    `spring-live-test/corrida-stock-reservation-events-snssqs-dotnet`: `keel init`, el MISMO diseño que la 9e (la fixture
    y su `DESIGN.md`, `--ready` 11/11, sin `--accept-unready`) y `keel-dotnet build` con `postgresql · snssqs`
    (197 archivos, con la skill `keel-dotnet-snssqs`); el proyecto compila tal cual. Cambia una sola variable respecto a
    la 9e (15/15, huella 9): el broker. Mide si los nueve archivos del agente siguen siendo los mismos con la skill de
    SNS/SQS y si el arnés de LocalStack (resiembra, lectura en barrido, abandono aparcado) aguanta un pipeline real. Los
    contenedores se llaman `stock-reservation-events-*`, como los de la 9e: no puede correr a la vez que otra corrida del
    mismo diseño.
  - **9h, hecha (2026-10-14): 19/19 y huella 9**, los MISMOS nueve archivos que la 9e: cambiar de broker no movió la
    huella fuera de `BrokerBindings.cs` (`docs/corridas/2026-10-14-stock-reservation-events-snssqs-dotnet.md`). Diseño
    listo, sin `--accept-unready`, sin `harnessPatches` ni `design-gaps.yaml`; tres listeners, uno por suscripción, como
    enseña la skill, y el arnés de LocalStack sin un rojo. Un hueco del generador: el agente de infraestructura no
    ejecutaba `infra/init-messaging.sh` (`up.sh` deja LocalStack vacío y `validate-infra.sh` falla); el agente lo rodeó.
    Arreglado en `keel-dotnet-infra.md` (paso 3 y `messaging` en el reporte) e `infra-validation.md`, como en
    keel-spring. keel-nest tenía el mismo hueco latente: arreglado igual. Y el archivo de cuerpo compartido del arnés de
    keel-spring (el defecto de la 9e): arreglado con un archivo por llamada, `compile-check` 38/38.
- **Inc. 10 — en curso (abierto el 2026-10-14).** Tramos como los de keel-nest (su § Inc. 10): la idempotencia de petición
  ya estaba (7e) y la deduplicación de mensajes también (9b); quedan 10b (reloj y purgas), 10c (reclamos de barrido,
  rescate y parámetros de despliegue), 10d (el gate `check-idempotency.sh`) y 10e (la corrida, `job-dispatch-cycles`).
  La reconciliación, la compensación y `lastKnown` van al 11, como en keel-nest. **Hueco de frontera visto al abrirlo**,
  el mismo que destapó keel-nest en su 10c: keel-dotnet ignora EN SILENCIO `service.parameters` (DSL 2.15), sin código
  ni aviso, y `job-dispatch` y `job-dispatch-cycles` entran en la frontera. Se cierra en el 10c.
  - **10b, reloj y purgas (hecho, 2026-10-14).** Sin cambio en `keel-core`: el segundo repartido, el despacho y la purga
    por lotes ya eran neutrales (`keel-core/gen/scheduling.js`, `BATCHED_PURGE`).
    - `src/scaffold/scheduling.js`: `Scheduling` (un `BackgroundService`; un bucle por tarea que calcula la siguiente
      ocurrencia AL TERMINAR la pasada, así que un tick con la anterior en curso se salta; cada pasada en su ámbito de DI;
      al apagar, la pasada en vuelo corre sin el token y el host la espera), `ScheduledTask` (el cron de seis campos con
      **Cronos 0.13.0**, MIT y sin dependencias; un cron inválido no deja arrancar), `SchedulingSettings`
      (`scheduling.enabled`, apagado en `test`; `scheduling.yaml` es el de keel-nest byte a byte) y un
      `<Grupo>Scheduler` por grupo, que abre la correlación de cada pasada y despacha con `Dispatch` o
      `DispatchWithoutTransaction` según `scheduleDispatch`. `Program.cs` lo registra el último.
    - `src/scaffold/purge.js`: `BatchedPurge` (el bucle, sin EF), `PurgeSettings` (las claves y defaults de keel-spring;
      `idempotency.yaml` como el de keel-nest) y `TablePurges`, con el SQL de cada tabla LITERAL (solo los instantes
      viajan como parámetro) y cada lote en una transacción nueva.
    - La nota del handler dice quién lo dispara y cómo; la frontera deja de avisar del `schedule` y avisa solo del
      barrido con transiciones (su reclamo, 10c); `mapping.md` y el agente de código lo enseñan.
    - **Medido:** `test/scheduling.test.js` (14): segundo y despacho contra el `Scheduler.java` que EMITE keel-spring en
      las cuatro fixtures con reloj, qué se purga contra keel-nest, la configuración contra keel-spring (y que lo que el
      YAML declara es lo que lee `PurgeSettings`), y los casos de la prueba emitida contra `batchedPurgeReference`.
      Falsado poniendo el segundo a 0: cae `payout-runs`, la única con dos barridos. La prueba emitida
      `SchedulingTests` ejecuta con Cronos el cron de cada tarea y el bucle por lotes: `cs-check` **15/15** (2 118
      pruebas, cien más; `product-catalog` arranca con el reloj y su purga). `db-check` **26/26, 154 sondas** (23 nuevas):
      cada purga con lotes de dos e instantes repetidos, lo vigente intacto, lo pendiente del outbox intacto aunque sea
      viejo, y el tope seguido de la pasada siguiente. Falsado con `--sabotage=purge` (el outbox cortado por
      `created_at`: caen las dos sondas del outbox y solo ellas) y `--sabotage=purge-batch` (cada lote hasta el corte:
      cae solo el tope). `npm test` 377/377.
    - Lo que no mide ninguna red: que un tick dispare de verdad el handler (lo medirá la corrida del 10e) y el apagado con
      una pasada en vuelo (en Windows SIGTERM no ejecuta los hooks).
  - **10c, reclamos de barrido, rescate y parámetros de despliegue (hecho, 2026-10-14).** Sin cambio en `keel-core`: el
    orden de los candidatos, las claves de `sweep.*`, las sentencias del rescate y el gradiente de los parámetros ya eran
    neutrales.
    - **El hueco de frontera, cerrado**: `src/scaffold/service-parameters.js` emite `<Servicio>Parameters` en
      `Domain/Parameters` (las guardas de keel-spring con sus frases; el constructor recibe nulables para decir QUÉ falta),
      `ServiceParametersRegistration` en `Infrastructure/Config` (lee `<artifactId>.<clave>`; `Program.cs` lo registra
      antes que nada), el fragmento de cada perfil (el de keel-nest byte a byte) y la prueba emitida
      `ServiceParametersTests`, que EJECUTA las guardas: el valor de prueba, el ausente y cada cota rota.
    - `src/scaffold/claim.js`: un método por reclamo en el puerto y en el adaptador —candidatos con `FOR UPDATE SKIP
      LOCKED` y un UPDATE condicional por fila, SQL literal, en una transacción propia; la cola estampa el reloj del rescate
      en el mismo UPDATE; el rescate solo se lleva lo más viejo que su plazo (de `sweep.*` o del parámetro del diseño) y
      ARRIENDA sin cambiar el estado; ninguno sube la versión del bloqueo optimista, como en los otros dos—, `SweepSettings`
      (`Program.cs` registra los del perfil y `AddPersistence` pone los defaults con `TryAdd`) y `sweep.yaml` (el de
      keel-nest byte a byte). Lo propio de .NET: el reclamo **se niega a correr dentro de una transacción abierta**
      (`RequireOwnTransaction`), porque con `InTransaction` se uniría a ella y el reclamo no existiría para nadie hasta el
      commit final.
    - La nota del handler dice que el reclamo y el rescate ya están generados y cómo se llaman; la frontera deja de avisar
      del barrido; el arnés gana `StallInFlight`, `PutInFlight` e `InFlightWithoutClock` con las sentencias de keel-core
      (las mismas que keel-nest); `mapping.md` y el agente de código lo enseñan.
    - **Medido:** `test/claim.test.js` (13) y `test/service-parameters.test.js` (5): el puerto y el adaptador de cada
      reclamo en las cuatro fixtures con barrido, `sweep.yaml` contra keel-nest y keel-spring y lo que lee
      `SweepSettings`, el rescate que lee su plazo del parámetro, los fragmentos contra los dos y las sentencias del arnés
      contra las de keel-nest. `npm test` 395/395. `cs-check` **15/15** (2 130 pruebas). `db-check` **26/26, 174 sondas**
      (20 nuevas): la cola (orden, lote, destino, reloj estampado y la pasada siguiente), dos réplicas a la vez sin
      repetir, SKIP LOCKED con otra transacción reteniendo una fila, la negativa a correr dentro de otra transacción, el
      rescate (solo lo abandonado, arrienda sin cambiar el estado, el fresco intacto, renovado no se repite) y las MISMAS
      sentencias del arnés contra el motor. **Falsado por capas**: con `--sabotage=claim-skip-locked` cae solo la sonda de
      SKIP LOCKED; con `--sabotage=claim-stale` (el rescate sin cota temporal), solo las dos del rescate.
    - **Lo que destapó**: el analizador EF1003 de EF Core no deja concatenar SQL dentro de `ExecuteSqlRawAsync` (la sonda
      que monta la sentencia del arnés la arma antes en una variable); y el heredoc de este shell come las barras
      invertidas, así que dos ediciones dejaron saltos de línea reales dentro de un literal de JS (cazado al importar).
  - **10d, el gate `check-idempotency.sh` (hecho, 2026-10-14).** El MOTOR es el de keel-core
    (`gen/idempotency-gate.js`), el mismo que el de keel-spring y keel-nest; `src/scaffold/idempotency-check.js` pone la
    MATRIZ con patrones de C#: `dedupe`, `payloadContract`, la escritura de los registros como INSERT (en EF Core, `Add` y
    no `Update` ni `Attach`), `commandIdempotency` (registro y clave natural), `domainEvent`, `sweepClaim` (con el
    reclamo generado y el barrido que build no puede reclamar, con su `deny` sobre los bloques de build),
    `outboxDelivery` (el dispatcher registrado en `BrokerBindings.cs`) y `conditionalUniqueness`. Las familias de lo que
    keel-dotnet aún no genera (compensación, reconciliación, idempotencia saliente, correo) llegan con el 11 y el 13. Los
    agentes de código y de calidad lo ejecutan y lo reportan (`idempotency:`), y el README dice que nace rojo.
    - **Medido:** `test/idempotency-check.test.js` (26): familias y sujetos iguales a los de keel-nest en 7 fixtures × 3
      brokers, y el gate EJECUTADO con bash: rojo recién generado en las cinco familias de `stock-reservation-events` y
      en las dos de `payout-runs`; verde con el uso correcto; rojo otra vez leyendo el lote con un finder, y con solo la
      nota del stub (el gate no lee comentarios). **Contra las corridas reales** de keel-dotnet (sin tocarlas: el script se
      lanza desde el scratchpad): `product-catalog` (7d), `stock-reservation-events` con RabbitMQ (9e) y con SNS/SQS (9h),
      **verdes** en todas sus familias. Falsado sobre una copia del `src/` de la 9e con tres sabotajes que conservan la
      forma (sin `RequireContract`, el orden de la guarda cruzado, el dispatcher sin registrar): cada uno tumba su familia
      y solo esa.
    - **Dos defectos del MOTOR que destapó keel-dotnet**, invisibles en los otros dos y arreglados como opciones de
      plataforma que solo emiten algo si se declaran (las líneas base de keel-spring y keel-nest, **idénticas**):
      (1) `excludeDirs`: en .NET `bin` y `obj` viven DENTRO de `src/<Proyecto>/`, y la búsqueda por contenido elegía una
      DLL que nombra los mismos mensajes que el listener: el gate salía ROJO sobre las corridas 9e y 9h, que estaban bien;
      (2) `typesPerFile: 'many'`: C# deja varios tipos en un archivo, y el agente de la 9h escribió sus tres listeners en
      un `Listeners.cs`; mirando el archivo entero, cada uno «prohibía» el orden del vecino. El archivo localizado por
      contenido se recorta ahora al bloque de primer nivel que nombra los mensajes. Los dos casos están en el test, con la
      DLL al lado. keel-nest (TypeScript) también admite varios tipos por archivo: el mismo hueco, latente y sin tocar.
  - **10e, la corrida — preparada (2026-10-14).** Workspace `spring-live-test/corrida-job-dispatch-cycles-dotnet`:
    `keel init`, el MISMO diseño que las gemelas de keel-nest (12/12, huella 6) y keel-spring (12/12, huella 5) —la fixture
    `job-dispatch-cycles` v1.0.1 y su `DESIGN.md`, `--ready` 11/11, sin `--accept-unready`— y `keel-dotnet build` con
    `postgresql` (el stack de las dos gemelas; 167 archivos, estampado `ready: true`). El proyecto compila tal cual, sin
    warnings; las pruebas de build pasan (77/77) y `check-idempotency.sh` nace ROJO solo en `sweepClaim`, que es el
    trabajo del agente. Mide lo que ninguna red mide: que un tick dispare de verdad el handler, que el reclamo y el rescate
    generados se usen tal cual y que el arnés del rescate (`StallInFlight`/`PutInFlight`) aguante un pipeline real. Los
    contenedores se llaman `job-dispatch-cycles-*`, como los de las gemelas: no puede correr a la vez que otra corrida del
    mismo diseño.
  - **10e, hecha (2026-10-14): 12/12 a la primera y huella 6**, los mismos seis archivos que keel-nest (12/12, huella 6;
    keel-spring 12/12, huella 5) (`docs/corridas/2026-10-14-job-dispatch-cycles-dotnet.md`). Sin `--accept-unready`, sin
    ronda de arbitraje, sin `harnessPatches` ni `design-gaps.yaml`, y `check-idempotency.sh` en verde. Un tick del reloj
    disparó de verdad el handler (los escenarios esperan al cron real), el barrido usa los dos reclamos generados tal cual y
    los flujos del rescate usan los tres helpers del arnés. Un hueco del generador: la nota del rescate no decía que un
    fallo en una fila no corta el lote, y el handler del agente cortaba la pasada al primer `Save` que perdía la carrera con
    el ejecutor (ningún escenario lo ve). Arreglado en la nota, con su aserción.
  - **Los dos latentes, cerrados (2026-10-14).** La misma frase en la nota del rescate de keel-nest y keel-spring (cambian
    solo los handlers del barrido de las tres fixtures con rescate), y el gate de keel-nest con `typesPerFile: 'many'`
    (TypeScript también deja varios tipos en un archivo), con su caso ejecutado en `test/idempotency-check.test.js` y
    falsado quitando la opción. Contra las 15 corridas de keel-nest, el veredicto del gate es idéntico antes y después.
    Las dos líneas base del golden, regeneradas por ese cambio intencional.
- **Inc. 10 — cerrado (2026-10-14).** La reconciliación, la compensación y `lastKnown` van al 11, como en keel-nest.
  Siguiente: el incremento 11 (clientes HTTP salientes, circuito propio, reconciliación, arnés WireMock).
- **Inc. 11 — en curso (abierto el 2026-10-14).** Tramos como los de keel-nest (su § Inc. 11), con el 11a ya hecho en
  keel-core (`outbound-resilience.js`, `reconciliation-stores.js`, `http-stub-probes.js`): 11b clientes HTTP, 11c
  reconciliación y compensación (con las familias `compensation`, `reconciliation` y `outboundIdempotency` del gate), 11d
  arnés del proveedor de prueba y skill `keel-dotnet-httpclient` (con `stub-check`), 11e la corrida sobre
  `stock-reservation`, el sujeto de las gemelas (keel-nest 24/24, keel-spring 21/21, huella 10).
  - **11b, clientes HTTP (hecho, 2026-10-14).**
    - **Lo neutral que faltaba**: el `http-clients.yaml` de cada perfil salió de keel-nest a
      `keel-core/gen/http-clients-config.js` (keel-nest lo importa; su línea base del golden, idéntica: 41 / 10 050) y
      lo comparte keel-dotnet byte a byte. `test/http-clients-config.test.js` en keel-core.
    - **Lo que emite** (`src/scaffold/http-clients.js`): el puerto `I<Cliente>Client` y los `<Llamada>Result` en
      `Domain/Clients`; en `Infrastructure/Clients` el adaptador sobre **HttpClient** (un solo `HttpExchange` sobre un
      `SocketsHttpHandler` sin redirecciones, 5 s de conexión y el timeout de lectura de keel-spring por intento), los DTOs
      del cable (la respuesta se lee con `WireJson` y un campo obligatorio que falta o llega con otro tipo es un
      `OutboundContractException`, que se propaga), el mapper de anticorrupción, la clave de idempotencia saliente
      (`OutboundIdempotency` sobre `CommandSignature`, que ahora se emite también sin registro de entrada) y la
      configuración (`HttpClientsSettings`, leída al arrancar; `AddOutboundClients` en `Program.cs`). **Sin Polly**: el
      circuito es la máquina de estados de resilience4j escrita en C# (`CircuitBreaker`, con `Lock`), y el retry va por
      fuera (`OutboundResilience.Run`), con la política de keel-core como literal en el adaptador. El fallback es un
      filtro de excepción (`catch (ProviderFailureException failure) when (...Fallback.Contains(failure.Kind))`): lo que
      no es un fallo del proveedor ni siquiera se captura. La cancelación de quien llama NO es un timeout. El handler que
      activa otro servidor por HTTP recibe el puerto y la nota de la activación y del orden de los efectos (las de
      keel-nest). Ningún paquete nuevo: HttpClient es de la biblioteca base.
    - **Frontera**: `http-clients` y `dependencies` se aceptan; `reconciledBy` y `compensations` con aviso (11c); `needs`,
      `oauth2-client-credentials` y un value object compuesto en el cuerpo o en la respuesta se rechazan nombrando el
      incremento 13 (el compuesto en la URL, con el rechazo neutral de `outbound-params.js`).
    - **Medido**: `test/http-clients.test.js` (8): `http-clients.yaml` igual al de keel-nest en los cuatro perfiles y
      `HttpClientsSettings` leyendo solo claves que declara; la política y lo que atiende el fallback de cada llamada de
      las tres fixtures con clientes, contra keel-core; la secuencia del circuito pasa por las cuatro transiciones y
      distingue otro umbral. `npm test` 428/428. La prueba EMITIDA `OutboundClientsTests` ejecuta el circuito contra la
      secuencia que build generó con `circuitBreakerReference` (600 pasos), la espera contra `retryWaitMs`, la
      clasificación de cada desenlace del proveedor con un `HttpMessageHandler` falso (2xx, sin cuerpo, 4xx, 5xx, 3xx,
      600, sin conexión, timeout, cancelación de quien llama, cuerpo que no es JSON), la lectura del contrato y CADA
      llamada resiliente del diseño contra un proveedor falso (intentos y MISMA clave sin conexión, el contrato roto que
      no cae al fallback, el circuito que se abre y la llamada siguiente que ni sale): 24, 43 y 34 pruebas en
      `stock-reservation`, `catalog-extended` y `asset-vault`; `cs-check` **15/15** (2 231 pruebas, 101 más). **Falsado** con seis sabotajes que conservan la forma
      (`cs-check --fixtures --sabotage=<id>`: `circuit-strict`, `circuit-4xx`, `retry-all`, `idempotency-random`,
      `fallback-any`, `cancel-as-timeout`): cada uno lo caza su prueba y solo la suya.
    - **Lo que destapó** en `cs-check`: su filtro de errores no veía los de los analizadores de xUnit (`xUnit1051`
      empieza en minúscula), así que la solución salió roja sin decir por qué; y `--keep` con `--fixtures` dejaba la
      copia dentro de la raíz temporal que se borra al salir. Los dos, arreglados (el filtro también en `db-check`).
    - **Sin medir**: contra un WireMock real (11d, `stub-check`) y en corrida (11e).
  - **11c, reconciliación y compensación (hecho, 2026-10-14).**
    - **Lo neutral que faltaba**: el `reconciliation.yaml` de cada perfil salió de keel-nest a
      `keel-core/gen/reconciliation-stores.js` (`reconciliationYaml`; golden de keel-nest idéntico, 41 / 10 050).
    - **Lo que emite** (`src/scaffold/reconciliation-claim.js`): la fila `reconciliation_claim` con el emisor genérico de
      las tablas del generador (`rowFile` de `messaging-stores.js`), `ReconciliationClaimStore` (la marca con UNA
      sentencia, `INSERT … ON CONFLICT DO UPDATE … WHERE claimed_at <= caducidad`: en PostgreSQL un error aborta la
      transacción entera, así que la carrera no se resuelve capturando la violación de clave como en keel-nest),
      `ReconciliationSettings` (los tres números por activación; `Program.cs` registra los del perfil y
      `AddPersistence` los defaults con `TryAdd`), el reclamo en el puerto y el adaptador de la raíz que espera
      (SKIP LOCKED sobre el estado de espera y la marca del diseño, el lote del perfil, la marca por candidato, el estado
      intacto y `RequireOwnTransaction`) y su purga por lotes (`TablePurges`, la misma lista que keel-nest). Las notas
      del barrido y de la compensación son las de keel-nest con los nombres de C#; el gate gana las familias
      `compensation`, `reconciliation` y `outboundIdempotency` con los mismos sujetos. La frontera deja de avisar.
    - **Un defecto latente en los TRES generadores, cerrado aquí**: la lectura de candidatos no excluía los que ya
      tienen una marca VIVA, así que con más atascados que el lote la cabeza de la cola —reclamada y aún sin resolver
      (un reintento, un proveedor caído)— ocupaba el lote de cada pasada hasta caducar, y los de detrás no se
      reconciliaban antes. keel-dotnet los excluye en la propia lectura (`NOT EXISTS` sobre `reconciliation_claim` con
      `claimed_at > caducidad`, `FOR UPDATE OF e`). keel-spring y keel-nest lo tenían igual: **cerrado en los dos
      (2026-10-14, a petición del usuario)**, en las dos ramas —JPQL con `not exists` y Mongo con `nin` en keel-spring;
      TypeORM con `NOT EXISTS` entre `Brackets` y la tienda documental con `held()` en keel-nest—. Las sondas que había
      pasaban con y sin el arreglo (la segunda pasada usaba un lote mayor): `db-check` y `doc-check` de keel-nest la
      repiten ahora con el MISMO lote, y `store-check` de keel-spring gana
      `laPasadaSiguienteSeLlevaAlDeDetrasConElMismoLote`. Medido: keel-nest `db-check` 48/48 (PostgreSQL y MySQL) y
      `doc-check` 13/13, falsados anulando la exclusión (caen justo esas sondas en `stock-reservation`,
      `catalog-extended` y `asset-vault`); keel-spring `npm test` 1664/1664 y `compile-check` en verde en las tres
      fixtures con reconciliación. Golden regenerado en los dos (solo cambian sus adaptadores y tiendas de
      reconciliación). Y tras la corrida, `store-check` de keel-spring sobre `stock-reservation`: **33/33** en
      PostgreSQL y en MySQL, con `laPasadaSiguienteSeLlevaAlDeDetrasConElMismoLote` dentro; falsado anulando la
      exclusión (cae esa sonda y solo esa).
    - **Medido**: `test/reconciliation.test.js` (7: el YAML igual al de keel-nest y lo que lee `ReconciliationSettings`,
      la sentencia de la tienda, el reclamo del adaptador, las purgas contra keel-nest, el registro y las notas);
      `schema-parity` ya compara `reconciliation_claim` con keel-spring; `idempotency-check.test.js` con
      `stock-reservation` y `catalog-extended` en la paridad de familias y EJECUTANDO el gate: las dos familias nacen
      rojas y `outboundIdempotency` verde, verdes con el uso correcto, y rojas otra vez barriendo con un finder,
      tragándose los errores (`catch (Exception)`), sin devolver el estado en el agregado o sin la clave saliente.
      `npm test` 442/442. `db-check` **26/26, 188 sondas** (14 nuevas): la tienda (inserta, respeta la marca viva,
      renueva la caducada justo en el límite, por activación, tres réplicas a la vez y gana una), el reclamo (umbral,
      orden, lote, estado intacto, marcas, la pasada siguiente que se lleva al de detrás, la caducidad y dos réplicas
      a la vez sin repetir) y su purga. **Falsado** con tres sabotajes (`--sabotage=reconciliation-expiry`, `-threshold`
      y `-head`): cada uno cae en su sonda y solo en ella. `cs-check` **15/15** (2 237 pruebas).
    - **Ojo, intermitente**: con la máquina cargada (justo tras `db-check` o con las suites a la vez), dos pasadas de
      `cs-check` salieron rojas por la LIMPIEZA de `ApiTests` (el servidor en memoria al cerrarse) en fixtures con
      servicios de fondo, también en algunas sin nada del 11c; seis pasadas seguidas en reposo, verdes. `cs-check` guarda
      ahora la salida entera de `dotnet test` cuando falla, para leer el mensaje la próxima vez.
  - **11d, el arnés del proveedor de prueba y la skill (hecho, 2026-10-14).**
    - **Lo que emite** (`src/scaffold/http-stub-harness.js`): `Support/HttpStub.cs` en el proyecto de flujos, con los
      helpers de keel-spring y keel-nest (`StubFor`, `StubFailure`, `StubConnectionFault`, `StubTimeout`,
      `StubSequence` con su guarda de una secuencia por ruta, `StubCallCount`, `StubRequests`, `StubRequestBody`,
      `StubRequestHeader`, `ResetStubs`) sobre el vocabulario de `keel-core/gen/http-stub-probes.js`, como parte de
      `FlowTest` más un `HttpStubHarness` que solo usa HttpClient (así `stub-check` lo compila SOLO);
      `AgeForReconciliation`/`HoldFromReconciliation` en `FlowTest`, con las sentencias de keel-nest, y el `IdLiteral`
      compartido con el rescate. El humo gana SMOKE-6, el mismo número que en los otros dos; el del broker de keel-dotnet,
      que lo ocupaba, pasa a SMOKE-8 (un diseño con mensajería y clientes habría tenido dos casos con el mismo id en la
      matriz). Skill `keel-dotnet-httpclient` (`SKILL.md` + `references/implementation.md` y `flows.md`), instalada con
      la capa, y `mapping.md` gana su apartado.
    - **Lo que destapó el WireMock real: SocketsHttpHandler reintenta por su cuenta.** Un DELETE con el corte de conexión
      llegaba CUATRO veces al proveedor por intento (con `curl`, una; el POST con cuerpo no lo reenviaba, el DELETE y el
      GET sí): un retry por debajo del del diseño, que repetiría una escritura que el diseño no reintenta ante
      `connection`. No hay opción pública para apagarlo; `HttpExchange` manda cada intento en su propia conexión
      (`Connection: close`) y un `ConnectCallback` no deja abrir una segunda para la misma petición. El precio, sin
      keep-alive entre llamadas; escrito en el código. FL-REC-002 («exactamente dos») habría salido verde por casualidad:
      el reenvío interno se encontraba la segunda respuesta de la secuencia.
    - **Medido**: `npm run stub-check` (nuevo) levanta SOLO el WireMock del catálogo y corre las sondas de
      `scripts/probes/StubProbes` —el arnés emitido y el adaptador emitido de `stock-reservation` con la configuración
      de `develop` apuntando a él—: **5/5, 10 sondas** (lo programado llega y se registra, el corte y el retraso son
      transporte y se reintentan con la MISMA clave, la secuencia entrega la segunda y se queda pegada, diez 503 abren
      el circuito, el 404 no se reintenta, el contrato roto se propaga, el reset vacía, y una conexión reutilizada que se
      corta no se reenvía por debajo del retry). **Falsado** con tres sabotajes (`initial-state`, `fault`,
      `transport-retry`): cada uno cae en su sonda. `generator-docs.test.js` ata las rutas y las firmas de la skill a lo
      emitido. `npm test` 443/443; `cs-check` 15/15 (2 237 pruebas).
    - **Sin medir**: los flujos de una corrida (11e). `harness-check` sigue sobre `product-catalog`, sin clientes.
  - **11e, la corrida — preparada (2026-10-14).** Workspace `spring-live-test/corrida-stock-reservation-dotnet`:
    `keel init`, el MISMO diseño que las gemelas de keel-nest (24/24, huella 10) y keel-spring (21/21, huella 10) —la
    fixture `stock-reservation` v1.1.0 y su `DESIGN.md`, `--ready` 11/11, sin `--accept-unready`— y `keel-dotnet build`
    con `postgresql · rabbitmq` (el stack de las gemelas, sembrado en `keel-stack.json`; 248 archivos, estampado
    `ready: true`, con la skill `keel-dotnet-httpclient`). El proyecto compila tal cual, sin warnings; las pruebas de
    build pasan (155/155) y `check-idempotency.sh` nace ROJO en las mismas siete familias que en keel-nest, con
    `outboundIdempotency` en verde (la clave la cablea build). Mide lo que ninguna red mide: los flujos del barrido de
    reconciliación con `AgeForReconciliation`, la compensación, el reintento con la MISMA clave contra el WireMock de
    `infra/` (FL-REC-002, «exactamente dos») y el clúster de dos réplicas. Los contenedores se llaman
    `stock-reservation-*`, como los de las gemelas: no puede correr a la vez que otra corrida del mismo diseño.
  - **11e, hecha (2026-10-14): 27/27 y huella 11** —10 de trabajo del agente, las mismas que las dos gemelas, más un
    `harnessPatch`— (`docs/corridas/2026-10-14-stock-reservation-dotnet.md`). Sin huecos del diseño. Dos defectos del
    generador, los dos arreglados en keel-dotnet: (1) el arnés no tenía segunda réplica y el agente de pruebas se paró en
    FL-CLU-*; se arregló a mitad de corrida (`5718300`, `StartReplica`/`StopReplica`/`OnReplica` con un segundo proceso
    del Api) y se propagó con `build --refresh`, sin `harnessPatch`; (2) `AssertJson` comparaba las cadenas por su texto
    crudo y `"é"` no casaba con `"é"` (cinco falsos negativos; el agente lo parcheó en `JsonShape.cs`): ahora las
    cadenas por su valor decodificado. `harness-check` **32/32** con FL-PROBE-001-C (la réplica arranca, responde, se
    para y el servidor sigue) y FL-PROBE-001-D (una `é` escapada frente a una literal). El aviso de `reset-db.sh` sobre
    las colas fue del agente de infraestructura antes de que el servidor declarara la topología: no es defecto.
- **Inc. 11 — cerrado (2026-10-14).** `needs` (réplica, `onMiss`, `lastKnown`), `oauth2-client-credentials` y los
  compuestos en una llamada siguen rechazados hasta el incremento 13, como en keel-nest. Siguiente: el incremento 12
  (persistencia documental, MongoDB).
- **Inc. 12 — cerrado (2026-10-15, corrida `notification-mailer-mongo` 23/23, huella 17).** Tramos como los de keel-nest (su § Inc. 12), con el 12a ya hecho en
  keel-core (`document.js`: el documento como datos, rutas, índices del diseño y de los almacenes, `export-indexes.sh`;
  `mongo-probes.js`, los scripts del arnés): 12b la persistencia documental, 12c los almacenes del generador sobre
  documentos, 12d el arnés y la skill `keel-dotnet-mongodb`, 12e la corrida (keel-nest la hizo sobre
  `notification-mailer-mongo`, que trae `mail` y `resolvedBy`, del 13). **Sujeto decidido (2026-10-15)**: el mismo que
  keel-nest, adelantando `resolvedBy` (12e-a) y la capa `mail` (12e-b); `inspection-reports` y `job-dispatch-mongo` no traen
  `validation-scenarios.md`, así que una corrida sobre ellos no tendría matriz que puntuar.
  - **12b, la persistencia documental (hecho, 2026-10-15).** `cs-check` 15/15 (126 ensamblados, 2 237 pruebas) y su paso nuevo de licencias de las fixtures (95 paquetes); keel-dotnet sin red 468/468. Sobre el driver oficial (**MongoDB.Driver 3.12.0**,
    Apache-2.0; sus transitivas DnsClient, SharpCompress, Snappier y ZstdSharp.Port son Apache-2.0, MIT y BSD-3-Clause),
    **sin mapeo de clases**: cada adaptador escribe y lee el `BsonDocument` campo a campo (el mapeo del driver
    decidiría nombres, discriminadores y representaciones por su cuenta).
    - **Una decisión de forma**: la rama documental emite los MISMOS nombres que la relacional —`DatabaseSettings`,
      `PersistenceTransactions` (con `InTransaction`, `AfterCommit` y `Run`), `PersistenceErrors.Translate`,
      `AddPersistence`/`InitializeDatabase`—, así que Program.cs, el mediator, el middleware de errores y la página solo
      cambian `usesRelational` por `usesPersistence` (`src/scaffold/persistence.js`). El puerto de cada raíz es el
      mismo; el adaptador se elige por modelo (`src/scaffold/document-repositories.js`). Un reclamo de barrido del
      puerto, en el adaptador documental, lanza `NotSupportedException` nombrando el 12c (la frontera ya rechaza el
      diseño que lo declara).
    - **Lo que emite** (`src/scaffold/document-persistence.js`): `db.yaml` con la `DB_URL` de keel-spring tal cual
      (`uuidRepresentation=standard` incluida: el driver de .NET la acepta, a diferencia del de Node); `DocumentDatabase`
      (un cliente por proceso); `BsonValues` (uuid binario de subtipo 4, `Decimal128` con su escala, Int64, el instante
      al milisegundo, el día a medianoche UTC, el json como texto, el enum por su constante con `EnumColumns`, y la
      auditoría declarada: `StampCreated` trata como «sin estampar» el null y el valor por defecto del dominio, como el
      `== default` relacional); `DocumentIndexes` creados al ARRANCAR con los nombres de keel-core; la transacción
      sobre una sesión, sin el `WithTransaction` del driver (que reintentaría dos minutos): el `WriteConflict` (112 o
      `TransientTransactionError`) repite el caso de uso entero hasta 3 veces y, agotado, es el 409; el E11000 → el
      error del diseño buscando el nombre del índice en el mensaje; y `infra/export-indexes.sh` neutral. Sin tope de
      transacción ni 503, como keel-spring en Mongo. El adaptador guarda con `$set` (no reemplaza: la auditoría de
      política se conserva), con la versión en el FILTRO y `created_*` en `$setOnInsert`; el listado ordena por la RUTA
      del espejo (`location.label`, `sections.status`), con desempate por `_id`.
    - **Frontera**: el modelo documental y `mongodb` entran; sobre documentos se rechazan, nombrando el 12c, la
      mensajería, los barridos con `schedule`, el registro de idempotencia y la reconciliación (el reparto de keel-nest), y
      se avisa de que el arnés de flujos documental llega en el 12d. Ninguna fixture documental entra entera por `build`
      todavía (todas traen algo del 12c o del 13): las redes miden sobre `planService`, como keel-nest en su 12b. La
      paridad del contrato HTTP pierde su única excepción (el `sort` de la página documental).
    - **Medido**: `npm run doc-check` (nuevo) contra un MongoDB miembro de un replica set, sobre las cuatro fixtures
      documentales y la derivada `job-dispatch-mongo-compare` (la sombra plegada en la clave natural): **14/14, 56 sondas**
      —ida y vuelta, el documento CRUDO contra `documentShape` a todo nivel (cada clave con su tipo BSON y ninguna de
      más), la versión obsoleta, la clave natural y el índice condicionado con su error y su mensaje, la carrera de dos
      transacciones (el clasificador y el 409 tras los reintentos), la auditoría, la página con orden y la propiedad
      inexistente, y los índices vivos contra el contrato (nombre, claves en orden, unicidad, filtro parcial, ninguno de
      más; creados dos veces)—. **Falsado con diez sabotajes** que compilan, cada uno en su comprobación: decimal como
      texto, uuid como texto en los dos sentidos (la ida y vuelta en VERDE: solo lo ve el documento crudo), la versión
      fuera del filtro, el clasificador del conflicto, el traductor sin índices, el literal en el filtro parcial,
      `created_at` declarado y de política reescritos, el enum por su miembro de C# y el día en otra zona. El del
      clasificador salió VERDE la primera vez: quitaba solo la etiqueta, y el código 112 dice lo mismo (mutación
      equivalente); ahora quita las dos vías. `test/document-persistence.test.js` (sin red): las claves que escribe cada
      `ToDocument` contra `documentShape` en orden y a todo nivel, los índices contra `documentIndexes`, el traductor
      contra `constraintErrors`, la `DB_URL` contra la que emite keel-spring y las propiedades de orden contra el
      `SORTABLE` que emite keel-nest.
    - **Lo que destapó**: `cs-check` solo revisaba las licencias transitivas del proyecto de referencia (PostgreSQL), así
      que lo que traen Kafka, SNS/SQS y ahora MongoDB no lo leía nadie. Gana un paso: las licencias de todo lo que NuGet
      resuelve para la solución de TODAS las fixtures.
  - **12c, los almacenes del generador sobre documentos (hecho, 2026-10-15).** Cada almacén conserva su archivo, su clase y
    su API, y solo cambia el cuerpo por modelo (`src/scaffold/document-stores.js`): el relay, los listeners, los handlers,
    el reloj y el gate no distinguen el almacén.
    - **Lo que emite**: el relay del outbox reclama con `FindOneAndUpdate` y la marca caducable `claimed_at` (el
      equivalente del SKIP LOCKED), sin transacción, en orden de llegada; el fallo es un `$inc` con el error como VALOR de
      un `$set` (un texto que empiece por `$` no se lee como campo), y la rendición con el contador ya incrementado. El
      PUENTE escribe el documento del outbox en la sesión de la transacción del cambio (con outbox, `Publish` pasa a ser
      `Task`: insertar es asíncrono) y, fuera de una, es un error. La guarda y el registro de idempotencia INSERTAN sobre
      su `_id` subdocumento en el orden de keel-core (`storeDocumentKey`), la guarda sin sesión (una inserción suelta ya es
      atómica) y el registro en la del caso de uso; la tienda de reconciliación es un upsert sobre la marca caducada, con
      `Held` para excluir de la lectura los candidatos de marca viva. Los reclamos de barrido (cola y rescate) y de
      reconciliación del adaptador, con `FindOneAndUpdate` en orden y el estado guardado como la constante del enum, y
      `RequireOwnTransaction` mirando la sesión. Las purgas, el mismo bucle por lotes sobre la colección (sin condición
      propia en el outbox: un `$lt` sobre una fecha no casa con null, y repetir la clave en el filtro rompía el documento).
      El gate pide `InsertOneAsync` y prohíbe el reemplazo y el upsert, y no emite `conditionalUniqueness` sobre
      documentos (ni keel-spring ni keel-nest lo hacen): `idempotency-check.test.js` gana la paridad de familias con
      keel-nest en las cuatro fixtures documentales.
    - **Adelantado del 12d**: el arnés de mensajería esperaba al outbox por SQL (`Harness.Db`), que en documental no existe,
      y no compilaba. Gana `Harness.MongoEval` (el script por ARCHIVO dentro del contenedor y envuelto en el `print` de
      `keel-core/gen/mongo-probes.js`) y la versión documental de `AwaitOutboxDrained`, `DeadLetteredEvents`,
      `AbandonOutboxEvent`, `ClearAbandonedOutboxEvents` y el aparcamiento del outbox. El rescate y la reconciliación del
      arnés siguen en el 12d.
    - **Frontera**: sobre documentos ya no se rechaza nada propio del modelo; `job-dispatch-mongo` e `inspection-reports`
      entran enteras por `build`. `notification-mailer-mongo` y `asset-vault` siguen fuera por lo del incremento 13 (correo,
      storage, `needs`, `resolvedBy`), como estaban en keel-nest.
    - **Medido**: `doc-check` **14/14, 127 sondas**, con los almacenes: el outbox (orden, lote, la marca viva y la
      caducada, dos réplicas sin repetir, fallo con backoff y rendición, lo publicado), el puente (la fila con las claves
      del contrato confirma y aborta con el cambio), el `_id` subdocumento de los dos registros en su orden, el registro de
      idempotencia y la guarda con las MISMAS sondas que la rama relacional (solo usan la API), los reclamos de barrido y de
      reconciliación de cada raíz, la tienda de la marca y las purgas por lotes. **Falsado con trece sabotajes** de los
      almacenes, cada uno en su sonda. Dos trampas medidas: (1) el sabotaje que quitaba el ORDEN del relay salió VERDE —el
      índice `ix_outbox_event_pending` (published_at, created_at) regala el orden, la misma que encontró keel-nest—, y ahora
      el orden se mide con el índice retirado; (2) con los instantes de las muestras creciendo como el `_id` (UUIDv7),
      quitar el orden de un reclamo era una mutación equivalente: ahora se siembran al revés de la inserción. Y una de las
      sondas: el muestreador de patrones daba 26 valores (un carácter), y con más de 26 muestras de una raíz la clave
      natural de `asset-vault` chocaba consigo misma; pasada la vigésimo sexta variante, la muestra se alarga.
  - **12d, el arnés documental y la skill (hecho, 2026-10-15).**
    - **Lo que emite** (`src/scaffold/document-harness.js`): en `FlowTest`, `MongoEval` —el `Db` de los documentos, sobre
      el `Harness.MongoEval` del 12c— y los ayudantes con los MISMOS nombres y scripts que keel-spring y keel-nest
      (`keel-core/gen/mongo-probes.js`): `StallInFlight`/`PutInFlight`/`InFlightWithoutClock` con `setStateScript` y
      `missingClockCountScript`, y `AgeForReconciliation`/`HoldFromReconciliation` con `ageClockScript`/`holdClockScript` y
      la clave del documento de `documentShape`. El humo gana el SMOKE-3 documental (la base responde a un script). La
      `infra/` ya era neutral: el `reset-db.sh` vacía documentos conservando índices.
    - **El agente de calidad** gana la rama documental: no hay baseline que redactar, sino índices que VERIFICAR con
      `infra/export-indexes.sh` (`indexes`/`indexesTested` en su reporte, como keel-nest), y la skill orquestadora se lo
      pide. **Skill `keel-dotnet-mongodb`** (`SKILL.md` + `repository-adapters.md`, `indexes.md`, `harness.md`,
      `troubleshooting.md`), instalada con `database: mongodb` en lugar de `keel-dotnet-database`; `generator-docs.test.js`
      comprueba que las rutas, los valores de `BsonValues` y los ayudantes que enseña existen en lo emitido. La frontera
      deja de avisar: sobre documentos ya no queda nada propio del modelo pendiente.
    - **Medido**: `npm run doc-harness-check` (nuevo) **18/18** sobre `job-dispatch-mongo` con su `infra/` real —build,
      `check-flows.sh`, `up.sh`, `validate-infra.sh` (el replica set), el humo, `score-scenarios.sh` saliendo con 0— y un
      flujo sonda con los ayudantes emitidos: las comillas y el `print` por `MongoEval`, el reset que conserva los índices,
      el rescate (estado y reloj rancio, reloj a ahora), el recuento sin reloj discriminando, el script de
      `AgeForReconciliation` que emite `asset-vault` (leído de su `FlowTest.cs`), y los índices vivos contra el contrato
      con `export-indexes.sh`. **Falsado con cuatro sabotajes**: sin el `print` cae el humo (score sale con 2); `PutInFlight`
      con el reloj rancio y el recuento sobre otro campo, cada uno en su sonda; y un índice fuera de `DocumentIndexes.cs`,
      en la verificación de calidad (y en la sonda del reset).
    - **Lo que destapó, y no era documental**: `check-flows.sh` salía ROJO sobre un proyecto RECIÉN generado, también
      relacional (`product-catalog`): MSBuild copia la salida del Api a la de los flujos por ser un ejecutable
      referenciado, aunque no vea sus tipos, y sin el Api compilado esa copia falla con `MSB3030` —después de compilar las
      pruebas—. En las corridas no se vio porque el agente de código iba por delante; `harness-check` compila la solución
      antes. Ahora el script ignora esa copia y lo dice. `harness-check` relacional sigue 32/32.
  - **12e-a, `resolvedBy` (hecho, 2026-10-15, `2ec07ca`).** La identidad del llamante resuelta contra VARIAS credenciales:
    el finder `FindBy<Campo>Containing` (el nombre de keel-spring en PascalCase) en el puerto y en los dos adaptadores
    —relacional sobre la tabla de elementos, documental sobre el array—, y `CallerIdentityResolver` (scoped, en
    `SecurityRegistration`), que el endpoint llama antes de despachar; el lector recibe `string? resolvedCaller`. Medido con
    `test/caller-resolution.test.js` y la sonda `credential` de `db-check` y `doc-check`, falsada en los dos.
  - **12e-b, la capa `mail` (hecho, 2026-10-15).** El reparto de keel-spring y keel-nest: build genera TAMBIÉN el adaptador
    y el renderizador (`src/scaffold/mail.js`), porque lo que llevan dentro son dos defensas cuya ausencia no rompe ninguna
    prueba. `MailMessage` (Domain/Mail) sanea asunto y cabeceras en el constructor con las reservadas de
    `keel-core/gen/mail-message.js`; `MailDeliveryException` con `Accepted`/`Rejected`/`Detail`/`Partial()`; los puertos
    `IMailSender` e `ITemplateRenderer` en Application/Ports; `SmtpMailSender` sobre **MailKit 4.18.1** (MIT), con un
    `SmtpClient` que apunta el destinatario rechazado en vez de abortar (`OnRecipientNotAccepted`): así se dice el envío
    PARCIAL; `HandlebarsTemplateRenderer` sobre **Handlebars.Net 2.4.3** (MIT) con dos entornos propios
    (`Handlebars.Create`) y un `ITextEncoder` con la tabla cerrada `& < > " '` —a diferencia de keel-nest, Handlebars.Net
    sí admite el escapado por instancia—, los marcadores simples como `{{this.[x]}}`, `Compile` y el LRU de 500;
    `mail.yaml` con las variables `MAIL_*` de keel-spring. La guarda contra el doble envío `ClaimFor<Op>` (el `guardClaim`
    de keel-core) en el puerto y en los dos adaptadores: en relacional un UPDATE condicional en un ámbito y una
    transacción PROPIOS (`IServiceScopeFactory`), en documental un `FindOneAndUpdate` sin la sesión del caso de uso. El
    handler de `mail.sentBy` recibe los dos puertos y la nota; la familia `mailDelivery` del gate entra (la paridad de
    `idempotency-check.test.js` ya no tiene familias pendientes). El arnés del buzón en `Support/Mail.cs`
    (`src/scaffold/mail-harness.js`, sobre `keel-core/gen/mail-probes.js`) con los once helpers de keel-spring y el
    SMOKE-7; la skill `keel-dotnet-mail` (`SKILL.md` + `security.md`, `flows.md`, `troubleshooting.md`).
    - **Una dependencia transitiva fijada a mano**: MimeKit pide `System.Security.Cryptography.Pkcs >= 10.0.0` y NuGet
      resolvía la 10.0.0, con dos avisos publicados (GHSA-846f-f764-76mx, alta; GHSA-2fmv-rv2c-59x7, moderada) corregidos
      en la 10.0.13. Se fija esa versión con correo, y es la ÚNICA excepción a la regla de las dos semanas (la publicó
      Microsoft el 2026-10-13): un parche de servicio frente a emitir a sabiendas una versión con un aviso de gravedad
      alta. Lo vigila `test/mail.test.js`; revisar al subir MailKit.
    - **Medido**: `npm run mail-check` (nuevo) **5/5 con 11 sondas** contra un Mailpit real —las dos partes, el adjunto,
      el remitente de respaldo, el Reply-To y la cabecera propia; un cuerpo con acentos byte a byte; la tabla cerrada en
      el buzón; el asunto saneado; el rechazo parcial y el total; el conteo; las palabras del motor como variables, los
      bloques, `Compile` y la parte en la clave de la caché—, **falsado con cuatro sabotajes** (`subject`, `escape`,
      `partial`, `fallback`), cada uno en su sonda. La guarda, con la sonda `Guarda_ClaimFor…` de `db-check` (PostgreSQL)
      y de `doc-check` (MongoDB): confirma aunque el caso de uso se deshaga, estampa su reloj, no se la lleva dos veces y
      de dos a la vez gana una; **falsada** en los dos con `send-guard` (la guarda escribe en la transacción o la sesión
      del caso de uso). `test/mail.test.js` (paridad del `mail.yaml` y del nombre de la guarda con keel-spring).
      `cs-check` **16/16** (126 ensamblados, 2 360 pruebas, licencias de 100 paquetes con las fixtures de correo ya dentro);
      keel-dotnet sin red 488/488.
    - **Lo que destapó, y era del 12e-a**: con `notification-mailer` dentro de la frontera, la prueba emitida del uuid
      malformado salió roja: el endpoint resolvía la identidad del llamante (una consulta a la base) ANTES de leer la
      entrada, así que una ruta malformada llegaba a la base en vez de responder 400. Ahora el lector recibe la resolución
      como función y la llama tras sus comprobaciones —el orden de keel-nest—, y `test/caller-resolution.test.js` lo fija.
  - **12e, la corrida (hecha, 2026-10-15; `docs/corridas/2026-10-15-notification-mailer-mongo-dotnet.md`).** **23/23 a
    la primera**, sin `harnessPatches` ni fixes de `infra/`, y `check-idempotency.sh` en verde sobre el proyecto
    terminado. Huella **17** de 298, la de las gemelas de control de keel-nest y keel-spring archivo por archivo (los
    nueve handlers, los tres agregados y la entidad hija, `BrokerBindings.cs`, el `README.md` y la misma consulta de
    negocio de la versión siguiente de una plantilla): 15 TODO · 2 consulta. Nada del adaptador documental, de los
    almacenes, del arnés ni del correo tocado. El único `designGap` ya estaba aceptado en `specs/gaps.yaml`, y era la
    segunda vez que un agente lo hacía (antes, `profile-directory-nest`): las skills de los tres generadores no decían
    que hay que mirar ahí antes de reportar. Arreglado en los tres, con su prueba.
- **Inc. 13 — en curso (abierto el 2026-10-15).** El correo ya entró en el 12e-b. Quedan pagos, caché, storage, autoría,
  `needs` (bajo demanda y réplica, con `lastKnown`) y `oauth2-client-credentials`. **El orden es el de keel-nest (su § Inc. 13),
  y por el mismo motivo**: pagos lo ejerce solo `payment-checkout`, que ya cabe entero en la frontera salvo la capa, así que
  es el único tramo que se cierra con corrida sin abrir otros frentes; caché y storage los declaran `asset-vault` y
  `catalog-extended`, que arrastran además `needs` y OAuth2. Tramos: 13a lo neutral (ya en keel-core desde keel-nest:
  matriz, claves, rechazos, monedas, doble); 13b+13c la capa y sus dos adaptadores; 13d el arnés, las skills, la matriz en
  build/check y la frontera; 13e la corrida `payment-checkout`; después 13f caché, 13g storage, 13h autoría, 13i–13j `needs`
  y OAuth2.
  - **13a, lo que faltaba de neutral (hecho, 2026-10-15).** `payments.yaml` estaba escrito en keel-nest: sale a
    `keel-core/gen/payments-config.js` (`paymentsYaml`), y keel-nest lo reexporta. Su `test/payments.test.js` sigue en verde
    contra keel-spring.
  - **13b+13c, la capa y sus dos adaptadores (hecho, 2026-10-15).** Van juntos, como en keel-nest: el registro cablea el
    adaptador de la pasarela elegida. `src/scaffold/payments.js` (lo neutro) emite `Domain/Payment` (`GatewayStatus`,
    `GatewayOutcome`, `PaymentSource`, `ChargeRequest`, `PaymentGatewayUnavailableException`,
    `GatewayRejectedPaymentMethodException`), el puerto `IPaymentGateway` en `Application/Ports`, `Application/Payment`
    (`PaymentOutcomeApplier` sobre `ICommandDispatcher`, `PaymentNotices`, `PaymentReconciliation` con `StaleBefore()` y
    `BatchSize()`) e `Infrastructure/Payment`: `PaymentGatewaySettings` (las duraciones con la sintaxis de Spring),
    `PaymentGatewayHttp`, `GatewayJson` (la lectura de un campo como la de los otros dos: falta, null o no escalar es sin
    valor; un número vale su texto), `GatewayKeys` (la clave `<referencia>:<acción>`, `save:<token>:<paso>` y el `|` del
    medio guardado, de keel-core), `MoneyAmounts` con la tabla de keel-core tal cual, `PaymentNotice` +
    `IPaymentNoticeVerifier` y `PaymentsRegistration`; y en `Api/Rest` el `PaymentNoticeEndpoint`, que lee el cuerpo como
    texto con un `StreamReader` (sin el contrato del cable: la firma es sobre los bytes que llegaron) y responde 401 o 200
    vacíos. La ruta la abre el plan de acceso neutral, que ya la traía. `src/scaffold/payment-gateways/{stripe,mercadopago}.js`
    traducen los de keel-nest caso por caso; la traducción de los rechazos se emite como diccionario desde
    `GATEWAY_TRANSLATIONS`.
    - **Lo que C# obliga a decidir**: un componente obligatorio del mensaje de desenlace que la pasarela no da falla en voz
      alta (`Required`/`RequiredValue`, uno por referencia y otro por valor); el que la capa no nombra (`cancelReason`) sale
      `Todo<T>(…)`, que lanza; la acción del cliente se embebe como `JsonElement`. **Y el transporte**: `SocketsHttpHandler`
      reenvía por su cuenta una petición cuya conexión se corta (medido en el 11b), y aquí eso es cobrar dos veces. El
      cliente de la pasarela lleva la misma guarda que `HttpExchange`: `Connection: close` y un `ConnectCallback` que no abre
      una segunda conexión para la misma petición.
    - **Medido**: dos pruebas EMITIDAS, que se ejecutan en `cs-check` con la fixture (Stripe) y la variante nueva
      `payment-checkout-mp` (MercadoPago). `PaymentGatewayTests` lanza el adaptador y el verificador contra una pasarela falsa
      (`HttpMessageHandler`) con las formas del doble (`payment-probes.js`): la clave y la unidad, la clave repetida al
      reintentar, cada código de rechazo del doble como su motivo, el 5xx y el corte en duda sin reintento, el plazo, el
      importe con más decimales sin mandarse, la búsqueda por referencia, `NotFound`, la devolución (parcial, con la lectura
      previa en MercadoPago), la captura caducada, guardar un medio y los avisos (firma, rotación, ventana, ts en
      milisegundos). `PaymentNoticeEndpointTests`, en el servidor en memoria: sin firma 401 vacío, firmado 200, y el GET
      cerrado. **Falsado** a mano con nueve sabotajes, cada uno cazado por su prueba (clave aleatoria, ventana, marca de
      captura caducada, redondeo, reintento del 5xx, firma ignorada, manifiesto sin minúsculas, lectura previa tragada, ts
      en milisegundos sin normalizar), y seis quedan en `cs-check --sabotage=payment-*`. `test/payments.test.js` (nuevo, sin
      red): solo cambian entre pasarelas su carpeta, el registro, sus pruebas y las variables fuera de local y test;
      `payments.yaml` idéntico al de keel-nest y al de keel-spring en los cuatro perfiles, y `PaymentGatewaySettings` lee solo
      claves que declara; la tabla, la clave y los rechazos de keel-core; la ruta abierta solo al POST; el despacho sin
      transacción; el aplicador. `cs-check --fixtures` **132/132 ensamblados, 2 584 pruebas**, licencias de 100 paquetes
      (ningún paquete nuevo: todo es de la biblioteca base); keel-dotnet sin red 496/496.
    - **La frontera sigue rechazando `payments`**, como en keel-nest tras su 13c: el proyecto compila, arranca y responde al
      aviso, pero sin el arnés (el doble en los flujos) ni las skills el agente no tendría con qué. Se quita en el 13d.
  - **13d, el arnés, las skills y la frontera (hecho, 2026-10-15). keel-dotnet genera ya la capa `payments`.**
    - `src/scaffold/payment-harness.js` emite `tests/<Raíz>.IntegrationTests/Support/PaymentGateway.cs` con la API NEUTRA de
      keel-spring y keel-nest en PascalCase (`GatewayAuthorizes`/`Charges`/`RequiresAction`/`Declines`,
      `GatewayDoesNotAnswer`, `GatewayReports`, `GatewayCaptures`/`Cancels`/`Refunds`, `GatewayExpiresAuthorization`,
      `GatewayRejects`, `GatewaySavesPaymentMethod`, `GatewayCallCount`/`Requests`, `GatewayIdFor`, y `GatewayCall` como
      enum). La lógica vive en `PaymentGatewayHarness`, que solo usa `HttpStubHarness` y la biblioteca base, para que
      `stub-check` lo compile SOLO; por eso `SendGatewayNotice`/`SendForgedGatewayNotice`, que necesitan el `Post` del
      flujo, van en `FlowTest.cs`. `AgeForReconciliation` y `HoldFromReconciliation` ganan el barrido de pagos en las dos
      ramas, relacional y documental, con el nombre del barrido como clave (como en los otros dos). La moneda de los
      escenarios (`paymentTestCurrency`) sale a `keel-core/gen/payments-config.js`: estaba escrita en keel-spring y en
      keel-nest, y ahora la importan los tres.
    - Skills `keel-dotnet-payments` (SKILL.md + `security`, `outcomes`, `reconciliation`, `flows`, `troubleshooting`),
      `keel-dotnet-stripe` y `keel-dotnet-mercadopago` (con su `sandbox.md`), instaladas por `stackSkills` (la de la
      pasarela, solo con ella). Lo que dicen distinto de keel-nest: los puertos se añaden al constructor primario (el
      contenedor ya los tiene), la sexta defensa es la del transporte (`Connection: close` y el `ConnectCallback`), y el
      reclamo del barrido se escribe como las guardas `ClaimFor…` que ya emite build (ámbito y transacción propios).
    - `build` y `check` llevan la matriz de la pasarela (rechazo y aviso de lo sin verificar; `check` enseña las dos
      pasarelas del catálogo), y `planService` la aplica también, para que ningún camino genere un adaptador a medias.
      `supported-features.js` ya no rechaza `payments`.
    - **Medido**: `npm run stub-check` gana la pasarela de las dos contra un WireMock REAL —`scripts/probes/PaymentProbes`,
      NEUTRAL: el mismo C# para las dos, la pasarela la elige `AddPayments`—: el arnés compilado solo con el adaptador y el
      verificador emitidos, cada helper con su desenlace (dos cobros a la vez casados por su referencia, cada motivo del
      arnés como ese motivo, el corte en duda y sin repetir, la consulta por id y por referencia, captura, anulación,
      autorización caducada, devolución parcial, guardar un medio y su rechazo) y el aviso firmado por el arnés aceptado
      por el verificador, el falsificado no. **9/9 a la primera, 14 sondas por pasarela**; falsado con
      `--sabotage=payment-body` (sin casar por la referencia: caen los dos casos de cobro en las dos pasarelas) y
      `payment-forged` (cae el del aviso en las dos). Sin red: `generator-docs.test.js` exige que las rutas que citan las
      tres skills existan en lo emitido y que los helpers que enseña `flows.md` sean los del arnés;
      `build.test.js` (build con MercadoPago: avisa de lo sin verificar e instala su skill y no la otra; la captura
      parcial con MercadoPago no pasa de `planService` y con Stripe sí) y `check.test.js` (la cobertura por pasarela).
  - **13e — corridas preparadas (2026-10-15), sin lanzar**: `spring-live-test/corrida-payment-checkout-{stripe,mercadopago}-dotnet/`,
    sembradas con `keel init` de este repo, `payment-checkout` v1.2.0 y su `DESIGN.md` (`--ready` en verde en las dos),
    `keel-stack.json` con PostgreSQL, RabbitMQ, Keycloak y la pasarela, y `build` hecho (322 archivos en cada una; con
    MercadoPago, los dos avisos de lo que la matriz no ha verificado). Las dos compilan sin warnings y sus pruebas unitarias
    pasan recién generadas (164 y 162, con `PaymentGatewayTests` y `PaymentNoticeEndpointTests`). Sin contratos de
    `/keel-docs`, como las de keel-nest y keel-spring. Comparten los puertos de `infra/`: se corren de una en una. Las
    gemelas para comparar la huella son las de keel-nest y keel-spring del 2026-10-09 (25/25, huella 20–21).
  - **13e, MercadoPago: 25/25 a la primera (2026-10-15; `docs/corridas/2026-10-15-payment-checkout-mercadopago-dotnet.md`).**
    Huella 22 de 322; quitando los dos huecos del generador, 20, la de las gemelas. Es la primera corrida de
    `payment-checkout` v1.2.0 en cualquier generador (con los escenarios de `onRejected`). Arreglados: `UseCasesTests` sin
    `AddPayments` (keel-dotnet; medido 15/15 rojo → verde) y el rechazo de una acción de seguimiento en el arnés de los
    tres (el adaptador consulta el estado real tras un 4xx; el doble necesita `GatewayReports`, y el agente había
    cambiado el adaptador en su lugar). **Pendiente, de los tres generadores**: el origen de `requestCharge` (HTTP o
    suscripción) que cinco corridas resolvieron a mano de cinco formas; candidato a pieza neutral.
  - **13e, Stripe: 25/25 (2026-10-15; `docs/corridas/2026-10-15-payment-checkout-stripe-dotnet.md`).** Con los arreglos de
    la de MercadoPago dentro (`build --refresh` antes de lanzarla), que se confirman: el agente no tocó `UseCasesTests.cs`
    ni el adaptador. Huella 21; quitando el hueco del generador, 20. **Una divergencia del servidor, arreglada**: keel-dotnet
    exigía que `metadata.eventId` fuera un uuid y descartaba el mensaje; en keel-spring y keel-nest es texto. El agente lo
    había resuelto en el arnés (`harnessPatch`); ahora `EventMetadata.EventId` es `string` y el lector no le exige forma
    (`MessagingTests`, `cs-check --fixtures` y `broker-check` con RabbitMQ 22/22). `payments-cancel-reason` aparece en las
    dos corridas: candidato obligatorio a id en la próxima minor de la capa. **Incremento 13, pagos: cerrado.**
  - **13f, la caché de lectura (hecho, 2026-10-15).** `keel-dotnet` genera `cache` sobre Redis y Valkey, con el reparto de
    keel-nest: se cachea la RESPUESTA de la operación, la consulta la pone el agente en el handler (después de lo que
    dependa de quién llama) y la invalidación, build. `src/scaffold/cache.js` emite el puerto `IOperationCache` en
    `Application/Ports` (`GetOrLoad`, `Evict`, `Clear`, `CachedOperation<T, TMessage>`, `CacheKey.Of`), las cachés del diseño
    en `Application/Support/CachedOperations.cs` (nombre, TTL y clave de `keel-core/gen/cache-plan.js`), y en
    `Infrastructure/Cache` el adaptador `RedisOperationCache` (degrada a miss, no guarda nulos, una carga por entrada, y una
    carga anterior al vaciado no guarda), el store sobre **StackExchange.Redis 3.3.1** (MIT; `AbortOnConnectFail = false`,
    `BacklogPolicy.FailFast` —la rama 3.x encola por defecto—, plazo por orden), `CacheInvalidations` (la tabla de keel-core,
    que el `UseCaseMediator` aplica dentro de la transacción del caso de uso) y el registro. `cache.yaml` sale a
    `keel-core/gen/cache-config.js` (estaba en keel-nest, que lo importa ahora). Las dos transacciones ganan
    `AfterCommitOrNow`: el vaciado espera al commit y, sin transacción, ocurre antes de responder (el `AfterCommit` de
    siempre lanza la acción sin esperarla). El arnés gana `ClearCache()` con la orden de `reset-db.sh`, y la skill es
    `keel-dotnet-redis`. La frontera deja de avisar de la caché.
    - **Lo que C# cambia**: el codec es System.Text.Json con las opciones del cable, sin lector por DTO. Con una
      diferencia al leer (`CacheCodec`): ninguna propiedad se exige presente. Una respuesta con `nulls: omit` se guarda sin
      esos campos y los DTO los declaran `required`, así que con las opciones del cable la entrada **no se leía nunca** y la
      caché no acertaba jamás, en silencio. Lo destapó `cache-check` (el acierto volvía al origen); la ida y vuelta de la
      prueba emitida no lo veía porque su muestra no llevaba nulos, y ahora hace una segunda vuelta con ellos (falsada:
      leer con las opciones del cable hace caer la de `GetProductBySlug`).
    - **Medido**: la prueba emitida `OperationCacheTests` EJECUTA el adaptador contra un store en memoria (acierto con su
      clave, su TTL y el JSON del cable, nulos, `Cacheable`, error de la carga, store caído, entrada ilegible, diez lecturas
      a la vez, el vaciado de una caché sin tocar otras con la carga anterior, sin store) y la ida y vuelta de cada respuesta
      cacheada del diseño; falsada con cinco sabotajes, cada uno en su caso. `npm run cache-check` (nuevo) contra Redis y
      Valkey reales con la sonda `scripts/probes/CacheProbes` (consola, porque sus pasos tienen orden): **25/25**, falsado
      con `offline` (la cola de la rama 3.x: la lectura esperó 4,5 s) y `ttl`. `test/cache.test.js` (sin red): `cache.yaml`
      idéntico al de keel-nest y leído por claves que declara, nombres y TTL de keel-core, la tabla de invalidación, el
      vaciado tras el commit, el puerto y la nota en el handler, el registro en la prueba del contenedor y en `Program.cs`,
      `ClearCache()` con la orden de `reset-db.sh`. `cs-check --fixtures` 132/132, **2 604 pruebas**, licencias de 103
      paquetes (StackExchange.Redis y su transitiva Pipelines.Sockets.Unofficial, MIT).
    - Los dos diseños con caché (`asset-vault`, `catalog-extended`) siguen fuera de la frontera por storage, `needs`, OAuth2
      y la autoría: la corrida espera al final del 13. Siguiente: 13g (storage).
  - **13g, el almacenamiento de binarios (hecho, 2026-10-15). La capa `storage` sale de la frontera.** El reparto de
    keel-spring y keel-nest: build emite el contrato y la entrada; el adaptador S3 lo escribe el agente.
    - **Lo neutral primero, sin mover ninguna línea base** (keel-spring 44/11 137 y keel-nest 41/10 050 idénticas):
      `storage.yaml` sale de keel-nest a `keel-core/gen/storage-config.js` (con `multipartFileLimitBytes`), como `cache.yaml`
      en el 13f; los cinco textos de la subida (la parte que falta, el 415, el 413, lo ilegible y la parte vacía) entran en
      `FRAMEWORK_RESPONSES` de `keel-core/gen/api-errors.js`, y keel-spring y keel-nest los leen de ahí (eran literales en
      los dos: la tercera copia no se escribió); `uploadNotes` acepta los nombres del lenguaje (`UPLOAD_NOTE_NAMES`, por
      defecto los de siempre). Antes, la línea base de keel-nest se regeneró en su propio commit: `492b743` cambió a
      propósito su arnés de pagos sin hacerlo (9 huellas, todas de ese commit).
    - **Lo emitido** (`src/scaffold/storage.js`): en `Domain/Storage`, `IFileStorage` (`Download`/`SignedUrl` solo con un
      bucket privado, `PublicUrl` solo con uno público), `StoredObject`, `BucketPolicy` (`AllowsContent` = tipo declarado Y
      firma, `AllowsSize`, `SignedUrlTtlSeconds()` que lanza sin caducidad declarada), `ContentSignature` (la tabla de
      keel-core) y `StoragePolicies` con una constante por bucket; en `Infrastructure/Storage`, `StorageSettings` (lee los
      buckets del diseño por su nombre y no arranca sin su nombre físico), `ConfiguredStoragePolicies`, el stub
      `S3FileStorage` y `StorageRegistration`, que llaman `Program.cs` y la prueba del contenedor (`Unconfigured`). El
      handler de la subida recibe `StoragePolicies` e `IFileStorage` con la nota neutral en nombres de C#; el mapper
      resuelve la URL de un bucket público con `PublicUrl` (era un `Todo.Value`). **AWSSDK.S3 4.0.103.4** (Apache-2.0, el
      mismo `AWSSDK.Core` que SNS/SQS) para el agente, skill `keel-dotnet-s3`.
    - **La entrada multipart** (`Api/Rest/MultipartReading.cs`): el lector de la subida lee el formulario LO PRIMERO (415 si
      no es multipart, 413 con el code del diseño por la longitud declarada y, por trozos, con el límite de Kestrel puesto en
      la petición —su máximo por defecto, 30 MB, es otro número—, `FILE_UNREADABLE` si está roto), después la ruta y luego
      campos y partes en el orden del controlador de keel-spring (`RequirePart`/`OptionalPart`, `Field`/`RequireField`, que
      leen el formulario y si no la query). `ApiErrorMiddleware` gana la parte que falta (400 sin code) y el 415. `ApiRoutes`
      sirve las subidas: su query son los campos simples y el binario no (el `@RequestPart`).
    - **Lo que destapó**: el oráculo de la paridad del contrato (`keel-spring/test/helpers/contract-table.js`) no leía un
      `@RequestParam` con un `@Pattern` que lleva paréntesis en la regex ni un `List<@Size(...) String>`: perdía `slug` y
      `labels` de `uploadAsset`. Corregido; la paridad de keel-nest sigue verde con él. Y, en C#, `MultipartFormDataContent`
      sin partes escribe una sección sin cabeceras que ASP.NET no lee como formulario: la prueba manda el cierre a secas,
      como la de keel-nest (un cliente real siempre manda alguna parte).
    - **El arnés**: `Upload(path, UploadPart, fields, headers)` (el `multipart(...)` de keel-spring) y, con MinIO,
      `StopStorage()`/`StartStorage()`.
    - **Medido**: `test/storage.test.js` (sin red, 9/9): `storage.yaml` idéntico al de keel-nest en los cuatro perfiles con
      MinIO y con S3 y leído por claves que declara, la tabla de firmas byte a byte, los métodos según la visibilidad, la
      inyección y la nota, el mapper, los registros, el límite y el arnés. La prueba emitida `ApiTests` gana los casos de la
      subida (la parte o el parámetro que falta primero, el 415, el 413, el cuerpo cortado, la parte vacía y la subida
      completa que llega al handler), que en keel-nest medía su test sobre Fastify: `cs-check --fixtures` 132/132
      ensamblados, **2 614 pruebas**, licencias de 104 paquetes. Falsado con dos sabotajes nuevos de `cs-check`, cada uno en su caso y solo en él: `multipart-limit` (sin el corte por la longitud declarada) tumba el 413 y `multipart-empty` (la parte vacía pasa) tumba el `FILE_UNREADABLE` de la parte vacía.
    - `asset-vault` y `catalog-extended` siguen fuera por `needs` y OAuth2 (y la autoría). Siguiente: 13h (la autoría).
  - **13h, la autoría de las escrituras (hecho, 2026-10-15).** Lo que se estampa ya estaba desde los incrementos 6 y 12b
    (las columnas `created_by`/`updated_by` de la política `all`, los campos `declared`, `created_by` solo al nacer y
    `updated_by` en cada escritura, en la raíz y sus hijas, en las dos ramas), pero **QUIÉN** quedaba no era el de
    keel-spring ni el de keel-nest, y no lo medía nada:
    - `AuditActor` se escribió en el 6, antes de la seguridad: devolvía `system` también con una petición autenticada.
      Ahora sigue la regla del `AuditorAware` de keel-spring y del `currentActor()` de keel-nest: con un token, el `sub`
      (el nombre del principal solo si no lo trae); con una clave de API, el cliente; sin petición autenticada,
      `system:<correlationId>` o `system`. Y la correlación la miraba solo con API: un servicio sin API cuya mensajería
      abre la correlación en el listener (`metering-digest`) escribía `system` a secas.
    - **Medido**: `test/audit-actor.test.js` (sin red, 5/5): la regla con y sin seguridad, la correlación de un listener,
      nada sin autoría y el estampado de las dos ramas (raíz e hijas con `catalog-extended` con la autoría puesta). La
      prueba emitida `AuditActorTests` EJECUTA el actor caso a caso con lo que el servicio tiene (`cs-check --fixtures`
      132/132, 2 619 pruebas). Contra la base real, la sonda nueva `<Raíz>_CreatedByEsDeQuienCreaYUpdatedByDelUltimoQueEscribe`
      (dos escrituras con dos autores; `created_by` del primero, `updated_by` del segundo): en `db-check` con el sujeto
      derivado `product-catalog-authorship` (ninguna fixture relacional declara la autoría; el mismo sujeto que keel-nest)
      y en `doc-check` con `asset-vault`, con el `sub` del token. Falsado con tres sabotajes, cada uno en su caso y solo
      en él: `actor-name` (cs-check: el nombre en vez del sujeto), `created-by` en db-check y en doc-check (created_by se
      reescribe en cada guardado).
    - La autoría `declared` (campos del dominio) se estampa con el mismo actor y la mide el texto; ninguna fixture la
      declara, así que no tiene sujeto en vivo.
    - `asset-vault` y `catalog-extended` siguen fuera solo por `needs` y OAuth2. Siguiente: 13i (`needs`).
  - **13i, el dato bajo demanda (`needs` on-demand): hecho (2026-10-15). `asset-vault` entra ENTERO en la frontera**
    (`keel-dotnet build` lo genera con MongoDB, Kafka, Keycloak, Redis y MinIO, con sus seis skills). El fallback del
    adaptador ya aplicaba `onUnavailable` desde el 11b (`fail` lanza el error del diseño, `degrade` deja el TODO con el
    `degradedTo`); faltaba lo de keel-spring y keel-nest en el handler: el puerto del cliente inyectado en la operación del
    `usedBy` y la nota de su política (que el dato ya llega en términos del dominio, que el retry y el circuito ya están,
    que el `fail` no se captura y, con `exposedAs`, que el mapper pide su DTO). La frontera deja pasar el `need` bajo
    demanda y rechaza, nombrando el 13j, la réplica y `onUnavailable: lastKnown` (este dejaba un TODO en el fallback). La
    skill `keel-dotnet-httpclient` enseña el `need`.
    - **Medido**: `test/needs.test.js` (sin red): la inyección y la nota solo donde toca, `degrade` y `fail` en el fallback.
      La prueba emitida `OutboundClientsTests` gana `<Adaptador><Llamada>ConElProveedorCaidoLanzaElErrorDelDiseno`: con el
      proveedor inalcanzable, la llamada lanza el error del diseño con su code, para un `need` y para una activación con
      `fail` (el escáner de asset-vault la estrena). Ninguna fixture declara un `need` con `fail`: lo trae la variante
      `asset-vault-need-fail` de `cs-check` (138/138 ensamblados, 2 791 pruebas), falsada con `--sabotage=need-fail`, que tumba ese caso y solo ese. keel-dotnet sin red 525/525.
    - Siguiente: 13j (la réplica, `lastKnown` y OAuth2: `catalog-extended`).
  - **13j-a, el último valor conocido y OAuth2 client-credentials (hecho, 2026-10-15).** Las dos piezas de keel-nest (su §
    13j), sobre los clientes del 11b:
    - **`lastKnown`**: `LastKnownValues` en `Infrastructure/Clients` (en memoria y por proceso, acotado por edad al LEER con la
      `maxAgeSeconds` del diseño y por tamaño con el tope de keel-core, con un `TimeProvider` para medirlo), alimentado en
      el camino feliz del adaptador con la clave de los parámetros de la llamada; el fallback lo sirve dentro de la ventana
      marcado (`Stale` y `AsStale()` en el resultado, que la nota de la caché ya pide no cachear) y se rinde con el error
      declarado. Antes dejaba un TODO.
    - **OAuth2**: `ClientCredentials` con la semántica del OAuth2AuthorizedClientManager de keel-spring (y la de
      keel-nest): `client_secret_basic` con la codificación de formulario de `URLEncoder`, los `scope` en el cuerpo, token
      reutilizado hasta `expires_in` menos 60 s, una sola petición en vuelo (`SemaphoreSlim`), `token_type` Bearer
      obligatorio y, sin `expires_in`, caducado en 1 s. `ClientSettings` gana la credencial y `HttpExchange` la pide antes de
      cada intento: sin token la petición no sale, y el fallo es `AuthGrant` (lo atiende el fallback, no cuenta para el
      circuito). `http-clients.yaml` ya traía las claves de keel-spring (neutral).
    - **Medido**: `test/outbound-13j.test.js` (sin red) y, EJECUTADO, `OutboundClientsTests`: el almacén (la ventana exacta,
      la clave por llamada y parámetros, los nulos, el tope), el adaptador de `catalog-extended` que recuerda, sirve el
      último valor de ESA clave dentro de la ventana y se rinde fuera, y la concesión contra un emisor falso (una petición
      con tres llamadas y con dos a la vez, la cabecera Basic y el formulario exactos, la renovación a 60 s del final,
      el token sin `expires_in`, el emisor caído, el rechazo, el JSON roto y el token que no es Bearer, y la llamada que
      lleva su Bearer o no sale). `cs-check --fixtures` 138/138, **2 800 pruebas**; falsado con cuatro sabotajes, cada uno
      en sus casos: `lastknown-window`, `lastknown-key`, `oauth-reuse`, `oauth-bearer`. keel-dotnet sin red 528/528.
    - `catalog-extended` queda fuera solo por la réplica (13j-b).
  - **13j-b, la réplica (hecho, 2026-10-15). `catalog-extended` entra ENTERO y ya no queda ninguna fixture fuera de la
    frontera de keel-dotnet** (`keel-dotnet build` lo genera con PostgreSQL, Kafka, Redis y MinIO, con sus cinco skills); lo
    único que rechaza es del stack (MySQL y los demás motores sin medir, la telemetría hasta el 14) y un value object
    compuesto en el cuerpo o la respuesta de una llamada saliente (ninguna fixture lo declara; los tests de la frontera
    lo derivan de `catalog-extended`).
    - **Lo emitido** (`src/scaffold/projections.js`, en `Application/Projection`): `<E>Snapshot`, `<E>Projector` (upsert
      idempotente que descarta un hecho anterior O IGUAL al guardado por su instante, `occurredAt` de keel-core) y `<E>Reader`
      (`onMiss`: `fetch` con el `Hydrate` del agente, `fail` con el error del diseño, `degrade` con null; y `ByKeys` cuando la
      lee un listado). El handler del `usedBy` recibe el lector con su nota, y el de la operación de proyección el proyector;
      los dos se registran en `UseCaseRegistration`. El adaptador de la réplica guarda en su PROPIA transacción, el
      REQUIRES_NEW de keel-spring: `Save` abre un ámbito de DI nuevo (otro contexto, otra transacción) y delega en el
      `SaveHere` del adaptador de ese ámbito, en las dos ramas. Y el finder por lote de la clave natural
      (`FindAll<Clave>In`, con `naturalKeyBatchReason` de keel-core), que también estrena `asset-vault` por su `scope-claim`.
    - **Diferencia con keel-nest, a propósito**: allí el proyector llama, por un cast, a dos métodos de dominio que escribe
      el agente; en C# eso no compila, y una réplica no lleva invariantes propias, así que el proyector construye la copia con
      el constructor de rehidratación del agregado. La escritura de la copia no deja TODO.
    - **Medido**: `test/replica.test.js` (sin red) y, contra PostgreSQL, las sondas nuevas de `db-check` sobre
      `catalog-extended`: el proyector crea, deja sin efecto la reentrega del mismo instante y un hecho anterior, y aplica
      uno más nuevo conservando el id; la copia sobrevive a la transacción de quien la escribe cuando esta se revierte; y
      `ByKeys` trae lo replicado y nada más. Falsado con `replica-tx`, `replica-order` y `replica-batch`.
    - **Lo que destapó, y era nuestro**: `db-check` de `catalog-extended` salía rojo de forma intermitente (un 409 de `sku`
      en una sonda u otra según el orden). Lo había roto el 13h: subir las muestras comunes de 16 a 17 llevó las de `Product`
      a 27, y la variante 27 de un texto con patrón repetía la primera (`AAAA`). El alargado que debía evitarlo sumaba al
      `minLength` declarado y no a la longitud natural de la muestra, así que con `{3,19}` no alargaba nada. Arreglado en
      `db-probes.js`. **La lección**: el 13h pasó `db-check` solo con el sujeto que había tocado; un cambio en las sondas
      comunes obliga a pasar TODOS los sujetos. Al pasarlos salió el segundo fallo del 13h: el sujeto derivado `product-catalog-authorship` conservaba el nombre del servicio, y sus proyectos chocaban con los de `product-catalog` en la solución común (con `--only` no se ve); ahora se llama como el sujeto. Con los dos arreglos, `db-check` entero: 12 sujetos, **206 sondas**; `doc-check` entero: 5 sujetos, 131 sondas; `cs-check --fixtures` 138/138, 2 800 pruebas. keel-dotnet sin red 532/532.
    - **Con esto el incremento 13 queda construido entero.** Lo que sigue son las corridas de `asset-vault` y
      `catalog-extended` en keel-dotnet, y el incremento 14.
  - **13k — corridas preparadas (2026-10-15), sin lanzar**: `spring-live-test/corrida-asset-vault-dotnet/` y
    `spring-live-test/corrida-catalog-dotnet/`, con los diseños de las gemelas de control de keel-spring y keel-nest
    (2026-10-11 v2): `asset-vault` v1.1.2 (idéntico a la fixture) y `catalog` v1.0.0 (la copia cerrada de
    `catalog-extended`, de `corrida-catalog-nest-v2`), cada uno con su `DESIGN.md` y sin contratos de `/keel-docs`, como las
    gemelas. Sembradas con `keel init` de este repo, `--ready` en verde (11/11) y el `keel-stack.json` de las gemelas
    (`mongodb · rabbitmq · keycloak · redis · minio` y `postgresql · kafka · keycloak · redis · minio`). `build` hecho: 335 y
    399 archivos; las dos compilan sin warnings y sus pruebas unitarias pasan recién generadas (169 y 228). Comparten los
    puertos de `infra/`: se corren de una en una. Gemelas para comparar la huella: `asset-vault` 32/32 con huella 18 en
    keel-spring y en keel-nest; `catalog` 56 escenarios con huella 28 (keel-spring) y la de keel-nest v2.
    - **Lo que destapó prepararlas**: la prueba emitida de `lastKnown` (13j-a) caía en `catalog` recién generado. Ahí
      `getPrice` sirve dos needs con políticas DISTINTAS (`currentPrice` con `lastKnown` y la réplica `supplierPrice` con
      `degrade`), y el adaptador enumera el conflicto con un TODO, como keel-spring y keel-nest; la prueba afirmaba
      `lastKnown` sin mirar que fuera LA política de la llamada. Ahora sale de `fallbackPolicy(call)`, la misma regla que el
      adaptador, y `test/outbound-13j.test.js` lo cubre derivando el conflicto de `catalog-extended` (ninguna red lo tenía).
  - **13k — corridas hechas (2026-10-16)**. Las fichas: `docs/corridas/2026-10-16-asset-vault-dotnet.md` y
    `docs/corridas/2026-10-16-catalog-dotnet.md`.
    - **`asset-vault`: 32/32, huella 21** (gemelas: 18). La primera puntuación dio 13 FAILED por un único defecto: la firma
      del comando recorría por reflexión el `ReadOnlyMemory<byte>` de una subida y caía en su `Span`. Cinco arreglos:
      la firma de la subida por el digest de su contenido (prueba emitida, sabotaje `signature-memory`),
      `check-flows.sh` con dígitos en el prefijo del id, `S3FileStorage` como `IHostedService` que aprovisiona los
      buckets, la lectura por lote del `embed` (`<Raíz>RefResolver` + `FindAllById`, la de los otros dos; sonda y
      sabotaje `id-batch` en `db-check` y `doc-check`) y `UploadOnReplica` en el arnés.
    - **`catalog`: 56/56, huella 23** (keel-nest v2: 25; keel-spring v2: 28). Ninguno de sus cuatro huecos del generador
      está en la huella. Los arreglos: el puerto **`IAfterCommit`** (la corrida se paró en `removeProductImage`, que
      borraba el binario dentro de la transacción porque Application no tenía con qué esperar al commit),
      `RowValues.Unmapped` solo cuando algún adaptador lo llama, **`RestartServerAsync()`** en `FlowTest` para empezar un
      flujo con la ventana del circuito vacía (el servidor es otro proceso: keel-spring la vacía en el suyo), y la nota del
      filtro plegado con la grafía de C# (`textFilterNotes` acepta la de la plataforma; golden de keel-spring y keel-nest
      idéntico). Sus dos designGaps no eran huecos: el 500 genérico no lleva `code` por contrato, y la invalidación de
      la caché termina antes de responder (la skill `keel-dotnet-redis` lo dice ahora entero).
    - **Medido**: sin red, keel-core 1216, keel-dotnet 545, keel-nest 800 y keel-spring 1664, todas en verde; golden de
      keel-spring y keel-nest idéntico. `cs-check --fixtures` 138/138 ensamblados y 2 803 pruebas; `db-check` entero, 12
      sujetos y **208 sondas**; `doc-check` entero, 5 sujetos y **133 sondas**. Falsados: `signature-memory` (solo cae
      la prueba de la firma), `id-batch` en `db-check` (las dos sondas del lote) y en `doc-check` (la del `Owner`).
    - **Con esto el incremento 13 queda cerrado.** Sigue el 14 (telemetría y `deploy/`).
- **Tramo previo al 14 — la revisión de los incrementos 0-13 (2026-10-18).** Antes de abrir el 14 se repasó el plan
  contra el código buscando lo que los incrementos cerrados habían dejado prometido. Cinco cosas, cuatro hechas:
  - **La matriz de paridad** (§1, principio 5, y §3), que el plan prometía desde el principio y no existía:
    `src/lib/engine-support.js` con una fila por mecanismo de `keel-core/gen/mechanisms.js`, `test/engine-support.test.js`,
    `test/parity.test.js` (marcadores por rama sobre los pares `job-dispatch` y `notification-mailer`, acotados a un
    archivo con la ruta del proyecto de cada rama) y `npm run matrix`. Las celdas salen de lo que este plan registra como
    medido y de los sabotajes que existen en cada red. Falsada quitando el `SKIP LOCKED` del relay en el emisor: cae
    exactamente `outbox-relay/relational`. **30 celdas: 25 verificadas, 3 sin ejecutar, 2 no-aplica y 2 filas pendientes
    del 14** (`runtime-panel`, `telemetry-store-spans`). Lo que destapó pasarla a código:
    - **sin ejecutar**: `transient-write-conflict/relational` (ninguna red provoca un interbloqueo real; el reintento de
      `PersistenceTransactions` no lo recorre nadie) y `folded-text` en las dos ramas (la sombra existe y se conserva,
      pero ninguna sonda manda la clave en mayúsculas al índice único: un `TextFold` que no plegara saldría verde). Las dos
      las mide keel-nest; aquí faltan sus sondas y sus sabotajes. La puerta del 16 («matriz sin `sin ejecutar`») las exige;
    - **sin falsar**: `harness-db-probes/relational`, `harness-sql-literals/postgresql` (como en keel-nest) y
      `partial-unique-index/postgresql` (ningún sabotaje rompe el PREDICADO del índice parcial).
  - **`test/profile-values-source.test.js`** en keel-dotnet, el de keel-spring y keel-nest (1c): ningún emisor define su
    gradiente ni escribe a mano una variable de `runtime-env`. La fuente estaba limpia; nada se lo exigía. Falsado
    plantando una copia y una llamada.
  - **La frontera sin incrementos cerrados**: el rechazo del value object compuesto en el cuerpo o la respuesta de una
    llamada saliente decía «llega en el incremento 13»; ahora nombra el 16, donde lo generó keel-nest. Y la idempotencia sin
    persistencia ya no se anuncia como pendiente del 10: no tiene mecanismo posible, y el aviso lo dice como keel-nest.
  - **El README del paquete**, que seguía en el incremento 4, con el flujo normalizado de dos pasos, la frontera de hoy,
    todos los sabotajes de `cs-check` y las redes en vivo.
  - **Para el 14** (no se hace aquí): la descripción de cada variable de producción en el README generado. Solo keel-spring
    la tiene (`productionParameters` de su `readme.js`, con las descripciones a mano); keel-nest tampoco. Es parte del
    `deploy/` del 14, y candidata a salir al catálogo neutral `runtime-env` con su descripción.
  - **Sigue abierto**: la red sin SDK `cs-syntax` (4c), sin decidir. Hoy la sintaxis de C# solo la juzga `cs-check`.
  - **Las tres celdas sin ejecutar, cerradas (2026-10-18).** Sondas nuevas y sus sabotajes, cada uno medido rojo en sus
    sondas y solo en ellas:
    - **`transient-write-conflict/relational`**, en `db-check` y en los 12 sujetos: dos ámbitos con su
      `PersistenceTransactions` bloquean dos filas en orden inverso; el motor aborta a uno (40P01) y la transacción lo
      repite ENTERA hasta que las dos terminan (tres intentos); y un 40P01 que agota sus intentos sale como el 409 de
      concurrencia. Sabotajes `deadlock` (el clasificador sin el 40P01) y `retry` (el bucle sin repetir): caen esas dos.
    - **`folded-text/relational`**, en `db-check` sobre `catalog-extended`: `Category.slug` en mayúsculas es la misma
      clave (el error del diseño) y la sombra del filtro de `Product.name` guarda el valor de `TextFold` sin unicidad.
      Sabotajes `fold` (cae solo la de la clave) y `fold-accents` (solo la del filtro).
    - **`folded-text/document`**, en `doc-check` sobre la derivada `job-dispatch-mongo-compare`: el documento guarda el
      valor plegado y la clave en mayúsculas y sin tildes choca con el error del diseño. Sabotaje `fold-accents`.
    - **Medido**: `db-check` entero, 12 sujetos y **234 sondas** (eran 208); `doc-check` entero, 5 sujetos y **134 sondas** (eran 133). La matriz
      queda en **28 verificadas, 0 sin ejecutar**, y `test/engine-support.test.js` lo sostiene: una celda razonada nueva
      lo pone rojo. Siguen **sin falsar** `harness-db-probes/relational`, `harness-sql-literals/postgresql` y el predicado de
      `partial-unique-index/postgresql`.
- **Inc. 14 — en curso (abierto el 2026-10-18).** Tramos como los de keel-nest (su § Inc. 14), con el 14a ya hecho en
  keel-core (`gen/telemetry-vocabulary.js`) y lo neutral del 14d también (`gen/observability-assets.js` con la fila de
  runtime por plataforma, `gen/deploy.js`, `gen/deploy-probes.js`).
  - **Evaluación al abrirlo.** keel-dotnet rechaza `telemetry: otel` en `supported-features.js` y le falta lo que los
    otros dos generan **con y sin** telemetría: la consola era la de serie de .NET (texto, sin `correlationId` por
    línea, sin JSON ECS fuera de `local`, niveles fijos en Information), no hay puerto de gestión y no hay `deploy/`.
  - **Tramos**: 14b los logs con y sin telemetría; 14c la telemetría en C# (spans con `ActivitySource` abiertos por el
    código generado, exportación OTLP de trazas y logs con el SDK de OpenTelemetry, métricas por scrape con los nombres
    del vocabulario y exemplars `trace_id`/`span_id`, el scrape en `MANAGEMENT_PORT` en production) y se quita de la
    frontera; 14d la fila de runtime de .NET en el panel y las alertas, y el `deploy/` de keel-dotnet (imagen multietapa
    con el SDK y el runtime de ASP.NET, usuario no root, `HEALTHCHECK` sobre `/readyz`); 14e los gates
    (`check-logging.sh`, `check-telemetry.sh`) con patrones de C#; 14f `telemetry-check` y `deploy-check`.
  - **Para el 14c, la librería de métricas** (§5, riesgo «nombres de métricas»): el exportador Prometheus de OTel .NET
    sigue en prerelease. La candidata es **prometheus-net** (MIT): escribe OpenMetrics con exemplars sacados de la traza
    en curso (`Exemplar.FromTraceContext()`, `trace_id`/`span_id`, las etiquetas que enlaza el Grafana de `deploy/`), con
    los nombres que pongamos (los de `promMetric`, como keel-nest con su cliente) y con un middleware que solo atiende un
    puerto (`UseMetricServer(port, …)`). Licencia y versión exactas se leen de nuget.org al entrar en `dotnet-stack.js`.
  - **14b — los logs, con y sin telemetría.** El `logging.yaml` de keel-nest sale a keel-core
    (`gen/logging-config.js`, con `ECS_VERSION`): lo comparten keel-nest y keel-dotnet salvo la cabecera, y la línea base
    de keel-nest sale **idéntica** (41 / 10 050). keel-dotnet emite en `Infrastructure/Logging`:
    - `LoggingSettings` (formato, los dos niveles con los nombres de logback, los `service.*`; un nivel que no existe no
      deja arrancar);
    - `KeelConsoleFormatter`, un `ConsoleFormatter` propio: texto en `local` y `test`
      (`<instante> <NIVEL> <pid> --- [correlationId] [categoría] mensaje`, la pila debajo) y JSON ECS anidado en
      `develop` y `production` (`@timestamp`, `log.level/logger`, `process.pid/thread.name`, `service.name/version/
      environment/node.name`, `message`, `correlationId`, `error.type/message/stack_trace`, `ecs.version`). El
      `correlationId` lo lee de `CorrelationContext` al escribir, no de un ámbito de log. No es el JSON de serie de .NET,
      que escribe otra forma (`Timestamp`, `EventId`, `State`);
    - `AddServiceLogging`: quita los proveedores de serie, `LOG_LEVEL_ROOT` es el mínimo de toda categoría y
      `LOG_LEVEL_APP` el de las que empiezan por el namespace raíz del servicio (la regla por prefijo de categoría de
      Microsoft.Extensions.Logging, la misma forma que el `logging.level.<paquete>` de logback). `Program.cs` la instala
      antes de crear la aplicación. El filtro de las sentencias de EF Core sigue igual: es más específico.
    - Una sola pila por fallo ya se cumplía: el mediator solo nombra el tipo, la pila la escribe el middleware de la API.
    - **Medido**: `test/logging.test.js` (el YAML contra el de keel-nest y los niveles contra keel-spring, las claves que
      lee `LoggingSettings`, el cableado, toda fixture con y sin correlación) y la prueba emitida `ServiceLoggingTests`,
      que copia la configuración EMITIDA de cada perfil, la lee con el cargador del servicio y escribe con el
      formateador: la línea ECS, la réplica por las tres vías, la pila una vez, el texto de local, `LOG_FORMAT`, los
      niveles a través de un proveedor real y el nivel desconocido. Sabotajes de `cs-check`: `log-correlation`,
      `log-levels` y `log-node`, cada uno rojo en sus pruebas de `ServiceLoggingTests` y solo en ellas. `cs-check`
      **17/17** (2 964 pruebas), con un paso nuevo, el de keel-nest: la consola del servidor ARRANCADO en develop es
      JSON ECS línea a línea (23 líneas, también las del arranque de ASP.NET Core).
    - **Lo que destapó, ajeno a los logs**: en dos pasadas cayó un `HealthTests` de una fixture SIN sabotear con
      `ObjectDisposedException` del `CancellationTokenSource` en `RabbitConnection.StopAsync` (y en la de
      `SnsSqsConnection`). Con `WebApplicationFactory`, el `Program` que termina dispone los servicios mientras la fábrica
      aún está parando el host, y el apagado llegaba a recursos ya dispuestos. En producción `Run()` para y después
      dispone, en orden; en las pruebas salía una vez cada pocas pasadas. Arreglado en los tres brokers: el apagado se
      hace UNA vez (`stopped ??= Stop()`), lo pida primero el host o el contenedor, y `Dispose` lo espera antes de soltar
      nada. `cs-check` 17/17 después; `broker-check` con RabbitMQ entero en verde y falsado. Kafka y SNS/SQS **sin
      medir** en vivo tras el arreglo: esa pasada se quedó sin memoria en la máquina (podman no arrancaba, `0xC0000142`),
      aunque `cs-check` compila y prueba sus variantes con el cambio.
  - **14c — la telemetría en keel-dotnet. `telemetry: otel` sale de la frontera.**
    - **Stack** (nuget.org, 2026-10-18): OpenTelemetry 1.19.1 (Apache-2.0; la 1.20.0 tenía tres días), su exportador OTLP
      y `Extensions.Propagators` para las trazas y los logs, y **prometheus-net 8.2.1** (MIT) para el scrape. El
      exportador Prometheus de OpenTelemetry sigue en beta (`1.19.1-beta.1`); prometheus-net no publica desde 2024, pero
      es estable y hace lo que pide el plan: OpenMetrics con exemplars y los nombres que pongamos. Decidido con el usuario.
    - **Lo neutral**: el `telemetry.yaml` de keel-nest sale a keel-core (`gen/telemetry-config.js`), el mismo de
      keel-nest salvo la cabecera; línea base de keel-nest idéntica.
    - **El núcleo** (`src/scaffold/telemetry.js`, en `Infrastructure/Telemetry`): `TelemetrySettings`, los nombres
      del vocabulario (`Observations`, `TelemetryAttributes`), `KeelTelemetry` (un `ActivitySource` propio, `keel`, el
      único que escucha el proveedor; `Observe` con el desenlace y el exemplar; `Publishing`, `Consuming`,
      `StartClient`/`FinishClient`, `StartServer`/`FinishServer`, `CacheGet`, `RegisterGauge`), el propagador (W3C de
      salida; de entrada W3C y las dos formas de B3, que en OpenTelemetry .NET son dos propagadores), el middleware HTTP
      (el primero del pipeline; las sondas cuentan sin abrir traza) y el scrape en `/actuator/prometheus`, en production
      solo en `MANAGEMENT_PORT` (`RequireHost` sobre el segundo puerto de Kestrel).
    - **Los puntos de paso**: el mediator (`keel.use-case`, un rechazo del dominio es `rejected` sin marcar el span), la
      envoltura (`metadata.traceparent` del span en curso), el relay (PRODUCER dentro de la traza de la fila, y el
      gauge `keel.outbox.dead_lettered`), `InboundContext.Run` (CONSUMER que continúa la del emisor), `HttpExchange`
      (CLIENT, `traceparent` y `http_client_requests_seconds` con la plantilla), la caché (`cache_gets_total`),
      storage y correo como decoradores del PUERTO (`ObservedFileStorage`, `ObservedMailSender`, con
      `TELEMETRY_INSTRUMENT_*`) y el formateador de logs (`trace.id`/`span.id`). Convención `observability.md`, instalada
      solo con telemetría.
    - **Tres decisiones propias de .NET**:
      - **Sin la instrumentación de ASP.NET Core.** El host crea un `Activity` por petición mientras haya logs, aunque
        nadie lo exporte; un span nuestro que colgara de él quedaría con un padre que el backend no tiene. Los nuestros
        toman el padre explícito (el de quien llama, el de la fila, el de la envoltura) o ninguno; el contexto vacío pide
        una traza nueva (con `StartActivity(..., default)` .NET vuelve a colgar del span en curso).
      - **El transporte no propaga** (`SocketsHttpHandler.ActivityHeadersPropagator = null`, con o sin telemetría): el
        `traceparent` lo escribe el span CLIENT, y sin telemetría no viaja el del span interno de ASP.NET Core.
      - **La métrica no puede lanzar.** prometheus-net rechaza un punto con otras etiquetas que las de su serie, y lanzaría
        en el `finally` del caso de uso, rompiendo la operación de negocio. Cada histograma fija sus etiquetas al nacer y
        los valores se alinean con ellas. Lo destapó la prueba emitida: dependía del orden de las pruebas.
    - **Medido**: `test/telemetry.test.js` (el YAML contra keel-nest, las claves que lee `TelemetrySettings`, el
      vocabulario, el cableado de cada punto de paso, la convención y lo que cita, el proveedor que solo escucha `keel`, y
      que sin telemetría no se emite nada ni un paquete) y la prueba emitida `TelemetryTests` sobre el servidor en
      memoria: la entrada HTTP continúa la traza y su exemplar es el de esa petición, las sondas no abren traza, los tres
      desenlaces con sus series, la raíz frente al span de ASP.NET Core, la llamada saliente, W3C y B3, el log con sus
      ids, el gauge, la envoltura y el consumo, y la configuración de production. `cs-check` **17/17**: 174 ensamblados
      con seis variantes con telemetría (las siluetas de keel-nest) y **3 962 pruebas**; licencias de 112 paquetes
      resueltos, transitivos incluidos. Sabotajes de las fixtures, cada uno rojo en su prueba de `TelemetryTests` y solo
      en ella: `telemetry-exemplar`, `-parent` (cae también la de la envoltura), `-host`, `-rejection`, `-b3` y
      `-log-trace`. **`telemetry-rejection` salió verde la primera vez**: con el rechazo y el fallo intercambiados seguía
      habiendo un `ok`, un `rejected` y un `error`, y la prueba solo contaba eso. Ahora ata cada desenlace al span de la
      excepción que lo produjo. keel-core 1216, keel-nest 800 y keel-dotnet 608 sin red.
    - **Matriz**: `telemetry-store-spans` pasa a `degradado` en las dos ramas, con su salida escrita. Npgsql ya publica su
      `ActivitySource`, pero escucharlo sin el filtro anti-ruido de keel-spring haría de cada pasada del relay una traza
      raíz por segundo. Queda pendiente `runtime-panel` (14d).
    - **Queda**: la fila de runtime de .NET (heap, GC, pool de Npgsql) para el panel (14d), los gates (14e) y las redes en
      vivo (14f, la primera vez que un colector de verdad lee este scrape).
  - **14d — el panel, las alertas y `deploy/`.**
    - **La fila de runtime de .NET** (`DOTNET_RUNTIME` en `src/scaffold/telemetry.js`), publicada por la telemetría
      generada con nombres propios, como keel-nest, porque nada de la plataforma sale por este scrape:
      - el heap gestionado (`GCMemoryInfo.HeapSizeBytes`) contra su límite (`TotalAvailableMemoryBytes`, el que respeta el
        límite del contenedor; el tamaño del heap crece a demanda y la alerta del 90 % dispararía en un servicio sano);
      - las pausas de GC como contador (`GC.GetTotalPauseDuration`);
      - un panel propio de .NET: la cola del thread pool (`ThreadPool.PendingWorkItemCount`), el síntoma de un código que
        bloquea hilos;
      - el pool de Npgsql, que no tiene otra API que su `Meter`: un `MeterListener` lee `db.client.connection.count` por
        estado, `.max` y `.pending_requests` y los vuelca en `keel_db_pool_*` (los nombres de keel-nest). Un instrumento
        observable da su valor y uno que no lo es da incrementos. **Sin medir contra Npgsql de verdad**: los nombres son
        los de su documentación de la 10; lo mide `telemetry-check` (14f), y hasta entonces la celda `runtime-panel`
        sigue pendiente con ese motivo.
      - Declarado como en keel-nest: sin pool en el modelo documental y sin retraso del consumidor.
    - **Panel y alertas** (`src/scaffold/observability-assets.js`): los neutrales de keel-core con esa plataforma.
    - **`deploy/`** (`src/scaffold/deploy.js`): el neutral de keel-core. La imagen va en dos etapas: publicación del Api con
      el SDK de .NET y runtime de ASP.NET con su usuario sin privilegios (`$APP_UID`). La imagen no trae ni curl ni wget,
      así que el `HEALTHCHECK` pide `/readyz` con el `/dev/tcp` de bash, y `dotnet` es el PID 1. El `DB_URL`, el
      `OAUTH2_JWK_SET_URI` y las sondas son los de keel-nest. En la raíz, `.dockerignore` y `.gitattributes`. El README
      enseña `deploy/`.
    - **Medido sin red**: `test/deploy.test.js` (toda variable que develop exige llega a la app y toda la que llega la lee
      el servidor; infraestructura, colector y realm idénticos a keel-spring; la imagen; el JWKS interno; el README) y
      `test/observability-assets.test.js` (panel y alertas contra keel-spring salvo el runtime y lo declarado). La pregunta
      que importa —¿publica el servidor TODA serie que consultan?— va en C#: build saca la lista del panel y las alertas
      de ESE diseño (`consultedSeries`) y la prueba emitida `TelemetryTests` ejercita cada observación y busca cada serie
      en el scrape, igual que la prueba de las series del runtime.
    - **Medido**: `cs-check --fixtures` en verde, 174 ensamblados y **3 974 pruebas**. Sabotaje `telemetry-series` (una
      serie del runtime con otro nombre): caen exactamente las dos pruebas que la miran. Sin red: keel-core 1216, keel-nest
      800 y keel-dotnet 631. **La imagen, construida y arrancada a mano con podman** (`--format docker`, como `up.sh`):
      construye, corre como `app` (UID 1654) con `dotnet` como PID 1, el `HEALTHCHECK` por `/dev/tcp` la pone en
      `healthy` y `/readyz` responde 200 por el puerto publicado. Con `localhost` el host no conecta: Windows resuelve
      primero `::1` y el reenvío IPv6 de podman no responde. Es de la máquina, no de la imagen, y lo mide `deploy-check`
      (14f).
    - **Dos trampas de la herramienta, otra vez**: el heredoc de la terminal convirtió en salto real un `'\n'` de una
      plantilla C# (no compilaba en ninguna variante), y el analizador `xUnit2029` rechaza `Assert.Empty` sobre un
      `Where`. Las dos las vio `cs-check`; la suite sin red no.
  - **14e — los gates de logs y de cardinalidad.**
    - **La forma**: el gate de keel-nest es un programa de Node embebido en el `.sh`, y un proyecto .NET no tiene por qué
      tener Node. Va en **bash y awk POSIX**, como el `check-idempotency.sh` que ya genera keel-dotnet, con un motor
      NEUTRAL nuevo en keel-core (`gen/source-gate.js`): recorre los archivos, quita los comentarios (los de bloque se
      vacían conservando las líneas) y aplica reglas que son DATOS, con su sintaxis de comentarios por plataforma. Un
      solo awk para todos los archivos (uno por archivo tardaba más de diez minutos en la suite, en Windows). Las reglas
      no pueden llevar barras invertidas ni comillas simples: viajan dentro de una cadena de awk entre comillas de bash, y
      el motor lanza si una las lleva.
    - **Lo que destapó la primera ejecución**: con el awk roto (una variable llamada `close`, que es una función de awk),
      el gate daba **OK**. Ahora un awk que no corre deja el gate sin veredicto (sale con 2), y hay una prueba para eso.
    - **`infra/check-logging.sh`** (`src/scaffold/logging-check.js`, siempre que haya casos de uso): el objeto de entrada
      entero en un log, el mensaje construido a mano (`$"…"` o `+`: en .NET las plantillas sí tienen argumentos
      estructurados, como en keel-spring), un `LogError` desde Domain o Application, la consola a pelo y las formas que
      lanzan trabajo SIN el contexto de la petición. En .NET esas son `UnsafeQueueUserWorkItem`, `UnsafeRegister`,
      `UnsafeStart` y `ExecutionContext.SuppressFlow`: el `ExecutionContext` lleva el `AsyncLocal` a `Task.Run`, a los
      temporizadores y a un `Thread` nuevo.
    - **`infra/check-telemetry.sh`** (`src/scaffold/telemetry-gate.js`, con telemetría): las claves de `Labels` de una
      observación, los `LabelNames` y los `CreateCounter(…, "etiqueta")` de prometheus-net y los tags de
      `System.Diagnostics.Metrics`, contra el vocabulario (sin la correlación) y las claves de las series HTTP y de caché.
      Por línea: un inicializador repartido en varias no lo ve, igual que el de keel-spring no ve una constante.
    - Los agentes de código y de calidad los ejecutan y los reportan (`logging`, `cardinality`); la skill orquestadora y
      la convención de observabilidad los nombran.
    - **Medido**: `keel-core/test/source-gate.test.js` (el motor con una plataforma inventada: reglas, rutas, comentarios,
      claves con y sin los literales que se saltan, directorios excluidos, awk roto) y
      `keel-dotnet/test/logging-telemetry-gates.test.js`, que EJECUTA los dos gates con bash: verdes en las quince
      fixtures recién generadas, cada regla roja con su forma prohibida y verde con la correcta, el ERROR fuera de Domain
      y Application no cuenta, la correlación nunca es etiqueta. Falsado quitando el filtro de comentarios: cae justo la
      prueba de los comentarios, la única que puede verlo, porque las notas de build no contienen formas prohibidas.
  - **14f — `telemetry-check` y `deploy-check`. Con esto el incremento 14 queda cerrado.**
    - **`npm run telemetry-check`** (`scripts/telemetry-check.js`), el gemelo del de keel-nest: la app ARRANCADA contra un
      PostgreSQL real y un colector OTLP falso. El exportador de .NET manda protobuf y no JSON, así que el receptor lo lee
      con un lector mínimo (`scripts/lib/otlp-traces.js`, probado sin red contra un mensaje codificado a mano). Un solo
      motor (PostgreSQL, el de la frontera). Antes de arrancar, el baseline de `dotnet ef`. `job-dispatch` en develop
      (TEL-1 a TEL-9), en production (TEL-10) y `profile-directory` con OIDC (TEL-11). **11/11 a la primera.** Falsado
      tres veces, cada sabotaje en su caso: `pool-name` (TEL-7), `management` (TEL-10) y `server-parent` (TEL-3, TEL-8 y
      TEL-9: el log tampoco lleva ya la traza de quien llamó).
    - **Lo que destapó, y no lo veía ningún caso**: el pool salió con su tamaño, pero TEL-7 exige `pendiente == 0`, que
      también sale si el instrumento no existe. Medido con un `MeterListener` sobre Npgsql 10.0.3, la cola de espera es
      `db.client.connection.npgsql.pending_requests` (propia de Npgsql, con el prefijo), no
      `db.client.connection.pending_requests`: **la serie de saturación salía siempre a 0 y su alerta no habría
      disparado nunca**. Arreglado, y medido donde sí se ve: la prueba emitida publica los cuatro instrumentos con un
      `Meter` llamado `Npgsql` y exige cada valor en su serie (sabotaje `telemetry-pool` de `cs-check`: cae esa prueba y
      solo ella). `cs-check --fixtures` 174/174 y 3 978 pruebas tras el arreglo.
    - **`npm run deploy-check`** (`scripts/deploy-check.js`): `deploy/` entero con su `up.sh` y las preguntas al backend,
      NEUTRALES desde keel-nest (`keel-core/gen/deploy-probes.js`, DEP-2 a DEP-8); keel-dotnet pone su DEP-1 (la serie de
      runtime de .NET en el scrape). Antes de construir la imagen, el baseline de `dotnet ef`, como el `npm install` de
      keel-nest. **8/8**: la serie del caso de uso en el backend, el exemplar y su traza en Tempo, los logs en Loki, el
      panel, las alertas y una alerta que llega al contacto. Es la puerta del incremento: el MISMO panel, las MISMAS
      alertas y el MISMO contacto tienen datos con los tres servidores.
    - **Matriz**: `runtime-panel` pasa a `verificado` en relacional (telemetry-check, falsado) y a `degradado` en
      documental (MongoDB.Driver no publica su pool sin suscribirse a sus eventos, como en keel-nest). **Ya no queda
      ninguna fila pendiente**: 34 celdas, 29 verificadas, 3 degradadas con su motivo y 2 que no aplican.
    - **Queda declarado para después**, como en keel-nest: los spans de los drivers (`telemetry-store-spans`), el push
      OTLP de métricas, el pool documental y el retraso del consumidor. Sin medir aquí: el `broker-check` de Kafka y
      SNS/SQS tras el arreglo del apagado (pendiente desde el 14b).
- **Inc. 14 — cerrado (2026-10-18).** Siguiente: el 15 (evolución del proyecto generado).
- **Inc. 15 — cerrado (2026-10-18).** La lógica ya era neutral desde el 15 de keel-nest (`keel-core/gen/evolution.js`):
  keel-dotnet solo pone sus cinco textos de plataforma (`DOTNET_EVOLUTION` en `src/scaffold/evolution.js`) y cablea
  `build` como keel-nest: delta del diseño antes de refrescar el snapshot, cambios de stack, `planEvolution`,
  `reportEvolution`, la base congelada con `persistEvolution` y `--check` en rojo con una evolución o una fusión sin
  cerrar. El modo evolución entra en la skill (`generator-docs.js`), en `keel-dotnet-code`, en `keel-dotnet-tests` y
  en `orchestration.md`. La versión nueva de un conflicto va a `build/keel-refresh/` también por .NET: un proyecto SDK
  compila todo `.cs` bajo su carpeta.
  - **Puerta**: `test/design-evolution.test.js` (7, la misma fixture y la misma evolución que en los otros dos) con
    **paridad del delta contra keel-spring Y keel-nest**: mismo `delta`, mismas versiones, mismo stack y mismas
    secciones de `EVOLUTION.md`; y `test/generated-propagation.test.js` (9) portado. Falsado quitando
    `persistEvolution`: caen 4 de los 7 (el circuito, la segunda pasada, el cambio de stack y la paridad).
  - De paso: la frontera del README todavía decía que la telemetría se rechazaba; ya no.
  - Siguiente: el 16 (cierre: frontera sin rechazos sin motivo, matriz sin pendientes, `capability-coverage` y la
    corrida de control del par MVP en los tres generadores).
- **Inc. 16 — hecho (2026-10-19), con corrida de control en los tres generadores.**
  - **16a, la cobertura de capacidades (hecho).** Las quince fixtures entran enteras en la frontera. Quedan sin fixture las
    mismas diez capacidades opcionales que en keel-nest; `test/capability-coverage.test.js` (el enumerador compartido de
    keel-core) exige su motivo, comprobado contra los emisores de keel-dotnet y no copiado. Las ramas sin fixture son
    parches en memoria sobre una fixture real (`UNCOVERED_BRANCHES` de `test/helpers/workspace.js`) con DOS redes: la
    rama en lo emitido (`test/uncovered-branches.test.js`, que exige también que cada parche sea un diseño válido) y su
    variante en `cs-check`, que la compila y ejecuta sus pruebas emitidas. Una mejora sobre keel-nest: la captura PARCIAL
    (`payments.capture.amount`), allí un `hueco`, aquí la genera `payment-checkout-partial-capture` sobre Stripe
    (`amount_to_capture`), con la capacidad `partial-capture` y comprobado que la pasarela la cubre.
  - **16c, el compuesto en el cuerpo y en la respuesta de una llamada saliente (hecho).** La frontera ya no lo rechaza; el
    compuesto en la URL o en una cabecera sigue rechazado con el mensaje neutral de los tres. El cuerpo ya salía bien (el
    value object se escribe por sus propiedades con el contrato del cable). La respuesta se leía con un `Deserialize<T>`
    genérico, que a un objeto al que le falta un obligatorio le pasa un `0` al constructor; ahora se lee con el MISMO
    `ValueReaders.Read<Tipo>` de la entrada (`ResponseReading.Composite`, `RequiredComposite`, `CompositeList`), como
    keel-nest, y lo que rechaza es un `OutboundContractException`. `ValueReaders` se emite también sin API ni
    suscripciones si una respuesta lo necesita. La prueba emitida `OutboundClientsTests` lo EJECUTA en toda llamada con
    un compuesto, con resiliencia o sin ella: llega como su value object, igual al construido con los mismos valores, y
    lo que no es un objeto, el objeto vacío y el que pierde un solo obligatorio violan el contrato; y el compuesto del
    cuerpo viaja como objeto con los nombres del diseño. Silueta `stock-reservation-compuesto-saliente` (el parche de
    keel-nest). `cs-check --fixtures`: 15 fixtures y 19 variantes, 204/204 ensamblados y 4 991 pruebas. Falsado con
    `--sabotage=outbound-composite` (la respuesta leída con `Deserialize`): cae justo el caso del obligatorio que falta.
  - **16b, la mensajería sin persistencia: se rechaza en los TRES, y destapa un defecto de los otros dos.** keel-nest la «cerró» en
    su 16 porque «el emisor ya la sabía hacer», pero lo que emite no publica: los eventos los levanta el agregado y los
    drena el adaptador de repositorio, y sin persistencia keel-nest no emite ni puente ni publisher (el handler dice «no
    publica nada») ni registra la conexión del broker en `app.module.ts`; keel-spring emite un puente que espera un
    `@TransactionalEventListener(AFTER_COMMIT)` que nadie dispara. Los dos generan, sin decirlo, un servicio que no
    publica ni consume. Decidido (2026-10-18): rechazarla en los tres con el mismo motivo, neutral en
    `keel-core/gen/messaging-frontier.js` (`messagingWithoutPersistenceErrors`), como `outbound-params.js`. keel-nest retira sus
    dos siluetas «sin persistencia» de `DERIVED_SILHOUETTES`. Ninguna fixture la declara, así que lo emitido no cambia. Lo
    fija `test/messaging-frontier.test.js`: el de keel-core prueba la función, y el de keel-dotnet, que los tres rechazan
    con el mismo mensaje. Suites: keel-core 1224, keel-spring 1664, keel-nest 792 y keel-dotnet 683.
  - **16d, la corrida de control (hecha).** El par del MVP con los TRES generadores desde `5a8143e`: el mismo diseño
    (v2.0.2), el mismo stack (`postgresql|mongodb · rabbitmq · keycloak`) y seis corridas. Las fichas son
    `docs/corridas/2026-10-18-notification-mailer[-mongo]-{spring,nest,dotnet}-control.md`; la comparación de las seis
    está en la de keel-dotnet relacional.
    - **Las seis salen 23/23 y con huella 17**: la misma lista de archivos en los seis, y la de la serie del par
      (las cuatro del 2026-10-12 y la documental de keel-dotnet del 2026-10-15). La única excepción es keel-dotnet
      documental, con 18: el reescrito de más es el `.csproj` de los flujos, por la ruta larga de Windows (`MSB3030`).
      Es de entorno.
    - **Dos huecos del generador, arreglados.**
      - La nota de `resolvedBy` del mensaje del broker salía con `undefined` en keel-dotnet: `messaging.js` leía como
        objeto el `Entidad.campo` del diseño. Ahora usa `resolvedByOf` de `repositories.js`. Lo fija
        `test/caller-resolution.test.js`, falsado con el emisor anterior.
      - Los agentes de pruebas de keel-nest y keel-dotnet no tenían la regla de keel-spring: «un fixture de
        infraestructura documentado no es un `uncovered`». Con esa falta, dos de los cuatro dejaron sin cubrir el 403
        por audiencia ajena, con `test-m2m-bad-aud` ya sembrado. La regla está ahora en los dos.
    - **Dos huecos del diseño, para la próxima minor del par.** Solo los ve la comparación: cada agente decidió sin
      saber que decidía.
      - `required-value-blank`: tres contratos distintos para una variable requerida en blanco.
      - `rendered-subject-bound`: repetido del 2026-10-12, así que es candidato obligatorio a id.
      - Cerrados los dos en el par v2.0.3 (2026-10-19), decisión del usuario. El valor en blanco se rechaza con un
        `pattern` en `TemplateVariableValue.value`, que da un 400. El asunto de más de 200 se trunca, por regla. Es un
        parche: no toca ningún escenario, así que el careo y la revisión siguen valiendo.
      - Después, la minor v2.1.0 (2026-10-19). Añade el caso borde del truncado y del blanco en `FL-NTF-001`, y
        reescribe el Then 3 de `FL-DSP-001`: el relay vuelve a aceptar con `relayAccepts()` antes del segundo ciclo.
        - Lo sellado por versión se reafirmó a mano contra el delta, por decisión del usuario: decisiones,
          estructural, revisión y huecos, estos últimos con los dos hallazgos ya decididos.
        - El careo se rehízo con agente en tres pasadas completas.
          - La 1 dio siete hallazgos: tres resueltos en el escenario (el uuid sin versión, `templateId` en las
            variables, la aplicación antes que la clave) y cuatro en el diseño (la clave gana a las credenciales,
            compilar antes que la duplicada, la duplicada antes que la requerida, la repetición devuelve la
            aceptación).
          - La 2 dio uno, la convención de `sendingSince`.
          - La 3 salió limpia.
        - Tres de las reglas nuevas solo escriben lo que los seis servidores ya hacían.
    - De paso, el pendiente del inc. 0: `wire-contract.md` nombra ya a los tres generadores. Se regeneraron las dos
      líneas base (solo cambian ese documento y el agente de pruebas de keel-nest).
  - **16e, las tres celdas sin falsar (hecho, 2026-10-19).** La matriz queda sin celdas sin falsar.
    - Dos de las tres no se podían falsar: `db-check` reconstruía con keel-core las sentencias del rescate en vez de
      ejecutar las del arnés, y comparaba el predicado del índice parcial con el mapeo emitido.
    - Ahora la sonda del rescate ejecuta el `Rescues` y el `IdLiteral` del `FlowTest.cs` emitido, el sabotaje se aplica
      en memoria antes de generar las sondas (así llega al arnés) y el predicado se compara con `partialIndexSpecs` de
      keel-core.
    - Cinco sabotajes nuevos, cada uno rojo solo en su sonda:
      - `partial-literal`: el predicado y la unicidad condicionada de notification-mailer;
      - `harness-stall`, `harness-missing-clock`, `stale-literal` y `uuid-literal`: la sonda del rescate de
        job-dispatch y job-dispatch-cycles.
    - `db-check` limpio, 28/28.
  - **16f, el cierre de la documentación (hecho, 2026-10-19)**, lo que el §7 asigna al 16:
    - el `README.md` raíz y el de keel-dotnet ya no lo dan por «en construcción»;
    - el detalle de `CLAUDE.md` se mueve a `.claude/rules/dotnet-generador.md` (clave `dotnet`), como el de keel-nest.
  - **16g, `broker-check` tras el apagado del 14b (hecho, 2026-10-19).** 67/67 contra RabbitMQ, Kafka y LocalStack
    reales, con sus dos sabotajes por broker cayendo en su flujo y solo en él. Con esto se mide lo que el 14 dejó «sin
    medir aquí»: Kafka y SNS/SQS después del arreglo del apagado.

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
