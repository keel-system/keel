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

## La frontera, hoy (incremento 4)

Genera el proyecto que compila sin un solo warning, pasa sus pruebas y arranca, con:

- el **contrato del cable** (`keel-core/gen/wire.js`) instalado en las opciones JSON de la API: la escala de
  un `decimal`, el instante en UTC con tres decimales, el `json` embebido, el enum por el valor del diseño,
  el texto sin escapar y `[OmitNulls]` para `conventions.nulls: omit`. La prueba emitida
  `WireContractTests` ejecuta todos los casos compartidos con keel-spring y keel-nest;
- el **dominio**: value objects que hacen cumplir su tipo en el constructor (y normalizan la escala),
  `<Tipo>Format` para los escalares con formato, agregados con estado de rehidratación, guarda del
  lifecycle y buffer de eventos, y la jerarquía de errores de los otros dos generadores;
- la **aplicación**: un mensaje y un handler por operación (el handler nace fallando con su TODO y las
  notas del diseño), DTOs con el nombre del cable, mappers campo a campo y un mediator propio (sin MediatR),
  con el registro en el contenedor generado y probado.

Acepta la capa `api` avisando de que llega en el incremento 5. Avisa de lo que una operación declara y su
mecanismo aún no existe (`idempotency` y `schedule` en el 10, `cache` en el 13), y **rechaza** el resto de
capas nombrando el incremento que la trae (persistencia en el 6, seguridad en el 8, mensajería en el 9…).
La telemetría llega en el 14.

## Licencias

Ningún paquete con licencia comercial (MediatR ≥ 13, AutoMapper ≥ 15, MassTransit ≥ 9,
FluentAssertions ≥ 8…). Cada paquete que se puede emitir lleva su versión exacta y su licencia SPDX en
`src/lib/dotnet-stack.js`, y `npm run cs-check` comprueba, contra el catálogo de nuget.org, la licencia de
todo lo que NuGet resuelve, transitivos incluidos.

## Desarrollo

```bash
npm test --workspace packages/keel-dotnet       # sin SDK: el texto emitido, la proyección, la frontera, la paridad con keel-spring y keel-nest
npm run cs-check --workspace packages/keel-dotnet  # con el SDK 10 y red: restaura, compila, prueba, licencias y arranque, y la solución de TODAS las fixtures
npm run cs-check --workspace packages/keel-dotnet -- --fixtures  # solo la solución de todas las fixtures y las sondas del dominio
npm run cs-check --workspace packages/keel-dotnet -- --sabotage=decimal-scale  # falsa la prueba emitida: tiene que salir rojo
```

Sabotajes de `cs-check` (rompen lo emitido conservando la forma; el check tiene que salir rojo en las
pruebas de esa regla y solo en esas): `decimal-scale`, `decimal-exact`, `timestamp-format`, `utf8` y
`wiring`.

`cs-check` compila además, en una sola solución, lo que se emite para **todas** las fixtures compartidas
(aunque la frontera todavía rechace alguna de sus capas) y ejecuta sus pruebas emitidas y las sondas del
dominio (`scripts/probes/`): C# de verdad que ejecuta el dominio generado (escala, rechazos, formato,
transición negada, orden del cable).
