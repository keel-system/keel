# Cómo construir un generador

Un generador convierte specs Keel en servicios de una tecnología concreta repartiendo el trabajo en dos mitades:

1. **Scaffolding transversal al stack** (comando `build`): tras el cuestionario de stack (BD, broker, auth… — solo lo que el diseño necesita; persistido en `keel-stack.json`), genera de forma determinista todo lo necesario para **levantar el proyecto**: dependencias en función del stack elegido, configuración por perfiles, infraestructura de prueba, y toda la estructura cuyo código es idéntico sea cual sea la opción de infra puntual (dominio puro, puertos, contratos, controllers, mediator, manejo de errores, stubs).
2. **Conocimiento para el agente**: una skill orquestadora, convenciones y **skills por tecnología** (`skills/keel-<tech>-<infra>/SKILL.md`, instaladas condicionalmente en el proyecto generado según el stack elegido) con las que el agente escribe el código cuya implementación depende de la infra elegida (adaptadores del broker/storage…), la lógica de negocio y los tests.

Cada generador es un **paquete npm independiente con CLI propia** (`keel-<tech>`, ej. `keel-spring`): se instala con `npm i -g keel-<tech>` y su comando `build` prepara el workspace y genera el scaffolding. Los generadores conocidos se ven con `keel list`. Referencia viva: el paquete `keel-spring`.

## Qué instala `keel-<tech> build` en el workspace

```
.claude/skills/keel-generate-<tech>/SKILL.md   # el proceso de generación paso a paso
generators/<tech>/
├── README.md            # contrato: entrada, compatibilidad DSL, salida, reglas
├── conventions/
│   ├── project-layout.md    # stack por defecto + estructura + frontera scaffolding/agente
│   └── mapping.md           # tabla normativa spec → código
├── skills/              # skills por tecnología del stack (keel-<tech>-kafka/, keel-<tech>-s3/…) para el código del agente
└── golden/              # ejemplo de referencia generado desde un diseño fijo
```

Además de copiar estos archivos (idempotente; `--force` sobrescribe), `build` comprueba la compatibilidad de versión DSL del manifiesto, ejecuta la validación mecánica (`keel validate`, sin `--wip`) — si el diseño no es generable, lo reporta y se detiene — y genera el scaffolding en `services/<servicio>-<tech>/`.

El scaffolding debe dejar el proyecto generado como **repo autosuficiente**: quien lo clone (sin el workspace Keel) puede finalizar la generación. Eso significa: un `CLAUDE.md` contextual en la raíz, especializado por servicio (orden de procesamiento de capas — solo las declaradas —, stack elegido, proceso y verificación); un snapshot del diseño en `specs/` del proyecto (que `build` **siempre refresca** — el canónico es el del workspace); y `.claude/skills/` con una skill propia del proyecto (`keel-generate-<tech>/`, con copia local de las conventions) más **solo** las skills por tecnología del stack elegido (instalación condicional según `keel-stack.json`). Si el generador orquesta el completado con subagentes (patrón de `keel-spring`: agente de código en paralelo con agente de infraestructura, y agente de validación funcional al final), sus definiciones viven en `assets/.claude/agents/` y se instalan tanto en el workspace como en `.claude/agents/` del proyecto generado. La skill del workspace queda como copia canónica; las locales se refrescan con `--force`.

## Anatomía del paquete

```
keel-<tech>/
├── package.json         # bin: keel-<tech>; dependencia: keel-core (validación + schemas del DSL)
├── src/
│   ├── cli.js           # commander: comando build
│   ├── commands/build.js
│   ├── lib/             # assets.js (rutas + SUPPORTED_DSL), model.js (DSL → modelo), stack-catalog/config
│   └── scaffold/        # un módulo por artefacto transversal al stack (patrón de keel-spring)
├── assets/              # exactamente lo que build copia al workspace (árbol de arriba)
└── test/
```

**Criterio de frontera del scaffolding**: build genera todo lo derivable mecánicamente del diseño + `keel-stack.json` cuyo código es idéntico sea cual sea la opción de infra elegida (más deps/config/compose, derivados del catálogo de stack). Lo que cambia según la opción concreta (publisher Kafka vs Rabbit, adaptador de storage…) se documenta en la skill por tecnología correspondiente (`skills/keel-<tech>-<infra>/`) y lo escribe el agente. El proyecto recién generado debe compilar y arrancar sin el trabajo del agente (los huecos son stubs que fallan en ejecución, no en compilación).

El paquete **no duplica la validación ni los schemas**: importa `validateService`, `loadService`, `copyTree`, etc. de `keel-core`, que es quien define el DSL. La versión soportada se declara en `src/lib/assets.js` (`SUPPORTED_DSL`), en `package.json` (`"keel": { "dsl": "2.0" }`) y en el README del generador.

## El contrato (README.md del generador)

Debe declarar explícitamente:

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/` (manifiesto + capas), validado (`keel validate` + `/keel-validate`).
2. **Compatibilidad**: qué versiones del DSL soporta (`keel: "2.0"` del manifiesto). Ante una versión no soportada, el generador se detiene — nunca genera "a ver qué sale".
3. **Salida**: repo git propio en `services/<service.name>-<tech>/`, con tests pasando y README que registra `Generado desde <spec> v<service.version>` + decisiones de generación.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; los huecos del spec se reportan como cambios propuestos al spec.

## La tabla de mapeo (conventions/mapping.md)

Es el corazón del generador: cada construcción del DSL (entidad, campo `unique`, `rules`, `errors[].code`, `emits`, `idempotency`, `cache`, `access`, `retry`/`circuitBreaker`, `outbox`…) tiene su traducción concreta a la tecnología. Organiza la tabla **por capa** (domain, use-cases, api, security, messaging, http-clients, persistence). Criterios:

- Cubre **todas** las construcciones de `docs/dsl-reference.md` y `docs/dsl/<capa>.md`; si una capa o construcción no aplica, se dice explícitamente.
- Los `code` de error y nombres de evento se trasladan exactos: son contrato público.
- Define el orden de autoridad: spec > mapping > golden > criterio del agente (documentado).
- Incluye la política de tests: por operación (feliz + cada error), por invariante, y el comando de verificación que debe pasar antes de dar la generación por terminada.

## El golden example

Tras la primera generación real aprobada, congela en `golden/` el diseño usado y el resultado. Sirve como referencia de estilo y como detector de regresiones: al cambiar la skill o las conventions, regenera el diseño fijo y compara contra el golden.

## Proceso para crear un generador nuevo

Un generador nuevo es un paquete `packages/keel-<tech>/` en el monorepo de Keel (ej. el futuro `keel-nest`):

1. Copia `packages/keel-spring/` y adapta: `package.json` (name, bin, descripción), `src/lib/assets.js` (skill y tecnología), y el contenido de `assets/` — README, skill y conventions de la tecnología (verifica versiones actuales del stack con `find-docs`).
2. Escribe la tabla de mapeo completa recorriendo `docs/dsl-reference.md` construcción por construcción.
3. Pruébalo en un workspace: `npm link` del paquete, `keel-<tech> build specs/<servicio>` y genera un servicio existente (idealmente el mismo diseño que otro generador ya generó); compara comportamiento observable: mismos endpoints, mismos códigos de error, mismos eventos.
4. Refina la skill y las conventions con lo aprendido y puebla `golden/`. El generador mejora con cada uso.

Para experimentar sin crear el paquete, también puedes crear `generators/<tech>/` + su skill directamente en el workspace (mismo layout de assets); si funciona bien, conviértelo en paquete siguiendo el patrón de `keel-spring`.

## Versionado

- El README del generador (y `SUPPORTED_DSL` en su CLI) declara qué versión del DSL soporta.
- Cuando el DSL suba de versión (ver [methodology.md](methodology.md)), cada generador se actualiza y publica a su ritmo; mientras tanto, su comprobación de compatibilidad en `build` protege contra usos incompatibles.
