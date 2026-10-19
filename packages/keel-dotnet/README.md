# keel-dotnet

Generador .NET para diseños Keel, construido en 16 incrementos medidos (`PLAN-KEEL-DOTNET.md` en la raíz
del repo lleva su estado), cerrado con la corrida de control del par del MVP en los tres generadores. Su objetivo es el de los otros dos generadores: **el mismo diseño genera con
keel-spring, keel-nest o keel-dotnet servidores equivalentes** — mismo contrato HTTP, mismo cable, mismos
eventos, mismas tablas, misma operación.

```bash
keel-dotnet check specs/<servicio>   # opcional: no escribe nada, dice si el diseño es generable
keel-dotnet build specs/<servicio>   # desde el workspace de diseño; el diseñador elige el stack a mano
cd services/<servicio>-dotnet
/keel-generate-dotnet                # dentro del proyecto, SIN argumentos
```

`build` se niega sobre un diseño no listo (`keel validate --ready` en rojo) salvo `--accept-unready`, que queda
estampado en `keel-generated.json`, y no escribe nada en el workspace de diseño.

## El contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/` (manifiesto + capas), validado y listo
   (`keel validate --ready`; con `--accept-unready` se genera igual y queda estampado).
2. **Compatibilidad**: DSL `2.21`, la misma que keel-spring y keel-nest. Ante otra, se detiene.
3. **Salida**: `services/<servicio>-dotnet/`, una solución .NET 10 con un proyecto por capa (Domain,
   Application, Infrastructure, Api y pruebas), la configuración por perfiles en `config/` con el mismo
   formato y las mismas variables que los otros dos servidores, sus sondas `/livez` y `/readyz`, el
   snapshot sellado del diseño en `specs/` y lo que el agente necesita para completarla.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; lo que no sabe mapear lo
   rechaza o lo avisa en código (`src/lib/supported-features.js`), nunca lo ignora.

## La frontera, hoy (incremento 16 cerrado)

Toda fixture compartida se genera entera: el proyecto compila sin un solo warning, pasa sus pruebas emitidas y
arranca. Lo que build genera, capa a capa (el detalle de cada una, con sus redes, en `PLAN-KEEL-DOTNET.md`):

- **Contrato del cable** (`keel-core/gen/wire.js`) en las opciones JSON de la API; la prueba emitida
  `WireContractTests` ejecuta todos los casos compartidos con keel-spring y keel-nest.
- **Dominio y aplicación**: value objects con sus guardas, agregados con lifecycle, errores declarados, un mensaje y
  un handler por operación (el handler nace con su TODO y las notas del diseño) y un mediator propio, sin MediatR.
- **API REST** con Minimal APIs, `ErrorResponse`, paginación, `Location`, entrada multipart y el `docs/openapi.yaml`
  derivado, el mismo byte a byte que el de los otros dos.
- **Persistencia relacional** con EF Core 10 sobre PostgreSQL, y **documental** sobre MongoDB.Driver sin mapeo de
  clases; con los almacenes del generador (outbox, mensajes procesados, idempotencia de petición, reclamos, rescate,
  reconciliación y purgas por lotes) en los dos modelos.
- **Seguridad** con un middleware propio delante de los endpoints (Keycloak y Cognito), alcance por recurso,
  identidad del llamante y `resolvedBy`.
- **Mensajería** sobre RabbitMQ, Kafka y SNS/SQS, sin MassTransit.
- **Reloj** (`schedule`) sobre Cronos, **clientes HTTP salientes** sobre HttpClient con el circuito de resilience4j
  escrito en C#, `needs` (bajo demanda, `lastKnown` y réplica) y OAuth2 client-credentials.
- **Correo** (MailKit y Handlebars.Net), **pagos** (Stripe y MercadoPago sin SDK de pasarela), **caché** (Redis y
  Valkey), **almacenamiento** (S3/MinIO) y **autoría** de las escrituras.
- El **arnés** de flujos `FL-*`, `infra/`, `score-scenarios.sh`, `check-idempotency.sh`, los agentes y las skills
  `keel-dotnet-<tech>` del stack.
- **Logs** ECS, **telemetría** con OpenTelemetry y prometheus-net, el panel, las alertas y `deploy/`.
- La **evolución** de un proyecto ya generado: `build --refresh --prune` deja `build/keel-refresh/EVOLUTION.md` con
  el delta del diseño contra una base congelada (`keel-core/gen/evolution.js`, la misma lógica que los otros dos), y
  la skill entra en modo evolución.

Lo que **rechaza**, nombrando el motivo (`src/lib/supported-features.js`): los motores sin medir (MySQL, MariaDB, SQL
Server, Oracle), un value object compuesto en la URL o en una cabecera de una llamada saliente (no tiene forma ahí en
ningún generador; en el cuerpo y en la respuesta se genera desde el 16), una identidad del llamante que no sea texto y la
mensajería sin persistencia (sin el adaptador de repositorio no hay quién publique los eventos del agregado:
`PLAN-KEEL-DOTNET.md`, incremento 16). Avisa de la `idempotency` sin persistencia, que no tiene dónde registrar la clave.

Las ramas del DSL que ninguna fixture declara las genera un parche sobre una fixture real (`UNCOVERED_BRANCHES` de
`test/helpers/workspace.js`): `test/uncovered-branches.test.js` exige la rama en lo emitido y `cs-check` las compila y
ejecuta sus pruebas emitidas. `test/capability-coverage.test.js` exige que toda capacidad opcional la declare una fixture
o tenga su motivo escrito.

## Licencias

Ningún paquete con licencia comercial (MediatR ≥ 13, AutoMapper ≥ 15, MassTransit ≥ 9,
FluentAssertions ≥ 8…). Cada paquete que se puede emitir lleva su versión exacta y su licencia SPDX en
`src/lib/dotnet-stack.js`, y `npm run cs-check` comprueba, contra el catálogo de nuget.org, la licencia de
todo lo que NuGet resuelve, transitivos incluidos.

## Desarrollo

```bash
npm test --workspace packages/keel-dotnet       # sin SDK: el texto emitido, la proyección, la frontera, la paridad con keel-spring y keel-nest
npm run cs-check --workspace packages/keel-dotnet  # con el SDK 10 y red: restaura, compila, prueba, licencias y arranque, y la solución de TODAS las fixtures
npm run cs-check --workspace packages/keel-dotnet -- --fixtures  # solo la solución de todas las fixtures y las sondas del dominio
npm run cs-check --workspace packages/keel-dotnet -- --sabotage=decimal-scale  # falsa la prueba emitida: tiene que salir rojo
```

Sabotajes de `cs-check` (rompen lo emitido conservando la forma; el check tiene que salir rojo en las pruebas de esa
regla y solo en esas). Del proyecto: `decimal-scale`, `decimal-exact`, `timestamp-format`, `utf8`, `wiring`,
`correlation`, `method-405` y `not-blank`. De las fixtures (con `--fixtures`): los de los clientes salientes
(`circuit-strict`, `circuit-4xx`, `retry-all`, `idempotency-random`, `fallback-any`, `cancel-as-timeout`), los de
`needs` y OAuth2 (`need-fail`, `lastknown-window`, `lastknown-key`, `oauth-reuse`, `oauth-bearer`), los de pagos
(`payment-*`), los de las subidas (`multipart-limit`, `multipart-empty`, `signature-memory`) y `actor-name`.

`cs-check` compila además, en una sola solución, lo que se emite para **todas** las fixtures compartidas y ejecuta
sus pruebas emitidas y las sondas del dominio (`scripts/probes/`): C# de verdad que ejecuta el dominio generado
(escala, rechazos, formato, transición negada, orden del cable).

Las redes en vivo (SDK 10 y podman/docker), una por mecanismo; todas aceptan `-- --sabotage=<id>` para falsarse:

| Check | Qué mide |
|---|---|
| `db-check` | los adaptadores relacionales contra PostgreSQL real, con sondas generadas desde el modelo |
| `doc-check` | la persistencia documental contra MongoDB en replica set |
| `harness-check` / `doc-harness-check` | el arnés de flujos contra la `infra/` real, y cada código de `score-scenarios.sh` |
| `security-check` | la seguridad contra un Keycloak real |
| `broker-check` | la mensajería contra RabbitMQ, Kafka y LocalStack (`-- --broker=<id>` para uno) |
| `stub-check` | el proveedor de prueba y la pasarela de pago contra un WireMock real |
| `cache-check` | la caché contra Redis y Valkey |
| `mail-check` | el correo contra un Mailpit real |
| `telemetry-check` | la telemetría con la app arrancada contra PostgreSQL y un colector OTLP falso |
| `deploy-check` | `deploy/` entero y las preguntas al backend que comparten los tres generadores |
