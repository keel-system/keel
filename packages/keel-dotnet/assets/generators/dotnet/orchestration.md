# Orquestación de agentes — cómo se completa el proyecto

Cómo la skill `/keel-generate-dotnet` —ejecutada **dentro de este proyecto**, sin argumentos— lo completa hasta
dejarlo funcional y validado. La skill **no escribe código**: es la **orquestadora** de cinco subagentes, y decide
el avance y los relanzamientos (gating) sobre el bloque estructurado (`status`, `blockers`, `failures`…) con el que
cada uno cierra su reporte.

Es el **mismo pipeline** que el de keel-spring y keel-nest, con las mismas fases, los mismos códigos de salida y la
misma regla de quién arbitra: el objetivo de keel-dotnet es que el mismo diseño produzca un servidor equivalente, y
para eso también tiene que validarse igual. Lo que cambia son los comandos.

Lo **determinista** —compilar, ejecutar la suite y derivar la matriz de escenarios del XML JUnit— lo hace el
orquestador con `infra/score-scenarios.sh`; el agente de arbitraje solo se invoca cuando esa matriz trae algo en
rojo. Una generación que sale limpia no gasta una sesión en decir «todo OK».

## Punto de partida: qué dejó hecho `build`

`keel-dotnet build` ya generó de forma **determinista** todo lo transversal: la solución compila sin warnings y
arranca, con dominio puro (value objects con sus guardas, agregados con su lifecycle, errores), puertos, mensajes y
handlers con `TODO`, el mediator con su transacción y el registro de los handlers, la API REST entera (endpoints,
lectura y validación de cada petición, `ErrorResponse`), la persistencia EF Core (filas con su mapeo, adaptadores,
bloqueo optimista, traducción de constraints), la configuración por perfiles, la infraestructura de prueba en
`infra/` y el arnés de integración. Lo que queda para los agentes es la **lógica de negocio** con sus invariantes,
lo que los puertos necesiten además de lo derivable, las pruebas de los escenarios, la validación contra el
servidor real y el baseline de migraciones.

> **Sin pruebas unitarias nuevas; con pruebas de integración.** Los escenarios `FL-*` de `validation-scenarios.md`
> se traducen **una vez** a pruebas de flujo (xUnit, `tests/<Raíz>.IntegrationTests/`, caja negra contra el
> contrato) y se ejecutan contra la infraestructura real. El criterio de «generación terminada» es `dotnet build`
> en verde + el **100%** de los escenarios en OK. Las pruebas que `build` dejó en `tests/<Raíz>.UnitTests`
> (arranque bajo el perfil `test`, configuración, contrato del cable, API, cableado, modelo de EF) se conservan y
> se ejecutan en la fase 3 con `dotnet test`: no se escriben otras.

## El pipeline

```mermaid
flowchart TB
    PRE["⚙ Precondiciones: specs/validation-scenarios.md · keel-stack.json · repo git · dotnet restore"]
    PRE --> F1
    subgraph F1["Fase 1 — tres agentes en paralelo"]
        CODE(["🤖 keel-dotnet-code<br/>TODOs, negocio<br/>hasta dotnet build en verde"])
        INFRA(["🤖 keel-dotnet-infra<br/>bash infra/up.sh + validate-infra.sh"])
        TESTS(["🤖 keel-dotnet-tests<br/>escenarios FL-* → tests/…IntegrationTests/<br/>hasta infra/check-flows.sh en verde"])
    end
    CODE --> GATE1{Gating fase 1}
    INFRA --> GATE1
    TESTS --> GATE1
    GATE1 -->|"compiles: false → relanzar code (máx. 2)"| CODE
    GATE1 -->|"infra KO corregible → relanzar infra (1 vez)"| INFRA
    GATE1 -->|"tests KO por causa propia → relanzar tests"| TESTS
    GATE1 -->|"blockers"| STOP1[/"Detenerse y reportar"/]
    GATE1 -->|"infra PENDIENTE (sin docker/podman)"| STOP0[/"Detenerse: compilado pero NO validado"/]
    GATE1 -->|los tres OK| SCORE
    SCORE["⚙ Fase 2a — bash infra/score-scenarios.sh<br/>compila, humo del arnés y, en verde, la suite<br/>matriz FL-* desde el XML JUnit"]
    SCORE --> GATE2A{exit code}
    GATE2A -->|"2 · nada que arbitrar → relanzar tests<br/>(o code si la solución no compila; o el orquestador si es de build)"| TESTS
    GATE2A -->|"0 · matriz al 100%"| QUALITY
    GATE2A -->|"1 · FALLO / OMITIDO / NO_EJERC"| VALIDATE
    VALIDATE(["🤖 Fase 2b — keel-dotnet-validate<br/>arbitra: code | test | harness | design"])
    VALIDATE --> GATE2{Gating fase 2}
    GATE2 -->|"code → relanzar code"| CODE
    GATE2 -->|"test / harness → relanzar tests"| TESTS
    GATE2 -->|"design o blockers"| STOP2[/"Detenerse: proponer el cambio al diseño"/]
    CODE -.->|"tras el fix, SIEMPRE se vuelve al script"| SCORE
    TESTS -.-> SCORE
    QUALITY(["🤖 Fase 3 — keel-dotnet-quality<br/>pase no-conductual + build + suite al 100%<br/>+ dotnet test + baseline creado y verificado"])
    QUALITY --> GATE3{Gating fase 3}
    GATE3 -->|KO| STOP3[/"Revertir el pase y reportar"/]
    GATE3 -->|OK| CLOSE["⚙ Cierre: README · INFORME-GENERACION.md · design-gaps.yaml · infra/down.sh · commit"]
```

## Por qué la fase 1 son tres agentes y ninguno espera a otro

Todos sus insumos están en disco antes de empezar (`specs/`, `keel-stack.json`, `infra/`, el arnés), así que no hay
arista entre ellos:

- **`tests` no espera a `infra`**: escribir las pruebas no toca un contenedor; su gate es compilar.
- **`tests` no espera a `code`, y no puede quedar preso de él**: el proyecto de flujos no ve ningún tipo del
  servicio, y `infra/check-flows.sh` lo compila **sin construir sus referencias**. Un `src/` a medio escribir no lo
  pone en rojo. Es el equivalente del source set de integración de keel-spring, que compila sin el código del servicio.
- **El paralelismo es la garantía de independencia**: el autor de las pruebas nunca ve el código terminado (no lee
  `src/`), así que el test no puede acomodarse a lo que el código hace. Y la caja negra es estructural: un flujo que
  nombre un tipo del servicio no compila.

## Por qué la fase 2 está partida en dos

Ejecutar la suite y derivar «FL-x → OK | FALLO» del XML **no requiere criterio**: es parsear, y lo hace el script
con los mismos programas con los que keel-spring y keel-nest puntúan su XML. Decidir de quién es la culpa de un
fallo sí lo requiere, y no puede hacerlo quien tiene que poner la suite en verde: si fuera `keel-dotnet-code`,
`culprit: test` sería su salida barata y el `Then` acabaría ajustándose al código.

El script lo invoca el orquestador y por eso su salida es compacta: la de `dotnet` va entera a
`build/keel-scenarios/run.log`, la del servidor a `build/keel-scenarios/server.log`, y por stdout solo sale la
matriz. El orquestador es la sesión más larga del pipeline; no vuelques esos logs en su contexto salvo para
diagnosticar.

## Los códigos de `score-scenarios.sh`

| Código | Significa | Qué se hace |
|---|---|---|
| `0` | matriz al 100% | fase 3, sin invocar al árbitro |
| `1` | hay `FL-*` en FALLO, OMITIDO o NO_EJERC | fase 2b: `keel-dotnet-validate` con la matriz y los volcados |
| `2` | **nada que arbitrar**: la solución no compila, el humo del arnés está rojo, la matriz está vacía, la suite falló por pruebas que no son escenarios, un flujo no llegó a arrancar sin dejar ningún FALLO, o `specs/` no casa con su sello | según la causa (ver abajo); no consume cupo |

(El código `3` de keel-spring —workers de Gradle que sostienen `build/`— no existe aquí.)

### Un exit 2 no siempre es del agente de pruebas

- **`BUILD: KO`** (la solución no compila): los errores que imprime dicen de quién. En `src/`, de `keel-dotnet-code`;
  en el proyecto de flujos, de `keel-dotnet-tests`.
- **El humo, o un flujo, dentro del proyecto de flujos** (una prueba, o `Support/`): del agente de pruebas.
- **Fuera**: `infra/`, la solución, `Directory.*.props`. Eso lo escribe `keel-dotnet build`; lo corrige el
  orquestador y va a `INFORME-GENERACION.md` como fix del **generador** a portar.

### Un flujo que no arranca sale OMITIDO

Si el arranque de un flujo falla (el servidor no arranca, el reset falla, o su `GivenAsync`), la base da sus
escenarios por **OMITIDOS**, no por fallidos, y vuelca `build/keel-failures/<Flujo>-init.json` con la causa y el
último sondeo; el script lo lista como arnés roto. Si la causa es el **comportamiento del servidor** (no arranca
porque el código está mal), es `culprit: code` como cualquier otro rojo.

### Un `NO_EJERC` es rojo, y tiene dueño

Un escenario declarado en `validation-scenarios.md` que ninguna prueba ejercita sale `NO_EJERC` y el script sale
con `1`. Si se puede escribir, es cobertura que falta (`keel-dotnet-tests`, sin cupo); si no se puede por la
superficie que el propio escenario exige, es `culprit: design` y **se detiene**. Y detenerse significa no tocar el
diseño, ni aquí ni en el workspace: un `culprit: design` se **propone** en `design-gaps.yaml` y en el informe.
`score-scenarios.sh` comprueba el sello de `specs/` y sale con `2` si alguien lo editó.

## Los cinco agentes

| Agente | Responsabilidad | Qué NO hace |
|---|---|---|
| `keel-dotnet-code` | TODOs, lógica de negocio, invariantes, ampliar puertos de repositorio, hasta `dotnet build` en verde sin warnings y el gate del formato. Antes de cada handler, la auditoría de `conventions/flow-fidelity.md`. Relanzado desde la fase 2, lee la evidencia cruda y verifica su fix con el flujo afectado. | No escribe pruebas, no toca `tests/`, no levanta contenedores, no añade paquetes ni referencias. Su verde por flujo no aprueba escenarios. |
| `keel-dotnet-infra` | Levanta `infra/` (`bash infra/up.sh`) y la sondea (`bash infra/validate-infra.sh`); la deja arriba. | No edita código ni scripts de `infra/`. |
| `keel-dotnet-tests` | Traduce **una vez** los escenarios a `tests/<Raíz>.IntegrationTests/<Flujo>Flow.cs`, en caja negra, hasta `bash infra/check-flows.sh` en verde. | **No lee `src/`**, no implementa negocio, no ejecuta las pruebas en la fase 1. |
| `keel-dotnet-validate` | **Árbitro**: decide, contra el `Then` original y los volcados de `build/keel-failures/`, si cada fallo es `code`, `test`, `harness` o `design`. Solo corre si hay rojo. | No ejecuta la suite ni compone la matriz; no corrige código ni pruebas. |
| `keel-dotnet-quality` | Pase **no-conductual**, la no-regresión (la suite al 100%), `dotnet test` (lo que `build` dejó en `tests/<Raíz>.UnitTests`) y el **baseline de migraciones**: revisa el DDL del modelo (`infra/export-schema.sh`), crea la migración con `dotnet ef` y la **verifica en vivo** (`infra/verify-baseline.sh`). | Nada conductual: se reporta en `remaining`. |

Regla común: ningún agente pregunta al usuario —registra sus bloqueos en `blockers` y termina— y ningún hueco del
diseño se resuelve en silencio en el código: se propone en `designGaps`.

**La orquestación es de un solo nivel.** Los cinco son **hojas**: el único que invoca agentes es la skill. El cupo
de ciclos se cuenta sobre las invocaciones del orquestador, el gating se decide sobre el bloque del agente
invocado, y las restricciones que hacen válida la validación —el de pruebas sin leer `src/`, el árbitro sin
corregir, el de calidad sin cambiar comportamiento— son **del agente**: un subagente lanzado por él no las
heredaría.

## Handoffs

| Campo | Lo emite | Lo consume | Para qué |
|---|---|---|---|
| `compiles` / `failures` | code | orquestador | relanzar code con sus errores (máx. 2 ciclos en fase 1) |
| `status: PENDIENTE`, `runtime` | infra | orquestador | detenerse sin docker/podman; el runtime del `down` final |
| `files` / `uncovered` / `assumptions` | tests | orquestador, validate | qué flujos se tradujeron, qué no y por qué, y qué se dio por cierto de la infraestructura |
| matriz + `exit code` | ⚙ `score-scenarios.sh` | orquestador | `0` → fase 3 · `1` → árbitro · `2` → según la causa |
| `failures[].culprit` + `evidence` + `file` | validate | orquestador, code/tests relanzados | a quién relanzar y con qué evidencia exacta |
| `blocking: systemic \| scoped` | validate | orquestador | cómo se cuenta el ciclo |
| `harnessPatches` | tests (relanzado) | orquestador, informe | parches al arnés: son defectos del generador |
| `verifiedFlows` | code (relanzado) | orquestador | qué flujos verificó; NO aprueba escenarios |
| `baseline` / `baselineTested` | quality | orquestador, README | el baseline creado y verificado en vivo |
| `scenarios` / `unitTests` | quality | orquestador | no-regresión y `dotnet test` |
| `remaining` / `designGaps` / `blockers` | cualquiera | usuario, informe | lo que queda pendiente de decisión |

## El ciclo de fix se verifica a sí mismo, pero no se aprueba a sí mismo

El agente relanzado en la fase 2 cierra ejecutando **los flujos que le señaló el arbitraje** (`dotnet build` y el
ejecutable de los flujos con `-class`). Ese verde no aprueba nada: un fix puede regresionar otro flujo, y la matriz
sale del XML de **una** ejecución completa. Tras cualquier ciclo de fix se vuelve **siempre** a
`bash infra/score-scenarios.sh`.

Si una tanda mezcla `culprit: code` con `culprit: test`/`harness`, se relanzan **en serie** (primero code): los dos
ejecutan flujos sobre la misma base, y el reset de uno borra los datos del otro.

## Un solo actor sobre el proyecto

Mientras un agente está vivo, nadie más toca este directorio —el orquestador incluido—: el script sobrescribe
`build/keel-failures/` (la evidencia que el árbitro está leyendo), el reset vacía la base que otro está usando, y en
Windows un servidor de flujos vivo retiene el ejecutable del Api, así que una compilación a la vez falla. Y el
trabajo de un agente no lo hace el orquestador aunque sepa hacerlo: las restricciones que lo hacen válido son del
agente. La única ventana del orquestador es la fase 2a y el cierre.

## Ciclos de fix

El cupo de la fase 2 son los ciclos código → re-puntuación por fallos puntuales (`blocking: scoped`), y escala con
el número de flujos `FL-*`:

| Flujos `FL-*` | Ciclos `scoped` | Tope duro |
|---|---|---|
| hasta 10 | 2 | 4 |
| 11–20 | 3 | 5 |
| más de 20 | 4 | 6 |

No consumen cupo los ciclos que cierran un bloqueo sistémico (`blocking: systemic`: una causa transversal que
impedía ejercitar casi cualquier escenario), ni los `culprit: test` o `harness`, que no dicen nada del código.
Alcanzado el tope, se reporta la matriz y se detiene.

## El cierre devuelve al generador lo que es del generador

El cierre escribe `INFORME-GENERACION.md` en la raíz, que abre con **la matriz final y su código de salida,
literales** —si no está al 100%, el proyecto no está cerrado—, y sigue con: (1) incidencias del generador
(`harnessPatches`, fixes de `infra/` o de la solución, los `failures` con `culprit: harness`), cada una diciendo
**de quién es**; (2) código determinista mejorable; (3) agentes y convenciones donde un ciclo fue largo por falta
de un antecedente; (4) huecos del diseño.

Y los huecos del diseño se escriben además en `design-gaps.yaml` (schema `design-gaps.schema.json` de keel-core,
sellado con el `service` y la `version` de `specs/service.keel.yaml`), una entrada por hueco con `layer`, `unit`,
`kind`, `proposal`, `source` y el `scenario` que lo destapó. `keel-dotnet check` los imprime desde el workspace y
`/keel-evolve` los recoge. **Copia ese archivo fuera del proyecto antes de tirarlo**: comparar huecos entre corridas
es lo que distingue el hueco de un diseño del hueco del método.

## Autosuficiencia del proyecto

`build` deja aquí todo lo que el pipeline necesita: la skill orquestadora, los cinco agentes, las convenciones
(`{{keel:docs}}/conventions/`), `architecture.md`, `constitution.md`, la skill de la base de datos y el snapshot del
diseño en `specs/`. El canónico del diseño sigue siendo `specs/<servicio>/` del workspace: un cambio funcional se
hace allí, se re-ejecuta `keel-dotnet build specs/<servicio> --refresh` y se vuelve a entrar aquí.
