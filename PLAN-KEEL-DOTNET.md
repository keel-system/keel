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
