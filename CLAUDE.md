# CLAUDE.md

Guía para desarrollar **Keel** (este repo). Todo el proyecto está en español: mensajes de CLI, docs, commits y este archivo.

## Qué es

Monorepo npm workspaces (`packages/*`) con una CLI Node.js (ESM puro, Node >=18, **sin build ni lint**) + una metodología para agentes. El diseño de un servicio se expresa en artefactos YAML declarativos ("DSL Keel 2.0", archivos `*.keel.yaml`, uno por capa en `specs/<servicio>/`). El código final (Java, etc.) **no lo genera JavaScript**: lo genera el agente siguiendo skills; la CLI solo siembra, valida y prepara.

## Distinción crítica: código vs. assets sembrados

- `packages/*/src/` — código de la CLI (lo que se ejecuta).
- `packages/*/assets/` — **payload** que `keel init` / `keel-spring build` copian al workspace del usuario final: schemas, templates, skills, docs y un `CLAUDE.md` plantilla.

Los `.claude/skills/` y el `CLAUDE.md` bajo `assets/` **no son configuración de este repo**. Editar un schema, template o doc del DSL significa editar dentro de `assets/`.

## Estructura

### `packages/keel-core` — CLI `keel`

- `src/cli.js` — entry point (commander). Comandos: `init`, `new`, `list`, `validate`, `describe`, `add` (deprecado).
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

Depende de `keel-core` y **no duplica** validación ni schemas. `src/commands/build.js` instala la skill + convenciones + skills por tecnología en el workspace, valida y genera el **scaffolding transversal al stack** en `services/<servicio>-spring/`: todo lo necesario para levantar el proyecto (dependencias según el stack elegido, config por perfiles `local`/`develop`/`production`/`test` con fragmentos `parameters/`, infraestructura de prueba agrupada en `infra/` — compose, `docker/Dockerfile.devtools`, `validate-infra.sh`, `reset-db.sh` para vaciar datos entre flujos de validación) más la estructura cuyo código no depende de la infra puntual, con la arquitectura hexagonal + CQRS del prototipo de referencia, sin paquete `shared` ni Spring Modulith (dominio puro + espejo `XxxJpa` con puerto/adaptador, commands/queries + handlers stub despachados vía `UseCaseMediator`, controllers `<Agregado>V1Controller`, jerarquía de errores `DomainException` + `ApiExceptionHandler`, seguridad, eventos con puerto `<Evento>Publisher` + stub). **Frontera**: el código cuya implementación cambia según la infra elegida (publishers/listeners del broker, adaptador de storage) no se genera — lo completa la skill `keel-generate-spring`, que actúa de **orquestadora** de cuatro subagentes (`assets/.claude/agents/keel-spring-{code,infra,validate,quality}.md`, instalados por `build` en el workspace y en el proyecto; cada uno cierra su reporte con un bloque estructurado `status`/`blockers`/`failures` sobre el que el orquestador hace gating): `keel-spring-code` (código y tests, guiado por las skills por tecnología `keel-spring-<tech>` — fuente en `assets/generators/spring/skills/`, cada una un directorio SKILL.md + `references/` con configuración/implementación/troubleshooting leídos bajo demanda, instaladas **como directorio completo** y condicionalmente en el `.claude/skills/` del proyecto según `keel-stack.json`; los seis dialectos de BD comparten `keel-spring-database` — tuning/dialecto/validación, el código JPA sigue saliendo de build) en paralelo con `keel-spring-infra` (levanta y sondea `infra/` con docker o podman), después `keel-spring-validate` (escenarios de `validation-scenarios.md` contra el servidor real, secuenciales con reset de datos por flujo vía `infra/reset-db.sh`) y al final `keel-spring-quality` (pase de calidad no-conductual con `./gradlew test` en verde). El proyecto generado queda como **repo autosuficiente** (clonable y finalizable sin el workspace): `build` le escribe, en `.claude/` del proyecto (`src/scaffold/claude-md.js` + `src/scaffold/generator-docs.js`), un `CLAUDE.md` contextual (orden de capas declaradas, stack, verificación), un `architecture.md` (arquitectura hexagonal + CQRS y función de cada paquete) y un `constitution.md` (reglas inviolables: frontera hexagonal, transaccionalidad, contratos públicos — fuente estática en `assets/generators/spring/architecture.md` y `constitution.md`), `.claude/skills/keel-generate-spring/` con skill propia + `.claude/agents/` + conventions + solo las skills por tecnología del stack elegido (`src/scaffold/generator-docs.js` — `stackSkills()`), y un snapshot del diseño en `specs/` que se refresca en cada build (en `build.js`, vía `copyTree` con force). El scaffolding vive en `src/scaffold/` (un módulo por artefacto, patrón contexto precomputado + template literals) sobre `src/lib/` (`naming.js`, `type-mapper.js`, `model.js` — `buildModel()`, `writer.js` — regeneración segura estilo `copyTree`, `stack-catalog.js` + `stack-config.js` + `prompt.js` — cuestionario de stack persistido en `keel-stack.json` del servicio generado). El proyecto sale estilo Spring Initializr: wrapper de Gradle vendorizado en `vendor/gradle-wrapper/` (fuera de `assets/`) e `infra/docker-compose.yaml` de infraestructura de prueba según el stack. Assets: `assets/.claude/skills/keel-generate-spring/`, `assets/.claude/agents/` y `assets/generators/spring/` (contrato, `orchestration.md` — flujo de la orquestación de agentes —, `architecture.md`, `constitution.md`, `conventions/` — `mapping.md`, `project-layout.md`, `infra-validation.md`, `flow-fidelity.md`, `domain-services.md`, `virtual-threads.md` —, `skills/keel-spring-<tech>/`, `golden/`). Al añadir un agente o una convention, ampliar las listas `AGENTS`/`CONVENTIONS` de `src/scaffold/generator-docs.js` (instalación en el proyecto generado; al workspace van por `copyTree`).

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
- Skills: `keel-<verbo>`; generadores: skill `keel-generate-<tech>`, paquete `keel-<tech>` con bin homónimo.
- Servicios generados: `services/<nombre>-<tech>/`.
- Español en todo lo visible al usuario (mensajes, docs, commits).
- **Identificadores en inglés (mandatorio)**: los nombres del DSL (types, entidades, operaciones, eventos…) y todo directorio, archivo y símbolo del código generado por los agentes van en inglés; solo la prosa (descriptions, comentarios, mensajes) va en español. Regla canónica en `assets/core/docs/dsl-reference.md` y en `keel-spring/assets/generators/spring/constitution.md`.

## Documentación canónica (es payload: se edita en `assets/`)

- `packages/keel-core/assets/core/docs/methodology.md` — metodología completa.
- `packages/keel-core/assets/core/docs/dsl-reference.md` + `docs/dsl/<capa>.md` — referencia del DSL.
- `packages/keel-core/assets/core/docs/building-a-generator.md` — cómo crear un generador.
- `packages/keel-core/assets/core/docs/validation-scenarios.md` — escenarios Given/When/Then.
