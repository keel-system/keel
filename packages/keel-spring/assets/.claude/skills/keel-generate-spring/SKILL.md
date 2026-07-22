---
name: keel-generate-spring
description: Genera un microservicio Java / Spring Boot completo a partir de un servicio Keel multi-artefacto validado, orquestando subagentes de código, infraestructura y validación funcional. Usar cuando el usuario quiere producir (o regenerar) el código Spring de un servicio diseñado en este workspace.
argument-hint: "<specs/servicio>"
---

# /keel-generate-spring — diseño Keel → servicio Spring Boot

Completa el servicio indicado (`specs/<servicio>/`: manifiesto + un artefacto por capa) hasta un proyecto Spring Boot funcional. `keel-spring build` ya generó de forma **determinista** todo lo transversal al stack: el proyecto arranca (Gradle con las dependencias del stack elegido, config por perfiles, infraestructura de prueba en `infra/`) y trae la estructura completa que no depende de la infraestructura puntual — dominio puro, puertos, contratos CQRS + `UseCaseMediator`, DTOs, controllers, `ApiExceptionHandler`, seguridad, JPA y stubs de handlers. Lo que queda —implementaciones de los puertos de infraestructura, lógica de negocio, invariantes, tests y la validación funcional— **no lo haces tú directamente: eres el orquestador** de tres subagentes instalados por `build` en `.claude/agents/` (del workspace y del proyecto generado): `keel-spring-code` (completa el código hasta tests en verde), `keel-spring-infra` (levanta y sondea la infraestructura de prueba con docker o podman) y `keel-spring-validate` (ejecuta los escenarios de `validation-scenarios.md` contra el servidor real). El contrato y compatibilidad de este generador están en `generators/spring/README.md`; las convenciones en `generators/spring/conventions/`; las guías por tecnología en `generators/spring/skills/` (fuente: los agentes leen las skills instaladas en el proyecto). El proyecto generado es un repo **autosuficiente** (quien lo clone puede finalizar la generación sin este workspace): `build` deja en `services/<servicio>-spring/` un `CLAUDE.md` contextual, un snapshot del diseño en `specs/`, la skill propia con conventions en `.claude/skills/keel-generate-spring/`, las skills por tecnología del stack elegido en `.claude/skills/keel-spring-<tech>/` (instaladas condicionalmente según `keel-stack.json`), y los mismos tres agentes en `.claude/agents/`.

## Proceso

1. **Compatibilidad y validez.**
   - El manifiesto (`service.keel.yaml`) debe declarar `keel: "2.0"`. Otra versión → detente y repórtalo.
   - `keel-spring build` ya validó al instalar; si el diseño cambió desde entonces, ejecuta `keel validate specs/<servicio>` (sin `--wip`) y la checklist semántica de `/keel-validate`. Errores → detente y repórtalos; nunca se genera desde un diseño inválido o incompleto.
   - Debe existir `specs/<servicio>/validation-scenarios.md` (los escenarios que cierran el diseño). Si falta, detente y pide cerrarlo con `/keel-design`: sin escenarios no hay contra qué validar el servidor generado.

2. **Decisiones de generación.** El stack (BD, broker, auth, cache, storage) ya lo eligió el diseñador en el cuestionario de `keel-spring build` y está en `services/<servicio>-spring/keel-stack.json`: respétalo. Para cambiar el stack: borrar `keel-stack.json` y re-ejecutar `keel-spring build --force`. Solo pregunta al usuario decisiones que el scaffolding no cubre (paquete base distinto, etc.) y regístralas en el README generado.

3. **Destino.** El proyecto vive en `services/<service.name>-spring/` dentro del workspace, creado por el scaffolding de `keel-spring build`. Sea `<proyecto>` esa ruta.
   - Si no existe: pide ejecutar primero `keel-spring build specs/<servicio>` (no lo recrees a mano).
   - Si el diseño cambió desde el último build, re-ejecuta `keel-spring build specs/<servicio>`: solo añade archivos nuevos, nunca pisa lo ya implementado (con `--force` sobrescribe; avisa antes qué se perdería).
   - Si el directorio no es aún un repo git, inicialízalo (`git init -b main`).

4. **Fase 1 — código e infraestructura EN PARALELO.** Lanza en un único mensaje dos subagentes (dos Task en paralelo):
   - `keel-spring-code`: «Completa el proyecto en `<proyecto>`. Sigue su `CLAUDE.md`.» — implementa TODOs, lógica de negocio, adaptadores del stack y tests hasta `./gradlew test` en verde.
   - `keel-spring-infra`: «Levanta y valida la infraestructura de `<proyecto>` (`infra/docker-compose.yaml`). Déjala arriba y reporta.»

   Espera a **ambos**. Manejo de fallos:
   - Infra KO porque no hay docker ni podman disponibles → continúa: el agente de código verifica con `./gradlew test` (H2/embebidos); omite la fase 2, reporta la validación funcional como **PENDIENTE** y sugiere testcontainers.
   - Infra KO por causa corregible reportada → relanza `keel-spring-infra` una vez con el diagnóstico. Si sigue KO, detente antes de la fase 2 y reporta.
   - Código KO (tests en rojo tras su trabajo) → relanza `keel-spring-code` con el reporte de fallos (máx. 2 ciclos); si persiste, reporta al usuario y detente.

5. **Fase 2 — validación funcional.** Solo con código OK e infra OK (o sin infraestructura que levantar): lanza `keel-spring-validate` pasándole `<proyecto>` y el reporte del agente de infraestructura. Ejecuta cada escenario `FL-*` de `specs/<servicio>/validation-scenarios.md` contra el servidor real y devuelve la matriz escenario → resultado.
   - Escenarios en FALLO → relanza `keel-spring-code` con la evidencia de los fallos y después de nuevo `keel-spring-validate` (máx. 2 ciclos código→validación); si persiste, reporta y detente.
   - Si un escenario contradice el spec, el hueco es del diseño: propón corregir `validation-scenarios.md`/los artefactos, no acomodes el código en silencio.
   - Al terminar todo, baja la infraestructura: `docker compose -f <proyecto>/infra/docker-compose.yaml down` (o `podman compose`, según el runtime que reportó el agente de infraestructura).

6. **Cerrar.** Commit en el repo generado (`Generado desde specs/<servicio> v<version>`). Resume al usuario: qué se generó, decisiones tomadas, la matriz escenario → resultado, el estado final de cada agente y cualquier hueco del diseño detectado (propuesto como cambio a los artefactos, nunca resuelto en silencio en el código).

## Reglas

- El diseño es la única fuente de verdad funcional. Nada de entidades, campos, endpoints o reglas que no estén en sus artefactos.
- Los `code` de error y los nombres de evento se copian exactos: son contrato público.
- Ante ambigüedad: diseño > conventions > golden > tu criterio (documentado).
- El detalle capa por capa (qué completar en application/domain/api/security/messaging/http-clients/storage/persistence) vive en el `CLAUDE.md` del proyecto generado, que es lo que consume el agente de código: no lo dupliques aquí ni en los prompts.
- Si esta skill, los agentes o las conventions se quedan cortas durante una generación real, propón la mejora (y considera contribuirla al paquete keel-spring) — el generador aprende de cada uso.
