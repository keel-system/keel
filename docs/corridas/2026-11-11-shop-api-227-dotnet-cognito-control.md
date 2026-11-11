# Corrida de control de la lectura acotada (DSL 2.27) con Cognito — `shop-api` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.27, relacional, 5 capas), con `OrderMain.reads` en `forbidden` y `User.reads` en `not-found` |
| Stack | `postgresql · cognito` (sin broker, caché ni storage; telemetría `none`; Cognito es el emulador del docker-compose) |
| Generador | `keel-dotnet@0.2.0` (`4da2c080` al refrescar con `build --refresh --prune`) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, structural, undecided) |
| Papel | control |
| Matriz final | **92/92 OK** (primera pasada 90 OK · 2 FALLO, FL-SEL-002 y FL-SEL-006, `culprit: code`) |
| Huella del agente | 332 archivos registrados por `build`, 0 adoptados, **28 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 2: uno en `design-gaps.yaml` y otro no reportado |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-227-dotnet-postgre-cognito\services\shop-api-dotnet`. Corrida de control del
incremento 8 de `PLAN-DSL-227-LECTURA-ACOTADA.md`, cruzada: shop-api con Cognito en keel-dotnet. Es la segunda de shop-api
con Cognito, después de `2026-11-11-shop-api-227-nest-cognito-control.md`, y su gemela con Keycloak
(`shop-227-dotnet-postgre`) está pendiente.

## Lo que medía

Lo mismo que la corrida de keel-nest con Cognito:

- **Las personas por el emulador, con su email (D5).** Todos los flujos piden su llamante con
  `TokenAs(actor.Sub, claims, actor.Role)`, y el email (la identidad del llamante, `callerIdentity`) y el rol llegan por los
  mappings de persona del emulador.
- **El token sin email.** FL-ACC-016 lo pide con `TokenAs("sub-without-email", …)` y espera un 401.

Los 92 en verde. Con Cognito real el email hay que configurarlo, y eso no lo prueba ninguna corrida.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 98 casos, 0 fallos, 92 `FL-*` distintos.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`:
  - 25 de los reescritos partían de un TODO: los 19 handlers y los 6 agregados.
  - `ProductInfo.cs` incluye el arreglo del ciclo de `code`: `productPrice` a escala 2 al crear y editar, el mismo de
    FL-SEL-002 y -006 que en keel-nest.
  - Las otras 2 son una consulta por lote, `FindAllByOrderIds`, en el puerto y el adaptador de `ProductInOrder`; las dos
    salen con CRLF. Es una de las que añadieron keel-spring y keel-nest; aquí el agente no añadió la de `ProductInfo` y
    deja anotados tres N+1 en el informe (`Checkout`, `CancelOrder` y `MergeCart`).
  - `README.md` gana una sección de despliegue, que no es una decisión.
- **El arreglo del reset (`4da2c080`), confirmado.** Es la primera corrida con el agente de infra nuevo. La carga de
  `fixtures.sql` antes del primer arranque se cuenta como esperada («no bloquea la puntuación»), y no como un KO.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## designGaps

- `cart-line-sum-over-max` — `AddCount` hace `Count += quantity` sin guarda: la suma de `addToCart` y `mergeCart` pasa del
  máximo de `count` sin error (no reportado). Van tres corridas con este hueco.
- `cart-line-concurrent-add` — Dos `addToCart` o `mergeCart` simultáneos sobre el mismo producto chocan con la unicidad
  `(cart, productId)` de `product_in_orders`. Responden 409 con el `code` canónico del adaptador
  (`PRODUCT_IN_ORDER_CART_PRODUCT_ID_ALREADY_EXISTS`), porque el diseño no declara el error de esa carrera. Ningún
  escenario la ejercita. Este sí está en `design-gaps.yaml`.
