# Diseños de servicios

Este repositorio contiene **diseños de servicios Keel**: cada servicio se describe como un conjunto de
artefactos declarativos agnósticos de tecnología (`specs/<servicio>/`, un artefacto YAML por capa), a
partir de los cuales se genera la implementación en la tecnología que se quiera.

> Edita libremente esta introducción para describir tu organización, convenciones o cómo contribuir.
> La tabla de la sección **Servicios diseñados** se regenera automáticamente al cerrar cada diseño
> (`/keel-design`) o al ejecutar `/keel-handoff`; **no edites a mano el contenido entre los marcadores**.

## Servicios diseñados

Cada servicio enlaza su **documento de diseño** (`DESIGN.md`: modelo de dominio, invariantes, decisiones y
cómo reutilizarlo) y, si existe, su **guía de integración** (`INTEGRATION.md` + `openapi.yaml`).

<!-- keel:servicios:start -->
_Aún no hay servicios diseñados. Cierra un diseño con `/keel-design specs/<servicio>` para poblar esta tabla._
<!-- keel:servicios:end -->

## Cómo trabajar aquí

Este directorio es un **workspace Keel** (ver `CLAUDE.md` para el flujo completo):

1. `keel new <servicio>` — crea `specs/<servicio>/` (manifiesto + capas obligatorias).
2. `/keel-design specs/<servicio>` — diseña capa a capa con el agente; al cerrar, genera
   `validation-scenarios.md`, el documento de diseño `docs/<servicio>/DESIGN.md` y actualiza este índice.
3. `/keel-generate <tech> specs/<servicio>` — genera la implementación en `services/<servicio>-<tech>/`.
4. `/keel-docs specs/<servicio>` — documentación para integradores externos.
