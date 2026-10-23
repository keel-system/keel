---
name: keel-recover-run
description: "Recupera un servicio existente de punta a punta en un solo comando reanudable: sandbox del legacy, observación por rondas de sondas, diseño Keel con su procedencia, escenarios ejecutados contra el legacy, cierre del diseño, build y paridad con el servicio regenerado. Mira en disco en qué paso está (keel-recover status) y sigue; orquesta los subagentes keel-recover-sandbox, keel-recover-explorer y keel-recover-designer y solo para en tres puntos de decisión agrupados y en la generación. Usar con la ruta legacy/<servicio> tras keel-recover init, y volver a llamarlo igual hasta terminar."
argument-hint: "legacy/<servicio> [--spec specs/<servicio>]"
---

# /keel-recover-run — la recuperación de un legacy, en un solo comando

Tu rol: el **orquestador**. El trabajo lo hacen los subagentes de `{{keel:agents}}` y los comandos deterministas de
`keel-recover`; tú decides qué toca, compruebas cada puerta y hablas con el humano solo en los puntos de decisión. No
guardas dónde te quedaste: lo dice `keel-recover status`, así que este comando se puede cortar en cualquier momento y
volver a llamar igual.

## El bucle

```
repetir:
  keel-recover status <legacy> --json [--spec <dir>]   →  { phase, reason, action, project, details }
  hacer lo de esa fase (tabla de abajo)
  si la fase es un punto de parada o se agotó un presupuesto → informar y SALIR
```

Antes de la primera vuelta, si te pasaron el **repo** del legacy en vez de `legacy/<servicio>`, ejecuta
`keel-recover init <repo> --name <servicio>` (el nombre lo pregunta `AskUserQuestion` si el del directorio no sirve) y
sigue con `legacy/<servicio>`. Si `init` sale con 2, el legacy no encaja: muestra el motivo y sal.

| Fase | Qué haces | Puerta |
|---|---|---|
| `sandbox` | Lanza el subagente `keel-recover-sandbox` con la ruta `legacy/<servicio>` | `status: OK`. Con `REJECTED` o un `blocker` de tipo `question`, **para** y explícalo: es del humano |
| `observe` | `keel-recover introspect legacy/<servicio>/sandbox` y lanza `keel-recover-explorer` con `round-0` (o `round-1`) | la ronda en verde |
| `explore` | Lanza `keel-recover-explorer` con la ronda siguiente, **una a la vez**. Presupuesto: 5 rondas, o hasta que una ronda suba la cobertura acumulada menos de 2 puntos | → **punto de decisión 1** |
| `design` | Sin diseño: lanza `keel-recover-designer` con `task: design`. Con preguntas sin contestar → **punto de decisión 2**. Con respuestas sin aplicar: `keel-recover-designer` con `task: apply`. Si su reporte trae `readExpectations` o `blockers` de tipo `probe`, lanza antes de caracterizar `keel-recover-explorer` con una ronda corta de exactamente esas sondas: convierte las lecturas del código en grabaciones. Presupuesto: 3 pasadas de `design`/`repair` (cada tanda de respuestas lleva su `apply`) | `status` deja de decir `design` |
| `characterize` | Si `contract-map.yaml` tiene `data`, antes `keel-recover fixtures legacy/<servicio>` (el estado de partida, desde el snapshot; si sale en rojo, `repair` con su error). Después `keel-recover characterize legacy/<servicio>`. Un `keep` en rojo: `keel-recover-designer` con `task: repair`, el flujo y su fallo. Un `fix` en rojo: si falla una expectativa del lado `legacy` que el diseñador estimó leyendo el código (`readExpectations`), es `repair`; si no, el defecto ya no está en el legacy: pregúntalo. Nunca corriges tú los escenarios ni `contract-map.yaml` | caracterización en verde |
| `close` | **Punto de decisión 3** (cierre y stack) | — |
| `build` | `keel-<tech> build specs/<servicio>` con el stack elegido | el proyecto existe |
| `generate` | **Para**: imprime exactamente qué lanzar (abajo) | — |
| `parity` | `bash <proyecto>/deploy/up.sh`, `keel-recover target <proyecto> -o legacy/<servicio>/target-<proyecto>.yaml`, `keel-recover parity legacy/<servicio> --target …`, y al final `bash <proyecto>/deploy/down.sh` | paridad en verde |
| `done` | El resumen final (abajo) | — |

Un subagente cada vez sobre el sandbox: el explorador y characterize comparten la base y su snapshot. Si un comando dice
que no hay snapshot, `keel-recover verify legacy/<servicio>/sandbox --no-up` y repite.

## Los tres puntos de decisión

Son los únicos momentos en que preguntas. En cada uno, primero el resumen en una tabla corta y luego `AskUserQuestion`
(como mucho 4 preguntas por llamada, opciones con `label` corto y la recomendada primero con «(Recomendado)»).

1. **Cerrar la exploración** (`explore`).
   - **Muestra:** la serie de cobertura ronda a ronda, lo que queda sin cubrir y por qué (código muerto, ramas que solo
     dispara un fallo interno), y `unobserved.yaml`.
   - **Pregunta:** ¿otra ronda o cerrar?
   - **Al cerrar**, escribe `legacy/<servicio>/exploration.yaml`:

     ```yaml
     kind: exploration
     schema: 1
     stopped: { date: AAAA-MM-DD, rounds: [round-0, round-1, …], coverage: 97.7, reason: "…" }
     ```

2. **Las decisiones del diseño** (`design` con preguntas abiertas).
   - **Origen:** todas las de `legacy/<servicio>/questions.yaml` sin `answer`, en tandas: primero los `fix`, luego
     `asked`, luego `omitted`.
   - **Primero las que impone el método** (el contrato del cable, la paginación, la identidad en un proveedor OIDC, el
     409 de una unicidad, el 400 de validación: su evidencia cita la doc del método y no un defecto del legacy), juntas
     en UNA pregunta de confirmación: «el método fija estas N; ¿alguna se rechaza?».
   - **Después las globales**, las que reescriben a otras (el orden de las guardas, los estados con nombre, el estilo
     del error), diciendo qué más cierran; las locales al final. Una decisión global contestada tarde reabre hallazgos
     en todas las operaciones que toca.
   - **Cada pregunta**, tal como la escribió el diseñador: su evidencia y su recomendación.
   - **Por cada respuesta**, escribe `answer` (el `label` o el texto libre) y `date` en la misma entrada, y relanza
     `keel-recover-designer` con `task: apply`.

3. **Cerrar y generar** (`close`, o `build` si `--ready` ya está en verde).
   - **Muestra:** lo que falta de `keel validate --ready specs/<servicio>`.
   - **Pregunta** dos cosas:
     - **Cierre:** «cerrar el diseño y generar» (recomendado), «cerrar solo el diseño» (termina en `DESIGN.md` y
       `keel index`, sin stack: se retoma con este mismo comando) o «generar sin cerrar» (`--accept-unready`, queda
       estampado en el proyecto).
     - **Generador y stack:** `keel-spring`, `keel-nest` o `keel-dotnet`, y las opciones que `environment.yaml` no
       fija ya: el motor y el broker del legacy se conservan salvo que el humano diga otra cosa.
   - **Para cerrar**, lanza en paralelo los agentes de keel-core `keel-design-review`, `keel-gap-sweep` y
     `keel-flow-review` (`{{keel:agents}}/…`) con la ruta `specs/<servicio>/`. Sus hallazgos se deciden con el humano
     en una tanda más, ordenada como la del punto 2. Después, el flujo de `/keel-handoff` para `DESIGN.md`.
   - **El orden de una vuelta de cierre:** `apply` → `characterize` → (en verde) las revisiones. Un hallazgo del careo
     cerrado con `resolution: design` caduca el careo entero y el presupuesto es de 3 pasadas por versión: cierra antes
     los que se resuelven en el escenario, agrupa los de diseño en una sola `apply`, y relanza `keel-flow-review` solo
     cuando el YAML ya no vaya a cambiar. Cada vuelta de decisiones abre superficie nueva (medido en shop-api: 39, 19 y
     1 hallazgos del barrido en tres vueltas).
   - **Para generar**, escribe `services/<servicio>-<tech>/keel-stack.json` con el stack elegido y ejecuta
     `keel-<tech> build specs/<servicio>` (con `--accept-unready` si se eligió así).

## La generación: aquí paras

El pipeline del generador lanza sus propios subagentes y un subagente no puede lanzar a otros, así que no se anida. Di
exactamente:

```
La generación la lanzas tú, en una sesión nueva dentro del proyecto:
  cd services/<servicio>-<tech>
  dotnet restore          # solo keel-dotnet
  /keel-generate-<tech>
Cuando termine, vuelve aquí y lanza otra vez /keel-recover-run legacy/<servicio>.
```

Al volver, `status` dice `parity` en cuanto el pipeline dejó su `design-gaps.yaml`.

## El resumen final (`done`)

Una tabla corta con:
- los `keep`, `fix` y `frontier` contra el legacy y contra el regenerado;
- la cobertura;
- la procedencia por nivel;
- las diferencias de la paridad, declaradas y sin declarar;
- los `design-gaps.yaml` del proyecto, que son decisiones del humano para la siguiente versión del diseño.

Rutas: `legacy/<servicio>/FIDELITY.md` y `legacy/<servicio>/PARITY-<proyecto>.md`.

## Lo que no haces

- **No decides por el humano.** Ni un `fix`, ni un `asked`, ni un `omitted`, ni cuándo dejar de explorar, ni el stack.
  Recomiendas; decide él.
- **No tocas el legacy** ni editas lo que escriben las herramientas: los sellos, `verify.json`, las grabaciones o el
  `target.yaml`.
- **No sigues con una puerta en rojo.** Agotado un presupuesto, informas con la evidencia y sales: volver a llamar el
  comando retoma desde ahí.
