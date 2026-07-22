# Generador Spring Boot

Generador **Java / Spring Boot** para diseños Keel, instalado en este workspace con `keel-spring build specs/<servicio>` (paquete npm `keel-spring`). El trabajo se reparte en dos fases:

1. **Scaffolding transversal al stack** (`keel-spring build`): la CLI pregunta el stack (BD, broker, auth, cache, storage — solo lo que el diseño necesita; persistido en `keel-stack.json`) y genera en `services/<servicio>-spring/` todo lo necesario para levantar el proyecto: Gradle **con wrapper** y las dependencias del stack elegido (estilo Spring Initializr), config por perfiles, `docker-compose.yaml` de prueba, y toda la estructura independiente de la infra puntual — dominio puro, puertos, contratos CQRS + mediator, entidades, DTOs, controllers con las rutas reales, excepciones + `ApiExceptionHandler`, seguridad, JPA y stubs con `// TODO`.
2. **Completado por el agente** (skill `keel-generate-spring`): el código que depende de la infraestructura elegida — publishers/listeners del broker, adaptador de storage — siguiendo `references/<tech>.md`, más lógica de negocio, invariantes y todos los tests, guiado por las convenciones de este directorio.

## Contrato

- **Entrada**: el diseño multi-artefacto de un servicio de este workspace — `specs/<servicio>/` con manifiesto (`service.keel.yaml`) más un artefacto por capa —, **ya validado** (`keel validate` + `/keel-validate`). `keel-spring build` ejecuta esa validación antes de generar el scaffolding.
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
| `references/` | Guía por tecnología del stack (kafka, rabbitmq, snssqs, s3, redis, keycloak, cognito) para el código que escribe el agente |
| `golden/` | Ejemplo de referencia para estilo y detección de regresiones |

## Compatibilidad

| Generador | DSL Keel |
|-----------|----------|
| keel-spring (actual) | `keel: "2.0"` |

## Estado

**Esqueleto.** Las convenciones están definidas; se consolidarán generando el primer servicio real, que además poblará `golden/`.
