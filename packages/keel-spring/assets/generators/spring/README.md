# Generador Spring Boot

Generador **Java / Spring Boot** para diseños Keel, instalado en este workspace con `keel-springboot build specs/<servicio>` (paquete npm `keel-springboot`). El trabajo se reparte en dos fases:

1. **Scaffolding determinista** (`keel-springboot build`): la CLI pregunta el stack (BD, broker, auth, cache — solo lo que el diseño necesita; persistido en `keel-stack.json`) y genera en `services/<servicio>-spring/` todo lo derivable mecánicamente del diseño — proyecto Gradle **con wrapper** (estilo Spring Initializr), entidades, enums, value objects, repositorios, DTOs, controllers con las rutas reales, excepciones de negocio, stubs de application services con `// TODO` y `docker-compose.yaml` de infraestructura de prueba.
2. **Completado por el agente** (skill `keel-generate-spring`): lógica de negocio, invariantes, capas security/messaging/http-clients y todos los tests, guiado por las convenciones de este directorio.

## Contrato

- **Entrada**: el diseño multi-artefacto de un servicio de este workspace — `specs/<servicio>/` con manifiesto (`service.keel.yaml`) más un artefacto por capa —, **ya validado** (`keel validate` + `/keel-validate`). `keel-springboot build` ejecuta esa validación antes de generar el scaffolding.
- **Compatibilidad**: DSL `keel: "2.0"`. Si el manifiesto declara otra versión, el generador se detiene y lo reporta.
- **Salida**: un repo git propio en `services/<service.name>-spring/`, con tests pasando y un README que registra `Generado desde specs/<servicio> v<service.version>` y las decisiones de generación tomadas.
- **Regeneración segura**: re-ejecutar `build` solo añade archivos nuevos; lo implementado por el agente no se pisa (con `--force` se sobrescribe todo lo generado).
- **El diseño manda**: este generador nunca inventa ni corrige funcionalidad. Un hueco en el diseño se reporta como cambio propuesto a los artefactos, no se resuelve en el código.

## Contenido

| Ruta | Qué es |
|------|--------|
| `.claude/skills/keel-generate-spring/` (en la raíz del workspace) | La skill que ejecuta la generación |
| `conventions/project-layout.md` | Stack por defecto y estructura del proyecto generado |
| `conventions/mapping.md` | Tabla normativa de mapeo diseño → código Spring, por capa |
| `golden/` | Ejemplo de referencia para estilo y detección de regresiones |

## Compatibilidad

| Generador | DSL Keel |
|-----------|----------|
| keel-springboot (actual) | `keel: "2.0"` |

## Estado

**Esqueleto.** Las convenciones están definidas; se consolidarán generando el primer servicio real, que además poblará `golden/`.
