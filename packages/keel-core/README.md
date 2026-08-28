# keel-core

**Diseña un servidor una vez. Genéralo en cualquier tecnología.**

`keel-core` es el núcleo de [Keel](https://github.com/keel-system/keel): la CLI `keel` más el **DSL Keel** que define cómo se describe un servicio sin nombrar framework, ORM, broker ni lenguaje. Siembra el workspace de diseño, crea y valida servicios, y expone su validación como librería para que cada generador (`keel-spring`, y los que vengan) la reutilice en vez de duplicarla.

El diseño de un servicio vive en `specs/<servicio>/`: un manifiesto más **un artefacto YAML por capa** — dominio, casos de uso, API, seguridad, mensajería, clientes HTTP, dependencias, persistencia, almacenamiento, correo. Cada capa se itera por separado, cabe en un diff y se relaciona con las demás por nombre. Ese diseño es la fuente de verdad: el código final no lo genera JavaScript, lo genera un agente leyendo el spec validado.

## Instalación

```bash
npm i -g keel-core     # comando `keel`
```

Requiere Node.js >= 18. Sin build step: ESM puro.

## Uso

```bash
mkdir mi-proyecto && cd mi-proyecto
keel init                        # siembra el workspace: skills, schemas, plantillas, docs

# ¿Ya existe un diseño que resuelva esto?
keel registry search catalogo    # busca en el registry de diseños reutilizables
keel registry get catalog        # lo adopta tal cual, con sus derivados al día
keel new mi-servicio --from registry:catalog   # …o lo deriva, con linaje en `basedOn`

keel new mi-servicio             # …o de cero: manifiesto + domain + use-cases
keel validate specs/mi-servicio  # schemas por capa + referencias cruzadas, offline
```

El diseño capa a capa lo conduce un agente con las skills que `keel init` siembra (`/keel-design`, `/keel-validate`, `/keel-docs`, `/keel-handoff`…), y la generación la hace el generador de la tecnología elegida:

```bash
npm i -g keel-spring
keel-spring build specs/mi-servicio    # → services/mi-servicio-spring/
cd services/mi-servicio-spring
# y en Claude Code, abierto en esa raíz: /keel-generate-spring
```

Cuando el encargo no es un servicio sino un **sistema**, hay una fase previa: `/keel-decompose` decide las fronteras con el humano y escribe el mapa `system.yaml`, y `keel system` calcula en qué orden se construyen los servicios —quien publica contrato va antes que quien lo consume— y contrasta ese mapa contra los diseños reales.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `keel init [--force] [--check]` | Siembra el workspace de diseño: skills del agente, schemas por capa, plantillas, docs y el archivo de contexto. Nunca sobrescribe sin `--force`. Con `--check` no escribe y falla si alguna copia del payload quedó atrás respecto a la CLI instalada. |
| `keel new <servicio> [--from <origen>]` | Crea `specs/<servicio>/` con manifiesto + capas obligatorias. Con `--from` deriva de un diseño existente (nombre local, ruta o `registry:<diseño>`) estampando el linaje en `service.basedOn`. |
| `keel validate <ruta>` | Valida un servicio: JSON Schema de cada capa + referencias cruzadas entre artefactos. Offline, reportando todos los errores de una vez. |
| `keel describe <servicio>` | Resume un diseño para leerlo o reutilizarlo: identidad, estado, capas, contenido y frescura de sus derivados. |
| `keel index [--check]` | Genera el índice de diseños del workspace: la tabla del `README.md` (solo entre marcadores) y `index.json`. Determinista: `--check` es la puerta de CI de un registry. |
| `keel system [show \| check]` | Lee el mapa del sistema. `show` muestra las olas de construcción —orden topológico de las aristas bloqueantes, no declarado—; `check` es la **única validación cross-servicio** del método y llega a cruzar dos specs. Ninguno escribe nada. |
| `keel registry [list \| search \| show \| get]` | Explora y materializa diseños reutilizables. Fuente configurable con `--source` o `KEEL_REGISTRY_URL`; caché en `~/.keel/registry/` con `--refresh` y `--offline`. |
| `keel list` | Lista los generadores conocidos y su paquete npm. |

## Validación en tres niveles

`keel validate` cubre los dos primeros; el tercero lo hace el agente.

1. **Schema por capa** — JSON Schema 2020 (Ajv) contra `schema/<capa>.schema.json`.
2. **Referencias cruzadas** — que los nombres casen entre capas: tipos, entidades, agregados, transiciones, payloads, `endpoints`→operaciones, roles.
3. **Revisión semántica** — calidad del diseño, invariantes y mínimo privilegio, a cargo de la skill `/keel-validate`. No está en código a propósito.

Lo que no es una incoherencia sino **una decisión que el diseño no ha tomado** no sale como aviso sino como **obligación** con id estable, que se cierra en el YAML o se acepta por escrito en `decisions.yaml` — y mientras siga abierta, `keel validate` está en rojo.

## Como librería

Los generadores consumen la API pública en vez de reimplementar la validación:

```js
import { validateService, summarizeService, supportedDsl } from 'keel-core';

const result = validateService('specs/mi-servicio');
if (!result.ok) {
  console.error(result.loadErrors, result.schemaErrors, result.crossRefErrors);
  console.error(result.obligations.open);   // decisiones que el diseño no ha tomado
}
```

`validateService(dir, { wip })` no toca consola ni `exitCode`: devuelve el resultado completo (`ok`, `loadErrors`, `schemaErrors`, `crossRefErrors`, `warnings`, `pending`, `obligations`) para que cada generador lo presente a su manera. El resto de la API pública —`loadService`, `resolveServiceRef`, `summarizeService`, `listDerivatives`, `buildIndex`, `buildSystemPlan`, `copyTree`, `emitHarnessFiles`, `supportedDsl`— está en `src/index.js`.

## Compatibilidad

| Paquete | DSL Keel |
|---------|----------|
| keel-core 0.3.x | `keel: "2.13"` |

Se soporta **una sola versión** del DSL. Los schemas no gatean primitivos por versión, así que aceptar las anteriores haría que el campo `keel` de un manifiesto declarase una intención que nada comprueba. El razonamiento completo está en `docs/dsl-reference.md § Historial de versiones` del workspace sembrado.

## Documentación

Toda la documentación viaja dentro del paquete y `keel init` la copia a `docs/` del workspace:

- [`methodology.md`](https://github.com/keel-system/keel/blob/main/packages/keel-core/assets/core/docs/methodology.md) — la metodología completa.
- [`dsl-reference.md`](https://github.com/keel-system/keel/blob/main/packages/keel-core/assets/core/docs/dsl-reference.md) + `dsl/<capa>.md` — la referencia del DSL, capa a capa.
- [`design-registry.md`](https://github.com/keel-system/keel/blob/main/packages/keel-core/assets/core/docs/design-registry.md) — publicar y consumir diseños reutilizables.
- [`system-decomposition.md`](https://github.com/keel-system/keel/blob/main/packages/keel-core/assets/core/docs/system-decomposition.md) — descomponer un encargo en servicios.
- [`building-a-generator.md`](https://github.com/keel-system/keel/blob/main/packages/keel-core/assets/core/docs/building-a-generator.md) — crear un generador para otra tecnología.

## Licencia

MIT
