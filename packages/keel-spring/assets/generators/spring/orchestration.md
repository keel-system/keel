# Orquestación de agentes — cómo se genera el código

Cómo la skill `/keel-generate-spring` — ejecutada **dentro de este proyecto** (`cd` a la
raíz y `/keel-generate-spring`, sin argumentos) — lo completa hasta dejarlo funcional y
validado. La skill **no escribe código**: es la **orquestadora** de cinco subagentes
instalados en `.claude/agents/`, y toma sus decisiones de avance/relanzamiento (gating)
sobre el bloque estructurado (`status`, `blockers`, `failures`…) con el que cada agente
cierra su reporte.

## Punto de partida: qué dejó hecho `build`

`keel-spring build`, ejecutado en el workspace de diseño, ya generó de forma
**determinista** todo lo transversal al stack: el proyecto compila y arranca, con dominio puro, puertos,
contratos CQRS + `UseCaseMediator`, controllers, JPA, seguridad, stubs con `// TODO`,
config por perfiles e infraestructura de prueba en `infra/`. Lo que queda para los
agentes es la **frontera dependiente de la infraestructura elegida** (publishers/listeners
del broker, adaptador de storage), la lógica de negocio con sus invariantes y la
validación funcional contra el servidor real.

> **Sin pruebas unitarias en este flujo; con pruebas de integración.** No es una
> contradicción: los escenarios `FL-*` de `validation-scenarios.md` se traducen **una vez**
> a pruebas de integración JUnit (`src/integrationTest/`, caja negra contra el contrato) y
> se ejecutan contra la infraestructura real. El criterio de "generación terminada" es
> `./gradlew build -x test` en verde + `./gradlew integrationTest` con el **100%** de los
> escenarios en OK. La suite de pruebas **unitarias** sigue siendo un proceso
> **independiente y posterior**, que arranca cuando el diseñador ha validado el
> funcionamiento del servidor; el andamiaje que deja `build` (deps, perfil `test` con H2,
> `<Nombre>ApplicationTests`) se conserva intacto para esa fase.

## El pipeline

```mermaid
flowchart TB
    PRE["Precondiciones (cwd = raíz del proyecto):<br/>snapshot del diseño en specs/ · specs/validation-scenarios.md<br/>keel-stack.json · .claude/ completo"]

    PRE --> F1
    subgraph F1["Fase 1 — en paralelo"]
        CODE["keel-spring-code<br/>TODOs, negocio, adaptadores<br/>hasta ./gradlew build -x test en verde"]
        INFRA["keel-spring-infra<br/>compose up (docker/podman)<br/>+ sondeo validate-infra.sh"]
        TESTS["keel-spring-tests<br/>escenarios FL-* → src/integrationTest/<br/>hasta compileIntegrationTestJava en verde"]
    end

    CODE --> GATE1{Gating fase 1}
    INFRA --> GATE1
    TESTS --> GATE1
    GATE1 -->|"compiles: false → relanzar code<br/>con sus failures (máx. 2 ciclos)"| CODE
    GATE1 -->|"infra KO corregible → relanzar<br/>infra con el diagnóstico (1 vez)"| INFRA
    GATE1 -->|"tests KO por causa propia → relanzar<br/>tests (KO por src/main o locks: se reevalúa)"| TESTS
    GATE1 -->|"blockers en cualquiera"| STOP1[/"Detenerse y reportar:<br/>hueco o contradicción del diseño"/]
    GATE1 -->|"infra PENDIENTE (sin docker/podman)"| STOP0[/"Detenerse: sin infra no hay validación<br/>end-to-end → compilado pero NO validado"/]
    GATE1 -->|los tres OK| VALIDATE

    VALIDATE["Fase 2 — keel-spring-validate<br/>./gradlew integrationTest + arbitraje<br/>matriz desde el XML, evidencia de keel-failures/"]
    VALIDATE --> GATE2{Gating fase 2}
    GATE2 -->|"culprit: code → relanzar code con ese bloque y revalidar<br/>blocking: scoped → consume cupo (máx. 2)<br/>blocking: systemic → no consume (tope duro 4)"| CODE
    GATE2 -->|"culprit: test → relanzar tests<br/>(no consume cupo)"| TESTS
    GATE2 -->|"blockers o culprit: design"| STOP2[/"Detenerse: proponer cambio a los<br/>artefactos, no acomodar el código"/]
    GATE2 -->|"todos los escenarios OK (100%)"| QUALITY

    QUALITY["Fase 3 — keel-spring-quality<br/>pase no-conductual + ./gradlew build -x test en verde<br/>+ ./gradlew integrationTest al 100% (no-regresión)<br/>+ baseline de migraciones (con persistence)"]
    QUALITY --> GATE3{Gating fase 3}
    GATE3 -->|"quality KO, baseline KO<br/>o scenarios KO<br/>→ revertir el pase de calidad"| STOP3[/"Detenerse y reportar"/]
    GATE3 -->|OK| README["Actualizar README<br/>guía de despliegue productivo<br/>(pasos + parámetros de parameters/production/*)"]
    README --> CLOSE["Cierre: compose down · commit<br/>«Generado desde specs/&lt;servicio&gt; v&lt;version&gt;»<br/>+ resumen (matriz, remaining, blockers, designGaps)"]
```

Antes del commit de cierre, con la re-validación en 100% OK, el orquestador actualiza la
sección `## Despliegue en producción` del `README.md` del proyecto: pasos para levantar el
servidor en production y la tabla de parámetros obligatorios, derivados de
`src/main/resources/parameters/production/*.yaml` (todo `${VAR}` sin default) y del stack, más
lo que los agentes cablearon al completar los adaptadores. El scaffolding deja un baseline
determinista de esa sección; el orquestador la reconcilia con el código final.

## Por qué la fase 1 son tres agentes y ninguno espera a otro

Los tres arrancan a la vez porque **todos sus insumos ya están en disco** antes de empezar:
los dejó `keel-spring build` (`specs/`, `docs/openapi.yaml`, `keel-stack.json`,
`parameters/local/security.yaml`, `infra/`). No hay arista entre ellos, ni de datos ni de
recursos:

- **`tests` no espera a `infra`.** Mientras las pruebas se *escriben* no se toca un
  contenedor: derivan del contrato y su gate es compilación pura. Serializar metería
  `compose up --build` y sus reintentos en el camino crítico a cambio de nada. Lo único que
  antes viajaba de infra a la validación era `authHint`; ahora los dos lados leen el mismo
  `infra/test-credentials.env` que genera `build`, así que no hay nada que negociar en
  ejecución: la infraestructura crea lo que ese archivo declara y `AbstractFlowIT` pide
  exactamente eso. Verificar la fontanería en vivo exige además el código terminado, así que
  no cabe en la fase 1 ni serializando: cae en la fase 2, donde la validación arranca
  confirmando las `assumptions` que el agente de pruebas reportó.
- **`tests` no espera a `code`, y no puede quedar preso de él.** `build.gradle` deja
  `src/main/java` fuera del `compileClasspath` del source set `integrationTest`, así que
  `compileIntegrationTestJava` compila con el `main` a medio escribir. Ese mismo hecho es lo
  que hace la caja negra estructural: un test que importe una clase generada no compila.
- **El paralelismo es la garantía de independencia**, no una optimización de agenda: el autor
  de las pruebas nunca ve el código terminado, así que el test no puede acomodarse a lo que el
  código hace en vez de a lo que el `Then` dice. Dos lecturas independientes del mismo spec
  que coinciden son evidencia; donde discrepan, sale un fallo que hay que arbitrar.

## Los cinco agentes

| Agente | Responsabilidad | Qué lee | Qué NO hace |
|---|---|---|---|
| `keel-spring-code` | Completa TODOs, lógica de negocio, invariantes y adaptadores del stack hasta `./gradlew build -x test` en verde. Antes de cada handler ejecuta la auditoría de [flow-fidelity](conventions/flow-fidelity.md). | `.claude/CLAUDE.md` del proyecto (orden de capas), `architecture.md`, `constitution.md`, `specs/`, conventions ([mapping](conventions/mapping.md) estricto) y las skills `keel-spring-<tech>` del stack (SKILL.md primero, `references/` bajo demanda). | No escribe pruebas unitarias ni ejecuta `./gradlew test`; no toca contenedores, no ejecuta `bootRun` ni escenarios funcionales. |
| `keel-spring-infra` | Levanta `infra/docker-compose.yaml` con docker o podman (detección: `$CONTAINER_RUNTIME` → `docker` → `podman`), sondea con `infra/validate-infra.sh` (reintentos) y deja la infraestructura **arriba** para la validación. Con auth, **ejecuta y verifica** `infra/init-keycloak.sh` (que genera build) contra los valores de `infra/test-credentials.env`: no lo redacta. | [infra-validation](conventions/infra-validation.md) (sondeo por tecnología vía el contenedor `devtools`), la reference de auth del stack. | Nunca edita código del proyecto; solo corrige causas operativas (puerto ocupado, contenedor viejo). No baja la infraestructura al terminar. |
| `keel-spring-tests` | Traduce **una vez** los escenarios `FL-*` a pruebas de integración JUnit en `src/integrationTest/java/**/flows/` (una clase por flujo, `@DisplayName` con el id, `@BeforeAll` con `resetState()`), en caja negra: HTTP y JSON, jamás DTOs ni entidades. Cierra con `./gradlew compileIntegrationTestJava` en verde. | `specs/` (todas las capas + `validation-scenarios.md`), `docs/openapi.yaml`, [integration-tests](conventions/integration-tests.md) y la `AbstractFlowIT` que generó build. | **No lee `src/main/java`** (es la garantía de independencia), no implementa negocio, no escribe pruebas unitarias y no ejecuta las IT en la fase 1. |
| `keel-spring-validate` | **Gate de la generación** (única red de seguridad funcional: exige 100% de escenarios OK). Ejecuta `./gradlew integrationTest` —la app la arranca JUnit contra la infra real—, compone la matriz desde `build/test-results/integrationTest/*.xml` y **arbitra** cada fallo contra el `Then` original con la evidencia de `build/keel-failures/`, clasificándolo en `culprit: code \| test \| design`. | `specs/validation-scenarios.md`, [integration-tests](conventions/integration-tests.md), [infra-validation](conventions/infra-validation.md) y el reporte del agente de infraestructura. | No corrige código ni escribe/edita tests; no siembra datos a mano; no baja la infraestructura. |
| `keel-spring-quality` | Pase de higiene **no-conductual** (imports, constructor injection, `final`, excepciones tipadas, código muerto) con `./gradlew build -x test` en verde; la no-regresión conductual la comprueba él mismo re-ejecutando `./gradlew integrationTest`. Con capa `persistence`, además el **baseline de migraciones**: exporta el DDL de las entidades ya finales (`infra/export-schema.sh`), lo revisa, lo commitea como `db/migration/V1__baseline_schema.sql` y lo prueba con `PROFILE=local,migrations` sobre una BD sin esquema. | [project-layout](conventions/project-layout.md), [mapping](conventions/mapping.md) (transaccionalidad), `keel-spring-database/references/migrations.md`. | Nada conductual: validaciones, firmas, status HTTP, eventos, `@Transactional` — se reportan en `remaining`, no se aplican. No relaja `ddl-auto` fuera de `local` ni usa `baseline-on-migrate` para forzar el arranque. |

Regla común: ningún agente pregunta al usuario — registra sus bloqueos en `blockers`
y termina; decide el orquestador. Y ningún hueco del diseño se resuelve en silencio
en el código: se propone como cambio a los artefactos (`designGaps`).

## Handoffs: qué campo consume quién

| Campo | Lo emite | Lo consume | Para qué |
|---|---|---|---|
| `compiles` / `failures` | `keel-spring-code` | Orquestador | Relanzar code con sus propios errores de compilación (máx. 2 ciclos en fase 1). |
| `status: PENDIENTE`, `runtime` | `keel-spring-infra` | Orquestador | Detener la orquestación sin docker/podman (no hay validación posible); elegir el runtime del `compose down` final. |
| `authHint` | `keel-spring-infra` | Orquestador | Solo si el proveedor **no** quedó con los valores de `infra/test-credentials.env` (el contrato que genera build y que lee `AbstractFlowIT`): entonces hay que pasar `AUTH_TOKEN_URL`/`AUTH_TEST_CLIENT`/`AUTH_CLIENT_SECRET` por entorno. |
| `identity` | `keel-spring-infra` | Orquestador, `keel-spring-validate` | Que el aprovisionamiento corrió y que el token se pidió **de verdad**. Sin `tokenChecked: OK`, todo escenario autenticado va a fallar en bloque y no por su contrato. |
| `classes` / `uncovered` | `keel-spring-tests` | Orquestador, resumen final | Qué flujos quedaron traducidos y qué escenarios **no** se ejercitan (y por qué): dejan de darse por probados en silencio. |
| `assumptions` | `keel-spring-tests` | `keel-spring-validate` | Apuestas sobre infraestructura que la fase 1 no puede verificar (nombre de cola, cliente M2M, secreto, bucket). La validación las confirma **antes** de la primera ejecución de la suite: cada una fallida es un bloqueo sistémico que, descubierto por fuerza bruta, cuesta un ciclo completo. |
| `failures[].culprit` | `keel-spring-validate` | Orquestador | A quién relanzar: `code` → `keel-spring-code`; `test` → `keel-spring-tests`; `design` → detenerse. |
| `failures` (escenario, request, response, esperado) | `keel-spring-validate` | `keel-spring-code` / `keel-spring-tests` (relanzado) | Evidencia **exacta** para el ciclo de fix, tomada de `build/keel-failures/`. |
| `blocking: systemic \| scoped` | `keel-spring-validate` | Orquestador | Contar los ciclos de fix: ver «Ciclos de fix» abajo. |
| `coverageGaps` | `keel-spring-validate` | `keel-spring-tests` (relanzado), resumen | Categorías que ninguna clase de flujo ejercita: es cobertura que falta, no un fallo del código. |
| `remaining` | `keel-spring-quality` | Resumen final | Hallazgos conductuales pendientes de decisión humana. |
| `baseline` | `keel-spring-quality` | Orquestador | Gate de desplegabilidad: `KO` → relanzar una vez con el error; sin `OK` el commit lo dice explícitamente (production no arrancaría). |
| `scenarios: OK \| KO` | `keel-spring-quality` | Orquestador | No-regresión: el pase de calidad no cambió comportamiento. `KO` → revertir el pase, no tocar las pruebas. |
| `blockers` / `designGaps` | Cualquiera | Usuario | Contradicciones o huecos del diseño: se detiene la orquestación o se consolidan en el resumen; nunca se resuelven relanzando. |

## Ciclos de fix: bloqueo sistémico ≠ fallos puntuales

El cupo de la fase 2 son los ciclos código→validación para **fallos puntuales**
(`blocking: scoped`), y **escala con el tamaño del diseño**: un servicio de 22
flujos y cinco piezas de infraestructura no cabe en el mismo presupuesto que uno
de cinco flujos. Se cuenta sobre los flujos `FL-*` de `specs/validation-scenarios.md`:

| Flujos `FL-*` | Ciclos `scoped` | Tope duro |
|---|---|---|
| hasta 10 | 2 | 4 |
| 11–20 | 3 | 5 |
| más de 20 | 4 | 6 |

Un ciclo que cerró un **bloqueo sistémico** (`blocking: systemic` — una causa
transversal única que impedía ejercitar casi cualquier escenario: seguridad,
arranque, infraestructura) **no consume cupo**.

Tampoco lo consume un ciclo con `culprit: test`: relanza a `keel-spring-tests`, no a
`keel-spring-code`, y corrige la **prueba**, no el servicio. Mismo argumento que exime a
los bloqueos sistémicos: el cupo mide cuántas veces se le da otra oportunidad al código, y
un test mal derivado no dice nada sobre el código.

La razón es que un bloqueo sistémico *oculta* los fallos finos: mientras toda la
API responde 401, no se puede saber nada sobre las reglas de negocio. Al
destrabarlo aparece, por primera vez, una tanda de fallos específicos —
exactamente aquello para lo que existe el cupo. Cobrárselo al presupuesto de los
fallos puntuales lo agota antes de empezar a usarlo.

El tope duro de la tabla acota el total de ciclos de fase 2 (los `scoped` más los
que cerraron bloqueos sistémicos), para que ninguna calificación deje la
orquestación en bucle. Alcanzado el límite que aplique, el orquestador reporta la
matriz y se detiene.

## Autosuficiencia del proyecto generado

`build` deja en este proyecto todo lo que el pipeline necesita: la skill orquestadora
(`.claude/skills/keel-generate-spring/`), los cinco agentes (`.claude/agents/`), las
conventions (`.claude/conventions/`), `architecture.md` y `constitution.md`, las skills por
tecnología del stack elegido y un snapshot del diseño en `specs/`. **No hay nada del
generador en el workspace de diseño**: el pipeline se ejecuta siempre con el cwd en esta
raíz, y funciona idéntico desde un clon del repo, sin el workspace.

El canónico del diseño sigue siendo `specs/<servicio>/` del workspace: el snapshot de
`specs/` se refresca en cada `keel-spring build`. Si el diseño cambió, se re-ejecuta
`keel-spring build specs/<servicio>` allí (solo añade archivos nuevos; con `--force`
sobrescribe) y se vuelve a entrar aquí.
