# Plan: escenarios `FL-*` como pruebas de integración JUnit

## Contexto

`keel-spring-validate` es hoy la única red de seguridad funcional de la generación y se relanza
varias veces sobre **los mismos** escenarios: una por ciclo de fix de la fase 2 (cupo de 2 a 4
según tamaño del diseño) y una más tras el pase de calidad. En cada relanzamiento reconstruye a
mano, desde la prosa de `specs/validation-scenarios.md`, todas las llamadas `curl` de todos los
flujos y re-asserta el `Then` a ojo. Nada se persiste: el bloque `scenarios: [{id, result}]` vive
solo en el prompt del orquestador.

El problema no es ejecutar, es **re-derivar**. Y tiene un efecto peor que el coste: la exigencia de
"verifica el cuerpo completo, aserción por aserción" depende de que el agente sea igual de
meticuloso en la pasada 1 y en la 4, con un modo de fallo silencioso (escenario dado por bueno
porque el status coincidía).

**Cambio**: los escenarios se traducen **una vez** a pruebas de integración JUnit contra la infra
real, escritas por un agente nuevo que corre **en paralelo** con `keel-spring-code` y
`keel-spring-infra`. Validar pasa a ser ejecutar un comando y leer los fallos.

Esto **no** introduce pruebas unitarias: la doctrina de "sin suite unitaria en el flujo de
generación" se mantiene. Cambia el vehículo de la validación end-to-end, de `curl` efímero a código
versionado.

**Por qué el paralelismo es la clave y no un detalle de agenda**: las pruebas derivan del contrato
(`specs/`, `docs/openapi.yaml`), no de la implementación. Por eso pueden escribirse a la vez que el
código y, sobre todo, por eso **su autor nunca ve el código terminado**. Eso elimina por
construcción el riesgo de que el test se acomode a lo que el código hace en vez de a lo que el
`Then` dice. Dos lecturas independientes del mismo spec que coinciden son evidencia; donde
discrepan, sale un fallo que hay que arbitrar.

## Decisiones ya tomadas

1. **Caja negra**: las IT no importan DTOs, comandos ni entidades generadas. Hablan HTTP y assertan
   sobre JSON. Compilan sin esperar a `keel-spring-code` (el paralelismo es real) y validan solo el
   contrato observable, que es lo que exige `validation-scenarios.md:84`.
2. **La app la arranca JUnit**: `@SpringBootTest(webEnvironment = RANDOM_PORT)` + `@ActiveProfiles("local")`
   contra los contenedores de `infra/docker-compose.yaml`. Desaparecen el `bootRun` en background,
   la espera con `curl` al 8080 y el "detén el servidor al terminar".
3. **Source set `integrationTest` separado**: `./gradlew build -x test` sigue siendo el gate de
   compilación y **no** ejecuta las IT (fallarían sin infra). La tarea no se engancha a `check`.
4. **Una clase por flujo**, métodos ordenados, `@BeforeAll` con `infra/reset-db.sh`. Respeta la
   doctrina vigente: reset **por flujo**, no entre escenarios; flujo auto-contenido.
5. **`@DisplayName` con el id `FL-*`**: la matriz `scenarios:` sale del XML de forma mecánica.
6. **`keel-spring-validate` deja de ejercitar y pasa a ejecutar y arbitrar**, clasificando cada
   fallo en `culprit: code | test | design`.
7. **La re-validación tras calidad deja de ser un agente** y pasa a ser `./gradlew integrationTest`
   que ejecuta el propio `keel-spring-quality`.
8. **Sin dependencias nuevas**: `spring-boot-starter-test` ya trae AssertJ, JsonPath y JSONAssert
   (`gradle.js:72`). El cuerpo completo se asserta con `JSONAssert` en `JSONCompareMode.STRICT`
   (campos presentes **y ausentes** en una sola aserción); los valores no deterministas —ids,
   marcas de tiempo— se extraen aparte con JsonPath y se verifican por forma. Las esperas de
   efectos asíncronos usan un helper de polling propio, no Awaitility.

## Paso 0 — Prerrequisito: un fixture con escenarios

Ninguno de los tres fixtures (`packages/keel-spring/test/fixtures/{catalog-extended,
metering-digest, product-catalog}`) tiene `validation-scenarios.md`; los tests actuales prueban el
scaffolding, no la validación. Sin escenarios no hay forma de probar nada de lo que sigue.

Escribir `packages/keel-spring/test/fixtures/catalog-extended/validation-scenarios.md` a mano
siguiendo el formato de `packages/keel-core/assets/core/docs/validation-scenarios.md`. Es el
fixture más completo (tiene `api`, `messaging` y `storage`), así que cubre los casos difíciles.
Bastan 3-4 flujos representativos: un CRUD con unicidad, uno con evento emitido, uno de
autorización (401/403) y uno de `storage`.

## Paso 1 — `packages/keel-spring/src/scaffold/gradle.js`

Añadir tras el bloque `dependencies { … }` del `buildGradle` (las deps de test ya están):

```groovy
sourceSets {
    integrationTest {
        compileClasspath += sourceSets.main.output
        runtimeClasspath += sourceSets.main.output
    }
}

configurations {
    integrationTestImplementation.extendsFrom testImplementation
    integrationTestRuntimeOnly.extendsFrom testRuntimeOnly
}

// Escenarios FL-* de specs/validation-scenarios.md contra la infra real de infra/.
// Fuera de `check` a propósito: sin infraestructura levantada no tiene sentido,
// y `./gradlew build -x test` debe seguir siendo el gate de compilación.
tasks.register('integrationTest', Test) {
    testClassesDirs = sourceSets.integrationTest.output.classesDirs
    classpath = sourceSets.integrationTest.runtimeClasspath
    useJUnitPlatform()
    shouldRunAfter tasks.named('test')
}
```

El perfil lo fija `@ActiveProfiles("local")` en la clase base, no la tarea (una sola fuente).
`.gitignore` no necesita cambios: `build/` ya está excluido (`gradle.js:106-112`).

## Paso 2 — `packages/keel-spring/src/scaffold/integration-tests.js` (módulo nuevo)

Mismo patrón que el resto de `src/scaffold/`: contexto precomputado + template literals, `export
function generate(model)` devolviendo `[{path, content}]`. Usa `javaFile`/`javaPath` de
`render.js` (ver `app-tests.js` como referencia mínima).

Genera en `src/integrationTest/java/<basePackage>/flows/`:

### `AbstractFlowIT`

Clase base de la que hereda toda clase de flujo. Contenido condicionado por `layersPresent` y
`stack`:

- `@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)`,
  `@ActiveProfiles("local")`, `@TestInstance(PER_CLASS)`,
  `@TestMethodOrder(MethodOrderer.OrderAnnotation.class)`, `@ExtendWith(FailureCapture.class)`.
- `TestRestTemplate` inyectado (no lanza en 4xx/5xx: el status es aserción).
- Métodos HTTP: `get/post/put/patch/delete(String path, String jsonBody, String token)` que
  devuelven un `Response` (record con `status`, `headers`, `body`), registran el intercambio en
  `FailureCapture` y añaden `Idempotency-Key` uuid nuevo en cada mutación.
- `resetState()` — `ProcessBuilder("bash", "infra/reset-db.sh")` respetando `CONTAINER_RUNTIME`,
  con el exit code comprobado. Si el stack es H2 (sin `cliResetCmd`, ver `stack-catalog.js:180`)
  no hay script: en su lugar `@DirtiesContext` a nivel de clase, que recrea el esquema en memoria.
- `idempotencyKey()` — uuid por llamada.
- Solo con capa `security`: `tokenFor(String role)` y `serviceCredential()`, resolviendo contra el
  proveedor del stack (Keycloak `localhost:8180/realms/<realm>/protocol/openid-connect/token`,
  Cognito `localhost:9229`) o leyendo las API keys ya sembradas en
  `src/main/resources/parameters/local/security.yaml`. Es el conocimiento que hoy vive en prosa en
  `conventions/infra-validation.md:112-136`, ahora ejecutable. Cachea el token por rol.
- `assertBody(Response, String expectedJson)` — `JSONAssert` en modo `STRICT`.
- `await(Duration timeout, Supplier<Boolean>)` — polling para efectos asíncronos (eventos,
  suscripciones), sin dependencias nuevas.
- Solo con capa `messaging`: helpers para publicar en un `channel` y para consumir del broker
  **real** del compose. Nunca `@EmbeddedKafka`: no es la infraestructura levantada.

### `FailureCapture` (`TestWatcher`)

**Es la pieza que evita que este cambio degrade el ciclo de fix.** El XML de JUnit por sí solo
devuelve `expected: 201 but was: 409` más un stack trace — menos de lo que hoy produce el agente a
mano. `FailureCapture` vuelca, en `testFailed`, el último intercambio completo a
`build/keel-failures/<FL-id>.json`:

```json
{ "scenario": "FL-PRD-001-B",
  "displayName": "…", "assertion": "expected 409 but was 201",
  "request":  { "method": "POST", "path": "/api/v1/products", "headers": {}, "body": {} },
  "response": { "status": 201, "headers": {}, "body": {} } }
```

### `src/integrationTest/resources/`

Lo que el perfil `local` necesite en el contexto de test (normalmente un `application.yaml` mínimo
o nada, porque `@ActiveProfiles` ya carga `parameters/local/`).

**No genera ninguna clase de flujo**: eso es derivado del diseño y lo escribe el agente.

## Paso 3 — `packages/keel-spring/src/scaffold/index.js`

`import * as integrationTests from './integration-tests.js';` y añadirlo a `GENERATORS` junto a
`appTests` (líneas 15 y 51).

## Paso 4 — Agente nuevo `keel-spring-tests`

`packages/keel-spring/assets/.claude/agents/keel-spring-tests.md`. Frontmatter con
`tools: Read, Write, Edit, Bash, Grep, Glob` y `model: inherit`, siguiendo la forma de los cuatro
existentes. Puntos que el prompt debe fijar:

- **Fuentes permitidas**: `specs/` (todas las capas + `validation-scenarios.md`) y
  `docs/openapi.yaml`. **Prohibido leer `src/main/java`** — es la garantía de independencia. Lo que
  el diseño no diga es `designGaps`, nunca algo que se resuelve mirando el código.
- Una clase `<Flow>FlowIT` por flujo en `src/integrationTest/java/<basePackage>/flows/`, heredando
  de `AbstractFlowIT`, `@DisplayName("FL-XXX-NNN-A: <título>")` por escenario, `@Order(n)` en el
  orden del documento, `@BeforeAll` con `resetState()`.
- **Assertar el `Then` completo**: status, cabeceras (`Location`, paginación), cuerpo entero con
  `JSONAssert` STRICT, y las convenciones de determinación del escenario (orden de colecciones,
  escala decimal, ausencia vs nulo, colación). Un test que solo comprueba el status no vale.
- Ids y marcas de tiempo: por forma y por reutilización simbólica dentro del flujo, jamás por valor
  literal (`validation-scenarios.md:75-76`).
- Cerrar con `./gradlew compileIntegrationTestJava` en verde. **No ejecutar** las IT: la infra
  puede no estar lista.
- No preguntar al usuario; registrar bloqueos y terminar.
- Bloque estructurado de cierre:

```yaml
status: OK | KO | PENDIENTE
classes: [ { flow: FL-PRD-001, file: …, scenarios: 4 } ]
uncovered: [ { scenario: FL-SUB-003-C, reason: "onFailure/DLQ exige provocar el fallo del handler" } ]
designGaps: [...]
blockers: [...]
```

`uncovered` es deliberado: los escenarios que hoy tampoco se ejercitan bien (DLQ, `schedule`,
`onMiss: degrade` con proveedor externo) pasan de darse por probados en silencio a declararse.

Registrar el archivo en `AGENTS` de `src/scaffold/generator-docs.js:31` — único punto de
instalación.

## Paso 5 — Convención nueva

`packages/keel-spring/assets/generators/spring/conventions/integration-tests.md` + entrada en
`CONVENTIONS` (`generator-docs.js:18-27`). Contenido: estructura de clase por flujo, ordenación y
encadenado de estado dentro del flujo, reset, tokens por rol y credencial M2M, `Idempotency-Key`
único por request, aserción de cuerpo completo con JSONAssert STRICT vs JsonPath para lo no
determinista, y **cómo verificar lo no observable por HTTP** (consumir del broker real, nunca
`@EmbeddedKafka`; qué hacer cuando el efecto solo se ve por devtools).

Ajustar `conventions/infra-validation.md`: el §"Reset de estado entre flujos" (líneas 67-101) pasa
a describir el hook `@BeforeAll` como consumidor de `reset-db.sh`. El script y su exclusión de
`flyway_schema_history` no cambian.

## Paso 6 — Reescritura de los agentes existentes

- **`keel-spring-validate.md`** — ya no arranca `bootRun` ni construye peticiones. Ejecuta
  `./gradlew integrationTest`, lee `build/test-results/integrationTest/*.xml` y
  `build/keel-failures/*.json`, mapea a la matriz por el `@DisplayName`, y **arbitra** cada fallo
  contra el `Then` original. Mismo bloque de cierre que hoy más `culprit` por fallo:

```yaml
failures:
  - scenario: FL-PRD-001-B
    culprit: code                 # code | test | design
    then: "3. cuerpo con code=SKU_ALREADY_EXISTS y status 409"
    request: {...}
    response: {...}
    expected: "409 con code SKU_ALREADY_EXISTS"
    hint: "unicidad de sku case-sensitive; el escenario declara colación insensible"
```

  Conserva las tres categorías que hoy debe ejercitar aunque no estén en los escenarios (mismo
  `code` con status distinto según endpoint, fechas que pasan por caché, hija de relación
  bidireccional): pasan de "ejercitarlas a mano" a "revisar que las IT las cubren".

- **`keel-spring-quality.md`** — levantar la prohibición de ejecutar tests **solo** para
  `integrationTest`, que pasa a ser su verificación de no-regresión antes de reportar. Sigue sin
  escribirlos. Ajustar la premisa (líneas 11-19) y el cierre (99-106), que hoy dicen que la red de
  seguridad es "la re-validación que el orquestador lanza después".

- **`keel-spring-code.md`** — nota explícita: las IT las escribe otro agente en paralelo; no debe
  leerlas, tocarlas ni ajustarlas para que pasen. Si cree que un test está mal, es `culprit: test`
  y lo decide `validate`.

## Paso 7 — Orquestación

- **`assets/generators/spring/orchestration.md`** — reescribir:
  - Fase 1 en paralelo: `code` ∥ `infra` ∥ `tests` (hoy son dos).
  - Gate de terminación: `./gradlew build -x test` en verde **+ `./gradlew integrationTest` al 100%**.
  - Fase 2: `validate` ejecuta y arbitra.
  - Conteo de ciclos: regla nueva — un fallo con `culprit: test` relanza `keel-spring-tests`, no
    `keel-spring-code`, y **no consume** cupo de ciclos código→validación (mismo argumento que hoy
    exime a los bloqueos sistémicos: no es un fallo del servicio). Mantener el tope duro global.
  - Fase 3: la re-validación posterior a calidad deja de ser un nodo de agente.
  - Tabla de agentes y tabla de handoffs: fila nueva para `tests`, campo `culprit` en los handoffs.
- **`src/scaffold/generator-docs.js` → `skillMd()`** (pasos 0-5, ~líneas 118-127): es la definición
  ejecutable del pipeline y debe quedar sincronizada palabra por palabra con `orchestration.md`.
- **`src/scaffold/claude-md.js`** (§Verificación, líneas ~182-201) y **`src/scaffold/readme.js`**:
  el comando de verificación incluye `./gradlew integrationTest`.

## Paso 8 — Documentación del repo

- **`CLAUDE.md` raíz**: el párrafo de `keel-spring` describe cuatro subagentes y afirma que "el
  flujo de generación no produce pruebas unitarias". Pasa a cinco, y hay que precisar la distinción
  —sin suite **unitaria**, con suite de **integración** derivada de los escenarios— para que no se
  lea como contradicción. Actualizar también la descripción de `assets/generators/spring/` con la
  convention nueva.
- **`packages/keel-core/assets/core/docs/validation-scenarios.md`**: **no se toca**. El formato es
  agnóstico del generador; que Spring lo materialice en JUnit es decisión del generador. (Su línea
  3 ya dice "el agente del generador lo usa para derivar tests de integración": este plan hace real
  lo que el documento ya prometía.)

## Paso 9 — Tests del repo

- `packages/keel-spring/test/scaffold.test.js`: `build.gradle` contiene el source set y la tarea;
  `AbstractFlowIT` y `FailureCapture` se generan.
- `packages/keel-spring/test/shape-coverage.test.js`: la base rinde coherente en las siluetas con y
  sin `security`, `messaging` y `persistence` (H2 vs BD con `cliResetCmd`).
- `packages/keel-spring/test/skills.test.js`: el agente nuevo y la convention nueva se instalan.

## Verificación

1. `npm test --workspace packages/keel-spring` en verde.
2. `node packages/keel-spring/src/cli.js build <fixture>` sobre `catalog-extended` y
   `metering-digest` (siluetas deliberadamente distintas): `src/integrationTest/` y la tarea Gradle
   salen bien en ambos.
3. En el proyecto generado, con `infra/docker-compose.yaml` levantado:
   `./gradlew build -x test` sigue verde **sin** tocar las IT, y `./gradlew compileIntegrationTestJava`
   compila la base.
4. `/keel-generate-spring` completo sobre ese servicio, observando lo que de verdad importa: que
   los tres agentes de fase 1 corren en paralelo sin pisarse, que `validate` compone la matriz
   desde el XML, y que **un fallo inducido a propósito en un test** (no en el código) se clasifica
   como `culprit: test` y relanza al agente correcto.
5. Medir, para cerrar la decisión con datos: tokens del agente de tests frente a una pasada de
   validación del flujo anterior, y tokens de la segunda pasada en ambos mundos.

## Nota de secuenciación

Los pasos 0-5 dejan un estado coherente e inocuo: el andamiaje y el agente existen, el pipeline
sigue funcionando como hoy. Los pasos 6-8 son los que mueven el gate y son la parte cara de
revertir. Si se quiere evidencia antes de comprometerse, ese es el corte natural.
