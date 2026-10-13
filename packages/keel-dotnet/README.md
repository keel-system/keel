# keel-dotnet

Generador .NET para diseños Keel, **en construcción por incrementos** (`PLAN-KEEL-DOTNET.md` en la raíz
del repo lleva su estado). Su objetivo es el de los otros dos generadores: **el mismo diseño genera con
keel-spring, keel-nest o keel-dotnet servidores equivalentes** — mismo contrato HTTP, mismo cable, mismos
eventos, mismas tablas, misma operación.

```bash
keel-dotnet check specs/<servicio>   # opcional: no escribe nada, dice si el diseño es generable
keel-dotnet build specs/<servicio>   # desde el workspace de diseño
cd services/<servicio>-dotnet
dotnet build && dotnet test
```

## El contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/` (manifiesto + capas), validado y listo
   (`keel validate --ready`; con `--accept-unready` se genera igual y queda estampado).
2. **Compatibilidad**: DSL `2.21`, la misma que keel-spring y keel-nest. Ante otra, se detiene.
3. **Salida**: `services/<servicio>-dotnet/`, una solución .NET 10 con un proyecto por capa (Domain,
   Application, Infrastructure, Api y pruebas), la configuración por perfiles en `config/` con el mismo
   formato y las mismas variables que los otros dos servidores, sus sondas `/livez` y `/readyz`, el
   snapshot sellado del diseño en `specs/` y lo que el agente necesita para completarla.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; lo que no sabe mapear lo
   rechaza o lo avisa en código (`src/lib/supported-features.js`), nunca lo ignora.

## La frontera, hoy (incremento 2)

Genera el proyecto que compila sin un solo warning, pasa sus pruebas y arranca. Acepta las capas
`domain`, `use-cases` y `api` avisando de que su código llega en los incrementos 4 y 5, y **rechaza** el
resto nombrando el incremento que la trae (persistencia en el 6, seguridad en el 8, mensajería en el 9…).
La telemetría llega en el 14.

## Licencias

Ningún paquete con licencia comercial (MediatR ≥ 13, AutoMapper ≥ 15, MassTransit ≥ 9,
FluentAssertions ≥ 8…). Cada paquete que se puede emitir lleva su versión exacta y su licencia SPDX en
`src/lib/dotnet-stack.js`, y `npm run cs-check` comprueba, contra el catálogo de nuget.org, la licencia de
todo lo que NuGet resuelve, transitivos incluidos.

## Desarrollo

```bash
npm test --workspace packages/keel-dotnet       # sin SDK: el texto emitido, la proyección, la frontera
npm run cs-check --workspace packages/keel-dotnet  # con el SDK 10 y red: restaura, compila, prueba, licencias y arranque
```
