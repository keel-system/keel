# Workspace Keel

Este directorio es un **workspace Keel**, sembrado con `keel init`: aquí se diseñan servidores como artefactos agnósticos de tecnología (un directorio `specs/<servicio>/` con un artefacto YAML por capa) y se generan implementaciones concretas a partir de ellos.

## El flujo

```
(si el encargo es un sistema)  /keel-decompose → system.yaml + SYSTEM.md + briefs/<servicio>.md
                                                  │  keel system → el orden de construcción
                                                  ▼   y por cada servicio, en ese orden:
keel registry → keel new → /keel-design (+ /keel-consume si depende de otros servidores;
                                         cierra con DESIGN.md + README)
        → /keel-validate → keel-<tech> build → cd services/<servicio>-<tech> → /keel-generate-<tech>
        → /keel-docs + /keel-integrate

y después, cada vez que el diseño cambie:  /keel-evolve
```

0. **Descomponer, si el encargo es un sistema** — `/keel-decompose [ruta al TDR]`. Todo lo que sigue tiene grano de **un servicio**: `/keel-design` parte de uno ya nombrado. Cuando el encargo es un sistema completo, esta skill entrevista el documento de requisitos, decide con el humano dónde está la frontera de cada servicio (una frontera es una decisión estructural: se recomienda y la decide él), y escribe `system.yaml` (el mapa), `docs/system/SYSTEM.md` (la decisión y su porqué) y un `docs/system/briefs/<servicio>.md` por servicio — el **encargo** con el que se arranca cada diseño. `keel system` da las olas de construcción y el mapa de contextos; `keel system check` contrasta el mapa con los diseños reales y es la **única comprobación cross-servicio** (`keel validate` no ve más allá de un servicio). Un encargo con una sola fuente de verdad no necesita este paso. Referencia: `docs/system-decomposition.md`.
1. **Buscar antes de diseñar** — un diseño desde cero cuesta una sesión de entrevista; uno derivado, una revisión. Antes de arrancar, mira si el problema ya está resuelto: `keel registry search <dominio>` busca en el registry público de diseños reutilizables (por slug, familia, tags, dominio o descripción) y `keel registry show <diseño>` da su ficha completa con enlaces a su documentación para evaluarlo sin descargarlo. Si encaja, se deriva en el paso 2 con `--from registry:<diseño>`. Referencia: `docs/design-registry.md`.
2. **Crear** — `keel new <servicio>`: crea `specs/<servicio>/` con manifiesto (`service.keel.yaml`) + capas obligatorias (`domain`, `use-cases`). Para reutilizar un diseño existente ajustándolo: `keel new <nuevo> --from <origen>` clona sus artefactos y registra el linaje en `service.basedOn`; `/keel-design` lo detecta y entrevista solo sobre lo que cambia. El origen puede ser un diseño **de este workspace** (`billing`, `specs/billing`), una **ruta** a cualquier otro, o uno **del registry** (`registry:catalog`), que se descarga al derivar. Para decidir de qué diseño derivar: `keel describe <servicio>` resume identidad, estado, capas y contenido; `docs/<servicio>/DESIGN.md` explica las decisiones y su porqué.
3. **Diseñar** — `/keel-design specs/<servicio>`: entrevista al humano y construye el diseño **capa a capa** (domain → use-cases → dependencies → api → security → messaging → http-clients → persistence → storage), aprobando cada artefacto antes del siguiente. Si el servicio **depende de otros servidores** (necesita un dato que no es suyo), el bloque de integración ejecuta `/keel-consume` a partir del `INTEGRATION.md` del proveedor: entrevista la estrategia de cada dato (pedirlo al decidir vs. mantener una copia local) y escribe de una pasada las capas `dependencies`, `http-clients` y `messaging` coherentes entre sí. La invocación es automática dentro de `/keel-design`; se ejecuta a mano solo si la dependencia aparece con el diseño ya cerrado, o cuando el proveedor publica una versión nueva de su contrato. Las capas opcionales se declaran en el manifiesto solo si aplican. Referencia: `docs/dsl-reference.md` (índice) y `docs/dsl/<capa>.md`. El cierre ejecuta primero un **análisis de huecos** (lo que el diseño no dice y algún generador tendría que inventar) y produce después `specs/<servicio>/validation-scenarios.md` (escenarios Given/When/Then; formato en `docs/validation-scenarios.md`), el **contrato de equivalencia** con el que se validará todo servidor generado de este diseño, sea cual sea su stack; y, como paso final automático, ejecuta `/keel-handoff` para derivar `docs/<servicio>/DESIGN.md` (características + decisiones de diseño con su porqué) y actualizar el índice de servicios del `README.md`.
4. **Validar** — `/keel-validate` (usa `keel validate specs/<servicio>` para schemas por capa + referencias cruzadas, y añade la checklist semántica).
5. **Generar** — siempre **dos pasos**, y en este orden:
   1. `keel-<tech> build specs/<servicio>` **desde este workspace**. Cada generador es un paquete npm con CLI propia: se instala con `npm i -g keel-<tech>` (ej. `keel-spring`; ver conocidos: `keel list`). El comando valida el diseño, **pregunta el stack** al diseñador (BD, broker, auth… — decisión manual, persistida en `keel-stack.json`) y genera en `services/<servicio>-<tech>/` el scaffolding transversal al stack más todo el conocimiento que el agente necesita (`.claude/` con skill propia, agentes, conventions y las guías por tecnología del stack elegido) y un snapshot del diseño en `specs/`. El proyecto queda como **repo autosuficiente**.
   2. `cd services/<servicio>-<tech>` y, **dentro de ese proyecto**, `/keel-generate-<tech>` (sin argumentos). Ahí el agente completa el código dependiente de la infra elegida y la lógica de negocio, y valida los escenarios contra el servidor real.

   No hay ninguna skill de generación en este workspace: el generador vive solo dentro del proyecto que produce. Si el diseño cambia, se re-ejecuta el paso 1 (solo añade archivos nuevos; con `--force` sobrescribe lo generado) y se vuelve a entrar al proyecto.
6. **Documentar** — `/keel-docs specs/<servicio>` deriva los **contratos formales** y el panel de revisión: `openapi.yaml` (HTTP), `asyncapi.yaml` (eventos, si hay capa `messaging`), colecciones Postman en `postman/` y `overview.html`, el panel visual del servicio (capacidades, casos de uso como acordeones por audiencia, eventos, clientes HTTP) con visores para renderizar ambos contratos (`openapi.html`, `asyncapi.html`). `/keel-integrate specs/<servicio>` deriva `INTEGRATION.md`, el **contrato servidor-a-servidor en prosa** (cómo obtener el token M2M, qué reintentar, qué publicar) para que otro servidor lo consuma. (El documento de diseño `DESIGN.md` ya se produjo al cerrar el diseño; `/keel-handoff specs/<servicio>` lo **regenera** cuando el spec cambia.)
7. **Evolucionar** — `/keel-evolve specs/<servicio>`: la puerta única para cambiar un diseño **ya cerrado**. Traduce el cambio a capas afectadas, itera solo esas con `/keel-design`, versiona el contrato (patch/minor/major) y **regenera en cascada todos los derivados** que el cambio deja atrás: `validation-scenarios.md`, `DESIGN.md`, los contratos formales y el panel de `/keel-docs`, e `INTEGRATION.md`. Cada derivado lleva estampado el `service.version` del que nació, y `keel describe <servicio>` los inventaría comparando ese sello con el manifiesto: es lo que hace mecánicamente visible que uno quedó atrás.

## Estructura

```
CLAUDE.md            # este archivo
README.md            # índice de servicios diseñados (enlaza el DESIGN.md de cada uno); página de entrada del repo
system.yaml          # el mapa del sistema, si el workspace tiene más de un servicio (de /keel-decompose)
                     # NO es una capa del DSL: describe cómo se reparte el encargo, no lo que hace un servicio
.gitignore           # excluye services/ del repo del workspace (aquí solo se versiona el diseño)
.claude/skills/      # las skills del flujo de diseño (las de los generadores viven en cada services/<x>/)
schema/              # un JSON Schema por capa + common.schema.json ($defs compartidos)
specs/<servicio>/    # el diseño de cada servicio, un artefacto por capa — la fuente de verdad
                     # (+ validation-scenarios.md: escenarios de validación derivados, al cerrar el diseño)
templates/service/   # plantillas por capa para arrancar artefactos nuevos
contracts/<proveedor>/  # INTEGRATION.md de servidores EXTERNOS de los que dependemos (entrada de /keel-consume)
                     # contracts/ es lo que consumimos; docs/<servicio>/ es lo que producimos
docs/                # methodology, dsl-reference (índice), dsl/<capa>.md, building-a-generator,
                     # design-registry (publicar y consumir diseños reutilizables),
                     # system-decomposition (descomponer un encargo en servicios)
                     # (+ <servicio>/: openapi.yaml, asyncapi.yaml, postman/, overview.html y visores de /keel-docs;
                     #    INTEGRATION.md de /keel-integrate, DESIGN.md de /keel-handoff)
docs/system/         # el encargo y su descomposición (de /keel-decompose): tdr.md, SYSTEM.md
                     # y briefs/<servicio>.md — un encargo por servicio, entrada de /keel-design
services/            # servicios generados por `keel-<tech> build` (un repo git propio cada uno,
                     # autosuficiente: trae su .claude/ con la skill del generador y el snapshot del diseño)
```

## Reglas para el agente

- **El diseño es la fuente de verdad.** Todo cambio funcional se hace en `specs/<servicio>/` y se regenera; nunca directamente en `services/`.
- **Un diseño cerrado se cambia con `/keel-evolve`.** Cambiar el spec sin propagar deja derivados que mienten. Los derivados (`validation-scenarios.md`, `DESIGN.md`, `openapi.yaml`, `asyncapi.yaml`, Postman, `overview.html`, `INTEGRATION.md`) **jamás se editan a mano**: se regeneran con su skill.
- **Cero tecnología en los specs.** Framework, BD, broker o proveedor de auth se deciden al generar, jamás al diseñar. El DSL nunca se modifica para acomodar a un generador: se ajusta el generador, nunca el DSL (regla inviolable en `docs/dsl-reference.md § Evolución del DSL`).
- **Identificadores en inglés, prosa en español.** Todo nombre del DSL (types, entidades, campos, operaciones, eventos, errores, roles, canales, buckets) y todo lo que los generadores derivan de ellos (directorios, archivos, clases, tablas) va en inglés; las `description`, la documentación y la conversación con el usuario, en español.
- **Una capa por vez.** Al diseñar o iterar, trabaja el artefacto de la capa activa y cierra sus referencias cruzadas antes de seguir.
- **Una capa opcional existe ⇔ está declarada en `layers`** del manifiesto. No crees artefactos de capas que el servicio no necesita.
- **Nunca generes desde un diseño inválido** ni con un generador cuya compatibilidad de versión DSL no cubra el manifiesto.
- **El índice del `README.md` lo genera `keel index`**, nunca se edita a mano la región entre los marcadores `<!-- keel:servicios:start/end -->`. Lo ejecutan `/keel-design` al cerrar y `/keel-handoff`.
- **El mapa no sustituye al diseño, y no se ignora.** `system.yaml` dice qué servicios hay y quién consume a quién; lo que cada uno hace vive solo en `specs/<servicio>/`. Cuando `keel system check` reporte que el mapa y un diseño no coinciden, **se corrige uno de los dos** — un mapa que quedó atrás miente igual que un `DESIGN.md` que quedó atrás. Las olas de construcción las calcula `keel system`: no se escriben a mano ni se declaran en el mapa.
- La metodología completa está en `docs/methodology.md`; descomponer un encargo en servicios, en `docs/system-decomposition.md`; publicar y consumir diseños reutilizables, en `docs/design-registry.md`.
