# Corrida `catalog` — keel-dotnet sobre MySQL y SNS/SQS (registry, DSL 2.22)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v0.1.2 del registry (DSL 2.22, relacional, 7 capas) |
| Stack | `mysql · snssqs · keycloak · minio` |
| Generador | `keel-dotnet@0.0.1` |
| Diseño listo al generar | sí |
| Matriz final | **187/187 OK** |
| Huella del agente | 413 archivos registrados por `build`, 0 adoptados, **37 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 3, de keel-dotnet (ver § Arreglos); un cuarto parche del agente no se adopta |
| Convertidos en id | — |
| Clasificación de la huella | 35 de territorio del agente, los mismos que en la corrida del 2026-10-19 (28 handlers, 3 agregados y una hija, `BrokerBindings.cs`, `S3FileStorage.cs` y el `README.md`) + 2 del generador (`tests/Catalog.UnitTests/MessagingTests.cs`, `tests/Catalog.IntegrationTests/Support/Messaging.cs`) |
| Agujeros de la puerta | 0 |

El mismo diseño que `2026-10-19-catalog-dotnet.md`, con otro stack: MySQL en vez de PostgreSQL, SNS/SQS en vez de
RabbitMQ y sin telemetría. Se generó en `D:\keel-example\catalog-dotnet-mysql-sns\services\catalog-dotnet`.

## Lo que dijo el informe y lo que había

El informe se sostiene. La huella confirma que solo dos archivos fuera del territorio del agente cambiaron, y son los
dos que el informe declara. Las tres fallas tienen la misma causa de fondo: **ninguna fixture tenía la forma del
catálogo con SNS/SQS** (un servicio que publica sin suscribirse) **ni la combinación SNS/SQS con MySQL**. Las variantes
`*-snssqs` de `CS_VARIANTS` son `stock-reservation-events` y `metering-digest`, las dos con suscripciones y sobre
PostgreSQL. El aparcado del outbox solo existe en la rama SNS/SQS, y `broker-check` no tiene eje de motor.

## Arreglos

1. **`[Theory]` sin filas en `MessagingTests`** (`src/scaffold/messaging-tests.js`). La curva de visibilidad sale una
   fila por suscripción, y sin suscripciones el `[Theory]` quedaba vacío. El analizador xUnit1003 rompía el build. El
   agente lo resolvió con una suscripción sintética. El arreglo no emite la curva cuando no hay suscripciones, porque
   no hay curva del diseño que comprobar. `ElContratoIncumplidoNoSeReintentaEnSqs` sigue. Falsado: con el emisor
   anterior, la variante nueva da exactamente `error xUnit1003` con el SDK 10.
2. **La marca del aparcado llevaba zona** (`src/scaffold/messaging-harness.js`, `parkOutbox`). `'2999-01-01
   00:00:00+00'` es válido en un `timestamptz` de PostgreSQL, pero MySQL lo rechaza en un `DATETIME` (ERROR 1292). Ahora
   va sin zona. En PostgreSQL se lee en la zona de la sesión al aparcar y al devolver, así que la igualdad de
   `UnparkOutbox` sigue cumpliéndose. Con el `UPDATE` fallando, `AwaitServerConnectedAsync` moría antes de
   `init-messaging.sh`, LocalStack quedaba sin topología y los flujos siguientes caían con `NonExistentQueue`: de ahí
   los 4 escenarios en fallo y los 29 omitidos del primer intento.
3. **`ParkOutbox` estaba fuera del `try`** (mismo archivo). El motivo que dio el informe no es exacto: el `finally` no
   resiembra la topología, solo devuelve las filas aparcadas. El arreglo sí es correcto, por otra razón: si la segunda
   pasada fallaba, las filas que había aparcado la primera se quedaban en 2999 para siempre y el outbox no las volvía a
   entregar.

**No adoptado: el reintento de `PurgeAsync` ante `NonExistentQueue`.** Era un síntoma del arreglo 2, no un defecto:
el arnés siempre resiembra la topología al levantar el broker (`PrepareAsync` → `StartAsync` →
`AwaitServerConnectedAsync`). Si la purga volviera a sembrarla, taparía la señal que `keel-spring-tests.md` documenta
(«`NonExistentQueue` dice que la topología no está sembrada»).

Redes: dos pruebas en `test/messaging.test.js`, falsadas contra el código anterior, y la variante
`catalog-extended-publish-snssqs` (publica sin suscribirse, SNS/SQS sobre MySQL) en `CS_VARIANTS`. Esa variante la
parsea `cs-syntax` y la compila y prueba `cs-check`, y se midió a mano con el SDK: 0 warnings y 213/213 pruebas
emitidas. Queda sin red en vivo la marca sin zona sobre MySQL con el broker real, porque `broker-check` solo levanta
PostgreSQL. Por ahora la mide esta corrida, que llegó a 187/187 con ese mismo texto.

## designGaps

Ninguno.
