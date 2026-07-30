# Cómo construir un generador

Un generador convierte specs Keel en servicios de una tecnología concreta repartiendo el trabajo en dos mitades:

1. **Scaffolding transversal al stack** (comando `build`): tras el cuestionario de stack (BD, broker, auth… — solo lo que el diseño necesita; persistido en `keel-stack.json`), genera de forma determinista todo lo necesario para **levantar el proyecto**: dependencias en función del stack elegido, configuración por perfiles, infraestructura de prueba, y toda la estructura cuyo código es idéntico sea cual sea la opción de infra puntual (dominio puro, puertos, contratos, controllers, mediator, manejo de errores, stubs).
2. **Conocimiento para el agente**: una skill orquestadora, convenciones y **skills por tecnología** (`skills/keel-<tech>-<infra>/SKILL.md`, instaladas condicionalmente en el proyecto generado según el stack elegido) con las que el agente escribe el código cuya implementación depende de la infra elegida (adaptadores del broker/storage…), la lógica de negocio y los tests.

Cada generador es un **paquete npm independiente con CLI propia** (`keel-<tech>`, ej. `keel-spring`): se instala con `npm i -g keel-<tech>` y su comando `build` genera el proyecto. Los generadores conocidos se ven con `keel list`. Referencia viva: el paquete `keel-spring`.

## El flujo de generación: dos pasos, con cambio de directorio en medio

Todos los generadores exponen **el mismo** flujo de dos pasos, y es normativo:

```bash
# 1) desde el workspace de diseño, con el diseño cerrado y en verde:
keel-<tech> build specs/<servicio>     # cuestionario de stack → services/<servicio>-<tech>/

# 2) dentro del proyecto generado:
cd services/<servicio>-<tech>
/keel-generate-<tech>                  # sin argumentos
```

El paso 1 existe porque **el stack lo elige el diseñador a mano** (BD, broker, auth, caché, storage — solo lo que el diseño necesita): es una decisión humana que no se deriva del spec, y queda persistida en `keel-stack.json` del proyecto. El paso 2 se ejecuta **con el cwd en la raíz del proyecto**, no en el workspace: el proyecto es autosuficiente y la skill no toma argumentos.

**El workspace de diseño no recibe nada del generador.** No hay skill de generación, ni agentes, ni conventions, ni `generators/<tech>/` en él: el workspace es solo diseño. Todo el conocimiento de generación se instala en el `.claude/` del proyecto que el generador produce, leyéndolo directamente de los `assets/` del paquete npm. Un generador nuevo **no debe** sembrar nada en el workspace: duplicaría el conocimiento y abriría un segundo camino de generación (el problema exacto que este flujo normaliza).

## Qué genera `keel-<tech> build`

`build` se ejecuta desde el workspace (verifica que lo es), comprueba la compatibilidad de versión DSL del manifiesto, aplica su chequeo de frontera (ver `supported-features.js` más abajo), ejecuta la validación mecánica (`keel validate`, sin `--wip`) — si el diseño no es generable, lo reporta y se detiene —, pregunta el stack y escribe **todo** en `services/<servicio>-<tech>/`:

```
services/<servicio>-<tech>/
├── <el proyecto>        # scaffolding transversal al stack: deps, config, infra de prueba, estructura
├── keel-stack.json      # el stack elegido por el diseñador (se reutiliza sin repreguntar)
├── specs/               # snapshot del diseño (build lo REFRESCA siempre; el canónico es el del workspace)
├── docs/                # snapshot de los contratos formales de /keel-docs (si ya se generaron)
└── .claude/
    ├── CLAUDE.md        # contextual y especializado por servicio: orden de capas declaradas, stack, verificación
    ├── architecture.md  # arquitectura del proyecto generado y función de cada paquete
    ├── constitution.md  # reglas inviolables: qué rompería la arquitectura o serían malas prácticas
    ├── orchestration.md # el pipeline: fases, gating, handoffs (si el completado se orquesta con subagentes)
    ├── conventions/     # copia local de las conventions (mapping, project-layout…)
    ├── agents/          # los subagentes del completado
    └── skills/
        ├── keel-generate-<tech>/   # la ÚNICA skill de generación; se invoca sin argumentos
        └── keel-<tech>-<infra>/    # solo las del stack elegido (condicional según keel-stack.json)
```

Con eso el proyecto es un **repo autosuficiente**: quien lo clone, sin el workspace Keel, puede finalizar la generación. La skill del proyecto conviene **sintetizarla** (parametrizada por servicio, stack y capas presentes) en vez de copiar un asset estático: así solo existe una definición del pipeline y no puede divergir.

Si el generador orquesta el completado con subagentes (patrón de `keel-spring`: agente de código en paralelo con agente de infraestructura, agente de validación funcional después y un pase de calidad no-conductual al final), sus definiciones viven en `assets/.claude/agents/` y se instalan en `.claude/agents/` del proyecto. Patrón recomendado de **handoff estructurado**: cada subagente cierra su reporte con un bloque parseable (`status`, `blockers[]`, `failures[]`…) y la skill orquestadora decide avances y relanzamientos sobre esos campos, nunca sobre prosa.

**Regeneración segura**: re-ejecutar `build` solo añade archivos nuevos y nunca pisa lo que el agente implementó; `--force` sobrescribe todo lo generado (avisando de qué se perdería). Los snapshots de `specs/` y `docs/` son la excepción: se refrescan siempre.

## Anatomía del paquete

```
keel-<tech>/
├── package.json         # bin: keel-<tech>; dependencia: keel-core (validación + schemas del DSL)
├── src/
│   ├── cli.js           # commander: comando build
│   ├── commands/build.js
│   ├── lib/             # assets.js (rutas + SUPPORTED_DSL), model.js (DSL → modelo), stack-catalog/config
│   └── scaffold/        # un módulo por artefacto transversal al stack (patrón de keel-spring)
├── assets/              # fuente del .claude/ del proyecto generado: skill, agents, conventions, skills/<infra>, golden
└── test/
```

**Criterio de frontera del scaffolding**: build genera todo lo derivable mecánicamente del diseño + `keel-stack.json` cuyo código es idéntico sea cual sea la opción de infra elegida (más deps/config/compose, derivados del catálogo de stack). Lo que cambia según la opción concreta (publisher Kafka vs Rabbit, adaptador de storage…) se documenta en la skill por tecnología correspondiente (`skills/keel-<tech>-<infra>/`) y lo escribe el agente. El proyecto recién generado debe compilar y arrancar sin el trabajo del agente (los huecos son stubs que fallan en ejecución, no en compilación).

El paquete **no duplica la validación ni los schemas**: importa `validateService`, `loadService`, `copyTree`, etc. de `keel-core`, que es quien define el DSL. La versión soportada se declara en `src/lib/assets.js` (`SUPPORTED_DSL`), en `package.json` (`"keel": { "dsl": "2.3" }`) y en el README del generador.

## El contrato (README.md del generador)

Debe declarar explícitamente:

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/` (manifiesto + capas), validado (`keel validate` + `/keel-validate`).
2. **Compatibilidad**: qué versiones del DSL soporta (`keel: "2.3"` del manifiesto). Ante una versión no soportada, el generador se detiene — nunca genera "a ver qué sale".
3. **Salida**: repo git propio en `services/<service.name>-<tech>/`, con tests pasando y README que registra `Generado desde <spec> v<service.version>` + decisiones de generación.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; los huecos del spec se reportan como cambios propuestos al spec.

## La tabla de mapeo (conventions/mapping.md)

Es el corazón del generador: cada construcción del DSL (entidad, campo `unique`, `rules`, `errors[].code`, `emits`, `idempotency`, `cache`, `access`, `retry`/`circuitBreaker`, `outbox`…) tiene su traducción concreta a la tecnología. Organiza la tabla **por capa** (domain, use-cases, api, security, messaging, http-clients, dependencies, persistence). Criterios:

- Cubre **todas** las construcciones de `docs/dsl-reference.md` y `docs/dsl/<capa>.md`; si una capa o construcción no aplica, se dice explícitamente.
- **Nada declarado se ignora en silencio.** El DSL es más ancho que cualquier generador concreto, y eso es correcto: se ajusta el generador, nunca el DSL. Lo que no vale es que el generador reciba una construcción que no sabe mapear y produzca su default como si nada — el diseñador cree que se generó y nadie se lo desmiente. Declara la frontera **en código**, no solo en prosa: un módulo tipo `src/lib/supported-features.js` que el comando `build` consulta justo después del chequeo de `SUPPORTED_DSL` y que devuelve errores (impiden generar) y avisos (dejan seguir, diciendo qué se genera en su lugar). Es el sitio donde se acumula todo lo que el generador aún no cubre, y desaparece de allí cuando se implementa. Sin ese chequeo, la superficie no cubierta es exactamente la que ningún diseño de ejemplo haya usado todavía — y no se descubre hasta que un servicio real la necesita.
- La capa `dependencies` es de **síntesis**: sus referencias (`fetchedFrom`, `replica.fedBy`) apuntan a construcciones que el generador ya traduce desde `http-clients` y `messaging`, así que no debe producir un segundo cliente ni un segundo listener. Lo que sí exige código propio es `replica` (materializar la copia y mantenerla al día de forma idempotente) y `onMiss` (la política de lectura cuando el dato falta: pedirlo, fallar con el error declarado, o degradar). Un generador puede ignorar la capa entera y seguir siendo correcto para `strategy: on-demand`; con `replicated` no, porque la copia no se mantendría sola.
- Los `code` de error y nombres de evento se trasladan exactos: son contrato público.
- Define el orden de autoridad: spec > mapping > golden > criterio del agente (documentado).
- Incluye la política de tests: por operación (feliz + cada error), por invariante, y el comando de verificación que debe pasar antes de dar la generación por terminada.

## El golden example

Tras la primera generación real aprobada, congela en `golden/` el diseño usado y el resultado. Sirve como referencia de estilo y como detector de regresiones: al cambiar la skill o las conventions, regenera el diseño fijo y compara contra el golden.

## Proceso para crear un generador nuevo

Un generador nuevo es un paquete `packages/keel-<tech>/` en el monorepo de Keel (ej. el futuro `keel-nest`):

1. Copia `packages/keel-spring/` y adapta: `package.json` (name, bin, descripción), `src/lib/assets.js` (skill y tecnología), y el contenido de `assets/` — README, skill y conventions de la tecnología (verifica versiones actuales del stack con `find-docs`).
2. Escribe la tabla de mapeo completa recorriendo `docs/dsl-reference.md` construcción por construcción.
3. Pruébalo en un workspace: `npm link` del paquete, `keel-<tech> build specs/<servicio>` y genera un servicio existente (idealmente el mismo diseño que otro generador ya generó); después `cd` al proyecto y completa con `/keel-generate-<tech>`. Compara comportamiento observable con el otro generador: mismos endpoints, mismos códigos de error, mismos eventos.
4. Refina la skill y las conventions con lo aprendido y puebla `golden/`. El generador mejora con cada uso.

## Versionado

- **Antes de proponer cualquier cambio al DSL, aplica la regla inviolable de evolución** ([dsl-reference.md § Evolución del DSL](dsl-reference.md#evolución-del-dsl-regla-inviolable)): se ajusta el generador, nunca el DSL. Una necesidad de tu generador casi siempre se resuelve en su `stack-catalog`/config/`mapping.md`, no en el lenguaje.
- El README del generador (y `SUPPORTED_DSL` en su CLI) declara qué versión del DSL soporta.
- Cuando el DSL suba de versión (ver [methodology.md](methodology.md)), cada generador se actualiza y publica a su ritmo; mientras tanto, su comprobación de compatibilidad en `build` protege contra usos incompatibles.
