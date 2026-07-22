# Workspace Keel

Este directorio es un **workspace Keel**, sembrado con `keel init`: aquí se diseñan servidores como artefactos agnósticos de tecnología (un directorio `specs/<servicio>/` con un artefacto YAML por capa) y se generan implementaciones concretas a partir de ellos.

## El flujo

```
keel new → /keel-design (cierra con DESIGN.md + README) → /keel-validate → /keel-generate <tech> → /keel-docs
```

1. **Crear** — `keel new <servicio>`: crea `specs/<servicio>/` con manifiesto (`service.keel.yaml`) + capas obligatorias (`domain`, `use-cases`).
2. **Diseñar** — `/keel-design specs/<servicio>`: entrevista al humano y construye el diseño **capa a capa** (domain → use-cases → api → security → messaging → http-clients → persistence → storage), aprobando cada artefacto antes del siguiente. Las capas opcionales se declaran en el manifiesto solo si aplican. Referencia: `docs/dsl-reference.md` (índice) y `docs/dsl/<capa>.md`. El cierre produce `specs/<servicio>/validation-scenarios.md` (escenarios Given/When/Then; formato en `docs/validation-scenarios.md`) con el que el generador validará el servidor y, como paso final automático, ejecuta `/keel-handoff` para derivar `docs/<servicio>/DESIGN.md` (características + decisiones de diseño con su porqué) y actualizar el índice de servicios del `README.md`.
3. **Validar** — `/keel-validate` (usa `keel validate specs/<servicio>` para schemas por capa + referencias cruzadas, y añade la checklist semántica).
4. **Generar** — `/keel-generate <tech> specs/<servicio>`: delega en el generador instalado en `generators/<tech>/`. Cada generador es un paquete npm con CLI propia: se instala con `npm i -g keel-<tech>` (ej. `keel-spring`; ver conocidos: `keel list`) y se prepara con `keel-<tech> build specs/<servicio>` (copia su skill, convenciones y skills por tecnología al workspace, valida el diseño, pregunta el stack y genera el scaffolding transversal del servicio; el agente completa el código dependiente de la infra elegida, la lógica de negocio y los tests). Salida: `services/<servicio>-<tech>/` como repo git propio.
5. **Documentar** — `/keel-docs specs/<servicio>` deriva `INTEGRATION.md` + `openapi.yaml` + colecciones Postman (`postman/`) para integradores externos. (El documento de diseño `DESIGN.md` ya se produjo al cerrar el diseño; `/keel-handoff specs/<servicio>` lo **regenera** cuando el spec cambia.)

## Estructura

```
CLAUDE.md            # este archivo
README.md            # índice de servicios diseñados (enlaza el DESIGN.md de cada uno); página de entrada del repo
.gitignore           # excluye services/ del repo del workspace (aquí solo se versiona el diseño)
.claude/skills/      # las skills del flujo (y las de generadores instalados)
schema/              # un JSON Schema por capa + common.schema.json ($defs compartidos)
specs/<servicio>/    # el diseño de cada servicio, un artefacto por capa — la fuente de verdad
                     # (+ validation-scenarios.md: escenarios de validación derivados, al cerrar el diseño)
templates/service/   # plantillas por capa para arrancar artefactos nuevos
docs/                # methodology, dsl-reference (índice), dsl/<capa>.md, building-a-generator
                     # (+ <servicio>/: INTEGRATION.md + openapi.yaml de /keel-docs y DESIGN.md de /keel-handoff)
generators/<tech>/   # generadores instalados con `keel-<tech> build` (conventions + golden)
services/            # servicios generados (un repo git propio cada uno)
```

## Reglas para el agente

- **El diseño es la fuente de verdad.** Todo cambio funcional se hace en `specs/<servicio>/` y se regenera; nunca directamente en `services/`.
- **Cero tecnología en los specs.** Framework, BD, broker o proveedor de auth se deciden al generar, jamás al diseñar.
- **Una capa por vez.** Al diseñar o iterar, trabaja el artefacto de la capa activa y cierra sus referencias cruzadas antes de seguir.
- **Una capa opcional existe ⇔ está declarada en `layers`** del manifiesto. No crees artefactos de capas que el servicio no necesita.
- **Nunca generes desde un diseño inválido** ni con un generador cuya compatibilidad de versión DSL no cubra el manifiesto.
- La metodología completa está en `docs/methodology.md`.
