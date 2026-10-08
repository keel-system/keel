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
  - **Preparación de la corrida (2026-10-07)**: `profile-directory` v1.0.0 llevada a `--ready` 11/11
    (entra en `READY_FIXTURES`): 13 escenarios en tres flujos (FL-CRD-001 alta, lectura y reemplazo
    entero; FL-CRD-002 dos titulares que no se ven ni se pisan, y la identidad ignorada en el cuerpo;
    FL-CRD-003 401 y 403), registro estructural, barrido de huecos, revisión, careo y `DESIGN.md`. El
    diseño gana `conventions.nulls: include` y la regla del reemplazo entero. Las decisiones las tomó
    quien preparaba la corrida, por delegación. El careo lo rehizo después `keel-flow-review` con contexto
    limpio: la pasada 2 encontró que `getMyCard` no declaraba cómo encuentra la ficha (solo lo decía una
    regla de `saveMyCard`; cerrado en el diseño) y el 403 de un usuario sin roles (aceptado), y la
    pasada 3, completa, salió limpia.
  - **Corrida (2026-10-07): keel-nest 13/13 a la primera, huella 4** (los dos handlers, el agregado y el
    README; ningún archivo de seguridad tocado), y la gemela de **keel-spring 14/14** tras un ciclo, también
    con huella 4 (`docs/corridas/2026-10-07-profile-directory-{nest,spring}.md`). Las dos sin
    `--accept-unready`: es la primera corrida de cualquier generador que entra por la puerta de `--ready`.
    La equivalencia cazó un **defecto de keel-spring**: un bearer inválido salía como 401 sin cuerpo
    (el entry point de `oauth2ResourceServer` pisaba al del contrato), que keel-nest cumplía desde el
    principio; arreglado y falsado. Y el comentario del scaffolding que llamaba «convención» al `code`
    canónico de la clave natural (provocó un `designGap` falso en keel-spring) dice ya, en los dos
    generadores, que es el de la familia `uniqueness` de `framework-errors.md`.

### Inc. 9 — Mensajería y outbox

- `scaffold/{events,messaging,outbox,dead-letter-config,messaging-provisioning}.js` + skills
  `keel-nest-{rabbitmq,kafka,snssqs}`: `EventEnvelope`, bridge dominio→integración, relay
  con reclamo `SKIP LOCKED` y backoff, señal de rendición, `reliability` best-effort vs outbox,
  suscripciones con deduplicación (`processed_event`, clave `metadata.eventId` con envoltura
  Keel), reintento sin reintentar el rechazo de negocio, dead-letter con destinos de
  `subscriptionDestination()`. Orden: RabbitMQ → Kafka → SNS/SQS.
- **Puerta**: `broker-check` sobre el proyecto nest (sondas neutrales), `store-check` (relay),
  corridas rabbit y kafka del mismo diseño (serie como la de keel-spring).
- **Preparación (2026-10-07, sin código todavía)**. Lo averiguado, para empezar sin releerlo todo:
  - **Fixtures objetivo**: `inspection-reports` (outbox + suscripción con envoltura Keel + API; la
    corrida natural del incremento) y `metering-digest` (best-effort + suscripciones de una fuente ajena
    `wrapped`, con `wireName`, discriminador y `messageId` en cabecera, `retry` y `deadLetter`; sin API).
  - **Lo que ya existe en keel-nest**: `EventMetadata`, `DomainEvent`, un `<Evento>Event` por evento con
    `of(...)`, y `raise`/`pullDomainEvents()` en la raíz. El adaptador de repositorio drena y **descarta**
    los eventos (`repositories.js`, `TODO (incremento 9)`): ahí entra el puente.
  - **Lo neutral que ya existe en keel-core/gen**: `WIRE_SHAPES.eventEnvelope`/`eventMetadata` (wire.js),
    destinos y descarte (`dead-letter.js`: `subscriptionDestination`, `publishedDestination`,
    `deadLetterName`), sondas de broker (`broker-probes.js`), y en el modelo `events[]` (destino, routing
    key, canal), `messaging.reliability` y `subscriptions[]` con su contrato (`envelope`, `payloadPath`,
    `discriminator`, `messageId`, `wireName`, `unknownFields`, `trigger`, `triggerArguments`,
    `triggerHasDomainGuard`, `deadLetter`, `queueDefault`/`topicDefault`).
  - **Qué emite keel-spring y keel-nest tiene que igualar** (`messaging.js`, `outbox.js`,
    `idempotency.js`, `dead-letter-config.js`, `config.js` § `brokerYaml`/`messagingYaml`):
    `EventEnvelope.of(metadata, data, correlationId)`; `<Evento>IntegrationEvent` (la metadata NO se
    serializa en `data`); el puente (outbox → escribe la fila en la transacción; best-effort → publica
    tras el commit por un puerto `<Evento>Publisher` con un stub que solo avisa); tabla `outbox_event`
    (`id, destination, routing_key, event_type, payload text, created_at, published_at, attempts,
    next_attempt_at, last_error(1024)`, índice `ix_outbox_event_pending (published_at, created_at)`);
    relay en tres pasos (reclamo corto con SKIP LOCKED + lease en `next_attempt_at`, publicación fuera de
    transacción, desenlace corto con backoff `initial·2^(n-1)` con tope) y puerto `OutboxDispatcher` cuyo
    respaldo FALLA al arrancar fuera de `local`/`test`; `processed_event` con PK `(handler_id(128),
    event_id(255))` e índice `ix_processed_event_processed_at`, y `IdempotencyGuard` con
    `alreadyProcessed`/`record` (con guarda de dominio) y `tryRecord` (sin ella), la carrera resuelta en
    la clave; la clase del mensaje de cada suscripción con `requireContract()` (llamado DESPUÉS de filtrar
    por `eventType`; un incumplimiento no se reintenta). Mismas claves y variables de entorno:
    `RABBITMQ_HOST/PORT/USERNAME/PASSWORD`, `MESSAGING_DESTINATION`, `messaging.subscriptions.<clave>.topic`
    y `.queue` (RabbitMQ/SNS) o `.group-id` (Kafka), `OUTBOX_RELAY_*` (en `local`, 40 intentos y tope de
    backoff 2 s), `PROCESSED_EVENT_PURGE_*`.
  - **RabbitMQ**: build declara la topología de consumo (exchange topic del canal de origen, cola propia
    `queueDefault` enlazada con `#`, y la DLQ `<cola>-dlq` por argumentos `x-dead-letter-*`), y el
    reintento del listener con `onFailure.retry` sin reintentar `DomainException`. Lo publicado se lee en
    una cola por canal nombrada como el canal (la declara el agente, skill del broker).
  - **Decisiones tomadas**: (1) `TransactionContext` necesita `afterCommit(callback)` para best-effort;
    (2) el relay va con un bucle propio de retardo fijo; el scheduling (`@nestjs/schedule`) y las purgas
    de `outbox_event` y `processed_event` llegan con el incremento 10, como la de `idempotency_record`;
    (3) orden RabbitMQ primero: la frontera rechaza `kafka` y `snssqs` hasta su tramo; (4) tablas como
    DATOS en keel-core (como `IDEMPOTENCY_RECORD`), con `schema-parity` contra keel-spring.
  - **Tramos propuestos**: 9a tablas y parámetros del relay neutrales en keel-core; 9b keel-nest emite
    envoltura, eventos de integración, puente, outbox con relay, `processed_event` y guard, mensajes de
    suscripción y la topología RabbitMQ; 9c arnés (`flow.ts`: entregar a una suscripción, leer lo
    publicado y la DLQ con `broker-probes`) y `broker-check`; 9d skill `keel-nest-rabbitmq` y
    convenciones; 9e corrida con RabbitMQ en los dos generadores.
- **9a — hecho (2026-10-07)**: `keel-core/gen/messaging-stores.js`, los dos almacenes y sus parámetros como
  DATOS. `usesOutbox` y `usesMessageDeduplication` (keel-spring los reexporta como `usesOutbox` y
  `usesIdempotency`); `OUTBOX_EVENT` y `PROCESSED_EVENT` (columnas con tipo del DSL, cota, nulabilidad,
  clave e índice; las de texto sin cota en JPA llevan el 255 que Hibernate les pone, y `claimed_at` va
  marcada `onlyIn: 'document'`); `OUTBOX_RELAY`, `OUTBOX_PURGE` y `PROCESSED_EVENT_PURGE` (clave, variable
  y default, con el valor propio de `local` donde difiere) con `parameterValue(param, perfil)`; y la
  referencia ejecutable de `outboxBackoffMs` y `outboxDeadLettered`, contra la que se probará lo que emita
  keel-nest. keel-spring toma de ahí el YAML de `messaging.yaml` (`parameterLine`) y el respaldo de sus
  `@Value`; las entidades JPA siguen escritas a mano y `test/messaging-stores-parity.test.js` las compara
  con los datos en el par del MVP (las dos ramas), más el YAML de cada perfil y los `@Value` (falsado: una
  cota cambiada en los datos tumba la tabla; quitar la línea del YAML tumba el perfil).
  - **Defecto de keel-spring destapado**: en el modelo RELACIONAL `outbox.relay.claim-timeout-ms` no salía
    en el YAML —con un comentario de cuando el relay sostenía el lock durante el despacho—, pero desde que
    publica fuera de la transacción el reclamo es un lease sobre `next_attempt_at` y `OutboxRelay` lo lee:
    la palanca existía y ninguna variable la movía. Ahora sale en los dos modelos; el test de
    `scaffold.test.js` que fijaba lo contrario está invertido. La línea base cambia SOLO en los
    `messaging.yaml` relacionales y en el README (que lista `OUTBOX_RELAY_CLAIM_TIMEOUT_MS`): ningún
    archivo Java, ninguna fixture documental.
- **9b — hecho (2026-10-07)**: keel-nest emite la mensajería sobre RabbitMQ y persistencia relacional
  (la frontera acepta la capa; rechaza `kafka` y `snssqs` en el stack, la mensajería sin persistencia y la
  identidad del emisor con `resolvedBy`).
  - **Contratos** (`src/scaffold/messaging.js`): `EventEnvelope` (con `parse` para la entrante, que deja
    `data` sin leer hasta filtrar por tipo), un `<Evento>IntegrationEvent` por evento con la metadata NO
    enumerable (no viaja en `data`), el puente `<Servicio>DomainEventBridge` —los adaptadores de repositorio
    ya le entregan `pullDomainEvents()` dentro de la transacción; con outbox escribe la fila, con
    best-effort publica tras el commit por el puerto `<Evento>Publisher` (stub que avisa)—, la clase del
    mensaje de cada suscripción (`fromWire` con los nombres de la fuente y `requireContract()` con la
    presencia y las cotas, con las frases de keel-spring) y la envoltura propia de una fuente `wrapped`;
    `MessageContractViolation` es el `IllegalArgumentException` de keel-spring (no se reintenta). Los
    mensajes reutilizan el lector del cable y las reglas de la API (`request-reading.ts`), que ahora se
    emiten también sin API; la correlación, igual.
  - **Almacenes** (`src/scaffold/messaging-stores.js`, sobre los datos del 9a): las entidades TypeORM de
    `outbox_event` y `processed_event`, el relay en tres pasos (`OutboxRelayStore`: reclamo con SKIP
    LOCKED y lease, en READ COMMITTED en MySQL; publicación fuera de transacción; desenlace con backoff y
    rendición) con un bucle de retardo fijo propio, el respaldo del dispatcher que no deja arrancar fuera
    de local/test, y `IdempotencyGuard` (`alreadyProcessed`/`record`/`tryRecord`, en transacción propia).
    `TransactionContext` gana `afterCommit`, `inNewTransaction` (el REQUIRES_NEW) y la opción `isolation`.
  - **RabbitMQ** (`src/scaffold/rabbitmq.js`): la topología de consumo como datos (la de
    `RabbitTopologyConfig`) y la política de reintento del listener —la reconciliación de
    `onFailure.retry` pasó a `keel-core/gen/dead-letter.js` (`rabbitListenerRetry`), con keel-spring en su
    línea base idéntica—; y la CONEXIÓN con amqplib 2.2 (reconexión con `setup` que vuelve a declarar la
    topología y a arrancar los consumidores; `publish` con confirmación y `mandatory`; `consume` que hace lo
    del contenedor de Spring: ack al terminar, reintento en memoria salvo `DomainException` y
    `MessageContractViolation`, y rechazo sin reencolar → DLQ). Configuración con las variables de
    keel-spring (`RABBITMQ_*`, `RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS`) más
    `RABBITMQ_PUBLISHER_CONFIRM_TIMEOUT_MS` (10 s), propia de keel-nest: en keel-spring ese plazo lo pone el
    dispatcher del agente.
  - **Lo del agente** entra por UN archivo, `broker-bindings.ts` (`BROKER_ADAPTERS`: el dispatcher o los
    publishers, que sustituyen al respaldo por token; `MESSAGE_LISTENERS`, en un módulo que importa el de
    casos de uso): es el component-scan de Spring. `mapping.md` gana la sección `messaging`; la skill
    `keel-nest-rabbitmq` es el 9d.
  - **Puerta medida**: `test/messaging.test.js` (17) EJECUTA lo emitido: la envoltura en el cable, la
    lectura y su rechazo, los mensajes con wireName, contrato y cotas, la envoltura `wrapped`, el backoff
    contra la referencia de keel-core, la topología contra la `RabbitTopologyConfig` que EMITE keel-spring en
    cuatro fixtures, el reintento, y `messaging.yaml`/`rabbitmq.yaml` contra los de keel-spring (falsado con
    cuatro roturas: cada una tumba su test). `schema-parity` cubre las dos tablas. `ts-check` 12/12 (las 13
    fixtures, ahora con RabbitMQ donde hay mensajería). `db-check` **20/20** en PostgreSQL y MySQL con los
    almacenes (falsado quitando el lease, quitando SKIP LOCKED y sacando el registro de su transacción).
    Dos cosas que destapó: `db-check` no compilaba `notification-mailer` desde el incremento 8 (no instalaba
    `jose`) y nadie lo había relanzado; y en MySQL, un bloqueo con un predicado sin índice en REPEATABLE READ
    retiene todas las filas recorridas (lo hacía la sonda, no el relay).
  - **Sin medir todavía**: nada habla con un RabbitMQ real (la conexión, `publish` con confirmación, el
    consumo con reintento y DLQ): es el 9c (arnés y `broker-check`). Las purgas, con el incremento 10.
- **9c — hecho (2026-10-07)**: el arnés de integración con la mensajería y `broker-check`.
  - **Arnés** (`src/scaffold/messaging-harness.js`, en `flow.ts`): `deliver<Suscripción>` (la envoltura y las
    cabeceras que declara el contrato; la Keel, COMPLETA, como la publica cualquier servicio Keel —el arnés
    de keel-spring solo manda `eventId` y `eventType` y Jackson tolera el resto—), `deliverMessage`,
    `publishedMessages` (con la espera al drenaje del outbox), `deadLetterMessages`, `purgeMessages`,
    `stopBroker`/`startBroker` (que espera a que la conexión del servicio vuelva), `deadLetteredEvents`,
    `abandonOutboxEvent`/`clearAbandonedOutboxEvents` y `pauseOutboxRelay`/`resumeOutboxRelay`. Los
    comandos salen de `keel-core/gen/broker-probes.js` por el contenedor devtools (`devtoolsContainer()`,
    nuevo y neutral: se componía a mano en cuatro sitios de `infra-scripts.js`). Lo que el arnés de keel-nest
    puede y el de keel-spring no: el servidor corre en el mismo proceso, así que lo rendido y la pausa se
    le piden al relay, y la conexión recuperada, a la conexión. Cada flujo arranca con el broker arriba y la
    conexión hecha.
  - **La topología de PUBLICACIÓN pasa a build** (el exchange del servicio y una cola por canal, con el
    binding de cada routing key): en keel-spring la escribe el agente siguiendo su skill, que insiste en que
    sin ella toda aserción de mensajería falla y, con `mandatory`, el outbox se rinde. Mismos nombres: el
    servidor es el mismo.
  - **`broker-check` (nuevo) 18/18** contra RabbitMQ real sobre `stock-reservation`, con un dispatcher y un
    listener sonda registrados en `broker-bindings.ts` como lo haría el agente y flujos que usan SOLO los
    helpers del arnés: entrega y proceso, reentrega absorbida, fallo transitorio reintentado 5 veces → DLQ,
    rechazo de negocio y contrato incumplido → DLQ sin reintento, evento ajeno confirmado sin efecto, la
    fila del outbox publicada con su tipo, lo que no tiene cola no se da por publicado, el broker caído y
    vuelto sin rendición, el evento abandonado contado y la purga. Falsado haciendo reintentable el rechazo
    de negocio y quitando `mandatory`: cae cada uno en su flujo y solo ahí.
  - **Tres defectos que destapó**, los tres invisibles sin un broker que se cae: (1) la conexión reabría el
    canal de confirmaciones desde su evento de cierre sobre una conexión que se estaba muriendo — rechazos
    sin manejar, que en Node tumban el proceso, y un `ack` sobre un canal cerrado también; ahora el canal se
    abre bajo demanda al publicar, todo canal y toda promesa tienen su manejador, el cierre tiene tope y el
    relay deja de recorrer el lote al apagarse; (2) `GracefulShutdown` no cancelaba su tope de 30 s tras un
    apagado correcto: en la suite de integración (un servidor por flujo en el mismo proceso) disparaba un
    `process.exit(1)` en mitad de otro flujo — no se había visto porque ningún flujo duraba tanto; (3) el
    lector del JUnit de `broker-check` contaba como verdes los `<error>` de Vitest (los errores sin
    manejar), y así salió un primer «21/21» falso.
- **9d — hecho (2026-10-07)**: la skill `keel-nest-rabbitmq` (`SKILL.md` + `references/listeners.md` y
  `troubleshooting.md`), instalada solo con RabbitMQ en el stack. Mucho más corta que la de keel-spring: lo
  que allí es código del agente —confirmaciones con `CorrelationData`, deadline por encima del
  recovery-interval, reset con cooldown, el configurer del contenedor, el customizer del reintento, la
  topología de publicación— aquí lo hace build, y la skill solo enseña el envío (una línea sobre
  `RabbitConnection.publish`), los publishers best-effort, un listener por COLA y dónde se registra todo
  (`broker-bindings.ts`). Las lecciones que sí se trasladan, con su porqué: lo ajeno con `return` y lo
  propio roto con `throw`, el orden del guard lo dicta el diseño (y el reintento en memoria no es una
  reentrega), la carrera ya resuelta no es un fallo, la identidad del emisor resuelta antes del comando.
  El agente de código gana el paso de la mensajería; `mapping.md` e `integration-tests.md` ya lo
  documentaban desde 9b/9c. Puerta: `generator-docs.test.js` ata la skill al código emitido —se instala en
  los dos harnesses solo con el broker, cada ruta `src/…` que cita existe en lo que build emite (falsado
  cambiando una), y las firmas que enseña (`publish`, `consume`, `EventEnvelope.parse`, el guard,
  `broker-bindings`) son las de verdad—. El dispatcher de la skill es el mismo que `broker-check` ejecuta
  contra RabbitMQ real.
  - **Fixture de la corrida, por decidir antes del 9e**: `inspection-reports` es **documental** y keel-nest
    no genera Mongo hasta el incremento 12. Las relacionales con outbox arrastran capas fuera de la
    frontera: `notification-mailer` (mail, inc. 13), `payment-checkout` (payments, 13), `stock-reservation` y
    `catalog-extended` (http-clients, 11; storage, 13). `metering-digest` es relacional pero best-effort y
    sin API. Opciones: una fixture nueva relacional (outbox + suscripción con envoltura Keel + API), o una
    variante de una existente sin las capas ajenas, como hacen los tests con `NEST_READY_DESIGN`.
- **Orden de lo que queda (decidido el 2026-10-07)**: la corrida con RabbitMQ (9e) **antes** que Kafka (9f) y
  SNS/SQS (9g), para medir de punta a punta lo construido antes de multiplicarlo por tres brokers: si la
  corrida destapa un defecto de las piezas comunes, se arregla una vez. El desglose inicial (9a–9e) solo
  desglosaba RabbitMQ; Kafka y SNS/SQS siguen siendo parte de este incremento.
- **9e — hecho (2026-10-07)**: corridas ejecutadas y registradas en
  `docs/corridas/2026-10-07-stock-reservation-events-{nest,spring}.md`. keel-nest **18/18** a la primera con
  huella **9** (todo TODO legítimo; el de más frente a los 8 de keel-spring es `broker-bindings.ts`), sin
  `harnessPatches` ni archivos de mensajería de build tocados; keel-spring 14/14. Un hueco del generador: los
  comentarios nombraban un listener por suscripción con la cola compartida (ahora uno por cola,
  `consumerQueues`). Un hueco del diseño que no reportó nadie (`late-outcome-after-release`): el `gaps.yaml`
  mandaba al descarte un `StockReserved` tardío que los dos servidores confirman sin efecto; corregido.
  Preparación: la fixture `stock-reservation-events` v1.0.0, la
  variante de `stock-reservation` sin `http-clients`, `dependencies` ni la reconciliación por reloj (otra
  silueta y otros incrementos), con `security` declarada abierta (`protocol: none`, API interna) en vez de
  ausente. Llevada a **`--ready` 11/11**: escenarios reescritos (fuera los de clúster y reconciliación,
  que necesitan réplica y barrido; dos `Then` que prometían «sin reintentos» quedan en lo observable —que no
  hay descarte—; `FL-RES-004` cubre `RESERVATION_NOT_FOUND` por las dos puertas), registro estructural de
  siete secciones, revisión, barrido de las 12 clases (corrigió un comentario falso sobre la carrera
  rechazo/confirmación y dejó sin cota el motivo del rechazo, ahora 255), careo en dos pasadas (cuatro
  `Given` que se apoyaban en otro flujo, corregidos) y `DESIGN.md`. El careo lo hizo quien preparaba la
  corrida, no un `keel-flow-review` de contexto limpio: se puede repetir con él. Entra en `READY_FIXTURES`;
  `compile-check` del `main` en verde (rabbitmq, postgresql y mysql). Workspaces en
  `spring-live-test/corrida-stock-reservation-events-{nest,spring}/`, con el proyecto generado por `build`
  sobre PostgreSQL y RabbitMQ (estampado `ready: true`, 176 y 220 archivos).
- **9f — Kafka, hecho (2026-10-07)**: el cliente es `@confluentinc/kafka-javascript` 1.10 (librdkafka con API
  compatible con KafkaJS y binarios precompilados, también para Windows): `kafkajs` no publica desde 2023 y
  `@platformatic/kafka` exige Node ≥ 22.22, por encima del 22.12 del proyecto generado. Antes de escribir nada
  se midió el cliente contra un Kafka real, y salieron tres cosas: `connect()` sin broker rechaza a los 30 s
  (la conexión va en un bucle en segundo plano, el servicio arranca sin broker); un `eachMessage` que lanza hace
  que el cliente reentregue el MISMO mensaje (así que el reintento y el descarte los resuelve la conexión, y
  lanzar queda para cuando no hay desenlace: el `.DLT` no se pudo escribir); y un consumidor suscrito a un topic
  que aún no existe no lo ve hasta el siguiente refresco de metadatos, 5 min por defecto (el perfil `local`
  refresca cada 2 s: el mensaje llega en medio segundo). **Neutral nuevo** en keel-core: `kafkaListenerRetry`
  (la curva sale de las suscripciones con descarte, como `DeadLetterConfig`; sin ninguna, diez intentos sin
  espera, el `DefaultErrorHandler` por defecto) y `KAFKA_PRODUCER_TIMEOUTS` (keel-spring los toma de ahí, golden
  idéntico), más `RECORD_FORMAT` y el `format` opcional de la lectura de Kafka en `broker-probes`. **keel-nest**:
  `src/scaffold/kafka.js` (consumo como datos, la conexión con productor `acks: -1` idempotente, un consumidor
  por suscripción con su grupo `<servicio>-<evento>`, reintento en memoria y descarte en `<topic>.DLT` con los
  headers de Spring Kafka, partición y offset en binario), `group-id` en `messaging.yaml` (paridad con
  keel-spring), `consumerUnits` (los textos para el agente nombran un listener por suscripción con su grupo), la
  rama Kafka del arnés (marca de offset por canal y por descarte al abrir el flujo, lectura con clave y headers,
  entrega por `kcat -P`, espera a que cada consumidor cuyo topic existe tenga particiones), y la skill
  `keel-nest-kafka`. `broker-check` recorre los dos brokers: **36/36** (Kafka 18, RabbitMQ 18), con
  `FL-BRK-001-G` propio de Kafka (el descarte conserva la clave y lleva `kafka_dlt-original-topic` y
  `kafka_dlt-exception-message`). Falsado haciendo que la conexión olvide qué topics descartan (`deadLetter: false` al
  registrar la suscripción, que compila igual): caen `FL-BRK-001-C`, `-D`, `-E` y `-G`, los cuatro que esperan algo
  en la `.DLT`, y solo esos. Lo que destapó la primera pasada: dos casos del outbox con el broker parado y
  vuelto morían en el plazo de 30 s por caso de Vitest, sin nada roto (cada `kcat -L` contra el broker parado
  tarda 5,6 s y cada `podman exec` 1,5 s en Windows): con mensajería, el plazo es de 120 s; y
  `awaitOutboxDrained` esperaba también a la fila ya rendida, agotando sus 15 s en cada lectura (con los dos
  brokers). `ts-syntax` y `ts-check` juzgan cada fixture con mensajería sobre los dos brokers.
- **9g — SNS/SQS, hecho (2026-10-07)**: `infra/init-messaging.sh` y sus checks pasan a keel-core
  (`gen/messaging-provisioning.js`, con los textos de cada generador por parámetro; keel-spring queda como capa
  fina y su golden no se mueve). **keel-nest**: `src/scaffold/snssqs.js` sobre el SDK v3 de AWS
  (`@aws-sdk/client-sns` y `-sqs` 3.1147): las mismas variables que keel-spring; la publicación con el tipo como
  message attribute `eventType` (sobre él filtran las suscripciones) y el ARN resuelto LISTANDO y exigiendo un
  suscriptor confirmado —lo que la skill de keel-spring le pide escribir al agente: el resolutor por defecto
  crea el topic, y un topic sin suscriptores descarta sin error—, con los plazos cortos de SNS de esa misma
  skill; y un consumidor por suscripción que sondea su cola (la de `init-messaging.sh`): borra al terminar bien,
  aplica la curva del diseño alargando la VISIBILIDAD (`initialDelayMs·2^(n-1)`, la de la skill de keel-spring;
  1 con `fixed`), deja que la RedrivePolicy lleve lo agotado a la DLQ y lleva él lo no reintentable directo a la
  DLQ (la salida que esa skill da para los errores que el diseño no quiere reintentar). Sin DLQ declarada, lo
  agotado se registra y se borra, como con los otros dos brokers — **keel-spring con SNS/SQS sin descarte lo
  reintenta para siempre** cada visibilidad (anotado, no corregido aquí). Arnés: lectura en barrido que oculta
  y suelta (`SQS_SWEEP_VISIBILITY`), dedupe por `MessageId`, y `startBroker` que resiembra con el relay en pausa y
  espera a que una sonda llegue a la cola de arnés antes de soltar el broker (LocalStack pierde la topología al
  reiniciarse). `broker-check` con `FL-BRK-002-B` propio: una fila cuyo topic no existe no se da por publicada.
  Skill `keel-nest-snssqs`. `ts-syntax` y `ts-check` juzgan cada fixture con mensajería sobre los tres brokers
  (`ts-check` 12/12 con 32 siluetas). `broker-check` con SNS/SQS **19/19** (los tres brokers en una pasada: **55/55**), falsado con dos sabotajes que compilan
  —`isRetryable` que lo reintenta todo y la resolución del topic que lo crea sin exigir suscriptor—: caen
  `FL-BRK-001-D`, `-E` y `FL-BRK-002-B`, y solo esos. El primer intento de sabotaje no compilaba (TypeScript
  estrechaba el tipo) y habría pasado por falsación sin medir nada: el proyecto saboteado se compila ANTES de
  lanzar la pasada.

### Inc. 10 — Idempotencia, compensación, reconciliación y barridos

- `scaffold/{idempotency,http-idempotency,reconciliation-claim,claim,scheduling,
  idempotency-check,last-known}.js`: `idempotency_record` + firma del comando, `keySource`
  (`client-key`, `payload-field` sin mecanismo cuando la `naturalKey` es la guarda),
  reclamo como arriendo con `stalledAfter`, barrido sin transacción abarcadora,
  `check-idempotency.sh` portado con sus familias y **saliendo rojo recién generado**.
- **Puerta**: `claim-check` y `store-check` portados (postgres, mysql); medición por mutación
  (romper cada mecanismo conservando su forma ⇒ algún `FL-*` rojo); corrida de
  `customer-refunds`/`stock-reservation`.
- **Evaluación al abrirlo (2026-10-07)**. Lo que ya existe: la idempotencia de petición (10a) y la
  deduplicación de mensajes (`processed_event` + `IdempotencyGuard`, 9b). Lo que el modelo neutral ya
  decide: `schedule` de cada operación, los reclamos de un barrido (`operation.claim[]`, con `stalled`
  para el rescate de `stalledAfter`), la guarda de efecto irreversible (`guardClaim`) y la
  reconciliación (`reconciles[]`). Qué fixtures de la frontera actual lo pisan: `metering-digest`
  (cierre diario sin reclamo), `payout-runs` (un barrido con reclamo y uno de cierre sin él) y
  `job-dispatch` (reclamo más rescate por `stalledAfter`). **La reconciliación, la compensación y
  `lastKnown` se mudan al incremento 11**: las tres cuelgan de `dependencies`/`http-clients` (ninguna
  fixture las declara sin esas capas), y la guarda de efecto irreversible solo la declara
  `notification-mailer`, que espera al correo (13).
- **Tramos**: **10b** scheduler de las operaciones con `schedule` (el reparto del segundo y la decisión
  de despachar sin transacción pasan a keel-core) y las purgas por lotes de `outbox_event`,
  `processed_event` e `idempotency_record`, con su configuración paritaria; **10c** reclamos de barrido y
  rescate (`claim.js`) con la parte del arnés (`stallInFlight`/`putInFlight`/`inFlightWithoutClock`) y su
  medición contra los motores (`db-check`); **10d** el gate `check-idempotency` portado; **10e** corrida
  (`payout-runs` o `job-dispatch`) en los dos generadores.
- **10b — reloj y purgas, hecho (2026-10-07)**. **Neutral nuevo**, `keel-core/gen/scheduling.js`: el
  segundo de arranque repartido (`scheduleSeconds`/`scheduleCron`), cómo se despacha cada operación por reloj
  (`scheduleDispatch`: sin transacción abarcadora si reconcilia, llama a la pasarela, alimenta una guarda
  irreversible o reclama su lote; con ella, lo demás), y la purga por lotes (`BATCHED_PURGE`, sus claves y
  `batchedPurgeReference`, la referencia ejecutable); más `IDEMPOTENCY_RECORD_PURGE` en
  `request-idempotency.js`. keel-spring los toma de ahí con su golden **idéntico** (43 combinaciones).
  **keel-nest**: `src/scaffold/scheduling.js` (`Scheduling` sobre `cron` 4.4 a pelo —no @nestjs/schedule: las
  expresiones de las purgas salen de la configuración—, con `waitForCompletion` como el `@Scheduled` de Spring,
  parada que espera a la pasada en vuelo, `scheduling.enabled` apagado en `test`; un `<Grupo>Scheduler` por
  grupo con operaciones por reloj, con correlación nueva por pasada) y `src/scaffold/purge.js` (el bucle sin
  framework y `TablePurges`, cada lote en una transacción nueva, con las claves, variables y defaults de
  keel-spring en `messaging.yaml` e `idempotency.yaml`). La nota del handler dice cómo lo despacha su
  scheduler; `mapping.md` lo enseña. La frontera deja de avisar del `schedule` y avisa del **reclamo** de un
  barrido con transiciones (10c). Puerta: `test/scheduling.test.js` (11) compara segundo y despacho con el
  `Scheduler.java` que emite keel-spring en las tres fixtures, ejecuta el bucle contra la referencia de keel-core
  (con repetidos en la frontera y con tope) y la configuración contra la de keel-spring; falsado poniendo el
  segundo a 0 (cae `payout-runs`, la única con dos barridos) y quitando el último lote del bucle (cae ese test).
  `db-check` **20/20** con las purgas contra los dos motores en las cuatro fixtures (lotes de dos con instantes
  repetidos, el tope y la pasada siguiente, lo vigente y lo pendiente del outbox intactos), falsado cortando el
  outbox por `created_at`: caen esas tres comprobaciones en las dos fixtures con outbox, y solo esas. El primer
  sabotaje —quitar `published_at IS NOT NULL`— no falsaba nada: con la columna nula, `published_at < :cutoff`
  ya es falso en SQL, así que la condición es redundante (se conserva por paridad e intención). `ts-check`
  12/12 (las 32 siluetas compilan con `strict` y el servidor arranca con el reloj). Lo que no mide ninguna red:
  que un tick dispare de verdad el handler (lo medirá la corrida del 10e) y el apagado con una pasada en vuelo
  (en Windows SIGTERM no ejecuta los hooks).
- **10c — reclamos de barrido, rescate y parámetros de despliegue, hecho (2026-10-07)**.
  - **Hueco de frontera destapado al abrirlo**: keel-nest **ignoraba en silencio** los parámetros de despliegue
    (`service.parameters`, DSL 2.15) —ni código ni aviso—, y el rescate de `job-dispatch` lee su plazo de uno.
    Ahora se generan (`src/scaffold/service-parameters.js`): el value object de dominio con las guardas de
    keel-spring (con sus mensajes), un módulo global que lo puebla desde `<artifactId>.<clave>`, y el fragmento
    por perfil con el gradiente, que pasa a keel-core (`gen/service-parameters.js`, `parameterProfileValue`).
    `test/service-parameters.test.js` compara los fragmentos con los de keel-spring en las tres fixtures que los
    declaran y EJECUTA las guardas.
  - **Neutral nuevo** en `keel-core/gen/scheduling.js`: el orden de los candidatos (`claimOrderField`), las
    claves de `sweep.*` agrupadas por bloque (`sweepConfig`), y las sentencias con las que el arnés fabrica la
    precondición del rescate (`rescueProbes`, `stallSql`, `missingClockCountSql`). keel-spring los toma de ahí con
    su golden idéntico. **Y el golden ya no depende del fin de línea**: los assets se copian tal como están en la
    copia de trabajo, y normalizarla a LF (tras unos archivos que las ediciones habían dejado en CRLF) movía 504
    huellas sin que build cambiara nada; la línea base se regeneró sobre el commit anterior, sin el cambio.
  - **keel-nest** (`src/scaffold/claim.js`): un método por reclamo en el puerto y en el adaptador —candidatos con
    `FOR UPDATE SKIP LOCKED` y un UPDATE condicional por fila, en transacción propia y en READ COMMITTED en
    MySQL; la cola estampa el reloj del rescate en el mismo UPDATE; el rescate solo se lleva lo más viejo que su
    plazo (de `sweep.*` o del parámetro del diseño) y ARRIENDA sin cambiar el estado—, `sweep.yaml` paritario, la
    nota del handler («el reclamo ya está generado»), y en el arnés `stallInFlight`/`putInFlight`/
    `inFlightWithoutClock` por la misma CLI que `db()`. La frontera deja de avisar del barrido.
  - **Puerta medida**: `test/claim.test.js` (9) y `keel-core/test/scheduling.test.js` (7). `db-check` **24/24** con
    `payout-runs` como sujeto nuevo: la cola (orden, lote, destino, reloj estampado, la pasada siguiente), dos
    réplicas a la vez, SKIP LOCKED, el rescate (solo lo abandonado, arrienda, renueva, no toca lo fresco) y las
    MISMAS sentencias del arnés contra el motor. **Falsado por capas**: sin el bloqueo cae solo SKIP LOCKED; sin
    el bloqueo ni la condición del UPDATE cae además la carrera; sin la cota temporal caen las tres del rescate.
    Quitar solo la condición no pone nada rojo, y es correcto: con SKIP LOCKED dos réplicas nunca seleccionan la
    misma fila, y la condición es la segunda defensa (la que sostiene el reclamo en un motor sin SKIP LOCKED).
    `ts-check` 12/12; destapó que la prueba de casos de uso emitida montaba sus módulos a mano sin el de
    parámetros.
  - **Sin medir**: las sondas del arnés no están falsadas por mutación, y el barrido que build NO puede reclamar
    (`payout-runs.closePayoutRuns`, dos estados en vuelo) queda para el agente con el aviso del modelo y el gate
    de 10d (familia `sweepClaim`).
- **10d — el gate `check-idempotency.sh`, hecho (2026-10-07)**.
  - **El motor pasa a keel-core** (`gen/idempotency-gate.js`): las tres clases de comprobación (`unit`, `impl`,
    `claim`), el recorte por bloque y la salida por familia, con lo que cambia entre lenguajes en `platform`
    (carpeta de fuentes, extensión, archivos de mensajes). Extraído del de keel-spring copiando su texto exacto
    (los escapes del bash no se reescriben a mano) y neutralizando la prosa; su `check-idempotency.sh` cambia
    solo en esa prosa y en dos arreglos del motor (abajo), con los 220 tests que lo EJECUTAN en verde.
  - **keel-nest** (`src/scaffold/idempotency-check.js`): la MATRIZ con patrones de TypeScript, con las mismas
    familias y sujetos que keel-spring para el mismo diseño (`dedupe`, `payloadContract`, `commandIdempotency`,
    `domainEvent`, `sweepClaim`, `outboxDelivery`), salvo `conditionalUniqueness` —en TypeORM cada save escribe al
    momento: no hay volcado diferido que ordenar— y la escritura de los registros, que es la misma promesa con
    otra forma (`insert` y no `save`, que en TypeORM es un upsert). El listener no tiene nombre fijo en keel-nest:
    se localiza por contenido (los mensajes que nombra y la guarda). El dispatcher del outbox se exige registrado
    en `broker-bindings.ts`. Los agentes de código y de calidad lo ejecutan y lo reportan (`idempotency:`).
  - **Medido**: `test/idempotency-check.test.js` (17) compara familias y sujetos con keel-spring en 5 fixtures × 3
    brokers, y EJECUTA el gate: rojo recién generado en las cinco familias de `stock-reservation-events` y en las
    dos de `payout-runs`; verde con el uso correcto; rojo otra vez leyendo el lote con un finder. **Contra las
    corridas reales de keel-nest** (copiadas, sin tocar): `stock-reservation-events` **verde** en sus cinco
    familias; `product-catalog` v2 **verde**; y `product-catalog` v1 —la corrida en la que el agente escribió su
    propio registro con otra tabla, el defecto que motivó el 10a— **roja**. Falsado sobre la copia de
    `stock-reservation-events` con cinco sabotajes que conservan la forma (`record` renombrado, `requireContract`
    quitado, la firma a mano, el `raise` quitado, el dispatcher sin registrar): cada uno tumba su familia y solo esa.
  - **Dos defectos del MOTOR que destapó keel-nest**, invisibles en keel-spring porque allí el reclamo generado vive
    en otro archivo (el repositorio declarativo): (1) con `scope: method`, el recorte se quedaba con el PRIMER bloque
    que casaba y, si era el de build (`deny`), abandonaba el archivo entero sin mirar el del agente; ahora salta los
    bloques denegados y sigue; (2) cuando todos los bloques con llaves eran de build, la reserva por párrafos partía
    uno de ellos por una línea en blanco y su trozo ya no nombraba lo que el `deny` busca: el barrido que build no
    puede reclamar salía VERDE recién generado. La reserva por párrafos solo se usa ya en archivos sin bloques que
    casen. Y en keel-nest el `save` generado también es una escritura condicional (la versión del bloqueo
    optimista): va en el `deny`, o el mismo barrido salía verde.
- **10e — corrida, preparada (2026-10-07)**. Ni `job-dispatch` ni `payout-runs` servían: son SILUETAS para los
  comprobadores (en `job-dispatch` un trabajo solo salía de `running` por el rescate, y a `done`, como un éxito;
  en `payout-runs` nadie llega a `settled`). Fixture nueva, `job-dispatch-cycles` v1.0.0: la cola con despacho
  por ciclos (`dispatchJobs` cada minuto), la confirmación del ejecutor (`completeJob`, POST
  `/jobs/{id}/completion`) y el rescate a `abandoned` pasado `abandonAfterMinutes` (parámetro de despliegue);
  bloqueo optimista para la carrera confirmación/rescate y API interna abierta. Llevada a **`--ready` 11/11**:
  decisiones (registro estructural de cinco secciones y el code canónico de concurrencia aceptado), revisión
  (6 ids), barrido de las 11 clases, 12 escenarios con matriz (el reloj se espera con techo de 90 s; la
  precondición del rescate se fabrica con `stallInFlight`/`putInFlight`), careo de una pasada hecho por quien
  preparaba la corrida (un hallazgo aceptado) y `DESIGN.md`. Entra en `READY_FIXTURES`, en el `COMPILAN` de
  `main-compilable` y en `db-check`.
  - **Defecto del MODELO NEUTRAL destapado al prepararla** (los dos generadores): con una operación EXPUESTA que
    también saca la fila de `running` (el ejecutor que confirma), `classifyClaims` tomaba `running` por una
    «espera con plazo» aunque la transición del barrido declara `stalledAfter`, y con dos transiciones
    «seleccionando» les ponía a las dos el predicado del índice `[status, runningSince]`: el rescate sin plazo
    (todo lo que estuviera en running, al minuto) y la cola exigiendo `runningSince <= ahora` sobre filas sin
    reloj (no tomaba NINGUNA). Ni `keel validate` ni los dos `check` avisaban; lo vio leer los reclamos que
    salían. Una transición con `stalledAfter` es ahora siempre un rescate; regresión en `claim.test.js`
    (falsada deshaciendo el arreglo). La línea base de keel-spring solo cambia en la fixture nueva.
  - Workspaces en `spring-live-test/corrida-job-dispatch-cycles-{nest,spring}/`, con el proyecto generado por
    `build` sobre PostgreSQL (estampado `ready: true`; 148 y 177 archivos). El gate `check-idempotency.sh` de los
    dos nace ROJO en `sweepClaim`, como debe.
- **10e — corridas ejecutadas y registradas (2026-10-07)** en
  `docs/corridas/2026-10-07-job-dispatch-cycles-{nest,spring}.md`. Las dos **12/12**: keel-nest con una ronda de
  arbitraje (dos rojos de la prueba, `toMatch` con un comparador de forma) y huella **6**; keel-spring sin arbitraje y
  huella **5**. En las dos, nada del reloj, del reclamo, de la persistencia ni del arnés tocado: los handlers usan los
  dos reclamos generados y `check-idempotency.sh` sale verde sobre el proyecto terminado. Contrastando los informes
  con los proyectos: (1) **los dos servidores** traducían la carrera de la clave natural a un code que el diseño no
  declara (`JOB_REFERENCE_ALREADY_EXISTS`) — hueco de la fixture, que no nombraba `naturalKeyError`, y agujero de la
  puerta; el informe de keel-spring no lo vio; (2) los escenarios usaban `/api/jobs` cuando el DSL sirve `/api/v1`
  (agujero de la puerta: nada contrasta las rutas de los escenarios); (3) la regex de `inFlightWithoutClock` (10c)
  perdía su barra dentro de la plantilla — arreglada con su test falsado; (4) `integration-tests.md` advierte ya que
  `UUID_SHAPE` no es una RegExp. La fixture pasa a **v1.0.1** (`naturalKeyError: JOB_ALREADY_ENQUEUED`, rutas
  servidas, careo en dos pasadas), de nuevo 11/11. Quedan como candidatos a id `natural-key-error-unnamed` (un `CHK-*`)
  y `route-version-implicit` (un `CHK-SCEN-*`). **Con esto el incremento 10 queda cerrado en su alcance** (la
  reconciliación, la compensación y `lastKnown`, en el 11).

### Inc. 11 — Clientes HTTP salientes y dependencias

- `scaffold/{http-clients,dependencies,ref-resolvers}.js` + skill `keel-nest-httpclient`:
  puertos `<Cliente>Client`, adaptadores con DTOs wire y mapper ACL, `cockatiel` con
  fallback estrecho (sobrecargas desde `outbound-failures` neutral; el 4xx no cuenta para el
  circuito), idempotencia saliente, auth saliente por config, `replica` + `onMiss`,
  `onUnavailable: lastKnown` con `maxAgeSeconds`; stub HTTP del arnés (`stubSequence`).
- **Puerta**: `stub-sequence`, tests de rasgo, corrida con `http-clients`.
- **Evaluación al abrirlo (2026-10-07, sin código todavía)**. Lo que se suma del incremento 10: la
  **reconciliación** (`reconciledBy`, tabla `reconciliation_claim`, `reconciliation-claim.js` de keel-spring, 804
  líneas), la **compensación** (`dependencies.compensations`) y `lastKnown`. Lo de keel-spring a portar:
  `http-clients.js` (907: puerto `<Cliente>Client` + records `<Llamada>Result` en dominio; adaptador, DTOs wire y mapper
  ACL en infraestructura; auth saliente por configuración; `OutboundIdempotency`), `dependencies.js` (294: proyector y
  lector de réplicas), `ref-resolvers.js` (151), `last-known.js` (146) y `lib/outbound-failures.js` (154: las sobrecargas
  del fallback estrecho, candidato a neutral), más la skill `keel-spring-httpclient`.
  - **Sujeto**: `stock-reservation` (relacional, RabbitMQ, `http-clients` + `dependencies`): una llamada saliente
    (`inventory.cancelStock`, DELETE con idempotencia `payload-hash`, retry exponencial, circuit breaker y fallback), un
    encargo publicado (`reserveStock` por outbox) con su reconciliación por reloj (`reconcileReservations`,
    `unansweredAfterSeconds` 1800, `awaitingSince`) y una compensación por evento (`StockRejected`). **No está lista**:
    `--ready` 3/11 (le faltan decisiones de avisos e incoherencias, registro estructural, revisión, huecos, matriz,
    careo y `DESIGN.md`); llevarla a 11/11 es parte del incremento, como en 9e y 10e.
  - **Sin sujeto en la frontera**: `needs` con réplica y `onUnavailable: lastKnown` solo los declaran `asset-vault`
    (documental, incremento 12) y `catalog-extended` (storage, incremento 13). Propuesta: que la frontera los siga
    rechazando nombrando ese motivo, y se generen cuando haya fixture que los mida.
  - **Tramos propuestos**: 11a lo neutral (fallos del proveedor, política de resiliencia como datos, la tabla
    `reconciliation_claim` y sus parámetros); 11b clientes HTTP (puerto, adaptador sobre `fetch` con `cockatiel`,
    fallback estrecho, idempotencia y auth salientes) con paridad contra keel-spring; 11c reconciliación y compensación
    (reclamo con marca persistida, purga, notas del handler) y el gate `reconciliation` en `check-idempotency.sh`;
    11d arnés (`stubSequence` y el proveedor de prueba, `ageForReconciliation`) y skill `keel-nest-httpclient`; 11e
    `stock-reservation` a `--ready` y corrida en los dos generadores.
- **11a — lo neutral, hecho (2026-10-07)**. Dos módulos nuevos en `keel-core/gen`, extraídos de keel-spring sin cambiar
  un byte de lo que emite (`golden-digest --check`: 44 combinaciones, 10 854 archivos idénticos):
  - `outbound-resilience.js`: los seis fallos del proveedor por `kind` (`transport`, `server-error`, `unknown-status`,
    `client-error`, `circuit-open`, `auth-grant`) con lo que decide cada uno —si entra al fallback, si cuenta para el
    circuito, si es un rechazo—, lo que reintenta el retry desde `retryOn` (nunca el 4xx), `resiliencePolicy(call)` con
    los defaults que keel-spring aplicaba con `??` sueltos en `config.js`, y `retryWaitMs` como referencia ejecutable
    de la espera. keel-spring queda con la proyección `kind` → excepción (`src/lib/outbound-failures.js`).
  - `reconciliation-stores.js`: la tabla `reconciliation_claim` como datos (y el `_id` aplanado del documental), su
    purga (`RECONCILIATION_PURGE`, ahora con variable de entorno), `reconciliationParameters` —clave, variable y
    default de los tres números de un barrido—, `reconciledActivations`/`reconciliationClaims`, y la referencia del
    reclamo (`reconciliationWindow`, `reconciliationClaimReference`: el mismo `<=` que el UPDATE condicional). El
    descriptor del reclamo del modelo lleva sus `parameters`, y el `@Value` del lote deja de repetir un `50` a mano.
  - **Medido**: `keel-core/test/{outbound-resilience,reconciliation-stores}.test.js` (los invariantes: el fallback
    atiende siempre dos o más, todo lo que cuenta el circuito lo atiende el fallback, el 4xx no se reintenta nunca) y
    `keel-spring/test/outbound-parity.test.js`, que ata el YAML de resilience4j, la entidad JPA, el documento y el
    YAML y los `@Value` del barrido a los datos neutrales en `stock-reservation` (relacional) y `asset-vault`
    (documental). Falsado cambiando en keel-core la cota de `activation` y el separador del `_id`: cae cada una su
    prueba y solo esa.
  - **Para 11b**: keel-spring no aplica el `timeoutMs` por llamada sino el MAYOR de las llamadas del cliente como
    timeout de lectura (`client.readTimeoutMs`), con 5 s de conexión fijos. keel-nest puede aplicarlo por llamada
    (`cockatiel`), pero entonces los dos servidores cortarían en instantes distintos: decidir al abrir 11b si se
    iguala keel-nest a keel-spring o se corrige keel-spring. **Decidido en 11b**: se iguala (el mismo número, por
    intento).
- **11b — clientes HTTP, hecho (2026-10-07)**.
  - **Sin cockatiel, medido**. Su `CountBreaker` no es el circuito de resilience4j en tres puntos: solo evalúa la
    ventana al registrar un FALLO (fallo, fallo, éxito, éxito abre en resilience4j al 50 % y en cockatiel no), no
    cuenta lo que su política no maneja (para resilience4j un 4xx es un ÉXITO que llena la ventana) y en semiabierto
    reabre al primer fallo en vez de muestrear; su `IBreaker` no deja que un éxito abra, así que no se puede corregir
    por encima. Además su `maxAttempts` son reintentos (resilience4j: intentos totales), su backoff lleva jitter y su
    umbral es estricto (`>`). Por eso la máquina de estados de resilience4j vive en keel-core como referencia
    ejecutable (`circuitBreakerReference`, con `minimumNumberOfCalls` = min(100, ventana) y 10 pruebas en
    semiabierto, los defaults que keel-spring no sobrescribe —lo vigila `outbound-parity.test.js`—) y keel-nest
    emite la suya (`infrastructure/clients/circuit-breaker.ts`) con el retry por fuera, el orden de resilience4j.
  - **Lo que emite** (`src/scaffold/http-clients.js`): puerto `<Cliente>Client` (clase abstracta) y `<Llamada>Result`
    en `domain/clients`; en `infrastructure/clients` —`infrastructure/http` es la plataforma de ENTRADA— el adaptador
    sobre `fetch` (timeout por intento, sin seguir redirecciones), los DTOs wire con la guarda de los obligatorios
    (`OutboundContractError`: se propaga, no entra al fallback ni cuenta para el circuito), el mapper ACL, la tabla
    de fallos con su `kind` neutral, la clave de idempotencia saliente (`CommandSignature`, ahora también sin
    registro de entrada), la configuración (`http-clients.yaml`, la de keel-spring sin el bloque de resilience4j) y
    `HttpClientsModule` global. El fallback sale de la `onFailure` de la activación (ignore/fail/degrade), como en
    keel-spring; el handler que la dispara recibe el puerto inyectado y la nota de la activación y del orden.
  - **Frontera**: `http-clients` y `dependencies` se aceptan; `reconciledBy` y `compensations` con aviso (11c);
    `needs`, `auth: oauth2-client-credentials` y un value object compuesto en una llamada se rechazan (sin fixture
    en la frontera que los mida: asset-vault y catalog-extended, incrementos 12 y 13).
  - **Medido**: `test/http-clients.test.js` (14) EJECUTA el adaptador de `stock-reservation` contra un proveedor
    falso de `node:http` (con un sustituto de `@nestjs/common`): 3 intentos con la MISMA clave sin conexión o con
    timeout, el 5xx sin reintento (no está en `retryOn`), el 4xx al fallback y como éxito del circuito, el cuerpo que
    viola el contrato propagado, el 204 neutro, diez 5xx que abren y la llamada siguiente que ni sale; el circuito
    emitido recorre 6000 pasos aleatorios igual que la referencia; `http-clients.yaml` es el de keel-spring en los
    cuatro perfiles. Falsado con cinco sabotajes que conservan la forma (umbral estricto, el 4xx contado, reintentar
    todo, clave aleatoria, fallback para cualquier error): cada uno lo caza su prueba. `ts-check` destapó que la
    prueba de casos de uso emitida monta sus módulos a mano y le faltaba `HttpClientsModule` (nueve rojos: las tres
    fixtures con clientes × tres brokers); arreglado y fijado en `npm test`. Después, `ts-check` entero en verde: las
    33 siluetas compilan con `strict` y sus pruebas emitidas pasan.
  - **Sin medir**: contra un WireMock real (el arnés y `stubSequence` son 11d) y en corrida (11e).
- **11c — reconciliación y compensación, hecho (2026-10-07)**.
  - **Lo que emite** (`src/scaffold/reconciliation-claim.js`): la tabla `reconciliation_claim` como entidad TypeORM
    sobre los datos de keel-core (con el emisor genérico de las tablas del generador, `storeEntity`), su tienda
    (`ReconciliationClaimStore.claim`: UPDATE condicional sobre la marca caducada y, si no casa, INSERT con la clave
    primaria arbitrando la carrera; cada paso confirmado en su transacción), el reclamo en el puerto y el adaptador de
    la raíz que espera (candidatos con SKIP LOCKED por el umbral del diseño y `awaitingSince`, el que más lleva
    primero, con su lote; el estado NO se toca), los tres números por activación (`RECONCILIATION_SETTINGS` y
    `reconciliation.yaml`, el de keel-spring) y la purga por lotes de la tabla con el reloj y la retención de
    `RECONCILIATION_PURGE`. El handler del barrido recibe la nota de keel-spring (reclamo generado o no, el ORDEN de
    un deshacer frente a un reintento, la carrera con el camino feliz) y el de la compensación la suya (qué deshace,
    qué estado devuelve, cuál es la guarda). La frontera ya no avisa de nada en `stock-reservation`.
  - **Gate**: las familias `compensation` (el handler escrito; la vuelta al proveedor, exigida como LLAMADA
    `this.<cliente>.<llamada>(` —en keel-spring basta con nombrar el tipo, que aquí ya está en el `inject` que genera
    build—; y la transición de vuelta en el agregado), `reconciliation` (el reclamo generado usado y sin finder, el
    barrido escrito, el disparador; y para un barrido que build no reclama, la marca, el lote y el umbral de SU
    activación) y `outboundIdempotency` (pendiente del 11b), con los mismos sujetos que keel-spring.
  - **Medido**: `test/reconciliation.test.js` (7: `reconciliation.yaml` igual al de keel-spring en los tres perfiles,
    los defaults del código, la purga, las notas y el cableado); `schema-parity` con `reconciliation_claim` (lee ahora
    también `persistence/reconciliation` de keel-spring); `idempotency-check.test.js` con `stock-reservation` en los
    tres brokers y EJECUTANDO el gate: rojo recién generado en las dos familias, verde con el uso correcto, rojo otra
    vez barriendo con un finder o dejando el estado sin devolver. `db-check` **32/32** con `stock-reservation` como
    sujeto nuevo (115/115 en PostgreSQL y MySQL) y el reclamo de `catalog-extended` (`claimForReconcileWithdrawals…`)
    medido de paso: la tienda (insertar, marca viva, caducada, por activación, tres réplicas a la vez y gana una), el
    reclamo (umbral, orden, lote, estado intacto, marcas, caducidad, dos réplicas a la vez) y la purga. Falsado sobre
    PostgreSQL: sin la condición de caducidad en el UPDATE caen la marca viva, la carrera de la tienda y las pasadas
    siguientes (4 casos en cada sujeto); sin el umbral de espera caen las pasadas, las marcas y la caducidad (3).
  - **Sin medir**: el reclamo de reconciliación DOCUMENTAL (incremento 12) y un barrido que build no pueda reclamar
    (ninguna fixture de la frontera lo tiene: `asset-vault` y `catalog-extended` siguen fuera).
- **11d — arnés y skill, hecho (2026-10-07)**.
  - **Vocabulario del stub como dato neutral** (`keel-core/gen/http-stub-probes.js`): el admin API (del puerto
    publicado del catálogo), sus recursos, el corte de conexión, el estado inicial de una secuencia y la forma de
    cada mapping. keel-spring sigue con su Java a mano y la paridad lo ata (las mismas cadenas en su
    `AbstractFlowIT`).
  - **Lo que emite** (`src/scaffold/http-stub-harness.js`): `test/integration/support/http-stub.ts`, SIN Nest ni
    vitest (solo `fetch`), con los helpers de keel-spring (`stubFor`, `stubFailure`, `stubConnectionFault`,
    `stubTimeout`, `StubResponse` + `stubSequence` con su guarda de una secuencia por ruta, `stubCallCount`,
    `stubRequests`, `stubRequestBody`, `stubRequestHeader`, `resetStubs`); `flow.ts` lo reexporta (los flujos siguen
    importando solo de `flow.ts`) y olvida las secuencias al empezar cada flujo, tras el reset que ya vacía el stub.
    `ageForReconciliation(activación, id)` en `flow.ts`, con las sentencias de keel-spring sobre `db()` y el mismo
    criterio de emisión (sin los literales del motor no sale). El humo gana SMOKE-6 (el stub se deja programar). El
    reset en memoria del circuito de keel-spring no hace falta: aquí cada flujo arranca su servidor.
  - **Skill `keel-nest-httpclient`** (`SKILL.md` + `references/implementation.md` y `references/flows.md`), instalada
    con la capa: la llamada desde el handler, los rechazos con significado traducidos en `<llamada>Once`, el
    contrato en prosa, el fallback `degrade`, y los flujos contra el stub (reintento con la misma clave, circuito,
    barrido de reconciliación). `generator-docs.test.js` comprueba que cada ruta citada existe y que los ejemplos son
    líneas del adaptador emitido.
  - **Medido**: `test/http-stub-harness.test.js` (6) EJECUTA `http-stub.ts` contra un admin falso y compara cada
    mapping con el vocabulario de keel-core; `npm run stub-check` (nuevo) levanta SOLO el WireMock del catálogo y
    corre contra él los helpers emitidos y el adaptador emitido de `stock-reservation`: **13/13** (lo programado
    llega, el corte de conexión y el timeout son transporte y se reintentan con la misma clave, la secuencia
    entrega la segunda respuesta y se queda pegada, diez 503 abren el circuito, el cuerpo inválido se propaga).
    Falsado: con el estado inicial equivocado caen los tres pasos de la secuencia; con el fault renombrado WireMock
    rechaza el mapping (422) y el paso sale en rojo con esa causa —antes el script se caía sin resumen, y ahora un
    fallo inesperado es un paso rojo con su mensaje—.
  - **Sin medir**: los flujos de una corrida (11e) y `harness-check` con un sujeto con clientes (sigue sobre
    `product-catalog`; lo que añade el 11d lo mide `stub-check`).
- **11e — corrida, preparada (2026-10-07)**. `stock-reservation` pasa a **v1.1.0** y a **`--ready` 11/11** (estaba
  en 3/11), partiendo de los laterales de `stock-reservation-events`:
  - **YAML**: la capa `security` declarada abierta (`protocol: none`, API interna) en vez de ausente;
    `successStatus: 200` en la confirmación; `authorship: none` escrito; cota 255 en `releaseReason` y en el motivo
    del rechazo; y una regla en `reconcileReservations` que escribe `releaseReason = "sin respuesta del almacén"` al
    rendirse (REV-DOMAIN-PARTIAL-WRITER: en la v1.0.0 el barrido liberaba sin motivo).
  - **Laterales**: `decisions.yaml` (las aceptaciones reafirmadas para la v1.1.0, `CHK-DEPS-CLOCK-NOT-OBSERVABLE` y
    `CHK-DEPS-COMPENSATION-DEAD-END` aceptadas, y el registro estructural de nueve secciones con §3.6 y §3.11),
    `review.yaml` (11 ids), `gaps.yaml` (las 13 clases, con la 8 y la 13 de lo saliente y el barrido),
    `validation-scenarios.md` (los de `events` —`FL-RES-004` cubre `RESERVATION_NOT_FOUND`, los «sin reintentos»
    quedan en lo observable— más el clúster y la reconciliación: `FL-REC-001` se rinde y cancela, `FL-REC-001-B` el
    desenlace tardío que no resucita la reserva —el candidato que dejó abierto `events`—, `FL-REC-002` el corte de
    conexión que se reintenta con la MISMA clave, `FL-REC-003` el 503 que no se repite), careo en dos pasadas
    (`FL-CLU-002` tenía un Then vacuo: «ninguna reserva ajena» con el estado recién arrancado; ahora una sexta sin
    envejecer) y `DESIGN.md`. Entra en `READY_FIXTURES`.
  - **El arnés de keel-nest gana la segunda réplica** (`startReplica`, `stopReplica`, `onReplica`, los nombres de
    keel-spring): quitar los `FL-CLU-*` dejaba la incoherencia `CHK-SCEN-CLUSTER-UNCOVERED` —es la propiedad por la
    que existe el reclamo—, así que se cerró la carencia del arnés y no el escenario. Es un segundo `AppModule` en el
    mismo proceso, con su puerto, su pool, su planificador y su relay; el flujo la para al cerrar.
    `test/replica-harness.test.js`.
  - **Medido**: la línea base de keel-spring cambia SOLO en `stock-reservation` (48 puntos, regenerada);
    `compile-check` de keel-spring en verde (rabbitmq, postgresql y mysql); `ts-check` de keel-nest en verde. Ojo:
    `ts-check` compila con `test/` solo el proyecto de `product-catalog`; de las demás fixtures, dominio, aplicación
    y API. Así que el `flow.ts` y el `http-stub.ts` de un diseño con clientes NO los juzgaba `tsc` (el 11d lo daba por
    hecho): se comprobó sobre una copia del proyecto de la corrida —`npm install`, `tsc --noEmit` del proyecto entero
    con `test/`, sus 67 pruebas del perfil `test`, `check:architecture` y `check-flows.sh`, todo en verde—.
    Candidato: que `ts-check` compile también `test/integration/support` de cada fixture.
  - **Workspaces** en `spring-live-test/corrida-stock-reservation-{nest,spring}/`, sobre PostgreSQL y RabbitMQ
    (`keel-stack.json` sembrado), proyectos estampados `ready: true` (223 y 252 archivos). Los dos `check` sin avisos
    del modelo (keel-spring, sus cuatro notas informativas de frontera de siempre); los dos gates
    `check-idempotency.sh` nacen ROJOS en las mismas siete familias (`outboundIdempotency` nace verde: la clave la
    cablea build).
- **11e — corridas ejecutadas y registradas (2026-10-08)** en
  `docs/corridas/2026-10-08-stock-reservation-{nest,spring}.md`. Las dos **al 100%**: keel-nest 24/24 (los 21 del
  documento y tres `FL-RES-001-V*` que añadió su agente) con una ronda de arbitraje de prueba, keel-spring 21/21 sin
  arbitraje; huella **10** en las dos; sin `harnessPatches`, sin huecos de diseño. Los escenarios de clúster pasaron
  en keel-nest con la segunda réplica estrenada, y los de reconciliación con `ageForReconciliation` y los helpers del
  stub, sin SQL ni mappings a mano. Contrastando los informes con los proyectos, dos defectos del GATE, comunes a los
  dos generadores y arreglados en los dos: (1) la familia `reconciliation` (y `sweepClaim`) vetaba cualquier finder
  en el barrido, también el `findById` que relee un candidato ya reclamado; keel-spring lo escondió tras
  `reloadClaimed(UUID)` para callarlo. Ahora se veta el finder por el campo del lifecycle o `findAll`; (2) nadie
  miraba que el barrido se tragara los errores: keel-nest dejó dos `catch {}` (uno sobre una llamada que ya no lanza
  por el proveedor). Ahora la familia prohíbe el `catch` sin variable (TypeScript) o de `Exception`/
  `RuntimeException`/`Throwable` (Java). Medido con el gate regenerado sobre copias de los dos proyectos terminados
  (seis variantes, cada una en el color esperado) y fijado en los `idempotency-check.test.js` de los dos, falsado en
  las cuatro direcciones. La línea base de keel-spring solo cambia en `check-idempotency.sh`. Pendiente: la
  puntuación cuenta ids `FL-*` que no están en el documento. **Con esto el incremento 11 queda cerrado en su
  alcance**; `needs` (réplica, `onMiss`, `lastKnown`), `oauth2-client-credentials` y los compuestos en una llamada
  siguen rechazados hasta que una fixture de la frontera los mida (incrementos 12 y 13).

### Inc. 12 — Persistencia documental (MongoDB)

- `scaffold/document-{entities,embeddables,repositories,indexes,config}.js`: agregado como
  documento, índices parciales generados en clase (`MongoIndexConfig` equivalente),
  reclamo con `findOneAndUpdate`, outbox e idempotencia documentales, `export-indexes.sh`.
- **Puerta**: `mongo-check`, `index-check` y `mapping-check` documentales; el par
  `notification-mailer` / `-mongo` genera en las dos ramas.
- **Evaluación al abrirlo (2026-10-08, sin código todavía)**. Línea base de keel-spring verde (44 combinaciones,
  10 857 archivos).
  - **Sujetos en el repo**: `job-dispatch-mongo` (dominio, casos de uso, API y persistencia: clave natural con su
    error, índices del barrido, `schedule` con reclamo y rescate), `inspection-reports` (más mensajería: outbox y
    suscripciones, hijas anidadas, un campo `date`), `notification-mailer-mongo` (el del MVP: `--ready` 10/11 en la
    fixture —el `DESIGN.md` vive en `fixtures/design-docs/`—, pero declara `mail`, que es del incremento 13) y
    `asset-vault` (`storage` y `needs`: incremento 13).
  - **Lo de keel-spring a portar**: `document-{entities,embeddables,repositories,indexes,config}.js` (1 337 líneas) y
    las ramas documentales repartidas en `outbox.js`, `idempotency.js`, `http-idempotency.js`, `claim.js`
    (`findOneAndUpdate`), `reconciliation-claim.js`, `mediator.js` (el `WriteConflict` —etiqueta
    `TransientTransactionError` o código 112— reintentado), `controllers.js` (E11000 → error del diseño buscando el
    nombre del índice), `config.js` (URI con `uuidRepresentation=standard`, `auto-index-creation` apagada) e
    `integration-tests.js` (sobre `keel-core/gen/mongo-probes.js`, ya neutral). La `infra/` con replica set ya es
    neutral (`infra-catalog.js`). Checks: `mongo-check`, y las ramas documentales de `index-check`, `mapping-check`,
    `claim-check` y `store-check`.
  - **La representación física es contrato** (la lee el otro servidor y la miden los checks): campos en
    `snake_case`, `_id` = id de la raíz, UUID como binario subtipo 4, `decimal` como `Decimal128` (nunca texto: se
    ordenaría lexicográficamente), `timestamp` como `Date` (milisegundos), `date` como `Date` a medianoche —Spring
    la toma en la zona del sistema: riesgo a medir—, enum por el nombre de su constante, value object como
    subdocumento, hija anidada en la raíz, relación a otro agregado como `<relación>_id`, `lock_version`, auditoría en
    `created_at`/`updated_at`/`created_by`/`updated_by`. Spring escribe además `_class`: no es contrato (lee sin él)
    y keel-nest no lo escribe.
  - **Tramos propuestos**: 12a lo neutral (el documento como datos, las rutas, los índices del diseño y de los
    almacenes, `export-indexes.sh`) con keel-spring consumiéndolo byte a byte igual; 12b la persistencia documental
    en keel-nest (driver oficial `mongodb`, sesión y transacción con `AsyncLocalStorage`, versión comprobada en el
    filtro, `WriteConflict` reintentado, índices al arrancar, E11000 → error del diseño, perfil `test` sin base) con
    paridad contra lo que EMITE keel-spring y `db-check` sobre MongoDB; 12c los almacenes documentales (outbox con
    `claimed_at`, `processed_event`, `idempotency_record`, `reconciliation_claim`, reclamos y rescate con
    `findOneAndUpdate`, purgas); 12d el arnés (`mongo-probes` en `flow.ts`, `harness-check` con un sujeto documental)
    y la skill `keel-nest-mongodb`; 12e la corrida. **Sujeto de 12e por decidir**: `notification-mailer-mongo` exige
    adelantar `mail` del incremento 13; la alternativa es llevar `job-dispatch-mongo` o `inspection-reports` a
    `--ready`, como `stock-reservation` en 11e.
- **12a — lo neutral, hecho (2026-10-08)**. `keel-core/gen/document.js`, extraído de keel-spring sin cambiar un byte de
  lo que emite (`golden-digest --check`: 44 combinaciones, 10 857 archivos idénticos):
  - **El documento como datos**: `DOCUMENT_STORAGE` (la representación física de cada base del DSL), `documentShape`
    (los campos de primer nivel de cada documento en el orden del diseño: `_id`, escalares con su tipo BSON, sombra
    plegada, subdocumento, array, referencia, versión y auditoría de política), `valueObjectShape` y
    `documentValueObjects`. El `_id` también en una hija anidada: el mapeador de Spring proyecta TODA propiedad id
    sobre `_id`, y el otro servidor tiene que leerla ahí.
  - **Rutas e índices**: `documentPathsFor`, `documentIndexSpecs`, `partialDocumentIndexSpecs` (keel-spring le añade
    la clase del espejo), `nestedIndexWarnings`, `storeDocumentIndexes` (outbox, processed_event, idempotency_record
    y reconciliation_claim, con un `store` estable en vez del nombre de la variable Java), `documentIndexes` y
    `exportIndexesScript` con las dos piezas que nombra como parámetro de la plataforma.
  - **Medido**: `keel-core/test/document.test.js` (10, sobre un diseño sintético con todas las formas de miembro) y
    `keel-spring/test/document-parity.test.js`, que ata los `@Field`/`@Id` de cada `XxxDocument` y de cada espejo
    de value object —nombre, orden y `DECIMAL128`— y la colección de cada raíz a `documentShape` en las cuatro
    fixtures documentales. Falsado con tres sabotajes en keel-core (decimal como texto, la hija sin `_id`, sin
    auditoría de política): cada uno cae en la fixture que lo tiene y solo en ella. Y la línea base falsada a su vez:
    renombrar el prefijo del índice de la clave natural cambia 9 archivos de keel-spring. keel-core 1139/1139,
    keel-spring 1646/1646.
- **12b — la persistencia documental en keel-nest, hecho (2026-10-08)**.
  - **Una decisión de forma**: la rama documental emite los MISMOS archivos que la relacional para la transacción
    (`transaction-context.ts`: `active`, `inTransaction`, `inNewTransaction`, `afterCommit`), los errores
    (`persistence-errors.ts`: `translatePersistenceError`, `isTransientWriteConflict`, `OptimisticLockConflict`…) y el
    módulo (`persistence-module.ts`), con el driver dentro. El mediator, el filtro de errores y el módulo raíz solo
    cambian `usesRelational` por `usesPersistence`; el puerto de cada raíz es el mismo y el adaptador se elige por
    modelo (`src/scaffold/document-repositories.js`).
  - **Lo que emite** (`src/scaffold/document-persistence.js`): `db.yaml` con la `DB_URL` de keel-spring tal cual (la de
    local es la MISMA; el driver de Node rechaza `uuidRepresentation` —medido, `MongoParseError`— y `mongo-settings.ts`
    la quita al leerla), `bson-values.ts` (uuid binario subtipo 4, `Decimal128` con su escala, Int64 ↔ bigint, `date`
    a medianoche UTC, json como texto, enum por su constante), `document-indexes.ts` (los de `keel-core/gen/document.js`,
    creados al ARRANCAR), la transacción manual y no `withTransaction` (que reintentaría dos minutos: el conflicto lo
    reintenta el mediator con sus tres intentos, como keel-spring), el `WriteConflict` (112 / `TransientTransactionError`)
    como transitorio, E11000 → el error del diseño por el nombre del índice, y `export-indexes.sh` neutral. Sin tope de
    transacción ni 503: keel-spring no lo aplica en Mongo. El adaptador guarda con `$set` (no reemplaza: lo que el
    dominio no lleva, como la auditoría de política, se conserva), con la versión en el FILTRO y `created_at` en
    `$setOnInsert`; el listado ordena por la RUTA del espejo (`location.label`, `sections.status`), que es lo que acepta
    el `?sort=` de keel-spring documental —no el nombre aplanado de la rama relacional—, con desempate por `_id`.
  - **Frontera**: el modelo documental se acepta y `mongodb` entra en `SUPPORTED_DATABASES`; sobre documentos se
    rechazan, nombrando el 12c, la mensajería, los barridos con `schedule`, el registro de idempotencia y la
    reconciliación. La paridad de contrato HTTP pierde su única excepción (la página documental sin `sort`).
  - **Medido**: `npm run doc-check` (nuevo) contra un MongoDB miembro de un replica set, sobre `inspection-reports`
    (sin su mensajería), `job-dispatch-mongo` y `notification-mailer-mongo` (sin mensajería ni correo): **9/9**, 84
    comprobaciones —la URI de keel-spring, los índices vivos contra los neutrales (nombre, claves, unicidad y filtro
    parcial; crearlos dos veces), el documento CRUDO contra `documentShape` a todo nivel (cada clave con su tipo BSON y
    ninguna de más: ni `_class`), ida y vuelta, versión obsoleta → 409, clave natural e índice condicionado → el error
    del diseño y el finder del ocupante, dos transacciones sobre el mismo documento → conflicto transitorio, `created_at`
    que no cambia al reescribir, página con orden y la propiedad inexistente, borrado—. Falsado con siete sabotajes
    que compilan, cada uno cazado por su comprobación: decimal como texto, la versión fuera del filtro, el literal del
    diseño en el filtro parcial, un clasificador que no reconoce el WriteConflict, `_class` en el documento,
    `created_at` reescrito y el uuid como texto en los dos sentidos —este con la ida y vuelta en VERDE: solo lo ve el
    documento crudo contra el contrato, que es para lo que existe—. Dos primeros intentos de sabotaje no conservaban
    la forma (el servidor rechazaba la operación, o el código reventaba) y la sonda moría sin resumen: ahora cada bloque
    convierte un error inesperado en una comprobación roja con su causa. Y un fallo de la propia sonda, no del
    generador: fijaba la clave del índice condicionado por el nombre del campo del diseño (`application`) en vez del
    miembro del dominio (`applicationId`), y el «no conviven» salía rojo.
    Las muestras de agregados salen de `db-check` a `scripts/lib/samples.js` (la sonda relacional, idéntica byte a byte).
    `test/document-persistence.test.js` (sin red) EJECUTA el adaptador con un sustituto del driver: el documento del
    contrato, la ida y vuelta, el conflicto de versión, los índices y la URL contra los de keel-spring.
    `ts-check` **12/12**: las 33 siluetas compilan con `strict` —las documentales ya con su persistencia— y sus pruebas
    emitidas pasan. keel-nest 398/398 sin red. La matriz de paridad: `document-indexes`, `persistence-adapter` y
    `transient-write-conflict` documentales pasan a `verificado` por `doc-check`, falsados; `schema-baseline` y
    `folded-text` documentales, `razonado` (sin red que ejecute `export-indexes.sh` y sin fixture documental con
    `compare`); los almacenes, al 12c, y las sondas del arnés, al 12d.
  - **Para 12c**: el registro de procesados, el outbox con `claimed_at` (el relay sin `SKIP LOCKED`), el registro de
    idempotencia, `reconciliation_claim` y los reclamos de barrido con `findOneAndUpdate`, con el gate y la frontera
    abiertos para `job-dispatch-mongo` e `inspection-reports` enteros. **Sigue por decidir el sujeto de 12e.**
- **12c — los almacenes documentales, hecho (2026-10-08)**.
  - **Neutral**: `storeDocumentKey` y `storeDocumentFields` en `keel-core/gen/document.js`: el `_id` de cada almacén
    del generador (el uuid del outbox; el SUBDOCUMENTO `{handler_id, event_id}` y `{operation_scope, idempotency_key}`
    —MongoDB compara un `_id` subdocumento en orden, así que el orden es contrato—; la clave aplanada de
    `reconciliation_claim`) y sus campos, `claimed_at` incluido. `keel-spring/test/document-parity.test.js` los ata a
    sus cuatro espejos `*Document`: casaban ya.
  - **Lo que emite** (`src/scaffold/document-stores.js`): cada almacén con la MISMA API que su gemelo relacional (el
    relay, los listeners, los handlers y el gate no distinguen el almacén). El relay reclama con `findOneAndUpdate`
    y la marca caducable `claimed_at`, sin transacción —la operación ya es atómica—, ordenado por llegada; el fallo
    incrementa y suelta la marca en una actualización por pipeline, con el error como `$literal` (un texto que
    empiece por `$` se leería como un campo); la guarda y el registro INSERTAN sobre su `_id` subdocumento; la
    tienda de la reconciliación es un upsert sobre la marca caducada; los reclamos de barrido y de reconciliación del
    adaptador, con `findOneAndUpdate` en orden y el estado guardado como la constante del enum; las purgas, el mismo
    bucle por lotes con la frontera y el borrado sobre la colección. El puente escribe el documento del outbox en la
    sesión del cambio. El gate pide `insertOne` y prohíbe el reemplazo y el upsert. Lo relacional, idéntico: 9 840
    archivos de las fixtures relacionales comparados contra `HEAD`, cero diferencias.
  - **Frontera**: el modelo documental se acepta entero. Y se dice un hueco que no era del 12 y que destapó
    `asset-vault`: la autoría de POLÍTICA (`audit.authorship: all`) no la estampa ningún adaptador de keel-nest (en
    relacional la columna es NOT NULL: la escritura fallaría). Se rechaza en los dos modelos; solo la declara
    `asset-vault`, fuera también por `storage`.
  - **Medido**: `doc-check` **11/11**, 262 comprobaciones sobre cuatro sujetos —`inspection-reports` y
    `notification-mailer-mongo` ya con su mensajería, y `asset-vault` para la reconciliación—: el documento de cada
    almacén contra el contrato, el puente con su aborto, el reclamo del relay (orden, lote, marca viva y caducada,
    carrera de réplicas, backoff, rendición), la guarda, el registro de idempotencia (repetición, carrera, aborto,
    caducidad), los reclamos de cola y rescate, la reconciliación y las purgas. Falsado con once sabotajes que
    compilan: nueve caen en su comprobación; uno (el relay sin orden) salía VERDE porque el índice de pendientes
    regalaba el orden —ahora el orden se mide con el índice retirado y cae—; y uno, la purga del outbox sin su
    condición, es una mutación EQUIVALENTE (un `published_at` nulo nunca cumple el corte). Como el uuid del 12b, la
    clave del registro en otro orden pasa su propia ida y vuelta y solo la ve el documento crudo.
    `idempotency-check.test.js` gana la paridad de familias con keel-spring en tres fixtures documentales y EJECUTA
    el gate (la escritura nace verde; un upsert en la guarda la pone roja). keel-nest sin red en verde.
  - **Lo que destapó `ts-check`** (12/12 al final, las 33 siluetas con `strict`): la sección del outbox del arnés
    (`flow.ts`: esperar el drenaje, `abandonOutboxEvent`, `clearAbandonedOutboxEvents`) componía SQL con `db()`, que
    en documental no existe. En vez de una espera vacía que pasara por buena, la versión documental lee la colección
    con la `TransactionContext` del propio servidor arrancado (`flow.ts` ya tomaba de él el relay); ojo para la skill
    del 12d: ahí `clearAbandonedOutboxEvents()` es asíncrona. El resto del arnés documental —el reset entre flujos y las
    sondas de mongosh— es el 12d, y `build` lo avisa sobre todo diseño documental: el servidor sale entero, los
    `FL-*` todavía no se pueden puntuar.
- **12d — el arnés documental y la skill, hecho (2026-10-08)**.
  - **Lo que emite** (`src/scaffold/document-harness.js`, sección de `flow.ts`): `mongoEval(script)` —el `db()`
    documental—, por ARCHIVO dentro del contenedor y envuelto en el `print(...)` de `keel-core/gen/mongo-probes.js`
    (las dos trampas que esa fuente documenta: el argv se come las comillas en Windows, y por archivo mongosh no
    imprime la última expresión); `stallInFlight`/`putInFlight`/`inFlightWithoutClock` con `setStateScript` y
    `missingClockCountScript`, y `ageForReconciliation` con `ageClockScript` y la clave del documento de
    `documentShape`: los mismos nombres y los MISMOS scripts que el `AbstractFlowIT` de keel-spring. El humo gana
    SMOKE-3 documental (la base responde a un script). La `infra/` ya era neutral y servía: el `reset-db.sh` vacía
    documentos conservando índices. `build` deja de avisar de que el arnés documental está incompleto.
  - **El agente de calidad** gana la rama documental: no hay baseline que redactar, sino índices que VERIFICAR con
    `infra/export-indexes.sh` (`indexes`/`indexesTested` en su reporte, como keel-spring), y la skill orquestadora
    se lo pide. Es el único cambio en lo relacional: el texto de ese agente compartido.
  - **Skill `keel-nest-mongodb`** (`SKILL.md` + `repository-adapters.md`, `indexes.md`, `harness.md`,
    `troubleshooting.md`), instalada con `database: mongodb` en lugar de `keel-nest-database`. `generator-docs.test.js`
    comprueba que cada ruta que cita existe y que los ayudantes y conversores que enseña los exporta lo emitido
    (incluido que `clearAbandonedOutboxEvents` sea asíncrona en documental).
  - **Medido**: `npm run doc-harness-check` (nuevo) **14/14** sobre `job-dispatch-mongo` con su `infra/` real —build,
    `check-flows.sh`, `up.sh`, `validate-infra.sh` (el replica set), el humo, `score-scenarios.sh` saliendo con 0— y
    un flujo sonda que usa los ayudantes emitidos: comillas y `print` por `mongoEval`, el reset que conserva los
    índices (los del arnés y `uk_jobs_natural`), el rescate (estado y reloj rancio, reloj a ahora), el recuento sin
    reloj discriminando, y el script de `ageForReconciliation` que emite `asset-vault`, leído de su `flow.ts`.
    Falsado con cuatro sabotajes que compilan: sin el `print` cae el humo (score sale con 2); `putInFlight` con el
    reloj rancio, el recuento sobre otro campo y el envejecimiento sobre otro campo caen cada uno en su sonda. La
    primera versión del paso del humo buscaba la palabra `ARNÉS` y no vio el primer sabotaje: ahora se juzga por el
    código 2. `ts-check` 12/12; keel-nest sin red 405/405. La matriz no tiene ya nada documental pendiente.
  - **Con esto el 12 queda cerrado salvo la corrida (12e)**, cuyo sujeto sigue por decidir.
- **12e — sujeto decidido y corrida preparada (2026-10-08)**: `notification-mailer-mongo`, adelantando la capa `mail`
  del incremento 13 y `resolvedBy`, que eran lo único de ese diseño fuera de la frontera.
  - **12e-a, `resolvedBy`** (la credencial es UNA de las del recurso, no su clave natural): el finder
    `findBy<Campo>Containing` en el puerto y en los dos adaptadores (relacional: la tabla de elementos y el dueño;
    documental: el array del propio documento), con el nombre de keel-spring; `CallerIdentityResolver` en
    `caller-identity.ts`, registrado en el `SecurityModule` (`usesSecurityModule`), que el controlador usa ANTES de
    despachar; el campo del mensaje pasa a `string | null` con la nota de que llega resuelto y de que el null es la
    precondición de la operación; y la nota de la suscripción nombra el mismo finder. Se quitan los dos rechazos de
    la frontera. `test/caller-resolution.test.js` (paridad del nombre con keel-spring, el controlador y el resolutor
    EJECUTADO); `db-check` y `doc-check` ganan «resuelve por una credencial que no es la primera» y «una ajena da
    null». Falsado en documental buscando solo en la primera (`credential_keys.0`): cae esa y solo esa. Lo destapó
    `doc-check` antes que nadie: el resolutor tipaba la credencial como `string` y el lector del mensaje la da como
    `string | null` (no compilaba).
  - **12e-b, la capa `mail`** (`src/scaffold/mail.js`), con el reparto de keel-spring —build genera también el
    adaptador y el renderizador—: `MailMessage` en `domain/mail` (asunto y cabeceras saneados en el constructor,
    nombres reservados rechazados), `MailDeliveryException` (`accepted`, `rejected`, `detail`, `partial()`), los
    puertos `MailSender` y `TemplateRenderer` en `application/port/out`, el adaptador SMTP sobre **nodemailer** 10 (que
    resuelve el envío parcial con `info.rejected` y el total con un error `EENVELOPE`: los dos acaban en
    `MailDeliveryException`) y el renderizador **Handlebars** 4.7. Dos hallazgos del motor de JavaScript: (1) el escapado
    no se puede poner por instancia —el runtime lee el de `Handlebars.Utils`—, así que la tabla cerrada `& < > " '`
    se instala ahí, una vez; (2) `{{[if]}}` sigue llamando al helper (en Handlebars.java es un literal), así que los
    marcadores se compilan como `{{this.[x]}}`. `compile()` usa `precompile`: el `compile` de Handlebars es
    perezoso y solo fallaría al renderizar. `mail.yaml` con las MISMAS variables y defaults que keel-spring (lo
    compara `mail.test.js`). La guarda del envío, `claimFor<Op>(id)`: UPDATE condicional en `inNewTransaction`, y en
    documental `findOneAndUpdate` sin la sesión del caso de uso. El handler de `sentBy` recibe los puertos y la nota;
    `CommandDispatcher` la de la operación irreversible. El gate gana `mailDelivery` (envío y guarda, rojo recién
    generado) y, para igualar las familias de keel-spring en `notification-mailer`, `conditionalUniqueness`: en
    keel-nest lo afirmable es que el handler busque la ocupante con el finder generado (no hay flush), y solo en
    relacional, como keel-spring. El arnés del buzón (`test/integration/support/mail.ts`, sobre
    `keel-core/gen/mail-probes.js`, reexportado por `flow.ts`), con la espera derivada del periodo del barrido y el
    tiempo de caso ampliado a dos esperas; humo SMOKE-7. Skill `keel-nest-mail` (SKILL.md, `security.md`,
    `flows.md`, `troubleshooting.md`).
  - **Medido**: `test/mail.test.js` EJECUTA lo emitido —el mensaje, el renderizador (la tabla, las palabras del motor,
    `compile`, la caché), el adaptador contra un servidor SMTP falso de `node:net` (las dos partes, el respaldo, el
    Reply-To, el parcial, el total, el relay caído) y el arnés contra un Mailpit falso (la repaginación por encima de
    200, el chaos)—. `npm run mail-check` (nuevo) **17/17** contra un Mailpit REAL con el entorno del catálogo,
    falsado con cuatro sabotajes que compilan, cada uno cazado por su caso: el asunto sin sanear (y un dato: nodemailer
    ya pliega el salto de línea, así que la inyección de `Bcc:` no llega a ocurrir por su lado; lo que mide el caso es
    el asunto exacto), el escapado por defecto (`&#x27;`), el parcial dado por bueno y el remitente de respaldo
    ignorado. `db-check` 32/32 (PostgreSQL y MySQL) y `doc-check` 11/11 con la guarda: se lleva la fila y estampa el
    reloj, la segunda devuelve null y la marca está confirmada; falsado en las dos ramas quitando el estado de la
    condición: cae «por segunda vez devuelve null» y solo esa. `ts-check` 12/12; keel-nest sin red 429/429. Lo emitido
    para los diseños sin correo ni `resolvedBy` no cambia (digest de 9978 archivos).
  - **Workspaces** en `spring-live-test/corrida-notification-mailer-mongo-{nest,spring}/`, sobre MongoDB, RabbitMQ y
    Keycloak (`keel-stack.json` sembrado), `--ready` 11/11 y proyectos generados (273 y 300 archivos). Como `ts-check`
    no compila `test/` de las fixtures, se juzgó una COPIA del proyecto nest: `npm install`, `tsc` entero y con
    `tsconfig.flows.json`, sus 73 pruebas del perfil `test`, `check:architecture` y `check-flows.sh`, todo en verde.
    Los dos gates `check-idempotency.sh` nacen ROJOS en las mismas siete familias (con `mailDelivery`). `check` sin
    avisos del modelo en keel-nest (la nota del status por constructor); keel-spring, sus notas de siempre más la de
    la auditoría sobre lo anidado.
- **12e — corridas ejecutadas y registradas (2026-10-08)** en
  `docs/corridas/2026-10-08-notification-mailer-mongo-{nest,spring}.md`. Las dos **23/23**: keel-nest con un ciclo de
  `culprit: code` (el formato del idioma, que su agente validó después de buscar la plantilla), keel-spring sin
  arbitraje; huellas **18** y **17**, sin `harnessPatches`. Los dos agentes escribieron el mismo finder con el mismo
  nombre (`findLatestVersion`, consulta de negocio: «la versión es la siguiente» está escrita en `registerTemplate`), y
  los dos usaron la guarda, el renderizador por parte, el envío parcial y `compile()` al dar de alta como piden las skills
  de correo. Contrastando informes y proyectos:
  - **Defecto de keel-nest, arreglado**: `CommandDispatcherAdapter` inyectaba el mediator por constructor, y en cuanto
    un handler inyecta `CommandDispatcher` (un barrido que despacha otro caso de uso) el contenedor no arranca: ciclo
    contenedor → handler → adaptador → mediator. Reproducido sobre una copia limpia del proyecto; ahora se resuelve en
    el primer despacho con `ModuleRef` (73/73 sobre la misma copia), fijado en `test/application.test.js`. `ts-check` no
    lo veía: build no inyecta el puerto en ningún handler, así que el ciclo solo nace con el código del agente.
  - **Defecto común, arreglado en keel-core**: `export-indexes.sh` no exportaba el `partialFilterExpression`, y el índice
    único condicionado no se distinguía de uno normal al verificar en vivo. Fijado ejecutando el fragmento de mongosh;
    la línea base de keel-spring cambia solo en ese script (9 puntos).
  - **Divergencia entre los dos servidores** (sin escenario): con `recipient` mal formado y la plantilla inexistente,
    keel-spring responde 400 y keel-nest 422, según dónde puso cada agente el `<Tipo>Format.validate`. Candidato: que el
    formato de un campo que el diseño no normaliza viaje a la entrada en los dos generadores.
  - **De los tres `designGaps` de keel-spring**: uno real y pequeño (`list-order-significance`); uno falso positivo
    (`INVALID_STATE_TRANSITION` es del catálogo cerrado de `framework-errors.md`, que no viaja al proyecto generado:
    pendiente) y uno del contrato del cable (una lista no informada viaja como `[]` en los dos, pero `wire-contract.md` no
    lo escribe: pendiente).
  - Suites: keel-core 1140/1140, keel-nest 430/430, keel-spring 1650/1650. **Con esto el incremento 12 queda cerrado.**
- **Pendientes de la 12e: los tres cerrados (2026-10-08)**, en los dos generadores:
  - **Los documentos de contrato viajan al proyecto**: `keel-core/gen/contract-docs.js` entrega `framework-errors.md` y
    `wire-contract.md`, y los dos generadores los instalan tal cual en `docs/keel/`; los agentes de pruebas los citan
    antes de reportar un `code` «sin declarar». Fijado en `keel-nest/test/generator-docs.test.js` y
    `keel-spring/test/scaffold.test.js` (mismos bytes que keel-core).
  - **`list-never-null` en el contrato del cable** (`wire.js` y § Listas de `wire-contract.md`): una lista no viaja
    nunca como `null`, y la que la entrada no informa se lee como `[]` salvo la opcional de un PATCH. keel-nest ya lo
    hacía en el lector; keel-spring lo hace ahora en el constructor compacto del mensaje, en vez de depender del agente.
    `keel-nest/test/list-never-null.test.js` lo exige en las 15 fixtures sobre lo que emiten LOS DOS; falsado quitando
    la normalización de keel-spring (caen las 5 fixtures con listas en la entrada). Línea base de keel-spring: los dos
    documentos nuevos, el agente de pruebas y los mensajes con listas.
  - **Y el tercero, la precedencia del formato (400/422), cerrado** (decisión del diseñador: el formato a la entrada,
    sin tocar el DSL): `validationRules` de `keel-core/gen/constraints.js` deja de quitar en la entrada el `pattern`
    que un campo hereda de su value type —lo quitaba «por si el diseño normalizaba», cosa que solo podía decirse en
    prosa y ningún diseño hace—, así que un valor mal formado es un 400 antes que cualquier error de negocio en los dos
    servidores, también por la ruta y por la query. El dominio lo sigue repitiendo con `<Tipo>Format` para lo que no
    entra por la API (eventos, operaciones internas), y el gate `check-domain-guards.sh` lo sigue exigiendo. Si un
    diseño necesita normalizar antes de validar, el `pattern` tiene que admitir el valor sin normalizar: es un hueco
    del diseño, y así lo dicen ahora `mapping.md` y `domain-modeling.md` de los dos generadores, sus agentes y la guía
    del careo. `keel-nest/test/input-format-parity.test.js` lo exige sobre lo que emiten los dos en todas las
    fixtures; falsado devolviendo la decisión vieja a keel-core (caen las 4 fixtures con formato heredado). El test
    de paridad del contrato HTTP necesitó contar paréntesis: la regex de un `@Pattern` de ruta trae los suyos.
  - **Divergencia latente encontrada de paso**: la lista OPCIONAL del cuerpo de un PATCH es de tres estados en
    keel-spring (ausente = no tocar) y en keel-nest se lee como `[]`, que la vaciaría. Ninguna fixture tiene esa forma.

### Inc. 13 — Capas de borde: cache, storage, correo, pagos

- `cache.js` (Redis, mismo serializador del inc. 3), `storage.js` (`BucketPolicy` +
  `ContentSignature` generados por build), `mail.js` (build genera adaptador SMTP y
  renderizador: asunto saneado en el VO, variables escapadas), `payments.js` neutral +
  `payment-gateways/{stripe,mercadopago}.js` + `gateway-support.js` de nest.
- **Puerta**: `mail-check`, `payment-check` (pasarela falsa con `node:http`), tests de
  regresión de subida; corrida `payment-checkout` con las dos pasarelas.
- **El correo ya está hecho**: se adelantó al 12e (`mail.js`, `mail-harness.js`, `mail-check` 17/17, skill
  `keel-nest-mail`). Quedan cache, storage (con la autoría de política, que solo declara `asset-vault`) y pagos.
- **Evaluación al abrirlo (2026-10-08)**. Suites: keel-core 1140, keel-nest 462, keel-spring verde; línea base de
  keel-spring idéntica (44 combinaciones, 10 945 archivos).
  - **Sujetos**: pagos lo ejerce SOLO `payment-checkout` (dominio, casos de uso, API, seguridad, mensajería,
    persistencia relacional y `payments`: todo lo demás ya está dentro de la frontera de keel-nest). Cache y storage
    los declaran solo `asset-vault` y `catalog-extended`, y los dos arrastran además lo que la frontera todavía
    rechaza: `needs` (los dos), `oauth2-client-credentials` (catalog-extended) y `authorship: all` (asset-vault).
    Por eso **pagos va primero**: es el único tramo que se puede cerrar con corrida sin abrir otros tres frentes.
  - **Lo de keel-spring a portar para pagos** (~2 700 líneas): `payments.js` (la parte neutra: `GatewayStatus`,
    `GatewayOutcome`, `PaymentSource`, `ChargeRequest`, el puerto, `PaymentOutcomeApplier`, `PaymentNotices`,
    `PaymentReconciliation`, propiedades, cliente HTTP sin reintentos, `MoneyAmounts`, el verificador como puerto y
    el controlador del aviso sobre el cuerpo CRUDO), `payment-gateways/{stripe,mercadopago}.js` (adaptador y
    verificador de cada una), `payments-harness.js` (el doble de la pasarela en el arnés), `gateway-support.js` (la
    matriz), las skills `keel-spring-{payments,stripe,mercadopago}` y `payment-check` (pasarela falsa del JDK). Ya
    eran neutrales: `payments-model.js` (el modelo), `payment-probes.js` (el doble) y la pregunta del stack.
  - **Riesgos de equivalencia que hay que decidir en un sitio**: la clave de idempotencia hacia la pasarela (un
    reintento por el OTRO servidor tiene que repetirla), la tabla de rechazos → motivo neutro, las claves con que
    viaja la referencia, la ruta del aviso, y las **unidades menores de cada moneda**: medido, `Intl` de Node
    (CLDR) discrepa del JDK en 25 monedas —IQD da 0 decimales en vez de 3, así que 12.500 IQD saldrían como 13 en la
    unidad de la pasarela—. keel-nest no puede preguntarle a su plataforma. Y en Fastify, el aviso tiene que
    verificarse sobre los bytes que llegaron: el parser JSON de `wire.ts` no puede tocarlos antes.
  - **Tramos**: 13a lo neutral de pagos (keel-spring lo consume byte a byte igual); 13b la parte neutra en keel-nest
    (tipos, puerto, aplicación del desenlace, aviso con cuerpo crudo, despacho sin transacción de las operaciones
    que llaman a la pasarela, la puerta de la matriz en build/check) y se quita `payments` de la frontera; 13c los
    adaptadores y verificadores de Stripe y MercadoPago sobre `fetch`, EJECUTADOS contra una pasarela falsa de
    `node:http` con los casos de `payment-check`; 13d el arnés (el doble de la pasarela), las skills
    `keel-nest-{payments,stripe,mercadopago}`, `payment-check` de keel-nest y gate; 13e corrida `payment-checkout`
    con las dos pasarelas en los dos generadores. Después, cache, storage, autoría y `needs` (13f en adelante).
- **13a — lo neutral de pagos: hecho (2026-10-08)**. `keel-core/gen/payment-gateways.js`: la matriz de paridad
  (movida de keel-spring, que la reexporta), `PAYMENT_NOTICE_PATH`, `paymentIdempotencyKey`
  (`<referencia>:<acción>`) y `savedMethodIdempotencyKey`, `SAVED_METHOD_SEPARATOR`, `GATEWAY_TRANSLATIONS` por
  pasarela (rechazos → motivo neutro, clave de la referencia y del pagador, pasos de guardar un medio, la marca de la
  captura caducada, los campos de la firma del aviso), `PAYMENT_TEST_SECRETS` (la credencial y el secreto con
  que firma el arnés: un mismo `.env` para los dos servidores) y `CURRENCY_MINOR_UNITS` (las 218 monedas de
  `java.util.Currency` con unidad menor). keel-spring lo consume: línea base **idéntica**, falsada cambiando la clave
  de la referencia y un rechazo en keel-core (caen los adaptadores de las tres combinaciones de `payment-checkout`).
  `keel-core/test/payment-gateways.test.js` (los casos neutrales de la matriz, que salen de keel-spring, más la
  traducción contra el vocabulario y **contra el doble**: el código que `payment-probes.js` manda para cada motivo
  tiene que volver como ese motivo; falsado cambiando uno en el doble). `payment-check` de keel-spring gana
  `lasUnidadesMenoresDelJdkSonLasDeKeelCore`: el JDK tiene que seguir diciendo lo que dice la tabla (falsado moviendo
  IQD a 0 decimales: cae ese caso). La razón de `why` de MercadoPago ya no nombra la skill de keel-spring.
  Suites: keel-core 1149/1149, keel-nest 462/462, keel-spring 1645/1645 (los cinco casos neutrales de la matriz se
  mudaron a keel-core); `payment-check` de keel-spring verde con las dos pasarelas.
- **13b + 13c — la capa en keel-nest, con sus dos adaptadores: hechos (2026-10-08)**. Van juntos porque el
  `PaymentsModule` cablea el adaptador de la pasarela elegida y sin él el proyecto no compila.
  - `src/scaffold/payments.js` (lo neutro): `domain/payment` (`GatewayStatus`, `GatewayOutcome`, `PaymentSource`,
    `ChargeRequest`, `PaymentGatewayUnavailableException`), el puerto `PaymentGateway` en `application/port/out`,
    `application/payment` (`PaymentOutcomeApplier`, `PaymentNotices`, `PaymentReconciliation` con `staleBefore()` y
    su umbral como token de aplicación), y en `infrastructure/payment` la configuración (las MISMAS claves y
    variables que keel-spring: `payments.yaml` es idéntico byte a byte en los cuatro perfiles, y las duraciones se
    leen con la sintaxis de Spring —`2s`, `500ms`, `PT10S`— para que un mismo `.env` valga), `PaymentGatewayHttp`
    (fetch sin reintentos; el cuerpo se lee dentro del try, así que un corte a mitad también es «no contestó»; el
    plazo es conexión + lectura, porque fetch no los distingue), `MoneyAmounts` con la tabla de keel-core emitida
    tal cual, el verificador como clase abstracta con `PaymentNotice` (cabeceras sin mayúsculas, primer valor), el
    controlador del aviso y el `PaymentsModule` global. Las clases de aplicación las cablea el `UseCaseModule`, como
    los mappers, y el `CommandDispatcher` se emite también con pagos (el aplicador despacha la operación de cada
    desenlace).
  - **El aviso en Fastify**: el lector JSON del contrato del cable deja pasar el cuerpo de `/webhooks/payments` como
    texto (`http-platform.ts`), y el controlador lo verifica antes de leer nada; responde con `reply` a mano (200 o
    401 vacíos, como el `ResponseEntity` de keel-spring). La ruta abierta la pone ahora el **plan de acceso neutral**
    (`accessPlan` añade el POST del aviso cuando el modelo tiene pagos): `security-parity.test.js` ya no la excluye
    y compara las dos.
  - **Despacho sin transacción** de lo que llama a la pasarela (`callsPaymentGateway`): en los controladores; el
    barrido ya lo hacía `scheduleDispatch`; y la nota de la suscripción lo dice, con el token nulo por evento.
  - **Lo que TypeScript obliga a decidir y Java no**: un componente obligatorio del mensaje de desenlace que la
    pasarela no da (`required(…)`) falla en voz alta en vez de pasar un null; el que la capa no nombra
    (`cancelReason` en la fixture, aceptado por `CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED`) sale como `todo<T>()`, que
    compila y lanza con el TODO; y la acción del cliente se envuelve en `RawJson`. En MercadoPago, una acción sin
    `payment_method` es null (Jackson daría la cadena vacía, que no es JSON).
  - `src/scaffold/payment-gateways/{stripe,mercadopago}.js`: la traducción caso por caso de los de keel-spring, con
    las tablas, las claves y la plantilla de la clave de idempotencia de keel-core.
  - **Medido**: `test/payments.test.js` EJECUTA el adaptador y el verificador emitidos de las dos pasarelas contra una
    pasarela falsa de `node:http` con las formas del doble (`payment-probes.js`): los casos de `payment-check` uno a
    uno, más la devolución parcial con un 5xx y el 3DS sin cliente de Stripe; y, sin ejecutar, la paridad entre
    pasarelas (solo cambian su carpeta, el módulo, las variables de develop/production y lo que nombra el stack), el
    `payments.yaml` contra el de keel-spring, la ruta abierta, la exención del lector, el despacho sin transacción,
    la tabla de monedas, el aplicador, la reconciliación y el aviso. Falsado con nueve sabotajes, cada uno cazado por
    su caso: firma de cada pasarela, ventana, captura caducada en las dos, la lectura previa con 5xx, el corte sin
    traducir, el 5xx reintentado, el 3DS leído como fallo, el redondeo silencioso y la clave aleatoria. (Un sabotaje
    mal escrito —reintentar con recursión— colgó la pasada: los sabotajes van con `--test-timeout`.)
    `ts-syntax.test.js` y `ts-check` ganan la silueta con MercadoPago: **ts-check 12/12**, 34 siluetas con `strict` y
    sus pruebas emitidas en verde (la primera pasada cazó que el montaje de `use-cases.test.ts` no traía la pasarela).
    Suites: keel-core 1149/1149, keel-nest 502/502.
  - **La frontera sigue rechazando `payments`**: el proyecto compila y arranca, pero sin el arnés (el doble de la
    pasarela en los flujos, `gatewayExpiresAuthorization`, `ageForReconciliation` del barrido) ni las skills, el agente
    no tendría con qué. Se quita en el 13d.

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

