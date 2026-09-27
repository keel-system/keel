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
