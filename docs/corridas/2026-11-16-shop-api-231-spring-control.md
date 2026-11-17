# Corrida de control de la guarda del agregado (DSL 2.31) — `shop-api` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.31, relacional, 5 capas), con el `exactlyOne: [cart, order]` de `ProductInOrder`, la cota de `count` como invariante de la línea y U6 (`createProduct` con `input.fields`, `ProductInfo.productStock` sin máximo) |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`ddcd183f` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, review, structural) |
| Papel | control |
| Matriz final | **92/92 OK** a la primera (sin arbitrajes; el agente de validación no se invocó) |
| Huella del agente | 330 archivos registrados por `build`, 0 adoptados, **27 reescritos**, 0 borrados |
| Clasificación de la huella | 27 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el informe no cuenta ninguno en prosa) |
| Huecos del generador | 1, del arnés (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-231-spring-postgre\services\shop-api-spring`. Primera de las cinco corridas de control
del incremento A9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`.

## Lo que medía

- **`cart-line-sum-over-max` desaparece.** Salió en las cuatro corridas de la 2.27; ahora el diseño lo decide (la cota
  de `count` es de la línea y una suma que la pase es 422 `INVARIANT_VIOLATED`) y `build` emite la guarda. El agente
  escribió `ProductInOrder.addCount` como una suma sin comprobación, con el comentario «la cota la comprueba
  ensureInvariants al guardar», y no repitió la cota en ningún handler. No hay `Math.addExact` ni ningún 1.000.000 en
  `application/usecases`. No sale como `designGap`.
- **El `exactlyOne` de la línea.** `moveToOrder(orderId)` pone `cartId` a nulo y `orderId` en la misma mutación, y el
  factory `forCart` crea la línea con `orderId` nulo. FL-ORD-* (el checkout que mueve las líneas) en verde.
- **Lo que escribe `build` no se toca.** El `ensureInvariants()` de las cinco raíces guardadas es byte a byte el que
  emite `build` hoy, y los cinco adaptadores siguen llamándolo en su `save`. Los 27 reescritos son los 27 archivos con
  TODO de `build` (19 handlers, 6 entidades y 2 mappers): ninguna consulta, frente a 5 en la corrida de la 2.27.
- **U6.** `createProduct` lee su entrada explícita con el máximo de `productStock`, y `cancelOrder` puede dejar el stock
  por encima (FL-ORD-026, en verde) sin que la guarda lo rechace: la entidad ya no tiene ese máximo.

## Lo que se contrastó

- El informe contra el proyecto: la matriz es la de `infra/score-scenarios.sh` (código 0), no hay `design-gaps.yaml`, y
  la huella la imprime `corrida-metrics.js footprint`.
- La guarda, con un script que compara el `ensureInvariants()` de cada entidad con el que emite `planService` del
  generador sobre el snapshot del proyecto: 5 iguales, 0 distintos, 0 ausentes. Las notas de la guarda en los handlers
  desaparecen al reescribirlos, como cualquier otro comentario del stub.
- Respecto a la corrida de la 2.27: la primera pasada fue 92/92 (allí 21 OK · 71 FALLO por el arnés del agente) y
  la huella bajó de 32 a 27 reescritos.

## Huecos del generador

- **Arnés: `tokenAs` no puede expresar un email sin verificar** (FL-ACC-016, paso 2). Las personas de `tokenAs` nacen
  con `emailVerified: true` fijo y sus claims son `Map<String, String>`, así que un claim booleano no cabe. El agente
  lo aproximó con un mapper que pone `email_verified` a la cadena `"false"`. El escenario pasa, porque el servicio no
  mira ese claim, pero la prueba no demuestra lo que dice. No es de la 2.31: el escenario existe desde la 2.27, y allí
  el informe no lo contó.

## designGaps

Ninguno: no hay `design-gaps.yaml` y el informe dice «sin huecos de diseño».
