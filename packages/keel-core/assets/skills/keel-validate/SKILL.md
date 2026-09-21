---
name: keel-validate
description: Valida un servicio Keel multi-artefacto (schemas por capa + referencias cruzadas vía CLI) y ejecuta la revisión semántica de calidad del diseño. Usar antes de generar código o docs.
argument-hint: "<specs/servicio>"
---

# /keel-validate — validación estructural, cruzada y semántica

Valida el servicio indicado (directorio `specs/<servicio>/`) en cuatro niveles. No modifiques los artefactos sin confirmar cada corrección con el usuario, salvo errores triviales de formato.

## Niveles 1 y 2 — Schema por capa + referencias cruzadas (CLI)

```bash
keel validate specs/<servicio>
```

La CLI valida el manifiesto y cada capa contra su schema (`schema/<capa>.schema.json`), la coherencia `layers` ↔ archivos, y las referencias cruzadas mecánicas (tipos, entidades, operaciones, eventos, roles y permisos referenciados existen; agregados bien formados: raíz y miembros existentes, sin entidades en dos agregados, `per-aggregate` solo con agregados declarados; operaciones huérfanas como warning). Además detecta **diseño incompleto**: capas que siguen siendo la plantilla (sin operaciones, entidades, eventos o clientes) y `service.description` placeholder (empieza por `TODO` o es el texto de la plantilla).

Durante una sesión de diseño usa `keel validate --wip specs/<servicio>`: los pendientes de diseño incompleto (los `emits`/`cache.invalidatedBy` hacia una capa messaging aún no diseñada, y los campos `file` cuyo bucket aún no existe en una capa storage aún no diseñada) se reportan como avisos y el veredicto es "Diseño en progreso". El veredicto ✅ **Válido** solo existe sin `--wip`; nunca se genera ni documenta desde un "Diseño en progreso".

Si falla, traduce cada error a lenguaje del DSL (ej. "`use-cases: createProduct.emits`: el evento 'ProductCreated' no está en messaging" → "la operación emite un evento que aún no definiste en la capa messaging") y propón la corrección.

Fallback si el comando `keel` no está disponible: valida cada `<capa>.keel.yaml` con ajv-cli (`--spec=draft2020 -r schema/common.schema.json -s schema/<capa>.schema.json`) y haz las cross-refs leyendo los artefactos.

## Nivel 3 — Semántica (lo que ni el schema ni las cross-refs pueden expresar)

Lee los artefactos y verifica esta checklist. Reporta cada hallazgo con severidad **error** (bloquea generación) o **aviso** (mejorable):

> **Lo que esta checklist NO hace es ejecutar los flujos.** Si `keel validate` avisa con `CHK-SCEN-FLOW-REVIEW-STALE` (falta el careo, se hizo sobre otros escenarios o tiene hallazgos sin decidir), lanza el subagente `keel-flow-review` (`{{keel:agents}}/keel-flow-review.md`) sobre `specs/<servicio>/` antes de dar el diseño por validado, y repasa sus hallazgos con el usuario. Lo que el careo busca —un `Then` que no se deduce del YAML cuando se lleva el estado paso a paso— no lo ve una lectura estática, y es lo que en las corridas encontraba el agente de pruebas ya en la generación.

**Consistencia del modelo (error):**

Seis de las siete comprobaciones que aquí había las hace ya `keel validate` en el nivel 2, y por eso no las repite esta lista: la identidad única por entidad, el `generated`/`computed` en el input, el `default` de enum fuera de sus `values`, la `query` con `emits`, la `cache` fuera de una query y la variable de ruta ausente del input. Salieron de aquí al mecanizarse; si vuelven a aparecer en esta lista, el agente estará juzgando dos veces lo mismo y la prosa acabará diciendo algo distinto del código. Lo que queda es lo que ningún YAML contesta:

- Ningún campo `sensitive: true` aparece en un output `{ fields }` o payload de evento sin justificación explícita del diseño.
- Ninguna invariante de una entidad depende de campos de entidades de **otro** agregado (la consistencia entre agregados es eventual, vía eventos). Las `invariants` son texto libre: contrástalas contra el índice de agregados a mano.

**Calidad por capa — recorrido por id.**

La CLI lista los ids de revisión que le tocan a ESTE diseño (`REV-*`, derivados de las capas que declara) y cuántos tienen ya veredicto. Recórrelos **en el orden en que los lista**, uno a uno:

1. Lee la pregunta del id y, si necesitas el porqué, su sección en `references/review-checklist.md` — solo la de la capa que estés mirando.
2. Contesta con evidencia del diseño: nombra la entidad, la operación o el campo.
3. Escribe el veredicto en `specs/<servicio>/review.yaml` (`ok` / `fixed` / `accepted` / `open`), con nota salvo en `ok`.

Vuelve a ejecutar `keel validate` al terminar: la cobertura tiene que quedar completa, y un veredicto `open` deja el diseño sin generar, que es lo correcto.

**No repitas lo que la CLI ya contestó.** Sus hallazgos vienen con id `CHK-*`: se leen y se incorporan al informe, no se vuelven a juzgar.

**Escenarios de validación (`validation-scenarios.md`):**
- Existe `specs/<servicio>/validation-scenarios.md` (formato: `docs/validation-scenarios.md`); si falta, **error**: el diseño no está cerrado y el generador no puede validar el servidor.
- Su matriz de cobertura incluye toda operación de use-cases, y cada `error` declarado aparece en algún flujo o caso borde con su `code` exacto (huecos: **error**).
- Rutas, payloads, estados y eventos de los escenarios coinciden con los artefactos; si el spec cambió después del archivo (discrepancias o versión distinta en su cabecera), márcalo como desactualizado (**error**) y propón regenerarlo con `/keel-design`.
- El archivo es el **contrato de equivalencia** entre implementaciones: lo que no fija, cada generador lo decide por su cuenta. Comprueba contra `docs/validation-scenarios.md § Determinación observable` (el criterio vive allí, no lo dupliques aquí) y marca como **error** los tres fallos que lo vacían de contenido: `Then` que solo verifica el status en vez del cuerpo completo de la respuesta; error cubierto sin su status HTTP; flujo cuyo `Given` depende de la ejecución de otro flujo (tras el reset previo a cada flujo, ese estado no existe). Como **aviso**: colección devuelta sin orden declarado, estado del `lifecycle` que ningún flujo alcanza, y `cache.invalidatedBy` con vías no ejercitadas.
- **Las enumeraciones de campos coinciden entre sí y con el artefacto** (**error**). Deriva la proyección de cada `output` —campos de la entidad, menos `exclude`, más los objetos de `embed`, más los campos con `default`— y contrástala contra **cada** `Then` que enumere esa entidad. Dos escenarios del mismo documento que discrepan sobre si un campo viaja obligan a quien genere a elegir a cuál obedecer, y esa elección no es suya. El caso más frecuente: un campo con `default` que no aparece en la petición, se olvida en la respuesta de creación y se da por supuesto en el flujo de transición de estado.
- **Toda caché tiene un escenario de retención** (**aviso fuerte**): una lectura que, dentro del TTL y tras una mutación que **no** está en `invalidatedBy`, sigue devolviendo el valor viejo. Sin él, una implementación que no cachea absolutamente nada pasa todos los escenarios de invalidación.
- **Ningún escenario exige lo que el diseño no puede cumplir** (**error**). El caso concreto: un `Then` que espera ver un cambio reflejado de inmediato en un objeto `embed` cuya entidad no aporta ningún evento a `invalidatedBy`. No es un fallo del futuro servidor: es una contradicción entre dos artefactos del mismo diseño, y se resuelve en el YAML o en el escenario, nunca en el código.
- **`security.cors` sin sus dos escenarios** (**aviso**): con la política declarada, el archivo debe traer un escenario de **preflight** (`OPTIONS` sin credencial, con el método y las cabeceras que la política admite) **y** uno de petición normal cross-origin que afirme las cabeceras de `exposedHeaders`. Con solo el primero, el servidor contesta al preflight y el navegador sigue sin poder leer la respuesta: son dos fallos distintos, no dos redacciones del mismo.
- **`onUnavailable` sin escenario del proveedor caído** (**aviso fuerte**): no lo cubre el de `onMiss`, que habla de la copia vacía y no de la indisponibilidad. Con `lastKnown` son dos, y el que falta casi siempre es el del **arranque en frío** —nunca hubo lectura previa, así que la operación falla con el `error` declarado—: sin él, un almacén que no llega a guardar nada pasa el escenario del rescate y la política degrada en silencio a «fallar siempre».

## Nivel 4 — Factibilidad con el generador que se vaya a usar

`keel validate` es agnóstico por diseño: dice si el diseño es coherente consigo mismo, no si **un** generador concreto puede con él. Esa segunda pregunta la contesta el generador, y conviene hacerla **antes** de cerrar:

```bash
keel-<tech> check specs/<servicio>        # los generadores conocidos: keel list
```

No escribe nada. Devuelve tres cosas que hasta ahora solo aparecían al generar: qué del diseño ese generador **no materializa** (y qué hace en su lugar), qué avisos trae la traducción a código —típicamente porque el diseño no decide algo que el generador necesita— y si el proyecto se puede construir entero. Incorpora sus bloqueos a tu veredicto; sus avisos van al informe, porque cada uno dice qué se genera en lugar de lo que el diseño pidió.

Si el diseñador aún no ha elegido tecnología, este nivel se salta y se dice en la salida: el diseño sigue siendo válido, pero nadie ha comprobado que sea generable.

## Salida

Termina con un veredicto claro:
- ✅ **Válido** — listo para `keel-<tech> build specs/<servicio>` (que genera el proyecto; el código se completa después con `/keel-generate-<tech>` dentro de él) y para `/keel-docs`.
- ❌ **Inválido** — lista numerada de errores (y avisos aparte), cada uno con el artefacto afectado y su corrección propuesta. Ofrece aplicarlas.
