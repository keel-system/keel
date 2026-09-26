# CLAUDE.md

Guía para desarrollar **Keel** (este repo). Todo el proyecto está en español: mensajes de CLI, docs, commits y este archivo.

Este archivo es el **índice**. El razonamiento largo de cada caso vive en `.claude/rules/`, en cinco archivos con frontmatter `paths:` que solo entran en contexto al abrir un archivo que casa con su glob. La columna «detalle» de la tabla de abajo dice cuál:

| clave | archivo |
|---|---|
| `persistencia` | `.claude/rules/spring-persistencia.md` |
| `arnés` | `.claude/rules/spring-arnes-y-gates.md` |
| `generado` | `.claude/rules/spring-proyecto-generado.md` |
| `telemetría` | `.claude/rules/spring-telemetria.md` |
| `core` | `.claude/rules/core-dsl-y-validacion.md` |

## Qué es

Monorepo npm workspaces (`packages/*`) con una CLI Node.js (ESM puro, Node >=18, **sin build ni lint**) + una metodología para agentes. El diseño de un servicio se expresa en artefactos YAML declarativos ("DSL Keel 2.0", archivos `*.keel.yaml`, uno por capa en `specs/<servicio>/`). El código final (Java, etc.) **no lo genera JavaScript**: lo genera el agente siguiendo skills; la CLI solo siembra, valida y prepara.

## Distinción crítica: código vs. assets sembrados

- `packages/*/src/` — código de la CLI (lo que se ejecuta).
- `packages/*/assets/` — **payload** que las CLIs copian al usuario final. Dos destinos distintos y sin solape: `keel-core/assets/` → el **workspace de diseño** (`keel init`: schemas, templates, docs y un `AGENTS.md` plantilla desde `assets/core/`, más las skills del flujo de diseño desde `assets/skills/`); `keel-spring/assets/` → el **proyecto generado** (`keel-spring build`: skill del generador, agentes, conventions, skills por tecnología). Un generador **nunca** siembra nada en el workspace de diseño.

Las skills y el `AGENTS.md` bajo `assets/` **no son configuración de este repo**. Editar un schema, template o doc del DSL significa editar dentro de `assets/`.

## Harnesses de agente

El payload no se copia tal cual a un directorio de harness: se **proyecta**. `keel-core/src/lib/harness.js` define `HARNESSES` (hoy Claude Code y opencode) y `emitHarnessFiles()`, y **se emiten todos siempre** — un workspace o un proyecto generado sirve para cualquiera sin decidir nada al sembrarlo, y como la fuente es única no hay dos copias que puedan divergir, solo dos proyecciones.

La frontera que gobierna dónde va cada cosa:

- Lo que el harness **carga** (skills, agentes, archivo de contexto) cambia de sitio y de frontmatter según la herramienta → fuente **neutral** en `assets/skills/` y `assets/agents/`, con frontmatter neutro (`tools: [read, bash…]`, `spawns: false`) y rutas citadas como tokens `{{keel:skills}}`, `{{keel:agents}}`, `{{keel:context}}`, `{{keel:docs}}`. El prefijo `keel:` no es decorativo: `{{…}}` a secas ya es la sintaxis de variables de las colecciones Postman que documenta `/keel-docs`.
- Lo que solo es **markdown leído por ruta** (architecture, constitution, orchestration, conventions) va a `docs/keel/` del proyecto generado, en una sola copia, y **no puede citar rutas de harness**: ahí un `.claude/…` mentiría a quien use el otro, así que se nombra la skill o el agente. `docContent()` en `generator-docs.js` falla si queda un token.
- El contexto del repo: `AGENTS.md` lleva el texto y `CLAUDE.md` lo importa con `@AGENTS.md` cuando es compartido (el workspace, que el equipo edita); cuando cita rutas de harness se proyecta entero por harness (el proyecto generado, que `build` regenera).

Un literal `.claude/` en un asset es un bug, y hay tests que lo cazan (`keel-core/test/harness.test.js`). El `.claude/rules/` de la raíz **no** es un asset: es configuración de este repo.

## Estructura

### `packages/keel-core` — CLI `keel`

- `src/cli.js` — entry point (commander). Comandos: `init`, `new`, `list`, `validate`, `describe`, `index`, `system` (`show`/`check`), `registry` (`list`/`search`/`show`/`get`). Usa `parseAsync`: el `--from registry:<slug>` de `new` y `registry get` descargan por red.
- `src/commands/` — un archivo por comando.
- `src/lib/`:
  - `assets.js` — constantes `LAYERS`, `REQUIRED_LAYERS` (`domain`, `use-cases`), `KNOWN_GENERATORS`, `isKeelWorkspace()`.
  - `loader.js` — `loadService()`, `resolveServiceDir()`, `resolveServiceRef()` (nombre kebab → `specs/<n>` o ruta), `MANIFEST_FILE = 'service.keel.yaml'`.
  - `validate-service.js` — `validateService()`, orquesta la validación.
  - `summarize-service.js` — `summarizeService()`, resumen puro del diseño para `keel describe`.
  - `crossrefs.js` — `checkCrossRefs()`, validación mecánica de referencias entre capas.
  - `derivatives.js` — `listDerivatives()`, inventario de los derivados del diseño (escenarios, `DESIGN.md`, contratos formales, panel, `INTEGRATION.md`) y su frescura: compara el `service.version` que cada uno lleva estampado con el del manifiesto (`fresh`/`stale`/`unstamped`/`missing`/`orphan`/`not-applicable`). Lo consume `keel describe` y lo orquesta la skill `/keel-evolve`.
  - `design-index.js` — `buildIndex()`, `renderTable()`, `applyMarkers()`, `renderIndexJson()`: el índice de los diseños del workspace, proyección pura de `summarizeService()` + `listDerivatives()` + el sidecar `design.yaml` (schema propio, **fuera del DSL**). Escribe la tabla del `README.md` entre los marcadores `<!-- keel:servicios:start/end -->` —de los que es el **único** escritor— y el `index.json`. Determinista a propósito (sin timestamps): de ahí que `keel index --check` sirva de puerta de CI. Detalle en `core`.
  - `system-map.js` — `loadSystemMap()`, `buildSystemPlan()`, `renderPlanTable()`: el **mapa del sistema** (`system.yaml` en la raíz del workspace, schema propio **fuera del DSL**). Es la fase previa al diseño: qué servicios componen un encargo, quién consume a quién y en qué orden se construyen. Las **olas** son un orden topológico sobre las aristas `blocking`. Es la **única validación cross-servicio** del método —`crossrefs.js` no puede ver más allá de un servicio—. Determinista, sin timestamps: `keel system check` es puerta de CI y cualquier hallazgo (avisos incluidos) es rojo. Lo escribe la skill `/keel-decompose`. Detalle en `core`.
  - `registry-source.js` — acceso al registry remoto: `loadRegistryIndex()` (caché por URL en `~/.keel/registry/` con ETag y TTL de 24 h), `findDesign()`, `searchDesigns()`, `downloadDesign()` y `parseRegistryRef()`. **Dos puertas, dos intenciones**: `keel registry get <slug>` **adopta** y `keel new <nuevo> --from registry:<slug>` **deriva**. Un registry es un repo git servido por URLs raw, no un servicio: no hay `keel publish`. Detalle en `core`.
  - `copy.js` — `copyTree()`, copia idempotente de assets.
  - `derive.js` — `rewriteManifestForDerivation()`, reescritura del manifiesto para `keel new --from`.
  - `design-delta.js` — `diffDesigns(prevDir, nextDir)`: qué cambió entre dos versiones de un diseño. Puro y determinista; lo consume el generador para evolucionar un proyecto que ya generó.
  - `scenario-blocks.js` — `splitScenarioBlocks()` y compañía: el troceador de `validation-scenarios.md`, **fuente única** para `crossrefs.js` y `design-delta.js`.
- `src/index.js` — API pública que consumen los generadores (reexporta lo anterior).
- `assets/core/` — payload: `schema/*.schema.json` (incluye dos que **no** son capas del DSL: `design.schema.json` y `system.schema.json`), `templates/service/*.keel.yaml`, `docs/`, `AGENTS.md` plantilla. Las skills del flujo de diseño viven en `assets/skills/` (fuera de `core/`, porque se proyectan en vez de copiarse).
- `test/*.test.js` — tests con `node:test`.

### `packages/keel-spring` — generador Spring (CLI `keel-spring`)

Depende de `keel-core` y **no duplica** validación ni schemas.

**Flujo normalizado de generación (dos pasos, un `cd` en medio)** — es el único, y todo texto del repo debe enseñarlo así:

```bash
keel-spring check specs/<servicio>   # opcional y antes de cerrar: no escribe nada, dice si es generable
keel-spring build specs/<servicio>   # desde el workspace de diseño; el diseñador elige el stack a mano
cd services/<servicio>-spring
/keel-generate-spring                # dentro del proyecto, SIN argumentos
```

`build` **no escribe nada en el workspace de diseño** (el workspace es solo diseño): todo el conocimiento del generador va al proyecto que produce, y la skill del proyecto — sintetizada por `src/scaffold/generator-docs.js` (`skillMd()`), parametrizada por servicio/stack/capas — es la **única** definición del pipeline. No existe un asset estático de la skill, ni una skill genérica `keel-generate`, ni `generators/<tech>/` en el workspace: eran caminos alternativos de versiones anteriores y se eliminaron.

Qué genera `build`, qué deja al agente, el pipeline de cinco subagentes y la frontera entera: en `generado`. El scaffolding vive en `src/scaffold/` (un módulo por artefacto, patrón contexto precomputado + template literals) sobre `src/lib/` (`naming.js`, `type-mapper.js`, `model.js`, `writer.js`, `stack-catalog.js` + `stack-config.js` + `prompt.js`). El proyecto sale estilo Spring Initializr: wrapper de Gradle vendorizado en `vendor/gradle-wrapper/` (fuera de `assets/`) e `infra/docker-compose.yaml` según el stack. Assets (todos son **fuente** del proyecto generado): `assets/agents/` y `assets/generators/spring/` (contrato, `orchestration.md`, `architecture.md`, `constitution.md`, `conventions/`, `skills/keel-spring-<tech>/`, `golden/`). Al añadir un agente o una convention, ampliar las listas `AGENTS`/`CONVENTIONS` de `src/scaffold/generator-docs.js`, que es el único punto de instalación.

## Comandos de desarrollo

```bash
npm install                                      # raíz
npm test                                         # todos los workspaces (node --test nativo)
npm test --workspace packages/keel-core          # un paquete
npm link --workspace packages/keel-core          # habilita `keel` local
npm link --workspace packages/keel-spring        # habilita `keel-spring` local
node packages/keel-core/src/cli.js <cmd>         # ejecutar sin link
npm run compile-check --workspace packages/keel-spring    # compila de verdad el arnés generado (JDK + red, minutos)
npm run broker-check --workspace packages/keel-spring     # levanta la infra y ejercita los tres brokers (podman/docker)
npm run mail-check --workspace packages/keel-spring       # levanta Mailpit y lee el buzón por SMTP real (podman/docker)
npm run store-check --workspace packages/keel-spring      # relay del outbox, almacenes de idempotencia y reclamo de reconciliación
npm run mongo-check --workspace packages/keel-spring      # ejercita los scripts de mongosh que emite el arnés
npm run telemetry-check --workspace packages/keel-spring  # arranca la app y mide la TELEMETRÍA (único check que la arranca)
npm run mapping-check --workspace packages/keel-spring    # pregunta al motor si el MAPEO es el que el diseño pidió
npm run index-check --workspace packages/keel-spring      # ejercita la UNICIDAD CONDICIONADA en sus dos ramas
npm run deploy-check --workspace packages/keel-spring     # levanta deploy/ entero y le pregunta AL BACKEND
npm run matrix --workspace packages/keel-spring           # imprime la MATRIZ DE PARIDAD y sus tres listas (puro)
npm run claim-check --workspace packages/keel-spring      # ejercita los RECLAMOS generados contra el motor real
node packages/keel-spring/scripts/claim-check.js <fixture> [--database=<motor>] [--keep]   # una sola pasada
npm run clean                                    # raíz: barre raíces `keel-tests-*` que dejó un test muerto a la fuerza
```

Qué mide cada check, qué encontró y con qué mutaciones está falsado: en `arnés`. Ahí está también por qué el Java generado no lo compila `npm test` y cuáles son sus dos redes (`java-syntax.test.js` siempre y sin JDK, `compile-check` opt-in con javac).

**Los tests no dejan basura**: un test que necesite un directorio temporal usa `tmpDir()` de `test/helpers/tmp.js` (fuente única en `keel-core`, con un shim de reexport en `keel-spring`), nunca `os.tmpdir()` a pelo. `tmpDir()` cuelga todo de una raíz por proceso que se borra en `process.on('exit')` — también cuando la suite falla, que es justo cuando un `rmSync` al final de la función no llega a ejecutarse. Los `t.after` que ya limpian siguen siendo válidos: liberan espacio a mitad de ejecución. `test/tmp-hygiene.test.js` (uno por paquete) prohíbe el patrón viejo, y `npm run clean` es la escotilla para lo único que el barrido no cubre: un SIGKILL.

## Flujo de validación (`validateService()`)

1. **Capa 0**: detecta artefactos aún en plantilla / `description` placeholder → `pending` (error duro salvo `--wip`).
2. **Capa 1**: JSON Schema por capa con Ajv 2020 (`assets/core/schema/<capa>.schema.json` + `common.schema.json`).
3. **Capa 2**: referencias cruzadas por nombre entre capas (`crossrefs.js`): tipos, entidades, agregados, lifecycle, payloads, endpoints→operaciones, roles, etc.

La revisión **semántica** (calidad del diseño, invariantes, mínimo privilegio) no está en código: la hace la skill `/keel-validate`.

## Dónde se añade cada cosa

La columna «detalle» nombra el archivo de `.claude/rules/` que lleva el razonamiento completo de esa fila (leyenda al principio de este archivo). Abrir cualquiera de los archivos citados ya lo carga; si no, léelo a mano antes de tocar nada.

| Cambio | Archivos a tocar | Detalle |
|---|---|---|
| Nuevo comando CLI | `keel-core/src/cli.js` + nuevo archivo en `src/commands/` (lógica pura en `src/lib/`, el comando solo consola y escritura) | `core` |
| Cambio en la pasada en seco (`keel-spring check`) | `keel-spring/src/commands/check.js` + `src/scaffold/index.js` (`planService`) + `test/check.test.js`. La aserción que no se puede perder: **no escribe nada** en el workspace | `generado` |
| Cambio en el índice de diseños | `keel-core/src/lib/design-index.js` + `test/design-index.test.js`. Debe seguir siendo determinista | `core` |
| Cambio en el mapa de sistema | `keel-core/src/lib/system-map.js` + `assets/core/schema/system.schema.json` + `test/system-map.test.js` | `core` |
| Cambio en `deploy/` (el servicio en contenedor para pruebas manuales) | `keel-spring/src/scaffold/deploy.js` + sus casos en `test/scaffold.test.js`. Tres reglas de portabilidad que solo se ven con podman en Windows | `generado` |
| Cambio en el aprovisionamiento del proveedor de identidad | `keel-spring/src/scaffold/auth-provisioning.js` (`realmSpec()` es la fuente) + `test/keycloak-script-runs.test.js`, que EJECUTA el bash con un stub de kcadm | `generado` |
| Cambio en el reclamo de un barrido | `keel-spring/src/lib/model.js` (`classifyClaims`/`rescueClaim`) + `src/scaffold/claim.js` + `test/claim.test.js` + `test/rescue-shape-coverage.test.js`; después `npm run claim-check` | `persistencia` |
| Propagar un arreglo del generador a un proyecto YA generado | `keel-core/src/lib/write.js` + `keel-spring/src/lib/generated-manifest.js` + `writer.js` + `scaffold/index.js` + `commands/build.js` + `keel-core/test/generated-drift.test.js` y `keel-spring/test/generated-propagation.test.js` | `generado` |
| Cambio en el relay del outbox, en un almacén de idempotencia o en el reclamo de reconciliación | `keel-spring/src/scaffold/{outbox,idempotency,http-idempotency,reconciliation-claim}.js` + `src/lib/store-probes.js` + `test/store-probes.test.js` + `test/reconciliation-shape-coverage.test.js`; después `npm run store-check` | `persistencia` |
| Cambio en la señal de que el outbox se RINDE | `keel-spring/src/scaffold/outbox.js` (las DOS ramas) + `src/scaffold/integration-tests.js` (`deadLetteredEvents()`) + `test/corrida-fixes.test.js` | `persistencia` |
| Cambio en el aislamiento entre flujos (`infra/reset-db.sh`) | `keel-spring/src/scaffold/devtools.js` (`resetDbScript`) + `test/reset-purges.test.js`. Los destinos salen de `subscriptionDestination()`, nunca compuestos a mano | `arnés` |
| Cambio en la salida de `score-scenarios.sh` o en `FailureCapture` | `keel-spring/src/scaffold/integration-tests.js` + `test/score-non-scenario-message.test.js`, que ejecuta el awk con bash. Tocar ese Java obliga a `compile-check` | `arnés` |
| Nuevo harness de agente | `keel-core/src/lib/harness.js`: una entrada más en `HARNESSES` + casos en `test/harness.test.js`. No debería hacer falta tocar ningún asset ni ningún generador | `core` |
| Nueva regla de validación cross-servicio | `keel-core/src/lib/system-map.js` (`buildSystemPlan`, o `checkSpecDrift`) — **nunca** `crossrefs.js` — + `assets/core/docs/system-decomposition.md` | `core` |
| Cambio en el acceso al registry | `keel-core/src/lib/registry-source.js` + `test/registry.test.js`. Todo lo de red entra por parámetro (`fetchImpl`, `now`, `cacheDir`) | `core` |
| Nueva versión del DSL | **Se soporta una sola**: se *sustituye* el enum de `properties.keel` en `assets/core/schema/service.schema.json`; `supportedDsl()` lo deriva. Después, `SUPPORTED_DSL` de cada generador, la plantilla y las fixtures | `core` |
| Cambio del formato de `index.json` | Añadir una clave es aditivo y **no** sube `INDEX_SCHEMA_VERSION` (`src/lib/design-index.js`). Subirlo es breaking: primero la CLI, después los registries | `core` |
| Nuevo archivo dentro del directorio de un servicio (`specs/<servicio>/`) | Fila en `SPEC_SIDE_FILES` (`keel-core/src/lib/spec-files.js`), diciendo si viaja al publicar y al derivar + `test/spec-files.test.js` | `core` |
| Nueva capacidad del DSL (una propiedad **opcional** nueva en un schema de capa) | El schema, su emisor… y una **fixture que la declare**: `keel-spring/test/capability-coverage.test.js` cruza propiedades opcionales contra fixtures | `core` |
| Nuevo archivo del payload que el workspace pueda editar | `CUSTOMIZABLE_PAYLOAD` (`keel-core/src/lib/assets.js`), o `keel init --check` lo reportará como deriva | `core` |
| Cambio en lo que se genera por MODELO o por MOTOR | Fila o celda en `keel-spring/src/lib/engine-support.js` (la matriz de paridad) + `test/engine-support.test.js` + `test/parity.test.js`; `src/scaffold/engine-limits.js` para lo `degradado`; después `npm run matrix` | `generado` |
| Cambio en la unicidad CONDICIONADA al estado (`indexes` con `when`) | **Dos emisores, uno por modelo**: `src/scaffold/document-indexes.js` y `src/scaffold/migrations.js` + `src/lib/index-probes.js` + `src/lib/document-index-probes.js` + `src/scaffold/conditional-uniqueness.js` + `test/index-probes.test.js` y `test/conditional-uniqueness.test.js`; después `npm run index-check` | `persistencia` |
| Cambio en la IDENTIDAD del llamante (`security.authentication.callerIdentity`) | `keel-core/assets/core/schema/security.schema.json` + `docs/dsl/security.md` + `crossrefs.js` + `keel-spring/src/lib/model.js` + `src/scaffold/{security,controllers,repositories,services}.js` + `test/caller-identity.test.js` | `generado` |
| Cambio en la RÉPLICA del arnés (escenarios de clúster) | `keel-spring/src/scaffold/integration-tests.js` (`usesReplica`, `REPLICA_BODY`) + `test/corrida-fixes.test.js` + `npm run compile-check` | `arnés` |
| Nuevo motor de base de datos | Entrada en `DATABASES` (`keel-spring/src/lib/stack-catalog.js`) con su `kind`, más `staleTimestamp`, `uuidLiteral` y su forma de invocación por CLI + `test/engine-claim-coverage.test.js`; verificar con `node scripts/claim-check.js job-dispatch --database=<motor>` | `persistencia` |
| Cambio en el formato de un value type ESCALAR | `keel-spring/src/lib/type-mapper.js` (`inheritedTypePattern`) + `src/scaffold/value-types.js` + `src/scaffold/domain-guards-check.js` + `test/value-type-format.test.js` y `test/domain-guards-check.test.js` | `persistencia` |
| Cambio en las guardas de un value object COMPUESTO | `keel-spring/src/lib/type-mapper.js` (`numericConstraints`) + `src/scaffold/value-types.js` (`valueGuards`) + `test/corrida-fixes.test.js` | `persistencia` |
| Cambio en lo que el ACTUATOR expone, en qué PUERTO o en quién lo alcanza | `keel-spring/src/scaffold/config.js` (`managementYaml`: en production el actuator va en `MANAGEMENT_PORT` y las sondas en `/livez`/`/readyz` del principal) + `src/scaffold/security.js` (`authorizeBlock`) + `src/scaffold/integration-tests.js` (`actuatorMetric`) + el `HEALTHCHECK` de `deploy.js` + el predicado de sondas de `telemetry.js` + `test/corrida-fixes.test.js` y `test/telemetry.test.js`. Tienen que decir lo mismo | `telemetría` |
| Cambio en el CONTEXTO al saltar de hilo (hilos virtuales, `@Async`) | `keel-spring/src/scaffold/concurrency.js` (`ContextPropagatingExecutors` + `ContextPropagationConfig`) + la regla `context` de `logging-check.js` (`CONTEXT_FORMS`) + TEL-13/14 de `src/lib/telemetry-probes.js` + `test/boundary-logging.test.js`; después `compile-check` y `telemetry-check` | `telemetría` |
| Cambio en el aspecto de `@LogExceptions` | `keel-spring/src/scaffold/logging.js` + `test/corrida-fixes.test.js` + `npm run compile-check`. La regla: `getSignature()` se captura **antes** del `proceed()` | `telemetría` |
| Cambio en la telemetría (`telemetry: otel`) | Es elección de **stack**: `TELEMETRY`/`TELEMETRY_INFRA` en `src/lib/stack-catalog.js` + `stack-config.js` + flag `--telemetry`. El Java en `src/scaffold/telemetry.js` y compañía; `test/telemetry.test.js` + `java-syntax` + `compile-check --telemetry=otel` + `npm run telemetry-check`. Visión de conjunto, garantías y fragilidades: `OBSERVABILIDAD-ARQUITECTURA.md` | `telemetría` |
| Cambio en el PANEL, en las ALERTAS o en el CONTACTO al que salen | `keel-spring/src/scaffold/observability-assets.js` + `src/lib/telemetry-probes.js` (el vocabulario) + `src/scaffold/deploy.js` + `test/observability-assets.test.js`; después `telemetry-check` y `deploy-check` | `telemetría` |
| Cambio en el gate de CARDINALIDAD de las métricas | `keel-spring/src/scaffold/telemetry-gate.js` (`allowedTagKeys()` deriva del vocabulario) + `test/telemetry-cardinality-gate.test.js`, que lo EJECUTA con bash + las dos mitades del agente | `telemetría` |
| Cambio en lo que un `input` HEREDA del dominio | `keel-core/src/lib/crossrefs.js` (`constraintsOf`/`checkInputConstraints`) + `assets/core/docs/dsl/use-cases.md` + tests en las dos direcciones en `test/crossrefs.test.js` | `core` |
| Nueva comprobación sobre `validation-scenarios.md` | `keel-core/src/lib/scenario-blocks.js` (fuente única) + la regla en `crossrefs.js` con su `CHK-SCEN-*` + `docs/validation-scenarios.md`. **Todas son AVISO, sin excepción** | `core` |
| Nueva regla de validación mecánica | `keel-core/src/lib/crossrefs.js` **con su id** (`error(id, msg)` / `warn(id, msg)`, nunca `errors.push`) + su entrada en `src/lib/checks.js` + `test/crossrefs.test.js` | `core` |
| Un hueco que aparece en una CORRIDA | Clasificarlo con las cuatro preguntas de `checks.js`: `CHK-*` si el DSL tiene dónde declararlo, `OBL-*` si el diseño no lo decidió, `REV-*` si hay que leer prosa | `core` |
| Nuevo **parámetro de despliegue** del servicio (`service.parameters`, DSL 2.15) | `keel-core/assets/core/schema/service.schema.json` + `docs/dsl/service.md` + `CHK-SERVICE-PARAM-UNBACKED` en `crossrefs.js` + `keel-spring/src/lib/model.js` (`buildService`) + `src/scaffold/service-parameters.js` + `config.js` (el fragmento y su gradiente) + `deploy.js` (`.env`) | `core` |
| Cambio en la unicidad ACOTADA A LA COLECCIÓN de una raíz (índice `unique` de una hija que incluye la relación al padre) | `keel-core/src/lib/crossrefs.js` (`CHK-PERSIST-CHILD-UNIQUE-CODE`) + `keel-spring/src/scaffold/controllers.js` (`raceOnlyConstraint` devuelve el MOTIVO) + `src/lib/declared-errors.js` (el acotado incluye la raíz) + `test/catalog-run.test.js` | `persistencia` |
| Cambio en las FK entre AGREGADOS o en el nombre de una FK | `keel-spring/src/scaffold/persistence-members.js` (`foreignKeyName`, `crossAggregateForeignKeys`: fuente única) + `persistence-entities.js` (las tres asociaciones) + `migrations.js` (el apéndice de `export-schema.sh`) + `controllers.js` (`CONSTRAINT_TO_ERROR`) + `conventions/mapping.md`; después `compile-check` | `persistencia` |
| Cambio en lo que se admite en una SUBIDA (tipo declarado frente a firma del binario) | `keel-spring/src/scaffold/storage.js` (`BucketPolicy.allowsContent` + `ContentSignature`) + `assets/generators/spring/skills/keel-spring-s3/` (snippet y checklist) + `test/generation-regressions.test.js` | `generado` |
| Una convención de determinación que cambia el código (DSL 2.14: `conventions.nulls`, `constraints.scalePolicy`, `compare`/`match`) | El schema + `crossrefs.js` + el detector `CHK-SCEN-CONVENTION-UNBACKED` + su traducción en keel-spring + `keel-spring/test/catalog-run.test.js` | `core` |
| Cambio en el careo de flujos o en la coherencia de los derivados | `keel-core/assets/agents/keel-flow-review.md` + `assets/skills/keel-design/references/flow-walkthrough.md` + `src/lib/flow-review.js` + `derived-coherence.js` + `test/flow-review.test.js` y `test/derived-coherence.test.js` | `core` |
| Un aviso NUEVO del generador sobre el diseño | Fila en `FAMILIAS` de `keel-spring/test/design-generation-delta.test.js`, con `anticipa: '<CHK-ID>'` o `soloGenerador` con el motivo escrito | `core` |
| Un `designGap` que vuelve de una corrida | `design-gaps.yaml` del proyecto generado → `keel-spring check` lo imprime → `/keel-evolve` lo cierra. Copiarlo a `docs/corridas/<fecha>-<servicio>.md` **antes** de tirar el proyecto | `core` |
| Nueva comprobación de REVISIÓN (lo que solo un lector puede juzgar) | Fila en `keel-core/src/lib/reviews.js` con su `appliesTo(layers)` + su sección en `assets/skills/keel-validate/references/review-checklist.md` + `test/reviews.test.js` | `core` |
| Nueva obligación de diseño | Fila en `keel-core/src/lib/obligations.js` + fila en `assets/core/docs/design-obligations.md` + el emisor (`obligation(id, scope, mensaje)` en `crossrefs.js`, nunca un `warnings.push`) | `core` |
| Nuevo `code` que emita el generador sin que el diseño lo declare | `keel-core/src/lib/framework-errors.js` + `assets/core/docs/framework-errors.md` + el emisor vía `declaredErrorFor`/`effectiveErrorCode` de `keel-spring/src/lib/declared-errors.js`. Lista cerrada | `core` |
| Nuevo eje de repetición o de compensación | Son **seis** mecanismos distintos: comprobar a cuál pertenece el caso antes de añadir nada. El gate es `keel-spring/src/scaffold/idempotency-check.js` → `infra/check-idempotency.sh`, y un mecanismo nuevo se añade a su matriz **y se falsa** | `arnés` |
| Cambio en lo que significa ÚNICO en una columna de texto (collation) | `keel-spring/src/lib/stack-catalog.js` (`caseSensitiveCollation`) + `src/lib/type-mapper.js` + `src/lib/model.js` + `test/corrida-fixes.test.js` + la fila `unique-collation` de `engine-support.js`; después `npm run mapping-check` | `persistencia` |
| Cambio en el mapeo de un value object APLANADO en una entidad | `keel-spring/src/scaffold/persistence-members.js` (los `subs[]` llevan el `@Column` ya resuelto) + `src/scaffold/persistence-entities.js` + `test/scaffold.test.js` | `persistencia` |
| Cambio en el mapeo de un campo de colección (`list: true`) | `keel-spring/src/scaffold/persistence-entities.js` (rama `elementCollection`) + `src/scaffold/embeddables.js` + `test/mail.test.js` y `test/index-child-table.test.js` | `persistencia` |
| Test que necesite un directorio temporal | `tmpDir('<prefijo>-')` de `test/helpers/tmp.js`, **nunca** `os.tmpdir()` a pelo: lo que cuelga de ahí lo borra el propio proceso al salir. `test/tmp-hygiene.test.js` lo verifica en los dos paquetes | — |
| Cambio en el correo saliente | `keel-spring/src/scaffold/mail.js` (puerto, adaptador SMTP, renderizador) + `src/lib/mail-probes.js` + `src/scaffold/mail-harness.js` + `test/mail.test.js`. Aquí build genera **también** el adaptador | `generado` |
| Cambio en la API del buzón de correo | `keel-spring/src/lib/mail-probes.js` — **nunca** un literal en `mail-harness.js` ni en `stack-catalog.js`; después `npm run mail-check` | `arnés` |
| Cambio en un script de mongosh | `keel-spring/src/lib/mongo-probes.js` — **nunca** un literal en `integration-tests.js` — + `test/mongo-probes.test.js`; después `npm run mongo-check`. Aquí javac no es red | `persistencia` |
| Nueva capa del DSL | `LAYERS` en `keel-core/src/lib/assets.js` + `assets/core/schema/<capa>.schema.json` + `templates/service/<capa>.keel.yaml` + `docs/dsl/<capa>.md` + reglas en `crossrefs.js` | `core` |
| Cambio en el andamiaje de pruebas (`src/scaffold/integration-tests.js`) | Emite Java por plantilla: pasar `npm run compile-check` antes de darlo por hecho. Los helpers del proveedor de prueba se renderizan en un solo sitio (`test/stub-sequence.test.js`) | `arnés` |
| Cambio en un comando de broker (flags, endpoints, cuerpos de petición) | `keel-spring/src/lib/broker-probes.js` — **nunca** un literal en `integration-tests.js`; después `npm run broker-check` | `arnés` |
| Nuevo broker | Entrada en `BROKERS` (`src/lib/stack-catalog.js`) + su rama en `broker-probes.js` + las ramas de `integration-tests.js` + escenarios en `scripts/broker-check.js` + decidir `needsBrokerReseed` | `arnés` |
| Nuevo generador | Paquete `packages/keel-<tech>/` calcado de `keel-spring`; guía en `keel-core/assets/core/docs/building-a-generator.md`; registrar en `KNOWN_GENERATORS` (`src/lib/assets.js`) | `core` |
| Cambio de versión del DSL en un generador | Sincronizar `SUPPORTED_DSL` (`src/lib/assets.js` del generador) + campo `keel.dsl` de su `package.json` + su README | `core` |

## Convenciones

- ESM estricto; imports de stdlib con prefijo `node:` (`node:fs`, `node:path`).
- Artefactos: `<capa>.keel.yaml`; manifiesto `service.keel.yaml`; schemas `<capa>.schema.json`.
- Skills: `keel-<verbo>`; generadores: paquete `keel-<tech>` con bin homónimo y skill `keel-generate-<tech>` **instalada solo en el proyecto generado**, invocada sin argumentos con el cwd en su raíz.
- Servicios generados: `services/<nombre>-<tech>/`.
- Español en todo lo visible al usuario (mensajes, docs, commits).
- **Identificadores en inglés (mandatorio)**: los nombres del DSL (types, entidades, operaciones, eventos…) y todo directorio, archivo y símbolo del código generado por los agentes van en inglés; solo la prosa (descriptions, comentarios, mensajes) va en español. Regla canónica en `assets/core/docs/dsl-reference.md` y en `keel-spring/assets/generators/spring/constitution.md`.

## Documentación canónica (es payload: se edita en `assets/`)

- `packages/keel-core/assets/core/docs/methodology.md` — metodología completa.
- `packages/keel-core/assets/core/docs/dsl-reference.md` + `docs/dsl/<capa>.md` — referencia del DSL.
- `packages/keel-core/assets/core/docs/building-a-generator.md` — cómo crear un generador.
- `packages/keel-core/assets/core/docs/validation-scenarios.md` — escenarios Given/When/Then.
- `packages/keel-core/assets/core/docs/framework-errors.md` — los `code` que pone el generador cuando el diseño no nombra el conflicto de un mecanismo (idempotencia, bloqueo optimista, unicidad, subida). Lista **cerrada**, con su override por `errors`; el dato vive en `src/lib/framework-errors.js` y un test ata las dos piezas.
- `packages/keel-core/assets/core/docs/design-registry.md` — publicar y consumir diseños reutilizables (registry, sidecar `design.yaml`, `keel index`, `keel registry`).
- `packages/keel-core/assets/core/docs/system-decomposition.md` — descomponer un encargo en servicios (mapa `system.yaml`, briefs, `keel system`).
