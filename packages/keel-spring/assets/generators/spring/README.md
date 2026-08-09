# Generador Spring Boot

Generador **Java / Spring Boot** para diseños Keel (paquete npm `keel-spring`). Este directorio es la **fuente** de lo que el generador instala en cada proyecto que produce; no se copia a ningún workspace de diseño. El trabajo se reparte en dos fases, separadas por un `cd`:

```bash
keel-spring build specs/<servicio>     # en el workspace de diseño → services/<servicio>-spring/
cd services/<servicio>-spring
/keel-generate-spring                  # dentro del proyecto, sin argumentos
```

1. **Scaffolding transversal al stack** (`keel-spring build`): la CLI pregunta el stack (BD, broker, auth, cache, storage — solo lo que el diseño necesita; persistido en `keel-stack.json`) y genera en `services/<servicio>-spring/` todo lo necesario para levantar el proyecto: Gradle **con wrapper** y las dependencias del stack elegido (estilo Spring Initializr), config por perfiles, el mecanismo de migraciones de esquema (Flyway del dialecto elegido, `db/migration/` y los perfiles auxiliares `schema-export`/`migrations`; el baseline lo produce el agente), infraestructura de prueba agrupada en `infra/` (`docker-compose.yaml`, `docker/Dockerfile`, `validate-infra.sh`, `reset-db.sh`, `export-schema.sh`), y toda la estructura independiente de la infra puntual — dominio puro, puertos, contratos CQRS + mediator, entidades, DTOs, controllers con las rutas reales, excepciones + `ApiExceptionHandler`, seguridad, JPA y stubs con `// TODO`. Además deja el proyecto como repo **autosuficiente** para el agente: `el archivo de contexto` contextual (orden de capas, stack, verificación), `docs/keel/architecture.md` (arquitectura hexagonal + CQRS y función de cada paquete) y `docs/keel/constitution.md` (reglas inviolables), un snapshot del diseño en `specs/` (refrescado en cada build), `el directorio de skills/keel-generate-spring/` con skill propia, `docs/keel/conventions/`, las skills por tecnología del stack elegido en `el directorio de skills/keel-spring-<tech>/` y `el directorio de agentes/` con los subagentes de la orquestación — quien clone el repo puede finalizar la generación sin el workspace.
2. **Completado orquestado por el agente** (skill `keel-generate-spring`, ejecutada **dentro del proyecto generado** y sin argumentos): la skill orquesta cinco subagentes — `keel-spring-code` (código dependiente de la infraestructura elegida — publishers/listeners del broker, adaptador de storage — siguiendo las skills `keel-spring-<tech>` instaladas en el proyecto, más lógica de negocio e invariantes) en paralelo con `keel-spring-infra` (levanta y sondea la infraestructura de `infra/` con docker o podman) y con `keel-spring-tests` (traduce los escenarios de `validation-scenarios.md` a pruebas de integración en `src/integrationTest/`, en caja negra y sin leer `src/main/java`); al terminar los tres, el orquestador ejecuta `infra/score-scenarios.sh` (corre la suite y compone la matriz desde el XML de JUnit: determinista, sin agente) y **solo si sale algo en rojo** invoca `keel-spring-validate`, que **arbitra** cada fallo en `culprit: code | test | harness | design` (el gate de la generación exige el 100% en OK); al final `keel-spring-quality` (pase de calidad no-conductual con la compilación en verde y los escenarios como no-regresión propia, más el baseline de migraciones de esquema exportado de las entidades ya finales y verificado con un doble check estático — la prueba en vivo contra una BD sin esquema es del diseñador, fuera del pipeline). Este flujo **no produce pruebas unitarias** —son un proceso independiente posterior a que el diseñador valide el servidor— pero **sí de integración**: los escenarios `FL-*` son código versionado, no `curl` efímero. El flujo completo — fases, gating, ciclos de reintento y handoffs — está en [orchestration.md](orchestration.md).

## Contrato

- **Entrada**: el diseño multi-artefacto de un servicio de este workspace — `specs/<servicio>/` con manifiesto (`service.keel.yaml`) más un artefacto por capa —, **ya validado** (`keel validate` + `/keel-validate`). `keel-spring build` ejecuta esa validación antes de generar el scaffolding.
- **Compatibilidad**: DSL `keel: "2.0"`, `"2.1"`, `"2.2"` y `"2.3"`. Si el manifiesto declara otra versión, el generador se detiene y lo reporta.
- **Salida**: un repo git propio en `services/<service.name>-spring/`, compilando (`./gradlew build -x test`) y con los escenarios `FL-*` validados en vivo al 100%, un README que registra `Generado desde specs/<servicio> v<service.version>` y las decisiones de generación tomadas, más lo que permite al agente completar la generación arrancando con cwd en el propio proyecto o desde un clon del repo: `docs/keel/` (`architecture.md`, `constitution.md`, `orchestration.md`, `conventions/`), los artefactos que carga el harness —skill orquestadora, agentes, skills por tecnología del stack y el archivo de contexto— proyectados a `.claude/` y `.opencode/`, y `specs/` (snapshot).
- **Regeneración segura**: re-ejecutar `build` solo añade archivos nuevos; lo implementado por el agente no se pisa (con `--force` se sobrescribe todo lo generado).
- **El diseño manda**: este generador nunca inventa ni corrige funcionalidad. Un hueco en el diseño se reporta como cambio propuesto a los artefactos, no se resuelve en el código.

## Contenido

| Ruta | Qué es |
|------|--------|
| `keel-spring-code.md`, `keel-spring-infra.md`, `keel-spring-tests.md`, `keel-spring-validate.md`, `keel-spring-quality.md` (fuera de este directorio, en `assets/el directorio de agentes/`) | Los cinco subagentes de la orquestación — código, infraestructura, pruebas de integración, arbitraje de fallos y calidad no-conductual — copiados a `el directorio de agentes/` del proyecto generado. La puntuación de la matriz **no** es un agente: la hace `infra/score-scenarios.sh`, que genera `src/scaffold/integration-tests.js` |
| `orchestration.md` | Flujo de la orquestación: fases, gating, ciclos de reintento y handoffs (copiado a `docs/keel/orchestration.md`) |
| `architecture.md` | Arquitectura hexagonal + CQRS y función de cada paquete (copiado a `docs/keel/architecture.md` del proyecto generado) |
| `constitution.md` | Reglas inviolables: frontera hexagonal, transaccionalidad, contratos públicos, precisión numérica (copiado a `docs/keel/constitution.md`) |
| `conventions/project-layout.md` | Stack por defecto y estructura del proyecto generado |
| `conventions/mapping.md` | Tabla normativa de mapeo diseño → código Spring, por capa |
| `conventions/infra-validation.md` | Sondeo de la infraestructura de prueba vía `devtools` + reset de datos entre flujos |
| `conventions/integration-tests.md` | Traducción de los escenarios `FL-*` a pruebas de integración JUnit (`src/integrationTest/`): forma de las clases, § Del DSL al cable y tabla de ejecución |
| `conventions/flow-fidelity.md` | Auditoría de fidelidad al flujo: checklist previa a implementar cada handler |
| `conventions/domain-modeling.md` | Modelado del dominio: agregados ricos, invariantes, value objects y reparto de la validación entre capas |
| `conventions/domain-services.md` | Cuándo y cómo crear servicios de dominio (`@DomainComponent`) |
| `conventions/read-composition.md` | Cómo se resuelven las referencias `embed` (por lote con el `<Raíz>RefResolver`) y cuándo hace falta un join proyectado en un adaptador de lectura |
| `conventions/dependencies.md` | Capa `dependencies`: proyecciones de réplica (`<Entidad>Projector` / `<Entidad>Reader`) y su cableado listener → guard → mediator → handler |
| `conventions/concurrency.md` | El servicio corre replicado: quién arbitra cada mecanismo de repetición, la ventana del `409 IDEMPOTENCY_KEY_IN_PROGRESS`, los `@Scheduled` que corren en todas las instancias y qué no cubre ningún gate |
| `conventions/virtual-threads.md` | I/O paralela con hilos virtuales en query handlers |
| `skills/` | Skills por tecnología del stack (`keel-spring-<tech>/` — database, kafka, rabbitmq, snssqs, s3, redis, keycloak, cognito; SKILL.md + `references/` bajo demanda), instaladas condicionalmente en el `el directorio de skills/` del proyecto generado según `keel-stack.json` |

## Compatibilidad

| Generador | DSL Keel |
|-----------|----------|
| keel-spring (actual) | `keel: "2.0"`, `keel: "2.1"`, `keel: "2.2"`, `keel: "2.3"` |
