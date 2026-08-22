# keel-spring

Generador **Spring Boot** para diseños [Keel](../../README.md). Es un paquete independiente con CLI propia que reparte el trabajo en dos fases, separadas por un `cd`: `build` —ejecutado en el workspace de diseño— valida el diseño, pregunta el stack al diseñador y genera de forma **determinista**, dentro de `services/<servicio>-spring/`, el scaffolding **transversal al stack** — todo lo necesario para levantar el proyecto con arquitectura hexagonal + CQRS (Gradle con las dependencias del stack elegido y springdoc, perfiles `local`/`develop`/`production`/`test`, dominio puro + espejo JPA con puerto/adaptador, commands/queries + handlers stub vía `UseCaseMediator`, controllers `V1`, jerarquía de errores con `@RestControllerAdvice`, puertos de publicación de eventos con stub) — más el `.claude/` completo del agente (skill propia, agentes, conventions y las skills por tecnología del stack) y un snapshot del diseño en `specs/`. **En el workspace de diseño no se instala nada**: el conocimiento del generador vive solo dentro del proyecto que produce. El código que depende de la infraestructura elegida (publishers/listeners del broker, adaptador de storage) y la lógica de negocio los completa el agente (Claude Code) ejecutando `/keel-generate-spring` **dentro del proyecto**, que orquesta cinco subagentes instalados por `build` en `.claude/agents/`: `keel-spring-code` (código, sin pruebas unitarias, guiado por las skills `keel-spring-<tech>` instaladas en el proyecto según `keel-stack.json`) en paralelo con `keel-spring-infra` (levanta la infraestructura de prueba de `infra/` con docker o podman) y con `keel-spring-tests` (traduce **una vez** los escenarios `FL-*` de `validation-scenarios.md` a pruebas de integración JUnit en `src/integrationTest/`, en caja negra y sin leer `src/main/java` — el source set deja `main` fuera de su `compileClasspath`, así que compilan en paralelo con el código y la caja negra es estructural), después la puntuación de escenarios, que **no es un agente**: el orquestador ejecuta `infra/score-scenarios.sh` (corre `./gradlew integrationTest` —la app la arranca JUnit, con reset de datos por flujo vía `infra/reset-db.sh`— y compone la matriz desde el XML de JUnit, con la salida de Gradle al log para no cargarle el contexto), y **solo si sale algo en rojo** invoca `keel-spring-validate`, que arbitra cada fallo en `culprit: code | test | harness | design`; al final `keel-spring-quality` (pase de calidad no-conductual, los escenarios como no-regresión propia, más el baseline de migraciones de esquema —build deja el mecanismo Flyway con `db/migration/` vacío; el agente lo exporta de las entidades finales con `infra/export-schema.sh` y lo prueba en vivo—). El criterio de terminado es `./gradlew build -x test` en verde más `./gradlew integrationTest` con el 100% de los escenarios end-to-end en OK; la suite de pruebas **unitarias** es un proceso independiente y posterior a que el diseñador valide el servidor. Cada subagente reporta con un bloque estructurado (`status`/`blockers`/`failures`) sobre el que la skill orquestadora decide avances y relanzamientos.

## Uso

```bash
npm i -g keel-spring

# 1) en un workspace Keel (keel init), con el diseño terminado:
keel-spring build specs/<servicio>
# → comprueba la compatibilidad DSL y ejecuta la validación (schemas + referencias cruzadas)
# → cuestionario de stack (BD/broker/auth/cache/storage, solo lo que el diseño necesita) → keel-stack.json
# → genera services/<servicio>-spring/: scaffolding transversal al stack estilo Spring Initializr
#   (wrapper de Gradle incluido + infraestructura de prueba en infra/; compila y arranca tal cual),
#   más .claude/ (skill, agentes, conventions, skills del stack) y snapshots de specs/ y docs/
# → el workspace de diseño no recibe ningún archivo

# 2) dentro del proyecto generado:
cd services/<servicio>-spring

# y en Claude Code, abierto en esa raíz:
#   /keel-generate-spring   → sin argumentos; orquesta código + infraestructura + validación funcional
```

Para arrancarlo a mano en cualquier momento: `docker compose -f infra/docker-compose.yaml up -d && ./gradlew bootRun`.

`build --defaults` (o sin terminal interactiva) omite el cuestionario con los defaults (PostgreSQL, Kafka, Keycloak, Redis). `build` es idempotente y de regeneración segura: no sobrescribe el código ya implementado por el agente salvo con `--force`; el stack persistido en `keel-stack.json` se reutiliza sin repreguntar, y los snapshots de `specs/` y `docs/` se refrescan siempre.

## Compatibilidad

| Paquete | DSL Keel |
|---------|----------|
| keel-spring 0.1.x | `keel: "2.13"` |

Una sola versión, en espejo de lo que acepta `keel validate`: los schemas del DSL no gatean primitivos por versión, así que aceptar las anteriores haría que el campo `keel` de un manifiesto declarase una intención que nada comprueba. El razonamiento completo, en `docs/dsl-reference.md § Historial de versiones`.

El contrato completo del generador está en [`assets/generators/spring/README.md`](assets/generators/spring/README.md). Para crear un generador de otra tecnología con este mismo patrón: `docs/building-a-generator.md` del workspace (o `packages/keel-core/assets/core/docs/building-a-generator.md` en el monorepo).
