# keel-spring

Generador **Spring Boot** para diseños [Keel](../../README.md). Es un paquete independiente con CLI propia que reparte el trabajo en dos fases: `build` instala el conocimiento del generador (skill + convenciones + skills por tecnología + golden), valida el diseño y genera de forma **determinista** el scaffolding **transversal al stack** — todo lo necesario para levantar el proyecto con arquitectura hexagonal + CQRS (Gradle con las dependencias del stack elegido y springdoc, perfiles `local`/`develop`/`production`/`test`, dominio puro + espejo JPA con puerto/adaptador, commands/queries + handlers stub vía `UseCaseMediator`, controllers `V1`, jerarquía de errores con `@RestControllerAdvice`, puertos de publicación de eventos con stub). El código que depende de la infraestructura elegida (publishers/listeners del broker, adaptador de storage), la lógica de negocio y los tests los completa el agente (Claude Code) con `/keel-generate-spring`, que orquesta cuatro subagentes instalados por `build` en `.claude/agents/`: `keel-spring-code` (código y tests, guiado por las skills `keel-spring-<tech>` instaladas en el proyecto según `keel-stack.json`) en paralelo con `keel-spring-infra` (levanta la infraestructura de prueba de `infra/` con docker o podman), después `keel-spring-validate` (escenarios de `validation-scenarios.md` contra el servidor real, con reset de datos entre flujos vía `infra/reset-db.sh`) y al final `keel-spring-quality` (pase de calidad no-conductual con tests en verde). Cada subagente reporta con un bloque estructurado (`status`/`blockers`/`failures`) sobre el que la skill orquestadora decide avances y relanzamientos.

## Uso

```bash
npm i -g keel-spring

# en un workspace Keel (keel init), con el diseño terminado:
keel-spring build specs/<servicio>
# → copia .claude/skills/keel-generate-spring/, .claude/agents/ y generators/spring/ al workspace
# → comprueba la compatibilidad DSL y ejecuta la validación (schemas + referencias cruzadas)
# → cuestionario de stack (BD/broker/auth/cache/storage, solo lo que el diseño necesita) → keel-stack.json
# → genera el scaffolding transversal al stack en services/<servicio>-spring/, estilo Spring Initializr:
#   wrapper de Gradle incluido + infraestructura de prueba en infra/; compila y arranca tal cual

# después:
cd services/<servicio>-spring && docker compose -f infra/docker-compose.yaml up -d && ./gradlew bootRun

# y en Claude Code:
#   /keel-generate-spring specs/<servicio>   → orquesta código + infraestructura + validación funcional
```

`build --defaults` (o sin terminal interactiva) omite el cuestionario con los defaults (PostgreSQL, Kafka, Keycloak, Redis). `build` es idempotente y de regeneración segura: no sobrescribe archivos existentes (ni assets instalados ni código ya implementado en `services/`) salvo con `--force`; el stack persistido en `keel-stack.json` se reutiliza sin repreguntar.

## Compatibilidad

| Paquete | DSL Keel |
|---------|----------|
| keel-spring 0.1.x | `keel: "2.0"` |

El contrato completo del generador está en [`assets/generators/spring/README.md`](assets/generators/spring/README.md). Para crear un generador de otra tecnología con este mismo patrón: `docs/building-a-generator.md` del workspace (o `packages/keel-core/assets/core/docs/building-a-generator.md` en el monorepo).
