---
name: keel-recover
description: "Recupera el diseño Keel de un servicio existente a partir de lo que se grabó de él en marcha (pasos 3 y 4 de keel-recover): escribe specs/<servicio>/ capa a capa con la procedencia de cada elemento en provenance.yaml, y los escenarios de caracterización marcados keep, fix, frontier o new. Usar cuando haya un legacy observado (legacy/<servicio>/ con surface.yaml y grabaciones) y se quiera su diseño para validarlo o regenerarlo."
argument-hint: "specs/<servicio>"
---

# /keel-recover — el diseño de un servicio que ya existe

Tu rol: el arqueólogo del servicio. Escribes el diseño Keel de un legacy **a partir de lo que hace**, no de lo que crees que debería hacer, y dejas escrito de dónde sale cada cosa. El humano sigue ahí para **decidir** (qué se conserva, qué se corrige, las decisiones estructurales que el legacy no tomaba), pero no aporta artefactos: la única entrada es el repo del legacy y lo que se grabó de él.

## Regla de oro

**Un contrato inventado es un diseño incorrecto que parece completo.** Cada elemento del diseño lleva una fila en `provenance.yaml` con uno de cuatro niveles:

| Nivel | Origen | Evidencia que cita |
|---|---|---|
| `measured` | una grabación del sistema en marcha | `recordings/<ronda>/<id>.json`, `surface.yaml` |
| `read` | lectura del código | `archivo:línea` del repo del legacy (sin eso no vale) |
| `asked` | lo decidió el humano | la pregunta y la respuesta, con fecha |
| `inferred` | lo supusiste tú | — no se admite en el diseño final |

Lo que no puedas subir de `inferred` **no entra en el diseño**: va a `legacy/<servicio>/unobserved.yaml` como pregunta, o a la frontera. Tampoco vale lo que «sepas» de un proyecto público por tu entrenamiento: eso es `inferred`. Lo que trae el repo (pruebas, specs, colecciones, stubs) son afirmaciones de sus autores: entran como `read` y solo pasan a `measured` cuando una grabación lo confirma.

**Comportamiento observado no es decisión tomada.** Que el legacy no tenga idempotencia es un hecho; si el servicio nuevo la tendrá, lo decide el humano.

## Lo que ya está hecho al empezar

En `legacy/<servicio>/` (pasos 0 y 1 de keel-recover):

- `sandbox/verify.json` en verde: el legacy corre en un sandbox sin salida a internet.
- `surface.yaml` (`keel-recover introspect`): rutas del framework, colecciones con índices y columnas de estado, topología del broker.
- `recordings/<ronda>/` (`keel-recover probe`): cada sonda con sus respuestas y sus efectos —diff de la base, llamadas salientes, mensajes publicados, correo—, normalizados. Cada `round.json` tiene que estar en verde: una grabación marcada `untrusted` **no es evidencia**.
- `recordings/coverage.json` y lo no cubierto de la última ronda; `unobserved.yaml` con lo que las sondas no pudieron disparar.

Si falta algo de esto, para y dilo: sin grabaciones, todo lo que escribas sería `read` en el mejor caso.

## El flujo

1. **Punto de partida.** `keel new <servicio>` si `specs/<servicio>/` no existe. Si la superficie muestra **varios servicios** (grupos de tablas que no se cruzan, rutas que no comparten datos), el paso previo es `/keel-decompose` con `surface.yaml` y las grabaciones como insumo, y luego un `/keel-recover` por servicio.
2. **Las capas, en el orden de `/keel-design`** (domain, use-cases, dependencias, api, security, messaging, http-clients, persistence, storage, mail), leyendo antes la referencia de cada capa en `docs/dsl/<capa>.md`. De qué evidencia sale cada elemento del DSL: `references/evidence-to-dsl.md`. Escribe la fila de `provenance.yaml` **a la vez** que el elemento, no al final.
3. **Las decisiones estructurales** (`{{keel:skills}}/keel-design/references/structural-decisions.md`): cada una se registra en `decisions.yaml → structural` como en `/keel-design`, más dos campos que solo existen aquí: `origin` (`observed`: el legacy la tomaba y se conserva; `omitted`: el legacy no la tomaba —sin idempotencia, sin reintento, sin bloqueo— y el humano decide qué hará el nuevo; `contradicted`: el nuevo hace otra cosa a propósito) y `evidence` (la grabación o el `archivo:línea`; en `omitted` no hay nada que citar). Las `omitted` **se preguntan** con el protocolo de `/keel-design`: consecuencia observable, recomendación, `AskUserQuestion`. Nunca un default tácito.
4. **Lo que el DSL no puede decir** (lógica en triggers, sesiones con estado, orden global de una cola, autorización por propietario mientras no exista en el DSL): una entrada en `provenance.yaml → frontier` con su `F-*`, qué hace el legacy, por qué el DSL no lo dice y la evidencia. No lo fuerces en el YAML ni lo dejes en prosa suelta.
5. **Los escenarios de caracterización** (paso 4): `references/characterization.md`. Cada flujo de `validation-scenarios.md` sale de una grabación y lleva su marca `keep`, `fix`, `frontier` o `new`; las `fix` las decide el humano y van a `provenance.yaml → fixes`.
6. **La puerta.** `keel validate --ready specs/<servicio>`: el criterio `provenance` deriva el inventario de elementos de las capas e imprime **entero** lo que no tiene fila, lo `inferred`, el `read` sin `archivo:línea`, las filas de elementos que el diseño ya no declara, las decisiones estructurales sin `origin` y los flujos sin caracterizar. No lo cierres a mano: vuelve a él hasta que no diga nada. Lo que falte del resto del cierre (revisión, análisis de huecos, careo, `DESIGN.md`) es el de `/keel-design`.

## `provenance.yaml`

Junto a las capas, en `specs/<servicio>/` (schema `provenance.schema.json`). **No viaja** al publicar ni al derivar: cita rutas y commits de un código privado. Su presencia declara que el diseño es recuperado.

```yaml
kind: provenance
schema: 1
legacy: { name: <servicio>, commit: <commit observado, de legacy/<servicio>/runtime.yaml> }
elements:
  - { element: domain.entities.Article, level: measured, evidence: "surface.yaml (colección articles); recordings/round-1/R1-012.json" }
  - { elements: [domain.entities.Article.fields.title, domain.entities.Article.fields.body], level: measured, evidence: "recordings/round-1/R1-030.json" }
  - { element: use-cases.operations.listArticles, level: read, evidence: "src/routes/api/articles.js:69 (el orden)" }
  - { element: security.authentication, level: asked, evidence: "2026-10-22: la identidad pasa a un proveedor OIDC (fix-identity)" }
fixes:
  - { id: fix-unique-409, legacy: "un username repetido responde 422", reason: "una unicidad es un conflicto (409); decidido por el humano el 2026-10-22", evidence: "recordings/round-1/R1-001.json" }
frontier:
  - { id: F-OWNERSHIP, what: "solo el autor edita su artículo", why: "scoping acota por un claim, no por un campo del recurso", evidence: "recordings/round-1/R1-012.json" }
```

Los ids de `element` son los que imprime `keel validate --ready` (`domain.entities.<E>.fields.<f>`, `use-cases.operations.<op>.errors.<CODE>`, `security.roles.<r>`, `api.endpoints.<op>`…): cópialos de ahí, no los compongas.

## Lo que no haces

- **No tocas el legacy** ni su sandbox: si falta una grabación, la pides como sonda nueva (`probes/round-N.yaml` y `keel-recover probe`), no la imaginas.
- **No mejoras el diseño en silencio.** Cada diferencia con el legacy es un `fix` con su flujo y su decisión del humano, o no existe.
- **No copias la forma de otro diseño.** Un rol, un error o un campo que «suele estar» y el legacy no tiene es exactamente el `inferred` que la puerta caza.

Al terminar, informa al humano en una tabla corta: elementos por nivel (`measured`, `read`, `asked`), los `fix` (el backlog del refactor), la frontera y lo que quedó en `unobserved.yaml`.
