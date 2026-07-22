---
name: keel-generate
description: Orquesta la generación de un servidor desde un servicio Keel multi-artefacto delegando en el generador instalado de la tecnología pedida (generators/<tech>). Usar cuando el usuario quiere producir código a partir de un diseño.
argument-hint: "<tecnología> <specs/servicio>"
---

# /keel-generate — orquestador de generación

Convierte un diseño Keel validado (`specs/<servicio>/`, un artefacto por capa) en un proyecto ejecutable delegando en el **generador instalado** de la tecnología: `generators/<tecnología>/` en este workspace. El diseño es la única fuente de verdad funcional: si detectas un hueco, propón el cambio a los artefactos, no lo resuelvas solo en el código.

Cada generador es un paquete npm independiente con CLI propia (ej. `keel-spring`); su comando `build` instala en el workspace la skill `keel-generate-<tech>` y los archivos de `generators/<tech>/`, valida el diseño, pregunta el stack (persistido en `keel-stack.json`) y genera el scaffolding transversal en `services/<servicio>-<tech>/`. El agente completa el código dependiente de la infraestructura elegida (guiado por `generators/<tech>/references/`), la lógica de negocio y los tests. Puedes invocar directamente `/keel-generate-<tech>` si ya sabes la tecnología; este orquestador solo resuelve y verifica antes de delegar.

## Proceso

1. **Resolver el generador.** Comprueba que existen `.claude/skills/keel-generate-<tecnología>/` y `generators/<tecnología>/` en el workspace. Si no, indica al usuario cómo instalarlo: `npm i -g keel-<tecnología>` (ej. `keel-spring`; ver `keel list`) y `keel-<tecnología> build specs/<servicio>`. No intentes generar sin generador instalado.

2. **Cargar el conocimiento del generador.** Lee, en este orden:
   - `generators/<tech>/README.md` — contrato y compatibilidad de versión DSL.
   - `.claude/skills/keel-generate-<tech>/SKILL.md` — el proceso de generación (instalada por `keel-<tech> build`).
   - `generators/<tech>/conventions/` — convenciones normativas.
   - `generators/<tech>/references/` — guías por tecnología del stack (solo las del stack de `keel-stack.json`).
   - `generators/<tech>/golden/` — referencia de estilo, si está poblado.

3. **Compatibilidad y validación.** `keel-<tech> build` ya comprueba la versión DSL y ejecuta la validación mecánica; si el usuario acaba de pasar por `build` en verde, no las repitas. Si se invocó esta skill sin pasar por `build`, verifica que la versión `keel:` del manifiesto está soportada por el generador (README) y ejecuta `keel validate specs/<servicio>` (siempre sin `--wip`: un "Diseño en progreso" no es generable). En ambos casos aplica la checklist semántica de `/keel-validate`. Errores → detente; nunca se genera desde un diseño inválido o incompleto.

4. **Generar** siguiendo la skill del generador al pie de la letra, incluida su verificación: tests del proyecto generado pasando **y** los escenarios de `specs/<servicio>/validation-scenarios.md` ejecutados contra el servidor generado en marcha (llamadas reales, verificando status y efectos de cada **Then**). Si `validation-scenarios.md` no existe, detente: el diseño no está cerrado — pide completarlo con `/keel-design`. Salida: `services/<service.name>-<tech>/`, inicializado como repo git propio.

5. **Cerrar.** Resume: qué se generó, decisiones de generación tomadas, huecos del diseño detectados, y si el uso reveló mejoras para el generador.

## Reparto de responsabilidades

- **El core del workspace** define el DSL, valida diseños y documenta (`/keel-design`, `/keel-validate`, `/keel-docs`).
- **Cada generador** (paquete `keel-<tech>`: su CLI, `generators/<tech>/` + su skill) posee sus convenciones y su proceso; este orquestador no las duplica ni las contradice.
- **Cada servicio generado** (`services/<nombre>-<tech>/`) es un repo git independiente con su propio ciclo de vida.
