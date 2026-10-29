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
7. **Versiones verificadas al abrir cada incremento** con `ctx7`/`find-docs`, nunca de memoria. La base prevista es la línea estable de Go 1.27, que se confirma en el inc. 2 y queda fijada con la directiva `toolchain` de `go.mod`. Política: el `go` de `go.mod` declara la versión mínima que el código usa de verdad, y el `toolchain` la estable con la que se mide. **Corregido en el inc. 3**: el mínimo es 1.27 y no «las dos últimas mayores», porque el cable va sobre `encoding/json/v2`, que en 1.26 no compila.
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
| Jackson / `wire.ts` / STJ | `encoding/json/v2` (estable en 1.27) con las opciones del contrato en `platform/wire` —un solo punto: `wire.Marshal`/`Unmarshal`—, y los tipos que la stdlib no tiene: `Decimal` propio sobre `math/big` con su escala, `Date` y `Optional[T]` tri-estado. El instante es `time.Time`, y su forma (UTC, 3 decimales, `Z`) la pone un conversor de las opciones, no un tipo envoltorio (inc. 3) |
| BigDecimal / decimal.js con escala / `decimal` | `wire.Decimal` propio (inc. 3): shopspring normaliza `2.50`→`2.5`, y apd escribe `1E-7` y es mutable |
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
- `http.Server` con `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout` y `MaxHeaderBytes` como constantes de `httpapi` (no como configuración: los otros tres no los declaran y `application.yaml` tiene que ser igual; inc. 2); cuerpos con `http.MaxBytesReader` (el 413 sale del catálogo de `api-errors.js`).
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
- `go mod tidy` no mueve ningún requisito directo ni ninguna herramienta de las que declara `build`, y después `go mod tidy -diff` sale vacío y `go mod verify` en verde. `build` no escribe `go.sum` ni los indirectos: los calcula tidy con MVS, que es determinista (corregido en el inc. 2).
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
- **Con SDK** (`npm run go-check`): genera; ejecuta `go mod tidy` (sin mover ningún directo), `go mod tidy -diff` (vacío), `go mod verify`, `gofmt -l` (vacío), `go vet`, `go tool staticcheck`, `go build ./...`, `go test ./...` (arquitectura incluida), `go test -race ./...` dentro de un contenedor `golang:<v>`, `govulncheck` y licencias; arranca el servidor y pide `/livez` contra PostgreSQL en podman. Después vienen los checks en vivo por mecanismo con los mismos nombres que en keel-dotnet (`db-check`, `harness-check`, `security-check`, `broker-check`, `stub-check`, `doc-check`, `doc-harness-check`, `cache-check`, `mail-check`, `telemetry-check`, `deploy-check`, `matrix`), cada uno con sus `--sabotage=<id>`.
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

- **Cierre de las divergencias del inc. 1 (2026-10-29, al abrir el inc. 2).** No hacía falta decidir cuál era la buena: las dos respuestas coinciden en todo diseño válido.
  - `usesMessaging`: la rama de keel-nest (`|| !layersPresent.persistence`) solo se alcanza con mensajería sin persistencia, que los tres rechazan antes de generar (`messaging-frontier.js`). Entra la de keel-dotnet.
  - `usesJwt`: `accessPlan` solo devuelve `open: true` con el protocolo `none`, y entonces `usesTokenProtocol` ya es falso. El `!plan.open` de keel-dotnet no cambiaba nada; entra la de keel-nest.
  - Extraídos a `gen/features.js` con lo que colgaba de ellos y tenía el mismo cierre: `usesBridge`, `usesProcessedEvents`, `usesRabbitMq`, `usesKafka`, `usesSnsSqs`, `securityPlan`, `usesHttpSecurity` y `usesCallerScope`. Como `gen-extracted.test.js` enumera las exportaciones de `features.js`, ya vigila que no vuelvan a copiarse.
  - **Se queda fuera `usesCallerIdentity`**: ahí `!plan.open` sí cambia la respuesta si un diseño declara `callerIdentity` con el protocolo `none` (el schema no lo impide). Tampoco `usesRoleCheck` ni `usesSubscriptionMessages` (este último solo existe en keel-nest).
  - Golden de keel-spring (46) y keel-nest (43) idénticos a la línea base.
- **Inc. 2 — hecho (2026-10-29).** El paquete `packages/keel-go`, calcado del inc. 2 de keel-dotnet (`8c546b22`).
  - **El paquete**:
    - CLI con `build` y `check` sobre el tronco neutral; registro en `KNOWN_GENERATORS`.
    - `go-projection.js` con el contrato entero y la tabla de siglas de staticcheck (ST1003): `customerId` → `CustomerID`, `imageUrls` → `ImageURLs`, `type` → `typ` si no se exporta. El modelo se construye en las 17 fixtures y nombra lo mismo que con Java, TypeScript y C#.
    - `go-source.js`: el colector de imports (tres grupos de goimports; solo los que el cuerpo usa, sin contar comentarios ni cadenas), la alineación de gofmt y la cabecera `// Code generated by keel-go. DO NOT EDIT.`.
    - La frontera: dominio, casos de uso y API aceptados con aviso; el resto rechazado con su incremento; la telemetría también.
    - `go-stack.js` con versión exacta y SPDX de cada módulo, de ejecución y de herramienta. Cada versión se leyó de proxy.golang.org con al menos dos semanas, y cada licencia del LICENSE del módulo.
  - **El proyecto emitido**:
    - `go.mod` con `go 1.26.0` + `toolchain go1.27.3` y dos requisitos directos (`go.yaml.in/yaml/v3`, `golang.org/x/sync`). Lleva las cuatro herramientas en `tool` y también en `require … // indirect`: sin eso, tidy las resolvería a la última versión publicada.
    - `config/` embebida en el binario (`embed.FS`), con un `application.yaml` línea a línea igual al de keel-nest y keel-dotnet, y su cargador en `internal/platform/config`.
    - Sondas en `internal/platform/health`, y el `http.Server` con sus límites en `internal/httpapi`.
    - `cmd/server` con `run(ctx, args, getenv, stdout) error`, el errgroup y el apagado en orden.
    - `internal/architecture`, la prueba de la frontera, que se comprueba a sí misma con seis imports plantados.
    - `doc.go` por paquete, y `docs/keel/` con `architecture.md`, `constitution.md` y las seis convenciones del § 3.
  - **Medido**:
    - `npm test` 122/122: la proyección contra las otras tres en las 17 fixtures, la puerta, la frontera, las licencias y la alineación contra 10 salidas capturadas de gofmt (`test/gofmt-captures.json`).
    - `go-syntax` sobre las 17 fixtures, autocomprobado con Go roto.
    - `go-idioms`, 12 reglas, cada una falsada por su mutación, que la dispara a ella sola.
    - `npm run go-check` 20/20: tidy sin mover nada declarado; `tidy -diff` vacío y `verify`; `gofmt -l`, `vet` y staticcheck vacíos; build con `CGO_ENABLED=0 -trimpath`; pruebas por gotestsum con su JUnit; `-race` en `golang:1.27.3` (podman); la frontera en rojo con un import plantado; govulncheck; go-licenses sobre el servicio y los 35 transitivos de las herramientas, falsado quitando BSD-3-Clause; el binario arrancado desde otro directorio, con `/livez`, `/readyz` y 404.
    - El apagado tras SIGTERM no se mide en Windows, y se dice. Lo cubre la prueba emitida, que cancela el contexto.
    - keel-core 1306/1306; golden de keel-spring y keel-nest idénticos.
  - **Decisiones medidas, que corrigen el plan**:
    - **`go.sum` y los indirectos no los escribe build.** Para calcularlos hace falta Go, y la puerta «`tidy -diff` vacío» sobre lo emitido no se puede cumplir (§ 3.8). Los calcula `go mod tidy`, que con MVS es determinista: las mismas versiones directas dan siempre el mismo grafo, igual que `npm install` en keel-nest. La puerta pasa a ser «**tidy no mueve ningún requisito directo ni ninguna herramienta**». Si una herramienta subiera un directo, tidy lo movería y go-check saldría en rojo.
    - **Los límites del `http.Server` son constantes de `httpapi`, no configuración** (§ 3.6). Los otros tres no los declaran (Tomcat, Node y Kestrel usan sus defaults): añadir claves rompería la igualdad de `application.yaml`. `MaxHeaderBytes` son los 8 KiB de Tomcat.
    - **YAML: `go.yaml.in/yaml/v3`** (v3.0.5), la continuación de `gopkg.in/yaml.v3` que mantiene la organización YAML, con la misma API. Su LICENSE trae MIT y Apache-2.0. Se lee como `yaml.Node` para conservar los escalares tal cual, porque un placeholder se resuelve antes de convertir nada.
    - **gosec no entra.** La v2.29.0 no lee los datos de exportación de Go 1.27 («export data version 5 is greater than maximum supported version 4»), así que no analiza nada. Además, como herramienta metería gRPC, OpenTelemetry y la API de Google en el `go.mod` del servicio. Se reevalúa si alguna vez sale una versión compatible.
    - **El `int` del DSL es `int32`**, como en Java y C#: con el `int` de 64 bits de Go, un valor fuera de rango sería un dato aceptado donde los otros dan 400.
    - **El error de un `code` no hereda**: `errorBase` devuelve su categoría (`KindNotFound`…) desde la jerarquía neutral. El tipo concreto llega en el inc. 4.
    - **La configuración va embebida**, así que el binario no depende del directorio de trabajo; go-check lo arranca desde otro. Como dos paquetes se llaman `config`, el de los archivos se importa con el alias `configfiles`.
  - **Trampas que costaron un ciclo cada una:**
    - **Un comentario corta la alineación de gofmt** entre dos campos de un struct (medido). `alignRows` admite líneas `{ text }` que cortan la sección, y los bloques de columna son contiguos, como en el tabwriter.
    - En una plantilla de JS, el `${VAR}` del cargador se evalúa. Se escribe `$[VAR]` (y `$[[` para una llave suelta) y se traduce sobre la plantilla ENTERA. Un `.replaceAll` encadenado al último tramo de una concatenación solo traduce ese tramo.
    - La regla de documentación miraba solo la línea anterior: un comentario de varias líneas, o uno con `//go:embed`, empieza más arriba.
    - Python en Windows escribe CRLF si no se le pasa `newline=''`. Las plantillas de JS normalizan los saltos, así que el Go emitido no se vio afectado, pero los fuentes sí.
- **Inc. 3 — hecho (2026-10-29).** El contrato del cable: `src/scaffold/wire.js` emite `internal/platform/wire` (`wire.go`, `decimal.go`, `date.go`, `optional.go`) y tres pruebas.
  - **Medido antes de decidir** (Go 1.27.3):
    - `shopspring/decimal` v1.6.0 NORMALIZA: `2.50` sale `2.5` (y su JSON es una cadena). Fuera.
    - `cockroachdb/apd` v3.2.3 conserva la escala, pero `String()` y su JSON escriben `1E-7` y `1E+3` (solo `Text('f')` es plano), y su API es mutable: copiar uno por valor comparte su `big.Int`.
    - **`Decimal` propio sobre `math/big`**: inmutable, con valor cero útil (0 con escala 0) y la semántica de BigDecimal que ya reproducen keel-nest y keel-dotnet: suma con la mayor escala, producto con la suma, `Quo` con escala y modo, `Rescale`, y los siete `RoundingMode` con la tabla de la Javadoc como oráculo. El dominio no gana un módulo de terceros.
    - **`encoding/json/v2` es estable en 1.27** (compila sin `GOEXPERIMENT`); con `GOTOOLCHAIN=go1.26.0` no compila. Se usa, y el `go` de `go.mod` pasa a **1.27.0**.
  - **Lo que da json/v2 por defecto y el v1 no**: `[]` para una lista `nil`; nombres EXACTOS (el v1 casaba `"A"` con `a`: otra respuesta que la de Jackson para el mismo cuerpo); un segundo valor tras el cuerpo, rechazado; sin escapar lo no ASCII ni `<>&`. Y conversores por tipo en las opciones: `time.Time` (UTC, `.000Z`, truncando; al leer exige zona), `int64`/`int32` también desde una cadena numérica y `jsontext.Value` también desde una cadena con el documento.
  - **Decidido sin que lo diga el contrato**: un nombre repetido NO se rechaza (el v2 sí, por defecto) y gana el último, como en Jackson, `JSON.parse` y STJ. Es candidato a regla de `wire.js`.
  - **La proyección**: `json` → `jsontext.Value` (antes `json.RawMessage`, del v1). El dominio y la aplicación pueden importar `internal/platform/wire` (`boundaries()`). `github.com/google/uuid` v1.6.0 (BSD-3) entra en `go.mod`: la prueba del cable lo usa.
  - **La regla `no-panic` de `go-idioms`** admite el `panic` de una función `Must…` (`MustDecimal`, `MustDate`), la convención de `regexp.MustCompile`, y solo ese (caso propio en `go-idioms.test.js`).
  - **Medido**:
    - La prueba emitida trae TODOS los casos de `wire.js` (17 de salida, 10 de ida y vuelta, 4 rechazados) y 19 pruebas más: nulos, `omitzero` sin tocar las listas, propiedades desconocidas, mayúsculas, duplicados, valor sobrante, enum por número, límites del decimal, instante sin zona, enteros fuera de rango, los tres estados de `Optional` (con el long desde cadena DENTRO, que comprueba que hereda las opciones), aritmética, la tabla de redondeo y la inmutabilidad.
    - `go-check` 26/26, con **seis sabotajes del cable, cada uno en rojo con su prueba** (`test/helpers/wire-sabotages.js`): la escala, el formato del instante, el tri-estado, `[]`, el long desde cadena y los nombres sin distinguir mayúsculas. `test/wire.test.js` comprueba sin Go que cada sabotaje se sigue aplicando y que nombra una prueba que existe.
    - **Fuzzing** (`FuzzParseDecimal`, `FuzzParseTimestamp` y `FuzzParseDate`, con los casos de `wire.js` como semillas): a los pocos segundos encontró `100000E1000`, que se aceptaba (la escala estaba dentro del límite) y cuya forma plana, de 1006 dígitos, ya no se podía volver a leer. Había un límite para el texto y otro para la escala; ahora es uno, `MaxDigits = 1000` dígitos de la forma plana (el `maxNumberLength` de Jackson), y la entrada queda como semilla. Después, 60 s por fuzzer sin hallazgos.
    - keel-go 137/137 y keel-core 1306/1306. keel-core/gen no se tocó, así que los golden de spring y nest no cambian.
- **Inc. 4a — hecho (2026-10-29): el dominio.** Seis emisores sobre `internal/domain` (un solo paquete, un archivo por tipo): `errors`, `enums`, `value-types`, `entities`, `events` y `domain-guards-check`. `render.js` gana el nombre de archivo (`goFileName`, que esquiva los sufijos que Go lee como restricción de compilación: `x_linux.go`, `x_test.go`), `declType` (lo opcional que no es lista es un puntero) y `localName` (un parámetro que se llamara `time` o `wire` ocultaría el paquete).
  - **Lo que en Go toma otra forma**:
    - **Errores**: no hay jerarquía. `Kind` es la categoría (el papel de la clase base de su status) y `*Error` lleva `code`, status y mensaje. Un centinela por `code` del diseño (`ErrProductNotFound`) y por error del dominio generado (`ErrInvalidValue`, `ErrValueFormat`, `ErrInvalidStateTransition`). Una ocurrencia se construye con `Errorf(ErrX, "…", args…)` y `errors.Is` la reconoce por su centinela (el campo `of`), no por su `code`: `ErrInvalidValue` y `ErrValueFormat` comparten `VALIDATION_ERROR` y se distinguen. El `code` con status según la operación se construye con `StatusErrorf`. El nombre sale del `code` con la tabla de siglas de staticcheck: `SKU_ALREADY_EXISTS` → `ErrSkuAlreadyExists` (SKU no es sigla para ST1003).
    - **Enums**: `type X string`, una constante comentada por valor (el comentario corta la alineación: cada una es su sección), `ParseX` y `UnmarshalText` que solo admiten los valores del diseño. Por eso `ErrInvalidValue` existe en cuanto hay un enum, donde los otros tres solo lo tienen con value objects: la paridad de errores lo descuenta con su motivo.
    - **Value objects**: struct con los campos sin exportar, `NewX(...) (X, error)`, accesores sin `Get`, `Equal` (go-cmp la usa) y su JSON con `MarshalJSONTo`/`UnmarshalJSONFrom` sobre un struct `xJSON` con los nombres del diseño: **leer del cable pasa por el constructor**, como el record de keel-spring. La presencia no se comprueba: en Go un obligatorio es un valor y un opcional un puntero, y el null que en los otros llega en ejecución aquí no compila. La regex es RE2, donde `$` ya es el final del texto (el `\z` de keel-dotnet). La longitud se cuenta en runas, no en bytes.
    - **Formato escalar**: un tipo `Format` y una variable por value type (`var SKUFormat = Format{…}`), así que la llamada es `SKUFormat.Validate(x)` dentro del dominio y `domain.SKUFormat.Validate(x)` fuera, y el gate neutral la casa igual. `domainGuardsScript` gana `sourceDir` (`internal`; por defecto `src`, sin cambiar un byte de keel-nest ni keel-dotnet).
    - **Entidades**: struct sin campos exportados, `Rehydrate<E>(<E>State)` con un estado de campos con nombre, accesores que copian lo opcional (`clonePtr`) y las listas (`slices.Clone`), la guarda `transitionTo` sobre un mapa de transiciones y el buffer de eventos (`raise`, `PullEvents`). `transitionTo` y `raise` solo los llama el código del agente: llevan `//lint:ignore U1000` con su motivo (staticcheck lo respeta; gofmt mete una línea `//` antes de la directiva).
    - **Eventos**: `Event` es una interfaz con `EventMetadata()`; cada evento, un struct con `Metadata` y su payload, y `New<E>Event(...)`. La metadata va en el orden del cable.
  - **Medido**:
    - `npm test` de keel-go 190/190. Entre ellas, `test/domain.test.js` (43): paridad de `code` y status con lo que EMITEN keel-dotnet y keel-spring en las 17 fixtures, el gate del formato con los mismos campos y EJECUTADO con bash (rojo recién generado, rojo con la llamada en un comentario, verde dentro y fuera del dominio, y avisa si falta la variable), y la forma de enums, estados, transiciones y metadata. **Destapó un defecto antes de compilar nada**: los centinelas del diseño salían con `code: "undefined"`.
    - `go-check` gana dos pasos. El primero compila el Go de las **17 fixtures**, cada una como su módulo: tidy, gofmt, vet, staticcheck y sus pruebas (`--fixtures` corre solo ese). El segundo es la sonda `scripts/probes/domain_probe_test.go` (prueba interna de `internal/domain` de product-catalog: escala normalizada, rechazos con 400, el ancla, el enum, la transición negada con 409, los centinelas y la copia del estado) con **siete sabotajes** (`test/helpers/domain-sabotages.js`), cada uno en rojo con su prueba y solo con ella, salvo las que caen con ella por una dependencia legítima (`alsoFails`): la prueba del cable de Money cae con la escala y con la cota porque lee por el mismo constructor, y con el centinela porque json/v2 pregunta `errors.Is(err, json.SkipFunc)` al error de `UnmarshalJSONFrom`, así que un `Is` que dice que sí a todo cambia lo que hace el lector. `test/domain-sabotages.test.js` comprueba sin Go que se siguen aplicando.
    - **`go-check` 51/51**, con `-race` en `golang:1.27.3` (podman).
    - keel-core 1306/1306; golden de keel-spring (46) y keel-nest (43) idénticos.
  - **Pendiente del 4a, con motivo**: `scalePolicy: reject` en un value object no lo declara ninguna fixture (solo entradas de casos de uso), así que esa rama compila en ninguna; un diseño con un patrón que RE2 no admite (lookaround, retrorreferencias) haría fallar `regexp.MustCompile` al arrancar, y la frontera todavía no lo rechaza.
- **Inc. 4b — hecho (2026-10-29): la aplicación.** Cuatro emisores sobre `internal/application` (un solo paquete): `services` (mensaje y handler por operación), `dtos`, `mappers` y `use-cases` (el despacho). `render.js` gana `applicationPath`, `goTypeName` (los nombres que el modelo compone al estilo de Java pasan por la tabla de siglas: `GetProductsByIdsQuery` → `GetProductsByIDsQuery`) y `appType` (enums y value objects como `domain.X`, DTO propios por su nombre Go); `goFileName` lee una sigla en plural como una palabra (`get_products_by_ids_query.go`, antes `…_by_i_ds_…`).
  - **Lo que en Go toma otra forma**:
    - **Sin mediator.** En los otros tres un mediator busca el handler de un mensaje en tiempo de ejecución; en Go sería reflexión en el camino de la petición. El registro es un struct generado, `UseCases`, con un campo TIPADO por operación (`Handler[CreateProductCommand, CreateProductResponseDto]` o `CommandHandler[ActivateProductCommand]`): un mensaje no puede llegar a otro handler porque no compila. Lo que el mediator añadía —el log de frontera y, con la persistencia, la transacción— es un decorador genérico (`observe`/`observeCommand`), como un middleware de net/http, que `NewUseCases` pone al cablear. La clase del mensaje (`KindQuery`, `KindReturningCommand`, `KindCommand`) va en ese cableado.
    - **Log de frontera**: Debug si salió bien, Info si el dominio lo rechazó (con su `code`, por `errors.As` contra `*domain.Error`) y Error si falló, solo con el tipo del error más interno: el error en sí lo registra el borde (§ 3.2). Nunca los valores del mensaje.
    - **Mensaje y handler, en dos archivos.** El plan decía «un archivo por caso de uso»; pero el mensaje lo escribe build (cabecera de código generado) y el handler el agente (sin ella), y en un solo archivo refrescar el mensaje pisaría la lógica. El mensaje es el cuerpo HTTP: tags con el nombre del cable, `json:"-"` en lo de la ruta y en `page`/`size`; un opcional de PATCH es `wire.Optional[T]` con `omitzero`; un campo con default, un puntero.
    - **El handler nace fallando** con `fmt.Errorf("%w: %s", ErrNotImplemented, "<operación>")`, no con un panic, y con las notas del diseño (precondiciones, reglas, errores con su centinela y `domain.Errorf`/`StatusErrorf`, transiciones, eventos con `raise(New…Event(...))`).
    - **El despacho** (`use-cases.dispatches`): el handler recibe `*UseCases` (con `//lint:ignore U1000` hasta que el agente lo use) y despacha por el campo de la operación invocada, que lleva su decorador. `dispatchNote` de keel-core gana `port` y `withoutTransaction` como parámetros y `call` como función, con los defaults de antes: los golden de spring (46) y nest (43) no cambian un byte. La variante sin transacción llega con la persistencia (inc. 6).
    - **Mapeos**: funciones `To<Dto>` en un archivo por entidad (`product_mapper.go`; la hija en el suyo, una sola vez aunque la alcancen dos raíces). Lo que no se deriva entra por parámetro (embed, needs, id del padre, filas de la inversa). Un campo que build no sabe mapear hace que esa función devuelva además un error con el campo nombrado (y que lo propaguen las que la llaman); el archivo que lo lleva es del agente. Un mapeo completo no declara un error que nunca devuelve. El puntero de un opcional sale con `new(expr)` (Go 1.26).
    - **DTOs**: struct con el nombre del cable en el tag y el orden del diseño; con `conventions.nulls: omit`, `omitzero` en lo opcional y nunca en una lista. `PagedResponse[T]` con las claves de `WIRE_SHAPES`; `FileUpload` sin JSON. Una variante recortada se construye con `To<Variante>(source)`.
  - **Medido**:
    - `npm test` de keel-go 256/256. `test/application.test.js` (60): en las 17 fixtures, los mensajes y su clase son los que EMITEN keel-nest y keel-dotnet, cada DTO lleva las claves de keel-dotnet en el mismo orden, y cada operación tiene su campo, su cableado, su fila en la prueba emitida y su handler fallando con su nombre; más omit, PATCH, página, notas, despacho, el mapeo con hueco y la frontera de imports.
    - La frontera: `use-cases` deja de avisar; avisan por operación `idempotency`/`schedule` (inc. 10) y `cache` (inc. 13), como keel-dotnet.
    - **`go-check` 56/56**, con la prueba emitida `use_cases_test.go` en verde y **cuatro sabotajes** (`test/helpers/application-sabotages.js`), cada uno en rojo con exactamente su prueba: una operación sin cablear, el decorador que se traga el error, el que devuelve el valor cero y el rechazo registrado como fallo. `test/application-sabotages.test.js` comprueba sin Go que se siguen aplicando. Las 17 fixtures pasan tidy, gofmt, vet, staticcheck y sus pruebas; `-race` en `golang:1.27.3`.
    - keel-core 1306/1306, keel-nest 861/861, keel-dotnet 819/819; golden de keel-spring (46) y keel-nest (43) idénticos.
  - **Pendiente del 4b, con motivo**: `scalePolicy: round` en un decimal ESCALAR de entrada se redondea en el `UnmarshalJSONFrom` del mensaje, pero ninguna fixture lo declara (las que redondean lo hacen en un value object), así que esa rama solo la mide `application.test.js` sobre el texto, sin compilar. El cableado no se usa todavía desde `run`: lo enchufa la API (inc. 5).
- **Inc. 5 — hecho (2026-10-29): la API REST.** Cuatro emisores sobre `internal/httpapi` (un paquete) y uno de plataforma: `endpoints.js` (un endpoint y un lector por operación, en `<grupo>_endpoints.go`, y la tabla `routes`), `rest-support.js` (`errors.go`, `reading.go`, `validation.go`, `reply.go`, `middleware.go`), `api-tests.js` (`api_test.go` y `edge_test.go`) y `correlation.js` (`internal/platform/correlation`). `NewHandler(probes, useCases, logger)` registra cada fila de `routes` en el ServeMux, un patrón `/` para el 404 y el 405 con `ErrorResponse`, y envuelve todo con el borde; `run` construye `UseCases` con el logger, que escribe el `correlationId` de cada petición (`correlation.LogHandler`). El OpenAPI derivado entra con `derivedOpenapiFiles`, como en los otros tres. La frontera deja de avisar por la API.
  - **Lo que en Go toma otra forma**:
    - **Un endpoint DEVUELVE su error** (`func (a *api) createProduct(w, r) error`) y un solo punto, `writeError`, lo traduce con `errors.As`: lectura, parámetro ausente, validación, el 413 y `*domain.Error` (su `Status()`, su `code` y el error y el mensaje por defecto de su categoría, de `api-errors.js`; un status sin categoría, con su frase HTTP). Lo demás —`ErrNotImplemented` incluido— es el catch-all 500, el único que se registra con el error entero.
    - **La tabla `routes` es datos con su handler**: `{Operation, Method, Path, Status, Location, Query, Body, handle: (*api).createProduct}`, una expresión de método. `Routes()` devuelve una copia; la paridad la lee del Go emitido.
    - **El 404 y el 405 no son de net/http** (texto plano): un patrón `/` pregunta al propio mux con `mux.Handler` qué métodos casan con ese camino; si alguno, 405 con su `Allow`.
    - **El borde** abre la correlación, pone `http.MaxBytesReader` y recupera un pánico como un 500 con su pila en el log (relanza `http.ErrAbortHandler`). La regla `no-panic` de `go-idioms` admite ahora RELANZAR lo que la misma función recuperó con `recover()`, y solo eso (caso propio en `go-idioms.test.js`).
    - **Los auxiliares se emiten bajo demanda**: staticcheck (U1000) rechaza una función sin usar, así que `endpoints.js` apunta en `plan.uses` lo que pide cada lector (`member`, `textUUID`, `pageParam`, `textLength`…) y `rest-support.js` emite solo eso, con sus dependencias. `api.test.js` lo vigila en las 17 fixtures en las dos direcciones.
  - **Medido antes de decidir** (Go 1.27.3):
    - **json/v2 llama a `UnmarshalJSONFrom` también con `null`.** Leer el cuerpo de golpe sobre el mensaje hacía pasar `"price": null` por `NewMoney`: «Petición malformada» donde keel-spring dice `price must not be null`. El lector lee el cuerpo como objeto (`map[string]jsontext.Value`) y cada miembro presente y no nulo sobre su campo (`member`), como el `JsonBodyReader` de keel-dotnet; un opcional de PATCH, con `optionalMember` (ausente, null o valor). Prueba emitida y sabotaje propios (`null-member`).
    - **El objeto no se lee con las opciones del cable**: su conversor de `jsontext.Value` lee el documento DESDE una cadena (para los campos `json`) y se aplicaba a cada miembro. El objeto va con json/v2 a pelo (solo `AllowDuplicateNames`); los miembros, con `wire.Unmarshal`.
    - **`format:emitnull` no existe en el json/v2 estable**: `Details` es un tipo con su `MarshalJSONTo` que escribe `null` sin detalles.
    - **tree-sitter-go no lee `new(expr)` con una llamada** (Go 1.26); con un identificador, sí. Se escribe `code := …; &code`.
  - **Decidido sin oráculo, con su motivo**: el tope del cuerpo es `MaxBodyBytes = 30_000_000` (el de Kestrel) y pasarse es 413 `Payload Too Large` sin code, con un texto nuevo en `api-errors.js` (`bodyTooLarge`). Tomcat no limita un cuerpo JSON, y el tope de Kestrel o de Fastify cae en el manejador de cada uno sin texto propio; net/http no pone ninguno, así que keel-go lo declara. `api-errors.test.js` vigila ya también que keel-go no escriba a mano ningún texto.
  - **Medido**:
    - `npm test` de keel-go 340/340. `test/contract-parity.test.js`: en las 17 fixtures (sin las capas que la frontera rechaza, y keel-spring sobre el mismo diseño), la tabla `routes` dice lo mismo que los controladores de keel-spring —método, ruta, status, `Location`, query y cuerpo— y cada DTO de respuesta lleva sus campos. `test/openapi.test.js`: el documento es el de keel-spring y keel-nest byte a byte y describe las rutas registradas. `test/api.test.js`: textos, auxiliares sin usar o sin emitir, el orden del lector y el PATCH de tres estados.
    - **La red de fixtures destapó un defecto antes de la corrida**: `*msg.Amount.Cmp(...)` se lee `*(msg.Amount.Cmp(...))` (payment-checkout, una cota sobre un decimal opcional). Ahora se desreferencia entre paréntesis antes de la llamada.
    - **El import plantado de go-check cerraba un ciclo**: dominio → httpapi, ahora que httpapi importa el dominio, y Go lo rechazaba antes de que la prueba de arquitectura dijera nada (el paso salía rojo por otro motivo). Se planta dominio → `platform/health`, también prohibido y sin ciclo.
    - **`go-check` 68/68**, con `-race` en `golang:1.27.3` (podman), con las pruebas emitidas de la API en verde y **diez sabotajes** (`test/helpers/api-sabotages.js`), cada uno en rojo con exactamente su prueba: el 405 que sale 404, la correlación ignorada, `details` como `[]`, `notBlank` que deja pasar espacios, el `null` que llega al constructor, el cuerpo sin tope, el uuid laxo, el pánico tragado, el error del dominio como 500 y el 500 sin log. `test/api-sabotages.test.js` comprueba sin Go que se siguen aplicando. El binario arrancado responde el 404 con `ErrorResponse` y una operación sin escribir con su 500 y su `correlationId`.
    - keel-core 1306/1306; golden de keel-spring (46) y keel-nest (43) idénticos.
  - **Pendiente del 5, con motivo**: la subida multipart (capa storage, inc. 13) —sus operaciones no se sirven, y la capa se rechaza entera—; la identidad del llamante (`resolvedIdentity`) se deja sin leer con una nota hasta la seguridad (inc. 8); con persistencia, la página será el `Pageable` de Spring Data (`page`, `size`, `sort`), y hoy son dos enteros.
- **Inc. 6 — en curso, en cuatro tramos**: 6a el esquema (PostgreSQL), 6b los repositorios, la unidad de trabajo y goose al arrancar, 6c `db-check` con los adaptadores, 6d MySQL. keel-core no se toca en ninguno de los cuatro salvo que falte una decisión neutral.
- **Inc. 6a — hecho (2026-10-29): el esquema.** `src/scaffold/persistence.js` emite `internal/infrastructure/postgres/` (`doc.go`, `migrations.go` con las migraciones embebidas en un `embed.FS` y `migrations/00001_baseline.sql`) y `internal/domain/pageable.go`.
  - **Lo que en Go toma otra forma**:
    - **El esquema lo escribe build, en SQL.** En los otros tres sale de un ORM (Hibernate, TypeORM, EF Core) y el baseline lo exporta una herramienta; keel-go no tiene ORM, y el esquema ya es dato neutral (`relational.js`). La migración baseline de goose lleva el esquema entero (Up) y su vuelta atrás (Down), con la cabecera de código generado.
    - **El tipo físico de cada columna es el que Hibernate da al mismo tipo Java en PostgreSQL** (`physicalType`): `varchar(255)` sin cota, `numeric(38,2)` sin escala declarada y `numeric(19,s)` con ella, `timestamp(6) with time zone`, el enum por su constante en `varchar(255)`, `text` para `text` y `json`. Así la base de un servicio keel-go es la de su gemelo de keel-spring, y `infra/fixtures.sql` vale para los dos. No se emite el `CHECK` de enum que añade Hibernate 6+: no lo tienen keel-nest ni keel-dotnet.
    - **La unicidad de la clave natural y de un `unique` es una constraint de tabla** (el `@UniqueConstraint` de keel-spring); la de un índice declarado, un índice único con nombre; la condicionada, un índice parcial con el predicado de `partialIndexSpecs`.
    - **Las FK dentro del agregado borran en cascada** (hija → padre, elemento → raíz), como el `DeleteBehavior.Cascade` de keel-dotnet; las que van a otro agregado, NO ACTION, como el baseline de keel-spring. Todas al final con `ALTER TABLE`: el orden de las tablas no importa.
    - **Con persistencia, la página es el `Pageable` de Spring Data** (`domain.Pageable`, `SortOrder`, `SortAsc`/`SortDesc`): el mensaje lleva `Pageable domain.Pageable` y el lector `pageableParam` la lee con la semántica indulgente del `PageableReading` de keel-dotnet (ilegible → default, negativa → 0, tope, `sort=a,b,desc` repetible), con los defaults y el orden de `keel-core/gen/pagination.js`. La fila de `routes` pasa a `page`, `size`, `sort`.
  - **La frontera**: la persistencia relacional entra avisando de que faltan los repositorios (6b); la documental se rechaza con el incremento 12, y el motor solo puede ser PostgreSQL (`SUPPORTED_DATABASES`; MySQL en 6d). `pendingLayers(layers)` quita la persistencia solo al diseño documental, así que las paridades ven ya el esquema de las fixtures relacionales.
  - **Medido**:
    - `npm test` de keel-go 356/356. `test/schema-parity.test.js` (nuevo, con el lector `test/helpers/schema.js` sobre el SQL): en las 12 fixtures relacionales, mismas tablas, columnas (nulabilidad, cota, escala), nombres de constraint, índice y FK y predicados que lo que EMITE keel-spring, más la derivación del value object opcional. Las tablas de mecanismos que keel-go todavía no genera (`idempotency_record`, `reconciliation_claim`, `outbox_event`, `processed_event`) se descuentan con su incremento (`MECHANISM_TABLES`). Falsado con cuatro sabotajes aislados: la cota +1 tumba 11 fixtures, un índice de FK de menos 3, la nulabilidad del value object la derivación y el nombre de la FK 3.
    - **`npm run db-check` (nuevo) 16/16** contra `postgres:16-alpine` en podman: el baseline de cada fixture relacional se aplica a una base vacía, el catálogo del motor (`information_schema`, `pg_constraint`, `pg_indexes`) dice lo mismo que el SQL emitido —columnas, nombres y el predicado del índice parcial de notification-mailer— y Down la deja vacía. Falsado aplicando una migración sin un índice de FK (`-ix_categories_parent_id`).
    - **`go-check --fixtures` 18/18**: las 17 fixtures, con el paquete `postgres` y el lector del `Pageable`, pasan tidy, gofmt, vet, staticcheck y sus pruebas.
    - keel-core no se toca: golden de keel-spring y keel-nest sin cambios.
  - **Pendiente del 6a, con motivo**: la relación a-uno interna sin vuelta y el value object anidado no los declara ninguna fixture persistida (keel-dotnet los deja como TODO): el esquema emite la columna y la FK de la primera y una nota en el SQL para el segundo, sin red que lo mida. **El baseline lo reescribe build** mientras el diseño cambie; cuando haya un despliegue, un cambio de diseño tiene que ser una migración nueva y no otra baseline: eso es del incremento 15 (evolución).
- **Inc. 6b — hecho (2026-10-29): repositorios, transacción y goose al arrancar.** Dos emisores nuevos: `src/scaffold/repositories.js` (el puerto `<Raíz>Repository` en `internal/domain`, el adaptador `postgres.<Raíz>Repository` y `values.go`) y `src/scaffold/persistence-runtime.js` (`config/parameters/<perfil>/db.yaml`, `database.go`, `transactions.go`, `errors.go` y el paquete `internal/platform/textfold`). `go-stack.js` gana `github.com/jackc/pgx/v5` v5.11.0 y `github.com/pressly/goose/v3` v3.29.0 (MIT los dos), y `golang.org/x/text` v0.43.0 (BSD-3-Clause) solo con un pliegue de acentos; `requiresFor(model)` los pide según el diseño.
  - **Lo que en Go toma otra forma**:
    - **Un finder devuelve `(*E, bool, error)`**: «no está» es una respuesta y no un error del adaptador, y el caso de uso decide qué `code` del diseño significa. Nunca `nil, nil`.
    - **Guardar es fusionar**, como el merge de Hibernate: la raíz con su versión (`UPDATE … WHERE id = $n AND lock_version = $m`; cero filas es `errStaleVersion`, que `translate` convierte en el 409 de concurrencia); las hijas que ya no están se borran (`NOT (id = ANY($2::uuid[]))`, y lo que cuelga de ellas cae en cascada) y las demás se insertan o actualizan con `ON CONFLICT (id) DO UPDATE`; una lista de valores se reescribe entera, como la `@ElementCollection` de JPA. Lo guardado se RELEE en la misma transacción.
    - **Hijas y listas, una consulta por tabla** para todas las raíces leídas (`= ANY($1::uuid[])`), siempre con el cursor anterior cerrado: en una transacción la conexión es una sola.
    - **Un enum se guarda por el NOMBRE de su constante** (el `@Enumerated(STRING)` de keel-spring), que no tiene por qué ser su valor en el cable: `<enum>Columns` y `parse<Enum>Column` en `values.go`. La sombra de rango de un enum ordenable, por su posición en la declaración.
    - **La transacción viaja en el contexto.** `application.Transactor` (lo implementa `postgres.Transactions`) lo usa el decorador `observe`: solo lectura para `KindQuery`, escritura para lo demás, y el log de frontera FUERA (cuenta lo que vio el cliente, confirmación incluida). Los repositorios se unen a ella sin verla (`DBTX`); sin ella, cada lectura va sola y cada escritura abre la suya. `SET LOCAL statement_timeout` es el tope; un `40P01`/`40001` repite la transacción entera hasta `WRITE_CONFLICT_ATTEMPTS` y, agotado, es el 409 de concurrencia. **Un error tras el handler (el commit) devuelve el valor cero**: lo que no se confirmó no sale.
    - **El despacho sin transacción es un contexto marcado**: `application.WithoutTransaction(ctx)`. `Transactions.Within` no abre ninguna y `openTx` ignora la abierta, así que cada escritura del despachado confirma la suya. La nota de `dispatchNote` lo nombra.
    - **Los adaptadores llegan por `application.Dependencies`** (`Transactor` y un campo por raíz), que construye `cmd/server` y solo él; cada handler recibe en su constructor el repositorio de su agregado (`repositoryOf`), con `//lint:ignore U1000` hasta que el agente lo use. Sin persistencia, `NewUseCases(logger)` como antes.
    - **Los errores del motor**, por el NOMBRE de la constraint con `constraint-errors.js`: los códigos que el diseño no declara (`CONCURRENT_MODIFICATION`, `TRANSACTION_TIMEOUT`, la unicidad canónica `<ENTIDAD>_<CAMPOS>_ALREADY_EXISTS` y la violación desconocida, 409 SIN code) son centinelas del dominio (`persistenceSentinels` en `errors.js`). El borde responde un `*domain.Error` sin code con `"code": null`, y el 503 del tope con `Retry-After: 1`.
    - **db.yaml** lleva las claves y valores de keel-dotnet salvo `schema:`: aquí el esquema lo gobiernan SIEMPRE las migraciones, en todos los perfiles (goose al arrancar, serializado por su tabla de versiones). La URL JDBC de keel-spring vale tal cual. El perfil `test` no tiene base: `run` arranca y un repositorio usado devuelve `errDisabled`.
    - **`database/sql` no tiene espera de pool**: `connection-timeout-ms` es el `connect_timeout` de libpq (redondeado a segundos) y el plazo del ping del arranque.
  - **La frontera**: la persistencia relacional deja de avisar. Se rechazan, con su motivo (ninguna fixture con persistencia las declara: sin red que mida su mapeo), la relación interna a-uno SIN vuelta, la many-to-many dentro del agregado y el value object persistido con otro dentro o con un campo opcional. Se leen del MODELO (`unmeasuredShapes`), que es quien sabe qué relación es interna.
  - **Medido**:
    - `npm test` de keel-go 419/419. `test/repositories.test.js` (62): en las 12 fixtures relacionales, el traductor conoce EXACTAMENTE las constraints del `PersistenceErrors` de keel-dotnet y cada una sale con el centinela de `constraint-errors.js`; `db.yaml` de los cuatro perfiles dice lo mismo que el de keel-dotnet; un puerto por raíz con su adaptador (`var _ domain.XRepository = …`), el arranque que los cablea y migra, cada handler con el repositorio de su agregado, y `go.mod` con pgx y goose (x/text solo en catalog-extended). `test/domain.test.js` descuenta los centinelas de persistencia de la paridad de errores del dominio, con su motivo.
    - **`go-check --fixtures` 18/18**: las 17 fixtures, con las hijas de catalog-extended (con su pliegue de acentos y su rango de enum), las listas de valores y de value objects de notification-mailer, los ids `long` y `string` de shop-api y la versión declarada, pasan tidy (sin mover un directo), gofmt, vet, staticcheck y sus pruebas. La red cazó dos defectos antes de ejecutar nada: la versión no se leía (el siguiente guardado habría sido un INSERT) y la sangría del bucle de las listas.
    - **`go-check` 71/71**, con `GO_READY_DESIGN` ya CON persistencia: el binario arranca en el perfil `develop` contra un PostgreSQL efímero (podman), goose aplica la baseline al arrancar (`goose_db_version` y la tabla `products`) y las sondas y la API responden como antes. `-race` en `golang:1.27.3`.
    - keel-core no se toca: golden de keel-spring y keel-nest sin cambios.
  - **Trampa que costó un ciclo**: en esta máquina, escribir código con barras invertidas a través de la shell (heredoc a Python, JSON o un script de node) las pierde o las convierte (un `\b` de expresión regular salió como un carácter de retroceso, y un `'\n'` como un salto de línea real dentro de una cadena). Las ediciones con escapes, siempre con la herramienta de edición.
  - **Pendiente del 6b, con motivo**: nada de lo emitido se ha EJECUTADO contra la base todavía (el SQL de cada adaptador, la versión, la fusión de hijas, la traducción de una violación): es el 6c. Sin API, el arranque no construye los casos de uso (metering-digest), así que tampoco abre la base: llega con el reloj (inc. 10).
- **Para retomar (cada incremento empieza en un contexto nuevo):** el siguiente es el **6c**: `db-check` con los ADAPTADORES contra un PostgreSQL real, como el de keel-dotnet (`keel-dotnet/scripts/db-check.js` y `scripts/lib/db-probes.js`). Al abrirlo:
  - Una sonda Go generada desde el modelo por sujeto (las 12 fixtures relacionales), escrita como prueba interna de `internal/infrastructure/postgres` y ejecutada con `DB_URL` apuntando al contenedor: `Save` de un agregado nuevo y releído campo a campo, la versión que sube, el `UPDATE` con versión obsoleta → el centinela de concurrencia, cada constraint de `constraintErrors` violada → su centinela, la fusión de hijas (una quitada, una cambiada, una nueva) y las listas en su orden, `List` con su orden y el desempate, y `FindAllByID`/finder por lote. Cada mecanismo falsado con un sabotaje aplicado EN MEMORIA antes de generar (la lección del 16e de keel-dotnet: una red que reconstruye lo que mide no lo falsa).
  - Los finders de búsqueda (DSL 2.22, `keel-core/gen/query-filters.js`) no se emitieron en el 6b: entran en el 6c, con su red (`finder-designs.js` y `--sabotage=finder-*`).
  - El tope de transacción (503) y el interbloqueo repetido se miden ahí también (dos transacciones cruzadas, como `transaction-limits` de keel-spring).
  - Para generar una fixture a mano sin pasar por la puerta: `planService({ ...loadService(dir), workspace: FIXTURES_DIR })` y escribir sus `files` (lo que hace `go-check --fixtures`).
  - `go-check` necesita la máquina de podman en marcha (para `-race` y ahora también para el PostgreSQL del arranque). Dura ~15 min, casi todo en las 17 fixtures (`--fixtures` solo ese paso).
  - Decidir `usesCallerIdentity` cuando keel-go llegue a seguridad (inc. 8), no antes.

MariaDB, SQL Server y Oracle se quedan rechazados con su motivo hasta que una red los mida, como en keel-nest.

## 6. Riesgos conocidos

- **El cable.** Cerrado en el inc. 3: `Decimal` propio sobre `math/big` y `encoding/json/v2`, medidos y falsados. Nunca `float64` para importes.
- **`nil` frente a vacío.** Cerrado en el inc. 3: json/v2 escribe `[]` para un slice `nil`, y la prueba emitida lo fija (sabotaje `list-null`).
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
- `npm run go-check --workspace packages/keel-go` (Go + podman) en verde en todas las fixtures que admita la frontera: tidy sin mover un directo, `gofmt -l`, `go mod tidy -diff` y `staticcheck` vacíos, `go vet` limpio, `-race` en verde.
- `test/go-idioms.test.js` en verde y cada regla falsada por su mutación.
- Hitos end-to-end en los incs. 7 y 12, y control final en el 16: `/keel-generate-go` sobre el par MVP con el 100 % de los `FL-*`, registrado en `docs/corridas/` con `corrida-metrics.js footprint`, y `keel-go-quality` en verde sobre lo que escribió el agente.
- `licenses.test.js` y `infra/check-licenses.sh` siempre en verde. Un módulo GPL añadido a `go-stack.js` —también como herramienta— debe ponerlos en rojo (se falsa en el inc. 2).
