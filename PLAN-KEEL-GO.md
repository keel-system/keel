# Plan de construcción de `keel-go`

## Context

Keel tiene tres generadores: `keel-spring`, `keel-nest` y `keel-dotnet`. Los tres cumplen la misma regla: **el mismo diseño genera servidores equivalentes**. keel-dotnet salió en ~2 semanas (74 commits, 16 incrementos) porque toda la interpretación del diseño ya vivía en `keel-core/gen` (88 módulos, 18,8k líneas): modelo, cable, acceso, `infra/`, lectura JUnit, OpenAPI, errores, evolución, matriz y sondas. El cuarto, `keel-go`, sigue el mismo camino. Lo propio del paquete es la **proyección Go** (`go-projection.js`), su tabla de stack (`go-stack.js`) y los renderizadores de `src/scaffold/`.

Tres condiciones de partida:
- **El usuario no es experto en Go.** El plan lleva una guía de entorno (§7), igual que el de dotnet.
- **Rige la misma restricción de licencias que en dotnet:** solo paquetes permisivos, comprobados en código (§1.6).
- **El código emitido tiene que leerse como Go idiomático**, no como Java traducido. Equivalente por fuera, Go por dentro: las prácticas del §3 son normativas y tienen puerta, igual que la paridad.

El primer paso de la implementación es copiar este plan al repo como `PLAN-KEEL-GO.md` y llevar ahí el estado de cada incremento.

Flujo normativo, idéntico a los otros:

```bash
keel-go check specs/<servicio>
keel-go build specs/<servicio>
cd services/<servicio>-go
/keel-generate-go
```

## 0. Regla de equivalencia

Se usa la misma tabla del §0 de `completed_plans/PLAN-KEEL-NEST.md`: contrato HTTP, cable, mensajería, fiabilidad, persistencia, operación y telemetría. El oráculo es siempre el **texto emitido** por keel-spring, y por keel-nest y keel-dotnet donde ya haya un `*-parity.test.js`. Nunca un recuerdo.

La equivalencia es de **comportamiento observable**, no de forma interna. Que keel-spring tenga subpaquetes `commands/`, `dtos/` o `mappers/` no obliga a Go a tenerlos: donde la forma de Spring choca con el idioma de Go (§3), gana Go y la paridad se mide en el cable, el esquema, los códigos de error y las series.

## 1. Principios

1. **La frontera avanza en código.** `src/lib/supported-features.js` nace rechazando todas las capas salvo `domain`, `use-cases` y `api`. Cada entrada nombra el incremento que la trae, y cada incremento borra entradas.
2. **Nada neutral se copia.** Si falta una decisión en `keel-core/gen`, primero se extrae ahí sin que cambie un byte de los otros tres. Puertas: `npm run golden -- --check` de keel-spring y de keel-nest, y las paridades de keel-nest y keel-dotnet.
3. **Cada incremento cierra con una puerta medible**: rasgos del texto, sintaxis Go, idioma Go (§3), compilación real, el check en vivo cuando aplica y una corrida en los hitos.
4. **Fixtures compartidas** (`fixtures/designs/`). La vara final es el par del MVP (`notification-mailer` / `-mongo`).
5. **Matriz de paridad propia** (`src/lib/engine-support.js`) sobre el catálogo neutral `keel-core/gen/mechanisms.js`.
6. **Licencias permisivas, en código.** `src/lib/go-stack.js` declara cada módulo —de ejecución **y de herramienta** (`tool` de `go.mod`)— con versión exacta y SPDX. `test/licenses.test.js` exige la lista blanca (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0 solo si es inevitable y queda escrito) y prohíbe GPL/AGPL/BUSL/SSPL por nombre. El proyecto generado lleva `infra/check-licenses.sh` (`go tool go-licenses` sobre los transitivos) y `govulncheck`, el equivalente del NuGet Audit. Consecuencia directa: **golangci-lint (GPL-3.0) queda fuera** del `go.mod` emitido; el lint es `go vet` + `staticcheck` (MIT) (§3.8).
7. **Versiones verificadas al abrir cada incremento** con `ctx7`/`find-docs`, nunca de memoria. La base prevista es la línea estable de Go 1.27, que se confirma en el inc. 2 y queda fijada con la directiva `toolchain` de `go.mod`. Política: el `go` de `go.mod` declara la versión mínima que el código usa de verdad, y el `toolchain` la estable con la que se mide; se soportan las dos últimas versiones mayores, como el propio proyecto Go.
8. **Sin cgo en el binario.** Todo el stack es Go puro y se compila con `CGO_ENABLED=0`: binario estático, nada de gcc en Windows e imagen `distroless/static:nonroot`. La única excepción es `go test -race`, que exige cgo: se ejecuta dentro de un contenedor `golang:<v>` en `go-check` (§4, redes), nunca en el binario.
9. **Referencias normativas de estilo**, citadas por `constitution.md` del proyecto generado y por las skills: *Effective Go*, *Go Code Review Comments*, la *Google Go Style Guide* (decisiones y buenas prácticas) y *Go Proverbs*. Si una regla del §3 contradice una de ellas, se corrige el plan.

## 2. Arquitectura del proyecto generado (`services/<servicio>-go/`)

Hexagonal + CQRS, el mismo reparto de responsabilidades que `architecture.md` de keel-spring, **con la granularidad de paquetes de Go**: un paquete es una unidad de compilación y de API, no una carpeta de clasificación. Lo que en Spring son subpaquetes (`commands/`, `queries/`, `dtos/`, `mappers/`) en Go son **archivos** del mismo paquete. Un solo módulo:

```
go.mod / go.sum                # módulo <servicio>; go mínimo + toolchain; directiva tool (gotestsum, goose, go-licenses, govulncheck, staticcheck)
cmd/server/main.go             # solo run(ctx, args, getenv, stdout) error + os.Exit; cableado manual (DI explícita) en run
internal/
  domain/                      # paquete domain: solo stdlib + uuid/decimal. Un archivo por agregado/value/enum/evento; errores; puertos (interfaces)
  application/                 # paquete application → domain. <caso>.go por caso de uso (comando/consulta, handler, DTO y mapeo juntos); mediator genérico sin reflexión
  infrastructure/              # un paquete por adaptador, nombrado por tecnología: postgres/ mysql/ mongo/ rabbitmq/ kafka/ snssqs/ keycloak/ httpclient/ s3/ smtp/ scheduler/ telemetry/
  httpapi/                     # → application. Router net/http, un solo mapa de rutas, lectores, ErrorResponse, middleware
  platform/                    # wire/ (Decimal, Instant, Optional[T]), config/, health/, logging/, clock/
  architecture_test.go         # la frontera hexagonal, ejecutada (ver abajo)
tests/integration/             # flujos FL-* de caja negra con build tag `integration`, sobre la infra/ real
infra/                         # la NEUTRAL de keel-core/gen/infra-scripts.js con GO_INFRA
deploy/                        # Dockerfile multi-etapa: golang:<v> → gcr.io/distroless/static:nonroot
```

- Cada paquete lleva `doc.go` con su comentario de paquete (`// Package domain …`).
- `domain` y `application` son **un paquete cada uno** a propósito: partirlos por agregado abre ciclos de importación en cuanto dos agregados se refieren (refs, `dispatches`), y Go no los admite. Si un servicio crece tanto que el paquete estorba, se decide con una corrida, no por adelantado.
- Nombres de paquete cortos, en minúscula y singular; prohibidos `util`, `utils`, `common`, `helpers`, `models`, `base` y `types` (§3.1).

**La frontera hexagonal la tiene que comprobar una prueba.** `internal/` solo protege frente a otros módulos, no frente a otras capas del mismo módulo. Por eso se emite `internal/architecture_test.go`, que recorre `go list -deps -json ./...` y falla si una capa importa a otra que no debe (y si `domain` importa algo fuera de la stdlib y su lista blanca). Hace el papel del dependency-cruiser de keel-nest y se falsa plantando un import.

Equivalencias de stack. Todas son permisivas; la versión exacta se fija al abrir el incremento correspondiente.

| Spring / Nest / .NET | Go |
|---|---|
| Gradle wrapper / npm lock / global.json | `go.mod` (`toolchain`) + `go.sum`; herramientas con la directiva `tool` (`go tool gotestsum`): el proyecto no exige nada instalado aparte de Go |
| Spring MVC / Fastify / Minimal APIs | `net/http` con el enrutado por método y patrón (Go 1.22+). Sin framework web y con un solo punto de lectura/escritura JSON |
| Jackson / `wire.ts` / STJ | `encoding/json` con tipos propios en `platform/wire`: `Decimal` con la escala del campo, `Instant` (3 decimales + `Z`), `Optional[T]` tri-estado para el PATCH con null y enums por valor. Se evalúa `encoding/json/v2` en el inc. 3, según su estado en esa versión (si sigue tras `GOEXPERIMENT`, no se usa) |
| Bean Validation / lectores | lectores generados por operación desde `inputRules`, sin librería de validación ni reflexión de tags |
| JPA + Flyway / EF + dotnet ef | **SQL emitido** desde `gen/relational.js` sobre `database/sql` (driver `pgx/v5/stdlib` y `go-sql-driver/mysql`), con migraciones **goose** embebidas (`embed.FS`). Sin ORM: el esquema ya es dato neutral, y la versión optimista y `SKIP LOCKED` ya son SQL crudo. Siempre consultas parametrizadas, nunca SQL concatenado con datos |
| `@Version` | `UPDATE … WHERE id = ? AND version = ?`; 0 filas → conflicto. Lo mide `db-check` |
| UUIDv7 | `google/uuid` `NewV7()`. Big-endian nativo: el `binary(16)` de MySQL sale igual que en keel-spring, sin el problema de Guid de .NET |
| Transacción del caso de uso | `UnitOfWork.Do(ctx, func(ctx context.Context) error)`: el `*sql.Tx` viaja en el `context.Context` con una clave no exportada y los repositorios reciben una interfaz `DBTX`. `defer tx.Rollback()` siempre; commit explícito |
| Excepciones de dominio | valores `error`: tipos con `Code()` y errores centinela; se envuelven con `%w` y el mapeo a HTTP se hace en el borde con `errors.Is`/`errors.As` contra `framework-errors.js` y `constraint-errors.js` |
| Spring Security JWT / JwtBearer | middleware propio + `golang-jwt/jwt/v5` + JWKS con `MicahParks/keyfunc`, y las políticas de `gen/access-plan.js`. La identidad viaja en el `context` con accesores tipados |
| resilience4j / circuito propio | circuito propio comparado con `circuitBreakerReference` (como nest y dotnet); retry y timeout con `context`. `http.Client` propio con `Timeout`, nunca `http.DefaultClient` |
| `@Scheduled` / Cronos | `robfig/cron/v3` con `cron.WithSeconds()` (6 campos) |
| RabbitMQ / Kafka / SNS-SQS | `rabbitmq/amqp091-go`, `twmb/franz-go`, `aws-sdk-go-v2` (sns, sqs); DLT con las cabeceras de Spring Kafka |
| MongoDB | `go.mongodb.org/mongo-driver/v2`, UUID binario subtipo 4 y `Decimal128` |
| Redis / Valkey | `redis/go-redis/v9` (sirve para los dos) |
| S3 | `aws-sdk-go-v2/service/s3` |
| SMTP + plantillas | `wneessen/go-mail` + el motor de plantillas que usen los otros tres (se verifica en el inc. 13), con escapado estricto (`html/template` para HTML, nunca `text/template`) |
| Logback / pino / MEL | `log/slog` con handler JSON y campos ECS; la correlación va por el contexto (`InfoContext`, un handler que lee el `context`) |
| Micrometer + OTel | `otel-go` (trazas y logs por OTLP, `otelhttp` en el router) + `prometheus/client_golang` (scrape con exemplars) con **los nombres de `telemetry-vocabulary.js`**; el pool sale de `sql.DBStats` |
| Actuator | `/livez` y `/readyz` en el puerto principal + un segundo `http.Server` en `MANAGEMENT_PORT` |
| JUnit / Vitest / xUnit | `go test -json` → `gotestsum --junitfile`, leído por `gen/junit-scoring.js`. Comparación con `google/go-cmp` (BSD-3); sin librería de aserciones |
| YAML de perfiles | un lector YAML mantenido (`goccy/go-yaml` o `go.yaml.in/yaml/v3`; `gopkg.in/yaml.v3` está archivado), a decidir en el inc. 2. Las variables de entorno siempre ganan al YAML |
| Ciclo de vida | `signal.NotifyContext` + `golang.org/x/sync/errgroup` (BSD-3) para servidores, relay, consumidores y scheduler |

## 3. Prácticas de Go (normativas)

Lo que sigue es **contrato del código emitido** —el que escribe `build` y el que escribe el agente siguiendo las skills—. Cada regla tiene dónde se comprueba: `go-idioms.test.js` (texto, sin SDK), `go-syntax.test.js` (árbol, sin SDK), `go-check` (herramientas reales) o la skill/agente `keel-go-quality` (lo que solo un lector puede juzgar). `constitution.md` y `conventions/` del proyecto generado las repiten con ejemplos.

### 3.1 Nombres y paquetes
- `MixedCaps`, nunca `snake_case`; **siglas en un solo caso** (`ID`, `URL`, `HTTP`, `JSON`, `UUID`): `customerId` del DSL → `CustomerID` en Go, y el nombre del cable va en el tag `json:"customerId"`. La regla vive en `go-projection.js` con su tabla de siglas y su test.
- Sin tartamudeo: `order.Order` sí, `order.OrderService` no; `domain.Order`, no `domain.DomainOrder`.
- Getters sin `Get` (`o.Status()`), receptores de una o dos letras y consistentes en todo el tipo, interfaces de un método con sufijo `-er` cuando el nombre sale natural.
- Comentario de documentación en todo identificador exportado, empezando por su nombre.

### 3.2 Errores
- Los errores se devuelven y se comprueban todos; ninguno se descarta con `_` sin un comentario que diga por qué.
- Contexto con `fmt.Errorf("guardar pedido %s: %w", id, err)`: `%w` siempre que el llamante pueda querer inspeccionarlo; mensajes en minúscula, sin punto final y sin «error al…» redundante.
- Errores de dominio como tipos o centinelas exportados (`ErrOrderNotFound`), comparados con `errors.Is`/`errors.As`, **nunca** por texto.
- `panic` solo para invariantes de programación imposibles; un middleware de `recover` en el borde HTTP lo convierte en el 500 del catch-all de `api-errors.js` y lo registra. Ningún `panic` en un camino de petición esperado.
- Se registra **o** se devuelve, no las dos cosas: el log del error lo hace el borde.

### 3.3 `context.Context`
- Primer parámetro (`ctx context.Context`) de toda función que haga E/S o pueda bloquear; nunca guardado en un struct.
- `context.Background()` solo en `main` y en pruebas (`t.Context()`); todo lo demás hereda. Cancelación y plazos se propagan hasta el driver.
- Claves de contexto de tipo no exportado, con accesores tipados (`IdentityFrom(ctx)`).

### 3.4 Interfaces y dependencias
- Las interfaces se declaran **donde se consumen** (los puertos en `domain`/`application`), pequeñas; los adaptadores devuelven structs concretos («acepta interfaces, devuelve structs»).
- Sin estado global mutable ni `init()` con efectos; el reloj (`platform/clock`), el generador de ids y la configuración se inyectan. Sin contenedores de DI (wire, fx, dig): el cableado de `run` es explícito y legible.
- Genéricos donde quitan duplicación real (`Optional[T]`, `Page[T]`, el mediator `Handler[C, R]`), no por sistema. Sin reflexión en caminos de petición.

### 3.5 Concurrencia y ciclo de vida
- Ninguna goroutine sin dueño: toda goroutine nace en un `errgroup` o con un `WaitGroup` que alguien espera, y termina cuando su `ctx` se cancela.
- Apagado ordenado y en orden fijo: `/readyz` pasa a 503 → `srv.Shutdown(ctx)` con plazo → se paran consumidores y scheduler → drenaje del relay del outbox → cierre de clientes y del pool. La prueba emitida del drenaje lo mide (SIGTERM no llega en Windows).
- Los datos compartidos llevan su mutex al lado y documentado; `go test -race` en `go-check` lo vigila.

### 3.6 HTTP y seguridad del borde
- `http.Server` con `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout` y `MaxHeaderBytes` desde la configuración; cuerpos con `http.MaxBytesReader` (el 413 sale del catálogo de `api-errors.js`).
- Decodificación JSON estricta: `DisallowUnknownFields` solo donde el contrato del cable lo pida, y comprobación de que no queda un segundo valor tras el cuerpo.
- Comparaciones de secretos y firmas de webhooks con `hmac.Equal`/`subtle.ConstantTimeCompare`; aleatoriedad con `crypto/rand`, nunca `math/rand` para nada que importe.
- Nada de `fmt.Sprintf` en SQL ni en rutas de comandos; ningún secreto en logs (el handler de `slog` redacta por nombre de atributo).

### 3.7 Pruebas
- Tablas de casos con `t.Run` y nombres legibles; `t.Helper()` en los helpers; `t.Parallel()` donde no comparten infra; `t.Cleanup` en vez de `defer` en helpers.
- Tiempo y relojes con `testing/synctest` (estable desde Go 1.25) para el circuito, los barridos y el scheduler: sin `time.Sleep` en pruebas unitarias.
- **Fuzzing nativo** (`FuzzXxx`) para los lectores del cable (`Decimal`, `Instant`, `Optional[T]`, el cuerpo de cada operación): el corpus semilla son los casos de `wire.js`.
- Comparación con `go-cmp`; los flujos FL-* son **una función `Test…` por flujo** (el JUnit de gotestsum lo lee así, §6).

### 3.8 Formato, lint y módulo
- `gofmt` exacto (el alineador de `go-source.js`) y los imports en tres grupos: stdlib, terceros, el propio módulo (el orden de `goimports`).
- Lint: `go vet ./...` y `go tool staticcheck ./...` (incluye `SA`, `S`, `ST`, `QF`) **sin hallazgos** en lo que emite `build`; un `//lint:ignore` solo con su motivo. `gosec` (Apache-2.0) se evalúa en el inc. 2 y entra si no exige silenciar falsos positivos en lo emitido.
- `go mod tidy -diff` vacío y `go mod verify` en verde: el `go.mod` que escribe `build` ya está ordenado.
- Lo que escribe `build` y el agente no debe tocar lleva la cabecera estándar `// Code generated by keel-go. DO NOT EDIT.` (la reconocen gopls y los linters); lo que escribe el agente no la lleva. Coincide con la distinción de `keel-generated.json`.

### 3.9 Construcción y despliegue
- `go build -trimpath -ldflags="-s -w"` con `CGO_ENABLED=0`; la versión y el commit se inyectan por `-ldflags -X` y además se leen de `runtime/debug.ReadBuildInfo`.
- Dockerfile multi-etapa con caché de módulos (`--mount=type=cache`), `GOFLAGS=-mod=readonly`, imagen final `distroless/static:nonroot` (usuario no root, sin shell) y `HEALTHCHECK` delegado a un subcomando del propio binario (`/server healthcheck`), porque no hay curl.
- Configuración por variables de entorno (12-factor) con los defaults del gradiente de `profile-values.js`; la configuración se valida entera al arrancar y el servicio no arranca con un valor inválido.

### La red de idioma: `test/go-idioms.test.js`
Recorre lo emitido de todas las fixtures y siluetas y prohíbe, con el archivo y la línea: `init()`; `http.DefaultClient`/`http.Get`; `context.Background()`/`context.TODO()` fuera de `main` y pruebas; `panic(` fuera de la lista de invariantes; `math/rand` fuera de pruebas; `time.Sleep` en pruebas unitarias; `snake_case` y siglas mal capitalizadas en identificadores; paquetes con los nombres prohibidos del §3.1; `fmt.Errorf` que recibe un `err` sin `%w`; identificador exportado sin comentario; `http.Server` sin los cuatro timeouts. Cada regla se falsa con una mutación del texto emitido, como el corpus de `design-mutations`.

## 4. Anatomía del paquete `packages/keel-go/`

Calcada de `packages/keel-dotnet/`. Se reutiliza de `keel-core/gen` sin tocarlo:
- `gateDesign`, `resolveStack`, `materialize`, `project-writer`, `generated-manifest`, `specs-seal` y `evolution`.
- `buildModel` (con la proyección nueva), `wire`, `api-contract`, `api-errors`, `api-cases`, `access-plan`, `openapi`, `relational`, `constraint-errors`, `declared-errors`, `messaging-stores`, `reconciliation-stores`, `outbound-resilience`, `cache-plan`, `dispatch`, `entry-gates`, `ownership`, `query-filters`, `ref-targets`, `fixtures`, `infra-scripts`, `messaging-provisioning`, `identity-realm`/`identity-provisioning`, `junit-scoring`, `profile-values`, `runtime-env`, `deploy-probes`, `mechanisms`, `payment-gateways` y los `*-probes`.
- `keel-core/src/lib/harness.js` (`emitHarnessFiles`) y `test/helpers/tmp.js`.

Lo propio:
- `src/cli.js` y `src/commands/{build,check}.js`.
- `src/lib/assets.js` con `SUPPORTED_DSL = ['2.23']`.
- `src/lib/go-projection.js`, que implementa todo `PROJECTION_MEMBERS`/`PROJECTION_MESSAGES` de `keel-core/src/lib/gen/projection.js`, con las reglas de nombres del §3.1. Ojo: `errorBase` devuelve un tipo `error`, no una excepción.
- `src/lib/go-stack.js` (módulos de ejecución y de herramienta, DSN y SPDX), `supported-features.js` y `engine-support.js`.
- **`src/lib/go-source.js`**, una pieza que los otros no necesitaron. Lleva tres cosas:
  - un **colector de imports** por archivo, agrupado como `goimports`, porque en Go un import sin usar es un error de compilación;
  - un **alineador al estilo gofmt** para campos de struct, bloques `const`/`var` y literales clave-valor, porque `gofmt -l` tiene que salir vacío y `build` no puede depender de tener Go instalado;
  - la **cabecera de código generado** (§3.8) según quién escribe el archivo.
- `src/scaffold/*.js`: un módulo por artefacto (la lista de keel-dotnet sirve de índice) y un solo mapa de paquetes en `render.js`.
- `assets/agents/keel-go-{code,infra,tests,validate,quality}.md` y `assets/generators/go/{architecture,constitution,orchestration}.md`, más `conventions/` (una por bloque del §3: `naming`, `errors`, `context`, `concurrency`, `http`, `testing`) y `skills/keel-go-<tech>/`. Se instalan desde las listas `AGENTS`/`CONVENTIONS` de `src/scaffold/generator-docs.js`. `keel-go-quality` ejecuta el mismo `go vet` + `staticcheck` + `gofmt` + `go mod tidy -diff` que `go-check` sobre lo que escribió el agente, y revisa lo del §3 que no tiene detector.

Registro en `KNOWN_GENERATORS` (`keel-core/src/lib/assets.js`).

### Las redes

- **Sin SDK:** los `test/*.test.js` sobre el texto, con paridad contra spring, nest y dotnet. Además:
  - `test/go-syntax.test.js` usa `web-tree-sitter` + `tree-sitter-go` (MIT) sobre todas las fixtures y siluetas. Comprueba la sintaxis, que todo import del propio servicio apunte a un paquete emitido y que **todo import se use** (`pkg.` referenciado), que es la trampa propia de Go;
  - `test/go-idioms.test.js`, la red del §3.
- **Con SDK** (`npm run go-check`): genera; ejecuta `go mod download`, `go mod verify`, `go mod tidy -diff` (vacío), `gofmt -l` (vacío), `go vet`, `go tool staticcheck`, `go build ./...`, `go test ./...` (arquitectura incluida), `go test -race ./...` dentro de un contenedor `golang:<v>`, `govulncheck` y licencias; arranca el servidor y pide `/livez` contra PostgreSQL en podman. Después vienen los checks en vivo por mecanismo con los mismos nombres que en keel-dotnet (`db-check`, `harness-check`, `security-check`, `broker-check`, `stub-check`, `doc-check`, `doc-harness-check`, `cache-check`, `mail-check`, `telemetry-check`, `deploy-check`, `matrix`), cada uno con sus `--sabotage=<id>`.
- `npm run golden` sobre `keel-core/gen/golden-digest.js` con las combinaciones de keel-nest, determinista y falsada.

## 5. Incrementos

| Inc. | Objetivo | Puerta |
|---|---|---|
| 0 | Línea base: golden de keel-spring y keel-nest, y paridades de nest y dotnet en verde antes de tocar keel-core | digests idénticos |
| 1 | Hueco neutral: capturar el XML real de `gotestsum` (orden de atributos, `TestX/sub`, escapes) y ajustar `junit-scoring.js`; auditar qué decisiones siguen dentro de un generador y extraerlas | golden idénticos; `gen-neutral.test.js`; caso real en `junit-scoring.test.js`, en rojo antes del arreglo |
| 2 | Esqueleto: CLI, puerta, `go-projection` (con la tabla de siglas), `go-source.js` (imports + gofmt + cabecera), módulo que compila y arranca con `run()` testeable, perfiles `local/develop/production/test` con el gradiente de `profile-values.js` y validación al arrancar, `/livez` `/readyz`, apagado ordenado con `errgroup`, `http.Server` con timeouts, prueba de arquitectura, `licenses.test.js`, `go-idioms.test.js`, decisión sobre YAML y `gosec`, `constitution.md` y `conventions/` del §3, harness con `emitHarnessFiles()` | `build`/`check`/`tmp-hygiene`/`licenses`; `go-syntax`; `go-idioms` falsado regla a regla; `go-check` (gofmt, tidy y staticcheck vacíos, vet y build limpios, `-race` en contenedor); arquitectura falsada con un import plantado |
| 3 | Contrato del cable (**el de mayor riesgo**): `Decimal`, `Instant`, `Optional[T]`, slices vacíos como `[]` y no `null`, y la prueba emitida con **todos** los casos de `wire.js`, más su `Fuzz…` con esos casos como semilla | la prueba emitida en `go-check`; falsada quitando la escala, el formato del timestamp, el tri-estado o el `[]` |
| 4 | Dominio y aplicación: value objects con guardas (constructores `NewX(...) (X, error)`, campos no exportados), agregados con lifecycle, mediator genérico sin reflexión, errores declarados como tipos y centinelas | paridad de nombres de cable y códigos con keel-spring; `go-syntax`; `go-idioms` |
| 5 | API REST: router, lectores, `ErrorResponse`, `recover` en el borde, `MaxBytesReader`, paginación, `Location`, OpenAPI derivado byte a byte | `contract-parity` contra keel-spring; `openapi.test.js` |
| 6 | Persistencia relacional: SQL de `relational.js`, baseline goose, FKs, índices únicos condicionados, versión, unidad de trabajo, `SKIP LOCKED`, finders (DSL 2.22) y `infra/fixtures.sql`. PostgreSQL primero y **MySQL en 6b** | `schema-parity` y `fixtures-schema`; `db-check` en PG y MySQL con sabotajes |
| 7 | Arnés de integración + agentes `keel-go-*` + `score-scenarios.sh` | `harness-check`; **primera corrida** sobre `notification-mailer`, con `keel-go-quality` (vet + staticcheck + gofmt) en verde sobre lo que escribió el agente |
| 8 | Seguridad (Keycloak y Cognito), ownership y alcance | `security-parity`, `ownership`; `security-check` (401 frente a 404 incluido) |
| 9 | Mensajería: los tres brokers, outbox, `processed_event` y DLT; mensajería sin persistencia rechazada (`messaging-frontier`) | `broker-check` con `--broker=`; `-race` en verde |
| 10 | Idempotencia, reclamos, rescate, purgas por lotes, scheduling y el gate de idempotencia | `idempotency-check.test`; `db-check`; pruebas de reloj con `synctest`; corrida `job-dispatch` |
| 11 | Clientes HTTP salientes, circuito propio, reconciliación y arnés WireMock | `http-clients.test`; `stub-check`; corrida `stock-reservation` |
| 12 | Persistencia documental (MongoDB en replica set) | `doc-check`, `doc-harness-check`; corrida `-mongo` |
| 13 | Caché, storage, correo, autoría, needs y pagos (Stripe y MercadoPago, sin SDK de pasarela; firmas con `hmac.Equal`) | `cache/mail/stub-check`; corridas `payment-checkout`, `asset-vault`, `catalog` |
| 14 | Telemetría y despliegue: series del panel, exemplars, pool, logs ECS, `deploy/` (distroless nonroot, `trimpath`, subcomando `healthcheck`) | `telemetry-check`, `deploy-check` (sondas de `deploy-probes.js`) |
| 15 | Evolución (`gen/evolution.js` + `GO_EVOLUTION`) | `design-evolution.test` con paridad del delta contra los tres |
| 16 | Cierre: frontera sin rechazos sin motivo, matriz sin `sin ejecutar`, `capability-coverage`, corrida de control del par MVP en los **cuatro** generadores; README raíz, `CLAUDE.md` y `.claude/rules/go-generador.md` | 8×23/23 y huella comparable (~17); `go-idioms` y staticcheck vacíos en las ocho corridas |

### Estado

- **Inc. 0 — hecho (2026-10-28).**
  - El golden de keel-spring sale idéntico: 46 combinaciones, 11 713 archivos.
  - **El de keel-nest estaba desfasado:** su última regeneración fue en `814cf99a`, y `--check` dio 90 huellas cambiadas en 7 archivos. Se atribuyeron volcando `planService` en un worktree de `814cf99a` y en HEAD, y comparando el contenido. Cada familia casa con un commit:
    - Imágenes de MinIO/mc (compose de `infra/` y `deploy/`, Dockerfile del toolbox y la etiqueta de devtools): `af6d734a`.
    - `tokenAs` con la identidad en cualquier claim y el párrafo de la persona en `integration-tests.md`, más `caller-identity.ts`: `df0dddc0` y `4575f3a6`.
    - `bson-values.ts` con el id `long`/`int` en documentos: `4f006ba3`.
    - El comentario de `dashboards-provisioning.yaml` (`@keel-system/keel-core`): `2587f530`.
  - Como ningún archivo quedaba sin explicar, la línea base se regeneró (43 combinaciones, 10 627 archivos) y el `--check` siguiente sale idéntico.
  - Suites en verde: keel-core 1286/1286, keel-spring 1679/1679, keel-nest 861/861, keel-dotnet 819/819 y keel-recover 189/189.
  - **Es la misma lección del inc. 0 de dotnet, repetida:** los cambios de lo emitido en keel-nest tampoco regeneran su golden en el mismo commit. A partir del inc. 1, todo cambio en `keel-core/gen` pasa los **dos** `golden -- --check` antes de dar el commit por bueno.
- **Inc. 1 — hecho (2026-10-29).** Go 1.27.3 instalado (§7).
  - **Resultado**:
    - Se retiraron 593 líneas copiadas de keel-nest y keel-dotnet.
    - keel-nest no cambia un byte por la extracción: su golden solo difiere en `score-scenarios.sh`, que es el awk.
    - Suites en verde: keel-core 1306/1306, keel-spring 1679, keel-nest 861, keel-dotnet 819 y keel-recover 189.
    - `keel-core/test/gen-extracted.test.js` prohíbe que un generador (también keel-go) vuelva a definir lo extraído. keel-spring queda fuera con su lista y su motivo: su `usesStorageControl` exige devtools y su `sendsMail` no mira la capa.
  - **XML real de gotestsum 1.13.0, capturado** (`keel-core/test/junit-scoring.test.js`, `GOTESTSUM_XML`). Con el awk de antes la matriz salía **vacía**: los dos casos nuevos nacieron en rojo. Lo que tiene de distinto frente a Gradle, Vitest y xUnit:
    - `classname` va antes que `name` (como Vitest) y por defecto es la ruta del módulo (`example.com/acme/…/integration`), con puntos: keel-go pasará `--junitfile-testcase-classname short` (sale `integration`).
    - El nombre es el de la función, que no admite guiones (`TestFL_RES_001`), o la ruta del subtest con los espacios como `_` (`TestFL_RES_004/FL-RES-004-B:_rechazo…`).
    - El padre de unos subtests es un caso más, y cae en rojo cuando cae un hijo: duplicaba filas y, si no era un flujo, salía como rojo «no escenario».
    - `message="Failed"` siempre; lo que dijo la prueba va en el cuerpo del `<failure>` entre `=== RUN` y `--- FAIL`, con `&#34;`, `&#39;` y `&#x9;`.
  - **Arreglo en `gen/junit-scoring.js`**: el id sale del último tramo de la ruta (después de cortar por los dos puntos) y de `TestFL_X_001` → `FL-X-001`; las filas se guardan hasta el `END` y un padre con hijos no puntúa salvo que caiga sin que caiga ninguno (su propio rojo, la limpieza del flujo, no se pierde); con «Failed», el mensaje sale del cuerpo. Los casos reales de Gradle, Vitest y xUnit v3 (3.x y 4.x) siguen en verde sin tocarlos.
  - **El golden cambia, a propósito y solo en un archivo**: `infra/score-scenarios.sh` en las 46 combinaciones de keel-spring y las 43 de keel-nest, y ningún otro. Se regeneran las dos líneas base en el mismo commit.
  - **Auditoría de lo neutral que seguía en un generador**: se compararon los cuerpos de toda función homónima de keel-nest y keel-dotnet. Hay 31 con cuerpo idéntico de más de dos líneas y unos 37 predicados `uses*` de una. Se extraen solo los que tienen el MISMO cierre en los dos:
    - `gen/features.js`: `usesApi`, `usesRelational`, `usesDocument`, `usesPersistence`, `repositoryRoots`, `repositoryOf`, `isPaginated`, `isPartialUpdate`, `resolvedByOf`, `usesMediator`, `usesHttpClients`, `usesOAuth2`, `usesHttpStub`, `usesIdentityHarness`, `usesMail`, `sendsMail`, `usesMultipart`, `usesStorage`, `usesStorageControl`, `usesPayments`, `usesServiceParameters` y `usesStatementCount`.
    - `gen/aging-targets.js` (relacional y documental), `gen/compensation.js` (la nota) y `gen/mapper-plan.js`.
    - En sus módulos de siempre: `sortablePaths` (`document.js`), `guardClaimsFor` (`scheduling.js`), `subscriptionsBySource` (`messaging-plan.js`), `localIssuer` (`identity-realm.js`) y `localMongoUrl` (`infra-catalog.js`).
  - **Divergencias encontradas, que NO se extraen hasta decidir cuál es la buena**:
    - `usesMessaging`: keel-nest admite mensajería sin capa de persistencia, una rama muerta desde que los tres la rechazan (`messaging-frontier`).
    - `usesJwt`: keel-dotnet exige además que el plan de acceso no sea abierto.
    - De ellos cuelgan `usesKafka`, `usesRabbitMq`, `usesSnsSqs`, `usesProcessedEvents`, `usesCallerScope` y `usesRoleCheck`.
    - Tampoco se extrae `internalDatabaseUrl`, que emite una URL `jdbc:`: keel-go necesitará otro DSN.

- **Para retomar (cada incremento empieza en un contexto nuevo):** el siguiente es el **inc. 2** (esqueleto). Antes de empezarlo:
  - **Decisión pendiente del usuario: las dos divergencias del inc. 1**, `usesMessaging` y `usesJwt` (ver arriba). keel-go necesita esos predicados ya en el inc. 2 (seguridad y mensajería van detrás, pero `usesJwt` decide el middleware); lo limpio es decidir cuál es el bueno, extraerlo a `gen/features.js` y añadirlo a `gen-extracted.test.js`.
  - Comprobar que el inc. 1 está commiteado (`git log`): si no, commitear primero el inc. 0 (golden de keel-nest + el plan) y luego el inc. 1.
  - El patrón de la extracción: comparar cuerpos de funciones homónimas entre generadores y mover solo lo que tiene el mismo CIERRE, con `golden --check` de keel-spring y keel-nest antes y después.

MariaDB, SQL Server y Oracle se quedan rechazados con su motivo hasta que una red los mida, como en keel-nest.

## 6. Riesgos conocidos

- **El cable.** Go no tiene decimal con escala ni Optional. `shopspring/decimal` normaliza `2.50` → `2.5`, así que la escala tiene que salir del campo (`gen/constraints.js`) o hay que usar `cockroachdb/apd`, que conserva el exponente. Se decide midiendo en el inc. 3. Nunca `float64` para importes.
- **`nil` frente a vacío.** `encoding/json` serializa un slice `nil` como `null` y un map `nil` igual; el contrato del cable pide `[]`. Los DTO de salida se construyen con `make` o el escritor normaliza, y la prueba emitida del cable lo fija.
- **gofmt exacto desde JS.** La alineación de columnas en structs y `const` es el riesgo mecánico principal. `go-check` lo detecta (`gofmt -l`), y el alineador se prueba contra la salida real de gofmt sobre todas las fixtures.
- **Imports sin usar y variables sin usar** rompen la compilación, también en ramas que solo aparecen con cierta silueta. Por eso hay colector de imports, `go-syntax` con la regla de uso y siluetas en `DERIVED_SILHOUETTES`.
- **Java traducido a Go.** El riesgo de calcar keel-spring es emitir Go que compila pero no es idiomático (getters `GetX`, `ID` como `Id`, excepciones simuladas con `panic`, un paquete por clase). Lo frenan `go-idioms`, staticcheck (`ST*`) y `keel-go-quality`.
- **Ciclos de importación.** Partir `domain`/`application` en varios paquetes los provoca con las referencias entre agregados; por eso son un paquete cada uno (§2).
- **El detector de carreras exige cgo.** Se ejecuta en contenedor Linux; en Windows no hay `-race` sin gcc, y la guía (§7) no lo pide.
- **Nombres de métricas.** El panel espera las series de Micrometer: se registran con `client_golang` a mano y con los nombres del vocabulario, no con la convención de OTel.
- **Orden de atributos y subtests en el JUnit de gotestsum.** Se mide en el inc. 1 y la skill pide una función `Test…` por flujo.
- **SIGTERM en Windows** no llega, igual que en nest y dotnet. Lo cubre la prueba emitida del drenaje.
- **YAML:** `gopkg.in/yaml.v3` está archivado. Se elige un sucesor mantenido en el inc. 2.
- **Licencias de herramientas.** golangci-lint es GPL-3.0 y quedaría registrado en `go.mod` con la directiva `tool`; por eso no se usa (§1.6). Quien quiera usarlo en su máquina lo instala aparte, fuera del módulo.

## 7. Guía de entorno local (para quien no conoce Go)

**Estado de la máquina (medido):** Node, Git y Podman instalados; Go 1.27.3 instalado y verificado el 2026-10-29.

1. **Instalar Go** con el MSI de https://go.dev/dl (o `winget install GoLang.Go`). Después reabre la terminal y VS Code:
   ```powershell
   go version
   go env GOPATH          # %USERPROFILE%\go
   ```
   Añade `%USERPROFILE%\go\bin` al PATH de usuario.
2. **Editor:** VS Code con la extensión **Go** (golang.go, MIT). Acepta instalar `gopls` cuando lo ofrezca. En la configuración, `"go.lintTool": "staticcheck"` y formato al guardar (viene activo: aplica `gofmt` y ordena los imports).
3. **Herramientas globales** (opcionales: el proyecto generado las trae con `go tool`):
   ```powershell
   go install gotest.tools/gotestsum@latest
   go install golang.org/x/vuln/cmd/govulncheck@latest
   go install honnef.co/go/tools/cmd/staticcheck@latest
   ```
4. **Prueba de humo** en el scratchpad:
   ```powershell
   mkdir hola; cd hola
   go mod init hola
   # main.go con un http.HandleFunc("GET /hola", ...)
   go run .
   go test ./...
   gofmt -l .            # vacío = bien formateado
   go vet ./...
   staticcheck ./...     # vacío = sin hallazgos
   ```
5. **Proxy corporativo:** si `go mod download` falla, revisa `go env GOPROXY` / `GOPRIVATE`, o configura `HTTPS_PROXY`.
6. **Un proyecto generado**, en cuanto exista el inc. 2:
   ```powershell
   npm link --workspace packages/keel-go
   keel-go build specs/<servicio>
   cd services/<servicio>-go
   go mod download
   bash infra/up.sh
   go run ./cmd/server
   go tool gotestsum --junitfile build/test-results.xml ./...
   go vet ./...; go tool staticcheck ./...
   ```
7. **Qué es cada pieza:**
   - `go.mod` es el `package.json` y fija también el toolchain y las herramientas.
   - `go.sum` es el lock.
   - Un paquete es un directorio; todos sus archivos comparten espacio de nombres.
   - Una mayúscula inicial hace un identificador público.
   - `internal/` no se puede importar desde fuera del módulo.
   - Los errores se devuelven, no se lanzan; `panic` no es una excepción.
   - `context.Context` lleva la cancelación y los plazos de una petición hasta la base de datos.
   - Lectura recomendada, en este orden: *A Tour of Go*, *Effective Go* y *Go Code Review Comments*.

## 8. Archivos críticos

- **Nuevos:** `packages/keel-go/**` y `PLAN-KEEL-GO.md`.
- **Tocados en keel-core:** `src/lib/assets.js` (`KNOWN_GENERATORS`) y `src/lib/gen/junit-scoring.js`, más lo neutral que aparezca en el inc. 1. En el inc. 16, `README.md`, `CLAUDE.md` y `.claude/rules/go-generador.md`.
- **Referencias a calcar:**
  - `packages/keel-dotnet/src/{cli.js,commands/,lib/cs-projection.js,lib/supported-features.js,lib/engine-support.js,scaffold/render.js,scaffold/generator-docs.js}`
  - `packages/keel-dotnet/scripts/cs-check.js`
  - `packages/keel-dotnet/test/{cs-syntax,licenses,contract-parity,schema-parity,security-parity}.test.js`
  - `packages/keel-nest/test/helpers/workspace.js`
  - `completed_plans/PLAN-KEEL-DOTNET.md`

## 9. Verificación

- Por incremento: la puerta de su fila del §5, `npm test` de los cinco paquetes en verde y los golden de keel-spring y keel-nest sin cambios.
- `npm run go-check --workspace packages/keel-go` (Go + podman) en verde en todas las fixtures que admita la frontera: `gofmt -l`, `go mod tidy -diff` y `staticcheck` vacíos, `go vet` limpio, `-race` en verde.
- `test/go-idioms.test.js` en verde y cada regla falsada por su mutación.
- Hitos end-to-end en los incs. 7 y 12, y control final en el 16: `/keel-generate-go` sobre el par MVP con el 100 % de los `FL-*`, registrado en `docs/corridas/` con `corrida-metrics.js footprint`, y `keel-go-quality` en verde sobre lo que escribió el agente.
- `licenses.test.js` y `infra/check-licenses.sh` siempre en verde. Un módulo GPL añadido a `go-stack.js` —también como herramienta— debe ponerlos en rojo (se falsa en el inc. 2).
