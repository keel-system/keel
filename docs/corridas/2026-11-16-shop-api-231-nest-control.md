# Corrida de control de la guarda del agregado (DSL 2.31) — `shop-api` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.31, relacional, 5 capas), con el `exactlyOne: [cart, order]` de `ProductInOrder`, la cota de `count` como invariante de la línea y U6 (`createProduct` con `input.fields`, `ProductInfo.productStock` sin máximo) |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`ddcd183f` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, review, structural) |
| Papel | control |
| Matriz final | **92/92 OK** (primera pasada 82 OK · 10 FALLO, todos `culprit: code` y por la misma causa: la escala de `productPrice`) |
| Huella del agente | 306 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 4 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el informe dice «ninguno») |
| Huecos del generador | 1, repetido de la 2.27 (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-231-nest-postgre\services\shop-api-nest`. Segunda de las cinco corridas de control del
incremento A9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`. La referencia es
`2026-11-11-shop-api-227-nest-cognito-control.md` (mismo generador, con Cognito).

## Lo que medía

- **`cart-line-sum-over-max` desaparece.** `ProductInOrder.addCount` suma sin comprobar («la cota de count la comprueba
  la guarda al guardar»), y los handlers de `addToCart` y `mergeCart` lo dicen en un comentario en vez de repetir la
  cota. El único máximo que queda en `application/usecases` es el de `orderAmount` en `checkout`, que es el
  `ORDER_AMOUNT_EXCEEDED` 409 que declara el diseño. No sale como `designGap`; en la 2.27 sí salió en esta misma
  generación.
- **Lo que escribe `build` no se toca.** El `ensureInvariants()` de las cinco raíces es byte a byte el que emite `build`
  hoy, y los dos adaptadores reescritos (`product-in-order-repository-impl.ts` y `product-info-repository-impl.ts`)
  siguen llamándolo en su `save`.
- **La huella, igual que en la 2.27**: 30 reescritos, de los que 25 partían de un TODO (19 handlers y 6 agregados), 4 son
  las mismas consultas por lote (`findAllByIds` de `ProductInfo` y `findAllByOrderIds` de `ProductInOrder`, en puerto y
  adaptador) y el `README.md` gana la sección «Despliegue en producción», que no es una decisión.

## Lo que se contrastó

- La matriz es la de `infra/score-scenarios.sh` (código 0), no hay `design-gaps.yaml`, y la huella la imprime
  `corrida-metrics.js footprint`.
- La guarda, con el mismo script que la corrida de keel-spring: 5 iguales, 0 distintas, 0 ausentes.
- La clasificación, comparando cada reescrito con lo que emite `planService` sobre el snapshot del proyecto: 25 con TODO
  de `build` y 5 sin él (los 4 de consulta y el README).

## Huecos del generador

- **La escala de un `decimal` de entrada con `scalePolicy: reject`.** Un `productPrice` de `30` tiene que salir como
  `30.00` (escala 2 del diseño; el escenario lo afirma). keel-nest solo aplica la escala cuando la política es `round`
  (`scaleRounded` de `src/scaffold/services.js`); con `reject`, rechaza lo que trae más decimales, pero no rellena lo que
  trae menos, y la respuesta sale con la escala que llegó. El agente lo arregla con `setScale(2, 'HALF_UP')` en
  `ProductInfo.create` y `replaceWith`. Es el mismo arreglo de la 2.27 (allí con 2 fallos y aquí con 10, por la misma
  causa). keel-spring pasa a la primera, probablemente porque devuelve lo que lee de la columna `numeric(19,2)`; falta
  medirlo en keel-dotnet y keel-go. Rellenar la escala no pierde nada, así que lo puede hacer el generador al leer la
  entrada en las dos políticas.

## designGaps

Ninguno: no hay `design-gaps.yaml` y el informe dice «ninguno».
