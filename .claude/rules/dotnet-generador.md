---
paths:
  - "packages/keel-dotnet/**"
---

# El generador keel-dotnet

Detalle movido desde `CLAUDE.md` para que solo cargue al trabajar en `packages/keel-dotnet/`. El índice de una línea por
caso sigue en `CLAUDE.md` § Dónde se añade cada cosa. Cómo se construyó y con qué se midió cada incremento:
`PLAN-KEEL-DOTNET.md`.

## Principios y stack del proyecto generado

Tercer generador, construido en 16 incrementos medidos bajo la misma regla que keel-nest: **el mismo diseño genera con
keel-spring, keel-nest o keel-dotnet servidores equivalentes**. No copia nada de los otros dos: importa de `keel-core/gen`
la interpretación del diseño (`buildModel` con su proyección `src/lib/cs-projection.js`), la puerta, el stack, la escritura
con manifiesto y la evolución, y solo tiene sus renderizadores (`src/scaffold/`, con un solo mapa de proyectos y
namespaces en `render.js`). Su frontera se declara en código (`src/lib/supported-features.js`) y, cerrado el plan, solo
rechaza lo que tiene MOTIVO escrito (ver § Cierre).

El proyecto generado es una solución .NET 10 con **un proyecto por capa** (Domain, Application, Infrastructure, Api y las
pruebas): la frontera hexagonal la impone el compilador con las referencias entre proyectos. Pruebas con xUnit v3 sobre
**Microsoft.Testing.Platform** (`global.json` lo declara: con el SDK 10, xUnit v3 4.x ya no corre por VSTest). Los tests
derivan sus diseños de las fixtures compartidas (`test/helpers/workspace.js`, `DOTNET_READY_DESIGN`).

## Licencias

**Ninguna librería con licencia comercial**: nada de MediatR ≥ 13, AutoMapper ≥ 15, MassTransit ≥ 9, FluentAssertions ≥ 8.
Cada paquete NuGet lleva versión exacta y licencia SPDX en `src/lib/dotnet-stack.js`, que vigila `test/licenses.test.js`;
`cs-check` comprueba además, contra el catálogo de nuget.org, la licencia de todo lo que NuGet resuelve, transitivos
incluidos. MimeKit trae `System.Security.Cryptography.Pkcs`, fijada a mano en la versión corregida (ver `dotnet-stack.js`).

## Persistencia relacional (incremento 6)

**EF Core 10 sobre PostgreSQL** (solo ese motor). Filas con mapeo fluente sobre `keel-core/gen/relational.js`
(`src/scaffold/persistence.js`; `test/schema-parity.test.js` compara su esquema con lo que EMITE keel-spring, con el lector
compartido `keel-spring/test/helpers/schema-table.js`). Puerto en `Domain/Repository` con adaptador de mapeo explícito
(`repositories.js`), transacción del caso de uso abierta por el mediator a través de `IUseCaseTransactions`, y errores del
motor traducidos por el nombre de la constraint (`persistence-runtime.js`). **Todo índice va NOMBRADO** en EF: sin nombre,
dos índices sobre las mismas columnas se funden. El baseline lo genera `dotnet ef` (herramienta local en
`.config/dotnet-tools.json`). La prueba emitida `PersistenceModelTests` construye el modelo de EF y su DDL sin base;
`npm run db-check` ejecuta los adaptadores contra PostgreSQL real.

## Persistencia documental (incremento 12)

Sobre **MongoDB.Driver** y **sin mapeo de clases**: cada adaptador escribe el `BsonDocument` de `keel-core/gen/document.js`
campo a campo (`src/scaffold/document-repositories.js`, con los valores de `BsonValues`), y la rama emite los MISMOS
nombres que la relacional (`DatabaseSettings`, `PersistenceTransactions`, `PersistenceErrors`, `AddPersistence`;
`src/scaffold/document-persistence.js`), así que lo de encima solo mira `usesPersistence`.

Los almacenes del generador sobre documentos (12c, `src/scaffold/document-stores.js`) conservan archivo, clase y API y solo
cambian el cuerpo: relay con `FindOneAndUpdate` y la marca caducable `claimed_at`, puente que inserta la fila del outbox en
la sesión del cambio, guarda y registro que INSERTAN sobre su `_id` subdocumento, reconciliación con upsert sobre la marca
caducada y purgas por lotes. El arnés de flujos gana `MongoEval` y los ayudantes del rescate y de la reconciliación con los
scripts de `keel-core/gen/mongo-probes.js` (12d, `src/scaffold/document-harness.js`), y la skill es `keel-dotnet-mongodb`:
el agente de calidad verifica los índices vivos con `export-indexes.sh` en vez de un baseline. Lo miden
`test/document-persistence.test.js` y `npm run doc-check` (MongoDB real en replica set, falsado con veintitrés sabotajes;
el orden del relay se mide con su índice retirado, porque el índice lo regala).

## Seguridad (incremento 8)

Un **middleware propio** delante de los endpoints (`HttpSecurityMiddleware`), no la autorización de ASP.NET Core ni
JwtBearer: decide como Spring Security antes de enrutar, con las reglas de `keel-core/gen/access-plan.js` como datos y el
JWT validado con `Microsoft.IdentityModel.JsonWebTokens`. Las pruebas emitidas firman con su propia clave
(`TestCredential.cs`) y el arnés pide los tokens a `infra/test-credentials.env` (`Support/Credentials.cs`); lo miden
`test/security-parity.test.js` y `npm run security-check`.

`resolvedBy` (12e-a): el finder `FindBy<Campo>Containing` en los dos adaptadores y `CallerIdentityResolver`, que el endpoint
llama antes de despachar (`test/caller-resolution.test.js`). El diseño escribe `resolvedBy` como texto (`Entidad.campo`):
léelo con `resolvedByOf` de `repositories.js`, nunca como objeto — la nota del mensaje del broker salió con `undefined` así
hasta la corrida de control del 2026-10-18.

## Mensajería (incremento 9)

Los tres brokers de keel-nest y la MISMA configuración, byte a byte, desde `keel-core/gen/messaging-plan.js`: RabbitMQ con
**RabbitMQ.Client** (`rabbitmq.js`), Kafka con **Confluent.Kafka** (`kafka.js`; la licencia de su nativo
`librdkafka.redist` va leída a mano en `VERIFIED_LICENSES`) y SNS/SQS con el **SDK oficial de AWS v4** (`snssqs.js`; la
topología la siembra el `infra/init-messaging.sh` neutral). Nada de MassTransit. Lo que escribe el agente se registra en
`Messaging/BrokerBindings.cs` (skills `keel-dotnet-rabbitmq`, `-kafka`, `-snssqs`); lo mide `npm run broker-check`.

## Reloj, purgas, reclamos y parámetros (incremento 10)

Reloj y purgas (10b) con un `BackgroundService` propio sobre **Cronos** (`src/scaffold/scheduling.js`, `purge.js`): el
segundo repartido y el despacho los decide `keel-core/gen/scheduling.js`, y `test/scheduling.test.js` los compara con el
`Scheduler.java` que EMITE keel-spring; las purgas las mide `db-check`. Los reclamos de barrido y el rescate (10c,
`src/scaffold/claim.js`) y los parámetros de despliegue (`service-parameters.js`) son los de keel-nest sobre EF Core; el
reclamo se niega a correr dentro de una transacción abierta (`RequireOwnTransaction`), y lo miden `test/claim.test.js` y
`db-check`.

El gate `infra/check-idempotency.sh` (10d) es el motor de `keel-core/gen/idempotency-gate.js` con la matriz de C# de
`src/scaffold/idempotency-check.js`, y su plataforma declara `excludeDirs: ['bin', 'obj']` y `typesPerFile: 'many'` (sin
ellas salía rojo sobre corridas correctas); lo EJECUTA `test/idempotency-check.test.js`.

## Clientes HTTP salientes y reconciliación (incremento 11)

Los clientes (11b, `src/scaffold/http-clients.js`) van sobre **HttpClient**, sin Polly: el circuito es la máquina de
resilience4j escrita en C# y la prueba emitida `OutboundClientsTests` la recorre contra la secuencia que build genera con
`circuitBreakerReference`; el fallback es un filtro de excepción con los fallos de `keel-core/gen/outbound-resilience.js`,
y `http-clients.yaml` es el neutral de `keel-core/gen/http-clients-config.js` (el de keel-nest). El value object compuesto
de una respuesta saliente se lee con el MISMO `ValueReaders.Read<Tipo>` de la entrada (`ResponseReading.Composite`), y lo
que rechaza es un `OutboundContractException`. Lo miden `test/http-clients.test.js` y `cs-check --fixtures --sabotage=<id>`.

El reclamo de reconciliación (11c, `src/scaffold/reconciliation-claim.js`) pone su marca en `reconciliation_claim` con UNA
sentencia `INSERT … ON CONFLICT DO UPDATE … WHERE` (en PostgreSQL un error aborta la transacción) y su lectura excluye los
candidatos de marca viva; lo miden `test/reconciliation.test.js` y `db-check`.

## Correo (capa `mail`, adelantada al 12e)

`src/scaffold/mail.js`: build genera también el adaptador SMTP sobre **MailKit** (un `SmtpClient` que apunta el
destinatario rechazado en vez de abortar: así se dice el envío parcial) y el renderizador sobre **Handlebars.Net** (dos
entornos propios con un `ITextEncoder` de la tabla cerrada de `keel-core/gen/mail-message.js`), la guarda contra el doble
envío `ClaimFor<Op>` (UPDATE condicional en un ámbito y una transacción propios; en documental, `FindOneAndUpdate` sin la
sesión del caso de uso), la familia `mailDelivery` del gate, el buzón en `Support/Mail.cs` (`mail-harness.js`) y la skill
`keel-dotnet-mail`. Lo miden `test/mail.test.js`, `npm run mail-check` (Mailpit real) y la sonda de la guarda de
`db-check`/`doc-check`.

## Pagos (incremento 13)

`src/scaffold/payments.js` (lo neutro, con `payments.yaml` de `keel-core/gen/payments-config.js`, el mismo de keel-nest) y
`src/scaffold/payment-gateways/{stripe,mercadopago}.js` sobre `HttpClient` SIN reintentos tampoco por debajo (la guarda de
conexión de `HttpExchange`), el aviso leído como texto en `Api/Rest/PaymentNoticeEndpoint.cs`. Lo EJECUTAN las pruebas
emitidas `PaymentGatewayTests` y `PaymentNoticeEndpointTests` en `cs-check` (variante `payment-checkout-mp` para
MercadoPago, `--sabotage=payment-*`) y lo compara `test/payments.test.js`; el arnés de la pasarela es
`Support/PaymentGateway.cs` (`src/scaffold/payment-harness.js`, compilado solo y medido contra un WireMock real con las dos
pasarelas en `stub-check`), y las skills son `keel-dotnet-payments` y la de la pasarela.

## Caché, almacenamiento y autoría (incremento 13)

Caché (13f, `src/scaffold/cache.js`): el puerto `IOperationCache`, `CachedOperations` y en `Infrastructure/Cache` el
adaptador y el store sobre **StackExchange.Redis** (`BacklogPolicy.FailFast`: la rama 3.x encola por defecto), con
`CacheCodec`, que lee sin exigir presencia porque una respuesta con `nulls: omit` se guarda sin esos campos; la
invalidación la aplica el `UseCaseMediator` con `CacheInvalidations` y `AfterCommitOrNow`; `cache.yaml` es el neutral de
`keel-core/gen/cache-config.js`. Lo miden la prueba emitida `OperationCacheTests`, `test/cache.test.js` y
`npm run cache-check`.

Almacenamiento (13g, `src/scaffold/storage.js`), con el reparto de keel-spring y keel-nest: build emite el contrato en
`Domain/Storage` (`IFileStorage` con los métodos de lectura según la visibilidad, `BucketPolicy.AllowsContent` con la firma
de `keel-core/gen/content-signatures.js`, `StoragePolicies`), `storage.yaml` (el neutral de
`keel-core/gen/storage-config.js`), el registro y el stub `S3FileStorage` que completa el agente con **AWSSDK.S3** (skill
`keel-dotnet-s3`), y la entrada multipart `Api/Rest/MultipartReading.cs` (415, 413 con el code del diseño,
`FILE_UNREADABLE` y la parte que falta, con los textos de `keel-core/gen/api-errors.js`); el arnés gana `Upload(...)` y
`StopStorage`/`StartStorage`. Lo miden `test/storage.test.js` y los casos de subida de la prueba emitida `ApiTests`.

Autoría (13h): `AuditActor` (en `persistence-runtime.js`) con la regla del `AuditorAware` de keel-spring —el `sub` del
token, el cliente de la clave de API o `system[:<correlationId>]`—, ejecutada por la prueba emitida `AuditActorTests` y
medida contra la base con la sonda de autoría de `db-check` (sujeto derivado `product-catalog-authorship`) y `doc-check`
(`asset-vault`).

## Logs y telemetría (incremento 14)

Logs (14b, `src/scaffold/logging.js`): un `ConsoleFormatter` propio, texto en local y JSON ECS fuera, con el `logging.yaml`
neutral de `keel-core/gen/logging-config.js`. Telemetría (14c, `src/scaffold/telemetry.js`): OpenTelemetry sobre un
`ActivitySource` propio (`keel`, el único que escucha el proveedor: sin la instrumentación de ASP.NET Core, cuyo `Activity`
por petición no se exporta y dejaría huérfanos los spans que colgaran de él) y el scrape con **prometheus-net** (el
exportador Prometheus de OTel sigue en beta), con el `telemetry.yaml` neutral de `keel-core/gen/telemetry-config.js`;
storage y correo se observan con decoradores del puerto, y la métrica nunca lanza (alinea los valores con las etiquetas de
su serie). Lo mide la prueba emitida `TelemetryTests` en `cs-check` (variantes `<fixture>-otel`, `--sabotage=telemetry-*`)
y `test/telemetry.test.js`; en vivo, `telemetry-check` y `deploy-check`. La cola del pool de Npgsql lleva el prefijo
`npgsql`.

## Evolución (incremento 15)

`build --refresh --prune` deja `build/keel-refresh/EVOLUTION.md` con la lógica NEUTRAL de `keel-core/gen/evolution.js` y
los textos de `DOTNET_EVOLUTION` (`src/scaffold/evolution.js`); lo miden `test/design-evolution.test.js`, con paridad del
delta contra keel-spring y keel-nest, y `test/generated-propagation.test.js`.

## Cierre (incremento 16)

**La frontera.** Toda fixture entra entera, y `test/capability-coverage.test.js` exige el motivo de cada capacidad sin
fixture. Las ramas sin fixture son parches de `UNCOVERED_BRANCHES` (`test/helpers/workspace.js`) que recorren
`test/uncovered-branches.test.js` (que exige además que cada parche VALIDE) y `cs-check` como variantes. La mensajería sin
persistencia se rechaza en los tres con el motivo de `keel-core/gen/messaging-frontier.js`: sin adaptador de repositorio
nadie publica los eventos, y keel-spring y keel-nest generaban un servicio que no publicaba sin decirlo.

**La matriz** (`src/lib/engine-support.js`, `npm run matrix`) queda sin celdas `sin ejecutar` ni sin falsar. Una celda pasa
a `verificado` solo con la red que la ejecuta, y a `falsified: true` solo con el sabotaje medido. **La lección del 16e**:
una red que reconstruye lo que mide no lo falsa. `db-check` recalculaba las sentencias del rescate con `stallSql` de
keel-core en vez de ejecutar las del arnés emitido, y comparaba el predicado del índice parcial con el mapeo emitido (que
se daba la razón a sí mismo). Ahora la sonda del rescate lee el `Rescues` y el `IdLiteral` del `FlowTest.cs` emitido
(`emittedRescues` en `scripts/lib/db-probes.js`), el sabotaje se aplica EN MEMORIA antes de generar las sondas (así llega
al arnés de `tests/`) y el predicado se compara con `partialIndexSpecs` de keel-core.

**La corrida de control** del par del MVP en los tres generadores: 6×23/23 y huella 17
(`docs/corridas/2026-10-18-*-control.md`).

## Redes y trampas medidas

`npm run cs-check --workspace packages/keel-dotnet` (SDK 10, red y podman/docker, minutos) es la red que juzga lo emitido:
genera, restaura, compila sin warnings, prueba, comprueba licencias, genera el baseline con `dotnet ef` y ARRANCA el
proyecto. Las redes en vivo por mecanismo están en `CLAUDE.md` § Comandos.

- Un comentario XML con dos guiones seguidos hace que MSBuild descarte el `.props` entero **sin decir nada** (lo caza
  `test/scaffold.test.js`).
- En una plantilla de JS, un `${` literal del C# se evalúa como expresión.
- Bajo una ruta larga (> 260) Roslyn compila sin dejar la DLL (`MSB3030`): se genera en rutas cortas, y en una corrida bajo
  `spring-live-test/` el agente tuvo que acortar el `IntermediateOutputPath`.
- Los `using` van DENTRO del namespace (una entidad `Application` chocaba con el namespace `X.Application`).
- El `decimal` de .NET redondea EN SILENCIO por encima de 28 decimales: el conversor lo rechaza comparando escalas.
- EF 10 se niega a `Migrate` sin migraciones (cambios pendientes): `develop` necesita el baseline de `dotnet ef`.
