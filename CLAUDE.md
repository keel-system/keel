# CLAUDE.md

Guía para desarrollar **Keel** (este repo). Todo el proyecto está en español: mensajes de CLI, docs, commits y este archivo.

## Qué es

Monorepo npm workspaces (`packages/*`) con una CLI Node.js (ESM puro, Node >=18, **sin build ni lint**) + una metodología para agentes. El diseño de un servicio se expresa en artefactos YAML declarativos ("DSL Keel 2.0", archivos `*.keel.yaml`, uno por capa en `specs/<servicio>/`). El código final (Java, etc.) **no lo genera JavaScript**: lo genera el agente siguiendo skills; la CLI solo siembra, valida y prepara.

## Distinción crítica: código vs. assets sembrados

- `packages/*/src/` — código de la CLI (lo que se ejecuta).
- `packages/*/assets/` — **payload** que las CLIs copian al usuario final. Dos destinos distintos y sin solape: `keel-core/assets/core/` → el **workspace de diseño** (`keel init`: schemas, templates, skills del flujo de diseño, docs y un `CLAUDE.md` plantilla); `keel-spring/assets/` → el `.claude/` del **proyecto generado** (`keel-spring build`: skill del generador, agentes, conventions, skills por tecnología). Un generador **nunca** siembra nada en el workspace de diseño.

Los `.claude/skills/` y el `CLAUDE.md` bajo `assets/` **no son configuración de este repo**. Editar un schema, template o doc del DSL significa editar dentro de `assets/`.

## Estructura

### `packages/keel-core` — CLI `keel`

- `src/cli.js` — entry point (commander). Comandos: `init`, `new`, `list`, `validate`, `describe`.
- `src/commands/` — un archivo por comando.
- `src/lib/`:
  - `assets.js` — constantes `LAYERS`, `REQUIRED_LAYERS` (`domain`, `use-cases`), `KNOWN_GENERATORS`, `isKeelWorkspace()`.
  - `loader.js` — `loadService()`, `resolveServiceDir()`, `resolveServiceRef()` (nombre kebab → `specs/<n>` o ruta), `MANIFEST_FILE = 'service.keel.yaml'`.
  - `validate-service.js` — `validateService()`, orquesta la validación.
  - `summarize-service.js` — `summarizeService()`, resumen puro del diseño para `keel describe`.
  - `crossrefs.js` — `checkCrossRefs()`, validación mecánica de referencias entre capas.
  - `copy.js` — `copyTree()`, copia idempotente de assets.
  - `derive.js` — `rewriteManifestForDerivation()`, reescritura del manifiesto para `keel new --from` (derivar un diseño existente).
- `src/index.js` — API pública que consumen los generadores (reexporta lo anterior).
- `assets/core/` — payload: `schema/*.schema.json`, `templates/service/*.keel.yaml`, `.claude/skills/`, `docs/`, `CLAUDE.md` plantilla.
- `test/crossrefs.test.js` — tests con `node:test`.

### `packages/keel-spring` — generador Spring (CLI `keel-spring`)

Depende de `keel-core` y **no duplica** validación ni schemas.

**Flujo normalizado de generación (dos pasos, un `cd` en medio)** — es el único, y todo texto del repo debe enseñarlo así:

```bash
keel-spring build specs/<servicio>   # desde el workspace de diseño; el diseñador elige el stack a mano
cd services/<servicio>-spring
/keel-generate-spring                # dentro del proyecto, SIN argumentos
```

`build` **no escribe nada en el workspace de diseño** (el workspace es solo diseño): todo el conocimiento del generador va al `.claude/` del proyecto que produce, y la skill del proyecto — sintetizada por `src/scaffold/generator-docs.js` (`skillMd()`), parametrizada por servicio/stack/capas — es la **única** definición del pipeline. No existe un asset estático de la skill, ni una skill genérica `keel-generate`, ni `generators/<tech>/` en el workspace: eran caminos alternativos de versiones anteriores y se eliminaron.

`src/commands/build.js` valida y genera el **scaffolding transversal al stack** en `services/<servicio>-spring/`: todo lo necesario para levantar el proyecto (dependencias según el stack elegido, config por perfiles `local`/`develop`/`production`/`test` con fragmentos `parameters/`, el mecanismo de migraciones de esquema (Flyway del dialecto elegido, `db/migration/` vacío y los perfiles auxiliares aditivos `schema-export`/`migrations` — el baseline lo exporta el agente de calidad desde las entidades finales y lo prueba en vivo), infraestructura de prueba agrupada en `infra/` — compose, `docker/Dockerfile.devtools`, `validate-infra.sh`, `reset-db.sh` para dejar el estado limpio entre flujos de validación —vacía datos preservando `flyway_schema_history` y borra las claves `<servicio>:*` de la caché, y con `--schema` recrea el esquema, que es la única salida cuando `ddl-auto: update` deja columnas huérfanas tras regenerar entidades—, `export-schema.sh` para exportar el DDL, que además verifica que el baseline conserva los nombres de constraint del diseño, y con capa `security` sobre Keycloak el aprovisionamiento del proveedor de identidad —`src/scaffold/auth-provisioning.js`: `init-keycloak.sh` (realm, roles, un usuario por rol, los clientes máquina del diseño y la matriz `test-m2m-*`) más `test-credentials.env`, **fuente única** de clientes y secretos que el agente de infraestructura ejecuta/verifica y que `AbstractFlowIT` lee en vez de hardcodear—) más la estructura cuyo código no depende de la infra puntual, con la arquitectura hexagonal + CQRS del prototipo de referencia, sin paquete `shared` ni Spring Modulith (dominio puro + espejo `XxxJpa` con puerto/adaptador, commands/queries + handlers stub despachados vía `UseCaseMediator`, controllers `<Agregado>V1Controller` (binding derivado del endpoint declarado: un `@PathVariable` por `{segmento}` de la ruta, cuerpo solo en POST/PUT/PATCH, multipart si la entrada trae un campo `file`), DTOs completos —relaciones incluidas: `<rel>Id` para otro agregado y `<Hija>Dto` para las entidades hijas—, jerarquía de errores `DomainException` + `ApiExceptionHandler` (con el status por constructor cuando un mismo `code` se declara con `http` distinto según la operación), `CacheConfig` cuando el diseño declara `cache` (TTL y constante por caché, JSON con `JavaTimeModule`, degradación a miss), seguridad, y la cadena completa de eventos de dominio — buffer `raise`/`pullDomainEvents` en el agregado, drenaje en el adaptador de repositorio, `<Evento>IntegrationEvent` + `<Servicio>DomainEventBridge`, y con `reliability: outbox` la tabla `outbox_event` + `OutboxRelay` tras el puerto `OutboxDispatcher`; con `subscriptions`, su simétrico del lado consumidor: `processed_event` + `IdempotencyGuard`; y el `CorrelationContext` + `CorrelationFilter` que dan la correlación end-to-end que estampa cada `EventEnvelope`). **Frontera**: el código cuya implementación cambia según la infra elegida (envío al broker —`OutboxDispatcher` o `<Evento>Publisher`— y listeners, adaptador de storage) no se genera — lo completa la skill `keel-generate-spring`, que actúa de **orquestadora** de cinco subagentes (`assets/.claude/agents/keel-spring-{code,infra,tests,validate,quality}.md`, instalados por `build` en el `.claude/agents/` del proyecto; cada uno cierra su reporte con un bloque estructurado `status`/`blockers`/`failures` sobre el que el orquestador hace gating): `keel-spring-code` (código, **sin pruebas unitarias**, guiado por las skills por tecnología `keel-spring-<tech>` — fuente en `assets/generators/spring/skills/`, cada una un directorio SKILL.md + `references/` con configuración/implementación/troubleshooting leídos bajo demanda, instaladas **como directorio completo** y condicionalmente en el `.claude/skills/` del proyecto según `keel-stack.json`; los seis dialectos de BD comparten `keel-spring-database` — tuning/dialecto/validación, el código JPA sigue saliendo de build) en paralelo con `keel-spring-infra` (levanta y sondea `infra/` con docker o podman) y con `keel-spring-tests` (traduce **una vez** los escenarios `FL-*` de `validation-scenarios.md` a pruebas de integración JUnit en `src/integrationTest/`, una clase por flujo, **en caja negra y sin leer `src/main/java`** — el paralelismo es lo que garantiza esa independencia, y el source set lo respalda dejando `main` fuera de su `compileClasspath`: un test que importe una clase generada no compila; cierra con `./gradlew compileIntegrationTestJava`, sin ejecutar nada), después la **puntuación de escenarios, que no es un agente**: el orquestador ejecuta `infra/score-scenarios.sh` (lo genera `src/scaffold/integration-tests.js` junto al resto del arnés) — encadena el humo del arnés y, en verde, `./gradlew integrationTest` —la app la arranca JUnit contra la infra real, con reset de estado por flujo vía `infra/reset-db.sh` en el `@BeforeAll` de cada clase—, compone la matriz desde el XML de JUnit y sale con `0` (100% OK → fase 3 **sin invocar a ningún agente**), `1` (hay fallos) o `2` (arnés roto, la suite no corrió); toda la salida de Gradle va a `build/keel-scenarios/run.log` y por stdout solo la matriz, porque quien lo invoca es la sesión más larga del pipeline. Solo con `exit 1` se invoca `keel-spring-validate`, que ya **no ejecuta nada**: recibe los fallos puntuados con su `class` y la ruta de su volcado, y **arbitra** cada uno contra el `Then` original con la evidencia que `FailureCapture` dejó en `build/keel-failures/`, clasificándolo en `culprit: code|test|harness|design`: un `culprit: test` relanza al agente de pruebas, no al de código, y no consume cupo de ciclos; un `culprit: code` relanza al de código con la ruta del volcado —lee la evidencia cruda, no el extracto— y cierra verificando su fix con `./gradlew integrationTest --tests '<ClaseAfectada>'`, verde que **no** aprueba el escenario: tras cualquier ciclo de fix se re-puntúa siempre la suite completa con el script, y si la tanda mezcla ambos culprits los relanzamientos van en serie porque comparten Gradle y base de datos) y al final `keel-spring-quality` (pase de calidad no-conductual con `./gradlew build -x test` en verde y `./gradlew integrationTest` al 100% como no-regresión propia —ya no hay nodo de re-validación—, más el baseline de migraciones —`infra/export-schema.sh` → revisión → arranque con `PROFILE=local,migrations` sobre BD sin esquema, reportado como `baseline: OK|KO|N/A`—). El flujo de generación **no produce pruebas unitarias, pero sí de integración**: el gate es `./gradlew build -x test` más `./gradlew integrationTest` con el 100% de los escenarios `FL-*` en OK contra la infraestructura real; la suite **unitaria** es un proceso independiente posterior a que el diseñador valide el servidor (el andamiaje de test — deps, perfil `test` con H2, `<Nombre>ApplicationTests` — sí lo sigue generando `build`, igual que el source set `integrationTest` con su `AbstractFlowIT` y `FailureCapture`). El proyecto generado queda como **repo autosuficiente** (clonable y finalizable sin el workspace): `build` le escribe, en `.claude/` del proyecto (`src/scaffold/claude-md.js` + `src/scaffold/generator-docs.js`), un `CLAUDE.md` contextual (orden de capas declaradas, stack, verificación), un `architecture.md` (arquitectura hexagonal + CQRS y función de cada paquete), un `constitution.md` (reglas inviolables: frontera hexagonal, transaccionalidad, contratos públicos, precisión numérica —`BigDecimal` con escala y redondeo explícitos en importes y cálculo científico, detallado en `conventions/domain-modeling.md`—) y un `orchestration.md` (el pipeline completo: fases, gating, handoffs y conteo de ciclos, al que remite la skill para no duplicarlo) — los tres, fuente estática en `assets/generators/spring/` —, `.claude/skills/keel-generate-spring/` con la skill sintetizada + `.claude/agents/` + conventions + solo las skills por tecnología del stack elegido (`src/scaffold/generator-docs.js` — `stackSkills()`), un snapshot del diseño en `specs/` que se refresca en cada build (en `build.js`, vía `copyTree` con force) y un snapshot de los contratos formales en `docs/` — solo lo que produce `/keel-docs` (openapi/asyncapi + sus visores, `overview.html`, colecciones Postman; nunca `DESIGN.md` ni `INTEGRATION.md`, que son de otras skills), enumerado por `src/lib/keel-docs.js` y escrito con `writeFiles` en force; si el diseñador aún no ha ejecutado `/keel-docs`, el build avisa y sigue. El scaffolding vive en `src/scaffold/` (un módulo por artefacto, patrón contexto precomputado + template literals) sobre `src/lib/` (`naming.js`, `type-mapper.js`, `model.js` — `buildModel()`, `writer.js` — regeneración segura estilo `copyTree`, `stack-catalog.js` + `stack-config.js` + `prompt.js` — cuestionario de stack persistido en `keel-stack.json` del servicio generado). El proyecto sale estilo Spring Initializr: wrapper de Gradle vendorizado en `vendor/gradle-wrapper/` (fuera de `assets/`) e `infra/docker-compose.yaml` de infraestructura de prueba según el stack. Assets (todos son **fuente** del `.claude/` del proyecto generado; nada se copia a un workspace): `assets/.claude/agents/` y `assets/generators/spring/` (contrato — README interno del generador, no se instala —, `orchestration.md`, `architecture.md`, `constitution.md`, `conventions/` — `mapping.md`, `project-layout.md`, `infra-validation.md`, `integration-tests.md`, `flow-fidelity.md`, `domain-modeling.md`, `domain-services.md`, `dependencies.md`, `virtual-threads.md` —, `skills/keel-spring-<tech>/`, `golden/`). Al añadir un agente o una convention, ampliar las listas `AGENTS`/`CONVENTIONS` de `src/scaffold/generator-docs.js`, que es el único punto de instalación.

## Comandos de desarrollo

```bash
npm install                                      # raíz
npm test                                         # todos los workspaces (node --test nativo)
npm test --workspace packages/keel-core          # un paquete
npm link --workspace packages/keel-core          # habilita `keel` local
npm link --workspace packages/keel-spring        # habilita `keel-spring` local
node packages/keel-core/src/cli.js <cmd>         # ejecutar sin link
```

## Flujo de validación (`validateService()`)

1. **Capa 0**: detecta artefactos aún en plantilla / `description` placeholder → `pending` (error duro salvo `--wip`).
2. **Capa 1**: JSON Schema por capa con Ajv 2020 (`assets/core/schema/<capa>.schema.json` + `common.schema.json`).
3. **Capa 2**: referencias cruzadas por nombre entre capas (`crossrefs.js`): tipos, entidades, agregados, lifecycle, payloads, endpoints→operaciones, roles, etc.

La revisión **semántica** (calidad del diseño, invariantes, mínimo privilegio) no está en código: la hace la skill `/keel-validate`.

## Dónde se añade cada cosa

| Cambio | Archivos a tocar |
|---|---|
| Nuevo comando CLI | `keel-core/src/cli.js` + nuevo archivo en `src/commands/` |
| Nueva regla de validación mecánica | `keel-core/src/lib/crossrefs.js` + test en `test/crossrefs.test.js` |
| Nueva capa del DSL | `LAYERS` en `src/lib/assets.js` + `assets/core/schema/<capa>.schema.json` + `assets/core/templates/service/<capa>.keel.yaml` + `assets/core/docs/dsl/<capa>.md` + reglas en `crossrefs.js` |
| Nuevo generador | Paquete `packages/keel-<tech>/` calcado de `keel-spring`; guía en `keel-core/assets/core/docs/building-a-generator.md`; registrar en `KNOWN_GENERATORS` (`src/lib/assets.js`) |
| Cambio de versión del DSL en un generador | Sincronizar `SUPPORTED_DSL` (`src/lib/assets.js` del generador) + campo `keel.dsl` de su `package.json` + su README |

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
