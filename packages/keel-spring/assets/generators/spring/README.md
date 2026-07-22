# Generador Spring Boot

Generador **Java / Spring Boot** para diseños Keel, instalado en este workspace con `keel-spring build specs/<servicio>` (paquete npm `keel-spring`). El trabajo se reparte en dos fases:

1. **Scaffolding transversal al stack** (`keel-spring build`): la CLI pregunta el stack (BD, broker, auth, cache, storage — solo lo que el diseño necesita; persistido en `keel-stack.json`) y genera en `services/<servicio>-spring/` todo lo necesario para levantar el proyecto: Gradle **con wrapper** y las dependencias del stack elegido (estilo Spring Initializr), config por perfiles, infraestructura de prueba agrupada en `infra/` (`docker-compose.yaml`, `docker/Dockerfile.devtools`, `validate-infra.sh`), y toda la estructura independiente de la infra puntual — dominio puro, puertos, contratos CQRS + mediator, entidades, DTOs, controllers con las rutas reales, excepciones + `ApiExceptionHandler`, seguridad, JPA y stubs con `// TODO`. Además deja el proyecto como repo **autosuficiente** para el agente: `.claude/CLAUDE.md` contextual (orden de capas, stack, verificación), `.claude/architecture.md` (arquitectura hexagonal + CQRS y función de cada paquete) y `.claude/constitution.md` (reglas inviolables), un snapshot del diseño en `specs/` (refrescado en cada build), `.claude/skills/keel-generate-spring/` con skill propia + conventions, las skills por tecnología del stack elegido en `.claude/skills/keel-spring-<tech>/` y `.claude/agents/` con los subagentes de la orquestación — quien clone el repo puede finalizar la generación sin el workspace.
2. **Completado orquestado por el agente** (skill `keel-generate-spring`): la skill orquesta tres subagentes — `keel-spring-code` (código dependiente de la infraestructura elegida — publishers/listeners del broker, adaptador de storage — siguiendo las skills `keel-spring-<tech>` instaladas en el proyecto, más lógica de negocio, invariantes y tests) en paralelo con `keel-spring-infra` (levanta y sondea la infraestructura de `infra/` con docker o podman), y al terminar ambos, `keel-spring-validate` (escenarios de `validation-scenarios.md` contra el servidor real).

## Contrato

- **Entrada**: el diseño multi-artefacto de un servicio de este workspace — `specs/<servicio>/` con manifiesto (`service.keel.yaml`) más un artefacto por capa —, **ya validado** (`keel validate` + `/keel-validate`). `keel-spring build` ejecuta esa validación antes de generar el scaffolding.
- **Compatibilidad**: DSL `keel: "2.0"`. Si el manifiesto declara otra versión, el generador se detiene y lo reporta.
- **Salida**: un repo git propio en `services/<service.name>-spring/`, con tests pasando, un README que registra `Generado desde specs/<servicio> v<service.version>` y las decisiones de generación tomadas, y `.claude/` (`CLAUDE.md`, `architecture.md`, `constitution.md`, skill orquestadora, conventions, skills por tecnología del stack) + `specs/` (snapshot) que permiten al agente completar la generación arrancando con cwd en el propio proyecto o desde un clon del repo.
- **Regeneración segura**: re-ejecutar `build` solo añade archivos nuevos; lo implementado por el agente no se pisa (con `--force` se sobrescribe todo lo generado).
- **El diseño manda**: este generador nunca inventa ni corrige funcionalidad. Un hueco en el diseño se reporta como cambio propuesto a los artefactos, no se resuelve en el código.

## Contenido

| Ruta | Qué es |
|------|--------|
| `.claude/skills/keel-generate-spring/` (en la raíz del workspace) | La skill que orquesta la generación |
| `.claude/agents/keel-spring-{code,infra,validate,quality}.md` (en la raíz del workspace) | Los subagentes de la orquestación: código, infraestructura, validación funcional y calidad no-conductual |
| `architecture.md` | Arquitectura hexagonal + CQRS y función de cada paquete (copiado a `.claude/architecture.md` del proyecto generado) |
| `constitution.md` | Reglas inviolables: frontera hexagonal, transaccionalidad, contratos públicos (copiado a `.claude/constitution.md`) |
| `conventions/project-layout.md` | Stack por defecto y estructura del proyecto generado |
| `conventions/mapping.md` | Tabla normativa de mapeo diseño → código Spring, por capa |
| `conventions/infra-validation.md` | Sondeo de la infraestructura de prueba vía `devtools` + reset de datos entre flujos |
| `conventions/flow-fidelity.md` | Auditoría de fidelidad al flujo: checklist previa a implementar cada handler |
| `conventions/domain-services.md` | Cuándo y cómo crear servicios de dominio (`@DomainComponent`) |
| `conventions/virtual-threads.md` | I/O paralela con hilos virtuales en query handlers |
| `skills/` | Skills por tecnología del stack (`keel-spring-<tech>/` — kafka, rabbitmq, snssqs, s3, redis, keycloak, cognito), instaladas condicionalmente en el `.claude/skills/` del proyecto generado según `keel-stack.json` |
| `golden/` | Ejemplo de referencia para estilo y detección de regresiones |

## Compatibilidad

| Generador | DSL Keel |
|-----------|----------|
| keel-spring (actual) | `keel: "2.0"` |

## Estado

**Esqueleto.** Las convenciones están definidas; se consolidarán generando el primer servicio real, que además poblará `golden/`.
