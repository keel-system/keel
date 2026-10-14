# Corrida `stock-reservation-events` — keel-dotnet (incremento 9: mensajería con RabbitMQ)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation-events` v1.0.0 (DSL 2.21, relacional, 6 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 9: 9a–9d, `7afbfef`…`3ad36e2`) |
| Diseño listo al generar | sí |
| Matriz final | **15/15 OK** (14 del documento + `FL-RES-001-V`, ver § Pruebas) |
| Huella del agente | 196 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 1 (el cuerpo compartido de las entregas del arnés, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 9 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 (careo 4→0; barrido 19; revisión 5; 10 aceptadas / 9 cerradas) |

La corrida que mide el incremento 9 de `PLAN-KEEL-DOTNET.md` (9e): la primera de keel-dotnet con capa `messaging`. Sus
gemelas son `2026-10-07-stock-reservation-events-nest.md` y `2026-10-07-stock-reservation-events-spring.md`: el mismo
diseño y los mismos escenarios.

## Cómo terminó

**15/15**, con el script en 0 y sin volcados en `build/keel-failures/` (no hubo ningún rojo en la ejecución final). Sin
`harnessPatches`, sin `culprit: harness` y sin fixes de `infra/` ni de la solución. `dotnet test` 117/117 y el baseline
de migraciones creado con `dotnet ef` y verificado en vivo. Los escenarios de mensajería —`FL-OBX-001` con el broker
parado y vuelto, la doble entrega simultánea de `FL-CMP-001-C`, la reentrega sin guarda de dominio de `FL-CNT-001-B` y
el descarte de `FL-RES-004`— salieron con los helpers del arnés del 9c, sin ninguno escrito a mano.

## Comparación

| | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|
| Matriz | **15/15** | 18/18 a la primera | 14/14 |
| Registrados por build | 196 | 176 | 220 |
| Reescritos | **9** | 9 | 8 |
| Reescritos por un hueco del generador | **0** | 0 | 0 |
| Huecos del generador | 1 (el arnés, propuesto por el propio agente) | 1 (un comentario) | 0 |

Los mismos 14 escenarios del documento en los tres; lo que cambia la cuenta son los casos de validación que añade el
agente de pruebas (uno aquí, cuatro en keel-nest).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los seis handlers de `Application/UseCases/` | TODO legítimo: la lógica de cada caso de uso |
| `Domain/Aggregate/Reservation.cs` | TODO legítimo: la creación, las transiciones y `NoteStockCount` |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo: el registro del dispatcher y del listener, el sitio previsto |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

Los MISMOS nueve archivos que keel-nest (con `broker-bindings.ts`), uno a uno.

**Archivos nuevos del agente**: `RabbitMq/RabbitOutboxDispatcher.cs` (la línea sobre `RabbitConnection.Publish` que
enseña la skill) y `RabbitMq/InventoryEventsListener.cs`: UN listener para la cola compartida que enruta por
`Metadata.EventType`, abre un ámbito de DI por mensaje para el `IUseCaseMediator`, aplica el orden del guard de cada
mensaje (`AlreadyProcessed`/`Record` en `StockReserved` y `StockRejected`, que tienen guarda de dominio; `TryRecord` en
`StockCountAdjusted`, que no) y confirma la carrera resuelta (`InvalidStateTransitionException` o el 409
`CONCURRENT_MODIFICATION`) registrándola igual. Es el listener de la skill casi literal. Más los ocho flujos y el
baseline del pase de calidad. Ningún archivo de mensajería de build tocado: la conexión, la topología, el puente, el
relay y el registro de procesados funcionaron tal cual.

El `designGap` que la corrida de keel-nest destapó (`late-outcome-after-release`: un `StockReserved` que llega con la
reserva liberada) ya estaba corregido en el `gaps.yaml`, y este agente hace lo mismo que los otros dos: la carrera
resuelta, confirmada sin efecto.

## Arreglos

- **El arnés escribía el cuerpo de cada entrega en un archivo FIJO del contenedor devtools** (`/tmp/keel-deliver.json`,
  y el del peek en `/tmp/keel-probe.json`). `FL-CMP-001-C` lanza dos entregas a la vez con `Task.WhenAll`, y las dos
  copiaban su cuerpo al mismo archivo antes de publicarlo. No falló porque los dos cuerpos eran iguales (es la doble
  entrega del mismo mensaje), pero con cuerpos distintos una entrega se lleva el de la otra. Lo propuso el agente de
  pruebas en el informe, sin aplicarlo (`Support/` es de build). Ahora cada llamada usa su propio archivo
  (`/tmp/keel-probe-<guid>.json`) y lo borra al terminar. `broker-check` gana `FL-BRK-001-G` (ocho entregas distintas
  a la vez, todas procesadas con su cuerpo) y su falsado: con el archivo compartido de antes, sale FALLO. **22/22**.
  - **keel-spring tiene el mismo defecto latente** (`DELIVER_BODY` fijo y `deliverMessage` sin `synchronized`); keel-nest
    no, porque sus entregas son síncronas en un solo hilo. **Arreglado después** (tras la 9h): `deliverMessage` de los
    tres brokers y el sondeo de RabbitMQ usan un archivo por llamada (`devtoolsFile`) y lo borran al terminar;
    `compile-check` en verde.

## Pruebas

`FL-RES-001-V` (los 400 `VALIDATION_ERROR` de las restricciones de entrada) lo añadió el agente de pruebas por la
checklist de `integration-tests.md`; no está en `validation-scenarios.md`. El informe anota también que
`infra/check-domain-guards.sh` no existe: es lo previsto, este diseño no declara value types con formato, y todas las
guías lo citan «si existe».

## designGaps

Ninguno.
