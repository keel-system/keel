# Corrida `stock-reservation` — keel-dotnet (incremento 11e)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.1.0 (relacional, RabbitMQ, `http-clients` + `dependencies`) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 11: 11b–11d, `8149530`…`9a5229b`, y el arreglo de la réplica `5718300`) |
| Diseño listo al generar | sí |
| Matriz final | **27/27 OK** (los 21 del documento y FL-RES-001-V1…V6) |
| Huella del agente | 248 archivos registrados por `build`, 0 adoptados, **11 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 2 (el arnés sin segunda réplica, que bloqueó FL-CLU-*; `AssertJson` comparando las cadenas por su escape) |
| Convertidos en id | |
| Clasificación de la huella | 10 TODO · 0 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas del 2026-10-08 |

La corrida del incremento 11 de `PLAN-KEEL-DOTNET.md`, sobre el MISMO diseño y el mismo stack que sus gemelas de
keel-nest y keel-spring (`2026-10-08-stock-reservation-{nest,spring}.md`). Mide lo que ninguna red mide: los flujos del
barrido de reconciliación con `AgeForReconciliation`, la compensación, el reintento con la MISMA clave contra el WireMock
de `infra/` (FL-REC-002) y el clúster de dos réplicas (FL-CLU-*).

## Cómo terminó

**27/27**, con `score-scenarios.sh` en 0 y sin huecos del diseño. Pruebas de build 155/155, el baseline de `dotnet ef`
verificado (50 elementos del esquema) y `check-idempotency.sh` en verde (había nacido rojo en siete familias, con
`outboundIdempotency` en verde porque la clave la cablea build). El barrido de reconciliación toma su lote con
`ClaimForReconcileReservationsReserveStock` tal cual, avisa al almacén con `inventoryClient.CancelStock` fuera de toda
transacción y captura la carrera con el camino feliz por su excepción concreta. Los flujos del proveedor usan los
helpers del arnés (`StubSequence`, `StubRequests`, `StubRequestHeader`, `StubCallCount`) sin un mapping a mano.

**Una parada a mitad**: el agente de pruebas no pudo escribir FL-CLU-001/002/003 porque el arnés de keel-dotnet no
arrancaba una segunda instancia (keel-spring y keel-nest sí). Se arregló en el generador —no como `harnessPatch`— y se
propagó con `build --refresh`, que puso al día solo `FlowTest.cs`, `FlowServer.cs` y `Harness.cs`; los tres FL-CLU
pasaron después con la réplica nueva.

## Comparación

| | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|
| Matriz | **27/27** | 24/24, una ronda de arbitraje | 21/21 |
| Registrados por build | 248 | 223 | 252 |
| Reescritos | **11** | 10 | 10 |
| Reescritos por un hueco del generador | 1 (`JsonShape.cs`) | 0 | 0 |
| Huecos del generador | 2 | 2 (del gate, comunes a los dos) | (los mismos) |

Sin el `harnessPatch`, la huella del trabajo del agente es 10, la de las dos gemelas.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los siete handlers de `Application/UseCases/` | TODO legítimo: la lógica de cada caso de uso, el barrido y la compensación |
| `Domain/Aggregate/Reservation.cs` | TODO legítimo: la creación y las transiciones |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo: el dispatcher del outbox y los listeners de RabbitMQ |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |
| `tests/…/Support/JsonShape.cs` | **generador**: `harnessPatch`, ver § Arreglos |

**Archivos nuevos del agente**: los catorce flujos de `tests/StockReservation.IntegrationTests/` (más una base común,
`ReservationFlowBase.cs`) y el baseline de migraciones.

## Arreglos

- **El arnés no tenía segunda réplica** (bloqueó FL-CLU-*). `FlowTest` gana `StartReplica()`, `StopReplica()` y
  `OnReplica(...)`, los nombres de keel-spring y keel-nest; la réplica es un segundo proceso del mismo Api en otro puerto
  contra la misma infraestructura (`ReplicaServer`), y cada flujo nuevo para la que el anterior dejara viva
  (`5718300`). `harness-check` gana FL-PROBE-001-C, que la arranca, le habla, la para y comprueba que el servidor del
  flujo sigue.
- **`AssertJson` comparaba las cadenas por su escape.** La rama de los valores usaba `GetRawText()`: un JSON esperado
  escrito con el codificador por defecto de System.Text.Json lleva `é` como `é`, y el servidor la manda literal.
  Cinco falsos negativos en la primera puntuación (FL-REC-001, -001-B, -002, -003 y FL-CLU-002, todos con «sin
  respuesta del almacén»); el agente lo parcheó en `JsonShape.cs`. Arreglado en el generador igual que el parche (las
  cadenas por su valor decodificado; números, booleanos y null siguen por su texto, porque `2.50` no es `2.5`), y
  `harness-check` gana FL-PROBE-001-D, que lo ejerce con una `é` escapada frente a una literal.

## Lo que se miró y no es defecto

- **El aviso de `reset-db.sh`** al purgar las tres colas de RabbitMQ: lo dio el agente de infraestructura ANTES de que el
  servidor declarara la topología, y el script lo prevé («¿la cola aún no existe?»). En los flujos, con el servidor
  arriba, no aparece.
- **FL-RES-001-V1…V6**: los rechazos 400 por validación que añade el agente de pruebas siguiendo la checklist. Cuentan
  como del documento porque prolongan FL-RES-001; la puntuación solo aparta lo que no prolonga un id declarado.
- **FL-RES-001-D** envejece `idempotency_record` con un `UPDATE` sobre todas las filas: funciona porque cada flujo
  arranca con el estado reseteado. Candidato a helper del arnés (como `AgeForReconciliation`), sin urgencia.

## designGaps

Ninguno (sin `design-gaps.yaml`).
