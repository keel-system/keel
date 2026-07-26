# Keel

**Diseña un servidor una vez. Genéralo en cualquier tecnología.**

Keel es una CLI de Node.js + una metodología para agentes que separa el *qué* hace un servicio del *cómo* está implementado:

1. **Diseño agnóstico por capas** — la funcionalidad del servidor se condensa en un directorio de **artefactos declarativos relacionados** (`specs/<servicio>/`): un manifiesto más una capa por preocupación — dominio, casos de uso, API, seguridad, mensajería, clientes HTTP, persistencia. Cada capa se itera con el humano por separado y ninguna menciona framework, ORM, broker ni lenguaje.
2. **Generación dirigida por agentes** — un agente (Claude Code) lee el spec validado y genera un proyecto completo para una tecnología concreta (Spring Boot, NestJS, FastAPI…), guiado por el generador de esa tecnología.
3. **Documentación automática del diseño** — al cerrar el diseño se derivan, sin intervención extra, el documento de diseño reutilizable (`DESIGN.md`) y un índice `README.md` del workspace que lista los servicios; y, cuando se necesita integrar, la guía de integración + OpenAPI para que otros sistemas se conecten con mínima fricción.

El mismo spec puede regenerarse tantas veces como se quiera, en tecnologías distintas, sin re-diseñar nada.

## Paquetes

Este repo es un **monorepo npm workspaces** con dos tipos de paquete:

| Paquete | CLI | Qué hace |
|---------|-----|----------|
| `packages/keel-core` | `keel` | El core: siembra workspaces, crea servicios y valida diseños. Define el DSL (schemas, docs, plantillas) y expone su validación como librería para los generadores. |
| `packages/keel-spring` | `keel-spring` | Generador Spring Boot: `build` instala su skill + convenciones + referencias, valida el diseño, pregunta el stack y genera el scaffolding transversal (el proyecto arranca); el código dependiente de la infra elegida y la lógica de negocio los genera el agente. Futuro: `keel-nest`, `keel-fastapi`, … |

## Instalación

```bash
git clone <este-repo> && cd keel
npm install
npm link --workspace packages/keel-core          # comando `keel`
npm link --workspace packages/keel-spring        # comando `keel-spring`
```

(Publicación en npm pendiente; los `bin` ya están configurados.)

## Uso

```bash
mkdir mi-proyecto && cd mi-proyecto

keel init            # siembra el workspace: skills, schemas, plantillas, docs
keel new mi-servicio # crea specs/mi-servicio/ (manifiesto + domain + use-cases)

# En Claude Code, dentro del workspace:
#   /keel-design specs/mi-servicio           diseña capa a capa; al cerrar genera
#                                            validation-scenarios.md, docs/mi-servicio/DESIGN.md
#                                            y actualiza el índice README.md del workspace
keel validate specs/mi-servicio              # schemas por capa + referencias cruzadas

#   /keel-docs specs/mi-servicio             → openapi.yaml, asyncapi.yaml, Postman y overview.html
#   /keel-handoff specs/mi-servicio          → regenera DESIGN.md + índice si el spec cambió

# Generar: dos pasos, con un cd en medio.
keel-spring build specs/mi-servicio   # valida, pregunta el stack y genera services/mi-servicio-spring/
cd services/mi-servicio-spring
# En Claude Code, abierto en esa raíz:
#   /keel-generate-spring                    → sin argumentos; completa el proyecto y valida los escenarios
```

## Comandos

| Comando | Qué hace |
|---------|----------|
| `keel init [--force]` | Copia al directorio actual todo lo necesario: skills del agente, schemas por capa, plantillas, docs y `CLAUDE.md`. Nunca sobrescribe sin `--force`. |
| `keel new <servicio>` | Crea `specs/<servicio>/` con manifiesto + capas obligatorias desde plantillas. |
| `keel list` | Lista los generadores conocidos y su paquete npm. |
| `keel validate <ruta>` | Valida un servicio (directorio o manifiesto): schema de cada capa + referencias cruzadas entre artefactos (offline, con todos los errores). |
| `keel-spring build <ruta> [--force] [--defaults]` | Comprueba la compatibilidad DSL, valida el diseño, pregunta el stack (persistido en `keel-stack.json`) y genera en `services/<servicio>-spring/` el scaffolding transversal al stack más el `.claude/` del agente (skill, agentes, conventions, skills del stack) y los snapshots de `specs/` y `docs/`. No escribe nada en el workspace de diseño. |

## El workspace sembrado

```
mi-proyecto/
├── CLAUDE.md                 # el flujo, para el agente
├── README.md                 # índice de servicios diseñados (enlaza cada DESIGN.md) — página de entrada del repo
├── .claude/skills/           # keel-design, keel-consume, keel-validate, keel-docs, keel-integrate, keel-handoff
├── schema/                   # un JSON Schema por capa + common.schema.json
├── specs/<servicio>/         # el diseño de cada servicio, un artefacto por capa — la fuente de verdad
│   ├── service.keel.yaml     #   manifiesto: identidad + capas declaradas
│   ├── domain.keel.yaml      #   entidades, types, invariantes (obligatoria)
│   ├── use-cases.keel.yaml   #   operaciones, idempotencia, caché (obligatoria)
│   └── *.keel.yaml           #   api, security, messaging, http-clients, dependencies, persistence (opcionales)
├── templates/service/        # una plantilla por capa
├── contracts/<proveedor>/    # INTEGRATION.md de servidores externos de los que dependemos (entrada de /keel-consume)
├── docs/                     # methodology, dsl-reference (índice), dsl/<capa>.md, building-a-generator
└── services/<servicio>-<tech>/  # servicios generados por `keel-<tech> build` (un repo git propio cada uno)
    ├── .claude/              #   la skill del generador, sus agentes y conventions — el flujo de generación
    └── specs/                #   snapshot del diseño: el proyecto se completa sin el workspace
```

El workspace es **solo diseño**: no aloja skills ni convenciones de generadores. Todo el conocimiento de generación vive dentro de cada proyecto generado.

## Estructura de este repo

```
keel/
├── package.json                  # raíz privada: workspaces packages/*
└── packages/
    ├── keel-core/                 # el core (Node 18+, ESM, sin build step)
    │   ├── src/
    │   │   ├── cli.js            # entry (commander): init, new, list, validate
    │   │   ├── index.js          # API pública para generadores (validateService, loadService, …)
    │   │   ├── commands/
    │   │   └── lib/              # assets, copia, carga multi-artefacto, referencias cruzadas
    │   └── assets/core/          # lo que `keel init` siembra (skills, schemas, plantillas, docs)
    └── keel-spring/              # generador Spring Boot
        ├── src/                  # CLI: comando build + scaffolding transversal (src/scaffold, src/lib)
        └── assets/               # lo que `keel-spring build` instala (skill + conventions + skills por tecnología + golden)
```

Los assets **son** la metodología: el DSL se documenta en `packages/keel-core/assets/core/docs/dsl-reference.md`, el schema vive en `packages/keel-core/assets/core/schema/`, y cada generador en su propio paquete `packages/keel-<tech>/`. Para crear un generador nuevo: `packages/keel-core/assets/core/docs/building-a-generator.md`.

## Principios

- **El diseño es la fuente de verdad.** Todo lo que un generador necesita saber está en los artefactos; ninguna decisión de negocio queda implícita.
- **Cero tecnología en el diseño.** ORM, framework, broker, proveedor de auth o base de datos concreta se deciden al generar, nunca al diseñar.
- **Iterable por humanos y agentes, capa a capa.** Cada artefacto es YAML legible y pequeño: un humano revisa una capa en un diff, un agente la produce y la consume; las capas se relacionan por nombre y `keel validate` comprueba las referencias.
- **Regenerable.** Cambiar de stack es re-ejecutar la generación, no reescribir el diseño.
