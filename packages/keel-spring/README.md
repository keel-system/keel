# keel-springboot

Generador **Spring Boot** para diseños [Keel](../../README.md). Es un paquete independiente con CLI propia que reparte el trabajo en dos fases: `build` instala el conocimiento del generador (skill + convenciones + golden), valida el diseño y genera de forma **determinista** el scaffolding del proyecto con arquitectura hexagonal + CQRS (Gradle con springdoc, perfiles `local`/`develop`/`production`/`test`, dominio puro + espejo JPA con puerto/adaptador, commands/queries + handlers stub vía `UseCaseMediator`, controllers `V1`, jerarquía de errores con `@RestControllerAdvice` y publishers de eventos); la lógica de negocio y los tests los completa el agente (Claude Code) con `/keel-generate-spring`.

## Uso

```bash
npm i -g keel-springboot

# en un workspace Keel (keel init), con el diseño terminado:
keel-springboot build specs/<servicio>
# → copia .claude/skills/keel-generate-spring/ y generators/spring/ al workspace
# → comprueba la compatibilidad DSL y ejecuta la validación (schemas + referencias cruzadas)
# → cuestionario de stack (BD/broker/auth/cache, solo lo que el diseño necesita) → keel-stack.json
# → genera el scaffolding determinista en services/<servicio>-spring/, estilo Spring Initializr:
#   wrapper de Gradle incluido + docker-compose de infraestructura de prueba

# después:
cd services/<servicio>-spring && docker compose up -d && ./gradlew bootRun

# y en Claude Code:
#   /keel-generate-spring specs/<servicio>   → completa lógica de negocio y tests
```

`build --defaults` (o sin terminal interactiva) omite el cuestionario con los defaults (PostgreSQL, Kafka, Keycloak, Redis). `build` es idempotente y de regeneración segura: no sobrescribe archivos existentes (ni assets instalados ni código ya implementado en `services/`) salvo con `--force`; el stack persistido en `keel-stack.json` se reutiliza sin repreguntar.

## Compatibilidad

| Paquete | DSL Keel |
|---------|----------|
| keel-springboot 0.1.x | `keel: "2.0"` |

El contrato completo del generador está en [`assets/generators/spring/README.md`](assets/generators/spring/README.md). Para crear un generador de otra tecnología con este mismo patrón: `docs/building-a-generator.md` del workspace (o `packages/keel-core/assets/core/docs/building-a-generator.md` en el monorepo).
