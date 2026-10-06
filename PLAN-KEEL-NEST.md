# Plan de construcción de `keel-nest`

## 0. Propósito y regla de equivalencia

`keel-nest` es el segundo generador de Keel: `keel-nest build specs/<servicio>` → `cd
services/<servicio>-nest` → `/keel-generate-nest` (sin argumentos). Mismo flujo normativo de dos
pasos que `keel-spring` (`building-a-generator.md`), mismo reparto build/agente, mismas puertas.

**Definición operativa de «servidores equivalentes»** — lo que este plan mide en cada incremento:

| Eje | Equivalencia exigida | Cómo se mide |
|---|---|---|
| Contrato HTTP | rutas, verbos, status de éxito, `ErrorResponse` byte a byte de forma, `code` exactos, paginación (`items/page/size/totalElements/totalPages`), orden y desempate | test de contrato estructural (§ inc. 5) + escenarios `FL-*` |
| Cable | `timestamp` ISO con 3 decimales y `Z`; `decimal` con la escala declarada (nunca `number` binario); `conventions.nulls`; enums por valor; `json` embebido como objeto; ids UUIDv7 | golden de serialización compartido en `keel-core` (§ inc. 3) |
| Mensajería | `EventEnvelope` idéntica (`metadata.eventId…traceparent` + `data`), destinos físicos, cabeceras, dead-letter | escenarios `FL-*` + `broker-check` |
| Fiabilidad | los seis mecanismos de repetición/compensación (idempotency_record, processed_event, outbound idempotency, outbox, reclamo, reconciliación) con las mismas tablas/colecciones y semántica | `idempotency-check` + `store-check` + `claim-check` portados |
| Persistencia | mismas tablas, columnas, cotas, índices (incl. únicos condicionados), FKs, `@Version` ↔ `@VersionColumn`, motores | `mapping-check` + `index-check` portados |
| Operación | `/livez` `/readyz`, puerto de management, gradiente de perfiles `local/develop/production/test`, variables de entorno con los mismos nombres | test de config + `deploy-check` |
| Telemetría | mismas series (nombres y tags) que consulta el panel/alertas que ya genera keel-spring | `telemetry-check` portado: el **mismo** panel debe tener datos |

Regla de oro heredada: el generador nunca inventa ni corrige funcionalidad; lo que no sabe
mapear se **rechaza o avisa en código** (`supported-features.js`), nunca se ignora.

## 1. Principios de construcción

1. **La frontera avanza en código.** `keel-nest/src/lib/supported-features.js` nace
   rechazando todo salvo lo mínimo; cada incremento **borra** entradas. El estado del generador
   en cualquier momento es «lo que su frontera ya no rechaza».
2. **Una interpretación del diseño.** Todo lo que no depende del lenguaje destino (modelo
   semántico, errores declarados, destinos físicos, clasificación de reclamos, vocabularios de
   sondas, infra de compose) vive en `keel-core` y lo consumen los dos generadores. Si una
   decisión se toma en dos sitios, divergirá.
3. **Cada incremento cierra con una puerta medible** — tests sobre el texto emitido +
   compilación real (`tsc`) + check en vivo cuando aplica + corrida si hay un hito end-to-end.
   Ningún incremento se da por hecho con una red que solo compara cadenas.
4. **Fixtures compartidas.** Los mismos diseños de `keel-spring/test/fixtures` sirven a los dos
   generadores; el par del MVP (`notification-mailer` / `-mongo`) es la vara de medir final.
5. **Matriz de paridad por mecanismo**, no por intuición: los ids de mecanismo de
   `engine-support.js` pasan a ser catálogo neutral y cada generador declara su columna
   (`verificado` / `razonado` / `degradado` / `no soportado`) con su porqué.
6. **Mejores prácticas Node/Nest** (verificar versiones con `find-docs`/ctx7 al abrir cada
   incremento, nunca de memoria): Node LTS, NestJS actual, TypeScript `strict`, ESLint +
   reglas de frontera, `npm ci` con lockfile, configuración tipada y validada al arrancar,
   apagado ordenado, sin `any` en dominio, sin `number` para dinero.

## 2. Arquitectura del proyecto generado (`services/<servicio>-nest/`)

Hexagonal + CQRS, misma forma que `architecture.md` de keel-spring, traducida:

```
src/
├── domain/            # TS puro: SIN imports de @nestjs/*, typeorm, mongodb…
│   ├── aggregate/ entity/ valueobject/ enums/ events/ errors/
│   ├── repository/    # PUERTOS como abstract class (sirven de token de DI)
│   └── clients/ storage/ mail/ identity/   # Uuids.v7()
├── application/       # SIN imports de Nest: commands/ queries/ usecases/ dtos/ mappers/
│   └── interfaces/    # Command, Query<R>, ReturningCommand<R>, Handler (+ decorador propio
│                      #   @ApplicationComponent que solo pone metadata)
└── infrastructure/
    ├── usecase/       # UseCaseMediator: frontera transaccional (TypeORM QueryRunner +
    │                  #   AsyncLocalStorage); dispatchWithoutTransaction para el barrido
    ├── persistence/   # *.orm-entity.ts + RepositoryImpl con toDomain/toOrm explícitos
    ├── messaging/     # EventEnvelope, DomainEventBridge, outbox/ (relay + OutboxDispatcher)
    ├── rest/          # controllers que solo traducen + ApiExceptionFilter + ErrorResponse
    ├── security/ http/ storage/ mail/ payments/ scheduling/ telemetry/ logging/ config/
    └── app.module.ts  # el único sitio que cablea handlers y puertos
```

Elecciones de stack (equivalentes a las de Spring; confirmar versión al implementar):

| Spring | Nest |
|---|---|
| Gradle wrapper vendorizado | `package.json` + `package-lock.json` generado, `npm ci`, `.nvmrc` |
| JPA + Flyway | TypeORM + migraciones TypeORM (`migrations/`, baseline exportado por el agente de calidad) |
| Spring Data MongoDB | driver oficial `mongodb` (control fino de `findOneAndUpdate` e índices parciales) |
| Bean Validation | `class-validator` + `class-transformer` con `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`) |
| `BigDecimal` | `decimal.js` + serializador propio que conserva la escala en el JSON |
| Jackson `TimestampModule` | serializador único de `Date`→ISO con 3 decimales |
| Spring Security + JWT | `jose` (JWKS) en un `Guard` global + `@Roles`; Keycloak/Cognito por stack |
| resilience4j | `cockatiel` (retry, circuit breaker, timeout, bulkhead) con fallback estrecho |
| `@Scheduled` | `@nestjs/schedule` |
| RabbitMQ / Kafka / SNS-SQS | `amqplib`, cliente Kafka mantenido (evaluar `@confluentinc/kafka-javascript` vs `kafkajs`), `@aws-sdk/client-sns|sqs` |
| Redis cache | `ioredis` |
| S3/MinIO | `@aws-sdk/client-s3` + firma de URL |
| SMTP + Handlebars/Mustache | `nodemailer` + `handlebars` sin helpers ni partials de fichero, escapado por defecto |
| Logback + MDC | `pino` (`nestjs-pino`) + `AsyncLocalStorage` para correlación |
| Micrometer + OTel | OpenTelemetry Node SDK (trazas/logs OTLP) + `prom-client` por scrape, **con los nombres de serie del vocabulario neutral** |
| Actuator | `@nestjs/terminus` en `/livez` `/readyz` + servidor de management en `MANAGEMENT_PORT` |
| JUnit `integrationTest` | Jest (`test/integration/`) + `jest-junit` → el mismo XML que lee `score-scenarios.sh` |

Gates estáticos que el proyecto lleva dentro (equivalentes a los `.sh` de Spring):
`dependency-cruiser` con la regla hexagonal (domain/application no importan framework),
`check-domain-guards.sh`, `check-idempotency.sh`, gate de cardinalidad de métricas — portados
a TypeScript/AST donde el original hace `grep` sobre Java.

## 3. Incrementos

Cada incremento: **objetivo · entregables · archivos · puerta de evaluación · criterio de salida**.
El orden es de dependencia: ninguno usa algo que no exista ya.

### Inc. 0 — Línea base de keel-spring (medir antes de tocar)

- **Objetivo**: poder demostrar que la extracción del inc. 1 no cambia ni un byte de lo que
  genera keel-spring.
- **Entregables**: `packages/keel-spring/scripts/golden-digest.js`: para cada fixture × stack
  representativo (la matriz de `compile-check`), corre `planService` en memoria y escribe el
  `digestOf` de cada archivo en `test/golden/digests.json` (solo huellas, no árbol congelado).
- **Puerta**: `npm test` verde; el script es determinista (dos ejecuciones = mismo JSON).
- **Salida**: digests de referencia commiteados.
- **Estado: hecho (2026-10-06).** `npm run golden` escribe la línea base (42 combinaciones,
  10 453 archivos, huellas sha256 recortadas a 64 bits); `npm run golden -- --check` compara y
  sale con 1 nombrando combinación y archivo. Falsado: un espacio en la plantilla de
  `Uuids.java` lo pone rojo en las 42. `test/golden-digest.test.js` vigila determinismo y
  cobertura de fixtures; no compara contra la línea base a propósito.

### Inc. 1 — Núcleo neutral en `keel-core` (refactor sin cambio de comportamiento)

- **Objetivo**: separar *interpretar el diseño* de *emitir Java*.
- **Entregables** (en `packages/keel-core/src/lib/gen/`, exportado desde `src/index.js`):
  - `model.js` neutral: `buildModel` sin `javaType`/anotaciones; los tipos salen como tipos
    **del DSL** con sus constraints. keel-spring añade su proyección (`type-mapper.js`,
    `basePackage`) en una pasada propia (`projectJava(model)`).
  - Lo ya neutral se mueve tal cual: `naming.js` (parte no-Java), `declared-errors.js`,
    `dead-letter.js` (`subscriptionDestination`), `outbound-failures.js`, `cron-period.js`,
    `buckets.js`, `payments-model.js`, `classifyClaims`/`rescueClaim`, `RECONCILIATION_BATCH_SIZE`.
  - Vocabularios de sondas cuya carga es CLI/HTTP (no Java): `broker-probes`, `mail-probes`,
    `mongo-probes`, `telemetry-probes` (nombres de serie y tags), `payment-probes` (formas del cable).
  - Parte de infra del catálogo de stack (contenedores, imágenes, `HEALTHCHECKS`, `DATABASES.kind`,
    `realmSpec()` de auth) → `gen/infra-catalog.js`; cada generador conserva sus dependencias.
  - Catálogo de **ids de mecanismo** (`MECHANISMS` sin celdas) → `gen/mechanisms.js`.
  - Fixtures: se mueven a `fixtures/designs/` en la raíz del monorepo (o se referencian desde
    `keel-spring/test/fixtures` vía helper) para que ambos paquetes las usen; `READY_FIXTURES`
    a un helper compartido.
- **Puerta**: `npm test` de los dos paquetes verde; **digests del inc. 0 idénticos**;
  `npm run compile-check` (subset postgres+rabbit, kafka+mongo) verde; `npm run matrix` igual.
- **Salida**: keel-spring importa el núcleo desde `keel-core`; ningún módulo de `gen/` contiene
  la palabra `java`/`@` de anotación (test que lo vigila).
- **Estado: hecho (2026-10-06)**, en cinco tramos con su commit cada uno, y en todos la huella
  de la línea base idéntica (42 combinaciones, 10 453 archivos) y la matriz de paridad idéntica:
  - **1a** fixtures a `fixtures/designs/` y `fixtures/design-docs/` en la raíz.
  - **1b** `keel-core/gen`: nombres, `code` declarados, destinos de mensajería, cadencia de
    cron, buckets.
  - **1c** vocabularios de sondas (broker partido en neutral + proyección Java, correo,
    mongosh, pasarelas).
  - **1d** `infra-catalog.js` (con `java-stack.js` en keel-spring para dependencias Gradle,
    Flyway y URLs), `mechanisms.js` y `identity-realm.js` (`realmSpec()`).
  - **1e** `model.js`, `types.js` y `payments-model.js` en `keel-core/gen`; `buildModel` exige una
    **proyección de lenguaje** cuyo contrato fija `gen/projection.js` (16 miembros + 4 textos), y
    keel-spring pasa `java-projection.js`. Además de la huella, el modelo ENTERO (avisos y orden
    de claves incluidos) salió idéntico en las 42 combinaciones, y `test/gen-model.test.js`
    construye el modelo de las 13 fixtures con una proyección que no es Java sin que aparezca
    nada de Java (falsado: una anotación metida en el modelo neutral tumba 5 fixtures).
  - `compile-check` no se volvió a pasar: con la salida idéntica byte a byte no compila nada
    distinto de lo que ya compilaba.
  - keel-core sube a `0.4.0` (exports `keel-core/gen` y `keel-core/gen/*`) y keel-spring depende
    de `^0.4.0`. Sin publicar.
- **Aplazado a propósito**, cada cosa al incremento que la necesita:
  - el vocabulario de telemetría (`telemetry-probes.js`) → inc. 14: separar las series de
    negocio y HTTP, que comparten los dos generadores, de las de runtime, que son de cada
    plataforma, es una decisión de diseño y no un movimiento;
  - la tabla de historial de migraciones en los `cliResetCmd` (hoy `flyway_schema_history`) → inc. 6;
  - el renderizado de los scripts de `infra/` (compose, `validate-infra.sh`, `reset-db.sh`,
    `init-keycloak.sh`), que también es neutral → inc. 7, cuando keel-nest los necesite.

### Inc. 2 — Esqueleto de `keel-nest` (CLI, puertas y proyecto vacío que arranca)

- **Entregables**: `packages/keel-nest/` calcado de keel-spring: `package.json` (bin
  `keel-nest`, `keel.dsl` = la de keel-spring), `src/cli.js` (`build`, `check`),
  `src/commands/{build,check}.js` con el mismo tronco (DSL soportado → `supported-features` →
  `validateService` → `assessReadiness` con `--accept-unready` estampado → stack → escribir),
  `src/lib/{assets,stack-catalog,stack-config,prompt,writer,generated-manifest}.js`
  reutilizando `classifyGenerated`/`pruneOrphans` de keel-core (`--refresh`, `--prune`,
  `--check`, `--force`), `src/scaffold/index.js` con `planService` puro.
  `supported-features.js` **rechaza** todas las capas salvo `domain`, `use-cases` y `api`.
  Scaffold mínimo: `package.json`, `tsconfig` strict, `nest-cli.json`, `main.ts` con apagado
  ordenado, `AppModule`, config por perfiles (`config/<perfil>/*.yaml` con el gradiente
  literal → `${VAR:default}` → `${VAR}`) validada al arrancar, `/livez` `/readyz`, `.gitignore`,
  `README`. Registro en `KNOWN_GENERATORS` de keel-core.
  Proyección de harness con `emitHarnessFiles()` (skill `keel-generate-nest` sintetizada por
  `generator-docs.js`, aún sin agentes).
- **Puerta**: `test/{build,check,tmp-hygiene,stack}.test.js`; `check` **no escribe nada**;
  `build` se niega con diseño no listo; `npm run ts-check` (nuevo script: `npm ci` + `tsc
  --noEmit` + arrancar y pedir `/livez`) verde sobre un proyecto vacío.
- **Salida**: `keel list` muestra `nest`; un fixture con solo dominio genera un proyecto que
  compila y arranca.
- **Estado: hecho (2026-10-06)**, en dos tramos:
  - **2a** — el tronco de `build` pasa a `keel-core/gen` antes de escribir keel-nest, para que
    no lo copie: `design-gate.js` (la puerta del diseño, ahora la misma para los dos generadores),
    `stack.js` (cuestionario y `resolveStack`, con la pregunta de identidad del lenguaje como
    gancho), `materialize.js` (escritura con manifiesto), `project-writer.js`,
    `generated-manifest.js`, `specs-seal.js`, `keel-docs.js` y `prompt.js`. keel-spring los usa;
    golden idéntico.
  - **2b** — el paquete: `keel-nest build|check`, la frontera, la proyección TypeScript y un
    proyecto que arranca. `npm run ts-check` sale **7/7**: genera, instala, compila con `strict`,
    pasa sus pruebas, construye, arranca y responde `/livez` y `/readyz` con
    `{"status":"UP"}`. Falsado: saboteando el drenaje de `/readyz` cae exactamente su prueba. La
    suite del paquete es de 46 casos, sin red, y uno de ellos cruza las 13 fixtures: con la
    proyección TS el modelo nombra las mismas entidades, rutas, status y avisos que con la de Java.
- **Cambios respecto a lo planificado**, con su motivo:
  - **Vitest 5, no Jest.** NestJS 12 es solo ESM y Jest solo carga sus paquetes desde Node 24.9.
    Tampoco sirve Vitest 4 (el de la plantilla de `nest new`): con la última Vite, npm 10 revienta
    resolviendo sus peers. Vitest trae reporter JUnit, así que `score-scenarios.sh` (inc. 7) lee el
    mismo XML.
  - **Node 22.12+ y ESM** (`module: nodenext`, imports relativos con `.js`), por NestJS 12.
  - **TypeScript `~6.0`**, el que declara la CLI de Nest 12; el 7 (nativo) todavía no.
  - **Inyección siempre con `@Inject(<token>)`**, para que el arranque no dependa de qué
    herramienta transforme el TypeScript (tsc al compilar, Vitest en las pruebas).
  - **Sin `EVOLUTION.md` todavía**: el modo evolución llega en el inc. 15, como estaba previsto.
  - **`check` de keel-spring sigue con su formato propio**; solo `build` comparte la puerta.
  - **No medido en Windows**: el apagado ordenado tras SIGTERM, porque allí la señal mata el
    proceso sin ejecutar los hooks. Lo cubre la prueba generada del drenaje, que no depende de la
    señal, y `ts-check` lo mide en Linux y macOS.

### Inc. 3 — Contrato del cable (antes de emitir ningún DTO)

- **Objetivo**: fijar la forma JSON una vez, en neutral, y que los dos generadores la cumplan.
- **Entregables**: `keel-core/src/lib/gen/wire.js` + `assets/core/docs/wire-contract.md`
  (ejemplos canónicos: `ErrorResponse`, decimal con escala, timestamp de 3 decimales, nulls
  según `conventions.nulls`, `PagedResponse`, `EventEnvelope`, `json` embebido, enteros
  > 2^53). En keel-nest: `scaffold/serialization.js` (interceptor/serializador único que
  respeta escala y precisión), `Decimal` de `decimal.js`, `bigint` para `long`.
- **Puerta**: `wire-golden.test.js` en **los dos** paquetes contra los mismos ejemplos (en
  keel-spring, sobre la configuración Jackson emitida; en keel-nest, ejecutando el serializador
  generado con Node). Un ejemplo saboteado debe ponerlo rojo.
- **Salida**: la tabla «Cable» del §0 tiene test detrás en las dos columnas.

### Inc. 4 — Dominio y aplicación (sin persistencia)

- **Entregables**: `scaffold/{enums,value-types,entities,ids,events,exceptions,mediator,
  services,dtos,mappers}.js`: value objects con guardas en el constructor, agregados con
  factory + rehidratación + `transitionTo`, invariantes que lanzan el error del diseño,
  `raise()` de eventos con `EventMetadata` estampada una vez, jerarquía de errores por
  `http`, handlers con `TODO` que fallan en ejecución, `UseCaseMediator` (sin transacción aún),
  `Uuids.v7()`. Gate emitido: `.dependency-cruiser.js` con la frontera hexagonal +
  `infra/check-domain-guards.sh` portado.
- **Puerta**: `ts-syntax.test.js` (parser de TypeScript, sin instalar, sobre todas las
  fixtures — equivalente a `java-syntax.test.js`, autocomprobado con TS roto) + tests de
  rasgos (`shape-coverage`, `value-type-format`, `domain-guards-check`) + `ts-check` sobre las
  fixtures + regla hexagonal ejecutada.
- **Salida**: `supported-features` deja de rechazar `domain`/`use-cases` en todas sus formas.

### Inc. 5 — API REST

- **Entregables**: `scaffold/{controllers,web,validation}.js`: controllers por agregado y
  versión, `ValidationPipe` con las cotas heredadas del dominio, status de éxito del diseño,
  `ApiExceptionFilter` → `ErrorResponse`, paginación/orden con desempate estable,
  `CorrelationMiddleware` (`X-Correlation-Id` + `AsyncLocalStorage`), `framework-errors` vía
  `declaredErrorFor` neutral.
- **Puerta**: `contract-parity.test.js`: para cada fixture, la tabla (método, ruta, status,
  codes posibles, forma de request/response) extraída del **modelo neutral** coincide con la
  que expone cada generador (keel-spring desde sus controllers, keel-nest desde los suyos /
  `@nestjs/swagger`). Más `ts-check` y una prueba de arranque que pide una ruta y recibe el
  `ErrorResponse` del stub.
- **Salida**: un diseño sin persistencia ni mensajería genera un servidor cuyo contrato HTTP
  es el de keel-spring.

### Inc. 6 — Persistencia relacional (TypeORM)

- **Entregables**: `scaffold/{persistence-entities,persistence-members,repositories,
  migrations,auditing,purge,conditional-uniqueness}.js`: entidades ORM con VOs aplanados,
  cotas de columna, FKs con el nombre de `foreignKeyName` neutral e índice en toda FK,
  `@VersionColumn` con round-trip, índices únicos y parciales, collation sensible a mayúsculas,
  purga por lotes, tope de transacción (`statement_timeout`/equivalente por motor) → 503
  `TRANSACTION_TIMEOUT`, reintento de interbloqueo; mediator transaccional; perfil `test`.
  Matriz `src/lib/engine-support.js` de keel-nest: PostgreSQL y MySQL primero; MariaDB,
  SQL Server y Oracle `razonado` hasta medirlos.
- **Puerta**: tests de rasgo + `ts-check`; `mapping-check` e `index-check` portados (podman/
  docker, sondas desde los vocabularios neutrales) en postgres y mysql; `npm run matrix`
  muestra la columna nest.
- **Salida**: primer diseño **completo** generable: dominio + use-cases + api + persistence.

### Inc. 7 — Arnés de integración y pipeline de agentes (primer hito end-to-end)

- **Entregables**: `scaffold/{integration-tests,devtools,docker,deploy,context-md,
  generator-docs,readme}.js`: `infra/docker-compose.yaml` desde el catálogo neutral,
  `validate-infra.sh`, `reset-db.sh`, `score-scenarios.sh` (lee el XML de `jest-junit`, mismos
  exit codes 0/1/2/3), base `AbstractFlow` en TS con `FailureCapture` a
  `build/keel-failures/`, sello de `specs/` (`specs.sha256`).
  `assets/agents/keel-nest-{code,infra,tests,validate,quality}.md` neutrales;
  `assets/generators/nest/{architecture,constitution,orchestration}.md` +
  `conventions/` (mapping.md por capa recorriendo `dsl-reference.md`, project-layout,
  domain-modeling, integration-tests, logging…) + `skills/keel-nest-database/`.
  Listas `AGENTS`/`CONVENTIONS` en `generator-docs.js`.
- **Puerta**: `score-*.test.js` ejecutan el awk/bash con XML fabricado; **corrida** sobre una
  fixture de silueta simple (CRUD relacional sin mensajería) registrada en
  `docs/corridas/<fecha>-<servicio>-nest.md` con `corrida-metrics.js footprint`.
  Criterio: 100% `FL-*` OK, y la misma fixture en keel-spring también al 100%.
- **Salida**: **primer servidor equivalente demostrado**. A partir de aquí cada incremento
  cierra con su corrida.

### Inc. 8 — Seguridad

- `scaffold/{security,auth-provisioning}.js` + skills `keel-nest-keycloak`, `keel-nest-cognito`:
  guard JWT con JWKS, roles/authorities, `access` por operación, `scoping` por recurso (403),
  `callerIdentity` resuelta en un único punto, validación de audiencia por proveedor,
  `realmSpec()` neutral → script kcadm y `realm-export.json`.
- **Puerta**: `caller-identity`, `auth-scoping`, `keycloak-script-runs` (ejecuta el bash con el
  stub); corrida con `security` (asset-vault o profile-directory).

### Inc. 9 — Mensajería y outbox

- `scaffold/{events,messaging,outbox,dead-letter-config,messaging-provisioning}.js` + skills
  `keel-nest-{rabbitmq,kafka,snssqs}`: `EventEnvelope`, bridge dominio→integración, relay
  con reclamo `SKIP LOCKED` y backoff, señal de rendición, `reliability` best-effort vs outbox,
  suscripciones con deduplicación (`processed_event`, clave `metadata.eventId` con envoltura
  Keel), reintento sin reintentar el rechazo de negocio, dead-letter con destinos de
  `subscriptionDestination()`. Orden: RabbitMQ → Kafka → SNS/SQS.
- **Puerta**: `broker-check` sobre el proyecto nest (sondas neutrales), `store-check` (relay),
  corridas rabbit y kafka del mismo diseño (serie como la de keel-spring).

### Inc. 10 — Idempotencia, compensación, reconciliación y barridos

- `scaffold/{idempotency,http-idempotency,reconciliation-claim,claim,scheduling,
  idempotency-check,last-known}.js`: `idempotency_record` + firma del comando, `keySource`
  (`client-key`, `payload-field` sin mecanismo cuando la `naturalKey` es la guarda),
  reclamo como arriendo con `stalledAfter`, barrido sin transacción abarcadora,
  `check-idempotency.sh` portado con sus familias y **saliendo rojo recién generado**.
- **Puerta**: `claim-check` y `store-check` portados (postgres, mysql); medición por mutación
  (romper cada mecanismo conservando su forma ⇒ algún `FL-*` rojo); corrida de
  `customer-refunds`/`stock-reservation`.

### Inc. 11 — Clientes HTTP salientes y dependencias

- `scaffold/{http-clients,dependencies,ref-resolvers}.js` + skill `keel-nest-httpclient`:
  puertos `<Cliente>Client`, adaptadores con DTOs wire y mapper ACL, `cockatiel` con
  fallback estrecho (sobrecargas desde `outbound-failures` neutral; el 4xx no cuenta para el
  circuito), idempotencia saliente, auth saliente por config, `replica` + `onMiss`,
  `onUnavailable: lastKnown` con `maxAgeSeconds`; stub HTTP del arnés (`stubSequence`).
- **Puerta**: `stub-sequence`, tests de rasgo, corrida con `http-clients`.

### Inc. 12 — Persistencia documental (MongoDB)

- `scaffold/document-{entities,embeddables,repositories,indexes,config}.js`: agregado como
  documento, índices parciales generados en clase (`MongoIndexConfig` equivalente),
  reclamo con `findOneAndUpdate`, outbox e idempotencia documentales, `export-indexes.sh`.
- **Puerta**: `mongo-check`, `index-check` y `mapping-check` documentales; el par
  `notification-mailer` / `-mongo` genera en las dos ramas.

### Inc. 13 — Capas de borde: cache, storage, correo, pagos

- `cache.js` (Redis, mismo serializador del inc. 3), `storage.js` (`BucketPolicy` +
  `ContentSignature` generados por build), `mail.js` (build genera adaptador SMTP y
  renderizador: asunto saneado en el VO, variables escapadas), `payments.js` neutral +
  `payment-gateways/{stripe,mercadopago}.js` + `gateway-support.js` de nest.
- **Puerta**: `mail-check`, `payment-check` (pasarela falsa con `node:http`), tests de
  regresión de subida; corrida `payment-checkout` con las dos pasarelas.

### Inc. 14 — Telemetría, observabilidad y despliegue

- `scaffold/{telemetry,logging,logging-check,telemetry-gate,observability-assets,deploy,
  concurrency}.js`: OTel SDK, métricas por scrape con **los nombres y tags del vocabulario
  neutral** (el panel y las alertas generados son los mismos que en Spring), exemplars,
  propagación de contexto en saltos asíncronos, `@LogExceptions` equivalente (interceptor),
  `deploy/` con la app en contenedor (multi-stage, usuario no root, `HEALTHCHECK`).
- **Puerta**: `telemetry-check` (arranca la app y consulta las series del panel) y
  `deploy-check`; ninguna alerta nombra una serie que nest no publique.

### Inc. 15 — Evolución del proyecto ya generado

- `scaffold/evolution.js` con `diffDesigns` de keel-core: base congelada, fusiones pendientes,
  `.keel-new` fuera del árbol de fuentes, traspaso escrito para el pipeline;
  `keel-nest check` imprime `design-gaps.yaml`.
- **Puerta**: `design-evolution.test.js` y `generated-propagation.test.js` portados.

### Inc. 16 — Cierre de paridad y publicación

- `supported-features.js` de keel-nest sin rechazos que keel-spring no tenga (o con su
  motivo declarado); matriz de paridad Spring×Nest sin celdas `sin ejecutar` en los ejes del §0;
  `capability-coverage` y `parity` en verde para nest.
- **Corrida de control**: el par del MVP (`notification-mailer` y `-mongo`) generado con los
  dos generadores, 100% `FL-*` en ambos, misma huella de agente comparable, registrada en
  `docs/corridas/`.
- Docs: README del paquete (contrato: entrada, DSL soportada, salida, regla de oro), fila en
  el README raíz, `CLAUDE.md` (sección keel-nest y filas de «Dónde se añade cada cosa»),
  `.claude/rules/nest-*.md`. Publicación npm.

## 4. Cómo se evalúa cada incremento (resumen)

| Red | Coste | Qué cubre | Desde |
|---|---|---|---|
| `npm test` (node:test, rasgos sobre texto emitido) | segundos | forma de lo que build emite, lo que **no** debe aparecer | inc. 2 |
| `ts-syntax.test.js` (parser TS, sin instalar) | segundos | sintaxis de todas las fixtures × stacks | inc. 4 |
| `npm run ts-check` (npm ci + tsc + arranque) | minutos, red | tipos, imports, que el proyecto arranca | inc. 2 |
| regla hexagonal (`dependency-cruiser`) | segundos | frontera domain/application | inc. 4 |
| `wire-golden` / `contract-parity` | segundos | equivalencia con keel-spring sin levantar nada | inc. 3/5 |
| checks en vivo portados (`mapping`, `index`, `broker`, `store`, `claim`, `mongo`, `mail`, `payment`, `telemetry`, `deploy`) | minutos, podman/docker | lo que solo el motor/broker real juzga | inc. 6+ |
| corrida (`/keel-generate-nest` + `corrida-metrics`) | horas | servidor real al 100% de `FL-*` | inc. 7+ |
| medición por mutación | horas | que los escenarios prueban el mecanismo | inc. 10, 16 |

## 5. Riesgos conocidos y mitigación

- **Escala decimal y enteros grandes en JSON** (JS pierde `2.50` y > 2^53): serializador propio
  en el inc. 3, con golden compartido antes de cualquier DTO.
- **Transacción implícita en Node**: sin `AsyncLocalStorage` los repositorios escapan de la
  transacción del mediator; test de rasgo + escenario de rollback.
- **Paridad de motores con TypeORM** (Oracle/SQL Server, `SKIP LOCKED`, índices parciales en
  MySQL): matriz de paridad con `degradado` explícito, nunca silencio.
- **Nombres de métricas** distintos entre Micrometer y prom-client: vocabulario neutral desde el
  inc. 1 y `telemetry-check` que consulta las series del panel.
- **Extracción del inc. 1 rompe keel-spring**: digests del inc. 0 como puerta byte a byte.
- **Dos traducciones de los `FL-*`** (decisión: cada uno su arnés): mitigado con
  `contract-parity` estructural y con correr siempre la misma fixture en los dos generadores
  en cada corrida.

