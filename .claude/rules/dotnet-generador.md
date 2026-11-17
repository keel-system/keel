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

**EF Core 10 sobre PostgreSQL o MySQL**. Filas con mapeo fluente sobre `keel-core/gen/relational.js`
(`src/scaffold/persistence.js`; `test/schema-parity.test.js` compara su esquema con lo que EMITE keel-spring, con el lector
compartido `keel-spring/test/helpers/schema-table.js`). Puerto en `Domain/Repository` con adaptador de mapeo explícito
(`repositories.js`), transacción del caso de uso abierta por el mediator a través de `IUseCaseTransactions`, y errores del
motor traducidos por el nombre de la constraint (`persistence-runtime.js`). **Todo índice va NOMBRADO** en EF: sin nombre,
dos índices sobre las mismas columnas se funden. El baseline lo genera `dotnet ef` (herramienta local en
`.config/dotnet-tools.json`). La prueba emitida `PersistenceModelTests` construye el modelo de EF y su DDL sin base;
`npm run db-check` ejecuta los adaptadores contra PostgreSQL y MySQL reales.

**MySQL** con Microting.EntityFrameworkCore.MySql (el fork MIT de Pomelo, el único proveedor de EF Core 10 que no es GPL:
el de Oracle lo es) sobre MySqlConnector. Lo que cambia entre motores vive en `src/scaffold/relational-engine.js`
(proveedor, alias de `SqlQuery`, aislamiento de los reclamos, Meter del pool); el resto lo dice el catálogo de keel-core.
Las decisiones medidas: el uuid en binary(16) con los bytes del texto (`GuidFormat=Binary16`, fijado al REGISTRAR el
contexto, no en `DatabaseSettings`: así vale para cualquier cadena, la de las sondas incluida); la versión del servidor
fija (`AutoDetect` conecta, y `dotnet ef` no tiene base); la unicidad condicionada como columna generada `<índice>_flag`
(propiedad sombra) al final del índice único; el prólogo de la transacción ANTES de abrirla y sobre la conexión abierta a
mano (EF la soltaría al pool); los reclamos en READ COMMITTED (`ClaimIsolation`); la reconciliación con UPDATE + `INSERT
IGNORE` (MySqlConnector cuenta filas ENCONTRADAS, y `ON DUPLICATE KEY` no diría quién ganó); la purga con `LIMIT … OFFSET`
en ese orden; y el nombre de la constraint sacado del mensaje (la clave primaria es `PRIMARY`). Medido también: con
filesort, InnoDB bloquea todas las filas que examina y no solo las del LIMIT, así que dos réplicas a la vez pueden
llevarse menos que dos lotes (sin repetir: la sonda de la carrera cuenta la pasada siguiente). Los mismos nombres del
Meter del pool NO valen: MySqlConnector usa `db.client.connections.*` (plural) y `state`.

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

El contrato del token con cada proveedor (fase 2 de `PLAN-PROVEEDOR-IDENTIDAD.md`): build emite `TokenContractTests.cs` con los
casos `IDT-*` de `keel-core/gen/token-cases.js`, contra el `JwtAuthenticator` real y el perfil `test` cargado de verdad. Con un
proveedor que genera el id del cliente, `ServiceClientIds.cs` traduce el exento y la identidad 1:1. Lo miden
`test/token-contract.test.js` (sin SDK) y `cs-check --fixtures` con las variantes `*-cognito` y los sabotajes de
`scripts/lib/token-sabotages.js`, cada uno en exactamente sus casos.

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
`Scheduler.java` que EMITE keel-spring; las purgas las mide `db-check`. Desde el inc. 7 del plan 2.26 las purgas no son
tareas del reloj sino recurrentes del cronómetro (`<Tabla>PurgeTimer : IRecurringTimerHandler`, en `timer.js`;
`TablePurges.Tasks` solo da las que no van por él); el sondeador los resuelve del contenedor en cada ámbito, así que el
sabotaje `timer-every-replica` de `db-check`/`doc-check` es un `entity_id` nuevo al asegurar, no un kind por instancia. Los reclamos de barrido y el rescate (10c,
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

## Lectura acotada (DSL 2.27, inc. 3 de PLAN-DSL-227-LECTURA-ACOTADA.md)

`src/scaffold/read-scope.js`, con el reparto de keel-spring y keel-nest y lo neutral de `keel-core/gen/read-scope.js`:
`ReadScope` (Domain/Repository, con su `CacheKey()`), `ReadScopes` (Infrastructure/Security) que el LECTOR del endpoint
estampa en el mensaje (`public required ReadScope ReadScope`), el predicado `Scoped(query, scope)` sumado tras los criterios
del finder (la misma consulta da el total; el salto a otra raíz es una subconsulta de EF, un `IN` por salto) o
`Scoped(filter, …)` con `ReadScopeFilter` en documental (resuelve los `_id` de la otra colección), y `LoadScoped`/
`LoadScopedBy<Clave>` con `AdmittedOrMiss`, que pregunta al motor con el MISMO predicado. La prueba emitida
`ReadScopeTests` lleva RS-9 (la clave de keel-core y la que compone `CachedOperations` con dos scopes), RS-10 y RS-11.
Las sondas RS-1 a RS-8 (`scripts/lib/read-scope-probes.js`) son un `[Fact]` por caso con el id en el nombre, sobre una
siembra estática por raíz; las de los finders (2.22) llaman al finder acotado con `Unrestricted`. **Medido**: RS-7 con
«un valor del enum que ninguna fila tiene» salía rojo en MySQL con la suite entera y verde aislado (el filtro casaba con
las filas de A: su estado no es estable entre sondas): RS-7 afirma ahora que, para CADA valor, todo lo que sale lo lleva.

## Ciclo de vida del dato (DSL 2.28, inc. 3 de PLAN-DSL-228-CICLO-DE-VIDA.md)

`src/scaffold/data-lifecycle.js`, con el reparto de keel-spring y keel-nest y lo neutral de `keel-core/gen/data-lifecycle.js`:
`DeletedAt`/`AnonymizedAt` en la fila (o `deletedAt`/`anonymizedAt` en el documento), las lecturas VIVAS (`&& r.DeletedAt ==
null` en cada carga, `.Where(r => r.DeletedAt == null)` en el listado y su total, la línea del finder DETRÁS del alcance;
en documental `Live(...)` y `NotDeleted`), `DeleteById` que marca, `FindDeletedBy<Clave>` y `Restore` con su ventana, la
unicidad entre vivas como el índice parcial de `partialIndexSpecs` (con el MISMO nombre; en MySQL la columna generada) y la
retención: `<Raíz>Retention` en `Infrastructure/Persistence/Retention` (un ámbito y una transacción por agregado) y
`<Raíz>RetentionTimer : IRecurringTimerHandler`, con `RetentionSettings` desde `retention.yaml` (lo registra Program.cs).
Marcar, restaurar y anonimizar suben la versión. PD-1 es la regla `personal` de `logging-check.js`; PD-2, el
`ConfigureWarnings(... Ignore(SaveChangesFailed, QueryIterationFailed, CommandError))` del DbContext (EF escribe en el log
el fallo de una sentencia CON la excepción del motor) y el `LogIntegrity` sin excepción del manejador de la API. Lo miden
`test/data-lifecycle-parity.test.js` (paridad con keel-spring y PD-1 con bash) y `db-check`/`doc-check` con
`scripts/lib/lifecycle-probes.js`: un `[Fact]` por caso dentro de la clase de sondas, que comparte base con las demás, así
que no vacía tablas y el total de una página se mide como diferencia. Los sabotajes llevan un cuarto elemento opcional, la
expresión que el archivo tiene que contener (un `DeletedAt` sobre una raíz sin borrado lógico no compilaría).

## Redes y trampas medidas

Sin SDK, `test/cs-syntax.test.js` (tree-sitter-c-sharp en WebAssembly, `test/helpers/cs-tree.js`) parsea el C# de todas
las fixtures y de las variantes de `CS_VARIANTS` (`test/helpers/workspace.js`, la MISMA lista que compila `cs-check`) y
exige que todo `using` del propio servicio lleve a un namespace emitido; se autocomprueba con C# roto. La gramática no lee
una expresión de colección como rama de un `?:`: se emite `new Type[] { … }`.

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

## Historial de cambios (DSL 2.29, incremento 3 de `PLAN-DSL-229-HISTORIAL.md`)

`src/scaffold/history.js` emite la entrada, el cambio y el filtro en `Domain/History` (los valores de un cambio son
`JsonElement`: ya van en la forma del cable), y el resto en `Infrastructure/Persistence/History`: el diff (D2) sobre el TEXTO
del cable que escribe `WireJson`, la anonimización (D8), las rutas personales de cada raíz (`HistoryRoots`) y el almacén. El
relacional es `ChangeHistory` con las sentencias de keel-core tal cual por la conexión y la transacción del DbContext, como
`TimerStore`, y las dos tablas mapeadas solo para el esquema (`ChangeHistoryRow`, que `generatorTables` detecta para el paso de
esquema de build); el documental, un documento por entrada con su índice en `DocumentIndexes`.

T1: EF tiene la fila RASTREADA que el `Save` ya carga, así que la instantánea «antes» sale de ella antes de `Apply`, sin otra
lectura (como keel-spring); en documental se lee el documento antes de escribirlo (como keel-nest). La entrada se escribe tras
`SaveChangesAsync`, así que un 409 no deja ninguna (T5). La baja, la restauración y la retención escriben o se llevan su entrada
desde `data-lifecycle.js`; la retención resuelve el almacén del ámbito de su pasada. Los cambios guardados se leen a mano
(`ReadChanges`) y no con `WireJson`, porque su conversor de `JsonElement` toma una cadena por un documento serializado (leído en
`wire.js`, no medido con un fallo). El id de la entrada sale de `HistorySupport.NextId()`, monótono en el proceso: en MongoDB la
hora es de milisegundos, y **medido** que `Guid.CreateVersion7()` no crece dentro del mismo milisegundo (sin el arreglo, la
prueba emitida que pide diez mil ids crecientes cae), así que el desempate de D10 podía invertir dos escrituras seguidas. El
método de la página se llama `PageOf` para no competir con el tipo `Page<T>` dentro de la clase. La prueba emitida
`HistorySupportTests` (`src/scaffold/history-tests.js`) EJECUTA el diff, la anonimización y el id contra las referencias de
keel-core, con los resultados calculados en build; la falsan `cs-check --fixtures --only=cards-history
--sabotage=history-diff|history-next-id`, cada uno en exactamente sus pruebas.

Lo miden `test/history-parity.test.js` (casos, sentencias, tablas, patrones personales y nota contra keel-spring y keel-nest) y
`db-check`/`doc-check` con `scripts/lib/history-probes.js` (HI-1 a HI-10, un `[Fact]` por caso, `--sabotage=hi-*`). El reemplazo
de miembros de la muestra de `lifecycle-probes.js` solo ve una línea; la lista de hijas ocupa varias, y `history-probes.js` corta
el miembro donde se cierran sus paréntesis. `hi-outside-tx` relacional escribe la entrada por una conexión CLONADA: sobre la misma
conexión la sentencia seguiría dentro de la transacción abierta. En documental, `cards-history*-mongo` se juzgan
solo en HI y en el ciclo de vida (el hueco de la sonda general de `cards-logical-mongo`), y la comprobación de los índices vivos
mira `change_history` contra `CHANGE_HISTORY_COLLECTION`. RT-4 de `lifecycle-probes.js` daba por hecho que `from: deleted`
purga; con `then: anonymize` anonimiza.

## Lotes con resultado por elemento (DSL 2.30, incremento 3 de `PLAN-DSL-230-LOTES.md`)

`src/scaffold/batch.js` emite `Api/Rest/Batch.cs` (`BatchItem`, `BatchResponse`, `BatchEnvelope`, `BatchRunner.PerItem` y, con
un lote todo o nada, `AllOrNothing`). El lector de la operación lee el SOBRE: `JsonBodyReader.List(…, element => element)`
deja los elementos como `JsonElement` sin leer y solo se validan su presencia y su `maxItems` (BA-7); devuelve un
`BatchEnvelope` con los elementos y `Message(item)`, que construye el mensaje de UNO (`Item`, no la lista: `messageComponents`
de `services.js`). Cada elemento lo lee el bucle con el MISMO `ValueReaders.Read<Elemento>` del borde; la guarda del value
object llega como `InnerException` de `MalformedRequestException` y es el `message` del elemento. El fallo se traduce con
`ApiErrorMiddleware.Translate(http, error)`, que solo existe con lotes y pasa antes el error por `PersistenceErrors.Translate`:
dentro de la transacción del lote todo o nada el adaptador se UNE a ella y no traduce nada. Per-item responde con
`BatchRunner.MultiStatus`, fijo; el todo o nada abre `IUseCaseTransactions.Run` en el bucle (sin persistencia es el paso
directo), y su `ItemFailure` va SIN causa: la traducción de la persistencia recorre la cadena de causas, y la transacción que
revierte se habría llevado el índice.

La sonda (`scripts/lib/batch-probes.js`) sustituye el stub del handler por uno que guarda sin buscar el sku, registra
`AddUseCases()` tras la persistencia, referencia el proyecto de la API y llama al endpoint emitido con un `DefaultHttpContext`
y el `ApiErrorMiddleware` delante: un `[Fact]` por caso (`Batch_BA3_…`), con sus propios sku `ZZ<letra>-9xxx`. **Medido**:
`ba-one-tx` en PostgreSQL y MySQL cae SOLO en BA-2. EF Core no marca la transacción por un error capturado (BA-4 no cae) y abre un
savepoint antes de cada `SaveChanges` dentro de una transacción ajena, así que el duplicado no la aborta (BA-5 no cae); la
fila rechazada sigue en el change tracker y el elemento siguiente la vuelve a insertar (BA-2). Por eso el adaptador limpia el
tracker al traducir solo en la transacción que abre él: per-item depende de eso. En MongoDB no hay savepoint: el servidor aborta la transacción tras el duplicado y `ba-one-tx` cae en
BA-2 y BA-5, como en keel-nest (`BATCH_ONE_TX`).

## Lotes asíncronos (DSL 2.30, incremento 8 de `PLAN-DSL-230-LOTES.md`)

`src/scaffold/batch-jobs.js` emite el almacén en `Infrastructure/Persistence/Batch` (`IBatchJobStore`; `BatchJobStore` con las
sentencias de keel-core tal cual por la conexión y la transacción del DbContext, como `TimerStore` y `ChangeHistory`, más
`BatchJobRow`/`BatchItemResultRow` solo para el esquema; o sobre MongoDB con sus índices en `DocumentIndexes`, la clave única y
PARCIAL), `BatchSettings` y, en `Api/Rest`, `BatchJobs.cs` (el trabajo en el cable, el alta, las dos rutas y `BatchJobRunner`),
un `<Op>BatchJob : ITimerHandler` por operación y `BatchJobRegistration` (`AddBatchJobs`, que llama Program.cs tras el
cronómetro con `BatchSettings.From`). Los handlers son de la API y no de `AddTimer`: leen el sobre guardado con el lector
PÚBLICO del endpoint (`Read<Op>(ReadOnlyMemory<byte> body)`, que con lotes asíncronos parsea los bytes y valida la lista con
`ViolationSource.Params`, el mensaje `invalidParams` de keel-spring) y traducen el fallo con
`ApiErrorMiddleware.Translate(IServiceProvider, …)`, la sobrecarga sin petición. `batch-jobs.js` no importa a endpoints.js ni a
timer.js (ellos lo importan a él): el nombre de la clase de endpoints va escrito ahí.

`ITimerHandler.InTransaction` (miembro por defecto de la interfaz, true): el trabajo lo pone a false y el sondeador lo corre
fuera de su transacción y borra o rearma después (`Settle`). Cada elemento del chunk va en su ÁMBITO (su DbContext o su
sesión): el efecto por el mediator, el avance del cursor (la valla, primero) y el resultado en `IUseCaseTransactions.Run`; un
`FenceLostException` revierte el elemento y para el disparo. El dueño es `AuditActor.Current()` (se emite también con lotes
asíncronos) y el procesador corre con un principal de token cuyo `sub` es el dueño. La purga de `batch_job` es
`BatchJobPurgeTimer` (timer.js delega en `batchPurgeTimerBody`), con su almacén y `BatchSettings`, no `TablePurges`.

La sonda (`scripts/lib/batch-job-probes.js`) llama a los tres endpoints emitidos con un `DefaultHttpContext` (cuerpo, ruta,
query y cabecera) y el `ApiErrorMiddleware` delante, con el dueño en `SecurityContext.Open`; dispara el handler a mano con el
chunk a 2 (`ActivatorUtilities` con `BatchSettings` explícito) y NO registra el handler en el contenedor, para que el sondeador
de otras sondas no toque sus temporizadores. BJ-4 es `CrashingBatchJobStore`, registrado en el lugar del emitido (cada
elemento resuelve el suyo en su ámbito); BJ-5, el gancho `AfterEffect` del handler de la sonda, que mueve el cursor en otro
ámbito (en MongoDB, sin sesión: BJ-5 cae igual, aunque no se midió si por la valla o por un WriteConflict que
`PersistenceTransactions` repite hasta chocar con ella). La sonda de dos réplicas de las purgas cuenta también `BatchJobPurgeTimer`, y la de índices vivos de
doc-check compara las colecciones de `BATCH_JOB_COLLECTIONS` (claves, unicidad y filtro parcial). Medido: BJ-1 a BJ-9 en verde
en PostgreSQL, MySQL y MongoDB, y `bj-no-resume` en BJ-4, `bj-cursor-outside-tx` en BJ-4 y BJ-5 y `bj-foreign-reader` en BJ-6,
exactamente, en los tres.

## Lotes síncronos con clave (DSL 2.30, incremento 10b de `PLAN-DSL-230-LOTES.md`, D15)

`usesBatchJobs` significa ahora «almacén de trabajos» (lotes asíncronos o síncronos con clave, `batchJobStoreOperations`);
lo que es solo del asíncrono (el alta, el procesador, su temporizador, las rutas, `PagedResponse` y `PageableReading` por los
resultados) pregunta `usesAsyncBatchJobs`. `BatchJobs.cs` se partió: `BatchJobSteps.cs` lleva lo que comparten los dos (los
bytes del cuerpo y su firma, la cabecera, `BatchJobKeyReusedException`, `FenceLostException` y el paso de UN elemento, cada uno
en su ámbito, con tres desenlaces `BatchStep.Next|Stop|Lost`, y `Stored`, la respuesta rehecha con `batchStoredBody`); el
sabotaje `bj-cursor-outside-tx` apunta ahora a `BatchJobSteps.cs`. `KeyedBatches.cs` (Api/Rest) es el lote con clave: crea o
encuentra el trabajo en una transacción propia (`ReleaseKey`, `ByKey`, `Job`, `TakeOver`), procesa desde el cursor y responde
siempre lo guardado; sin la cabecera es el lote de siempre. El endpoint lee los BYTES (`BatchJobRequests.Body`) y el lector del
sobre los parsea con `ViolationSource.Params`, como el asíncrono. El todo o nada con clave pasa un `IAtomicSink` a
`BatchRunner.AllOrNothing` (parámetro explícito antes del `CancellationToken`, por CA1068) y descarta el trabajo si no se
confirma. `BatchJobRunner` y `KeyedBatches` construyen `BatchJobSteps` en una PROPIEDAD y no en un inicializador de campo: un
parámetro del constructor primario usado en los dos sitios es CS9124, error con `TreatWarningsAsErrors`. `SyncStaleMs`,
`TakeOver`, `Discard` y sus sentencias solo se emiten con lotes con clave; `AuditActor`, solo con security (sin ella el dueño
es `BATCH_ANONYMOUS_OWNER`).

La sonda (`scripts/lib/batch-key-probes.js`) llama al endpoint emitido con la cabecera de la clave y cuenta trabajos y
resultados como DIFERENCIA (la clase comparte base con las demás); la muerte a mitad de lote es el `CrashingBatchJobStore` de
las sondas BJ con `CrashAt = 1`, que ahora se emite para todo sujeto con almacén de trabajos.

## Guarda del agregado (DSL 2.31, incremento A5 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`)

`src/scaffold/entity-checks.js` emite en la entidad `EnsureInvariants()` (hijas, derivados, cotas y checks: el orden de D23), el derivado como propiedad que calcula sobre el `decimal` de .NET (`Compute<Campo>()` suma exacto y devuelve null si desborda el `decimal`; la propiedad redondea con `MidpointRounding.AwayFromZero`, que es el HALF_UP de D5, y suma `0.00m` para quedarse con la escala del campo) y las ayudas como miembros estáticos privados (`IsAbsent`, `ExceedsDecimal`, y los patrones con `[GeneratedRegex]`, que hacen la clase `partial`). El constructor de rehidratación no asigna el derivado: el valor que llega en el estado se ignora. Los checks leen las PROPIEDADES (la de un derivado calcula; la de una colección es la vista de solo lectura) y comparan con los operadores de C#, que sobre `int`, `long` y `decimal` comparan por cantidad; los nulos solo se comprueban en los operandos que admiten null (`x is null` sobre un tipo valor no anulable no compila). `saveGuardLines` son las primeras líneas DENTRO de la transacción del `Save` (relacional y documental), y `Apply`/`ToDocument<Raíz>` marcan la línea del derivado con `DERIVED_MARK`, que es lo que busca `cp-stale`.

Lo miden `test/entity-checks.test.js` (la forma, el orden, las notas y los mensajes contra keel-spring, y que cada sabotaje se aplique a lo emitido) y `db-check`/`doc-check` sobre `catalog-invariants`/`-mongo` con `scripts/lib/invariant-probes.js`: un `[Fact]` por vector (`Invariants_IC3_2_…`), y ese sujeto solo ejecuta sus vectores (las clases de ayuda del cronómetro se quedan: las nombra el registro de la fixture). El sujeto es también un parche de `UNCOVERED_BRANCHES`, así que lo recorren `cs-syntax` y `cs-check`.

## Búsqueda (DSL 2.32, incremento B5 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`)

El finder relacional (`src/scaffold/finders.js`) escribe `in` como `lista.Contains(r.Prop)` (cada elemento plegado antes si
el input pliega), `ne` como `r.Prop == null || r.Prop != v` (EF ya compensa los nulos de SQL, pero se escribe para que el
sabotaje `finder-ne-null` tenga forma) y la búsqueda como UN `Where` con un OR de `Contains`/`StartsWith` sobre la sombra de
cada campo de `over`, con el texto plegado una vez (EF escapa el patrón). El documental (`document-repositories.js`): `$in`
escrito con el mismo `BsonValues` con que se guarda, `$ne` y un `$or` de `BsonRegularExpression(Regex.Escape(...))`.

El borde: `PageableReading.Read(…, sortable)` cumple `readClientSort` y lanza `InvalidSortException` (Application/Support,
400 `VALIDATION_ERROR` con `invalidSort` en `ApiErrorMiddleware`); el endpoint le pasa el diccionario ruta del contrato →
propiedad del adaptador, y sin `sortable` todo `?sort=` es 400 (también en el historial y en los resultados de un trabajo).
`TextValues.List` recibe el nombre de la lista: parte por comas también un valor repetido (U8) y la vacía o con un elemento
vacío es `RequestValidationException([nombre], Params)` (D10). La tabla de rutas solo anuncia `sort` con `sortable`.

La collation del orden (U7): `orderCollations` de `persistence.js` lleva `binaryCollationFor` (sin comillas: `"C"` en
PostgreSQL, `utf8mb4_bin` en MySQL) al `UseCollation` de cada columna de `orderedTextColumns`, sin doblar la de la unicidad;
`schemaSteps` pasa las migraciones del agente a `orderCollationWork` con `baselineColumns` (una columna de EF por línea, con
su `name:`). db-check compara la collation contra el DISEÑO en los dos motores. La clave de la caché suma
`message.Pageable.Page`, `Size` y el orden (D18).

Lo miden `test/search.test.js` (la forma y que cada sabotaje se aplique) y `db-check --only=catalog-search` /
`doc-check --only=catalog-search-mongo` con `scripts/lib/search-probes.js`: un `[Fact]` por caso (`Search_FS3_…`), las
filas sembradas una vez por el adaptador emitido, y los SO-* llamando al `PageableReading.Read` emitido (el proyecto de
sondas referencia la API). El sujeto solo ejecuta sus casos. La sonda de finders de 2.22 se salta los criterios de 2.32.
