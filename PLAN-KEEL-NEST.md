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
| Gradle wrapper vendorizado | `package.json` (el lock lo crea el primer `npm install` y se commitea), `.nvmrc` |
| Spring MVC sobre Tomcat | **Fastify** (`@nestjs/platform-fastify`): más rendimiento que Express con el mismo código de Nest, y UN punto de lectura de cuerpos y UN punto de escritura de respuestas, que es donde se cumple el contrato del cable. Escucha en `SERVER_ADDRESS` (default `0.0.0.0`): Fastify por defecto solo atiende `127.0.0.1` |
| JPA + Flyway | TypeORM + migraciones TypeORM (`migrations/`, baseline exportado por el agente de calidad) |
| Spring Data MongoDB | driver oficial `mongodb` (control fino de `findOneAndUpdate` e índices parciales) |
| Bean Validation | `class-validator` + `class-transformer` con `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`) |
| `BigDecimal` | `Decimal` propio en `domain/support` con la semántica de escala de `BigDecimal` (sobre `decimal.js`, que por sí solo normaliza `2.50` a `2.5`) |
| Jackson (`TimestampModule`, `write-bigdecimal-as-plain`, `@JsonRawValue`) | `application/support/wire.ts`: lectura exacta con el texto fuente de cada número (`JSON.parse` con `context.source`), escritura con `JSON.rawJSON`, `RawJson` para el `json` embebido; conectado a Fastify como su parser JSON y su serializador de respuesta |
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
| JUnit `integrationTest` | Vitest (`test/integration/`) con su reporter JUnit → el mismo XML que lee `score-scenarios.sh`; peticiones con `app.inject()` de Fastify |

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
- **Estado: hecho (2026-10-06).**
  - **El contrato**, como datos en `keel-core/src/lib/gen/wire.js`: 16 reglas, 17 casos de
    salida, 10 de entrada formulados como ida y vuelta (comparables entre lenguajes sin saber cómo
    representa cada uno el valor), 4 rechazos y el orden de claves del error, la página y la
    envoltura de eventos. Para el diseñador, `assets/core/docs/wire-contract.md`, atado a los
    datos por `test/wire-contract.test.js`.
  - **Un hallazgo en keel-spring**: no fijaba la notación de `BigDecimal`, así que Jackson
    escribía `1E-7` por debajo de 1E-6. El contrato fija la notación plana y keel-spring activa
    `spring.jackson.generator.write-bigdecimal-as-plain`. Es un cambio de salida intencional: solo
    cambia `application.yaml` en las 42 combinaciones, y la línea base se regenera en su propio
    commit. Su `test/wire-contract.test.js` exige, sobre lo que emite, la pieza que realiza cada
    regla: Jackson, `appendInstant(3)`, el orden de los records, `@JsonValue`, `@JsonRawValue` y
    `NON_NULL` solo con `omit`. Falsado apagando la notación plana.
  - **En keel-nest**: `Decimal` y `RawJson` en `domain/support`; lector, conversores,
    serializador y `@OmitNulls()` en `application/support/wire.ts` (TypeScript puro); Fastify los
    usa como su parser JSON (que rechaza `__proto__` y responde 400 a un cuerpo malformado) y como
    su serializador de respuesta. La prueba emitida `test/wire-contract.test.ts` trae todos los
    casos de keel-core (un test de keel-nest lo exige) y una sonda HTTP por `app.inject()` mide que
    Fastify los use de verdad. En `ts-check`, 48 pruebas en verde. Falsado dos veces: quitar la
    escala de `Decimal` tumba las 7 pruebas de la escala, y pasar el `bigint` a `number`, las 6 de
    `long`.
- **Cambios respecto a lo planificado**:
  - **Fastify en lugar de Express** (petición del usuario, por rendimiento). Además da un único
    punto de lectura y escritura de JSON, que es justo donde se cumple este contrato.
  - **`JSON.parse` con texto fuente y `JSON.rawJSON`** (Node 22+) en lugar de un serializador a
    mano: el número llega y sale con su texto exacto sin dependencias.
  - **Un `Decimal` propio y no el de decimal.js tal cual**: decimal.js normaliza `2.50` a `2.5`.
  - **El error, la página y la envoltura** se fijan ya, pero keel-nest los emite en los
    incrementos 5 y 9; el orden de claves se le exigirá allí, contra los mismos datos.
- **Asimetría conocida, sin cubrir por el contrato**: un decimal *dentro* de un campo `json`
  embebido. Jackson lo pasa por un `double` al leer el árbol (`{"a":2.50}` sale `{"a":2.5}`) y
  keel-nest conserva el texto. Se resolverá decidiendo qué es lo correcto antes de igualarlos.

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
- **Estado: hecho (2026-10-06).**
  - **4a — lo que es del diseño, a `keel-core/gen`** antes de emitir nada: `constraints.js`
    (`numericConstraints`, `inheritedTypePattern`, `inheritedFormat` y `textConstraints`, la mezcla
    tipo → campo de las cotas) y `domain-guards.js` (`guardedFields`, las filas del gate del formato).
    keel-spring las importa de ahí; línea base idéntica (42 combinaciones, 10 453 archivos).
  - **4b — el dominio y la aplicación en keel-nest**: `enums`, `value-types`, `entities`, `ids`,
    `events`, `exceptions`, `dtos`, `mappers`, `services`, `mediator`, `domain-guards-check` y
    `architecture` (`.dependency-cruiser.json` + `npm run check:architecture`), sobre un `render.js`
    que es el ÚNICO mapa de tipo → archivo y compone los imports relativos.
  - **Puerta medida**: suite de 125 casos sin red. `ts-syntax.test.js` (parser de TypeScript, sin
    instalar) sobre las 13 fixtures, más imports que llevan a un archivo emitido y símbolos que ese
    archivo exporta; autocomprobado con TS roto y falsado saboteando la ruta de los DTOs (13 de 13 en
    rojo). `domain.test.js` y `application.test.js` **ejecutan** lo emitido (transpilado): la escala
    normalizada, los rechazos con 400 `VALIDATION_ERROR`, `scalePolicy: reject`, el `<Tipo>Format`, la
    transición negada con 409, el orden del cable de `EventMetadata` y `PagedResponse`, y que cada
    operación de cada fixture llega a SU handler por el contenedor real. Paridad sin levantar nada: los
    errores del dominio (clase, `code`, status) son los de keel-spring en 5 fixtures, y el gate del
    formato vigila los mismos campos en las 13. Falsado: sin la normalización de escala caen sus tres
    casos; con otro `code` en la transición caen el de comportamiento y los 5 de paridad; sin
    `@Handles` cae el cableado de las 13. `ts-check` sale **9/9**: además de lo de antes, la frontera
    hexagonal ejecutada y el dominio y la aplicación de las **13 fixtures compilando con `strict`**
    (no solo la de referencia). La regla hexagonal, falsada a mano en sus cuatro reglas (Nest en el
    dominio, un `import type` de un framework, dominio → infraestructura, aplicación → infraestructura,
    import roto): cada violación la caza su regla y solo esa; `node:crypto` pasa.
- **Cambios respecto a lo planificado**, con su motivo:
  - **La inyección de la capa application no usa `@Inject`**, que es de Nest: cada handler y mapper
    declara `static readonly inject = [...]` y `UseCaseModule` lo construye con un factory provider.
  - **Cada handler declara su mensaje con `@Handles(Mensaje)`**: TypeScript borra los genéricos, así
    que el registro por reflexión de `UseCaseAutoRegister` no es posible. El contenedor falla AL
    ARRANCAR si a un handler le falta o si dos reclaman el mismo mensaje (Java sobrescribía en silencio).
  - **Command / Query / ReturningCommand son clases abstractas con una marca de tipo**: TypeScript
    compara por estructura y tres interfaces vacías serían el mismo tipo.
  - **El agregado se rehidrata desde un objeto `<Entidad>State`**, no con argumentos posicionales que
    se desordenan sin que el compilador lo note. El factory sigue siendo un TODO, como en keel-spring.
  - **`InvalidValueException` (400 `VALIDATION_ERROR`)** explícita en las guardas de los value objects:
    es lo que la `IllegalArgumentException` de un constructor compacto acaba siendo en la API de
    keel-spring, dicho en la propia excepción.
  - **Un campo de DTO que el mapper no sabe derivar sale como `todo(...)`** (compila, falla en
    ejecución nombrándolo): el `null` de Java no cabe en un campo obligatorio de TypeScript estricto.
  - **La frontera avisa** de lo que una operación declara y cuelga de incrementos futuros:
    `idempotency` y `schedule` (incremento 10), `cache` (13).
  - **dependency-cruiser 18 con configuración JSON**; su esquema rechaza `extensionAlias`, y no hace
    falta: con el `tsconfig` del proyecto resuelve los `.js` → `.ts` de nodenext.
  - **keel-nest gana dos dependencias de desarrollo**: `typescript` (el parser de `ts-syntax` y la
    transpilación de los tests que ejecutan el dominio) y `decimal.js`.
- **Huecos que quedan a la vista**:
  - Ninguna fixture declara `scalePolicy: reject` dentro de un value object ni `round` en una entrada:
    los tests los derivan de una fixture real cambiando la política en memoria, pero el código solo lo
    compila `ts-check` cuando lo declara una fixture.
  - Los handlers no inyectan todavía el puerto del repositorio (llega con la persistencia, inc. 6), ni
    los del almacén de idempotencia, el correo o los clientes salientes (sus incrementos).

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
- **Estado: hecho (2026-10-06).**
  - **5a — el contrato, en `keel-core/gen`**: `validationRules` (constraints.js) da como DATOS, en
    orden, lo que valida cada campo —presencia, tamaño, formato, cotas, dígitos de `reject`—, y
    keel-spring escribe sus anotaciones Bean Validation desde ahí; `api-contract.js` decide cuándo la
    entrada va en el cuerpo, si el cuerpo es obligatorio y a dónde apunta `Location`, sacado del
    controlador de keel-spring. Línea base idéntica (42 combinaciones, 10 453 archivos), keel-spring
    1605/1605.
  - **5b — la API en keel-nest**: `rest-support.js` (correlación con `AsyncLocalStorage` abierta en
    un hook `onRequest` de Fastify, `ErrorResponse` en el orden del cable, lectura y validación de
    peticiones, `ApiExceptionFilter` global con los textos, status y `code` del `ApiExceptionHandler`
    de keel-spring), `controllers.js` (un controlador por grupo y un LECTOR generado por operación que
    convierte y valida en el orden del binding de Spring: ruta, cuerpo leído y validado, query presente
    y convertida, restricciones de ruta y query) y `routes.ts` (la tabla de rutas como datos: la usa el
    filtro para el 405 y la lee el test de paridad).
  - **Puerta medida**: `contract-parity.test.js` sobre las 13 fixtures (47 de las 49 operaciones con
    ruta; las 2 multipart, fuera con su motivo): método, ruta, status, `Location`, parámetros de query,
    cuerpo obligatorio u opcional y los campos de cada DTO de respuesta, de keel-spring (sus
    controladores Java) contra keel-nest (su `routes.ts` ejecutado, y comprobando que los decoradores del
    controlador dicen lo mismo). Falsado: un `@HttpCode` distinto tumba 11 fixtures; una query sin los
    opcionales, la que los declara. `rest.test.js` EJECUTA la lectura emitida: los booleanos y enums de
    Spring, `UUID.fromString` de Java, int32 y long, los mensajes de Hibernate Validator. La prueba
    emitida `test/api.test.ts` elige del diseño sus peticiones (llegar al handler → 500 con
    ErrorResponse mientras es un TODO, cuerpo malformado, cuerpo inválido, uuid de ruta malformado, 404,
    405, correlación); falsada en el proyecto: sin abrir la correlación caen los seis casos que la
    comparan, sin el 405 cae el suyo, con un `notBlank` que no rechaza cae la validación. Suite 148/148;
    `ts-check` **11/11**: además, las pruebas emitidas de las **13 fixtures** pasan y el servidor
    arrancado responde 404 con ErrorResponse en una ruta de la API.
- **Cambios respecto a lo planificado**, con su motivo:
  - **Sin `class-validator` ni `ValidationPipe`**: no ven los tipos del cable (`Decimal`, `bigint`,
    `WireNumber`) y sus decoradores irían en los mensajes de `application`, que la frontera hexagonal
    prohíbe. La validación la hace el lector generado con las reglas neutrales de keel-core.
  - **`contract-parity` compara keel-nest contra lo que EMITE keel-spring** (y no solo contra el
    modelo): es la equivalencia que se busca, y el modelo es la fuente de los dos.
  - **Sin `@nestjs/swagger`**: keel-spring anota `@Tag`/`@Operation`; el OpenAPI de keel-nest queda
    pendiente (no es contrato del cable).
  - **El proyecto declara `fastify`** (los tipos de petición y respuesta), en la línea que trae
    `@nestjs/platform-fastify` 12.
- **Asimetrías conocidas, sin cubrir**:
  - Una ruta que no existe: keel-nest responde 404 con ErrorResponse; en keel-spring no está medido
    (el catch-all de su `ApiExceptionHandler` podría capturar `NoResourceFoundException` como 500).
  - Un value object inválido construido DENTRO de un handler: en keel-nest es 400 `VALIDATION_ERROR`
    (`InvalidValueException`); en keel-spring la `IllegalArgumentException` fuera de Jackson cae en el
    catch-all como 500.
  - Los `details` usan los mensajes por defecto de Hibernate Validator en inglés; el locale con el que
    corre de verdad el servidor de keel-spring no está medido.
  - El orden de un listado (`sort`, desempate por id) llega con la persistencia (inc. 6): sin ella, la
    página son dos enteros en los dos generadores.

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
- **Estado: hecho (2026-10-06)**, en tres tramos con su commit cada uno.
  - **6a — lo que es del diseño, a `keel-core/gen`**: `relational.js` (el esquema como DATOS:
    `columnSpec` con nombre, nulabilidad, cota, escala y collation; los miembros persistidos; tablas de
    elementos; los nombres de constraint única, índice y FK; las sombras plegadas; la lista de palabras
    reservadas) y `constraint-errors.js` (qué error del diseño, con qué mensaje, significa violar cada
    constraint: lo que hacía `raceOnlyConstraint` y el mapa del `ApiExceptionHandler`). El modelo gana
    `namedType` (la clase del enum o del value object, sin pasar por la proyección). keel-spring los
    consume; línea base idéntica (42 combinaciones, 10 453 archivos), falsada con un sabotaje en
    `columnSpec`; keel-spring 1605/1605, keel-core 1065/1065.
  - **6b — la persistencia relacional en keel-nest**: `persistence-entities.js` (entidades TypeORM y
    tablas de elementos, tipo físico por motor), `repositories.js` (puerto en `domain/repository`,
    página, adaptador con mapeo explícito), `persistence-runtime.js` (`DataSource` con las variables
    de keel-spring —`DB_URL` admite la URL JDBC tal cual—, `TransactionContext` con
    `AsyncLocalStorage`, traducción de errores del motor, módulo global). El mediator abre la
    transacción (consultas de solo lectura, interbloqueo reintentado tres veces → 409); el filtro
    traduce constraint → error del diseño, versión → 409 y tope → 503 con `Retry-After`; con
    persistencia la página es el `Pageable` de Spring Data (`page`/`size`/`sort` indulgentes,
    `@PageableDefault` 10, tope 2000 o el del diseño, orden del diseño por defecto, desempate por id).
  - **Puerta medida**: suite 161/161 sin red, con `schema-parity.test.js` nuevo —tablas, columnas
    (nulabilidad, cota, escala) y NOMBRES de constraint, índice y FK de keel-nest contra lo que EMITE
    keel-spring, en las 9 fixtures relacionales más una derivación con un value object opcional—,
    falsado con tres sabotajes (cota +1 → 8 fixtures en rojo, un índice de FK menos → 2, la nulabilidad
    del value object opcional → la derivación). `ts-check` **11/11**: las 13 fixtures compilan con su
    persistencia y el servidor de referencia ARRANCA contra PostgreSQL en contenedor (perfil `develop`,
    leyendo `DB_URL` del entorno). `npm run db-check` (nuevo) **20/20** contra PostgreSQL 16 y MySQL 8,
    4 sujetos y 8 raíces: el catálogo del motor contra el esquema neutral (columnas, collation forzada,
    unicidades, índices y FK por nombre), la cota que rechaza el motor, ida y vuelta por el adaptador, la
    fila en crudo (enum por su CONSTANTE, decimal con su escala), versión obsoleta → conflicto, clave
    natural duplicada → el error del diseño, página y borrado del grafo. Falsado con tres sabotajes
    aislados, cada uno cazado por su comprobación y solo por ella.
  - **Dos defectos que solo vio un motor real**: (1) TypeORM NO aplica el transformador de la columna
    referenciada al escribir la FK de una relación, y en MySQL el uuid de la raíz llegaba como texto a
    un `binary(16)` («Data too long»): la FK se declara además como columna con su tipo y su
    transformador (`fkProperty`); (2) TypeORM `@VersionColumn` incrementa pero no comprueba la versión
    esperada: el bloqueo optimista es un UPDATE condicionado antes de guardar el grafo.
- **Cambios respecto a lo planificado**, con su motivo:
  - **TypeORM 1.x** (la 0.3 es `legacy`) y **sin `@nestjs/typeorm`**: el `DataSource` es un provider
    propio que se inicializa al arrancar y se destruye al apagar, sin más dependencia.
  - **El perfil `test` no tiene base de datos** (`database.enabled: false`): las pruebas de build
    arrancan sin infraestructura y quien toque un repositorio recibe un error que lo dice. El H2 de
    keel-spring no tiene equivalente que valga (los tipos físicos son por motor); lo que juzga el esquema
    es `db-check`.
  - **Auditoría estampada por el adaptador**, no con `@CreateDateColumn` (que pone un DEFAULT del
    motor): es lo que hace el listener de Spring Data.
  - **El tope de transacción por motor**: `SET LOCAL statement_timeout` en PostgreSQL;
    `innodb_lock_wait_timeout` y `max_execution_time` en MySQL (1205 y 3024 → 503). Es aproximado: el
    tope es por sentencia, no por la transacción entera, como el `setQueryTimeout` de Hibernate.
  - **`?sort=` nombra la propiedad de la entidad de persistencia** (`priceAmount`), como en keel-spring;
    una propiedad que no existe es un 500, igual que la `PropertyReferenceException` de Spring Data —
    defecto compartido, a la vista—.
- **Asimetrías conocidas, sin cubrir**:
  - `boolean` en MySQL: `tinyint(1)` en keel-nest, `bit` en Hibernate. Los enums: `varchar(255)` en los
    dos, sin el CHECK que añade Hibernate 6 en PostgreSQL. Los timestamps de auditoría `all` no llevan
    DEFAULT en ninguno de los dos.
  - El sub-campo enum de un value object aplanado: keel-spring deja caer su `@Enumerated` al aplanar
    (lo guardaría por ORDINAL); keel-nest lo guarda por su constante. Sin fixture que lo tenga; revisar
    en keel-spring.
  - Ninguna fixture relacional aplana un value object OPCIONAL: su mapeo de vuelta (la marca de
    presencia) solo lo compila `ts-check` en derivación, no lo ejercita `db-check`.
  - **6c — la unicidad condicionada y la matriz de paridad**:
    - A `keel-core/gen/relational.js` pasan `partialIndexSpecs` (tabla, columnas citadas por motor y
      PREDICADO con la constante del enum), `sqlLiteral`, `discriminatorColumn` y `relievingOperations`
      (qué operación RELEVA: entra y sale del estado condicionado en el mismo acto). keel-spring los
      consume; línea base idéntica.
    - keel-nest crea el índice: parcial (`@Index` con `where`) en PostgreSQL; en MySQL la columna
      generada DECLARADA `<índice>_flag` dentro del índice único, la misma forma que keel-spring y por
      el mismo motivo (una parte funcional anónima es opaca a la introspección). El puerto gana el
      finder del OCUPANTE y el handler que releva, su nota de ORDEN: en TypeORM cada `save` escribe en
      el momento, así que basta con el orden de los `save` (no hace falta el `flushPendingWrites` de JPA).
    - `src/lib/engine-support.js` (nuevo): la matriz de paridad de keel-nest, una fila por mecanismo
      del catálogo neutral —`pending` con el incremento que lo trae, o sus celdas por modelo o por
      motor—, y `npm run matrix`. Hoy: 6 celdas verificadas y falsadas, 1 que no aplica, ninguna sin
      ejecutar ni sin falsar, 17 pendientes de su incremento. `test/engine-support.test.js` la ata al
      catálogo (ni ids inventados ni filas sin promesa).
    - **Puerta medida**: `schema-parity` compara además el predicado del índice condicionado con el
      apéndice SQL de keel-spring, falsado con el literal en minúsculas. `db-check` **20/20** en los dos
      motores pregunta al motor el invariante entero (dos en `active` con la misma clave no conviven y
      sale el error del diseño, una en otro estado sí, el finder encuentra al ocupante), el PLEGADO (la
      misma clave en mayúsculas choca) y la CONCURRENCIA: un interbloqueo fabricado con dos
      transacciones que se clasifica como transitorio y una espera de bloqueo que se corta como tope.
      Falsado: predicado en minúsculas (rojo en PostgreSQL; en MySQL no, y es correcto: su collation no
      distingue mayúsculas), índice sin discriminador (MySQL), sin collation forzada, TextFold que no
      pliega, y la clasificación del interbloqueo y del tope rotas por separado. Suite 165/165,
      `ts-check` 11/11, keel-core 1067/1067.
- **Lo que no entró, con su incremento**: la tabla de historial de migraciones de los `cliResetCmd`
  (hoy la de Flyway) va con los scripts de `infra/` y el baseline del pase de calidad (inc. 7), que es
  cuando keel-nest los emite; la purga y los reclamos, con los incrementos 9 y 10. Y el bucle de
  reintento del mediator solo se ejecutará con un handler implementado (corrida del inc. 7).

### Inc. 7 — Arnés de integración y pipeline de agentes (primer hito end-to-end)

- **Entregables**: `scaffold/{integration-tests,devtools,docker,deploy,context-md,
  generator-docs,readme}.js`: `infra/docker-compose.yaml` desde el catálogo neutral,
  `validate-infra.sh`, `reset-db.sh`, `score-scenarios.sh` (lee el XML JUnit de Vitest, mismos
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
- **Reparto en tramos** (como los anteriores, cada uno con su commit):
  - **7a** — `infra/` neutral a `keel-core/gen` (compose, lanzadores, toolbox, validación y reset).
  - **7b** — keel-nest emite `infra/`, `score-scenarios.sh` sobre el XML JUnit de Vitest, la base de
    flujos con `FailureCapture` y el sello de `specs/`.
  - **7c** — agentes, conventions y la skill `keel-generate-nest` con el pipeline.
  - **7d** — la corrida (`/keel-generate-nest` sobre la fixture de silueta simple, y la misma en
    keel-spring).
- **Estado: 7a hecho (2026-10-06).** `keel-core/src/lib/gen/infra-scripts.js` escribe la `infra/`
  entera; lo que cambia entre generadores son TEXTOS de su plataforma (cabeceras, el proceso olvidado
  que comparte la infra, quién rehace el esquema tras `--schema`, el README del stub) más los checks y
  archivos que solo él siembra (en keel-spring, la topología de snssqs). El alcance por recurso pasa a
  llamarse desde el módulo neutral, porque `scopingClaimChecks` ya lo era. Los `cliResetCmd` del
  catálogo nombran el historial de migraciones con `{history}`/`{HISTORY}` (era
  `flyway_schema_history` escrito en cinco motores), y `concreteCmd` lo sustituye con el de la
  plataforma. keel-spring: línea base idéntica (42 combinaciones, 10 453 archivos), falsada cambiando
  su `historyTable` (33 `reset-db.sh` en rojo). `keel-core/test/infra-scripts.test.js` mide con una
  plataforma de juguete que cada texto llega a su archivo y ninguno de otro generador, y que ningún
  motor deja el placeholder sin sustituir (falsado quitando la sustitución en mayúsculas: cae Oracle).
- **Estado: 7b hecho (2026-10-06)**, en dos commits:
  - **La lectura del XML, en `keel-core/gen`** (`junit-scoring.js`): los dos programas awk de la matriz y
    el sello de `specs/`. Y un **defecto latente** que destapó Vitest: `/name="…"/` casaba DENTRO de
    `classname="…"`; Gradle escribe `name` primero y por eso nunca se vio, Vitest lo escribe al revés y
    la matriz salía vacía sobre una suite en verde. `keel-core/test/junit-scoring.test.js` EJECUTA los dos
    programas con los dos órdenes (falsado con el awk anterior: caen los dos casos de Vitest). En
    keel-spring solo cambia `score-scenarios.sh` (comentarios y ese patrón): línea base regenerada.
  - **El arnés en keel-nest**: `infra.js` (la plataforma: textos, y el historial `typeorm_migrations`,
    que el `DataSource` declara con `migrationsTableName` en vez del `migrations` por defecto, un nombre
    que un diseño puede usar) e `integration-tests.js`: `vitest.integration.config.ts` (en serie, JUnit con
    el título del caso en `name` y el archivo en `classname`), `test/integration/support/flow.ts`
    (`useFlow()`: servidor real en un puerto libre bajo `local`, `fetch` de verdad, reset por flujo,
    `db()` con el `cliQueryArgv` del catálogo, evidencia en `build/keel-failures/<FL-id>.json` con el
    formato de keel-spring), el humo y `infra/score-scenarios.sh` con los mismos códigos 0/1/2. Regla
    nueva `flujos-caja-negra` en `.dependency-cruiser.json`: un flujo no importa `src/`.
  - **Puerta medida**: `test/integration-harness.test.js` (sin red): la `infra/` de las 13 fixtures es la
    de keel-spring salvo los textos de la plataforma, el reset excluye la tabla que declara el
    `DataSource`, y el script lleva los programas compartidos. `npm run harness-check` (nuevo, podman o
    docker) **18/18**: genera el diseño de referencia, levanta `infra/` con sus propios scripts y puntúa
    flujos SONDA — uno verde que además mide el reset contra la base real (vacía los datos y respeta el
    historial), uno rojo con su evidencia (petición, respuesta, aserción), uno que no arranca y uno que
    rompe la caja negra —, y cada desenlace sale con su código (1, 2, 0, y 2 con el sello roto). Falsado
    cambiando la tabla de historial de la plataforma: cae la sonda del reset. `ts-check` 11/11: el
    arnés compila con `strict` en las 13 fixtures.
  - **7c hecho (2026-10-06)**, en dos commits:
    - **El baseline de migraciones**: fuera de `local` el esquema no lo creaba nadie (sin `migrationsRun`,
      y las migraciones fuera de `src/`). Ahora `develop`/`production` aplican `src/migrations/` al arrancar,
      e `infra/export-schema.sh` / `infra/verify-baseline.sh` exportan el DDL de las entidades y verifican
      que las migraciones crean exactamente ese esquema. Verificado en PostgreSQL y MySQL con
      `harness-check --database=`, falsado quitando una sentencia. A diferencia de keel-spring, la prueba
      en vivo cabe en el pipeline (`baselineTested: OK`, no `PENDING`): en `local` el esquema lo recrea
      `synchronize`.
    - **Agentes, convenciones y skill**: los cinco agentes, `architecture`/`constitution`/`orchestration`,
      seis convenciones y `keel-nest-database`, proyectados por `generator-docs.js`; `/keel-generate-nest`
      orquesta el mismo pipeline que keel-spring con sus mismos códigos. `infra/check-flows.sh` es el gate
      del agente de pruebas (solo cuenta los errores de `test/integration/`: tsc sigue los imports del
      arnés hasta `src/`). El arnés gana `jsonExact()` (la escala de un decimal no sobrevive a
      `JSON.parse`) y los matchers de forma; `keel-nest check` imprime `design-gaps.yaml` (lectura
      neutral en `keel-core/gen/design-gaps.js`). `harness-check` 25/25.
  - **7d hecho (2026-10-06): primer servidor equivalente demostrado.** `product-catalog` v1.1.0 (con
    `activateProduct` y el token fuera del contrato) completado por los dos pipelines: **keel-nest 23/23**
    y **keel-spring 23/23**, mismos escenarios (`docs/corridas/2026-10-06-product-catalog-{nest,spring}.md`).
    El arnés y los gates funcionaron a la primera (sin `harnessPatches` ni `culprit: harness`), y el
    baseline salió verificado en vivo. Pero la huella de keel-nest (12 reescritos frente a 6) destapa un
    **hueco del generador**: la idempotencia de petición, que keel-nest aún no emite, la escribió el agente
    a mano tocando cinco archivos de build, con otra tabla (`idempotency_keys`) y SQL solo de PostgreSQL.
    Los escenarios pasan; el esquema y el motor ya no son los de keel-spring. Siguiente: adelantar del
    incremento 10 la idempotencia de petición.
  - (Preparación de 7d, histórico) `product-catalog` trae `validation-scenarios.md` (6 flujos). Dos cosas antes de
    la corrida: (1) `createProduct` declara idempotencia, que keel-nest genera en el incremento 10, así
    que FL-PRD-002/003 no pueden pasar todavía contra keel-nest; (2) el diseño no está `--ready`
    (revisión, barrido de huecos, careo y decisiones estructurales son del diseñador): la corrida va con
    `--accept-unready` o tras cerrarlo con `/keel-design`.
  - **Diferencias con keel-spring, a la vista**: en Vitest un `beforeAll` que revienta da los casos por
    OMITIDOS (no hay `initializationError`), así que el arnés vuelca `<flujo>-init.json` y el script lo
    lista como arnés roto; el código 3 (workers de Gradle que sostienen `build/`) no existe aquí. Y el
    reset es automático en `useFlow()` (en keel-spring lo llama el `@BeforeAll` que escribe el agente).

### Inc. 10a — Idempotencia de petición (adelantada del incremento 10)

- **Por qué se adelanta** (cambio de orden respecto al plan, decidido el 2026-10-06): la corrida del
  inc. 7 demostró que un aviso de frontera no frena al agente cuando un escenario exige el mecanismo —lo
  escribió a mano, con otra tabla y SQL de un solo motor—, y casi todas las fixtures declaran
  `idempotency`. La regla de orden del plan lo permite: este tramo solo usa la persistencia del inc. 6;
  lo que depende del inc. 9 (la deduplicación de mensajes, `processed_event`) y del scheduling
  (barridos, reclamos, reconciliación, la purga) sigue en el incremento 10.
- **Estado: hecho (2026-10-06).**
  - **Neutral, en `keel-core/gen/request-idempotency.js`**: qué operaciones usan el registro
    (`registryOperations`: con `idempotency` y sin la guarda de clave natural), cuándo viaja la clave por
    la cabecera, y la tabla `idempotency_record` como DATOS (`IDEMPOTENCY_RECORD`: clave primaria
    `(operation_scope, idempotency_key)`, `signature`, `resource_id`, `created_at`, `expires_at` y el
    índice de la purga), que es la de keel-spring.
  - **En keel-nest**, `src/scaffold/request-idempotency.js`: el puerto `IdempotencyStore`
    (`domain/idempotency`), los dos errores de conflicto con el `code` del catálogo o el del diseño,
    `CommandSignature` (firma canónica), `IdempotencyContext` (la cabecera, abierta en el hook de entrada
    HTTP), la entidad y el adaptador TypeORM (sin SQL a mano: el motor lo pone TypeORM). El handler de la
    operación recibe el puerto inyectado y la nota con el algoritmo (reclamar PRIMERO, reproducir sin
    re-ejecutar, no capturar la carrera); `mapping.md` lo enseña con código. La frontera solo avisa ya si
    el diseño declara idempotencia sin persistencia.
  - **Puerta medida**: `schema-parity` compara la tabla con `IdempotencyRecordJpa` de keel-spring
    (falsado con una cota: caen las 4 fixtures con idempotencia). `db-check` **20/20** en PostgreSQL y
    MySQL: esquema, guardar y encontrar, el ámbito en la clave, la clave repetida y la carrera de dos
    transacciones como el conflicto con su `code`, la caducada sustituible y el rollback con el comando
    (falsado quitando la traducción: caen esas dos comprobaciones en las tres fixtures).
    `test/request-idempotency.test.js` ejecuta la firma y el contexto (falsado sin el orden de claves).
    `ts-check` 11/11.
  - **Sin cubrir todavía**: la purga de las claves caducadas (necesita el scheduling del inc. 10; `find`
    ya las ignora y `save` las sustituye), el gate estático `check-idempotency.sh` (familia
    `commandIdempotency`, inc. 10).
  - **Corrida v2 (2026-10-06)**: `product-catalog` con keel-nest, **23/23 a la primera** y huella de **7
    reescritos** (12 en la v1; keel-spring, 6): los handlers, el agregado y la guía de despliegue del
    README. Ningún archivo de infraestructura de build tocado y el handler idempotente con el algoritmo
    prescrito (`docs/corridas/2026-10-06-product-catalog-nest-v2.md`). Con esto el servidor de keel-nest
    del diseño es equivalente al de keel-spring también en el registro de idempotencia.

### Inc. 8 — Seguridad

- `scaffold/{security,auth-provisioning}.js` + skills `keel-nest-keycloak`, `keel-nest-cognito`:
  guard JWT con JWKS, roles/authorities, `access` por operación, `scoping` por recurso (403),
  `callerIdentity` resuelta en un único punto, validación de audiencia por proveedor,
  `realmSpec()` neutral → script kcadm y `realm-export.json`.
- **Puerta**: `caller-identity`, `auth-scoping`, `keycloak-script-runs` (ejecuta el bash con el
  stub); corrida con `security` (asset-vault o profile-directory).
- **Estado: hecho (2026-10-07), salvo la corrida**, en dos commits:
  - **8a — neutral en `keel-core/gen`** (keel-spring con su línea base idéntica, 42 combinaciones y
    10 457 archivos, falsada cambiando el texto de su arnés): `identity-provisioning.js` (el realm de
    prueba, `test-credentials.env` y el emulador de Cognito; cada generador pone sus textos en
    `platform.identity`) y `access-plan.js`: lo que exige cada regla (`accessRequirement`, atado a la
    traducción de Spring por test), qué rutas comprueban la audiencia, las cadenas en su orden de
    evaluación y los claims de cada proveedor (`TOKEN_CLAIMS`). keel-spring toma de ahí sus predicados.
  - **8b — keel-nest** (`src/scaffold/security.js`): la autorización es un **hook `onRequest`, no un
    Guard** — Spring Security decide antes de enrutar, así que sin credencial un camino que no existe es
    401 (no 404), y un Guard solo corre cuando una ruta casa. Las reglas son DATOS (`access-rules.ts`)
    comparados con la `SecurityConfig` que emite keel-spring en las 5 fixtures con seguridad × Keycloak y
    Cognito (`test/security-parity.test.js`, falsado quitando una authority: caen 10 de 10). JWT con
    `jose` (discovery del `issuer-uri` perezoso: arranca sin el proveedor, y un proveedor caído es 500,
    no 401), 60 s de margen, un bearer inválido es 401 también en una ruta abierta; claves de API en
    tiempo constante; CORS con la semántica del `DefaultCorsProcessor` dentro del mismo hook y antes de
    autenticar (con `@fastify/cors` el 401 salía sin cabeceras CORS: sus hooks se cargan después);
    `CallerIdentity` como punto único y `CallerScope` (puerto en `application/support`, inyectado en los
    handlers que declaran el error del alcance). Configuración con las MISMAS variables que keel-spring
    (`OAUTH2_ISSUER_URI`, `SECURITY_AUDIENCE`, `SECURITY_API_KEY`, `API_KEY_<CLIENTE>`,
    `SECURITY_CORS_ALLOWED_ORIGINS`). El perfil `test` solo acepta tokens de la clave que la prueba
    publica en `SECURITY_TEST_JWKS` (`test/support/test-credential.ts`): ninguna clave en el repo. El
    arnés gana `tokenFor`, `serviceCredential`, `tokenAs` (personas por `sub`), `scopedResource` y
    `bearer`, y el humo SMOKE-5; skills `keel-nest-keycloak` y `keel-nest-cognito`. La frontera ya no
    rechaza la capa; sí `callerIdentity.from.resolvedBy` (el finder por elemento de colección).
  - **Puerta medida**: `test/security.test.js` EJECUTA reglas, autenticador (tokens reales firmados con
    jose: caducado, otra clave, margen de reloj, roleGrants, Cognito), identidad y alcance; la prueba
    emitida de la API trae los casos de seguridad (falsada con un `verdict` que siempre concede: caen
    el 401 y el 403). `ts-check`: las 13 fixtures compilan y sus pruebas pasan. **`npm run
    security-check` (nuevo) 20/20** contra PostgreSQL y Keycloak reales: `init-keycloak.sh` siembra y
    es idempotente, y nueve sondas (401 sin credencial y con token inválido, 403 sin el permiso, el `sub`
    del token llega al handler, `tokenAs` con su `sub` y sus claims, la identidad no se acepta del
    cuerpo, 401/404 de un camino inexistente, 401 con el token de otro emisor); falsado rebajando la
    regla emitida de la ruta (sale FALLO la sonda del 403).
  - **Regresión ajena destapada**: `harness-check` estaba en rojo desde 7d — `product-catalog` trae ya
    su `validation-scenarios.md`, que entra en el sello `specs.sha256`, y el check lo sustituía por su
    documento sonda (el sello lo cazaba bien: salida 2). Ahora retira esa línea del sello: 25/25.
  - **Pendiente**: la corrida. `profile-directory` (la única fixture con seguridad cuyas demás capas
    genera keel-nest) no tiene `validation-scenarios.md`: hay que escribirlos y llevarla a `--ready`
    antes de correr `/keel-generate-nest` (y la misma en keel-spring).

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

