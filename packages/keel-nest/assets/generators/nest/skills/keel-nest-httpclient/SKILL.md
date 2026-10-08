---
name: keel-nest-httpclient
description: Guía de las integraciones HTTP salientes (capa http-clients) en un proyecto generado por keel-nest — usar el puerto desde el handler, traducir los rechazos con significado, completar lo que el contrato en prosa no dice y escribir los flujos contra el proveedor de prueba; el adaptador sobre fetch, el retry, el circuito y el fallback ya los genera build. Usar cuando el diseño declara la capa http-clients.
---

# HTTP clients salientes (capa `http-clients`)

Casi todo lo saliente sale **de build**, y es el mismo servidor que el de keel-spring del diseño: misma ruta,
misma cabecera de idempotencia, mismos reintentos, mismo circuito y mismo fallback. Lo tuyo es poco y concreto:
**llamar al puerto** desde el handler, **traducir** los rechazos que significan algo, completar lo que el
contrato solo dice en prosa y **probarlo** contra el proveedor de prueba. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Puerto | `domain/clients/<cliente>-client.ts` | Clase abstracta `<Cliente>Client` con una llamada por `calls.<c>`; devuelve `<Llamada>Result` (en términos del dominio, todo campo admite su ausencia) |
| Adaptador | `infrastructure/clients/<cliente>-http-adapter.ts` | La llamada sobre `fetch` (`<llamada>Once`), la política del diseño (`<LLAMADA>_POLICY`) y el fallback (`<llamada>Unavailable`) |
| Resiliencia | `src/infrastructure/clients/outbound-resilience.ts`, `src/infrastructure/clients/circuit-breaker.ts` | Retry por fuera y circuito por dentro, el orden de resilience4j; el circuito tiene SU semántica (un 4xx es un éxito para él) |
| Fallos del proveedor | `src/infrastructure/clients/provider-failures.ts` | `ProviderTransportError` (sin respuesta, timeout), `ProviderStatusError` (con su `status` y su `kind`), `CallNotPermittedError` (circuito abierto) |
| Lectura y escritura | `src/infrastructure/clients/http-exchange.ts`, `src/infrastructure/clients/response-reading.ts` | Un intento con su timeout, el cuerpo con el contrato del cable, y `OutboundContractError` para lo que viola el contrato |
| DTOs y mapper | `infrastructure/clients/<llamada>-request.ts`, `-response.ts`, `<cliente>-mapper.ts` | El contrato del tercero tal cual, con la guarda de los obligatorios, y la anticorrupción hacia el dominio |
| Clave saliente | `src/infrastructure/clients/outbound-idempotency.ts` | `OutboundIdempotency.fromPayload/correlated`, ya cableada en el intento de cada llamada que la declara |
| Configuración | `config/parameters/<perfil>/http-clients.yaml`, `src/infrastructure/clients/http-clients-settings.ts` | La `base-url` (obligatoria fuera de `local`, que apunta al WireMock de `infra/`) y las credenciales |
| Módulo | `src/infrastructure/clients/http-clients-module.ts` | Global: los handlers inyectan el puerto sin importarlo |

## Antes de empezar

- Aplica solo si el diseño declara la capa `http-clients`.
- Lee `specs/http-clients.keel.yaml` y `specs/dependencies.keel.yaml` (la `onFailure` de cada activación es la
  política del fallback, y ya está escrita en `<llamada>Unavailable`).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el puerto y los
  resultados son DOMINIO; el adaptador, los DTOs wire y el mapper, infraestructura. **application y domain no
  importan nada de `infrastructure/clients`**, ni un error del proveedor.

## Lo que escribes

1. **La llamada desde el handler.** El puerto ya está inyectado (`this.<cliente>Client`) cuando una activación
   del diseño sale por esta llamada, y la nota del handler dice el ORDEN de los efectos. Se llama con `await` y
   **sin** retry, try/catch ni circuito alrededor: eso ya está en el adaptador, y repetirlo multiplica los intentos.
2. **Los rechazos con significado.** Un 4xx llega al fallback con su línea de log y NO cuenta para el circuito.
   Si el diseño le da significado (un 404 es «no existe», un 409 un conflicto suyo), tradúcelo en `<llamada>Once`,
   antes de que llegue al fallback — `references/implementation.md` § Rechazos.
3. **El contrato en prosa.** Sin `request`/`response` estructurados, build deja los DTOs y el mapper con
   `TODO (agente)`; sin `method`/`path`, la llamada entera. Complétalos desde la frase `contract`; si la prosa es
   ambigua, es un hueco del diseño: dilo en el reporte, no inventes la ruta.
4. **El fallback que build no pudo escribir.** Con `onFailure: ignore` o `fail` ya está escrito; con `degrade`, o
   sin activación que lo declare, queda un `TODO` con la prosa del diseño. Un resultado degradado tiene que ser
   distinguible por el cliente de uno normal.

**No ensanches el fallback.** `providerFailureOf(error, [...])` deja pasar solo los fallos del proveedor; un bug
del adaptador o un `OutboundContractError` se propagan con su traza. Capturar cualquier error ahí registró
durante meses un defecto propio como «el proveedor está caído» (en keel-spring, INFORME-CORRIDA-OUTBOX.md).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al traducir un rechazo, completar una llamada o un mapper, o escribir un fallback `degrade` |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan una llamada saliente o un barrido de reconciliación |

## Validación

- `npm run typecheck` y `npm run check:architecture` (la frontera hexagonal).
- `bash infra/check-idempotency.sh`: la familia `outboundIdempotency` exige la clave en cada llamada que la
  declara; `compensation` y `reconciliation`, lo que el diseño pide de las llamadas que deshacen o reconcilian.
- Los flujos, contra el WireMock de `infra/` (`references/flows.md`).
