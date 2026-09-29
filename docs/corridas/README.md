# Registro de corridas

Una corrida es una generación real —`keel-spring build` + `/keel-generate-spring` con sus cinco
subagentes, contra infraestructura real— sobre un diseño concreto. Se registra aquí **antes de tirar
el proyecto generado**: los diez huecos de la primera corrida estuvieron perdidos porque el proyecto
se borró con ellos dentro.

El registro sirve para una sola pregunta, que es la de R8 en `recomendaciones-diseno.md`: **¿un diseño
cerrado deja menos decisiones al agente?** Para contestarla, cada corrida se mide igual y se compara
con las demás:

```bash
node packages/keel-spring/scripts/corrida-metrics.js footprint <workspace>/services/<servicio>-spring
node packages/keel-spring/scripts/corrida-metrics.js series
```

## Formato

Un archivo `<AAAA-MM-DD>-<servicio>[-<variante>].md`. Empieza con una tabla de dos columnas y
**etiquetas fijas**, que es lo que lee `series`. El resto del documento es libre.

| Etiqueta | Qué va | Ejemplo |
|---|---|---|
| `Diseño` | servicio, versión, DSL, modelo, capas | `` `notification-mailer` v1.0.0 (DSL 2.15, relacional, 7 capas) `` |
| `Stack` | lo que eligió el diseñador | `mysql · rabbitmq · keycloak` |
| `Generador` | versión del paquete | `` `keel-spring@0.1.5` `` |
| `Diseño listo al generar` | `sí`, `no, con --accept-unready (<ids que faltaban>)`, o `anterior a la puerta` para las corridas anteriores al paso 10 | `sí` |
| `Matriz final` | escenarios OK sobre el total | `**42/42 OK**` |
| `Huella del agente` | la fila que imprime `footprint`, tal cual | `413 archivos registrados por build, 0 adoptados, **53 reescritos**, 0 borrados` |
| `Huecos del diseño` | cuántos y de dónde (`design-gaps.yaml`, y los que no reportó nadie) | `4 en design-gaps.yaml + 2 que no reportó nadie` |
| `Convertidos en id` | los `CHK-*`/`OBL-*`/`REV-*` que salieron de esta corrida | |

Desde el plan de validación de R8, las corridas de medición (sufijo `-r8` en el nombre del archivo) llevan además estas etiquetas. Son opcionales: una corrida anterior no las tiene y la serie la sigue leyendo igual.

| Etiqueta | Qué va | Ejemplo |
|---|---|---|
| `Papel` | `control` si la corrida mide el residuo del generador y no el diseño; sin la fila, es de medición | `control` |
| `Clasificación de la huella` | la cuenta por clase de la rúbrica de abajo | `13 TODO · 3 consulta · 7 generador · 0 diseño · 0 puerta` |
| `Huecos del generador` | cuántos, con su arreglo en `keel-spring` | `5 (ver § Arreglos)` |
| `Agujeros de la puerta` | cuántos huecos del diseño debía haber cazado `--ready` o una clase de `gap-analysis.md` | `0` |
| `Coste del diseño` | hallazgos por pasada de careo (`careo 13→6→0`, forma fija: es lo que lee `series`), del barrido y de la revisión, y decisiones aceptadas frente a cerradas | `careo 13→6→0; barrido 24; revisión 5; 9 aceptadas / 31 cerradas` |

`series` termina con el **veredicto de H1**: `robusta`, `no-robusta` o `en-curso`, con el motivo. Los criterios los fija `verdict()` en `packages/keel-spring/src/lib/corrida-metrics.js` y se escribieron antes de correr. No se ajustan después de ver un resultado.

## Clasificar un reescrito

Cada archivo que la huella da por reescrito, y cada hueco reportado, cae en **una** clase:

| Clase | Criterio | Cuenta contra |
|---|---|---|
| TODO legítimo | build dejó un stub de negocio para el agente | nada |
| Consulta de negocio | regla en prosa que el DSL no estructura y el diseño sí dice | nada, pero se anota |
| Hueco del generador | el YAML declara lo necesario y build lo hizo mal o no lo hizo | `keel-spring`: arreglo con test falsado |
| **Hueco del diseño** | el agente tuvo que decidir algo que ni el YAML ni sus docs fijan | H1: va a `## designGaps` con su clave |
| **Agujero de la puerta** | un hueco del diseño que un criterio de `--ready` o una clase de `gap-analysis.md` debía haber cazado | H1, grave: se cuenta además en `Agujeros de la puerta` |

La pregunta que separa las dos últimas de las demás: **¿el agente tuvo que elegir?** Si la respuesta está escrita en el diseño, aunque sea en prosa, no es un hueco del diseño. Y si build no la usó, el hueco es del generador.

La primera clasificación la hace un **agente de contexto limpio**, con esta rúbrica, el diseño (`specs/`) y el diff de cada reescrito contra lo que registró build, y **sin** la conversación de diseño: quien diseñó tiende a leer como resuelto lo que quiso resolver. El diseñador arbitra los desacuerdos y anota cuáles fueron.

La huella no es el informe del agente, y es lo que manda. El informe cuenta lo que el agente creyó
que eran huecos; la huella cuenta lo que tuvo que decidir, y la mayor parte de eso no lo reporta nadie
porque para él era su trabajo. Los reescritos se leen uno a uno y cada uno se clasifica: TODO legítimo,
o decisión que el diseño no tomó.

## `## designGaps`: la sección que hace comparables los huecos

Desde R8, cada corrida termina con una sección `## designGaps` con **una viñeta por hueco**, que
empieza por una clave estable entre comillas invertidas:

```markdown
## designGaps

- `callback-order` — el orden de dos respuestas del proveedor no lo fija el diseño
- `idem-key-optional` — la cabecera de idempotencia es opcional y nadie dice qué pasa sin ella
```

`series` agrupa por esa clave: **un `designGap` que aparece en dos corridas distintas es candidato
obligatorio a id**. Hasta aquí esa regla se aplicaba a mano; ahora la lista la imprime el comando. La
clave la elige quien registra la corrida. Si el hueco ya salió antes, se reutiliza la clave de
entonces, que es lo que hace posible encontrarlo. Las corridas anteriores a este formato no tienen la
sección y no se reconstruyó a posteriori: sus claves serían inventadas.
